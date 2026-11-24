// src/inputSummary.ts
// How the page was typed into and clicked, as a few numbers: is a person at
// the keyboard, a script (Selenium, Playwright, Puppeteer, a CDP-driven
// browser), or an AI browser agent that looks at the screen, thinks for a few
// seconds, then acts? Next to the pointer summary (pointerSummary.ts), the
// Device risk tag sends it with the form, after the requestId, the pointer
// summary and a second dot (inside the 64 characters every server SDK passes
// on).
//
// Only counts and milliseconds, computed here: never a key, a character, a
// field, what was typed or where on the page. What it counts:
//   - key presses (trusted keydowns of a character), and text that arrived
//     with no key press at all (Playwright's fill, CDP Input.insertText, an
//     agent's typing; voice dictation does it too), and pastes;
//   - how even the time between key presses is (a script types at one pace)
//     and how long keys are held (a driver presses and lets go at once);
//   - mouse presses that landed exactly on the middle of what was pressed
//     (Playwright's and Puppeteer's click() aim there; a hand almost never
//     does, within one pixel);
//   - the actions (a press, the start of a burst of typing) and how many of
//     them came after a pause of 1.5 to 20 seconds: an agent takes a screenshot
//     and thinks before every step; a person fills a sign-in form in a flow.
// Autofill and password managers (no trusted key, but a replacement, not an
// insertion), IME composition and untrusted events (made by script on the
// page) are left out. Touchque's risk engine weighs it (device_input_synthetic,
// only ever a step-up); the dashboard names the kind of bot it points to.

export interface InputSummary {
  /** Version. */
  v: 1;
  /** Trusted key presses of a character. */
  kd: number;
  /** Text insertions with no key press just before them. */
  nk: number;
  /** Pastes. */
  pa: number;
  /** Intervals between key presses within a burst. */
  kn: number;
  /** Their mean (ms; null when none or the clock is coarse). */
  km: number | null;
  /** Their standard deviation (ms; null as km). */
  ks: number | null;
  /** How long keys were held, on average (ms; null as km). */
  hm: number | null;
  /** Mouse or pen presses on an element of at least 8 px. */
  cp: number;
  /** Of those, presses within 1 px of the element's middle. */
  cc: number;
  /** Actions: presses, and the start of each burst of typing. */
  ac: number;
  /** Actions after a pause of 1.5 to 20 seconds. */
  lg: number;
  /** The median pause between actions (ms; null with fewer than two actions). */
  gm: number | null;
}

export interface InputSummaryProbe {
  summary(): InputSummary;
  /** 17 characters (encodeInputSummary), sent after the pointer summary and a dot. */
  encode(): string;
  stop(): void;
}

export interface InputSummaryDeps {
  /** Which events came from the person's own hardware (tests). Default: `isTrusted`. */
  trusted?: (e: Event) => boolean;
}

const BURST_GAP_MS = 1500;
const LONG_GAP_MS = 1500;
const LONG_GAP_MAX_MS = 20000;
const KEY_NEAR_MS = 150;
const CENTER_PX = 1;
const MIN_TARGET_PX = 8;
const KEEP = 200;

/** A clock that only moves in steps of 5 ms or more: times mean nothing. */
function clockIsCoarse(perf: Performance | undefined): boolean {
  try {
    if (!perf) return true;
    const a = perf.now();
    let b = a;
    for (let i = 0; i < 100000 && b === a; i += 1) b = perf.now();
    return b === a || b - a >= 5;
  } catch {
    return true;
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function stddev(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null) return null;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Starts watching key presses, text input and presses on `root` (default: the document). */
export function startInputSummary(root: Document | HTMLElement = document, deps: InputSummaryDeps = {}): InputSummaryProbe {
  const doc = root instanceof Document ? root : root.ownerDocument;
  const trusted = deps.trusted ?? ((e: Event) => e.isTrusted);
  const perf = doc.defaultView?.performance;
  const coarse = clockIsCoarse(perf);
  let kd = 0;
  let nk = 0;
  let pa = 0;
  let cp = 0;
  let cc = 0;
  let lastKey = -Infinity;
  let lastAction = -Infinity;
  const intervals: number[] = [];
  const holds: number[] = [];
  const down = new Map<string, number>();
  const actions: number[] = [];

  const action = (at: number) => {
    actions.push(at);
    if (actions.length > KEEP) actions.shift();
    lastAction = at;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!trusted(e) || e.repeat || typeof e.key !== 'string' || e.key.length !== 1) return;
    const at = e.timeStamp;
    kd += 1;
    if (at - lastKey < BURST_GAP_MS) {
      intervals.push(at - lastKey);
      if (intervals.length > KEEP) intervals.shift();
    } else if (at - lastAction >= BURST_GAP_MS || lastAction === -Infinity) {
      action(at);
    }
    lastKey = at;
    down.set(e.code || e.key, at);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!trusted(e)) return;
    const k = e.code || e.key;
    const at = down.get(k);
    if (at === undefined) return;
    down.delete(k);
    holds.push(e.timeStamp - at);
    if (holds.length > KEEP) holds.shift();
  };
  const onInput = (e: Event) => {
    if (!trusted(e)) return;
    const ie = e as InputEvent;
    const type = typeof ie.inputType === 'string' ? ie.inputType : '';
    if (type === 'insertFromPaste' || type === 'insertFromDrop') { pa += 1; return; }
    // Only typed insertions: autofill replaces, an IME composes, a deletion is no text.
    if (type !== 'insertText' || ie.isComposing) return;
    const at = e.timeStamp;
    if (at - lastKey > KEY_NEAR_MS) {
      nk += 1;
      if (at - lastAction >= BURST_GAP_MS) action(at);
    }
  };
  const onPaste = (e: Event) => { if (trusted(e) && !(e.target instanceof Element && e.target.closest('input,textarea,[contenteditable]'))) pa += 1; };
  const onDown = (e: PointerEvent) => {
    if (!trusted(e) || e.button !== 0) return;
    action(e.timeStamp);
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < MIN_TARGET_PX || r.height < MIN_TARGET_PX) return;
      cp += 1;
      if (Math.abs(e.clientX - (r.left + r.width / 2)) <= CENTER_PX && Math.abs(e.clientY - (r.top + r.height / 2)) <= CENTER_PX) cc += 1;
    } catch { /* no box */ }
  };

  const opts = { capture: true, passive: true } as AddEventListenerOptions;
  const listeners: Array<[string, EventListener]> = [
    ['keydown', onKeyDown as EventListener], ['keyup', onKeyUp as EventListener], ['input', onInput],
    ['paste', onPaste], ['pointerdown', onDown as EventListener],
  ];
  for (const [type, fn] of listeners) root.addEventListener(type, fn, opts);

  const summary = (): InputSummary => {
    const gaps: number[] = [];
    for (let i = 1; i < actions.length; i += 1) gaps.push(actions[i] - actions[i - 1]);
    const lg = gaps.filter((g) => g >= LONG_GAP_MS && g <= LONG_GAP_MAX_MS).length;
    const r = (n: number | null) => (n === null ? null : Math.round(n));
    return {
      v: 1,
      kd,
      nk,
      pa,
      kn: intervals.length,
      km: coarse ? null : r(mean(intervals)),
      ks: coarse ? null : r(stddev(intervals)),
      hm: coarse ? null : r(mean(holds)),
      cp,
      cc,
      ac: actions.length,
      lg,
      gm: coarse ? null : r(median(gaps)),
    };
  };

  return {
    summary,
    encode: () => encodeInputSummary(summary()),
    stop() { for (const [type, fn] of listeners) root.removeEventListener(type, fn, opts); },
  };
}

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NONE = 4095;
const one = (n: number) => DIGITS[Math.max(0, Math.min(63, Math.floor(n)))];
const two = (n: number | null) => {
  const v = n === null ? NONE : Math.max(0, Math.min(NONE - 1, Math.round(n)));
  return DIGITS[v >> 6] + DIGITS[v & 63];
};

/**
 * The summary in 17 characters (base64url digits): version 1, then kd, nk, pa,
 * kn, km, ks, hm, cp, cc, ac, lg, gm÷100. Counts stop at 63 (cc never above
 * cp, lg never above ac), times at 4094 ms (gm at 409.4 s); `__` is none.
 */
export function encodeInputSummary(s: InputSummary): string {
  const cp = Math.min(s.cp, 63);
  const ac = Math.min(s.ac, 63);
  return `1${one(s.kd)}${one(s.nk)}${one(s.pa)}${one(s.kn)}${two(s.km)}${two(s.ks)}${two(s.hm)}`
    + `${one(cp)}${one(Math.min(s.cc, cp))}${one(ac)}${one(Math.min(s.lg, ac))}${two(s.gm === null ? null : s.gm / 100)}`;
}
