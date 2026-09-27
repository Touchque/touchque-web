import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from '@simplewebauthn/browser';
import type { RelayHttp } from './http';
import type { TouchQuePaths, RegisterResult, AuthenticateResult, ApproveResult, PasskeySummary } from './types';
import { PasskeyDismissedError, TouchQueWebError } from './errors';

function isDismissal(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** Run a WebAuthn ceremony, mapping a user-dismissal into `PasskeyDismissedError`. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isDismissal(err)) throw new PasskeyDismissedError();
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
  async register(extra: Record<string, unknown> = {}): Promise<RegisterResult> {
    const optionsBody = await this.http.post<unknown>(this.paths.registerOptions, {});
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

    const requiresStepUp = raw.requiresStepUp === true;
    const pending2fa = raw.status === 'pending_2fa';
    const ok = !requiresStepUp && !pending2fa && (raw.success === true || raw.status === 'success');

    return { ok, requiresStepUp, pending2fa, raw };
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

/** `true` if the current browser exposes the WebAuthn API at all. */
export function isPasskeySupported(): boolean {
  return browserSupportsWebAuthn();
}

/** `true` if a built-in platform authenticator (Touch ID / Windows Hello / …) is usable. */
export function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  return platformAuthenticatorIsAvailable();
}
