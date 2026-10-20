# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.5.0] — 2026-10-20 — "Why?" case codes, drop-in approval dialog, passkey autofill

### Added
- **`<touchque-approval>`**, a drop-in approval dialog (web component, no framework). `defineTouchQueApproval()`
  registers it; `dialog.fetch(url, init)` calls a route guarded by any server SDK and `dialog.login()` runs the
  classic push sign-in. It opens only when the server asks for an approval and shows each step: the number to
  pick on the phone with a countdown and the reasons, the first-time link QR with recovery codes, the offline QR
  with its number and the code input (or the time-based code), the passkey step (a button, as Safari needs a
  click), and refusals with their case code. Escape or the close button cancels (`AbortError`). Attributes
  `base-url`, `credentials`, `theme` (`light`, `dark`, `auto`); properties `config`, `options`
  (`texts`, `pollIntervalMs`, `telemetry`, `approvedMs`); events `touchque-step`, `touchque-approved`,
  `touchque-error`, `touchque-close`. Restyle it with `--tq-approval-*` CSS variables. Example in
  `examples/approval/`.
- `createApproval(config, options)` / `ApprovalController`: the dialog's state machine without UI
  (`getState`, `subscribe`, `fetch`, `login`, `useOffline`, `submitCode`, `setCodeType`, `continueWithPasskey`,
  `cancel`, `close`), for your own rendering; `@touchque/react`'s `<TouchQueApproval>` uses it. Also
  `describeApprovalStep`, `approvalTimeLeft`, `DEFAULT_APPROVAL_TEXTS`, `APPROVAL_STYLES`, `APPROVAL_ICONS`
  and the types `ApprovalState`, `ApprovalPhase`, `ApprovalError`, `ApprovalTexts`, `ApprovalOptions`.
- **Passkey autofill** (WebAuthn conditional mediation): `tq.passkeys.autofill({ input, context, signal })`
  lists the user's saved passkeys in the email field's autofill and resolves like `authenticate()` once one is
  picked, with no email typed. It never opens a modal: without browser support it resolves `null` at once, as it
  does when `signal` aborts, passwordless sign-in is off or a passkey button takes over. Call it once per time the
  form shows; it never loops on errors: a failing options call is retried only for a network error, 408 or 5xx
  (after 1, 2, 4 s, `maxRetries` default 3), a refusal (400, 401, 403, 429…) throws at once, and after 5
  failures a client stops asking for the page view. It waits while the tab is hidden and closes its request
  when the tab is hidden. A refused pick goes to `onError` and autofill opens again (at most `maxRetries`
  times). Options are fetched again every 4 minutes (`refreshMs`), before the challenge runs out, and a passkey
  the server no longer knows is reported to the browser (`PublicKeyCredential.signalUnknownCredential`). Needs a relay that answers
  `/passkey/authenticate/options` without an email (server SDKs 4.0.0). `isPasskeyAutofillAvailable()`.
- **Password → passkey**: `shouldOfferPasskey({ user })` says whether to offer "Add a passkey" after a password
  or email-link sign-in (WebAuthn and a built-in authenticator here, no "Not now" here before, no passkey of
  this user used or made in this browser), `dismissPasskeyOffer(user)` remembers "Not now" in this browser
  (`remindAfterDays` to ask again), `tq.passkeys.upgrade({ user, label, onStep })` registers one and remembers
  it, `rememberPasskey` / `forgetPasskeyOffer`. The marks are kept in `localStorage` under a hash of the user,
  never the user id itself. A successful `passkeys.authenticate()` marks the browser too.
- `PasskeyAlreadyRegisteredError`: `register()` / `upgrade()` on a device that already holds a passkey for the
  account (the browser's `InvalidStateError`).
- `Step.caseCode` and `Step.reasons` (server SDKs 3.7.0): the case code of the decision (`K7P-2QX`) and why number
  matching, a passkey or a refusal. Show the code with the step: "Tell your support team: K7P-2QX".
- `TouchQueWebAPIError.caseCode`: the case code of a refusal, from the step or the body.

## [1.4.0] — 2026-10-18 — Silent sign-ins

### Added
- **Silent sign-ins.** `createTouchQueWeb({ browserKey: true })` sends a fresh proof of this browser's
  device-bound key in the `X-TouchQue-Browser` header with guarded requests (`tq.fetch`) and
  `classic2fa.login`. With `silentSignIn` on in a server SDK (3.5.0), the first phone approval in this
  browser makes it known, and a later sign-in with nothing new about it gets in without a push
  (`assurance.method: 'silent'`, `requestId: 'silent'`). Anything else asks the phone as before. Off by
  default.
- `browserKey`: one ECDSA P-256 key pair per origin, made with WebCrypto as non-extractable and kept in
  IndexedDB (database `touchque`, store `keys`, key `browser-key-v1`). `proof()` resolves the header value
  (base64url JSON: `v`, `jwk`, `aud` = `location.origin`, `iat`, a 16-byte `nonce`, the P1363 `sig` over
  `touchque-browser:v1\n{aud}\n{iat}\n{nonce}`), or `null` when WebCrypto or IndexedDB is unavailable or
  takes over 2 s; it never throws. `thumbprint()` gives the key's RFC 7638 thumbprint as the server's
  `risk.browsers` lists it; `forget()` deletes the key. `tq.browserKey`;
  `createBrowserKey({ store, crypto, origin, now, timeoutMs })` for your own storage.
- `browserProofMessage`, `browserKeyThumbprint`, `browserKeyThumbprintInput`, `BROWSER_PROOF_HEADER`, and
  `TouchQueFetchOptions.browserProof` (for `touchqueFetch` without `createTouchQueWeb`).
- Types `BrowserKey`, `BrowserKeyOptions`, `BrowserKeyStore`, `BrowserProof`, `BrowserKeyJwk`;
  `TouchQueWebConfig.browserKey`.

## [1.3.0] — 2026-10-18

### Added
- **Mirror Alarm.** When the server's step carries `canary` (server SDKs 3.4.0), `touchqueFetch` loads it
  once on the current page (a hidden image plus one `sendBeacon` with `location.origin`), so a real-time
  phishing proxy in front of your site gets the approval refused and the phone warns the user. Allow the
  canary host in your CSP `img-src` and `connect-src`. `sendCanary(step.canary)` for pages that render
  steps without `touchqueFetch`.
- `Step.canary`.
- Documented: a step that turns into `passkey_required` mid-flight (the user tapped Approve on the phone
  during a call) runs the passkey approval as before.

## [1.2.0] — 2026-10-12

### Fixed
- **Device fingerprints on http pages were all the same.** Without WebCrypto (any page not served over
  https) the fallback hash padded one 53-bit value with zeros, so every browser sent
  `tq2_fp_000…0` and looked like one shared device. The fallback now spreads over every digit and is
  marked `tq2_fpw_`; the API ignores the old all-zero value.

### Added
- **`touchqueFetch(..., { telemetry: { apiBaseUrl } })`** sends the behavioural signals for the approval
  when the server's step carries a `telemetryToken` (server SDKs 3.3.0). `classic2fa.login` takes the
  same option. Off unless set.
- **`passkeys.register(extra, { onStep })`**: when the user has a linked phone, the relay first asks for an
  approval there; `onStep` gets the `waiting` step with the number to show. A refused approval throws
  `TouchQueWebAPIError` and never opens the passkey prompt.

### Changed
- `attachBehavioral` throws when `apiBaseUrl` is not an absolute http(s) URL, instead of posting to your
  own site and losing the signals silently.

## [1.1.0] — 2026-09-30

### Security
- **A phone-side reject ends the sign-in at once, even while the offline QR is on screen.** `touchqueFetch` used to
  stop checking the push when the offline QR appeared; it now keeps checking, so a reject on the phone surfaces
  as a final `rejected` step (`reason: 'request_rejected'`) and an approval finishes the action without typing a
  code. The QR is not redrawn on every check.
- `offline.challenge({ requestId })` / `offline.verifyTotp({ requestId })` tie the QR / time-based code to the
  push (see `@touchque/node` 3.1.0).

### Added
- `Step.offline.challengeCode` / `OfflineChallenge.challengeCode`: the number to print under the QR when number
  matching applies (the phone offers it among two decoys).

## [1.0.0] — 2026-09-28

### Added
- `touchqueFetch` / `tq.fetch` — `fetch()` for routes protected with
  `requireTouchQue`: re-sends the request with `X-TouchQue-Token` while the
  user approves, hands each step to `onStep` to render in your own UI, and
  runs the passkey approval automatically when a policy requires it.
  Supports the offline QR code and the rolling time-based code via
  `StepControls.useOffline()` / `submitCode()`.

### Changed
- **Breaking:** `classic2fa.login()` is now two-phase, matching the server:
  `onStep` receives the matching number **while waiting**, before approval
  (previously it arrived only in the final, successful response — there was
  no way to show it to the user in time to complete number matching).
  Existing callers that don't pass `onStep` are unaffected; `login()` still
  resolves once with the same `ClassicLoginResult` shape (`assurance` added).

## [0.6.0] — 2026-09-27

### Added
- `PasskeyRequiredError` (with `requestId`): `classic2fa.login()` throws it when
  the workspace requires a phishing-resistant passkey for this sign-in. Approve
  with `tq.passkeys.approveLogin({ requestId: err.requestId })`.

## [0.5.0] — 2026-09-27

### Changed
- `classic2fa.login()`, `offline.challenge()` and `offline.verifyTotp()` accept a
  missing `externalUsername`. Use this with `@touchque/node` 1.8's
  `getLoginUser`, where the server takes the user from your password step and
  ignores a username sent by the browser.

## [0.4.1] — 2026-09-27

### Security
- `offline.renderQr()` only accepts a PNG data URL, so a relay can't point the
  image at an arbitrary (tracking) URL.

## [0.4.0] — 2026-09-26

### Added
- `tq.offline` — the browser half of offline approval (phone without
  internet): `challenge({ externalUsername })` asks your backend for a signed
  QR, `renderQr(target, challenge)` draws it, `countdown(challenge, onTick)`
  shows the server-side expiry, and `verify({ challengeId, code })` sends the
  7-character code the user typed from their phone. `verifyTotp(...)` is the
  optional lower-assurance time-based fallback (only when
  `challenge.totpAvailable`). Wrong / expired / locked codes resolve
  `{ approved: false, reason, attemptsLeft }`.
- `formatOfflineCodeInput(text)` / `normalizeOfflineCode(text)` for the code
  input (upper-cases, drops look-alike characters, shows `ABC-DEFG`).
- Default relay paths `/offline/challenge`, `/offline/verify`, `/offline/totp`
  match `@touchque/node`'s `touchqueRouter` (1.7.0).

## [0.3.0] — 2026-09-26

### Added
- Browser recognition for the behavioral widget: with
  `collectDeviceFingerprint: true` the telemetry now carries `deviceSignals`
  — a stable per-browser id (`localStorage`) and a fingerprint of WebGL,
  audio, installed-font count, screen, timezone and CPU/memory traits (the
  User-Agent is deliberately excluded so a browser update isn't a new
  device). `collectDeviceSignals()` is exported for direct use. The v1
  `deviceFingerprint` field is still sent.
- Requires `TenantPolicy.deviceFingerprintingEnabled` on the workspace, else
  the server drops the signals.

## [0.2.0] — 2026-09-16

### Added
- `tq.classic2fa` — companion to `tq.passkeys` for classic push /
  number-match 2FA (no WebAuthn): `enroll()`, `status()`, `waitForLink()`
  (polls with a cleanup-safe `signal`/timeout, throwing
  `EnrollmentTimeoutError` if the device never links), and `login()`.
  Replaces the hand-rolled QR-render + poll + cleanup state machine every
  partner previously wrote themselves on their dashboard page. Default
  paths (`/enroll/start`, `/enroll/status`, `/login`) match
  `@touchque/node`'s new `touchqueRouter` exactly — zero config needed to
  pair the two.
- New `EnrollmentTimeoutError` class.

## [0.1.1] — 2026-09-16

### Fixed
- `mouseJitter` (behavioral biometrics) now detects genuine movement
  *direction reversals* between consecutive mousemove steps, instead of a
  single step's own `dx/dy` ratio. The old formula flagged a smooth,
  perfectly straight diagonal drag as high "jitter" on nearly every step
  while missing real micro-wobble entirely — a diagonal-moving bot script
  could read as more "human" than an actual human. The risk engine
  (`touchque-ai-risk-engine`) treats `mouseJitter === 0` + long distance
  as bot-like linear movement and `mouseJitter > 5` as a human signal, so
  this metric needed to reflect real erraticism regardless of the
  movement's angle.

## [0.1.0] — 2026-08-27

Initial release.

### Added
- `createTouchQueWeb({ baseUrl, paths?, credentials?, headers?, fetch? })` —
  a browser client that runs WebAuthn ceremonies and posts the JSON to the
  partner's own relay backend (never TouchQue directly).
- `passkeys.register()`, `passkeys.authenticate({ email })`,
  `passkeys.approveLogin({ requestId })`, `passkeys.list()`,
  `passkeys.remove(id)`.
- `authenticate()` classifies the flow-control outcomes (`ok` /
  `requiresStepUp` / `pending2fa`) and returns the relay's untouched body as
  `raw`.
- Typed errors: `PasskeyDismissedError`, `PasskeyNotRegisteredError`,
  `PasskeyDisabledError`, `TouchQueWebAPIError`, `TouchQueWebError`.
- `isPasskeySupported()` / `isPlatformAuthenticatorAvailable()`.
- Behavioral biometrics widget: `tq.behavioral.attach(...)` /
  `attachBehavioral(...)` (container-scoped mouse / click / keystroke-timing
  telemetry). Also shipped as a standalone `<script>` build
  (`dist/touchque-behavioral.global.js`, `window.TouchQueBehavioral`),
  superseding the private `@touchque/behavioral-widget` package.
