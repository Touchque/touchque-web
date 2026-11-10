import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installDeviceRiskTag, installFromScript, REQUEST_ID_FIELD, REFRESH_AFTER_MS, AFTER_SUBMIT_MS, DEVICE_EVENT,
  type TouchQueDevice,
} from './deviceRiskTag';
import type { DeviceRiskIdentifyOptions } from './deviceRisk';
import { setTouchQueLogger } from './log';

const SITE_KEY = `tqpk_${'a'.repeat(32)}`;

/** A fake identify: a new requestId per call, the options it was called with. */
function fakeRisk() {
  const calls: DeviceRiskIdentifyOptions[] = [];
  let n = 0;
  return {
    calls,
    identify: vi.fn(async (options: DeviceRiskIdentifyOptions) => {
      calls.push(options);
      n += 1;
      return { visitorId: 'tqv_visitor', requestId: `dre_${options.purpose}_${n}`, confidence: 0.99 };
    }),
  };
}

const field = (form: Element) => form.querySelector<HTMLInputElement>(`input[name="${REQUEST_ID_FIELD}"]`);
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

let device: TouchQueDevice | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as Window & { TouchQueDevice?: unknown }).TouchQueDevice;
});
afterEach(() => {
  device?.stop();
  device = null;
  vi.useRealTimers();
});

describe('the Device risk script tag', () => {
  test('identifies once on load and puts the requestId into every form', async () => {
    document.body.innerHTML = '<form id="a"><input name="email"></form><form id="b"></form>';
    const risk = fakeRisk();
    device = installDeviceRiskTag({ siteKey: SITE_KEY, purpose: 'sign_in' }, { deviceRisk: risk });
    const id = await device.ready;
    await flush();
    expect(id?.requestId).toBe('dre_sign_in_1');
    expect(risk.calls).toHaveLength(1);
    expect(risk.calls[0]).toMatchObject({ siteKey: SITE_KEY, purpose: 'sign_in', pageView: true });
    for (const f of document.querySelectorAll('form')) {
      expect(field(f)?.type).toBe('hidden');
      expect(field(f)?.value).toBe('dre_sign_in_1');
    }
    expect(device.requestId).toBe('dre_sign_in_1');
    expect(device.visitorId).toBe('tqv_visitor');
  });

  test('forms added later get the field; a form\'s own data-touchque-purpose gets its own identification', async () => {
    const risk = fakeRisk();
    device = installDeviceRiskTag({ siteKey: SITE_KEY }, { deviceRisk: risk });
    await device.ready;
    const later = document.createElement('form');
    document.body.appendChild(later);
    const signup = document.createElement('div');
    signup.innerHTML = '<form data-touchque-purpose="sign_up"><input name="touchque_request_id" value=""></form>';
    document.body.appendChild(signup);
    await flush();
    await flush();
    expect(field(later)?.value).toBe('dre_sign_in_1');
    const own = signup.querySelector('form')!;
    expect(own.querySelectorAll(`input[name="${REQUEST_ID_FIELD}"]`)).toHaveLength(1); // its own field is used
    expect(field(own)?.value).toBe('dre_sign_up_2');
    expect(risk.calls.map((c) => c.purpose)).toEqual(['sign_in', 'sign_up']);
  });

  test('a new identification before the 15 minutes run out, and after each submit; a hidden tab waits', async () => {
    vi.useFakeTimers();
    let clock = 0;
    document.body.innerHTML = '<form></form>';
    const risk = fakeRisk();
    const events: string[] = [];
    document.addEventListener(DEVICE_EVENT, (e) => events.push((e as CustomEvent).detail.requestId));
    device = installDeviceRiskTag({ siteKey: SITE_KEY }, { deviceRisk: risk, now: () => clock });
    await device.ready;
    await flush();
    const form = document.querySelector('form')!;
    expect(field(form)?.value).toBe('dre_sign_in_1');

    clock = REFRESH_AFTER_MS;
    await vi.advanceTimersByTimeAsync(REFRESH_AFTER_MS);
    expect(field(form)?.value).toBe('dre_sign_in_2');

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // The submitted form carries its requestId and how the pointer moved.
    expect(field(form)?.value).toMatch(/^dre_sign_in_2\.1[A-Za-z0-9_-]{17}$/);
    expect(device.value()).toBe(field(form)?.value);
    await vi.advanceTimersByTimeAsync(AFTER_SUBMIT_MS);
    expect(field(form)?.value).toBe('dre_sign_in_3');

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await vi.advanceTimersByTimeAsync(REFRESH_AFTER_MS);
    expect(risk.calls).toHaveLength(3);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(field(form)?.value).toBe('dre_sign_in_4');
    expect(events).toEqual(['dre_sign_in_1', 'dre_sign_in_2', 'dre_sign_in_3', 'dre_sign_in_4']);
  });

  test('the pointer summary: on submit after the requestId, left out with pointer: false', async () => {
    document.body.innerHTML = '<form><button>Go</button></form>';
    const pointer = { summary: vi.fn(), encode: () => '1CCABA__A__A__ACAA', stop: vi.fn() };
    device = installDeviceRiskTag({ siteKey: SITE_KEY }, { deviceRisk: fakeRisk(), pointer });
    await device.ready;
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(field(form)?.value).toBe('dre_sign_in_1.1CCABA__A__A__ACAA');
    // 26 + 1 + 18: inside the 64 characters every server SDK passes on.
    expect(field(form)!.value.length).toBeLessThanOrEqual(64);
    device.stop();
    expect(pointer.stop).toHaveBeenCalled();

    document.body.innerHTML = '<form></form>';
    device = installDeviceRiskTag({ siteKey: SITE_KEY, pointer: false }, { deviceRisk: fakeRisk() });
    await device.ready;
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(field(document.querySelector('form')!)?.value).toBe('dre_sign_in_1');
    expect(device.value()).toBe('dre_sign_in_1');
  });

  test('TouchQue unreachable: ready is null, the field is empty, the page goes on', async () => {
    document.body.innerHTML = '<form></form>';
    device = installDeviceRiskTag({ siteKey: SITE_KEY }, { deviceRisk: { identify: vi.fn(async () => null) } });
    expect(await device.ready).toBeNull();
    await flush();
    expect(field(document.querySelector('form')!)?.value).toBe('');
    expect(device.requestId).toBeNull();
  });

  test('from its script element: data-site-key, data-purpose and data-api; once per page; no site key warns', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ visitorId: 'tqv_x', requestId: 'dre_from_script_0000000', confidence: 0.6 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never);
    const script = document.createElement('script');
    script.setAttribute('data-site-key', SITE_KEY);
    script.setAttribute('data-purpose', 'password_reset');
    script.setAttribute('data-api', 'http://localhost:5001');
    document.head.appendChild(script);
    device = installFromScript(script);
    expect(installFromScript(script)).toBe(device);
    expect((window as Window & { TouchQueDevice?: TouchQueDevice }).TouchQueDevice).toBe(device);
    expect((await device.ready)?.requestId).toBe('dre_from_script_0000000');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:5001/device-risk/identify');
    expect(JSON.parse(String(init.body))).toMatchObject({ siteKey: SITE_KEY, view: true });
    vi.unstubAllGlobals();

    delete (window as Window & { TouchQueDevice?: unknown }).TouchQueDevice;
    script.remove();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Silent by default: a page's console stays clean.
      const bare = installFromScript(document.createElement('script'));
      expect(await bare.ready).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      // data-debug on the tag says it.
      delete (window as Window & { TouchQueDevice?: unknown }).TouchQueDevice;
      const debug = document.createElement('script');
      debug.setAttribute('data-debug', '');
      expect(await installFromScript(debug).ready).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('data-site-key'));
    } finally {
      setTouchQueLogger(null);
      warn.mockRestore();
    }
  });
});
