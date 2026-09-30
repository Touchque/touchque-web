import { describe, test, expect, vi } from 'vitest';
import { touchqueFetch, Step } from './action';
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
