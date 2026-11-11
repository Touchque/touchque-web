// src/deviceRiskTag.ts
// The one-line install of Device risk: a script tag on your sign-in, sign-up,
// password-reset or approval page, and one line on your server.
//
//   <script src="https://cdn.touchque.com/device/v2.0.0/script.js" data-site-key="tqpk_…" data-purpose="sign_in"
//           integrity="sha384-…" crossorigin="anonymous" async></script>
//
//   const verdict = await tq.deviceRisk.check(req.body.touchque_request_id, { event: 'sign_in', externalUsername });
//
// When the page loads, the tag identifies the browser (deviceRisk.identify)
// and puts the requestId into a hidden `touchque_request_id` field of every
// form on the page, forms added later included. A form's own
// `data-touchque-purpose` attribute wins over the tag's `data-purpose`
// (default sign_in). Touchque accepts an identification for 15 minutes and
// for one account: the tag takes a new one after 10 minutes (when the page
// is visible again, for a tab left open) and a second after each submit (a
// single-page app's next attempt may be another account).
//
// When a form is sent, the tag adds how the pointer and the fingers moved on
// the page to the field, after the requestId and a dot: 18 characters of
// counts (pointerSummary.ts: presses on a pointer that jumped there, how long
// presses and taps lasted, how straight long strokes were), never a position
// or a path. Your server passes the field as it is; Touchque's risk engine
// weighs it (device_pointer_synthetic, only ever a step-up). `data-pointer="off"`
// on the tag leaves it out.
//
// Single-page apps read `window.TouchqueDevice`: `ready` (the first
// identification, or null), `value()` (what to send now: the requestId and
// the pointer summary), `requestId`, `refresh()`, and the `touchque:device`
// event on document after each new identification.
//
// Nothing on the page is trusted: requestIds are made only by Touchque's
// server, used once, bound to your site's origin and to 15 minutes, and your
// server reads the verdict by requestId (the risk engine decides). A page
// without the tag, or with it blocked (ad blockers do that to honest people
// too), sends no requestId: your server's check still answers, with
// device_identification_missing, which only ever asks for a step-up.

import { createDeviceRisk, DEVICE_RISK_PURPOSES } from './deviceRisk';
import type { DeviceRisk, DeviceRiskIdentification, DeviceRiskPurpose } from './deviceRisk';
import { logWarn, errorText, setTouchqueLogger } from './log';
import { startPointerSummary } from './pointerSummary';
import type { PointerSummaryProbe } from './pointerSummary';

/** The hidden form field the tag fills; your server passes it to deviceRisk.check. */
export const REQUEST_ID_FIELD = 'touchque_request_id';
/** A form's own page purpose (sign_in, sign_up, password_reset, approval). */
export const FORM_PURPOSE_ATTRIBUTE = 'data-touchque-purpose';
/** The event on document after each new identification. */
export const DEVICE_EVENT = 'touchque:device';
/** Touchque accepts an identification for 15 minutes: a new one after 10. */
export const REFRESH_AFTER_MS = 10 * 60 * 1000;
/** After a submit, a new identification for the next attempt (a single-page app). */
export const AFTER_SUBMIT_MS = 1000;
export const DEVICE_TAG_VERSION = '2.0.0';

export interface DeviceRiskTagOptions {
  /** Your workspace's public site key (`tqpk_…`, dashboard → Device risk → Settings). */
  siteKey: string;
  /** The page, for forms without `data-touchque-purpose`. Default `sign_in`. */
  purpose?: DeviceRiskPurpose;
  /** Touchque's API, default `https://api.touchque.com`. */
  apiBaseUrl?: string;
  /** Send how the pointer and the fingers moved (counts only). Default true. */
  pointer?: boolean;
}

export interface TouchqueDevice {
  /** The first identification for the page's purpose, or null when Touchque could not be reached or refused (logged to the console). */
  readonly ready: Promise<DeviceRiskIdentification | null>;
  /** The current requestId for the page's purpose; null until ready, or after a failure. */
  readonly requestId: string | null;
  /** The current visitorId for the page's purpose. Never trust it on the page. */
  readonly visitorId: string | null;
  /** What to send to your server now (the form field's value): the requestId, a dot and the pointer summary; null until ready. */
  value(purpose?: DeviceRiskPurpose): string | null;
  /** A new identification now (for the page's purpose, or the one given), and the forms updated. */
  refresh(purpose?: DeviceRiskPurpose): Promise<DeviceRiskIdentification | null>;
  /** Fills forms the tag cannot see (inside a shadow root you own). */
  attach(root: ParentNode): void;
  /** Stops watching the page (tests, a page that unmounts the sign-in). */
  stop(): void;
  readonly version: string;
}

interface Slot {
  current: DeviceRiskIdentification | null;
  at: number;
  pending: Promise<DeviceRiskIdentification | null> | null;
  timer: ReturnType<typeof setTimeout> | null;
  stale: boolean;
}

export interface DeviceRiskTagDeps {
  win?: Window;
  deviceRisk?: Pick<DeviceRisk, 'identify'>;
  now?: () => number;
  pointer?: PointerSummaryProbe | null;
}

const isPurpose = (v: unknown): v is DeviceRiskPurpose => DEVICE_RISK_PURPOSES.includes(v as DeviceRiskPurpose);

/** Starts the tag's work on this page. Never throws. */
export function installDeviceRiskTag(options: DeviceRiskTagOptions, deps: DeviceRiskTagDeps = {}): TouchqueDevice {
  const win = deps.win ?? window;
  const doc = win.document;
  const now = deps.now ?? (() => Date.now());
  const risk = deps.deviceRisk ?? createDeviceRisk(win);
  const pagePurpose: DeviceRiskPurpose = isPurpose(options.purpose) ? options.purpose : 'sign_in';
  const slots = new Map<DeviceRiskPurpose, Slot>();
  const roots = new Set<ParentNode>([doc]);
  let stopped = false;
  let pointer: PointerSummaryProbe | null = null;
  try {
    pointer = deps.pointer !== undefined ? deps.pointer : options.pointer === false ? null : startPointerSummary(doc);
  } catch { /* no pointer summary: the requestId alone */ }
  const valueOf = (purpose: DeviceRiskPurpose): string | null => {
    const id = slots.get(purpose)?.current?.requestId;
    if (!id) return null;
    try { return pointer ? `${id}.${pointer.encode()}` : id; } catch { return id; }
  };

  const slot = (purpose: DeviceRiskPurpose): Slot => {
    let s = slots.get(purpose);
    if (!s) { s = { current: null, at: 0, pending: null, timer: null, stale: false }; slots.set(purpose, s); }
    return s;
  };
  const purposeOf = (form: HTMLFormElement): DeviceRiskPurpose => {
    const own = form.getAttribute(FORM_PURPOSE_ATTRIBUTE);
    return isPurpose(own) ? own : pagePurpose;
  };
  const formsIn = (root: ParentNode): HTMLFormElement[] => {
    const out: HTMLFormElement[] = [];
    if ((root as Element).tagName === 'FORM') out.push(root as HTMLFormElement);
    if (typeof (root as Element).querySelectorAll === 'function') out.push(...Array.from((root as Element).querySelectorAll('form')));
    return out;
  };
  const fieldOf = (form: HTMLFormElement): HTMLInputElement => {
    const existing = Array.from(form.querySelectorAll('input')).find((i) => i.name === REQUEST_ID_FIELD);
    if (existing) return existing;
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = REQUEST_ID_FIELD;
    form.appendChild(input);
    return input;
  };
  const fill = (purpose: DeviceRiskPurpose) => {
    const value = slots.get(purpose)?.current?.requestId ?? '';
    for (const root of roots) for (const form of formsIn(root)) if (purposeOf(form) === purpose) fieldOf(form).value = value;
  };

  const schedule = (purpose: DeviceRiskPurpose) => {
    const s = slot(purpose);
    if (s.timer) clearTimeout(s.timer);
    s.stale = false;
    s.timer = setTimeout(() => {
      s.timer = null;
      // A hidden tab waits: no identifications for a tab nobody looks at.
      if (doc.visibilityState === 'hidden') s.stale = true;
      else void identifyFor(purpose);
    }, REFRESH_AFTER_MS);
  };

  const identifyFor = (purpose: DeviceRiskPurpose): Promise<DeviceRiskIdentification | null> => {
    const s = slot(purpose);
    if (s.pending) return s.pending;
    if (stopped) return Promise.resolve(s.current);
    s.pending = risk.identify({ siteKey: options.siteKey, purpose, apiBaseUrl: options.apiBaseUrl, pageView: true })
      .catch((err: unknown) => {
        // A wrong site key or API address: said once, the page goes on.
        logWarn(`Touchque device.js: ${errorText(err)}`);
        return null;
      })
      .then((id) => {
        s.pending = null;
        if (stopped) return id;
        s.current = id;
        s.at = now();
        fill(purpose);
        if (id) schedule(purpose);
        try {
          doc.dispatchEvent(new CustomEvent(DEVICE_EVENT, { detail: { purpose, requestId: id?.requestId ?? null, visitorId: id?.visitorId ?? null, confidence: id?.confidence ?? null } }));
        } catch { /* no CustomEvent: nothing to tell */ }
        return id;
      });
    return s.pending;
  };

  const scan = (root: ParentNode) => {
    for (const form of formsIn(root)) {
      const purpose = purposeOf(form);
      const field = fieldOf(form);
      const s = slots.get(purpose);
      if (s?.current) field.value = s.current.requestId;
      else void identifyFor(purpose);
    }
  };

  const freshen = () => {
    for (const [purpose, s] of slots) {
      if (s.stale || (s.at && now() - s.at >= REFRESH_AFTER_MS)) void identifyFor(purpose);
    }
  };
  const onVisible = () => { if (doc.visibilityState !== 'hidden') freshen(); };
  const onSubmit = (e: Event) => {
    const form = e.target as HTMLFormElement | null;
    if (!form || form.tagName !== 'FORM') return;
    const purpose = purposeOf(form);
    // Before the browser reads the form (this listener runs first, on capture).
    const value = valueOf(purpose);
    if (value) fieldOf(form).value = value;
    // The submitted form already holds its value; the next attempt gets a new one.
    setTimeout(() => { if (!stopped) void identifyFor(purpose); }, AFTER_SUBMIT_MS);
  };
  const Observer = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const observer = typeof Observer === 'function'
    ? new Observer((records: MutationRecord[]) => {
      for (const r of records) for (const node of Array.from(r.addedNodes)) if (node.nodeType === 1) scan(node as Element);
    })
    : null;

  const ready = identifyFor(pagePurpose);
  try {
    observer?.observe(doc.documentElement, { childList: true, subtree: true });
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('visibilitychange', onVisible);
    doc.addEventListener('focusin', freshen);
    scan(doc);
    // An async tag can run before the parser reached the forms.
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => scan(doc), { once: true });
  } catch { /* a page without a DOM to watch: ready still answers */ }

  return {
    ready,
    get requestId() { return slots.get(pagePurpose)?.current?.requestId ?? null; },
    get visitorId() { return slots.get(pagePurpose)?.current?.visitorId ?? null; },
    value: (purpose) => valueOf(isPurpose(purpose) ? purpose : pagePurpose),
    refresh: (purpose) => identifyFor(isPurpose(purpose) ? purpose : pagePurpose),
    attach(root) { roots.add(root); scan(root); },
    stop() {
      stopped = true;
      observer?.disconnect();
      doc.removeEventListener('submit', onSubmit, true);
      doc.removeEventListener('visibilitychange', onVisible);
      doc.removeEventListener('focusin', freshen);
      for (const s of slots.values()) if (s.timer) clearTimeout(s.timer);
      pointer?.stop();
    },
    version: DEVICE_TAG_VERSION,
  };
}

/** The tag's own start: reads data-site-key, data-purpose, data-api and data-pointer from its script element. */
export function installFromScript(script: HTMLScriptElement | null, win: Window = window): TouchqueDevice {
  const w = win as Window & { TouchqueDevice?: TouchqueDevice };
  if (w.TouchqueDevice) return w.TouchqueDevice; // the tag twice on one page
  const el = script ?? win.document.querySelector<HTMLScriptElement>('script[data-site-key]');
  const siteKey = el?.getAttribute('data-site-key') || '';
  const purpose = el?.getAttribute('data-purpose') || undefined;
  const apiBaseUrl = el?.getAttribute('data-api') || undefined;
  const pointer = el?.getAttribute('data-pointer') !== 'off';
  if (el?.hasAttribute('data-debug') && typeof console !== 'undefined') setTouchqueLogger(console);
  const device = siteKey
    ? installDeviceRiskTag({ siteKey, purpose: purpose as DeviceRiskPurpose | undefined, apiBaseUrl, pointer }, { win })
    : unconfigured();
  w.TouchqueDevice = device;
  return device;
}

function unconfigured(): TouchqueDevice {
  logWarn('Touchque device.js: data-site-key is missing on the script tag (dashboard → Device risk → Settings).');
  return {
    ready: Promise.resolve(null),
    requestId: null,
    visitorId: null,
    value: () => null,
    refresh: () => Promise.resolve(null),
    attach: () => {},
    stop: () => {},
    version: DEVICE_TAG_VERSION,
  };
}
