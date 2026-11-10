// Error classes for @touchque/web.
//
// These normalize the two failure sources a browser passkey flow has:
//   1. The WebAuthn ceremony itself (the browser / authenticator), e.g. the
//      user closing the system prompt.
//   2. The partner's relay backend, e.g. "this user has no passkey" or
//      "passwordless login is not enabled for this tenant".
//
// A `requiresStepUp` outcome is NOT an error — it is returned as data on the
// authenticate() result so the caller can fall through to a push / number
// match flow.

/** Base class for every error thrown by this SDK. */
export class TouchQueWebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TouchQueWebError';
  }
}

/**
 * The WebAuthn ceremony did not complete because the user dismissed the
 * system prompt (or the browser aborted it). Maps `NotAllowedError` /
 * `AbortError` from `navigator.credentials.*`.
 */
export class PasskeyDismissedError extends TouchQueWebError {
  constructor(message = 'The passkey prompt was dismissed before it completed.') {
    super(message);
    this.name = 'PasskeyDismissedError';
  }
}

/**
 * `passkeys.register()` / `upgrade()`: this device's authenticator already
 * holds a passkey for this account (the browser's `InvalidStateError`), so
 * there is nothing to add. `upgrade()` remembers it, so the offer is not
 * shown again in this browser.
 */
export class PasskeyAlreadyRegisteredError extends TouchQueWebError {
  constructor(message = 'This device already has a passkey for this account.') {
    super(message);
    this.name = 'PasskeyAlreadyRegisteredError';
  }
}

/**
 * The account has no passkey registered. The relay backend returned
 * `error: "no_passkey_registered"` (or a 404 with no body). The caller
 * should fall back to another sign-in method (e.g. password).
 */
export class PasskeyNotRegisteredError extends TouchQueWebError {
  constructor(message = 'No passkey is registered for this account.') {
    super(message);
    this.name = 'PasskeyNotRegisteredError';
  }
}

/**
 * Passwordless sign-in is not enabled for this tenant/integration. The relay
 * backend returned `error: "passwordless_login_disabled"` (or a 403 with no body).
 */
export class PasskeyDisabledError extends TouchQueWebError {
  constructor(message = 'Passwordless sign-in is not enabled for this account.') {
    super(message);
    this.name = 'PasskeyDisabledError';
  }
}

/**
 * `waitForLink()` polled past its timeout without the device ever linking
 * (the user never scanned the QR code / entered the setup secret).
 */
export class EnrollmentTimeoutError extends TouchQueWebError {
  constructor(message = 'Timed out waiting for a device to link this enrollment.') {
    super(message);
    this.name = 'EnrollmentTimeoutError';
  }
}

/**
 * `waitForLink()` was stopped early via its `signal` (the caller cancelled).
 * Not a failure — callers typically catch and ignore this specifically.
 */
export class EnrollmentCancelledError extends TouchQueWebError {
  constructor(message = 'Enrollment polling was cancelled.') {
    super(message);
    this.name = 'EnrollmentCancelledError';
  }
}

/**
 * The relay backend returned a non-2xx response that is not one of the
 * specific cases above. `status` is the HTTP status, `body` is the parsed
 * response body (if any).
 */
export class TouchQueWebAPIError extends TouchQueWebError {
  public readonly status: number;
  public readonly body: unknown;
  /**
   * "Why?": the case code of a refusal (`K7P-2QX`) when the server sent one
   * (the step's or the body's `caseCode`). Show it: "Tell your support team: K7P-2QX".
   */
  public readonly caseCode: string | undefined;

  constructor(status: number, body: unknown, message?: string) {
    super(message || `Relay request failed with HTTP ${status}`);
    this.name = 'TouchQueWebAPIError';
    this.status = status;
    this.body = body;
    const b = (body && typeof body === 'object' ? body : {}) as { caseCode?: unknown; touchque?: { caseCode?: unknown } };
    const code = b.touchque && typeof b.touchque.caseCode === 'string' ? b.touchque.caseCode : b.caseCode;
    this.caseCode = typeof code === 'string' && code ? code : undefined;
  }
}

/**
 * TouchQue refused because the organization behind the site cannot use this
 * feature (HTTP 403, passed on by your server). `reason`:
 * - `not_in_plan` — not in its plan (`feature_not_in_plan`);
 * - `read_only` — being turned off (`feature_read_only`): reads work, changes are refused;
 * - `off` — switched off on this TouchQue deployment (`feature_off`).
 * `feature` is the catalog id (`device_risk`, `mobile_sdk`, `ciam`…). A
 * TouchQueWebAPIError, so existing `catch` blocks still see it; show the person
 * that this part of the sign-in is not available, not a retry.
 */
export class TouchQueWebFeatureError extends TouchQueWebAPIError {
  public readonly feature: string | undefined;
  public readonly reason: 'not_in_plan' | 'read_only' | 'off';

  constructor(status: number, body: unknown, reason: 'not_in_plan' | 'read_only' | 'off', message?: string) {
    super(status, body, message);
    this.name = 'TouchQueWebFeatureError';
    const f = body && typeof body === 'object' ? (body as { feature?: unknown }).feature : undefined;
    this.feature = typeof f === 'string' ? f : undefined;
    this.reason = reason;
  }
}

const FEATURE_REASONS: Record<string, 'not_in_plan' | 'read_only' | 'off'> = {
  feature_not_in_plan: 'not_in_plan',
  feature_read_only: 'read_only',
  feature_off: 'off',
};

/** The error for a failed answer: TouchQueWebFeatureError for the three feature codes, else TouchQueWebAPIError. */
export function webApiError(status: number, body: unknown, message?: string): TouchQueWebAPIError {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const reason = typeof code === 'string' ? FEATURE_REASONS[code] : undefined;
  return reason ? new TouchQueWebFeatureError(status, body, reason, message) : new TouchQueWebAPIError(status, body, message);
}

/**
 * `classic2fa.login()`: the workspace requires a phishing-resistant factor for
 * this sign-in, so no push was sent. Approve it with a passkey:
 * `await tq.passkeys.approveLogin({ requestId: err.requestId })`.
 */
export class PasskeyRequiredError extends TouchQueWebError {
  public readonly requestId: string;

  constructor(requestId: string) {
    super('This sign-in must be approved with a passkey.');
    this.name = 'PasskeyRequiredError';
    this.requestId = requestId;
  }
}
