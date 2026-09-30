// Offline Sign for the browser — approvals that work while the user's PHONE has
// no internet. Talks to the partner's own relay (never TouchQue directly);
// pairs with `touchqueRouter` from `@touchque/node` (>= 1.7.0) with zero config.
//
// Flow: `challenge()` → show the QR (`renderQr`) → the user scans it with the
// TouchQue app (offline), approves with Face ID and reads a 7-character code →
// `verify()`. Optionally `verifyTotp()` for the "no camera" fallback (only
// when `totpAvailable`).

import type { RelayHttp } from './http';
import { TouchQueWebAPIError } from './errors';

export interface OfflineSignPaths {
  /** POST — body `{ externalUsername }`; returns the challenge + QR. */
  offlineChallenge: string;
  /** POST — body `{ challengeId, code }`. */
  offlineVerify: string;
  /** POST — body `{ externalUsername, code }` (time-based fallback). */
  offlineTotp: string;
}

export interface OfflineChallenge {
  challengeId: string;
  /** Raw QR text (`TQ2.…`): encrypted for the user's phone, not readable by anything else. */
  qr: string;
  /** `data:image/png;base64,…` — render with `renderQr()` or set it as an `<img>` src. */
  qrDataUrl: string | null;
  expiresAt: string;
  expiresInSeconds: number;
  /** `true` when the "type the time-based code instead" fallback is enabled. */
  totpAvailable: boolean;
  /**
   * Number matching: print this under the QR. After scanning, the phone shows three numbers (this one
   * and two decoys) and the user taps the one that matches the page. Absent when no number matching applies.
   */
  challengeCode?: string;
}

export interface OfflineVerifyResult {
  approved: boolean;
  /** When not approved: `invalid_code`, `locked`, `expired`, `used`, `request_rejected` (the phone rejected this sign-in), `too_many_failures`, … */
  reason?: string;
  attemptsLeft?: number;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Upper-cases and strips spaces/dashes; returns null unless it is exactly 7 valid characters. */
export function normalizeOfflineCode(input: string): string | null {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 7) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** "ABC-DEFG" while the user is typing (drops invalid characters, caps at 7). */
export function formatOfflineCodeInput(input: string): string {
  const s = String(input ?? '').toUpperCase().replace(/[^A-Z2-9]/g, '').replace(/[IO]/g, '').slice(0, 7);
  return s.length > 3 ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}

/** Statuses the relay uses for "not approved" (as opposed to something broke). */
const NOT_APPROVED = [400, 401, 403, 404, 409, 410, 423, 429];

export class OfflineSign {
  constructor(
    private readonly http: RelayHttp,
    private readonly paths: OfflineSignPaths,
  ) {}

  /** Ask your backend for a challenge for this user. */
  /** `externalUsername` is optional: the server ignores it when its router binds the flow to your password step (`getLoginUser`). */
  /**
   * `requestId` is the push this QR is a fallback for: once the phone REJECTS it the QR is dead (no new QR is issued,
   * a code for the old one is refused with `request_rejected`), and a push with number matching makes the QR show the same number.
   */
  async challenge(input: { externalUsername?: string; requestId?: string } = {}): Promise<OfflineChallenge> {
    return this.http.post<OfflineChallenge>(this.paths.offlineChallenge, {
      ...(input.externalUsername && { externalUsername: input.externalUsername }),
      ...(input.requestId && { requestId: input.requestId }),
    });
  }

  /** Check the code the user typed. Wrong / expired / locked codes resolve `{ approved:false, reason }`. */
  async verify(input: { challengeId: string; code: string }): Promise<OfflineVerifyResult> {
    return this.asResult(() => this.http.post<OfflineVerifyResult>(this.paths.offlineVerify, { challengeId: input.challengeId, code: input.code }));
  }

  /** Time-based fallback: check a code typed straight from the app (only when `totpAvailable`). */
  async verifyTotp(input: { externalUsername?: string; code: string; requestId?: string }): Promise<OfflineVerifyResult> {
    const body = { ...(input.externalUsername && { externalUsername: input.externalUsername }), code: input.code, ...(input.requestId && { requestId: input.requestId }) };
    return this.asResult(() => this.http.post<OfflineVerifyResult>(this.paths.offlineTotp, body));
  }

  /**
   * Draw the QR into `target` (a selector or element) as an `<img>`. Returns a
   * handle: `remove()` clears it. Throws if the challenge has no image.
   */
  renderQr(target: string | Element, challenge: OfflineChallenge, options: { alt?: string; size?: number } = {}): { remove(): void } {
    const container = typeof target === 'string' ? document.querySelector(target) : target;
    if (!container) throw new Error('renderQr: container not found');
    if (!challenge.qrDataUrl) throw new Error('renderQr: the challenge has no qrDataUrl');
    // Only an inline PNG: a relay must not be able to point the image at an arbitrary (tracking) URL.
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(challenge.qrDataUrl)) throw new Error('renderQr: qrDataUrl must be a PNG data URL');
    const img = document.createElement('img');
    img.src = challenge.qrDataUrl;
    img.alt = options.alt ?? 'TouchQue offline sign QR code';
    img.width = options.size ?? 280;
    img.height = options.size ?? 280;
    img.style.imageRendering = 'pixelated'; // keep the modules sharp when scaled
    container.replaceChildren(img);
    return { remove: () => img.remove() };
  }

  /**
   * Calls `onTick(secondsLeft)` every second until the challenge expires, then
   * once with 0. Returns a `stop()` function. Uses the SERVER's `expiresInSeconds`
   * from when you called `challenge()` (not the browser clock), so a wrong PC
   * clock can't show a stale countdown.
   */
  countdown(challenge: OfflineChallenge, onTick: (secondsLeft: number) => void): () => void {
    const startedAt = Date.now();
    const tick = () => {
      const left = Math.max(0, challenge.expiresInSeconds - Math.floor((Date.now() - startedAt) / 1000));
      onTick(left);
      if (left === 0) stop();
    };
    const timer = setInterval(tick, 1000);
    const stop = () => clearInterval(timer);
    tick();
    return stop;
  }

  private async asResult(call: () => Promise<OfflineVerifyResult>): Promise<OfflineVerifyResult> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof TouchQueWebAPIError && NOT_APPROVED.includes(error.status)) {
        const body = (error.body ?? {}) as { reason?: string; error?: string; attemptsLeft?: number };
        return { approved: false, reason: body.reason ?? body.error ?? 'not_approved', attemptsLeft: body.attemptsLeft };
      }
      throw error;
    }
  }
}
