/**
 * lizaIP Panel — Styles: Slider config UI.
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
export const STYLES_SLIDER = `
  /* --- Slider Config UI --- */
  /* ha-entity-picker draws its own label above its own field box. A border
     here would wrap both and read as a box inside a box, which is what the
     stripped-fill styling this replaced ended up doing. */
  .slider-entity-picker-container ha-entity-picker {
    display: block;
    width: 100%;
  }
  /* Monospace because these are identifiers -- an attribute, a service, a
     data key, an entity id -- where one wrong character is the whole bug. */
  .slider-attribute-input,
  .slider-service-input,
  .slider-entity-fallback,
  .slider-datakey-input {
    width: 100%;
    font-family: monospace;
  }
  .config-field-hint {
    display: block;
    margin-top: 4px;
    font-size: var(--liza-font-s);
    line-height: 1.35;
    /* No measure cap here. A 62ch limit used to sit on this rule, on the
       argument that prose across a full panel is a poor measure -- but the card
       this hint lives in is already narrower than that on every screen it is
       used on, so the cap never protected a long line. What it did do was wrap
       every hint several words early, short of the field above it, which reads
       as text running into something invisible. The card is the measure. */
    color: var(--liza-muted-text);
  }
  .config-field-hint:empty { display: none; }
  /* Prefilling an autocomplete is a *suggestion*, so it is drawn as one: the
     chip pattern, under the field it fills, captioned with its reason. It was
     an underlined word at the end of the hint -- prose pretending to be a
     control, and the commonest action on the card set quieter than anything
     else on it -- and then a lone button, which read as the card's submit
     action and still never said why that device.

     Drawn in the primary colour and tinted, because "quiet outline" was the
     same complaint one step smaller: the empty picker above it is the state
     this chip exists to resolve, and it was the faintest thing on the card.
     Still sized to its text and left-aligned under the field, so it reads as
     something that types into that field rather than as the card's submit. */
  .slider-ctx-suggest {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  /* The caption is the long element now: it carries the device's icon and its
     name, and the chip beside it is three words. So the icon alignment and the
     ellipsis live here, and the row shrinks the device's name rather than
     pushing the button it exists to offer off the edge. The nowrap on the
     wrapper keeps the lead-in on one line: it is an anonymous flex item, so
     without it the words break up while the name beside them stays whole.
     NB: no backticks in this comment; it sits inside a template literal. */
  .slider-ctx-suggest-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    white-space: nowrap;
    font-size: var(--liza-font-s);
    color: var(--liza-muted-text);
  }
  .slider-ctx-suggest-label > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .slider-ctx-use-default {
    flex: none;
  }
  /* The entity-derived section sits in a wrapper so it can be rebuilt without
     tearing down the action editor (see _refreshButtonEntitySections). The
     wrapper is emitted even when it holds no field -- the refresh can empty a
     host that exists but cannot create one that does not -- and display:contents
     is what keeps that harmless: it generates no box, so an empty wrapper is not
     a flex item of .cch-editor-inner and does not spend one of its 16px gaps on
     nothing. Non-empty, the same rule promotes the field to a direct flex item,
     so it is spaced like the Label beside it.
     NB: no backticks in this comment; it sits inside a template literal. */
  #config-card-appearance { display: contents; }
  /* The same contract, for the same reason -- see above. This host was added
     later and had no rule at all, so on a button with no cycle it was an empty
     div spending one of .cch-editor-inner's 16px gaps on nothing, and with a
     cycle it stacked that gap on top of the section's own margin. */
  #config-card-presses { display: contents; }
  .config-field-hint code,
  .slider-warning code {
    font-family: monospace;
    font-size: var(--liza-font-11);
    padding: 1px 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--primary-text-color, #333) 8%, transparent);
  }
  .slider-warning {
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--warning-color, #ffa726);
    background: color-mix(in srgb, var(--warning-color, #ffa726) 12%, transparent);
    color: var(--primary-text-color, #333);
    font-size: var(--liza-font-s);
    line-height: 1.4;
  }
  /* The details itself is padding-free so the summary background can reach its
     edges; the body carries the inset. */
  .slider-advanced-body {
    display: flex;
    flex-direction: column;
    padding: 14px 12px;
  }
  .slider-advanced-body > .config-field { margin-bottom: 12px; }
  /* Separates the safe tunables above from the plumbing below, which silently
     breaks the slider when it is wrong. */
  .slider-advanced-body > .config-section-divider { margin: 10px 0 14px; }
  .slider-range-row {
    display: flex;
    /* .config-field sets column; without this the row silently stacks. */
    flex-direction: row;
    gap: 12px;
  }
  .slider-range-row > ha-input {
    flex: 1;
    min-width: 0;
  }
  /* Sensitivity holds a single number like "1" — a full-width box for it
     looks broken, and unlike Min/Max it isn't sharing a row with anything. */
  .slider-factor-input { width: 140px; }

  /* Most domains offer exactly one control, so the Control field states a fact
     rather than offering a choice. Sized and spaced like the inputs it stands
     in for, but without their border — a box would still read as editable. */
  /* Read-only statement of what the page's buttons do to this slider. Quieter
     than a warning and quieter than a field: it is neither a problem nor
     something to edit. */
  .slider-page-summary {
    margin: -2px 0 10px;
    padding: 7px 10px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--primary-text-color, #fff) 5%, transparent);
    color: var(--liza-muted-text);
    font-size: var(--liza-font-s);
    line-height: 1.45;
  }

  .slider-control-static {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    font-size: var(--liza-font-m);
    color: var(--primary-text-color, #333);
  }
  .slider-control-static ha-icon { color: var(--liza-muted-text); }

  /* Marks a config that no longer matches any preset, so a hand-edit is
     visible while Advanced is still collapsed. */
  .slider-advanced-tag {
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 0 6px;
    border-radius: 9px;
    font-size: var(--liza-font-11);
    font-weight: 500;
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 15%, transparent);
    color: var(--liza-accent-text);
  }
  .slider-reset-control {
    align-self: flex-start;
    margin-top: 10px;
  }
  /* Says which scope a section writes to, for the one card where a section's
     scope differs from the card's. Same shape as .slider-advanced-tag but
     neutral: that one flags a state worth fixing, this one is a plain fact
     about where an edit lands. Lowercase against the uppercase heading, so it
     reads as an aside rather than as part of the title. */
  .config-scope-tag {
    display: inline-flex;
    align-items: center;
    min-height: 16px;
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: var(--liza-font-xs);
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    background: color-mix(in srgb, var(--secondary-text-color, #888) 14%, transparent);
    color: var(--liza-muted-text);
    cursor: help;
  }
`;
