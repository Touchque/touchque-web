import { describe, it, expect, vi } from 'vitest';
import { MyAccountClient, MyAccountError } from './myAccount';

const ISSUER = 'https://acme.login.touchque.com';

function client(responder: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init });
    return responder(new URL(url), init);
  }) as unknown as typeof fetch;
  return { account: new MyAccountClient({ domain: 'acme.login.touchque.com', getAccessToken: async () => 'tok' }), calls };
}

describe('MyAccountClient', () => {
  it('calls /me/v1 with the bearer token and JSON bodies', async () => {
    const { account, calls } = client((url) => (url.pathname === '/me/v1/sessions/s%201' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ name: 'Zoë' }), { status: 200 })));
    expect(await account.updateProfile({ name: 'Zoë', userMetadata: { theme: 'dark' } })).toEqual({ name: 'Zoë' });
    expect(calls[0].url.toString()).toBe(`${ISSUER}/me/v1/profile`);
    expect(calls[0].init.method).toBe('PATCH');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'Zoë', userMetadata: { theme: 'dark' } });
    expect(await account.endSession('s 1')).toBeUndefined();
    expect(account.accountPageUrl('security')).toBe(`${ISSUER}/account/security`);
  });

  it('turns the RFC 9470 challenge into a step-up error', async () => {
    const { account } = client(() => new Response(JSON.stringify({ error: 'insufficient_user_authentication', error_description: 'A more recent sign-in is required' }), {
      status: 401, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_user_authentication", max_age="600"' },
    }));
    const err = await account.deleteAccount().catch((e) => e);
    expect(err).toBeInstanceOf(MyAccountError);
    expect(err).toMatchObject({ code: 'insufficient_user_authentication', status: 401, stepUp: true, maxAge: 600 });
  });

  it('refuses a plaintext http:// domain except on this machine', () => {
    const getAccessToken = async () => 'tok';
    expect(() => new MyAccountClient({ domain: 'http://acme.login.touchque.com', getAccessToken })).toThrow(MyAccountError);
    expect(new MyAccountClient({ domain: 'http://localhost:4000', getAccessToken }).issuer).toBe('http://localhost:4000');
  });
});
