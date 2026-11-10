/**
 * lizaIP Panel — Styles: Diagnostics menu, pill and progress dialog.
 *
 * One slice of the panel stylesheet. The barrel module one directory up
 * joins the slices back together in source order; nothing else imports
 * this file. The join is order-sensitive -- later rules win ties on
 * specificity -- so a slice must keep its position in that list.
 *
 * No backtick may appear anywhere in this file but the pair delimiting the
 * literal below, not even in a comment quoting a CSS identifier: the first
 * stray one ends the string and everything after it parses as code.
 */
export const STYLES_DIAGNOSTICS = `
  /* --- Diagnostics menu, pill and progress dialog --- */
  /* The ⋮ that offers the three downloads. HA's icon button, so it is the
     same size as every other icon control in the toolbar. */
  .diag-menu-btn {
    flex: 0 0 auto;
    color: var(--liza-muted-text);
  }
  /* On the accent-filled toolbar the muted grey disappears; there the button
     borrows the bar's own text colour, as the tabs beside it do. */
  /* The help toggle, beside the overflow menu it came out of. Same metrics
     as the menu button so the pair reads as one group of toolbar controls. */
  .guide-btn {
    flex: 0 0 auto;
    color: var(--liza-muted-text);
  }
  /* Pressed is a state, not a hover: with the guide docked the button stays
     lit, so the toolbar says where the panel's missing width went. */
  .guide-btn[aria-pressed="true"] {
    color: var(--primary-color, #03a9f4);
    background: var(--secondary-background-color);
    border-radius: 50%;
  }
  .toolbar .guide-btn { color: var(--primary-text-color, #fff); }

  .toolbar .diag-menu-btn {
    color: inherit;
    margin-left: 4px;
  }
  /* In a device row the ⋮ must not shove the status badge around, and it is
     only worth noticing once the pointer is on the row it belongs to. */
  .device-item .diag-menu-btn {
    margin-left: 4px;
    opacity: 0.55;
  }
  .device-item:hover .diag-menu-btn,
  .device-item .diag-menu-btn:focus-within {
    opacity: 1;
  }

  /* The dismissed builds, parked where a snackbar would be. Fixed, because a
     build outlives whichever screen started it, and stacked because the
     configuration and diagnostics lanes can run at the same time. */
  .diag-pills {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .diag-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 32px);
    padding: 8px 14px;
    border: none;
    border-radius: 999px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    font-size: 13px;
    cursor: pointer;
    --mdc-icon-size: 18px;
  }
  .diag-pill.running ha-icon { color: var(--primary-color, #03a9f4); }
  .diag-pill.error ha-icon { color: var(--error-color, #db4437); }

  .diag-dialog {
    text-align: left;
  }
  .diag-dialog-bar {
    height: 4px;
    margin: 12px 0 4px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--divider-color, #e0e0e0);
  }
  .diag-dialog-bar > div {
    height: 100%;
    background: var(--primary-color, #03a9f4);
    transition: width 0.2s ease;
  }
  .diag-steps {
    margin: 8px 0 0;
    padding: 0 0 8px;
    list-style: none;
    max-height: 46vh;
    overflow-y: auto;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  /* The heading a run of steps belongs under. Quiet and sticky: the list
     scrolls, and a row that has scrolled away from its heading is a row
     whose "Status" could be the remote's or Home Assistant's. */
  .diag-group {
    position: sticky;
    top: 0;
    padding: 10px 2px 4px;
    background: var(--card-background-color, #fff);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--liza-muted-text);
  }
  .diag-group:first-child { padding-top: 2px; }
  .diag-step {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 2px 5px 6px;
    font-size: 13px;
    color: var(--liza-muted-text);
  }
  .diag-step.done,
  .diag-step.running {
    color: var(--primary-text-color, #212121);
  }
  .diag-step-mark {
    flex: 0 0 auto;
    width: 16px;
    text-align: center;
    font-size: 12px;
  }
  .diag-step.done .diag-step-mark { color: var(--success-color, #4caf50); }
  .diag-step.running .diag-step-mark { color: var(--primary-color, #03a9f4); }
  /* The one row that is actually happening, told apart without relying on the
     colour alone. */
  .diag-step.running .diag-step-label { font-weight: 500; }
  .diag-step-label { flex: 1 1 auto; }
  .diag-step-state {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--liza-muted-text);
  }
  /* What the file carries. Quieter than the result above it -- it is a caution,
     not the outcome -- but on the same screen as the download. */
  .diag-dialog-privacy {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.45;
  }
  /* The list, then the two notes, then the button: each separated enough to
     be read as its own thing rather than as one block of small grey text. */
  .diag-dialog > .config-field-hint { margin-top: 12px; }
  .diag-dialog > .template-dialog-actions { margin-top: 18px; }
  .diag-dialog-error {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--error-color, #db4437);
    overflow-wrap: anywhere;
  }
  @media (prefers-reduced-motion: reduce) {
    .diag-dialog-bar > div { transition: none; }
  }
`;
