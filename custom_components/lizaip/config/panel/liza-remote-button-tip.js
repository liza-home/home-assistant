// lizaIP Panel — the hover card over a shape on the open face, and over a page
// in the strip. One node re-filled; every line comes from the helper that
// already answers that question elsewhere, and it describes, never announces.

/** The one node's id, which is what `aria-describedby` points at. */
const TIP_ID = "liza-button-tip";

// How long the pointer must rest. Not zero: crossing the face to reach the
// strip passes over a dozen shapes, and an instant card would flash each.
const TIP_DELAY_MS = 350;

/** Clear of the viewport edge, and clear of the shape the card is about. */
const TIP_GAP = 10;
const TIP_EDGE = 8;

/** How close to a corner of the card the caret's centre may sit. */
const TIP_CARET = 12;

// Keys the face draws that are not buttons, and must not be named as ones.
// `slider_horizontal` is the page title strip, which drives nothing at all.
const isSliderKey = (key) => /^slider_/.test(key);
const PAGE_TITLE_KEY = "slider_horizontal";

// How many presses of a cycle the card lists before counting the rest. Four
// covers every cycle the panel writes by hand; past that the card is taller
// than the face it sits beside and nobody reads to the end of it.
const TIP_MAX_PRESS_ROWS = 4;

export const ButtonTipMixin = {

  // ===================== whether the card appears =====================

  // Where the switch on the gear tab remembers itself. Browser-local, like the
  // page-links preference beside it: it changes what this editor draws and
  // nothing the remote does.
  BUTTON_TIPS_PREF: "liza.remote.buttonTips",

  /**
   * Whether a hover raises a card at all -- over a shape on the face or over a
   * page in the strip. Off until switched on.
   *
   * Both are the same card and the same interruption, so they answer to one
   * switch rather than to two that would have to be found and flipped
   * together. Off by default, like the page links beside it: the editor says
   * nothing on hover unless asked to. Read once and kept: this is asked on
   * every hover.
   *
   * Storage is wrapped: a browser with site data blocked throws on access
   * rather than returning null, and an unreadable preference is not a reason
   * for the face to stop rendering.
   */
  _buttonTipsEnabled() {
    if (this._buttonTipsOn === undefined) {
      let stored = null;
      try { stored = window.localStorage?.getItem(this.BUTTON_TIPS_PREF); } catch (e) { stored = null; }
      this._buttonTipsOn = stored === "1";
    }
    return this._buttonTipsOn;
  },

  _setButtonTipsEnabled(on) {
    this._buttonTipsOn = !!on;
    try {
      window.localStorage?.setItem(this.BUTTON_TIPS_PREF, this._buttonTipsOn ? "1" : "0");
    } catch (e) { /* Blocked storage: the switch still works for this session. */ }
    // Switched off while a card is up -- the pointer may be resting on a shape
    // on another tab -- it goes now rather than at the next pointer move.
    if (!this._buttonTipsOn) this._hideButtonTip();
  },

  // ===================== what the card says =====================

  // Everything the card knows about one shape, as data. Split from the markup
  // so the wording can be tested without a DOM — see `a single press is named
  // by what it runs, not by what it prints` in tests/js/button-tooltip.test.mjs.
  _buttonTipModel(key) {
    const assign = this._editAssign ? this._editAssign(key) : null;
    const rows = this._buttonTipRows(assign, key);
    return {
      key,
      name: this._buttonTipName(key, assign),
      rows,
      empty: !rows.length,
      // A slider has no actions to be missing, so the button wording would be
      // answering a question nobody asked about it.
      noneText: this._t(isSliderKey(key) ? "tip_not_configured" : "no_action_assigned"),
    };
  },

  // The words the remote prints on the shape, with the two non-buttons named
  // as what they are — exactly as `nameFor` does in `_refreshSVG`, so the card
  // and the shape's own accessible name cannot call one shape two things.
  _buttonTipName(key, assign) {
    if (key === PAGE_TITLE_KEY) return this._t("a11y_page_title");
    const spoken = this._buttonSpokenLabel?.(assign) || "";
    if (spoken) return spoken;
    if (isSliderKey(key)) return this._t("a11y_slider");
    return this._t("a11y_btn_fallback", { name: this._humaniseButtonKey(key) });
  },

  // One line per thing the button does, empty when it does nothing. A slider
  // stores mechanics rather than a service call, so the press helpers can only
  // ever call a working one empty and it is answered on its own terms instead.
  _buttonTipRows(assign, key) {
    if (isSliderKey(key)) return this._sliderTipRows(key, assign);
    if (!assign) return [];
    const rows = [];
    this._buttonTipPressRows(assign, rows);
    this._buttonTipLongTouchRow(assign, rows);
    this._buttonTipInteractionRows(assign, rows);
    this._buttonTipSliderRow(assign, rows);
    this._buttonTipTargetRows(assign, rows);
    return rows;
  },

  // How a slider is pointed, then what it moves. The arrangement is stated
  // first and always: a following slider's device is the fallback it drives
  // until something is touched, and the row above is what says so.
  _sliderTipRows(key, assign) {
    if (key === PAGE_TITLE_KEY) return [];
    const facts = this._sliderTipFacts(key, assign);
    const rows = [{
      kind: this._t("tip_slider_mode"),
      text: this._t(facts.follows ? "tip_slider_follows" : "tip_slider_fixed"),
    }];
    if (facts.entity) {
      const named = this._hass?.states?.[facts.entity]?.attributes?.friendly_name
        || facts.entity.split(".").pop();
      rows.push({
        kind: this._t("entity"),
        text: facts.control ? `${named} (${facts.control})` : named,
      });
    }
    return rows;
  },

  // A single press is named by what it *runs*, the head of the card being the
  // printed label already. A cycle is the other way round and numbered: its
  // labels are what its presses differ in, and its order is what it is.
  _buttonTipPressRows(assign, rows) {
    const kind = this._t("click_action");
    const rules = Array.isArray(assign.toggle?.rules) ? assign.toggle.rules : [];
    if (rules.length > 1) {
      const names = this._pressHeadings(rules);
      names.slice(0, TIP_MAX_PRESS_ROWS).forEach((name, i) => {
        rows.push({ kind, text: `${i + 1}. ${name}` });
      });
      const rest = names.length - TIP_MAX_PRESS_ROWS;
      if (rest > 0) rows.push({ kind, text: this._t("tip_more", { n: rest }) });
      return;
    }
    if (!Array.isArray(assign.config) || !assign.config.length) return;
    rows.push({ kind, text: this._toggleRuleName(assign) });
  },

  /** The long touch, which is stored as a sequence rather than as a rule. */
  _buttonTipLongTouchRow(assign, rows) {
    if (!Array.isArray(assign.longtouch) || !assign.longtouch.length) return;
    rows.push({
      kind: this._t("longtouch_action"),
      text: this._toggleRuleName({ config: assign.longtouch }),
    });
  },

  // The secondary gestures, named from the stored key rather than a table:
  // `interactions` is a map the backend fills, so a phrase per gesture would
  // have to be added here before a new one could be shown at all.
  _buttonTipInteractionRows(assign, rows) {
    const map = assign.interactions;
    if (!map || typeof map !== "object") return;
    for (const [name, actionId] of Object.entries(map)) {
      const action = (this._actions || []).find(a => a.id === actionId);
      rows.push({
        kind: this._humaniseButtonKey(name),
        text: action?.name || this._t("no_action_assigned"),
      });
    }
  },

  // That this button hands the slider its own device. Naming a subject is what
  // makes the slider follow this button while it is selected, and it is the
  // half of the arrangement the slider's own card cannot state.
  _buttonTipSliderRow(assign, rows) {
    const facts = this._buttonSliderOverride?.(assign);
    if (!facts?.entity) return;
    const named = this._hass?.states?.[facts.entity]?.attributes?.friendly_name
      || facts.entity.split(".").pop();
    rows.push({
      kind: this._t("a11y_slider"),
      text: facts.control ? `${named} (${facts.control})` : named,
    });
  },

  // What the button is aimed at: an entity, or a page. A goto whose target no
  // longer resolves is disarmed by the remote while the face goes on drawing a
  // confident glyph for it, so the page branch carries that verdict too.
  _buttonTipTargetRows(assign, rows) {
    const config = assign.config;
    if (!Array.isArray(config) || !config.length) return;

    const cmd = this._internalCommandFor?.(config);
    if (cmd && this._targetsPages?.(cmd)) {
      const target = this._internalCommandTargetName(
        config, "", this._internalTargetHint(assign),
      );
      if (target) rows.push({ kind: this._t("tip_opens"), text: target });
      const problem = this._internalCommandProblem(config);
      if (problem) rows.push({ kind: this._t("tip_problem"), text: problem, warn: true });
      return;
    }

    const subject = this._getTargetSubjectName?.(config) || "";
    const entityId = this._getTargetEntityFromConfig?.(config) || "";
    const named = subject
      || this._hass?.states?.[entityId]?.attributes?.friendly_name
      || (entityId ? entityId.split(".").pop() : "");
    if (named) rows.push({ kind: this._t("entity"), text: named });
  },

  // ===================== the node =====================

  // Created once and re-parented as needed: `_render()` rewrites the shadow
  // root and detaches it, so the parent is checked on every show — the same
  // bargain `_a11yLiveRegion` strikes with the same rewrite.
  _buttonTipEl() {
    const sr = this.shadowRoot;
    if (!sr) return null;
    if (!this._btnTip) {
      const el = document.createElement("div");
      el.className = "liza-btn-tip";
      el.id = TIP_ID;
      el.setAttribute("role", "tooltip");
      el.hidden = true;
      this._btnTip = el;
    }
    if (this._btnTip.parentNode !== sr) sr.appendChild(this._btnTip);
    return this._btnTip;
  },

  // The glyph the face already drew, read out of the overlay rather than
  // rebuilt: `_refreshSVG` resolves a tile image through the context, the
  // state, the page colour and the dim, and this would be a second answer.
  _buttonTipIconSrc(pathEl, key) {
    const container = pathEl?.ownerSVGElement?.parentElement;
    if (!container?.querySelector) return "";
    const img = container.querySelector(`img.pg-btn-img[data-key="${key}"]`);
    return img?.getAttribute?.("src") || "";
  },

  _buttonTipHtml(model, iconSrc) {
    const rows = model.empty
      ? `<div class="liza-btn-tip-row liza-btn-tip-none">${
          this._esc(model.noneText)}</div>`
      : model.rows.map(r => `
        <div class="liza-btn-tip-row${r.warn ? " warn" : ""}">
          <span class="liza-btn-tip-kind">${this._esc(r.kind)}</span>
          <span class="liza-btn-tip-text">${this._esc(r.text)}</span>
        </div>`).join("");
    return `
      <div class="liza-btn-tip-head">${
        iconSrc ? `<img class="liza-btn-tip-icon" src="${this._esc(iconSrc)}" alt="">` : ""
      }<span class="liza-btn-tip-name">${this._esc(model.name)}</span></div>
      ${rows}`;
  },

  // ===================== showing and hiding =====================

  // The face's single hover entry point, wired by `drawSVG` for every shape on
  // the open page. `on` is false for the leave and the blur; `instant` is a
  // focus, which is deliberate and has nothing to wait out.
  _onButtonHover(key, pathEl, on, instant) {
    if (!on) { this._hideButtonTip(); return; }
    // Switched off on the gear tab: a shape says nothing on hover.
    if (!this._buttonTipsEnabled()) return;
    // Mid-drag the card would sit over the shape the user is aiming at, and
    // the ghost is already saying what is being moved.
    if (this.classList?.contains?.("face-dragging")) return;
    this._cancelButtonTip();
    if (instant) { this._paintButtonTip(key, pathEl); return; }
    this._btnTipTimer = setTimeout(() => {
      this._btnTipTimer = null;
      this._paintButtonTip(key, pathEl);
    }, TIP_DELAY_MS);
  },

  _cancelButtonTip() {
    if (this._btnTipTimer) {
      clearTimeout(this._btnTipTimer);
      this._btnTipTimer = null;
    }
  },

  _paintButtonTip(key, pathEl) {
    this._paintTip(pathEl, this._buttonTipHtml(
      this._buttonTipModel(key), this._buttonTipIconSrc(pathEl, key),
    ));
  },

  // Put *html* in the one card and park it beside *anchor*. Shared by the
  // shapes and the thumbnails, so crossing from the face to the strip cannot
  // leave two cards behind: whichever raised it last owns it.
  _paintTip(anchor, html) {
    const tip = this._buttonTipEl();
    if (!tip) return;
    tip.innerHTML = html;
    tip.hidden = false;
    anchor?.setAttribute?.("aria-describedby", TIP_ID);
    this._btnTipAnchor = anchor;
    this._placeButtonTip(anchor, tip);
    // Scrolling moves the anchor and not a fixed card, so it takes the card
    // away rather than leaving it beside the wrong one. Captured, because the
    // strip is what scrolls, not the window.
    if (!this._btnTipScroll) this._btnTipScroll = () => this._hideButtonTip();
    window.addEventListener?.("scroll", this._btnTipScroll, true);
    // WCAG 1.4.13: content raised on hover is dismissable without moving the
    // pointer. On the window, because a pointer hover leaves the focus
    // wherever it was and the shape under it never sees the key.
    if (!this._btnTipKeydown) {
      this._btnTipKeydown = (e) => { if (e.key === "Escape") this._hideButtonTip(); };
    }
    window.addEventListener?.("keydown", this._btnTipKeydown, true);
  },

  // Beside the shape and inside the viewport, in fixed coordinates:
  // `.page-thumb` is scaled and translated, so a positioned child would grow
  // with the hover and shear with the subpage offset.
  _placeButtonTip(pathEl, tip) {
    const r = pathEl?.getBoundingClientRect?.();
    if (!r) return;
    // Measured from the origin, not from the last position: stale offsets
    // measure against the wrong edge and flip the card over for no reason.
    tip.style.left = "0px";
    tip.style.top = "0px";
    const box = tip.getBoundingClientRect?.() || { width: 0, height: 0 };
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    let left = r.right + TIP_GAP;
    let side = "right";
    if (left + box.width > vw - TIP_EDGE) {
      left = r.left - TIP_GAP - box.width;
      side = "left";
    }
    if (left < TIP_EDGE) left = Math.max(TIP_EDGE, vw - box.width - TIP_EDGE);

    let top = r.top + r.height / 2 - box.height / 2;
    top = Math.max(TIP_EDGE, Math.min(top, vh - box.height - TIP_EDGE));

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    this._placeTipCaret(tip, r, { left, top, box, side });
  },

  // The caret, which says which of forty close-packed shapes the card is
  // about. Kept level with the shape rather than with the card: the card is
  // clamped to the viewport and the shape it describes is not.
  _placeTipCaret(tip, r, { left, top, box, side }) {
    const fits = side === "right" ? left > r.right : left + box.width < r.left;
    tip.classList?.remove?.("tip-left", "tip-right");
    if (!fits) return;
    const centre = r.top + r.height / 2 - top;
    const limit = Math.max(TIP_CARET, box.height - TIP_CARET);
    tip.classList?.add?.(side === "right" ? "tip-right" : "tip-left");
    tip.style.setProperty?.(
      "--tip-caret", `${Math.round(Math.max(TIP_CARET, Math.min(centre, limit)))}px`,
    );
  },

  // Withdraw the card, and the description with it. A describedby left
  // pointing at a `hidden` node resolves to nothing in some readers and to
  // stale text in others, and the shape's own name must be heard either way.
  _hideButtonTip() {
    this._cancelButtonTip();
    if (this._btnTipAnchor) {
      this._btnTipAnchor.removeAttribute?.("aria-describedby");
      this._btnTipAnchor = null;
    }
    if (this._btnTipScroll) window.removeEventListener?.("scroll", this._btnTipScroll, true);
    if (this._btnTipKeydown) window.removeEventListener?.("keydown", this._btnTipKeydown, true);
    if (!this._btnTip) return;
    this._btnTip.hidden = true;
    this._btnTip.innerHTML = "";
    this._btnTip.classList?.remove?.("tip-left", "tip-right");
  },

  // ===================== the page thumbnails =====================

  // What the card says about a page: plain lines, a page having no gestures to
  // list. Headed by the title, which is what the user recognises it by, or by
  // the position when there is no title to use instead.
  _pageTipModel(page, bp) {
    const title = this._pageTitle(page);
    const pos = this._pagePosition(page);
    const { filled, total } = this._pageFillCounts(page, bp);
    return {
      name: title || pos,
      lines: [
        title ? pos : "",
        this._t("page_fill_desc", { filled, total }),
      ].filter(Boolean),
    };
  },

  _pageTipHtml(model) {
    const lines = model.lines.map(
      l => `<div class="liza-btn-tip-line">${this._esc(l)}</div>`,
    ).join("");
    return `
      <div class="liza-btn-tip-head"><span class="liza-btn-tip-name">${
        this._esc(model.name)}</span></div>
      ${lines}`;
  },

  // The strip's hover entry point, wired by `_wireButtonsView` for every thumb.
  // The open page is skipped: its shapes raise their own cards, and a second
  // card about the page is the thing the face's own tooltip was removed for.
  _onPageHover(pageIdx, thumbEl, on, instant) {
    if (!on) { this._hideButtonTip(); return; }
    // The same switch as the shapes: one card, one preference.
    if (!this._buttonTipsEnabled()) return;
    if (pageIdx === this._currentPageIdx) return;
    const page = this._pages?.[pageIdx];
    const bp = this._blueprint;
    if (!page || !bp) return;
    if (this.classList?.contains?.("face-dragging")) return;
    this._cancelButtonTip();
    const paint = () => this._paintTip(
      thumbEl, this._pageTipHtml(this._pageTipModel(page, bp)),
    );
    if (instant) { paint(); return; }
    this._btnTipTimer = setTimeout(() => {
      this._btnTipTimer = null;
      paint();
    }, TIP_DELAY_MS);
  },
};
