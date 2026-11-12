/**
 * lizaIP Panel — page operations.
 *
 * Switching, deleting, reordering, duplicating and re-targeting pages, and the
 * queue that runs those writes one at a time: each of them sends or receives
 * the whole page list, so two side by side would lose one another's pages.
 *
 * Assigned onto the panel's prototype like every other mixin, so these methods
 * run with `this` bound to the panel element.
 */

export const PagesMixin = {
  /**
   * Resolves once no page add/delete/reorder is running.
   *
   * Each of them sends or receives the whole page list: a delete sent while
   * an add is still saving names a list without the added pages, and the
   * add's answer then brings back the page just deleted.
   */
  _whenPageOpsIdle() {
    if (this._pageOpTail) return this._pageOpTail.then(() => this._whenPageOpsIdle());
    if (!this._pageOpInFlight) return Promise.resolve();
    return new Promise(resolve => (this._pageOpWaiters ||= []).push(resolve));
  },

  /**
   * Run a page add/delete/reorder/retarget/bind, one at a time.
   *
   * Each sends or receives the whole page list, so two side by side lose one
   * another's pages. Queued on a promise chain: an op started while the panel
   * is idle still runs synchronously up to its first await, so an optimistic
   * redraw is not put off. The counter keeps `_pageOpInFlight` raised until
   * the last op ends rather than the first.
   */
  _runPageOp(fn) {
    const run = async () => {
      this._pageOpCount = (this._pageOpCount || 0) + 1;
      this._pageOpInFlight = true;
      try {
        return await fn();
      } finally {
        this._pageOpCount -= 1;
        if (!this._pageOpCount) this._endPageOp();
      }
    };
    const prev = this._pageOpTail;
    const result = prev ? prev.then(run) : run();
    const tail = result.then(() => {}, () => {});
    this._pageOpTail = tail;
    tail.then(() => { if (this._pageOpTail === tail) this._pageOpTail = null; });
    return result;
  },

  /** End a page add/delete/reorder, applying a refresh deferred meanwhile. */
  _endPageOp() {
    this._pageOpInFlight = false;
    for (const resolve of this._pageOpWaiters?.splice(0) || []) resolve();
    if (!this._refreshAfterPageOp) return;
    this._refreshAfterPageOp = false;
    this._pendingConfigReload = true;
    this._flushPendingConfigReload();
  },

  /**
   * @param {number} idx  The page to move to.
   * @param {string|null} selectKey  A control on that page's face to open once
   *   it is current — the one the click that asked for the switch landed on.
   *   Replayed through `_selectFaceKey` rather than assigning
   *   `_selectedButtonIdx` here, so arriving at a button by crossing pages and
   *   arriving at it by clicking it cannot mean two different things.
   */
  async _switchPageTo(idx, selectKey = null) {
    if (idx < 0 || idx >= this._pages.length || idx === this._currentPageIdx) return;
    // Not awaited: the save keeps the page it was made on, and coming back
    // reads the copy cached below.
    this._flushAutoSave();
    const token = (this._pageSwitchToken || 0) + 1;
    this._pageSwitchToken = token;
    const oldPageId = this._pages[this._currentPageIdx]?.id;
    // While an earlier switch is still reading the page being left,
    // `_assignments` holds the page before that one -- not something to file
    // under this page's id.
    if (oldPageId && this._pageSwitchLoadingId !== oldPageId) {
      this._pageCache[oldPageId] = JSON.parse(JSON.stringify(this._assignments));
    }
    this._pageSwitchLoadingId = null;

    this._currentPageIdx = idx;
    this._selectedButtonIdx = -1;
    this._contextKey = null;
    // A half-finished move does not cross pages. Both ends resolve against one
    // page's assignment map, so the key left standing here would name a button
    // on the page just left and be matched against an identically-keyed one on
    // the page arrived at — a move the user never aimed.
    this._disarmMove();
    // A page is arrived at, not renamed: the new page's card opens on its
    // colour, with the title row left to the title strip on the face.
    this._pageTitleSelected = false;
    this._editorEl = null;
    this._sequence = [];

    const newPageId = this._pages[idx]?.id;

    if (this._pageCache[newPageId]) {
      this._assignments = JSON.parse(JSON.stringify(this._pageCache[newPageId]));
    } else {
      this._pageSwitchLoadingId = newPageId;
      await this._loadAssignments();
      // Overtaken by a later switch: that one owns the selection and the render.
      if (this._pageSwitchToken !== token) return;
      this._pageSwitchLoadingId = null;
    }
    // The selection replay renders for itself, so rendering here as well would
    // draw the arrived-at page once with nothing selected and once with the
    // button open — the blink the plain switch does not have.
    if (!selectKey || !this._selectFaceKey(selectKey)) this._render();
    // A deferred external change would have been read straight back out of the
    // stale `_pageCache` above, so the flush has to come after the switch, not
    // before it. The reload re-reads those entries rather than dropping them.
    this._flushPendingConfigReload();
  },

  /**
   * Delete (or Backspace, the key a Mac labels "delete") deletes what is
   * selected: the open button, as **Delete** in its menu does, or -- with no
   * button open -- the open page, through the same confirmation as its ✕.
   * Only where the key means nothing else: not while typing, not over a dialog
   * or menu, and not from focus that belongs to the rest of Home Assistant.
   */
  _onPageDeleteKey(e) {
    if (!(e.key === "Delete" || e.key === "Backspace")) return;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    // Not turned away while a page operation runs: `_deletePage` waits for it,
    // as the ✕ does. Dropping the key made it dead for the seconds a delete
    // took to settle on a slow disk.
    if (this._activeTab !== "buttons" || this._moveSourceKey) return;
    if (!this._pages?.[this._currentPageIdx]) return;
    if (this._faceMenuEl || this.shadowRoot?.querySelector(".add-page-overlay")) return;
    const path = e.composedPath?.() || [];
    const typing = path.some((n) => n?.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT|HA-INPUT|HA-INPUT-SEARCH|HA-SELECT)$/.test(n?.tagName || "")
      || n?.getAttribute?.("role") === "textbox");
    if (typing) return;
    const target = path[0];
    const unfocused = target === document.body || target === document.documentElement;
    if (!unfocused && !path.includes(this)) return;
    e.preventDefault();
    // An open button takes the key even when it holds nothing: deleting the
    // page from under a selected button is never what the key meant.
    if (this._selectedButton) {
      this._unassignButton();
      return;
    }
    this._deletePage(this._currentPageIdx);
  },

  async _deletePage(pageIdx) {
    // Named by id across the wait: the list can change under it.
    const wanted = this._pages[pageIdx !== undefined ? pageIdx : this._currentPageIdx]?.id;
    await this._whenPageOpsIdle();
    const idx = this._pages.findIndex(p => p.id === wanted);
    const page = this._pages[idx];
    if (!page) return;
    // Which page by position and id in the title, its name on the line under
    // it: two pages can share a title, and "Page 3/9 (#24)" cannot be confused.
    // `_pageTitle`, not `page.title`: `title` is a picture spec and
    // reads back as "mdi:sofa" rather than as a name.
    const pageName = this._pagePosition(page);
    const pageSubtitle = this._pageTitleShown(page);
    const pageId = page.id;
    // WCAG 3.3.4: this destroys the page and every button on it, and a
    // delete the backend accepts cannot be rolled back. Counted from
    // `_pageCache`, or the live assignments for the open page; a page that
    // is neither fetched on demand, the same WS round trip `_loadGlobalUsage`
    // uses, because a silent `{}` here used to read a nonempty, never-opened
    // page as empty and skip the warning its buttons deserved.
    // `slider_horizontal` is the title bar rather than a button.
    let assigns;
    if (pageId === this._currentPageId) {
      assigns = this._assignments;
    } else if (this._pageCache[pageId]) {
      assigns = this._pageCache[pageId];
    } else {
      try {
        const r = await this._hass.callWS({ type: "lizaip_config/get_assignments", entry_id: this._currentEntry, page_id: pageId });
        assigns = r?.assignments || {};
      } catch (e) {
        assigns = {};
      }
    }
    const configured = Object.entries(assigns)
      .filter(([key, rec]) => key !== "slider_horizontal" && this._isAssignedRecord(rec)).length;
    // The subpages a template brought with this page go with it: nothing else
    // leads to them. The backend drops them too; naming them here is what
    // tells the user, and taking them out of the strip at once is what keeps
    // the panel from showing pages that no longer exist.
    const bundled = page.template?.instance === pageId
      ? this._pages.filter(p => p.id !== pageId && p.template?.instance === pageId)
      : [];
    const pageMessage = configured > 0
      ? this._t("delete_page_confirm", { n: configured })
      : this._t("delete_page_confirm_empty");
    // Always asked. Skipping it for pages that looked empty went wrong: a
    // page that is neither open nor cached counts as having no buttons, and
    // was deleted with all of them and no warning.
    const confirmed = await this._confirmDestructive({
      title: this._t("delete_page_title", { name: pageName }),
      subtitle: pageSubtitle,
      message: bundled.length
        ? `${pageMessage} ${this._tCount("delete_page_subpages", bundled.length)}`
        : pageMessage,
      confirmText: this._t("delete"),
    });
    if (!confirmed) return;
    return this._runPageOp(() => this._commitPageDelete(pageId, bundled, pageName));
  },

  /** The agreed delete, run as a page operation (see `_runPageOp`). */
  async _commitPageDelete(pageId, bundled, pageName) {
    // Queued behind another page operation, the page may have gone meanwhile.
    if (!this._pages.some(p => p.id === pageId)) return;
    // Started before the selection moves -- the save takes the page it was
    // edited on as it starts -- and awaited only before the page list is
    // sent: on a slow disk a save can take seconds, and the page used to stay
    // in the strip all that time.
    const flushed = this._flushAutoSave();
    // Shown first, saved second, as a reorder is: `set_pages` talks to the
    // remote before it answers, and the strip used to keep the deleted page
    // until then. A failed save puts everything back.
    const before = {
      idx: this._currentPageIdx,
      assignments: this._assignments,
      pages: this._pages.slice(),
    };
    const removedIds = new Set([pageId, ...bundled.map(p => p.id)]);
    // _currentPageIdx is a position in a list that just got shorter, so
    // deleting anything to the left of the selection slides the selected page
    // down and the index has to follow it. Only clamping the tail — which is
    // all this once did — left every other deletion pointing at the *next*
    // page. Deleting the selected page itself lands on the first page left
    // after it; the clamp catches the case where there was nothing after it.
    const openBefore = this._currentPageId;
    const deletedSelected = removedIds.has(openBefore);
    const survivorsBefore = this._pages
      .slice(0, this._currentPageIdx).filter(p => !removedIds.has(p.id)).length;
    this._pages = this._pages.filter(p => !removedIds.has(p.id));
    this._currentPageIdx = deletedSelected
      ? survivorsBefore
      : this._pages.findIndex(p => p.id === openBefore);
    if (this._currentPageIdx >= this._pages.length) this._currentPageIdx = Math.max(0, this._pages.length - 1);

    this._selectedButtonIdx = -1;
    this._contextKey = null;
    this._pageTitleSelected = false;
    this._editorEl = null;
    // The page now open is drawn from its cached buttons until they are read
    // again below; without a cache entry it reads as empty for that moment.
    if (deletedSelected) {
      const openId = this._pages[this._currentPageIdx]?.id;
      this._assignments = openId != null && this._pageCache[openId]
        ? JSON.parse(JSON.stringify(this._pageCache[openId])) : {};
    }
    this._render();

    let result;
    try {
      await flushed;
      result = await this._hass.callWS({ type: "lizaip_config/set_pages", entry_id: this._currentEntry, pages: this._pages });
    } catch (e) {
      // Restore on failure
      this._pages = before.pages;
      this._currentPageIdx = before.idx;
      this._assignments = before.assignments;
      this._toast(this._t("delete_page_failed"));
      this._render();
      return;
    }
    this._toast(this._t("page_deleted", { name: pageName }));
    for (const id of removedIds) delete this._pageCache[id];

    // The backend took out every link to the deleted page; the pages it
    // changed are read again, or their buttons would still show the link.
    const cleaned = Array.isArray(result?.cleaned) ? result.cleaned : [];
    for (const id of cleaned) delete this._pageCache[id];
    // Only the selected page's assignments changed hands -- or were cleaned.
    // Otherwise `_assignments` describes the same page it already did, and
    // re-reading it would discard edits the flush above has not yet had
    // answered.
    if (deletedSelected || cleaned.includes(this._currentPageId)) await this._loadAssignments();
    if (cleaned.length) await this._loadGlobalUsage();
    if (deletedSelected || cleaned.length) this._render();
  },

  async _reorderPage(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    // Named by id: queued behind another page operation, the list can change
    // before this one runs.
    const movedId = this._pages[fromIdx]?.id;
    return this._runPageOp(() => this._commitPageReorder(movedId, fromIdx, toIdx));
  },

  async _commitPageReorder(movedId, wantedFrom, wantedTo) {
    const fromIdx = movedId != null ? this._pages.findIndex(p => p.id === movedId) : wantedFrom;
    const toIdx = Math.min(wantedTo, this._pages.length - 1);
    if (fromIdx < 0 || fromIdx === toIdx) return;
    const before = this._pages.slice();
    const beforeIdx = this._currentPageIdx;

    const [moved] = this._pages.splice(fromIdx, 1);
    this._pages.splice(toIdx, 0, moved);
    if (this._currentPageIdx === fromIdx) {
      this._currentPageIdx = toIdx;
    } else if (fromIdx < this._currentPageIdx && toIdx >= this._currentPageIdx) {
      this._currentPageIdx--;
    } else if (fromIdx > this._currentPageIdx && toIdx <= this._currentPageIdx) {
      this._currentPageIdx++;
    }

    // Show the move first, save it second. The card used to stay put until a
    // websocket round trip came back -- a round trip that rewrote every page
    // file and talked to the device before it answered -- and only then did a
    // full re-render put it in its new place.
    if (!this._reorderPageDom()) this._render();

    try {
      await this._hass.callWS({ type: "lizaip_config/set_pages", entry_id: this._currentEntry, pages: this._pages });
    } catch (err) {
      // Nothing was persisted, so the optimistic row is now a lie. Put the old
      // order back and render it properly rather than leaving the user looking
      // at a move that did not happen.
      console.error("[lizaIP] page reorder failed, reverting:", err);
      this._pages = before;
      this._currentPageIdx = beforeIdx;
      this._render();
    }
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

  /** Write the subpage the walk chose, and point the long touch at it.
   *
   * `create` already carries the subpage flag, the way back and the place
   * beside the button's own page, so all that is left is the long touch.
   */
  async _addOptionsPage({ key, pageId, name }, create) {
    return this._runPageOp(async () => {
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
      this._currentPageIdx = at >= 0
        ? at
        : Math.min(this._currentPageIdx, Math.max(this._pages.length - 1, 0));
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
    });
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

  /**
   * Write some of one page's fields -- its title, whether it is a subpage --
   * and adopt the page list the server answers with.
   *
   * Resolves true when that list differs from the one on screen, so a caller
   * that already drew the change can skip a second full render, which redraws
   * every face. A failed write rejects; what to show then is the caller's call.
   */
  async _updatePage(page, fields) {
    const result = await this._hass.callWS({
      type: "lizaip_config/update_page", entry_id: this._currentEntry,
      page_id: page.id, ...fields,
    });
    if (!result?.pages || JSON.stringify(result.pages) === JSON.stringify(this._pages)) return false;
    this._pages = result.pages;
    return true;
  },

  /** Flip a page between main and subpage, and tell the remote.
   *
   * Written through `update_page` like the title is, so the same push to the
   * device carries it -- there is no separate "page kind" message to keep in
   * step.
   */
  async _setPageSubpage(page, makeSub) {
    // Shown at once: the write rewrites every page file before it answers, and
    // waiting for that left the strip unchanged for a noticeable while.
    page.subpage = !!makeSub;
    this._render();
    try {
      // Redrawn again only if the server's list differs from what is shown.
      if (await this._updatePage(page, { subpage: !!makeSub })) this._render();
    } catch (e) {
      // Same stance as the title write: keep what the user asked for on
      // screen rather than silently snapping back, and let the next load
      // reconcile.
    }
  },
};
