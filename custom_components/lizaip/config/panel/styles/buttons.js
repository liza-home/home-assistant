/**
 * lizaIP Panel — Styles: Buttons view: two-column wireframe layout and volume rocker.
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
export const STYLES_BUTTONS = `
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
    /* The containing block for .goto-link-layer. It has to be this element and
       not the card: the layer is sized to the scrollable content, and only a
       child of the scroller itself scrolls along with the thumbnails it is
       drawing between. */
    position: relative;
  }
  /* The link from a button to the page it opens. Drawn by _drawGotoLink,
     which also sizes it; nothing here may set a width or a height. */
  .goto-link-layer {
    position: absolute;
    left: 0;
    top: 0;
    /* It covers the whole row, including every thumbnail and the add button, so
       anything less would make the strip untouchable. */
    pointer-events: none;
    /* Above the thumbs, which are positioned (for their delete button and their
       drag offset) and so would otherwise paint over a line drawn before them
       in document order. The layer is deliberately the strip's first child --
       see the markup -- so the stacking has to be stated rather than inherited
       from source order. */
    z-index: 5;
    /* The arc bows out of the box the endpoints span, and the arrowhead marker
       reaches past the path's last point. */
    overflow: visible;
  }
  .goto-link-layer .goto-link-path {
    fill: none;
    /* The text colour, so the link reads as something the panel is telling
       you rather than a warning, and so it flips with the day/night theme --
       a fixed colour would go invisible on one of the two. */
    stroke: var(--primary-text-color);
    stroke-width: 2.5;
    stroke-linecap: round;
  }
  .goto-link-layer .goto-link-head { fill: var(--primary-text-color); }
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
  /* The page a link points at. After .active deliberately: the target of an
     incoming link is usually the open page itself, and this frame is what says
     so -- that the card is also the open one is still said by every other cue
     on it. The text colour rather than a hue of its own, matching the line it
     terminates, so the two read as one mark. */
  .page-thumb[goto-link] {
    border-color: var(--primary-text-color);
    box-shadow: 0 0 12px color-mix(in srgb, var(--primary-text-color) 25%, transparent);
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
  /* The hover card, from lizaip-button-tip.js. Fixed and parented to the
     shadow root: .page-thumb is scaled and translated, so a positioned
     descendant would be scaled and sheared along with it.

     pointer-events:none because the card sits beside the shape it describes,
     and one that took the pointer would end the hover that produced it. */
  .liza-btn-tip {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 30;
    max-width: 260px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--card-background-color, #2b2b2b);
    color: var(--primary-text-color, #fff);
    border: 1px solid var(--divider-color, rgba(127,127,127,.3));
    box-shadow: 0 4px 16px rgba(0,0,0,.35);
    font-size: 12px;
    line-height: 1.35;
    pointer-events: none;
  }
  /* Spelled out because the element carries a position, and a positioned
     element with a display of its own would ignore the attribute. */
  .liza-btn-tip[hidden] {
    display: none;
  }
  .liza-btn-tip-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  /* The same PNG the face is drawing, at the size a line of this text is. */
  .liza-btn-tip-icon {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex: 0 0 auto;
  }
  .liza-btn-tip-name {
    overflow-wrap: anywhere;
  }
  /* A first column so the kinds line up and the values read as a list rather
     than a paragraph. A minimum rather than a fixed width, so a long word in
     a language that compounds is not clipped. */
  .liza-btn-tip-row {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .liza-btn-tip-kind {
    flex: 0 1 auto;
    min-width: 58px;
    max-width: 112px;
    opacity: .65;
    overflow-wrap: anywhere;
  }
  .liza-btn-tip-text {
    overflow-wrap: anywhere;
  }
  .liza-btn-tip-row.warn .liza-btn-tip-text {
    color: var(--error-color, #db4437);
  }
  .liza-btn-tip-none {
    opacity: .65;
  }
  /* The page card's lines, which have no kind to sit beside. */
  .liza-btn-tip-line {
    margin-top: 2px;
    opacity: .8;
    overflow-wrap: anywhere;
  }
  /* Which of forty close-packed shapes the card is about. Level with the
     shape, which is what --tip-caret carries: the card is clamped to the
     viewport and the shape it points at is not. */
  .liza-btn-tip.tip-left::after,
  .liza-btn-tip.tip-right::after {
    content: "";
    position: absolute;
    top: var(--tip-caret, 50%);
    margin-top: -6px;
    width: 0;
    height: 0;
    border: 6px solid transparent;
  }
  .liza-btn-tip.tip-right::after {
    left: -12px;
    border-right-color: var(--card-background-color, #2b2b2b);
  }
  .liza-btn-tip.tip-left::after {
    right: -12px;
    border-left-color: var(--card-background-color, #2b2b2b);
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
  }`;
