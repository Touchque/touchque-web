// Silent sign-ins end to end against the shared fake TouchQue API
// (testing/fake-touchque-api.mjs): this package's proofs, passed through a
// server untouched, are what TouchQue reads to know a browser.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, verify, webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { createTouchQueWeb, createBrowserKey, browserKeyThumbprint, browserProofMessage, type BrowserKeyStore, type BrowserProof, type Step } from './index';

const USER = 'jane@acme.com';
let fake: ChildProcess;
let base = '';

beforeAll(async () => {
  fake = spawn(process.execPath, [resolve(__dirname, '../testing/fake-touchque-api.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    fake.once('error', reject);
    fake.stdout!.once('data', (chunk) => resolve(JSON.parse(String(chunk).split('\n')[0]).port));
  });
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => { fake?.kill(); });

const control = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const calls = async (): Promise<Array<{ path: string; body: Record<string, unknown> }>> => (await fetch(`${base}/__test/calls`)).json();

beforeEach(async () => {
  await control('/__test/reset');
  await control('/__test/link', { user: USER });
});

/** A signed call to the fake API, as a server SDK makes it. */
async function api(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', 'test_secret')
    .update(`${method}:${path}:${ts}:${nonce}:${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'tq_test_key', 'X-Signature': signature, 'X-Timestamp': ts, 'X-Nonce': nonce },
    body: raw || undefined,
  });
  return { status: res.status, body: await res.json() };
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Stands in for your server with a TouchQue server SDK and `silentSignIn: true`
 * on the classic POST /login route: X-TouchQue-Browser goes to TouchQue as is.
 */
async function yourServer(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const proof = headers.get('x-touchque-browser') || undefined;
  const token = headers.get('x-touchque-token');
  if (token) {
    const { body } = await api('GET', `/login/status/${token}`);
    return body.status === 'CONFIRMED'
      ? reply(200, { status: 'success', requestId: token, assurance: body.assurance })
      : reply(202, { touchque: { state: 'waiting', requestId: token }, token });
  }
  if (proof) {
    const check = await api('POST', '/risk/check', { externalUsername: USER, type: 'LOGIN', browserProof: proof });
    if (check.status === 200 && check.body.prompt === false) {
      return reply(200, { status: 'success', requestId: 'silent', assurance: { phishingResistant: false, method: 'silent' } });
    }
  }
  const { body } = await api('POST', '/login/request', { externalUsername: USER, type: 'LOGIN', ...(proof && { browserProof: proof }) });
  return reply(202, { touchque: { state: 'waiting', requestId: body.requestId }, token: body.requestId });
}

function memoryStore(): BrowserKeyStore {
  let pair: CryptoKeyPair | undefined;
  return { load: async () => pair, save: async (p) => (pair ??= p), remove: async () => { pair = undefined; } };
}

const decode = (header: string): BrowserProof => JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));

describe('silent sign-ins against the shared fake API', () => {
  test('the first approval makes this browser known; the next sign-in skips the phone', async () => {
    const key = createBrowserKey({ store: memoryStore(), crypto: webcrypto as unknown as Crypto });
    const tq = createTouchQueWeb({ baseUrl: 'https://app.example.com', fetch: yourServer as typeof fetch, browserKey: key });

    // 1. A new browser: TouchQue asks, the push carries the proof, the user approves on the phone.
    const steps: Step[] = [];
    let approved = false;
    const first = await tq.classic2fa.login({
      pollIntervalMs: 5,
      onStep: (step) => {
        steps.push(step);
        if (!approved && step.state === 'waiting') { approved = true; void control('/__test/approve', { id: step.requestId }); }
      },
    });
    expect(first.assurance).toEqual({ phishingResistant: false, method: 'push' });
    expect(steps[0].state).toBe('waiting');
    const before = await calls();
    expect(before.map((c) => c.path).slice(0, 2)).toEqual(['/risk/check', '/login/request']);
    const pushed = before[1].body.browserProof as string;
    const proof = decode(pushed);
    expect(proof.aud).toBe(location.origin);
    expect(verify(
      'sha256', Buffer.from(browserProofMessage(proof.aud, proof.iat, proof.nonce)),
      { key: proof.jwk as unknown as webcrypto.JsonWebKey, format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(proof.sig, 'base64url'),
    )).toBe(true);

    // TouchQue lists the browser under the thumbprint this browser computes for itself.
    const { body: listed } = await api('GET', `/risk/browsers?externalUsername=${encodeURIComponent(USER)}`);
    expect(listed.browsers).toHaveLength(1);
    expect(listed.browsers[0]).toMatchObject({ thumbprint: await key.thumbprint(), lastMfaMethod: 'push' });
    expect(listed.browsers[0].thumbprint).toBe(await browserKeyThumbprint(proof.jwk, webcrypto.subtle as unknown as SubtleCrypto));

    // 2. Nothing new: TouchQue answers prompt:false, the guarded request goes through with no push.
    await control('/__test/opts', { silent: true });
    const mark = (await calls()).length;
    const res = await tq.fetch('https://app.example.com/login', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requestId: 'silent', assurance: { method: 'silent' } });
    const after = await calls();
    expect(after.slice(mark).map((c) => c.path)).toEqual(['/risk/check']);
    const checked = decode((await (await fetch(`${base}/__test/last-check`)).json()).browserProof);
    expect(checked.jwk).toEqual(proof.jwk);
    expect(checked.nonce).not.toBe(proof.nonce);
  });

  test('without a usable key the sign-in asks the phone as before', async () => {
    const tq = createTouchQueWeb({ baseUrl: 'https://app.example.com', fetch: yourServer as typeof fetch, browserKey: true }); // jsdom: no IndexedDB
    await control('/__test/opts', { silent: true });
    let approved = false;
    const result = await tq.classic2fa.login({
      pollIntervalMs: 5,
      onStep: (step) => { if (!approved && step.state === 'waiting') { approved = true; void control('/__test/approve', { id: step.requestId }); } },
    });
    expect(result.assurance?.method).toBe('push');
    const made = await calls();
    expect(made[0]).toMatchObject({ path: '/login/request' });
    expect(made[0].body.browserProof).toBeUndefined();
  });
});
