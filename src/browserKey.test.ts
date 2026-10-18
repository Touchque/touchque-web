import { describe, test, expect, vi } from 'vitest';
import { verify, webcrypto } from 'node:crypto';
import vectors from '../fixtures/silent-sign-in-vectors.json';
import {
  createBrowserKey, browserKey, browserProofMessage, browserKeyThumbprint, browserKeyThumbprintInput,
  type BrowserKeyStore, type BrowserProof,
} from './browserKey';
import { createTouchQueWeb } from './index';

const ORIGIN = 'https://app.example.com';
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

/** Stands in for IndexedDB (not in jsdom): keeps the CryptoKey pair like the real store does. */
function memoryStore() {
  let pair: CryptoKeyPair | undefined;
  const store: BrowserKeyStore & { saves: number; stored(): CryptoKeyPair | undefined } = {
    saves: 0,
    stored: () => pair,
    async load() { return pair; },
    async save(p) { store.saves += 1; if (!pair) pair = p; return pair; },
    async remove() { pair = undefined; },
  };
  return store;
}

const nodeKey = (store: BrowserKeyStore = memoryStore(), now?: () => number) =>
  createBrowserKey({ store, crypto: webcrypto as unknown as Crypto, origin: ORIGIN, now });

const decode = (header: string): BrowserProof => JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));

/** Verifies a proof the way the servers do: ECDSA P-256, SHA-256, raw r||s over the contract message. */
const verifies = (p: BrowserProof) => verify(
  'sha256', Buffer.from(browserProofMessage(p.aud, p.iat, p.nonce), 'utf8'),
  { key: p.jwk as unknown as webcrypto.JsonWebKey, format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(p.sig, 'base64url'),
);

describe('silent-sign-in-vectors.json browserProof', () => {
  test('message', () => {
    const m = vectors.browserProof.message;
    expect(browserProofMessage(m.aud, m.iat, m.nonce)).toBe(m.expected);
  });

  test('thumbprint (RFC 7638)', async () => {
    const t = vectors.browserProof.thumbprint;
    expect(browserKeyThumbprintInput(t.jwk)).toBe(t.canonical);
    expect(await browserKeyThumbprint(t.jwk, subtle)).toBe(t.expected);
    // Only the required members count: extra ones never change the thumbprint.
    expect(await browserKeyThumbprint({ ...t.jwk, d: 'x', ext: true, key_ops: [] } as typeof t.jwk, subtle)).toBe(t.expected);
  });

  test('the generator signed exactly our message', () => {
    const valid = vectors.browserProof.cases.find((c) => c.name === 'valid')!.proof as unknown as BrowserProof;
    expect(verifies(valid)).toBe(true);
    const header = vectors.browserProof.cases.find((c) => c.name === 'validHeaderEncoding')!.proof as string;
    expect(decode(header)).toEqual(valid);
  });
});

describe('browserKey.proof', () => {
  test('a proof per the contract that verifies with Node crypto', async () => {
    const now = 1792310400_123;
    const header = (await nodeKey(memoryStore(), () => now).proof())!;
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    const p = decode(header);
    expect(Object.keys(p)).toEqual(['v', 'jwk', 'aud', 'iat', 'nonce', 'sig']);
    expect(p).toMatchObject({ v: 1, aud: ORIGIN, iat: 1792310400 });
    expect(Object.keys(p.jwk)).toEqual(['kty', 'crv', 'x', 'y']);
    expect(p.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(p.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(p.nonce, 'base64url')).toHaveLength(16);
    expect(Buffer.from(p.sig, 'base64url')).toHaveLength(64);
    expect(verifies(p)).toBe(true);
    expect(verifies({ ...p, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' })).toBe(false);
  });

  test('one non-extractable key per browser, a new nonce per proof', async () => {
    const store = memoryStore();
    const key = nodeKey(store);
    const [a, b] = await Promise.all([key.proof(), key.proof()]);
    expect(store.saves).toBe(1); // concurrent first calls make one key
    expect(store.stored()!.privateKey.extractable).toBe(false);
    expect(store.stored()!.privateKey.usages).toEqual(['sign']);
    expect(decode(a!).jwk).toEqual(decode(b!).jwk);
    expect(decode(a!).nonce).not.toBe(decode(b!).nonce);
    // The next page load (or another tab) uses the stored key.
    expect(decode((await nodeKey(store).proof())!).jwk).toEqual(decode(a!).jwk);
  });

  test('thumbprint() matches the key in the proof; forget() makes a new key', async () => {
    const store = memoryStore();
    const key = nodeKey(store);
    expect(await key.thumbprint()).toBeNull(); // no key yet, and none made
    expect(store.saves).toBe(0);
    const first = decode((await key.proof())!);
    expect(await key.thumbprint()).toBe(await browserKeyThumbprint(first.jwk, subtle));
    await key.forget();
    expect(store.stored()).toBeUndefined();
    const second = decode((await key.proof())!);
    expect(second.jwk).not.toEqual(first.jwk);
    expect(verifies(second)).toBe(true);
  });

  test('null, never a throw, without WebCrypto, IndexedDB or an origin', async () => {
    // jsdom has no IndexedDB: the shared key has nowhere to live.
    expect(await browserKey.proof()).toBeNull();
    expect(await browserKey.thumbprint()).toBeNull();
    await expect(browserKey.forget()).resolves.toBeUndefined();
    const c = webcrypto as unknown as Crypto;
    expect(await createBrowserKey({ store: memoryStore(), crypto: {} as Crypto, origin: ORIGIN }).proof()).toBeNull();
    expect(await createBrowserKey({ store: null, crypto: c, origin: ORIGIN }).proof()).toBeNull();
    expect(await createBrowserKey({ store: memoryStore(), crypto: c, origin: 'null' }).proof()).toBeNull();
    const broken: BrowserKeyStore = {
      load: () => Promise.reject(new Error('QuotaExceededError')), save: () => Promise.reject(new Error('x')), remove: () => Promise.reject(new Error('x')),
    };
    const key = createBrowserKey({ store: broken, crypto: c, origin: ORIGIN });
    expect(await key.proof()).toBeNull();
    expect(await key.thumbprint()).toBeNull();
    await expect(key.forget()).resolves.toBeUndefined();
  });

  test('a stuck store gives up with null instead of holding up the sign-in', async () => {
    const stuck: BrowserKeyStore = { load: () => new Promise(() => {}), save: () => new Promise(() => {}), remove: async () => {} };
    const key = createBrowserKey({ store: stuck, crypto: webcrypto as unknown as Crypto, origin: ORIGIN, timeoutMs: 20 });
    expect(await key.proof()).toBeNull();
    expect(await key.thumbprint()).toBeNull();
  });

  test('a failed load is not cached', async () => {
    const store = memoryStore();
    const load = vi.spyOn(store, 'load').mockRejectedValueOnce(new Error('busy'));
    const key = nodeKey(store);
    expect(await key.proof()).toBeNull();
    expect(await key.proof()).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('createTouchQueWeb({ browserKey })', () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  function server(responses: Response[]) {
    const seen: Headers[] = [];
    const f = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return responses.shift()!;
    });
    return { fetch: f as unknown as typeof fetch, seen };
  }
  const waiting = () => json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't1' }, 202);

  test('guarded requests carry a fresh X-TouchQue-Browser proof, polls included', async () => {
    const s = server([waiting(), json({ ok: true }, 200)]);
    const tq = createTouchQueWeb({ baseUrl: ORIGIN, fetch: s.fetch, browserKey: nodeKey() });
    const res = await tq.fetch('/api/settings', { method: 'POST', headers: { 'X-CSRF': 'c' } }, { pollIntervalMs: 1 });
    expect(res.status).toBe(200);
    const proofs = s.seen.map((h) => h.get('x-touchque-browser')!);
    expect(proofs.every((p) => verifies(decode(p)))).toBe(true);
    expect(decode(proofs[0]).nonce).not.toBe(decode(proofs[1]).nonce);
    expect(s.seen[0].get('x-csrf')).toBe('c');
    expect(s.seen[1].get('x-touchque-token')).toBe('t1');
  });

  test('the classic 2FA login carries it; a silent answer resolves at once', async () => {
    const s = server([json({ status: 'success', requestId: 'silent', assurance: { phishingResistant: false, method: 'silent' } }, 200)]);
    const tq = createTouchQueWeb({ baseUrl: ORIGIN, fetch: s.fetch, browserKey: nodeKey() });
    const onStep = vi.fn();
    const result = await tq.classic2fa.login({ externalUsername: 'jane@acme.com', onStep });
    expect(result).toEqual({ status: 'success', requestId: 'silent', assurance: { phishingResistant: false, method: 'silent' } });
    expect(onStep).not.toHaveBeenCalled();
    expect(verifies(decode(s.seen[0].get('x-touchque-browser')!))).toBe(true);
  });

  test('off by default; with no key available the request goes out without the header', async () => {
    const off = server([json({ ok: true }, 200), json({ status: 'success', requestId: 'r1' }, 200)]);
    const tq = createTouchQueWeb({ baseUrl: ORIGIN, fetch: off.fetch });
    await tq.fetch('/api/settings');
    await tq.classic2fa.login();
    expect(off.seen.map((h) => h.get('x-touchque-browser'))).toEqual([null, null]);

    // `true` uses IndexedDB, which jsdom lacks: no header, no error, the usual push.
    const none = server([waiting(), json({ status: 'success', requestId: 'r1' }, 200)]);
    const tq2 = createTouchQueWeb({ baseUrl: ORIGIN, fetch: none.fetch, browserKey: true });
    expect(tq2.browserKey).toBe(browserKey);
    await expect(tq2.classic2fa.login({ pollIntervalMs: 1 })).resolves.toMatchObject({ requestId: 'r1' });
    expect(none.seen.map((h) => h.get('x-touchque-browser'))).toEqual([null, null]);

    const throwing = server([json({ ok: true }, 200)]);
    const tq3 = createTouchQueWeb({
      baseUrl: ORIGIN, fetch: throwing.fetch, browserKey: { proof: () => Promise.reject(new Error('x')), thumbprint: async () => null, forget: async () => {} },
    });
    expect((await tq3.fetch('/api/settings')).status).toBe(200);
    expect(throwing.seen[0].get('x-touchque-browser')).toBeNull();
  });
});
