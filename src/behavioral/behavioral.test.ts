import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBehavioralTracker } from './tracker';
import { attachBehavioral } from './index';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

function move(el: Element, x: number, y: number) {
  el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
}

describe('createBehavioralTracker', () => {
  test('getMetrics returns the fixed metric shape with numeric values', () => {
    const t = createBehavioralTracker(container);
    const m = t.getMetrics();
    expect(Object.keys(m).sort()).toEqual(
      ['clicks', 'keystrokeSpeedAvg', 'keystrokes', 'mouseDistance', 'mouseJitter'].sort(),
    );
    for (const v of Object.values(m)) expect(typeof v).toBe('number');
  });

  test('accumulates mouse distance and click count from container events', () => {
    const t = createBehavioralTracker(container);
    t.start();
    // The tracker skips the first move (no baseline yet); accumulation
    // starts once a non-(0,0) previous position is established.
    move(container, 1, 1);
    move(container, 4, 5); // dx=3, dy=4 -> distance += 5
    move(container, 4, 5); // no movement -> +0
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const m = t.getMetrics();
    expect(m.mouseDistance).toBe(5);
    expect(m.clicks).toBe(1);
    t.stop();
  });

  // mouseJitter = a genuine reversal in movement direction between
  // consecutive steps, not a single step's own dx/dy ratio — see
  // 2026-09-16 SDK fix plan for why the old per-step-ratio formula was
  // wrong (it flagged a smooth diagonal drag as "jitter" and missed real
  // micro wobble).
  test('a steady, unwavering diagonal drag reads as zero jitter', () => {
    const t = createBehavioralTracker(container);
    t.start();
    move(container, 1, 1);
    move(container, 11, 11); // dx=10, dy=10
    move(container, 21, 21); // dx=10, dy=10 — same direction
    move(container, 31, 31); // dx=10, dy=10 — same direction
    move(container, 41, 41); // dx=10, dy=10 — same direction
    expect(t.getMetrics().mouseJitter).toBe(0);
    t.stop();
  });

  test('a zigzagging drag (direction reversals) counts one jitter per reversal', () => {
    const t = createBehavioralTracker(container);
    t.start();
    move(container, 1, 1);
    move(container, 11, 11); // dx=+10, dy=10 — establishes the first vector, no reversal yet
    move(container, 1, 21); //  dx=-10, dy=10 — dx flips -> reversal 1
    move(container, 11, 31); // dx=+10, dy=10 — dx flips back -> reversal 2
    move(container, 1, 41); //  dx=-10, dy=10 — reversal 3
    move(container, 11, 51); // dx=+10, dy=10 — reversal 4
    expect(t.getMetrics().mouseJitter).toBe(4);
    t.stop();
  });

  test('a pure vertical drag (no horizontal component) reads as zero jitter', () => {
    const t = createBehavioralTracker(container);
    t.start();
    move(container, 1, 1);
    move(container, 1, 11); // dx=0, dy=10
    move(container, 1, 21); // dx=0, dy=10 — same direction
    move(container, 1, 31); // dx=0, dy=10 — same direction
    expect(t.getMetrics().mouseJitter).toBe(0);
    t.stop();
  });

  test('records inter-keystroke timing gaps but never keys/characters', () => {
    vi.useFakeTimers();
    const t = createBehavioralTracker(container);
    t.start();
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    vi.advanceTimersByTime(120);
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    const m = t.getMetrics();
    expect(m.keystrokes).toBe(1);
    expect(m.keystrokeSpeedAvg).toBeGreaterThanOrEqual(0);
    t.stop();
    vi.useRealTimers();
  });

  test('stop() removes the container listeners — no accumulation after stop', () => {
    const t = createBehavioralTracker(container);
    t.start();
    move(container, 1, 1);
    move(container, 11, 1); // dx=10, dy=0 -> distance += 10
    t.stop();
    move(container, 100, 1);
    move(container, 200, 1);
    expect(t.getMetrics().mouseDistance).toBe(10);
  });

  test('reset() zeroes the accumulated metrics', () => {
    const t = createBehavioralTracker(container);
    t.start();
    move(container, 1, 1);
    move(container, 31, 41); // dx=30, dy=40 -> distance += 50
    expect(t.getMetrics().mouseDistance).toBe(50);
    t.reset();
    expect(t.getMetrics().mouseDistance).toBe(0);
    t.stop();
  });

  test('never attaches window/document listeners', () => {
    const winAdd = vi.spyOn(window, 'addEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const t = createBehavioralTracker(container, { sampleIntervalMs: 5000 });
    t.start();
    expect(winAdd).not.toHaveBeenCalled();
    expect(docAdd).not.toHaveBeenCalled();
    t.stop();
  });
});

describe('attachBehavioral', () => {
  test('throws without a container', () => {
    expect(() =>
      attachBehavioral('#nope', { telemetryToken: 't', requestId: 'r', apiBaseUrl: 'https://x' }),
    ).toThrow(/container not found/);
  });

  test('throws without telemetryToken / requestId', () => {
    expect(() =>
      attachBehavioral(container, { telemetryToken: '', requestId: 'r', apiBaseUrl: 'https://x' }),
    ).toThrow(/telemetryToken and requestId/);
  });

  test('submit() POSTs metrics to /login/:id/telemetry with a Bearer token', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as any);
    const h = attachBehavioral(container, {
      telemetryToken: 'tok_abc',
      requestId: 'req 1',
      apiBaseUrl: 'https://api.touchque.io/',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await h.submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.touchque.io/login/req%201/telemetry');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(
      ['clicks', 'keystrokeSpeedAvg', 'keystrokes', 'mouseDistance', 'mouseJitter'].sort(),
    );
    h.stop();
  });

  test('submit() swallows a failed telemetry POST (never throws)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const h = attachBehavioral(container, {
      telemetryToken: 't',
      requestId: 'r',
      apiBaseUrl: 'https://x',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(h.submit()).resolves.toBeUndefined();
    h.stop();
  });

  test('includes deviceFingerprint only when collectDeviceFingerprint is true', async () => {
    // jsdom has no canvas; make getContext return null so generateDeviceFingerprint
    // takes its deterministic "no-canvas" branch instead of throwing.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never);
    // Newer Node's global localStorage shadows jsdom's and is unusable here.
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
      },
    });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as any);
    const withFp = attachBehavioral(container, {
      telemetryToken: 't',
      requestId: 'r',
      apiBaseUrl: 'https://x',
      collectDeviceFingerprint: true,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await withFp.submit();
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent).toHaveProperty('deviceFingerprint', 'no-canvas');
    // v2 signals ride along: a stable id, a fingerprint and the coarse traits
    expect(sent.deviceSignals.deviceId).toMatch(/^tq2_[0-9a-f]{32}$/);
    expect(sent.deviceSignals.fingerprint).toMatch(/^tq2_fp_/);
    expect(sent.deviceSignals.traits).toHaveProperty('timezone');
    withFp.stop();

    const fetchMock2 = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as any);
    const noFp = attachBehavioral(container, {
      telemetryToken: 't',
      requestId: 'r',
      apiBaseUrl: 'https://x',
      fetch: fetchMock2 as unknown as typeof fetch,
    });
    await noFp.submit();
    const sentWithout = JSON.parse((fetchMock2.mock.calls[0] as any)[1].body);
    expect(sentWithout).not.toHaveProperty('deviceFingerprint');
    expect(sentWithout).not.toHaveProperty('deviceSignals');
    noFp.stop();
  });
});
