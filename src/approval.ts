// The drop-in approval dialog's state machine, without any UI.
//
// `<touchque-approval>` (approvalElement.ts) and `@touchque/react`'s
// `<TouchQueApproval>` both render it. It drives the same two-phase step-up
// contract as `touchqueFetch` / `classic2fa.login` and turns each step into
// what the dialog shows: the number to pick on the phone, the first-time link
// QR, the offline QR and code, the passkey button, and the refusals with
// their case code.
//
//   const approval = createApproval({ baseUrl: '/touchque', credentials: 'include' });
//   approval.subscribe(render);
//   const res = await approval.fetch('/api/transfer', { method: 'POST', body });
//
// The dialog opens only when the server asks for an approval; a route that
// answers at once (or a silent sign-in) never shows it.

import { createTouchQueWeb } from './index';
import type { TouchQueWeb } from './index';
import type { TouchQueWebConfig } from './types';
import type { Step, StepControls, TouchQueFetchOptions } from './action';
import type { ClassicLoginResult } from './classic2fa';
import { normalizeOfflineCode } from './offline';
import { PasskeyDismissedError, PasskeyNotRegisteredError, TouchQueWebAPIError } from './errors';

export type ApprovalPhase = 'closed' | 'waiting' | 'enroll' | 'offline' | 'passkey' | 'approved' | 'error';

export interface ApprovalError {
  /** The step's state or reason (`rejected`, `expired`, `risk`, `rate_limited`, `network`…). */
  code: string;
  message: string;
  /** "Why?" case code to read out to support (`K7P-2QX`). */
  caseCode?: string;
  /** Seconds until a new attempt may work (`frozen`, `rate_limited`). */
  retryAfter?: number;
}

export interface ApprovalState {
  /** `closed`: nothing to show. Everything else is a dialog screen. */
  phase: ApprovalPhase;
  /** The last step from your server, untouched. */
  step: Step | null;
  /** Number matching: the digits to show; the user picks the same number on the phone. */
  number: string | null;
  expiresAt: string | null;
  /** Why the phone is asked (plain English, from the server). */
  reasons: Array<{ code: string; text: string }>;
  enroll: { qrCodeDataUrl: string; recoveryCodes: string[] } | null;
  offline: { qrDataUrl: string | null; challengeCode: string | null; totpAvailable: boolean; attemptsLeft: number | null } | null;
  /** A wrong or badly typed offline code, shown under the input. */
  codeError: string | null;
  /** A passkey ceremony or a typed code is being checked. */
  busy: boolean;
  /** A note on the passkey screen (the prompt was closed: try again). */
  notice: string | null;
  error: ApprovalError | null;
  /** The case code of the current step or refusal, or null. */
  caseCode: string | null;
}

/** Every text the dialog shows, in English. Override any of them with `texts`. */
export interface ApprovalTexts {
  waitingTitle: string;
  waitingBody: string;
  numberLabel: string;
  waitingStatus: string;
  expiresIn: (time: string) => string;
  whyTitle: string;
  noNotification: string;
  useOffline: string;
  enrollTitle: string;
  enrollBody: string;
  recoveryCodes: string;
  offlineTitle: string;
  offlineBody: string;
  offlineNumber: string;
  codeLabel: string;
  totpLabel: string;
  submitCode: string;
  useTotp: string;
  useQr: string;
  codeFormat: string;
  totpFormat: string;
  invalidCode: (attemptsLeft: number | null) => string;
  passkeyTitle: string;
  passkeyBody: string;
  passkeyButton: string;
  passkeyBusy: string;
  passkeyDismissed: string;
  approvedTitle: string;
  errorTitle: string;
  supportCode: (code: string) => string;
  cancel: string;
  close: string;
  errors: {
    rejected: string;
    expired: string;
    blocked: string;
    risk: string;
    geo_policy: string;
    access_policy: string;
    unauthenticated: string;
    passkey_not_registered: string;
    action_disabled: string;
    already_linked: string;
    not_linked: string;
    unavailable: string;
    misconfigured: string;
    frozen: (retryAfter?: number) => string;
    rate_limited: (retryAfter?: number) => string;
    network: string;
    generic: string;
  };
}

const wait = (seconds?: number) => {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 90) return ` Try again in ${Math.ceil(seconds)} seconds.`;
  return ` Try again in ${Math.ceil(seconds / 60)} minutes.`;
};

export const DEFAULT_APPROVAL_TEXTS: ApprovalTexts = {
  waitingTitle: 'Check your phone',
  waitingBody: 'We sent a request to the TouchQue app. Approve it there to continue.',
  numberLabel: 'Choose this number in the TouchQue app',
  waitingStatus: 'Waiting for your approval…',
  expiresIn: (time) => `Expires in ${time}`,
  whyTitle: 'Why your phone is asked',
  noNotification: 'No notification?',
  useOffline: 'Verify offline',
  enrollTitle: 'Link your phone',
  enrollBody: 'Scan this code with the TouchQue app to link your phone. Then approve the request it shows.',
  recoveryCodes: 'Recovery codes. Keep them somewhere safe; each one works once.',
  offlineTitle: 'Verify offline',
  offlineBody: 'Scan this code with the TouchQue app. It works without internet. Then type the code the app shows.',
  offlineNumber: 'Tap this number in the app',
  codeLabel: 'Code from the app',
  totpLabel: 'Time-based code from the app',
  submitCode: 'Verify',
  useTotp: 'No camera? Type the time-based code',
  useQr: 'Scan the QR code instead',
  codeFormat: 'Enter the 7-character code from the app.',
  totpFormat: 'Enter the 6-digit code from the app.',
  invalidCode: (left) => (left !== null && left >= 0 ? `That code did not match. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.` : 'That code did not match.'),
  passkeyTitle: 'Use your passkey',
  passkeyBody: 'This request must be approved with a passkey on this device.',
  passkeyButton: 'Continue with passkey',
  passkeyBusy: 'Waiting for your passkey…',
  passkeyDismissed: 'The passkey prompt was closed. Try again.',
  approvedTitle: 'Approved',
  errorTitle: 'Not approved',
  supportCode: (code) => `Tell your support team: ${code}`,
  cancel: 'Cancel',
  close: 'Close',
  errors: {
    rejected: 'The request was rejected on your phone.',
    expired: 'The request expired before it was approved. Start again.',
    blocked: 'This request was blocked.',
    risk: 'This request was blocked for your security.',
    geo_policy: 'Requests from your location are not allowed.',
    access_policy: 'An access rule of this site blocked the request.',
    unauthenticated: 'Sign in first.',
    passkey_not_registered: 'This request needs a passkey, and this account has none on this device.',
    action_disabled: 'This action is turned off.',
    already_linked: 'A phone is already linked to this account. Approve on that phone.',
    not_linked: 'No phone is linked to this account yet.',
    unavailable: 'Approvals are unavailable right now. Try again shortly.',
    misconfigured: 'Approvals are not set up correctly on this site.',
    frozen: (s) => `Approvals for this account are paused after several rejected requests.${wait(s)}`,
    rate_limited: (s) => `Too many requests.${wait(s) || ' Try again shortly.'}`,
    network: 'Could not reach the server. Check your connection and try again.',
    generic: 'Something went wrong. Try again.',
  },
};

export interface ApprovalOptions {
  /** Override any text (merged over `DEFAULT_APPROVAL_TEXTS`; `errors` too). */
  texts?: Partial<Omit<ApprovalTexts, 'errors'>> & { errors?: Partial<ApprovalTexts['errors']> };
  /** How often to check while waiting (default 1500 ms). */
  pollIntervalMs?: number;
  /** Behavioural signals for the approval (see `TouchQueFetchOptions.telemetry`). */
  telemetry?: TouchQueFetchOptions['telemetry'];
  /** How long the "Approved" screen stays before the dialog closes (default 900 ms). */
  approvedMs?: number;
}

const TERMINAL_REFUSALS = new Set(['rejected', 'expired', 'blocked', 'frozen', 'rate_limited']);

const CLOSED: ApprovalState = {
  phase: 'closed', step: null, number: null, expiresAt: null, reasons: [], enroll: null, offline: null,
  codeError: null, busy: false, notice: null, error: null, caseCode: null,
};

function abortError(): Error {
  const e = new Error('TouchQue approval cancelled');
  e.name = 'AbortError';
  return e;
}

const isAbort = (err: unknown) => (err as { name?: string })?.name === 'AbortError';

function mergeTexts(texts?: ApprovalOptions['texts']): ApprovalTexts {
  return { ...DEFAULT_APPROVAL_TEXTS, ...(texts ?? {}), errors: { ...DEFAULT_APPROVAL_TEXTS.errors, ...(texts?.errors ?? {}) } } as ApprovalTexts;
}

/** The message for a refusal step (`rejected`, `blocked` + `reason`, …). */
export function describeApprovalStep(step: Step, texts: ApprovalTexts = DEFAULT_APPROVAL_TEXTS): ApprovalError {
  const e = texts.errors;
  const reason = step.reason || '';
  let code: string = step.state;
  let message: string;
  switch (step.state) {
    case 'rejected': message = e.rejected; break;
    case 'expired': message = e.expired; break;
    case 'frozen': message = e.frozen(step.retryAfter); break;
    case 'rate_limited': message = e.rate_limited(step.retryAfter); break;
    case 'enroll': code = reason || 'not_linked'; message = reason === 'already_linked' ? e.already_linked : e.not_linked; break;
    default: {
      code = reason || 'blocked';
      const known = (e as unknown as Record<string, unknown>)[reason];
      message = typeof known === 'string' ? known : e.blocked;
    }
  }
  return { code, message, ...(step.caseCode && { caseCode: step.caseCode }), ...(step.retryAfter && { retryAfter: step.retryAfter }) };
}

function describeThrown(err: unknown, texts: ApprovalTexts): ApprovalError {
  if (err instanceof PasskeyNotRegisteredError) return { code: 'passkey_not_registered', message: texts.errors.passkey_not_registered };
  if (err instanceof TouchQueWebAPIError) {
    const body = (err.body && typeof err.body === 'object' ? err.body : {}) as { touchque?: Step };
    if (body.touchque?.state) return describeApprovalStep(body.touchque, texts);
    return { code: `http_${err.status}`, message: texts.errors.generic, ...(err.caseCode && { caseCode: err.caseCode }) };
  }
  if (err instanceof TypeError) return { code: 'network', message: texts.errors.network };
  return { code: 'error', message: texts.errors.generic };
}

type Listener = (state: ApprovalState) => void;

export class ApprovalController {
  readonly texts: ApprovalTexts;
  private readonly client: TouchQueWeb;
  private readonly options: ApprovalOptions;
  private state: ApprovalState = CLOSED;
  private readonly listeners = new Set<Listener>();
  private controls: StepControls | null = null;
  private abort: AbortController | null = null;
  private passkeyWait: { requestId: string; resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private codeType: 'qr' | 'totp' = 'qr';

  constructor(config: TouchQueWebConfig, options: ApprovalOptions = {}) {
    this.options = options;
    this.texts = mergeTexts(options.texts);
    this.client = createTouchQueWeb(config);
    // The passkey step waits for a click in the dialog (Safari needs one).
    this.client.classic2fa.approveWithPasskey = this.approveWithPasskey;
  }

  getState = (): ApprovalState => this.state;

  /** Calls `listener` on every change; returns the unsubscribe function. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /**
   * fetch() for a route guarded with requireTouchQue (or any TouchQue server
   * SDK guard). Shows the dialog while the user approves and resolves with
   * your route's response. A refusal resolves with the final 4xx and leaves
   * the error on screen until closed. Closing the dialog while waiting
   * rejects with an `AbortError`.
   */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = this.begin();
    try {
      const res = await this.client.fetch(input, init, {
        signal, onStep: this.onStep, approveWithPasskey: this.approveWithPasskey,
        pollIntervalMs: this.options.pollIntervalMs, telemetry: this.options.telemetry,
      });
      this.finish(signal);
      return res;
    } catch (err) {
      this.fail(signal, err);
      throw err;
    }
  };

  /**
   * Classic push sign-in through your relay (`classic2fa.login`), in the
   * dialog. Resolves once approved; a refusal rejects with
   * `TouchQueWebAPIError` and stays on screen until closed.
   */
  login = async (input: { externalUsername?: string } = {}): Promise<ClassicLoginResult> => {
    const signal = this.begin();
    try {
      const result = await this.client.classic2fa.login({
        externalUsername: input.externalUsername, signal, onStep: this.onStep,
        pollIntervalMs: this.options.pollIntervalMs, telemetry: this.options.telemetry,
      });
      this.finish(signal);
      return result;
    } catch (err) {
      this.fail(signal, err);
      throw err;
    }
  };

  /** The phone has no internet: show the offline QR. */
  useOffline = (): void => {
    if (!this.controls || this.state.phase !== 'waiting') return;
    this.codeType = 'qr';
    this.set({ busy: true, codeError: null });
    this.controls.useOffline();
  };

  /** Switch the offline screen between the QR code and the time-based code. */
  setCodeType = (type: 'qr' | 'totp'): void => {
    this.codeType = type;
    this.set({ codeError: null });
  };

  get codeMode(): 'qr' | 'totp' { return this.codeType; }

  /** Send the code the app shows (`totp`: the 6-digit time-based code). Checks its form first. */
  submitCode = (code: string, type: 'qr' | 'totp' = this.codeType): void => {
    if (!this.controls || this.state.phase !== 'offline' || this.state.busy) return;
    if (type === 'totp') {
      const digits = String(code ?? '').replace(/\D/g, '');
      if (digits.length !== 6) { this.set({ codeError: this.texts.totpFormat }); return; }
      this.set({ busy: true, codeError: null });
      this.controls.submitCode(digits, 'totp');
      return;
    }
    const normalized = normalizeOfflineCode(code);
    if (!normalized) { this.set({ codeError: this.texts.codeFormat }); return; }
    this.set({ busy: true, codeError: null });
    this.controls.submitCode(normalized, 'qr');
  };

  /** Run the passkey ceremony for the passkey step (call it from a click). */
  continueWithPasskey = async (): Promise<void> => {
    const pending = this.passkeyWait;
    if (!pending || this.state.busy) return;
    this.set({ busy: true, notice: null });
    try {
      const result = await this.client.passkeys.approveLogin({ requestId: pending.requestId });
      if (this.passkeyWait !== pending) return;
      this.passkeyWait = null;
      this.set({ busy: false });
      pending.resolve(result);
    } catch (err) {
      if (this.passkeyWait !== pending) return;
      if (err instanceof PasskeyDismissedError) {
        this.set({ busy: false, notice: this.texts.passkeyDismissed });
        return;
      }
      this.passkeyWait = null;
      this.set({ busy: false });
      pending.reject(err);
    }
  };

  /** Stop waiting and close (the pending fetch/login rejects with an `AbortError`). */
  cancel = (): void => {
    this.cancelSilently();
    clearTimeout(this.closeTimer);
    this.set(CLOSED);
  };

  /** Close the dialog after a refusal or the approved screen. While waiting it cancels. */
  close = (): void => {
    if (this.abort) {
      this.cancel();
      return;
    }
    clearTimeout(this.closeTimer);
    this.set(CLOSED);
  };

  private begin(): AbortSignal {
    this.cancelSilently();
    clearTimeout(this.closeTimer);
    this.codeType = 'qr';
    this.set(CLOSED);
    const ac = new AbortController();
    this.abort = ac;
    return ac.signal;
  }

  private cancelSilently(): void {
    if (this.passkeyWait) {
      const pending = this.passkeyWait;
      this.passkeyWait = null;
      pending.reject(abortError());
    }
    this.controls?.cancel();
    this.abort?.abort();
    this.abort = null;
    this.controls = null;
  }

  private finish(signal: AbortSignal): void {
    if (this.abort?.signal !== signal) return;
    this.abort = null;
    this.controls = null;
    if (this.state.phase === 'error' || this.state.phase === 'closed') return;
    this.set({ phase: 'approved', busy: false, error: null });
    this.closeTimer = setTimeout(() => { if (this.state.phase === 'approved') this.set(CLOSED); }, this.options.approvedMs ?? 900);
  }

  private fail(signal: AbortSignal, err: unknown): void {
    if (this.abort?.signal !== signal) return;
    this.abort = null;
    this.controls = null;
    if (isAbort(err)) { this.set(CLOSED); return; }
    if (this.state.phase === 'error') return; // the refusal step is already on screen
    const error = describeThrown(err, this.texts);
    this.set({ phase: 'error', busy: false, error, caseCode: error.caseCode ?? this.state.caseCode });
  }

  private approveWithPasskey = (requestId: string): Promise<unknown> => new Promise((resolve, reject) => {
    this.passkeyWait = { requestId, resolve, reject };
    this.set({ phase: 'passkey', busy: false, notice: null });
  });

  private onStep = (step: Step, controls: StepControls): void => {
    this.controls = controls;
    clearTimeout(this.closeTimer);
    const base: Partial<ApprovalState> = {
      step,
      busy: false,
      caseCode: step.caseCode ?? this.state.caseCode,
      ...(step.number && { number: step.number }),
      ...(step.expiresAt && { expiresAt: step.expiresAt }),
      ...(step.reasons && { reasons: step.reasons }),
    };
    if (TERMINAL_REFUSALS.has(step.state)) {
      this.set({ ...base, phase: 'error', error: describeApprovalStep(step, this.texts) });
      return;
    }
    switch (step.state) {
      case 'waiting':
        this.set({ ...base, phase: 'waiting', error: null, codeError: null });
        return;
      case 'approved':
        this.set({ ...base, phase: 'approved', error: null });
        return;
      case 'passkey_required':
        this.set({ ...base, phase: 'passkey', error: null, notice: null });
        return;
      case 'enroll': {
        const qr = step.enroll?.qrCodeDataUrl;
        if (!qr || !isPngDataUrl(qr)) {
          this.set({ ...base, phase: 'error', error: describeApprovalStep(step, this.texts) });
          return;
        }
        this.set({ ...base, phase: 'enroll', error: null, enroll: { qrCodeDataUrl: qr, recoveryCodes: step.enroll?.recoveryCodes ?? [] } });
        return;
      }
      case 'offline': {
        const prev = this.state.offline;
        const o = step.offline;
        const qr = o?.qrDataUrl && isPngDataUrl(o.qrDataUrl) ? o.qrDataUrl : prev?.qrDataUrl ?? null;
        const attemptsLeft = typeof o?.attemptsLeft === 'number' ? o.attemptsLeft : null;
        this.set({
          ...base,
          phase: 'offline',
          error: null,
          offline: {
            qrDataUrl: qr,
            challengeCode: o?.challengeCode ?? prev?.challengeCode ?? null,
            totpAvailable: o?.totpAvailable ?? prev?.totpAvailable ?? false,
            attemptsLeft,
          },
          // A wrong QR code comes back with attemptsLeft; a wrong time-based code with reason invalid_code.
          codeError: step.reason === 'invalid_code' || attemptsLeft !== null ? this.texts.invalidCode(attemptsLeft) : null,
        });
        return;
      }
      default:
        this.set({ ...base, phase: 'error', error: describeApprovalStep(step, this.texts) });
    }
  };

  private set(patch: Partial<ApprovalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      try { listener(this.state); } catch (err) { console.error('[TouchQue] approval listener failed:', err); }
    }
  }
}

/** Only an inline PNG: a relay must not point an image at an arbitrary (tracking) URL. */
export function isPngDataUrl(url: unknown): url is string {
  return typeof url === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url);
}

/** "1:05" until `expiresAt`, or null when it is past or more than 15 minutes away (a wrong clock). */
export function approvalTimeLeft(expiresAt: string | null | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const left = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (!Number.isFinite(left) || left <= 0 || left > 15 * 60) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** The headless approval dialog. Render its state with `<touchque-approval>`, `@touchque/react`, or your own UI. */
export function createApproval(config: TouchQueWebConfig, options: ApprovalOptions = {}): ApprovalController {
  return new ApprovalController(config, options);
}
