// The approval dialog's stylesheet, shared by `<touchque-approval>` (inside
// its shadow root) and `@touchque/react`'s `<TouchQueApproval>` (as a
// <style> next to the dialog). Every selector is under `.tq-approval`, so in
// a page's light DOM it touches nothing else.
//
// Theme it with CSS custom properties on the element (or the React
// component's `className` / `style`):
//   --tq-approval-accent      buttons, focus ring          (default #111827)
//   --tq-approval-accent-fg   text on the accent           (#ffffff)
//   --tq-approval-bg / -fg    card background / text       (#ffffff / #111827)
//   --tq-approval-muted       secondary text               (#4b5563)
//   --tq-approval-border      lines and fields             (#e5e7eb)
//   --tq-approval-danger      errors                       (#b42318)
//   --tq-approval-radius      card corners                 (16px)
//   --tq-approval-font        font stack                   (system-ui)
// `theme="dark"` (or `auto`, following the system) switches the defaults.

export const APPROVAL_STYLES = `
.tq-approval {
  --_accent: var(--tq-approval-accent, #111827);
  --_accent-fg: var(--tq-approval-accent-fg, #ffffff);
  --_bg: var(--tq-approval-bg, #ffffff);
  --_fg: var(--tq-approval-fg, #111827);
  --_muted: var(--tq-approval-muted, #4b5563);
  --_border: var(--tq-approval-border, #e5e7eb);
  --_soft: var(--tq-approval-soft, #f9fafb);
  --_danger: var(--tq-approval-danger, #b42318);
  --_danger-soft: var(--tq-approval-danger-soft, #fef3f2);
  --_ok: var(--tq-approval-ok, #067647);
  --_radius: var(--tq-approval-radius, 16px);
  box-sizing: border-box;
  width: min(400px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: auto;
  margin: auto;
  padding: 0;
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  background: var(--_bg);
  color: var(--_fg);
  font: 15px/1.5 var(--tq-approval-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  box-shadow: 0 24px 48px -12px rgba(16, 24, 40, 0.25);
}
.tq-approval[data-theme="dark"] {
  --_accent: var(--tq-approval-accent, #f9fafb);
  --_accent-fg: var(--tq-approval-accent-fg, #111827);
  --_bg: var(--tq-approval-bg, #161b26);
  --_fg: var(--tq-approval-fg, #f5f5f6);
  --_muted: var(--tq-approval-muted, #94969c);
  --_border: var(--tq-approval-border, #333741);
  --_soft: var(--tq-approval-soft, #1f242f);
  --_danger: var(--tq-approval-danger, #f97066);
  --_danger-soft: var(--tq-approval-danger-soft, #2b1614);
  --_ok: var(--tq-approval-ok, #47cd89);
}
@media (prefers-color-scheme: dark) {
  .tq-approval[data-theme="auto"] {
    --_accent: var(--tq-approval-accent, #f9fafb);
    --_accent-fg: var(--tq-approval-accent-fg, #111827);
    --_bg: var(--tq-approval-bg, #161b26);
    --_fg: var(--tq-approval-fg, #f5f5f6);
    --_muted: var(--tq-approval-muted, #94969c);
    --_border: var(--tq-approval-border, #333741);
    --_soft: var(--tq-approval-soft, #1f242f);
    --_danger: var(--tq-approval-danger, #f97066);
    --_danger-soft: var(--tq-approval-danger-soft, #2b1614);
    --_ok: var(--tq-approval-ok, #47cd89);
  }
}
.tq-approval::backdrop { background: rgba(12, 17, 29, 0.55); }
.tq-approval *, .tq-approval *::before, .tq-approval *::after { box-sizing: border-box; }
.tq-approval .tq-card { position: relative; display: flex; flex-direction: column; padding: 28px 24px 20px; }
.tq-approval .tq-icon {
  width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--_border); border-radius: 12px; color: var(--_fg);
}
.tq-approval .tq-icon svg { width: 24px; height: 24px; }
.tq-approval .tq-icon[data-tone="ok"] { color: var(--_ok); }
.tq-approval .tq-icon[data-tone="danger"] { color: var(--_danger); }
.tq-approval .tq-title { margin: 16px 0 0; font-size: 20px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; }
.tq-approval .tq-text { margin: 6px 0 0; color: var(--_muted); }
.tq-approval .tq-x {
  position: absolute; top: 12px; right: 12px; width: 36px; height: 36px; border: 0; border-radius: 8px;
  background: transparent; color: var(--_muted); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.tq-approval .tq-x:hover { background: var(--_soft); color: var(--_fg); }
.tq-approval .tq-x svg { width: 20px; height: 20px; }
.tq-approval .tq-panel { margin-top: 20px; padding: 16px; border: 1px solid var(--_border); border-radius: 12px; background: var(--_soft); text-align: center; }
.tq-approval .tq-label { margin: 0; font-size: 13px; font-weight: 500; color: var(--_muted); }
.tq-approval .tq-digits { display: flex; justify-content: center; gap: 8px; margin-top: 12px; user-select: none; }
.tq-approval .tq-digit {
  width: 48px; height: 56px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--_border); border-radius: 10px; background: var(--_bg);
  font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.tq-approval .tq-digits[data-size="small"] .tq-digit { width: 34px; height: 40px; font-size: 20px; }
.tq-approval .tq-status { display: flex; align-items: center; gap: 8px; margin: 16px 0 0; font-size: 14px; color: var(--_muted); }
.tq-approval .tq-status .tq-time { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tq-approval .tq-spinner {
  width: 14px; height: 14px; flex: none; border-radius: 50%;
  border: 2px solid var(--_border); border-top-color: var(--_fg); animation: tq-spin 0.8s linear infinite;
}
@keyframes tq-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tq-approval .tq-spinner { animation-duration: 2.4s; } }
.tq-approval .tq-why { margin-top: 14px; font-size: 13px; color: var(--_muted); }
.tq-approval .tq-why summary { cursor: pointer; font-weight: 500; }
.tq-approval .tq-why ul { margin: 6px 0 0; padding-left: 18px; }
.tq-approval .tq-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--_border); font-size: 14px; color: var(--_muted); }
.tq-approval .tq-qr { display: block; width: 200px; height: 200px; margin: 0 auto; image-rendering: pixelated; background: #fff; border-radius: 8px; }
.tq-approval .tq-field { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; text-align: left; }
.tq-approval .tq-field label { font-size: 13px; font-weight: 500; }
.tq-approval .tq-input {
  width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--_border); border-radius: 10px;
  background: var(--_bg); color: var(--_fg); font: inherit; font-size: 17px; letter-spacing: 0.08em; text-transform: uppercase;
}
.tq-approval .tq-input:focus { outline: 2px solid var(--_accent); outline-offset: 1px; }
.tq-approval .tq-input[aria-invalid="true"] { border-color: var(--_danger); }
.tq-approval .tq-hint { margin: 0; font-size: 13px; color: var(--_danger); }
.tq-approval .tq-btn {
  width: 100%; min-height: 44px; margin-top: 16px; padding: 0 16px; border: 1px solid var(--_accent); border-radius: 10px;
  background: var(--_accent); color: var(--_accent-fg); font: inherit; font-weight: 500; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
.tq-approval .tq-btn:disabled { opacity: 0.55; cursor: default; }
.tq-approval .tq-btn:focus-visible, .tq-approval .tq-link:focus-visible, .tq-approval .tq-x:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
.tq-approval .tq-btn[data-variant="quiet"] { margin-top: 6px; border-color: transparent; background: transparent; color: var(--_muted); }
.tq-approval .tq-btn[data-variant="quiet"]:hover { color: var(--_fg); }
.tq-approval .tq-link { padding: 0; border: 0; background: none; color: var(--_fg); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.tq-approval .tq-alert { margin-top: 16px; padding: 12px; border: 1px solid var(--_danger); border-radius: 10px; background: var(--_danger-soft); color: var(--_danger); font-size: 14px; }
.tq-approval .tq-note { margin-top: 14px; font-size: 14px; color: var(--_danger); }
.tq-approval .tq-case { display: block; margin-top: 6px; font-size: 13px; color: var(--_muted); }
.tq-approval .tq-case code, .tq-approval .tq-codes code { font: 600 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--_fg); }
.tq-approval .tq-codes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; margin: 8px 0 0; padding: 0; list-style: none; text-align: left; }
.tq-approval .tq-small { margin: 12px 0 0; font-size: 13px; color: var(--_muted); text-align: left; }
.tq-approval .tq-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
