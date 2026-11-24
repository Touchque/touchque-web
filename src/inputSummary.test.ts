// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { encodeInputSummary, startInputSummary } from './inputSummary';

const always = () => true;
const key = (type: string, key: string, timeStamp: number) => {
  const e = new KeyboardEvent(type, { key, code: `Key${key.toUpperCase()}`, bubbles: true });
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  return e;
};
const typed = (timeStamp: number, inputType = 'insertText') => {
  const e = new Event('input', { bubbles: true }) as InputEvent;
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  return e;
};

describe('the input summary', () => {
  test('a person: uneven keys held a while, no text without keys', () => {
    document.body.innerHTML = '<input id="f">';
    const probe = startInputSummary(document, { trusted: always });
    const f = document.getElementById('f')!;
    let t = 1000;
    for (const [gap, hold] of [[0, 90], [140, 70], [230, 110], [120, 80], [310, 95], [160, 60], [200, 105], [180, 75], [260, 85]]) {
      t += gap;
      f.dispatchEvent(key('keydown', 'a', t));
      f.dispatchEvent(typed(t + 2));
      f.dispatchEvent(key('keyup', 'a', t + hold));
    }
    const s = probe.summary();
    expect(s.kd).toBe(9);
    expect(s.nk).toBe(0);
    expect(s.kn).toBe(8);
    expect(s.ks).toBeGreaterThan(20);
    expect(s.hm).toBeGreaterThan(50);
    probe.stop();
  });

  test('a script: text with no key press, pastes counted, autofill left out', () => {
    document.body.innerHTML = '<input id="f">';
    const probe = startInputSummary(document, { trusted: always });
    const f = document.getElementById('f')!;
    f.dispatchEvent(typed(1000));
    f.dispatchEvent(typed(4000));
    f.dispatchEvent(typed(5000, 'insertFromPaste'));
    f.dispatchEvent(typed(6000, 'insertReplacementText'));
    const s = probe.summary();
    expect(s).toMatchObject({ kd: 0, nk: 2, pa: 1, ac: 2, lg: 1 });
    probe.stop();
  });

  test('untrusted events (made by script on the page) are not counted', () => {
    document.body.innerHTML = '<input id="f">';
    const probe = startInputSummary(document);
    document.getElementById('f')!.dispatchEvent(typed(1000));
    expect(probe.summary().nk).toBe(0);
    probe.stop();
  });

  test('17 characters, version 1, none as __', () => {
    const code = encodeInputSummary({ v: 1, kd: 9, nk: 0, pa: 0, kn: 8, km: 180, ks: 55, hm: 84, cp: 2, cc: 0, ac: 3, lg: 0, gm: 900 });
    expect(code).toHaveLength(17);
    expect(code[0]).toBe('1');
    expect(encodeInputSummary({ v: 1, kd: 0, nk: 0, pa: 0, kn: 0, km: null, ks: null, hm: null, cp: 0, cc: 0, ac: 0, lg: 0, gm: null }))
      .toBe('1AAAA______AAAA__');
  });
});
