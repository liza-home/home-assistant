/**
 * lizaIP Panel — Data Loading & Persistence
 * All backend communication: load/save pages, actions, assignments.
 * Auto-saves with debounce on every change.
 */

/**
 * How long after one of our own saves a `config_changed` event is still assumed
 * to be the echo of that save rather than news from somewhere else.
 *
 * The backend fires the event from `ws_save_actions` and `ws_save_assignments`,
 * i.e. from the very commands this panel sends, and the panel listens to it —
 * so without a window every save comes straight back as "the config changed,
 * re-render everything", which tears down the open action editor. See
 * `_onConfigChanged`.
 *
 * Generous rather than tight: the cost of overshooting is that a genuine
 * external change is applied a second late, while undershooting is the bug this
 * exists to close.
 */
const SELF_SAVE_ECHO_MS = 1500;

export const DataMixin = {
  /**
   * Open (or extend) the window in which a `config_changed` event is ours.
   *
   * Called on both sides of the round-trip, and the two sides do different
   * jobs. `ws_save_actions` and `ws_save_assignments` fire the event *before*
   * `send_result`, so the echo is already on the wire ahead of the reply the
   * `await` is waiting for — that is what the mark before the call covers. The
   * mark after it covers the follow-on events the save sets off in the backend
   * (`_refresh_state_listener`, the device sync in `panel.py`), which land a
   * moment later.
   */
  _markSelfSave() {
    this._selfSaveEchoUntil = Date.now() + SELF_SAVE_ECHO_MS;
  },

  // The face of the selected remote: its button geometry and its photo. Named
  // per hardware model on the backend, so a different variant draws its own
  // shape and its own set of keys rather than this one's.
  //
  // `entry_id` is sent even when it is null -- `_init` loads the blueprint
  // before a device is picked, and JSON drops the undefined key, which the
  // backend reads as "no device yet, give me the default". That is what the
  // picker screen draws behind the dialog.
  async _loadBlueprint() {
    try {
      this._blueprint = await this._hass.callWS({
        type: "lizaip_config/get_blueprint",
        entry_id: this._currentEntry || undefined,
      });
    }
    catch (e) { this._blueprint = { buttons: [], viewBox: "0 0 172 500", name: "lizaIP" }; }
  },

  /**
   * Re-read the face, and say whether it actually moved.
   *
   * A remote reports its SKU in the handshake, which can land *after* the panel
   * is already open — a fresh pairing, or firmware that only learned to send
   * one on this boot. Until then the backend answers `get_blueprint` with the
   * shipped default, so the panel would keep drawing the wrong geometry and the
   * wrong set of keys until the user closed and reopened it.
   *
   * The comparison is what makes this safe to call from a hot path: every
   * handshake fires it, but a device whose model has not changed produces an
   * identical answer and no re-render.
   */
  async _refreshBlueprint() {
    const before = JSON.stringify(this._blueprint || null);
    await this._loadBlueprint();
    return JSON.stringify(this._blueprint || null) !== before;
  },

  /**
   * The device list as the backend currently sees it, or `null` if it could not
   * be asked.
   *
   * The distinction is the whole point: `_listDevices` cannot tell "no remotes"
   * from "the call failed", and for the initial load that is fine — an empty
   * picker is the honest answer either way. A *refresh* has an older list in
   * hand and must not throw it away over one failed round-trip, which is
   * exactly what happens when the panel refetches the moment the connection
   * comes back and the first call races the reconnect.
   */
  async _fetchDevices() {
    try { return (await this._hass.callWS({ type: "lizaip_config/list_devices", language: this._uiLanguage() })) || []; }
    catch (e) { return null; }
  },

  async _listDevices() {
    this._devices = (await this._fetchDevices()) || [];
  },

  async _loadIconDefaults() {
    try { this._iconDefaults = await this._hass.callWS({ type: "lizaip_config/get_icon_defaults" }); }
    catch (e) { this._iconDefaults = null; }
  },

  // The slider capability table, owned by `action_controller.py`. An empty list
  // on failure — the slider cards fall back to their "configure it under
  // Advanced" path rather than claiming capabilities we cannot confirm.
  async _loadSliderControls() {
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/get_slider_controls" });
      this._sliderControls = r?.controls || [];
    } catch (e) { this._sliderControls = []; }
  },

  /**
   * Icon-tint swatches, derived server-side from imgserv's COLOR_NAMES.
   *
   * Left null on failure rather than defaulted to a local copy: a hardcoded
   * fallback palette here would silently drift from the colours imgserv renders,
   * which is the whole reason this is fetched. The picker falls back to the
   * free-form hex input, which still works.
   */
  async _loadPalette() {
    try { this._palette = (await this._hass.callWS({ type: "lizaip_config/get_palette" }))?.colors || null; }
    catch (e) { this._palette = null; }
  },

  /**
   * The action wordings the panel prints, from the integration's translations.
   *
   * Loaded rather than hardcoded so the panel and the device cannot disagree:
   * `get_action_label` in `const.py` reads the same `action_labels` section of
   * the same `translations/<lang>.json`. On failure `_actionLabels` stays empty
   * and `_getActionLabel` title-cases the key, which is readable English rather
   * than a blank button.
   *
   * `entry_id` is what makes the preview honest: the language is a per-device
   * option, so a remote pinned to Italian has to read Italian *in the panel
   * too*. Reloaded whenever the selected device changes, since the answer is
   * different per device.
   */
  async _loadActionLabels() {
    try {
      const r = await this._hass.callWS({
        type: "lizaip_config/get_action_labels",
        ...(this._currentEntry ? { entry_id: this._currentEntry } : {}),
        language: this._uiLanguage(),
      });
      this._actionLabels = r?.labels || {};
      // The language the backend resolved -- the device's, which may outrank
      // this browser.
      this._actionLabelsLang = r?.language || "";
    } catch (e) { this._actionLabels = this._actionLabels || {}; }
  },

  /**
   * Device-local commands, as the backend registry declares them.
   *
   * Used both to offer a command in the picker and to recognise one in a
   * stored button, so it can be given the right icon and label. Fetched rather
   * than hard-coded, so a new command needs no frontend change; an empty list
   * degrades to neither happening.
   */
  async _loadInternalCommands() {
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/get_internal_commands" });
      this._internalCommands = r?.commands || [];
    } catch (e) { this._internalCommands = []; }
    if (!this._loading) this._render?.();
  },

  // `hass` carries the entity, device, area and floor registries but not the
  // label one, so it is fetched the way HA's own pickers fetch it. Keyed by id
  // to match the shape of the registries `hass` does carry.
  async _loadLabels() {
    try {
      const rows = await this._hass.callWS({ type: "config/label_registry/list" });
      this._labels = Object.fromEntries((rows || []).map((l) => [l.label_id, l]));
    } catch (e) { this._labels = {}; }
  },

  async _loadAll() {
    // `_loadActionLabels` belongs here and not only in `_init`: the language is
    // a *per-device* option, so the answer changes with `_currentEntry`. `_init`
    // loads it before any device is selected (the picker screen still prints
    // labels), and this reloads it once one is — and again on every switch.
    // `_loadBlueprint` is here for the same reason as `_loadActionLabels`: the
    // face belongs to the device, so switching remotes must redraw it. `_init`
    // loads the default one before any device is selected; this replaces it
    // with the selected remote's own.
    await Promise.all([
      this._loadPages(), this._loadActions(), this._loadActionLabels(), this._loadBlueprint(),
    ]);
    await this._loadAssignments();
    await this._loadGlobalUsage();
  },

  async _loadPages() {
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/get_pages", entry_id: this._currentEntry });
      this._pages = r?.pages || [];
    } catch (e) { this._pages = []; }
    this._currentPageIdx = 0;
  },

  async _loadActions() {
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/get_actions", entry_id: this._currentEntry });
      this._actions = r?.actions || [];
      // Normalise here, at the one place the library enters the panel, so every
      // downstream reader (the button card, the icon preview, the action
      // editor) sees the same trimmed list. Entries generated before
      // `media_play_pause` was scoped still carry `idle`/`off` rules, and every
      // reader walks `states` before any fallback runs. `_saveActionsToBackend`
      // then persists the trimmed list, so this self-heals on the next save.
      for (const a of this._actions) {
        if (a && a.states) a.states = this._scopeActionStates(a.service, a.states);
      }
      this._deduplicateActions();
    } catch (e) { this._actions = []; }
  },

  _deduplicateActions() {
    const seen = new Map();
    const dupeMap = new Map();
    const unique = [];

    for (const a of this._actions) {
      const svc = a.service || "";
      if (!svc) { unique.push(a); continue; }
      // Never dedup layout-generated actions — each has a unique command/target
      if (a.id && a.id.startsWith("layout_")) { unique.push(a); continue; }
      if (seen.has(svc)) {
        dupeMap.set(a.id, seen.get(svc).id);
      } else {
        seen.set(svc, a);
        unique.push(a);
      }
    }

    if (dupeMap.size > 0) {
      this._actions = unique;
      for (const [btnKey, assign] of Object.entries(this._assignments)) {
        if (dupeMap.has(assign.action_id)) {
          assign.action_id = dupeMap.get(assign.action_id);
        }
      }
      this._scheduleAutoSave();
    }
  },

  async _loadAssignments() {
    const pageId = this._pages[this._currentPageIdx]?.id;
    if (!pageId) { this._assignments = {}; return; }
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/get_assignments", entry_id: this._currentEntry, page_id: pageId });
      this._assignments = r?.assignments || {};
    } catch (e) { this._assignments = {}; }
  },

  /**
   * Rebuild `_globalUsageDetails`, and with it the thumbnail cache.
   *
   * `refresh` re-reads the *other* pages from the backend instead of trusting
   * `_pageCache`. That is what a config_changed reload needs: a dynamic
   * refresh rewrites assignments on pages the user is not looking at, and a
   * cache hit would keep painting the old ones. The entries are replaced one
   * by one as they arrive rather than by blanking the map first, because a
   * thumbnail rendered mid-reload would otherwise draw an empty page.
   *
   * The current page is always taken from `_assignments`, refresh or not —
   * that is the copy the user may be mid-edit on, so re-reading it here would
   * discard their work. `_onConfigChanged` calls `_loadAssignments` first for
   * exactly that reason, having already established there is no edit in
   * flight.
   */
  async _loadGlobalUsage(refresh = false) {
    const details = {};
    for (let pi = 0; pi < this._pages.length; pi++) {
      const page = this._pages[pi];
      let assigns;
      if (page.id === this._currentPageId) {
        assigns = this._assignments;
        // Cached even while current. The page the user is looking at stops
        // being current the moment a page is added, and nothing re-reads it
        // on the way out — so skipping it here is what left the page just
        // left behind rendering from `{}`, i.e. looking unconfigured until it
        // was clicked again.
        this._pageCache[page.id] = JSON.parse(JSON.stringify(assigns));
      } else if (!refresh && this._pageCache[page.id]) {
        assigns = this._pageCache[page.id];
      } else {
        try {
          const r = await this._hass.callWS({ type: "lizaip_config/get_assignments", entry_id: this._currentEntry, page_id: page.id });
          assigns = r?.assignments || {};
          this._pageCache[page.id] = JSON.parse(JSON.stringify(assigns));
        } catch (e) {
          // Fall back to whatever the cache already holds rather than to `{}`.
          // A failed read is not evidence that a page is empty, and the two
          // consumers would otherwise disagree: the thumbnail keeps drawing
          // the surviving cache entry while the usage scan counts the page as
          // blank. That gap became reachable with `refresh`, which enters this
          // branch for pages that *do* have an entry.
          //
          // Under-counting here is the dangerous direction: `_globalUsageDetails`
          // is what marks an action unused, so a page dropped from the scan can
          // present a live action as safe to delete.
          assigns = this._pageCache[page.id] || {};
        }
      }
      for (const key in assigns) {
        const assign = assigns[key];
        if (!assign) continue;
        const record = (aid, interaction) => {
          if (!aid) return;
          if (!details[aid]) details[aid] = [];
          details[aid].push({
            page: page.name || page.id,
            pageIdx: pi,
            button: key,
            buttonName: assign.label || "",
            interaction: interaction || "",
          });
        };
        record(assign.action_id);
        // Secondary interactions (long-press, double-click, …) reference actions
        // too. Missing them made the "unused" badge lie — and would make any
        // bulk cleanup silently delete a live long-press action.
        const interactions = assign.interactions;
        if (interactions && typeof interactions === "object") {
          for (const [name, aid] of Object.entries(interactions)) record(aid, name);
        }
      }
    }
    this._globalUsageDetails = details;
  },

  _globalUsageCount(actionId) {
    return (this._globalUsageDetails[actionId] || []).length;
  },

  // Debounced auto-save: schedules a save ~600ms after the last change
  _scheduleAutoSave() {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => { this._autoSaveTimer = null; this._globalSave(true); }, 600);
  },

  /**
   * Flush any pending debounced save immediately (call before page/tab switch).
   *
   * Returns the save so a caller that is about to move `_currentPageIdx` can
   * await it. That await is required, not tidiness: `_globalSave` saves actions
   * first, and `_saveAssignments` only resolves `_currentPageId` after those
   * round-trips. Starting the flush without waiting leaves the page switch free
   * to land in between, so the edits get written to the page being switched
   * *to*, clobbering it and losing the ones they belonged to.
   *
   * Callers that leave `_currentPageIdx` alone can keep ignoring the result.
   */
  _flushAutoSave() {
    if (this._autoSaveTimer) {
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = null;
      return this._globalSave(true);
    }
    return Promise.resolve();
  },

    async _globalSave(silent = false) {
    try {
      await this._saveActionsToBackend();
      await this._saveAssignments();
      if (!silent) this._toast(this._t("saved"));
    } catch (e) { this._toast(this._t("save_failed", { error: e.message || e })); }
  },

  async _saveActionsToBackend() {
    for (let ai = 0; ai < this._actions.length; ai++) {
      const action = this._actions[ai];
      const service = action.service || "";
      const svc = service.split(".")[1] || "";
      const domain = service.split(".")[0] || "";

      if (this._internalCommand(service) || this._isStatelessService(svc)) {
        if (!action.icon) {
          action.icon = this._getServiceIcon(service);
        }
      } else if (!action.states || action.states.length === 0) {
        const statesInfo = this._getStatesForAction(action);
        const attribute = statesInfo.attribute;
        const stateVals = statesInfo.states || [];
        if (stateVals.length > 0) {
          const defaults = this._getDefaultIcons(domain, attribute);
          action.states = [];
          for (let si = 0; si < stateVals.length; si++) {
            const sv = stateVals[si];
            const icon = defaults[sv] || "";
            if (icon) {
              const entry = { state: sv, icon: icon };
              if (attribute) entry.attribute = attribute;
              action.states.push(entry);
            }
          }
        }
      }
    }
    // ws_save_actions fires config_changed, which comes back to us. `finally`
    // because a failed save may still have fired it — the backend fires before
    // it can know the reply will not make it.
    this._markSelfSave();
    try {
      await this._hass.callWS({ type: "lizaip_config/save_actions", entry_id: this._currentEntry, actions: this._actions });
    } finally {
      this._markSelfSave();
    }
  },

  async _saveAssignments(assignments = null, pageId = null) {
    const source = assignments || this._assignments;
    const cleaned = {};
    for (const [btnKey, assign] of Object.entries(source)) {
      if (!assign || typeof assign !== "object") {
        cleaned[btnKey] = { action_id: null, config: [], label: null, image: null, image_pinned: false, state_icons: {} };
        continue;
      }
      const copy = { ...assign };
      // Session-only, and deliberately not `label_edited`: that one is the
      // stored record of a typed label and has to reach the backend, or the
      // ladders go back to guessing and the entity prefix returns.
      delete copy._labelEdited;
      if (!copy.action_id) {
        copy.action_id = null;
        copy.config = copy.config || [];
        // A prelude or verification with no action to wrap is orphaned:
        // keeping either would replay against whatever gets assigned to this
        // slot next.
        delete copy.before;
        delete copy.after;
      }
      if (!("label" in copy)) copy.label = null;
      if (!("image" in copy)) copy.image = null;
      // image_pinned is a real user decision, not a transient UI flag: it must
      // survive a reload or the stale-image invalidation misfires on the next edit.
      copy.image_pinned = !!copy.image_pinned;
      if (!("state_icons" in copy)) copy.state_icons = {};
      cleaned[btnKey] = copy;
    }
    const targetPageId = pageId ?? this._currentPageId;
    // page_id must be a 32-bit unsigned integer ≥ 1 (PROTOCOL.md §3). Bail out
    // instead of sending a request the backend will reject.
    if (!Number.isInteger(targetPageId) || targetPageId < 1) {
      console.warn("[LIZA] save_assignments skipped — no valid page_id:", targetPageId);
      return;
    }
    // Same echo as save_actions — ws_save_assignments fires config_changed too.
    this._markSelfSave();
    try {
      await this._hass.callWS({
        type: "lizaip_config/save_assignments", entry_id: this._currentEntry,
        page_id: targetPageId, assignments: cleaned,
        language: this._uiLanguage(),
      });
    } finally {
      this._markSelfSave();
    }
  },

  /**
   * Strip every reference to `deletedId` from one page's assignments.
   *
   * Returns true when something changed. A button whose primary action is gone
   * loses the whole entry unless it still carries an image, another
   * interaction, a configured slider, its fixed-button overrides, or a
   * `dynamic` key — the last two for the same reasons `_unassignButton` keeps
   * them. Deliberately *not* the rule `_unassignButton` uses for the rest:
   * that is a user saying "clear this button" and takes the appearance
   * with it, while this is a library entry disappearing out from under buttons
   * that never asked for anything to change.
   */
  _purgeActionFromAssignments(assigns, deletedId) {
    let changed = false;
    for (const [btnKey, assign] of Object.entries(assigns)) {
      if (!assign || typeof assign !== "object") continue;
      if (assign.action_id === deletedId) {
        delete assign.action_id;
        delete assign.config;
        delete assign.label;
        delete assign.trigger_on;
        delete assign._labelEdited;
        // The label it claimed went with it, so the claim goes too — a slot
        // reassigned later must not print a label that no longer exists.
        delete assign.label_edited;
        delete assign.state_icons;
        if (!assign.image_pinned) { delete assign.image; delete assign.image_pinned; }
        // Same reasoning as _unassignButton: the action this button tracked is
        // gone, so tracking has to stop or the next refresh rebuilds a button
        // pointing at a deleted action. Explicit null so the backend unbinds
        // rather than inheriting the stored binding.
        if (assign.dynamic) assign.dynamic = null;
        changed = true;
      }
      if (assign.interactions && typeof assign.interactions === "object") {
        for (const [name, aid] of Object.entries(assign.interactions)) {
          if (aid !== deletedId) continue;
          delete assign.interactions[name];
          changed = true;
        }
        if (!Object.keys(assign.interactions).length) delete assign.interactions;
      }
      const hasInteractions = assign.interactions && Object.keys(assign.interactions).length > 0;
      // `mode` rather than truthiness, the same test `_hasRunnableAction` and
      // the store make: `ensureSliderActions` leaves a bare `{}` behind, which
      // is not yet a configured slider and must not hold an entry open.
      const hasSlider = !!assign.slider_actions?.mode;
      // The two reasons a blank-looking record still has to reach the backend,
      // both of them the ones `_unassignButton` keeps. A save rebuilds every
      // button key from the payload and merges what the panel did not send, so
      // dropping the record here is not "no change" — it is the panel saying
      // nothing about these fields, and the merge answering with what is on
      // disk. The unbind set just above would be one such silence, and the
      // deleted action would come back on the next refresh; the overrides say
      // what the *fixed* buttons do under this one and are not this deletion's
      // to destroy.
      const hasUnbind = Object.hasOwn(assign, "dynamic");
      const hasOverrides = assign.overrides && Object.keys(assign.overrides).length > 0;
      if (!assign.action_id && !assign.image && !hasInteractions && !hasSlider
          && !hasUnbind && !hasOverrides) {
        delete assigns[btnKey];
      }
    }
    return changed;
  },

  async _fetchServiceIcons() {
    try {
      const result = await this._hass.callWS({ type: "frontend/get_icons", category: "services" });
      this._serviceIconsCache = result?.resources || {};
    } catch (e) {
      this._serviceIconsCache = {};
    }
  },

  /**
   * HA only auto-loads the `config` fragment while the user is on /config, so
   * `ui.panel.config.*` is unknown inside our panel. `localize` returns "" for
   * unknown keys, which rendered the "Add action" dialog with blank tabs and
   * label-less rows.
   */
  async _loadHaTranslations() {
    try {
      await this._hass?.loadFragmentTranslation?.("config");
    } catch (e) { console.debug("[LIZA] fragment translations:", e); }
  },

  async _loadHaComponents() {
    // Ahead of the cache check on purpose: the elements are loaded once, but
    // the fragment has to be ensured on every entry, since a reload can leave
    // the components registered while the translations are gone.
    await this._loadHaTranslations();
    if (this._haComponentsLoaded) return;
    try {
      if (customElements.get("ha-automation-action")) { this._haComponentsLoaded = true; return; }
      const pp = document.createElement("partial-panel-resolver");
      pp.hass = { panels: [{ url_path: "config", component_name: "config" }] };
      pp._updateRoutes();
      await pp.routerOptions.routes.config.load();
      const cr = document.createElement("ha-panel-config");
      await cr.routerOptions.routes.automation.load();
      this._haComponentsLoaded = true;
    } catch (e) { console.debug("[LIZA] preload:", e); }
  },

  async _loadLayouts() {
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/list_layouts" });
      return r?.layouts || [];
    } catch (e) {
      console.warn("[LIZA] Failed to load layouts:", e);
      return [];
    }
  },

  async _loadLayoutDevices(layoutId) {
    // Returns {devices, error}. An empty list and a failed request need very
    // different messages: "set up the integration" is actively misleading when
    // the integration is fine and the request itself broke.
    try {
      const r = await this._hass.callWS({
        type: "lizaip_config/list_layout_devices",
        layout_id: layoutId,
      });
      return { devices: r?.devices || [], error: null };
    } catch (e) {
      console.warn("[LIZA] Failed to load layout devices:", e);
      return { devices: [], error: e?.message || String(e) };
    }
  },

  async _loadLayoutConfigEntries(layoutId) {
    // The config-entry flavour of the above: a layout bound to one instance of
    // an integration (a Hue bridge) rather than to one of its devices.
    try {
      const r = await this._hass.callWS({
        type: "lizaip_config/list_layout_config_entries",
        layout_id: layoutId,
      });
      return { entries: r?.entries || [], error: null };
    } catch (e) {
      console.warn("[LIZA] Failed to load layout config entries:", e);
      return { entries: [], error: e?.message || String(e) };
    }
  },

  /**
   * Tell the device to show a page.
   *
   * Fire-and-forget on purpose: the panel has already moved, and a device that
   * is offline or slow to answer must not hold up the editor. The one place
   * that speaks `goto_page`, so every way of reaching a page — the thumbnail
   * strip, adding a blank page, adding a layout page — navigates identically.
   */
  _gotoPageOnDevice(pageId) {
    if (!this._currentEntry || !pageId) return;
    this._hass.callWS({
      type: "lizaip_config/goto_page",
      entry_id: this._currentEntry,
      page_id: pageId,
    }).catch((e) => console.warn("[LIZA] goto_page failed:", e?.message || e));
  },

  /**
   * The one path a new page takes, whichever kind it is.
   *
   * `create` is the only difference between a blank page and a layout page: it
   * writes the page over the wire and answers with the new page list. The rest
   * — flushing a pending save, snapshotting the page being left, selecting the
   * new page, navigating the device to it, reloading — is identical for both,
   * and stays identical by living here rather than in two copies that drift.
   *
   * `reloadActions` is the one step that is *not* free to share. A layout page
   * merges generated entries into the action library and has to re-read it; a
   * blank page writes none. And `_loadActions` swallows a failed read as an
   * empty library, which `_saveActionsToBackend` then persists wholesale — so
   * re-reading a library that cannot have changed only exposes the stored one
   * to being wiped by a dropped connection.
   *
   * Errors propagate: the blank path toasts, the layout dialog keeps itself
   * open so the target can be corrected.
   */
  async _createPage(create, { reloadActions = false } = {}) {
    this._pageOpInFlight = true;
    try {
      // A pending save resolves _currentPageId, which is about to point at the
      // new page. Awaited so the save finishes while that still means the page
      // being left — otherwise it lands on the page being created, losing the
      // edits from both.
      await this._flushAutoSave();
      // Cache current page assignments before switching away
      if (this._pages.length > 0) {
        const oldPageId = this._pages[this._currentPageIdx]?.id;
        if (oldPageId) this._pageCache[oldPageId] = JSON.parse(JSON.stringify(this._assignments));
      }

      const result = await create();
      if (!result?.pages) return result;

      this._pages = result.pages;
      this._currentPageIdx = this._pages.length - 1;
      this._selectedButtonIdx = -1;
      this._contextKey = null;
      // A new page's card opens on its colour, like every other page's. Left
      // set, the row would carry over from the page just left and spell out the
      // new page's empty title instead.
      this._pageTitleSelected = false;
      this._editorEl = null;
      this._sequence = [];

      // Before the awaits below, for the same reason _switchPageTo fires it
      // first: the device should follow the panel now, not once the editor has
      // finished re-reading itself.
      this._gotoPageOnDevice(this._pages[this._currentPageIdx]?.id);

      if (reloadActions) await this._loadActions();
      await this._loadAssignments();
      this._render();
      this._scrollActivePageIntoView();
      return result;
    } finally {
      this._pageOpInFlight = false;
    }
  },

  _scrollActivePageIntoView() {
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      const activeThumb = this.shadowRoot?.querySelector(".page-thumb.active");
      if (activeThumb) activeThumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
  },

  async _addLayoutPage(layoutId, target, targetKind = "device") {
    try {
      return await this._createPage(() => this._hass.callWS({
        type: "lizaip_config/add_layout_page",
        entry_id: this._currentEntry,
        layout_id: layoutId,
        ...(targetKind === "config_entry"
          ? { target_config_entry: target }
          : { target_device: target }),
      }), { reloadActions: true });
    } catch (e) {
      console.error("[LIZA] Add layout page failed:", e);
      throw e;
    }
  },
};
