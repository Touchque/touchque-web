# @touchque/web example

A single Node process that:

- serves the static page `index.html` and this package's built `dist/`,
- acts as the **relay backend**: exposes the default `/passkey/*` routes and
  forwards each to the TouchQue Authenticator API with `@touchque/node`.

## Run

```bash
# from sdks/touchque-web
npm run build

# point it at a running authenticator backend (default http://localhost:5001)
# and give it API credentials from your TouchQue dashboard
export TQ_API_KEY=tq_xxx
export TQ_API_SECRET=xxx
# export TQ_API_BASE_URL=http://localhost:5001   # optional

node examples/relay.js
```

Open <http://localhost:3999>.

- **Register a passkey** first (uses the demo user `demo@example.com`).
- Then **Sign in with a passkey**.

For the WebAuthn ceremonies to succeed in a normal browser you need a real
platform authenticator, or Chrome DevTools → **WebAuthn** → "Enable virtual
authenticator environment".

> Demo shortcut: the relay reads the user for register/list/remove from the
> `x-demo-user` header / `?user=` query param. A real app derives it from an
> authenticated session.

## Approval dialog (`approval/`)

`<touchque-approval>` in front of a route guarded with `requireTouchQue('SEND_MONEY')`, with
`touchqueRouter` mounted for the passkey step. Express + `@touchque/node` + this package.

```bash
cd examples/approval && npm install
TQ_API_KEY=tq_xxx TQ_API_SECRET=xxx node server.mjs    # your workspace
open http://localhost:5207
```

Without a workspace or a phone, point it at the SDK's fake API and use the page's "Fake API" buttons (link the
demo user, approve, reject, ask for a passkey):

```bash
PORT=5208 node ../../../testing/fake-touchque-api.mjs
TQ_API_BASE_URL=http://127.0.0.1:5208 TQ_API_KEY=tq_test_key TQ_API_SECRET=test_secret node server.mjs
```

The fake API's QR images are placeholders, so the dialog refuses the first-time link QR (it accepts only real
PNG images) and shows the offline QR as a broken image; link the demo user first.
