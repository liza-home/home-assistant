/**
 * lizaIP Panel — Styles: Tile context menu and the inline accordion editor.
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
export const STYLES_TILE_MENU = `
  /* --- Tile context menu (right-click / long-press on a button) --- */
  /* Fixed rather than absolute: the face sits inside a scrolling column, and an
     absolutely positioned menu would be placed against whichever ancestor
     happens to be positioned and then scroll away from the tile it belongs to.
     The coordinates handed in are viewport coordinates, which is what fixed
     takes. */
  /* The menu the panel draws until Home Assistant's ha-dropdown is loaded;
     ha-dropdown draws itself. */
  div.face-menu {
    position: fixed;
    z-index: 20;
    min-width: 168px;
    /* As wide as its longest label: a row is one phrase, and one that wraps
       reads as two items. A column, so the rows stretch to that width rather
       than asking for a percentage of it. Capped at the viewport. */
    display: flex;
    flex-direction: column;
    width: max-content;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,.24);
  }
  button.face-menu-item {
    /* Flex rather than block: an item may carry an icon, and one that does
       must line its label up with the labels of the items that do not. */
    display: flex;
    align-items: center;
    gap: 10px;
    /* Home Assistant's own menu row: 40px tall, a 24px icon, a 14px label.
       The fallbacks are what the panel used before a theme defines them. */
    min-height: var(--ha-space-10, 40px);
    padding: 8px 12px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-size: var(--ha-font-size-m, var(--liza-font-13));
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    color: var(--primary-text-color);
  }
  button.face-menu-item ha-icon {
    --mdc-icon-size: 24px;
    flex: 0 0 auto;
    color: var(--ha-color-on-neutral-normal, var(--liza-muted-text));
  }
  button.face-menu-item[disabled] {
    cursor: default;
    opacity: .5;
  }
  button.face-menu-item[disabled]:hover { background: transparent; }
  button.face-menu-item:hover {
    background: var(--secondary-background-color);
  }

  div.face-menu-sep {
    height: 1px;
    margin: 4px 8px;
    background: var(--divider-color);
  }
  /* An item that cannot be taken back, kept legible rather than alarming: the
     colour is a warning to read the row, not a reason to avoid it. */
  button.face-menu-item-danger, button.face-menu-item-danger ha-icon {
    color: var(--ha-color-on-danger-quiet, var(--liza-danger-text));
  }
  button.face-menu-item-danger:not([disabled]):hover {
    background: color-mix(in srgb, var(--liza-danger-text) 12%, transparent);
  }

  /* --- Inline accordion editor --- */
  .inline-editor-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .inline-editor-row .action-name-input {
    flex: 1;
  }

  .action-editor-heading {
    margin: 0;
    font-size: var(--liza-font-m);
    font-weight: 500;
    color: var(--liza-muted-text);
  }
  /* A heading with something above it is starting a second section, and a
     break between two sections cannot be the same size as the step inside
     one: at a single step the control that ends the Click list and the
     heading that opens Long touch read as one group, so the add button looks
     like it belongs to the gesture named underneath it. Two steps rather than
     a new number, so the break is still the card's own rhythm. */
  .config-card-body > .action-editor-heading:not(:first-child) {
    margin-top: var(--liza-field-gap);
  }
`;
