// The drop-in approval dialog, end to end.
//
// Your server guards a route with requireTouchQue and mounts touchqueRouter
// (for the passkey step); the page calls the route through
// <touchque-approval>, which shows each step until the user approves.
//
//   npm install                       # express, @touchque/node, @touchque/web
//   TQ_API_KEY=tq_... TQ_API_SECRET=... node server.mjs
//   open http://localhost:5207
//
// Try every screen without a phone against the SDK's fake API:
//   node ../../testing/fake-touchque-api.mjs      # prints {"port":NNNN}
//   TQ_API_BASE_URL=http://127.0.0.1:NNNN TQ_API_KEY=tq_test_key TQ_API_SECRET=test_secret node server.mjs
// and use the buttons under "Fake API" on the page (link the demo user first,
// then approve, reject, move the request to a passkey). Its QR images are
// placeholders: the dialog refuses the link QR and shows a broken offline QR.
//
// DEMO ONLY: the signed-in user is fixed. A real app takes it from its session.

import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TouchQue, touchqueRouter, requireTouchQue } from '@touchque/node';

const PORT = Number(process.env.PORT || 5207);
const USER = process.env.DEMO_USER || 'demo@example.com';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const tq = new TouchQue({
  apiKey: process.env.TQ_API_KEY,
  apiSecret: process.env.TQ_API_SECRET,
  ...(process.env.TQ_API_BASE_URL && { baseUrl: process.env.TQ_API_BASE_URL }),
});

const app = express();
app.use(express.json());

// Your auth decides who is signed in; here it is always the demo user.
app.use((req, _res, next) => { req.user = { email: USER }; next(); });

// 1. The relay the browser SDK talks to (passkey approval, enrolment, login).
app.use('/touchque', touchqueRouter(tq, {
  getUserId: (req) => req.user?.email,
  getLoginUser: (req) => req.user?.email,
}));

// 2. A route that needs the phone's approval. One line.
app.post('/api/transfer',
  requireTouchQue('SEND_MONEY', {
    client: tq,
    details: (req) => ({ Amount: `${Number(req.body?.amount) || 0} EUR`, To: 'DE89 3704 0044 0532 0130 00' }),
  }),
  (req, res) => res.json({ ok: true, sent: Number(req.body?.amount) || 0 }));

// The page and the browser SDK (a bundler does this part in a real app).
const webDist = path.dirname(require.resolve('@touchque/web'));
const simpleWebAuthn = path.join(path.dirname(require.resolve('@simplewebauthn/browser', { paths: [webDist] })), '..', 'esm');
app.use('/sdk', express.static(webDist));
app.use('/vendor/simplewebauthn', express.static(simpleWebAuthn));
app.get('/', (_req, res) => res.sendFile('index.html', { root: here }));

// Fake API controls (only when pointed at testing/fake-touchque-api.mjs).
app.post('/fake/:action', async (req, res) => {
  if (!process.env.TQ_API_BASE_URL) return res.status(404).json({ error: 'not using the fake API' });
  const r = await fetch(`${process.env.TQ_API_BASE_URL}/__test/${req.params.action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: USER, ...req.body }),
  });
  res.status(r.status).json(await r.json().catch(() => ({})));
});

app.listen(PORT, () => console.log(`Approval example on http://localhost:${PORT} (user ${USER})`));
