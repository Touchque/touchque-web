import { describe, test, expect, vi, beforeEach } from 'vitest';

const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication,
  browserSupportsWebAuthn: vi.fn(() => true),
  browserSupportsWebAuthnAutofill: vi.fn(async () => false),
  platformAuthenticatorIsAvailable: vi.fn(async () => true),
  WebAuthnAbortService: { cancelCeremony: vi.fn(), createNewAbortSignal: vi.fn() },
}));

import { createApproval, defineTouchQueApproval, approvalTimeLeft, PasskeyDismissedError } from './index';
import type { ApprovalState, TouchQueApprovalElement } from './index';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** A scripted relay: each call takes the next response (a Response or a function of the request). */
function relay(script: Array<Response | ((url: string, init: RequestInit) => Response)>) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function track(approval: ReturnType<typeof createApproval>) {
  const phases: string[] = [];
  approval.subscribe((s: ApprovalState) => { if (phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
  return phases;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ApprovalController', () => {
  test('never opens for a route that answers at once', async () => {
    const r = relay([json({ ok: true })]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch });
    const phases = track(approval);
    const res = await approval.fetch('/api/pay', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true });
    expect(phases).toEqual(['closed']);
  });

  test('shows the number while waiting, then approved, then closes', async () => {
    const r = relay([
      json({ touchque: { state: 'waiting', requestId: 'r1', number: '47', expiresAt: new Date(Date.now() + 60_000).toISOString(), reasons: [{ code: 'new_device', text: 'A new device' }] }, token: 't1' }, 202),
      json({ ok: true }),
    ]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch }, { pollIntervalMs: 1, approvedMs: 5 });
    const seen: ApprovalState[] = [];
    approval.subscribe((s) => seen.push(s));
    await approval.fetch('/api/pay', { method: 'POST' });
    const waiting = seen.find((s) => s.phase === 'waiting')!;
    expect(waiting.number).toBe('47');
    expect(waiting.reasons).toEqual([{ code: 'new_device', text: 'A new device' }]);
    expect(approval.getState().phase).toBe('approved');
    expect(r.calls[1].headers.get('x-touchque-token')).toBe('t1');
    await new Promise((res) => setTimeout(res, 20));
    expect(approval.getState().phase).toBe('closed');
  });

  test('a refusal stays on screen with its message and case code', async () => {
    const r = relay([json({ touchque: { state: 'rejected', reason: 'request_rejected', caseCode: 'K7P-2QX' } }, 403)]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch });
    const res = await approval.fetch('/api/pay');
    expect(res.status).toBe(403);
    const s = approval.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toMatchObject({ code: 'rejected', message: 'The request was rejected on your phone.', caseCode: 'K7P-2QX' });
    approval.close();
    expect(approval.getState().phase).toBe('closed');
  });

  test('rate limits say when to try again; texts can be overridden', async () => {
    const r = relay([json({ touchque: { state: 'rate_limited', retryAfter: 30 } }, 429)]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch }, { texts: { errorTitle: 'Nope' } });
    await approval.fetch('/api/pay');
    expect(approval.getState().error?.message).toBe('Too many requests. Try again in 30 seconds.');
    expect(approval.texts.errorTitle).toBe('Nope');
  });

  test('the passkey step waits for a click, survives a closed prompt, then finishes', async () => {
    const r = relay([
      json({ touchque: { state: 'passkey_required', requestId: 'r9' }, token: 't1' }, 202),
      json({ challenge: 'c', rpId: 'example.com' }), // /passkey/login/options
      json({ challenge: 'c2', rpId: 'example.com' }),
      json({ success: true }), // /passkey/login/verify
      json({ ok: true }),
    ]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch }, { pollIntervalMs: 1 });
    const done = approval.fetch('/api/pay', { method: 'POST' });
    await vi.waitFor(() => expect(approval.getState().phase).toBe('passkey'));
    expect(startAuthentication).not.toHaveBeenCalled(); // no ceremony without a click

    startAuthentication.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
    await approval.continueWithPasskey();
    expect(approval.getState()).toMatchObject({ phase: 'passkey', notice: 'The passkey prompt was closed. Try again.', busy: false });

    startAuthentication.mockResolvedValueOnce({ id: 'cred' });
    await approval.continueWithPasskey();
    const res = await done;
    expect(await res.json()).toEqual({ ok: true });
    expect(r.calls.map((c) => c.url)).toEqual(['/api/pay', '/tq/passkey/login/options', '/tq/passkey/login/options', '/tq/passkey/login/verify', '/api/pay']);
    expect(r.calls[3].body).toMatchObject({ requestId: 'r9' });
    expect(PasskeyDismissedError).toBeDefined();
  });

  test('offline: QR and number, a badly typed code is caught here, a wrong one shows attempts left', async () => {
    const r = relay([
      json({ touchque: { state: 'waiting', requestId: 'r1' }, token: 't1' }, 202),
      json({ touchque: { state: 'offline', offline: { challengeId: 'o1', qrDataUrl: PNG, challengeCode: '55', totpAvailable: true } }, token: 't2' }, 202),
      json({ touchque: { state: 'offline', offline: { challengeId: 'o1', attemptsLeft: 2 } }, token: 't3' }, 202),
      json({ ok: true }),
    ]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch }, { pollIntervalMs: 60_000 });
    const done = approval.fetch('/api/pay');
    await vi.waitFor(() => expect(approval.getState().phase).toBe('waiting'));
    approval.useOffline();
    await vi.waitFor(() => expect(approval.getState().phase).toBe('offline'));
    expect(approval.getState().offline).toEqual({ qrDataUrl: PNG, challengeCode: '55', totpAvailable: true, attemptsLeft: null });
    expect(r.calls[1].headers.get('x-touchque-offline')).toBe('1');

    approval.submitCode('abc');
    expect(approval.getState().codeError).toBe('Enter the 7-character code from the app.');

    approval.submitCode('abc-defg');
    await vi.waitFor(() => expect(approval.getState().codeError).toBe('That code did not match. 2 attempts left.'));
    expect(r.calls[2].headers.get('x-touchque-code')).toBe('ABCDEFG');
    expect(approval.getState().offline?.qrDataUrl).toBe(PNG); // the QR stays

    approval.setCodeType('totp');
    approval.submitCode('123 456');
    await done;
    expect(r.calls[3].headers.get('x-touchque-code')).toBe('123456');
    expect(r.calls[3].headers.get('x-touchque-code-type')).toBe('totp');
  });

  test('closing while waiting cancels the call with an AbortError', async () => {
    const r = relay([json({ touchque: { state: 'waiting', requestId: 'r1', number: '12' }, token: 't1' }, 202)]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch }, { pollIntervalMs: 60_000 });
    const done = approval.fetch('/api/pay');
    await vi.waitFor(() => expect(approval.getState().phase).toBe('waiting'));
    approval.close();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(approval.getState().phase).toBe('closed');
  });

  test('login(): first-time link QR, then a refusal rejects and stays on screen', async () => {
    const r = relay([
      json({ touchque: { state: 'enroll', enroll: { qrCodeDataUrl: PNG, recoveryCodes: ['AAAA-BBBB'] } }, token: 't1' }, 202),
      json({ touchque: { state: 'blocked', reason: 'risk', caseCode: 'Q2W-3ER' } }, 403),
    ]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch }, { pollIntervalMs: 1 });
    const seen: ApprovalState[] = [];
    approval.subscribe((s) => seen.push(s));
    await expect(approval.login()).rejects.toMatchObject({ name: 'TouchQueWebAPIError', status: 403 });
    expect(seen.find((s) => s.phase === 'enroll')?.enroll).toEqual({ qrCodeDataUrl: PNG, recoveryCodes: ['AAAA-BBBB'] });
    expect(approval.getState().error).toMatchObject({ code: 'risk', message: 'This request was blocked for your security.', caseCode: 'Q2W-3ER' });
    expect(r.calls[0].url).toBe('/tq/login');
  });

  test('a network failure is shown, not swallowed', async () => {
    const r = relay([() => { throw new TypeError('Failed to fetch'); }]);
    const approval = createApproval({ baseUrl: '/tq', fetch: r.fetch });
    await expect(approval.fetch('/api/pay')).rejects.toBeInstanceOf(TypeError);
    expect(approval.getState().error?.code).toBe('network');
  });

  test('approvalTimeLeft ignores past and implausible times', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(approvalTimeLeft('2026-10-20T10:01:05Z', now)).toBe('1:05');
    expect(approvalTimeLeft('2026-10-20T09:59:00Z', now)).toBeNull();
    expect(approvalTimeLeft('2026-10-20T11:00:00Z', now)).toBeNull();
  });
});

describe('<touchque-approval>', () => {
  test('renders the steps into its dialog and fires events', async () => {
    defineTouchQueApproval();
    defineTouchQueApproval(); // twice is fine
    const r = relay([
      json({ touchque: { state: 'waiting', requestId: 'r1', number: '83' }, token: 't1' }, 202),
      json({ touchque: { state: 'expired', caseCode: 'Z9Z-9ZZ' } }, 408),
    ]);
    const node = document.createElement('touchque-approval') as TouchQueApprovalElement;
    node.config = { baseUrl: '/tq', fetch: r.fetch };
    node.options = { pollIntervalMs: 1 };
    document.body.append(node);
    const events: string[] = [];
    for (const type of ['touchque-step', 'touchque-error', 'touchque-close']) node.addEventListener(type, () => events.push(type));

    const res = await node.fetch('/api/pay');
    expect(res.status).toBe(408);
    const dialog = node.shadowRoot!.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('Not approved');
    expect(dialog.textContent).toContain('The request expired before it was approved. Start again.');
    expect(dialog.querySelector('.tq-case code')?.textContent).toBe('Z9Z-9ZZ');
    expect(events).toContain('touchque-step');
    expect(events).toContain('touchque-error');

    (dialog.querySelector('.tq-btn') as HTMLButtonElement).click();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(events[events.length - 1]).toBe('touchque-close');
    node.remove();
  });

  test('needs a base-url', () => {
    defineTouchQueApproval();
    const node = document.createElement('touchque-approval') as TouchQueApprovalElement;
    expect(() => node.approval).toThrow(/base-url/);
    node.setAttribute('base-url', '/tq');
    expect(node.approval).toBeDefined();
  });
});
