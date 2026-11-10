/**
 * lizaIP Panel — Buttons View: Context menus, and the rules about which button may be dragged onto which.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  OVERRIDABLE_FIXED_BUTTONS,
} from "./shared.js";
import { isMovableSlot } from "../lizaip-helpers.js";

export const ButtonsMenusMixin = {
  _canMoveButton(key) {
    if (!isMovableSlot(key)) return false;
    return this._isAssignedRecord(this._editAssign(key) || {});
  },

  /**
   * Could a move from `fromKey` land on `toKey`? The drag asks this per slot
   * to keep the ring honest: `_moveButtonTo` refuses ends that resolve to
   * different containers, and a ring that promised otherwise would lie.
   */

  _canDropButtonOn(fromKey, toKey) {
    if (!isMovableSlot(toKey)) return false;
    // Mirrors `_editContainer`'s branching without its `create`, so merely
    // hovering a fixed button cannot leave an override table behind.
    const contextKey = this._liveContextKey();
    if (!contextKey) return true;
    const scoped = OVERRIDABLE_FIXED_BUTTONS.has(toKey);
    if (scoped !== OVERRIDABLE_FIXED_BUTTONS.has(fromKey)) return false;
    return !scoped || !!this._assignments?.[contextKey];
  },

  _showFaceMenu(btn, ev) {
    this._closeFaceMenu();
    if (!this._canMoveButton(btn?.key)) return;
    const root = this.shadowRoot;
    if (!root) return;
    // Where focus came from, so closing can put it back. Captured after the
    // _closeFaceMenu() above, which clears any stale token, and before the
    // menu takes focus below. Null when nothing focusable was active -- a
    // pointer user who never focused the tile -- and restoring null is a
    // no-op, which is the right answer for them.
    // The ellipsis is doing work: this item finishes nothing, it asks for a
    // second gesture, and an item that looks like it acts on click is how a
    // user ends up clicking it twice.
    this._openMenu(ev, [
      // First, as the thing this menu adds; only while the feature is on, for
      // a button whose long touch is free and whose device an options
      // template fits.
      ...(this._canAddOptions(this._assignments?.[btn.key]) ? [{
        cls: "face-menu-add-options",
        label: this._t("add_options"),
        run: () => this._addButtonOptions(btn.key),
      }] : []),
      {
        cls: "face-menu-move",
        label: `${this._commonLabel("move", "Move")}…`,
        run: () => this._beginMove(btn.key),
      },
      {
        cls: "face-menu-delete",
        label: this._commonLabel("delete", "Delete"),
        run: () => {
          // `_selectButton` toggles: called on the button that is already open
          // it *deselects*, and the clear that follows would then find nothing
          // selected and do nothing at all. That is the common case, because
          // the tile you long-press is usually the one you just tapped.
          const idx = this._faceIdxFor(btn.key);
          if (idx >= 0 && this._selectedButtonIdx !== idx) this._selectButton(idx);
          this._unassignButton();
        },
      },
    ]);
  },

  /** The page strip's context menu: turn a page into a subpage, or back.
   *
   * A subpage is still a page -- it keeps its buttons, it is still reachable
   * from a Go to page action -- it just stops being offered in the remote's own
   * list of pages. That list is what the user pages through on the device, and
   * a page that only ever makes sense as the destination of a button does not
   * belong in it.
   *
   * It stays in this strip either way, tinted, because this is the editor: a
   * subpage that vanished from here could never be turned back.
   */

  _showPageMenu(idx, ev) {
    const page = this._pages?.[idx];
    if (!page) return;
    const isSub = !!page.subpage;
    // The page's kind and its device first; the separator then sets apart
    // what makes or removes a page, the destructive one last. An ellipsis
    // only where the item asks for a choice before acting; a confirmation
    // does not count.
    this._openMenu(ev, [{
      cls: "face-menu-subpage",
      label: isSub ? this._t("make_mainpage") : this._t("make_subpage"),
      run: () => this._setPageSubpage(page, !isSub),
    },
    // A page with a device -- made from a template, or given one -- offers to
    // change it; a page without one offers to assign one.
    page.template?.type || page.template?.target?.device ? {
      cls: "face-menu-retarget",
      label: this._t(page.template.target?.config_entry ? "change_hub" : "change_device"),
      run: () => this._changeTemplateTarget(page),
    } : {
      cls: "face-menu-assign-device",
      label: this._t("assign_device"),
      run: () => this._assignPageDevice(page),
    },
    { separator: true }, {
      cls: "face-menu-duplicate",
      label: this._t("duplicate_page"),
      run: () => this._duplicatePage(page),
    }, {
      cls: "face-menu-delete-page",
      // Home Assistant's own word, as the button menu's Delete uses; the
      // menu is already about the page.
      label: this._commonLabel("delete", "Delete"),
      // Looked up when chosen, not when opened: the list can be replaced in
      // between, and a stale index would delete a neighbour.
      run: () => {
        const at = this._pages.findIndex(p => p.id === page.id);
        if (at >= 0) this._deletePage(at);
      },
    }]);
  },

  /**
   * The hint under a page's title field. A template page learns about
   * `${_device}`; what any variable reads now is said as on every picture field.
   */

  _pageTitleHint(page, raw) {
    const usesDevice = /\$\{[^{}]*(?<![\w.])_device\b/.test(raw || "");
    const parts = [];
    if (usesDevice || this._hasEntityToken(raw)) {
      const now = this._resolvedPageTitle(page);
      if (now) parts.push(this._t("label_now_reads", { text: this._esc(now) }));
    }
    if (page?.template?.type || page?.template?.target?.device) parts.push(this._t("title_device_hint"));
    // `${_device.attr}` reads like an entity variable but is explained above.
    if (this._hasEntityToken((raw || "").replace(/\$\{\s*_device\.\w+\s*\}/g, ""))) {
      parts.push(this._t("variable_hint"));
    }
    return parts.join(" ");
  },

  /** What a template page's device or hub is called, for the page card.
   *
   * A device is named from `hass.devices` the way HA names it (the user's
   * rename first); a hub is a config entry, whose title the frontend does not
   * carry, so it is asked for once and the card redrawn when it arrives.
   */

  _templateTargetName(page) {
    const target = page?.template?.target || {};
    const name = this._templateDeviceName(page);
    if (name) return name;
    if (target.config_entry && this._templateEntryTitles?.[target.config_entry] === null) return "…";
    return target.entity_id || this._t("template_target_missing");
  },

  /** Ask for the new device of a template page and move the page to it.
   *
   * The same dialog that picked the device when the page was added, so the
   * same devices are on offer and the same ones are refused.
   */
  async _changeTemplateTarget(page) {
    // A page no template made was given its device here, and is moved here.
    if (!page.template?.type) return this._assignPageDevice(page);
    const templateId = page.template.type;
    const meta = (await this._loadTemplates()).find(l => l.id === templateId);
    if (!meta) {
      this._toast(this._t("template_gone", { name: templateId }));
      return;
    }
    const hub = !!meta.target_selector?.config_entry;
    const confirmLabel = this._t(hub ? "change_hub_confirm" : "change_device_confirm");
    try {
      await this._showTemplateEntityPicker(templateId, meta, {
        confirmLabel,
        busyLabel: this._t("changing"),
        onConfirm: async (target, kind) => {
          const result = await this._retargetTemplatePage(page, target, kind);
          return this._t(hub ? "hub_changed" : "device_changed", {
            name: this._pageDisplayLine(page),
            n: result?.buttons_changed ?? 0,
          });
        },
      });
    } catch (e) {
      console.warn("[lizaIP] Change device failed:", e);
      this._toast(this._t("template_picker_failed"));
    }
  },

  /** Whether a button's long touch is free for an options page.
   *
   * Free when it has none, and also when all it does is open a page that no
   * longer exists -- what is left of an options page that was deleted. The
   * remote ignores such a press, and Add options… replaces it.
   */
  _longtouchFree(assign) {
    const steps = assign?.longtouch;
    if (!Array.isArray(steps) || !steps.length) return true;
    if (steps.length !== 1) return false;
    const service = steps[0]?.action || steps[0]?.service || "";
    if (service !== "lizaip.goto_page") return false;
    const raw = steps[0]?.data?.page_id;
    const id = typeof raw === "string" ? parseInt(raw, 10) : raw;
    if (!Number.isInteger(id)) return false;
    return !(this._pages || []).some((p) => p.id === id);
  },

  /** The entity a button acts on, or "" for none. */
  _buttonEntity(assign) {
    return this._getTargetEntityFromConfig?.(assign?.config) || "";
  },

  /** Whether the menu offers Add options… for *assign*. Read from the answers
   *  `_prefetchOptionsFit` keeps, since a menu opens at once: a button not
   *  asked about yet goes without until it has been. */
  _canAddOptions(assign) {
    const entity = this._buttonEntity(assign);
    return Boolean(this._optionsFeatureEnabled?.() && entity
      && this._longtouchFree(assign) && this._optionsFit?.get(entity) === true);
  },

  /** Ask once per entity whether an options template fits it, for every
   *  button on the open page, so the menu can answer without waiting. */
  _prefetchOptionsFit() {
    if (!this._optionsFeatureEnabled?.() || !this._hass?.callWS) return;
    const known = (this._optionsFit ||= new Map());
    const wanted = [...new Set(Object.values(this._assignments || {})
      .map((a) => this._buttonEntity(a)))].filter((e) => e && !known.has(e));
    if (!wanted.length) return;
    // Marked as asked now, so a redraw while the reply is out does not ask again.
    wanted.forEach((e) => known.set(e, null));
    this._hass.callWS({ type: "lizaip_config/options_fit", entity_ids: wanted })
      .then((r) => wanted.forEach((e) => known.set(e, r?.fits?.[e] === true)))
      .catch((e) => {
        console.debug("[lizaIP] options_fit:", e);
        wanted.forEach((x) => known.set(x, false));
      });
  },

  /** Give a button an options page: a new subpage its long touch opens.
   *
   * The page is made from an options template the button's own device
   * answers. It sits right after the page the button is on, which stays open:
   * the link arrow shows where the long touch now goes.
   */
  async _addButtonOptions(key) {
    await this._flushAutoSave();
    const source = this._pages[this._currentPageIdx];
    if (!source) return;
    const assign = this._assignments?.[key];
    await this._showAddPageDialog({
      key,
      pageId: source.id,
      name: this._buttonSpokenLabel?.(assign) || this._humaniseButtonKey?.(key) || key,
      // What the button already acts on, so a template that fits it can be
      // bound without asking which device all over again.
      entity: this._buttonEntity(assign),
    });
  },

  /** Write the subpage the walk chose, and point the long touch at it.
   *
   * `create` already carries the subpage flag, the way back and the place
   * beside the button's own page, so all that is left is the long touch.
   */
  async _addOptionsPage({ key, pageId, name }, create) {
    this._pageOpInFlight = true;
    try {
      // The map of the button's own page. Switching pages while the page is
      // being made replaces `this._assignments`, and saving that under this
      // page's id would put another page's buttons on it.
      const assignments = this._assignments;
      let result;
      try {
        result = await create();
      } catch (e) {
        console.warn("[lizaIP] Add options page failed:", e);
        this._toast(this._t("add_page_failed"));
        return null;
      }
      const created = result?.page_id;
      if (created == null || !result?.pages) return null;
      const here = this._assignments === assignments;
      // Where the strip stays: the button's page, or whichever one was
      // switched to while the page was being made.
      const open = here ? pageId : this._currentPageId;
      this._pages = result.pages;
      const at = this._pages.findIndex((p) => p.id === open);
      if (at >= 0) this._currentPageIdx = at;
      const record = assignments[key] || (assignments[key] = {});
      record.longtouch = [{ action: "lizaip.goto_page", data: { page_id: created } }];
      // The page is no longer the open one: what it is read from next must
      // hold the long touch too.
      if (!here) this._pageCache[pageId] = JSON.parse(JSON.stringify(assignments));
      // Only this page's buttons: a global save would post the action library
      // as it was read before the template wrote to it, and the backend
      // replaces that library wholesale.
      await this._saveAssignments(assignments, pageId);
      // The template wrote action-library entries and a page the strip has no
      // thumbnail for yet; both are read before the first draw.
      await this._loadActions();
      await this._loadGlobalUsage();
      this._render();
      this._toast(this._t("options_added", { name }));
      return created;
    } finally {
      this._endPageOp();
    }
  },

  /** Give a page no template made a device, or move it to another one.
   *
   * The same dialog a template page's device is picked in, offering every
   * device and proposing the one most of the page's buttons act on.
   */
  async _assignPageDevice(page) {
    const moving = !!page.template?.target?.device;
    const meta = {
      name: this._pageDisplayLine(page),
      icon: "mdi:devices",
      description: this._t("assign_device_desc"),
      target_selector: { device: {} },
    };
    try {
      await this._showTemplateEntityPicker(null, meta, {
        confirmLabel: this._t(moving ? "change_device_confirm" : "assign_device_confirm"),
        busyLabel: this._t("changing"),
        loadDevices: () => this._loadAllDevices(page.id),
        onConfirm: async (target) => {
          const result = await this._bindPageDevice(page, target);
          return this._t(moving ? "device_changed" : "device_assigned", {
            name: this._pageDisplayLine(page),
            n: result?.buttons_changed ?? 0,
          });
        },
      });
    } catch (e) {
      console.warn("[lizaIP] Assign device failed:", e);
      this._toast(this._t("template_picker_failed"));
    }
  },


  /** Copy a page, buttons and all, and open the copy.
   *
   * The backend places it directly after the original and keeps its kind: a
   * subpage's copy is a subpage, so it does not suddenly join the remote's page
   * list. Going through `_createPage` flushes a pending edit first -- the copy
   * is of what the user sees, not of what was last saved.
   */
  async _duplicatePage(page) {
    try {
      const result = await this._createPage(() => this._hass.callWS({
        type: "lizaip_config/duplicate_page",
        entry_id: this._currentEntry,
        page_id: page.id,
      }));
      // The copy looks exactly like the page it came from; without a word the
      // only sign anything happened is one more thumbnail.
      if (result?.pages) this._toast(this._t("page_duplicated", { name: this._pageDisplayLine(page) }));
    } catch (e) {
      console.error("[lizaIP] duplicate page failed:", e);
      this._toast(this._t("duplicate_page_failed", { error: e?.message || e }));
    }
  },

  /** Flip a page between main and subpage, and tell the remote.
   *
   * Written through `update_page` like the picture and the colour are, so the
   * same push to the device carries it -- there is no separate "page kind"
   * message to keep in step.
   */
  async _setPageSubpage(page, makeSub) {
    const msg = {
      type: "lizaip_config/update_page", entry_id: this._currentEntry,
      page_id: page.id, subpage: !!makeSub,
    };
    // Shown at once: the write rewrites every page file before it answers, and
    // waiting for that left the strip unchanged for a noticeable while.
    page.subpage = !!makeSub;
    this._render();
    try {
      const result = await this._hass.callWS(msg);
      // Redrawn again only if the server's list differs from what is shown --
      // a full render redraws every face, which is the cost avoided above.
      if (result?.pages && JSON.stringify(result.pages) !== JSON.stringify(this._pages)) {
        this._pages = result.pages;
        this._render();
      }
    } catch (e) {
      // Same stance as the title and colour writes: keep what the user asked
      // for on screen rather than silently snapping back, and let the next
      // load reconcile.
    }
  },

  /** Build, place and wire a context menu. Shared by the tile and page menus.
   *
   * The menu itself is the fiddly part -- it has to put focus back where it
   * found it, answer the arrow keys its `role="menu"` promises, and get out of
   * the way on the next click, resize or Escape. None of that differs between
   * the things a menu can be opened on, and a second copy of it is the kind of
   * code that drifts until only one of them restores focus.
   *
   * @param ev     The event that asked for the menu; supplies the position.
   * @param items  `{cls, label, run}` -- `cls` also names the hook the tests
   *               and the stylesheet use, so it is not decoration.
   * @param opts   `keepCase` leaves the labels as written. The tile and page
   *               menus borrow Home Assistant's lower-case verbs ("move",
   *               "clear"); the diagnostics menu names files in whole
   *               sentences, and lower-casing those reads as a typo.
   */

  _openMenu(ev, items, { keepCase = false, anchor = null } = {}) {
    this._closeFaceMenu();
    const root = this.shadowRoot;
    if (!root || !items?.length) return;
    // Where focus came from, so closing can put it back. Captured after the
    // _closeFaceMenu() above, which clears any stale token, and before the
    // menu takes focus below. Null when nothing focusable was active -- a
    // pointer user who never focused the tile -- and restoring null is a
    // no-op, which is the right answer for them.
    this._faceMenuReturn = this._a11yCaptureFocus?.() || null;

    if (globalThis.customElements?.get?.("ha-dropdown") && customElements.get("ha-dropdown-item")) {
      this._openHaMenu(ev, items, { keepCase, anchor });
      return;
    }

    const menu = document.createElement("div");
    menu.className = "face-menu";
    menu.setAttribute("role", "menu");
    // Lower-cased here rather than in the strings: "Move" and "Clear" are Home
    // Assistant's own translations, and the strings are reused outside menus.
    const lang = this._lang?.() || undefined;
    menu.innerHTML = items.map(it => it.separator
      ? `<div role="separator" class="face-menu-sep"></div>`
      // `cls` stays the one class the click wiring below looks the item up by;
      // how an item looks, and whether it can be pressed at all, rides on a
      // flag -- `danger`, `disabled` -- rather than on a second class name.
      : `<button type="button" role="menuitem" class="face-menu-item ${it.cls}`
        + `${it.danger ? " face-menu-item-danger" : ""}"${it.disabled ? " disabled" : ""}>`
        + (it.icon ? `<ha-icon icon="${it.icon}" aria-hidden="true"></ha-icon>` : "")
        + `<span>${keepCase ? String(it.label) : String(it.label).toLocaleLowerCase(lang)}</span></button>`).join("");
    // Measured rather than guessed. A fixed width allowance has to be wrong
    // in one direction or the other, and when it is too wide the menu opens a
    // hand's width from the button that asked for it.
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";
    root.appendChild(menu);
    const seps = items.filter(it => it.separator).length;
    // About 40px an item, 9 a separator, plus the frame -- the fallback for an
    // environment that reports no layout at all.
    const width = Number(menu.offsetWidth) || (keepCase ? 280 : 180);
    const height = Number(menu.offsetHeight) || ((items.length - seps) * 40 + seps * 9 + 10);

    // `position: fixed`, so viewport coordinates go straight on. An anchored
    // menu hangs off its button's right edge, which is where a ⋮ in a toolbar
    // puts it; everything else opens at the pointer.
    const rect = anchor?.getBoundingClientRect?.();
    const vw = Number(window?.innerWidth) || 0;
    const vh = Number(window?.innerHeight) || 0;
    const y = rect ? rect.bottom + 4 : Number(ev?.clientY) || 0;
    if (rect) {
      // Pinned rather than placed at the measured width: the icons are custom
      // elements and may still be empty here, so a menu grows after the
      // measurement and the toolbar's ⋮ pushed its labels off the window.
      menu.style.left = "auto";
      menu.style.right = `${Math.max(4, vw ? vw - rect.right : 0)}px`;
    } else {
      // Nudged back inside near an edge: the face sits in a scrolling column,
      // and a menu opened on the last row would otherwise extend the page.
      const x = Number(ev?.clientX) || 0;
      menu.style.right = "auto";
      menu.style.left = `${Math.max(4, vw ? Math.min(x, vw - width - 4) : x)}px`;
    }
    menu.style.top = `${Math.max(4, vh ? Math.min(y, vh - height - 4) : y)}px`;
    menu.style.visibility = "";

    const dismiss = () => this._closeFaceMenu();
    for (const it of items) {
      if (it.disabled) continue;
      menu.querySelector(`.${it.cls}`)?.addEventListener("click", () => {
        this._closeFaceMenu();
        it.run();
      });
    }
    // Anything else the user does puts it away. `once` on each, because the
    // menu is gone after the first of them and the listeners go with it.
    root.addEventListener("click", dismiss, { once: true });
    window.addEventListener?.("resize", dismiss, { once: true });
    window.addEventListener?.("keydown", this._faceMenuKey = (e) => {
      if (e.key === "Escape") { dismiss(); return; }
      // role="menu" advertises a keyboard contract -- arrows move between
      // items, Home/End jump to the ends -- and a screen reader in menu mode
      // hands those keys to the menu rather than the page. Without this the
      // roles promised navigation the markup did not implement; Tab worked
      // only because these are native buttons.
      const items = Array.from(menu.querySelectorAll(".face-menu-item:not([disabled])"));
      if (!items.length) return;
      const cur = items.indexOf(root.activeElement);
      let next;
      if (e.key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % items.length;
      else if (e.key === "ArrowUp") next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else return;
      e.preventDefault?.();
      items[next].focus?.();
    });

    this._faceMenuEl = menu;
    menu.querySelector(".face-menu-item:not([disabled])")?.focus?.();
  },

  /** The menu as Home Assistant draws one: `ha-dropdown`, which brings the
   *  look, the arrow keys, Escape and the click outside that closes it. It
   *  opens where it was asked for -- at the pointer, or under the ⋮ that
   *  asked -- by hanging off an empty element placed there. */
  _openHaMenu(ev, items, { keepCase = false, anchor = null } = {}) {
    const root = this.shadowRoot;
    const lang = this._lang?.() || undefined;
    const spot = document.createElement("span");
    spot.className = "face-menu-anchor";
    const rect = anchor?.getBoundingClientRect?.();
    const x = rect ? rect.right : Number(ev?.clientX) || 0;
    const y = rect ? rect.bottom : Number(ev?.clientY) || 0;
    spot.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;`;

    const menu = document.createElement("ha-dropdown");
    menu.className = "face-menu";
    menu.setAttribute("placement", rect ? "bottom-end" : "bottom-start");
    menu.innerHTML = items.map(it => it.separator
      ? "<wa-divider></wa-divider>"
      // `cls` is the item's value: what the choice below is looked up by, and
      // the hook the tests and the stylesheet use.
      : `<ha-dropdown-item class="face-menu-item ${it.cls}" value="${it.cls}"`
        + `${it.danger ? ' variant="danger"' : ""}${it.disabled ? " disabled" : ""}>`
        + (it.icon ? `<ha-icon slot="icon" icon="${it.icon}" aria-hidden="true"></ha-icon>` : "")
        + `${keepCase ? String(it.label) : String(it.label).toLocaleLowerCase(lang)}</ha-dropdown-item>`).join("");
    root.appendChild(spot);
    root.appendChild(menu);
    menu._lizaAnchor = spot;
    this._faceMenuEl = menu;

    menu.addEventListener("wa-select", (e) => {
      const it = items.find(i => i.cls === e.detail?.item?.value);
      this._closeFaceMenu();
      if (it && !it.disabled) it.run();
    });
    // Escape, a click outside, a choice: every way it closes ends here.
    menu.addEventListener("wa-after-hide", () => {
      if (this._faceMenuEl === menu) this._closeFaceMenu();
    });
    // Opened from the keyboard (the menu key, Shift+F10) the first item takes
    // the focus, as a menu's does.
    menu.addEventListener("wa-after-show", () => {
      menu.querySelector("ha-dropdown-item:not([disabled])")?.focus?.();
    }, { once: true });
    Promise.resolve(menu.updateComplete).then(() => {
      if (this._faceMenuEl !== menu) return;
      menu.anchorElement = spot;
      menu.open = true;
    });
  },

  /** Put the tile menu away, if one is open. Safe to call when none is. */

  _closeFaceMenu() {
    if (this._faceMenuKey) {
      window.removeEventListener?.("keydown", this._faceMenuKey);
      this._faceMenuKey = null;
    }
    const el = this._faceMenuEl;
    this._faceMenuEl = null;
    el?._lizaAnchor?.remove?.();
    if (el?.parentNode) el.parentNode.removeChild(el);
    else if (el && this.shadowRoot) this.shadowRoot.removeChild?.(el);
    // Focus was moved into the menu when it opened, so removing the node
    // leaves activeElement on <body> -- the user's next Tab starts from the
    // top of the Home Assistant frontend, with nothing on screen saying why.
    // Only when a menu was really open: _showFaceMenu calls this first thing,
    // and that call must not move focus.
    const token = this._faceMenuReturn;
    this._faceMenuReturn = null;
    if (el && token && !this._a11yRestoreFocus?.(token)) this._a11yFocusFallback?.();
  },

  /** A verb from Home Assistant's own vocabulary, in the user's language.
   *
   * `ui.common.*` is part of the core translation bundle, loaded before any
   * panel is, so borrowing from it costs nothing and makes these items read
   * the way every other menu in the frontend does — including in the four
   * languages this integration ships but whose panel has only spoken English.
   * The fallback is for a `hass` that has not arrived yet, not for a missing
   * key.
   */

  _commonLabel(key, fallback) {
    const translated = this._hass?.localize?.(`ui.common.${key}`);
    return typeof translated === "string" && translated ? translated : fallback;
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
};
