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
  offline?: { challengeId: string; qrDataUrl?: string; expiresAt?: string; totpAvailable?: boolean; attemptsLeft?: number };
  reason?: string;
  retryAfter?: number;
  assurance?: { phishingResistant: boolean; method: string };
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
  fetch?: typeof fetch;
}

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
  let wake: (() => void) | undefined;

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

    const res = await doFetch(input, { ...init, headers, signal: options.signal });
    const body = await res.clone().json().catch(() => null);
    const step: Step | undefined = body && typeof body === 'object' && body.touchque && typeof body.touchque.state === 'string' ? body.touchque : undefined;

    if (!step || res.status !== 202) {
      if (step) options.onStep?.(step, controls);
      return res; // your route's response, or a final TouchQue refusal
    }
    token = typeof body.token === 'string' ? body.token : token;
    options.onStep?.(step, controls);
    if (TERMINAL.includes(step.state)) return res;

    if (step.state === 'passkey_required') {
      if (!options.approveWithPasskey || !step.requestId) return res; // caller handles the passkey step itself
      if (passkeyTried !== step.requestId) {
        passkeyTried = step.requestId;
        await options.approveWithPasskey(step.requestId); // browser ceremony; errors propagate (e.g. user dismissed)
        continue;
      }
    }
    // Offline: wait for the user to type the code. Otherwise re-check shortly.
    await sleep(step.state === 'offline' && !code ? null : poll);
  }
}
