import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, createHash, sign as signRaw, webcrypto } from 'node:crypto';
import { HostedLoginClient, HostedLoginError } from './hostedLogin';

// Node's own (file-less) Web Storage hides jsdom's: plain in-memory ones.
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() };
}
vi.stubGlobal('sessionStorage', memoryStorage());
vi.stubGlobal('localStorage', memoryStorage());
// jsdom has no SubtleCrypto: use Node's.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const ISSUER = 'https://acme.login.touchque.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (p: Record<string, unknown>) => {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(p)}`;
  return `${input}.${signRaw('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
};

let lastAuthorize: URL;
let refreshCount = 0;
const refreshCalls: URLSearchParams[] = [];
function mockFetch(nonceFor: () => string) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u.pathname === '/.well-known/jwks.json') return reply(200, { keys: [{ kty: 'RSA', kid: 'k1', n: jwk.n, e: jwk.e }] });
    if (u.pathname === '/oauth/token') {
      const f = new URLSearchParams(String(init?.body));
      const now = Math.floor(Date.now() / 1000);
      if (f.get('grant_type') === 'authorization_code') {
        const challenge = createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (challenge !== lastAuthorize.searchParams.get('code_challenge')) return reply(400, { error: 'invalid_grant' });
        const at = 'at-1';
        return reply(200, { access_token: at, expires_in: 1, refresh_token: 'tqr_1', id_token: jwt({ iss: ISSUER, sub: 'usr_1', aud: 'c1', exp: now + 300, nonce: nonceFor(), email: 'a@acme.test', at_hash: createHash('sha256').update(at).digest().subarray(0, 16).toString('base64url') }) });
      }
      if (f.get('grant_type') === 'refresh_token') {
        refreshCount += 1;
        refreshCalls.push(f);
        if (f.get('audience')) return reply(200, { access_token: `me-${refreshCount}`, expires_in: 600, scope: f.get('scope'), refresh_token: `tqr_${refreshCount + 1}` });
        return reply(200, { access_token: `at-${refreshCount + 1}`, expires_in: 300, refresh_token: `tqr_${refreshCount + 1}` });
      }
    }
    return reply(404, {});
  });
}

describe('HostedLoginClient', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); refreshCount = 0; refreshCalls.length = 0; });

  it('signs in with PKCE, verifies the ID token, refreshes once for parallel callers', async () => {
    const client = new HostedLoginClient({ domain: 'acme.login.touchque.com', clientId: 'c1', redirectUri: 'https://app/cb', audience: 'https://api.acme.test' });
    lastAuthorize = new URL(await client.buildAuthorizeUrl({ appState: { to: '/orders' }, screenHint: 'signup' }));
    expect(lastAuthorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(lastAuthorize.searchParams.get('audience')).toBe('https://api.acme.test');
    expect(lastAuthorize.searchParams.get('screen_hint')).toBe('signup');
    globalThis.fetch = mockFetch(() => lastAuthorize.searchParams.get('nonce') as string) as unknown as typeof fetch;
    const state = lastAuthorize.searchParams.get('state');
    const out = await client.handleRedirectCallback(`https://app/cb?code=c&state=${state}&iss=${encodeURIComponent(ISSUER)}`);
    expect(out.appState).toEqual({ to: '/orders' });
    expect(client.getUser()?.email).toBe('a@acme.test');
    // expires_in 1: the next call refreshes, and two callers share one refresh.
    const [a, b] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    expect(a).toBe('at-2');
    expect(b).toBe('at-2');
    expect(refreshCount).toBe(1);
  });

  it('gets My Account API tokens with the refresh token, one refresh at a time', async () => {
    const client = new HostedLoginClient({ domain: ISSUER, clientId: 'c1', redirectUri: 'https://app/cb' });
    lastAuthorize = new URL(await client.buildAuthorizeUrl());
    globalThis.fetch = mockFetch(() => lastAuthorize.searchParams.get('nonce') as string) as unknown as typeof fetch;
    await client.handleRedirectCallback(`https://app/cb?code=c&state=${lastAuthorize.searchParams.get('state')}`);
    const [api, me] = await Promise.all([client.getAccessToken(), client.getMyAccountToken('update:me read:me')]);
    expect(api).toBe('at-2');
    expect(me).toBe('me-2');
    // Each call used the refresh token the one before it got back.
    expect(refreshCalls.map((f) => f.get('refresh_token'))).toEqual(['tqr_1', 'tqr_2']);
    expect(refreshCalls[1].get('audience')).toBe(`${ISSUER}/me/`);
    expect(refreshCalls[1].get('scope')).toBe('read:me update:me');
    expect(await client.getMyAccountToken('read:me update:me')).toBe('me-2');
    expect(refreshCount).toBe(2);
    expect(client.accountUrl('devices')).toBe(`${ISSUER}/account/devices`);
    expect(client.myAccount().accountPageUrl()).toBe(`${ISSUER}/account`);
  });

  it('refuses a wrong state, a replayed nonce and a callback from another tab', async () => {
    const client = new HostedLoginClient({ domain: ISSUER, clientId: 'c1', redirectUri: 'https://app/cb' });
    lastAuthorize = new URL(await client.buildAuthorizeUrl());
    await expect(client.handleRedirectCallback('https://app/cb?code=c&state=nope')).rejects.toMatchObject({ code: 'state_mismatch' });
    await expect(client.handleRedirectCallback('https://app/cb?code=c&state=x')).rejects.toMatchObject({ code: 'state_missing' });
    lastAuthorize = new URL(await client.buildAuthorizeUrl());
    globalThis.fetch = mockFetch(() => 'replayed') as unknown as typeof fetch;
    await expect(client.handleRedirectCallback(`https://app/cb?code=c&state=${lastAuthorize.searchParams.get('state')}`)).rejects.toBeInstanceOf(HostedLoginError);
    expect(client.isAuthenticated()).toBe(false);
  });

  it('checks iss (RFC 9207): this issuer or none is accepted, a foreign or empty one is refused before the code exchange', async () => {
    const client = new HostedLoginClient({ domain: ISSUER, clientId: 'c1', redirectUri: 'https://app/cb' });
    const fetchMock = mockFetch(() => lastAuthorize.searchParams.get('nonce') as string);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    for (const answer of ['code=c&iss=https%3A%2F%2Fevil', `code=c&iss=${encodeURIComponent(`${ISSUER}/`)}`, 'code=c&iss=', 'error=access_denied&iss=https%3A%2F%2Fevil']) {
      lastAuthorize = new URL(await client.buildAuthorizeUrl());
      await expect(client.handleRedirectCallback(`https://app/cb?${answer}&state=${lastAuthorize.searchParams.get('state')}`)).rejects.toMatchObject({ code: 'issuer_mismatch' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.isAuthenticated()).toBe(false);
    lastAuthorize = new URL(await client.buildAuthorizeUrl());
    await client.handleRedirectCallback(`https://app/cb?code=c&state=${lastAuthorize.searchParams.get('state')}&iss=${encodeURIComponent(ISSUER)}`);
    expect(client.getUser()?.sub).toBe('usr_1');
    lastAuthorize = new URL(await client.buildAuthorizeUrl());
    await client.handleRedirectCallback(`https://app/cb?code=c&state=${lastAuthorize.searchParams.get('state')}`);
    expect(client.isAuthenticated()).toBe(true);
  });

  it('keeps the session when a refresh fails offline or on a 5xx, ends it on invalid_grant', async () => {
    const client = new HostedLoginClient({ domain: ISSUER, clientId: 'c1', redirectUri: 'https://app/cb', cacheLocation: 'localstorage' });
    lastAuthorize = new URL(await client.buildAuthorizeUrl());
    globalThis.fetch = mockFetch(() => lastAuthorize.searchParams.get('nonce') as string) as unknown as typeof fetch;
    await client.handleRedirectCallback(`https://app/cb?code=c&state=${lastAuthorize.searchParams.get('state')}`);

    // expires_in 1: every call below refreshes.
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(TypeError);
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'http_503' });
    expect(client.isAuthenticated()).toBe(true);
    expect(localStorage.getItem('tq.login.session')).not.toBeNull();

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch;
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(client.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('tq.login.session')).toBeNull();
  });

  it('refuses a plaintext http:// domain except on this machine', () => {
    expect(() => new HostedLoginClient({ domain: 'http://acme.login.touchque.com', clientId: 'c1', redirectUri: 'https://app/cb' }))
      .toThrow(expect.objectContaining({ code: 'config' }));
    for (const domain of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000', 'http://acme.localhost']) {
      expect(new HostedLoginClient({ domain, clientId: 'c1', redirectUri: 'http://localhost/cb' }).issuer).toBe(domain);
    }
    expect(new HostedLoginClient({ domain: 'acme.login.touchque.com/', clientId: 'c1', redirectUri: 'https://app/cb' }).issuer).toBe(ISSUER);
  });
});
