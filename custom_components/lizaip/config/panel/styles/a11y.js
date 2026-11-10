/**
 * lizaIP Panel — Styles: Keyboard focus and the narrow-viewport layout.
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
export const STYLES_A11Y = `
  /* ── keyboard focus ────────────────────────────────────────────────
     Home Assistant's ring, and only that: its width, offset and colour
     (--wa-focus-ring-*), drawn the same way on every control. No control
     adds a frame, glow or colour of its own on focus -- two indicators read
     as two things focused. No border-radius, so the ring follows the
     element's own shape. !important throughout: the panel's state rules are
     written far heavier than any focus selector can be, and 2.4.7 is not
     optional. */
  /* Announcements only. Clipped rather than display:none, which would take
     it out of the accessibility tree and silence it. */
  .liza-sr-only {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; border: 0;
    clip-path: inset(50%); overflow: hidden; white-space: nowrap;
  }

  :host *:focus-visible {
    outline: var(--wa-focus-ring-width, 2px) solid var(--liza-focus) !important;
    outline-offset: var(--wa-focus-ring-offset, 2px) !important;
  }

  /* Inside the box, as Home Assistant draws it on list rows and menu items:
     a row fills its list, so an outset ring is clipped by the list's edge or
     runs into the next row. */
  .template-row:focus-visible,
  .face-menu-item:focus-visible,
  .guide-toc-item:focus-visible,
  .guide-ext:focus-visible,
  .page-thumb-del:focus-visible {
    outline-offset: calc(-1 * var(--wa-focus-ring-width, 2px)) !important;
  }

  /* outline-offset draws the ring outside the border box, so it contrasts
     against the parent -- here --liza-accent-fill, where #808080 is 1.24:1
     (1.4.11 asks 3:1). --app-header-text-color is by definition readable on
     the header, so the ring stays visible on a custom one too. */
  .toolbar {
    --liza-focus: var(--app-header-text-color, #fff);
  }

  /* Clearing the browser's own ring for the pointer. Making things keyboard
     operable gave them tabindex, and a click focuses what it hits -- Chrome
     then paints a 5px blue rectangle around a round face button. ':not(
     :focus-visible)' keeps the keyboard rings above; an old browser that
     does not know the pseudo-class drops this rule and keeps its own. */
  :host *:focus:not(:focus-visible) {
    outline: none !important;
  }

  /* WCAG 2.4.11 Focus Not Obscured: .toolbar is sticky with z-index 10, so a
     control Tab scrolls to the top edge lands underneath it. scroll-margin is
     read off the focused element, which is what is needed here -- the
     scroller is HA's page container, outside this shadow root.
     64px = the 56px bar plus the 2px ring and its 2px offset. */
  :host a[href],
  :host button,
  :host input,
  :host select,
  :host textarea,
  :host [tabindex],
  :host ha-icon-button,
  :host ha-icon-picker,
  :host ha-entity-picker,
  :host ha-textfield,
  :host ha-select,
  :host ha-input,
  :host ha-input-search,
  :host ha-button,
  :host ha-switch,
  :host ha-combo-box,
  :host ha-picker-field {
    scroll-margin-top: 64px;
  }

  /* Containers focused only because the control that had focus was destroyed.
     They are landing pads, not controls, and a ring around a region that wraps
     the whole panel reads as "everything is selected". */
  :host [data-a11y-landing]:focus-visible {
    outline: none !important;
  }

  /* Shown while focused: the button is invisible until hover, and a blind
     focus on a *delete* is the worst one to hand over. Its ring is inset
     (above) because .page-thumb is overflow:hidden (2.4.11). */
  .page-thumb-del:focus-visible {
    opacity: 1;
  }

  /* A button that opens a page, while its link is drawn. !important for the
     same reason as the focus ring below: the configured/selected/per-key
     ladder above out-ranks any reasonable selector here, and restating this
     against each rung would mean seven attribute repeats. Declared before
     focus-visible so that a focused button still shows focus -- between two
     !important rules of equal specificity the later one wins. */
  .pg-svg-container .button[goto-link] {
    stroke: var(--primary-text-color) !important;
    stroke-width: 2 !important;
    vector-effect: non-scaling-stroke;
  }

  /* The remote face. An outline traces a bounding box, so on a round button
     it drew a square; stroke follows the real path instead. !important
     because the state rules out-rank this one, and selection survives it --
     a selected shape is also filled. non-scaling-stroke is what makes the
     ring 2 real pixels: the blueprint's viewBox scales user units by ~0.44. */
  .pg-svg-container .button:focus-visible {
    stroke: var(--liza-focus) !important;
    stroke-width: 2 !important;
    vector-effect: non-scaling-stroke;
    outline: none !important;
  }

  /* A closed page's tab stop is .pg-svg-container, a square-cornered box
     inside .page-thumb (overflow:hidden, 14px radius), so its ring was
     cropped. Drawn on the card instead: an outline is never clipped by the
     element's own overflow, and it follows the radius the eye expects. */
  .page-thumb:has(.pg-svg-container:focus-visible) {
    outline: 2px solid var(--liza-focus);
    outline-offset: 2px;
  }
  .pg-svg-container:focus-visible {
    outline: none !important;
  }

  /* The add-page walk focuses its first row so the arrow keys have somewhere
     to start, before the user has asked for anything. Until a key is pressed
     that focus is a starting point, not a recommendation, so it is not drawn:
     an opened step shows at most the row already chosen. The focus itself
     stays (WCAG 2.4.7 is about the indicator once the user is driving by
     keyboard, and the first keydown takes the class off). */
  .template-dialog.focus-quiet .template-row:focus-visible {
    outline: none !important;
  }
  /* Home Assistant's own list rows and menu items draw their own focus ring,
     inside the row; the panel's ring would make it two. Quiet means theirs
     too. */
  ha-list-item-button:focus-visible,
  ha-list-item-option:focus-visible,
  ha-dropdown-item:focus-visible {
    outline: none !important;
  }
  .template-dialog.focus-quiet ha-list-item-button,
  .template-dialog.focus-quiet ha-list-item-option {
    --ha-list-item-focus-width: 0;
    --ha-list-item-focus-width-start: 0;
    --ha-list-item-focus-background: transparent;
  }

  /* WCAG 1.4.10 Reflow. In one row only the device name can shrink, so under
     pressure it collapses and then the tabs are pushed off the edge. Measured
     across the four translations, the narrowest lossless single row is 560px
     (Spanish, 200% text); 600 is the first round number clear of it.
     Below that the tabs wrap -- via flex-wrap, so DOM order and therefore
     reading order are untouched (1.3.2). scroll-margin-top grows with the
     bar: measured 167px at 320px/200% text, so 176 clears it plus its ring.

     Keyed to a class the panel sets from its own measured width, not to a
     viewport media query. The two used to be the same number until the guide
     drawer arrived: it takes its column out of the panel and leaves the
     window alone, so a 500px panel inside a 1600px window would be told it
     was roomy and would keep the wide toolbar, which then wrapped into a
     ragged stack. What the toolbar has to fit into is the panel, so that is
     what it is asked about. See _narrowWatch in lizaip-panel.js. */
  :host(.panel-narrow) .toolbar {
    flex-wrap: wrap;
    height: auto;
    min-height: 56px;
    padding-bottom: 0;
  }
  :host(.panel-narrow) .toolbar .main-title {
    flex: 1 1 auto;
  }
  /* The ? and the ⋮ ride along on the tabs' wrapped row rather than claiming
     a third one of its own, so the tabs give up their width: 36 each, the 4px
     between them, and 4 of slack. */
  :host(.panel-narrow) .toolbar-tabs {
    flex: 1 0 calc(100% - 80px);
    margin-left: 0;
    margin-top: 4px;
  }
  :host(.panel-narrow) .toolbar .diag-menu-btn,
  :host(.panel-narrow) .toolbar .guide-btn {
    margin-top: 4px;
  }
  :host(.panel-narrow) .toolbar-tab {
    flex: 1;
  }
  /* Only as wide as the gear: an equal share would give an icon the room
     of a word and push the labelled tabs into two lines. */
  :host(.panel-narrow) .toolbar-tab-icon {
    flex: 0 0 auto;
  }
  :host(.panel-narrow) a[href],
  :host(.panel-narrow) button,
  :host(.panel-narrow) input,
  :host(.panel-narrow) select,
  :host(.panel-narrow) textarea,
  :host(.panel-narrow) [tabindex],
  :host(.panel-narrow) ha-icon-button,
  :host(.panel-narrow) ha-icon-picker,
  :host(.panel-narrow) ha-entity-picker,
  :host(.panel-narrow) ha-textfield,
  :host(.panel-narrow) ha-select,
  :host(.panel-narrow) ha-input,
  :host(.panel-narrow) ha-input-search,
  :host(.panel-narrow) ha-button,
  :host(.panel-narrow) ha-switch,
  :host(.panel-narrow) ha-combo-box,
  :host(.panel-narrow) ha-picker-field {
    scroll-margin-top: 176px;
  }
`;
