// src/pointerSummary.ts
// How the pointer and the fingers moved on this page, as a few numbers. Is a
// hand moving them, or software (Playwright, Puppeteer, Selenium, a
// CDP-driven browser, an AI browser agent) that jumps the pointer onto a
// button and presses it for no time, taps for no time, or moves along
// ruler-straight lines?
//
// Only counts, milliseconds and how far a stroke strays from a straight line,
// computed here: never a position, a path, what was pressed or typed, and
// nothing that tells one person from another. The Device risk tag sends it
// with the form (after the requestId), startClientSignals inside its
// signals; TouchQue's risk engine weighs it (device_pointer_synthetic). It
// only ever asks for a step-up, and only when there was movement and it
// looked made: no movement at all (a keyboard, a screen reader) is never a
// sign. Voice Control and Switch Control jump the pointer and press like
// software: they get the step-up too, never a refusal.

export interface PointerSummary {
  v: 1;
  /** Presses with the main button of a mouse or a pen. */
  p: number;
  /** Of those, presses the pointer jumped onto: at most one move in the 500 ms before, from 30 px or more away or from nowhere. */
  pt: number;
  /** The longest of those jumped presses, down to up (ms); null without one, or when the browser's clock is coarse. */
  pth: number | null;
  /** Long mouse or pen strokes: 300 px or more, 10 samples or more, not along an axis. */
  ls: number;
  /** The smallest of their largest distances from a straight line (px). */
  lsd: number | null;
  /** Taps: one finger that moved under 10 px. */
  t: number;
  /** The longest tap (ms); null without one, or when the browser's clock is coarse. */
  th: number | null;
  /** Long swipes: one finger, 300 px or more, 10 samples or more. */
  sw: number;
  /** The smallest of their largest distances from a straight line (px). */
  swd: number | null;
  /** Mouse and pen moves seen. */
  mv: number;
  /** Touch moves seen. */
  tm: number;
}

export interface PointerSummaryProbe {
  summary(): PointerSummary;
  /** 18 characters (encodePointerSummary), sent after the requestId and a dot. */
  encode(): string;
  stop(): void;
}

const JUMP_WINDOW_MS = 500;
const JUMP_PX = 30;
const STROKE_GAP_MS = 150;
const LONG_PX = 300;
const LONG_SAMPLES = 10;
const TAP_PX = 10;
// Strokes within 3° of an axis are left out: a mouse slid along a desk edge
// can keep its other coordinate still.
const AXIS = Math.tan((3 * Math.PI) / 180);
const KEEP = 64;
const MAX_SAMPLES = 2000;

interface Sample { x: number; y: number; t: number }

/** The path's length, and the largest distance of a sample from the line through the first and the last (px). */
export function lineFit(samples: readonly Sample[]): { length: number; deviation: number; dx: number; dy: number } {
  if (samples.length < 2) return { length: 0, deviation: 0, dx: 0, dy: 0 };
  const a = samples[0];
  const b = samples[samples.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  let length = 0;
  let deviation = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const s = samples[i];
    length += Math.hypot(s.x - samples[i - 1].x, s.y - samples[i - 1].y);
    const d = chord > 0 ? Math.abs(dy * (s.x - a.x) - dx * (s.y - a.y)) / chord : Math.hypot(s.x - a.x, s.y - a.y);
    if (d > deviation) deviation = d;
  }
  return { length, deviation, dx, dy };
}

const nearAxis = (dx: number, dy: number) => Math.min(Math.abs(dx), Math.abs(dy)) <= AXIS * Math.max(Math.abs(dx), Math.abs(dy));
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const smaller = (a: number | null, b: number) => (a === null ? b : Math.min(a, b));
const larger = (a: number | null, b: number) => (a === null ? b : Math.max(a, b));

/** A clock that only moves in steps of 5 ms or more (Tor Browser, resistFingerprinting): press times mean nothing. */
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

export interface PointerSummaryDeps {
  /** Which events came from the person's own hardware (tests). Default: `isTrusted`. */
  trusted?: (e: Event) => boolean;
}

/** Starts watching the pointer and the fingers on `root` (default: the document). */
export function startPointerSummary(root: Document | HTMLElement = document, deps: PointerSummaryDeps = {}): PointerSummaryProbe {
  const doc = root instanceof Document ? root : root.ownerDocument;
  // Events made by script on the page (a password manager's fill included) are startClientSignals' business.
  const trusted = deps.trusted ?? ((e: Event) => e.isTrusted);
  const perf = doc.defaultView?.performance;
  const coarse = clockIsCoarse(perf);
  let mv = 0;
  let tm = 0;
  let p = 0;
  let pt = 0;
  let ls = 0;
  let lsd: number | null = null;
  let t = 0;
  let th: number | null = null;
  let sw = 0;
  let swd: number | null = null;
  let stroke: Sample[] = [];
  const moves: Sample[] = [];
  let lastDown = -Infinity;
  const jumped: Array<{ id: number; down: number; up: number | null }> = [];
  let finger: { id: number; start: number; samples: Sample[]; far: number } | null = null;

  const longStroke = (samples: Sample[]) => {
    if (samples.length < LONG_SAMPLES) return null;
    const f = lineFit(samples);
    return f.length >= LONG_PX && !nearAxis(f.dx, f.dy) ? f.deviation : null;
  };
  const endStroke = () => {
    const d = longStroke(stroke);
    if (d !== null) { ls += 1; lsd = smaller(lsd, d); }
    stroke = [];
  };
  const isPointer = (e: PointerEvent) => trusted(e) && (e.pointerType === 'mouse' || e.pointerType === 'pen');

  const onMove = (e: PointerEvent) => {
    if (!isPointer(e)) return;
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of coalesced.length ? coalesced : [e]) {
      const s = { x: c.clientX, y: c.clientY, t: c.timeStamp };
      const last = stroke[stroke.length - 1];
      if ((last && s.t - last.t > STROKE_GAP_MS) || stroke.length >= MAX_SAMPLES) endStroke();
      stroke.push(s);
      moves.push(s);
      if (moves.length > KEEP) moves.shift();
      mv += 1;
    }
  };
  const onDown = (e: PointerEvent) => {
    if (!isPointer(e) || e.button !== 0) return;
    endStroke();
    p += 1;
    const at = e.timeStamp;
    // The moves since the last press, within 500 ms; the pointer's place before them.
    const from = Math.max(at - JUMP_WINDOW_MS, lastDown);
    const recent = moves.filter((m) => m.t > from);
    let before: Sample | null = null;
    for (let i = moves.length - 1; i >= 0; i -= 1) if (moves[i].t <= from) { before = moves[i]; break; }
    lastDown = at;
    // The press is where the pointer is now (not a move: mv leaves it out).
    moves.push({ x: e.clientX, y: e.clientY, t: at });
    if (moves.length > KEEP) moves.shift();
    // A hand brings the pointer over in many small moves; a driver sends one, or none.
    if (recent.length <= 1 && (!before || Math.hypot(e.clientX - before.x, e.clientY - before.y) >= JUMP_PX)) {
      pt += 1;
      jumped.push({ id: e.pointerId, down: at, up: null });
      if (jumped.length > KEEP) jumped.shift();
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!isPointer(e)) return;
    for (let i = jumped.length - 1; i >= 0; i -= 1) {
      if (jumped[i].id === e.pointerId && jumped[i].up === null) { jumped[i].up = e.timeStamp; break; }
    }
  };

  const onTouchStart = (e: TouchEvent) => {
    if (!trusted(e)) return;
    const c = e.changedTouches[0];
    // One finger only: a pinch or a second finger is not a tap or a swipe.
    finger = e.touches.length === 1 && c ? { id: c.identifier, start: e.timeStamp, samples: [{ x: c.clientX, y: c.clientY, t: e.timeStamp }], far: 0 } : null;
  };
  const track = (e: TouchEvent) => {
    if (!finger) return null;
    const c = Array.from(e.changedTouches).find((x) => x.identifier === finger!.id);
    if (!c) return null;
    const first = finger.samples[0];
    if (finger.samples.length < MAX_SAMPLES) finger.samples.push({ x: c.clientX, y: c.clientY, t: e.timeStamp });
    finger.far = Math.max(finger.far, Math.hypot(c.clientX - first.x, c.clientY - first.y));
    return finger;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!trusted(e)) return;
    tm += 1;
    track(e);
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (!trusted(e)) return;
    const done = track(e);
    if (!done) return;
    finger = null;
    if (done.far < TAP_PX) {
      t += 1;
      th = larger(th, e.timeStamp - done.start);
      return;
    }
    if (done.samples.length >= LONG_SAMPLES) {
      const f = lineFit(done.samples);
      if (f.length >= LONG_PX) { sw += 1; swd = smaller(swd, f.deviation); }
    }
  };
  const onTouchCancel = () => { finger = null; };

  const opts = { capture: true, passive: true } as AddEventListenerOptions;
  const listeners: Array<[string, EventListener]> = [
    ['pointermove', onMove as EventListener], ['pointerdown', onDown as EventListener], ['pointerup', onUp as EventListener],
    ['touchstart', onTouchStart as EventListener], ['touchmove', onTouchMove as EventListener],
    ['touchend', onTouchEnd as EventListener], ['touchcancel', onTouchCancel],
  ];
  for (const [type, fn] of listeners) root.addEventListener(type, fn, opts);

  const summary = (): PointerSummary => {
    const now = perf ? perf.now() : 0;
    let pth: number | null = null;
    // A press still held counts as long as it has been held so far.
    for (const j of jumped) pth = larger(pth, (j.up ?? now) - j.down);
    const current = longStroke(stroke);
    return {
      v: 1,
      p,
      pt,
      pth: coarse ? null : round1(pth),
      ls: ls + (current === null ? 0 : 1),
      lsd: round1(current === null ? lsd : smaller(lsd, current)),
      t,
      th: coarse ? null : round1(th),
      sw,
      swd: round1(swd),
      mv,
      tm,
    };
  };

  return {
    summary,
    encode: () => encodePointerSummary(summary()),
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
 * The summary in 18 characters (base64url digits), to fit after the
 * requestId in a form field that servers cut at 64 characters: version 1,
 * then p, pt, pth, ls, lsd×10, t, th, sw, swd×10, mv, tm. Counts stop at 63
 * (pt below p stays below it), times and moves at 4094; `__` is none.
 */
export function encodePointerSummary(s: PointerSummary): string {
  const pt = s.pt >= s.p ? one(s.p) : one(Math.min(s.pt, 62));
  return `1${one(s.p)}${pt}${two(s.pth)}${one(s.ls)}${two(s.lsd === null ? null : s.lsd * 10)}${one(s.t)}${two(s.th)}`
    + `${one(s.sw)}${two(s.swd === null ? null : s.swd * 10)}${two(s.mv)}${two(s.tm)}`;
}
