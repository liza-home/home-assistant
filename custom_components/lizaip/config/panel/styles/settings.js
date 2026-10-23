/**
 * lizaIP Panel — Styles: Settings tab.
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
export const STYLES_SETTINGS = `
  /* --- Settings tab --- */
  .settings-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
    max-width: 640px;
  }
  .settings-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 0 16px 16px;
  }
  /* The step field gets what .config-field gives its text inputs, but not its
     width: it holds two digits, and a full-width box reads as a place to type
     a sentence. Same reason .slider-factor-input is narrowed. */
  .settings-body input[type="number"] {
    width: 88px;
    padding: 10px 12px;
    border: 1px solid var(--divider-color);
    border-radius: 8px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font-size: var(--liza-font-m);
    font-family: inherit;
    box-sizing: border-box;
  }
  .settings-body input[type="number"]:focus {
    outline: none;
    border-color: var(--primary-color);
  }
  /* Left-aligned, unlike .hint-text, which is the centred empty-state style
     for a view with nothing in it yet. Centring a card's opening sentence sets
     it adrift from the fields it introduces. */
  .settings-card-description {
    margin: 0;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-s);
    line-height: 1.45;
  }
  .settings-switch-list {
    display: flex;
    flex-direction: column;
  }
  /* The control sits on the right of the name it belongs to, the way HA's own
     settings rows read, so the eye runs name → explanation → state. */
  .settings-switch-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 0;
    border-top: 1px solid var(--divider-color, rgba(127,127,127,.15));
  }
  .settings-switch-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .settings-switch-text label {
    font-size: var(--liza-font-m);
    font-weight: 500;
    color: var(--primary-text-color);
    cursor: pointer;
  }
  .settings-switch-text .config-field-hint { margin-top: 0; }
  .settings-switch-row ha-switch { flex: none; margin-top: 2px; }
  /* Indented under the switch it depends on, and dimmed rather than hidden
     while that switch is off: a field that vanishes leaves the user unsure
     whether it still exists. */
  .settings-switch-detail {
    padding: 2px 0 14px 16px;
    border-left: 2px solid var(--divider-color, rgba(127,127,127,.15));
    margin-left: 4px;
  }
  .settings-switch-detail.is-off { opacity: .45; }
  /* A two-digit number in a full-width box reads as a text field. The unit
     sits beside it rather than in the hint, where it has to be hunted for. */
  .settings-step-input { display: flex; align-items: center; gap: 8px; }
  .settings-step-input input { flex: none; }
  .settings-range-input input[type="range"] { flex: 1 1 auto; min-width: 0; accent-color: var(--primary-color); }
  .settings-range-value { min-width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; }
  .settings-step-unit {
    color: var(--liza-muted-text);
    font-size: var(--liza-font-m);
  }
  /* Dark like the remote's own screen, so the preview shows the text the
     way it will be seen there. */
  .settings-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 64px;
    border-radius: 8px;
    background: #000;
  }
  .settings-preview img {
    max-width: 100%;
  }
  .settings-fonts-hint {
    text-align: left;
  }
  .settings-actions {
    display: flex;
    gap: 8px;
  }
`;
