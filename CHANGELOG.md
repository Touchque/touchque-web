# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
