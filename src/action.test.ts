import { describe, test, expect, vi } from 'vitest';
import { touchqueFetch, sendCanary, Step } from './action';
import { RelayHttp } from './http';
import { ClassicTwoFactor } from './classic2fa';

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A scripted server: returns the next response and records the headers it received. */
function server(responses: Response[]) {
  const seen: Headers[] = [];
  const f = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    const next = responses.shift();
    if (!next) throw new Error('no more scripted responses');
    return next;
  });
  return { fetch: f as unknown as typeof fetch, seen };
}

describe('touchqueFetch', () => {
  test('shows the number while waiting, re-sends with the token, resolves with the route response', async () => {
    const s = server([
      json({ touchque: { state: 'waiting', requestId: 'r1', number: '47' }, token: 't1' }, 202),
      json({ touchque: { state: 'waiting', requestId: 'r1', number: '47' }, token: 't2' }, 202),
      json({ ok: true }, 200),
    ]);
    const steps: Step[] = [];
    const res = await touchqueFetch('/api/transfer', { method: 'POST', body: '{"amount":5}' }, {
      fetch: s.fetch, pollIntervalMs: 1, onStep: (st) => steps.push(st),
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(steps.map((x) => x.number)).toEqual(['47', '47']);
    expect(s.seen[0].get('x-touchque-token')).toBeNull();
    expect(s.seen[1].get('x-touchque-token')).toBe('t1');
    expect(s.seen[2].get('x-touchque-token')).toBe('t2');
  });

  // R1-04: the token reached no browser before, so the bot signals never ran.
  test('posts behavioural telemetry once when the step carries a token and telemetry is configured', async () => {
    const urls: string[] = [];
    const responses = [
      json({ touchque: { state: 'waiting', requestId: 'r1', telemetryToken: 'tt' }, token: 't1' }, 202),
      json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't2' }, 202),
      json({ ok: true }, 200),
    ];
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init?.method || 'GET'} ${String(input)} ${new Headers(init?.headers).get('authorization') || ''}`.trim());
      if (String(input).includes('/telemetry')) return json({ ok: true }, 200);
      return responses.shift()!;
    });
    await touchqueFetch('/api/transfer', { method: 'POST' }, {
      fetch: f as unknown as typeof fetch, pollIntervalMs: 1, telemetry: { apiBaseUrl: 'https://api.touchque.com' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(urls.filter((u) => u.includes('/telemetry'))).toEqual(['POST https://api.touchque.com/login/r1/telemetry Bearer tt']);
  });

  test('without the telemetry option nothing is posted to Touchque', async () => {
    const s = server([
      json({ touchque: { state: 'waiting', requestId: 'r1', telemetryToken: 'tt' }, token: 't1' }, 202),
      json({ ok: true }, 200),
    ]);
    await touchqueFetch('/api/transfer', { method: 'POST' }, { fetch: s.fetch, pollIntervalMs: 1 });
    expect((s.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))).toEqual(['/api/transfer', '/api/transfer']);
  });

  test('offline: keeps checking while the QR is up (without redrawing it), then sends the typed code with the token', async () => {
    const seen: Headers[] = [];
    let polls = 0;
    const f = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push(h);
      if (!h.get('x-touchque-token')) return json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't1' }, 202);
      if (h.get('x-touchque-offline')) return json({ touchque: { state: 'offline', offline: { challengeId: 'c1', qrDataUrl: 'data:x', challengeCode: '47' } }, token: 't2' }, 202);
      if (h.get('x-touchque-code')) return json({ ok: true }, 200);
      polls += 1;
      return json({ touchque: { state: 'offline', offline: { challengeId: 'c1' } }, token: 't2' }, 202);
    });
    const steps: Step[] = [];
    const res = await touchqueFetch('/api/transfer', { method: 'POST' }, {
      fetch: f as unknown as typeof fetch, pollIntervalMs: 1,
      onStep: (st, c) => {
        steps.push(st);
        if (st.state === 'waiting') c.useOffline();
        if (st.state === 'offline') setTimeout(() => c.submitCode('ABCD123'), 25);
      },
    });
    expect(res.status).toBe(200);
    expect(polls).toBeGreaterThan(0); // it kept checking the push while the QR was shown
    // The page hears about the QR exactly once (with the number to print under it), not on every check.
    expect(steps.map((x) => x.state)).toEqual(['waiting', 'offline']);
    expect(steps[1].offline).toMatchObject({ qrDataUrl: 'data:x', challengeCode: '47' });
    const codeCall = seen.find((h) => h.get('x-touchque-code'))!;
    expect(codeCall.get('x-touchque-code')).toBe('ABCD123');
    expect(codeCall.get('x-touchque-offline')).toBeNull();
    expect(codeCall.get('x-touchque-token')).toBe('t2');
  });

  test('a phone-side reject while the QR is up ends the attempt at once', async () => {
    const f = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (!h.get('x-touchque-token')) return json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't1' }, 202);
      if (h.get('x-touchque-offline')) return json({ touchque: { state: 'offline', offline: { challengeId: 'c1', qrDataUrl: 'data:x' } }, token: 't2' }, 202);
      return json({ touchque: { state: 'rejected', requestId: 'r1', reason: 'request_rejected' }, token: 't3' }, 403);
    });
    const steps: Step[] = [];
    const res = await touchqueFetch('/api/transfer', { method: 'POST' }, {
      fetch: f as unknown as typeof fetch, pollIntervalMs: 1,
      onStep: (st, c) => { steps.push(st); if (st.state === 'waiting') c.useOffline(); },
    });
    expect(res.status).toBe(403);
    expect(steps.map((x) => x.state)).toEqual(['waiting', 'offline', 'rejected']);
  });

  test('passkey_required runs the passkey approval once, then continues', async () => {
    const s = server([
      json({ touchque: { state: 'passkey_required', requestId: 'r9' }, token: 't1' }, 202),
      json({ ok: true }, 200),
    ]);
    const approve = vi.fn(async () => ({ success: true }));
    const res = await touchqueFetch('/x', {}, { fetch: s.fetch, pollIntervalMs: 1, approveWithPasskey: approve });
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith('r9');
  });

  test('a refusal is final: onStep sees it and the response is returned', async () => {
    const s = server([json({ touchque: { state: 'rejected', requestId: 'r1' }, token: 't' }, 403)]);
    const onStep = vi.fn();
    const res = await touchqueFetch('/x', {}, { fetch: s.fetch, onStep });
    expect(res.status).toBe(403);
    expect(onStep.mock.calls[0][0].state).toBe('rejected');
  });

  test('cancel() stops waiting with an AbortError', async () => {
    const s = server([json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't' }, 202)]);
    const p = touchqueFetch('/x', {}, { fetch: s.fetch, pollIntervalMs: 10_000, onStep: (_st, c) => setTimeout(() => c.cancel(), 5) });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a normal (unprotected) response passes straight through', async () => {
    const s = server([json({ hello: 1 }, 200)]);
    const res = await touchqueFetch('/x', {}, { fetch: s.fetch });
    expect(await res.json()).toEqual({ hello: 1 });
  });

  /** Rejects when `p` has not settled within `ms`. */
  const within = <T>(p: Promise<T>, ms = 500) => Promise.race([
    p, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms)),
  ]);

  test('a Request keeps its headers and body on every round', async () => {
    const seen: Array<{ headers: Headers; body: string }> = [];
    const responses = [
      json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't1' }, 202),
      json({ ok: true }, 200),
    ];
    // Like the real fetch: building the request reads the Request's body.
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({ headers: req.headers, body: await req.text() });
      return responses.shift()!;
    });
    const req = new Request('https://app.example.com/api/transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: '{"amount":5}',
    });
    const res = await touchqueFetch(req, {}, { fetch: f as unknown as typeof fetch, pollIntervalMs: 1 });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.headers.get('content-type')).toBe('application/json');
      expect(call.headers.get('authorization')).toBe('Bearer t');
      expect(call.body).toBe('{"amount":5}');
    }
    expect(seen[1].headers.get('x-touchque-token')).toBe('t1');
  });

  test('a stream body is sent again on every round', async () => {
    const bodies: string[] = [];
    const responses = [
      json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't1' }, 202),
      json({ ok: true }, 200),
    ];
    const f = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(await new Response(init?.body).text());
      return responses.shift()!;
    });
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"amount":5}')); c.close(); } });
    const res = await touchqueFetch('/api/transfer', { method: 'POST', body, duplex: 'half' } as RequestInit, {
      fetch: f as unknown as typeof fetch, pollIntervalMs: 1,
    });
    expect(res.status).toBe(200);
    expect(bodies).toEqual(['{"amount":5}', '{"amount":5}']);
  });

  test('init.signal stops the wait', async () => {
    const s = server([json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't' }, 202)]);
    const ac = new AbortController();
    const p = touchqueFetch('/x', { signal: ac.signal }, { fetch: s.fetch, pollIntervalMs: 10_000, onStep: () => setTimeout(() => ac.abort(), 5) });
    await expect(within(p)).rejects.toMatchObject({ name: 'AbortError' });
    expect((s.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  test('init.signal aborts the request in flight, next to options.signal', async () => {
    const page = new AbortController();
    const f = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const p = touchqueFetch('/x', { signal: page.signal }, { fetch: f as unknown as typeof fetch, signal: new AbortController().signal });
    setTimeout(() => page.abort(), 5);
    await expect(within(p)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a finished call leaves no listener on a reused signal', async () => {
    const ac = new AbortController();
    const added = vi.spyOn(ac.signal, 'addEventListener');
    const removed = vi.spyOn(ac.signal, 'removeEventListener');
    const s = server([json({ a: 1 }, 200), json({ a: 2 }, 200)]);
    await touchqueFetch('/x', {}, { fetch: s.fetch, signal: ac.signal });
    await touchqueFetch('/x', {}, { fetch: s.fetch, signal: ac.signal });
    const listeners = (spy: typeof added) => spy.mock.calls.filter((c) => c[0] === 'abort').map((c) => c[1]);
    expect(listeners(added)).toHaveLength(2);
    expect(listeners(removed)).toEqual(listeners(added));
  });

  test("the route's own response is returned without reading its body (a stream)", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: 1\n\n')); } }); // never ends
    const s = server([new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })]);
    const res = await within(touchqueFetch('/events', {}, { fetch: s.fetch }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');
    await reader.cancel();
  });
});

describe('classic2fa.login — two-phase', () => {
  test('hands the matching number to onStep BEFORE approval and resolves on success', async () => {
    const s = server([
      json({ touchque: { state: 'waiting', requestId: 'r1', number: '12' }, token: 't1' }, 202),
      json({ status: 'success', requestId: 'r1', assurance: { phishingResistant: false, method: 'push' } }, 200),
    ]);
    const http = new RelayHttp({ baseUrl: 'https://app.example.com/touchque', fetch: s.fetch });
    const c = new ClassicTwoFactor(http, { enrollStart: '/enroll/start', enrollStatus: '/enroll/status', login: '/login' } as any);
    const numbers: string[] = [];
    const result = await c.login({ onStep: (st) => st.number && numbers.push(st.number), pollIntervalMs: 1 });
    expect(numbers).toEqual(['12']);
    expect(result).toMatchObject({ status: 'success', requestId: 'r1' });
  });
});

describe('Mirror Alarm canary', () => {
  test('the first step with a canary loads it as a hidden image and beacons the page origin, once', async () => {
    const beacons: Array<[string, string]> = [];
    const sendBeacon = vi.fn((url: string, data: string) => { beacons.push([url, data]); return true; });
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    const created: HTMLImageElement[] = [];
    const orig = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = orig(tag);
      if (tag === 'img') created.push(el as HTMLImageElement);
      return el;
    }) as typeof document.createElement);
    try {
      const url = 'https://api.touchque.com/c/tok_abcdefghijklmnop.gif';
      const s = server([
        json({ touchque: { state: 'waiting', requestId: 'r1', canary: { url } }, token: 't1' }, 202),
        json({ touchque: { state: 'waiting', requestId: 'r1', canary: { url } }, token: 't2' }, 202),
        json({ ok: true }, 200),
      ]);
      await touchqueFetch('/api/transfer', { method: 'POST' }, { fetch: s.fetch, pollIntervalMs: 1 });
      expect(created).toHaveLength(1);
      expect(created[0].src).toBe(url);
      expect(created[0].referrerPolicy).toBe('origin');
      expect(beacons).toHaveLength(1);
      expect(beacons[0][0]).toBe('https://api.touchque.com/c/tok_abcdefghijklmnop');
      expect(JSON.parse(beacons[0][1])).toEqual({ origin: location.origin, top: true, referrer: '' });
    } finally {
      spy.mockRestore();
      delete (navigator as any).sendBeacon;
    }
  });

  test('sendCanary ignores anything that is not an http(s) URL and never throws', () => {
    expect(() => sendCanary(undefined)).not.toThrow();
    expect(() => sendCanary({ url: 'javascript:alert(1)' })).not.toThrow();
    expect(document.querySelectorAll('img[src^="javascript"]').length).toBe(0);
  });
});
