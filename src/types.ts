import type { BrowserKey } from './browserKey';

/**
 * The relay endpoint paths on the *partner's own backend*. The browser SDK
 * never talks to TouchQue directly for passkey ceremonies — the partner
 * backend holds the API key and relays to TouchQue.
 *
 * Every path is appended to `baseUrl`. Override any subset; the rest keep
 * their defaults.
 */
export interface TouchQuePaths {
  /** POST — returns `PublicKeyCredentialCreationOptionsJSON` (at the top level). */
  registerOptions: string;
  /** POST — body `{ response, ...extra }`; returns `{ verified, credentialId }`. */
  registerVerify: string;
  /** POST — body `{ email, ...context }`; returns `{ attemptId, options }`. */
  authenticateOptions: string;
  /** POST — body `{ attemptId, response, ...context }`; returns the relay's passthrough. */
  authenticateVerify: string;
  /** POST — body `{ requestId }`; returns `PublicKeyCredentialRequestOptionsJSON`. */
  approveOptions: string;
  /** POST — body `{ requestId, response }`; returns `{ success }`. */
  approveVerify: string;
  /** GET — returns `{ credentials: PasskeySummary[] }`. */
  list: string;
  /** DELETE `${remove}/${id}` — returns `{ deleted: true }`. */
  remove: string;
  /** POST — starts/rotates classic-2FA enrollment. Returns `{ secret, qrCodeDataUrl, ... }`. */
  enrollStart: string;
  /** GET — returns `{ linked, used, deviceId }`. */
  enrollStatus: string;
  /** POST — body `{ externalUsername }`; sends a push and waits for approval. */
  login: string;
  /** POST — body `{ externalUsername }`; returns an offline-sign challenge + QR. */
  offlineChallenge: string;
  /** POST — body `{ challengeId, code }`. */
  offlineVerify: string;
  /** POST — body `{ externalUsername, code }` (time-based fallback). */
  offlineTotp: string;
}

export interface TouchQueWebConfig {
  /** Base URL of the partner's own relay backend, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** Override any subset of the relay paths. */
  paths?: Partial<TouchQuePaths>;
  /**
   * Whether the SDK's relay requests send credentials (cookies). Use
   * `'include'` when the relay authenticates the browser with a cookie
   * session. Default: `'same-origin'`.
   */
  credentials?: RequestCredentials;
  /** Extra headers to attach to every relay request (e.g. a CSRF token). */
  headers?: Record<string, string>;
  /** Injectable fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Silent sign-ins (server SDKs 3.5.0 with `silentSignIn`). `true` sends a
   * fresh proof of this browser's device-bound key (`X-TouchQue-Browser`)
   * with guarded requests (`fetch`) and the classic 2FA login: the user's
   * approval makes the browser known, and a later sign-in from it skips the
   * phone when nothing about it is new. Pass a key from `createBrowserKey()`
   * to use your own. Off by default. Without WebCrypto or IndexedDB no header
   * is sent and sign-ins ask the phone as before.
   */
  browserKey?: boolean | BrowserKey;
}

export interface PasskeySummary {
  id: string;
  credentialId: string;
  deviceType: string | null;
  backedUp: boolean;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RegisterResult {
  verified: boolean;
  credentialId: string;
  [key: string]: unknown;
}

/**
 * Result of `passkeys.authenticate()`. The SDK does not interpret a
 * successful passwordless login for you — `raw` is whatever the relay
 * returned (a redirect URL, a session, etc.). The SDK only classifies the
 * three flow-control outcomes.
 */
export interface AuthenticateResult {
  /** `true` when the assertion verified and no step-up is required. */
  ok: boolean;
  /**
   * `true` when risk/policy demands a second factor. The caller should start
   * the normal push / number-match flow instead of trusting the assertion.
   */
  requiresStepUp: boolean;
  /** `true` when the relay wants the caller to continue a pending 2FA flow. */
  pending2fa: boolean;
  /** The relay's untouched response body. */
  raw: Record<string, unknown>;
}

export interface ApproveResult {
  success: boolean;
  [key: string]: unknown;
}
