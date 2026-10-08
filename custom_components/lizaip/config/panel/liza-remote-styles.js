/**
 * lizaIP Panel — Styles (v3 Action Library)
 */
export const STYLES = `
  :host {
    display: block;
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
    --primary-color: var(--primary-color, #03a9f4);

    /* Text-safe accents for WCAG 1.4.3 (4.5:1). No flat accent passes on both
       HA themes -- the required luminance ranges do not overlap -- so each is
       blended toward --primary-text-color. Text only; fills stay unblended. */
    --liza-accent-text: color-mix(in srgb, var(--primary-color, #03a9f4) 50%, var(--primary-text-color, #212121));
    --liza-success-text: color-mix(in srgb, #4caf50 60%, var(--primary-text-color, #212121));
    --liza-danger-text: color-mix(in srgb, #f44336 78%, var(--primary-text-color, #212121));
    --liza-error-text: color-mix(in srgb, var(--error-color, #db4437) 70%, var(--primary-text-color, #212121));
    /* HA's amber is the weakest semantic colour (#ffa600 is 1.96:1 on white),
       so it needs the largest shift. 45% is the first ratio clearing 4.5:1 on
       the worst light surface (#e5e5e5); 50% drops back to 4.15:1. */
    --liza-warning-text: color-mix(in srgb, var(--warning-color, #ffa600) 45%, var(--primary-text-color, #212121));

    /* Accent fills carrying white text. Plain #03a9f4 gives white only 2.63:1,
       so the fill is darkened until white clears 4.5:1. Theme-independent. */
    --liza-accent-fill: color-mix(in srgb, var(--primary-color, #03a9f4) 71%, #000);
    --liza-error-fill: color-mix(in srgb, var(--error-color, #db4437) 93%, #000);
    /* HA's muted colour is 3.82:1 on --secondary-background-color (light),
       under 1.4.3's 4.5:1. Nudged toward the body text colour: 5.15:1 light,
       7.77:1 dark. Used for every muted string, since the mix only ever
       raises contrast. Non-text uses of --secondary-text-color stay raw. */
    --liza-muted-text: color-mix(in srgb, var(--secondary-text-color, #727272) 75%, var(--primary-text-color, #212121));

    /* Keyboard focus ring. Fixed grey, not a theme variable: a theme-tracking
       colour moves toward one background and away from another. #808080 clears
       1.4.11's 3:1 on the panel's surfaces but NOT in .toolbar (1.24:1 on the
       accent fill), which overrides this token for its own subtree. */
    --liza-focus: #808080;

    /* Selected-state cue: 1.4.11 asks the same 3:1 as a focus ring, and
       --primary-color cannot carry it (#03a9f4 is 2.63:1 on the light theme).
       #0288d1 is the same blue one step down: 3.86:1 white, 4.51:1 #1a1a1a. */
    --liza-selected: #0288d1;

    /* Borrowed from HA's --ha-font-size-* scale, so a theme that raises
       --ha-font-size-scale scales this panel with the rest of the frontend.
       Not rem: HA's root is 14px, so rem would silently shrink everything.
       The fallbacks reproduce today's sizes on an HA without the tokens. */
    --liza-font-xs: var(--ha-font-size-xs, 10px);
    --liza-font-s: var(--ha-font-size-s, 12px);
    --liza-font-m: var(--ha-font-size-m, 14px);
    --liza-font-l: var(--ha-font-size-l, 16px);
    --liza-font-xl: var(--ha-font-size-xl, 20px);
    /* Steps HA has no token for. Same calc() shape as HA's own definitions, so
       they track --ha-font-size-scale identically instead of staying frozen
       while the tokenised sizes around them grow. */
    --liza-font-11: calc(11px * var(--ha-font-size-scale, 1));
    --liza-font-13: calc(13px * var(--ha-font-size-scale, 1));
    --liza-font-15: calc(15px * var(--ha-font-size-scale, 1));
    --liza-font-18: calc(18px * var(--ha-font-size-scale, 1));
    /* The gap between two stacked things in the button config card -- fields
       of the Appearance editor, press boxes in the list, fields inside a press
       box. One value because they are one rhythm: a press box is the same
       editor at a different level, and when its rows sat at 14px and its
       fields at 10px inside a card spacing its own at 16px, the nesting was
       legible as crowding rather than as structure. Not the 4px that separates
       a label from the control it names -- that is a part of one field, not
       two things in a column. */
    --liza-field-gap: 16px;
  }

  /* Headings are h1/h2/h3 for AT navigation (1.3.1), not for styling -- each
     already has a class that sets its own size. Bare type selectors (0,0,1)
     deliberately: ":host h2" scores (0,1,1) and beat every heading class.
     Guarded by "the heading reset must lose to every heading class". */
  h1, h2, h3, h4 {
    margin: 0;
    font-size: inherit;
    font-weight: inherit;
    line-height: inherit;
  }

  .toolbar {
    display: flex;
    align-items: center;
    /* min-height, not height: at 200% text the contents want more than 56px,
       and since .toolbar has no overflow they spilled and -- being sticky with
       z-index:10 -- painted over the view below (1.4.4). flex-wrap lets the
       tabs drop a row instead of squeezing the title; both are inert at normal
       text size. Guarded by "the toolbar must not set a fixed height". */
    flex-wrap: wrap;
    min-height: 56px;
    padding: 0 16px;
    background: var(--app-header-background-color, var(--liza-accent-fill));
    color: var(--app-header-text-color, #fff);
    font-size: var(--liza-font-xl);
    box-shadow: 0 2px 4px rgba(0,0,0,.15);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .toolbar .main-title {
    /* Not 'flex: 1'. Growing the title pushed the status pill against the
       Buttons tab, where it read as a third tab. Sized to content, the pill
       follows the name and the slack falls between it and the tabs. */
    flex: 0 1 auto;
    margin-left: 8px;
    font-weight: 400;
    /* Flex rather than a plain block, so the row is centred by the box model
       instead of by inline metrics, and min-width:0 lets the wrapping child
       actually shrink. */
    display: flex;
    align-items: center;
    min-width: 0;
  }
  /* Wraps rather than ellipsising: there is no title attribute and no second
     copy of the name, so a truncated device name was unrecoverable (1.4.4).
     overflow-wrap:anywhere keeps a spaceless name from widening the row and
     reintroducing horizontal scrolling at 320px (1.4.10). */
  .title-text {
    overflow-wrap: anywhere;
  }
  .toolbar-tabs {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  /* Online/offline. The word carries the state, not the dot: colour alone
     fails 1.4.1, announces nothing (1.1.1), and neither hue reaches 3:1 on
     the toolbar fill. The dot is therefore decoration and aria-hidden. */
  .toolbar-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    /* Placed before the title in the markup, not reordered with 'order': a
       CSS-only reorder would leave reading order disagreeing with visual
       order (1.3.2). '_announceDeviceStatus' announces the pair together, so
       a listener never hears the state without the device it belongs to. */
    margin: 0 10px 0 0;
    flex-shrink: 0;
    /* A tint composited over the theme's own background rather than a fixed
       colour: at 12% it barely moves the surface (11.5:1 at worst, measured),
       so the pill stays decoration and the word keeps carrying the meaning. */
    border-radius: 999px;
    padding: 3px 10px;
    border: 1px solid transparent;
  }
  .toolbar-status.online {
    background: color-mix(in srgb, #2e7d32 12%, transparent);
    border-color: color-mix(in srgb, #2e7d32 30%, transparent);
  }
  .toolbar-status.offline {
    background: color-mix(in srgb, #c62828 12%, transparent);
    border-color: color-mix(in srgb, #c62828 30%, transparent);
  }
  /* Neither green nor red, because the panel does not know. The theme's own
     divider grey rather than amber, which would read as a warning about the
     device when what is uncertain is our information about it. */
  .toolbar-status.unknown {
    background: color-mix(in srgb, var(--app-header-text-color, #fff) 12%, transparent);
    border-color: color-mix(in srgb, var(--app-header-text-color, #fff) 30%, transparent);
  }
  .toolbar-status-text {
    font-size: var(--liza-font-13);
    white-space: nowrap;
  }
  .toolbar-status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .toolbar-status-dot.online { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
  .toolbar-status-dot.offline { background: #f44336; box-shadow: 0 0 4px #f44336; }
  /* Hollow rather than filled, and unlit: the two known states glow, so an
     unknown one that also glowed would look like a third thing the device is
     doing instead of an absence of information. */
  .toolbar-status-dot.unknown {
    background: transparent;
    border: 1.5px solid color-mix(in srgb, var(--app-header-text-color, #fff) 60%, transparent);
    box-sizing: border-box;
  }

  .toolbar-tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    /* Full opacity, not a fade: 70% composited to 3.21:1 on the accent fill,
       under 1.4.3's 4.5:1, and nothing short of 95% clears it. The active tab
       is told apart by font-weight and border-bottom-color instead. */
    color: var(--app-header-text-color, #fff);
    border-radius: 0;
    padding: 6px 14px;
    font-size: var(--liza-font-13);
    cursor: pointer;
    transition: color .15s, border-color .15s;
  }
  .toolbar-tab:hover { color: var(--app-header-text-color, #fff); border-bottom-color: color-mix(in srgb, var(--app-header-text-color, #fff) 40%, transparent); }
  .toolbar-tab.active {
    color: var(--app-header-text-color, #fff);
    border-bottom-color: var(--app-header-text-color, #fff);
    font-weight: 500;
  }
  /* The gear: no text to pad around, so it is squared up to the same 44px
     target as the labelled tabs' height on a tablet. */
  .toolbar-tab-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    padding: 6px 10px;
    --mdc-icon-size: 20px;
  }

  .actions-search {
    display: flex;
    align-items: center;
    background: var(--secondary-background-color, #f5f5f5);
    border-radius: 16px;
    padding: 4px 10px;
    gap: 4px;
  }
  .actions-search ha-icon { color: var(--liza-muted-text); }
  .actions-search .search-input {
    background: none; border: none; outline: none;
    color: var(--primary-text-color);
    font-size: var(--liza-font-13); width: 110px;
  }
  .actions-search .search-input::placeholder { color: var(--liza-muted-text); opacity: 1; }

  .view {
    padding: 16px;
    width: 100%;
    box-sizing: border-box;
  }

  /* --- Device list --- */
  .device-list { display: flex; flex-direction: column; gap: 14px; padding: 12px; }
  .device-item {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    cursor: pointer;
    background: var(--secondary-background-color, #2a2a2a);
    border-radius: 12px;
    transition: transform .15s, box-shadow .15s;
  }
  .device-item:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .device-icon-wrap {
    width: 40px; height: 40px; border-radius: 50%;
    background: var(--primary-color, #03a9f4);
    display: flex; align-items: center; justify-content: center;
    margin-right: 14px; flex-shrink: 0;
  }
  .device-icon-wrap ha-icon { color: #fff; --mdc-icon-size: 20px; }
  .device-info { flex: 1; min-width: 0; }
  .device-title { font-weight: 600; font-size: var(--liza-font-m); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .device-meta { font-size: var(--liza-font-s); color: var(--liza-muted-text); margin-top: 2px; }

  /* The empty state is the only place the panel renders a link. A shadow root
     inherits no link colour from the frontend, so without this the anchor
     lands in browser-default blue next to Home Assistant's palette. */
  .empty-state { padding: 16px; color: var(--liza-muted-text); }
  .empty-state a { color: var(--liza-accent-text); text-decoration: none; font-weight: 500; }
  .empty-state a:hover, .empty-state a:focus-visible { text-decoration: underline; }
  .status-badge { display: flex; align-items: center; gap: 6px; font-size: var(--liza-font-s); font-weight: 500; flex-shrink: 0; margin-left: 12px; }
  .status-badge .dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-badge.online .dot { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
  .status-badge.online { color: var(--liza-success-text); }
  .status-badge.offline .dot { background: #f44336; box-shadow: 0 0 4px #f44336; }
  .status-badge.offline { color: var(--liza-danger-text); }

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
  .btn-add-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 8px 16px;
    border: 1px solid var(--primary-color);
    border-radius: 4px;
    background: transparent;
    color: var(--liza-accent-text);
    font-size: var(--liza-font-13);
    cursor: pointer;
    font-weight: 500;
    transition: background .15s;
  }
  .btn-add-action:hover { background: rgba(3,169,244,.08); }

  .actions-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
  }
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
  .action-edit-btn, .action-delete-btn {
    background: none; border: none; cursor: pointer;
    color: var(--liza-muted-text); padding: 4px;
    border-radius: 4px; transition: background .15s;
  }
  .action-edit-btn:hover, .action-delete-btn:hover { background: rgba(0,0,0,.05); }

  /* --- Editor card (kept for backwards-compat, config-card replaces) --- */
  .editor-card { display: none; }
  .editor-card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--divider-color);
  }
  .editor-card-icon {
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 10px;
    background: var(--secondary-background-color);
    flex-shrink: 0;
    overflow: hidden;
  }
  .editor-card-icon img { border-radius: 4px; }
  .editor-card-title-wrap {
    flex: 1;
    min-width: 0;
  }
  .editor-card-name {
    font-size: var(--liza-font-15);
    font-weight: 500;
  }
  .editor-card-key {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
    font-family: monospace;
  }
  .editor-card-btns {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .btn-test-editor {
    padding: 6px 14px;
    border: 1px solid var(--primary-color);
    background: transparent;
    color: var(--liza-accent-text);
    border-radius: 8px;
    font-size: var(--liza-font-s);
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-test-editor:hover {
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
  }
  .btn-unassign-editor {
    padding: 6px 14px;
    border: 1px solid var(--error-color, #db4437);
    background: transparent;
    color: var(--liza-error-text);
    border-radius: 8px;
    font-size: var(--liza-font-s);
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-unassign-editor:hover {
    background: color-mix(in srgb, var(--error-color, #db4437) 10%, transparent);
  }
  .editor-card-body {
    padding: 16px;
  }
  .editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 8px;
  }
  .editor-title {
    font-size: var(--liza-font-l);
    font-weight: 500;
  }
  .editor-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .editor-meta {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 16px;
  }
  .meta-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .meta-row label {
    font-size: var(--liza-font-13);
    font-weight: 500;
    color: var(--liza-muted-text);
    min-width: 50px;
  }
  .meta-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--divider-color);
    border-radius: 4px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font-size: var(--liza-font-m);
    font-family: inherit;
  }
  .meta-input:focus { outline: none; border-color: var(--primary-color); }
  .icon-picker-slot { flex: 1; }
  .editor-divider {
    height: 1px;
    background: var(--divider-color);
    margin: 12px 0;
  }
  .section-title {
    margin: 0 0 8px 0;
    font-size: var(--liza-font-13);
    font-weight: 500;
    color: var(--liza-muted-text);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .steps-list { margin-bottom: 4px; }
  .step-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--secondary-background-color);
    margin-bottom: 4px;
    font-size: var(--liza-font-13);
  }
  .step-num { color: var(--liza-muted-text); font-weight: 500; min-width: 18px; }
  .step-service { font-weight: 500; color: var(--primary-text-color); }
  .step-target { color: var(--liza-muted-text); font-size: var(--liza-font-s); }
  .states-list { display: flex; flex-direction: column; gap: 8px; }

  .btn-toggle-mode {
    display: inline-flex;
    align-items: center;
    padding: 6px 10px;
    border: 1px solid var(--divider-color);
    border-radius: 4px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    cursor: pointer;
  }
  .btn-toggle-mode:hover { background: var(--secondary-background-color); }

  /* --- Buttons View (two-column wireframe layout) --- */
  .config-layout {
    display: flex;
    flex-direction: column;
    gap: 24px;
    width: 100%;
    padding: 0 16px;
    box-sizing: border-box;
  }
  .config-layout > .config-card {
    display: flex;
    flex-direction: column;
  }
  .config-layout > .config-card .config-card-body {
    flex: 1;
    overflow-y: auto;
  }

  /* Pages card */
  .pages-card { padding: 0; overflow: hidden; }
  .pages-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--divider-color);
  }
  .pages-card-title { font-size: var(--liza-font-13); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--liza-muted-text); }
  .pages-card-actions { display: flex; gap: 4px; }
  .pages-card-actions ha-icon-button { --mdc-icon-button-size: 34px; --mdc-icon-size: 20px; }
  .pages-list {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 12px;
    /* 47px, not 14px, at the bottom: the inline overflow-x:auto on this
       element (set where it is rendered) forces overflow-y to the computed
       value "auto" too (CSS requires that once either axis isn't "visible"),
       which turns this row into a scroll container. A scroll container's own
       height comes only from normal layout -- a translateY shift (see
       .page-thumb.subpage) moves paint, not layout, so the shifted 7% was
       *scrollable* overflow rather than visible, and a min-height bump here
       cannot reach it either, since content already determines the row's
       height well past any floor that sets. The fixed crop every thumbnail's
       svg uses (viewBox "32 33 108 295" in _refreshSVG) makes a thumb's
       rendered height entirely predictable from its own fixed width: content
       width 168px (180 minus this rule's own 12px side padding, times two)
       times 295/108 is ~459px, so its 7% is ~32px -- the extra 33px here, on
       top of the original 14px, is that shift, made part of the row's actual
       layout height so nothing is left over to scroll for.
    */
    padding: 14px 12px 47px 12px;
    scrollbar-width: thin;
  }
  .pages-list::-webkit-scrollbar { height: 4px; }
  .pages-list::-webkit-scrollbar-thumb { background: var(--divider-color); border-radius: 2px; }
  .page-thumb {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 180px;
    padding: 6px;
    border-radius: 14px;
    cursor: pointer;
    border: 2px solid color-mix(in srgb, var(--primary-text-color) 8%, transparent);
    background: color-mix(in srgb, var(--primary-text-color) 2%, transparent);
    position: relative;
    transition: border-color .2s, background .2s, box-shadow .2s, transform .15s;
    overflow: hidden;
    /* How far this thumb slides to open the gap a drag is aiming at, written
       by _wirePageReorder. A custom property rather than an inline transform:
       inline would outrank the three rules below and silently drop a
       subpage's offset or the hover scale, so a subpage would jump the moment
       a drag displaced it. Every rule that sets transform on a thumb has to
       restate this, which the stylesheet test enforces. */
    transform: translateX(var(--pg-shift, 0px));
  }
  /* The 3% grow is a *hover* answer -- "this is the one under your pointer" --
     and nothing to do with which page is open: that is .active's blue frame
     alone. Behind a hover query because iOS has no hover to give and emulates
     one instead, leaving the last-tapped thumb grown until something else is
     tapped. A page that failed to open then still sat there enlarged, looking
     selected, with no blue frame on it -- two cues contradicting each other.
     On a touch screen the frame is now the only thing that claims anything. */
  @media (hover: hover) and (pointer: fine) {
    .page-thumb:hover {
      background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
      border-color: color-mix(in srgb, var(--primary-text-color) 20%, transparent);
      transform: translateX(var(--pg-shift, 0px)) scale(1.03);
    }
  }
  /* A subpage has the same background and border as a main page; it only
     sits lower than the main pages beside it -- the cue that it is out of the
     remote's page list. 7% of its own box, via transform rather than a
     percentage margin: a vertical margin's percentage is of the *container's
     width*, which would have shifted every subpage by the same amount
     regardless of its own height. */
  .page-thumb.subpage {
    transform: translateX(var(--pg-shift, 0px)) translateY(7%);
  }
  @media (hover: hover) and (pointer: fine) {
    .page-thumb.subpage:hover {
      /* Same specificity as .page-thumb:hover, declared after it, so its lone
         transform: scale(1.03) would otherwise win outright and the offset
         would vanish exactly while hovering. Restated together with it. */
      transform: translateX(var(--pg-shift, 0px)) translateY(7%) scale(1.03);
    }
  }
  /* The frame a drop is applied in. Removing the drag offsets would otherwise
     animate every displaced thumb back to where the drag started -- including
     the one that has just been moved in the DOM, so the card the user placed
     slides back to its origin and settles again. Set by the drop handler and
     removed on the next frame, so ordinary hovers keep their transition. */
  .pages-list.reordering .page-thumb {
    transition: none;
  }
  .page-thumb.active {
    border-color: var(--liza-selected);
    background: rgba(3,169,244,.04);
    box-shadow: 0 0 12px rgba(3,169,244,.2);
  }
  .page-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    flex-shrink: 0;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: 2px dashed color-mix(in srgb, var(--primary-text-color) 25%, transparent);
    background: transparent;
    cursor: pointer;
    transition: border-color .2s, background .2s, transform .15s;
  }
  .page-add-btn:hover {
    border-color: rgba(3,169,244,.7);
    background: rgba(3,169,244,.1);
    transform: scale(1.08);
  }
  .page-add-btn:hover ha-icon { color: rgba(3,169,244,.9) !important; }

  /* SVG container inside each page item */
  .pg-svg-container {
    width: 100%;
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    color: var(--primary-text-color);
    /* A press on the face starts a click or a drag, never a selection sweep.
       Nothing is lost: the labels live in the imgserv PNGs, not in the DOM. */
    user-select: none;
    -webkit-user-select: none;
  }
  .pg-svg-container svg {
    display: block;
    width: 100%;
    height: auto;
  }
  /* HTML <img> overlays: actual imgserv PNGs positioned over the SVG button shapes */
  .pg-svg-container .pg-btn-img {
    position: absolute;
    object-fit: contain;
    pointer-events: none;
  }
  /* Bounds the title overlay to the slider bar. A title longer than the title
     area is meant to overflow, but only within the bar - this is what stops the
     spill from being painted across the button grid underneath. */
  .pg-svg-container .pg-title-clip {
    position: absolute;
    overflow: hidden;
    pointer-events: none;
  }
  /* Sized in JS to the PNG's natural size times the device->user-unit scale, so
     the element already carries the image's aspect ratio and "fill" maps it 1:1.
     "contain" would re-fit it inside a box that already matches and only add
     letterboxing from percentage rounding. Positioned by the same code, centred
     on the bar on both axes. */
  .pg-svg-container .pg-title-img {
    object-fit: fill;
    object-position: center center;
  }
  /* SVG button overlay styles — pointer-events:all is critical for clickability */
  .pg-svg-container .button {
    fill: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
    stroke: color-mix(in srgb, var(--primary-text-color) 20%, transparent);
    stroke-width: 0.5;
    cursor: pointer;
    pointer-events: all;
    transition: fill .15s, stroke .15s;
  }
  .pg-svg-container .button:hover {
    fill: rgba(3,169,244,.18);
    stroke: var(--primary-color, #03a9f4);
    stroke-width: 1;
  }
  .pg-svg-container .button[configured] {
    fill: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    stroke: var(--divider-color, rgba(127,127,127,.3));
    stroke-width: 0.6;
  }
  .pg-svg-container .button[selected] {
    fill: rgba(3,169,244,.2);
    stroke: var(--liza-selected);
    stroke-width: 1.5;
  }
  .pg-svg-container .button[selected]:not([configured]) {
    fill: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    stroke: var(--liza-selected);
    stroke-width: 1.5;
  }
  .pg-svg-container .button[empty] {
    fill: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    stroke: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
    stroke-width: 0.4;
  }
  /* --- Volume rocker (one pill, three zones) -----------------------------
     No hover state anywhere on this control. Because the caps sit on top of
     the pill, a per-zone hover would flicker the fill on and off every time
     the pointer crossed a cap boundary. Assignment and selection are the only
     things that change how it looks.
     The :not([selected]) guards keep the blue selected rules winning. */

  /* +/- caps: no fill of their own when they carry nothing — the pill shows
     through, so an untouched rocker reads as one empty control rather than
     three. A cap that *is* assigned paints like any other configured button
     (rule below): the caps and the pill are separately assignable, so the face
     has to be able to say that the ends are set up while the middle is not.
     Nothing here depends on hover, so crossing a cap boundary still changes
     nothing. */
  .pg-svg-container .button[data-key="button_volume_up"]:not([selected]),
  .pg-svg-container .button[data-key="button_volume_down"]:not([selected]),
  .pg-svg-container .button[data-key="button_volume_up"]:not([selected]):hover,
  .pg-svg-container .button[data-key="button_volume_down"]:not([selected]):hover {
    fill: transparent;
    stroke: none;
    stroke-width: 0;
  }
  /* Assigned caps: the standard configured paint. More specific than the rule
     above (one extra attribute), so it wins wherever it applies without needing
     to come after it. */
  .pg-svg-container .button[data-key="button_volume_up"][configured]:not([selected]),
  .pg-svg-container .button[data-key="button_volume_down"][configured]:not([selected]),
  .pg-svg-container .button[data-key="button_volume_up"][configured]:not([selected]):hover,
  .pg-svg-container .button[data-key="button_volume_down"][configured]:not([selected]):hover {
    fill: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    stroke: var(--divider-color, rgba(127,127,127,.3));
    stroke-width: 0.6;
  }
  /* Slider pill: identical fill/stroke to a normal button in the same state —
     these rules exist only to suppress hover, not to restyle. Keep the values
     in sync with .button[empty] / .button[configured] above. */
  .pg-svg-container .button[data-key="slider_vertical"][empty]:not([selected]),
  .pg-svg-container .button[data-key="slider_vertical"][empty]:not([selected]):hover {
    fill: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    stroke: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
    stroke-width: 0.4;
  }
  .pg-svg-container .button[data-key="slider_vertical"][configured]:not([selected]),
  .pg-svg-container .button[data-key="slider_vertical"][configured]:not([selected]):hover {
    fill: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    stroke: var(--divider-color, rgba(127,127,127,.3));
    stroke-width: 0.6;
  }
  /* Dashed cap separators — same weight/colour as the empty button outline */
  .pg-svg-container .rocker-separator {
    fill: none;
    stroke: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
    stroke-width: 0.4;
    stroke-dasharray: 2,2;
    pointer-events: none;
  }
  /* +/- caps selected: blue round highlight */
  .pg-svg-container .button[data-key="button_volume_up"][selected],
  .pg-svg-container .button[data-key="button_volume_down"][selected] {
    fill: rgba(3,169,244,.2);
    stroke: var(--liza-selected);
    stroke-width: 1.5;
  }
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
     opens that button in one gesture (see onSelect in liza-remote-buttons-view
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
  /* Ghosted, not hidden: it keeps its slot in the layout so the gap stays
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
  .ctx-page-default {
    background: none; border: 1px solid var(--divider-color, rgba(127,127,127,.3));
    border-radius: 10px; padding: 1px 8px; cursor: pointer;
    font-size: var(--liza-font-11); color: var(--liza-muted-text);
  }
  .ctx-page-default:hover { border-color: var(--primary-color, #03a9f4); color: var(--liza-accent-text); }

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
  /* Label row with reset button.
     The border belongs to the *row*, not to the input inside it, so the
     trailing controls sit within the field the way Home Assistant's own
     text fields carry their trailing icons.
     Two things were wrong with putting them beside it. The input was
     flex: 1 next to buttons that appear only once you start typing, so the
     field physically shrank under the caret as it was used. And the box
     stopped ~90px short of the icon picker directly above it, which is the
     one field on this card it most obviously should line up with. Bordering
     the row fixes both at once: the box is always the full width, and what
     changes inside it no longer moves its edges. */
  .config-label-row {
    display: flex;
    gap: 2px;
    align-items: center;
    padding-inline-end: 6px;
    border: 1px solid var(--divider-color);
    border-radius: 8px;
    background: var(--card-background-color);
  }
  /* The focus ring follows the border it belongs to. Without this, focusing
     the input lit nothing -- its own border is gone. */
  .config-label-row:focus-within { border-color: var(--primary-color); }
  .config-label-row input[type="text"] {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
  }
  .config-label-row input[type="text"]:focus { outline: none; }
  /* Only the reset. The confirm/cancel pair this used to list with it is
     gone: a tooltip now commits on Enter or blur, so there is nothing left
     to confirm. */
  .config-label-reset {
    border: none;
    background: transparent;
    font-size: var(--liza-font-l);
    cursor: pointer;
    color: var(--liza-muted-text);
    padding: 4px 6px;
    border-radius: 4px;
    transition: all .15s;
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }
  .config-label-reset:hover { background: color-mix(in srgb, var(--primary-color) 15%, transparent); color: var(--liza-accent-text); }
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
  .config-field select, .config-field input[type="text"] {
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
  .config-field select:focus, .config-field input[type="text"]:focus {
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
     of appearance rather than of structure -- and go out of the layout
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

  .btn-test-config,
  .slider-reset-control {
    padding: 6px 14px;
    border: 1px solid var(--primary-color);
    background: transparent;
    color: var(--liza-accent-text);
    border-radius: 8px;
    font-size: var(--liza-font-s);
    font-weight: 500;
    cursor: pointer;
    transition: background .15s;
  }
  .btn-test-config:hover,
  .slider-reset-control:hover { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
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
       the layout on both edges, so the words sit one step below the last card
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
  .ps-reorder-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 8px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    cursor: pointer;
    transition: background .15s;
  }
  .ps-reorder-btn:hover:not(:disabled) { background: var(--secondary-background-color); }
  .ps-reorder-btn:disabled { opacity: .3; cursor: default; }
  .ps-layout-target-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 8px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background .15s;
  }
  .ps-layout-target-btn:hover { background: var(--secondary-background-color); }
  .ps-layout-target-name {
    flex: 1;
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
    width: 90px;
    font-size: var(--liza-font-s);
    padding: 5px 8px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    font-family: monospace;
  }
  .ps-color-input:focus { outline: none; border-color: var(--primary-color); }
  .ps-color-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--liza-muted-text);
    cursor: pointer;
    border-radius: 50%;
    opacity: .5;
    transition: opacity .15s, background .15s;
  }
  .ps-color-clear:hover { opacity: 1; background: var(--secondary-background-color); }

  /* --- Tile context menu (right-click / long-press on a button) --- */
  /* Fixed rather than absolute: the face sits inside a scrolling column, and an
     absolutely positioned menu would be placed against whichever ancestor
     happens to be positioned and then scroll away from the tile it belongs to.
     The coordinates handed in are viewport coordinates, which is what fixed
     takes. */
  .face-menu {
    position: fixed;
    z-index: 20;
    min-width: 168px;
    padding: 4px;
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,.24);
  }
  .face-menu-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-size: var(--liza-font-13);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    color: var(--primary-text-color);
  }
  .face-menu-item:hover, .face-menu-item:focus-visible {
    background: var(--secondary-background-color);
    outline: none;
  }
  .face-menu-sep {
    height: 1px;
    margin: 4px 8px;
    background: var(--divider-color);
  }

  /* --- Inline accordion editor --- */
  .btn-inline-editor {
    padding: 8px 12px 12px;
    background: var(--secondary-background-color);
    border-radius: 0 0 10px 10px;
    margin: -2px 0 4px 0;
    border: 1px solid var(--divider-color);
    border-top: none;
  }
  .inline-editor-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .inline-editor-row label {
    font-size: var(--liza-font-s);
    font-weight: 500;
    color: var(--liza-muted-text);
    min-width: 40px;
  }
  .inline-editor-row .meta-input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--divider-color);
    border-radius: 6px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font-size: var(--liza-font-13);
    font-family: inherit;
  }
  .inline-editor-row .meta-input:focus {
    outline: none;
    border-color: var(--primary-color);
  }
  .inline-editor-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--divider-color);
  }
  .btn-unassign {
    background: none;
    border: 1px solid var(--error-color, #db4437);
    color: var(--liza-error-text);
    border-radius: 8px;
    padding: 4px 12px;
    font-size: var(--liza-font-s);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: background .15s;
  }
  .btn-unassign:hover {
    background: color-mix(in srgb, var(--error-color, #db4437) 10%, transparent);
  }

  /* --- Assign card --- */
  .assign-card {
    margin-top: 16px;
    padding: 16px;
  }
  .assign-header {
    font-size: var(--liza-font-m);
    margin-bottom: 12px;
  }
  .assign-select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--divider-color);
    border-radius: 4px;
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font-size: var(--liza-font-m);
    font-family: inherit;
    cursor: pointer;
  }
  .assign-select:focus { outline: none; border-color: var(--primary-color); }
  .assign-hint {
    font-size: var(--liza-font-s);
    color: var(--liza-muted-text);
    margin-top: 8px;
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

  /* --- Debug tab --- */
  /* Kept here rather than in the debug view's own module: the stylesheet is
     one string shipped whole, and the view is loaded dynamically. */
  .debug-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }
  .debug-body {
    padding: 0 16px 16px;
  }
  .debug-body .hint-text {
    padding: 8px 0;
    text-align: left;
  }
  .debug-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
  /* Native buttons in the same shape the rest of the panel uses. Sized to the
     44px touch target the panel is operated at on a tablet, which is also what
     makes them read as pressable rather than as text. */
  .debug-btn {
    /* The reset is deliberate even though most buttons here omit it: a native
       button keeps the platform's own text colour until its appearance is
       cleared, and these are read on a tablet WebKit as well as in Chrome. */
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 18px;
    border: 1px solid var(--primary-color, #03a9f4);
    border-radius: 8px;
    background: transparent;
    color: var(--liza-accent-text);
    font-family: inherit;
    font-size: var(--liza-font-s);
    font-weight: 500;
    cursor: pointer;
    transition: background .15s, box-shadow .15s, transform .05s;
  }
  .debug-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent);
  }
  /* A pressed state, because the two slowest actions here take a round trip to
     the device and the only other feedback is the label changing. */
  .debug-btn:active:not(:disabled) { transform: translateY(1px); }
  .debug-btn:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
  }
  /* The filled variant takes the pre-darkened accent rather than the raw theme
     colour. Two reasons, both measured: white on --primary-color is 2.63:1,
     under the 4.5:1 AA floor, while white on this fill is 4.89:1; and the theme
     defines --primary-color through another token with no fallback of its own,
     so when that token is missing the background collapses to transparent and
     white label sits on a white card. The fill token carries its own fallback,
     which keeps the surface solid either way. */
  .debug-btn.primary {
    background: var(--liza-accent-fill);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 1px 2px rgba(0, 0, 0, .2);
  }
  .debug-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--liza-accent-fill) 88%, black);
  }
  /* A switch, styled like HA's own: a track the thumb slides in. Native, so it
     needs the same appearance reset, and :disabled dims the whole control
     rather than hiding it -- it is unavailable for one round trip, not gone.
     NB: no backticks in this comment; it sits inside a template literal. */
  .debug-switch {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0;
    border: none;
    background: none;
    /* inherit, not a token: the label has to match whatever the surrounding
       card already renders text in, and a button would otherwise fall back to
       the UA's own buttontext, which is dark on a dark card. */
    color: inherit;
    font-family: inherit;
    font-size: var(--liza-font-s);
    font-weight: 500;
    cursor: pointer;
  }
  .debug-switch-track {
    position: relative;
    width: 40px;
    height: 22px;
    border-radius: 999px;
    background: var(--divider-color, #9e9e9e);
    transition: background .18s;
    flex: none;
  }
  .debug-switch-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
    transition: transform .18s;
  }
  .debug-switch[aria-checked="true"] .debug-switch-track { background: var(--primary-color, #03a9f4); }
  .debug-switch[aria-checked="true"] .debug-switch-thumb { transform: translateX(18px); }
  .debug-switch:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; border-radius: 8px; }
  .debug-switch:disabled { opacity: .5; cursor: default; }
  /* Where the stream's output actually goes. A shadow root does not inherit
     the document's link colour, so the anchor has to be told -- the same
     reason .empty-state a exists. */
  .debug-traffic-subtitle {
    margin: 14px 0 6px;
    font-size: var(--liza-font-13);
    font-weight: 600;
  }
  .debug-traffic-frames {
    max-height: 360px;
    overflow: auto;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 8px;
    font-family: var(--code-font-family, monospace);
    font-size: var(--liza-font-s);
  }
  .debug-traffic-frames table { border-collapse: collapse; width: 100%; }
  .debug-traffic-frames td { padding: 2px 8px; white-space: nowrap; vertical-align: top; }
  .debug-traffic-frames td:last-child { white-space: normal; overflow-wrap: anywhere; width: 100%; }
  .debug-traffic-frames tr.bad td { color: var(--error-color, #f44336); }
  .debug-traffic-frames tr.warn td { color: var(--warning-color, #ff9800); }
  .debug-live { margin: 10px 0 0; font-size: var(--liza-font-s); color: var(--liza-muted-text); }
  .debug-live a { color: var(--liza-accent-text); text-decoration: none; font-weight: 500; }
  .debug-live a:hover, .debug-live a:focus-visible { text-decoration: underline; }

  .debug-btn:disabled {
    /* Dimmed rather than hidden: a control that vanishes mid-request reads as
       a fault, and these disable themselves for the length of one call. */
    opacity: .5;
    cursor: default;
    box-shadow: none;
  }
  .debug-verdict {
    font-size: var(--liza-font-l);
    font-weight: 600;
    margin: 8px 0;
  }
  .debug-verdict.ok { color: var(--success-color, #4caf50); }
  .debug-verdict.bad { color: var(--error-color, #f44336); }
  .debug-facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 0;
    font-size: var(--liza-font-m);
  }
  .debug-facts dt { color: var(--liza-muted-text); }
  .debug-facts dd { margin: 0; overflow-wrap: anywhere; }
  /* One row per module: the name left, its level right. A grid rather than a
     table because the pair is a label and its control, not tabular data, and a
     screen reader should meet them as such. */
  .debug-levels {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 16px;
    align-items: center;
    font-size: var(--liza-font-m);
  }
  /* The row is a grid item that lays its own two cells into the parent grid,
     so every select lines up across rows however long the module names are. */
  .debug-level-row { display: contents; }
  .debug-level-row label { color: var(--liza-muted-text); }
  /* A shadow root inherits no form styling from the document, so the select
     would otherwise render in the browser's own colours -- which on a dark
     theme means black text on a black card. */
  .debug-level-select {
    width: 100%;
    max-width: 220px;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--divider-color, rgba(127,127,127,0.4));
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-family: inherit;
    font-size: var(--liza-font-m);
  }
  .debug-level-select:disabled { opacity: 0.6; }
  .debug-error {
    color: var(--error-color, #f44336);
    font-size: var(--liza-font-m);
    overflow-wrap: anywhere;
  }
  .debug-section summary {
    cursor: pointer;
    font-size: var(--liza-font-m);
    padding: 4px 0;
    /* The heading and its one control share the line. Kept as list-item: a
       flex summary drops the disclosure triangle, and the triangle is what
       says the row can be opened at all. */
    display: list-item;
  }
  .debug-section-name { margin-right: 8px; }
  /* Pushed to the right edge of the summary line rather than placed after the
     text, so the buttons line up down the list instead of stepping in and out
     with the length of each endpoint's name. */
  .debug-section summary .debug-pretty-btn { float: right; }
  .debug-dump {
    /* A device dump is arbitrary length and arbitrary width; bound both so one
       long line cannot stretch the panel sideways. */
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* The device colours this text with terminal escapes, and those colours are
       defined against a dark terminal background -- on the panel's own surface
       half of them would be unreadable. Fixing the surface is what keeps the
       device's colours themselves untouched. */
    background: #1b1b1b;
    color: #d0d0d0;
    border-radius: 6px;
    padding: 8px;
    font-family: var(--liza-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: var(--liza-font-s);
    margin: 4px 0 8px;
  }

  /* The standard 16 terminal colours, as the device means them. Not theme
     tokens: a theme would shift the hues, and the colour is the device's
     statement about the line, not ours. */
  /* JSON syntax colours. Chosen against the dump's own dark surface, and from
     the same palette as the terminal colours above so one block of text does
     not look like it came from two different programs. */
  .debug-dump .json-key  { color: #5c8cd6; }
  .debug-dump .json-str  { color: #4e9a06; }
  .debug-dump .json-num  { color: #c4a000; }
  .debug-dump .json-bool { color: #a347ba; }
  .debug-dump .json-null { color: #8a8a8a; font-style: italic; }
  .debug-section-note {
    padding: 4px 10px 8px;
    font-size: 12px;
    color: var(--warning-color, #ffa600);
  }
  .debug-pretty-btn {
    /* The panel loads none of Home Assistant's form components, so a button
       here gets no inherited colour at all -- without these it renders as
       black text on a black surface. */
    font: inherit;
    font-size: 0.85em;
    cursor: pointer;
    padding: 2px 10px;
    border-radius: 12px;
    border: 1px solid var(--divider-color, #444);
    background: var(--secondary-background-color, #2b2b2b);
    color: var(--primary-text-color, #e0e0e0);
  }
  .debug-pretty-btn:hover { border-color: var(--primary-color, #5c8cd6); }
  .debug-pretty-btn.on {
    border-color: var(--primary-color, #5c8cd6);
    color: var(--primary-color, #5c8cd6);
  }
  .debug-dump .a-fg-0  { color: #3f3f3f; }
  .debug-dump .a-fg-1  { color: #cc4b4b; }
  .debug-dump .a-fg-2  { color: #4e9a06; }
  .debug-dump .a-fg-3  { color: #c4a000; }
  .debug-dump .a-fg-4  { color: #5c8cd6; }
  .debug-dump .a-fg-5  { color: #a347ba; }
  .debug-dump .a-fg-6  { color: #06989a; }
  .debug-dump .a-fg-7  { color: #d3d7cf; }
  .debug-dump .a-fg-8  { color: #7f7f7f; }
  .debug-dump .a-fg-9  { color: #ef5350; }
  .debug-dump .a-fg-10 { color: #8ae234; }
  .debug-dump .a-fg-11 { color: #fce94f; }
  .debug-dump .a-fg-12 { color: #82aaff; }
  .debug-dump .a-fg-13 { color: #e07be0; }
  .debug-dump .a-fg-14 { color: #34e2e2; }
  .debug-dump .a-fg-15 { color: #ffffff; }
  .debug-dump .a-bg-0  { background-color: #3f3f3f; }
  .debug-dump .a-bg-1  { background-color: #cc4b4b; }
  .debug-dump .a-bg-2  { background-color: #4e9a06; }
  .debug-dump .a-bg-3  { background-color: #c4a000; }
  .debug-dump .a-bg-4  { background-color: #5c8cd6; }
  .debug-dump .a-bg-5  { background-color: #a347ba; }
  .debug-dump .a-bg-6  { background-color: #06989a; }
  .debug-dump .a-bg-7  { background-color: #d3d7cf; }
  .debug-dump .a-bg-8  { background-color: #7f7f7f; }
  .debug-dump .a-bg-9  { background-color: #ef5350; }
  .debug-dump .a-bg-10 { background-color: #8ae234; }
  .debug-dump .a-bg-11 { background-color: #fce94f; }
  .debug-dump .a-bg-12 { background-color: #82aaff; }
  .debug-dump .a-bg-13 { background-color: #e07be0; }
  .debug-dump .a-bg-14 { background-color: #34e2e2; }
  .debug-dump .a-bg-15 { background-color: #ffffff; }
  .debug-dump .a-bold { font-weight: 700; }
  .debug-dump .a-dim { opacity: .65; }
  .debug-dump .a-italic { font-style: italic; }
  .debug-dump .a-underline { text-decoration: underline; }

  /* --- Shared --- */
  .hint-text {
    color: var(--liza-muted-text);
    font-size: var(--liza-font-m);
    padding: 24px 0;
    text-align: center;
  }
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--liza-accent-fill);
    color: #fff;
    padding: 10px 24px;
    border-radius: 8px;
    font-size: var(--liza-font-m);
    z-index: 999;
    opacity: 0;
    transition: opacity .3s;
    pointer-events: none;
  }
  .toast.show { opacity: 1; }

  /* ===== Layout Dialog Styles ===== */
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
  .add-page-dialog-options {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }
  .add-page-option {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 20px 16px;
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

  /* Layout picker grid */
  .layout-dialog { max-width: 560px; }
  .layout-dialog-desc {
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
    margin: -8px 0 16px 0;
  }
  .layout-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .layout-card {
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
  .layout-card:hover {
    border-color: var(--primary-color, #03a9f4);
    background: rgba(3,169,244,.08);
  }
  .layout-card-name { font-size: var(--liza-font-m); font-weight: 500; }
  .layout-card-desc { font-size: var(--liza-font-11); color: var(--liza-muted-text); text-align: center; }

  /* Device picker in layout flow */
  .layout-entity-picker {
    margin-bottom: 20px;
  }
  .layout-entity-picker label {
    display: block;
    font-size: var(--liza-font-13);
    color: var(--liza-muted-text);
    margin-bottom: 6px;
  }
  .layout-entity-picker-container {
    width: 100%;
  }
  .layout-entity-picker-container ha-device-picker,
  .layout-entity-picker-container ha-config-entry-picker,
  .layout-entity-picker-container ha-form {
    width: 100%;
  }
  .layout-device-select {
    width: 100%;
    padding: 10px;
    border-radius: 6px;
    border: 1px solid var(--divider-color, #444);
    background: var(--card-background-color, #1c1c1c);
    color: var(--primary-text-color, #fff);
    font-size: var(--liza-font-m);
  }
  .layout-entity-hint {
    font-size: var(--liza-font-11);
    color: var(--liza-muted-text);
    margin-top: 6px;
  }
  .layout-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
  .layout-confirm-btn {
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
  .layout-confirm-btn:disabled { opacity: .4; cursor: not-allowed; }
  .layout-confirm-btn:hover:not(:disabled) { opacity: .85; }

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

  /* --- Slider Config UI --- */
  /* ha-entity-picker draws its own label above its own field box. A border
     here would wrap both and read as a box inside a box, which is what the
     stripped-fill styling this replaced ended up doing. */
  .slider-entity-picker-container ha-entity-picker {
    display: block;
    width: 100%;
  }
  input.slider-attribute-input,
  select.slider-attribute-input,
  .slider-service-input,
  .slider-entity-fallback,
  .slider-datakey-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.3));
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #333);
    font-size: var(--liza-font-13);
    font-family: monospace;
  }
  /* Native <select> chevrons are drawn by the OS: a thin outline glyph jammed
     against the right edge, which looks nothing like the filled Material
     triangle ha-entity-picker and ha-icon-picker render immediately above and
     below on the same card. Draw mdi:menu-down ourselves so every control
     agrees, and inset it by the same 12px as the text padding so it isn't
     flush to the border.

     Must come after .slider-attribute-input above: that rule has the same
     specificity as .config-field select, so an earlier padding-right here
     would lose and the Attribute dropdown's text would run under the arrow. */
  .config-field select {
    -webkit-appearance: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23888888' d='M7,10L12,15L17,10H7Z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    background-size: 24px 24px;
    padding-right: 44px;
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
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding: 6px 14px;
    border: 1px solid var(--primary-color);
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
    color: var(--liza-accent-text);
    font-size: var(--liza-font-13);
    font-weight: 500;
    line-height: 1.4;
    cursor: pointer;
  }
  .slider-ctx-use-default:hover {
    background: color-mix(in srgb, var(--primary-color) 20%, transparent);
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
  .slider-range-row > div {
    flex: 1;
  }
  .slider-range-row input[type="number"],
  .slider-factor-input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.3));
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #333);
    font-size: var(--liza-font-13);
  }
  /* Sensitivity holds a single number like "1" — a full-width box for it
     looks broken, and unlike Min/Max it isn't sharing a row with anything. */
  .slider-factor-input { width: 96px; }

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

  /* ── keyboard focus ────────────────────────────────────────────────
     HA's geometry (2px outline, 2px offset) but not its colour -- see
     --liza-focus above. No border-radius, so the ring follows the element's
     own shape. !important throughout: the panel's state rules are written
     far heavier than any focus selector can be, and 2.4.7 is not optional. */
  /* Announcements only. Clipped rather than display:none, which would take
     it out of the accessibility tree and silence it. */
  .liza-sr-only {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; border: 0;
    clip-path: inset(50%); overflow: hidden; white-space: nowrap;
  }

  :host *:focus-visible {
    outline: 2px solid var(--liza-focus) !important;
    outline-offset: 2px !important;
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

  /* Text fields clear the outline on :focus and signal focus with a 1px
     border colour instead, which is easy to miss; put the ring back. */
  :host input:focus-visible,
  :host select:focus-visible,
  :host textarea:focus-visible {
    outline: 2px solid var(--liza-focus) !important;
    outline-offset: 1px !important;
  }

  /* Three corrections the generic ring cannot make. opacity:1 -- the button
     is invisible until hover, and a blind focus on a *delete* is the worst
     one to hand over. Negative offset -- .page-thumb is overflow:hidden, so
     an outset ring is clipped (2.4.11). And the hover fill, because the icon
     is itself a circle and a grey ring beside it read as a double edge. */
  .page-thumb-del:focus-visible {
    opacity: 1;
    outline-offset: -2px !important;
    background: var(--liza-error-fill);
    color: #fff;
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

  /* The add button is a dashed circle at rest, so an outset ring made two
     concentric circles. The dashes go solid instead -- one indicator, and
     broken-to-continuous reads without colour. border-width is restated
     because the rest state sets it via a shorthand whose color-mix can
     fail, falling back to 'medium' (3px) against everything else's 2px. */
  .page-add-btn:focus-visible {
    border-style: solid;
    border-width: 2px;
    border-color: var(--liza-focus);
    outline: none !important;
  }

  /* WCAG 1.4.10 Reflow. In one row only the device name can shrink, so under
     pressure it collapses and then the tabs are pushed off the edge. Measured
     across the four translations, the narrowest lossless single row is 560px
     (Spanish, 200% text); 600 is the first round number clear of it.
     Below that the tabs wrap -- via flex-wrap, so DOM order and therefore
     reading order are untouched (1.3.2). scroll-margin-top grows with the
     bar: measured 167px at 320px/200% text, so 176 clears it plus its ring. */
  @media (max-width: 600px) {
    .toolbar {
      flex-wrap: wrap;
      height: auto;
      min-height: 56px;
      padding-bottom: 0;
    }
    .toolbar .main-title {
      flex: 1 1 auto;
    }
    .toolbar-tabs {
      flex: 1 0 100%;
      margin-left: 0;
      margin-top: 4px;
    }
    .toolbar-tab {
      flex: 1;
      text-align: center;
    }
    /* Only as wide as the gear: an equal share would give an icon the room
       of a word and push the labelled tabs into two lines. */
    .toolbar-tab-icon {
      flex: 0 0 auto;
    }
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
    :host ha-combo-box,
    :host ha-picker-field {
      scroll-margin-top: 176px;
    }
  }

`;
