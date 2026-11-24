# @touchque/web

Browser SDK for [Touchque](https://touchque.com). It talks only to *your own backend*
— which relays to Touchque with its API key — and never holds a secret in the
browser. Use it to drive the step-up loop any Touchque server SDK produces
(`202 { touchque, token }` until approved) and, optionally, to run WebAuthn
passkey ceremonies.

[![npm version](https://img.shields.io/npm/v/@touchque/web.svg)](https://www.npmjs.com/package/@touchque/web)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

📘 Full docs: **[support.touchque.com](https://support.touchque.com)**

Framework-agnostic (plain DOM). If you're using React, see
[`@touchque/react`](https://www.npmjs.com/package/@touchque/react) instead —
it wraps this package in hooks and components.

## Install

```bash
npm install @touchque/web
```

## Quick start — step-up on any protected route

Your server SDK protects a route (e.g. Node's `requireTouchque('SEND_MONEY')`)
and answers `202 { touchque: step, token }` until the user approves. Call it
with `touchqueFetch` instead of `fetch` and render `step` however you like:

```typescript
import { touchqueFetch } from '@touchque/web';

const res = await touchqueFetch('/api/transfer', { method: 'POST', body }, {
  onStep(step, controls) {
    if (step.state === 'waiting') showNumber(step.number);       // number matching
    if (step.enroll) showQr(step.enroll.qrCodeDataUrl);          // first-time link
    if (step.reason === 'enrollment_off') showError('No phone is linked to this account yet.'); // final, no QR
    if (step.offline?.qrDataUrl) showOfflineQr(step.offline.qrDataUrl); // no internet on the phone
    // controls.useOffline() / controls.submitCode(code) / controls.cancel()
  },
});
// res is your route's own response once approved, or the final refusal (4xx), or the final 202 of an
// enrollment_off step: a 202 whose body has `touchque` is a step, not your route's answer.
```

`touchqueFetch` re-sends the request with `X-Touchque-Token` on an interval
until the step resolves — no manual polling loop to write.

While the first-time QR is up, the server's answers to these checks carry no QR (`{ state: 'enroll', expiresAt }`,
server SDKs 5.1). `touchqueFetch` does not pass them to `onStep`, so keep showing the QR you have. About 15 s
before it expires, a new QR comes as a new `enroll` step with `enroll.qrCodeDataUrl` and new recovery codes:
replace both, the old ones stop working. The approval dialog does the same.

An `enroll` step with `reason: 'enrollment_off'` (server SDKs 5.2) means the user has no phone linked and this route
may not show a linking QR (`enroll: false`, e.g. a sign-in before the password step). It is final, and it has no
`enroll`: `touchqueFetch` passes it to `onStep` once and returns its response, a 202, with no more checks. That 202
is not your route's answer, though `res.ok` is true: tell it apart by the `touchque` in its body, or by the step.
`classic2fa.login()`, `passkeys.register()` and the approval dialog's `fetch()` reject with a `TouchqueWebAPIError`
(status 202) instead. The dialog shows "No phone is linked to this account yet. Link the Touchque app first."
(`texts.errors.enrollment_off`; when you translated `not_linked` but not this one, your `not_linked`).

A refusal your server sends in its own error shape (server SDKs 5.1 `errorBody`) may have no `touchque` in the
body. Its `X-Touchque-State` and `X-Touchque-Reason` headers then give the step that `onStep` and the dialog get.
When your API is on another origin, list both in its `Access-Control-Expose-Headers`, or the page cannot read them.

## Drop-in approval dialog (no UI to write)

`<touchque-approval>` is the step-up UI, ready made: a web component that works with any framework or none.

```html
<touchque-approval base-url="/touchque"></touchque-approval>

<script type="module">
  import { defineTouchqueApproval } from '@touchque/web';
  defineTouchqueApproval();

  const dialog = document.querySelector('touchque-approval');
  const res = await dialog.fetch('/api/transfer', { method: 'POST', body }); // your guarded route
</script>
```

The dialog opens only when your server asks for an approval, and shows each step:

- the push wait, with the number to pick on the phone, a countdown and why the phone is asked;
- the QR to link a phone the first time, with the recovery codes;
- "Verify offline": the offline QR, its number and the code input (or the 6-digit time-based code);
- the passkey step, behind a button (Safari needs a click for WebAuthn);
- refusals (rejected, expired, blocked, paused, rate limited) with their case code.

`dialog.fetch()` resolves with your route's response, or with the final refusal (4xx). Closing the dialog while
it waits rejects with an `AbortError`; an `enrollment_off` step (no phone linked) rejects with a
`TouchqueWebAPIError` (status 202), and its error stays on screen. `dialog.login()` runs the classic push sign-in
through `touchqueRouter`'s `/login` the same way.

- `base-url`: where `touchqueRouter` (or your relay) is mounted; it serves the passkey step.
  `credentials="include"` for a cookie session on another origin. Or set the `config` property to a full
  `createTouchqueWeb` config.
- `theme`: `light` (default), `dark` or `auto`. Restyle with CSS variables on the element:
  `--tq-approval-accent`, `-accent-fg`, `-bg`, `-fg`, `-muted`, `-border`, `-danger`, `-radius`, `-font`.
- `options`: `{ texts, pollIntervalMs, telemetry, approvedMs }`. Every text is in `DEFAULT_APPROVAL_TEXTS`;
  override any of them, for example to translate.
- Events: `touchque-step` (`detail.step`), `touchque-approved`, `touchque-error` (`detail.error`),
  `touchque-close`.
- Your own UI on the same logic: `createApproval(config)` returns the headless controller
  (`subscribe`, `getState`, `fetch`, `login`, `useOffline`, `submitCode`, `continueWithPasskey`, `cancel`).

A runnable example, with a fake API to try every screen without a phone, is in
[`examples/approval/`](https://github.com/Touchque/touchque-web/blob/main/examples/approval/server.mjs). React: `<TouchqueApproval>` in `@touchque/react`.

## Passkeys

```typescript
import { createTouchqueWeb } from '@touchque/web';

const tq = createTouchqueWeb({ baseUrl: 'https://api.example.com' });

const result = await tq.passkeys.authenticate({ email: 'user@example.com' });
if (result.ok) {
  // signed in
} else if (result.requiresStepUp) {
  // fall back to push / number-match
}
```

`createTouchqueWeb`'s default relay paths (`/passkey/register/options`,
`/enroll/start`, `/login`, …) match `touchqueRouter` from `@touchque/node`
exactly, so pairing the two needs zero `paths` configuration.

### Passkey autofill

Let the browser offer the user's passkeys in the email field's autofill, next to saved addresses (WebAuthn
conditional mediation). Picking one signs in; nobody types an email.

```html
<input type="email" name="email" autocomplete="username webauthn">
```

```typescript
const controller = new AbortController();
const result = await tq.passkeys.autofill({ input: 'input[name=email]', signal: controller.signal });
if (result?.ok) {
  // signed in, like passkeys.authenticate()
}
```

- It never opens a modal. In a browser without passkey autofill it resolves `null` at once, so keep your normal
  form and "Sign in with a passkey" button.
- Start it once when the sign-in form shows and abort it when the form goes away. A passkey button
  (`passkeys.authenticate`) takes over from it; start autofill again when the form is back. Never restart it on
  an error: it retries by itself only what may pass later (a network error, 408, 5xx; after 1, 2, 4 s,
  `maxRetries`), throws at once on a refusal (400, 401, 403, 429…), and one client stops asking after 5
  failures in a page view. Passwordless sign-in turned off resolves `null`.
- It waits while the tab is hidden and closes its open request when the tab is hidden.
- A pick your server refuses (a passkey it no longer knows) goes to `onError` and autofill opens again.
- The relay is asked for options with no `email`, so they accept any passkey of your site. `touchqueRouter`
  and the other server SDK relays (4.0.0) do this, and the passkey the user picks names the account.
- Options are fetched again every 4 minutes (`refreshMs`), before Touchque's 5-minute challenge runs out. A
  passkey your server no longer knows is reported to the browser
  (`PublicKeyCredential.signalUnknownCredential`), so it stops offering it.

### Password → passkey

Right after a password or email-link sign-in, offer to add a passkey on this device, once per browser:

```typescript
import { shouldOfferPasskey, dismissPasskeyOffer } from '@touchque/web';

if (await shouldOfferPasskey({ user: email })) {
  // show "Add a passkey" / "Not now"
  // Add:     await tq.passkeys.upgrade({ user: email, onStep }); // the phone approves first if one is linked
  // Not now: dismissPasskeyOffer(email);
}
```

`shouldOfferPasskey` is true when WebAuthn and a built-in authenticator (Touch ID, Face ID, Windows Hello,
Android screen lock) are available, the user has not said "Not now" in this browser, and no passkey of theirs
was made or used here. The marks are kept in `localStorage` under a hash of the user, never the id itself.
`upgrade` registers through your relay's `/passkey/register/*` (`touchqueRouter` needs `getUserId`) and
remembers it; a device that already holds one throws `PasskeyAlreadyRegisteredError`. The full migration
guide is in the [docs](https://support.touchque.com/passkey-migration).

## Classic push 2FA (enroll + login)

```typescript
import { ClassicTwoFactor } from '@touchque/web';

const classic = new ClassicTwoFactor(httpClient);
await classic.login({
  onStep(step, controls) {
    // same Step shape as touchqueFetch above
  },
});
```

## Offline sign

`Step.state === 'offline'` carries `{ qrDataUrl, totpAvailable, challengeCode? }` — render the
QR (the phone scans it without internet and shows a 7-character code) and
call `controls.submitCode(code)` once the user types it.

- When `challengeCode` is present (number matching), print it under the QR: the phone shows it among two
  decoys and the user taps the one that matches.
- While the QR is on screen `touchqueFetch` keeps checking the push. If the user **rejects it on the phone**
  you get a final `rejected` step straight away (`reason: 'request_rejected'`) — the QR is dead, so reset your
  form. Approving the push instead finishes the sign-in without typing a code.

## Behavioral biometrics (optional)

```typescript
import { attachBehavioral } from '@touchque/web';

attachBehavioral(formElement, { telemetryToken, requestId });
```

Only active when your integration has behavioral biometrics enabled in the
Dashboard; otherwise it's a no-op.

## Mirror Alarm (phishing-proxy detection)

With server SDKs 3.4.0 the first waiting step carries `canary: { url }`. `touchqueFetch` (and so
`classic2fa.login` and the React hooks) loads it on the page that shows the sign-in, as a hidden 1x1 image,
and sends one `navigator.sendBeacon` to it with `location.origin`. If that page is not on your site, i.e. a
real-time phishing proxy relaying it, Touchque refuses the approval and the phone warns the user. Allow the
canary host (your Touchque API host) in your Content-Security-Policy `img-src` and `connect-src`. If you
render steps without `touchqueFetch`, call `sendCanary(step.canary)` once yourself.

## Silent sign-ins (stop asking when nothing is new)

A user who approved on the phone in this browser a little while ago, with nothing new about the sign-in since,
does not need another push. Touchque's risk engine decides; your server skips the push only when it says so.

```typescript
import { createTouchqueWeb } from '@touchque/web';

const tq = createTouchqueWeb({ baseUrl: 'https://api.example.com', browserKey: true });

const result = await tq.classic2fa.login({ onStep }); // or tq.fetch('/api/...') on a guarded route
if (result.assurance?.method === 'silent') {
  // a known browser: no push was sent
}
```

With `browserKey: true` the SDK keeps one ECDSA P-256 key for your site in this browser (WebCrypto,
non-extractable, in IndexedDB `touchque` / `keys`) and sends a fresh signed proof of it in the
`X-Touchque-Browser` header with every guarded request and the classic 2FA login. Turn on `silentSignIn` in your
server SDK (3.5.0). The first approval on the phone in this browser makes it known. Later, when Touchque finds
nothing new (the same browser, a recent approval from the phone linked now, a familiar country and network, no
risk signal, an everyday action), your server lets the user in at once. Anything else asks the phone as usual.

- No WebCrypto (an http page other than localhost) or no IndexedDB (some private windows and sandboxed frames):
  no header is sent and sign-ins ask the phone as before. Nothing throws, and a stuck IndexedDB is given up on
  after 2 seconds.
- A relay on another origin must allow `X-Touchque-Browser` in `Access-Control-Allow-Headers`.
- `tq.browserKey.forget()` (or `browserKey.forget()`) deletes this browser's key, so the next sign-in counts as a
  new browser. Use it on shared computers and on "sign out everywhere", and forget the user's browsers on the
  server too (`risk.forgetBrowsers`).
- `await browserKey.thumbprint()` is this browser's key thumbprint as the server's `risk.browsers` lists it, to
  mark "this browser" in an approved-browsers list (`null` before the first proof).
- Without `createTouchqueWeb`: `touchqueFetch(url, init, { browserProof: browserKey.proof })`, or put
  `await browserKey.proof()` (`null` when unavailable) in the `X-Touchque-Browser` header yourself.
- Where the browser has `navigator.userAgentData` (Chromium), the proof also carries `hints`: the platform, its
  version, the browser's full version list (at most 8 brands) and the device model, read once per page load
  (given up on after 300 ms). They are a hint the server reads for device trust, never a proof: they are not
  signed. Firefox and Safari send no `hints`.

## Device risk

Touchque Device Risk is a separate product with its own SDK: [`@touchque/device-risk`](https://www.npmjs.com/package/@touchque/device-risk) for the browser (the script tag served at `cdn.touchque.com/device`) and a server package in each language. This package no longer has it. With both products on a page, pass its report to the behavioral widget (`attachBehavioral(el, { deviceRiskReport: () => deviceRisk.collect({ purpose: 'sign_in' }) })`) and its requestId to `login.request` as `deviceRiskRequestId` on your server.

## "Why?": case codes

Steps from server SDKs 4.0.0 carry `caseCode` (`K7P-2QX`) and `reasons`. Show the code with the step or the
refusal, "Tell your support team: K7P-2QX"; your team opens the whole decision by it in the Touchque dashboard.
`TouchqueWebAPIError.caseCode` carries it on refusals.

## Privacy

What this package sends, and how long Touchque keeps it. Mention it in your
privacy notice (KVKK / GDPR).

**Interaction signals** (`attachBehavioral`, only when the workspace enables
behavioral biometrics): per-challenge aggregates of mouse distance and jitter,
click count, keystroke count and average keystroke speed. No key values,
characters or pointer coordinates leave the browser. The server keeps them for
60 seconds and compares them with fixed bot rules; no per-user profile is
built from them.

**Device signals (deprecated)** (`collectDeviceSignals()`): Touchque no longer
reads them; Touchque Device Risk (`@touchque/device-risk`) replaced them. What
the old call computes:

- a random id in `localStorage` (`tq_device_id`), kept until the user clears
  site data;
- a SHA-256 digest of coarse browser traits (platform, language, time zone,
  screen size, CPU cores, memory class, touch points, WebGL renderer, canvas
  and audio digests, font count, cookie and Do Not Track settings).

On the server, keyed hashes of these are kept as follows:

| What | How long |
|---|---|
| Browsers a user approved a sign-in from (at most 5 per user) | 30 days |
| The browser of a sign-in still waiting for approval | 15 minutes |
| Accounts seen per browser and per address (velocity) | 1 hour |
| Recognised browsers in your workspace | Deleted after 400 days unseen |
| Risk assessment records (pseudonymised, train a shadow-mode model) | 365 days |

**Mirror Alarm canary** (always, when the server's step carries one): the page's origin, whether it runs in
a frame, the host of `document.referrer`, and the address the request came from, kept with the sign-in
request it belongs to.

**Silent sign-ins** (only with `browserKey: true`): the public half of this browser's key, your page's origin,
the time and a random nonce, signed with the key. The private key never leaves the browser. Touchque keeps the
key's thumbprint with the user who approved in that browser, with when it was last approved and last used;
`risk.forgetBrowsers` on your server removes it.

## Security

- This package never sees your API secret — it only ever calls your backend.
- The `X-Touchque-Token` it echoes back is opaque to the browser; it's signed
  server-side and bound to one user + action + transaction.
- The browser key cannot be read out by script (non-extractable). Each proof names your page's origin and is
  fresh: Touchque accepts its nonce once, and only within 5 minutes of its time.
- See [SECURITY.md](https://github.com/Touchque/touchque-web/blob/main/SECURITY.md) to report a vulnerability.

## Requirements

- A browser with `fetch` and (for passkeys) WebAuthn support.
- For silent sign-ins: a secure context (https or localhost) with IndexedDB.
- A Touchque server SDK on your backend relaying the requests.

## Logging

The SDK keeps the browser console clean. While you integrate, `setTouchqueLogger(console)` shows its own problems (telemetry that did not start). `setTouchqueLogger(null)` turns it off again.

## License

MIT © [Touchque](https://touchque.com)

## Touchque Login (hosted sign-in)

Sign-up and sign-in pages for your own customers, on your brand, with OpenID Connect. See [support.touchque.com/touchque-login](https://support.touchque.com/touchque-login) for this SDK's client and a quickstart.
