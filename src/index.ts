// @touchque/web — browser SDK for Touchque Authenticator.
//
// Wraps the WebAuthn passkey ceremonies (register / authenticate / approve)
// around calls to *your own backend*, which relays them to Touchque with its
// API key. The browser never holds the API key and never calls Touchque's
// `/webauthn/*` endpoints directly.
//
//   import { createTouchqueWeb } from '@touchque/web';
//
//   const tq = createTouchqueWeb({ baseUrl: 'https://api.example.com' });
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
import { touchqueFetch, sendCanary } from './action';
import type { TouchqueFetchOptions } from './action';
import { browserKey as defaultBrowserKey } from './browserKey';
import type { BrowserKey } from './browserKey';
import type { AttachBehavioralOptions, BehavioralHandle } from './behavioral';
import type { TouchqueWebConfig, TouchquePaths } from './types';

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
export { touchqueFetch, sendCanary };
export type { Step, StepState, StepControls, TouchqueFetchOptions } from './action';
export type { RegisterApprovalOptions } from './passkeys';
export {
  browserKey, createBrowserKey, browserProofMessage, browserKeyThumbprint, browserKeyThumbprintInput, BROWSER_PROOF_HEADER,
} from './browserKey';
export type { BrowserKey, BrowserKeyOptions, BrowserKeyStore, BrowserProof, BrowserKeyJwk, BrowserHints, UserAgentDataLike } from './browserKey';
export {
  ApprovalController, createApproval, describeApprovalStep, approvalTimeLeft, isPngDataUrl, DEFAULT_APPROVAL_TEXTS, approvalAttribution,
} from './approval';
export type { ApprovalState, ApprovalPhase, ApprovalError, ApprovalTexts, ApprovalOptions } from './approval';
export { defineTouchqueApproval, APPROVAL_ICONS } from './approvalElement';
export type { TouchqueApprovalElement } from './approvalElement';
export { APPROVAL_STYLES } from './approvalStyles';
export { isPasskeyAutofillAvailable } from './passkeys';
export { deviceRisk, createDeviceRisk, DEVICE_RISK_FIELD, DEVICE_RISK_HEADER, DEVICE_RISK_PURPOSES } from './deviceRisk';
export { setTouchqueLogger } from './log';
export type { TouchqueWebLogger } from './log';
export { installDeviceRiskTag, REQUEST_ID_FIELD, FORM_PURPOSE_ATTRIBUTE, DEVICE_EVENT } from './deviceRiskTag';
export type { DeviceRiskTagOptions, TouchqueDevice } from './deviceRiskTag';
export type {
  DeviceRisk, DeviceRiskPurpose, DeviceRiskReport, DeviceRiskBody, DeviceRiskTraits, DeviceRiskFindings, DeviceRiskCollectOptions,
  DeviceRiskIdentifyOptions, DeviceRiskIdentification,
} from './deviceRisk';
export { deviceSealMessage } from './browserKey';
export type { DeviceSeal } from './browserKey';
export { startClientSignals, addAgentTrap, agentTrapState, AGENT_TRAP_ATTRIBUTE, AGENT_TRAP_WORD } from './clientSignals';
export type { ClientSignals, ClientSignalsProbe } from './clientSignals';
export { startPointerSummary, encodePointerSummary } from './pointerSummary';
export type { PointerSummary, PointerSummaryProbe } from './pointerSummary';
export type { PasskeyAutofillOptions } from './passkeys';
export { shouldOfferPasskey, dismissPasskeyOffer, rememberPasskey, forgetPasskeyOffer } from './upgrade';
export type { PasskeyOfferOptions } from './upgrade';

// Matches touchqueRouter's default mount paths in @touchque/node exactly —
// pairing the two needs zero `paths` config.
const DEFAULT_PATHS: TouchquePaths = {
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

export interface TouchqueWeb {
  /**
   * fetch() for routes protected with requireTouchque: re-sends while the user
   * approves, hands each step to `onStep` for YOUR UI, and runs the passkey
   * approval when a policy requires it. Resolves with your route's response.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit, options?: TouchqueFetchOptions): Promise<Response>;
  passkeys: Passkeys;
  /** Classic push / number-match 2FA — enrollment + login, no WebAuthn. */
  classic2fa: ClassicTwoFactor;
  /** Offline Sign — QR challenge / typed code for a phone with no internet. */
  offline: OfflineSign;
  /**
   * This browser's device-bound key for silent sign-ins (the shared
   * `browserKey`, or the one passed as `config.browserKey`). Its proof is
   * sent only when `config.browserKey` is set.
   */
  browserKey: BrowserKey;
  behavioral: {
    /**
     * Attach the behavioral biometrics widget to a container. Unlike the
     * passkey calls, this posts directly to Touchque (`apiBaseUrl`), gated
     * by the per-request `telemetryToken`.
     */
    attach(target: string | Element, options: AttachBehavioralOptions): BehavioralHandle;
  };
  /** `true` if the browser exposes the WebAuthn API. */
  isPasskeySupported(): boolean;
  /** `true` if a built-in platform authenticator is usable. */
  isPlatformAuthenticatorAvailable(): Promise<boolean>;
}

export function createTouchqueWeb(config: TouchqueWebConfig): TouchqueWeb {
  const http = new RelayHttp(config);
  const paths: TouchquePaths = { ...DEFAULT_PATHS, ...(config.paths ?? {}) };
  const passkeys = new Passkeys(http, paths);
  const classic2fa = new ClassicTwoFactor(http, paths);
  const offline = new OfflineSign(http, paths);
  const approveWithPasskey = (requestId: string) => passkeys.approveLogin({ requestId });
  classic2fa.approveWithPasskey = approveWithPasskey;
  const key = config.browserKey && typeof config.browserKey === 'object' ? config.browserKey : defaultBrowserKey;
  const browserProof = config.browserKey ? () => key.proof() : undefined;
  classic2fa.browserProof = browserProof;

  return {
    fetch: (input, init, options) => touchqueFetch(input, { credentials: config.credentials ?? 'same-origin', ...init }, {
      fetch: config.fetch, approveWithPasskey, browserProof, ...options,
    }),
    passkeys,
    classic2fa,
    offline,
    browserKey: key,
    behavioral: {
      attach: (target, options) =>
        attachBehavioral(target, { fetch: config.fetch, ...options }),
    },
    isPasskeySupported,
    isPlatformAuthenticatorAvailable,
  };
}

// Touchque Login (hosted sign-in) for single-page apps
export { HostedLoginClient, HostedLoginError } from './hostedLogin';
export type { HostedLoginClientOptions, LoginWithRedirectOptions, HostedLoginUser } from './hostedLogin';
export { MyAccountClient, MyAccountError } from './myAccount';
export type {
  MyAccountClientOptions, MyAccountProfile, MyAccountMethods, MyAccountSession, MyAccountApp, MyAccountConsents, ProfileChanges,
} from './myAccount';
