import { describe, test, expect, afterEach } from 'vitest';
import { startPointerSummary, encodePointerSummary, lineFit, type PointerSummaryProbe } from './pointerSummary';

// Events as the browser hands them over: dispatched here, so marked trusted by the test's hook.
function fire(type: string, props: Record<string, unknown>) {
  const e = new Event(type, { bubbles: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  document.dispatchEvent(e);
}
const move = (x: number, y: number, t: number) => fire('pointermove', { pointerType: 'mouse', clientX: x, clientY: y, timeStamp: t });
const press = (x: number, y: number, t: number, hold: number) => {
  fire('pointerdown', { pointerType: 'mouse', clientX: x, clientY: y, timeStamp: t, button: 0, pointerId: 1 });
  fire('pointerup', { pointerType: 'mouse', clientX: x, clientY: y, timeStamp: t + hold, button: 0, pointerId: 1 });
};
const touch = (type: string, x: number, y: number, t: number, fingers = 1) => {
  const c = { identifier: 7, clientX: x, clientY: y };
  fire(type, { timeStamp: t, changedTouches: [c], touches: type === 'touchend' ? [] : Array(fingers).fill(c) });
};

let probe: PointerSummaryProbe | null = null;
const start = () => { probe = startPointerSummary(document, { trusted: () => true }); return probe; };
afterEach(() => { probe?.stop(); probe = null; });

describe('the pointer summary', () => {
  test('a driver: every press on a pointer that jumped there, held for no time', () => {
    const p = start();
    move(200, 300, 1000); // one move onto the field, then the press
    press(200, 300, 1001, 1);
    move(420, 520, 1400);
    press(420, 520, 1401, 0.4);
    expect(p.summary()).toMatchObject({ p: 2, pt: 2, pth: 1, mv: 2 });
  });

  test('a hand: many small moves before a press that lasts', () => {
    const p = start();
    for (let i = 0; i < 20; i += 1) move(100 + i * 9 + (i % 3), 200 + i * 5 - (i % 2) * 2, 1000 + i * 16);
    press(280, 300, 1330, 95);
    // Resting on the button and pressing again: the pointer did not jump.
    press(281, 300, 2600, 88);
    expect(p.summary()).toMatchObject({ p: 2, pt: 0, pth: null });
  });

  test('ruler-straight strokes count, curved ones and ones along an axis do not', () => {
    const p = start();
    for (let i = 0; i <= 12; i += 1) move(10 + i * 30, 10 + i * 20, 1000 + i * 8); // 433 px, straight
    for (let i = 0; i <= 12; i += 1) move(10 + i * 30, 900, 2000 + i * 8); // along the x axis
    for (let i = 0; i <= 12; i += 1) move(10 + i * 30, 600 + i * 20 + Math.sin(i / 2) * 25, 3000 + i * 8); // a curve
    expect(p.summary()).toMatchObject({ ls: 2, lsd: 0 });
    expect(lineFit([{ x: 0, y: 0, t: 0 }, { x: 5, y: 5, t: 1 }, { x: 10, y: 0, t: 2 }]).deviation).toBe(5);
  });

  test('taps and swipes: instant taps, a ruler swipe; a pinch is neither', () => {
    const p = start();
    touch('touchstart', 50, 50, 1000); touch('touchend', 50, 50, 1002);
    touch('touchstart', 80, 90, 1500); touch('touchend', 81, 90, 1501);
    touch('touchstart', 200, 700, 2000);
    for (let i = 1; i <= 12; i += 1) touch('touchmove', 200, 700 - i * 30, 2000 + i * 10);
    touch('touchend', 200, 340, 2130);
    touch('touchstart', 10, 10, 3000, 2); touch('touchend', 10, 10, 3001);
    expect(p.summary()).toMatchObject({ t: 2, th: 2, sw: 1, swd: 0, tm: 12 });
  });

  test('untrusted events (a script, a password manager) are not counted here', () => {
    probe = startPointerSummary(document);
    move(1, 1, 10);
    press(1, 1, 11, 1);
    expect(probe.summary()).toMatchObject({ p: 0, mv: 0 });
  });

  test('18 characters: version, counts, times, deviations; none is __', () => {
    const code = encodePointerSummary({ v: 1, p: 2, pt: 2, pth: 1.2, ls: 0, lsd: null, t: 0, th: null, sw: 0, swd: null, mv: 2, tm: 0 });
    expect(code).toBe('1CCABA__A__A__ACAA');
    expect(code).toHaveLength(18);
    // Past 63 presses, one that did not jump still shows.
    expect(encodePointerSummary({ v: 1, p: 90, pt: 89, pth: 2, ls: 0, lsd: null, t: 0, th: null, sw: 0, swd: null, mv: 9000, tm: 0 }).slice(1, 3)).toBe('_-');
  });
});
