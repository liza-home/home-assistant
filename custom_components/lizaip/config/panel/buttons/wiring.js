/**
 * lizaIP Panel — Buttons View: Attaching listeners to the markup the view has just written.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  isSliderBtn,
  num,
  FACTOR_MIN,
  FACTOR_MAX,
  sliderDomains,
  controlsForEntity,
  matchControl,
  sliderSubjectEntity,
  setSliderSubject,
  setSliderControl,
  applyControl,
  SLIDER_VERTICAL_KEY,
  SLIDER_TARGET_ENTITY,
  isConfigured,
} from "./shared.js";
import {
  armSuppress,
  suppressedNow,
} from "../lizaip-svg.js";
import { badNumber } from "../lizaip-helpers.js";

export const ButtonsWiringMixin = {
  _wireButtonsView(bp) {
    // Page thumbnails
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      el.addEventListener("click", (e) => {
        // A long-press fires the menu and then, on most touch stacks, a click.
        // Without this the page would change out from under the open menu.
        if (suppressedNow(el)) return;
        const idx = parseInt(el.dataset.pageIdx);
        // On the current page, a button's own handler owns a click on it.
        // Anywhere else on that page -- the face background or the frame
        // around it -- selects the page itself: a selected button or the open
        // title row is put away and Page Settings shows. Otherwise the only
        // way out is re-clicking the exact control you started from.
        if (idx === this._currentPageIdx) {
          if (e.target?.closest?.(".button")) return;
          const wasTitle = this._selectedButtonIdx === -1 && !!this._pageTitleSelected;
          if (this._selectedButtonIdx === -1 && !this._contextKey && !wasTitle) return;
          this._flushAutoSave();
          this._selectedButtonIdx = -1;
          this._contextKey = null;
          this._pageTitleSelected = false;
          this._editorEl = null;
          this._sequence = [];
          this._render();
          if (wasTitle) {
            this._a11yEditorToggled?.(false, this._t("a11y_editing_title"), this._t("a11y_title_closed"));
          }
          return;
        }
        // Only the face *background* and the frame around it get here from
        // another page: every button path stops the click on itself and hands
        // it to `onSelect`, which crosses to the page with that button already
        // named. This is the click that names nothing, so it just crosses.
        if (idx !== this._currentPageIdx) {
          this._switchPageTo(idx);
        }
      });
    });

    // The strip's hover card. On the thumb rather than the picture inside it,
    // because the thumbs are small and a card that only answers over the drawn
    // pixels is one the user has to aim for. Focus too, for the keyboard.
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      const idx = parseInt(el.dataset.pageIdx);
      el.addEventListener("mouseenter", () => this._onPageHover(idx, el, true));
      el.addEventListener("mouseleave", () => this._onPageHover(idx, el, false));
      el.addEventListener("focusin", () => this._onPageHover(idx, el, true, true));
      el.addEventListener("focusout", () => this._onPageHover(idx, el, false));
    });

    // Right-click, and the long-press that stands in for it on touch. Same
    // gesture and same 500 ms as the button faces, so the strip does not teach
    // a second way to ask for a menu. Movement cancels it: dragging across the
    // strip is how it is scrolled, and how pages are reordered.
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      const idx = parseInt(el.dataset.pageIdx);
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault?.();
        e.stopPropagation?.();
        this._showPageMenu(idx, e);
      });
      // Without this the whole thing is pointer-only, and the README's claim
      // that the panel can be driven from the keyboard stops being true. Same
      // keys as the button faces. A thumb is a tab stop only while its page is
      // not the open one, so the page you are on is marked by stepping to
      // another page first -- every page is still reachable.
      el.addEventListener("keydown", (e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        const r = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
        this._showPageMenu(idx, {
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        });
      });
      let timer = null;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      el.addEventListener("touchstart", (e) => {
        cancel();
        // A new gesture starts: anything the last one left behind is stale.
        armSuppress(el, false);
        const touch = e.touches && e.touches[0];
        const x = touch ? touch.clientX : 0;
        const y = touch ? touch.clientY : 0;
        timer = setTimeout(() => {
          timer = null;
          // The click handler above switches pages; without this the menu
          // would open on a page the user is no longer looking at.
          armSuppress(el, true);
          this._showPageMenu(idx, { clientX: x, clientY: y });
        }, 500);
      }, { passive: true });
      for (const type of ["touchend", "touchmove", "touchcancel"]) {
        el.addEventListener(type, cancel, { passive: true });
      }
    });

    this.shadowRoot.querySelector(".page-add-btn")?.addEventListener("click", () => this._addPage());

    this.shadowRoot.querySelectorAll(".page-thumb-del").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._deletePage(parseInt(el.dataset.pageIdx));
      });
    });

    this._wirePageReorder();

    this._refreshSVG();

    // After the faces exist: the link starts at a shape `_refreshSVG` draws.
    this._wireGotoLinks();

    // Config panel wiring
    if (this._selectedButtonIdx >= 0) {
      const selBtn = bp.buttons[this._selectedButtonIdx];
      this._wireButtonConfigPanel(bp, selBtn);
    } else {
      this._wirePageSettingsPanel(bp);
    }
  },

  /**
   * Where a dragged page would land, as an index into the reordered list.
   *
   * Measured against the thumbs' midpoints rather than asking which thumb is
   * under the pointer. "Which thumb" cannot answer the only question a reorder
   * asks -- before it or after it -- which is why the old blue tint on the
   * hovered thumb told the user nothing they could act on.
   *
   * Reading rects instead of elements is also what makes the slot *after the
   * last page* addressable. There is no element there to hover, so the old
   * handler could only ever drop onto the final thumb and let splice decide.
   *
   * `rects` is in page order and excludes the add button, which shares the
   * strip but is not a page. Returns an index in the list as it will be once
   * the move is applied, which is what `_reorderPage` takes.
   */

  _wirePageSettingsPanel(bp) {
    // --- Title image wiring ---
    //
    // The same media field as the button image and the tooltip: one text box
    // that saves on Enter or blur. The value is stored as typed — "Kitchen"
    // stays "Kitchen", because the device draws anything that is not a media
    // source as text, and a `text:` the user never typed must not appear in
    // the box the next time it opens.
    const normalizeTitle = (raw) => (raw || "").trim();

    const saveTitle = async (raw) => {
      const page = this._pages[this._currentPageIdx];
      if (!page) return;
      const newImgTitle = normalizeTitle(raw);
      if (newImgTitle === (page.image || "")) return;
      const updateMsg = {
        type: "lizaip_config/update_page", entry_id: this._currentEntry,
        page_id: page.id, image: newImgTitle,
      };
      try {
        const result = await this._hass.callWS(updateMsg);
        if (result?.pages) this._pages = result.pages;
      } catch (e) {
        page.image = newImgTitle;
      }
      this._render();
    };

    // The stored title verbatim, whatever shape it has, so it can be copied
    // out and pasted into another field as is.
    const titlePage = this._pages[this._currentPageIdx];
    this._mountIconPicker(
      this.shadowRoot.querySelector("#ps-icon-picker-slot"),
      titlePage?.image || "",
      (picked) => saveTitle(picked),
      this._pageDeviceOption(titlePage),
    );

    this.shadowRoot.querySelector("#psTemplateTarget")?.addEventListener("click", () => {
      const page = this._pages[this._currentPageIdx];
      if (page?.template?.type || page?.template?.target?.device) this._changeTemplateTarget(page);
    });

    // --- Color picker wiring ---
    const colorInput = this.shadowRoot.querySelector("#psColorInput");
    const colorClear = this.shadowRoot.querySelector("#psColorClear");

    const saveColor = async (hexVal) => {
      const page = this._pages[this._currentPageIdx];
      // Strip # and normalize to uppercase 6-char hex
      const clean = (hexVal || "").replace(/^#/, "").toUpperCase().slice(0, 6);
      const changed = clean !== (page.default_color || "");
      if (!changed) return;
      const updateMsg = { type: "lizaip_config/update_page", entry_id: this._currentEntry, page_id: page.id, default_color: clean };
      try {
        const result = await this._hass.callWS(updateMsg);
        if (result?.pages) this._pages = result.pages;
      } catch (e) {
        page.default_color = clean;
      }
      this._render();
    };

    this.shadowRoot.querySelectorAll(".ps-color-dot").forEach(dot => {
      dot.addEventListener("click", () => {
        const page = this._pages[this._currentPageIdx];
        const clicked = (dot.dataset.color || "").replace(/^#/, "").toUpperCase();
        const selected = (page?.default_color || "").replace(/^#/, "").toUpperCase();
        // Clicking the active swatch toggles back to "follow theme" (default).
        saveColor(clicked && clicked === selected ? "" : clicked);
      });
    });
    const colorNative = this.shadowRoot.querySelector("#psColorNative");
    if (colorNative) {
      colorNative.addEventListener("input", () => saveColor(colorNative.value));
    }
    if (colorInput) {
      colorInput.addEventListener("change", () => {
        let val = colorInput.value.trim();
        if (val && !val.startsWith("#")) val = "#" + val;
        const hex = val.replace(/^#/, "");
        // Empty is not an error: it is how the page goes back to following the
        // theme, and the clear button does exactly the same thing.
        if (!hex) { this._clearFieldError(colorInput); saveColor(""); return; }
        if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
          // The text stays in the field. Re-rendering it away would destroy
          // the evidence along with the mistake, and a correction is usually
          // one character.
          this._setFieldError(colorInput, this._t("invalid_hex"));
          return;
        }
        this._clearFieldError(colorInput);
        saveColor(val);
      });
    }
    if (colorClear) {
      colorClear.addEventListener("click", () => saveColor(""));
    }

    this.shadowRoot.querySelector(".ps-move-up")?.addEventListener("click", () => {
      this._reorderPage(this._currentPageIdx, this._currentPageIdx - 1);
    });
    this.shadowRoot.querySelector(".ps-move-down")?.addEventListener("click", () => {
      this._reorderPage(this._currentPageIdx, this._currentPageIdx + 1);
    });

    this.shadowRoot.querySelector(".ps-unassign-all")?.addEventListener("click", () => {
      if (!confirm(this._t("unassign_all_confirm"))) return;
      const allBtns = bp.buttons.filter(b => b.key !== "slider_horizontal");
      for (const b of allBtns) delete this._assignments[b.key];
      // The context button was among those just deleted, so the selection it
      // named no longer exists. Nested overrides went with their grid buttons,
      // which is what "unassign all" means here.
      this._revalidateContext();
      this._scheduleAutoSave();
      this._editorEl = null;
      this._sequence = [];
      this._render();
    });

    this.shadowRoot.querySelector(".ps-delete-page")?.addEventListener("click", () => this._deletePage(this._currentPageIdx));
  },

  /**
   * "Key repeat": the button's action runs again for every auto-repeat
   * the remote sends while it stays pressed -- a TV's cursor keys, a volume
   * rocker. Only for a button that has an action of its own: a context
   * override is not where a fixed button's press is decided, and a slider has
   * no press.
   */
  _htmlRepeatSwitch(selBtn, selAssign, editingOverride) {
    if (editingOverride || !selAssign.config?.length) return "";
    if (selBtn.key === "slider_horizontal" || selBtn.key === SLIDER_VERTICAL_KEY) return "";
    const id = "liza-button-repeat";
    return `
          <div class="settings-switch-row button-repeat-row">
            <div class="settings-switch-text">
              <label id="${id}-label" for="${id}">${this._esc(this._t("button_repeat"))}</label>
              <span class="config-field-hint" id="${id}-hint">${this._esc(this._t("button_repeat_hint"))}</span>
            </div>
            <ha-switch id="${id}" class="button-repeat-switch" ${selAssign.repeat === true ? "checked" : ""}
                       aria-labelledby="${id}-label" aria-describedby="${id}-hint"></ha-switch>
          </div>`;
  },

  _wireButtonConfigPanel(bp, selBtn) {
    // Seed the change test with what this card was *just built from*. Without
    // this it would carry the previously selected button's entity, and the
    // sections would silently fail to appear whenever the new button ended up
    // pointing at that same entity — the card was rendered while it was still
    // empty, so "unchanged" would be true of the entity and false of the DOM.
    this._lastSectionsEntity = this._entityOfSelectedButton();

    Promise.resolve(this._mountEditor("button-editor-container"))
      .then(() => this._mountLongtouchEditor?.("button-longtouch-editor-container"));

    // A flag, stored only when on: absence keeps meaning "runs once".
    this.shadowRoot.querySelector(".button-repeat-switch")?.addEventListener("change", (e) => {
      const assign = this._editAssignEnsure(selBtn.key);
      if (e.target.checked) assign.repeat = true;
      else delete assign.repeat;
      this._scheduleAutoSave();
    });

    // Tooltip input -- the same field as the Image above it, committed the
    // same way: on Enter or on leaving the field, never per keystroke, so a
    // half-typed name is not drawn on the remote. Escape puts it back.
    const labelInput = this.shadowRoot.querySelector(".config-label-input");
    if (labelInput && !labelInput.disabled) {
      const commit = (typed) => {
        const appr = this._sliderAppearanceTarget(selBtn.key);
        if (appr?.scoped) {
          const rec = this._assignments[appr.key] || (this._assignments[appr.key] = {});
          // Empty is the inherit spelling, as with every other slider axis on a
          // grid button: storing "" would pin a blank label over the control's
          // own name.
          if (typed) rec[appr.nameKey] = typed;
          else delete rec[appr.nameKey];
          this._scheduleAutoSave();
          this._refreshSVG();
          this._render();
          return;
        }
        const assign = this._editAssignEnsure(selBtn.key);
        // `typed` arrives trimmed: the box's surrounding whitespace is not part
        // of any name, and storing it left the field re-rendering as the
        // derived label with the stray spaces still on the end.
        assign.label = typed;
        // The field holds the stored text, so its value is exactly what the
        // remote should print. `label_edited` is what makes the ladders print it
        // verbatim; `_labelEdited` is the session-only twin the render path uses
        // and `_saveAssignments` strips.
        //
        // Emptying the field is the exception: it names nothing, so it asks for
        // the derived label back rather than claiming a blank one, and releases
        // the claim the way ↺ does.
        if (typed) assign.label_edited = true;
        else delete assign.label_edited;
        assign._labelEdited = true;
        this._scheduleAutoSave();
        this._render();
      };
      this._wireMediaInput(
        labelInput,
        labelInput.parentElement?.querySelector?.(".liza-media-suggest") || null,
        commit,
        {
          ...this._pageDeviceOption(),
          ...this._labelTokenOptions(
            this._editAssign(selBtn.key)?.config,
            this._actions.find(a => a.id === this._editAssign(selBtn.key)?.action_id)?.service || "",
          ),
        },
      );
    }
    this.shadowRoot.querySelector(".config-label-reset")?.addEventListener("click", () => {
      const assign = this._editAssign(selBtn.key);
      if (!assign) return;
      const action = assign.action_id ? this._actions.find(a => a.id === assign.action_id) : null;
      const entity = assign.config ? this._getTargetEntityFromConfig(assign.config) : null;
      assign.label = this._computeLabel(action, entity, assign.config) || "";
      delete assign._labelEdited;
      // Reset hands the label back to the ladders, which is the way back to a
      // live, derived label after an edit froze one. Leaving the flag
      // set would pin the derived text as if it had been typed.
      delete assign.label_edited;
      this._scheduleAutoSave();
      this._render();
    });

    // --- Slider config UI event handlers ---
    // Gated on the same predicate that renders the card, so the two cannot
    // drift. It was gated on the presence of the Behavior chip row, which was
    // load-bearing by accident: removing that row would have silently unwired
    // every handler below it — entity picker, control select, sensitivity, icon
    // and label — leaving a card that renders correctly and responds to nothing.
    if (isSliderBtn(selBtn.key)) {
      // Which record this card's fields belong to. The card renders one body, so
      // the wiring branches once, here, instead of every handler asking.
      //
      // The page slot deliberately, not the edit slot: the slider subject,
      // The control name and `slider_factor` belong to the grid button
      // itself, not overrides, so routing them through `_editAssign` would bury
      // them in `overrides` where nothing reads them.
      const ctxKey = (selBtn.key === SLIDER_VERTICAL_KEY && this._liveContextKey())
        ? this._liveContextKey() : null;
      const ctxAssign = () => ctxKey
        ? (this._assignments[ctxKey] || (this._assignments[ctxKey] = {}))
        : null;
      const pageFactor = (() => {
        const raw = this._assignments[SLIDER_VERTICAL_KEY]?.slider_actions?.factor;
        return typeof raw === "number" && isFinite(raw) ? raw : 1.0;
      })();

      // Creates the mechanics blob on the first real edit, and stamps the mode
      // that the Behavior row used to stamp. Without it a fresh slider would be
      // written with fields but no `mode`, and every gate that requires one
      // (isConfigured, _isButtonAssigned, store._is_empty_button, the WS
      // _sanitize_slider_actions) would drop it on save — the card would accept
      // an entity and lose it. `factor` is defaulted here for the same reason:
      // the Sensitivity field renders 1.0 whether or not it is stored, so
      // leaving it unset would show a value the config does not contain.
      const ensureSliderActions = () => {
        const assign = this._editAssignEnsure(selBtn.key);
        if (!assign.slider_actions) assign.slider_actions = {};
        const sa = assign.slider_actions;
        if (sa.mode !== "proportional") sa.mode = "proportional";
        if (sa.factor == null) sa.factor = 1.0;
        return sa;
      };

      // A last-touched slider resolves its mechanics from the touched device at
      // gesture time, so the stored ones are not merely unused — leaving them
      // would let the backend read a stale target_entity and pin the slider to
      // it forever. The save path drops them too; dropping them here as well
      // keeps the in-memory config honest about what runs.
      const stripSliderMechanics = (sa) => {
        delete sa.target_entity;
        delete sa.attribute;
        delete sa.service;
        delete sa.data_key;
        delete sa.min;
        delete sa.max;
      };

      // The one writer for the Entity field, so the target and the field can
      // never disagree about whether a default exists.
      //
      // Every path through it writes a *whole* control set or none at all: the
      // old mechanics are stripped first and the new ones derived together from
      // the entity's live state. Updating them in place would let a lamp's
      // 0-255 range survive onto a speaker — the bug `_resolve_selection_config`
      // is written to make unreachable, which the panel must not reintroduce by
      // handing storage a half-written blob in the first place.
      const setSliderDefault = (sa, entityId) => {
        const id = (entityId || "").trim();
        const st = id ? this._hass?.states?.[id] : null;
        const available = id ? controlsForEntity(this._sliderControls, id, st) : [];
        // Keep the control the slider already expressed if the new entity still
        // supports it: a hand-picked colour temperature must not snap back to
        // brightness just because the lamp changed. Read before the strip.
        const previous = matchControl(this._sliderControls, sa);
        const control = previous && available.includes(previous) ? previous : available[0];

        // An explicit pin is hand-written and unspellable here, so re-picking
        // its entity must not quietly convert it to a following slider — that
        // would make the escape hatch destroyable by the one edit its own card
        // still offers.
        const pinned = sa.target === SLIDER_TARGET_ENTITY;

        stripSliderMechanics(sa);
        if (!control) {
          // Empty field, or an entity with nothing a slider can drive. Either
          // way there is no default — and no half of one.
          if (pinned) sa.target = SLIDER_TARGET_ENTITY;
          else delete sa.target;
          return;
        }
        sa.target_entity = id;
        applyControl(sa, control, st);
        // Following is the absence of `target`; only a pin is ever stored.
        if (!pinned) delete sa.target;
      };


      // One entity field, one writer. It had a second: the pinned card wrote
      // `target_entity` directly and re-derived the mechanics *only when the
      // domain changed*, on the theory that within a domain the user's choices
      // should survive. That is a field-by-field author — it leaves the old
      // range in place beside a new entity — and it is the whole-set bug
      // waiting for a lamp and a lamp of a different range. `setSliderDefault`
      // derives the set together or writes none of it, which makes the
      // preserve-the-user's-control intent explicit instead of accidental.
      // Choosing a device is what opts a grid button in, so one writer owns the
      // whole slider block -- subject and control together. Named, because the
      // "use <device>" shortcut in the hint writes exactly the same thing and
      // the two must not drift.
      const applyCtxEntity = (raw) => {
        const assign = ctxAssign();
        if (!assign) return;
        const chosen = typeof raw === "string" ? raw.trim() : "";
        // The whole axis, in one writer. Naming a device opts the button in;
        // clearing the field opts it out.
        // A control is a capability of the entity, so it cannot outlive a
        // change of device -- kept, it would ask a speaker for colour
        // temperature. Dropping the subject drops the block entire, so the
        // control goes with it either way.
        setSliderSubject(assign, chosen || null);
        setSliderControl(assign, "");
        this._scheduleAutoSave();
        this._render();
      };

      const entityContainer = this.shadowRoot.querySelector(".slider-entity-picker-container");
      if (entityContainer) {
        if (ctxKey) {
          // What the user chose, and nothing else. Falling back to the device
          // derived from the button's own action filled the field on a page
          // nobody had configured -- opening the card looked like reading back a
          // setting that had never been made. The derived device is offered as a
          // link in the hint instead: one click, but it has to be asked for.
          const cur = sliderSubjectEntity(ctxAssign()) || "";
          this._mountEntityPicker(entityContainer, cur, applyCtxEntity);
        } else {
          const sa0 = this._editAssign(selBtn.key)?.slider_actions || {};
          this._mountEntityPicker(entityContainer, sa0.target_entity || "", (next) => {
            setSliderDefault(ensureSliderActions(), next);
            this._scheduleAutoSave();
            this._render();
          });
        }
      }

      // The suggestion fills the field in rather than being a second way to say
      // the same thing, so it goes through the picker's writer. A handler of its
      // own here is how the two would come to disagree about what "chosen"
      // writes.
      const sliderCtxUseDefault = this.shadowRoot.querySelector(".slider-ctx-use-default");
      if (sliderCtxUseDefault) {
        sliderCtxUseDefault.addEventListener("click", () => {
          applyCtxEntity(sliderCtxUseDefault.dataset.entity || "");
        });
      }

      // Picking a control writes all five mechanics at once, the way HA's
      // `light-brightness` feature does internally.
      const applyControlById = (id) => {
        const c = (this._sliderControls || []).find(x => x.id === id);
        // The only non-control option is the disabled placeholder, which
        // cannot be selected — so there is no other branch to handle.
        if (!c) return;
        const sa = ensureSliderActions();
        applyControl(sa, c, this._hass?.states?.[sa.target_entity]);
        this._scheduleAutoSave();
        this._render();
      };
      const sliderControlSelect = this.shadowRoot.querySelector(".slider-control-select");
      if (sliderControlSelect) {
        this._wireHaSelect(sliderControlSelect, () => {
          if (!ctxKey) return applyControlById(sliderControlSelect.value);
          // A control *id* on the grid button, never mechanics — there is
          // nothing here that could be written down by halves, which is what
          // keeps the whole-set rule out of this field entirely. The first
          // option is the derived choice, so choosing it DELETES the key rather
          // than storing the id it happens to show; read off the select's own
          // first option, so the rule cannot disagree with what is on screen.
          const assign = ctxAssign();
          if (!assign) return;
          const id = sliderControlSelect.value;
          const derivedId = sliderControlSelect.options[0]?.value;
          setSliderControl(assign, id && id !== derivedId ? id : "");
          this._scheduleAutoSave();
          this._render();
        });
      }

      // The way back from a hand-edit. Without it, one typo in Service made
      // matchControl fail permanently: Control fell to the disabled placeholder
      // and the only recovery was retyping the preset's five values from
      // memory. Same code path as picking the control, so they cannot drift.
      const sliderResetControl = this.shadowRoot.querySelector(".slider-reset-control");
      if (sliderResetControl) {
        sliderResetControl.addEventListener("click", () => applyControlById(sliderResetControl.dataset.control));
      }

      // The Advanced mechanics fields all do the same thing: read the input,
      // write one key, save. Table-driven so they cannot drift apart — as six
      // hand-written copies they already had, on whether they re-render.
      //
      // `render` is deliberately not uniform. attribute/service/data_key feed
      // matchControl, so editing one changes the Control field above them;
      // min/max feed the hint and the range warning. Sensitivity affects
      // nothing currently on screen, so re-rendering would only fight the
      // caret for no visible gain.
      // Every parse falls back to the *current stored value*, so no field can be
      // emptied into a hole. That is not merely tidy. Clearing Min/Max would
      // otherwise rewrite a 0-255 brightness range to the media_player-shaped
      // 0-1 and collapse the drag — and clearing Service was worse: the key was
      // dropped on save (the sanitiser omits empty strings on purpose, so that
      // `data_key` can default to `attribute`), and the executor's own fallback
      // is a hard-coded `media_player.volume_set`, which it then fired at a
      // lamp with `brightness: 255`. Clearing Attribute killed the slider
      // outright, silently.
      //
      // These are the mechanics the whole-set rule governs: they only mean
      // anything together, and the fallback branch of `_resolve_selection_config`
      // hands this blob back verbatim as a *complete* control. A field that can
      // be blanked is a way to author the partial that rule exists to prevent,
      // so the way to clear one is to pick a different Control, which rewrites
      // them as a set.
      const SLIDER_FIELDS = [
        [".slider-attribute-input", "attribute", (v, cur) => v.trim() || cur, true],
        [".slider-service-input",   "service",   (v, cur) => v.trim() || cur, true],
        [".slider-datakey-input",   "data_key",  (v, cur) => v.trim() || cur, true],
        [".slider-factor-input",    "factor",    (v, cur) => num(v, num(cur, 1.0)), false],
        [".slider-min-input",       "min",       (v, cur) => num(v, num(cur, 0)),   true],
        [".slider-max-input",       "max",       (v, cur) => num(v, num(cur, 1)),   true],
      ];
      SLIDER_FIELDS.forEach(([sel, key, parse, render]) => {
        const el = this.shadowRoot.querySelector(sel);
        if (!el) return;
        // Attribute is a select over the entity's live attributes when there
        // is one to read; a select reports a pick, a field a change.
        const listen = (fn) => (el.localName === "ha-select"
          ? this._wireHaSelect(el, fn)
          : el.addEventListener("change", fn));
        listen(() => {
          // Sensitivity is the one field of this set that can belong to a
          // selected button: the executor carries `factor` across a retarget
          // untouched, so a per-button value is something it can act on. The
          // rest are re-derived from the live entity on every gesture, which is
          // why they are not on the card at all under a selection.
          if (ctxKey && key === "factor") {
            const assign = ctxAssign();
            if (!assign) return;
            const next = parseFloat(el.value);
            // Not clamped -- that would save a number nobody typed -- but no
            // longer silent either: the value used to be re-rendered away.
            if (!isFinite(next)) {
              this._setFieldError(el, this._t("invalid_number"));
              return;
            }
            if (next < FACTOR_MIN || next > FACTOR_MAX) {
              this._setFieldError(el, this._t("invalid_range", { min: FACTOR_MIN, max: FACTOR_MAX }));
              return;
            }
            this._clearFieldError(el);
            // Written only when it differs from the page's. The field is
            // pre-filled with the inherited value, so "no change" is by far the
            // commonest way to leave it, and tabbing through must not
            // manufacture an override.
            if (next === pageFactor) delete assign.slider_factor;
            else assign.slider_factor = next;
            this._scheduleAutoSave();
            this._render();
            return;
          }
          const sa = ensureSliderActions();
          // A browser blanks `.value` when a number field holds text it cannot
          // parse, so the rejected text has to be detected through validity.
          if (badNumber(el)) {
            this._setFieldError(el, this._t("invalid_number"));
            return;
          }
          const raw = el.value.trim();
          if (key === "factor" && raw) {
            const n = Number(raw);
            if (n < FACTOR_MIN || n > FACTOR_MAX) {
              this._setFieldError(el, this._t("invalid_range", { min: FACTOR_MIN, max: FACTOR_MAX }));
              return;
            }
          }
          // An inverted range is the one error here that needs both fields to
          // spot, and it is silently destructive: a slider whose maximum sits
          // below its minimum has no usable travel at all.
          if (key === "min" || key === "max") {
            const minEl = this.shadowRoot.querySelector(".slider-min-input");
            const maxEl = this.shadowRoot.querySelector(".slider-max-input");
            // Judged as a pair, so unparsable text in a sibling is dangerous:
            // the browser blanks `.value`, `num(...)` substitutes the stored
            // number, and the clears below then withdraw an error whose text
            // is still wrong. 3.3.1 wants it reported until it is fixed.
            const stillBad = badNumber(minEl) ? minEl : badNumber(maxEl) ? maxEl : null;
            if (stillBad) {
              this._setFieldError(stillBad, this._t("invalid_number"));
              return;
            }
            const lo = num(minEl?.value, num(sa.min, 0));
            const hi = num(maxEl?.value, num(sa.max, 1));
            if (Number.isFinite(lo) && Number.isFinite(hi) && hi <= lo) {
              this._setFieldError(el, this._t("invalid_min_max"));
              return;
            }
            this._clearFieldError(minEl);
            this._clearFieldError(maxEl);
          }
          this._clearFieldError(el);
          sa[key] = parse(el.value, sa[key]);
          this._scheduleAutoSave();
          if (render) this._render();
        });
      });

      const sliderFactorReset = this.shadowRoot.querySelector(".slider-factor-reset");
      if (sliderFactorReset) {
        sliderFactorReset.addEventListener("click", () => {
          const assign = ctxAssign();
          if (!assign) return;
          delete assign.slider_factor;
          this._scheduleAutoSave();
          this._render();
        });
      }
    }


    this._wireButtonEntitySections(bp, selBtn);

    // "Page default": drop the context but keep the same button selected, so
    // the card switches from the override to the default in place. Today's
    // behaviour stays reachable without deselecting the grid button, which is
    // the other half of the accidental-override mitigation.
    this.shadowRoot.querySelector(".ctx-page-default")?.addEventListener("click", () => {
      this._flushAutoSave();
      this._contextKey = null;
      const assign = this._editAssign(selBtn.key);
      this._sequence = this._cycleSequence(assign, selBtn.key);
      this._editorEl = null;
      this._render();
    });
  },

  // The button's entity lives inside the action editor, so it changes without
  // anything on the card being touched. `_onSequenceChanged` cannot answer that
  // with `_render()`: `_renderDeviceConfig` replaces the whole shadow root and
  // `_mountEditor` then clears its container and constructs a *new*
  // `ha-automation-action` — asynchronously, behind `_loadHaComponents()`. The
  // editor would collapse and lose focus on every change event, which is why
  // the original only refreshed the SVG and why the entity-derived sections
  // never appeared until the button was reselected.
  //
  // So rebuild only that subtree. The HTML comes from `_htmlButtonConfigPanel`
  // itself rather than a second builder: every gate those sections have —
  // `pageSliderFollows`, `isSliderBtn`, an empty `available`, `showImage`,
  // `actionStates.length` — is therefore evaluated by the same code that
  // evaluates it on a full render, and cannot drift into resurrecting a section
  // that should stay hidden. The rest of the produced markup is discarded; it
  // is string building, and the editor in it is never mounted.
  // A mixin method, not a closure. It was a `const` inside
  // `_wireButtonConfigPanel`, which was fine while the page-level Entity field
  // was its only caller -- and a blank panel the moment the context card
  // wanted one too, because `_wireButtonEntitySections` is a different method
  // and the name simply was not in scope there. A ReferenceError during wiring
  // takes the whole view down, so this is promoted rather than copied: two
  // pickers that drift on domain filtering or the hass-not-ready fallback
  // would be the same bug in slow motion.
  // HA's native entity picker (search, icons, state, area) — same pattern
  // as the template dialog. Free text made it trivial to type a typo that
  // only surfaced at runtime.
  //
  // Kept as a named unit rather than inlined into its one caller: it owns
  // the domain filtering and the hass-not-ready degradation, neither of
  // which is about the field it happens to be mounted in.

  _mountEntityPicker(container, value, onChange, opts = {}) {
    // The field's name. A label outside a shadow root cannot name the control
    // inside it, so it goes on the picker, which renders it itself.
    const entityLabel = opts.label || this._t("entity");
    if (this._hass) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      // Only domains a slider can actually drive. Unfiltered, the picker
      // offered sensor.*, automation.* and friends — none of which have a
      // readable attribute plus a matching *_set service — and choosing one
      // landed on "No presets for sensor", a dead end dressed as guidance.
      // Filtering makes that state unreachable instead of merely explained.
      // Callers that drive something other than a slider say so; the slider
      // filter is this helper's default, not a fact about every entity field.
      const doms = opts.includeDomains !== undefined
        ? opts.includeDomains : sliderDomains(this._sliderControls);
      if (doms) picker.includeDomains = doms;
      picker.label = entityLabel;
      picker.allowCustomEntity = true;
      picker.value = value;
      container.appendChild(picker);
      picker.addEventListener("value-changed", (ev) => onChange(ev.detail.value || ""));
      return;
    }
    // hass not ready yet — degrade to text rather than an empty box.
    // Distinct class: reusing .slider-service-input would collide with the
    // Service field below, and since this container renders first,
    // querySelector would bind the Service handler to this input. The card no
    // longer draws a label for this field -- the picker names itself -- so the
    // fallback has to carry the name too, or it is an unlabelled text box.
    container.innerHTML =
      `<ha-input appearance="outlined" class="slider-entity-fallback" label="${this._esc(entityLabel)}" value="${this._esc(value)}" placeholder="light.living_room" autocomplete="off"></ha-input>`;
    const fallback = container.querySelector(".slider-entity-fallback");
    fallback.addEventListener("change", () => onChange(String(fallback.value ?? "").trim()));
  },

  /**
   * The tile's own menu: move this button's configuration elsewhere, or clear
   * it. Opened by right-click, or by long-press on a touch screen.
   *
   * Until now the only route to either was the card — the ✕ in its header, an
   * anonymous glyph on a card the user has to open first, which meant clearing
   * a button was discoverable only by having already found it. This puts both
   * actions on the thing they act on, with words on them rather than symbols.
   *
   * It does neither itself. Clear selects the button and runs
   * `_unassignButton`, which is what the ✕ used to run — so the override
   * rules, which depend on what is in context at the moment of the clear,
   * apply here unchanged. Move only *arms* the move; the second gesture picks
   * the destination, and `_moveButtonTo` owns what that means.
   *
   * Offered only where there is something to act on: an empty tile gets no
   * menu at all rather than a menu with two dead items in it.
   */
  /**
   * Is there a configuration here a move could pick up? The one predicate
   * behind both routes to a move, so the menu item and the drag cannot
   * disagree. The title bar is not a button and has no assignment.
   */
};
