// Minimal relay backend for the @touchque/web example.
//
// It exposes the default /passkey/* routes the browser SDK calls and forwards
// each to the TouchQue Authenticator API with @touchque/node. It also serves
// the static example page and this package's built dist/, so the whole demo
// is one process.
//
//   TQ_API_KEY=tq_...  TQ_API_SECRET=...  node examples/relay.js
//   # then open http://localhost:3999
//
// DEMO ONLY: a real app derives `externalUsername` from an authenticated
// session. Here it is taken from the `x-demo-user` header / `?user=` so the
// page can be driven without a login system.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { TouchQue } = require('@touchque/node');

const PORT = process.env.PORT || 3999;
const AUTH_BASE = process.env.TQ_API_BASE_URL || 'http://localhost:5001';

if (!process.env.TQ_API_KEY || !process.env.TQ_API_SECRET) {
  console.error('Set TQ_API_KEY and TQ_API_SECRET (from your TouchQue dashboard) before running.');
  process.exit(1);
}

const tq = new TouchQue({
  apiKey: process.env.TQ_API_KEY,
  apiSecret: process.env.TQ_API_SECRET,
  baseUrl: AUTH_BASE,
});

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

function demoUser(req) {
  const url = new URL(req.url, `http://x`);
  return req.headers['x-demo-user'] || url.searchParams.get('user') || 'demo@example.com';
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    // ── static: example page + built SDK ──────────────────────────────
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), {
        'Content-Type': 'text/html',
      });
    }
    if (req.method === 'GET' && pathname.startsWith('/dist/')) {
      const distDir = path.join(__dirname, '..', 'dist');
      const file = path.join(distDir, pathname.slice('/dist/'.length));
      // Never serve outside dist/ (path-traversal guard).
      if (file !== distDir && !file.startsWith(distDir + path.sep)) {
        return send(res, 403, { error: 'forbidden' });
      }
      return send(res, 200, fs.readFileSync(file, 'utf8'), { 'Content-Type': 'text/javascript' });
    }

    // ── relay: passwordless-primary sign-in ───────────────────────────
    if (req.method === 'POST' && pathname === '/passkey/authenticate/options') {
      const { email } = await readBody(req);
      return send(res, 200, await tq.webauthn.primaryOptions({ externalUsername: email }));
    }
    if (req.method === 'POST' && pathname === '/passkey/authenticate/verify') {
      const { attemptId, response } = await readBody(req);
      const r = await tq.webauthn.primaryVerify({ attemptId, response });
      if (r.success) return send(res, 200, { status: 'success', redirect_url: '/', requestId: r.requestId });
      if (r.requiresStepUp) return send(res, 200, { requiresStepUp: true });
      return send(res, 401, { error: 'verification_failed' });
    }

    // ── relay: passkey management (DEMO user) ─────────────────────────
    if (req.method === 'POST' && pathname === '/passkey/register/options') {
      return send(res, 200, await tq.webauthn.registerOptions({ externalUsername: demoUser(req), discoverable: true }));
    }
    if (req.method === 'POST' && pathname === '/passkey/register/verify') {
      const { response, label } = await readBody(req);
      return send(res, 200, await tq.webauthn.registerVerify({ externalUsername: demoUser(req), response, label }));
    }
    if (req.method === 'GET' && pathname === '/passkey/credentials') {
      return send(res, 200, await tq.webauthn.listCredentials({ externalUsername: demoUser(req) }));
    }
    if (req.method === 'DELETE' && pathname.startsWith('/passkey/credentials/')) {
      const id = decodeURIComponent(pathname.split('/').pop());
      return send(res, 200, await tq.webauthn.deleteCredential(id));
    }

    send(res, 404, { error: 'not_found' });
  } catch (e) {
    send(res, e.status && e.status < 500 ? e.status : 502, { error: e.data?.error || e.message || 'relay_error' });
  }
});

server.listen(PORT, () => console.log(`relay + example on http://localhost:${PORT}  (auth API: ${AUTH_BASE})`));
