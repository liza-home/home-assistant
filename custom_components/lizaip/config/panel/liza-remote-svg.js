/**
 * lizaIP Panel — SVG Drawing
 * Renders clickable SVG button shapes. Icon/title images are overlaid as
 * HTML <img> elements by the caller (see _refreshSVG in liza-remote-buttons-view.js).
 */

/**
 * Draw the SVG remote with button overlays (shapes only — no icon images).
 * @param {HTMLElement} container
 * @param {Object} blueprint - {buttons, viewBox}
 * @param {number} selectedIdx - Selected button index (-1 = none)
 * @param {Function} hasAction - (buttonKey) => boolean
 * @param {Function} onSelect - (idx) callback
 * @param {Object} [opts] - {markFor, onContext, interactive, nameFor, faceTitle}
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
 */
export function drawSVG(container, blueprint, selectedIdx, hasAction, onSelect, opts) {
  if (!container || !blueprint) return;

  const bp = blueprint;
  const svgNS = "http://www.w3.org/2000/svg";

  container.innerHTML = "";

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
    // `presentation`, not nothing at all: the <title> below would otherwise
    // become this element's accessible name, and a *named element with no role*
    // is exposed as a group. That is the bug that had a reader saying the page
    // twice and then "group". Presentation keeps the tooltip while leaving the
    // element out of the tree; the shapes inside keep their own roles.
    svg.setAttribute("role", "presentation");
    // The hover tooltip for the open page. An SVG tooltip is a <title> child,
    // not a title attribute, and it is drawn by the renderer rather than the
    // accessibility tree, so it survives the presentation role.
    if (opts?.faceTitle) {
      const tip = document.createElementNS(svgNS, "title");
      tip.textContent = opts.faceTitle;
      svg.appendChild(tip);
    }
  } else {
    // A picture of another page. Nothing inside it is a control here.
    svg.setAttribute("aria-hidden", "true");
  }

  // Every drawn shape, with the centre arrow navigation steers by. Geometry
  // from the path data rather than getBBox(): it needs no layout, so it is the
  // same number in a browser and in a test.
  const stops = [];

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
      if (el._lizaSuppressClick) { el._lizaSuppressClick = false; return; }
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
        const t = e.touches && e.touches[0];
        const x = t ? t.clientX : 0;
        const y = t ? t.clientY : 0;
        timer = setTimeout(() => {
          timer = null;
          el._lizaSuppressClick = true;
          opts.onContext(idx, { clientX: x, clientY: y });
        }, 500);
      }, { passive: true });
      for (const type of ["touchend", "touchmove", "touchcancel"]) {
        el.addEventListener(type, cancel, { passive: true });
      }
    }
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

  container.appendChild(svg);
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
          cx = isRel ? cx + nums[i + 5] : nums[i + 5];
          cy = isRel ? cy + nums[i + 6] : nums[i + 6];
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
