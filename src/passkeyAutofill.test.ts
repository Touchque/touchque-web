import { describe, test, expect, vi, beforeEach } from 'vitest';

const sw = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
  browserSupportsWebAuthnAutofill: vi.fn(async () => true),
  platformAuthenticatorIsAvailable: vi.fn(async () => true),
  WebAuthnAbortService: { cancelCeremony: vi.fn(), createNewAbortSignal: vi.fn() },
}));
vi.mock('@simplewebauthn/browser', () => sw);

import { createTouchQueWeb, shouldOfferPasskey, dismissPasskeyOffer, rememberPasskey, forgetPasskeyOffer } from './index';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function relay(responses: Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: init.body ? JSON.parse(String(init.body)) : {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

// Node's own (file-less) localStorage hides jsdom's: use a plain in-memory one.
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => memory.clear(),
});

beforeEach(() => {
  vi.clearAllMocks();
  memory.clear();
  sw.browserSupportsWebAuthnAutofill.mockResolvedValue(true);
  sw.platformAuthenticatorIsAvailable.mockResolvedValue(true);
  sw.browserSupportsWebAuthn.mockReturnValue(true);
});

describe('passkeys.autofill()', () => {
  test('asks for options without an email, runs the conditional ceremony and verifies the pick', async () => {
    document.body.innerHTML = '<input id="email" autocomplete="username">';
    const r = relay([json({ attemptId: 'a1', options: { challenge: 'c', rpId: 'example.com' } }), json({ status: 'success', redirect_url: '/home' })]);
    sw.startAuthentication.mockResolvedValue({ id: 'cred-1' });
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });

    const result = await tq.passkeys.autofill({ input: '#email', context: { client_id: 'app' } });

    expect(result).toMatchObject({ ok: true, raw: { redirect_url: '/home' } });
    expect(document.getElementById('email')!.getAttribute('autocomplete')).toBe('username webauthn');
    expect(r.calls[0]).toEqual({ url: '/tq/passkey/authenticate/options', body: { client_id: 'app' } });
    expect(r.calls[1].body).toEqual({ attemptId: 'a1', response: { id: 'cred-1' }, client_id: 'app' });
    expect(sw.startAuthentication).toHaveBeenCalledWith(expect.objectContaining({ useBrowserAutofill: true }));
  });

  test('without autofill support it resolves null and never prompts', async () => {
    sw.browserSupportsWebAuthnAutofill.mockResolvedValue(false);
    const r = relay([]);
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    expect(await tq.passkeys.autofill()).toBeNull();
    expect(r.calls).toHaveLength(0);
    expect(sw.startAuthentication).not.toHaveBeenCalled();
  });

  test('another ceremony taking over (an abort) resolves null', async () => {
    const r = relay([json({ attemptId: 'a1', options: { challenge: 'c' } })]);
    sw.startAuthentication.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    expect(await tq.passkeys.autofill()).toBeNull();
  });

  test('fetches fresh options before the challenge runs out', async () => {
    const r = relay([
      json({ attemptId: 'a1', options: { challenge: 'c1' } }),
      json({ attemptId: 'a2', options: { challenge: 'c2' } }),
      json({ status: 'success' }),
    ]);
    let rejectFirst: (e: unknown) => void = () => { };
    sw.WebAuthnAbortService.cancelCeremony.mockImplementation(() => rejectFirst(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    sw.startAuthentication
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ id: 'cred-2' });
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });

    const result = await tq.passkeys.autofill({ refreshMs: 5 });

    expect(result?.ok).toBe(true);
    expect(r.calls[2].body).toMatchObject({ attemptId: 'a2' });
  });

  test('a signal stops it', async () => {
    const r = relay([json({ attemptId: 'a1', options: { challenge: 'c' } })]);
    const ac = new AbortController();
    sw.WebAuthnAbortService.cancelCeremony.mockImplementation(() => { throw new Error('must not cancel'); });
    sw.startAuthentication.mockImplementation(() => new Promise((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    sw.WebAuthnAbortService.cancelCeremony.mockImplementation(() => { /* the mock ceremony listens to the signal itself */ });
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    const pending = tq.passkeys.autofill({ signal: ac.signal });
    await vi.waitFor(() => expect(sw.startAuthentication).toHaveBeenCalled());
    ac.abort();
    expect(await pending).toBeNull();
    expect(sw.WebAuthnAbortService.cancelCeremony).toHaveBeenCalledTimes(1);
  });
});

describe('passkeys.autofill() when things fail (never a request loop)', () => {
  const opts = () => json({ attemptId: 'a', options: { challenge: 'c' } });

  test('a refused options call (400, a firewall 403, 429) throws at once after one request', async () => {
    for (const res of [json({ error: 'Missing required parameters' }, 400), json({ error: 'ACCESS_DENIED' }, 403), json({ error: 'rate_limited' }, 429)]) {
      const r = relay([res]);
      const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
      await expect(tq.passkeys.autofill()).rejects.toMatchObject({ name: 'TouchQueWebAPIError', status: res.status });
      expect(r.calls).toHaveLength(1);
    }
    expect(sw.startAuthentication).not.toHaveBeenCalled();
  });

  test('passwordless sign-in turned off resolves null without retrying', async () => {
    const r = relay([json({ error: 'passwordless_login_disabled' }, 403)]);
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    expect(await tq.passkeys.autofill()).toBeNull();
    expect(r.calls).toHaveLength(1);
  });

  test('a server error is retried after 1, 2, 4 s, then given up', async () => {
    vi.useFakeTimers();
    try {
      const r = relay([json({}, 503), json({}, 502), json({}, 500), json({}, 504)]);
      const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
      const done = tq.passkeys.autofill().catch((e) => e);
      await vi.advanceTimersByTimeAsync(999);
      expect(r.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(r.calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(4000);
      expect(r.calls).toHaveLength(4);
      expect(await done).toMatchObject({ status: 504 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a network error that clears up goes on to the pick', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const responses = [opts(), json({ status: 'success' })];
      const fetch = vi.fn(async () => { n += 1; if (n === 1) throw new TypeError('Failed to fetch'); return responses.shift()!; });
      sw.startAuthentication.mockResolvedValue({ id: 'c' });
      const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: fetch as unknown as typeof globalThis.fetch });
      const done = tq.passkeys.autofill();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await done)?.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('after 5 failures the client stops asking for the rest of the page view', async () => {
    const r = relay(Array.from({ length: 5 }, () => json({ error: 'nope' }, 400)));
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    for (let i = 0; i < 5; i++) await expect(tq.passkeys.autofill()).rejects.toBeTruthy();
    expect(await tq.passkeys.autofill()).toBeNull();
    expect(r.calls).toHaveLength(5);
  });

  test('a hidden tab waits until it is shown; hiding it closes the open request', async () => {
    let state: 'hidden' | 'visible' = 'hidden';
    const prop = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    try {
      const r = relay([opts(), opts(), json({ status: 'success' })]);
      let rejectOpen: (e: unknown) => void = () => { };
      sw.WebAuthnAbortService.cancelCeremony.mockImplementation(() => rejectOpen(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      sw.startAuthentication
        .mockImplementationOnce(() => new Promise((_, reject) => { rejectOpen = reject; }))
        .mockResolvedValueOnce({ id: 'c' });
      const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
      const done = tq.passkeys.autofill();
      await new Promise((res) => setTimeout(res, 10));
      expect(r.calls).toHaveLength(0); // nothing while hidden

      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => expect(sw.startAuthentication).toHaveBeenCalledTimes(1));

      state = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 10));
      expect(r.calls).toHaveLength(1); // closed, not reopened while hidden

      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect((await done)?.ok).toBe(true);
      expect(r.calls).toHaveLength(3);
    } finally {
      if (prop) Object.defineProperty(document, 'visibilityState', prop);
      else delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });

  test('a refused pick goes to onError and autofill opens again, at most maxRetries times', async () => {
    vi.useFakeTimers();
    try {
      const r = relay([opts(), json({ error: 'unknown' }, 404), opts(), json({ error: 'unknown' }, 404)]);
      sw.startAuthentication.mockResolvedValue({ id: 'gone' });
      const errors: Error[] = [];
      const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
      const done = tq.passkeys.autofill({ onError: (e) => errors.push(e), maxRetries: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await done).toBeNull();
      expect(errors).toHaveLength(2);
      expect(r.calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('password → passkey upgrade', () => {
  test('offers once per browser and user until dismissed or a passkey is here', async () => {
    expect(await shouldOfferPasskey({ user: 'Ada@Example.com' })).toBe(true);
    dismissPasskeyOffer('ada@example.com');
    expect(await shouldOfferPasskey({ user: 'Ada@Example.com' })).toBe(false);
    expect(await shouldOfferPasskey({ user: 'Ada@Example.com', remindAfterDays: 0 })).toBe(true);
    expect(await shouldOfferPasskey({ user: 'bob@example.com' })).toBe(true);
    rememberPasskey('bob@example.com');
    expect(await shouldOfferPasskey({ user: 'bob@example.com' })).toBe(false);
    forgetPasskeyOffer('bob@example.com');
    expect(await shouldOfferPasskey({ user: 'bob@example.com' })).toBe(true);
    // The address itself is not stored.
    expect([...memory.keys()].join(' ')).not.toMatch(/example/);
  });

  test('no offer without a built-in authenticator (unless asked) or without WebAuthn', async () => {
    sw.platformAuthenticatorIsAvailable.mockResolvedValue(false);
    expect(await shouldOfferPasskey({ user: 'a@b.c' })).toBe(false);
    expect(await shouldOfferPasskey({ user: 'a@b.c', requirePlatformAuthenticator: false })).toBe(true);
    sw.browserSupportsWebAuthn.mockReturnValue(false);
    expect(await shouldOfferPasskey({ user: 'a@b.c', requirePlatformAuthenticator: false })).toBe(false);
  });

  test('upgrade() registers through the relay and marks this browser', async () => {
    const r = relay([json({ challenge: 'c', rp: { id: 'example.com' } }), json({ verified: true, credentialId: 'x' })]);
    sw.startRegistration.mockResolvedValue({ id: 'new' });
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    const result = await tq.passkeys.upgrade({ user: 'ada@example.com', label: 'MacBook' });
    expect(result.verified).toBe(true);
    expect(r.calls[1].body).toEqual({ response: { id: 'new' }, label: 'MacBook' });
    expect(await shouldOfferPasskey({ user: 'ada@example.com' })).toBe(false);
  });

  test('a device that already holds a passkey is remembered and reported', async () => {
    const r = relay([json({ challenge: 'c' })]);
    sw.startRegistration.mockRejectedValue(Object.assign(new Error('previously registered'), { name: 'InvalidStateError' }));
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    await expect(tq.passkeys.upgrade({ user: 'kim@example.com' })).rejects.toMatchObject({ name: 'PasskeyAlreadyRegisteredError' });
    expect(await shouldOfferPasskey({ user: 'kim@example.com' })).toBe(false);
  });

  test('a passkey sign-in in this browser also marks it', async () => {
    const r = relay([json({ attemptId: 'a', options: { challenge: 'c' } }), json({ status: 'success' })]);
    sw.startAuthentication.mockResolvedValue({ id: 'c' });
    const tq = createTouchQueWeb({ baseUrl: '/tq', fetch: r.fetch });
    await tq.passkeys.authenticate({ email: 'eve@example.com' });
    expect(await shouldOfferPasskey({ user: 'eve@example.com' })).toBe(false);
  });
});
