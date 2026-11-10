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
import { createDeviceRisk } from '../deviceRisk';

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
   * Opt in to Device risk on this page (bigger privacy footprint): the
   * telemetry carries the page's device report (`deviceRisk.collect`), which
   * TouchQue identifies as a visitor of your workspace. Only used when the
   * workspace turned Device risk on; disclose it in your privacy notice.
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
  // A relative or missing base would post to the partner's own site and be
  // lost silently (R1-04).
  if (!/^https?:\/\/[^/]/i.test(apiBaseUrl)) {
    throw new Error('attachBehavioral: apiBaseUrl must be the absolute TouchQue API URL, e.g. https://api.touchque.com');
  }
  const fetchImpl = (options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined));
  if (!fetchImpl) {
    throw new Error('attachBehavioral: no `fetch` available — pass `fetch` in the options.');
  }
  const doFetch = fetchImpl.bind(globalThis);

  const tracker = createBehavioralTracker(containerEl, {
    sampleIntervalMs: options.sampleIntervalMs,
  });

  // The page's Device risk report, collected once; the async collection
  // never delays tracking or the first submit beyond ~1.5 s (audio probe).
  let reportPromise: Promise<string> | null = null;
  if (options.collectDeviceFingerprint === true) {
    reportPromise = createDeviceRisk().collect({ purpose: 'sign_in' });
  }

  tracker.start();

  async function submit(): Promise<void> {
    const metrics = tracker.getMetrics();
    const body: Record<string, unknown> = { ...metrics };
    if (reportPromise) {
      try {
        body.deviceRisk = await reportPromise;
      } catch { /* the movement aggregates still go out */ }
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
