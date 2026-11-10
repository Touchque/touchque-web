import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, verify, webcrypto } from 'node:crypto';
import { createBrowserKey, deviceSealMessage, type BrowserKeyStore } from './browserKey';
import {
  buildDeviceRiskReport, createDeviceRisk, osFamily, browserFamily, tamperFindings, vmFindings,
  type DeviceRiskBody, type DeviceRiskReport,
} from './deviceRisk';

const ORIGIN = 'https://app.example.com';

function memoryStore(): BrowserKeyStore {
  let pair: CryptoKeyPair | undefined;
  return {
    async load() { return pair; },
    async save(p) { if (!pair) pair = p; return pair; },
    async remove() { pair = undefined; },
  };
}

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

const nodeKey = () => createBrowserKey({ store: memoryStore(), crypto: webcrypto as unknown as Crypto, origin: ORIGIN });
const bodyOf = (r: DeviceRiskReport) => JSON.parse(r.body) as DeviceRiskBody;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
  Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deviceRisk report', () => {
  test('carries the purpose, origin, a fresh nonce, the stored id and coarse traits', async () => {
    const a = bodyOf(await buildDeviceRiskReport({ purpose: 'sign_up', browserKey: null }));
    const b = bodyOf(await buildDeviceRiskReport({ purpose: 'sign_up', browserKey: null }));
    expect(a.v).toBe(1);
    expect(a.p).toBe('sign_up');
    expect(a.aud).toBe(window.location.origin);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.nonce).not.toBe(a.nonce);
    expect(a.sid).toMatch(/^tq2_[0-9a-f]{32}$/);
    expect(b.sid).toBe(a.sid);
    expect(a.t.scr).toMatch(/^\d+x\d+$/);
    expect(typeof a.t.tz).toBe('string');
    expect(a.t.lang.length).toBeLessThanOrEqual(3);
    expect(a.t.mt).toMatch(/^[0-9a-f]{16}$/);
    // jsdom draws nothing: those parts are null, never an error.
    expect(a.t.cv).toBeNull();
    expect(a.t.gpu).toBeNull();
  });

  test('an unknown purpose is sent as sign_in', async () => {
    const r = await buildDeviceRiskReport({ purpose: 'tracking' as never, browserKey: null });
    expect(bodyOf(r).p).toBe('sign_in');
  });

  test('sealed with the browser key over the exact body text, verifiable with Node crypto', async () => {
    const r = await buildDeviceRiskReport({ purpose: 'sign_in', browserKey: nodeKey() });
    expect(r.seal).toBeDefined();
    const digest = createHash('sha256').update(r.body, 'utf8').digest('base64url');
    const s = r.seal!;
    expect(s.aud).toBe(ORIGIN);
    const ok = verify('sha256', Buffer.from(deviceSealMessage(s.aud, s.iat, s.nonce, digest), 'utf8'),
      { key: s.jwk as unknown as webcrypto.JsonWebKey, format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(s.sig, 'base64url'));
    expect(ok).toBe(true);
    // The seal message is not a browser proof's message.
    expect(deviceSealMessage('a', 1, 'n', 'd').startsWith('touchque-device:v1\n')).toBe(true);
  });

  test('unsealed without a key, and with a custom key that cannot seal', async () => {
    expect((await buildDeviceRiskReport({ purpose: 'sign_in', browserKey: null })).seal).toBeUndefined();
    const custom = { proof: async () => null, thumbprint: async () => null, forget: async () => { } };
    expect((await buildDeviceRiskReport({ purpose: 'sign_in', browserKey: custom })).seal).toBeUndefined();
  });

  test('collect encodes base64url JSON under the size limit and never throws', async () => {
    const encoded = await createDeviceRisk().collect({ purpose: 'password_reset', browserKey: null });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(6144);
    const report = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as DeviceRiskReport;
    expect(bodyOf(report).p).toBe('password_reset');
  });
});

/** jsdom's own functions are JavaScript: the ones there before a test patched anything stand in for native code. */
function jsdomNatives(): (fn: unknown) => boolean {
  const own = new Set<unknown>([Function.prototype.toString]);
  for (const proto of [Navigator.prototype, Screen.prototype, HTMLCanvasElement.prototype, Intl.DateTimeFormat.prototype, Date.prototype]) {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(proto))) { own.add(d.get); own.add(d.value); }
  }
  return (fn) => typeof fn !== 'function' || own.has(fn);
}

describe('findings', () => {
  test('a clean page has no tampering', () => {
    expect(tamperFindings(window, jsdomNatives())).toEqual([]);
  });

  test('with the real native check, jsdom (JavaScript, not a browser) looks patched', () => {
    expect(tamperFindings(window)).toContain('nav_user_agent');
  });

  test('a getter replaced on the prototype and a property defined on the instance', () => {
    const natives = jsdomNatives();
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')!;
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: function userAgent() { return 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0'; }, configurable: true });
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    try {
      const found = tamperFindings(window, natives);
      expect(found).toContain('nav_user_agent');
      expect(found).toContain('nav_own_property');
    } finally {
      Object.defineProperty(Navigator.prototype, 'userAgent', d);
      delete (navigator as unknown as Record<string, unknown>).platform;
    }
  });

  test('a User-Agent that names another OS than the platform', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131.0');
    expect(tamperFindings(window, () => true)).toContain('ua_platform_mismatch');
  });

  test('software and virtual graphics, webdriver', () => {
    expect(vmFindings(window, 'Google Inc. (Google)|ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toContain('soft_gpu');
    expect(vmFindings(window, 'VMware, Inc.|SVGA3D; build: RELEASE; LLVM;')).toContain('vm_gpu');
    expect(vmFindings(window, 'Apple|Apple M2')).not.toContain('vm_gpu');
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
    try {
      expect(vmFindings(window, null)).toContain('webdriver');
    } finally {
      delete (navigator as unknown as Record<string, unknown>).webdriver;
    }
  });
});

describe('coarse labels', () => {
  test('OS and browser families with the major version', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
    expect(osFamily(mac, 'MacIntel')).toBe('macOS');
    expect(browserFamily(mac)).toEqual({ br: 'Safari', bv: 18 });
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
    expect(osFamily(edge, 'Win32')).toBe('Windows');
    expect(browserFamily(edge)).toEqual({ br: 'Edge', bv: 130 });
    expect(osFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone')).toBe('iOS');
    expect(osFamily('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Linux armv8l')).toBe('Android');
  });
});

describe('deviceRisk.identify', () => {
  const SITE_KEY = `tqpk_${'a'.repeat(32)}`;

  test('posts the report with the site key as text/plain and returns the identification', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ visitorId: 'tqv_x', requestId: 'dre_y', confidence: 0.99 }) }) as never);
    const out = await createDeviceRisk().identify({ siteKey: SITE_KEY, purpose: 'sign_up', browserKey: null, apiBaseUrl: 'https://api.example.com/', fetch: fetchMock as unknown as typeof fetch });
    expect(out).toEqual({ visitorId: 'tqv_x', requestId: 'dre_y', confidence: 0.99 });
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://api.example.com/device-risk/identify');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
    const sent = JSON.parse(init.body as string);
    expect(sent.siteKey).toBe(SITE_KEY);
    const report = JSON.parse(Buffer.from(sent.report, 'base64url').toString('utf8')) as DeviceRiskReport;
    expect(bodyOf(report).p).toBe('sign_up');
  });

  test('a refusal or a network error resolves null; a bad site key throws at once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    const refused = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ code: 'origin_not_allowed' }) }) as never);
    expect(await createDeviceRisk().identify({ siteKey: SITE_KEY, purpose: 'sign_in', browserKey: null, fetch: refused as unknown as typeof fetch })).toBeNull();
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await createDeviceRisk().identify({ siteKey: SITE_KEY, purpose: 'sign_in', browserKey: null, fetch: down as unknown as typeof fetch })).toBeNull();
    await expect(createDeviceRisk().identify({ siteKey: 'pk_live', purpose: 'sign_in' })).rejects.toThrow(/siteKey/);
  });
});
