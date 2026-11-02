/**
 * lizaIP Panel — Styles: Button grid: nesting marks and the fixed controls.
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
export const STYLES_GRID = `
  /* --- Nesting marks: what the fixed controls do under the selected grid
     button ------------------------------------------------------------------
     Slotted here, after the rocker and slider rules, deliberately: those carry
     the same specificity (class + two attributes), so a mark placed earlier
     would lose to the cap's "fill: transparent" and never appear on the volume
     buttons. Every rule keeps ":not([selected])" so the blue selection above
     still wins outright — the mark says "this differs", selection says "you are
     editing this", and the second is the louder statement.

     Three exclusive marks, one attribute:
       context      — the grid button whose overrides are in play
       overridden   — a fixed control this button changes
       inheritable  — a fixed control this button leaves to the page

     "inheritable" is drawn at all, rather than left bare, because the point of
     lighting the set is to say "these five are editable from here". Bare is
     what every other page looks like. */
  .pg-svg-container .button[mark="context"]:not([selected]) {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 22%, transparent);
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1;
    stroke-dasharray: 3,2;
  }
  .pg-svg-container .button[mark="inheritable"]:not([selected]) {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 7%, transparent);
    stroke: color-mix(in srgb, var(--primary-color, #03a9f4) 35%, transparent);
    stroke-width: 0.6;
  }
  .pg-svg-container .button[mark="overridden"]:not([selected]) {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 20%, transparent);
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1.2;
  }
  /* The button whose configuration is waiting to be put somewhere else. Drawn
     with the accent it shares with the nesting marks — it is the same "the
     panel is holding something about this button" — but dashed and empty
     rather than filled, because the state it shows is that the tile is about
     to be *vacated*. It never appears beside them: _faceMark returns this
     one alone while a move is armed.

     No :not([selected]) guard, unlike every mark above, and the second
     selector is there to win the specificity race the first one loses: the
     armed button is usually the selected one — arming it is two gestures on
     the tile you were just editing — and the mark has to survive that or it
     shows on no button at all in the common case. */
  .pg-svg-container .button[mark="moving"],
  .pg-svg-container .button[mark="moving"]:not([configured]) {
    fill: none;
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1.4;
    stroke-dasharray: 4,3;
  }
  /* The slot a drag is about to land on: the filled counterpart of the dashed
     "moving" mark, drawn more strongly than the hover it replaces. No
     ":not([selected])" for the same reason the moving mark has none. */
  .pg-svg-container .button[drop],
  .pg-svg-container .button[drop]:hover {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 28%, transparent);
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1.6;
    stroke-dasharray: none;
  }
  /* The dragged button in flight, cloned into the same <svg> so the thumbnail's
     transform and clipping apply to it exactly as they do to the face. Carries
     no "data-key", so nothing per-key out-specifies it. "pointer-events: none"
     is load-bearing: the ghost sits under the pointer for the whole drag, and
     a hit test that found it would never report the slot it is covering. */
  .pg-svg-container .button[ghost] {
    pointer-events: none;
    /* Translucent because the ghost paints last, directly over the slot being
       aimed at. An opaque body would hide the drop ring the drag exists to
       read -- the fill is the part that occludes, so it gives way. */
    fill: color-mix(in srgb, var(--card-background-color, #fff) 55%, transparent);
    /* Thin and neutral, so it never reads as a second ring beside the accent
       one. Accent means "lands here", and nothing else may use it mid-drag. */
    stroke: color-mix(in srgb, var(--primary-text-color) 30%, transparent);
    stroke-width: 1;
    stroke-dasharray: none;
  }
  /* The icon stays legible: it is the only thing saying *which* button is in
     hand, and far too small to hide a ring drawn at the slot's edge. */
  .pg-svg-container .pg-btn-img[ghost] {
    opacity: 0.9;
  }
  /* The far half of the swap, previewed in the slot the drag emptied. Dimmed
     because it is a prediction: "and this comes back here", not "this is
     here now". */
  .pg-svg-container .pg-btn-img[returning] {
    opacity: 0.45;
    animation: liza-swap-in .12s ease-out;
  }
  /* A fresh element every time the pointer crosses a slot, so the entrance is
     a keyframe rather than a transition -- there is no previous value to move
     from. No "to": it ends on whatever the rule above says. */
  @keyframes liza-swap-in {
    from { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    /* The preview stays -- it is the answer to the question being asked. Only
       the fade goes. */
    .pg-svg-container .pg-btn-img[returning] { animation: none; }
  }
  /* What sells the lift. Soft and low-contrast so it shades the face rather
     than drawing an outline of its own around the ghost. */
  .pg-svg-container .button[ghost],
  .pg-svg-container .pg-btn-img[ghost] {
    filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.3));
  }
  /* Advertises the gesture, which otherwise hides inside a menu. The title bar
     and vertical slider are excluded because neither holds a button config
     (see "isMovableSlot"). Pointer-gated like the thumbnail grow. */
  @media (hover: hover) and (pointer: fine) {
    .pg-svg-container .button[configured]:not([data-key="slider_horizontal"]):not([data-key="slider_vertical"]) {
      cursor: grab;
    }
  }
  /* A live drag spends most of its life between shapes, and pointer capture
     redirects events but not the cursor, so it is stated on the host.
     "!important" to outrank every cursor the drag passes over. */
  :host(.face-dragging),
  :host(.face-dragging) * {
    cursor: grabbing !important;
  }
  /* Over no tile at all, where there is nothing to put a ring on. The source
     tile is excluded in "paintTarget": a refusal shown the instant a button is
     picked up reads as an error, not as the absence of a destination. */
  :host(.face-dragging.face-no-drop),
  :host(.face-dragging.face-no-drop) * {
    cursor: no-drop !important;
  }
  /* The vertical slider takes the mark as fill only: it keeps its ordinary
     outline, and the mark adds no *highlight* ring on top. (The stroke below is
     that ordinary outline, copied from the [configured] rule above — not a mark
     of its own. Setting it to none here would strip the pill's border the
     moment a context marked it.) The ring being refused is the accent one the
     generic [mark=] rules draw. It is a pill running
     y=238..309 with the two r=13 volume caps drawn *after* it at cy=238 and
     cy=309, covering both ends outright — a stroke on it survives only as two
     disconnected vertical scratches down the exposed middle band, which reads
     as broken rendering rather than as a highlight. So the middle band's fill
     is the whole mark, matching how [empty]/[configured] already treat it.
     The fill is repeated here rather than inherited from the [mark=] rules
     above: the existing [data-key="slider_vertical"][configured] rule carries a
     higher specificity than a bare [mark=] selector and would otherwise keep
     painting the pill its ordinary grey. Keep these two values in sync with
     the [mark=] block. */
  .pg-svg-container .button[data-key="slider_vertical"][mark="inheritable"]:not([selected]),
  .pg-svg-container .button[data-key="slider_vertical"][mark="inheritable"]:not([selected]):hover {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 7%, transparent);
    stroke: var(--divider-color, rgba(127,127,127,.3));
    stroke-width: 0.6;
  }
  .pg-svg-container .button[data-key="slider_vertical"][mark="overridden"]:not([selected]),
  .pg-svg-container .button[data-key="slider_vertical"][mark="overridden"]:not([selected]):hover {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 20%, transparent);
    stroke: var(--divider-color, rgba(127,127,127,.3));
    stroke-width: 0.6;
  }
  /* No "mark=moving" or "[drop]" rule here on purpose: the slider exchanges no
     button configurations at all (see "isMovableSlot"), so it takes neither.
     Restore both from git if it is ever let back in. */

  /* The caps do take part, but their per-key rules above score four against
     the generic marks' three, so restate both here at matching specificity.
     The ":hover" twins are load-bearing -- the caps' own hover rules reach
     five. Keep the values in sync with the generic blocks above. */
  .pg-svg-container .button[data-key="button_volume_up"][mark="moving"],
  .pg-svg-container .button[data-key="button_volume_down"][mark="moving"],
  .pg-svg-container .button[data-key="button_volume_up"][mark="moving"]:hover,
  .pg-svg-container .button[data-key="button_volume_down"][mark="moving"]:hover {
    fill: none;
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1.4;
    stroke-dasharray: 4,3;
  }
  .pg-svg-container .button[data-key="button_volume_up"][drop],
  .pg-svg-container .button[data-key="button_volume_down"][drop],
  .pg-svg-container .button[data-key="button_volume_up"][drop]:hover,
  .pg-svg-container .button[data-key="button_volume_down"][drop]:hover {
    fill: color-mix(in srgb, var(--primary-color, #03a9f4) 28%, transparent);
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1.6;
    stroke-dasharray: none;
  }
  /* Inactive pages: dimmed, but still aimable. The face is fully hit-testable
     on every page — clicking a button two pages away crosses to that page and
     opens that button in one gesture (see onSelect in lizaip-buttons-view
     and _switchPageTo(idx, key)). A pointer-events:none here silently undid
     that wiring: the click never reached the path, so it fell through to the
     thumbnail's own handler, which only switches pages. */
  .page-thumb:not(.active) .pg-svg-container .button {
    opacity: .85;
  }

  /* Pages edit mode */
  /* Inline page action icons — flanking the name row */
  .page-thumb-del {
    position: absolute;
    top: 2px;
    left: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: color-mix(in srgb, var(--primary-text-color) 50%, transparent);
    cursor: pointer;
    opacity: 0;
    transition: opacity .2s, background .15s, color .15s, transform .15s;
    z-index: 2;
  }
  .page-thumb.active .page-thumb-del { opacity: 1; }
  /* 'ha-icon' brings its own host box whose padding or height this stylesheet
     does not control, so flex centring centred the box and left the glyph low.
     'display: contents' drops the host box so the icon centres on its own
     bounds -- the only treatment that worked against all three bad boxes. */
  .page-thumb-del ha-icon,
  .page-add-btn ha-icon {
    display: contents;
  }
  .page-thumb-del:hover {
    background: var(--liza-error-fill);
    color: #fff;
    transform: scale(1.1);
  }
  /* Ghosted, not hidden: it keeps its slot in the template so the gap stays
     measured against a stable row, and it is transformed onto the slot it
     would land in, so the strip reads as the order it is about to become. */
  .page-thumb.dragging { opacity: .4; }
  @media (prefers-reduced-motion: reduce) {
    /* The gap itself stays -- it is the answer to the question being asked.
       Only the slide goes. */
    .page-thumb { transition: border-color .2s, background .2s, box-shadow .2s; }
  }

  /* SVG preview card */

  /* Config panel card */
  .config-card { padding: 0; overflow: hidden; }
  .config-card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider-color);
  }
  .config-card-icon {
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    background: var(--secondary-background-color);
    flex-shrink: 0;
    overflow: hidden;
  }
  .config-card-icon img { border-radius: 4px; }
  .config-card-title-wrap { flex: 1; min-width: 0; }
  .config-card-name { font-size: var(--liza-font-m); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .config-card-key { font-size: var(--liza-font-11); color: var(--liza-muted-text); font-family: monospace; }
  /* The subtitle when the card is editing an override rather than the page
     default. It carries the pair — which fixed button, under which grid button
     — because that is the one thing the card would otherwise not say, and a
     card that silently means something different is how an override gets
     written by accident. */
  .config-card-key.context-key {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font-family: inherit;
    color: var(--liza-accent-text);
  }

  /* The button card's header, which is also its Appearance editor. The plain
     .config-card-header above stays a single flex row and is still what the
     slider card uses; .cch turns it into a column so the override subtitle and
     the editor can stack inside one bordered block. */
  .config-card-header.cch {
    display: block;
    padding: 0;
  }
  .cch-preview-empty { opacity: 0.2; }
  .cch > .config-card-key { padding: 12px 20px; }
  /* Vertical padding is the gap, so the space after the last row of a section
     is the space between two of them -- a card whose final item sits closer to
     the edge than its items sit to each other reads as cut off. Horizontal
     padding stays at 20px, matching .config-card-key above and
     .config-card-body below: that one is not rhythm, it is the line every
     label on the card starts from. */
  .cch-editor-inner {
    padding: var(--liza-field-gap) 20px;
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
  }

  .config-card-body {
    padding: var(--liza-field-gap) 20px;
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
  }
  .config-section-divider {
    height: 1px;
    background: var(--divider-color, rgba(127,127,127,.15));
    margin: 4px 0;
  }
  /* A field with a trailing action beside it -- Sensitivity and its reset to
     the page value. HA's field draws its own outline, so the row is layout
     only: a border here would be a box around a box. */
  .config-label-row {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  /* Only the reset. The confirm/cancel pair this used to list with it is
     gone: a tooltip now commits on Enter or blur, so there is nothing left
     to confirm. */
  .config-label-reset {
    flex-shrink: 0;
  }
  .config-field { display: flex; flex-direction: column; gap: 4px; }
  /* The action list is a section wearing a field's wrapper. Its hint explains
     the list rather than captioning an input, and the add button below it is a
     further item, so both sit on the section step. The 4px a .config-field
     normally spends is the distance from a control to its own caption, which
     is not what either of these is. */
  .config-field.action-field { gap: var(--liza-field-gap); }
  /* The 4px a hint spends on the control above it, removed here for the same
     reason the gap changed: this one has no control above it, only the
     section's heading, which is already a step away. */
  .config-field.action-field > .config-field-hint { margin-top: 0; }
  #button-editor-container,
  #button-longtouch-editor-container {
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
    min-height: 52px;
  }
  /* Sentence case, not uppercase: these sit next to HA's own components
     (ha-entity-picker, ha-icon-picker) which render Material labels in
     sentence case, and an uppercase micro-label beside them reads as a
     section header rather than a field name. Uppercase is now reserved for
     .config-section-title, which is an actual heading. */
  .config-field label {
    font-size: var(--liza-font-13);
    font-weight: 500;
    color: var(--liza-muted-text);
  }
  /* The visual role the field labels used to play — but earning it. */
  .config-section-title {
    font-size: var(--liza-font-11);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .5px;
    color: var(--liza-muted-text);
    margin-bottom: -8px;
  }
  .config-section-title:not(:first-child) {
    margin-top: 4px;
    padding-top: 20px;
    border-top: 1px solid var(--divider-color, rgba(127,127,127,.15));
  }
  /* The page title input is not inside a .config-field -- it lives in its own
     inline editor row -- so it named itself here to pick up the same treatment
     rather than staying a raw browser input. That is not only cosmetic: an
     unstyled input keeps the UA's own background and border, which in a dark
     theme is a white box with dark text sitting in a dark card.

     The page title's own input used to be listed here too: it lived outside a
     .config-field, in the banner, and had to name itself to be styled. It is a
     .config-field like every other now, so it inherits by position. */
  .config-field input[type="text"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--divider-color);
    border-radius: 8px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font-size: var(--liza-font-m);
    font-family: inherit;
    box-sizing: border-box;
  }
  .config-field input[type="text"]:focus {
    outline: none;
    border-color: var(--primary-color);
  }
  .config-field .icon-picker-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .config-field .icon-picker-row .icon-preview {
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    background: var(--secondary-background-color);
    overflow: hidden;
    flex-shrink: 0;
  }
  /* The preview is a tile, so it wants the same screen the face gives one. */
  :host(.liza-dark) .config-field .icon-picker-row .icon-preview { background: #000; }
  .config-field .icon-picker-row .icon-preview img { border-radius: 4px; }
  /* The page title is the one image in this panel that is not square. Widening
     the box to the title's own 4:1 keeps the picture at the shape the device
     will draw, instead of shrinking a 200x50 strip into a 40px square where
     every wordmark reads as a smudge. Height is unchanged, so the row does not
     grow and the field still lines up with the button card's. */
  .config-field .icon-picker-row .icon-preview-title { width: 120px; }
  .config-field .icon-picker-slot { flex: 1; position: relative; min-width: 0; }
  /* Names offered once a picture field starts with a registered icon prefix.
     In the top layer (popover) and fixed against the field, because the
     cards clip their content: hung off the field inside a card, the list was
     cut at the card's edge. inset and margin undo the popover's centring. */
  .liza-media-suggest {
    position: fixed;
    inset: auto;
    z-index: 10;
    margin: 0; padding: 4px 0;
    list-style: none;
    max-height: 260px;
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    border: 1px solid var(--divider-color);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,.2);
  }
  .liza-media-suggest[hidden] { display: none; }
  .liza-media-option {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: var(--liza-font-m);
    color: var(--primary-text-color);
  }
  .liza-media-option:hover {
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 15%, transparent);
  }
  /* The friendly name beside an entity id, quieter than the id itself. */
  .liza-media-note {
    margin-left: auto; padding-left: 12px;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-s, 12px);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* The keyboard selection is stated twice over, with a literal fallback for
     each colour. A theme that leaves --primary-color unset makes both the
     color-mix tint and the bar invalid, and the whole rule is then dropped --
     arrowing through the list looked like it did nothing at all. */
  .liza-media-option.active,
  .liza-media-option[aria-selected="true"] {
    background: var(--liza-option-active-bg, rgba(3, 169, 244, 0.22));
    box-shadow: inset 3px 0 0 var(--primary-color, #03a9f4);
  }
  /* Foldable section. Matches the live container idiom on this panel: 8px
     radius, hairline divider border, tinted header. */
  .slider-advanced {
    margin-top: 4px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.15));
    border-radius: 8px;
    overflow: hidden;
  }
  .slider-advanced > summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    font-size: var(--liza-font-13);
    font-weight: 600;
    color: var(--primary-text-color);
    cursor: pointer;
    user-select: none;
    background: var(--secondary-background-color, rgba(127,127,127,.06));
  }
  .slider-advanced > summary:hover {
    background: color-mix(in srgb, var(--primary-color) 6%, transparent);
  }
  .slider-advanced[open] > summary {
    border-bottom: 1px solid var(--divider-color, rgba(127,127,127,.15));
  }
  /* display:flex on a summary suppresses the ::marker in Chrome, so the
     disclosure affordance is drawn explicitly and rotated on open. */
  .slider-advanced > summary::before {
    content: "";
    width: 0;
    height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    opacity: .6;
    transition: transform .15s;
  }
  .slider-advanced[open] > summary::before { transform: rotate(90deg); }
  .slider-advanced > summary::-webkit-details-marker { display: none; }
  /* State icons section */
  .state-icons-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 6px 0 0;
  }
  /* Virtual toggle button */
  /* How presses 2..N look, in the Appearance card under the fields that
     answer the same question for press 1.

     A column of full-width fields, not a row of cells. The rows used to be
     horizontal -- a cramped picker beside a bare input -- so the same two
     questions press 1 asks at full width with labels and a preview were asked
     again in a different shape, and the later presses read as an afterthought
     rather than as the peers they are. Same fields, same widths, same order. */
  /* The list's own heading and hint. It is a section, not a form field: it
     holds a list of boxes rather than one control, so it does not take
     .config-field's single-row spacing. */
  /* A column like everything else in this card, so the heading stands off its
     list by the same distance the list's boxes stand off each other. It was a
     plain block, and the only thing holding the hint off the first press was
     6px of padding on the list -- a second, smaller rhythm introduced at the
     one seam where the card's own spacing should simply have continued. */
  .press-appearance-section {
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
    margin: 0;
  }
  /* No cycle, so nothing to number and nothing to connect. The elements stay
     in the DOM -- see the header, gaining a second action has to be a change
     of appearance rather than of structure -- and go out of the template
     entirely, so a one-action button spaces exactly as it did before the list
     existed: the Image and Tooltip remain direct flex items of
     .cch-editor-inner, which is where their 16px gap comes from.
     The row is forced open: it is a <details> with its summary hidden, and a
     shut one would take the fields with it. */
  .press-appearance-section.press-plain,
  .press-appearance-section.press-plain > .press-appearance-list,
  .press-appearance-section.press-plain .press-appearance-row {
    display: contents;
  }
  .press-appearance-section.press-plain > #config-card-press-head,
  .press-appearance-section.press-plain .press-appearance-row > summary {
    display: none;
  }
  /* Title and hint are two items of the section, not a label glued to its
     field: the hint describes the whole list below it rather than one input,
     so it sits on the section's own step instead of the 4px a field spends
     between a control and its caption. */
  .press-appearance-section > #config-card-press-head {
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
  }
  .press-appearance-section > #config-card-press-head > .config-field-hint {
    margin-top: 0;
  }
  .press-appearance-section > #config-card-press-head > label {
    display: block;
    font-size: var(--liza-font-13);
    font-weight: 500;
    color: var(--liza-muted-text);
  }
  /* A rail linking the press boxes into one sequence. The boxes were numbered
     but otherwise unconnected, so they read as separate cards that happened to
     carry ordinals; the line is what actually says "these run in this order". */
  .press-appearance-list {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
    padding: 0 0 0 18px;
  }
  /* Dashed, not solid. A solid rail reads as a hard connector -- the kind that
     says "these are wired together". The cycle is softer than that: it is an
     order, and the next press only happens if someone presses again. Dashes
     say sequence without claiming a mechanism, and they keep the line from
     competing with the row borders it runs beside.
     Drawn as a border rather than a background so the dash pattern comes from
     the renderer; a 1px gradient would have to hard-code the rhythm.

     One segment per row rather than one rail down the whole list, and none on
     the last. A single pseudo-element has no way to know where the last row
     starts, so it was inset by a fixed amount from the bottom -- which was
     about right while every row was shut and the same height, and ran the full
     length of the last row the moment one was opened, trailing off below the
     final number into nothing. A segment belongs *between* two presses, so it
     is owned by the one it leads away from: 1 - - - 2 - - - 3, and after 3 the
     sequence is over.

     Spans number to number: down from this row's ordinal, across the gap, to
     where the next row's ordinal sits -- the gap between two boxes plus the
     next ordinal's 22px offset. Derived from the gap token rather than written
     out, because the rail is the one thing in this card whose geometry depends
     on that spacing: a hard-coded length left the dashes stopping short of the
     next number the moment the rhythm changed. Offset back into the list's own
     left padding, which is the gutter the rail runs in. */
  .press-appearance-row:not(:last-child)::before {
    content: "";
    position: absolute;
    inset-inline-start: -13px;
    top: 22px;
    bottom: calc(-22px - var(--liza-field-gap));
    width: 0;
    border-inline-start: 1px dashed var(--divider-color, rgba(127,127,127,.3));
  }
  .press-appearance-row {
    position: relative;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.25));
    background: rgba(127,127,127,.04);
  }
  /* A <details>, so the box is the summary's height until it is opened. The
     column that used to be the row itself moves onto the contents, which is
     everything after the summary. */
  .press-appearance-row[open] {
    display: flex;
    flex-direction: column;
    gap: var(--liza-field-gap);
  }
  /* The marker is the one piece of a native <details> that does not look like
     Home Assistant. It is replaced below with a chevron that turns, matching
     the action cards this list sits under. */
  .press-appearance-row > summary {
    list-style: none;
    cursor: pointer;
  }
  .press-appearance-row > summary::-webkit-details-marker { display: none; }
  .press-appearance-row > summary::after {
    content: "";
    flex: none;
    width: 8px;
    height: 8px;
    margin-inline-start: 4px;
    border-right: 2px solid var(--liza-muted-text);
    border-bottom: 2px solid var(--liza-muted-text);
    transform: translateY(-2px) rotate(45deg);
    transition: transform .18s ease;
  }
  .press-appearance-row[open] > summary::after {
    transform: translateY(2px) rotate(-135deg);
  }
  .press-appearance-row > summary:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
    border-radius: 6px;
  }
  /* What the press will wear, on the heading, because a shut row has hidden
     the field that would otherwise show it. In front of the name, not after
     it: an icon that follows the words it illustrates reads as a status badge
     tacked on the end, and the action cards below this list put the glyph
     first. The title takes the slack instead, so the chevron still lands at
     the far edge. */
  .press-appearance-glyph {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }
  .press-appearance-glyph img,
  .press-appearance-glyph ha-icon {
    width: 20px;
    height: 20px;
    --mdc-icon-size: 20px;
  }
  /* What this press does. The name comes from the same helper the chips use,
     so a row and its chip and its action card are three views of one step
     under one name. */
  .press-appearance-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  /* The ordinal sits *on* the rail, outside the box, with the card's own
     background behind it so it breaks the line rather than crossing it --
     the usual way a stepper marks its stops. Out of flow, so the head is
     free to be just the title. */
  /* Sized with the title it labels, not a size below it. At 11px the ordinals
     were the smallest text on the card -- the one piece of it that has to be
     read at a glance, set smaller than everything that does not. The box is
     widened with the text and re-centred on the rail: it has to be wide enough
     to cover the dashes it breaks, and a two-digit press has to fit without
     the number spilling over the line. */
  .press-appearance-num {
    position: absolute;
    inset-inline-start: -21px;
    top: 22px;
    transform: translateY(-50%);
    width: 16px;
    padding: 3px 0;
    text-align: center;
    background: var(--card-background-color, #fff);
    color: var(--liza-muted-text);
    font-size: var(--liza-font-13);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .press-appearance-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--liza-font-13);
    font-weight: 500;
    color: var(--primary-text-color);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* _htmlIconField and configFieldHtml each bring their own .config-field
     wrapper carrying the spacing of a standalone form row. Inside a press box
     they are stacked siblings, so the outer gap owns the rhythm. */
  .press-appearance-row .config-field {
    margin: 0;
    min-width: 0;
  }
  /* Nothing here. A press's Tooltip is the same field press 1's is, so it
     takes the same rule -- the one on a text input inside a config field. It used to
     restate padding, radius and font size at smaller values, which is why two
     copies of one field sat stacked at two different sizes. */
  /* The page-title editor's icon cell. It shares no markup with the presses --
     it is a single field in a header row -- but it wants the same "one cell,
     not a form row" sizing. */
  .title-icon-field { flex: 1 1 190px; max-width: 300px; }
  .title-icon-field .config-field { margin: 0; }

  /* The only control that adds an action -- Home Assistant's own is hidden in
     every state, so this one owns the wording and the position.
     Aligned to the content start, and padded only on the inside edge it does
     not share with the cards above it. It used to be centred on
     an auto margin and padded 12px on both sides, which left it sitting
     off the start of the list it appends to. This rule was also declared
     twice; the earlier copy never applied and has been removed. */
  .liza-add-action-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 6px;
    padding: 8px 10px 8px 0;
    /* The gap around this is the container's now. The 8px of padding is kept --
       it is what makes the control big enough to hit -- and pulled back out of
       the template on both edges, so the words sit one step below the last card
       and one step above the end of the card, while the target still reaches
       into the space on either side of them. */
    margin: -8px 0;
    background: transparent;
    border: none;
    color: var(--liza-accent-text);
    border-radius: 8px;
    font-size: var(--liza-font-m);
    font-weight: 500;
    cursor: pointer;
    transition: color .15s;
  }
  .liza-add-action-btn:hover { text-decoration: underline; }
`;
