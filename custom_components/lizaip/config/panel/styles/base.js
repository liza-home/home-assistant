/**
 * lizaIP Panel — Styles: Host, design tokens, toolbar, shell and device list.
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
export const STYLES_BASE = `
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
    --liza-font-12: calc(12px * var(--ha-font-size-scale, 1));
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
  /* Empty (and so invisible) unless the memory switch is on. */
  .toolbar-memory {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-left: 16px;
    font-size: var(--liza-font-13);
  }
  .mem-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .mem-bar {
    display: inline-block;
    width: 56px; height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: color-mix(in srgb, var(--app-header-text-color, #fff) 25%, transparent);
  }
  .mem-fill { display: block; height: 100%; background: var(--app-header-text-color, #fff); }
  /* The percentage beside each bar carries the value; colour only adds to it. */
  .mem-bar.warn .mem-fill { background: #ffb300; }
  .mem-bar.crit .mem-fill { background: #ff5252; }
  .mem-item:has(.mem-bar.unknown) { opacity: 0.6; }
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
`;
