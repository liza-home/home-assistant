/**
 * lizaIP Panel — v5 (Action Library = service templates)
 *
 * Architecture:
 *   - Action Library: reusable service templates (service + state icons)
 *     One entry per service type (e.g., "Light Toggle" for light.toggle)
 *   - Button Assignment: action_id + full config (service + target + data)
 *     Target is picked via HA editor in buttons tab
 *   - Actions tab: edit service templates (name, state icons)
 *   - Buttons tab: assign action + configure target via HA editor
 *
 * Module split:
 *   - liza-remote-data.js      — backend communication (load/auto-save)
 *   - liza-remote-helpers.js   — utilities, icon resolution, labeling
 *   - liza-remote-states.js    — state derivation & states editor
 *   - liza-remote-buttons-view.js — Buttons tab HTML + wiring
 *   - liza-remote-actions-view.js — Actions tab HTML + wiring
 *   - liza-remote-styles.js    — CSS styles
 *   - liza-remote-svg.js       — SVG rendering
 */

import { STYLES } from "./liza-remote-styles.js";
import { DataMixin } from "./liza-remote-data.js";
import { HelpersMixin } from "./liza-remote-helpers.js";
import { A11yMixin } from "./liza-remote-a11y.js";
import { I18nMixin } from "./liza-remote-i18n.js";
import { StatesMixin } from "./liza-remote-states.js";
import {
  ButtonsViewMixin,
  OVERRIDABLE_FIXED_BUTTONS,
  isGridBtn,
  isConfigured,
} from "./liza-remote-buttons-view.js";
import { ActionsViewMixin } from "./liza-remote-actions-view.js";
import { SettingsViewMixin } from "./liza-remote-settings-view.js";


class LizaRemotePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this._devices = [];
    this._blueprint = null;
    this._currentEntry = null;

    // Action Library — service templates (no target)
    this._actions = []; // [{id, name, service, states: [{state, icon, attribute?}]}]
    this._editingActionIdx = -1;

    // Button assignments — action_id + full config (with target)
    this._assignments = {}; // { button_key: { action_id: "...", config: [{action, target, data}] } }
    this._pages = [];
    this._currentPageIdx = 0;
    this._pageCache = {};
    this._selectedButtonIdx = -1;
    // The grid button providing context for the fixed buttons, or null for
    // "page defaults". The second half of a two-level selection:
    // `_selectedButtonIdx` says what is being edited, `_contextKey` says under
    // which grid button.
    //
    // The panel had one selection, so clicking `button_volume_up` after
    // `button_3` simply replaced it — the state "button_3 is the context *and*
    // I am editing volume-up" was unreachable, and that is exactly the state
    // this feature is about. Context surviving the click is the whole trick.
    //
    // `null` is today's behaviour exactly, which is how the feature stays
    // opt-in and how "no button selected -> the fixed buttons have their
    // default config" is spelled — by absence, again.
    this._contextKey = null;
    // Whether the page's title row -- its logo/label -- is on show in the Page
    // Settings card.
    //
    // Reaching that card and editing the page's title used to be the same
    // gesture: any click that left no button selected opened the card with the
    // title banner already spelled out. But the card is what a page *lands on*
    // -- switching pages, deselecting a button, deleting one -- while the title
    // is a single stored string, so the most common way to arrive was also the
    // one that put the least-wanted control first. Selecting a page now offers
    // the colour and nothing else; the title answers to the one control that is
    // the title, `slider_horizontal` on the face.
    //
    // Held beside `_selectedButtonIdx` rather than inside it because a title is
    // not a button: the rest of the panel reads -1 as "no button is being
    // edited", which stays true while the title row is open.
    this._pageTitleSelected = false;
    this._pagesEditMode = false;
    // The button whose configuration is waiting to be put somewhere else, or
    // null when no move is in progress.
    //
    // A move is two gestures with a state in between, and that state has to be
    // visible or the second gesture is a guess. Held as a *key* rather than an
    // index because the blueprint is re-read on every render and an index is
    // only meaningful against the one it came from.
    this._moveSourceKey = null;

    this._activeTab = "buttons"; // "actions" | "buttons" | "debug"
    // Whether this build carries the debug tools at all. They are stripped
    // from a stable release, so the panel has to ask rather than assume:
    // its own files are served from disk either way.
    this._debugTools = false;
    this._debugProbe = null;
    this._debugReport = null;
    // Loaded by the debug tab itself when it is opened, rather than on demand:
    // null means "not read yet", which is what triggers that first read.
    this._debugLogging = null;
    this._debugLoggingBusy = false;
    this._debugLoggingError = null;
    // "off" is where the switch starts, not what the device is: the port is
    // read from `/Device/Control` when the tab opens. `_known` says whether
    // that read has happened, `_following` whether we are reading the port --
    // an open port outlives a restart of Home Assistant, the task reading it
    // does not.
    // Which report sections the reader has indented, by endpoint.
    this._debugPretty = {};
    // Which report sections are expanded, and which are being read right now.
    // Kept here rather than left to the `<details>` elements: every render
    // rebuilds them, so an expansion that lived only in the DOM would close
    // itself the moment the section it asked for arrived.
    this._debugOpen = {};
    this._debugSectionBusy = {};
    this._debugPortOn = false;
    this._debugPortKnown = false;
    this._debugPortFollowing = null;
    // One flag and one error slot per action, not one shared pair: the three
    // calls are independent, so a shared flag greyed out the other two
    // controls for the length of a call that had nothing to do with them, and
    // a shared error slot showed a failed report inside the reachability card.
    this._debugProbeBusy = false;
    this._debugReportBusy = false;
    this._debugPortBusy = false;
    this._debugProbeError = null;
    this._debugReportError = null;
    this._debugPortError = null;
    this._globalUsageDetails = {};
    this._actionFilter = "";
    this._initialized = false;
    this._loading = false;
    // Set once the first load has finished. `_initialized` is no substitute:
    // it is raised *before* `_init` runs, so it cannot tell "loading" from
    // "loaded" — and an availability edge arriving mid-init would be applied to
    // a device list that has not been fetched yet.
    this._initDone = false;
    // An availability edge that arrived while the panel was busy, to be applied
    // once it is not. Without it the edge is simply dropped, and since the
    // backend fires only on real transitions there is no second chance.
    this._availabilityStale = false;
    // True while a page add/delete/reorder is in flight, so the config_changed
    // the backend fires mid-operation is ignored rather than raced against.
    this._pageOpInFlight = false;
    this._haComponentsLoaded = false;
    this._serviceIconsCache = null;
    this._iconDefaults = null;
    this._palette = null;
    this._sliderControls = [];
    this._internalCommands = [];
    this._labels = {};

    // Sequence state
    this._sequence = [];
    this._editorEl = null;

    // config_changed bookkeeping — see `_onConfigChanged`.
    this._selfSaveEchoUntil = 0;
    this._pendingConfigReload = false;
  }

  connectedCallback() {
    console.log("[LIZA] connectedCallback, initialized:", this._initialized, "hass:", !!this._hass);
    this._a11yInit();
    // Re-init when HA re-attaches the panel after navigation
    if (this._initialized && this._hass) {
      this._initialized = false;
      this._init();
    }
  }

  disconnectedCallback() {
    this._a11yStop();
    // The subscription outlives the element otherwise, and its callback would
    // keep re-rendering a panel that is no longer in the document.
    if (this._configChangedUnsub) {
      Promise.resolve(this._configChangedUnsub).then(u => u && u()).catch(() => {});
      this._configChangedUnsub = null;
    }
    if (this._helloUnsub) {
      Promise.resolve(this._helloUnsub).then(u => u && u()).catch(() => {});
      this._helloUnsub = null;
    }
    if (this._availabilityUnsub) {
      Promise.resolve(this._availabilityUnsub).then(u => u && u()).catch(() => {});
      this._availabilityUnsub = null;
    }
    // These two hang off `document` and the shared connection rather than off
    // the element, so nothing detaches them on their own — a removed panel
    // would keep refetching the device list for the life of the page.
    if (this._missedEdgeUnwatch) {
      this._missedEdgeUnwatch();
      this._missedEdgeUnwatch = null;
    }
  }

  /**
   * Follow backend-side changes to the current device's buttons.
   *
   * A dynamic refresh — from the Sonos push signal, a navigation or the
   * refresh service — rewrites assignments in the store and pushes them to the
   * remote. Without this the panel keeps painting whatever it read when it
   * opened, so the device shows the new favourites while the panel still shows
   * the old ones until something forces a reload.
   */
  async _subscribeConfigChanged() {
    if (this._configChangedUnsub || !this._hass?.connection) return;
    try {
      this._configChangedUnsub = await this._hass.connection.subscribeEvents(
        (ev) => this._onConfigChanged(ev),
        "lizaip_config_config_changed",
      );
    } catch (e) {
      // Live updates are a convenience; the refresh control still works.
      console.debug("[LIZA] config_changed subscription failed:", e);
    }
  }

  /**
   * Follow the handshake, so a remote can change its own face while on screen.
   *
   * `config_changed` does not cover this: it only fires from a hello when the
   * dynamic bindings actually moved, and a device reporting its SKU for the
   * first time usually moves nothing. Without its own subscription the panel
   * would keep drawing the shipped default geometry until it was reopened.
   */
  async _subscribeDeviceHello() {
    if (this._helloUnsub || !this._hass?.connection) return;
    try {
      this._helloUnsub = await this._hass.connection.subscribeEvents(
        (ev) => this._onDeviceHello(ev),
        "lizaip_device_hello",
      );
    } catch (e) {
      console.debug("[LIZA] device_hello subscription failed:", e);
    }
  }

  async _onDeviceHello(ev) {
    if (!this._currentEntry || ev?.data?.entry_id !== this._currentEntry) return;
    if (this._loading) return;
    // Re-rendered only on a real change: every reconnect lands here, and the
    // usual case is a device whose model the backend already knew. Safe to run
    // mid-edit, unlike `_reloadFromBackend` — nothing the user has typed lives
    // in the blueprint, so there is no unflushed state to discard.
    if (await this._refreshBlueprint()) this._render();
  }

  /**
   * Follow the device's connection, so the online badge is not a snapshot.
   *
   * `_listDevices` runs once, during `_init`, and `available` is read from the
   * backend at that moment. A panel opened while Home Assistant was restarting,
   * or while the remote was reconnecting, went on showing *Offline* for a device
   * that had been back for hours — nothing refetched the list.
   *
   * Both edges matter, so this listens for the availability event rather than
   * the hello, which only fires on the way up.
   *
   * Subscribed *before* the list is fetched, not after. The other way round
   * leaves a window the width of the whole initial load in which a device can
   * connect unobserved: the snapshot says offline, and the event that would
   * have corrected it had no listener yet.
   */
  async _subscribeAvailability() {
    if (this._availabilityUnsub || !this._hass?.connection) return;
    try {
      this._availabilityUnsub = await this._hass.connection.subscribeEvents(
        (ev) => this._onAvailabilityChanged(ev),
        "lizaip_device_availability",
      );
    } catch (e) {
      console.debug("[LIZA] availability subscription failed:", e);
    }
  }

  async _onAvailabilityChanged(ev) {
    // Not filtered by `_currentEntry` the way the other two handlers are: every
    // remote is on the list, not just the selected one. A bare event with no
    // entry_id says nothing about any of them.
    //
    // Nor is it filtered against the list before refetching. Comparing first
    // looks cheaper, but it silently drops the two cases that matter most — an
    // event for a device the list has not learned about yet, and one that
    // arrives while the list is stale for some other reason. The refresh below
    // is the one that decides whether anything actually changed, and it does so
    // against the backend rather than against a snapshot.
    if (!ev?.data?.entry_id) return;
    await this._refreshAvailability();
  }

  /**
   * Re-read the device list and repaint only if a badge would actually move.
   *
   * Every path that suspects it has missed an edge comes through here, so the
   * decision to repaint lives in one place. Repainting unconditionally would
   * be wrong on the busy paths: the tab-visibility and reconnect hooks below
   * fire on ordinary use, and a re-render mid-edit for no reason is a worse
   * bug than the stale badge this is fixing.
   */
  async _refreshAvailability() {
    // Mid-load the list is about to be replaced anyway, and `_loadAll` does not
    // fetch it — so the edge is remembered rather than dropped, and flushed
    // once the load that displaced it is done.
    if (this._loading || !this._initDone) {
      this._availabilityStale = true;
      return;
    }
    const devices = await this._fetchDevices();
    // A failed refetch is not evidence that every remote went away.
    if (!devices) return;

    const before = this._availabilityKey(this._devices);
    this._devices = devices;
    if (this._availabilityKey(devices) !== before) this._render();
  }

  _availabilityKey(devices) {
    return (devices || []).map(d => `${d?.entry_id}:${d?.available ? 1 : 0}`).join(",");
  }

  /** Apply an edge that arrived while the panel was busy. */
  _flushAvailability() {
    if (!this._availabilityStale) return;
    this._availabilityStale = false;
    this._refreshAvailability();
  }

  /**
   * Catch up on edges that were never delivered at all.
   *
   * The event is the only thing correcting the badge, so anything that stops it
   * reaching us freezes the badge permanently — there is no second delivery and
   * no periodic poll. Two ordinary situations do exactly that:
   *
   * * Home Assistant's frontend connection drops and re-establishes. It
   *   resubscribes on its own, but whatever the device did in between is gone.
   * * The tab is backgrounded — a phone left overnight — and the browser stops
   *   servicing it. It comes back showing yesterday's badge.
   *
   * Both end with a moment where the panel is live again and its list is not,
   * which is precisely when to ask once. Cheap, and silent unless a badge moved.
   */
  _watchForMissedEdges() {
    if (this._missedEdgeUnwatch) return;
    const catchUp = () => {
      if (document.visibilityState !== "hidden") this._refreshAvailability();
    };
    document.addEventListener("visibilitychange", catchUp);

    let dropReady = () => {};
    try {
      const conn = this._hass?.connection;
      if (conn?.addEventListener) {
        conn.addEventListener("ready", catchUp);
        dropReady = () => { try { conn.removeEventListener("ready", catchUp); } catch (e) {} };
      }
    } catch (e) {
      console.debug("[LIZA] connection-ready hook unavailable:", e);
    }

    this._missedEdgeUnwatch = () => {
      document.removeEventListener("visibilitychange", catchUp);
      dropReady();
    };
  }

  async _onConfigChanged(ev) {
    const entryId = ev?.data?.entry_id;
    // An event with no entry_id is not "ours by default": the backend fires a
    // bare `{}` when it cannot resolve the device (`build_full_config_payload`),
    // which carries no config and says nothing about this entry. Treating it as
    // a match reloaded every open panel — and, now, could defer a reload that
    // was never asked for. `panel.py` already ignores these; match it.
    if (!this._currentEntry || entryId !== this._currentEntry) return;
    if (this._loading) return;

    // A page add/delete/reorder fires this event from the backend *before* it
    // answers the request that caused it, so the handler would otherwise run
    // against a _currentPageIdx that is about to change: its _loadAssignments
    // would resolve after the operation had already switched pages and publish
    // the previous page's buttons as the new page's. Dropped rather than
    // deferred — the operation reloads everything it touches and renders
    // itself, so there is nothing left for a deferred reload to apply.
    if (this._pageOpInFlight) return;

    // Our own saves come back to us: `ws_save_actions` and
    // `ws_save_assignments` both fire this event, so every autosave arrives
    // here a round-trip later. Answering it with `_render()` is what made the
    // action editor uneditable — a full render replaces the shadow root and
    // `_mountEditor` builds a *new*, collapsed `ha-automation-action`, so the
    // editor was torn down roughly half a second after every keystroke.
    //
    // The old guard (`this._autoSaveTimer`) could not catch this. The timer is
    // set to null when it *fires*, before `_globalSave` is even called, so it
    // is already null by the time the echo lands. `_markSelfSave` closes that
    // gap by anchoring the window on the save itself, on both sides of the
    // round-trip.
    if (Date.now() < this._selfSaveEchoUntil) return;

    // A genuine external change — a Sonos push refresh, another browser tab —
    // while the user is mid-edit. Deferred rather than dropped, and deferred
    // rather than applied: `_reloadFromBackend` replaces `this._assignments`
    // wholesale, so applying it now would discard edits the debounced save has
    // not flushed yet, on top of destroying the editor.
    if (this._isEditingLive()) {
      this._pendingConfigReload = true;
      return;
    }

    await this._reloadFromBackend();
  }

  /**
   * Is there an editor on screen that a full re-render would destroy?
   *
   * Deliberately broad. `_autoSaveTimer` means keystrokes are still unflushed;
   * a selected button means the config card — and its `ha-automation-action` —
   * is mounted; an expanded action row is the Actions tab's equivalent. The
   * cost of a false positive is a refresh delayed until the user closes the
   * editor, which `_flushPendingConfigReload` then applies.
   */
  _isEditingLive() {
    if (this._autoSaveTimer) return true;
    if (this._activeTab === "actions") return this._editingActionIdx >= 0;
    return this._selectedButtonIdx >= 0;
  }

  /**
   * Apply a deferred external change now that nothing is being edited.
   *
   * Called from every path that closes an editor. Safe to call unconditionally:
   * it is a no-op unless something was actually deferred.
   */
  _flushPendingConfigReload() {
    if (!this._pendingConfigReload || this._isEditingLive() || this._loading) return;
    this._reloadFromBackend();
  }

  async _reloadFromBackend() {
    // Nothing to reload against once the user is back on the device list, and
    // the loaders would ask the backend for a null entry_id. `_goBack` leaves
    // the flag set on purpose — `_selectDevice` is what resets it — so this is
    // where the dangling request is dropped.
    if (!this._currentEntry) {
      this._pendingConfigReload = false;
      return;
    }
    // Any reload satisfies a deferred one, whatever asked for it. The Actions
    // tab can close its editor without going through a flush site
    // (`_deleteAction`), so without this the flag could outlive its reason.
    this._pendingConfigReload = false;
    try {
      // Inactive thumbnails are drawn entirely from _pageCache, so the map is
      // updated entry by entry as the reload answers rather than dropped up
      // front: a render landing mid-reload would otherwise draw every other
      // page as empty. `refresh` is what still makes a backend-side change to
      // a page the user is not looking at show up — it re-reads instead of
      // trusting the entry it is about to replace.
      await this._loadAssignments();
      await this._loadGlobalUsage(true);
      // The face can change under an open panel — a device that reports its SKU
      // for the first time is answered with the default geometry until then —
      // and this is the one path every external change funnels through. Cheap
      // because `_refreshBlueprint` only reports a change when there is one;
      // the `_render` below is happening regardless.
      await this._refreshBlueprint();
      this._render();
    } catch (e) {
      // The panel is now showing config it knows to be stale. Put the request
      // back so the next flush point retries it, rather than leaving the user
      // to notice and hit refresh themselves.
      this._pendingConfigReload = true;
      console.debug("[LIZA] config_changed reload failed:", e);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass) return;
    if (this._editorEl) this._editorEl.hass = this._editorHass();
    if (!this._initialized) {
      this._initialized = true;
      this._lastThemeMode = this._getThemeMode();
      this._init();
    } else if (this._loading) {
      return;
    } else {
      const mode = this._getThemeMode();
      if (this._lastThemeMode !== mode) {
        this._lastThemeMode = mode;
        this._render();
      } else if (this._activeTab === "buttons") {
        this._refreshButtonIcons();
      } else if (this._activeTab === "actions") {
        this._refreshActionIcons();
      }
    }
    if (!this._loading) this._refreshSVGIcons();
  }
  set narrow(n) { this._narrow = n; }
  set panel(p) { this._panel = p; }

  /**
   * Load the debug view, if this build carries it.
   *
   * The debug tooling is stripped from a stable release, so both halves can be
   * missing: the backing WebSocket commands and this module. The backend is
   * asked first -- a module that loaded without commands behind it would offer
   * a tab that only produces "unknown command" -- and the import is dynamic
   * because a static one would take the whole panel down with a file that is
   * not there.
   */
  async _loadDebugTools() {
    try {
      const features = await this._hass.callWS({ type: "lizaip_config/get_features" });
      if (!features?.debug_tools) return;
      const mod = await import("./liza-remote-debug-view.js");
      Object.assign(LizaRemotePanel.prototype, mod.DebugViewMixin);
      this._debugTools = true;
    } catch (e) {
      console.debug("[LIZA] debug tools unavailable:", e);
    }
  }

  async _init() {
    try {
      console.log("[LIZA] _init starting...");
      this._initDone = false;
      // Before anything is fetched, so no edge falls into the gap between the
      // list being read and the listener existing. The handler defers whatever
      // arrives before `_initDone`, and the flush at the end applies it.
      await this._loadDebugTools();
      await this._subscribeAvailability();
      this._watchForMissedEdges();
      this._loadHaComponents();
      this._fetchServiceIcons();
      this._loadIconDefaults();
      this._loadPalette();
      this._loadInternalCommands();
      // One round-trip, not three. These three fetches share no state and no
      // ordering: each writes its own field and swallows its own failure, so
      // running them in sequence bought nothing and cost two extra serialised
      // round-trips before anything — the blueprint, the device list, every
      // button image — could start loading.
      //
      // `_loadSliderControls` is still awaited here rather than left to float:
      // the entity picker's domain filter and the capability <select> cannot
      // render correctly without the table. Awaiting it *alongside* the others
      // keeps that guarantee while making it free — the cost is now the slowest
      // of the group rather than their sum.
      //
      // `_loadActionLabels` is awaited for the same reason: the first render
      // prints button names, and `_getActionLabel` degrades to a title-cased
      // key until the table arrives. Unawaited, a fresh panel would flash the
      // bare key wording and only then settle on the translated one.
      // `_loadLabels` likewise: a label-targeted button is named after its
      // label, and would flash its entity's name until the registry landed.
      //
      // Unlike the four above, which are deliberately not awaited at all
      // because nothing in the first render depends on them.
      await Promise.all([
        this._loadSliderControls(),
        this._loadActionLabels(),
        this._loadLabels(),
        this._loadBlueprint(),
        this._listDevices(),
      ]);
      console.log("[LIZA] blueprint:", this._blueprint?.name, "buttons:", this._blueprint?.buttons?.length);
      console.log("[LIZA] devices:", this._devices?.length, this._devices);

      const urlParams = new URLSearchParams(window.location.search);
      const requestedEntry = urlParams.get('entry_id');

      if (requestedEntry && this._devices.some(d => d.entry_id === requestedEntry)) {
        this._currentEntry = requestedEntry;
        await this._loadAll();
      } else if (this._devices.length === 1) {
        this._currentEntry = this._devices[0].entry_id;
        await this._loadAll();
      }

      // A tab from the URL, for a deep link written by hand or bookmarked --
      // the device page's own link deliberately lands on the default tab.
      // Only with a device selected -- the tabs do not exist on the device
      // list -- and "debug" only where the build has it, which a stable
      // release does not: an unknown tab would otherwise render an empty panel
      // with no tab highlighted. Read after _loadDebugTools, which _init
      // awaits before any of this.
      const requestedTab = urlParams.get("tab");
      if (this._currentEntry && (requestedTab === "actions" || requestedTab === "settings"
          || (requestedTab === "debug" && this._debugTools))) {
        this._activeTab = requestedTab;
        // Opening straight onto the debug tab from a link is an entry too, and
        // `_switchTab` never runs for it.
        if (requestedTab === "debug") this._enterDebugTab?.();
      }
      console.log("[LIZA] _init done, currentEntry:", this._currentEntry, "pages:", this._pages?.length);
      this._render();
      this._subscribeConfigChanged();
      this._subscribeDeviceHello();
      this._initDone = true;
      this._flushAvailability();
    } catch (e) {
      console.error("[LIZA] _init failed:", e);
      // This replaces the whole shadow tree, so no --liza-* token resolves
      // here. No literal red clears 1.4.3 on both themes, so the theme's own
      // body colour is used and the label carries the error (1.4.1).
      this.shadowRoot.innerHTML = `<p style="padding:16px;color:var(--primary-text-color,#212121);"><strong>lizaIP panel error:</strong> ${this._esc(String(e && e.message || e))}</p>`;
    }
  }

  // =================== PROPERTIES ===================
  // `0` is not a legal page_id (PROTOCOL.md §3 — reserved to mean "no page"),
  // so return null when there is no current page rather than a bogus id.
  get _currentPageId() { return this._pages[this._currentPageIdx]?.id ?? null; }
  get _selectedButton() {
    if (this._selectedButtonIdx < 0 || !this._blueprint) return null;
    return this._blueprint.buttons[this._selectedButtonIdx] || null;
  }

  // =================== EDIT SLOT ===================
  // Where an edit to `key` currently lands: the page's own assignment map, or
  // the override table nested under the context button.
  //
  // Every read and write of the *selected* button's record goes through these
  // three, so "am I editing a default or an override?" is answered in one
  // place. The alternative — each call site testing `_contextKey` for itself —
  // is the same shape of mistake that shipped three bugs on this branch, where
  // one rule lived in two implementations and they disagreed.
  //
  // A key with no nested form (a grid button, either slider) always lands in
  // the page map, whatever the context is. That is the same scoping guard
  // `resolve_fixed_action` needs on the other side, and for the same reason:
  // these take any key.

  // The container holding `key`'s record, or null when the context is set but
  // its button has gone (a page switch mid-edit, an unassign-all).
  _editContainer(key, { create = false } = {}) {
    const contextKey = this._liveContextKey();
    if (!contextKey || !OVERRIDABLE_FIXED_BUTTONS.has(key)) return this._assignments;
    const ctx = this._assignments[contextKey];
    if (!ctx) return null;
    if (!ctx.overrides) {
      if (!create) return null;
      // Created lazily, on the first write only. An empty table is dropped by
      // both writers before it can reach disk, so a stray one here is harmless
      // — but not creating it on a read keeps `hasOverride` honest about what
      // the user has actually configured.
      ctx.overrides = {};
    }
    return ctx.overrides;
  }

  // The record being edited for `key`, or undefined. Read-only: opening a card
  // must never write, which is what stops merely selecting a fixed button under
  // a context from creating an override the user did not ask for.
  _editAssign(key) {
    return this._editContainer(key)?.[key];
  }

  // The record being edited for `key`, created if absent. The write path.
  _editAssignEnsure(key) {
    const container = this._editContainer(key, { create: true });
    if (!container) return {};
    return container[key] || (container[key] = {});
  }

  // Drop the record entirely, and prune an override table that empties with it
  // — deletion is the spelling of "inherited", so a table left behind holding
  // nothing would make `hasOverride` claim an override that is not there.
  _editAssignDelete(key) {
    const container = this._editContainer(key);
    if (!container) return;
    delete container[key];
    const contextKey = this._liveContextKey();
    const ctx = contextKey ? this._assignments[contextKey] : null;
    if (ctx?.overrides && Object.keys(ctx.overrides).length === 0) delete ctx.overrides;
  }

  // Is the selected button currently being edited as an override rather than as
  // its own page default? The question the card header and the ✕ both ask.
  _editingOverride(key) {
    return !!this._liveContextKey() && OVERRIDABLE_FIXED_BUTTONS.has(key);
  }

  // The context, but only if it is still one.
  //
  // `_contextKey` records a choice the user made, and the button under it can
  // stop qualifying while it is held: its action can be cleared, its whole
  // record can be unassigned. The staleness test is `_mayBeContext` itself
  // rather than a second predicate, because a second predicate is how this
  // branch produced three bugs — and `_mayBeContext` already answers for a
  // missing record and a blank one alike.
  //
  // The bug this closes: clearing the context button's action left its record
  // behind, so the edit slot still found it, created an override table under it
  // and persisted an override onto a button `_record_selection` can never
  // select. It saved, it showed in the card as configured, and it could never
  // fire. `_editContainer`'s existing guard did not catch it because the record
  // had not gone — it had merely stopped meaning anything.
  //
  // The overrides themselves are deliberately left in place. The store keeps an
  // overrides-only button for exactly this reason: clearing an action and
  // picking another must not destroy the overrides hanging off it. Re-assigning
  // makes this context live again and they work as they did.
  _liveContextKey() {
    return this._contextKey && this._mayBeContext(this._contextKey)
      ? this._contextKey
      : null;
  }

  // =================== DISPLAY SLOT ===================
  // There isn't one, deliberately. The face reads `_editAssign` directly, the
  // same slot the card reads, so "what is configured for this key right now" has
  // one owner rather than a display copy that can drift from the edit copy.
  //
  // A read-side twin of `resolve_fixed_action` was written here first — the face
  // showing what a *press* would do, falling back to the page default when the
  // context declares no override. It was wrong for this surface: the card offers
  // that same slot as empty, so the face was drawing a configured-looking tile
  // for a slot with nothing in it. The face is a config view; `_faceMark`'s
  // `inheritable` is where "and this one falls back to the page default" is said.

  // Forget a context that has stopped qualifying, so the face and the card stop
  // showing a selection that no longer exists. The edit slot is already safe
  // without this — it reads through `_liveContextKey` — but leaving the stale
  // key set would keep the grid button highlighted and the card in override
  // mode, which is the panel telling the user something untrue.
  _revalidateContext() {
    this._contextKey = this._liveContextKey();
  }

  // May this button become the context whose overrides are edited? One owner,
  // called by every site that sets `_contextKey`, so they cannot drift.
  //
  // A grid button, and *configured*: an override says "when this button is the
  // selection, the fixed controls do something else", and a blank button is
  // never the selection — `_record_selection` only records a button it
  // dispatched an action for. Offering overrides on a blank button would build
  // config that can never fire, and light the face up for a button that does
  // nothing.
  //
  // A button carrying *only* an override table is blank by this test, and that
  // is deliberate rather than an oversight. The store keeps such a button so
  // that clearing an action does not silently destroy the overrides hanging off
  // it, which is a question about preserving data; this is a question about
  // behaviour, and the backend's `may_be_context` answers it the same way.
  _mayBeContext(key) {
    return isGridBtn(key) && isConfigured(this._assignments?.[key]);
  }

  _refreshActionIcons() {
    // Actions tab: no entity context, show default service icon (no-op)
  }

  // =================== INTERACTIONS ===================
  _selectDevice(entryId) {
    this._currentEntry = entryId;
    this._editingActionIdx = -1;
    this._selectedButtonIdx = -1;
    this._contextKey = null;
    this._pageTitleSelected = false;
    this._editorEl = null;
    this._pageCache = {};
    this._globalUsageDetails = {};
    // Every debug reading belongs to the device being left. A probe result or
    // a log-port state carried across would describe the wrong remote — and
    // the port toggle would offer to switch off a stream on a device it was
    // never started for.
    this._debugProbe = null;
    this._debugReport = null;
    // Cleared to null rather than kept: these are one device's log levels, and
    // showing them under another would invite a change aimed at the wrong
    // remote. Null also makes the tab read them again for the device now shown.
    this._debugLogging = null;
    this._debugLoggingError = null;
    this._debugPretty = {};
    this._debugOpen = {};
    this._debugSectionBusy = {};
    this._debugPortOn = false;
    this._debugPortKnown = false;
    this._debugPortFollowing = null;
    this._debugProbeError = null;
    this._debugReportError = null;
    this._debugPortError = null;
    // Both belong to the device being left: the window marks a save *we* made
    // on it, and the deferral a change to it. Neither says anything about the
    // device being selected, and keeping them would suppress or misapply its
    // first events.
    this._selfSaveEchoUntil = 0;
    this._pendingConfigReload = false;
    this._sequence = [];
    this._pagesEditMode = false;
    this._actionFilter = "";
    this._pages = [];
    this._actions = [];
    this._assignments = {};
    this._currentPageIdx = 0;
    this._loading = true;
    this._loadAll().then(() => {
      this._loading = false;
      this._render();
      // `_loadAll` fetches the selected remote's config, not the device list,
      // so an edge that arrived during the switch is still unapplied here.
      this._flushAvailability();
    });
  }

  _goBack() {
    this._flushAutoSave();
    this._currentEntry = null;
    this._editingActionIdx = -1;
    this._selectedButtonIdx = -1;
    this._contextKey = null;
    this._pageTitleSelected = false;
    this._editorEl = null;
    this._render();
  }

  _switchTab(tab) {
    this._flushAutoSave();
    this._activeTab = tab;
    if (tab === "buttons") {
      this._editingActionIdx = -1;
    } else if (tab === "actions") {
      this._loadGlobalUsage().then(() => this._render());
    } else if (tab === "debug") {
      this._enterDebugTab?.();
    } else if (tab === "settings") {
      this._enterSettingsTab();
    }
    this._editorEl = null;
    this._render();
    this._flushPendingConfigReload();
  }

  async _navigateToButton(pageIdx, buttonKey) {
    if (pageIdx !== this._currentPageIdx) {
      await this._switchPageTo(pageIdx);
    }
    const btnIdx = this._blueprint.buttons.findIndex(b => b.key === buttonKey);
    if (btnIdx < 0) return;
    this._activeTab = "buttons";
    this._editingActionIdx = -1;
    this._selectedButtonIdx = btnIdx;
    // Same reset `_selectButton` does, for the same reason: the card this
    // opens replaces Page Settings.
    this._pageTitleSelected = false;
    const btn = this._blueprint.buttons[btnIdx];
    // Arrived at from the usage list, which only ever names page defaults —
    // an override belongs to a grid button, not to a page slot — so this drops
    // any context rather than navigating into a nested state nothing linked to.
    this._contextKey = this._mayBeContext(btn.key) ? btn.key : null;
    const assign = this._editAssign(btn.key);
    this._sequence = assign?.config ? [...assign.config] : [];
    this._editorEl = null;
    this._render();
    requestAnimationFrame(() => {
      const selected = this.shadowRoot.querySelector(".button-row.selected");
      if (selected) selected.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  _selectButton(idx) {
    this._flushAutoSave();
    // The title row belongs to the Page Settings card, which this click is
    // about to replace. Left set, deselecting the button later would reopen
    // Page Settings already spelled out — a title row nobody asked for, from a
    // click two gestures ago.
    this._pageTitleSelected = false;
    const closing = this._selectedButtonIdx === idx;
    // Captured before the render that destroys it: the shape or row you
    // pressed is where focus belongs again once the card closes.
    if (!closing) this._a11yRememberTrigger();
    if (closing) {
      this._selectedButtonIdx = -1;
      this._editorEl = null;
      this._sequence = [];
      // Re-clicking the context button deselects it *and* drops the context —
      // one gesture, because the two were set by one gesture. Deselecting a
      // fixed button leaves the context alone, so you can edit one override
      // after another without re-selecting the grid button each time.
      if (this._blueprint?.buttons[idx]?.key === this._contextKey) this._contextKey = null;
    } else {
      this._selectedButtonIdx = idx;
      const btn = this._blueprint.buttons[idx];
      // Clicking a grid button makes it the context, if it may be one. Clicking
      // a fixed button leaves the context exactly where it is — that survival
      // is what makes the nested state reachable at all.
      //
      // An unconfigured grid button clears the context rather than leaving the
      // previous one standing: it cannot be a context itself, and keeping the
      // old one would leave the face marked for a button you are no longer
      // looking at.
      if (isGridBtn(btn.key)) this._contextKey = this._mayBeContext(btn.key) ? btn.key : null;
      // Read through the edit slot, not `this._assignments[key]`: under a
      // context an override's steps do not live there, and loading the page
      // default into the editor would show the wrong config and then overwrite
      // the override with it on the first keystroke.
      const assign = this._editAssign(btn.key);
      this._sequence = assign?.config ? [...assign.config] : [];
      this._editorEl = null;
    }
    const listCard = this.shadowRoot?.querySelector(".button-list-card");
    const scrollTop = listCard?.scrollTop || 0;
    this._render();
    const btnName = this._a11yButtonName(this._blueprint?.buttons[idx]?.key);
    this._a11yEditorToggled(
      this._selectedButtonIdx >= 0,
      this._tNamed("a11y_editing", btnName),
      this._tNamed("a11y_editor_closed", btnName),
    );
    // Deselecting closes the config card, which is the moment an external
    // change deferred during the edit can safely land. A no-op when a button is
    // still selected — `_isEditingLive` says so.
    this._flushPendingConfigReload();
    requestAnimationFrame(() => {
      const card = this.shadowRoot?.querySelector(".button-list-card");
      if (card) card.scrollTop = scrollTop;
      const selectedRow = this.shadowRoot?.querySelector(".button-row.selected");
      if (selectedRow) selectedRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const editorCard = this.shadowRoot?.querySelector(".editor-card");
      if (editorCard) setTimeout(() => editorCard.scrollIntoView({ behavior: "smooth", block: "nearest" }), 150);
    });
  }

  _onSequenceChanged(ev) {
    ev.stopPropagation();
    const value = ev.detail?.value;
    if (!Array.isArray(value)) return;
    this._sequence = value.length > 0 ? [value[0]] : [];
    if (this._editorEl && this._editorEl.actions !== this._sequence) {
      this._editorEl.actions = this._sequence;
    }
    if (this._editorEl) this._enforceSingleAction(this._editorEl);
    this._commitCurrentToAssignment();
    this._scheduleAutoSave();
    this._refreshSVG();

    // The card's Button icons and Slider sections are derived from the button's
    // *entity*, which is picked inside this editor — so adding an action to an
    // empty button left them missing until the button was reselected.
    //
    // Gated on the *resolved target entity* rather than fired on every event.
    // This handler runs on each keystroke inside the editor, and if the entity
    // has not changed then nothing entity-derived can have: rebuilding would be
    // wasted work and would move focus around inside the rebuilt subtree for no
    // reason. The corollary matters as much as the obvious case — repointing an
    // already-configured button at a *different* entity must refresh too, not
    // just going from none to one — so this compares values instead of testing
    // for emptiness. Losing the entity (-> "") is a change like any other, and
    // the sections disappear.
    const entity = this._entityOfSelectedButton();
    if (entity !== this._lastSectionsEntity) {
      this._lastSectionsEntity = entity;
      this._refreshButtonEntitySections();
    }
  }

  // The entity the selected button currently resolves to, or "" for none.
  // Normalised to a string so the change test never compares null to undefined
  // and reports a change that did not happen.
  _entityOfSelectedButton() {
    const btn = this._selectedButton;
    if (!btn) return "";
    const assign = this._editAssign(btn.key);
    if (!assign?.config) return "";
    return this._getTargetEntityFromConfig(assign.config) || "";
  }

  _commitCurrentToAssignment() {
    const btn = this._selectedButton;
    if (!btn) return;
    const existing = this._editAssign(btn.key) || {};
    // The label input is pre-filled with the *auto* label, so its value is only
    // meaningful once the user has actually typed in it (_labelEdited).
    const nameInput = this.shadowRoot?.querySelector(".config-label-input");
    const customName = existing._labelEdited ? (nameInput?.value?.trim() || "") : "";
    // Emptying the field names nothing, so it hands the button back to the
    // derived label instead of claiming a blank one — the same release ↺ does.
    const labelCleared = !!existing._labelEdited && !customName;
    if (labelCleared) delete existing.label_edited;
    // A label typed in an earlier session is just as much the user's as one
    // typed a moment ago, but `_labelEdited` does not survive a reload —
    // `label_edited` is the stored half of the same fact. Without it, picking a
    // new action for the button below re-derived `label` and silently threw a
    // label the user typed last week away.
    const typedName = customName || (existing.label_edited ? existing.label : "");

    if (!this._sequence.length) {
      // No action in editor — only update label if needed
      if (customName || labelCleared) {
        existing.label = customName;
        if (customName) existing.label_edited = true;
        this._editAssignEnsure(btn.key);
        const target = this._editAssign(btn.key);
        Object.assign(target, existing);
        // `Object.assign` copies keys, it cannot remove one — the release above
        // only reaches the stored record if we delete it there as well.
        if (labelCleared) delete target.label_edited;
      }
      return;
    }

    // Resolve/create action in library. Matching on the service alone made every
    // play_media button collapse onto the first play_media entry in the library —
    // which is how a button ends up wearing another button's name and artwork.
    const step = this._sequence[0];
    const service = this._stepService(this._sequence);
    let action = this._findMatchingAction(this._sequence);
    if (!action) {
      const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
      action = { id, name: this._deriveActionName(service), service, states: [] };
      if (this._isPayloadService(service)) action.payload_identity = this._payloadIdentity(step.data);
      this._actions.push(action);
    }

    const entity = this._getTargetEntityFromConfig(this._sequence);
    const prevPayload = this._getPayloadDisplay(existing.config);
    const nextPayload = this._getPayloadDisplay(this._sequence);

    existing.action_id = action.id;
    existing.config = this._sequence;

    // Remember what the command's target was called, while it still resolves.
    // The dropdown stores a page id, so once that page is deleted the button
    // could only ever report "Page 3" — a number the user never chose and
    // cannot act on. Written only when the target resolves: a save made while
    // the target is already broken must not overwrite a good remembered name
    // with the id-derived stand-in. A button that stops being an internal
    // command clears it, so a stale hint cannot outlive what it described.
    if (!this._internalCommandProblem(this._sequence, service)) {
      const targetName = this._internalCommandTargetName(this._sequence, service);
      if (targetName) existing.internal_target_name = targetName;
      else delete existing.internal_target_name;
    }

    // Respect an explicitly edited label; otherwise keep the auto label in sync
    // with the payload the user just picked. An empty auto label means we have
    // nothing better to say — keep whatever the layout or the user already set
    // rather than blanking it.
    const autoLabel = this._computeLabel(action, entity, this._sequence);
    existing.label = typedName || autoLabel || existing.label || "";
    if (customName) existing.label_edited = true;

    // An image inherited from a layout (or from a previously selected media item)
    // must not survive a payload change — only a user-pinned one does.
    if (!existing.image_pinned && existing.image && prevPayload?.thumbnail !== nextPayload?.thumbnail) {
      delete existing.image;
    }

    // Written back through the slot so a commit under a context lands in the
    // override table rather than overwriting the page default with it.
    this._editAssignEnsure(btn.key);
    Object.assign(this._editAssign(btn.key), existing);
  }

  /**
   * Find the library entry that describes this exact sequence.
   *
   * For a service that carries its identity in the payload (play_media,
   * select_source, …) the service name alone is not enough — matching on it
   * would hand back a different button's entry, along with its name and icon.
   */
  _findMatchingAction(sequence) {
    if (!sequence.length) return null;
    const step = sequence[0];
    const svc = this._stepService(sequence);
    if (!svc) return null;
    const candidates = this._actions.filter(a => a.service === svc);
    if (!candidates.length) return null;
    if (!this._isPayloadService(svc)) return candidates[0];

    // An empty identity is itself an identity: it means "the generic entry for
    // this service". Returning null here instead would mint a brand-new library
    // entry on every autosave, so a half-configured button quietly filled the
    // library with duplicates. `??` (not `||`) so a stored empty identity is
    // honoured rather than being recomputed from the entry's own config.
    const identity = this._payloadIdentity(step.data);
    return candidates.find(a => (a.payload_identity ?? this._payloadIdentity(a.config?.[0]?.data)) === identity) || null;
  }

  _unassignButton() {
    const btn = this._selectedButton;
    if (!btn) return;

    // Under a context, ✕ means "back to inherited", and deletion is how that is
    // spelled — there is no "Inherited" entry in any dropdown for the same
    // reason. The whole entry goes, not just its action fields: an override is
    // a whole sub-assignment, so a half-cleared one would be an override that
    // says "do nothing" rather than one that says nothing, and those are
    // different behaviours. It also keeps `hasOverride` a presence test.
    if (this._editingOverride(btn.key)) {
      this._editAssignDelete(btn.key);
      this._sequence = [];
      this._scheduleAutoSave();
      this._editorEl = null;
      this._render();
      return;
    }

    const existing = this._editAssign(btn.key);
    if (existing) {
      // ✕ means "clear this button", once. It used to work down a list of
      // fields and keep a pinned image — and the icon picker pins every icon it
      // writes, so a chosen icon could not be cleared here at all: on a button
      // that had only an icon ✕ visibly did nothing, and on one that had an
      // action too it dropped the action and left the icon behind for good.
      // There is no reading of one ✕ on one card under which that is what the
      // user asked for.
      //
      // A whitelist rather than a longer delete list, because the delete list
      // is what went stale: it never learned about `interactions`,
      // `overrides`/`slider_factor` or the slider's hidden
      // -icon flag, and it would not learn about the next field either. What
      // survives is stated here, and everything else on the record goes by
      // construction.
      //
      // What survives is `overrides`, and only that. They are not this card's
      // settings: they say what the *fixed* controls do while this button is
      // the selection, they are edited from those buttons' own cards, and both
      // `_mayBeContext` and the store's `_is_empty_button` are built to keep an
      // overrides-only button for exactly this reason — clearing an action must
      // not silently destroy them. Scope is this button's record and nothing
      // else: no other button, and nothing on the page.
      //
      // The *frozen* half only. A string override names a capability or service
      // resolved against this button's own slider subject, which ✕ just took
      // away, so keeping one leaves a setting for a retarget that no longer
      // happens and the next device chosen would silently inherit it. A frozen
      // sub-assignment carries its own target and survives on its own terms.
      //
      // `slider_vertical` is excluded by name rather than by shape, and that
      // exclusion is the whole point of naming it. It is a `{entity_id,
      // control}` block, so it *is* an object and would sail through the shape
      // test -- but it is not a frozen sub-assignment, it is this button's own
      // retarget, and the subject it names is precisely what ✕ was asked to
      // take away. Keeping it would leave a cleared button still pointing the
      // page's slider at a device, which is the one outcome ✕ must not have.
      const kept = {};
      const frozen = Object.fromEntries(
        Object.entries(existing.overrides || {}).filter(
          ([k, v]) => k !== "slider_vertical" && typeof v === "object" && v,
        ),
      );
      if (Object.keys(frozen).length > 0) kept.overrides = frozen;
      // Explicit null, not absence: the backend inherits a *missing* dynamic
      // key from the stored assignment (so a panel that knows nothing about
      // bindings can't destroy them). Dropping the record is exactly that
      // absence, so a bound button cleared here would be re-filled with its
      // name and payload by the next refresh and come back on its own. The
      // null is therefore kept whatever else survives, and is reason enough on
      // its own to keep the record: `_is_empty_button` drops the entry once the
      // backend has seen the unbind.
      //
      // Presence, not truth: an already-unbound button holds `dynamic: null`,
      // and a truthiness test reads that as nothing to say. It is not — assign
      // an action to such a button and clear it again, and the record would go
      // with the unbind still inside it, letting the merge on the next save
      // inherit the binding from disk all over again.
      if (Object.hasOwn(existing, "dynamic")) kept.dynamic = null;

      // Nothing worth keeping means no record. A record holding only overrides
      // or only the unbind is not "assigned" to any reader — `isConfigured`,
      // `_mayBeContext` and `_isAssignedRecord` all call it blank — so the
      // card, the face and the page's filled count agree with the store either
      // way.
      //
      // Written through `_editContainer` rather than `this._assignments`, which
      // is what it returns on this branch, so that no writer here bypasses the
      // edit slot.
      const container = this._editContainer(btn.key);
      if (Object.keys(kept).length && container) container[btn.key] = kept;
      else this._editAssignDelete(btn.key);
    }
    this._sequence = [];
    this._scheduleAutoSave();
    // The cleared button may have been the context, and is blank now, so a
    // context pointing at it goes with it. `_liveContextKey` would ignore the
    // stale key anyway, but leaving it set keeps the grid button highlighted
    // and the card in override mode — the panel showing a selection that no
    // longer exists.
    this._revalidateContext();
    this._editorEl = null;
    this._render();
  }

  /**
   * Arm a move: the next control clicked on the face receives this button's
   * configuration.
   *
   * A move is two gestures with a state in between, so that state is held and
   * drawn rather than implied. The face marks the armed button; clicking it
   * again, pressing Escape or leaving the page calls it off.
   */
  _beginMove(key) {
    if (!key) return;
    this._disarmMove();
    this._moveSourceKey = key;
    // Escape calls it off from anywhere, which matters because the armed state
    // swallows the next click on the face: without a way out that is not a
    // click, changing your mind means completing a move you did not want.
    window.addEventListener?.("keydown", this._moveKey = (e) => {
      if (e.key === "Escape") this._cancelMove();
    });
    this._render();
  }

  // Drop the armed state without drawing. The two ways out of a move — called
  // off, or carried out — both pass through here so the listener cannot outlive
  // the state it belongs to.
  _disarmMove() {
    if (this._moveKey) {
      window.removeEventListener?.("keydown", this._moveKey);
      this._moveKey = null;
    }
    this._moveSourceKey = null;
  }

  _cancelMove() {
    if (!this._moveSourceKey) return;
    this._disarmMove();
    this._render();
  }

  /**
   * Land the armed button's configuration on `targetKey`, and `targetKey`'s
   * back on it.
   *
   * A swap rather than an overwrite, because a move onto an occupied slot has
   * to do *something* with what was there and the only lossless answer is the
   * empty place the move just made. Onto an empty slot the exchange is a plain
   * move, which is the ordinary case and reads as one.
   *
   * Whole records change hands, not a chosen set of fields. A button's
   * configuration is everything on it — its action, its label, its icon, its
   * `overrides`, its slider retarget — and a move that relocated some of it
   * would leave the rest behind on a button that no longer has the action it
   * qualified.
   */
  _moveButtonTo(targetKey) {
    const sourceKey = this._moveSourceKey;
    this._disarmMove();
    if (!sourceKey || !targetKey || sourceKey === targetKey) { this._render(); return; }

    // Both ends must live in the same container, and the comparison says so
    // directly rather than restating the scoping rules. Under a live context an
    // overridable fixed button resolves to the override table while a grid
    // button resolves to the page map, and carrying a record across that line
    // would change what it *means* — an override is what a control does while
    // one button is selected, a page default is what it does otherwise. The
    // source is resolved without `create`, so a refused move cannot leave an
    // override table behind that the user never asked for.
    const from = this._editContainer(sourceKey);
    const source = from?.[sourceKey];
    if (!source) { this._render(); return; }
    const to = this._editContainer(targetKey, { create: true });
    if (!to || to !== from) {
      this._toast(this._t("different_scope"));
      this._render();
      return;
    }

    const target = to[targetKey];
    // Presence, not truth, exactly as `_unassignButton` reads it: `dynamic:
    // null` is a recorded unbind and a truthiness test would call it nothing.
    const hadDynamic = (rec) => !!rec && Object.hasOwn(rec, "dynamic");
    const sourceBound = hadDynamic(source);
    const targetBound = hadDynamic(target);

    // A slot that was bound and receives a record with nothing to say about
    // bindings must say the unbind out loud. The backend inherits a *missing*
    // `dynamic` key from what is already stored, so a binding left unmentioned
    // here survives on disk and the next refresh refills the button with the
    // name and payload of an item that moved away.
    const land = (rec, wasBound) => {
      if (rec) {
        const next = { ...rec };
        if (wasBound && !Object.hasOwn(next, "dynamic")) next.dynamic = null;
        return next;
      }
      return wasBound ? { dynamic: null } : null;
    };

    const onTarget = land(source, targetBound);
    const onSource = land(target, sourceBound);
    // Read both records before writing either: on the ordinary path `from` and
    // `to` are the same object, so the first write would otherwise be the
    // second's input. An override table cannot empty out from under this — the
    // source always had a record, so something always remains.
    if (onTarget) to[targetKey] = onTarget; else delete to[targetKey];
    if (onSource) from[sourceKey] = onSource; else delete from[sourceKey];

    this._scheduleAutoSave();
    // The configuration moved, so the card must move with it: opening the slot
    // the user just filled is the answer to "where did it go". `_selectButton`
    // toggles, and the target is often the button already open, so the
    // selection is cleared first to make that call a plain select.
    this._selectedButtonIdx = -1;
    const idx = this._blueprint?.buttons?.findIndex(b => b.key === targetKey) ?? -1;
    if (idx >= 0) {
      this._selectButton(idx);
    } else {
      this._revalidateContext();
      this._editorEl = null;
      this._render();
    }
    // After the selection, because `_selectButton` may have made the target the
    // context: the source can have *been* the context and is blank now, and a
    // context pointing at a blank button keeps the face marked for a nesting
    // the executor will never perform.
    this._revalidateContext();
  }

  async _testButton(buttonKey) {
    const testingOverride = this._editingOverride(buttonKey);
    // `_hasRunnableAction`, not `_isAssignedRecord`: an icon-only button is
    // "assigned" enough to show ✕, but there is nothing here to run. The card
    // already hides Test in that case; this is the same rule asked at the point
    // of firing, so any other route to it reports the truth rather than
    // dispatching a click the device drops and toasting success.
    const record = testingOverride ? this._editAssign(buttonKey) : this._assignments[buttonKey];
    if (!this._hasRunnableAction(record)) { this._toast(this._t("no_action_assigned")); return; }
    const deviceId = (this._devices.find(d => d.entry_id === this._currentEntry) || {}).device_id;
    const event = (extra) => this._hass.callApi("POST", "events/lizaip_event", {
      device_id: deviceId, entry_id: this._currentEntry,
      type: "button", page_id: this._currentPageId, ...extra,
    });
    try {
      // Testing an override means testing the pair, so the context is
      // established the way the user would establish it: by touching the grid
      // button first. Anything else would run the page default and report it as
      // the override — the executor resolves against the *device's* selection,
      // which the panel's `_contextKey` does not set. This also leaves the
      // device selected exactly where a real touch would leave it.
      if (testingOverride && this._contextKey) {
        await event({ button_name: this._contextKey, button: this._contextKey, interaction: "touch" });
      } else if (OVERRIDABLE_FIXED_BUTTONS.has(buttonKey)) {
        // ...and testing a page default means testing it with *no* context, so
        // the device's selection has to be cleared first. It is not implied:
        // nothing in the panel clears it, so a selection left behind by an
        // earlier override test (or by "Page default", which only clears the
        // panel's own `_contextKey`) survives on the device. Without this, a
        // second Test on the same fixed button sends no `touch`, the device
        // still holds the old selection, and the *override* runs while the card
        // shows the page default and the toast says "Action executed ✓" —
        // the panel confidently reporting the one thing that did not happen.
        //
        // Spelled as a click on a blank grid button because that is the gesture
        // `_record_selection` already treats as "deselect", rather than by
        // inventing a clear-selection command the device would then have two
        // ways to reach. A blank button dispatches nothing, so the click is
        // inert beyond the clearing. If the page has no blank button there is
        // nothing safe to press, and the test proceeds — the pre-existing
        // behaviour, now the rare case rather than the usual one.
        const blank = (this._blueprint?.buttons ?? [])
          .find(b => isGridBtn(b.key) && !this._mayBeContext(b.key));
        if (blank) {
          await event({ button_name: blank.key, button: blank.key, interaction: "click" });
        }
      }
      await event({ button_name: buttonKey, button: buttonKey, interaction: "click" });
      this._toast(testingOverride ? "Override executed ✓" : "Action executed ✓");
    } catch (e) { this._toast(this._t("failed", { error: e.message || e })); }
  }

  _isButtonAssigned(buttonKey) {
    // Deliberately the *page slot*, not the edit slot. This is the question
    // "does this position on the page do anything", and its answers feed
    // `filledCount` and the `pg-empty` class that makes a blank page look
    // deletable. Reading it through the context would make a page with one
    // override count as filled, and a genuinely blank page undeletable.
    return this._isAssignedRecord(this._assignments[buttonKey]);
  }

  // The same question asked of one record, so the card can ask it about an
  // override without a second copy of the rules drifting from this one.
  //
  // An icon alone counts: the tile shows something, so the slot is not empty
  // and ✕ has something to clear. That is *not* the same question as "does
  // pressing this button run anything" — see `_hasRunnableAction`, which this
  // is defined in terms of so the two cannot answer differently about the parts
  // they share.
  _isAssignedRecord(assign) {
    if (!assign) return false;
    if (assign.image) return true;
    return this._hasRunnableAction(assign);
  }

  // Does this record actually *do* something when the button is pressed?
  //
  // Deliberately everything `_isAssignedRecord` accepts except the image: an
  // icon is appearance, and gating ▶ Test on it offered to run a button that
  // dispatches nothing — the device did nothing while the panel toasted
  // "Action executed ✓".
  _hasRunnableAction(assign) {
    if (!assign) return false;
    if (assign.interactions && Object.keys(assign.interactions).length > 0) return true;
    // Slider mechanics count as an assignment: a proportional slider has no
    // action_id at all, and would otherwise report itself as unconfigured.
    // `mode` must be present — ensureSliderActions() can leave a bare {} behind,
    // which is not yet a configured slider.
    const sa = assign.slider_actions;
    if (sa && sa.mode) return true;
    // The button's own config is what actually runs. Requiring the library entry
    // to exist meant a dangling action_id made the button read as unassigned —
    // which hid its own Test and ✕ controls, so it could not be cleared at all.
    if (Array.isArray(assign.config) && assign.config.length) return true;
    return !!(assign.action_id && this._actions.find(a => a.id === assign.action_id));
  }

  // Assign, or clear, the action a button runs.
  //
  // Every read and write goes through the edit slot, never
  // `this._assignments[btnKey]`. This was the one writer that did not, and it
  // is the writer that matters most: under a context it wrote the *page
  // default* while the card, the badge and the face all reported an override.
  // The override stayed the bare `{}` that `_editAssignEnsure` had scaffolded,
  // and `_sanitize_overrides` drops an empty entry — so the config the user
  // had just written vanished at the save and `button_power` kept doing the
  // page default on the device.
  //
  // The vertical slider hid this for weeks: it needs nothing stored, because
  // absence is how "follow the selection" is spelled. So the one fixed control
  // that worked was the one that never had to survive a save.
  _assignActionToButton(btnKey, actionId) {
    if (!actionId) {
      const assign = this._editAssign(btnKey);
      if (assign) {
        delete assign.action_id;
        delete assign.config;
        // `before` is the prelude belonging to the action just cleared, and
        // `after` its verification. Left behind they survive the save (the WS
        // schema only validates `assignments` as a dict) and resurrect around
        // whatever action is assigned to this slot next.
        delete assign.before;
        delete assign.after;
        // An override earns its place by having an action to run:
        // `_sanitize_override_entry` keeps an entry only for its `action_id`,
        // so once that is gone this record cannot survive the save whatever
        // else it holds. Deleting it — and pruning a table that empties with
        // it — is what keeps `hasOverride` telling the truth in the meantime,
        // since that is a presence test and the bare `{}` left here is truthy
        // in JS. Without this the face reads "overridden" until the next
        // reload silently replaces it with the page default.
        //
        // Unconditional rather than a second emptiness test: `action_id` is
        // the whole of the store's rule, so re-deriving one here is how the
        // panel and the executor drift apart.
        if (this._editingOverride(btnKey)) this._editAssignDelete(btnKey);
      }
    } else {
      const assign = this._editAssignEnsure(btnKey);
      assign.action_id = actionId;
      const action = this._actions.find(a => a.id === actionId);
      if (action && !assign.config) {
        const target = {};
        if (action.service && this._hass) {
          const svcDomain = action.service.split(".")[0];
          if (svcDomain && svcDomain !== "homeassistant") {
            const domainEntities = Object.keys(this._hass.states).filter(e => e.startsWith(svcDomain + "."));
            if (domainEntities.length === 1) target.entity_id = domainEntities[0];
          }
        }
        assign.config = [{ action: action.service, target, data: {} }];
      }
      if (!assign._labelEdited && !assign.label_edited) {
        const entity = assign.config ? this._getTargetEntityFromConfig(assign.config) : null;
        const autoLabel = this._computeLabel(action, entity, assign.config);
        if (autoLabel) assign.label = autoLabel;
      }
    }
    this._scheduleAutoSave();
    this._revalidateContext();
    this._render();
  }

  // =================== PAGES ===================
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
    await this._flushAutoSave();
    const oldPageId = this._pages[this._currentPageIdx]?.id;
    if (oldPageId) this._pageCache[oldPageId] = JSON.parse(JSON.stringify(this._assignments));

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

    // Fire goto_page immediately — before any await/render so it's not delayed by DOM changes
    this._gotoPageOnDevice(newPageId);

    if (this._pageCache[newPageId]) {
      this._assignments = JSON.parse(JSON.stringify(this._pageCache[newPageId]));
    } else {
      await this._loadAssignments();
    }
    // The selection replay renders for itself, so rendering here as well would
    // draw the arrived-at page once with nothing selected and once with the
    // button open — the blink the plain switch does not have.
    if (!selectKey || !this._selectFaceKey(selectKey)) this._render();
    // A deferred external change would have been read straight back out of the
    // stale `_pageCache` above, so the flush has to come after the switch, not
    // before it. The reload re-reads those entries rather than dropping them.
    this._flushPendingConfigReload();
  }

  async _switchPage(dir) {
    await this._switchPageTo(this._currentPageIdx + dir);
  }

  async _addPage() {
    // Show a dialog asking whether to add a blank page or a layout page
    this._showAddPageDialog();
  }

  _showAddPageDialog() {
    const { dlg: overlay, close } = this._openModal(`
      <div class="add-page-dialog">
        <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._t("add_page")}</h2>
        <div class="add-page-dialog-options">
          <button class="add-page-option" data-type="blank" autofocus>
            <ha-icon icon="mdi:file-plus-outline" style="--mdc-icon-size:32px;" aria-hidden="true"></ha-icon>
            <span>${this._t("blank_page")}</span>
            <span class="add-page-option-desc">${this._t("configure_manually")}</span>
          </button>
          <button class="add-page-option" data-type="layout">
            <ha-icon icon="mdi:remote" style="--mdc-icon-size:32px;" aria-hidden="true"></ha-icon>
            <span>${this._t("layout")}</span>
            <span class="add-page-option-desc">${this._t("preconfigured_remote")}</span>
          </button>
        </div>
        <button class="add-page-cancel">${this._t("cancel")}</button>
      </div>
    `, { labelledBy: "liza-dlg-title" });

    overlay.querySelector('[data-type="blank"]').addEventListener("click", () => {
      close();
      this._addBlankPage();
    });
    overlay.querySelector('[data-type="layout"]').addEventListener("click", () => {
      close();
      this._showLayoutPicker();
    });
    overlay.querySelector(".add-page-cancel").addEventListener("click", close);
  }

  async _addBlankPage() {
    // Set by the create step below, which has already said why it failed. The
    // outer catch is for everything *after* the page was written, which has no
    // message of its own — and would otherwise fail silently into the console.
    let toasted = false;
    try {
      await this._createPage(async () => {
        // set_pages replaces the whole list, so the new page is appended
        // locally and the list sent as a whole. Without an id — the backend
        // mints a unique 32-bit one and answers with it.
        this._pages.push({ image: "" });
        try {
          return await this._hass.callWS({
            type: "lizaip_config/set_pages",
            entry_id: this._currentEntry,
            pages: this._pages,
          });
        } catch (e) {
          // If backend rejects, remove the optimistically added page
          this._pages.pop();
          this._toast(this._t("add_page_failed"));
          toasted = true;
          throw e;
        }
      });
    } catch (e) {
      console.error("[LIZA] _addBlankPage failed:", e);
      if (!toasted) this._toast(this._t("add_page_error", { error: e.message || e }));
    }
  }

  async _showLayoutPicker() {
    const layouts = await this._loadLayouts();
    if (!layouts.length) {
      this._toast(this._t("no_layouts"));
      return;
    }

    // One flat grid, deliberately not one grid per category. `.layout-grid`
    // already lays cards out side by side, but grouping defeated it: every
    // shipped layout carries a category of its own (Remote / Lights / Media),
    // so each group held exactly one card and the `1fr` column stretched it
    // across the full dialog — three full-width rows instead of a row of
    // three. Grouping only starts paying for itself with several layouts per
    // category, and the grid reflows on its own until then.
    const cards = [...layouts]
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map(l => `
        <button class="layout-card" data-layout-id="${this._esc(l.id)}">
          ${this._renderIconHtml(l.icon || 'mdi:remote', 36)}
          <span class="layout-card-name">${this._esc(l.name || l.id)}</span>
          <span class="layout-card-desc">${this._esc(l.description || '')}</span>
        </button>
      `).join("");

    const { dlg: overlay, close } = this._openModal(`
      <div class="add-page-dialog layout-dialog">
        <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._t("choose_layout")}</h2>
        <div class="layout-grid">${cards}</div>
        <button class="add-page-cancel">${this._t("cancel")}</button>
      </div>
    `, { labelledBy: "liza-dlg-title" });

    overlay.querySelectorAll(".layout-card").forEach(card => {
      card.addEventListener("click", () => {
        const layoutId = card.dataset.layoutId;
        const layout = layouts.find(l => l.id === layoutId);
        close();
        this._showLayoutEntityPicker(layoutId, layout).catch((e) => {
          console.warn("[LIZA] Layout picker failed:", e);
          this._toast(this._t("layout_picker_failed"));
        });
      });
    });
    overlay.querySelector(".add-page-cancel").addEventListener("click", close);
  }

  /**
   * Ask which device (or hub) a layout should drive.
   *
   * Adding a layout page and moving one to another device ask the very same
   * question under the very same rules, so they share this dialog; only what
   * the confirm button says and does differs. `onConfirm(target, kind)` does
   * the work and returns the toast to show once the dialog is closed.
   */
  async _showLayoutEntityPicker(layoutId, layoutMeta, {
    confirmLabel = this._t("add_layout_page"),
    busyLabel = this._t("adding"),
    onConfirm = async (target, kind) => {
      await this._addLayoutPage(layoutId, target, kind);
      return this._t("layout_added", { name: layoutMeta?.name || layoutId });
    },
  } = {}) {
    const deviceSelector = layoutMeta?.target_selector?.device || null;
    const entrySelector = layoutMeta?.target_selector?.config_entry || null;
    const description = layoutMeta?.description || "";
    const fieldLabel = this._t(entrySelector ? "target_hub" : "target_device");

    const { dlg: overlay, close } = this._openModal(`
      <div class="add-page-dialog layout-dialog">
        <h2 class="add-page-dialog-title" id="liza-dlg-title">
          ${this._renderIconHtml(layoutMeta?.icon || 'mdi:remote', 24)}
          ${layoutMeta?.name || layoutId}
        </h2>
        ${description ? `<p class="layout-dialog-desc">${description}</p>` : ""}
        <div class="layout-entity-picker">
          <label for="liza-layout-target">${fieldLabel}</label>
          <div class="layout-entity-picker-container"></div>
          <!-- Replaced asynchronously with the outcome of a round-trip, which
               moves no focus, so a screen reader would otherwise never hear it. -->
          <p class="layout-entity-hint" role="status" aria-live="polite">${this._t(entrySelector ? "loading_hubs" : "loading_devices")}</p>
        </div>
        <div class="layout-dialog-actions">
          <button class="add-page-cancel">${this._t("cancel")}</button>
          <button class="layout-confirm-btn" disabled>${this._esc(confirmLabel)}</button>
        </div>
      </div>
    `, { labelledBy: "liza-dlg-title" });

    const container = overlay.querySelector(".layout-entity-picker-container");
    const hint = overlay.querySelector(".layout-entity-hint");
    const confirmBtn = overlay.querySelector(".layout-confirm-btn");
    const caption = overlay.querySelector(".layout-entity-picker label");
    let getTarget = () => "";
    const targetKind = entrySelector ? "config_entry" : "device";

    // The device picker and both <select> fallbacks share one contract: append
    // it, enable Add once something is chosen, read the value back on confirm.
    // An HA picker reports the new value on the event; a native <select> does
    // not, so fall back to reading the element. The config-entry field is
    // mounted separately, since it also has to validate what was picked.
    const bindPicker = (el, readValue, eventName = "value-changed") => {
      container.appendChild(el);
      el.addEventListener(eventName, (ev) => {
        const val = ev?.detail && "value" in ev.detail ? ev.detail.value : readValue();
        confirmBtn.disabled = !val;
      });
      getTarget = readValue;
    };

    // An HA control draws the field's name itself, so the caption above it
    // would say the same thing twice. Only the plain <select> fallback, which
    // has no label of its own, keeps it.
    const dropCaption = () => caption?.remove();

    if (!deviceSelector && !entrySelector) {
      // Every shipped layout declares a device or a config-entry selector; the
      // entity selector they replaced is gone. Saying so beats the old
      // behaviour of quietly painting an unfiltered entity picker, which let a
      // layout bind to something none of its actions could service.
      hint.textContent =
        this._t("layout_no_target");
      return;
    }

    // HA's pickers live in the lazily-loaded `config` fragment, and `_init`
    // only kicks that load off without waiting for it. Deciding which field to
    // build without waiting too is a race the user loses by being quick: the
    // element is simply not registered yet, and the dialog silently settles for
    // the plain <select> it falls back to. `_mountEditor` already awaits this
    // for the same reason.
    await this._loadHaComponents();

    if (entrySelector) {
      // Config-entry layouts are bound to one instance of an integration — a
      // Hue bridge — and generate their whole grid from what it owns. The
      // server already returned exactly the eligible ones, so the picker only
      // has to present them.
      const { entries, error } = await this._loadLayoutConfigEntries(layoutId);
      const integration = entrySelector.integration || "";

      if (error) {
        hint.textContent = this._t("hubs_load_failed", { error });
      } else if (!entries.length) {
        hint.textContent = integration
          ? this._t("no_hub_found", { integration })
          : this._t("no_hub_found_generic");
      } else {
        // HA's pickers list every config entry of the integration, including
        // ones the server filtered out. The only entry it offers that we reject
        // is a disabled one, so say that rather than failing later with an
        // empty grid.
        const DISABLED_HUB = this._t("hub_disabled");
        const eligible = new Set(entries.map((e) => e.id));
        // One hub is not a choice. Preselecting it and letting the user press
        // Add beats asking someone to pick from a list of one.
        const only = entries.length === 1 ? entries[0].id : "";
        const chooseHint = only
          ? this._t("hub_every_light")
          : this._t("hub_choose");

        // Mounting is identical for either HA field; they differ only in how a
        // pick is read off the event and written back. Both are uncontrolled --
        // they report a value and expect the owner to hand it back -- so
        // without the write the field snaps to whatever it was first given.
        const mountHaField = (el, readPick, writePick) => {
          dropCaption();
          container.appendChild(el);
          let chosen = only;
          getTarget = () => chosen;
          el.addEventListener("value-changed", (ev) => {
            ev.stopPropagation();
            chosen = readPick(ev) || "";
            writePick(chosen);
            const usable = !chosen || eligible.has(chosen);
            confirmBtn.disabled = !chosen || !usable;
            hint.textContent = usable ? chooseHint : DISABLED_HUB;
          });
          confirmBtn.disabled = !only;
        };

        // Two HA-native ways to render this, tried in order, because which one
        // the frontend has actually loaded is not knowable from here.
        //
        // `ha-config-entry-picker` is HA's purpose-built picker for this exact
        // question and needs only an integration. `ha-form` reaches the same
        // element the long way round, by resolving a `config_entry` selector,
        // and is worth trying second because it is what HA builds its
        // config-flow and automation UIs out of, so it is loaded on many more
        // paths.
        //
        // Naming a single element and trusting it failed twice here, in ways
        // worth recording. `ha-select` is a raw dropdown that must be fed and
        // positioned by hand. `ha-combo-box` is not a custom element at all in
        // this frontend -- the name survives only as an internal module -- so
        // that guard could never pass, and the dialog quietly rendered the
        // browser's <select> while looking like it had chosen otherwise. A
        // ladder degrades one visible step at a time instead.
        if (customElements.get("ha-config-entry-picker")) {
          const picker = document.createElement("ha-config-entry-picker");
          picker.hass = this._hass;
          // It queries HA for the integration's entries itself; ours are used
          // only for the messaging and to reject what the server would.
          picker.integration = entrySelector.integration;
          picker.label = fieldLabel;
          picker.value = only;
          mountHaField(picker, (ev) => ev.detail?.value, (v) => { picker.value = v; });
        } else if (customElements.get("ha-form")) {
          const form = document.createElement("ha-form");
          form.hass = this._hass;
          // Our selector block is already the shape HA's `config_entry`
          // selector expects, `integration` key and all, so it is passed
          // through rather than translated.
          form.schema = [
            { name: "hub", required: true, selector: { config_entry: entrySelector } },
          ];
          form.computeLabel = () => fieldLabel;
          form.data = only ? { hub: only } : {};
          mountHaField(form, (ev) => ev.detail?.value?.hub, (v) => { form.data = { hub: v }; });
        } else {
          // Neither is registered, so the frontend fragment never loaded. A
          // plain select is not pretty, but an element that never upgrades
          // renders as an empty box and would make the layout unaddable.
          const select = document.createElement("select");
          select.className = "layout-device-select";
          // Only this branch keeps the <label>; the HA pickers above drop it
          // (dropCaption) and carry their own `label` instead.
          select.id = "liza-layout-target";
          // Built via the DOM rather than innerHTML: entry titles are user-set
          // and would otherwise need escaping.
          if (!only) {
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = this._t("select_hub");
            select.appendChild(placeholder);
          }
          for (const entry of entries) {
            const opt = document.createElement("option");
            opt.value = entry.id;
            opt.textContent = entry.title;
            select.appendChild(opt);
          }
          bindPicker(select, () => select.value || "", "change");
          select.value = only;
          confirmBtn.disabled = !only;
        }
        hint.textContent = chooseHint;
      }
    } else {
      // Device-mode layouts span several entity domains of one device. The
      // eligible-device list is resolved server-side against the device and
      // entity registries, so the picker only has to present it.
      const { devices, error } = await this._loadLayoutDevices(layoutId);
      const allowed = new Set(devices.map((d) => d.id));

      if (error) {
        hint.textContent = this._t("devices_load_failed", { error });
      } else if (!devices.length) {
        const integration = deviceSelector.integration || "";
        hint.textContent = integration
          ? this._t("no_matching_devices", { integration })
          : this._t("no_matching_devices_generic");
      } else if (customElements.get("ha-device-picker")) {
        const picker = document.createElement("ha-device-picker");
        picker.hass = this._hass;
        picker.label = fieldLabel;
        dropCaption();
        picker.deviceFilter = (device) => allowed.has(device.id);
        // Fallback narrowing in case deviceFilter is unsupported: at minimum
        // only show devices exposing the layout's primary domain.
        if (deviceSelector.primary_domain) {
          picker.includeDomains = [deviceSelector.primary_domain];
        }
        bindPicker(picker, () => picker.value);
        hint.textContent = this._t("choose_layout_device");
      } else {
        // ha-device-picker is not registered in every HA frontend build, and an
        // element that never upgrades renders as an empty box — which would make
        // device-mode layouts impossible to add. The server already returned
        // exactly the eligible devices, so a plain select loses nothing.
        const select = document.createElement("select");
        select.className = "layout-device-select";
        // Only this branch keeps the <label>; ha-device-picker drops it.
        select.id = "liza-layout-target";
        // Built via the DOM rather than innerHTML: device names are user-set
        // and would otherwise need escaping.
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = this._t("select_device");
        select.appendChild(placeholder);
        for (const d of devices) {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.name;
          select.appendChild(opt);
        }
        bindPicker(select, () => select.value, "change");
        hint.textContent = this._t("choose_layout_device");
      }
    }

    confirmBtn.addEventListener("click", async () => {
      const target = getTarget();
      if (!target) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = busyLabel;
      try {
        const done = await onConfirm(target, targetKind);
        close();
        if (done) this._toast(done);
        this._render();
      } catch (e) {
        this._toast(this._t("failed", { error: e.message || e }));
        confirmBtn.disabled = false;
        confirmBtn.textContent = confirmLabel;
      }
    });

    overlay.querySelector(".add-page-cancel").addEventListener("click", close);
  }

  async _deletePage(pageIdx) {
    const idx = pageIdx !== undefined ? pageIdx : this._currentPageIdx;
    const page = this._pages[idx];
    // `_pageLabel`, not `page.image`: `image` is a title-*image* spec and
    // reads back as "mdi:sofa" rather than as a name. The helper strips the
    // scheme, humanises the slug and supplies its own fallback.
    const pageName = this._pageLabel(page);
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
    // Always asked. Skipping it for pages that looked empty went wrong: a
    // page that is neither open nor cached counts as having no buttons, and
    // was deleted with all of them and no warning.
    const confirmed = await this._confirmDestructive({
      title: this._t("delete_page_title", { name: pageName }),
      message: configured > 0
        ? this._t("delete_page_confirm", { n: configured })
        : this._t("delete_page_confirm_empty"),
      confirmText: this._t("delete"),
    });
    if (!confirmed) return;
    // A pending save resolves against _currentPageId, and the indices below are
    // about to move under it. Awaited so it writes to the page it was actually
    // edited on.
    await this._flushAutoSave();
    const removed = this._pages.splice(idx, 1)[0];
    this._pageOpInFlight = true;
    try {
      try {
        await this._hass.callWS({ type: "lizaip_config/set_pages", entry_id: this._currentEntry, pages: this._pages });
      } catch (e) {
        // Restore on failure
        this._pages.splice(idx, 0, removed);
        this._toast(this._t("delete_page_failed"));
        return;
      }
      this._toast(this._t("page_deleted", { name: pageName }));
      delete this._pageCache[pageId];

      // _currentPageIdx is a position in a list that just got shorter, so
      // deleting anything to the left of the selection slides the selected page
      // one place down and the index has to follow it. Only clamping the tail —
      // which is all this did — left every other deletion pointing at the
      // *next* page. Deleting the selected page itself keeps the index, which
      // now addresses the page that took its place; the clamp catches the case
      // where there was nothing after it.
      const deletedSelected = idx === this._currentPageIdx;
      if (idx < this._currentPageIdx) this._currentPageIdx--;
      if (this._currentPageIdx >= this._pages.length) this._currentPageIdx = Math.max(0, this._pages.length - 1);

      this._selectedButtonIdx = -1;
      this._contextKey = null;
      this._pageTitleSelected = false;
      this._editorEl = null;
      // Only the selected page's assignments changed hands. Deleting another
      // page leaves `_assignments` describing the same page it already did, and
      // re-reading it would discard edits the flush above has not yet had
      // answered.
      if (deletedSelected) await this._loadAssignments();
      this._render();
    } finally {
      this._pageOpInFlight = false;
    }
  }

  async _reorderPage(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const [moved] = this._pages.splice(fromIdx, 1);
    this._pages.splice(toIdx, 0, moved);
    if (this._currentPageIdx === fromIdx) {
      this._currentPageIdx = toIdx;
    } else if (fromIdx < this._currentPageIdx && toIdx >= this._currentPageIdx) {
      this._currentPageIdx--;
    } else if (fromIdx > this._currentPageIdx && toIdx <= this._currentPageIdx) {
      this._currentPageIdx++;
    }
    this._pageOpInFlight = true;
    try {
      await this._hass.callWS({ type: "lizaip_config/set_pages", entry_id: this._currentEntry, pages: this._pages });
    } finally {
      this._pageOpInFlight = false;
    }
    this._render();
  }

  // =================== MOUNT HA EDITOR ===================
  async _mountEditor(containerId) {
    const container = this.shadowRoot?.querySelector(`#${containerId}`);
    if (!container) return;

    // Move the existing element rather than rebuilding it. Every render
    // replaces this container wholesale, and a fresh `ha-automation-action`
    // opens collapsed — so an autosave echo or a sibling edit would fold up the
    // action being edited. `_editorEl` is cleared wherever the editing context
    // changes, so a surviving one always belongs here.
    if (this._editorEl) {
      container.replaceChildren(this._editorEl);
      this._editorEl.hass = this._editorHass();
      this._editorEl.narrow = this._narrow;
      if (this._editorEl.actions !== this._sequence) this._editorEl.actions = this._sequence;
      this._enforceSingleAction(this._editorEl);
      return;
    }

    container.innerHTML = "";

    await this._loadHaComponents();

    if (customElements.get("ha-automation-action")) {
      const editor = document.createElement("ha-automation-action");
      editor.hass = this._editorHass();
      editor.narrow = this._narrow;
      editor.actions = this._sequence;
      editor.addEventListener("value-changed", (ev) => this._onSequenceChanged(ev));
      container.appendChild(editor);
      this._editorEl = editor;
      this._enforceSingleAction(editor);
    } else {
      const ta = document.createElement("textarea");
      ta.style.cssText = "width:100%;min-height:200px;font-family:monospace;font-size:13px;padding:12px;border:1px solid var(--divider-color);border-radius:4px;background:var(--card-background-color);color:var(--primary-text-color);resize:vertical;box-sizing:border-box;";
      ta.value = JSON.stringify(this._sequence, null, 2);
      ta.addEventListener("input", () => {
        try { this._onSequenceChanged({ detail: { value: JSON.parse(ta.value) }, stopPropagation: () => {} }); } catch(e){}
      });
      container.appendChild(ta);
      container.insertAdjacentHTML("afterbegin",
        `<p style="color:var(--liza-warning-text);font-size:12px;margin-bottom:8px">${this._t("visual_editor_unavailable")}</p>`);
    }
  }

  /**
   * `hass` for the action editor, with every internal command narrowed to this device.
   *
   * Two narrowings, both driven by the registry rather than by any one
   * command's name, so a command added to the backend needs no change here:
   *
   * - `target` is dropped. The service declares a device target so it can be
   *   found under a lizaIP device in the action dialog. Here the device is not
   *   in question — the panel is editing one remote's button — so a device
   *   picker would only offer a way to point the button at a remote it is not
   *   on. Dropped rather than pre-filled: a step with no target runs on
   *   whichever remote it sits on, which is what a button means.
   * - A parameter naming a target gets a dropdown of this device's own options.
   *   The global schema pools every device's pages, because one description is
   *   registered per service and the standalone automation editor has no
   *   device context.
   * - Everything else is hidden. One field per target, so there is no second
   *   field able to disagree with the dropdown, and the device is the one the
   *   button sits on.
   *
   * The dropdown carries the target's *id* and shows its name. Two pages are
   * allowed to share a name, and the backend rightly refuses such a name as
   * ambiguous — so a name-valued dropdown can offer two identical entries that
   * both disarm the button, with the id field that used to disambiguate them
   * now hidden. An id is also unaffected by the page being renamed. The user
   * still only ever reads and picks a name.
   *
   * `ha-service-control` reads `hass.services` and memoises on its identity, so
   * the returned object must be stable — a fresh one per render would re-render
   * the form on every keystroke.
   */
  _editorHass() {
    const hass = this._hass;
    const registered = (this._internalCommands || []).filter(
      (cmd) => hass?.services?.lizaip?.[(cmd.service || "").split(".")[1]],
    );
    if (!registered.length) return hass;

    const pages = this._pages || [];
    // Two spellings of the same list: ids to store, names to read.
    const byId = pages.map((page) => ({ value: String(page.id), label: this._pageLabel(page) }));
    const byNameOptions = pages.map((page) => this._pageLabel(page));

    // What a step already stores decides which spelling its dropdown speaks,
    // so a button written before the dropdown moved to ids keeps showing its
    // page instead of going blank. New steps store nothing yet and get an id.
    const storedKey = (service, keys) => {
      for (const step of this._sequence || []) {
        if ((step?.action || step?.service) !== service) continue;
        for (const k of keys) {
          const v = step?.data?.[k];
          if (v !== undefined && v !== null && v !== "") return k;
        }
      }
      return null;
    };

    const plan = registered.map((cmd) => {
      const params = cmd.target_params || [];
      const idKey = params.find((p) => p.type === "page_id")?.key;
      const nameKey = params.find((p) => p.type === "page_name")?.key;
      const inUse = storedKey(cmd.service, [idKey, nameKey].filter(Boolean));
      const picker = inUse || idKey || nameKey;
      return { cmd, picker, options: picker === idKey ? byId : byNameOptions };
    });

    const key = JSON.stringify([
      byId,
      plan.map((p) => [p.cmd.service, p.picker]),
    ]);
    if (this._editorHassCache?.hass === hass && this._editorHassCache?.key === key) {
      return this._editorHassCache.value;
    }

    const lizaip = { ...hass.services.lizaip };
    for (const { cmd, picker, options } of plan) {
      const name = cmd.service.split(".")[1];
      const svc = lizaip[name];
      // Every other way of naming the same target goes. The dropdown is the
      // answer, so a second field could only ever disagree with it. A command
      // with no target params keeps its fields — they are its input, not a
      // target.
      const hidden = new Set([
        "config_entry_id",
        ...(picker
          ? (cmd.target_params || []).map((p) => p.key).filter((k) => k !== picker)
          : []),
      ]);

      const fields = {};
      for (const [field, spec] of Object.entries(svc.fields || {})) {
        if (hidden.has(field)) continue;
        fields[field] = field === picker
          ? {
              ...spec,
              // The one field left, so it carries the requiredness of the
              // target however the schema spread it across the spellings.
              required: true,
              // Free text only where it is the sole way to show a value the
              // list no longer has — a page since deleted. Offering it
              // otherwise just invites a typo that resolves to nothing.
              selector: {
                select: {
                  options,
                  custom_value: !options.length,
                  mode: "dropdown",
                },
              },
            }
          : spec;
      }
      const { target: _unusedTarget, ...rest } = svc;
      lizaip[name] = { ...rest, fields };
    }

    const value = { ...hass, services: { ...hass.services, lizaip } };
    this._editorHassCache = { hass, key, value };
    return value;
  }

  _enforceSingleAction(editor) {
    const STYLE_ID = "liza-single-action";
    const HIDE_CSS = `.link-button-row, ha-button-menu, .buttons { visibility:hidden!important; height:0!important; overflow:hidden!important; margin:0!important; padding:0!important; }`;
    const inject = () => {
      const sr = editor.shadowRoot;
      if (!sr) return false;
      let styleEl = sr.querySelector(`#${STYLE_ID}`);
      if (!styleEl) {
        styleEl = document.createElement("style"); styleEl.id = STYLE_ID; styleEl.textContent = HIDE_CSS;
        sr.appendChild(styleEl);
      }
      sr.querySelector("#liza-fab-style")?.remove();
      sr.querySelector("#liza-btn-style")?.remove();
      styleEl.disabled = false;
      const hasAction = this._sequence && this._sequence.length > 0;
      let btn = editor.parentElement?.querySelector(".liza-add-action-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.className = "liza-add-action-btn";
        btn.innerHTML = `+ Add action`;
        btn.addEventListener("click", () => {
          const nativeBtn = sr.querySelector(".buttons ha-button") || sr.querySelector("ha-button-menu");
          if (nativeBtn) nativeBtn.click();
        });
        editor.parentElement?.appendChild(btn);
      }
      btn.style.display = hasAction ? "none" : "";
      return true;
    };
    if (!inject()) {
      let tries = 0;
      const id = setInterval(() => { if (inject() || ++tries > 30) clearInterval(id); }, 100);
    }
    editor.style.cssText = "";
  }

  // =================== RENDERING ===================
  _render() {
    try {
      // 3.1.2 Language of Parts. The panel ships five languages and falls back
      // to English for the rest, while Home Assistant sets <html lang> from the
      // user's own locale -- so on a Dutch or Polish install the English text
      // here is a part in a different language from the page around it.
      // Declared on the host, which the shadow tree inherits from.
      const lang = this._lang?.();
      if (lang && this.getAttribute("lang") !== lang) this.setAttribute("lang", lang);
      // The tile menu is transient and `innerHTML` below would strip the node
      // while leaving the panel holding a reference to it and a live keydown
      // listener on the window. Closed here rather than at each caller, since
      // every path that changes the face renders.
      this._closeFaceMenu?.();
      // Modal dialogs are appended to this shadow root, which _renderDeviceList
      // and _renderDeviceConfig replace wholesale via innerHTML. Any render
      // landing while a dialog is open would therefore silently destroy it —
      // and one always can, because `_init` defers a render until `_loadAll`
      // resolves, and the layout dialogs await WS round-trips of their own.
      // Detaching and re-appending the nodes keeps their listeners intact,
      // since the elements themselves are never recreated.
      const overlays = [...(this.shadowRoot?.querySelectorAll(".add-page-overlay") || [])];
      const pagesList = this.shadowRoot?.querySelector(".pages-list");
      const pagesScroll = pagesList?.scrollLeft || 0;
      // `innerHTML` below destroys the focused element and focus drops to the
      // document, so every re-rendering control was usable exactly once per
      // trip through the tab order.
      const focus = this._a11yCaptureFocus();
      if (!this._currentEntry) this._renderDeviceList();
      else this._renderDeviceConfig();
      // Before focus is restored: the control being returned to may be one of
      // the ones whose tab stop is written here.
      this._a11yNormalizeTabStops();
      this._a11yObserveTabStops();
      for (const overlay of overlays) {
        this.shadowRoot.appendChild(overlay);
        // Re-appending drops a dialog out of the top layer, taking the focus
        // trap and the inertness of the panel with it: it looks unchanged
        // while Tab walks out into a page the user cannot see.
        if (overlay.showModal) {
          if (overlay.open) overlay.close();
          overlay.showModal();
        }
      }
      this._a11yRestoreFocusSoon(focus);
      // `innerHTML` above dropped the status region; put the same node back so
      // it keeps announcing rather than starting over empty each render.
      this._a11yLiveRegion();
      if (pagesScroll) {
        requestAnimationFrame(() => {
          const list = this.shadowRoot?.querySelector(".pages-list");
          if (list) list.scrollLeft = pagesScroll;
        });
      }
    } catch (e) {
      console.error("[LIZA] _render failed:", e);
    }
  }

  _renderDeviceList() {
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="toolbar"><ha-menu-button></ha-menu-button><h1 class="main-title">lizaIP</h1></div>
      <div class="view"><ha-card outlined><div class="card-content">
        ${this._devices.length === 0
          // Straight to this integration's own page, not the integration list:
          // that is where the "Add entry" button for a new hub actually is, and
          // the panel only exists once lizaIP is loaded, so the page resolves.
          ? `<p class="empty-state">${this._t("no_devices", {
              link: `<a href="/config/integrations/integration/lizaip">${this._t("no_devices_link")}</a>`,
            })}</p>`
          : `<div class="device-list">${this._devices.map(d => {
              // Same reasoning as the config toolbar: the id is spelled out by
              // a screen reader and read by nobody, so the meta line carries
              // only the firmware version. An untitled device still falls back
              // to its id for the title, which is the one place it earns its
              // space.
              const meta = d.sw_version ? `v${d.sw_version}` : '';
              const displayTitle = (d?.title || '').trim() || d.device_id || d.entry_id || 'lizaIP';
              return `
            <div class="device-item" data-entry="${d.entry_id}" role="button" tabindex="0">
              <div class="device-icon-wrap"><ha-icon icon="mdi:remote" style="color:#fff;--mdc-icon-size:20px" aria-hidden="true"></ha-icon></div>
              <div class="device-info">
                <div class="device-title">${this._esc(displayTitle)}</div>
                ${meta ? `<div class="device-meta">${this._esc(meta)}</div>` : ''}
              </div>
              <div class="status-badge ${d.available ? 'online' : 'offline'}"><span class="dot" aria-hidden="true"></span>${this._t(d.available ? 'device_online' : 'device_offline')}</div>
            </div>`;
            }).join("")}</div>`}
      </div></ha-card></div>`;
    const mb = this.shadowRoot.querySelector("ha-menu-button");
    if (mb) { mb.hass = this._hass; mb.narrow = this._narrow; }
    this.shadowRoot.querySelectorAll(".device-item").forEach(el =>
      el.addEventListener("click", () => this._selectDevice(el.dataset.entry)));
  }

  /**
   * What the toolbar pill says, as one answer both the markup and the live
   * region read from. Three states, not two: a missing record means we never
   * heard back, which is not the same claim as the device being offline.
   */
  _deviceStatus(device) {
    const state = !device ? "unknown" : device.available ? "online" : "offline";
    const key = { online: "device_online", offline: "device_offline", unknown: "device_unknown" }[state];
    return { state, label: this._t(key) };
  }

  /**
   * WCAG 4.1.3 Status Messages: a device dropping offline never gets focus, so
   * it has to reach a live region. Not `role="status"` on the pill, because
   * `_renderDeviceConfig` replaces the shadow root on every tick -- a recreated
   * region reports nothing, and a surviving one would repeat itself forever.
   * Hence the comparison against the last state; the first paint is silent.
   */
  _announceDeviceStatus(status, name) {
    // Keyed by device: opening an offline device after an online one is not
    // a device going offline, and announcing it would report a non-event.
    const previous = this._lastAnnouncedStatus;
    this._lastAnnouncedStatus = { entry: this._currentEntry, state: status.state };
    if (!previous || previous.entry !== this._currentEntry) return;
    if (previous.state === status.state) return;
    this._a11yAnnounce?.(this._t("device_status_announced", { name, state: status.label }));
  }

  _renderDeviceConfig() {
    const bp = this._blueprint;
    if (!bp) return;
    const device = this._devices.find(d => d.entry_id === this._currentEntry);
    const status = this._deviceStatus(device);
    const title = (device?.title || '').trim() || device?.device_id || this._currentEntry || 'lizaIP';
    // The device id is deliberately not shown: 32 hex characters spelled out
    // one by one bury the name beside them (2.4.6). It stays the fallback
    // where there is no title, because then it is the only name there is.
    const titleInner = `<span class="title-text">${this._esc(title)}</span>`;

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="toolbar">
        ${this._devices.length > 1
          ? `<ha-icon-button id="btn-back" label="${this._esc(this._t("back"))}"><ha-icon icon="mdi:arrow-left" aria-hidden="true"></ha-icon></ha-icon-button>`
          : `<ha-menu-button></ha-menu-button>`}
        <span class="toolbar-status ${status.state}">
          <span class="toolbar-status-dot ${status.state}" aria-hidden="true"></span>
          <span class="toolbar-status-text">${this._esc(status.label)}</span>
        </span>
        <h1 class="main-title">${titleInner}</h1>
        <!-- No aria-label: it read "Buttons / Actions", which is just the two
             tabs' own names concatenated, so a reader heard "Buttons" twice
             before reaching anything. A tablist's name is optional and there is
             only one on the page, so there is nothing to disambiguate. -->
        <div class="toolbar-tabs" role="tablist">
          <button class="toolbar-tab ${this._activeTab === 'buttons' ? 'active' : ''}" data-tab="buttons"
                  id="liza-tab-buttons" role="tab" aria-controls="liza-tabpanel"
                  aria-selected="${this._activeTab === 'buttons' ? 'true' : 'false'}"
                  tabindex="${this._activeTab === 'buttons' ? '0' : '-1'}"><span aria-hidden="true">🎛️</span> ${this._t("tab_buttons")}</button>
          <button class="toolbar-tab ${this._activeTab === 'actions' ? 'active' : ''}" data-tab="actions"
                  id="liza-tab-actions" role="tab" aria-controls="liza-tabpanel"
                  aria-selected="${this._activeTab === 'actions' ? 'true' : 'false'}"
                  tabindex="${this._activeTab === 'actions' ? '0' : '-1'}"><span aria-hidden="true">⚡</span> ${this._t("actions")}</button>
          ${!this._debugTools ? "" : `
          <button class="toolbar-tab ${this._activeTab === 'debug' ? 'active' : ''}" data-tab="debug"
                  id="liza-tab-debug" role="tab" aria-controls="liza-tabpanel"
                  aria-selected="${this._activeTab === 'debug' ? 'true' : 'false'}"
                  tabindex="${this._activeTab === 'debug' ? '0' : '-1'}"><span aria-hidden="true">🩺</span> ${this._t("tab_debug")}</button>`}
          <!-- Last and icon-only: settings are visited rarely, and a gear at
               the far end is where they are looked for. The name a reader
               hears comes from aria-label; title shows it on hover.
               NB: no backticks in this comment; it sits in a template. -->
          <button class="toolbar-tab toolbar-tab-icon ${this._activeTab === 'settings' ? 'active' : ''}" data-tab="settings"
                  id="liza-tab-settings" role="tab" aria-controls="liza-tabpanel"
                  aria-label="${this._esc(this._t("tab_settings"))}" title="${this._esc(this._t("tab_settings"))}"
                  aria-selected="${this._activeTab === 'settings' ? 'true' : 'false'}"
                  tabindex="${this._activeTab === 'settings' ? '0' : '-1'}"><ha-icon icon="mdi:cog" aria-hidden="true"></ha-icon></button>
        </div>
      </div>
      <!-- tabindex="-1", not "0": a tabpanel earns a tab stop only when it has
           no focusable content, and this one wraps the entire view. -->
      <div class="view" id="liza-tabpanel" role="tabpanel" aria-labelledby="liza-tab-${this._activeTab}" tabindex="-1">
        ${this._activeTab === "buttons" ? this._htmlButtonsView(bp)
          : this._activeTab === "debug" ? (this._htmlDebugView?.() ?? "")
          : this._activeTab === "settings" ? this._htmlSettingsView()
          : this._htmlActionsView()}
      </div>
      <div class="toast" role="status" aria-live="polite"></div>`;

    const mb = this.shadowRoot.querySelector("ha-menu-button");
    if (mb) { mb.hass = this._hass; mb.narrow = this._narrow; }
    // After the markup, because announcing re-attaches the live region to a
    // shadow root the assignment above has just emptied.
    this._announceDeviceStatus(status, title);
    this.shadowRoot.querySelector("#btn-back")?.addEventListener("click", () => this._goBack());
    this.shadowRoot.querySelectorAll(".toolbar-tab").forEach(el =>
      el.addEventListener("click", () => this._switchTab(el.dataset.tab)));

    if (this._activeTab === "buttons") this._wireButtonsView(bp);
    else if (this._activeTab === "debug") this._wireDebugView?.();
    else if (this._activeTab === "settings") this._wireSettingsView();
    else this._wireActionsView();
  }

}

// Apply mixins. I18n goes first: every other mixin calls `_t`.
Object.assign(LizaRemotePanel.prototype, I18nMixin);
Object.assign(LizaRemotePanel.prototype, DataMixin);
Object.assign(LizaRemotePanel.prototype, HelpersMixin);
Object.assign(LizaRemotePanel.prototype, StatesMixin);
Object.assign(LizaRemotePanel.prototype, ButtonsViewMixin);
Object.assign(LizaRemotePanel.prototype, ActionsViewMixin);
Object.assign(LizaRemotePanel.prototype, SettingsViewMixin);
Object.assign(LizaRemotePanel.prototype, A11yMixin);

if (!customElements.get("liza-remote-panel")) {
  customElements.define("liza-remote-panel", LizaRemotePanel);
}

// Exported so the panel tests can exercise a prototype method directly: the
// element itself cannot be constructed outside a browser.
export { LizaRemotePanel };

