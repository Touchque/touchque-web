// src/deviceRisk.ts
// Device risk: a visitor ID for the browser on your sign-in, sign-up,
// password-reset or approval page, and does anything about it look wrong?
//
//   import { deviceRisk } from '@touchque/web';
//   const { visitorId, requestId, confidence } = await deviceRisk.identify({ siteKey, purpose: 'sign_up' });
//   hidden.value = requestId;   // your server reads the trusted result by requestId
//
// identify() sends the page's report to TouchQue with your workspace's public
// site key (dashboard → Device risk → Settings) and gets back a visitorId of
// your workspace (another TouchQue customer sees another one for the same
// browser), the requestId of this identification and how sure TouchQue is.
// Never trust them on the page: your server reads the signals and the risk
// engine's verdict by requestId (deviceRisk.getEvent / deviceRisk.check) or
// passes the requestId to login.request and risk.check. Every signal only
// ever asks for more; nothing blocks on its own.
//
// collect() is the relay alternative: the encoded report for your server to
// pass as `deviceRisk` (no call from the page to TouchQue).
//
// What is sent: coarse traits (OS, browser family and major version, time
// zone, languages, screen size, cores, memory, touch points, the graphics
// card's name) and short hashes of how this browser draws text, plays a test
// sound and which of 25 common fonts it has; plus findings (patched browser
// functions, a virtual or software graphics card, a headless browser, a
// private window where the browser lets that be seen). TouchQue keeps none of
// the raw values: it stores keyed hashes (a separate key per workspace, so no
// browser is ever linked across TouchQue customers) and coarse labels, for the
// 30 to 90 days the workspace sets.
//
// Use it only on sign-in, sign-up, password-reset and approval pages, and
// name it in your privacy notice. In the EU, storage and device reading for
// anything beyond the security of a sign-in the user asked for needs consent
// (ePrivacy 5(3)); under KVKK, security is a legitimate interest.
//
// The report is sealed with this browser's device-bound key (the same
// non-extractable key as silent sign-ins) where the browser has one: TouchQue
// sees it came whole from a browser holding that key, from this page's
// origin, once. A seal does not make the traits true: anything on the page
// can lie to its own report, which is why TouchQue checks them against each
// other, against what it sees on the network, and against visitors it knew.

import { audioSignature, canvasSignature, digestHex, installedFonts, readOrCreateDeviceId, webglRenderer } from './behavioral/fingerprint';
import { browserKey as defaultBrowserKey } from './browserKey';
import type { BrowserKey, DeviceSeal } from './browserKey';
import { logWarn, errorText } from './log';

/** The page the report is collected on. Device risk is for these pages only. */
export type DeviceRiskPurpose = 'sign_in' | 'sign_up' | 'password_reset' | 'approval';
export const DEVICE_RISK_PURPOSES: readonly DeviceRiskPurpose[] = ['sign_in', 'sign_up', 'password_reset', 'approval'];

/** The form field (or header) a report travels in from the browser to your server. */
export const DEVICE_RISK_FIELD = 'deviceRisk';
export const DEVICE_RISK_HEADER = 'X-TouchQue-Device';

/** Coarse traits. Raw here, never stored raw: the server keeps keyed hashes and coarse labels. */
export interface DeviceRiskTraits {
  /** OS family: Windows, macOS, Linux, Android, iOS, ChromeOS or Other. */
  os: string;
  /** Browser family: Chrome, Edge, Firefox, Safari, Opera, Samsung or Other. */
  br: string;
  /** Browser major version (0 when unknown). Left out of matching: an update is the same device. */
  bv: number;
  /** navigator.platform, at most 32 characters. */
  pf: string;
  /** IANA time zone, e.g. Europe/Istanbul. */
  tz: string;
  /** Minutes west of UTC now (Date.getTimezoneOffset). */
  tzo: number;
  /** navigator.languages, at most 3, each at most 16 characters. */
  lang: string[];
  /** Screen size as long x short side (rotation does not change it). */
  scr: string;
  cd: number;
  /** devicePixelRatio, 2 decimals. */
  dpr: number;
  /** hardwareConcurrency. */
  hc: number;
  /** deviceMemory (Chromium), else null. */
  dm: number | null;
  /** maxTouchPoints. */
  tp: number;
  /** WebGL unmasked vendor|renderer, at most 128 characters, or null. */
  gpu: string | null;
  /** 16-hex digests (null when not available): canvas text drawing, the audio test, the probe fonts found, Math results, WebGL limits. */
  cv: string | null;
  au: string | null;
  fn: string | null;
  mt: string | null;
  wg: string | null;
}

/** What the page found about itself. Names only: stable codes the server and the dashboard explain. */
export interface DeviceRiskFindings {
  /** Browser functions replaced by script, and traits that contradict each other. */
  tamper: string[];
  /** A virtual machine, software graphics, a headless or automated browser. */
  vm: string[];
  /** How a private window showed itself (chromium_quota, firefox_no_sw, safari_opfs), or null. */
  priv: string | null;
  /** Brave (randomises some traits on purpose: not suspicious, but the server trusts those traits less). */
  brave: boolean;
  /** Two drawings of the same canvas differed: noise added by an extension or an anti-detect browser. */
  cvNoise: boolean;
  /** Which storage the page could use. */
  storage: { ls: boolean; idb: boolean; cookie: boolean };
}

/** The signed part of a report. */
export interface DeviceRiskBody {
  v: 1;
  p: DeviceRiskPurpose;
  /** The page's origin. */
  aud: string;
  /** Unix seconds. */
  iat: number;
  /** base64url of 16 random bytes; the server accepts each once. */
  nonce: string;
  /** This browser's stored random id (`tq2_…`, shared with collectDeviceSignals), or null. */
  sid: string | null;
  t: DeviceRiskTraits;
  s: DeviceRiskFindings;
  /** Milliseconds the collection took. */
  ms: number;
}

/** What `collect` encodes: `body` is the exact JSON text the seal covers. */
export interface DeviceRiskReport {
  v: 1;
  body: string;
  seal?: DeviceSeal;
}

export interface DeviceRiskCollectOptions {
  purpose: DeviceRiskPurpose;
  /**
   * The key that seals the report. Default: the shared `browserKey`. `null`
   * sends it unsealed (the server trusts it less).
   */
  browserKey?: BrowserKey | null;
  /** Give up on the slow parts (audio, private-window check) after this long. Default 1500 ms. */
  timeoutMs?: number;
}

export interface DeviceRiskIdentifyOptions extends DeviceRiskCollectOptions {
  /** Your workspace's public site key (`tqpk_…`, dashboard → Device risk → Settings). */
  siteKey: string;
  /** TouchQue's API, default `https://api.touchque.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Identified when the page loads, not when the form is sent (the script
   * tag does this): TouchQue counts it (a sign-up, a country) when your
   * server checks it, not per page view.
   */
  pageView?: boolean;
}

/** What the page gets. Never trust it alone: your server reads the identification by `requestId`. */
export interface DeviceRiskIdentification {
  /** This browser in your workspace only (`tqv_…`). */
  visitorId: string;
  /** This identification (`dre_…`): send it to your server. Usable for one account, for 15 minutes. */
  requestId: string;
  /** 0.99 sealed by the device key, 0.95 its stored id, up to 0.9 a match of its traits, 0.5 to 0.6 a first sight. */
  confidence: number;
}

export interface DeviceRisk {
  /**
   * Identifies this browser with TouchQue (your site key, from your own
   * origin): `{ visitorId, requestId, confidence }`, or `null` (never throws)
   * when TouchQue could not be reached or refused (the reason is logged to
   * the console). Send `requestId` to your server.
   */
  identify(options: DeviceRiskIdentifyOptions): Promise<DeviceRiskIdentification | null>;
  /**
   * The encoded report (base64url JSON) for your server to pass to TouchQue
   * as `deviceRisk` (the relay alternative to identify). Never throws; collects what it can.
   */
  collect(options: DeviceRiskCollectOptions): Promise<string>;
  /** The report before encoding, for tests and debugging. */
  report(options: DeviceRiskCollectOptions): Promise<DeviceRiskReport>;
}

const MAX_ENCODED = 6144;

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256); }
  return base64url(bytes);
}

const short = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
const hex16 = async (input: string | null) => (input === null ? null : (await digestHex(input)).hex.slice(0, 16));

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

// ── coarse labels ──────────────────────────────────────────────────────────

export function osFamily(ua: string, platform: string): string {
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return 'iOS';
  if (/Windows/.test(ua) || /^Win/.test(platform)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua) || /^Mac/.test(platform)) return 'macOS';
  if (/Linux|X11/.test(ua) || /Linux/.test(platform)) return 'Linux';
  return 'Other';
}

export function browserFamily(ua: string): { br: string; bv: number } {
  const v = (re: RegExp) => { const m = re.exec(ua); return m ? Number(m[1]) || 0 : 0; };
  if (/Edg(e|A|iOS)?\//.test(ua)) return { br: 'Edge', bv: v(/Edg(?:e|A|iOS)?\/(\d+)/) };
  if (/OPR\/|Opera/.test(ua)) return { br: 'Opera', bv: v(/OPR\/(\d+)/) };
  if (/SamsungBrowser\//.test(ua)) return { br: 'Samsung', bv: v(/SamsungBrowser\/(\d+)/) };
  if (/Firefox\/|FxiOS\//.test(ua)) return { br: 'Firefox', bv: v(/(?:Firefox|FxiOS)\/(\d+)/) };
  if (/Chrome\/|CriOS\//.test(ua)) return { br: 'Chrome', bv: v(/(?:Chrome|CriOS)\/(\d+)/) };
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return { br: 'Safari', bv: v(/Version\/(\d+)/) };
  return { br: 'Other', bv: 0 };
}

// ── traits ──────────────────────────────────────────────────────────────────

function mathDigestInput(): string {
  // Engines differ in the last bits of these (V8, SpiderMonkey, JavaScriptCore, and per CPU).
  const M = Math;
  return [M.acos(0.123124234234234242), M.acosh(1e308), M.asinh(1), M.atanh(0.5), M.expm1(1), M.sinh(1),
    M.cosh(1), M.tan(-1e300), M.log1p(10), M.cbrt(Math.PI), M.exp(1) ** 10].map(String).join(',');
}

function webglLimits(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return null;
    const keys = [gl.MAX_TEXTURE_SIZE, gl.MAX_RENDERBUFFER_SIZE, gl.MAX_VERTEX_ATTRIBS, gl.MAX_VERTEX_UNIFORM_VECTORS,
      gl.MAX_FRAGMENT_UNIFORM_VECTORS, gl.MAX_VARYING_VECTORS, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, gl.MAX_VIEWPORT_DIMS,
      gl.ALIASED_LINE_WIDTH_RANGE, gl.ALIASED_POINT_SIZE_RANGE];
    const values = keys.map((k) => { const v = gl.getParameter(k); return v && typeof v === 'object' ? Array.from(v as ArrayLike<number>).join('x') : String(v); });
    const ext = (gl.getSupportedExtensions() || []).slice().sort().join(',');
    return `${values.join('|')}#${ext}`;
  } catch {
    return null;
  }
}

async function collectTraits(win: Window): Promise<{ traits: DeviceRiskTraits; canvasRaw: string | null; gpuRaw: string | null }> {
  const nav = win.navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || '';
  const platform = short(nav.platform, 32);
  const { br, bv } = browserFamily(ua);
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
  const w = win.screen?.width || 0;
  const h = win.screen?.height || 0;
  const canvasRaw = canvasSignature();
  const gpuRaw = webglRenderer();
  const fonts = installedFonts();
  const traits: DeviceRiskTraits = {
    os: osFamily(ua, platform),
    br,
    bv,
    pf: platform,
    tz: short(tz, 64),
    tzo: new Date().getTimezoneOffset(),
    lang: (Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language || '']).slice(0, 3).map((l) => short(l, 16)),
    scr: `${Math.max(w, h)}x${Math.min(w, h)}`,
    cd: win.screen?.colorDepth || 0,
    dpr: Math.round((win.devicePixelRatio || 1) * 100) / 100,
    hc: nav.hardwareConcurrency || 0,
    dm: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    tp: nav.maxTouchPoints || 0,
    gpu: gpuRaw ? gpuRaw.slice(0, 128) : null,
    cv: await hex16(canvasRaw),
    au: null,
    fn: fonts ? await hex16(fonts.join(',')) : null,
    mt: await hex16(mathDigestInput()),
    wg: await hex16(webglLimits()),
  };
  return { traits, canvasRaw, gpuRaw };
}

// ── findings ────────────────────────────────────────────────────────────────

const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;

/** The getters and methods anti-detect tools and spoofing extensions replace. */
const WATCHED: Array<[string, () => object | undefined, string, 'get' | 'value']> = [
  ['nav_user_agent', () => Navigator.prototype, 'userAgent', 'get'],
  ['nav_platform', () => Navigator.prototype, 'platform', 'get'],
  ['nav_languages', () => Navigator.prototype, 'languages', 'get'],
  ['nav_cores', () => Navigator.prototype, 'hardwareConcurrency', 'get'],
  ['nav_webdriver', () => Navigator.prototype, 'webdriver', 'get'],
  ['nav_touch', () => Navigator.prototype, 'maxTouchPoints', 'get'],
  ['screen_width', () => Screen.prototype, 'width', 'get'],
  ['screen_height', () => Screen.prototype, 'height', 'get'],
  ['canvas_data_url', () => HTMLCanvasElement.prototype, 'toDataURL', 'value'],
  ['canvas_context', () => HTMLCanvasElement.prototype, 'getContext', 'value'],
  ['canvas_image_data', () => (typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : undefined), 'getImageData', 'value'],
  ['webgl_parameter', () => (typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : undefined), 'getParameter', 'value'],
  ['tz_resolved', () => Intl.DateTimeFormat.prototype, 'resolvedOptions', 'value'],
  ['tz_offset', () => Date.prototype, 'getTimezoneOffset', 'value'],
  ['audio_channel', () => (typeof AudioBuffer !== 'undefined' ? AudioBuffer.prototype : undefined), 'getChannelData', 'value'],
];

/** Instance properties that only exist when script defined them over the prototype's getter. */
const OWN_ON_INSTANCE: Array<[string, () => object | undefined, string]> = [
  ['nav_own_property', () => navigator, 'userAgent'],
  ['nav_own_property', () => navigator, 'platform'],
  ['nav_own_property', () => navigator, 'webdriver'],
  ['nav_own_property', () => navigator, 'hardwareConcurrency'],
  ['nav_own_property', () => navigator, 'languages'],
  ['screen_own_property', () => screen, 'width'],
];

function isNative(fn: unknown): boolean {
  try {
    if (typeof fn !== 'function') return true; // nothing to judge
    if (!NATIVE.test(Function.prototype.toString.call(fn))) return false;
    // Native methods and getters have no own prototype; a `function () {}` stand-in does.
    return !Object.prototype.hasOwnProperty.call(fn, 'prototype');
  } catch {
    return false; // a Proxy whose toString trap throws
  }
}

/** `native` decides what counts as the browser's own code (tests pass their own: jsdom is written in JavaScript). */
export function tamperFindings(win: Window, native: (fn: unknown) => boolean = isNative): string[] {
  const out = new Set<string>();
  if (!native(Function.prototype.toString)) out.add('fn_to_string');
  for (const [code, target, prop, kind] of WATCHED) {
    try {
      const proto = target();
      if (!proto) continue;
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d) continue;
      if (!native(kind === 'get' ? d.get : d.value)) out.add(code);
    } catch { /* a throwing getter is not evidence by itself */ }
  }
  for (const [code, target, prop] of OWN_ON_INSTANCE) {
    try {
      const obj = target();
      if (obj && Object.prototype.hasOwnProperty.call(obj, prop)) out.add(code);
    } catch { /* ignore */ }
  }
  const nav = win.navigator as Navigator & { userAgentData?: { platform?: string; brands?: Array<{ brand: string }> } };
  const ua = nav.userAgent || '';
  const os = osFamily(ua, '');
  const pf = nav.platform || '';
  // What the User-Agent says against what the rest of the browser says.
  try {
    const pfOs = /^Win/.test(pf) ? 'Windows' : /^Mac/.test(pf) ? 'macOS' : /^(iPhone|iPad|iPod)/.test(pf) ? 'iOS' : /Linux|Android/.test(pf) ? 'Linux' : '';
    const uaOs = os === 'Android' || os === 'ChromeOS' ? 'Linux' : os;
    // iPadOS asks for desktop pages as a Mac with touch points: the same device.
    if (pfOs && uaOs !== 'Other' && pfOs !== uaOs && !(uaOs === 'iOS' && pfOs === 'macOS') && !(uaOs === 'macOS' && pfOs === 'iOS')) out.add('ua_platform_mismatch');
  } catch { /* ignore */ }
  try {
    const chPf = nav.userAgentData?.platform;
    if (chPf) {
      const map: Record<string, string> = { Windows: 'Windows', macOS: 'macOS', Linux: 'Linux', Android: 'Android', 'Chrome OS': 'ChromeOS', ChromeOS: 'ChromeOS', iOS: 'iOS' };
      if (map[chPf] && os !== 'Other' && map[chPf] !== os) out.add('uach_platform_mismatch');
    }
  } catch { /* ignore */ }
  try {
    const gecko = typeof (win as unknown as { mozInnerScreenX?: number }).mozInnerScreenX === 'number';
    const { br } = browserFamily(ua);
    if (br === 'Firefox' && !/FxiOS/.test(ua) && !gecko) out.add('ua_engine_mismatch');
    if ((br === 'Chrome' || br === 'Edge' || br === 'Opera') && !/CriOS|EdgiOS|OPT\//.test(ua) && gecko) out.add('ua_engine_mismatch');
  } catch { /* ignore */ }
  try {
    const langs = nav.languages;
    if (Array.isArray(langs) && langs.length && nav.language && langs[0] !== nav.language) out.add('language_mismatch');
  } catch { /* ignore */ }
  // The zone the browser names against the offset its clock uses (an extension that changed only one).
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      const now = new Date();
      const there = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      const zoneOffset = Math.round((utc.getTime() - there.getTime()) / 60000);
      if (Math.abs(zoneOffset - now.getTimezoneOffset()) > 1) out.add('timezone_mismatch');
    }
  } catch { /* ignore */ }
  try {
    const hc = nav.hardwareConcurrency;
    if (typeof hc === 'number' && (hc < 1 || hc > 256 || !Number.isInteger(hc))) out.add('impossible_cores');
  } catch { /* ignore */ }
  return [...out].sort();
}

export function vmFindings(win: Window, gpu: string | null): string[] {
  const out = new Set<string>();
  const nav = win.navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } };
  if (gpu && /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Microsoft Basic Render|Mesa OffScreen/i.test(gpu)) out.add('soft_gpu');
  if (gpu && /VMware|VirtualBox|Parallels|QXL|Red Hat|virgl|Hyper-V|Citrix|bochs|UTM|Apple Paravirtual/i.test(gpu)) out.add('vm_gpu');
  try { if (/HeadlessChrome|PhantomJS|SlimerJS/.test(nav.userAgent || '')) out.add('headless'); } catch { /* ignore */ }
  try { if ((nav.userAgentData?.brands || []).some((b) => /Headless/i.test(b.brand))) out.add('headless'); } catch { /* ignore */ }
  try { if (nav.webdriver === true) out.add('webdriver'); } catch { /* ignore */ }
  try { if (win.outerWidth === 0 && win.outerHeight === 0) out.add('zero_window'); } catch { /* ignore */ }
  try { if (nav.hardwareConcurrency === 1) out.add('one_core'); } catch { /* ignore */ }
  return [...out].sort();
}

/** How a private window showed itself, where the browser lets that be seen (heuristic; null when not seen). */
export async function privateWindow(win: Window): Promise<string | null> {
  const nav = win.navigator as Navigator & { brave?: unknown; storage?: StorageManager & { getDirectory?: () => Promise<unknown> } };
  const ua = nav.userAgent || '';
  const { br } = browserFamily(ua);
  try {
    if (br === 'Firefox' && win.isSecureContext && !('serviceWorker' in nav)) return 'firefox_no_sw';
    if (br === 'Safari' && nav.storage && typeof nav.storage.getDirectory === 'function') {
      try {
        await nav.storage.getDirectory();
      } catch (err) {
        if (String((err as Error)?.message || '').includes('unknown transient reason')) return 'safari_opfs';
      }
      return null;
    }
    if ((br === 'Chrome' || br === 'Edge' || br === 'Opera' || br === 'Samsung') && nav.storage?.estimate) {
      const { quota } = await nav.storage.estimate();
      const heap = (win.performance as Performance & { memory?: { jsHeapSizeLimit?: number } })?.memory?.jsHeapSizeLimit || 1073741824;
      // A private window's quota is tied to memory; a normal one to the disk.
      if (typeof quota === 'number' && quota > 0 && quota < heap * 2) return 'chromium_quota';
    }
  } catch { /* ignore */ }
  return null;
}

function storageFindings(win: Window): DeviceRiskFindings['storage'] {
  const out = { ls: false, idb: false, cookie: false };
  try { const k = '__tq_dr'; win.localStorage.setItem(k, '1'); win.localStorage.removeItem(k); out.ls = true; } catch { /* ignore */ }
  try { out.idb = typeof win.indexedDB !== 'undefined' && !!win.indexedDB; } catch { /* ignore */ }
  try { out.cookie = win.navigator.cookieEnabled === true; } catch { /* ignore */ }
  return out;
}

function pageOrigin(win: Window): string {
  try { const o = win.location.origin; return o && o !== 'null' ? o : ''; } catch { return ''; }
}

/** Builds the report. Never throws: every part fails soft. */
export async function buildDeviceRiskReport(options: DeviceRiskCollectOptions, win: Window = window): Promise<DeviceRiskReport> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 1500;
  const purpose: DeviceRiskPurpose = DEVICE_RISK_PURPOSES.includes(options.purpose) ? options.purpose : 'sign_in';
  const { traits, canvasRaw, gpuRaw } = await collectTraits(win);
  const [audio, priv] = await Promise.all([
    within(audioSignature(), timeoutMs, null),
    within(privateWindow(win), timeoutMs, null),
  ]);
  traits.au = await hex16(audio);
  let cvNoise = false;
  try {
    const again = canvasSignature();
    cvNoise = !!canvasRaw && !!again && again !== canvasRaw;
  } catch { /* ignore */ }
  const nav = win.navigator as Navigator & { brave?: unknown };
  const body: DeviceRiskBody = {
    v: 1,
    p: purpose,
    aud: pageOrigin(win),
    iat: Math.floor(Date.now() / 1000),
    nonce: randomNonce(),
    sid: readOrCreateDeviceId(),
    t: traits,
    s: {
      tamper: tamperFindings(win),
      vm: vmFindings(win, gpuRaw),
      priv,
      brave: typeof nav.brave === 'object' && nav.brave !== null,
      cvNoise,
      storage: storageFindings(win),
    },
    ms: Date.now() - started,
  };
  const text = JSON.stringify(body);
  const report: DeviceRiskReport = { v: 1, body: text };
  const key = options.browserKey === undefined ? defaultBrowserKey : options.browserKey;
  if (key && typeof key.sealDevice === 'function') {
    try {
      const digest = await digestHex(text);
      if (!digest.weak) {
        const bytes = new Uint8Array(digest.hex.match(/../g)!.map((b) => parseInt(b, 16)));
        const seal = await key.sealDevice(base64url(bytes));
        if (seal) report.seal = seal;
      }
    } catch { /* unsealed */ }
  }
  return report;
}

const SITE_KEY = /^tqpk_[A-Za-z0-9_-]{32}$/;
const DEFAULT_API = 'https://api.touchque.com';

export function createDeviceRisk(win?: Window): DeviceRisk {
  const target = () => win ?? window;
  const api: DeviceRisk = {
    report: (options) => buildDeviceRiskReport(options, target()),
    async identify(options) {
      if (!options || typeof options.siteKey !== 'string' || !SITE_KEY.test(options.siteKey)) {
        throw new Error('deviceRisk.identify: siteKey must be your workspace\'s Device risk site key (tqpk_…)');
      }
      const base = (options.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      if (!/^https?:\/\/[^/]/i.test(base)) throw new Error('deviceRisk.identify: apiBaseUrl must be an absolute URL, e.g. https://api.touchque.com');
      const doFetch = (options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined));
      if (!doFetch) throw new Error('deviceRisk.identify: no `fetch` available, pass `fetch` in the options.');
      try {
        const report = await api.collect(options);
        // text/plain: a simple request, so no CORS preflight.
        const res = await doFetch.call(globalThis, `${base}/device-risk/identify`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ siteKey: options.siteKey, report, ...(options.pageView && { view: true }) }),
          credentials: 'omit',
        });
        const out = await res.json().catch(() => null) as Partial<DeviceRiskIdentification> & { code?: string } | null;
        if (!res.ok || !out || typeof out.visitorId !== 'string' || typeof out.requestId !== 'string') {
          logWarn(`TouchQue deviceRisk.identify: ${out?.code || res.status}`);
          return null;
        }
        return { visitorId: out.visitorId, requestId: out.requestId, confidence: typeof out.confidence === 'number' ? out.confidence : 0 };
      } catch (err) {
        logWarn(`TouchQue deviceRisk.identify: TouchQue could not be reached (${errorText(err)})`);
        return null;
      }
    },
    async collect(options) {
      try {
        const report = await buildDeviceRiskReport(options, target());
        let encoded = encodeJson(report);
        if (encoded.length > MAX_ENCODED) {
          // A long GPU name: cut it. The seal covers the whole body, so the cut report goes unsealed.
          const body = JSON.parse(report.body) as DeviceRiskBody;
          body.t.gpu = body.t.gpu ? body.t.gpu.slice(0, 48) : null;
          encoded = encodeJson({ v: 1, body: JSON.stringify(body) });
        }
        return encoded;
      } catch {
        return encodeJson({ v: 1, body: JSON.stringify({ v: 1, p: options.purpose, error: true }) });
      }
    },
  };
  return api;
}

/** Device risk for this page (the shared browser key seals it). */
export const deviceRisk: DeviceRisk = createDeviceRisk();
