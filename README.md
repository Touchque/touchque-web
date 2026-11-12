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
    if (step.state === 'enroll') showQr(step.enroll.qrCodeDataUrl); // first-time link
    if (step.state === 'offline') showOfflineQr(step.offline.qrDataUrl); // no internet on the phone
    // controls.useOffline() / controls.submitCode(code) / controls.cancel()
  },
});
// res is your route's own response, once approved.
```

`touchqueFetch` re-sends the request with `X-Touchque-Token` on an interval
until the step resolves — no manual polling loop to write.

While the first-time QR is up, the server's answers to these checks carry no QR (`{ state: 'enroll', expiresAt }`,
server SDKs 5.1). `touchqueFetch` does not pass them to `onStep`, so keep showing the QR you have. When it expires,
a new QR comes as a new `enroll` step with `enroll.qrCodeDataUrl`. The approval dialog does the same.

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

`dialog.fetch()` resolves with your route's response. Closing the dialog while it waits rejects with an
`AbortError`. `dialog.login()` runs the classic push sign-in through `touchqueRouter`'s `/login` the same way.

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

## Device risk (sign-in, sign-up, reset and approval pages)

A paid add-on, off until your workspace turns it on (dashboard → Device risk). Every browser that reaches one of
these pages gets a visitor ID of your workspace, like Fingerprint's `visitorId`, and the risk engine decides whether
anything about it asks for more.

### One line on the page, one on your server

```html
<script src="https://cdn.touchque.com/device/v2.0.0/script.js" data-site-key="tqpk_…" data-purpose="sign_in"
        integrity="sha384-…" crossorigin="anonymous" async></script>
```

```typescript
// Your server, when the form arrives (any server SDK has this line):
const verdict = await tq.deviceRisk.check(req.body.touchque_request_id, { event: 'sign_in', externalUsername });
if (verdict.stepUp) { /* ask for more: a number-matched approval, a passkey, your emailed code */ }
```

Pages that already load `…/device.js` (the tag's first name) keep working: the CDN serves the same bytes, with the same
`integrity`, at both names. The dashboard's Device risk → Settings shows the tag with your site key and this version's `integrity` hash
(`dist/device-sri.json` in the package; each version has its own path, so the hash never changes under you). The
tag identifies the browser when the page loads and puts the requestId into a hidden `touchque_request_id` field of
every form on the page, forms added later included. A form's own `data-touchque-purpose="sign_up"` wins over the
tag's `data-purpose` (default `sign_in`). Touchque accepts an identification for 15 minutes and for one account: the
tag takes a new one after 10 minutes, and another after each submit, so a single-page app's next attempt is fresh.
`data-api` points it at another Touchque API host. Allow the script host in `script-src` and your API host in
`connect-src` of your Content-Security-Policy.

**How the pointer moved.** When a form is sent, the tag adds 18 characters after the requestId and a dot: how the
pointer and the fingers moved on the page, as counts computed in the browser (`startPointerSummary`): presses on a
pointer that jumped onto the button and how long they lasted, how close long strokes and swipes came to a ruler line,
how long taps lasted. Never a position, a path or what was pressed. Software that drives a browser (Playwright,
Puppeteer, Selenium, AI browser agents) jumps the pointer and presses for 0 to 3 ms; a hand takes 30 ms and more. Pass
the field to `deviceRisk.check` as it is (45 characters, inside the 64 every server SDK passes on); the risk engine
weighs it as `device_pointer_synthetic`, a number-matched step-up at most, never a refusal, in shadow until you
enforce it. No movement at all (a keyboard, a screen reader) is never a sign; Voice Control and Switch Control move
like software and get the step-up. `data-pointer="off"` on the tag leaves it out. Name it in your privacy notice with
the rest: the numbers serve the sign-in's security, tell no person from another and are not kept apart from the
verdict.

Single-page apps read `window.TouchqueDevice`: `await TouchqueDevice.ready` (the first identification, or null),
`TouchqueDevice.value()` (what to send now: the requestId and the pointer summary), `TouchqueDevice.requestId`,
`TouchqueDevice.refresh()`, and the `touchque:device` event on `document` after each new identification. With npm
instead of the tag: `installDeviceRiskTag({ siteKey, purpose })` does the same.

**What a missing tag gets.** Nothing on the page is trusted. requestIds are made only by Touchque's server, used
for one account, bound to your site's origin and to 15 minutes; your server reads the verdict by requestId and the
risk engine decides. A page without the tag, or with it blocked, sends no requestId: `deviceRisk.check` still
answers (`report: 'missing'`, or `'unknown'` / `'expired'` for one that does not verify) with
`device_identification_missing`. Ad blockers block such scripts for honest people too, so that signal only ever asks
for a number-matched step-up, never refuses, and starts in shadow like the others. Removing or blocking the tag
gets the visitor a step-up at most, never a way past a check.

### From your own domain (first-party)

Ad blockers and browser privacy lists drop scripts and calls to known third-party fingerprinting hosts, for honest
visitors too (they then get `device_identification_missing`, a step-up at most). Big sites serve the tag and its
identify call from their own domain instead, like Fingerprint's proxy integrations: two paths under `/_tq/` on your
site, passed on to Touchque.

| Your path | Goes to |
|---|---|
| `GET /_tq/device/vX.Y.Z/script.js` | `https://cdn.touchque.com/device/vX.Y.Z/script.js` (the same bytes, so the same `integrity`) |
| `POST /_tq/device-risk/identify` | `https://api.touchque.com/device-risk/identify` |

The tag then points at your domain (`data-api` is where it sends the identify call):

```html
<script src="https://www.example.com/_tq/device/v2.0.0/script.js" data-site-key="tqpk_…" data-purpose="sign_in"
        data-api="https://www.example.com/_tq" integrity="sha384-…" crossorigin="anonymous" async></script>
```

Your Content-Security-Policy needs only `'self'` for both (`script-src`, `connect-src`).

**The proxy secret.** Behind your proxy every visitor reaches Touchque from your proxy's address. Send the visitor's
address as `X-Touchque-Client-IP` together with your workspace's proxy secret as `X-Touchque-Proxy-Secret`
(`tqps_…`, dashboard → Device risk → Settings; owners and admins see it, and the API key reads it from
`GET /device-risk/settings`). Touchque then records and scores the visitor's address and counts the per-address
limit (60 identifications a minute) on it instead of on your proxy. Keep the secret on the server like the API key:
an environment variable or a secret store, never in the page or in git. A wrong secret is
`403 proxy_secret_invalid`; rotating the site key makes a new secret. Without the secret the proxy still works, but
every visitor counts against the proxy's one address: fine for small sites only. Also pass the visitor's address as
`clientIp` to `deviceRisk.check` (and `login.request`) on your server. Your own cookies are not needed: drop them
on the way.

**nginx** (in your site's `server` block):

```nginx
location /_tq/device/ {
    proxy_pass https://cdn.touchque.com/device/;
    proxy_ssl_server_name on;
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
}
location = /_tq/device-risk/identify {
    limit_except POST { deny all; }
    proxy_pass https://api.touchque.com/device-risk/identify;
    proxy_ssl_server_name on;
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Touchque-Proxy-Secret "tqps_…";   # from Device risk → Settings; keep this file out of git
    proxy_set_header X-Touchque-Client-IP $remote_addr;  # behind a load balancer: set_real_ip_from + real_ip_header first
}
```

**Cloudflare Worker** (route `www.example.com/_tq/*`; `wrangler secret put TOUCHQUE_PROXY_SECRET`):

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.startsWith('/_tq/device/')) {
      return fetch('https://cdn.touchque.com/device/' + url.pathname.slice('/_tq/device/'.length));
    }
    if (request.method === 'POST' && url.pathname === '/_tq/device-risk/identify') {
      return fetch('https://api.touchque.com/device-risk/identify', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: request.headers.get('Origin') || '',
          'X-Touchque-Proxy-Secret': env.TOUCHQUE_PROXY_SECRET,
          'X-Touchque-Client-IP': request.headers.get('CF-Connecting-IP') || '',
        },
        body: await request.text(),
      });
    }
    return new Response('Not found', { status: 404 });
  },
};
```

**Next.js middleware** (`middleware.ts`, on Vercel or your own server; Next.js 16 calls the file `proxy.ts` and the
function `proxy`; `TOUCHQUE_PROXY_SECRET` in the project's environment variables):

```ts
import { NextRequest, NextResponse } from 'next/server';

export const config = { matcher: '/_tq/:path*' };

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (req.method === 'GET' && pathname.startsWith('/_tq/device/')) {
    return NextResponse.rewrite(new URL('https://cdn.touchque.com/device/' + pathname.slice('/_tq/device/'.length)));
  }
  if (req.method === 'POST' && pathname === '/_tq/device-risk/identify') {
    const r = await fetch('https://api.touchque.com/device-risk/identify', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: req.headers.get('origin') ?? '',
        'X-Touchque-Proxy-Secret': process.env.TOUCHQUE_PROXY_SECRET ?? '',
        // On Vercel the first x-forwarded-for entry is the visitor; behind your own load balancer, its header.
        'X-Touchque-Client-IP': (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim(),
      },
      body: await req.text(),
    });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  return new Response('Not found', { status: 404 });
}
```

If you already have a middleware, add the two `/_tq/` branches at its top and `'/_tq/:path*'` to its matcher.

**Vercel rewrites** (`vercel.json`, any framework). A rewrite cannot add the proxy secret, so this suits small sites;
at volume, use the middleware above (or a Vercel function doing the same) for the identify path:

```json
{
  "rewrites": [
    { "source": "/_tq/device/:path*", "destination": "https://cdn.touchque.com/device/:path*" },
    { "source": "/_tq/device-risk/identify", "destination": "https://api.touchque.com/device-risk/identify" }
  ]
}
```

A Touchque Login custom domain (verified) serves both paths itself: Device risk → Settings then shows the tag with
`https://login.example.com/_tq`, nothing to proxy. In every case Touchque still checks the page's `Origin` against
your verified domains and listed origins, so pass `Origin` on unchanged (nginx passes it as it came; the Worker and
the middleware set it).

### From your own code

```typescript
import { deviceRisk } from '@touchque/web';

// When the form is sent (purpose: 'sign_in' | 'sign_up' | 'password_reset' | 'approval'):
const id = await deviceRisk.identify({ siteKey: 'tqpk_…', purpose: 'sign_up' });
// id: { visitorId: 'tqv_…', requestId: 'dre_…', confidence: 0.99 }, or null when Touchque could not be reached
form.elements.deviceRiskRequestId.value = id?.requestId ?? '';
```

Never trust the page's copy: your server reads the identification by `requestId` with a server SDK
(`tq.deviceRisk.getEvent(requestId)`: the visitor, how sure, what the page showed, the risk engine's verdict), checks
it for an account on sign-up and password-reset pages (`tq.deviceRisk.check(requestId, { event: 'sign_up',
externalUsername, clientIp })`), and passes it as `deviceRiskRequestId` to `login.request` and `risk.check` on
sign-in and approval pages. An identification serves one account for 15 minutes; another account gets
`device_report_replayed`.

- **The visitor ID** (`tqv_…`) belongs to your workspace only: another Touchque customer sees another one for the
  same browser. It survives cleared site data, private windows where the browser lets its traits be seen, and browser
  updates. `confidence`: 0.99 when the browser's device-bound key sealed the report, 0.95 its stored id, up to 0.9 a
  match of its traits (lower for identical computers of a fleet), 0.5 to 0.6 a first sight.
- **Site key and origins:** the site key (`tqpk_…`) is public; Touchque answers only pages on your organization's
  verified domains and their subdomains (Organization → Domains) and on the origins you list (Device risk →
  Settings). The request is a
  `text/plain` POST, so no CORS preflight; allow your Touchque API host in your Content-Security-Policy `connect-src`.
- **Relay instead:** `deviceRisk.collect({ purpose })` returns the encoded report for your server to pass as
  `deviceRisk`, if your page must not call Touchque itself.
- **The behavioral widget:** `attachBehavioral({ collectDeviceFingerprint: true })` now sends this same report with the
  telemetry; `collectDeviceSignals` and the v1 fingerprint are deprecated and Touchque no longer reads them.
- **What it reads:** coarse traits (OS, browser family and major version, time zone, languages, screen size,
  CPU cores, memory class, touch points, the graphics card's name) and short hashes of how the browser draws a
  test text, plays a test sound, which of 25 common fonts it has, a few Math results and its WebGL limits. And
  findings: browser functions replaced by script, traits that contradict each other (an anti-detect browser or
  a spoofing extension), a virtual machine or software graphics, a headless or automated browser, and a private
  window where the browser lets that be seen.
- **Sealed:** where the browser has a device-bound key (`browserKey`, the silent sign-in key), the report is
  signed with it (`touchque-device:v1`, a different message from a proof's). Touchque then knows it came whole
  from a browser holding that key, from your page's origin, once. A seal does not make the traits true: script
  on the page can lie to its own report, so Touchque checks them against each other, against the address, and
  against the devices it saw before.
- **What Touchque keeps:** no raw trait. Keyed hashes (HMAC with a key of your workspace alone, so a device is
  never linked across Touchque customers), coarse labels ("Chrome 130 · macOS · laptop"), the account, the
  country and a keyed hash of the address's network, for the 30 to 90 days your workspace sets.
- **What it does:** the risk engine counts per visitor (accounts, sign-ups, countries, stored-id resets), checks the
  browser's clock against the address and decides. Every signal only ever asks for more (a number-matched approval or
  a passkey; on a sign-up, your own extra check). It never lets anyone skip a check and never blocks on its own.
  Signals start in shadow: reported and counted, asking only on visitors your admin marked "Step up always".
- **Never respawned:** the stored id lives in `localStorage` only. A cleared browser is matched back by its traits
  on Touchque's side, not by copying the id between stores.

**Tell your users.** Use it only on sign-in, sign-up, password-reset and approval pages, and say it in your
privacy notice. In Turkey (KVKK) account security can rest on legitimate interest (art. 5/2(f)); in the EU,
reading the device needs consent unless it is strictly necessary for the security of a sign-in the user asked
for (ePrivacy art. 5(3)), and a check that lets a known device do less does not count. Ask your lawyer. A
starting text is on the dashboard's Device risk → Settings tab.

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
reads them; `attachBehavioral({ collectDeviceFingerprint: true })` sends the
Device risk report instead. What the old call computes:

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

**Device risk** (`deviceRisk.collect`, only when the workspace turns Device risk on): see
[Device risk](#device-risk-sign-in-sign-up-reset-and-approval-pages). Keyed hashes and coarse labels, kept 30
to 90 days as the workspace sets; never raw traits, never linked across workspaces.

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

The SDK keeps the browser console clean. While you integrate, `setTouchqueLogger(console)` shows its own problems (identify could not reach Touchque, telemetry that did not start); on the Device risk script tag, add `data-debug`. `setTouchqueLogger(null)` turns it off again.

## License

MIT © [Touchque](https://touchque.com)

## Touchque Login (hosted sign-in)

Sign-up and sign-in pages for your own customers, on your brand, with OpenID Connect. See [support.touchque.com/touchque-login](https://support.touchque.com/touchque-login) for this SDK's client and a quickstart.
