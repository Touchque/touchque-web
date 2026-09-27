import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the WebAuthn ceremony library — jsdom has no real authenticator.
// `vi.hoisted` lets the mock fns exist before the hoisted `vi.mock` factory runs.
const { startRegistration, startAuthentication, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } =
  vi.hoisted(() => ({
    startRegistration: vi.fn(),
    startAuthentication: vi.fn(),
    browserSupportsWebAuthn: vi.fn(() => true),
    platformAuthenticatorIsAvailable: vi.fn(async () => true),
  }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
}));

import { createTouchQueWeb } from './index';
import {
  PasskeyDismissedError,
  PasskeyNotRegisteredError,
  PasskeyDisabledError,
  TouchQueWebAPIError,
} from './errors';

/** Build a fetch stub that returns queued responses in order. */
function fetchStub(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: {} };
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function bodyOf(call: { init: RequestInit }): any {
  return JSON.parse(call.init.body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  browserSupportsWebAuthn.mockReturnValue(true);
});

describe('createTouchQueWeb', () => {
  test('throws when baseUrl is missing', () => {
    expect(() => createTouchQueWeb({ baseUrl: '' })).toThrow(/baseUrl/);
  });

  test('trims a trailing slash from baseUrl', async () => {
    const { fn, calls } = fetchStub([{ body: {} }, { body: {} }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://api.example.com/', fetch: fn });
    startRegistration.mockResolvedValue({ id: 'r' });
    await tq.passkeys.register();
    expect(calls[0].url).toBe('https://api.example.com/passkey/register/options');
  });

  test('exposes support helpers', () => {
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: vi.fn() as any });
    expect(tq.isPasskeySupported()).toBe(true);
  });
});

describe('passkeys.register', () => {
  test('gets options, runs startRegistration, posts the response + extra to verify', async () => {
    const { fn, calls } = fetchStub([
      { body: { challenge: 'c', rp: {} } }, // registerOptions (top-level options)
      { body: { verified: true, credentialId: 'cred_1' } }, // registerVerify
    ]);
    const tq = createTouchQueWeb({ baseUrl: 'https://api.example.com', fetch: fn });
    startRegistration.mockResolvedValue({ id: 'attResp' });

    const result = await tq.passkeys.register({ label: 'MacBook' });

    expect(calls[0].url).toBe('https://api.example.com/passkey/register/options');
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c', rp: {} } });
    expect(calls[1].url).toBe('https://api.example.com/passkey/register/verify');
    expect(bodyOf(calls[1])).toEqual({ response: { id: 'attResp' }, label: 'MacBook' });
    expect(result.credentialId).toBe('cred_1');
  });

  test('maps a dismissed prompt to PasskeyDismissedError', async () => {
    const { fn } = fetchStub([{ body: { challenge: 'c' } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://api.example.com', fetch: fn });
    startRegistration.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));

    await expect(tq.passkeys.register()).rejects.toBeInstanceOf(PasskeyDismissedError);
  });
});

describe('passkeys.authenticate', () => {
  test('unwraps { attemptId, options }, threads context into both calls, classifies ok', async () => {
    const { fn, calls } = fetchStub([
      { body: { attemptId: 'att_1', options: { challenge: 'c' } } },
      { body: { status: 'success', redirect_url: 'https://app/cb?code=x' } },
    ]);
    const tq = createTouchQueWeb({ baseUrl: 'https://api.example.com', fetch: fn });
    startAuthentication.mockResolvedValue({ id: 'asrt' });

    const result = await tq.passkeys.authenticate({
      email: 'user@example.com',
      context: { client_id: 'app', redirect_uri: 'https://app/cb' },
    });

    expect(bodyOf(calls[0])).toEqual({
      email: 'user@example.com',
      client_id: 'app',
      redirect_uri: 'https://app/cb',
    });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(bodyOf(calls[1])).toEqual({
      attemptId: 'att_1',
      response: { id: 'asrt' },
      client_id: 'app',
      redirect_uri: 'https://app/cb',
    });
    expect(result).toMatchObject({ ok: true, requiresStepUp: false, pending2fa: false });
    expect(result.raw.redirect_url).toBe('https://app/cb?code=x');
  });

  test('classifies requiresStepUp', async () => {
    const { fn } = fetchStub([
      { body: { attemptId: 'att_1', options: {} } },
      { body: { success: false, requiresStepUp: true, riskScore: 0.95 } },
    ]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });
    startAuthentication.mockResolvedValue({ id: 'a' });

    const result = await tq.passkeys.authenticate({ email: 'u@x.com' });

    expect(result.ok).toBe(false);
    expect(result.requiresStepUp).toBe(true);
  });

  test('classifies pending2fa', async () => {
    const { fn } = fetchStub([
      { body: { attemptId: 'att_1', options: {} } },
      { body: { status: 'pending_2fa', requestId: 'req_1', tempToken: 't' } },
    ]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });
    startAuthentication.mockResolvedValue({ id: 'a' });

    const result = await tq.passkeys.authenticate({ email: 'u@x.com' });

    expect(result.pending2fa).toBe(true);
    expect(result.ok).toBe(false);
  });

  test('404 on options -> PasskeyNotRegisteredError (caller falls back to password)', async () => {
    const { fn } = fetchStub([{ status: 404, body: { error: 'no_passkey_registered' } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });

    await expect(tq.passkeys.authenticate({ email: 'u@x.com' })).rejects.toBeInstanceOf(
      PasskeyNotRegisteredError,
    );
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  test('403 on options -> PasskeyDisabledError', async () => {
    const { fn } = fetchStub([{ status: 403, body: { error: 'passwordless_login_disabled' } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });

    await expect(tq.passkeys.authenticate({ email: 'u@x.com' })).rejects.toBeInstanceOf(
      PasskeyDisabledError,
    );
  });

  test('other non-2xx -> TouchQueWebAPIError carrying status + body', async () => {
    const { fn } = fetchStub([{ status: 500, body: { error: 'boom', message: 'relay down' } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });

    const err = await tq.passkeys.authenticate({ email: 'u@x.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(TouchQueWebAPIError);
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ error: 'boom', message: 'relay down' });
  });

  test('a 403 with an unrelated error code is NOT treated as "passwordless disabled"', async () => {
    const { fn } = fetchStub([{ status: 403, body: { error: 'rate_limited', message: 'slow down' } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });

    const err = await tq.passkeys.authenticate({ email: 'u@x.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(TouchQueWebAPIError);
    expect(err).not.toBeInstanceOf(PasskeyDisabledError);
    expect(err.status).toBe(403);
  });
});

describe('passkeys.approveLogin', () => {
  test('posts requestId to options + verify, runs a ceremony in between', async () => {
    const { fn, calls } = fetchStub([
      { body: { challenge: 'c' } },
      { body: { success: true } },
    ]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });
    startAuthentication.mockResolvedValue({ id: 'a' });

    const result = await tq.passkeys.approveLogin({ requestId: 'req_9' });

    expect(calls[0].url).toBe('https://x/passkey/login/options');
    expect(bodyOf(calls[0])).toEqual({ requestId: 'req_9' });
    expect(bodyOf(calls[1])).toEqual({ requestId: 'req_9', response: { id: 'a' } });
    expect(result.success).toBe(true);
  });
});

describe('passkeys.list / remove', () => {
  test('list() returns the credentials array', async () => {
    const { fn, calls } = fetchStub([{ body: { credentials: [{ id: 'c1' }] } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });

    const list = await tq.passkeys.list();

    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toBe('https://x/passkey/credentials');
    expect(list).toEqual([{ id: 'c1' }]);
  });

  test('list() tolerates a missing credentials field', async () => {
    const { fn } = fetchStub([{ body: {} }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });
    expect(await tq.passkeys.list()).toEqual([]);
  });

  test('remove() DELETEs the id url-encoded', async () => {
    const { fn, calls } = fetchStub([{ body: { deleted: true } }]);
    const tq = createTouchQueWeb({ baseUrl: 'https://x', fetch: fn });

    await tq.passkeys.remove('cred/1 2');

    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe('https://x/passkey/credentials/cred%2F1%202');
  });
});

describe('config.credentials', () => {
  test('defaults to same-origin and can be set to include', async () => {
    const a = fetchStub([{ body: { credentials: [] } }]);
    await createTouchQueWeb({ baseUrl: 'https://x', fetch: a.fn }).passkeys.list();
    expect(a.calls[0].init.credentials).toBe('same-origin');

    const b = fetchStub([{ body: { credentials: [] } }]);
    await createTouchQueWeb({ baseUrl: 'https://x', fetch: b.fn, credentials: 'include' }).passkeys.list();
    expect(b.calls[0].init.credentials).toBe('include');
  });
});
