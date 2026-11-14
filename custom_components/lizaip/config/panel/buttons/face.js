/**
 * lizaIP Panel — Buttons View: Drawing the remote's face: the SVG, its icons and the caches over them.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  isSliderBtn,
  FIXED_CONTROL_KEYS,
  hasOverride,
  DEFAULT_BUTTON_ICONS,
  SLIDER_VERTICAL_KEY,
  SLIDER_ICON_HIDDEN_KEY,
  resolveSliderIcon,
  sliderIconFor,
  storesConfig,
} from "./shared.js";
import {
  drawSVG,
  getPathBounds,
  cropFace,
  overlayStyle,
  titleFit,
  tileFit,
} from "../lizaip-svg.js";

/** How often, and how far apart, a tile picture that failed is asked for again. */
const TILE_RETRIES = 2;
const TILE_RETRY_MS = 1500;

/** The overlays `_drawFaces` patches in place; `drawSVG` leaves them attached. */
const FACE_OVERLAYS = "img.pg-btn-img[data-key], .pg-title-clip";

export const ButtonsFaceMixin = {
  // Which nesting mark, if any, the face should put on `key`.
  //
  // Since the read-only list came off the grid button's card, this is the *only*
  // thing that says which fixed controls are overridden — so it is the whole
  // affordance rather than half of it, and the reason it still asks
  // `hasOverride` / `sliderRetarget` rather than a rule of its own is that
  // those are what the executor's twins agree with.
  //
  // Returns null when no grid button is in context: without one, "overridden"
  // has nothing to be relative to, and a permanent mark would say the fixed
  // buttons are special even on pages that never nest anything.
  _faceMark(key, pageAssigns) {
    // An armed move outranks the nesting marks, and is the one mark that shows
    // with nothing in context. It answers a question the user is holding right
    // now — "which button am I moving?" — while the nesting marks describe a
    // standing arrangement, and the two cannot both be read off one tile.
    if (this._moveSourceKey) return key === this._moveSourceKey ? "moving" : null;
    // The *live* context, not the stored one: a button whose action has been
    // cleared is no longer selectable, so marking the fixed controls relative to
    // it would light up the face for a nesting the executor will never perform.
    const ctx = this._liveContextKey();
    if (!ctx) return null;
    if (key === ctx) return "context";
    if (!FIXED_CONTROL_KEYS.includes(key)) return null;
    const ctxAssign = pageAssigns?.[ctx];
    if (key === SLIDER_VERTICAL_KEY) {
      // The slider's mark reads a live predicate, not the presence of a stored
      // id. A pinned page slider, an opted-out
      // button and an entity with no controls all leave it inheriting, and all
      // three would look overridden under a presence test.
      //
      // Through `_sliderContextState`, which is the same answer the face's icon
      // and tint read — the mark and the glyph beside it must not be able to
      // disagree about whether this button takes the slider.
      return this._sliderContextState(pageAssigns)?.retargets
        ? "overridden" : "inheritable";
    }
    return hasOverride(ctxAssign, key) ? "overridden" : "inheritable";
  },

  // --- SVG refresh methods ---
  /**
   * The `img` for one tile on a page thumbnail, patched in place.
   *
   * *onFace* holds the tile pictures already on this face, by key; the one
   * for *key* is taken from it and kept attached, so a redraw -- once a second
   * while a variable counts down -- never detaches a load in flight, which
   * the browser would drop. Its `src` is written only when it changed: the
   * same value written again would load it again.
   *
   * A URL still being asked for (`src` null) leaves a kept tile showing its
   * old picture until `_applyDeviceUrls` has the answer.
   */

  _tileImg(key, img, onFace = null) {
    const { src, key: devKey } = typeof img === "string" ? { src: img, key: "" } : img;
    let el = onFace?.get(key);
    onFace?.delete(key);
    if (!el) {
      el = document.createElement("img");
      // Decoration: the shape underneath already names it, and these are
      // `pointer-events: none`. Unnamed, a reader would announce the imgserv
      // src once per button.
      el.setAttribute("alt", "");
      el.setAttribute("data-key", key);
      el.addEventListener?.("error", () => this._retryTileImg(el));
    }
    if (src && el.getAttribute("src") !== src) {
      el.style?.removeProperty?.("visibility");
      el.setAttribute("src", src);
    }
    // Cleared when known: a stale one would let `_applyDeviceUrls` put back
    // the picture this tile just moved on from.
    if (devKey) el.setAttribute("data-dev-key", devKey);
    else el.removeAttribute?.("data-dev-key");
    return el;
  },

  /**
   * Ask once more for a tile picture that failed, a little later each time.
   *
   * A phone on a slow or switching network loses requests that a reload
   * would answer; without this the tile stays blank until the next redraw
   * happens to change its `src`.
   */

  _retryTileImg(el) {
    const src = el.getAttribute("src");
    // Counted per `src`: `_applyDeviceUrls` writes one too.
    if (el._retry?.src !== src) el._retry = { src, n: 0 };
    if (!src || el._retry.n >= TILE_RETRIES) return;
    const n = ++el._retry.n;
    setTimeout(() => {
      if (!el.isConnected || el.getAttribute("src") !== src) return;
      // Removed first: some engines skip a `src` set to the value it has.
      el.removeAttribute("src");
      el.setAttribute("src", src);
    }, TILE_RETRY_MS * n);
  },

  /**
   * Size *el* over shape *b* from its own pixels, as the device draws it.
   *
   * Remembered per picture because a new `img` has `naturalWidth` 0 until
   * `load` -- a 60x62 cover slice would otherwise open at the 50x52 default
   * on every page switch and then snap to size.
   */

  _fitTileImg(el, b, key, extraCss = "") {
    const natural = (this._tileNaturalByKey ||= new Map());
    const apply = () => {
      if (el.naturalWidth) natural.set(key, { w: el.naturalWidth, h: el.naturalHeight });
      const known = natural.get(key);
      el.style.cssText = tileFit(b, el.naturalWidth || known?.w, el.naturalHeight || known?.h)
        + extraCss;
    };
    // One listener per element, since a kept picture is fitted again.
    if (el._fitOnLoad) el.removeEventListener?.("load", el._fitOnLoad);
    el._fitOnLoad = apply;
    el.addEventListener?.("load", apply);
    apply();
  },

  /**
   * Redraw the faces -- every one, or only the page indices in *pages*; what
   * the faces read is what the next face-only redraw covers.
   */
  _refreshSVG(pages = null) {
    const draw = () => this._drawFaces(pages);
    return this._readingFaces ? this._readingFaces(draw, !pages) : draw();
  },

  _drawFaces(pages = null) {
    const bp = this._blueprint;
    if (!bp) return;
    // The tiles below are about to be rebuilt, so what the icon pass learned
    // from the previous ones no longer describes anything on screen.
    this._invalidateFaceCaches();
    this._prefetchOptionsFit?.();
    // Every face is drawn again, so what the pages read starts over.
    if (!pages) this._variables?.pageKeys.clear();
    const containers = [...this.shadowRoot.querySelectorAll(".pg-svg-container")];

    containers.forEach(container => {
      const pageIdx = parseInt(container.dataset.pageIdx);
      if (pages && !pages.has(pageIdx)) return;
      // Drawn now, so nothing is owed to it when it comes into view.
      this._facesDirty?.delete(pageIdx);
      const isActive = pageIdx === this._currentPageIdx;
      const page = this._pages[pageIdx];
      if (!page) return;
      this._facePageStart?.(pageIdx);
      const currentPageId = this._pages[this._currentPageIdx]?.id;
      const pageAssigns = (page.id === currentPageId)
        ? this._assignments
        : (this._pageCache[page.id] || {});

      const selectedIdx = this._faceSelectedIdx(bp, isActive);
      // Every tile below reads the *edit slot*, not `pageAssigns[key]`.
      //
      // With a grid button in context the face becomes a view of *that button's
      // configuration*, which is the same thing the card shows — so a fixed
      // control shows the override, and shows nothing when there is no
      // override. Reading the page default here is what made the face contradict
      // the card: it drew the power glyph for a slot the card was offering as
      // empty, and the user had no way to tell which fixed controls the selected
      // button actually configures.
      //
      // Deliberately *not* "what would a press do". A control with no override
      // does still run the page default — that is what `_faceMark` says with
      // `inheritable`, and the mark is the right place for it, because the face
      // is a config surface and its tiles answer "what is set here".
      //
      // `_editAssign` is the one owner of that question and is read-only, so
      // drawing a card can never create an override. An inactive thumbnail has
      // no context and no edit slot, so it reads its cached page map.
      const assignFor = isActive
        ? (key) => this._editAssign(key)
        : (key) => pageAssigns[key];
      // The slider's half of the same question. It is not an `overrides` entry,
      // so `_editAssign` returns the page slider for it whatever the context is
      // — which left the strip showing the page's config while every button
      // beside it had switched to the selection's. Computed once per face rather
      // than per tile: the three reads below and `markFor` all want this answer.
      const sliderCtx = isActive ? this._sliderContextState(pageAssigns) : null;
      // Under a context the strip shows what the selected button points it at,
      // and shows nothing when that button points it nowhere — the slider's
      // spelling of the blank tile the fixed buttons get. No fallback glyph when
      // the retargeted entity yields no control either, for the same reason
      // `sliderIconFor` no longer has one.
      //
      // The button's own `slider_image` wins when it has one, and shows whether
      // or not the button retargets: the card offers Appearance to any selected
      // button, so a stored icon the face refused to draw was a field that took
      // a value and appeared to lose it. Only the *derived* glyph needs the
      // retarget, because deriving is what needs a control to derive from.
      // Read from the page slot rather than the edit slot for the same reason
      // the card does — it is a field on the grid button, not an `overrides`
      // entry.
      const sliderCtxIcon = () => {
        const rec = pageAssigns?.[this._liveContextKey()] || {};
        return resolveSliderIcon(
          rec.slider_image,
          sliderCtx.retargets ? (sliderCtx.control?.icon || "") : "",
          !!rec[SLIDER_ICON_HIDDEN_KEY],
        );
      };
      const isSliderCtx = (key) => !!sliderCtx && key === SLIDER_VERTICAL_KEY;
      // `storesConfig`, not the `isDriving` that used to be here. That predicate
      // was `isConfigured || sliderFollows`, and `sliderFollows` is true only for
      // `slider_vertical` — so on a page with nothing set up, the one control
      // nobody had configured was the only one painted as configured. The slider
      // does still drive without storing anything, but that is what the branch
      // above says, and it says it only while a button is actually in context.
      const hasAction = (key) => (isSliderCtx(key)
        ? sliderCtx.retargets
        : storesConfig(assignFor(key)));
      // An inactive page's controls were wired to nothing at all, and the path
      // handler stops every click on itself — so clicking a button on another
      // page did not even switch to it, let alone open it. The click had to
      // miss every control and land on the face background before the
      // thumbnail's own handler could see it. Both faces answer the same
      // gesture now; the far one just has a page to cross first.
      const onSelect = isActive
        ? (idx) => this._selectFaceKey(bp.buttons[idx]?.key)
        : (idx) => this._switchPageTo(this._pageIdxOf(container), bp.buttons[idx]?.key);
      const getIcon = (key) => {
        if (isSliderCtx(key)) return sliderCtxIcon();
        const assign = assignFor(key);
        const fallbackIcon = DEFAULT_BUTTON_ICONS[key] || "";
        if (!assign) return fallbackIcon;
        // An explicit "no icon" on the page slider, which is a stored choice
        // rather than an absence and so must beat the derived glyph below.
        if (key === SLIDER_VERTICAL_KEY && assign[SLIDER_ICON_HIDDEN_KEY]) return "";
        // Slider mechanics carry their own icon (see sliderIconFor) — checked
        // before the action_id branch because proportional sliders have none.
        if (!assign.icon) {
          const sIcon = sliderIconFor(this._sliderControls, assign);
          if (sIcon) return sIcon;
        }
        if (!assign.action_id) {
          return this._resolveButtonIcon(assign, null, fallbackIcon, page) || fallbackIcon;
        }
        const action = this._actions.find(a => a.id === assign.action_id);
        return this._resolveButtonIcon(assign, action, fallbackIcon, page) || fallbackIcon;
      };
      // Normalise once, like resolve_icon_url's icon.strip(), so every startsWith
      // branch below matches a title pasted with surrounding whitespace.
      // An unset title renders nothing — the device shows a blank title bar, so the
      // preview must too. Never substitute the page id as a stand-in label.
      const rawTitle = this._resolvedPageTitle(page);
      const mode = this._getThemeMode();
      container.classList.toggle("face-dark", mode === "dark");
      const pgColor = page.default_color || "";
      // The colour is sent as soon as one part can spend it; imgserv decides
      // which do. A title carrying its own fg= has already said what it wants.
      // The title strip the remote is sent, colour and text style included.
      const sliderImage = rawTitle ? this._deviceImg(rawTitle, "title", pgColor) : null;
      const sliderImageUrl = sliderImage && sliderImage.src !== "" ? sliderImage : null;

      // Draw clickable button shapes only — icon/title images are HTML overlays
      // below. `markFor` rides along because the nesting mark styles the SVG
      // shape, which is not part of what moved to the overlays.
      drawSVG(container, bp, selectedIdx, hasAction, onSelect, {
        // Only the open page exposes its forty shapes as controls. See drawSVG.
        interactive: isActive,
        // The face says "configured" with colour, which a screen reader cannot
        // report, so the state joins the name instead.
        nameFor: (btn, { configured }) => {
          // The title strip is drawn by the same loop as the shapes but is the
          // Page Settings control, not a button: the file says so in four
          // other places and this callback was the one that missed it, so a
          // reader heard the storage key -- "slider horizontal, empty".
          if (btn.key === "slider_horizontal") return this._t("a11y_page_title");
          // Same trap one key over: the slider is not a button, and the
          // fallback would call it "Button Slider vertical".
          const sliderFallback = isSliderBtn(btn.key) ? this._t("a11y_slider") : null;
          // The words the remote prints on the button, not the stored text: a
          // label holding a placeholder was read out as "dollar sign, left
          // brace, STATE".
          const assign = assignFor(btn.key);
          const name = this._buttonSpokenLabel(assign) || sliderFallback
            || this._t("a11y_btn_fallback", { name: this._humaniseButtonKey(btn.key) });
          return this._t(configured ? "a11y_btn_configured" : "a11y_btn_empty", { name });
        },
        // Only the active page carries the nesting marks. An inactive thumbnail
        // has no selection to be in context of — `selectedIdx` is already -1
        // there for the same reason — and marking one would claim a context on
        // a page the user is not editing.
        markFor: isActive ? (key) => this._faceMark(key, pageAssigns) : () => null,
        // Same rule as `onSelect`: an inactive thumbnail is a picture of another
        // page, and clearing a button on a page the user is not editing is not
        // a gesture anyone reaches for by accident.
        onContext: isActive ? (idx, ev) => this._showFaceMenu(bp.buttons[idx], ev) : null,
        // Only the open page, for the reason `onContext` is: a move reads the
        // open page's assignments, and a thumbnail is a picture of another.
        canDrag: isActive ? (key) => this._canMoveButton(key) : null,
        canDrop: isActive ? (key, fromKey) => this._canDropButtonOn(fromKey, key) : null,
        onDrop: isActive ? (from, to) => this._dropButtonOn(from, to) : null,
        keep: FACE_OVERLAYS,
      });

      cropFace(container.querySelector("svg"));

      // The pictures the last draw left, by key. Each one this draw still
      // wants is taken out by `_tileImg`; what remains is removed below.
      const onFace = new Map();
      container.querySelectorAll("img[data-key]")
        .forEach(el => onFace.set(el.getAttribute("data-key"), el));

      // Title PNG (slider_horizontal area). `titleFit` draws it at the size
      // the device does; the clip bounds a title too long for the bar, which
      // would otherwise be painted across the grid below it.
      //
      // Natural sizes are remembered per URL because `_render()` builds a new
      // `img` on every page switch, whose `naturalWidth` is 0 until `load`
      // fires even from cache -- without the cache a short label snapped in
      // from bar-width on every switch.
      if (sliderImageUrl) {
        const sliderBtn = bp.buttons.find(b => b.key === 'slider_horizontal');
        if (sliderBtn) {
          const b = getPathBounds(sliderBtn.d);
          if (b) {
            const el = this._tileImg('slider_horizontal', sliderImageUrl, onFace);
            const kept = el.parentNode?.classList?.contains('pg-title-clip');
            const clip = kept ? el.parentNode : document.createElement('div');
            clip.className = 'pg-title-clip';
            clip.style.cssText = overlayStyle(b, b.w, b.h);

            el.className = 'pg-btn-img pg-title-img';
            const natural = (this._titleNaturalByUrl ||= new Map());
            const applySize = () => {
              if (el.naturalWidth) {
                natural.set(sliderImageUrl.key, { w: el.naturalWidth, h: el.naturalHeight });
              }
              const known = natural.get(sliderImageUrl.key);
              Object.assign(el.style, titleFit(
                b, el.naturalWidth || known?.w, el.naturalHeight || known?.h,
              ));
            };
            if (el._titleOnLoad) el.removeEventListener?.('load', el._titleOnLoad);
            el._titleOnLoad = applySize;
            el.addEventListener('load', applySize);
            applySize();

            if (!kept) {
              clip.appendChild(el);
              container.appendChild(clip);
            }
          }
        }
      }

      // Button icon PNGs
      bp.buttons.forEach(btn => {
        // `slider_horizontal` is the title bar and gets its own image above.
        // `slider_vertical` is *not* skipped: its glyph is a stored — and under
        // a context, an overridden — choice that `getIcon` already answers for,
        // so skipping it would leave the one control this branch is about with
        // no icon on the face.
        if (btn.key === 'slider_horizontal') return;
        const icon = String(getIcon(btn.key) ?? '').trim();
        if (!icon) return;
        const b = getPathBounds(btn.d);
        if (!b) return;
        // Through `assignFor`, like `getIcon` above, rather than the raw page
        // map. The icon this overlay carries is already the context's, so
        // reading the page default for the tint and the dim would style it as
        // unassigned — the fixed control the page leaves blank but the context
        // drives would come out greyed under the icon just drawn for it.
        const overlayAssign = assignFor(btn.key);
        const tile = this._buildTileImgUrl(
          icon, mode, pgColor, storesConfig(overlayAssign),
        );
        // "" is nothing to draw; null is a URL still being asked for.
        if (tile.src === "") return;
        const el = this._tileImg(btn.key, tile, onFace);
        el.className = 'pg-btn-img';
        // Dimmed while the firmware glyph is all there is. Read through
        // `storesConfig`, like the tint above: a fixed key configured inline,
        // with no library action, is assigned too.
        const dim = DEFAULT_BUTTON_ICONS[btn.key] && !storesConfig(overlayAssign);
        this._fitTileImg(el, b, tile.key,
          'pointer-events:none;' + (dim ? 'opacity:0.3;' : ''));
        if (el.parentNode !== container) container.appendChild(el);
      });

      // Tiles this draw no longer has, and a title together with its clip.
      onFace.forEach(el => {
        const clip = el.parentNode?.classList?.contains('pg-title-clip') ? el.parentNode : null;
        (clip || el).remove?.();
      });
      this._facePageEnd?.();
    });
    this._observeFaces(containers);
  },

  /**
   * Tell the variables which pages are in view (`_faceVisible`), so a change
   * on a page scrolled away is asked for and drawn once it is scrolled back.
   *
   * Clipping by the page strip counts: an observer without a root clips the
   * target by every scrolling ancestor, not only by the viewport.
   */
  _observeFaces(containers) {
    if (typeof IntersectionObserver !== "function") return;
    this._faceObserver ||= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target;
        // A face the last render replaced reports itself out of view too, and
        // must not speak for the new one at its index.
        if (!el.isConnected) {
          this._faceObserver.unobserve(el);
          continue;
        }
        const idx = parseInt(el.dataset.pageIdx);
        const was = this._faceVisible(idx);
        (this._faceVisibility ||= new Map()).set(idx, entry.isIntersecting);
        if (entry.isIntersecting && !was) this._faceShown?.(idx);
      }
    });
    for (const c of containers) this._faceObserver.observe(c);
  },

  // Which shape on the face carries the selection highlight.
  //
  // A grid button when one is selected. Otherwise `slider_horizontal`, but only
  // while the page's title row is open — that strip *is* the title, and the
  // highlight says which control the card is currently showing. Landing on Page
  // Settings by selecting a page highlights nothing: the card is showing the
  // page's colour, which is not any one shape on the face.
  //
  // It used to light up whenever nothing was selected, from when reaching Page
  // Settings and opening the title were the same gesture. Kept that way it would
  // now mark the strip while the row it opens is closed.
  //
  // Only the highlight moves, never `_selectedButtonIdx`. The rest of the panel
  // reads -1 as "no button is being edited", which stays true -- a page is not
  // a button.
  //
  // Inactive page thumbnails get nothing: there is no selection to show on a
  // page that is not being edited.

  _faceSelectedIdx(bp, isActive) {
    if (!isActive) return -1;
    if (this._selectedButtonIdx >= 0) return this._selectedButtonIdx;
    if (!this._pageTitleSelected) return -1;
    // findIndex gives -1 for a blueprint without the strip, which is the same
    // "highlight nothing" the caller already handles. Not optional-chained:
    // `_refreshSVG` has already returned if there is no blueprint, and drawSVG
    // walks `bp.buttons` unguarded a few lines later, so a guard here would
    // relocate that crash rather than prevent it.
    return bp.buttons.findIndex(b => b.key === "slider_horizontal");
  },

  _refreshSVGIcons() {
    return this._readingFaces ? this._readingFaces(() => this._refreshFaceIcons(), false) : this._refreshFaceIcons();
  },

  _refreshFaceIcons() {
    // Incremental update: refresh only state-driven icon <img src> values
    // without a full redraw (avoids re-fetching images that haven't changed).
    if (!this._blueprint) return;
    const mode = this._getThemeMode();

    // Home Assistant assigns `hass` on every state change anywhere in the
    // house, and this walk is O(pages x buttons x actions) -- on a full remote
    // that is thousands of operations, nearly always to conclude that nothing
    // moved. So the walk records which entities it actually read, and a later
    // tick that touched none of them returns here instead.
    //
    // HA replaces a state object rather than mutating it, so identity is a
    // sufficient and very cheap test. The face epoch covers everything else:
    // any edit that could change *which* entities matter redraws the face,
    // and a redraw invalidates the set rather than trusting it.
    if (this._svgIconDeps
        && this._svgIconEpoch === this._faceEpoch
        && this._svgIconMode === mode
        && this._svgIconDepsUnchanged()) {
      return;
    }
    const deps = new Map();

    this.shadowRoot.querySelectorAll(".pg-svg-container").forEach(container => {
      const pageIdx = parseInt(container.dataset.pageIdx);
      const page = this._pages[pageIdx];
      if (!page) return;
      const pageColor = page.default_color || "";
      const currentPageId = this._pages[this._currentPageIdx]?.id;
      const isActive = page.id === currentPageId;
      const pageAssigns = isActive
        ? this._assignments
        : (this._pageCache[page.id] || {});

      // Added to what the page's face read, not in place of it.
      this._facePageStart?.(pageIdx, false);
      container.querySelectorAll("img.pg-btn-img[data-key]").forEach(img => {
        const key = img.getAttribute("data-key");
        if (key === 'slider_horizontal') return;
        // Through the edit slot, like `_refreshSVG`'s `getIcon`. This runs on
        // every entity state change, so reading the page default here would
        // repaint it over the context's own tile a second after that tile was
        // drawn — which reads as an intermittent bug rather than a missing
        // feature.
        const assign = isActive ? this._editAssign(key) : pageAssigns[key];
        if (!assign?.action_id) return;
        // Recorded before the early returns below, because an entity that
        // currently resolves to no icon still has to be watched: it is exactly
        // the one whose next state change should bring the tile back.
        for (const eid of this._getTargetEntitiesFromConfig(assign.config) || []) {
          if (!deps.has(eid)) deps.set(eid, this._hass?.states?.[eid]);
        }
        const action = this._actions.find(a => a.id === assign.action_id);
        if (!action) return;
        const newIcon = this._resolveButtonIcon(assign, action, "", page);
        if (!newIcon) return;
        const tile = this._buildTileImgUrl(newIcon, mode, pageColor, true);
        if (tile.src === null) {
          // Asked for; `_applyDeviceUrls` fills it in when the answer comes.
          // The picture on the tile stays until then.
          img.setAttribute('data-dev-key', tile.key);
          return;
        }
        if (!tile.src) return;
        if (img.getAttribute('src') !== tile.src) {
          img.setAttribute('src', tile.src);
          img.setAttribute('data-dev-key', tile.key);
        }
      });
      this._facePageEnd?.();
    });

    this._svgIconDeps = deps;
    this._svgIconEpoch = this._faceEpoch;
    this._svgIconMode = mode;
  },

  /**
   * Whether every entity the last icon pass read still holds the same state.
   *
   * An entity that has since disappeared from `hass` compares equal to the
   * `undefined` recorded for one that was already missing, so a button bound
   * to a removed entity does not spin the walk on every tick.
   */

  _svgIconDepsUnchanged() {
    const states = this._hass?.states;
    for (const [eid, recorded] of this._svgIconDeps) {
      if (states?.[eid] !== recorded) return false;
    }
    return true;
  },

  /**
   * Drop what the icon pass remembered, because the face it described is gone.
   *
   * Called wherever the face is rebuilt: the set of entities on screen is a
   * product of that markup, so it cannot outlive it.
   */

  _invalidateFaceCaches() {
    this._faceEpoch = (this._faceEpoch || 0) + 1;
    this._svgIconDeps = null;
  },

  /**
   * `{src, key}` for a button face: the tile the remote is sent (`_deviceImg`).
   * An untinted tile -- a default the page leaves unassigned -- is asked for
   * without the colour.
   *
   * The colour is the page's default and nothing else: the editor draws a
   * button from how it is configured, not from what its target is currently
   * doing. The remote still tints and fills by state, device-side.
   */

  _buildTileImgUrl(icon, mode, color, isTinted) {
    return this._deviceImg(icon, "tile", isTinted ? color : "");
  },

  // --- Wiring ---

  /**
   * The blueprint index of a button key — what `_selectButton` speaks in.
   * Read off the live blueprint rather than carried through the menu, because
   * the menu outlives the render that opened it only by microseconds but the
   * key is the stable thing either way.
   */
  _faceIdxFor(key) {
    const buttons = this._blueprint?.buttons || [];
    return buttons.findIndex(b => b.key === key);
  },

  /**
   * What clicking a control on the face means, wherever the click came from.
   *
   * `slider_horizontal` is Page Settings, not a button: clicking it always
   * lands on the page card, so it deselects rather than selecting. It also
   * drops the context, because Page Settings is not a nested state and a face
   * still marked under it would be claiming otherwise.
   *
   * It is additionally the one control that *is* the page's title, so it is
   * what opens the title row on that card. Selecting a page thumbnail leaves
   * the row closed; this strip toggles it, which is the same "click the thing
   * again to put it away" every other control has.
   *
   * Everything else hands to `_selectButton`, including the click that
   * deselects. That delegation is the fix for a real bug: this used to clear
   * `_selectedButtonIdx` itself and return, which skipped `_selectButton`'s
   * context handling entirely — so deselecting a grid button on the face left
   * `_contextKey` set and the highlight stuck on with nothing selected. Two
   * implementations of "what deselect means", one of which forgot half the
   * state. One owner now — and that owner is why a click on an *inactive*
   * page's face can land on the button it hit rather than only on the page:
   * `_switchPageTo` replays the very same gesture once the page is current.
   *
   * @returns {boolean} Whether the key named a control — and so whether this
   *   rendered. A caller that has changed something else first (the page, in
   *   `_switchPageTo`'s case) has to draw that change itself when the answer is
   *   no, or a key naming nothing would leave the new page unpainted.
   */
  _selectFaceKey(key) {
    if (!key) return false;
    // A move is armed: this click is the second half of it, whatever it lands
    // on. Intercepted here rather than in each caller because this is the one
    // owner of "what clicking a control on the face means", and a move that
    // only completed on some routes would be a move that sometimes selected
    // instead. Clicking the armed button itself calls it off — the same "click
    // it again to put it away" every other control has.
    //
    // Everything else goes to `_moveButtonTo`, which already turns down every
    // slot that cannot hold a button record and says why. Naming one of them
    // here too was a second copy of that rule, and the two had drifted.
    if (this._moveSourceKey) {
      if (key === this._moveSourceKey) this._cancelMove();
      else this._moveButtonTo(key);
      return true;
    }
    if (key === "slider_horizontal") {
      // Toggled against the state it is actually in, not against a plain
      // `true`: arriving here from a selected grid button must *open* the row,
      // and that state has `_selectedButtonIdx >= 0` with the flag already
      // false.
      const wasOpen = this._selectedButtonIdx < 0 && this._pageTitleSelected;
      // Captured before the render that replaces it. The title row is an
      // editor like any config card, so it opens and closes the same way.
      if (!wasOpen) this._a11yRememberTrigger();
      this._selectedButtonIdx = -1;
      this._contextKey = null;
      this._pageTitleSelected = !wasOpen;
      this._render();
      this._a11yEditorToggled(
        this._pageTitleSelected,
        this._t("a11y_editing_title"),
        this._t("a11y_title_closed"),
      );
      return true;
    }
    const idx = this._faceIdxFor(key);
    if (idx < 0) return false;
    this._selectButton(idx);
    return true;
  },
};
