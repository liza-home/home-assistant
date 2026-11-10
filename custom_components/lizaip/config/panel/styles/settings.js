/**
 * lizaIP Panel — Styles: Settings tab.
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
export const STYLES_SETTINGS = `
  /* --- Settings tab --- */
  /* Not a column of cards any more: a chip row picks one group and only that
     group is drawn, so the tab fits the panel without scrolling. */
  .settings-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }
  /* The chips and the search sit on one line while there is room; the search
     drops under them before the chips start scrolling, since a box too narrow
     to read what was typed is worse than a second line. */
  .settings-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  /* One line, scrolled sideways when it does not fit. Wrapping would move the
     group below it up and down as the panel is resized. */
  /* ha-tab-group draws the tabs, the active marker and the arrow keys. It
     scrolls sideways on its own when the tabs do not fit. */
  .settings-nav { flex: 1 1 auto; min-width: 0; }
  .settings-chip ha-icon { --mdc-icon-size: 18px; margin-inline-end: 6px; }
  .settings-section { outline: none; }
  /* ha-input-search draws the field, its magnifier and its clear button. */
  .settings-search { flex: 0 1 260px; min-width: 0; }
  /* The same amber the guide's search uses, so a hit looks like a hit
     wherever it is found. A fixed pair rather than theme tokens: the two
     colours have to stay legible together in both themes. */
  .settings-hit {
    background: #ffd54f;
    color: #000;
    border-radius: 2px;
    padding: 0 1px;
  }
  .settings-section-title {
    margin: 0;
    font-size: var(--liza-font-l);
    font-weight: 500;
    color: var(--primary-text-color);
  }
  /* Not .hint-text: that is the centred empty-state style, and centring a
     sentence that introduces the cards below it sets it adrift from them. */
  .settings-section-note {
    margin: 6px 0 0;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-s);
    line-height: 1.45;
  }
  /* Side by side while there is room, but capped: a card wider than about
     620px turns its hints into lines too long to scan. Starting them at the
     top keeps a short card short; padded to a tall one it reads unfinished. */
  .settings-section-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
    justify-content: start;
    align-items: start;
    gap: 16px;
    margin-top: 12px;
  }
  @media (max-width: 700px) {
    .settings-section-cards { grid-template-columns: 1fr; }
  }
  .settings-card { margin: 0; }
  /* Fontbook's own panel, shown as a group: as wide as the section, and tall
     enough to work in -- it was made to fill a page of its own. */
  .settings-fontbook { display: block; width: 100%; }
  .fontbook-host { display: block; min-height: 70vh; }
  .fontbook-host > * { display: block; width: 100%; min-height: 70vh; }
  /* Cards that belong together in one grid cell, one under the other. */
  .settings-card-stack { display: grid; gap: 16px; min-width: 0; }
  /* .actions-card-header spaces its children apart, which pushes a title that
     now has a glyph before it to the far side of the card. Its 12px top also
     set the title nearer the edge than the body below is to the sides. */
  .settings-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: flex-start;
    padding: 16px;
  }
  .settings-card-icon { flex: none; color: var(--liza-muted-text); --mdc-icon-size: 20px; }
  /* An action belonging to the card, not to a field in it, so it sits in the
     header rather than loose at the bottom where it reads as a next step. */
  .settings-card-header .actions-card-title { margin: 0; }
  /* Left-aligned, unlike .hint-text, which is the centred empty-state style
     for a view with nothing in it yet. Centring a card's opening sentence sets
     it adrift from the fields it introduces. */
  .settings-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }
  /* A list opening the body would draw its own rule a step below the header's,
     reading as a doubled divider. */
  .settings-body > .settings-switch-list:first-child > .settings-switch-row:first-child {
    border-top: none;
    padding-top: 0;
  }
  /* The font names a typeface and the size holds two digits, so a row each
     left the card mostly empty. The size keeps only what its hint needs, and
     the row wraps rather than squeezing the font name out of sight. */
  .settings-field-row {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    gap: 16px;
  }
  .settings-field-row > .config-field:first-child { flex: 1 1 220px; }
  .settings-field-row > .config-field + .config-field { flex: 0 1 auto; }
  .settings-field-row .config-field-hint { white-space: nowrap; }
  .settings-subheading {
    margin: 0;
    font-size: var(--liza-font-s);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: var(--liza-muted-text);
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
     sits inside the field's end, rather than in the hint where it has to be
     hunted for. */
  .settings-step-input { display: flex; align-items: center; gap: 8px; }
  ha-input.settings-step-input { display: block; width: 160px; max-width: 100%; }
  /* A row of number fields hugs them: stretched, the second field is pushed
     to the far edge, away from the first it is read together with. */
  .settings-field-row > .config-field:has(> ha-input.settings-step-input) { flex: 0 0 auto; }
  /* A slider for a handful of seconds does not get better for being a metre
     long: past this it is only harder to land on a value. */
  /* The bottom margin clears the thumb, which overflows the slider's box
     and would otherwise touch the hint below. */
  .settings-range-input { max-width: 440px; align-items: flex-end; margin-bottom: 14px; }
  /* Level with the track. ha-slider's track hangs below its own box (the
     thumb overflows it), so bottom-aligning leaves the number above it. */
  .settings-range-input .settings-range-value { margin-bottom: -6px; }
  .settings-range-input ha-slider { flex: 1 1 auto; min-width: 0; }
  .settings-range-value { min-width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; }
  .settings-step-unit {
    color: var(--liza-muted-text);
    font-size: var(--liza-font-m);
  }
  /* A placeholder and what it turns into, so the word "variable" has
     something to point at. It hugs its line: a short sample stretched across
     the card reads as an empty field waiting to be filled in. */
  .settings-sample {
    display: flex;
    align-items: center;
    align-self: start;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    font-size: var(--liza-font-s);
  }
  .settings-sample-source { font-family: monospace; color: var(--liza-muted-text); }
  .settings-sample-arrow { --mdc-icon-size: 16px; color: var(--liza-muted-text); }
  .settings-sample-value { font-weight: 500; color: var(--primary-text-color); }
  /* One dot per repeat, so the delay and the rate above can be seen as well
     as felt. */
  .settings-repeat-demo { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  /* ha-button draws it; a held press must not scroll or select text. */
  .settings-repeat-btn { touch-action: none; user-select: none; }
  .settings-repeat-pulses { display: flex; flex-wrap: wrap; gap: 4px; min-height: 8px; flex: 1 1 auto; }
  .settings-repeat-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--primary-color, #03a9f4); }
  /* The editor opens beneath the picker and is headed like any other card.
     An accent border and a short slide mark it as the card now being worked
     on, without dressing it as a page of its own. */
  /* The divider is translucent and color-mix averages alpha too, so mixing
     against it drowned every other border on the page; this sets alpha. */
  .theme-editor-card {
    border-color: color-mix(in srgb, var(--primary-color) 40%, transparent);
  }
  .theme-editor-card.is-entering { animation: liza-theme-editor-in .22s ease-out; }
  @keyframes liza-theme-editor-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .theme-editor-card.is-entering { animation: none; }
  }
  /* The card's one dismiss, pushed to the trailing edge of a header that
     otherwise packs its children to the start. */
  .theme-edit-close {
    margin-left: auto;
    color: var(--liza-muted-text);
    --mdc-icon-button-size: 36px;
    --mdc-icon-size: 20px;
  }
  /* Each axis is one row of chips. The chips carry pictures imgserv drew for
     the device, so a choice is shown rather than described. The body already
     spaces its children, so a section adds the rule and nothing else. */
  .theme-facet, .theme-presets {
    padding-top: 12px;
    border-top: 1px solid var(--divider-color, rgba(127,127,127,.15));
  }
  /* A section opening the body would draw its rule a step below the header's. */
  .settings-body > .theme-presets:first-child,
  .settings-body > .theme-facet:first-child {
    padding-top: 0;
    border-top: none;
  }
  .theme-facet-label {
    display: block;
    margin-bottom: 8px;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-m);
  }
  /* One row of equal tiles: a grid, because as flex items they were sized by
     the artwork inside them and came out ragged. */
  .theme-preset-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
    gap: 8px;
  }
  .theme-preset.selected {
    border-color: var(--primary-color);
    box-shadow: inset 0 0 0 1px var(--primary-color);
  }
  /* A theme tile shows what the theme draws: its state colours, its title text
     at its own size, and its own glyphs, on the black the remote really uses. */
  .theme-preset {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.15));
    border-radius: 12px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: center;
    cursor: pointer;
  }
  .theme-preset:hover { border-color: var(--primary-color); }
  /* The mix is shown so the screen tells the truth, but it has no file to be
     picked again by: only its copy icon does anything. */
  .theme-preset-mix { cursor: default; }
  .theme-preset-mix:hover {
    border-color: var(--divider-color, rgba(127,127,127,.15));
  }
  .theme-card-art {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 74px;
    padding: 6px;
    overflow: hidden;
    border-radius: 8px;
    background: #000;
  }
  /* A tile holds the same screen as the remote, scaled to the tile's width:
     every length is the device's own in pixels over the 260 the screen is
     wide (240 of strip plus padding), so the proportions are the remote's. */
  .theme-card-screen {
    display: block;
    min-height: 0;
    padding: 0;
    container-type: inline-size;
  }
  .theme-card-screen .theme-screen {
    gap: calc(100cqw * 6 / 260);
    padding: calc(100cqw * 10 / 260);
    border-radius: 0;
  }
  .theme-card-screen .theme-strip-frame {
    width: calc(100cqw * 240 / 260);
    height: calc(100cqw * 60 / 260);
  }
  .theme-card-screen .theme-strip-title {
    width: calc(100cqw * 200 / 260);
    height: calc(100cqw * 50 / 260);
  }
  .theme-card-screen .theme-strip-tooltip {
    width: calc(100cqw * 200 / 260);
    height: calc(100cqw * 40 / 260);
  }
  /* Four tiles in the strip's width, so the state colours never wrap into a
     ragged second row on a narrow tile. */
  .theme-card-screen .theme-tiles {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: calc(100cqw * 4 / 260);
    width: calc(100cqw * 240 / 260);
  }
  .theme-card-screen .theme-tile {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
  .theme-card-art-add { color: var(--primary-color); }
  /* The Add tile is also where a theme file is dropped, so it is drawn as a
     drop area: dashed, and lit while a file is held over it. */
  .theme-preset-add { border-style: dashed; }
  .theme-preset-add.selected { border-style: solid; }
  .theme-preset-add.is-drop-over {
    border-color: var(--primary-color);
    border-style: solid;
    box-shadow: inset 0 0 0 1px var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
  }
  .theme-preset-drop-hint {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 12px;
    color: var(--liza-muted-text);
  }
  .theme-preset-drop-hint ha-icon { --mdc-icon-size: 16px; flex: none; }
  .theme-edit-why { color: var(--error-color, #db4437); font-weight: 500; }
  .theme-card-art-add ha-icon { --mdc-icon-size: 28px; }
  .theme-preset-name {
    display: grid;
    gap: 4px;
    min-width: 0;
    font-size: var(--liza-font-m);
  }
  /* The name takes a line of its own and the icons a fixed one below, so they
     sit in the same place on every tile however long the theme is called. */
  .theme-preset-title {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .theme-preset-acts {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 16px;
  }
  .theme-preset-edit ha-icon { --mdc-icon-size: 16px; }
  .theme-preset-edit {
    display: inline-flex;
    opacity: .6;
    cursor: pointer;
  }
  .theme-preset-edit:hover { opacity: 1; color: var(--primary-color); }
  .theme-preset-delete:hover {
    color: var(--error-color, #ff8a80);
  }
  /* The step between the bin and the file going away. It sits under the row
     rather than over it, so the theme it names stays in view. */
  .theme-delete-confirm {
    display: grid;
    gap: 8px;
    padding: 13px;
    border: 1px solid var(--error-color, rgba(255,138,128,.4));
    border-radius: 10px;
    background: rgba(255,138,128,.06);
  }
  .theme-delete-confirm .settings-actions { margin-top: 0; }
  /* The editor's own fields. A swatch is an input, not a painted box, so the
     colour on screen is the one being edited and nothing has to be measured
     by the contrast suite. */
  /* Home Assistant's expansion panel: frame, heading row, chevron and the
     slide are its. The lead icon takes the accent while its group is open. */
  .theme-edit-group { display: block; }
  .theme-edit-lead { color: var(--liza-muted-text); }
  .theme-edit-group[expanded] .theme-edit-lead { color: var(--primary-color); }
  .theme-edit-head {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
  }
  /* What the section holds, so a shut row can be read. It stays on one line:
     a wrapped palette would push the rows to different heights. */
  .theme-edit-value {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--liza-font-s);
    color: var(--liza-muted-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .theme-edit-value:empty { display: none; }
  .theme-edit-dots { display: inline-flex; gap: 3px; }
  .theme-edit-dots i {
    display: block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }
  .theme-edit-body { overflow: hidden; }
  .theme-edit-slot {
    display: grid;
    gap: 8px;
    padding: 0 0 8px;
  }
  .theme-edit-head .theme-facet-label { display: block; margin: 0; }
  /* One column per state, each the same width, so the labels do not pull the
     swatches into uneven gaps. Capped, so a wide card leaves them a group
     rather than spreading them edge to edge. */
  .theme-edit-colors {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    max-width: 420px;
  }
  @media (max-width: 420px) {
    .theme-edit-colors { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  .theme-edit-color {
    display: grid;
    gap: 4px;
    justify-items: center;
    font-size: var(--liza-font-s);
  }
  .theme-edit-block { display: grid; gap: 6px; }
  .theme-edit-block + .theme-edit-block {
    margin-top: 14px;
    padding-top: 13px;
    border-top: 1px solid var(--divider-color, rgba(127,127,127,.18));
  }
  .theme-edit-block-head { font-size: var(--liza-font-m); font-weight: 600; }
  .theme-edit-block .theme-edit-colors { margin-top: 2px; }
  .theme-edit-swatch {
    width: 100%;
    max-width: 72px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--divider-color, rgba(127,127,127,.15));
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }
  /* Two columns, so each row is one domain's pair: the active state on the
     left, the other on the right. Too narrow for two, the pairs stack. */
  .theme-edit-glyphs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  @media (max-width: 560px) {
    .theme-edit-glyphs { grid-template-columns: 1fr; }
  }
  /* The screen a theme draws. Black like the device screen, because every
     image in it is one imgserv drew for it. */
  .theme-screen {
    display: grid;
    gap: 6px;
    justify-items: center;
    padding: 10px;
    border-radius: 8px;
    background: #000;
  }
  .theme-tiles {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
  }
  .theme-tile {
    width: 44px;
    height: 44px;
    object-fit: contain;
  }
  .theme-strip {
    max-width: 100%;
    object-fit: contain;
  }
  /* The frame the remote gives a text strip. Outlined, not bordered, so the
     line does not eat into the 240x60 it stands for. */
  .theme-strip-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 240px;
    height: 60px;
    outline: 1px dashed rgba(255, 255, 255, .2);
  }
  .theme-strip-frame .theme-strip { max-width: none; }
  .theme-strip-title { width: 200px; height: 50px; }
  .theme-strip-tooltip { width: 200px; height: 40px; }
  .settings-actions {
    display: flex;
    gap: 8px;
  }
  /* A card that writes something keeps its confirming button on the right,
     with anything destructive pushed to the far edge away from it. */
  .settings-actions-end { justify-content: flex-end; }
  /* The only card that interrupts the device rather than setting it, so it is
     drawn in the error colour and cannot be read as one more setting. */
  .settings-danger-card { border-color: var(--liza-error-text, var(--error-color)); }
  .settings-danger-card .settings-card-icon,
  .settings-danger-card .actions-card-title { color: var(--liza-error-text, var(--error-color)); }
/* The red is variant="danger" now; nothing is left to say here. */
`;
