// <touchque-approval>: the drop-in approval dialog, as a framework-free web
// component.
//
//   import { defineTouchQueApproval } from '@touchque/web';
//   defineTouchQueApproval();
//
//   <touchque-approval base-url="/touchque" credentials="include"></touchque-approval>
//
//   const dialog = document.querySelector('touchque-approval');
//   const res = await dialog.fetch('/api/transfer', { method: 'POST', body });   // a guarded route
//   const signedIn = await dialog.login();                                       // classic push sign-in
//
// It opens only when your server asks for an approval and shows each step:
// the number to pick on the phone, the first-time link QR, the offline QR and
// code, the passkey button, and refusals with their case code. Escape or the
// close button cancels (the call rejects with an AbortError).
//
// Attributes: base-url (where touchqueRouter or your relay is mounted),
// credentials ('include' for a cookie session on another origin), theme
// ('light' default, 'dark', 'auto'). Properties: config (a full
// TouchQueWebConfig, wins over the attributes), options ({ texts,
// pollIntervalMs, telemetry, approvedMs }), approval (the controller).
// Events (bubbling, composed): touchque-step { step }, touchque-approved,
// touchque-error { error }, touchque-close.

import { ApprovalController, approvalTimeLeft, isPngDataUrl } from './approval';
import type { ApprovalOptions, ApprovalState, ApprovalTexts } from './approval';
import { formatOfflineCodeInput } from './offline';
import { APPROVAL_STYLES } from './approvalStyles';
import type { TouchQueWebConfig } from './types';

const SVG = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const APPROVAL_ICONS = {
  phone: SVG('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  key: SVG('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m17 6 3 3"/><path d="m14.5 8.5 2 2"/>'),
  check: SVG('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>'),
  alert: SVG('<circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16h.01"/>'),
  qr: SVG('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v.01"/><path d="M14 20h.01"/><path d="M17 20h4v-3"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

type Screen = { key: string; root: HTMLElement; update(state: ApprovalState): void };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: keyof typeof APPROVAL_ICONS, tone?: 'ok' | 'danger'): HTMLElement {
  const box = el('div', 'tq-icon');
  if (tone) box.dataset.tone = tone;
  box.innerHTML = APPROVAL_ICONS[name]; // constant markup only
  return box;
}

function button(text: string, onClick: () => void, variant?: 'quiet'): HTMLButtonElement {
  const b = el('button', 'tq-btn', text);
  b.type = 'button';
  if (variant) b.dataset.variant = variant;
  b.addEventListener('click', onClick);
  return b;
}

function digits(value: string, small = false): HTMLElement {
  const row = el('div', 'tq-digits');
  if (small) row.dataset.size = 'small';
  row.setAttribute('role', 'img');
  row.setAttribute('aria-label', value.split('').join(' '));
  for (const d of value) row.append(el('span', 'tq-digit', d));
  return row;
}

function caseLine(texts: ApprovalTexts, code: string | null): HTMLElement | null {
  if (!code) return null;
  const line = el('span', 'tq-case');
  const [before, after = ''] = texts.supportCode('\u0000').split('\u0000');
  line.append(before, el('code', undefined, code), after);
  return line;
}

function qrImage(src: string, alt: string): HTMLImageElement {
  const img = el('img', 'tq-qr');
  if (src) img.src = src;
  img.alt = alt;
  img.width = 200;
  img.height = 200;
  return img;
}

function screenKey(state: ApprovalState, controller: ApprovalController): string {
  if (state.phase === 'offline') return `offline:${controller.codeMode}`;
  if (state.phase === 'waiting') return `waiting:${state.step?.requestId ?? ''}`;
  return state.phase;
}

function buildScreen(state: ApprovalState, c: ApprovalController, titleId: string): Screen {
  const t = c.texts;
  const card = el('div', 'tq-card');
  const close = el('button', 'tq-x');
  close.type = 'button';
  close.setAttribute('aria-label', state.phase === 'error' || state.phase === 'approved' ? t.close : t.cancel);
  close.innerHTML = APPROVAL_ICONS.x;
  close.addEventListener('click', () => c.close());
  const title = (text: string) => { const h = el('h2', 'tq-title', text); h.id = titleId; return h; };
  const key = screenKey(state, c);

  switch (state.phase) {
    case 'waiting': {
      card.append(close, icon('phone'), title(t.waitingTitle), el('p', 'tq-text', t.waitingBody));
      if (state.number) {
        const panel = el('div', 'tq-panel');
        panel.append(el('p', 'tq-label', t.numberLabel), digits(state.number));
        card.append(panel);
      }
      const status = el('p', 'tq-status');
      status.setAttribute('role', 'status');
      const time = el('span', 'tq-time');
      status.append(el('span', 'tq-spinner'), t.waitingStatus, time);
      card.append(status);
      const why = el('details', 'tq-why');
      const list = el('ul');
      why.append(el('summary', undefined, t.whyTitle), list);
      card.append(why);
      const row = el('div', 'tq-row');
      const offline = el('button', 'tq-link', t.useOffline);
      offline.type = 'button';
      offline.addEventListener('click', () => c.useOffline());
      row.append(t.noNotification, offline);
      card.append(row, button(t.cancel, () => c.cancel(), 'quiet'));
      return {
        key,
        root: card,
        update(s) {
          time.textContent = approvalTimeLeft(s.expiresAt) ? t.expiresIn(approvalTimeLeft(s.expiresAt) as string) : '';
          why.hidden = s.reasons.length === 0;
          list.replaceChildren(...s.reasons.map((r) => el('li', undefined, r.text || r.code)));
          offline.disabled = s.busy;
        },
      };
    }

    case 'enroll': {
      card.append(close, icon('qr'), title(t.enrollTitle), el('p', 'tq-text', t.enrollBody));
      const panel = el('div', 'tq-panel');
      if (state.enroll && isPngDataUrl(state.enroll.qrCodeDataUrl)) panel.append(qrImage(state.enroll.qrCodeDataUrl, t.enrollTitle));
      card.append(panel);
      if (state.enroll?.recoveryCodes.length) {
        card.append(el('p', 'tq-small', t.recoveryCodes));
        const codes = el('ul', 'tq-codes');
        for (const code of state.enroll.recoveryCodes) { const li = el('li'); li.append(el('code', undefined, code)); codes.append(li); }
        card.append(codes);
      }
      card.append(button(t.cancel, () => c.cancel(), 'quiet'));
      return { key, root: card, update() { /* static */ } };
    }

    case 'offline': {
      const totp = c.codeMode === 'totp';
      card.append(close, icon('qr'), title(t.offlineTitle), el('p', 'tq-text', totp ? t.totpLabel : t.offlineBody));
      const panel = el('div', 'tq-panel');
      const img = qrImage(state.offline?.qrDataUrl || '', t.offlineTitle);
      const numberBox = el('div');
      if (!totp) {
        panel.append(img, numberBox);
        card.append(panel);
      }
      const form = el('form');
      form.noValidate = true;
      const field = el('div', 'tq-field');
      const inputId = `${titleId}-code`;
      const label = el('label', undefined, totp ? t.totpLabel : t.codeLabel);
      label.htmlFor = inputId;
      const input = el('input', 'tq-input');
      input.id = inputId;
      input.autocomplete = 'one-time-code';
      input.spellcheck = false;
      input.inputMode = totp ? 'numeric' : 'text';
      input.placeholder = totp ? '123456' : 'ABC-DEFG';
      input.maxLength = totp ? 7 : 8;
      if (!totp) input.addEventListener('input', () => { input.value = formatOfflineCodeInput(input.value); });
      const hint = el('p', 'tq-hint');
      hint.id = `${inputId}-hint`;
      hint.setAttribute('aria-live', 'polite');
      field.append(label, input, hint);
      const submit = el('button', 'tq-btn', t.submitCode);
      submit.type = 'submit';
      form.append(field, submit);
      form.addEventListener('submit', (e) => { e.preventDefault(); c.submitCode(input.value, totp ? 'totp' : 'qr'); });
      card.append(form);
      const switchRow = el('div', 'tq-row');
      const switchMode = el('button', 'tq-link', totp ? t.useQr : t.useTotp);
      switchMode.type = 'button';
      switchMode.addEventListener('click', () => c.setCodeType(totp ? 'qr' : 'totp'));
      switchRow.append(switchMode);
      card.append(switchRow, button(t.cancel, () => c.cancel(), 'quiet'));
      queueMicrotask(() => input.focus());
      let shownNumber: string | null = null;
      return {
        key,
        root: card,
        update(s) {
          const qr = s.offline?.qrDataUrl;
          if (qr && img.src !== qr) img.src = qr;
          const number = s.offline?.challengeCode ?? null;
          if (number !== shownNumber) {
            shownNumber = number;
            numberBox.replaceChildren(...(number ? [el('p', 'tq-label', t.offlineNumber), digits(number, true)] : []));
          }
          switchRow.hidden = !s.offline?.totpAvailable && !totp;
          hint.textContent = s.codeError ?? '';
          input.setAttribute('aria-invalid', s.codeError ? 'true' : 'false');
          if (s.codeError) input.setAttribute('aria-describedby', hint.id); else input.removeAttribute('aria-describedby');
          submit.disabled = s.busy;
          input.readOnly = s.busy;
        },
      };
    }

    case 'passkey': {
      card.append(close, icon('key'), title(t.passkeyTitle), el('p', 'tq-text', t.passkeyBody));
      const note = el('p', 'tq-note');
      note.setAttribute('role', 'status');
      const go = button(t.passkeyButton, () => { void c.continueWithPasskey(); });
      card.append(note, go, button(t.cancel, () => c.cancel(), 'quiet'));
      queueMicrotask(() => go.focus());
      return {
        key,
        root: card,
        update(s) {
          note.textContent = s.notice ?? '';
          note.hidden = !s.notice;
          go.disabled = s.busy;
          go.textContent = s.busy ? t.passkeyBusy : t.passkeyButton;
        },
      };
    }

    case 'approved': {
      const status = title(t.approvedTitle);
      status.setAttribute('role', 'status');
      card.append(close, icon('check', 'ok'), status);
      return { key, root: card, update() { /* static */ } };
    }

    case 'error':
    default: {
      card.append(close, icon('alert', 'danger'), title(t.errorTitle));
      const alert = el('div', 'tq-alert');
      alert.setAttribute('role', 'alert');
      card.append(alert);
      const done = button(t.close, () => c.close());
      card.append(done);
      queueMicrotask(() => done.focus());
      return {
        key,
        root: card,
        update(s) {
          const line = caseLine(t, s.error?.caseCode ?? s.caseCode);
          alert.replaceChildren(s.error?.message ?? t.errors.generic, ...(line ? [line] : []));
        },
      };
    }
  }
}

let instances = 0;

function createElementClass(): CustomElementConstructor {
  return class TouchQueApprovalElement extends HTMLElement {
    static get observedAttributes() { return ['base-url', 'credentials', 'theme']; }

    private controller: ApprovalController | null = null;
    private configValue: TouchQueWebConfig | null = null;
    private optionsValue: ApprovalOptions = {};
    private unsubscribe: (() => void) | null = null;
    private readonly dialog: HTMLDialogElement;
    private screen: Screen | null = null;
    private ticker: ReturnType<typeof setInterval> | undefined;
    private lastPhase = 'closed';
    private lastStep: unknown = null;
    private readonly titleId = `tq-approval-${++instances}`;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `:host{display:contents}${APPROVAL_STYLES}`;
      this.dialog = document.createElement('dialog');
      this.dialog.className = 'tq-approval';
      this.dialog.setAttribute('aria-labelledby', this.titleId);
      this.dialog.setAttribute('part', 'dialog');
      this.dialog.dataset.theme = this.getAttribute('theme') || 'light';
      // Escape: cancel through the controller, so the call ends too.
      this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.controller?.close(); });
      root.append(style, this.dialog);
    }

    /** A full `@touchque/web` config; wins over the base-url / credentials attributes. */
    get config(): TouchQueWebConfig | null { return this.configValue; }
    set config(value: TouchQueWebConfig | null) { this.configValue = value; this.reset(); }

    /** `{ texts, pollIntervalMs, telemetry, approvedMs }` */
    get options(): ApprovalOptions { return this.optionsValue; }
    set options(value: ApprovalOptions) { this.optionsValue = value ?? {}; this.reset(); }

    /** The headless controller behind the dialog (state, subscribe, …). */
    get approval(): ApprovalController {
      if (!this.controller) {
        const config = this.configValue ?? {
          baseUrl: this.getAttribute('base-url') || '',
          ...(this.getAttribute('credentials') && { credentials: this.getAttribute('credentials') as RequestCredentials }),
        };
        if (!config.baseUrl) throw new Error('<touchque-approval>: set the base-url attribute (or the config property).');
        this.controller = new ApprovalController(config, this.optionsValue);
        this.unsubscribe = this.controller.subscribe((s) => this.render(s));
      }
      return this.controller;
    }

    /** fetch() for a guarded route, with the dialog. See ApprovalController.fetch. */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { return this.approval.fetch(input, init); }

    /** Classic push sign-in through your relay, with the dialog. */
    login(input?: { externalUsername?: string }) { return this.approval.login(input); }

    cancel(): void { this.controller?.cancel(); }

    close(): void { this.controller?.close(); }

    attributeChangedCallback(name: string, oldValue: string | null, value: string | null) {
      if (oldValue === value) return;
      if (name === 'theme') { this.dialog.dataset.theme = value || 'light'; return; }
      if (!this.configValue) this.reset();
    }

    disconnectedCallback() {
      this.controller?.cancel();
    }

    private reset() {
      if (!this.controller) return;
      this.controller.cancel();
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.controller = null;
    }

    private emit(type: string, detail?: unknown) {
      this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    }

    private render(state: ApprovalState) {
      const c = this.controller;
      if (!c) return;
      if (state.step && state.step !== this.lastStep) this.emit('touchque-step', { step: state.step });
      this.lastStep = state.step;
      if (state.phase !== this.lastPhase) {
        if (state.phase === 'approved') this.emit('touchque-approved');
        if (state.phase === 'error') this.emit('touchque-error', { error: state.error });
        if (state.phase === 'closed') this.emit('touchque-close');
        this.lastPhase = state.phase;
      }

      if (state.phase === 'closed') {
        clearInterval(this.ticker);
        this.ticker = undefined;
        this.screen = null;
        this.dialog.replaceChildren();
        if (this.dialog.open) {
          if (typeof this.dialog.close === 'function') this.dialog.close(); else this.dialog.removeAttribute('open');
        }
        return;
      }

      const key = screenKey(state, c);
      if (!this.screen || this.screen.key !== key) {
        this.screen = buildScreen(state, c, this.titleId);
        this.dialog.replaceChildren(this.screen.root);
      }
      this.screen.update(state);
      if (!this.dialog.open) {
        if (typeof this.dialog.showModal === 'function') this.dialog.showModal(); else this.dialog.setAttribute('open', '');
      }
      // The countdown on the waiting screen.
      if (state.phase === 'waiting' && !this.ticker) {
        this.ticker = setInterval(() => { if (this.controller && this.screen) this.screen.update(this.controller.getState()); }, 1000);
      } else if (state.phase !== 'waiting' && this.ticker) {
        clearInterval(this.ticker);
        this.ticker = undefined;
      }
    }
  };
}

/**
 * Registers `<touchque-approval>` (or `tagName`) once. Safe to call more than
 * once and during server rendering (it does nothing without
 * `customElements`).
 */
export function defineTouchQueApproval(tagName = 'touchque-approval'): void {
  if (typeof window === 'undefined' || typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return;
  if (customElements.get(tagName)) return;
  customElements.define(tagName, createElementClass());
}

/** The element's public surface, for TypeScript: `document.querySelector('touchque-approval') as TouchQueApprovalElement`. */
export interface TouchQueApprovalElement extends HTMLElement {
  config: TouchQueWebConfig | null;
  options: ApprovalOptions;
  readonly approval: ApprovalController;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  login(input?: { externalUsername?: string }): ReturnType<ApprovalController['login']>;
  cancel(): void;
  close(): void;
}
