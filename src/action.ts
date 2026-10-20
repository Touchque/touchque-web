// Step-up from the browser, without any TouchQue UI.
//
// Your server protects a route with requireTouchQue('SEND_MONEY') (or any
// TouchQue server SDK). Call it with touchqueFetch instead of fetch:
//
//   const res = await touchqueFetch('/api/transfer', { method: 'POST', body }, {
//     onStep(step, controls) {
//       // render it YOUR way:
//       //   step.state === 'waiting'  → "Approve on your phone", show step.number if present
//       //   step.state === 'enroll'   → <img src={step.enroll.qrCodeDataUrl}> "Scan with TouchQue"
//       //   step.state === 'offline'  → <img src={step.offline.qrDataUrl}> + input → controls.submitCode(code)
//       //   controls.useOffline()     → phone has no internet
//     },
//   });
//   // res is your route's own response once approved (or the final 403/408/423/429).
//
// While waiting it re-sends the same request with the X-TouchQue-Token header
// every `pollIntervalMs`. Your route runs once, after approval.

export type StepState =
  | 'waiting' | 'approved' | 'rejected' | 'expired' | 'enroll'
  | 'passkey_required' | 'offline' | 'blocked' | 'frozen' | 'rate_limited';

export interface Step {
  state: StepState;
  requestId?: string;
  /** Number matching: show it; the user picks it on the phone. */
  number?: string;
  expiresAt?: string;
  details?: Array<{ label: string; value: string }>;
  enroll?: { qrCodeDataUrl: string; recoveryCodes?: string[]; expiresAt?: string };
  offline?: {
    challengeId: string;
    qrDataUrl?: string;
    expiresAt?: string;
    totpAvailable?: boolean;
    attemptsLeft?: number;
    /** Number matching: print this under the QR — the phone shows it among two decoys and the user taps the match. */
    challengeCode?: string;
  };
  reason?: string;
  /**
   * "Why?" (server SDKs 4.0.0): the case code of this decision (`K7P-2QX`).
   * Show it with the step ("Tell your support team: K7P-2QX"); the team opens
   * the whole decision by this code in the TouchQue dashboard.
   */
  caseCode?: string;
  /** Why number matching, a passkey or a refusal (plain English, a fixed list, never a score). */
  reasons?: Array<{ code: string; text: string }>;
  retryAfter?: number;
  assurance?: { phishingResistant: boolean; method: string };
  /** Only when the workspace collects behavioural signals (see `TouchQueFetchOptions.telemetry`). */
  telemetryToken?: string;
  /**
   * Mirror Alarm (server SDKs 3.4.0): touchqueFetch loads it on this page by
   * itself (see `sendCanary`), so a real-time phishing proxy in front of your
   * site gets the approval refused. Only on the first waiting step.
   */
  canary?: { url: string };
}

/**
 * Mirror Alarm: tells TouchQue which page shows this sign-in, so a phishing
 * proxy in front of your site gets the approval refused. Loads the canary as a
 * hidden image (the browser adds the page's origin as Referer) and sends a
 * beacon with `location.origin`. touchqueFetch does it by itself for every
 * step that carries `canary`; call it only when you render steps without it.
 * Allow the canary host in your CSP `img-src` and `connect-src`. Never throws.
 */
export function sendCanary(canary: { url: string } | undefined): void {
  const url = canary?.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || typeof document === 'undefined') return;
  try {
    const img = document.createElement('img');
    img.alt = '';
    img.width = 1;
    img.height = 1;
    img.setAttribute('aria-hidden', 'true');
    // Keeps the page's origin in Referer even under a no-referrer page policy.
    img.referrerPolicy = 'origin';
    img.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
    const done = () => { img.remove(); };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    img.src = url;
    (document.body || document.documentElement).appendChild(img);
  } catch {
    // The beacon below still reports the page.
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      let top = true;
      try { top = window.top === window; } catch { top = false; }
      // A string is sent as text/plain: no CORS preflight.
      navigator.sendBeacon(url.replace(/\.gif(?=$|[?#])/i, ''), JSON.stringify({
        origin: location.origin, top, referrer: document.referrer || '',
      }));
    }
  } catch {
    // Best effort: nothing on the page depends on it.
  }
}

export interface StepControls {
  /** Phone has no internet: switch to the offline QR code. */
  useOffline(): void;
  /** Send the code from the phone (`totp`: the rolling time-based code, no QR scan). */
  submitCode(code: string, type?: 'qr' | 'totp'): void;
  /** Stop waiting; touchqueFetch rejects with an AbortError. */
  cancel(): void;
}

export interface TouchQueFetchOptions {
  onStep?: (step: Step, controls: StepControls) => void;
  /** How often to re-check while waiting (default 1500 ms). */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Passkey approval for `passkey_required` (set automatically by createTouchQueWeb). */
  approveWithPasskey?: (requestId: string) => Promise<unknown>;
  /**
   * Silent sign-ins: makes the browser key proof sent as `X-TouchQue-Browser`
   * with each request (set by createTouchQueWeb with `browserKey: true`; or
   * pass `browserKey.proof`). `null`, or an error, sends no header.
   */
  browserProof?: () => Promise<string | null>;
  fetch?: typeof fetch;
  /**
   * Send behavioural signals for this approval when the workspace collects
   * them (the server's step then carries a `telemetryToken`). Off unless set.
   */
  telemetry?: {
    /** TouchQue API base URL, e.g. `https://api.touchque.com`. */
    apiBaseUrl: string;
    /** Element whose pointer/keyboard activity is measured (default: document.body). */
    container?: string | Element;
    /** Also send device recognition signals; disclose it in your privacy notice. */
    collectDeviceFingerprint?: boolean;
  };
}

import { attachBehavioral, type BehavioralHandle } from './behavioral';
import { BROWSER_PROOF_HEADER } from './browserKey';

const TERMINAL: StepState[] = ['approved', 'rejected', 'expired', 'blocked', 'frozen', 'rate_limited'];

function abortError(): Error {
  const e = new Error('TouchQue approval cancelled');
  e.name = 'AbortError';
  return e;
}

export async function touchqueFetch(input: RequestInfo | URL, init: RequestInit = {}, options: TouchQueFetchOptions = {}): Promise<Response> {
  const doFetch = (options.fetch ?? fetch).bind(globalThis);
  const poll = options.pollIntervalMs ?? 1500;
  let token: string | undefined;
  let offline = false;
  let code: { value: string; type: 'qr' | 'totp' } | undefined;
  let cancelled = false;
  let passkeyTried: string | undefined;
  let lastOfflineId: string | undefined;
  let wake: (() => void) | undefined;
  let tracker: BehavioralHandle | undefined;
  let telemetrySent = false;
  const canariesSent = new Set<string>();

  const controls: StepControls = {
    useOffline() { offline = true; wake?.(); },
    submitCode(value, type = 'qr') { code = { value, type }; wake?.(); },
    cancel() { cancelled = true; wake?.(); },
  };
  options.signal?.addEventListener('abort', () => controls.cancel(), { once: true });

  const sleep = (ms: number | null) => new Promise<void>((resolve) => {
    const t = ms === null ? undefined : setTimeout(() => { wake = undefined; resolve(); }, ms);
    wake = () => { if (t) clearTimeout(t); wake = undefined; resolve(); };
  });

  try {
    for (;;) {
      if (cancelled) throw abortError();
      const headers = new Headers(init.headers);
      if (token) headers.set('X-TouchQue-Token', token);
      if (offline) headers.set('X-TouchQue-Offline', '1');
      if (code) {
        headers.set('X-TouchQue-Code', code.value);
        if (code.type === 'totp') headers.set('X-TouchQue-Code-Type', 'totp');
      }
      offline = false;
      code = undefined;
      // A fresh proof on every request, polls included: the server reads it
      // only when it starts an approval (also after a first-time enrollment).
      const makeProof = options.browserProof;
      if (makeProof && !headers.has(BROWSER_PROOF_HEADER)) {
        const proof = await Promise.resolve().then(makeProof).catch(() => null);
        if (typeof proof === 'string' && proof) headers.set(BROWSER_PROOF_HEADER, proof);
      }

      const res = await doFetch(input, { ...init, headers, signal: options.signal });
      const body = await res.clone().json().catch(() => null);
      const step: Step | undefined = body && typeof body === 'object' && body.touchque && typeof body.touchque.state === 'string' ? body.touchque : undefined;
      if (step?.canary?.url && !canariesSent.has(step.canary.url)) {
        canariesSent.add(step.canary.url);
        sendCanary(step.canary);
      }

      if (!step || res.status !== 202) {
        if (step) options.onStep?.(step, controls);
        return res; // your route's response, or a final TouchQue refusal
      }
      token = typeof body.token === 'string' ? body.token : token;
      if (!tracker && options.telemetry && step.telemetryToken && step.requestId && typeof document !== 'undefined') {
        try {
          tracker = attachBehavioral(options.telemetry.container ?? document.body, {
            telemetryToken: step.telemetryToken, requestId: step.requestId, apiBaseUrl: options.telemetry.apiBaseUrl,
            collectDeviceFingerprint: options.telemetry.collectDeviceFingerprint, fetch: options.fetch,
          });
        } catch (err) {
          console.warn('[TouchQue] behavioural telemetry not started:', err instanceof Error ? err.message : err);
        }
      }
      // While the QR is on screen the loop keeps checking (so a phone-side reject ends the attempt at once).
      // Those checks carry no QR again — don't make the page redraw the one it already shows.
      const sameQrStillUp = step.state === 'offline' && !!step.offline && !step.offline.qrDataUrl && step.offline.attemptsLeft === undefined
        && !step.reason && lastOfflineId === step.offline.challengeId;
      if (step.state === 'offline' && step.offline?.qrDataUrl) lastOfflineId = step.offline.challengeId;
      if (!sameQrStillUp) options.onStep?.(step, controls);
      if (TERMINAL.includes(step.state)) return res;

      if (step.state === 'passkey_required') {
        if (!options.approveWithPasskey || !step.requestId) return res; // caller handles the passkey step itself
        if (passkeyTried !== step.requestId) {
          passkeyTried = step.requestId;
          await options.approveWithPasskey(step.requestId); // browser ceremony; errors propagate (e.g. user dismissed)
          continue;
        }
      }
      // Offline: keep checking the push while the user reads the QR / types the code; a submitted code wakes us.
      await sleep(poll);
      // One submission, after the user has had a moment on the page: it must
      // reach TouchQue before the approval does to count.
      if (tracker && !telemetrySent) {
        telemetrySent = true;
        void tracker.submit();
      }
    }
  } finally {
    tracker?.stop();
  }
}
