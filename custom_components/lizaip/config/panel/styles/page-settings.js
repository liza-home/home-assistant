/**
 * lizaIP Panel — Styles: Page settings: slider_horizontal and the colour picker.
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
export const STYLES_PAGE_SETTINGS = `
  /* --- Page Settings (slider_horizontal) --- */
  /* Metrics here deliberately match .config-card-header. The page
     settings card and the button config card render into the *same* slot in
     .config-layout -- selecting a button swaps one for the other in place -- so
     a difference in padding or icon size reads as the panel twitching rather
     than as two different screens. */
  .ps-title-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider-color, rgba(127,127,127,.2));
    flex-wrap: wrap;
  }
  .ps-title-subtitle {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }
  .ps-page-meta .ps-title-subtitle {
    display: block;
  }
  .ps-page-name {
    display: block;
    font-size: var(--liza-font-m);
    color: var(--primary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ps-page-meta-text {
    min-width: 0;
  }
  /* Half the banner: the "which page, of how many" line, beside the reorder
     arrows. Both are about the page rather than about any one item on it, so
     the banner stands down entirely while the title is open. The 40px floor is
     the arrows' own height -- without it the line alone would set a shorter
     banner on a card with nothing to reorder. */
  .ps-page-meta {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    min-height: 40px;
  }
  .ps-title-reorder {
    display: flex;
    gap: 4px;
    align-items: center;
    align-self: center;
    flex-shrink: 0;
  }
  /* The title's Image field, which now lives in the card body rather than in
     the banner: it is the same .config-field the button card's Image is, so it
     needs no geometry of its own beyond sitting flush with the section under
     it. The rename row that used to be here -- a display arm, an editor arm and
     a tick/cross pair, each sized against the other -- is gone with the design
     it served. */
  .ps-title-editor .config-field { margin: 0; }
  /* A banner with nothing under it closes the card: the rule would draw a
     line between the page row and the card's own edge. */
  .ps-title-banner:last-child { border-bottom: none; }
  .ps-body { gap: 12px !important; }
  .ps-section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--divider-color, #e0e0e0);
  }
  .ps-section-title {
    font-size: var(--liza-font-13);
    font-weight: 600;
    color: var(--primary-text-color);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ps-template-target-btn {
    width: 100%;
  }
  .ps-template-target-name {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* --- Page Settings: Color Picker --- */
  .ps-color-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 0;
    align-items: center;
  }
  .ps-color-dot {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    transition: transform .15s, border-color .15s, box-shadow .15s;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.15);
    position: relative;
  }
  .ps-color-dot:hover { transform: scale(1.12); }
  .ps-color-dot.active {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 2px var(--primary-color), inset 0 0 0 1px rgba(0,0,0,.12);
  }
  .ps-color-dot.active::after {
    content: "✓";
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--liza-font-m);
    font-weight: 700;
    color: rgba(0,0,0,.55);
    pointer-events: none;
  }
  .ps-color-row {
    display: flex;
    align-items: center;
    /* Wrapping so a validation message can take a full line of its own below
       the row rather than being squeezed between the swatch and the box. */
    flex-wrap: wrap;
    gap: 8px;
    padding: 4px 0 0;
  }

  /* Validation messages.
     Never colour alone: the message is words, and it is placed next to the
     field it is about, so 1.4.1 does not depend on anyone seeing red. The
     border on the invalid control is a second, non-colour cue for the same
     reason -- a shape change, not just a hue change. */
  .field-error {
    display: block;
    flex-basis: 100%;
    margin-top: 4px;
    font-size: var(--liza-font-s);
    line-height: 1.35;
    color: var(--liza-error-text);
  }
  .field-error:empty { display: none; }

  :host [aria-invalid="true"] {
    border-color: var(--error-color, #db4437);
    box-shadow: 0 0 0 1px var(--error-color, #db4437);
  }
  .ps-color-native {
    -webkit-appearance: none;
    appearance: none;
    width: 28px;
    height: 28px;
    border: 1px solid var(--divider-color, #444);
    border-radius: 6px;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
    background: none;
  }
  .ps-color-native::-webkit-color-swatch-wrapper { padding: 2px; }
  .ps-color-native::-webkit-color-swatch { border: none; border-radius: 4px; }
  .ps-color-native::-moz-color-swatch { border: none; border-radius: 4px; }
  .ps-color-input {
    width: 120px;
    font-family: monospace;
  }
`;
