/**
 * lizaIP Panel — Buttons View: The strip of page thumbnails: how full each page is, and dragging one to a new place.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  isConfigured,
} from "./shared.js";

export const ButtonsPageStripMixin = {
  _pageFillCounts(page, bp) {
    const currentPageId = this._pages[this._currentPageIdx]?.id;
    const pageAssigns = (page.id === currentPageId)
      ? this._assignments
      : (this._pageCache[page.id] || {});
    const allBtnKeys = bp.buttons.map(b => b.key);
    return {
      filled: allBtnKeys.filter(k => isConfigured(pageAssigns[k])).length,
      total: allBtnKeys.length,
    };
  },

  /**
   * Move the page thumbnails into `this._pages` order without re-rendering.
   *
   * A reorder changes where pages sit and nothing about what is on them, but
   * `_render()` rewrites the shadow root wholesale: every thumb is rebuilt from
   * a string, every `.pg-svg-container` is a new empty node, and `_refreshSVG()`
   * then redraws every page face and re-attaches every image. Paying that to
   * move one card is what made a drop lag behind the drag.
   *
   * Moving the existing nodes keeps their drawn faces, their cached `<img>`
   * elements and their already-wired listeners. Only the attributes that encode
   * a *position* have to be rewritten, which `_relabelPageThumbs` does.
   *
   * Returns false if the DOM is not in the state this can safely patch, in
   * which case the caller should fall back to a full render.
   */

  _reorderPageDom() {
    const strip = this.shadowRoot?.querySelector(".pages-list");
    if (!strip || !this._blueprint) return false;

    const byId = new Map();
    strip.querySelectorAll(".page-thumb").forEach(el => byId.set(el.dataset.pageId, el));
    if (byId.size !== this._pages.length) return false;

    const thumbs = this._pages.map(p => byId.get(String(p.id)));
    if (thumbs.some(el => !el)) return false;

    // The add button is the strip's last child and has to stay there, so every
    // thumb is moved in front of it in turn; after the last one the row reads
    // in `_pages` order. Re-inserting a node that is already in place is a
    // no-op move, so the common "dragged one card" case touches few nodes.
    const anchor = strip.querySelector(".page-add-btn");
    for (const el of thumbs) {
      if (anchor) strip.insertBefore(el, anchor);
      else strip.appendChild(el);
    }

    this._relabelPageThumbs();
    // This path exists to skip the render that would otherwise redraw the link,
    // and a reorder moves the very thumbnails it points at.
    this._drawGotoLink();
    return true;
  },

  /**
   * Rewrite the position-derived bits of each thumb after a move.
   *
   * `data-page-idx` is an index into `_pages`, and the spoken name carries
   * "page n of m", so both go stale the moment a page moves. Everything else on
   * a thumb describes the page itself and survives untouched.
   */

  _relabelPageThumbs() {
    this._pages.forEach((page, i) => {
      const el = this.shadowRoot?.querySelector(
        `.page-thumb[data-page-id="${CSS.escape(String(page.id))}"]`
      );
      if (!el) return;

      el.dataset.pageIdx = String(i);
      el.querySelectorAll("[data-page-idx]").forEach(n => { n.dataset.pageIdx = String(i); });

      const isActive = i === this._currentPageIdx;
      const subpageNote = page.subpage ? `, ${this._t("a11y_subpage")}` : "";
      const spokenName = this._t("page_name_pos", {
        name: this._pageLabel(page), n: i + 1, m: this._pages.length,
      }) + subpageNote;

      // The open page is named by `data-a11y-name` and a closed one by the
      // container's `aria-label` — the same split `_render()` makes, so a
      // relabelled thumb is indistinguishable from a re-rendered one.
      if (isActive) el.dataset.a11yName = spokenName;
      const picture = el.querySelector(".pg-svg-container");
      if (picture && !isActive) {
        picture.setAttribute("aria-label", `${this._t("a11y_open_page", { name: spokenName })}.`);
      }
    });
  },

  // --- Goto links ------------------------------------------------------------
  //
  // A button that opens another page is the one assignment whose *target* is
  // also on screen, and nothing said so: the card named the page in words, but
  // finding it in a strip of lookalike thumbnails was still a reading exercise.
  // The link draws the relation the user already configured.
  //
  // It is drawn from both ends, because the two questions a user asks about
  // navigation are opposites of each other. Hovering a button, the question is
  // "where does this go", and one link answers it. Hovering a page, the
  // question becomes "how is this page reached", which only the whole set of
  // buttons pointing at it can answer. A page nothing points at draws nothing,
  // which is the honest and useful answer: that page is unreachable from the
  // remote.
  //
  // Hover and nothing else. Selection does not draw links: a selected button
  // keeps its card open while the user works elsewhere, and a link left
  // standing for that long reads as part of the template rather than as an
  // answer to a question just asked.

  /**
   * The page an assignment opens, or null when it opens none.
   *
   * `_internalTargetPage` is the single owner of "which page does this name",
   * and it answers null for everything that is not a resolvable page: a plain
   * HA service call, a command targeting something else, a deleted page, a name
   * two pages share. Each of those is a case where there is no one page to
   * point at, so each correctly draws nothing.
   */

  _pageDropIndex(clientX, rects, dragIdx) {
    let before = 0;
    while (before < rects.length) {
      const r = rects[before];
      if (clientX < r.left + r.width / 2) break;
      before++;
    }
    // `before` counts the thumbs the pointer has passed, the dragged one
    // included. It is still occupying a slot it is about to vacate, so once
    // the pointer is past it every count is one too high.
    return before > dragIdx ? before - 1 : before;
  },

  /**
   * How far one thumb slides to open the gap, in px.
   *
   * Taking an item out at `dragIdx` and putting it back at `dropIdx` displaces
   * everything in between by exactly the dragged item's own outer width --
   * whatever the others happen to measure. So one `shift`, read once at
   * dragstart, drives the whole strip, and nothing has to be re-measured while
   * the pointer moves.
   *
   * The two directions are not symmetric: dragging right, the passed-over
   * thumbs close up behind it; dragging left, they open ahead of it. Hence the
   * half-open ranges -- `dropIdx` itself moves in one case and not the other.
   *
   * The dragged thumb travels too, across the slots it passes. A native drag
   * leaves the source element in place at reduced opacity, so without this the
   * strip shows two holes -- one where the thumb still sits and one where it is
   * going -- and neither reads as the answer. Moved, there is one picture: the
   * row in its prospective order, with the thumb ghosted on its landing slot.
   * This is the one step that assumes the thumbs are equal width, which
   * `.page-thumb`'s fixed 180px makes true; the displaced thumbs above do not.
   */

  _pageDragShift(idx, dragIdx, dropIdx, shift) {
    if (idx === dragIdx) return (dropIdx - dragIdx) * shift;
    if (idx > dragIdx && idx <= dropIdx) return -shift;
    if (idx < dragIdx && idx >= dropIdx) return shift;
    return 0;
  },

  /**
   * Drag-to-reorder for the pages strip, with the landing slot shown as a gap.
   *
   * The strip, not each thumb, listens for `dragover` and `drop`: a gap at the
   * end of the row has no thumb over it, and per-thumb handlers also left the
   * padding between thumbs dead.
   *
   * The offset is written as a custom property rather than an inline
   * `transform`, which would outrank -- and so silently discard --
   * `.page-thumb.subpage`'s own `translateY(7%)` and the hover scale. See the
   * `--pg-shift` rules in the stylesheet.
   */

  _wirePageReorder() {
    const strip = this.shadowRoot.querySelector(".pages-list");
    if (!strip) return;
    const thumbs = () => Array.from(strip.querySelectorAll(".page-thumb[draggable]"));

    let dragIdx = null;
    let shift = 0;
    let dropIdx = null;
    // The thumbs' slots, measured once while the row is still untransformed,
    // and the scroll offset that measurement was taken at.
    //
    // Re-reading them per dragover would feed this its own output: the gap is
    // drawn with transforms, and a transformed element reports the moved box.
    // The slots the pointer is being compared against are the ones the row
    // will settle into, which do not change during a drag -- only the scroll
    // does, and that is one subtraction.
    let slots = [];
    let scrollAt = 0;
    // The pending dragover frame, and the pointer position it will read. Held
    // outside the handler so `clear()` can cancel a frame that would otherwise
    // paint a drag that has already ended.
    let rafId = null;
    let lastX = 0;

    const paint = (to) => {
      if (dragIdx === null || to === dropIdx) return;
      dropIdx = to;
      thumbs().forEach((t, i) => {
        const dx = this._pageDragShift(i, dragIdx, to, shift);
        t.style.setProperty("--pg-shift", `${dx}px`);
      });
    };
    const clear = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      thumbs().forEach(t => t.style.removeProperty("--pg-shift"));
      dragIdx = null;
      dropIdx = null;
      slots = [];
    };

    thumbs().forEach(el => {
      el.addEventListener("dragstart", (e) => {
        dragIdx = parseInt(el.dataset.pageIdx);
        dropIdx = dragIdx;
        slots = thumbs().map(t => {
          const b = t.getBoundingClientRect();
          return { left: b.left, width: b.width };
        });
        scrollAt = strip.scrollLeft;
        // The gap between thumbs travels with them, so the slot a thumb
        // vacates is its own width plus one gap.
        shift = slots[dragIdx].width + this._stripGap(strip);
        el.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        clear();
      });
    });

    strip.addEventListener("dragover", (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      // dragover fires far faster than the strip can be repainted, and each one
      // used to re-query every thumb and rescan the slots. The pointer is read
      // here, where the event is still live, and the work is folded into the
      // next frame -- so a burst of events costs one pass, not one each.
      lastX = e.clientX;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (dragIdx === null) return;
        this._autoScrollStrip(strip, lastX);
        // Back into the frame the slots were measured in: scrolling the strip
        // right by d moves its content left by d, so a fixed slot's clientX
        // falls by d and has to be given back.
        const x = lastX + (strip.scrollLeft - scrollAt);
        paint(this._pageDropIndex(x, slots, dragIdx));
      });
    });

    strip.addEventListener("drop", (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      const from = dragIdx;
      const to = dropIdx;
      // The row is frozen for the length of the swap. `.page-thumb` transitions
      // its transform, so dropping the offsets starts a 150ms slide back to
      // the arrangement the drag began with -- which plays out *after* the DOM
      // has already been reordered, so the card the user just placed visibly
      // travels back to where it came from and settles again. Nothing here is
      // an animation worth keeping: the move is instant and correct, and the
      // transition only had the old positions to animate from.
      strip.classList.add("reordering");
      // Transforms are dropped before the move, not after: the re-render
      // replaces these elements, and a shifted thumb left behind for a frame
      // is the flicker the gap exists to avoid.
      strip.querySelectorAll(".page-thumb").forEach(t => t.classList.remove("dragging"));
      clear();
      if (to !== null && from !== to) this._reorderPage(from, to);
      // Commit the reordered, unshifted row while transitions are still off,
      // then let them back in for ordinary hovers. Reading a layout property
      // is what forces that commit; without it the class could go away in the
      // same frame it was added and change nothing.
      void strip.offsetWidth;
      requestAnimationFrame(() => strip.classList.remove("reordering"));
    });
  },

  /** The strip's own `gap`, in px, falling back to the stylesheet's 12. */

  _stripGap(strip) {
    const raw = getComputedStyle?.(strip)?.columnGap || "";
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 12;
  },

  /**
   * Scroll the strip when a drag nears either edge.
   *
   * The strip is `overflow-x: auto` with fixed-width thumbs, so past about five
   * pages the target is off-screen -- and a native drag does not scroll its
   * container on its own in every browser, which made those pages unreachable
   * by drag at all.
   */

  _autoScrollStrip(strip, clientX) {
    const r = strip.getBoundingClientRect?.();
    if (!r || strip.scrollWidth <= strip.clientWidth) return;
    const EDGE = 40;
    const STEP = 18;
    if (clientX < r.left + EDGE) strip.scrollLeft -= STEP;
    else if (clientX > r.right - EDGE) strip.scrollLeft += STEP;
  },
};
