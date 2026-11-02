/**
 * lizaIP Panel — Buttons View: The curves drawn between a button and the page it jumps to.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  gotoLinkEnd,
  gotoLinkPath,
} from "./shared.js";
import {
  drawSVG,
} from "../lizaip-svg.js";
import { NON_BUTTON_KEYS } from "../lizaip-helpers.js";

/** The line's width in px; must match `.goto-link-path { stroke-width }`. */
const GOTO_LINK_STROKE = 2.5;
/**
 * How far, in stroke widths, the line stops short of the frame. The head's tip
 * marks the true end; 1.5 keeps the line's round cap inside the head's flanks.
 */
const GOTO_LINK_HEAD_INSET = 1.5;

export const ButtonsGotoLinksMixin = {
  _gotoPageOf(assign) {
    if (!assign?.action_id) return null;
    const action = (this._actions || []).find(a => a.id === assign.action_id);
    return this._internalTargetPage(assign.config, action?.service) || null;
  },

  /**
   * The page a long touch on this button opens, or null.
   *
   * `longtouch` is a bare step list with no `action_id` beside it -- a long
   * touch is always configured inline -- so the step names its own service and
   * there is no fallback to pass.
   *
   * Silent while the feature is switched off, matching `longtouch_assignment`
   * in `buttons.py`: the steps stay stored but the remote does not run them,
   * and a line drawn to a page that no long touch currently opens would be a
   * navigation path the user cannot take.
   */

  _gotoLongPageOf(assign) {
    const steps = assign?.longtouch;
    if (!Array.isArray(steps) || !steps.length) return null;
    if (!this._longtouchEnabled?.()) return null;
    return this._internalTargetPage(steps) || null;
  },

  /**
   * Every page one button can open, click and long touch together.
   *
   * De-duplicated by page: a button whose two gestures lead to the same place
   * would otherwise draw one line exactly on top of another, darkening it for
   * no reason a viewer could name.
   */

  _gotoPagesOf(assign) {
    const pages = [];
    for (const page of [this._gotoPageOf(assign), this._gotoLongPageOf(assign)]) {
      if (page && !pages.some(p => p.id === page.id)) pages.push(page);
    }
    return pages;
  },

  /**
   * The pages a control on the open page opens -- none, one, or one per gesture.
   *
   * Read through the edit slot, exactly as the face's own tiles are, so the
   * link describes the same configuration the drawn button describes. Under a
   * context that is the override being edited rather than the page default --
   * a link pointing at the page the *stored* record names would contradict the
   * button it starts from.
   */

  _gotoLinkPages(key) {
    if (!key) return [];
    return this._gotoPagesOf(this._editAssign?.(key));
  },

  /**
   * Whose outgoing link is on screen: the button the pointer is over, and
   * nothing else.
   *
   * Selection deliberately does not count. A link drawn for the selected
   * button stays on screen for as long as that button is being configured,
   * which is most of the time the editor is open -- so the one relation the
   * overlay exists to point out became permanent furniture, and a line that is
   * always there says nothing. Tying it to the pointer makes it an answer to a
   * question just asked, and makes every face readable again the moment the
   * pointer leaves.
   *
   * The two face shapes that are not buttons are refused. `slider_horizontal`
   * is the page's title bar and `slider_vertical` the page slider; both are
   * dragged, never pressed, so neither can open anything -- yet both hold a
   * record whose stored steps may name `goto_page`, which would otherwise be
   * read as a route that no gesture can take.
   */

  _gotoLinkKey() {
    const key = this._gotoHoverKey;
    return key && !NON_BUTTON_KEYS.has(key) ? key : null;
  },

  /**
   * The page whose incoming links are on screen: the one under the pointer.
   *
   * Matched by id rather than kept as an index, because the strip reorders
   * under drag and an index remembered across a reorder names a different
   * page. The id arrives from a DOM attribute and is therefore a string, while
   * page ids are numbers, so both sides are compared as text.
   */

  _gotoHoverPage() {
    if (this._gotoHoverPageId == null) return null;
    const wanted = String(this._gotoHoverPageId);
    return (this._pages || []).find((p) => String(p.id) === wanted) || null;
  },

  // Where the switch on the gear tab remembers itself. A browser-local key,
  // not a device setting: it changes what this editor draws and nothing the
  // remote does, so it has no business being saved per remote on the backend.
  PAGE_LINKS_PREF: "liza.remote.pageLinks",

  /**
   * Whether links are drawn at all. Off until switched on.
   *
   * Defaulting to off keeps the editor quiet: the overlay paints over the
   * page strip on every hover, which is noise for the many sessions that are
   * not tracing where a button leads. Whoever wants it turns it on once and
   * the browser remembers. Read once and kept, because this is asked on
   * every pointer move.
   *
   * Storage is wrapped: a browser with site data blocked throws on access
   * rather than returning null, and an unreadable preference is not a reason
   * for the page strip to stop rendering.
   */

  _pageLinksEnabled() {
    if (this._pageLinksOn === undefined) {
      let stored = null;
      try { stored = window.localStorage?.getItem(this.PAGE_LINKS_PREF); } catch (e) { stored = null; }
      this._pageLinksOn = stored === "1";
    }
    return this._pageLinksOn;
  },

  _setPageLinksEnabled(on) {
    this._pageLinksOn = !!on;
    try {
      window.localStorage?.setItem(this.PAGE_LINKS_PREF, this._pageLinksOn ? "1" : "0");
    } catch (e) { /* Blocked storage: the switch still works for this session. */ }
    // A no-op while the gear tab is the one showing -- there is no overlay in
    // the DOM to clear. Called anyway so that the one place that changes the
    // preference is also the place that makes the change take effect.
    this._drawGotoLink();
  },

  /**
   * The links to draw, as pairs of live elements, in the order they are drawn.
   *
   * Split out from the painting because it is the whole of the *rule* -- which
   * links exist and why -- while everything in `_drawGotoLink` is geometry.
   *
   * An outgoing link starts only on the open page. A closed thumbnail is a
   * picture of another page drawn at a fifth of the size with its controls
   * deliberately non-interactive (see `drawSVG`'s `interactive`), so there is
   * nothing there to hover. Incoming links do start on closed thumbnails,
   * because that is where the buttons that reach a page almost always are -- a
   * page is usually opened from somewhere else.
   *
   * Both halves are hover-driven and nothing else is: a button under the
   * pointer shows where it goes, a thumbnail under the pointer shows what
   * reaches it, and an idle pointer draws no lines at all.
   */

  _gotoLinkSpecs(list) {
    if (!list || !this._pageLinksEnabled()) return [];
    const thumbFor = (id) =>
      list.querySelector(`.page-thumb[data-page-id="${CSS.escape(String(id))}"]`);

    const key = this._gotoLinkKey();
    if (key) {
      const shape = list.querySelector(
        `.page-thumb.active .button[data-key="${CSS.escape(key)}"]`,
      );
      if (!shape) return [];
      // One per gesture that opens a page: a button whose click opens one page
      // and whose long touch opens another describes two routes, and drawing
      // only the first would say the second does not exist.
      return this._gotoLinkPages(key)
        .map((page) => ({ shape, thumb: thumbFor(page.id) }))
        .filter((spec) => spec.thumb);
    }

    // No button under the pointer: if a page is, show what reaches that page.
    // The hovered page rather than the open one, so the question can be asked
    // of any page in the strip without opening it first -- and so that the
    // answer, like the outgoing half, lasts exactly as long as the pointer
    // stays put.
    const target = this._gotoHoverPage();
    const thumb = target ? thumbFor(target.id) : null;
    if (!thumb) return [];

    const specs = [];
    const openId = this._pages?.[this._currentPageIdx]?.id;
    for (const page of this._pages) {
      const source = thumbFor(page.id);
      if (!source) continue;
      // Read exactly the way the face is drawn, so a line never starts on a
      // shape that is showing something else.
      //
      // The open page goes through the edit slot. That is what carries unsaved
      // edits, and -- with a grid button in context -- what resolves a fixed
      // control to that button's override, which is the assignment its shape is
      // currently drawn from. Walking the page map instead made the overlay
      // disagree with itself: hovering the override's own button drew the link
      // (its outgoing half asks `_editAssign`), while hovering the page it
      // opens did not, so the same relation existed or not depending on which
      // end you looked from. The keys come from the blueprint rather than from
      // the records, because an override exists for a key the page map does not
      // mention at all. A fixed control with no override resolves to nothing
      // and contributes no link, which is the face's own answer: under a
      // context, that shape is drawn as unset.
      //
      // Every other page goes through `_pageCache`, which is what its closed
      // thumbnail draws -- no context reaches it, and its unsaved edits are not
      // in `_assignments`, which belongs to the open page alone. A page missing
      // from the cache has genuinely not been read yet rather than being empty;
      // it contributes nothing until it is, exactly as its thumbnail does.
      const entries = page.id === openId
        ? (this._blueprint?.buttons || []).map((b) => [b.key, this._editAssign?.(b.key)])
        : Object.entries(this._pageCache?.[page.id] || {});
      for (const [btnKey, assign] of entries) {
        // Same two non-buttons as in `_gotoLinkKey`, refused for the same
        // reason: their records can hold steps, but no press runs them.
        if (NON_BUTTON_KEYS.has(btnKey)) continue;
        if (!this._gotoPagesOf(assign).some((p) => p.id === target.id)) continue;
        const shape = source.querySelector(`.button[data-key="${CSS.escape(btnKey)}"]`);
        if (shape) specs.push({ shape, thumb });
      }
    }
    return specs;
  },

  /**
   * Paint the current links, or clear the overlay when there are none.
   *
   * Everything is measured rather than derived from the blueprint: the face is
   * scaled to its container, thumbnails are shifted by drags and by the subpage
   * offset, and the strip scrolls. `getBoundingClientRect` is the only answer
   * that survives all of that, and the overlay is measured the same way so the
   * readings share one coordinate space.
   */
  /**
   * Drop the link outlines from whatever currently carries them.
   *
   * Found by selector rather than kept in a list: the shapes a previous draw
   * marked are routinely destroyed and rebuilt by `_refreshSVG` between two
   * draws, so a remembered element can be one that is no longer in the
   * document while its replacement sits there still outlined.
   */

  _clearGotoMarks() {
    this.shadowRoot?.querySelectorAll(".pages-list [goto-link]")
      .forEach((el) => el.removeAttribute("goto-link"));
  },

  _drawGotoLink() {
    const layer = this.shadowRoot?.querySelector(".goto-link-layer");
    if (!layer) return;
    const list = this.shadowRoot?.querySelector(".pages-list");
    const specs = this._gotoLinkSpecs(list);
    if (!specs.length) {
      this._clearGotoMarks();
      // Emptied rather than hidden: a stale path left in the DOM would flash
      // back at its old coordinates the moment anything made the layer visible
      // again, and there is nothing here worth keeping to redraw.
      if (layer.innerHTML) layer.innerHTML = "";
      // Cleared alongside it, or the cache below would recognise the paths that
      // are no longer drawn and decline to draw them again.
      delete layer.dataset.linkPath;
      return;
    }

    // Sized to the scrollable content, not to the visible box: a target may be
    // scrolled out of view, and a layer cut to the viewport would clip the link
    // exactly when it is most needed -- pointing off-screen is how the user is
    // told to scroll. `clientWidth` is the floor for the case where nothing
    // overflows and `scrollWidth` is the smaller of the two.
    const w = Math.max(list.scrollWidth, list.clientWidth);
    const h = Math.max(list.scrollHeight, list.clientHeight);
    layer.setAttribute("viewBox", `0 0 ${w} ${h}`);
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;

    // Measured after the resize above, so the overlay is already the size the
    // coordinates below are expressed in.
    const base = layer.getBoundingClientRect();
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
    };

    let marks = "";
    const paths = [];
    const ends = [];
    for (const { shape, thumb } of specs) {
      const box = rel(shape);
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      // Aimed from the button's centre, then pulled back to its own border, so
      // the line leaves the outline rather than starting under it.
      const end = gotoLinkEnd(rel(thumb), cx, cy);
      const start = gotoLinkEnd(box, end.x, end.y);
      const d = gotoLinkPath(start.x, start.y, end.x, end.y, GOTO_LINK_HEAD_INSET * GOTO_LINK_STROKE);
      paths.push(d);
      ends.push(shape, thumb);
      marks += `<path class="goto-link-path" d="${d}" marker-end="url(#goto-link-head)"/>`;
    }

    // Outline both ends, before the cache check below rather than after: a
    // rebuilt face carries no attributes, and its shapes land at the very
    // coordinates they had, so the paths match and the draw is skipped while
    // the outlines are gone. Re-marking costs an attribute write per link.
    this._clearGotoMarks();
    for (const el of ends) el.setAttribute("goto-link", "");

    // Nothing moved: rewriting identical markup would restart the draw-in
    // animation on every pointer twitch and every unrelated render.
    const signature = paths.join("|");
    if (layer.dataset.linkPath === signature) return;
    layer.dataset.linkPath = signature;
    // The arrowhead is a marker so it stays on each curve's own end tangent
    // without the angle being computed here, and so that any number of links
    // share one definition. `markerUnits="strokeWidth"` ties its size to the
    // line's, so the two cannot drift apart. The line stops
    // GOTO_LINK_HEAD_INSET stroke widths short of the frame and the head is
    // anchored that far behind its tip, so the tip ends on the frame's outer
    // edge -- not past it -- and the line's round cap stays inside the head.
    layer.innerHTML = `
      <defs>
        <marker id="goto-link-head" markerWidth="5" markerHeight="5" refX="${5 - GOTO_LINK_HEAD_INSET}" refY="2.5"
                orient="auto" markerUnits="strokeWidth">
          <path class="goto-link-head" d="M0,0 L5,2.5 L0,5 Z"/>
        </marker>
      </defs>${marks}`;
  },

  /**
   * Listen for the pointer crossing the open page's controls.
   *
   * Delegated to the strip rather than bound per shape: `_refreshSVG` rebuilds
   * every face from scratch whenever anything about a page changes, so listeners
   * on the shapes themselves would be dropped by the next repaint while the
   * strip itself survives until the whole view is re-rendered.
   *
   * `mouseover` alone, with no `mouseout` to match: it fires for the background
   * the pointer lands on when it leaves a button, which resolves to no key and
   * clears the link. The one gap that leaves is the pointer leaving the strip
   * entirely without crossing anything else, which `mouseleave` closes.
   *
   * Two readings are taken from the same event because the overlay asks two
   * questions of the pointer -- which button it is on, and which page -- and a
   * second listener would see the same crossings and answer half of each.
   */

  _wireGotoLinks() {
    const list = this.shadowRoot?.querySelector(".pages-list");
    if (!list) return;
    // What the pointer is over is deliberately *not* reset here, though the
    // markup it named has just been replaced. Both readings are a key and an
    // id, never an element: `_gotoLinkSpecs` looks the shape and the thumbnail
    // up by selector on every draw, so they survive a rebuild that destroys
    // everything they refer to. Forgetting them instead made the link flicker
    // out and stay out -- Home Assistant pushes `hass` on every state change in
    // the house, each one re-renders this view, and no mouse event fires again
    // until the pointer moves, so a link only lasted until the next unrelated
    // entity changed. A key whose shape is genuinely gone resolves to no spec
    // and draws nothing, which is the same thing forgetting it would have done.

    list.addEventListener("mouseover", (e) => {
      const shape = e.target?.closest?.(".page-thumb.active .button[data-key]");
      const key = shape?.getAttribute?.("data-key") || null;
      // Read even with a button in hand, so that leaving the button for the
      // page around it needs no further event to fall back to.
      const pageId = e.target?.closest?.(".page-thumb[data-page-id]")
        ?.getAttribute?.("data-page-id") ?? null;
      if (key === this._gotoHoverKey && pageId === this._gotoHoverPageId) return;
      this._gotoHoverKey = key;
      this._gotoHoverPageId = pageId;
      this._drawGotoLink();
    });
    list.addEventListener("mouseleave", () => {
      if (!this._gotoHoverKey && this._gotoHoverPageId == null) return;
      this._gotoHoverKey = null;
      this._gotoHoverPageId = null;
      this._drawGotoLink();
    });

    // Window-level and registered once for the life of the element, in the same
    // shape as `_pageDeleteKey`: the strip is rebuilt by every render and a
    // listener re-added per render would accumulate. Removed in
    // `disconnectedCallback`.
    //
    // Coalesced to one redraw per frame. `_drawGotoLink` measures every row and
    // rewrites the layer's markup, and a drag-resize fires far faster than a
    // frame — so the unthrottled version did that whole pass tens of times per
    // frame and only the last one was ever seen.
    if (!this._gotoLinkResize) {
      this._gotoLinkResize = () => {
        if (this._gotoLinkResizeFrame != null) return;
        this._gotoLinkResizeFrame = (typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : (cb) => setTimeout(cb, 16))(() => {
            this._gotoLinkResizeFrame = null;
            this._drawGotoLink();
          });
      };
      window.addEventListener?.("resize", this._gotoLinkResize);
    }

    this._drawGotoLink();
    // Again after layout settles. `_render` restores the strip's scroll offset
    // in a frame of its own and the faces are sized by CSS, so the first pass
    // above can measure a row that is still moving.
    requestAnimationFrame(() => this._drawGotoLink());
  },
};
