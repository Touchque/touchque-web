// Behavioral biometrics widget — the one call in this SDK that goes directly
// from the browser to TouchQue. It is gated by a per-request `telemetryToken`
// that the partner's own backend mints server-side (POST /login/request with
// TenantPolicy.behavioralBiometricsEnabled) — the browser never holds the
// partner's API key.
//
// Scoped strictly to the container element passed in: it never adds
// window/document listeners, and a failed telemetry POST is swallowed so it
// can never block or surface an error on the partner's 2FA flow.

import { createBehavioralTracker } from './tracker';
import { generateDeviceFingerprint, collectDeviceSignals, type DeviceSignals } from './fingerprint';

export { collectDeviceSignals } from './fingerprint';
export type { DeviceSignals } from './fingerprint';

export type { BehavioralMetrics } from './tracker';

export interface AttachBehavioralOptions {
  /** Per-request token minted by the partner backend. Required. */
  telemetryToken: string;
  /** The pending login request id this telemetry belongs to. Required. */
  requestId: string;
  /** TouchQue API base URL, e.g. `https://api.touchque.com`. */
  apiBaseUrl: string;
  /**
   * Opt in to device recognition (bigger privacy footprint): a stable
   * per-browser id plus hardware/OS traits (WebGL, audio, fonts, screen,
   * timezone). Only used when the workspace also enables
   * `deviceFingerprintingEnabled`; disclose it in your privacy notice.
   */
  collectDeviceFingerprint?: boolean;
  /** Sampling interval (ms) for the internal tracker. Default 1000. */
  sampleIntervalMs?: number;
  /** Injectable fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface BehavioralHandle {
  /** Stop tracking and remove the container listeners. */
  stop(): void;
  /** Zero the accumulated metrics without detaching. */
  reset(): void;
  /** Send the current metrics to TouchQue. Best-effort, never throws. */
  submit(): Promise<void>;
}

function resolveContainer(target: string | Element): Element | null {
  if (typeof target === 'string') return document.querySelector(target);
  return target || null;
}

export function attachBehavioral(
  target: string | Element,
  options: AttachBehavioralOptions,
): BehavioralHandle {
  const containerEl = resolveContainer(target);
  if (!containerEl) {
    throw new Error('attachBehavioral: container not found');
  }
  if (!options.telemetryToken || !options.requestId) {
    throw new Error('attachBehavioral: telemetryToken and requestId are required');
  }

  const apiBaseUrl = (options.apiBaseUrl || '').replace(/\/+$/, '');
  const fetchImpl = (options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined));
  if (!fetchImpl) {
    throw new Error('attachBehavioral: no `fetch` available — pass `fetch` in the options.');
  }
  const doFetch = fetchImpl.bind(globalThis);

  const tracker = createBehavioralTracker(containerEl, {
    sampleIntervalMs: options.sampleIntervalMs,
  });

  // v1 hash (kept for the server's drift comparison) + v2 signals, collected
  // once; the async v2 collection never delays tracking or the first submit
  // beyond ~1.5 s (audio probe timeout).
  let fingerprint: string | null = null;
  let signalsPromise: Promise<DeviceSignals> | null = null;
  if (options.collectDeviceFingerprint === true) {
    fingerprint = generateDeviceFingerprint();
    signalsPromise = collectDeviceSignals();
  }

  tracker.start();

  async function submit(): Promise<void> {
    const metrics = tracker.getMetrics();
    let body: Record<string, unknown> = { ...metrics };
    if (fingerprint) {
      body.deviceFingerprint = fingerprint;
      try {
        const signals = signalsPromise ? await signalsPromise : null;
        if (signals) body.deviceSignals = { deviceId: signals.deviceId, fingerprint: signals.fingerprint, traits: signals.traits, version: signals.version };
      } catch { /* v1 fingerprint alone still goes out */ }
    }
    try {
      await doFetch(`${apiBaseUrl}/login/${encodeURIComponent(options.requestId)}/telemetry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.telemetryToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Best-effort — a failed telemetry submission must never block or
      // surface an error on the partner's 2FA flow.
    }
  }

  return {
    stop: () => tracker.stop(),
    reset: () => tracker.reset(),
    submit,
  };
}
