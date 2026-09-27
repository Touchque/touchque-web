// Classic push / number-match 2FA — the companion to passkeys.ts for
// partners not using WebAuthn. Talks to the same relay backend as the
// passkey flow (never TouchQue directly); pairs with `touchqueRouter` from
// `@touchque/node` by default (`/enroll/start`, `/enroll/status`, `/login`).
//
// This replaces the QR-render + poll + cleanup state machine every partner
// used to hand-roll on their own dashboard page.

import type { RelayHttp } from './http';
import { EnrollmentTimeoutError, EnrollmentCancelledError, PasskeyRequiredError, TouchQueWebAPIError } from './errors';
import type { Step, StepControls } from './action';

export interface ClassicTwoFactorPaths {
  /** POST — starts (or rotates) enrollment. Returns `{ secret, qrCodeDataUrl, ... }`. */
  enrollStart: string;
  /** GET — returns `{ linked, used, deviceId }`. */
  enrollStatus: string;
  /** POST — two-phase: 202 { touchque: step, token } until approved, then 200. */
  login: string;
}

export interface EnrollStartResult {
  secret: string;
  /** Ready-to-render `data:image/png;base64,...` — set as an `<img>` src directly. */
  qrCodeDataUrl: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface LinkStatus {
  linked: boolean;
  used: boolean;
  deviceId: string | null;
}

export interface ClassicLoginResult {
  status: 'success';
  requestId: string;
  /** How it was approved; `phishingResistant` is true only for passkeys. */
  assurance?: { phishingResistant: boolean; method: string };
}

export interface ClassicLoginOptions {
  /** Ignored by the server when its router binds login to your password step (`getLoginUser`). */
  externalUsername?: string;
  /**
   * Render each step in your own UI: `waiting` (+ `number` to show for number
   * matching), `enroll` (first-time QR), `offline` (QR + code input). Use the
   * controls to switch to offline or submit the code.
   */
  onStep?: (step: Step, controls: StepControls) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClassicTwoFactor {
  constructor(
    private readonly http: RelayHttp,
    private readonly paths: ClassicTwoFactorPaths,
  ) {}

  /** Start (or rotate) enrollment for the signed-in user. Show `qrCodeDataUrl` for them to scan. */
  async enroll(): Promise<EnrollStartResult> {
    return this.http.post<EnrollStartResult>(this.paths.enrollStart, {});
  }

  /** One-shot status check — did the mobile app link yet? */
  async status(): Promise<LinkStatus> {
    return this.http.get<LinkStatus>(this.paths.enrollStatus);
  }

  /**
   * Poll `status()` until the device links, or reject with
   * `EnrollmentTimeoutError`. Pass `signal` (e.g. from an `AbortController`)
   * to cancel early — rejects with `EnrollmentCancelledError`, which callers
   * typically catch and ignore specifically (it isn't a failure).
   */
  async waitForLink(
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<LinkStatus> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (options.signal?.aborted) throw new EnrollmentCancelledError();
      const s = await this.status();
      if (options.signal?.aborted) throw new EnrollmentCancelledError();
      if (s.linked) return s;
      if (Date.now() >= deadline) throw new EnrollmentTimeoutError();
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Classic push sign-in. Resolves once approved; while waiting, `onStep`
   * gets the step to render (show `step.number` when present — the user picks
   * the same number on the phone). A passkey-only policy runs the passkey
   * approval automatically when the SDK was created with createTouchQueWeb.
   * Refusals throw `TouchQueWebAPIError` (`.status`, `.body.touchque.state`).
   */
  async login(input: ClassicLoginOptions = {}): Promise<ClassicLoginResult> {
    const res = await this.http.stepUp(
      this.paths.login,
      input.externalUsername ? { externalUsername: input.externalUsername } : {},
      { onStep: input.onStep, signal: input.signal, pollIntervalMs: input.pollIntervalMs, approveWithPasskey: this.approveWithPasskey },
    );
    const body = await res.json().catch(() => null);
    if (res.ok) return body as ClassicLoginResult;
    const step = body?.touchque as Step | undefined;
    if (step?.state === 'passkey_required' && step.requestId) throw new PasskeyRequiredError(step.requestId);
    if (res.status === 409 && body?.error === 'PASSKEY_REQUIRED' && body.requestId) throw new PasskeyRequiredError(body.requestId); // servers before @touchque/node 2
    throw new TouchQueWebAPIError(res.status, body, step?.reason || step?.state || body?.error || 'login_failed');
  }

  /** @internal set by createTouchQueWeb so passkey-only policies just work. */
  approveWithPasskey?: (requestId: string) => Promise<unknown>;
}
