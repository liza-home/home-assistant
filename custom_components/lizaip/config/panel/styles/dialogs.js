/**
 * lizaIP Panel — Styles: Layout, device-picker, confirmation and restore dialogs.
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
export const STYLES_DIALOGS = `
  /* ===== Template Dialog Styles ===== */
  /* A native <dialog>, shown with showModal() -- see _openModal. The rules
     below undo the UA's own dialog styling (a centred, auto-sized, bordered
     white box) so it can go on being the full-viewport scrim it has always
     been visually, while the platform supplies the focus trap, Escape,
     inertness and top-layer stacking underneath. */
  /* Home Assistant's dialog draws the scrim and the surface; the card inside
     it is only the content's padding and rhythm. The rest of this block is
     for the native <dialog> used until HA has loaded ha-dialog. */
  ha-dialog.add-page-overlay {
    --dialog-content-padding: 0;
  }
  ha-dialog.add-page-overlay .add-page-dialog {
    background: none;
    box-shadow: none;
    border-radius: 0;
    width: auto;
    min-width: 0;
    max-width: none;
    max-height: none;
    overflow: visible;
  }
  dialog.add-page-overlay {
    position: fixed;
    inset: 0;
    border: 0;
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    background: rgba(0,0,0,.55);
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  /* Scoped to [open]: an unconditional flex display would override the UA's
     "display: none" for a closed dialog and paint it over the panel. */
  dialog.add-page-overlay[open] { display: flex; }
  /* The element itself paints the scrim, so the UA's own backdrop would only
     darken it a second time. */
  dialog.add-page-overlay::backdrop { background: transparent; }
  .add-page-dialog {
    background: var(--card-background-color, #1e1e1e);
    border-radius: 16px;
    padding: 24px;
    /* At 400% zoom the viewport is 320px wide, where a hard 320px minimum
       plus 48px of padding put the dialog wider than the screen and forced
       sideways scrolling to reach the buttons. min() keeps the comfortable
       width on a normal display and lets it shrink when there is less room
       than that; border-box stops the padding adding to whichever wins. */
    min-width: min(320px, 100%);
    max-width: 480px;
    width: 90%;
    box-sizing: border-box;
    /* A dialog taller than a zoomed viewport was unscrollable and its actions
       unreachable, since the overlay centres it and clips the overflow. */
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  .add-page-dialog-title {
    font-size: var(--liza-font-18);
    font-weight: 500;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--primary-text-color, #fff);
  }
  /* Cancel, Save and the destructive commits are Home Assistant's own
     ha-button now, so their look -- fill, radius, focus ring, disabled
     state -- comes from the theme rather than from us. All that is left
     here is where they sit. */

  /* Template picker list */
  .template-dialog { max-width: 560px; }
  .template-dialog-desc {
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
    margin: -8px 0 16px 0;
  }

  /* A form step carries its own rhythm, so the gaps between its fields do not
     depend on whatever margin the input component leaves behind. */
  .add-page-body.is-form-body > .config-field { margin-bottom: 12px; }
  .add-page-body.is-form-body > .config-field:last-of-type { margin-bottom: 0; }

  /* One row, used by every step of the walk: the folders on the first
     screen, the templates inside one, the search results and the devices the
     last step offers are all the same shape, so the dialog never changes
     form -- only what it is listing. */
  .template-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px 0 6px;
  }
  /* Home Assistant's list and rows draw themselves -- height, hover, focus,
     the chosen option. They only take the gap and the rounded corners the
     walk's rows have always had. */
  ha-list-base.template-list,
  ha-list-selectable.template-list {
    --ha-list-gap: 3px;
  }
  ha-list-item-button.template-row,
  ha-list-item-option.template-row {
    --ha-list-item-focus-radius: 11px;
    border-radius: 11px;
  }
  /* The walk's own buttons, until HA's list is loaded. */
  button.template-row {
    display: flex;
    align-items: center;
    gap: 13px;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 11px;
    background: transparent;
    color: var(--primary-text-color, #fff);
    font: inherit;
    cursor: pointer;
  }
  button.template-row:hover {
    background: rgba(255,255,255,.055);
    border-color: var(--divider-color, #333);
  }
  button.template-row.is-chosen {
    background: rgba(3,169,244,.1);
    border-color: var(--primary-color, #03a9f4);
  }
  /* The heading over each half of the first screen. Home Assistant labels
     such a group rather than ruling an unexplained line between two, and the
     panel already spells that role out in .config-section-title. */
  .template-list-title {
    margin: 0;
    padding: 4px 12px 4px;
    font-size: var(--liza-font-11);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .5px;
    color: var(--liza-muted-text);
  }
  /* The rule belongs between the two groups, not against either of them: at
     4px it read as part of the heading under it. */
  .template-list.is-lead + .template-list-title {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--divider-color, #333);
  }
  .template-list.is-lead { padding-bottom: 0; }
  .template-row-text { flex: 1 1 auto; min-width: 0; }
  .template-row-name {
    display: block;
    font-size: var(--liza-font-m);
    font-weight: 600;
    line-height: 1.3;
  }
  .template-row-desc {
    display: block;
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .template-row-tail {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }
  /* Drawn rather than a glyph, so it needs no icon round-trip to say "this
     one opens". */
  .template-row-chevron {
    width: 7px;
    height: 7px;
    border-right: 1.6px solid currentColor;
    border-bottom: 1.6px solid currentColor;
    transform: rotate(-45deg);
  }
  /* The last step chooses one of a few targets rather than browsing, and
     Home Assistant's own visible single-choice lists head each option with
     a radio. */
  .template-row-radio {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--liza-muted-text);
    box-sizing: border-box;
  }
  .template-row.is-chosen .template-row-radio {
    border-color: var(--primary-color, #03a9f4);
  }
  .template-row.is-chosen .template-row-radio::after {
    content: "";
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--primary-color, #03a9f4);
  }
  /* An area is optional per device, so a list that shows any reserves the
     second line on all of them. */
  .template-target-list.is-two-line .template-row-desc:empty::after {
    content: "\\00a0";
  }
  .template-row mark {
    background: rgba(3,169,244,.3);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
  }

  /* The picture is an imgserv raster, not a glyph CSS can tint, and the two
     kinds are shaped nothing alike -- but the plate is one width for both,
     so every name in the list starts at the same place. */
  .tile-plate {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 40px;
    width: 52px;
    box-sizing: border-box;
    border-radius: 9px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.08);
  }
  /* A template's mark is not a picture the remote shows: it sits on the plate,
     not on the remote's black screen. */
  :host(.liza-dark) .tile-plate .liza-dev-img { background: none; }
  /* "(3 pages)" after a template's name: part of the name, quieter. */
  .template-pages { color: var(--liza-muted-text); font-weight: 400; }

  /* ── The add-page walk's own chrome ──────────────────────────────────
     Scoped to the walk's host, because .add-page-dialog and .template-dialog
     are shared by every other dialog in the panel. */
  .add-page-dialog#liza-template-step {
    max-width: 680px;
    width: 92%;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* The crumb carries its own 6px of button padding, so the head is inset by
     28px rather than 22px: that puts the crumb's text on the same left rail
     as the group headings and the rows' plates below it. */
  .add-page-head {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    flex: 0 0 auto;
    height: var(--add-page-head-h);
    padding: 16px 28px 8px;
  }
  /* The trail replaces both the step's title and a Back button, and stays on
     one row however long it grows: a wrapped crumb would push the search and
     the list down a step at a time. */
  .add-page-crumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: nowrap;
    overflow: hidden;
    min-width: 0;
  }
  .add-page-crumb {
    border: 0;
    background: transparent;
    padding: 2px 6px;
    border-radius: 6px;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-13);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    transition: color .15s, background .15s;
  }
  .add-page-crumb:hover {
    color: var(--primary-text-color, #fff);
    background: rgba(255,255,255,.06);
  }
  .add-page-crumb.is-current {
    color: var(--primary-text-color, #fff);
    font-size: var(--liza-font-m);
    font-weight: 600;
    padding: 2px 6px;
  }
  .add-page-crumb-sep { color: var(--liza-muted-text); opacity: .5; }

  .add-page-search {
    display: flex;
    align-items: center;
    margin: 0 22px 6px;
    /* Minus its own margin: the step without a bar reserves the same var, so
       the two cannot drift apart. */
    min-height: calc(var(--add-page-search-h) - 6px);
  }
  .add-page-search-input {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* One height for every step of the walk, the way HA pins its own stepped
     pickers: dialog-add-integration sizes the sub-views to the list view it
     measured. The 300px is the tallest step, so that one is exactly filled,
     the shorter folders leave a strip rather than the dialog resizing under
     the pointer, and only a genuinely longer list scrolls. The subtrahend is
     the chrome around it -- head, search, foot and the dialog's own margins
     -- measured rather than guessed, and keeps the foot reachable when the
     screen is short or zoomed. */
  .add-page-dialog {
    --add-page-head-h: 44px;
    --add-page-search-h: 46px;
    --add-page-list-h: min(300px, calc(100vh - 172px));
  }
  .add-page-body {
    flex: 1 1 auto;
    min-height: 0;
    height: var(--add-page-list-h);
    overflow-y: auto;
    padding: 0 22px;
  }
  /* The last step asks for a device rather than offering a search, so it
     takes the bar's height into the body: the dialog is the same height
     there as on every step behind it, and the foot stays put. */
  .add-page-body.is-form-body {
    height: calc(var(--add-page-list-h) + var(--add-page-search-h));
  }
  .add-page-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 34px 12px 40px;
    text-align: center;
  }
  .add-page-empty > img { opacity: .35; }
  .add-page-empty-title {
    margin: 8px 0 0;
    font-size: var(--liza-font-m);
    color: var(--primary-text-color, #fff);
  }
  .add-page-empty-hint {
    margin: 0;
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
  }
  .add-page-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 22px 14px;
    border-top: 1px solid var(--divider-color, #333);
  }
  .add-page-count { font-size: var(--liza-font-11); color: var(--liza-muted-text); }
  .add-page-foot .add-page-cancel { margin: 0; }
  /* Home Assistant's own back arrow, sized down so it sits inside the head's
     fixed height rather than overflowing it, and nudged onto the same left
     rail the crumb text uses on the step before. */
  .add-page-back {
    --mdc-icon-button-size: 40px;
    margin-left: -2px;
    flex: 0 0 auto;
    color: var(--liza-muted-text);
  }
  /* The count sits between the two, so it keeps them apart on its own. */
  .add-page-foot .add-page-count { margin-right: auto; }

  /* The last step of the walk asks one question rather than offering a grid,
     so there is no count to hold the left and the pair that ends the walk
     sits together on the right, where a hand expects a commit. */
  .add-page-foot.is-form-foot { justify-content: flex-end; }

  /* What the page is about to become, drawn as the card it was picked from:
     the last screen is the only one that cannot show the thing itself. */
  .template-receipt {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 6px 0 18px;
    padding: 14px 16px;
    border: 1px solid var(--divider-color, #333);
    border-radius: 14px;
    background: rgba(255,255,255,.035);
  }
  .template-receipt-text { min-width: 0; }
  .template-receipt-name {
    display: block;
    font-size: var(--liza-font-m);
    font-weight: 600;
  }
  .template-receipt-sub {
    display: block;
    margin-top: 2px;
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }

  /* What the template binds to, in the template flow */
  .template-entity-picker {
    margin-bottom: 20px;
  }
  .template-entity-caption {
    margin: 0 0 2px;
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
  }
  .template-target-list { padding-bottom: 0; }
  .template-entity-hint {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
    margin-top: 6px;
  }
  .template-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
  .template-confirm-btn { flex: 0 0 auto; }

  /* Destructive confirmation. The red is ha-button's variant="danger", which
     the theme guarantees a readable foreground on; we no longer mix it
     ourselves. The message is a normal paragraph in the theme's own body
     colour, so nothing here depends on red to be read -- the red is
     emphasis, not information (1.4.1). */
  /* The title row is a flex row (icon + text) in other dialogs; a title that
     carries a subtitle stacks it underneath instead. */
  .add-page-dialog-title:has(.confirm-dialog-subtitle) {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .confirm-dialog-subtitle {
    display: block;
    font-size: var(--liza-font-m);
    font-weight: normal;
    color: var(--liza-muted-text);
    overflow-wrap: anywhere;
  }
  .confirm-dialog-message {
    font-size: var(--liza-font-m);
    line-height: 1.5;
    margin: 0 0 20px;
    color: var(--primary-text-color, #fff);
  }
  .confirm-danger-btn { flex: 0 0 auto; }

  /* Restoring a configuration. One window walks the three steps -- choose a
     file, look at what is in it, watch it go in -- so its body changes under
     a header that says which of them is being taken. */
  .restore-dialog { max-width: 460px; }
  .restore-line {
    font-size: var(--liza-font-m);
    line-height: 1.5;
    margin: 0 0 12px;
    color: var(--primary-text-color, #fff);
  }
  .restore-line.note {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }
  /* The warning is marked by its border and its words, never by colour alone
     (WCAG 1.4.1): the sentence says outright what is about to be replaced. */
  .restore-line.warn {
    border-left: 3px solid var(--warning-color, #f9a825);
    padding: 2px 0 2px 12px;
  }
  .restore-drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 30px 16px;
    margin: 4px 0 10px;
    border: 1px dashed var(--divider-color, #444);
    border-radius: 14px;
    background: color-mix(in srgb, var(--primary-text-color, #fff) 3%, transparent);
    transition: border-color .15s ease, background .15s ease;
    text-align: center;
    cursor: pointer;
    position: relative;
  }
  .restore-drop:hover {
    border-color: var(--liza-accent-fill);
    background: color-mix(in srgb, var(--liza-accent-fill) 5%, transparent);
  }
  .restore-drop.over {
    border-color: var(--liza-accent-fill);
    background: color-mix(in srgb, var(--liza-accent-fill) 10%, transparent);
  }
  /* The icon in a disc of its own: a bare glyph floating over a dashed box
     read as a stray mark rather than as the thing being asked for. */
  .restore-drop > ha-icon {
    --mdc-icon-size: 26px;
    display: flex; align-items: center; justify-content: center;
    width: 52px; height: 52px; border-radius: 50%;
    background: color-mix(in srgb, var(--liza-accent-fill) 12%, transparent);
    color: var(--liza-accent-fill);
  }
  .restore-drop-hint {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }
  .restore-dialog { position: relative; }
  .restore-dialog .add-page-dialog-title { padding-right: 40px; }
  .restore-dialog-close {
    position: absolute; top: 8px; right: 8px;
  }
  /* The three steps across the top. Numbered, and a tick for the ones that
     are behind: the user can see how much of the road is left. */
  .restore-steps {
    display: flex; align-items: center;
    list-style: none; margin: 16px 0; padding: 0;
  }
  /* The labels take the room they need and the rules between them take all
     the rest, so the three steps span the window however wide it is. */
  .restore-steps-item {
    display: flex; align-items: center; gap: 6px;
    min-width: 0;
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }
  /* The rule lives inside the step it follows, so the slack has to be handed
     to the step first; the last one carries no rule and keeps its own width. */
  .restore-steps-item:not(:last-child) { flex: 1 1 auto; }
  .restore-steps-item:last-child { flex: 0 0 auto; }
  .restore-steps-item.current { color: var(--primary-text-color, #fff); font-weight: 500; }
  /* box-sizing and line-height both matter here: the border otherwise grows
     the disc past the 20px the row is laid out for, and an inherited 1.5
     line box is taller than the disc, which rides the digit off its centre.
     Tabular figures keep 1, 2 and 3 on the same middle. */
  .restore-steps-mark {
    flex: none;
    box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%;
    border: 1px solid var(--divider-color, #444);
    font-size: var(--liza-font-11); line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .restore-steps-mark ha-icon { display: block; line-height: 0; }
  /* The step being taken is marked by weight and a filled disc, not by colour
     alone (WCAG 1.4.1), and the ones behind it carry a tick. */
  .restore-steps-item.current .restore-steps-mark {
    background: var(--liza-accent-fill); border-color: transparent; color: #fff;
  }
  .restore-steps-item.done .restore-steps-mark {
    border-color: var(--liza-accent-fill); color: var(--liza-accent-fill);
  }
  .restore-steps-item.done .restore-steps-mark ha-icon { --mdc-icon-size: 14px; }
  .restore-steps-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The rule between one step and the next, so the three read as a road
     rather than as three separate labels. Drawn after each but the last. */
  .restore-steps-item::after {
    content: ""; flex: 1 0 auto; min-width: 12px;
    height: 1px; margin: 0 8px;
    background: var(--divider-color, #444);
  }
  .restore-steps-item:last-child::after { content: none; }
  .restore-steps-item.done::after { background: var(--liza-accent-fill); }
  /* The archive leads the review step, as a card headed by its own name. */
  .restore-card {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px; margin: 0 0 16px;
    border: 1px solid var(--divider-color, #444); border-radius: 12px;
    background: color-mix(in srgb, var(--primary-text-color, #fff) 4%, transparent);
  }
  .restore-card-icon {
    flex: none; --mdc-icon-size: 24px;
    color: var(--liza-accent-fill);
  }
  .restore-card-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .restore-line.file {
    font-weight: 500; margin: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .restore-card-meta {
    font-size: var(--liza-font-11); color: var(--liza-muted-text);
  }
  /* The sentences under the card keep the icon and the text apart rather than
     letting one wrap under the other. */
  .restore-line.warn { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; }
  .restore-line.warn ha-icon {
    flex: none; --mdc-icon-size: 18px; margin-top: 1px;
    color: var(--warning-color, #f9a825);
  }
  /* The pages in the archive, as the faces the remote will show. A row that
     scrolls sideways rather than a growing stack: twenty pages must not push
     the Restore button off the screen. */
  .restore-pages {
    display: flex; gap: 12px;
    list-style: none; margin: 0 0 16px; padding: 2px;
    overflow-x: auto; overflow-y: hidden;
    scrollbar-width: thin;
  }
  .restore-page {
    flex: 0 0 auto; width: 68px;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 6px 4px;
    border: 1px solid var(--divider-color, #444); border-radius: 10px;
    background: color-mix(in srgb, var(--primary-text-color, #fff) 4%, transparent);
  }
  /* A picture of a page that does not exist yet: nothing on it answers a
     press, and the shapes must not offer the editor's hover affordance.

     No padding of its own, ever: the icon overlays are placed in per cent of
     this box, so anything between it and the face shifts every one of them. */
  .restore-face {
    width: 100%; flex: none; padding: 0;
    pointer-events: none;
  }
  .restore-face .button { cursor: default; }
  .restore-page-title {
    max-width: 100%;
    font-size: var(--liza-font-11);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .restore-page-count {
    font-size: var(--liza-font-11); color: var(--liza-muted-text);
  }
  .restore-bar {
    height: 6px; border-radius: 3px; overflow: hidden;
    background: color-mix(in srgb, var(--liza-accent-fill) 18%, transparent);
  }
  .restore-bar-fill {
    height: 100%; width: 0;
    background: var(--liza-accent-fill);
    transition: width .2s ease;
  }
  .restore-bar.sweeping .restore-bar-fill {
    width: 40%;
    animation: liza-restore-sweep 1.1s ease-in-out infinite;
  }
  @keyframes liza-restore-sweep {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }
  /* It worked, said with a mark and a sentence rather than only a colour. */
  .restore-done {
    display: flex; align-items: center; gap: 10px;
    margin: 8px 0; font-size: var(--liza-font-m);
    color: var(--primary-text-color, #fff);
  }
  .restore-done-icon { --mdc-icon-size: 28px; color: var(--success-color, #43a047); }
  @media (prefers-reduced-motion: reduce) {
    .restore-bar-fill { transition: none; }
    .restore-bar.sweeping .restore-bar-fill { animation-duration: 3s; }
  }
  /* The dialog's own buttons need the same air every other dialog gives them;
     without it they sat on whatever the body ended with. */
  .restore-dialog > .template-dialog-actions { margin-top: 20px; }
  .restore-status {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
    margin: 0 0 14px;
  }
  .restore-status.error { color: var(--error-color, #db4437); }
  /* Cancel sits in a flex row beside the commit, so it must not carry the
     auto margin that would centre it and strand its partner at the edge. */
  .confirm-cancel-btn { flex: 0 0 auto; }

  /* Who a remote is assigned to. Rows carry the panel's own list look -- the
     12px surface the device list uses -- and the whole row is the control. */
  .people-hint {
    font-size: var(--liza-font-m);
    line-height: 1.5;
    margin: 0 0 12px;
    color: var(--liza-muted-text);
  }
  .people-listhead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 0 0 8px;
  }
  .people-section {
    font-size: var(--liza-font-12);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .6px;
    color: var(--liza-muted-text);
  }
  .people-count {
    font-size: var(--liza-font-12);
    color: var(--liza-muted-text);
  }
  .people-search { display: block; margin: 0 0 10px; }
  .people-empty,
  .people-no-match {
    font-size: var(--liza-font-m);
    margin: 0 0 20px;
    color: var(--liza-muted-text);
  }
  .people-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 48vh;
    overflow-y: auto;
    margin-bottom: 20px;
  }
  /* Home Assistant's own row: a badge, a name and a switch, with nothing
     drawn around it. The switch is the state, so no second selected look. */
  .person-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 4px;
    min-height: 48px;
    box-sizing: border-box;
  }
  .person-row[hidden] { display: none; }
  .person-avatar { width: 40px; height: 40px; flex: 0 0 auto; }
  .person-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .person-row-pick .person-info { cursor: pointer; }
  .person-name {
    font-size: var(--liza-font-m);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .person-switch { flex: 0 0 auto; }
`;
