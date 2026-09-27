import { describe, test, expect, vi, afterEach } from 'vitest';
import { RelayHttp } from './http';
import { ClassicTwoFactor } from './classic2fa';
import { EnrollmentTimeoutError, EnrollmentCancelledError } from './errors';

const PATHS = { enrollStart: '/enroll/start', enrollStatus: '/enroll/status', login: '/login' };

function fetchJson(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function client(fetchImpl: typeof fetch) {
  const http = new RelayHttp({ baseUrl: 'https://api.example.com', fetch: fetchImpl });
  return new ClassicTwoFactor(http, PATHS as any);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ClassicTwoFactor', () => {
  test('enroll() POSTs to enrollStart and returns the secret + QR', async () => {
    const fetchImpl = fetchJson({ secret: 'S1', qrCodeDataUrl: 'data:image/png;base64,x' });
    const c = client(fetchImpl);
    const result = await c.enroll();
    expect(result).toEqual({ secret: 'S1', qrCodeDataUrl: 'data:image/png;base64,x' });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/enroll/start');
    expect(init.method).toBe('POST');
  });

  test('status() GETs enrollStatus', async () => {
    const fetchImpl = fetchJson({ linked: true, used: true, deviceId: 'dev_1' });
    const c = client(fetchImpl);
    const result = await c.status();
    expect(result).toEqual({ linked: true, used: true, deviceId: 'dev_1' });
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/enroll/status');
    expect(init.method).toBe('GET');
  });

  test('waitForLink() polls until linked', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const linked = call >= 3;
      return new Response(JSON.stringify({ linked, used: linked, deviceId: linked ? 'dev_1' : null }), { status: 200 });
    });
    const c = client(fetchImpl);
    const result = await c.waitForLink({ pollIntervalMs: 1 });
    expect(result.linked).toBe(true);
    expect(call).toBe(3);
  });

  test('waitForLink() throws EnrollmentTimeoutError once the deadline passes', async () => {
    const fetchImpl = fetchJson({ linked: false, used: false, deviceId: null });
    const c = client(fetchImpl);
    await expect(c.waitForLink({ timeoutMs: 5, pollIntervalMs: 1 })).rejects.toThrow(EnrollmentTimeoutError);
  });

  test('waitForLink() throws EnrollmentCancelledError when its signal aborts mid-poll', async () => {
    const fetchImpl = fetchJson({ linked: false, used: false, deviceId: null });
    const c = client(fetchImpl);
    const controller = new AbortController();
    const promise = c.waitForLink({ pollIntervalMs: 5, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(EnrollmentCancelledError);
  });

  test('login() POSTs externalUsername to the login path', async () => {
    const fetchImpl = fetchJson({ status: 'success', requestId: 'req_1', challengeCode: '42' });
    const c = client(fetchImpl);
    const result = await c.login({ externalUsername: 'user@example.com' });
    expect(result).toEqual({ status: 'success', requestId: 'req_1', challengeCode: '42' });
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ externalUsername: 'user@example.com' });
  });

  test('login() throws TouchQueWebAPIError on a non-2xx relay response (e.g. rejected)', async () => {
    const fetchImpl = fetchJson({ error: '2FA_REJECTED' }, 403);
    const c = client(fetchImpl);
    await expect(c.login({ externalUsername: 'user@example.com' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('ClassicTwoFactor — phishing-resistant policy', () => {
  test('login() turns a 409 PASSKEY_REQUIRED into PasskeyRequiredError carrying the requestId', async () => {
    const { PasskeyRequiredError } = await import('./errors');
    const tq = client(fetchJson({ error: 'PASSKEY_REQUIRED', requestId: 'req_p' }, 409) as unknown as typeof fetch);
    const err = await tq.login().catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyRequiredError);
    expect(err.requestId).toBe('req_p');
  });

  test('other errors are passed through unchanged', async () => {
    const { TouchQueWebAPIError } = await import('./errors');
    const tq = client(fetchJson({ error: '2FA_REJECTED' }, 403) as unknown as typeof fetch);
    expect(await tq.login().catch((e) => e)).toBeInstanceOf(TouchQueWebAPIError);
  });
});
