// Framework-agnostic behavioral biometrics tracker (mouse movement + click +
// keystroke timing dynamics), scoped strictly to a caller-supplied container
// element — never `window` / `document`. No key or character is ever
// captured, only inter-keystroke timing gaps.

export interface BehavioralMetrics {
  mouseDistance: number;
  mouseJitter: number;
  clicks: number;
  keystrokes: number;
  keystrokeSpeedAvg: number;
}

export interface BehavioralTrackerOptions {
  /** Interval (ms) at which `onSample` fires. Default 1000. */
  sampleIntervalMs?: number;
  /** Inter-keystroke gaps longer than this (ms) are ignored. Default 2000. */
  keystrokeMaxGapMs?: number;
  /** Called every `sampleIntervalMs` with the current metrics. */
  onSample?: (metrics: BehavioralMetrics) => void;
}

export interface BehavioralTracker {
  start(): void;
  stop(): void;
  reset(): void;
  getMetrics(): BehavioralMetrics;
}

export function createBehavioralTracker(
  containerEl: Element,
  opts: BehavioralTrackerOptions = {},
): BehavioralTracker {
  const sampleIntervalMs = opts.sampleIntervalMs || 1000;
  const keystrokeMaxGapMs = opts.keystrokeMaxGapMs || 2000;

  let running = false;
  let distance = 0;
  let jitterCount = 0;
  let clickCount = 0;
  let lastPos = { x: 0, y: 0 };
  // Previous movement vector, used to detect direction reversals (see
  // handleMouseMove below). `null` until the first real step is seen.
  let prevDelta: { dx: number; dy: number } | null = null;
  let lastKeyTime: number | null = null;
  let keyIntervals: number[] = [];
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function handleMouseMove(e: Event): void {
    const { clientX, clientY } = e as MouseEvent;
    if (lastPos.x !== 0 && lastPos.y !== 0) {
      const dx = clientX - lastPos.x;
      const dy = clientY - lastPos.y;
      distance += Math.sqrt(dx * dx + dy * dy);
      // Jitter = a genuine reversal in direction between this step and the
      // last one (sign flip on either axis), not a property of a single
      // step's own dx/dy ratio. A straight line — horizontal, vertical, or
      // diagonal — never reverses direction, so it now correctly reads as
      // low/zero jitter; real hand tremor is characterized by frequent
      // small reversals, which this catches regardless of the line's angle.
      // (Previously `Math.abs(dx/dy) > 0.1` flagged a smooth diagonal drag
      // as "jitter" on nearly every step while missing genuine micro
      // wobble.) The risk engine treats jitter===0 + long distance as
      // bot-like linear movement and jitter>5 as a human signal, so this
      // metric must reflect real erraticism.
      if (dx !== 0 || dy !== 0) {
        if (
          prevDelta &&
          ((dx !== 0 && prevDelta.dx !== 0 && Math.sign(dx) !== Math.sign(prevDelta.dx)) ||
            (dy !== 0 && prevDelta.dy !== 0 && Math.sign(dy) !== Math.sign(prevDelta.dy)))
        ) {
          jitterCount += 1;
        }
        prevDelta = { dx, dy };
      }
    }
    lastPos = { x: clientX, y: clientY };
  }

  function handleClick(): void {
    clickCount += 1;
  }

  function handleKeyDown(): void {
    const now = Date.now();
    if (lastKeyTime !== null) {
      const diff = now - lastKeyTime;
      if (diff < keystrokeMaxGapMs) {
        keyIntervals.push(diff);
      }
    }
    lastKeyTime = now;
  }

  function getMetrics(): BehavioralMetrics {
    const avgSpeed = keyIntervals.length
      ? keyIntervals.reduce((a, b) => a + b, 0) / keyIntervals.length
      : 0;
    return {
      mouseDistance: Math.floor(distance),
      mouseJitter: jitterCount,
      clicks: clickCount,
      keystrokes: keyIntervals.length,
      keystrokeSpeedAvg: Math.floor(avgSpeed),
    };
  }

  function start(): void {
    if (running || !containerEl) return;
    running = true;
    containerEl.addEventListener('mousemove', handleMouseMove);
    containerEl.addEventListener('click', handleClick);
    containerEl.addEventListener('keydown', handleKeyDown);
    intervalHandle = setInterval(() => {
      if (typeof opts.onSample === 'function') opts.onSample(getMetrics());
    }, sampleIntervalMs);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    containerEl.removeEventListener('mousemove', handleMouseMove);
    containerEl.removeEventListener('click', handleClick);
    containerEl.removeEventListener('keydown', handleKeyDown);
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = null;
  }

  function reset(): void {
    distance = 0;
    jitterCount = 0;
    clickCount = 0;
    keyIntervals = [];
    lastPos = { x: 0, y: 0 };
    prevDelta = null;
    lastKeyTime = null;
  }

  return { start, stop, reset, getMetrics };
}
