/**
 * lizaIP Panel — Styles: Actions view.
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
export const STYLES_ACTIONS = `
  /* --- Actions View --- */
  .actions-view { max-width: 900px; margin: 0 auto; }
  .actions-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--divider-color);
  }
  .actions-card-title {
    font-size: var(--liza-font-l);
    font-weight: 500;
  }

  .actions-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
  }

  /* --- Actions toolbar: scope chips and sort --- */
  .actions-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--divider-color);
  }
  /* ha-chip-set and ha-filter-chip draw the chips, their selected fill and
     their disabled dimming. A scope is still shown when it is empty, disabled
     rather than removed: a chip that disappears moves the ones beside it, so
     the next press lands on the wrong scope. */
  .scope-chip-count {
    margin-inline-start: 6px;
    opacity: .75;
    font-variant-numeric: tabular-nums;
  }
  .action-sort-select { min-width: 160px; }

  /* --- Actions cleanup bar --- */
  .actions-cleanup-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 16px;
    font-size: var(--liza-font-s);
    background: var(--secondary-background-color);
    border-bottom: 1px solid var(--divider-color);
  }
  .actions-cleanup-bar.warning { color: var(--warning-color, #ff9800); }
/* ha-button carries the fill and the red outline; the bar only places it. */
  .cleanup-btn { flex: 0 0 auto; }

  /* --- Actions domain groups --- */
  .action-group { display: flex; flex-direction: column; gap: 2px; }
  .action-group + .action-group { margin-top: 6px; }
  .action-group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    font: inherit;
    font-size: var(--liza-font-11);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: .5px;
    color: var(--liza-muted-text);
    background: none;
    border: none;
    padding: 8px 12px 4px;
    cursor: pointer;
    text-align: left;
  }
  .action-group-header:hover { color: var(--primary-text-color); }
  .action-group-title { flex: 1; }
  .action-group-count {
    font-variant-numeric: tabular-nums;
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--secondary-background-color);
  }

  .action-badge.duplicate {
    background: transparent;
    border: 1px solid var(--warning-color, #ff9800);
    color: var(--warning-color, #ff9800);
  }
  .action-row.editing .action-badge.duplicate {
    background: transparent;
    border-color: rgba(255,255,255,.6);
    color: #fff;
  }
  /* Secondary to the service it follows: it answers "which one is this", and
     reading as loudly as the service would make every row look longer. */
  .action-where { opacity: .75; }
  .actions-list-card {
    overflow: hidden;
  }
  .action-row {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background .15s, border-color .15s;
    gap: 10px;
  }
  .action-row:hover { background: var(--secondary-background-color); }
  .action-row.editing {
    background: var(--liza-accent-fill);
    color: #fff;
    border-color: var(--primary-color);
    border-radius: 10px 10px 0 0;
  }
  .action-row.editing .action-subtitle { color: #fff; }
  .action-row.editing .action-delete-btn { color: #fff; }
  .action-row.editing .btn-expand-icon { color: #fff; }
  .action-badges {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .action-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--liza-font-11);
    padding: 2px 8px;
    border-radius: 12px;
    background: var(--secondary-background-color);
    color: var(--liza-muted-text);
  }
  .action-badge.unused {
    background: transparent;
    color: var(--liza-muted-text);
    border: 1px dashed var(--secondary-text-color);
    font-style: italic;
  }
  .action-row.editing .action-badge {
    background: rgba(255,255,255,.2);
    color: #fff;
  }
  .action-row.editing .action-badge.unused {
    background: transparent;
    border-color: rgba(255,255,255,.4);
    color: #fff;
  }
  .action-inline-editor {
    padding: 8px 12px 12px;
    background: var(--secondary-background-color);
    border-radius: 0 0 10px 10px;
    margin: -2px 0 4px 0;
    border: 1px solid var(--divider-color);
    border-top: none;
  }
  .assigned-to-section {
    margin: 8px 0;
  }
  .assigned-to-section label {
    font-size: var(--liza-font-11);
    font-weight: 500;
    color: var(--liza-muted-text);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .assigned-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .assigned-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--liza-font-s);
    padding: 3px 10px;
    border-radius: 14px;
    background: var(--liza-accent-fill);
    color: var(--text-primary-color, #fff);
    opacity: 1;
    cursor: pointer;
    transition: filter 0.15s;
  }
  .assigned-chip:hover {
    filter: brightness(0.88);
  }
  .assigned-none {
    font-size: var(--liza-font-s);
    color: var(--liza-muted-text);
    font-style: italic;
  }
  .action-inline-editor .section-title {
    font-size: var(--liza-font-13);
    font-weight: 500;
    margin: 12px 0 8px;
    color: var(--liza-muted-text);
  }
  .action-icon {
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    background: var(--secondary-background-color);
    flex-shrink: 0;
    overflow: hidden;
  }
  .action-row.editing .action-icon { background: rgba(255,255,255,.15); }
  .action-icon ha-icon { --mdc-icon-size: 20px; }
  .action-icon img { border-radius: 4px; }
  .action-info { flex: 1; min-width: 0; }
  .action-name { font-size: var(--liza-font-m); font-weight: 500; }
  .action-subtitle { font-size: var(--liza-font-s); color: var(--liza-muted-text); }
  .icon-picker-slot { flex: 1; }
  .section-title {
    margin: 0 0 8px 0;
    font-size: var(--liza-font-13);
    font-weight: 500;
    color: var(--liza-muted-text);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .states-list { display: flex; flex-direction: column; gap: 8px; }
`;
