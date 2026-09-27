import { describe, test, expect, beforeEach, vi } from 'vitest';
import { collectDeviceSignals } from './fingerprint';

// jsdom has no canvas / WebGL / AudioContext: every optional signal must fail
// soft to null, never throw, and the fingerprint must still be produced.
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => { data.delete(k); },
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
  } as Storage;
}

describe('collectDeviceSignals', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Newer Node ships a global localStorage that shadows jsdom's and is
    // unusable without --localstorage-file; give the tests a real one.
    vi.stubGlobal('localStorage', memoryStorage());
    Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never);
  });

  test('returns a stable per-browser id that persists across calls', async () => {
    const a = await collectDeviceSignals();
    const b = await collectDeviceSignals();
    expect(a.deviceId).toMatch(/^tq2_[0-9a-f]{32}$/);
    expect(b.deviceId).toBe(a.deviceId);
    expect(window.localStorage.getItem('tq_device_id')).toBe(a.deviceId);
  });

  test('fingerprint is deterministic for the same traits and independent of the stored id', async () => {
    const a = await collectDeviceSignals();
    window.localStorage.clear(); // "cleared site data": new id, same hardware traits
    const b = await collectDeviceSignals();
    expect(b.deviceId).not.toBe(a.deviceId);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^tq2_fp_[0-9a-f]{32}$/);
  });

  test('fails soft when optional APIs are unavailable', async () => {
    const s = await collectDeviceSignals();
    expect(s.traits.webglRenderer).toBeNull();
    expect(s.traits.canvas).toBeNull();
    expect(s.traits.audio).toBeNull();
    expect(s.traits.cores).toBeGreaterThan(0);
    expect(s.version).toBe('tq2');
  });

  test('a different screen changes the fingerprint (traits actually feed it)', async () => {
    const before = await collectDeviceSignals();
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(9999);
    const after = await collectDeviceSignals();
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('does not put the user-agent in the fingerprint (a browser update is not a new device)', async () => {
    const before = await collectDeviceSignals();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11) Chrome/999');
    const after = await collectDeviceSignals();
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  test('works without localStorage (private mode)', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const s = await collectDeviceSignals();
    expect(s.deviceId).toBeNull();
    expect(s.fingerprint).toMatch(/^tq2_fp_/);
  });
});
