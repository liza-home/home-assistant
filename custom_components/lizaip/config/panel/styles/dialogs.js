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
  .add-page-overlay {
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
  .add-page-overlay[open] { display: flex; }
  /* The element itself paints the scrim, so the UA's own backdrop would only
     darken it a second time. */
  .add-page-overlay::backdrop { background: transparent; }
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
  /* Room for four square cards in a row. Only the add-page dialog holds this
     grid, so the other dialogs keep their width. */
  .add-page-dialog:has(> .add-page-dialog-options) { max-width: 640px; }
  .add-page-dialog-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .add-page-option {
    /* Square, whatever the label. A card whose words need more height than
       its width still grows rather than clipping them. */
    aspect-ratio: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 12px;
    text-align: center;
    border: 2px solid var(--divider-color, #333);
    border-radius: 12px;
    background: transparent;
    color: var(--primary-text-color, #fff);
    cursor: pointer;
    transition: border-color .2s, background .2s;
    font-size: var(--liza-font-m);
  }
  .add-page-option:hover {
    border-color: var(--primary-color, #03a9f4);
    background: rgba(3,169,244,.08);
  }
  .add-page-option-desc {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
    text-align: center;
  }
  .add-page-cancel {
    display: block;
    margin: 0 auto;
    padding: 8px 24px;
    background: transparent;
    border: 1px solid var(--divider-color, #444);
    border-radius: 8px;
    color: var(--liza-muted-text);
    cursor: pointer;
    font-size: var(--liza-font-13);
  }
  .add-page-cancel:hover { color: var(--primary-text-color, #fff); border-color: var(--primary-text-color); }

  /* Template picker grid */
  .template-dialog { max-width: 560px; }
  .template-dialog-desc {
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
    margin: -8px 0 16px 0;
  }
  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .template-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 18px 12px;
    border: 2px solid var(--divider-color, #333);
    border-radius: 12px;
    background: transparent;
    color: var(--primary-text-color, #fff);
    cursor: pointer;
    transition: border-color .2s, background .2s;
  }
  .template-card:hover {
    border-color: var(--primary-color, #03a9f4);
    background: rgba(3,169,244,.08);
  }
  .template-card-name { font-size: var(--liza-font-m); font-weight: 500; }
  .template-card-desc { font-size: var(--liza-font-11); color: var(--liza-muted-text); text-align: center; }
  /* A grouped step has a way back as well as a way out. */
  .template-dialog-nav { display: flex; gap: 8px; justify-content: center; }
  /* The cancel button centres itself with auto margins; inside the flex row
     those absorb the free space and push the two buttons apart instead. */
  .template-dialog-nav .add-page-cancel { margin: 0; }
  .template-back {
    padding: 8px 24px;
    background: transparent;
    border: 1px solid var(--divider-color, #444);
    border-radius: 8px;
    color: var(--liza-muted-text);
    cursor: pointer;
    font-size: var(--liza-font-13);
  }
  .template-back:hover { color: var(--primary-text-color, #fff); border-color: var(--primary-text-color); }

  /* Device picker in template flow */
  .template-entity-picker {
    margin-bottom: 20px;
  }
  .template-entity-picker label {
    display: block;
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
    margin-bottom: 6px;
  }
  .template-entity-picker-container {
    width: 100%;
  }
  .template-entity-picker-container ha-device-picker,
  .template-entity-picker-container ha-config-entry-picker,
  .template-entity-picker-container ha-form {
    width: 100%;
  }
  .template-device-select {
    width: 100%;
    padding: 10px;
    border-radius: 6px;
    border: 1px solid var(--divider-color, #444);
    background: var(--card-background-color, #1c1c1c);
    color: var(--primary-text-color, #fff);
    font-size: var(--liza-font-m);
  }
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
  .template-confirm-btn {
    padding: 8px 20px;
    background: var(--liza-accent-fill);
    border: none;
    border-radius: 8px;
    color: #fff;
    font-size: var(--liza-font-m);
    font-weight: 500;
    cursor: pointer;
    transition: opacity .2s;
  }
  .template-confirm-btn:disabled { opacity: .4; cursor: not-allowed; }
  .template-confirm-btn:hover:not(:disabled) { opacity: .85; }

  /* Destructive confirmation. --liza-error-fill rather than a raw --error-color
     for the same reason the accent fill exists: white on it measures 4.85:1,
     clear of WCAG 1.4.3's 4.5:1, which raw #db4437 is not. The message is a
     normal paragraph in the theme's own body colour, so nothing here depends
     on red to be read -- the red is emphasis, not information (1.4.1). */
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
  .confirm-danger-btn {
    padding: 8px 20px;
    background: var(--liza-error-fill);
    border: none;
    border-radius: 8px;
    color: #fff;
    font-size: var(--liza-font-m);
    font-weight: 500;
    cursor: pointer;
    transition: opacity .2s;
  }
  .confirm-danger-btn:hover { opacity: .85; }

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
  /* The input is the only focusable thing in here, so the box wears its ring. */
  .restore-drop:focus-within {
    outline: 2px solid var(--liza-accent-fill);
    outline-offset: 2px;
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
  /* A label wrapping a real file input rather than a button calling click()
     on a detached one: the browser's own picker, opened by the user's own
     click, is the only version every browser reports back from reliably. */
  .restore-pick-btn {
    padding: 9px 22px;
    background: var(--liza-accent-fill);
    border-radius: 8px;
    color: #fff;
    font-size: var(--liza-font-m);
    font-weight: 500;
    cursor: pointer;
  }
  .restore-drop:hover .restore-pick-btn { opacity: .85; }
  .restore-drop .restore-input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .restore-drop-hint {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
  }
  .restore-dialog { position: relative; }
  .restore-dialog .add-page-dialog-title { padding-right: 32px; }
  .restore-dialog-close {
    position: absolute; top: 12px; right: 12px;
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0;
    border: none; border-radius: 50%;
    background: transparent; cursor: pointer;
    color: var(--ha-color-on-neutral-normal, var(--liza-muted-text));
  }
  .restore-dialog-close:hover { background: var(--secondary-background-color); }
  .restore-dialog-close ha-icon { --mdc-icon-size: 20px; }
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
  /* Its own cancel rather than .add-page-cancel, which is "margin: 0 auto"
     because the Add Page dialog puts it alone on its row. Inside this flex
     row that auto margin centred Cancel and stranded Delete at the far right,
     so the pair no longer read as one choice. Same appearance, no margin. */
  .confirm-cancel-btn {
    padding: 8px 20px;
    background: transparent;
    border: 1px solid var(--divider-color, #444);
    border-radius: 8px;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-m);
    cursor: pointer;
  }
  .confirm-cancel-btn:hover {
    color: var(--primary-text-color, #fff);
    border-color: var(--primary-text-color);
  }
`;
