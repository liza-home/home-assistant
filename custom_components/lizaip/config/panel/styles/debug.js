/**
 * lizaIP Panel — Styles: Debug tab, plus the shared hint/toast primitives.
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
export const STYLES_DEBUG = `
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
  /* The actions are ha-button. Everything that used to be drawn here -- the
     fill, the radius, the hover, the pressed nudge, the focus ring, the
     disabled dimming -- is the theme's job now, so only the row geometry is
     left. The accent/filled split that the .primary modifier used to make is
     carried by the element's own variant and appearance attributes. */
  .debug-btn { flex: 0 0 auto; }

  /* HA's switch with its words beside it, sitting in the button row. */
  .debug-switch {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
  }
  .debug-switch label {
    font-size: var(--liza-font-s);
    font-weight: 500;
    cursor: pointer;
  }
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
  /* One select per module, named by the module. A grid so the selects line
     up in columns however many modules the device reports. */
  .debug-levels {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px 16px;
  }
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
`;
