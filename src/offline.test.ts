import { describe, test, expect, vi, beforeEach } from 'vitest';
import { OfflineSign, normalizeOfflineCode, formatOfflineCodeInput } from './offline';
import { TouchQueWebAPIError } from './errors';
import type { RelayHttp } from './http';

const paths = { offlineChallenge: '/offline/challenge', offlineVerify: '/offline/verify', offlineTotp: '/offline/totp' };
const fakeHttp = () => ({ post: vi.fn(), get: vi.fn(), delete: vi.fn() }) as unknown as RelayHttp;
const challenge = { challengeId: 'c1', qr: 'TQ1.a.b', qrDataUrl: 'data:image/png;base64,AAAA', expiresAt: 't', expiresInSeconds: 3, totpAvailable: true };

describe('OfflineSign', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="qr"></div>'; });

  test('challenge/verify/verifyTotp post to the configured relay paths', async () => {
    const http = fakeHttp();
    (http.post as any).mockResolvedValue({ approved: true });
    const o = new OfflineSign(http, paths);
    await o.challenge({ externalUsername: 'a@b.com' });
    await o.verify({ challengeId: 'c1', code: 'ABC-DEFG' });
    await o.verifyTotp({ externalUsername: 'a@b.com', code: 'ABCDEFG' });
    expect(http.post).toHaveBeenNthCalledWith(1, '/offline/challenge', { externalUsername: 'a@b.com' });
    expect(http.post).toHaveBeenNthCalledWith(2, '/offline/verify', { challengeId: 'c1', code: 'ABC-DEFG' });
    expect(http.post).toHaveBeenNthCalledWith(3, '/offline/totp', { externalUsername: 'a@b.com', code: 'ABCDEFG' });
  });

  test('challenge/verifyTotp carry the push request id, and the number for the page comes back', async () => {
    const http = fakeHttp();
    const o = new OfflineSign(http, paths);
    (http.post as any).mockResolvedValueOnce({ ...challenge, challengeCode: '47' });
    const ch = await o.challenge({ requestId: 'req-1' });
    expect(http.post).toHaveBeenLastCalledWith('/offline/challenge', { requestId: 'req-1' });
    expect(ch.challengeCode).toBe('47');
    (http.post as any).mockResolvedValueOnce({ approved: true });
    await o.verifyTotp({ code: 'ABCDEFG', requestId: 'req-1' });
    expect(http.post).toHaveBeenLastCalledWith('/offline/totp', { code: 'ABCDEFG', requestId: 'req-1' });
  });

  test('a wrong code resolves { approved:false, reason, attemptsLeft } instead of throwing; real errors still throw', async () => {
    const http = fakeHttp();
    const o = new OfflineSign(http, paths);
    (http.post as any).mockRejectedValueOnce(new TouchQueWebAPIError(401, { approved: false, reason: 'invalid_code', attemptsLeft: 4 }));
    expect(await o.verify({ challengeId: 'c1', code: 'AAAAAAA' })).toEqual({ approved: false, reason: 'invalid_code', attemptsLeft: 4 });
    (http.post as any).mockRejectedValueOnce(new TouchQueWebAPIError(500, { error: 'boom' }));
    await expect(o.verify({ challengeId: 'c1', code: 'AAAAAAA' })).rejects.toBeInstanceOf(TouchQueWebAPIError);
    (http.post as any).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(o.verify({ challengeId: 'c1', code: 'AAAAAAA' })).rejects.toThrow('Failed to fetch');
  });

  test('renderQr draws the server-made PNG into the container and can be removed', () => {
    const o = new OfflineSign(fakeHttp(), paths);
    const handle = o.renderQr('#qr', challenge, { size: 200 });
    const img = document.querySelector('#qr img') as HTMLImageElement;
    expect(img.src).toBe(challenge.qrDataUrl);
    expect(img.width).toBe(200);
    handle.remove();
    expect(document.querySelector('#qr img')).toBeNull();
    expect(() => o.renderQr('#nope', challenge)).toThrow('container not found');
    expect(() => o.renderQr('#qr', { ...challenge, qrDataUrl: null })).toThrow('no qrDataUrl');
    for (const bad of ['https://tracker.example/pixel.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGgxPg==']) {
      expect(() => o.renderQr('#qr', { ...challenge, qrDataUrl: bad })).toThrow('must be a PNG data URL');
    }
  });

  test('countdown uses the server\'s expiresInSeconds and stops at 0', () => {
    vi.useFakeTimers();
    const o = new OfflineSign(fakeHttp(), paths);
    const ticks: number[] = [];
    const stop = o.countdown(challenge, (s) => ticks.push(s));
    vi.advanceTimersByTime(5000);
    expect(ticks).toEqual([3, 2, 1, 0]);
    stop();
    vi.useRealTimers();
  });
});

describe('code helpers', () => {
  test('normalizeOfflineCode accepts spacing/case, rejects anything that is not 7 valid characters', () => {
    expect(normalizeOfflineCode('abc-defg')).toBe('ABCDEFG');
    expect(normalizeOfflineCode(' abc defg ')).toBe('ABCDEFG');
    for (const bad of ['abc-def', 'ABC-DEFGH', 'ABC-DE0G', 'ABC-DEIG', '', null as unknown as string]) expect(normalizeOfflineCode(bad)).toBeNull();
  });

  test('formatOfflineCodeInput formats as the user types and drops characters the app never shows', () => {
    expect(formatOfflineCodeInput('ab')).toBe('AB');
    expect(formatOfflineCodeInput('abcd')).toBe('ABC-D');
    expect(formatOfflineCodeInput('abc-defg-extra')).toBe('ABC-DEFG');
    expect(formatOfflineCodeInput('a0b1c-oi')).toBe('ABC');
  });
});

describe('OfflineSign without a typed username (router bound to the password step)', () => {
  test('challenge() and verifyTotp() send no username when none is given', async () => {
    const http = fakeHttp();
    const o = new OfflineSign(http, paths);
    await o.challenge();
    expect((http.post as any).mock.calls[0][1]).toEqual({});
    await o.verifyTotp({ code: 'ABCDEFG' });
    expect((http.post as any).mock.calls[1][1]).toEqual({ code: 'ABCDEFG' });
  });
});
