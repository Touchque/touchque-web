// The browser SDK's own problems: identify could not reach TouchQue, a script tag without
// its site key, telemetry that did not start. Silent by default: nothing goes to the console
// unless you pass a logger (setTouchQueLogger(console) while you integrate) or put data-debug
// on the device.js script tag.

/** What the SDK logs through: `console`, or anything with `warn`. */
export interface TouchQueWebLogger {
  warn(message: string): void;
}

let current: TouchQueWebLogger | null = null;

/** Where the SDK reports its own problems; `null` (the default) logs nothing. */
export function setTouchQueLogger(logger: TouchQueWebLogger | null): void {
  current = logger;
}

/** @internal One of the SDK's own problems; a logger that throws never breaks the page. */
export function logWarn(message: string): void {
  try {
    current?.warn(message);
  } catch {
    // never break the page
  }
}

/** @internal `message` of an error for a log line, never the object. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
}
