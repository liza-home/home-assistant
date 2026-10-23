/**
 * lizaIP Panel — Styles: The user guide: drawer, dialog, lightbox and contents.
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
export const STYLES_GUIDE = `
  /* ── The user guide ──────────────────────────────────────────────────
     A reading window, not a form: it is the widest and tallest dialog the
     panel opens, because the thing inside it is a manual with screenshots
     and eighty rows of table. The rail on the left is how a reader gets
     around twenty sections without scrolling through all of them. */
  .guide-dialog {
    max-width: min(1100px, 96vw);
    width: 96vw;
    max-height: calc(100vh - 32px);
    /* The dialog itself does not scroll -- the reading pane inside it does,
       so the heading rail and the title stay put while the text moves. */
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 16px 16px 8px;
  }
  .guide-head {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 0 0 8px;
    border-bottom: 1px solid var(--divider-color, #333);
  }
  .guide-head .add-page-dialog-title { flex: 1 1 auto; margin: 0; }
  .guide-head-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
  .guide-ext,
  .guide-close {
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0;
    border: none; border-radius: 50%;
    background: transparent; cursor: pointer;
    color: var(--ha-color-on-neutral-normal, var(--liza-muted-text));
  }
  .guide-ext:hover, .guide-close:hover { background: var(--secondary-background-color); }
  .guide-ext ha-icon, .guide-close ha-icon { --mdc-icon-size: 20px; }
  .guide-body {
    display: flex; flex-direction: column; gap: 8px;
    flex: 1 1 auto;
    min-height: 0; /* without it the flex child refuses to shrink and scroll */
    padding-top: 12px;
  }
  /* The contents control and the list it drops. Positioned, because in a
     narrow drawer the list is laid over the text rather than given a column
     of its own: a permanent rail there would halve the prose. Dragged wide
     it becomes exactly that permanent rail -- see the container query at the
     end of this block, which is where the width to afford one comes from. */
  .guide-nav { position: relative; flex: 0 0 auto; min-width: 0; }
  /* The rail's caption and fold control. No rail until the container query
     below says so, and no header either -- narrow, the contents are already
     a labelled disclosure. */
  .guide-rail-head { display: none; }
  .guide-toc-toggle {
    display: flex; align-items: center; gap: 8px;
    width: 100%;
    border: 1px solid var(--divider-color, #333);
    border-radius: 8px;
    background: var(--secondary-background-color);
    color: var(--primary-text-color, #fff);
    font-size: var(--liza-font-13);
    padding: 6px 10px;
    cursor: pointer;
    text-align: left;
  }
  .guide-toc-toggle:hover { border-color: var(--primary-color, #03a9f4); }
  .guide-toc-toggle:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
  }
  .guide-toc-toggle ha-icon { --mdc-icon-size: 18px; flex: 0 0 auto; }
  /* The section being read. It is the button's whole point when collapsed,
     so it takes the room and the long ones are cut rather than wrapped. */
  .guide-toc-current {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600;
  }
  .guide-toc-caret { transition: transform .15s ease; }
  .guide-toc-toggle[aria-expanded="true"] .guide-toc-caret { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) {
    .guide-toc-caret { transition: none; }
  }
  .guide-toc {
    position: absolute;
    top: calc(100% + 4px); left: 0; right: 0;
    z-index: 2;
    max-height: min(60vh, 420px);
    overflow-y: auto;
    padding: 4px;
    background: var(--card-background-color, #1e1e1e);
    border: 1px solid var(--divider-color, #333);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
  }
  .guide-toc[hidden] { display: none; }
  /* Sticky so it survives scrolling a twenty-entry list: the whole point of
     typing is that the list is longer than the box. */
  .guide-filter {
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; gap: 6px;
    padding: 2px 6px 6px;
    background: var(--card-background-color, #1e1e1e);
  }
  .guide-filter ha-icon { --mdc-icon-size: 18px; flex: 0 0 auto; color: var(--liza-muted-text); }
  .guide-filter-input {
    flex: 1 1 auto; min-width: 0;
    border: 1px solid var(--divider-color, #333);
    border-radius: 6px;
    background: var(--secondary-background-color);
    color: var(--primary-text-color, #fff);
    font: inherit;
    font-size: var(--liza-font-13);
    padding: 4px 8px;
  }
  .guide-filter-input:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 1px;
  }
  .guide-toc-none {
    margin: 4px 8px;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-13);
  }
  /* The counter and its two arrows. Together they are a find bar, so they sit
     where every find bar puts them: inside the box's row, at its end. */
  .guide-hits {
    display: inline-flex; align-items: center; gap: 2px;
    flex: 0 0 auto;
  }
  .guide-hits[hidden] { display: none; }
  .guide-hits-count {
    color: var(--liza-muted-text);
    font-size: var(--liza-font-12);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    padding: 0 2px;
  }
  .guide-hit-step {
    display: inline-flex; align-items: center; justify-content: center;
    /* 24px is under the 24x24 target minimum on its own, so the row's own
       padding is the rest of it; these two sit inside a 32px-tall bar. */
    width: 24px; height: 24px;
    flex: 0 0 auto;
    border: none; border-radius: 4px;
    background: transparent; cursor: pointer;
    color: var(--liza-muted-text);
  }
  .guide-hit-step ha-icon { --mdc-icon-size: 16px; }
  .guide-hit-step:hover {
    background: var(--secondary-background-color);
    color: var(--primary-text-color, #fff);
  }
  .guide-hit-step:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 1px;
  }
  .guide-toc-item[hidden] { display: none; }
  .guide-toc-item {
    display: flex; align-items: baseline; gap: 6px;
    width: 100%;
    text-align: left;
    border: none; background: transparent; cursor: pointer;
    color: var(--liza-muted-text);
    font-size: var(--liza-font-13);
    line-height: 1.4;
    padding: 5px 8px;
    border-radius: 6px;
    border-left: 2px solid transparent;
  }
  .guide-toc-text { flex: 1 1 auto; min-width: 0; }
  /* How many of the searched word this section holds. Shown only while a
     search is on, so an unsearched list is exactly what it always was. */
  .guide-toc-count {
    flex: 0 0 auto;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--secondary-background-color);
    color: var(--liza-muted-text);
    font-size: var(--liza-font-12);
    font-variant-numeric: tabular-nums;
  }
  .guide-toc-count[hidden] { display: none; }
  .guide-toc-l3 { padding-left: 24px; font-size: var(--liza-font-12); }
  .guide-toc-item:hover { background: var(--secondary-background-color); }
  /* One tab stop gets into the list and the arrows move inside it, so where
     the focus is has to be obvious: it is the only thing telling a keyboard
     reader which of twenty entries Enter will open. */
  .guide-toc-item:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: -2px;
  }
  /* Marked by weight and a bar as well as by colour (WCAG 1.4.1): which
     section is being read must survive a monochrome display. */
  .guide-toc-item.active {
    color: var(--primary-text-color, #fff);
    font-weight: 600;
    border-left-color: var(--primary-color, #03a9f4);
    background: var(--secondary-background-color);
  }
  .guide-content {
    --liza-guide-measure: 76ch;
    /* Every screenshot in the guide is exactly 1200px wide, so that is the
       width at which the content is as big as it will ever get. Past it the
       pictures stop growing and the prose is already at its measure, and
       dragging wider only bought empty gutter on the right. Capped here and
       centred, and the drag is capped to match in widthMax() -- the two
       together mean the slack is always split evenly and there is never much
       of it to split. */
    --liza-guide-column: 1200px;
    flex: 1 1 auto;
    overflow-y: auto;
    min-width: 0;
    padding: 0 8px 24px 0;
    color: var(--primary-text-color, #fff);
    font-size: var(--liza-font-m);
    line-height: 1.6;
  }
  .guide-content:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .guide-content h2, .guide-content h3, .guide-content h4 {
    color: var(--primary-text-color, #fff);
    line-height: 1.3;
    margin: 24px 0 8px;
    /* The rail scrolls a heading to the very top of the pane, and without
       this the heading sits flush against the edge with no air above it. */
    scroll-margin-top: 8px;
  }
  .guide-content h2 {
    font-size: var(--liza-font-18);
    padding-bottom: 4px;
    border-bottom: 1px solid var(--divider-color, #333);
  }
  .guide-content h3 { font-size: var(--liza-font-l); }
  .guide-content h4 { font-size: var(--liza-font-m); }
  .guide-content p, .guide-content ul, .guide-content ol { margin: 0 0 12px; }
  .guide-content li { margin: 0 0 4px; }
  .guide-content a { color: var(--primary-color, #03a9f4); }
  /* A line of text has a comfortable length, and it is not "however wide the
     reader dragged the drawer". Dragged to 1400px the prose ran about 190
     characters a line, where the eye loses the start of the next one on the
     way back; 60-80 is the long-standing figure and 76ch sits in it. In ch
     rather than px so it tracks the reader's font size, including at 200%.

     Prose only. Screenshots, tables and code are the reason to drag the
     drawer wide in the first place -- a full-width screenshot of a Home
     Assistant page is legible where a 500px one is not, and the settings
     table is eighty rows of three columns -- so those stay full-bleed within
     the column. The column itself is capped at the width of the widest thing
     in the guide, so "full-bleed" stops meaning "stretched past the point
     where anything grows". */
  /* The column: everything the guide renders lives in here, so the prose and
     the pictures share one left edge, and the slack past 1200px is split
     evenly rather than piling up on the right. */
  .guide-measure {
    max-width: var(--liza-guide-column, 1200px);
    margin-inline: auto;
  }
  /* Everything made of words keeps the measure and sits in the middle of the
     column. Left-aligned it looked unfinished at any width worth dragging to:
     a 525px ribbon of text against the left edge of a 1200px column, with the
     section rules running the whole way across past the end of it. h2 is in
     the list for that reason -- its underline is a rule, and a rule twice the
     width of the paragraph under it reads as a mistake. */
  .guide-content p,
  .guide-content ul,
  .guide-content ol,
  .guide-content blockquote,
  .guide-content h2,
  .guide-content h3,
  .guide-content h4,
  .guide-content hr {
    max-width: var(--liza-guide-measure);
    margin-inline: auto;
  }
  /* A paragraph that holds nothing but a screenshot is not prose and must not
     be measured as prose: Markdown wraps every image in a <p>, so the measure
     was capping the picture at 76 characters of text -- about 525px of a
     1200px capture, less than half of what was taken. Stamped in _wireGuide
     rather than matched with :has(), which Home Assistant's browser may not
     have. The wide things are centred too, so the column has one axis. */
  .guide-content p.guide-figure,
  .guide-content table,
  .guide-content pre {
    max-width: 100%;
    margin-inline: auto;
  }
  .guide-content p.guide-figure { text-align: center; }
  .guide-content code {
    font-family: var(--ha-font-family-code, monospace);
    font-size: .92em;
    background: var(--secondary-background-color);
    border-radius: 4px;
    padding: 1px 5px;
    /* Entity ids and templates have no spaces and are long; without this one
       of them widens the whole pane and the tables with it. */
    overflow-wrap: anywhere;
  }
  .guide-content pre {
    background: var(--secondary-background-color);
    border-radius: 8px;
    padding: 12px;
    overflow-x: auto;
    margin-block: 0 12px;
  }
  .guide-content pre code { background: none; padding: 0; overflow-wrap: normal; }
  .guide-content img {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    /* auto, not 0: a block image is not centred by the figure's
       text-align, and a shorthand here would quietly undo a margin-inline
       set earlier -- which is exactly what used to happen, leaving every
       picture narrower than the column hugging its left edge. */
    margin: 12px auto;
    border: 1px solid var(--divider-color, #333);
    cursor: zoom-in;
  }
  .guide-content img:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px;
  }
  /* The picture, over everything, at whatever size the window allows. Pinned
     to the viewport rather than the drawer: a 1200px screenshot shown inside
     a 500px drawer is the problem, not the solution. */
  .guide-lightbox {
    /* Above the sticky toolbar, which sits at 10. It used to be 12 inside
       .guide-drawer, and the drawer is a stacking context at 9 -- so the
       whole viewer was being painted under the toolbar no matter what
       number it was given. It hangs off the shadow root now. */
    position: fixed; inset: 0; z-index: 30;
    display: flex; align-items: center; justify-content: center;
    gap: 8px;
    padding: 56px 16px 16px;
    background: rgba(0, 0, 0, 0.85);
    /* Plain arrow on the backdrop. It used to be zoom-out, which is the
       pointer for "click to shrink this picture" and so promised something
       the backdrop does not do -- clicking it closes the viewer. The one
       place a magnifier means anything is over the picture itself. */
    cursor: default;
  }
  .guide-lightbox-bar {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 12px;
    color: #fff;
  }
  .guide-lightbox-count { font-size: 0.85em; opacity: 0.85; }
  .guide-lightbox-figure {
    margin: 0; min-width: 0;
    max-width: 100%; max-height: 100%;
    display: flex; flex-direction: column; gap: 8px; align-items: center;
  }
  .guide-lightbox-figure img {
    max-width: 100%;
    /* Room left for the caption, so a tall screenshot does not push it off. */
    max-height: calc(100vh - 140px);
    object-fit: contain;
    border-radius: 8px;
    background: var(--card-background-color, #1e1e1e);
    /* The pointer is the only thing saying the picture is a control at all.
       zoom-in up to the last step, zoom-out on it, because the next click
       from there goes back to fitted. */
    cursor: zoom-in;
    touch-action: none;
    /* The native image drag is what cancelled the pan after its first move:
       dragstart cancels the pointer stream the pan rides on. draggable=false
       is set on the element too; this is the WebKit half of the same thing. */
    -webkit-user-drag: none;
    user-select: none;
  }
  .guide-lightbox-figure img:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px;
  }
  /* Magnified. The caps have to come off entirely or the explicit width set
     on the image is overruled and the zoom does nothing -- which is exactly
     what the fit/actual-size version did on any screen wider than the 1200px
     the screenshots were taken at. The figure scrolls, and the image is
     dragged to pan it. */
  .guide-lightbox.zoomed .guide-lightbox-figure {
    max-width: 100%; max-height: 100%;
    overflow: auto;
    align-items: flex-start;
    cursor: grab;
  }
  .guide-lightbox.zoomed .guide-lightbox-figure:active { cursor: grabbing; }
  .guide-lightbox.zoomed .guide-lightbox-figure img {
    max-width: none; max-height: none;
    object-fit: fill;
    cursor: grab;
  }
  .guide-lightbox.zoomed .guide-lightbox-figure img:active { cursor: grabbing; }
  .guide-lightbox-figure figcaption {
    color: #e0e0e0;
    font-size: 0.9em; text-align: center; max-width: 76ch;
  }
  .guide-lightbox-step,
  .guide-lightbox-close {
    width: 40px; height: 40px; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    border: none; border-radius: 50%; cursor: pointer;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    --mdc-icon-size: 24px;
  }
  .guide-lightbox-step:hover,
  .guide-lightbox-close:hover { background: rgba(255, 255, 255, 0.28); }
  .guide-lightbox-step:focus-visible,
  .guide-lightbox-close:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px;
  }
  .guide-lightbox-step[hidden] { display: none; }
  .guide-content table {
    width: 100%;
    border-collapse: collapse;
    margin-block: 0 16px;
    font-size: var(--liza-font-13);
  }
  .guide-content th, .guide-content td {
    border: 1px solid var(--divider-color, #333);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }
  .guide-content th { background: var(--secondary-background-color); }
  .guide-content blockquote {
    margin-block: 0 12px;
    padding: 2px 0 2px 12px;
    border-left: 3px solid var(--divider-color, #333);
    color: var(--liza-muted-text);
  }
  .guide-content hr { border: none; border-top: 1px solid var(--divider-color, #333); margin-block: 24px; }

  /* Searched words, where they stand. A <mark> rather than a span, because
     that is the element that means this, and a screen reader says so. */
  .guide-content mark.guide-hit {
    background: #ffd54f;
    color: #000;
    border-radius: 2px;
    padding: 0 1px;
  }
  /* The one being stepped to. Outlined as well as recoloured: "which of the
     seventeen am I on" must not be a question about hue (1.4.1), and the two
     fills are adjacent on screen where a difference in colour alone is
     exactly what gets missed. */
  .guide-content mark.guide-hit-current {
    background: var(--primary-color, #03a9f4);
    color: #000;
    outline: 2px solid var(--primary-text-color, #fff);
    outline-offset: 1px;
  }

  /* ── Contents: a drop-down when there is no room, a rail when there is ──
     Capping the prose at a readable measure left a gutter in a wide drawer,
     and a contents list is what a gutter in a manual is for. Above 820px
     there is room for a 220px rail and the full measure beside it, so the
     list stops being something to open and is simply there, with the section
     being read already lit up.

     A container query, not a media query: what decides is how wide the guide
     is, and the guide is a drawer the reader drags -- the window may not have
     changed at all. Safe here where it was not on the host, because nothing
     inside the guide is position: fixed; the drawer itself is, and it is the
     container's ancestor rather than its descendant.

     The JS side does not repeat the 820. It asks whether the toggle is
     displayed, so the breakpoint lives in exactly one place. */
  .guide-panel, .guide-dialog { container-type: inline-size; container-name: guide; }

  @container guide (min-width: 820px) {
    .guide-body { flex-direction: row; gap: 16px; }
    .guide-nav {
      flex: 0 0 clamp(180px, 24%, 260px);
      display: flex; flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--divider-color, #333);
      padding-right: 8px;
    }
    .guide-toc-toggle { display: none; }
    /* A caption over the list and the fold control against the divider: the
       control was a loose round glyph above the search box, which read as a
       third search affordance rather than as the rail's own header. */
    .guide-rail-head {
      display: flex; align-items: center; gap: 8px;
      flex: 0 0 auto;
      min-height: 28px;
      margin-bottom: 4px;
    }
    .guide-rail-title {
      flex: 1 1 auto; min-width: 0;
      font-size: 0.72em; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--liza-muted-text, #9e9e9e);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .guide-rail-toggle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; flex: 0 0 auto;
      border: none; border-radius: 6px;
      background: none; cursor: pointer;
      color: var(--liza-muted-text, #9e9e9e);
      --mdc-icon-size: 18px;
    }
    .guide-rail-toggle:hover {
      background: var(--secondary-background-color, #2a2a2a);
      color: var(--primary-text-color, #fff);
    }
    .guide-rail-toggle:focus-visible {
      outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px;
    }
    /* Folded, the rail keeps only its button: no caption, no column, no
       divider, and the 220px goes back to the screenshots. */
    .guide-body.rail-collapsed .guide-nav {
      flex: 0 0 auto;
      border-right: none;
      padding-right: 0;
    }
    .guide-body.rail-collapsed .guide-rail-title { display: none; }
    .guide-body.rail-collapsed .guide-rail-head { margin-bottom: 0; }
    .guide-body.rail-collapsed .guide-toc,
    .guide-body.rail-collapsed .guide-toc[hidden] { display: none; }
    /* The dropdown becomes the column: no longer lifted off the page, no
       longer capped in height, and scrolling on its own rather than with the
       text -- a rail that scrolled away with the prose would be no rail. */
    .guide-toc,
    .guide-toc[hidden] {
      display: block;
      position: static;
      max-height: none;
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 0;
      background: none;
      border: none;
      box-shadow: none;
    }
    .guide-filter { background: var(--card-background-color, #1e1e1e); padding: 0 0 8px; }
  }
  /* ── The guide, docked ────────────────────────────────────────────────
     Pinned to the right edge of the viewport, which is also the panel's: the
     host fills everything right of Home Assistant's sidebar, the same
     assumption .add-page-overlay already makes with position: fixed.

     The squeeze is a margin on the two columns rather than padding on the
     host, because a fixed drawer ignores the host's padding and would sit
     beside the gap instead of in it. */
  .guide-drawer {
    position: fixed;
    /* Under the toolbar, not beside it. Dragging the guide's edge used to
       narrow the bar along with everything else, so the tabs reflowed and
       the whole top of the panel moved while the pointer was still down --
       a resize that rearranges the furniture reads as breakage. The bar now
       keeps the full panel and only the view below it gives up the column.
       The height is published by _narrowWatch, because the bar is not a
       fixed 56px: at 200% text it wraps to two rows. */
    top: var(--liza-toolbar-h, 56px);
    right: 0; bottom: 0;
    width: var(--liza-guide-width, 480px);
    display: flex;
    /* Under the sticky toolbar's z-index: 10. They no longer overlap at all,
       but a wrapped bar growing into the gap should win if they ever do. Far
       under the dialogs' 1000: the narrow fallback and the restore window
       must still cover everything. */
    z-index: 9;
    background: var(--card-background-color, #1e1e1e);
    border-left: 1px solid var(--divider-color, #333);
    box-shadow: -4px 0 16px rgba(0,0,0,.25);
  }
  /* The squeeze, on the host rather than on the two columns.
     A margin on .view does nothing useful: it is width:100% and border-box,
     so a right margin pushes it off the edge instead of narrowing it, and
     the drawer ends up painted over a view that never gave up the space.
     Padding on the host narrows the box every child measures itself against,
     so everything in flow moves -- including anything added later. */
  :host(.guide-open) {
    padding-right: var(--liza-guide-width, 480px);
  }
  /* ...except the toolbar, which takes the width back with a negative margin.
     It is the one child the guide does not sit beside: the drawer starts
     below it, so narrowing it would only make the tabs reflow every time the
     guide's edge is dragged. A negative right margin rather than a width
     calculation, because the bar is in flow and this is simply the padding
     undone. */
  :host(.guide-open) .toolbar {
    margin-right: calc(-1 * var(--liza-guide-width, 480px));
  }
  /* All three move together or none do. The host's padding is animated, so a
     toolbar whose compensating margin snaps is 560px wider than the panel for
     a fifth of a second -- it shoots past the right edge and settles back,
     which is the jump the guide used to open with. Same duration, same
     easing, and the bar's width works out constant at every frame. */
  :host, .guide-drawer, .toolbar {
    transition: padding-right .18s ease, width .18s ease, margin-right .18s ease;
  }
  /* Fixed children are positioned against the viewport, so the host's padding
     passes them by: the toast would stay centred on a window it no longer has
     all of, and the pills would sit behind the guide. */
  :host(.guide-open) .toast {
    left: calc(50% - var(--liza-guide-width, 480px) / 2);
  }
  :host(.guide-open) .diag-pills {
    right: calc(var(--liza-guide-width, 480px) + 16px);
  }
  /* While the handle is held, the drawer has to be where the pointer is. With
     the transition on it arrives a fifth of a second late and the drag reads
     as broken. Also honoured for anyone who asked for less motion. */
  :host(.guide-resizing),
  :host(.guide-resizing) .guide-drawer,
  :host(.guide-resizing) .toolbar {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    :host, .guide-drawer, .toolbar { transition: none; }
  }
  /* The grab edge. 6px of hit area for the pointer, 1px of it painted, and a
     visible ring when it is reached by Tab -- it is an arrow-key control. */
  .guide-resize {
    flex: 0 0 6px;
    margin-left: -3px;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
  }
  .guide-resize:hover,
  .guide-resize:focus-visible {
    background: var(--primary-color, #03a9f4);
    outline: none;
  }
  .guide-panel {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 12px 8px;
    /* The text scrolls; the drawer does not, so the heading and the contents
       control stay put while the reader moves through it. */
    overflow: hidden;
  }
  /* Screenshots in a 480px column are small, and the guide's are full-width
     captures of a configuration panel. Shown edge to edge, and the content
     pane is the only thing between them and the frame. */
  .guide-drawer .guide-content { padding-right: 4px; }
  .guide-drawer .guide-content h2 { font-size: var(--liza-font-l); }

`;
