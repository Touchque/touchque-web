import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import type { RelayHttp } from './http';
import type { TouchQuePaths, RegisterResult, AuthenticateResult, ApproveResult, PasskeySummary } from './types';
import { PasskeyAlreadyRegisteredError, PasskeyDisabledError, PasskeyDismissedError, PasskeyNotRegisteredError, TouchQueWebError, TouchQueWebAPIError } from './errors';
import type { Step, StepControls } from './action';
import { rememberPasskey } from './upgrade';

function isDismissal(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

// Counts the ceremonies this SDK starts. Starting one aborts the one before
// it (@simplewebauthn's abort service), so the autofill request knows whether
// it is still the current one before it cancels anything itself.
let ceremonySeq = 0;

/** Run a WebAuthn ceremony, mapping a user-dismissal into `PasskeyDismissedError`. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  ceremonySeq += 1;
  try {
    return await run();
  } catch (err) {
    if (isDismissal(err)) throw new PasskeyDismissedError();
    if ((err as { name?: string })?.name === 'InvalidStateError') throw new PasskeyAlreadyRegisteredError();
    if (err instanceof TouchQueWebError) throw err;
    throw new TouchQueWebError(
      `WebAuthn ceremony failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

function unwrapOptions(body: unknown): { attemptId?: string; options: Record<string, unknown> } {
  if (body && typeof body === 'object' && 'options' in body) {
    const b = body as { attemptId?: string; options: Record<string, unknown> };
    return { attemptId: b.attemptId, options: b.options };
  }
  // Some relay endpoints return the ceremony options at the top level.
  return { options: (body ?? {}) as Record<string, unknown> };
}

export interface RegisterApprovalOptions {
  /** Render the phone-approval step (`waiting` + `number`) when the user has a linked phone. */
  onStep?: (step: Step, controls: StepControls) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export class Passkeys {
  constructor(
    private readonly http: RelayHttp,
    private readonly paths: TouchQuePaths,
  ) {}

  /**
   * Register a passkey for the currently signed-in user.
   *
   * `extra` is merged into the verify request body — use it for a device
   * label, for example: `register({ label: 'MacBook Touch ID' })`.
   */
  async register(extra: Record<string, unknown> = {}, approval: RegisterApprovalOptions = {}): Promise<RegisterResult> {
    // A user with a linked phone approves adding a passkey there first: the
    // relay answers 202 with the step (show `step.number`) until approved.
    const res = await this.http.stepUp(this.paths.registerOptions, {}, approval);
    const optionsBody = await res.json().catch(() => null);
    if (!res.ok) {
      const step = (optionsBody as { touchque?: Step } | null)?.touchque;
      throw new TouchQueWebAPIError(res.status, optionsBody, step?.reason || step?.state || 'register_options_failed');
    }
    const { options } = unwrapOptions(optionsBody);
    const response = await ceremony(() => startRegistration({ optionsJSON: options as never }));
    return this.http.post<RegisterResult>(this.paths.registerVerify, { response, ...extra });
  }

  /**
   * Passwordless-primary sign-in: authenticate a user from zero with a
   * passkey. `context` is merged into both relay calls (pass OAuth params,
   * a redirect URI, etc.).
   *
   * Inspect the result: `ok` = signed in; `requiresStepUp` = start a push /
   * number-match flow; `pending2fa` = continue a pending 2FA flow. `raw` is
   * the relay's untouched response.
   */
  async authenticate(
    input: { email: string; context?: Record<string, unknown> },
  ): Promise<AuthenticateResult> {
    const context = input.context ?? {};
    const optionsBody = await this.http.post<unknown>(this.paths.authenticateOptions, {
      email: input.email,
      ...context,
    });
    const { attemptId, options } = unwrapOptions(optionsBody);
    const response = await ceremony(() => startAuthentication({ optionsJSON: options as never }));

    const raw = await this.http.post<Record<string, unknown>>(this.paths.authenticateVerify, {
      ...(attemptId !== undefined ? { attemptId } : {}),
      response,
      ...context,
    });

    const result = classify(raw);
    // This browser holds a passkey of this user: no "Add a passkey" offer here.
    if (result.ok || result.requiresStepUp) rememberPasskey(input.email);
    return result;
  }

  /**
   * Passkey autofill (WebAuthn conditional mediation): the browser lists the
   * user's saved passkeys for this site in the autofill of the email field,
   * next to saved addresses. Start it once when the sign-in form shows; it
   * resolves once the user picks a passkey, like `authenticate()`, with no
   * email typed.
   *
   * Never opens a modal: in a browser without passkey autofill it resolves
   * `null` at once, and so it does when `signal` aborts, when passwordless
   * sign-in is off for your workspace, or when another passkey ceremony (a
   * "Sign in with a passkey" button) takes over. Call it again only when the
   * form shows again, never in a loop on errors: it retries by itself.
   *
   * - The relay's `authenticateOptions` is called with no `email`, so it must
   *   answer options for any passkey of this site (`touchqueRouter` from
   *   `@touchque/node` 4.0.0 and the other 4.0.0 relays do).
   * - A failed options call is retried only when it may pass later (a network
   *   error, 408 or 5xx), after 1, 2, 4… seconds and at most `maxRetries`
   *   times (default 3); a refusal (400, 401, 403, 429…) throws at once. After
   *   5 failures one `tq` client stops asking for the rest of the page view
   *   and resolves `null`.
   * - A pick the server refuses (a passkey it no longer knows) goes to
   *   `onError` and autofill opens again, at most `maxRetries` times; without
   *   `onError` it throws.
   * - It waits while the tab is hidden, and closes its open request when the
   *   tab is hidden (a fresh one opens when it is shown again).
   * - The options are fetched again every `refreshMs` (default 4 minutes),
   *   before TouchQue's 5-minute challenge runs out.
   *
   * `input` (an element or selector) gets `webauthn` as the last token of its
   * `autocomplete` attribute, which the browser needs; or write
   * `autocomplete="username webauthn"` yourself.
   */
  async autofill(options: PasskeyAutofillOptions = {}): Promise<AuthenticateResult | null> {
    const { signal, context = {}, refreshMs = 4 * 60 * 1000, onError } = options;
    const maxRetries = Math.max(0, options.maxRetries ?? 3);
    if (signal?.aborted || this.autofillFailures >= AUTOFILL_FAILURE_LIMIT || !(await isPasskeyAutofillAvailable())) return null;
    if (options.input) markAutofillInput(options.input);

    let optionRetries = 0;
    let pickFailures = 0;
    for (;;) {
      // Only a tab the user looks at asks for options and keeps a request open.
      if (!(await whenVisible(signal))) return null;

      let optionsBody: unknown;
      try {
        optionsBody = await this.http.post<unknown>(this.paths.authenticateOptions, { ...context });
      } catch (err) {
        if (signal?.aborted) return null;
        if (err instanceof PasskeyDisabledError) return null; // passwordless sign-in is off: nothing to offer
        this.autofillFailures += 1;
        if (!isRetryable(err) || optionRetries >= maxRetries || this.autofillFailures >= AUTOFILL_FAILURE_LIMIT) throw err;
        optionRetries += 1;
        if (!(await pause(backoffMs(optionRetries), signal))) return null;
        continue;
      }
      optionRetries = 0;
      const { attemptId, options: publicKey } = unwrapOptions(optionsBody);
      if (signal?.aborted) return null;

      ceremonySeq += 1;
      const mine = ceremonySeq;
      let reopen = false;
      // Cancel only while this request is still the current ceremony: a
      // passkey button started since then already aborted it.
      const cancelMine = () => { if (ceremonySeq === mine) WebAuthnAbortService.cancelCeremony(); };
      const timer = setTimeout(() => { reopen = true; cancelMine(); }, refreshMs);
      const onVisibility = () => { if (document.visibilityState === 'hidden') { reopen = true; cancelMine(); } };
      signal?.addEventListener('abort', cancelMine, { once: true });
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      let response;
      const started = Date.now();
      try {
        response = await startAuthentication({ optionsJSON: publicKey as never, useBrowserAutofill: true, verifyBrowserAutofillInput: false });
      } catch (err) {
        const current = ceremonySeq === mine && !signal?.aborted;
        if (reopen && current) continue;
        // The browser ended a request that stayed open a while (its timeout): open a new one.
        if ((err as { name?: string })?.name === 'NotAllowedError' && current && Date.now() - started > 5000) continue;
        if (isDismissal(err)) return null;
        throw new TouchQueWebError(`WebAuthn ceremony failed: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelMine);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      }

      let raw: Record<string, unknown>;
      try {
        raw = await this.http.post<Record<string, unknown>>(this.paths.authenticateVerify, {
          ...(attemptId !== undefined ? { attemptId } : {}),
          response,
          ...context,
        });
      } catch (err) {
        if (signal?.aborted) return null;
        // A passkey the server no longer knows (removed on another device):
        // tell the browser so it stops offering it.
        if (err instanceof TouchQueWebError && ((err as TouchQueWebAPIError).status === 404 || err instanceof PasskeyNotRegisteredError)) {
          signalUnknownCredential((publicKey as { rpId?: string }).rpId, (response as { id?: string }).id);
        }
        if (!onError) throw err;
        pickFailures += 1;
        this.autofillFailures += 1;
        try { onError(err as Error); } catch { /* the caller's handler */ }
        if (pickFailures > maxRetries || this.autofillFailures >= AUTOFILL_FAILURE_LIMIT) return null;
        if (!(await pause(backoffMs(pickFailures), signal))) return null;
        continue;
      }
      return classify(raw);
    }
  }

  /** Failed autofill calls of this client (options refused or failing, picks refused); 5 stop it for the page view. */
  private autofillFailures = 0;

  /**
   * Password → passkey: register a passkey for the signed-in user right after
   * a password or email-link sign-in (show it when `shouldOfferPasskey()`
   * says so), and remember in this browser that `user` has one here, so the
   * offer is not shown again. Same relay calls and phone approval as
   * `register()`. A device that already holds one throws
   * `PasskeyAlreadyRegisteredError` (and is remembered too).
   */
  async upgrade(input: { user: string; label?: string } & RegisterApprovalOptions): Promise<RegisterResult> {
    const { user, label, ...approval } = input;
    try {
      const result = await this.register(label ? { label } : {}, approval);
      rememberPasskey(user);
      return result;
    } catch (err) {
      if (err instanceof PasskeyAlreadyRegisteredError) rememberPasskey(user);
      throw err;
    }
  }

  /**
   * Approve an already-pending login request (second-factor flow) with a
   * passkey, instead of the mobile push.
   */
  async approveLogin(input: { requestId: string }): Promise<ApproveResult> {
    const optionsBody = await this.http.post<unknown>(this.paths.approveOptions, {
      requestId: input.requestId,
    });
    const { options } = unwrapOptions(optionsBody);
    const response = await ceremony(() => startAuthentication({ optionsJSON: options as never }));
    return this.http.post<ApproveResult>(this.paths.approveVerify, {
      requestId: input.requestId,
      response,
    });
  }

  /** List the signed-in user's registered passkeys (metadata only). */
  async list(): Promise<PasskeySummary[]> {
    const body = await this.http.get<{ credentials?: PasskeySummary[] }>(this.paths.list);
    return body.credentials ?? [];
  }

  /** Remove one of the signed-in user's passkeys by its record id. */
  async remove(id: string): Promise<{ deleted: boolean }> {
    return this.http.del<{ deleted: boolean }>(
      `${this.paths.remove}/${encodeURIComponent(id)}`,
    );
  }
}

function classify(raw: Record<string, unknown>): AuthenticateResult {
  const requiresStepUp = raw.requiresStepUp === true;
  const pending2fa = raw.status === 'pending_2fa';
  const ok = !requiresStepUp && !pending2fa && (raw.success === true || raw.status === 'success');
  return { ok, requiresStepUp, pending2fa, raw };
}

export interface PasskeyAutofillOptions {
  /** The email / username field (element or selector); gets `webauthn` added to its `autocomplete`. */
  input?: HTMLInputElement | string;
  /** Merged into both relay calls, like `authenticate({ context })` (OAuth fields, a redirect…). */
  context?: Record<string, unknown>;
  /** Stops waiting for a pick; `autofill()` then resolves `null`. */
  signal?: AbortSignal;
  /** Fetch fresh options this often while nobody picks (default 240 000 ms). */
  refreshMs?: number;
  /**
   * A pick the server refused (e.g. a passkey it no longer knows). Show it;
   * autofill opens again by itself. Without it, `autofill()` throws instead.
   */
  onError?: (error: Error) => void;
  /** Retries of a failing options call (network, 408, 5xx) and reopenings after a refused pick (default 3). */
  maxRetries?: number;
}

/** After this many failures one client stops asking for passkey autofill options for the page view. */
const AUTOFILL_FAILURE_LIMIT = 5;

/** A failure worth asking again: no answer at all, a timeout or a server error. Refusals (4xx) are final. */
function isRetryable(err: unknown): boolean {
  if (err instanceof TouchQueWebAPIError) return err.status === 408 || err.status >= 500;
  return err instanceof TypeError; // fetch() rejects with a TypeError when the network fails
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

/** Waits `ms`; false when `signal` aborted meanwhile. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const done = (ok: boolean) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(ok); };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves true once the page is visible (at once when it is); false when `signal` aborts first. */
function whenVisible(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      document.removeEventListener('visibilitychange', onChange);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onChange = () => { if (document.visibilityState !== 'hidden') done(true); };
    const onAbort = () => done(false);
    document.addEventListener('visibilitychange', onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function markAutofillInput(target: HTMLInputElement | string): void {
  const input = typeof target === 'string' ? document.querySelector<HTMLInputElement>(target) : target;
  if (!input) return;
  const tokens = (input.getAttribute('autocomplete') || 'username').split(/\s+/).filter((t) => t && t !== 'webauthn');
  input.setAttribute('autocomplete', [...tokens, 'webauthn'].join(' '));
}

function signalUnknownCredential(rpId: string | undefined, credentialId: string | undefined): void {
  try {
    const pkc = (globalThis as { PublicKeyCredential?: { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } }).PublicKeyCredential;
    if (rpId && credentialId && typeof pkc?.signalUnknownCredential === 'function') {
      pkc.signalUnknownCredential({ rpId, credentialId }).catch(() => { });
    }
  } catch {
    // WebAuthn Signal API: best effort.
  }
}

/**
 * `true` when this browser can offer passkeys in a field's autofill (WebAuthn
 * conditional mediation). `passkeys.autofill()` checks it itself.
 */
export function isPasskeyAutofillAvailable(): Promise<boolean> {
  try {
    return browserSupportsWebAuthnAutofill().catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** `true` if the current browser exposes the WebAuthn API at all. */
export function isPasskeySupported(): boolean {
  return browserSupportsWebAuthn();
}

/** `true` if a built-in platform authenticator (Touch ID / Windows Hello / …) is usable. */
export function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  return platformAuthenticatorIsAvailable();
}
