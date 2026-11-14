/**
 * lizaIP Panel — SVG Drawing
 * Renders clickable SVG button shapes. Icon/title images are overlaid as
 * HTML <img> elements by the caller (see _refreshSVG in lizaip-buttons-view.js).
 */

/**
 * How long a long-press keeps the right to swallow a click, in ms.
 *
 * A touch stack that delivers the click a long-press ended delivers it
 * immediately; 700 ms is generous for that and still far short of the next
 * deliberate tap.
 */
const SUPPRESS_MS = 700;

/**
 * Mark (or unmark) the click a long-press is about to leave behind.
 *
 * This used to be a plain boolean cleared only by the click it was waiting
 * for -- which iOS frequently never sends. Safari swallows the click itself
 * once a long press has turned into a text callout or a drag lift, and it
 * sends none at all when the press ends as a scroll of the page strip. The
 * flag then stayed set and ate the *next* tap instead, so a page or a button
 * simply failed to open every other time it was touched.
 *
 * Two things stop that now: the mark expires, and the next touch clears it
 * before it can do any harm.
 */
export function armSuppress(el, on) {
  if (el) el._lizaSuppressClick = on ? Date.now() + SUPPRESS_MS : 0;
}

/** True if a click arriving now is the one a long-press just left behind.
 *  Reading it consumes it either way: a stale mark must not outlive the
 *  first click that looks at it. */
export function suppressedNow(el) {
  const until = el?._lizaSuppressClick || 0;
  if (el) el._lizaSuppressClick = 0;
  return until > 0 && Date.now() <= until;
}

/**
 * Eat the click a finished drag leaves behind, on the container (which
 * survives the drop's redraw) in the capture phase. That phase is also why a
 * drag must not `armSuppress` as well: the shape's listener never runs.
 */
function swallowNextClick(container) {
  if (!container?.addEventListener) return;
  let timer = null;
  const off = () => {
    container.removeEventListener?.("click", swallow, true);
    if (timer) clearTimeout(timer);
  };
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
    off();
  };
  container.addEventListener("click", swallow, true);
  timer = setTimeout(off, SUPPRESS_MS);
}

/** How far the pointer must travel before a press becomes a drag, in CSS px.
 *  Above the tremor in an ordinary click, which must never become a drag. */
const DRAG_THRESHOLD = 4;

/**
 * Drag a button's configuration onto another: the move `Move…` arms, in one
 * gesture. Reports both ends through `opts.onDrop` and decides nothing else.
 * Mouse and pen only -- touch spends a long press on the context menu.
 *
 * The ghosts are cloned *inside* the existing face and container, because
 * `.page-thumb` has a `transform` and `overflow: hidden` -- a follower parked
 * outside would be mispositioned and clipped.
 *
 * @param {HTMLElement} container The `.pg-svg-container`, which outlives the
 *   redraw a drop causes -- hence the swallow and cursor class hang off it.
 * @param {SVGElement} svg The face, used to refuse a release over another
 *   page's face.
 */
function createFaceDrag(container, svg, opts) {
  // The press, before it is known to be a drag. `live` is what separates the
  // two: below the threshold this is still a click that has not been let go.
  const state = { el: null, key: null, x: 0, y: 0, live: false, target: null, wasMark: null, onKey: null, onSelect: null, thumb: null, thumbWasDraggable: false, ghost: null, ghostImg: null, scale: 1, srcImg: null, backImg: null };

  const root = () => container?.getRootNode?.() || (typeof document !== "undefined" ? document : null);

  /**
   * Stop the page strip's native drag of the `.page-thumb` this face sits in.
   * `dragstart` fires on the thumb and never reaches this container, so it
   * cannot be cancelled -- the attribute goes, and comes back in `clear()`.
   */
  const holdThumb = () => {
    state.thumb = container?.closest?.(".page-thumb[draggable]") || null;
    if (!state.thumb) return;
    // Remembered, not assumed: restoring every thumb as `true` would grant a
    // page reordering the strip had deliberately taken away from it.
    state.thumbWasDraggable = state.thumb.draggable !== false;
    state.thumb.draggable = false;
  };

  const releaseThumb = () => {
    if (state.thumb) state.thumb.draggable = state.thumbWasDraggable;
    state.thumb = null;
    state.thumbWasDraggable = false;
  };

  /** The face shape under the pointer, or null. */
  const shapeAt = (x, y) => {
    const hit = root()?.elementFromPoint?.(x, y);
    // The overlays are `pointer-events: none`, so the topmost hit is already
    // the shape -- `closest` is kept for anything that may later be in the way.
    const shape = hit?.closest?.(".button[data-key]") || null;
    // Another page's thumbnail is not a destination: those shapes are drawn
    // from assignments this move is not reading.
    if (!shape || !svg?.contains?.(shape)) return null;
    // Nor a shape that cannot hold a configuration. Refused here rather than
    // at the release, so the ring never appears and the cursor says so on the
    // way past.
    if (opts.canDrop && !opts.canDrop(shape.getAttribute?.("data-key"), state.key)) return null;
    return shape;
  };

  /**
   * Flag the panel root for the drag. The cursor must outrank every element a
   * drag crosses, and pointer capture redirects the events but not the cursor,
   * so only a rule on the host can speak for all of it.
   */
  const flagHost = (name, on) => {
    const host = root()?.host;
    if (on) host?.classList?.add?.(name);
    else host?.classList?.remove?.(name);
  };

  /** The HTML icon overlay for a face key, which is where a button's picture
   *  lives -- the SVG holds only the shape. */
  const iconFor = (key) => container.querySelector?.(`img.pg-btn-img[data-key="${key}"]`);

  /**
   * A copy of the dragged button, flying with the pointer: the shape cloned
   * into the same `<svg>` and its icon cloned into the same container, so the
   * thumbnail's own `transform` and clipping apply to both as to the face.
   */
  const makeGhost = () => {
    const ghost = state.el.cloneNode?.(false);
    if (!ghost) return;
    // Stripped of everything that says *slot*: it is a thing in flight, and the
    // per-key rules would otherwise out-specify the ghost styling as well.
    for (const a of ["mark", "drop", "selected", "configured", "data-key"]) ghost.removeAttribute?.(a);
    ghost.setAttribute?.("ghost", "");
    svg.appendChild?.(ghost);
    state.ghost = ghost;

    // The icon moves in the container's *own* px, which an ancestor transform
    // scales on the way to the screen -- `.page-thumb:hover` is 1.03, so an
    // uncorrected icon drifts further than its shape the longer the drag runs.
    const rect = container.getBoundingClientRect?.();
    state.scale = (rect?.width && container.offsetWidth)
      ? rect.width / container.offsetWidth : 1;

    // The picture is an HTML overlay, so a shape alone would fly as an empty
    // outline saying "a button" where this says "*this* button". Keyless like
    // the shape, which also hides it from the overlay refresh.
    state.srcImg = iconFor(state.key);
    const copy = state.srcImg?.cloneNode?.(true);
    if (!copy) return;
    copy.removeAttribute?.("data-key");
    copy.setAttribute?.("ghost", "");
    container.appendChild?.(copy);
    state.ghostImg = copy;
    // The original stays behind otherwise, so the button would read as being in
    // two places at once -- in hand and still in its slot.
    state.srcImg.style?.setProperty?.("visibility", "hidden");
  };

  /**
   * The other half of the swap: the target's icon shown in the slot the drag
   * emptied. Without it a drop reads as overwriting the destination, which is
   * not what a move does -- the two configurations trade places.
   */
  const showReturn = (shape) => {
    state.backImg?.remove?.();
    state.backImg = null;
    const key = shape?.getAttribute?.("data-key");
    // An icon overlay is not proof of a configuration: a fixed button draws a
    // faint fallback while unassigned. Nothing comes back from an empty slot,
    // and the absence of a preview says exactly that.
    const filled = key && (!opts.canDrag || opts.canDrag(key));
    const copy = filled && state.srcImg ? iconFor(key)?.cloneNode?.(true) : null;
    if (!copy) return;
    copy.removeAttribute?.("data-key");
    copy.setAttribute?.("returning", "");
    // Worn in the source's slot, so the geometry is the source's.
    for (const p of ["left", "top", "width", "height"]) {
      copy.style?.setProperty?.(p, state.srcImg.style?.[p]);
    }
    container.appendChild?.(copy);
    state.backImg = copy;
  };

  /** Carry the ghost to the pointer. The shape travels in user units, the icon
   *  in the client px it was positioned with. */
  const dragGhost = (x, y) => {
    const dx = x - state.x;
    const dy = y - state.y;
    const m = svg.getScreenCTM?.();
    state.ghost?.setAttribute?.("transform",
      `translate(${dx / (m?.a || 1)} ${dy / (m?.d || 1)})`);
    if (state.ghostImg?.style) {
      state.ghostImg.style.transform =
        `translate(${dx / state.scale}px, ${dy / state.scale}px)`;
    }
  };

  const paintTarget = (shape) => {
    // Never the source itself: a drag that came back home is a cancel, and
    // ringing the shape it started on would promise a move that does nothing.
    const next = shape && shape !== state.el ? shape : null;
    // The cursor answers across the gaps between shapes. The source is exempt
    // from both: a refusal the instant a button is picked up reads as an error
    // rather than as the absence of a destination.
    flagHost("face-no-drop", !next && shape !== state.el);
    if (state.target === next) return;
    state.target?.removeAttribute?.("drop");
    state.target = next;
    next?.setAttribute?.("drop", "");
    showReturn(next);
  };

  /** Put the face back the way the drag found it. */
  const clear = () => {
    if (state.onKey) {
      window.removeEventListener?.("keydown", state.onKey);
      state.onKey = null;
    }
    if (state.onSelect) {
      window.removeEventListener?.("selectstart", state.onSelect);
      state.onSelect = null;
    }
    flagHost("face-dragging", false);
    flagHost("face-no-drop", false);
    state.target?.removeAttribute?.("drop");
    if (state.live && state.el) {
      // Restored, not removed: the shape may have carried a nesting mark from
      // `markFor` before the drag borrowed the attribute.
      if (state.wasMark === null) state.el.removeAttribute?.("mark");
      else state.el.setAttribute("mark", state.wasMark);
    }
    releaseThumb();
    state.ghost?.remove?.();
    state.ghostImg?.remove?.();
    state.backImg?.remove?.();
    state.srcImg?.style?.removeProperty?.("visibility");
    state.ghost = null; state.ghostImg = null; state.backImg = null;
    state.srcImg = null; state.scale = 1;
    state.el = null; state.key = null;
    state.live = false; state.target = null; state.wasMark = null;
  };

  const begin = () => {
    state.live = true;
    state.wasMark = state.el.getAttribute?.("mark") ?? null;
    state.el.setAttribute("mark", "moving");
    makeGhost();
    flagHost("face-dragging", true);
    // The press may already have anchored a selection before the threshold was
    // crossed, and it grows with every move after. `user-select: none` cannot
    // reach it: the pointer leaves the container constantly during a drag.
    window.getSelection?.()?.removeAllRanges?.();
    state.onSelect = (e) => e.preventDefault();
    window.addEventListener?.("selectstart", state.onSelect);
    // Escape, because the way out of a pointer gesture cannot be releasing the
    // pointer -- that is how it is completed.
    state.onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      finish(null);
    };
    window.addEventListener?.("keydown", state.onKey);
  };

  /** End the gesture, dropping on `shape` when there is one. */
  const finish = (shape) => {
    const wasLive = state.live;
    const from = state.key;
    const el = state.el;
    const to = shape && shape !== el ? shape.getAttribute?.("data-key") : null;
    clear();
    if (!wasLive) return;
    // The click the browser sends next is drag residue, not a selection. The
    // container swallow only, never `armSuppress` too -- see `swallowNextClick`.
    swallowNextClick(container);
    if (to) opts.onDrop(from, to);
  };

  return {
    /** Wire one shape as a drag source. */
    wire(el, key) {
      el.addEventListener("pointerdown", (e) => {
        // Touch keeps its long-press menu; a secondary button is on its way to
        // the context menu and must not be mistaken for a lift.
        if (e.pointerType === "touch" || (e.button != null && e.button !== 0)) return;
        if (!opts.canDrag(key)) return;
        clear();
        state.el = el; state.key = key;
        state.x = e.clientX; state.y = e.clientY;
        // Held from the press, not from the threshold: the browser's own drag
        // starts at a distance it picks, which can be shorter than ours, so a
        // thumb still draggable at that moment is already moving.
        holdThumb();
        // Captured at the press, not the threshold: without it the first move
        // out of a small shape goes elsewhere and no drag ever starts.
        el.setPointerCapture?.(e.pointerId);
      });

      el.addEventListener("pointermove", (e) => {
        if (state.el !== el) return;
        // A redraw landed under the gesture -- an echo of someone else's save,
        // say. The shape being dragged is no longer on screen, so there is
        // nothing left to drop.
        if (el.isConnected === false) { clear(); return; }
        if (!state.live) {
          const dx = e.clientX - state.x;
          const dy = e.clientY - state.y;
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          begin();
        }
        dragGhost(e.clientX, e.clientY);
        paintTarget(shapeAt(e.clientX, e.clientY));
      });

      el.addEventListener("pointerup", (e) => {
        if (state.el !== el) return;
        // Hit-tested afresh, since moves may have been coalesced away, and
        // finished before the capture is released: releasing fires
        // `lostpointercapture` below, which would cancel the drop first.
        finish(state.live ? shapeAt(e.clientX, e.clientY) : null);
        el.releasePointerCapture?.(e.pointerId);
      });

      for (const type of ["pointercancel", "lostpointercapture"]) {
        el.addEventListener(type, () => { if (state.el === el) finish(null); });
      }
    },
  };
}

/**
 * Draw the SVG remote with button overlays (shapes only — no icon images).
 * @param {HTMLElement} container
 * @param {Object} blueprint - {buttons, viewBox}
 * @param {number} selectedIdx - Selected button index (-1 = none)
 * @param {Function} hasAction - (buttonKey) => boolean
 * @param {Function} onSelect - (idx) callback
 * @param {Object} [opts] - {markFor, onContext, onDrop, canDrag, canDrop, interactive, nameFor, keep}
 *
 * Accessibility: with `interactive` the shapes become real controls —
 * `role="button"`, a tab stop, a name from `nameFor`, and Enter/Space/context
 * keys on the same callbacks as the pointer gestures. Without it the panel's
 * primary surface is reachable by mouse and touch only.
 *
 * Inactive thumbnails pass `interactive: false`: they draw the same forty
 * shapes, so exposing them would multiply the tab sequence by the page count
 * to reach controls the user can get to by opening the page. They are
 * `aria-hidden`, and the thumbnail around them carries the page switch.
 *
 * Icons are HTML <img> overlays added by the caller, not drawn here. `opts`
 * stays because the nesting mark is a property of the *shape* — it drives the
 * stylesheet's `mark` attribute — rather than of the icon.
 *
 * `onContext(idx, {clientX, clientY})` is the secondary gesture on a tile:
 * right-click on a pointer, long-press on a touch screen. Both are routed here
 * rather than to a second listener in the caller, because the shape is the only
 * thing that knows which tile was hit — the icon overlays sit above it with
 * `pointer-events:none` for the same reason.
 *
 * `canDrag(key)` and `onDrop(fromKey, toKey)` wire the drag shortcut, and only
 * when both are given. The optional `canDrop(toKey, fromKey)` narrows what may
 * *receive* one. See `createFaceDrag`.
 */
export function drawSVG(container, blueprint, selectedIdx, hasAction, onSelect, opts) {
  if (!container || !blueprint) return;

  const bp = blueprint;
  const svgNS = "http://www.w3.org/2000/svg";

  // `keep` is a selector for the overlays the caller patches in place. They
  // stay attached: a picture detached mid-load is dropped by the browser, and
  // a redraw comes once a second while a variable counts down.
  if (opts?.keep) {
    for (const child of Array.from(container.children || [])) {
      if (!child.matches?.(opts.keep)) child.remove?.();
    }
  } else {
    container.innerHTML = "";
  }

  const svg = document.createElementNS(svgNS, "svg");
  const vb = bp.viewBox || "0 0 400 800";
  const parts = vb.split(/\s+/);
  const vbWidth = parseFloat(parts[2]);
  const vbHeight = parseFloat(parts[3]);

  svg.setAttributeNS(null, "viewBox", vb);
  svg.setAttributeNS(null, "width", vbWidth.toString());
  svg.setAttributeNS(null, "height", vbHeight.toString());
  svg.style.display = "block";
  svg.style.width = "100%";
  svg.style.height = "auto";

  const interactive = opts?.interactive !== false;
  if (interactive) {
    // No role, because the face is not a widget in its own right: it is a
    // picture with buttons drawn on it, and each button says what it is.
    //
    // It was a toolbar, then a listbox. Both were wrong for the same reason --
    // every composite role (toolbar, listbox, radiogroup, grid) is *defined* as
    // one tab stop with the arrows moving inside it, and Tab is how people
    // actually expect to walk this face. The keyboard decides the role, so
    // forty buttons that Tab reaches individually are forty buttons.
    //
    // `presentation`, not nothing at all: a named element with no role is
    // exposed as a group, which is the bug that had a reader saying the page
    // twice and then "group". The shapes inside keep their own roles.
    svg.setAttribute("role", "presentation");
    // No <title>: the browser would draw the page's over whichever shape the
    // pointer rested on, answering a hover about a button with the page.
  } else {
    // A picture of another page. Nothing inside it is a control here.
    svg.setAttribute("aria-hidden", "true");
  }

  // Every drawn shape, with the centre arrow navigation steers by. Geometry
  // from the path data rather than getBBox(): it needs no template, so it is the
  // same number in a browser and in a test.
  const stops = [];

  // Shared by every shape, because the gesture runs between two of them. Built
  // only when the caller offers both halves.
  const faceDrag = (interactive && typeof opts?.onDrop === "function"
    && typeof opts?.canDrag === "function")
    ? createFaceDrag(container, svg, opts)
    : null;

  // Button shape overlays (click targets)
  bp.buttons.forEach((btn, idx) => {
    if (!btn.d) return;
    const el = document.createElementNS(svgNS, "path");
    el.setAttributeNS(null, "d", btn.d);
    el.setAttributeNS(null, "class", "button");
    el.setAttribute("data-key", btn.key);

    if (idx === selectedIdx) el.setAttribute("selected", "");
    if (hasAction(btn.key)) {
      el.setAttribute("configured", "");
    } else {
      el.setAttribute("empty", "");
    }
    // The nesting mark, when the panel has a grid button in context: which
    // button *is* the context, and which of the fixed controls differ under it.
    // A single attribute rather than three booleans, because the three states
    // are exclusive and the stylesheet's specificity ladder is easier to reason
    // about with one axis to slot into.
    //
    // Set alongside `configured`/`empty` rather than replacing them: a control
    // is still configured or not while it is also overridden, and the existing
    // rules go on saying so.
    const mark = opts?.markFor ? opts.markFor(btn.key) : null;
    if (mark) el.setAttribute("mark", mark);

    if (interactive) {
      const selected = idx === selectedIdx;
      el.setAttribute("role", "button");
      // Promoted to a real tab stop after the loop, once the geometry the
      // arrows steer by has been collected.
      el.setAttribute("tabindex", "-1");
      const b = getPathBounds(btn.d);
      stops.push({ el, idx, cx: b ? b.cx : 0, cy: b ? b.cy : 0 });
      el.setAttribute("aria-label", opts?.nameFor
        ? opts.nameFor(btn, { configured: hasAction(btn.key) })
        : btn.key.replace(/^button_/, "").replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()));
      // `aria-current`, not `aria-selected`: selection is a listbox idea, and
      // aria-selected is invalid on a button. Set only when true -- "false" is
      // announced by some readers, which is noise on thirty-nine shapes.
      //
      // Position is not carried at all: aria-posinset is invalid on button, and
      // writing "3 of 40" into the name means saying it on every single shape.
      if (selected) el.setAttribute("aria-current", "true");

      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          // Space scrolls the page by default, and the face is tall enough to
          // scroll — so activating a button would also jump the view away from it.
          e.preventDefault();
          e.stopPropagation();
          onSelect(idx);
        } else if (opts?.onContext && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
          // The menu is otherwise reachable only by right-click or long-press,
          // so without this the whole secondary action is pointer-only.
          e.preventDefault();
          e.stopPropagation();
          const r = el.getBoundingClientRect();
          opts.onContext(idx, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
        }
      });
    }

    el.addEventListener("click", (e) => {
      e.stopPropagation();
      // A long-press has already acted, and the browser still delivers the
      // click that ended it. Without this, opening the menu by long-press also
      // selected the button underneath and re-rendered the face out from under
      // the menu.
      if (suppressedNow(el)) return;
      onSelect(idx);
    });

    if (opts?.onContext) {
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.onContext(idx, e);
      });

      // The same gesture for touch, where there is no right button. Cancelled
      // by movement so a drag across the face — which is how the page strip is
      // scrolled — never fires it.
      let timer = null;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      el.addEventListener("touchstart", (e) => {
        cancel();
        // A new gesture starts: anything the last one left behind is stale.
        armSuppress(el, false);
        const t = e.touches && e.touches[0];
        const x = t ? t.clientX : 0;
        const y = t ? t.clientY : 0;
        timer = setTimeout(() => {
          timer = null;
          armSuppress(el, true);
          opts.onContext(idx, { clientX: x, clientY: y });
        }, 500);
      }, { passive: true });
      for (const type of ["touchend", "touchmove", "touchcancel"]) {
        el.addEventListener(type, cancel, { passive: true });
      }
    }

    // Wired on every shape: one that cannot be picked up is still a place one
    // can be put down, and `canDrag` is asked at the press, not here, so
    // clearing a button never leaves a stale listener behind.
    faceDrag?.wire(el, btn.key);

    svg.appendChild(el);
  });

  // Every shape is a tab stop, and the arrows work as well.
  //
  // A listbox is normally one tab stop with a roving tabindex, and that is what
  // this shipped as. It was changed back deliberately: arrow keys are what a
  // screen reader user expects, but a sighted keyboard user reaches for Tab and
  // found the face impossible to walk. Both now work.
  //
  // The cost is real and is the reason the pattern exists: crossing the face
  // with Tab takes one press per button again. The arrows are the fast path,
  // and Home and End skip to either end.
  if (interactive && stops.length) {
    for (const s of stops) s.el.setAttribute("tabindex", "0");

    /** The nearest shape in a direction. Weighted so the step stays in the row
     *  or column it started in: without the perpendicular penalty, "right" from
     *  the last key in a row jumps diagonally to whatever happens to be closest. */
    const nearest = (from, dx, dy) => {
      let best = null;
      let bestScore = Infinity;
      for (const s of stops) {
        if (s === from) continue;
        const ax = (s.cx - from.cx) * dx;
        const ay = (s.cy - from.cy) * dy;
        const along = ax + ay;
        if (along <= 0) continue;
        const perp = Math.abs(dx ? s.cy - from.cy : s.cx - from.cx);
        const score = along + perp * 3;
        if (score < bestScore) { bestScore = score; best = s; }
      }
      return best;
    };

    // Focus only. The tab stops do not rove: every button keeps its own, so
    // arrowing across the face must not quietly rewrite the tab order behind
    // it -- Tab from wherever you stopped should carry on from there.
    const move = (from, to) => {
      if (to) to.el.focus();
    };

    const DIRS = {
      ArrowRight: [1, 0], ArrowLeft: [-1, 0],
      ArrowDown: [0, 1], ArrowUp: [0, -1],
    };
    for (const s of stops) {
      s.el.addEventListener("keydown", (e) => {
        if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          e.stopPropagation();
          move(s, e.key === "Home" ? stops[0] : stops[stops.length - 1]);
          return;
        }
        const dir = DIRS[e.key];
        if (!dir) return;
        // Not stopped when there is nowhere to go: the arrow then means what it
        // always did to the page, which is how a reader scrolls the face.
        const to = nearest(s, dir[0], dir[1]);
        if (!to) return;
        e.preventDefault();
        e.stopPropagation();
        move(s, to);
      });
    }
  }

  // Dashed arc separators for the +/- rocker
  const volumeUpBtn = bp.buttons.find(b => b.key === "button_volume_up");
  const volumeDownBtn = bp.buttons.find(b => b.key === "button_volume_down");
  if (volumeUpBtn?.d && volumeDownBtn?.d) {
    const upB = getPathBounds(volumeUpBtn.d);
    const downB = getPathBounds(volumeDownBtn.d);
    if (upB && downB) {
      const x1 = upB.cx - upB.w / 2;
      const x2 = upB.cx + upB.w / 2;
      const r = upB.w / 2;
      for (const [cy, sweep] of [[upB.cy, 0], [downB.cy, 1]]) {
        const sep = document.createElementNS(svgNS, "path");
        sep.setAttributeNS(null, "d", `M${x1},${cy} A${r},${r} 0 0 ${sweep} ${x2},${cy}`);
        sep.setAttributeNS(null, "class", "rocker-separator");
        svg.appendChild(sep);
      }
    }
  }

  // Under the overlays it kept, which are drawn on top of it.
  if (opts?.keep && container.firstChild && container.insertBefore) {
    container.insertBefore(svg, container.firstChild);
  } else {
    container.appendChild(svg);
  }
}

/** The button area of a face, without the casing around it. */
const CROP = { x: 32, y: 33, w: 108, h: 295 };

/** The device title area in its own pixels, which is not the bar's shape. */
const TITLE = { w: 200, h: 60 };

/** A grid button's circle on the device, in its pixels: the most a tile may fill. */
const CELL = { w: 60, h: 62 };

/** imgserv's `size=tile`, assumed until a picture says otherwise. */
const TILE = { w: 50, h: 52 };

/** Crop a drawn face to its button area, in place. */
export function cropFace(svg) {
  if (!svg) return;
  svg.style.width = "100%";
  svg.style.height = "auto";
  svg.setAttributeNS(null, "viewBox", `${CROP.x} ${CROP.y} ${CROP.w} ${CROP.h}`);
  svg.setAttributeNS(null, "width", String(CROP.w));
  svg.setAttributeNS(null, "height", String(CROP.h));
}

/**
 * Where an HTML overlay goes over a shape, in per cent of the cropped face,
 * so it holds at whatever pixel size the face is drawn.
 */
export function overlayStyle(b, w, h = w) {
  return `left:${((b.cx - w / 2 - CROP.x) / CROP.w * 100).toFixed(3)}%;`
    + `top:${((b.cy - h / 2 - CROP.y) / CROP.h * 100).toFixed(3)}%;`
    + `width:${(w / CROP.w * 100).toFixed(3)}%;`
    + `height:${(h / CROP.h * 100).toFixed(3)}%;`;
}

/**
 * Where a grid tile goes over its oval *b*, at the size the device draws it.
 *
 * Sized from the picture's own pixels against the 60x62 cell, so a 50x52
 * tile and a 60x62 cover slice each take the share of the button they take on
 * the remote; nothing is drawn larger than the cell.
 */
export function tileFit(b, naturalWidth, naturalHeight) {
  // One scale for both axes, so a square icon stays square, taken from the
  // 60x62 cell fitted into the shape: a grid oval is exactly that, and a round
  // or wider control (the D-pad, a rocker) gives its picture no more. Bounded
  // by the shape, which is what lets a 60x62 cover slice fill its oval exactly.
  const s = Math.min(b.w / CELL.w, b.h / CELL.h);
  const w = Math.min((naturalWidth || TILE.w) * s, CELL.w * s);
  const h = Math.min((naturalHeight || TILE.h) * s, CELL.h * s);
  return overlayStyle(b, w, h);
}

/**
 * A title picture at the size the device draws it, in per cent of its bar.
 *
 * Sized from the picture's own pixels: the bar is 4:1 while the title area is
 * 10:3, so fitting a short label to the bar made it as large as a full-width
 * logo. One too long overflows, which is what the device does with it too.
 * Centred in the bar, unless it is wider than the bar: then it starts at the
 * left edge, so the start of the title shows and the rest is cut off.
 */
export function titleFit(b, naturalWidth, naturalHeight) {
  const scale = Math.min(b.w / TITLE.w, b.h / TITLE.h);
  const w = (naturalWidth || TITLE.w) * scale;
  const h = (naturalHeight || TITLE.h) * scale;
  return {
    left: (w > b.w ? 0 : (b.w - w) / 2 / b.w * 100).toFixed(2) + "%",
    top: ((b.h - h) / 2 / b.h * 100).toFixed(2) + "%",
    width: (w / b.w * 100).toFixed(2) + "%",
    height: (h / b.h * 100).toFixed(2) + "%",
  };
}

/**
 * Compute bounding box center + dimensions of an SVG path.
 * Exported so callers can position HTML <img> overlays at the same locations.
 */
export function getPathBounds(d) {
  if (!d) return null;
  const points = [];

  const cmdRe = /([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/gi;
  let match;
  let cx = 0, cy = 0;

  while ((match = cmdRe.exec(d)) !== null) {
    const cmd = match[1];
    const argsStr = match[2].trim();
    const nums = [];
    const numRe = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi;
    let nm;
    while ((nm = numRe.exec(argsStr)) !== null) nums.push(parseFloat(nm[0]));

    const isRel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case 'M': // moveto: x,y pairs
      case 'L': // lineto: x,y pairs
        for (let i = 0; i < nums.length - 1; i += 2) {
          cx = isRel ? cx + nums[i] : nums[i];
          cy = isRel ? cy + nums[i + 1] : nums[i + 1];
          points.push([cx, cy]);
        }
        break;
      case 'H': // horizontal line: x values
        for (let i = 0; i < nums.length; i++) {
          cx = isRel ? cx + nums[i] : nums[i];
          points.push([cx, cy]);
        }
        break;
      case 'V': // vertical line: y values
        for (let i = 0; i < nums.length; i++) {
          cy = isRel ? cy + nums[i] : nums[i];
          points.push([cx, cy]);
        }
        break;
      case 'C': // cubic bezier: (x1,y1 x2,y2 x,y) — use all as bounds contributors
        for (let i = 0; i < nums.length - 5; i += 6) {
          const x1 = isRel ? cx + nums[i] : nums[i];
          const y1 = isRel ? cy + nums[i + 1] : nums[i + 1];
          const x2 = isRel ? cx + nums[i + 2] : nums[i + 2];
          const y2 = isRel ? cy + nums[i + 3] : nums[i + 3];
          cx = isRel ? cx + nums[i + 4] : nums[i + 4];
          cy = isRel ? cy + nums[i + 5] : nums[i + 5];
          points.push([x1, y1], [x2, y2], [cx, cy]);
        }
        break;
      case 'S': // smooth cubic: (x2,y2 x,y)
        for (let i = 0; i < nums.length - 3; i += 4) {
          const x2 = isRel ? cx + nums[i] : nums[i];
          const y2 = isRel ? cy + nums[i + 1] : nums[i + 1];
          cx = isRel ? cx + nums[i + 2] : nums[i + 2];
          cy = isRel ? cy + nums[i + 3] : nums[i + 3];
          points.push([x2, y2], [cx, cy]);
        }
        break;
      case 'Q': // quadratic: (x1,y1 x,y)
        for (let i = 0; i < nums.length - 3; i += 4) {
          const x1 = isRel ? cx + nums[i] : nums[i];
          const y1 = isRel ? cy + nums[i + 1] : nums[i + 1];
          cx = isRel ? cx + nums[i + 2] : nums[i + 2];
          cy = isRel ? cy + nums[i + 3] : nums[i + 3];
          points.push([x1, y1], [cx, cy]);
        }
        break;
      case 'T': // smooth quadratic: x,y pairs
        for (let i = 0; i < nums.length - 1; i += 2) {
          cx = isRel ? cx + nums[i] : nums[i];
          cy = isRel ? cy + nums[i + 1] : nums[i + 1];
          points.push([cx, cy]);
        }
        break;
      case 'A': // arc: rx,ry rotation large-arc sweep-flag x,y — ONLY x,y are coordinates!
        for (let i = 0; i < nums.length - 6; i += 7) {
          const x0 = cx, y0 = cy;
          cx = isRel ? cx + nums[i + 5] : nums[i + 5];
          cy = isRel ? cy + nums[i + 6] : nums[i + 6];
          // An unrotated half ellipse -- every arc a face is drawn with -- also
          // reaches the far end of the axis it does not travel along. Without
          // it a level oval measured as tall as it is wide. The sweep flag says
          // which side: in SVG's y-down space it turns through increasing angles.
          const rx = Math.abs(nums[i]), ry = Math.abs(nums[i + 1]);
          const mx = (x0 + cx) / 2, my = (y0 + cy) / 2;
          const sweep = nums[i + 4] ? 1 : -1;
          if (!nums[i + 2] && Math.abs(y0 - cy) < 1e-6 && Math.abs(Math.abs(cx - x0) - 2 * rx) < 1e-3) {
            // Left to right with sweep=1 passes the top (y - ry).
            points.push([mx, my - sweep * Math.sign(cx - x0) * ry]);
          } else if (!nums[i + 2] && Math.abs(x0 - cx) < 1e-6 && Math.abs(Math.abs(cy - y0) - 2 * ry) < 1e-3) {
            // Top to bottom with sweep=1 passes the right (x + rx).
            points.push([mx + sweep * Math.sign(cy - y0) * rx, my]);
          }
          points.push([cx, cy]);
        }
        break;
      case 'Z': // close — no new point
        break;
    }
  }

  if (points.length < 2) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const w = maxX - minX;
  const h = (maxY - minY) || w;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}
