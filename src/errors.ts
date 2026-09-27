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
 * The account has no passkey registered. The relay backend returned 404 (or
 * `error: "no_passkey_registered"`). The caller should fall back to another
 * sign-in method (e.g. password).
 */
export class PasskeyNotRegisteredError extends TouchQueWebError {
  constructor(message = 'No passkey is registered for this account.') {
    super(message);
    this.name = 'PasskeyNotRegisteredError';
  }
}

/**
 * Passwordless sign-in is not enabled for this tenant/integration. The relay
 * backend returned 403 (or `error: "passwordless_login_disabled"`).
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

  constructor(status: number, body: unknown, message?: string) {
    super(message || `Relay request failed with HTTP ${status}`);
    this.name = 'TouchQueWebAPIError';
    this.status = status;
    this.body = body;
  }
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
