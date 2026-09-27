// @touchque/web — browser SDK for TouchQue Authenticator.
//
// Wraps the WebAuthn passkey ceremonies (register / authenticate / approve)
// around calls to *your own backend*, which relays them to TouchQue with its
// API key. The browser never holds the API key and never calls TouchQue's
// `/webauthn/*` endpoints directly.
//
//   import { createTouchQueWeb } from '@touchque/web';
//
//   const tq = createTouchQueWeb({ baseUrl: 'https://api.example.com' });
//
//   // passwordless sign-in
//   const result = await tq.passkeys.authenticate({ email: 'user@example.com' });
//   if (result.ok) { /* signed in */ }
//   else if (result.requiresStepUp) { /* start push / number-match */ }

import { RelayHttp } from './http';
import { Passkeys, isPasskeySupported, isPlatformAuthenticatorAvailable } from './passkeys';
import { ClassicTwoFactor } from './classic2fa';
import { OfflineSign } from './offline';
import { attachBehavioral, collectDeviceSignals } from './behavioral';
import { touchqueFetch } from './action';
import type { TouchQueFetchOptions } from './action';
import type { AttachBehavioralOptions, BehavioralHandle } from './behavioral';
import type { TouchQueWebConfig, TouchQuePaths } from './types';

export * from './types';
export * from './errors';
export { isPasskeySupported, isPlatformAuthenticatorAvailable };
export { attachBehavioral, collectDeviceSignals };
export type { DeviceSignals } from './behavioral';
export { ClassicTwoFactor, OfflineSign };
export { normalizeOfflineCode, formatOfflineCodeInput } from './offline';
export type { OfflineChallenge, OfflineVerifyResult, OfflineSignPaths } from './offline';
export type { AttachBehavioralOptions, BehavioralHandle, BehavioralMetrics } from './behavioral';
export type { ClassicTwoFactorPaths, EnrollStartResult, LinkStatus, ClassicLoginResult, ClassicLoginOptions } from './classic2fa';
export { touchqueFetch };
export type { Step, StepState, StepControls, TouchQueFetchOptions } from './action';

// Matches touchqueRouter's default mount paths in @touchque/node exactly —
// pairing the two needs zero `paths` config.
const DEFAULT_PATHS: TouchQuePaths = {
  registerOptions: '/passkey/register/options',
  registerVerify: '/passkey/register/verify',
  authenticateOptions: '/passkey/authenticate/options',
  authenticateVerify: '/passkey/authenticate/verify',
  approveOptions: '/passkey/login/options',
  approveVerify: '/passkey/login/verify',
  list: '/passkey/credentials',
  remove: '/passkey/credentials',
  enrollStart: '/enroll/start',
  enrollStatus: '/enroll/status',
  login: '/login',
  offlineChallenge: '/offline/challenge',
  offlineVerify: '/offline/verify',
  offlineTotp: '/offline/totp',
};

export interface TouchQueWeb {
  /**
   * fetch() for routes protected with requireTouchQue: re-sends while the user
   * approves, hands each step to `onStep` for YOUR UI, and runs the passkey
   * approval when a policy requires it. Resolves with your route's response.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit, options?: TouchQueFetchOptions): Promise<Response>;
  passkeys: Passkeys;
  /** Classic push / number-match 2FA — enrollment + login, no WebAuthn. */
  classic2fa: ClassicTwoFactor;
  /** Offline Sign — QR challenge / typed code for a phone with no internet. */
  offline: OfflineSign;
  behavioral: {
    /**
     * Attach the behavioral biometrics widget to a container. Unlike the
     * passkey calls, this posts directly to TouchQue (`apiBaseUrl`), gated
     * by the per-request `telemetryToken`.
     */
    attach(target: string | Element, options: AttachBehavioralOptions): BehavioralHandle;
  };
  /** `true` if the browser exposes the WebAuthn API. */
  isPasskeySupported(): boolean;
  /** `true` if a built-in platform authenticator is usable. */
  isPlatformAuthenticatorAvailable(): Promise<boolean>;
}

export function createTouchQueWeb(config: TouchQueWebConfig): TouchQueWeb {
  const http = new RelayHttp(config);
  const paths: TouchQuePaths = { ...DEFAULT_PATHS, ...(config.paths ?? {}) };
  const passkeys = new Passkeys(http, paths);
  const classic2fa = new ClassicTwoFactor(http, paths);
  const offline = new OfflineSign(http, paths);
  const approveWithPasskey = (requestId: string) => passkeys.approveLogin({ requestId });
  classic2fa.approveWithPasskey = approveWithPasskey;

  return {
    fetch: (input, init, options) => touchqueFetch(input, { credentials: config.credentials ?? 'same-origin', ...init }, {
      fetch: config.fetch, approveWithPasskey, ...options,
    }),
    passkeys,
    classic2fa,
    offline,
    behavioral: {
      attach: (target, options) =>
        attachBehavioral(target, { fetch: config.fetch, ...options }),
    },
    isPasskeySupported,
    isPlatformAuthenticatorAvailable,
  };
}
