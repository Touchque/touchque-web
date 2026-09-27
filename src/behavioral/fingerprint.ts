// Browser device signals — deliberately separate from the movement tracker.
// A persistent device identity is a materially bigger privacy footprint than
// per-challenge movement aggregates (it identifies a browser across
// sessions), so it is only collected when the integrator explicitly opts in
// via `collectDeviceFingerprint: true` AND the workspace enables it
// (TenantPolicy.deviceFingerprintingEnabled — the server drops the signals
// otherwise). Disclose it in your privacy notice (KVKK / GDPR).
//
// What this can and cannot do:
//  - It recognises "the same browser" (returning device vs first sight) and
//    "the same device behind many accounts". It is NOT a hardware id: a
//    browser cannot read a MAC address, serial number or any network-card
//    identifier, and phones randomise Wi-Fi MACs anyway.
//  - The stable id lives in localStorage; clearing site data or a private
//    window makes the browser look new. `fingerprint` (from hardware/OS
//    traits) survives that and lets the server link the new id back to it.
//  - Nothing here defeats a determined attacker who spoofs every signal; it
//    raises the cost of credential stuffing and account sharing, and feeds
//    the risk score. It never blocks anyone by itself.

const STORAGE_KEY = 'tq_device_id';
const ID_VERSION = 'tq2';

export interface DeviceSignals {
  /** Random per-browser id kept in localStorage (null when storage is unavailable) */
  deviceId: string | null;
  /** SHA-256 hex of the traits below; stable across storage clears */
  fingerprint: string;
  /** Coarse, human-readable traits (for the dashboard / debugging) */
  traits: {
    platform: string;
    language: string;
    timezone: string;
    screen: string;
    cores: number;
    memoryGb: number | null;
    touchPoints: number;
    webglRenderer: string | null;
    canvas: string | null;
    audio: string | null;
    fonts: number | null;
    cookiesEnabled: boolean;
    doNotTrack: string | null;
  };
  version: string;
}

// ── stable random id ────────────────────────────────────────────────────────

function randomId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readOrCreateDeviceId(): string | null {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing && /^tq2_[0-9a-f]{32}$/.test(existing)) return existing;
    const created = `${ID_VERSION}_${randomId()}`;
    window.localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return null; // private mode / storage blocked
  }
}

// ── individual signals (each fails soft to null) ────────────────────────────

function webglRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return gl.getParameter(gl.RENDERER) as string;
    return `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}|${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`;
  } catch {
    return null;
  }
}

function canvasSignature(): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.font = "14px 'Arial'";
    ctx.fillText('TouchQue device \u{1F512} \u00E7\u011F\u0131\u00F6\u015F\u00FC', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.font = "18px serif";
    ctx.fillText('TouchQue device \u{1F512} \u00E7\u011F\u0131\u00F6\u015F\u00FC', 4, 40);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgb(255,0,255)';
    ctx.beginPath();
    ctx.arc(50, 30, 20, 0, Math.PI * 2, true);
    ctx.fill();
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

async function audioSignature(): Promise<string | null> {
  try {
    const Ctx = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext });
    const Offline = Ctx.OfflineAudioContext || Ctx.webkitOfflineAudioContext;
    if (!Offline) return null;
    const context = new Offline(1, 5000, 44100);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 10000;
    const compressor = context.createDynamicsCompressor();
    oscillator.connect(compressor);
    compressor.connect(context.destination);
    oscillator.start(0);
    const buffer = await Promise.race([
      context.startRendering(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!buffer) return null;
    const data = buffer.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    return sum.toFixed(6);
  } catch {
    return null;
  }
}

const FONT_PROBES = ['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Palatino', 'Garamond',
  'Comic Sans MS', 'Trebuchet MS', 'Impact', 'Tahoma', 'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Menlo', 'Monaco',
  'Roboto', 'Ubuntu', 'Noto Sans', 'Lucida Grande', 'Helvetica Neue', 'SF Pro Text', 'Apple Color Emoji'];

/** Number of probe fonts that render differently from the fallback (a cheap installed-fonts count). */
function installedFontCount(): number | null {
  try {
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:72px;visibility:hidden';
    span.textContent = 'mmmmmmmmmmlliWWW';
    document.body.appendChild(span);
    const measure = (family: string) => {
      span.style.fontFamily = family;
      return `${span.offsetWidth}x${span.offsetHeight}`;
    };
    const baselines = ['monospace', 'sans-serif', 'serif'].map(measure);
    let count = 0;
    for (const font of FONT_PROBES) {
      const differs = ['monospace', 'sans-serif', 'serif'].some((base, i) => measure(`'${font}',${base}`) !== baselines[i]);
      if (differs) count++;
    }
    document.body.removeChild(span);
    return count;
  } catch {
    return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }
  // Non-secure context (http): a 53-bit cyrb53 hash, formatted like a hex digest
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(64, '0');
}

/**
 * Collects the browser's device signals. Never throws; on failure returns a
 * best-effort object (fingerprint 'fp_error' when even that is impossible).
 */
export async function collectDeviceSignals(): Promise<DeviceSignals> {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const traits: DeviceSignals['traits'] = {
      platform: navigator.platform || '',
      language: navigator.language || '',
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })(),
      screen: `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}@${window.devicePixelRatio || 1}`,
      cores: navigator.hardwareConcurrency || 1,
      memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      touchPoints: navigator.maxTouchPoints || 0,
      webglRenderer: webglRenderer(),
      canvas: null,
      audio: await audioSignature(),
      fonts: installedFontCount(),
      cookiesEnabled: navigator.cookieEnabled === true,
      doNotTrack: navigator.doNotTrack ?? null,
    };
    const canvas = canvasSignature();
    traits.canvas = canvas ? (await sha256Hex(canvas)).slice(0, 16) : null;

    // The User-Agent is deliberately NOT part of the fingerprint: a browser
    // update would otherwise look like a new device.
    const fingerprint = await sha256Hex(JSON.stringify([
      traits.platform, traits.timezone, traits.screen, traits.cores, traits.memoryGb, traits.touchPoints,
      traits.webglRenderer, traits.canvas, traits.audio, traits.fonts,
    ]));
    return { deviceId: readOrCreateDeviceId(), fingerprint: `tq2_fp_${fingerprint.slice(0, 32)}`, traits, version: ID_VERSION };
  } catch {
    return {
      deviceId: readOrCreateDeviceId(),
      fingerprint: 'fp_error',
      traits: {
        platform: '', language: '', timezone: '', screen: '', cores: 1, memoryGb: null, touchPoints: 0,
        webglRenderer: null, canvas: null, audio: null, fonts: null, cookiesEnabled: false, doNotTrack: null,
      },
      version: ID_VERSION,
    };
  }
}

/**
 * v1 fingerprint (canvas + screen + UA hash), kept so existing integrations
 * and the server's drift comparison keep working. Prefer collectDeviceSignals().
 */
export function generateDeviceFingerprint(): string {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no-canvas';

    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('TouchQue Behavioral Widget Fingerprint', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('TouchQue Behavioral Widget Fingerprint', 4, 17);

    const canvasData = canvas.toDataURL();
    const screenData = `${window.screen.width}x${window.screen.height}-${window.screen.colorDepth}`;
    const browserData = `${navigator.userAgent}-${navigator.language}-${navigator.platform}-${navigator.hardwareConcurrency || 1}`;
    const raw = canvasData + screenData + browserData;

    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = (hash << 5) + hash + raw.charCodeAt(i);
    }
    return `tq_fp_${Math.abs(hash).toString(16)}`;
  } catch {
    return 'fp_error';
  }
}
