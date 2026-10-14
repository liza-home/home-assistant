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
 *   - liza-remote-variables.js — ${…} variables in the previews, answered by the backend
 *   - liza-remote-states.js    — state derivation & states editor
 *   - liza-remote-buttons-view.js — Buttons tab HTML + wiring
 *   - liza-remote-button-tip.js — the hover card over a shape on the face
 *   - liza-remote-actions-view.js — Actions tab HTML + wiring
 *   - liza-remote-styles.js    — CSS styles
 *   - liza-remote-stylesheet.js — adopts those styles onto the shadow root
 *   - liza-remote-svg.js       — SVG rendering
 */

import { STYLES } from "./liza-remote-styles.js";
import { adoptStyles } from "./liza-remote-stylesheet.js";
import { DataMixin } from "./liza-remote-data.js";
import { HelpersMixin, syncCustomIcons, isMovableSlot } from "./liza-remote-helpers.js";
import { VariablesMixin } from "./liza-remote-variables.js";
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
import { ButtonTipMixin } from "./liza-remote-button-tip.js";


class LizaRemotePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    // Parsed once and carried by the root itself, so the renders below can
    // replace the markup without the stylesheet being read again. Falsy only
    // where constructable stylesheets are missing, and then each render
    // inlines the `<style>` tag it always did.
    this._stylesAdopted = adoptStyles(this.shadowRoot);
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
    // Which press rows are expanded, keyed `buttonKey:index`. Lives on the
    // panel, not in the DOM, because `_refreshButtonEntitySections` rebuilds
    // whole subtrees while the user is working -- a row they opened would
    // otherwise shut itself the moment they typed in it.
    //
    // Collapsed is the default because the list grows with the cycle -- six
    // presses is six headings and twelve fields, which buries the action list
    // the presses actually come from. The exception is a press just added:
    // `_applyCycle` opens it, because adding a step and then having to hunt
    // for its row is the one moment the user certainly wants it open.
    //
    // Keyed by button so switching selection needs no reset: the rows of a
    // button the user left open are still open when they come back to it.
    this._openPresses = new Set();
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
    // The running diagnostics build and its window. One at a time: the build
    // spends its time on the remote, and a second would only queue behind it.
    this._diagJob = null;
    this._diagDialog = null;
    // A configuration download in flight. No window -- it copies local files
    // and is over at once -- so this is only here to swallow a double click.
    this._configBusy = false;
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
    this._debugTrafficBusy = false;
    this._debugProbeError = null;
    this._debugReportError = null;
    this._debugPortError = null;
    this._debugTraffic = null;
    this._debugTrafficError = null;
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
    // On window, not the shadow root: after a click on a page thumb focus sits
    // on <body>, outside the panel, and the shadow root never hears the key.
    if (!this._pageDeleteKey) {
      this._pageDeleteKey = (e) => this._onPageDeleteKey(e);
      window.addEventListener?.("keydown", this._pageDeleteKey);
    }
    // Re-init when HA re-attaches the panel after navigation
    if (this._initialized && this._hass) {
      this._initialized = false;
      this._init();
    }
  }

  disconnectedCallback() {
    this._a11yStop();
    if (this._pageDeleteKey) {
      window.removeEventListener?.("keydown", this._pageDeleteKey);
      this._pageDeleteKey = null;
    }
    // Registered once by `_wireGotoLinks` and so not dropped by the render that
    // replaces the strip it draws over — this is the only place it can go.
    if (this._gotoLinkResize) {
      window.removeEventListener?.("resize", this._gotoLinkResize);
      this._gotoLinkResize = null;
    }
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
    // A reconnect is often a reboot, which closes the log port.
    this._recheckDebugPort?.();
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
    const entryId = ev?.data?.entry_id;
    if (!entryId) return;

    // The event carries the new state, so a remote already on the list is
    // updated in place. Only what the event cannot answer goes back to the
    // backend: a remote the list has not learned about yet, an event without
    // a state, or a panel mid-load whose list is about to be replaced.
    const connected = ev.data.connected;
    const known = (this._devices || []).find(d => d?.entry_id === entryId);
    if (typeof connected !== "boolean" || !known || this._loading || !this._initDone) {
      await this._refreshAvailability();
      return;
    }
    // Tells a refetch already in flight that its answer predates this edge.
    this._availabilityEdges = (this._availabilityEdges || 0) + 1;
    if (Boolean(known.available) === connected) return;
    this._devices = this._devices.map(d => (d === known ? { ...d, available: connected } : d));
    this._render();
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
    const edgesBefore = this._availabilityEdges || 0;
    const devices = await this._fetchDevices();
    // A failed refetch is not evidence that every remote went away.
    if (!devices) return;
    // An edge applied while this was in flight is newer than the answer, which
    // would otherwise put the badge back. Ask again instead.
    if ((this._availabilityEdges || 0) !== edgesBefore) {
      await this._refreshAvailability();
      return;
    }

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
      if (document.visibilityState === "hidden") return;
      this._refreshAvailability();
      this._recheckDebugPort?.();
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
    // The event carries only `entry_id` (and `order_only`); the reload below
    // reads everything else from the backend.
    if (!this._currentEntry || ev?.data?.entry_id !== this._currentEntry) return;
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
      } else if (this._activeTab === "actions") {
        // The buttons tab has no counterpart here: its icons are the SVG face
        // tiles, refreshed below. The call that stood here walked `.button-row`,
        // which nothing has rendered since the list view was removed -- so it
        // ran a query per state change to find nothing, several times a second.
        this._refreshActionIcons();
      }
    }
    if (!this._loading) {
      this._refreshVariables?.();
      this._refreshSVGIcons();
    }
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
      // Extra icon sets live in the browser; imgserv needs their shapes.
      syncCustomIcons(this._hass);
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
      }
      // Opening onto the debug tab is an entry too, and `_switchTab` never
      // runs for it: from a link, or by coming back to the panel with the tab
      // still selected -- HA re-attaches the element and this runs again, and
      // the log-stream switch would otherwise show what it read last time.
      if (this._currentEntry && this._activeTab === "debug") {
        if (this._debugTools) this._enterDebugTab?.();
        else this._activeTab = "buttons";
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
    this._debugTraffic = null;
    this._debugTrafficError = null;
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
      // The debug readings were cleared above; on the debug tab, read them
      // for the remote now shown, or its log-stream switch stays at "off".
      if (this._activeTab === "debug" && this._currentEntry === entryId) this._enterDebugTab?.();
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
      // The unconditional render below paints the tab now, rather than leaving
      // the user on the old one until a websocket round trip comes back. This
      // one is for what that round trip brought — so it only runs when the
      // round trip brought something, instead of rendering the panel twice on
      // every visit to the tab.
      this._loadGlobalUsage().then((changed) => { if (changed) this._render(); });
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
    this._sequence = this._cycleSequence(assign, btn.key);
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
      this._sequence = this._cycleSequence(assign, btn.key);
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
    const key = this._selectedButton?.key;
    const cycling = this._cycleEnabled(key);
    // Cycling, every action in the list is a press and the list is kept whole.
    // Otherwise the cap still holds: the editor shows one action because the
    // button runs one action.
    this._sequence = cycling
      ? value.slice()
      : (value.length > 0 ? [value[0]] : []);
    if (this._editorEl && this._editorEl.actions !== this._sequence) {
      this._editorEl.actions = this._sequence;
    }
    if (this._editorEl) this._enforceSingleAction(this._editorEl);
    // What the presses looked like *before* this event, taken now because the
    // commit below is about to overwrite part of it: `_syncToggleFirstStep`
    // rewrites `rules[0].config` to the new press 1 while leaving its icon and
    // tooltip alone, so by the time `_applyCycle` ran, slot 0 was the incoming
    // action wearing the outgoing appearance -- and matching against that
    // handed press 1's old icon to whichever press had just been dragged into
    // its place. Deep-copied so the commit cannot reach into it afterwards.
    const prevRules = cycling
      ? (this._toggleRules(key) || []).map(r => JSON.parse(JSON.stringify(r)))
      : null;
    // Press 1's face, before anything touches it. Taken ahead of the commit
    // because the commit is one of the things that may rewrite it.
    const faceBefore = cycling ? this._pressOneFace(key) : "";
    // Order matters. `_commitCurrentToAssignment` resolves press 1 into
    // `config` and `action_id`; `_applyCycle` then copies that into `rules[0]`
    // and writes the rest, so it has to run second or step 1 would be built
    // from an assignment that has not been updated yet.
    this._commitCurrentToAssignment();
    if (cycling) this._applyCycle(key, prevRules);
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
    //
    // The press rows refresh for a second reason: each row is titled by what
    // its press does, and a press with no row is a press whose icon and
    // tooltip cannot be reached.
    //
    // Compared by *content*, not by length. Dragging a press to a new position
    // leaves the count alone and renames every row it passed, so a length test
    // left the titles describing the order the list used to be in.
    const entity = this._entityOfSelectedButton();
    const sig = this._cycleSignature();
    // Press 1's face moving is the one change the partial refresh cannot
    // carry. Its Image is inside the refreshed host, but its Tooltip is
    // deliberately a sibling of that host -- so that an entity change cannot
    // throw away a name typed and not yet confirmed -- and nothing else
    // rewrites it. Reorder press 1 away and the row updated its heading, its
    // glyph and every other press, while the Tooltip underneath went on
    // showing the wording of the press that used to lead: a row contradicting
    // itself, and the stale text committed back the next time the field was
    // left.
    //
    // Re-rendered whole instead. The reason the card patches rather than
    // renders is the action editor, which must not be rebuilt under someone
    // typing in it -- but a face only moves when a press is dropped, added or
    // deleted, and none of those happen mid-keystroke. The partial path still
    // handles every other case, which is all of the frequent ones.
    if (cycling && this._pressOneFace(key) !== faceBefore) {
      this._lastSectionsEntity = entity;
      this._lastCycleSig = sig;
      this._render();
    } else if (entity !== this._lastSectionsEntity || (cycling && sig !== this._lastCycleSig)) {
      this._lastSectionsEntity = entity;
      this._lastCycleSig = sig;
      this._refreshButtonEntitySections();
    }
  }

  /**
   * Press 1's stored appearance, as one comparable string.
   *
   * Image and tooltip together, because they move together: a press carries
   * both or neither. Null-separated so a value ending where the next begins
   * cannot read as a different pair.
   */
  _pressOneFace(key) {
    const a = this._editAssign?.(key);
    return `${a?.image || ""}\u0000${a?.label || ""}`;
  }

  /**
   * What the press rows are drawn from, as one comparable string.
   *
   * Only the things a row shows: the service each press calls, in order. An
   * edit *inside* a press -- retargeting it, changing its data -- does not
   * rename its row, so including those would rebuild the rows on keystrokes
   * that change nothing about them.
   */
  _cycleSignature() {
    return (this._sequence || [])
      .map(step => this._stepService([step]) || "?")
      .join("|");
  }

  /**
   * Write the editor's action list back out as the button's presses.
   *
   * `rules[0]` is press 1 and must stay equal to `config`, which
   * `_commitCurrentToAssignment` has just resolved -- so it is copied from the
   * assignment rather than rebuilt from the list, and carries the same
   * `action_id`. Presses 2..N come from the rest of the list.
   *
   * Icons and tooltips travel with the *action*, not with the slot.
   *
   * They used to be carried across by index, on the argument that press 2
   * should keep looking like press 2. That held while the only way to change
   * the list was to retype it. Once the list could be dragged -- and once the
   * summary drew each press's glyph and its name side by side -- it stopped
   * holding: dragging Pause above Play left the pause glyph sitting on Play,
   * and the chip read "1. Playing" under a pause icon. The icon is a picture
   * *of the action*; an action that moves has to take its picture with it.
   *
   * Matched on the press's config, so a reorder is an exact match and every
   * press keeps what the user gave it. Press 1 included: its face is stored on
   * the assignment rather than on its rule, so it is lent to the matcher going
   * in and written back coming out. A press whose config has *changed*
   * matches nothing, and falls back to whatever was in its slot: that is the
   * user retargeting the step they are working on, and their tooltip should
   * survive them changing their mind about which light it points at. Slots
   * already claimed by a match are not offered again, so an inserted press
   * cannot inherit the appearance of one that is still on screen.
   *
   * Below two presses there is no cycle -- that is just the button's own
   * action, which `config` already holds. The block is deleted rather than
   * left at one rule, because `sanitize_toggle` reads presence as "this button
   * toggles" and a one-rule block would claim that while doing nothing.
   */
  _applyCycle(key, prevRules = null) {
    const target = this._editAssignEnsure(key);
    if (!target) return;
    if (this._sequence.length < 2) { delete target.toggle; return; }
    // The caller's snapshot when there is one -- see `_onSequenceChanged`, the
    // live block has had `rules[0].config` rewritten by then. Falling back to
    // the live block keeps the method usable on its own.
    const prevRaw = Array.isArray(prevRules)
      ? prevRules
      : (Array.isArray(target.toggle?.rules) ? target.toggle.rules : []);
    // Press 1 wears the assignment's own `image` and `label`; `rules[0].icon`
    // is never read. So to the matcher slot 0 looked faceless, and only half a
    // reorder happened: dragging Stop to the top moved `mdi:stop` onto a
    // `rules[0].icon` nothing renders, left `mdi:play` sitting on the button,
    // and gave Play's new row nothing at all. Lending slot 0 the assignment's
    // face lets it be matched and moved like any other press.
    //
    // Seeded onto a copy -- the caller's snapshot is not ours to edit.
    const prev = prevRaw.map((r, i) => (i === 0
      ? { ...r, icon: r.icon || target.image || "", label: r.label || target.label || "" }
      : r));
    const rules = this._sequence.map((step, i) => ({
      config: i === 0
        ? JSON.parse(JSON.stringify(target.config || [step]))
        : [JSON.parse(JSON.stringify(step))],
    }));

    // Exact matches first, every one of them, before any slot is handed out on
    // position. One pass would let an inserted press claim slot 0 on position
    // and leave the press that actually belongs there to inherit its
    // neighbour's icon -- the whole row shifted by one, which is the failure
    // this change exists to prevent.
    const taken = new Set();
    const from = new Array(rules.length).fill(null);
    rules.forEach((rule, i) => {
      const want = JSON.stringify(rule.config);
      const at = prev.findIndex((r, j) => !taken.has(j) && JSON.stringify(r.config) === want);
      if (at !== -1) { taken.add(at); from[i] = prev[at]; }
    });
    rules.forEach((_, i) => {
      if (from[i] || taken.has(i) || !prev[i]) return;
      taken.add(i);
      from[i] = prev[i];
    });

    // A press with no source after both passes is a genuinely new one: no
    // step matched it and no slot was free to inherit from. Open its row, so
    // a step the user has just added is a step whose Image and Tooltip are in
    // front of them rather than one heading down a collapsed list.
    //
    // Retargeting a press in place does not count -- it still takes `prev[i]`
    // on the positional pass -- so editing an existing step never springs its
    // row open under the user.
    from.forEach((was, i) => {
      if (i > 0 && !was) this._openPresses?.add(`${key}:${i}`);
    });

    rules.forEach((rule, i) => {
      const was = from[i];
      if (was?.icon) rule.icon = was.icon;
      if (was?.label) rule.label = was.label;
      // Resolve-or-create, exactly as press 1 does. `action_id` is what the
      // Actions view counts uses by, so a press without one is a press the
      // library thinks nobody is using -- which is how an action still on a
      // button gets reported as safe to delete. Skipped for a press that calls
      // no service -- a delay, a condition -- which has no entry to be.
      const id = i === 0
        ? target.action_id
        : (this._stepService(rule.config) ? this._resolveAction(rule.config).id : "");
      if (id) rule.action_id = id; else delete rule.action_id;
    });

    // ...and back out again. Press 1's face is stored on the assignment, so the
    // one it just won has to be written there; left on `rules[0].icon` it would
    // be invisible and the row would go on showing the press that used to lead.
    //
    // Only when there was a cycle to reorder. A button with one action and an
    // image gains its first cycle with `prev` empty and slot 0 never in play,
    // and clearing on that path would wipe the image off every button the
    // moment it got a second action. Once there is a cycle, slot 0 takes part
    // like any other: a press inserted at the front matched nothing and starts
    // blank, exactly as a press inserted anywhere else does.
    if (prev.length) {
      const lead = rules[0];
      if (lead.icon) target.image = lead.icon; else delete target.image;
      // A name that travelled in with a press is one the user typed, and the
      // flag is what stops the generated name overwriting it on next render.
      if (lead.label) { target.label = lead.label; target.label_edited = true; }
      else { delete target.label; delete target.label_edited; }
      delete lead.icon;
      delete lead.label;
    }
    target.toggle = { mode: "cycle", rules };
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
    //
    // Press 1, not the whole cycle. While cycling, `_sequence` holds one action
    // per press and only the first of them is what the *button* is.
    const seq = this._clickSequence();
    const service = this._stepService(seq);
    const action = this._resolveAction(seq);

    const entity = this._getTargetEntityFromConfig(seq);
    const prevPayload = this._getPayloadDisplay(existing.config);
    const nextPayload = this._getPayloadDisplay(seq);

    existing.action_id = action.id;
    existing.config = seq;

    // Remember what the command's target was called, while it still resolves.
    // The dropdown stores a page id, so once that page is deleted the button
    // could only ever report "Page 3" — a number the user never chose and
    // cannot act on. Written only when the target resolves: a save made while
    // the target is already broken must not overwrite a good remembered name
    // with the id-derived stand-in. A button that stops being an internal
    // command clears it, so a stale hint cannot outlive what it described.
    if (!this._internalCommandProblem(seq, service)) {
      const targetName = this._internalCommandTargetName(seq, service);
      if (targetName) existing.internal_target_name = targetName;
      else delete existing.internal_target_name;
    }

    // Respect an explicitly edited label; otherwise keep the auto label in sync
    // with the payload the user just picked. An empty auto label means we have
    // nothing better to say — keep whatever the layout or the user already set
    // rather than blanking it.
    const autoLabel = this._computeLabel(action, entity, seq);
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
    // The card renders `rules[0]` through this editor, and the executor runs
    // `rules[position]` — so an action edited here has to reach step 1 too, or
    // the first press would run something the user can no longer see.
    this._syncToggleFirstStep?.(this._editAssign(btn.key));
  }

  /**
   * The library entry for this sequence, created if the library has none.
   *
   * Factored out of `_commitCurrentToAssignment` so a cycle's later presses are
   * linked exactly the way its first one is. `action_id` is what the Actions
   * view counts uses by, so a press resolved any other way -- or not at all --
   * is a press the library believes nobody is using, which is how an action
   * still on a button gets reported as safe to delete.
   *
   * Returns an entry for any sequence, including one whose first step calls no
   * service at all -- a delay, a condition. That is deliberately the behaviour
   * `_commitCurrentToAssignment` has always had for a button's own action, and
   * changing it here would change what a plain button stores. Callers that must
   * not mint a serviceless entry (a cycle's later presses) check
   * `_stepService` first.
   */
  _resolveAction(sequence) {
    const service = this._stepService(sequence);
    const found = this._findMatchingAction(sequence);
    if (found) return found;
    const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
    const action = { id, name: this._deriveActionName(service), service, states: [] };
    if (this._isPayloadService(service)) {
      action.payload_identity = this._payloadIdentity(sequence[0]?.data);
    }
    this._actions.push(action);
    return action;
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
   * A move in one gesture: dragged from `fromKey`, released on `toKey`.
   * `_moveButtonTo` decides what it means. Arms the state without
   * `_beginMove`'s render, which would rebuild the face under the gesture.
   */
  _dropButtonOn(fromKey, toKey) {
    const hadArmed = !!this._moveSourceKey;
    this._disarmMove();
    if (!fromKey || !toKey || fromKey === toKey) {
      // Only when something was showing: with nothing armed there is nothing to
      // unpaint, and the drag cleared its own marks as it ended.
      if (hadArmed) this._render();
      return;
    }
    this._moveSourceKey = fromKey;
    this._moveButtonTo(toKey);
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

    // Neither end may be a slot that holds no button record -- see
    // `isMovableSlot`. Stated here, the only place that sees both ends of a
    // move, rather than once per gesture.
    if (!isMovableSlot(sourceKey) || !isMovableSlot(targetKey)) {
      this._toast(this._t("not_a_button_slot"));
      this._render();
      return;
    }

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

  _isButtonAssigned(buttonKey) {
    // Deliberately the *page slot*, not the edit slot. This is the question
    // "does this position on the page do anything", and its answers feed
    // `filledCount`, which decides what a thumb says it holds and whether the
    // page is deletable. Reading it through the context would make a page with one
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
    // A long touch is something the button does, and ✕ clears it.
    if (Array.isArray(assign.longtouch) && assign.longtouch.length) return true;
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

    // Disabled: clicking a page in the editor no longer moves the remote.
    // Fire goto_page immediately — before any await/render so it's not delayed by DOM changes
    // this._gotoPageOnDevice(newPageId);

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
          ${this._debugTools ? `
          <button class="add-page-option" data-type="debug">
            <ha-icon icon="mdi:bug-outline" style="--mdc-icon-size:32px;" aria-hidden="true"></ha-icon>
            <span>${this._t("debug_pages")}</span>
            <span class="add-page-option-desc">${this._t("debug_pages_desc")}</span>
          </button>` : ""}
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
    overlay.querySelector('[data-type="debug"]')?.addEventListener("click", () => {
      close();
      this._showLayoutPicker({ debug: true });
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

  /**
   * The layouts to add a page from. `debug` picks the test and demo pages,
   * which only a beta release ships (and only with the debug tools loaded).
   */
  async _showLayoutPicker({ debug = false } = {}) {
    const layouts = (await this._loadLayouts()).filter(l => !!l.debug === debug);
    const withRandom = debug && this._debugTools && this._showRandomPagesDialog;
    if (!layouts.length && !withRandom) {
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
    // A test generator, not a layout: it lives with the debug tools and is
    // gone with them from a stable release.
    const randomCard = withRandom ? `
        <button class="layout-card" data-random-pages>
          ${this._renderIconHtml("mdi:dice-multiple", 36)}
          <span class="layout-card-name">${this._t("random_pages")}</span>
          <span class="layout-card-desc">${this._t("random_pages_desc")}</span>
        </button>` : "";

    const { dlg: overlay, close } = this._openModal(`
      <div class="add-page-dialog layout-dialog">
        <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._t(debug ? "debug_pages" : "choose_layout")}</h2>
        <div class="layout-grid">${cards}${randomCard}</div>
        <button class="add-page-cancel">${this._t("cancel")}</button>
      </div>
    `, { labelledBy: "liza-dlg-title" });

    overlay.querySelectorAll(".layout-card").forEach(card => {
      card.addEventListener("click", () => {
        if (card.hasAttribute("data-random-pages")) {
          close();
          this._showRandomPagesDialog();
          return;
        }
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

  /**
   * Delete (or Backspace, the key a Mac labels "delete") removes the open page,
   * through the same confirmation as its ✕. Only where the key means nothing
   * else: not while typing, not over a dialog or menu, and not from focus that
   * belongs to the rest of Home Assistant.
   */
  _onPageDeleteKey(e) {
    if (!(e.key === "Delete" || e.key === "Backspace")) return;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this._activeTab !== "buttons" || this._pageOpInFlight || this._moveSourceKey) return;
    if (!this._pages?.[this._currentPageIdx]) return;
    if (this._faceMenuEl || this.shadowRoot?.querySelector("dialog.add-page-overlay")) return;
    const path = e.composedPath?.() || [];
    const typing = path.some((n) => n?.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(n?.tagName || "")
      || n?.getAttribute?.("role") === "textbox");
    if (typing) return;
    const target = path[0];
    const unfocused = target === document.body || target === document.documentElement;
    if (!unfocused && !path.includes(this)) return;
    e.preventDefault();
    this._deletePage(this._currentPageIdx);
  }

  async _deletePage(pageIdx) {
    const idx = pageIdx !== undefined ? pageIdx : this._currentPageIdx;
    const page = this._pages[idx];
    // Which page by position and id in the title, its name on the line under
    // it: two pages can share a title, and "Page 3/9 (#24)" cannot be confused.
    // `_pageTitle`, not `page.image`: `image` is a title-*image* spec and
    // reads back as "mdi:sofa" rather than as a name.
    const pageName = this._pagePosition(page);
    const pageSubtitle = this._pageTitle(page);
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
      subtitle: pageSubtitle,
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

    this._pageOpInFlight = true;
    try {
      await this._hass.callWS({ type: "lizaip_config/set_pages", entry_id: this._currentEntry, pages: this._pages });
    } catch (err) {
      // Nothing was persisted, so the optimistic row is now a lie. Put the old
      // order back and render it properly rather than leaving the user looking
      // at a move that did not happen.
      console.error("[LIZA] page reorder failed, reverting:", err);
      this._pages = before;
      this._currentPageIdx = beforeIdx;
      this._render();
    } finally {
      this._pageOpInFlight = false;
    }
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
      this._wireActionMoves(editor);
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
   * Take over "Move up" / "Move down" from the action rows.
   *
   * These two menu items are the only way to reorder presses without a mouse.
   * Home Assistant's drag handle needs a pointer drag, which a touch user
   * cannot perform against a scrolling page -- so on a phone the menu *is* the
   * reordering control, not a convenience beside it.
   *
   * Listened for in the *capture* phase on the editor host. The row fires
   * `move-up` composed, so it crosses the shadow boundary and reaches us on
   * the way down, before the list's own at-target handler runs; stopping it
   * there means exactly one reorder happens rather than ours and theirs both
   * landing. Taking the move over outright also makes it independent of the
   * frontend version -- the list's internals are not API, and they are where
   * the animation has to hook in.
   */
  _wireActionMoves(editor) {
    const handle = (ev, delta) => {
      const row = ev.target;
      const rows = Array.from(
        editor.shadowRoot?.querySelectorAll(".rows > ha-automation-action-row") || [],
      );
      const from = Number.isInteger(row?.index) ? row.index : rows.indexOf(row);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= this._sequence.length) return;
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      this._animateRowSwap(rows[from], rows[to], () => this._moveAction(from, to));
    };
    editor.addEventListener("move-up", (ev) => handle(ev, -1), true);
    editor.addEventListener("move-down", (ev) => handle(ev, 1), true);
  }

  /**
   * Slide the two rows past each other, then apply the move.
   *
   * A reorder with no motion is a list that looks identical and is not: the
   * rows are titled by what they do, so two presses swapping places reads as
   * the text having changed rather than the order. The swap is the one thing
   * that says *which* row moved and where it went -- and it matters most for
   * the touch user who reached this through the menu and never saw a drag.
   *
   * Applied on completion rather than alongside, so the animation plays
   * against a stable list: committing first would re-render the rows out from
   * under the transforms. `prefers-reduced-motion` and any browser without the
   * animation API fall straight through to the move itself; the timeout is the
   * same guarantee for a row torn down mid-flight, since a cancelled animation
   * never reports finishing and the reorder must not be lost with it.
   */
  _animateRowSwap(a, b, done) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce || !a || !b || typeof a.animate !== "function") { done(); return; }
    const dy = b.getBoundingClientRect().top - a.getBoundingClientRect().top;
    const opts = { duration: 180, easing: "ease-in-out", fill: "forwards" };
    const up = a.animate([{ transform: "translateY(0)" }, { transform: `translateY(${dy}px)` }], opts);
    const down = b.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-dy}px)` }], opts);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
      // Held until the rows have re-rendered in their new order. Dropping the
      // transforms any earlier snaps both rows back to where they started for
      // a frame, which is the flicker the animation exists to avoid.
      requestAnimationFrame(() => { try { up.cancel(); down.cancel(); } catch (e) {} });
    };
    up.addEventListener("finish", finish);
    setTimeout(finish, opts.duration + 80);
  }

  /**
   * Move one action to another position and commit it.
   *
   * Routed through `_onSequenceChanged` rather than written straight to the
   * assignment, because a reorder is not just a new list: the presses carry
   * icons and tooltips that have to travel with them, and that handler is
   * where `_applyCycle` does it. A drag already arrives this way, so the menu
   * and the handle end in the same place.
   *
   * Focus returns to the row that moved. It was the menu's anchor and the
   * menu is now gone, so without this a keyboard user is dropped at the top of
   * the document after every single step.
   */
  _moveAction(from, to) {
    const next = this._sequence.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    if (this._editorEl) this._editorEl.actions = next;
    this._onSequenceChanged({ detail: { value: next }, stopPropagation: () => {} });
    requestAnimationFrame(() => {
      const rows = this._editorEl?.shadowRoot?.querySelectorAll(".rows > ha-automation-action-row");
      rows?.[to]?.focus?.();
    });
  }

  // Whether this remote's settings (the gear tab) have *section* on. Off until
  // they are loaded, so a feature never flickers into view while the panel is
  // still asking the backend what the remote is set to.
  _featureEnabled(section) {
    return this._textSettings?.settings?.[section]?.enabled === true;
  }

  _longtouchEnabled() {
    return this._featureEnabled("longtouch");
  }

  // Whether buttons on this remote may carry a toggle. Gates the editor section
  // only; the backend applies the same switch to what the remote actually does,
  // and neither side strips a stored block, so turning it off hides the
  // configuration rather than losing it.
  _toggleFeatureEnabled() {
    return this._featureEnabled("toggle");
  }

  /**
   * Whether this button's action list means "one action per press".
   *
   * A cycle is a list of actions run one at a time, which is the list
   * `ha-automation-action` already draws -- so the editor *is* the cycle
   * editor, and the second action a user adds is the second press. That
   * reading is only on where the remote's Buttons setting asks for it; with it
   * off the editor keeps the single-action cap and behaves as it always did.
   *
   * Grid buttons only: a slider is a proportional control with no press to
   * count, so there is nothing for a cycle to advance on.
   */
  _cycleEnabled(key) {
    return !!key && isGridBtn(key) && !!this._toggleFeatureEnabled?.();
  }

  /**
   * One button's presses, flattened into the single list the editor shows.
   *
   * `config` is press 1 and `toggle.rules[0]` mirrors it, so the later presses
   * are `rules[1..]`. A button with no block is a cycle of one and yields just
   * its own action, which is what makes this safe to use everywhere `config`
   * used to be read into `_sequence`.
   *
   * A button that cannot cycle yields only its own action even if a block is
   * stored. The feature switch hides a cycle rather than deleting it, so the
   * presses survive being turned off -- but while it is off the editor has the
   * single-action cap on, and handing it a list it is forbidden to show would
   * mean the card and the remote disagreed about what the button does.
   */
  _cycleSequence(assign, key = this._selectedButton?.key) {
    const own = Array.isArray(assign?.config) ? assign.config : [];
    const rules = assign?.toggle?.rules;
    if (!this._cycleEnabled(key)) return [...own];
    if (!Array.isArray(rules) || rules.length < 2) return [...own];
    return [...own, ...rules.slice(1).flatMap(
      (r) => (Array.isArray(r?.config) ? r.config : []))];
  }

  /**
   * What the *button itself* runs: press 1, never the whole cycle.
   *
   * `config` is read by everything that asks what a button is -- its subject
   * entity, its label, its library action, the face it draws -- and it is also
   * what the remote falls back to when the toggle feature is switched off. Let
   * the whole cycle into it and turning the feature off would make one press
   * fire every step at once.
   */
  _clickSequence() {
    if (!this._cycleEnabled(this._selectedButton?.key)) return this._sequence;
    return this._sequence.length ? [this._sequence[0]] : [];
  }

  // The long-touch steps of the selected button. One shared empty list when
  // there are none, so the identity test that keeps the editor from being
  // reset (and folded up) on every render holds for an empty button too.
  _longtouchSequence() {
    const key = this._selectedButton?.key;
    const steps = key ? this._editAssign(key)?.longtouch : null;
    if (Array.isArray(steps) && steps.length) return steps;
    return this._noLongtouch || (this._noLongtouch = []);
  }

  /**
   * The editor for the action a long touch runs, below the click's.
   *
   * Reused exactly while the click editor is: that one is cleared wherever the
   * editing context changes, and a long-touch editor built beside a different
   * click editor belongs to another button.
   */
  async _mountLongtouchEditor(containerId) {
    const container = this.shadowRoot?.querySelector(`#${containerId}`);
    if (!container) return;
    const sequence = this._longtouchSequence();
    if (this._longEditorEl && this._editorEl && this._longEditorOwner === this._editorEl) {
      container.replaceChildren(this._longEditorEl);
      this._longEditorEl.hass = this._editorHass();
      this._longEditorEl.narrow = this._narrow;
      if (this._longEditorEl.actions !== sequence) this._longEditorEl.actions = sequence;
      this._enforceSingleAction(this._longEditorEl);
      return;
    }
    container.innerHTML = "";
    this._longEditorEl = null;
    await this._loadHaComponents();
    if (!customElements.get("ha-automation-action")) return;
    const editor = document.createElement("ha-automation-action");
    editor.hass = this._editorHass();
    editor.narrow = this._narrow;
    editor.actions = sequence;
    editor.addEventListener("value-changed", (ev) => this._onLongtouchChanged(ev));
    container.appendChild(editor);
    this._longEditorEl = editor;
    this._longEditorOwner = this._editorEl;
    this._enforceSingleAction(editor);
  }

  _onLongtouchChanged(ev) {
    ev.stopPropagation();
    const value = ev.detail?.value;
    const key = this._selectedButton?.key;
    if (!Array.isArray(value) || !key) return;
    // One step, like the click: the editor below it is a single action.
    if (value.length) {
      this._editAssignEnsure(key).longtouch = [value[0]];
    } else {
      const assign = this._editAssign(key);
      if (assign) delete assign.longtouch;
    }
    const sequence = this._longtouchSequence();
    if (this._longEditorEl) {
      if (this._longEditorEl.actions !== sequence) this._longEditorEl.actions = sequence;
      this._enforceSingleAction(this._longEditorEl);
    }
    this._scheduleAutoSave();
    this._refreshSVG();
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
      const declared = hass.services.lizaip[(cmd.service || "").split(".")[1]]?.fields || {};
      const params = cmd.target_params || [];
      const idKey = params.find((p) => p.type === "page_id")?.key;
      const nameKey = params.find((p) => p.type === "page_name")?.key;
      // A spelling the service no longer declares cannot be the picker: the
      // dropdown is grafted onto a field of the schema, so choosing one that
      // is not there would leave the step with no target control at all. A
      // button stored against a withdrawn spelling falls back to the one that
      // is still offered.
      const offered = [idKey, nameKey].filter((k) => k && declared[k]);
      const inUse = storedKey(cmd.service, offered);
      return { cmd, idKey, picker: inUse || offered[0] || null };
    });

    // Keyed on what the dropdowns are made of, not on `hass`.
    //
    // Home Assistant builds a new `hass` on every state change but keeps one
    // `services` object until a service actually changes, so this hits on the
    // ticks that used to miss -- and `ha-service-control` memoises on
    // `hass.services`, which therefore now holds still instead of being
    // replaced several times a second while the user types.
    const key = pages.map((p) => `${p.id}\u0000${this._pageLabel(p)}\u0000${this._pageDisplayLine(p)}`).join("\u0001")
      + "\u0002" + plan.map((p) => `${p.cmd.service}\u0000${p.picker ?? ""}`).join("\u0001");
    const cached = this._editorHassCache;
    if (cached?.key === key && cached?.fromServices === hass.services) {
      // Same `hass` as well, so the whole object can be handed back -- which
      // some callers compare by identity.
      if (cached.hass === hass) return cached.whole;
      // Only the services are reused: the caller wants this tick's states.
      const whole = { ...hass, services: cached.patchedServices };
      this._editorHassCache = { ...cached, hass, whole };
      return whole;
    }

    // Two spellings of the same list: ids to store, names to read. Both show
    // "Page 3/9 (#24) · Title" -- an HA dropdown option is one line, so the
    // title follows the position rather than sitting under it. The by-name
    // value stays the bare name: that is what gets stored and resolved.
    const byId = pages.map((page) => ({ value: String(page.id), label: this._pageDisplayLine(page) }));
    const byNameOptions = pages.map((page) => ({ value: this._pageLabel(page), label: this._pageDisplayLine(page) }));

    const lizaip = { ...hass.services.lizaip };
    for (const { cmd, picker, idKey } of plan) {
      const options = picker === idKey ? byId : byNameOptions;
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

    const services = { ...hass.services, lizaip };
    const whole = { ...hass, services };
    // `fromServices` is what HA handed us and what the next call compares
    // against; `patchedServices` is the rewritten copy handed back.
    this._editorHassCache = { hass, fromServices: hass.services, key, patchedServices: services, whole };
    return whole;
  }

  /**
   * Hold the click editor to one action -- unless that button cycles.
   *
   * The cap is one injected stylesheet hiding Home Assistant's own "add" and
   * overflow controls, plus a proxy button of ours that clicks the hidden one.
   * A cycle is a list of actions run one per press, which is exactly the list
   * this editor draws, so there the proxy stays and keeps offering more; for
   * everything else it goes away once the button has its one action.
   *
   * HA's own button is hidden in *every* state, cycle included, and the proxy
   * is the only add control the card ever shows. That is a wording decision as
   * much as a layout one: the button that adds a press should say so, and HA's
   * lives in a shadow root we cannot translate. It also keeps the control in
   * one place instead of moving from below the list to inside it the moment a
   * first action appears.
   *
   * The proxy is still hidden for a blank non-cycling button's second action,
   * because the first action is what makes a button a button and a second one
   * would never run.
   *
   * Scoping does the rest. The stylesheet lives in this editor's shadow root,
   * so it never reached the `ha-button-menu` inside each action *row* -- which
   * is why a single action already has its own overflow menu, and why a cycle
   * keeps HA's own row menus and drag handles.
   *
   * `.buttons` is the one selector that still matters: `ha-automation-action`
   * renders its Add-action button as `<div class="buttons"><ha-button>` inside
   * its `<ha-sortable>`, so hiding that div is the cap and the proxy's click
   * target is the `ha-button` inside it -- hidden by `visibility`, which still
   * takes a programmatic click. `.link-button-row` and `ha-button-menu` are
   * kept beside it because they were the shape of the same control on earlier
   * frontends, and `hacs.json` still supports back to 2026.8.
   */
  _enforceSingleAction(editor) {
    const STYLE_ID = "liza-single-action";
    const NUM_STYLE_ID = "liza-press-numbers";
    const GAP_STYLE_ID = "liza-action-gaps";
    // The action cards space themselves, inside this shadow root, on a step of
    // their own -- so the one list on the card that is not ours was the one
    // list with a different rhythm. Reached the same way the move buttons are
    // (see `_wireActionMoves`): the internals are not API, but they are where
    // the spacing is. Written as gap plus zeroed margins rather than as a
    // margin of our own, so it lands on the same value whichever of the two
    // the installed frontend happens to use.
    const GAP_CSS = `
      .rows { display: flex; flex-direction: column; gap: var(--liza-field-gap, 16px); }
      .rows > * { margin-top: 0 !important; margin-bottom: 0 !important; }`;
    const HIDE_CSS = `.link-button-row, ha-button-menu, .buttons { visibility:hidden!important; height:0!important; overflow:hidden!important; margin:0!important; padding:0!important; }`;
    // Number each action card with the press that runs it.
    //
    // Hung off `.handle` rather than the row, and that is not a preference.
    // `ha-automation-action-row`'s shadow root contains exactly one slot --
    // `<slot name="icons">` -- and no default slot, so a `::before` on the row
    // host would be an unslotted light-DOM child and would never be painted.
    // The handle is a plain `<div class="handle" slot="icons">` that Home
    // Assistant renders into that very slot, it has no shadow root of its own,
    // and it sits in this editor's root where our stylesheet can reach it. So
    // it is the one node here that can carry a counter and show it.
    //
    // Reading the counter off the same element that increments it keeps the
    // numbering in DOM order for free, which is the order the presses run in,
    // which is the order HA's own drag-and-drop rewrites.
    //
    // The handle already means "this row has a position in a list"; putting
    // the position on it says which one. Muted and unfilled, in the same ink
    // as the drag glyph beside it, so it reads as part of the handle rather
    // than as a badge stuck on the card -- a filled pill says "status" or
    // "count", and this is neither. Tabular figures so the cards do not shift
    // as the count passes nine.
    const NUM_CSS = `
      .rows { counter-reset: liza-press; }
      .rows .handle { counter-increment: liza-press; gap: 2px; }
      .rows .handle::before {
        content: counter(liza-press);
        color: var(--liza-muted-text, var(--secondary-text-color, #727272));
        /* The size the appearance rail numbers its presses at. The two lists
           number the same presses, so a number in one has to look like the
           same kind of thing as the number beside it in the other. */
        font-size: calc(13px * var(--ha-font-size-scale, 1));
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        font-family: var(--paper-font-body1_-_font-family, inherit);
      }`;
    const inject = () => {
      const sr = editor.shadowRoot;
      if (!sr) return false;
      let styleEl = sr.querySelector(`#${STYLE_ID}`);
      if (!styleEl) {
        styleEl = document.createElement("style"); styleEl.id = STYLE_ID; styleEl.textContent = HIDE_CSS;
        sr.appendChild(styleEl);
      }
      let numEl = sr.querySelector(`#${NUM_STYLE_ID}`);
      if (!numEl) {
        numEl = document.createElement("style"); numEl.id = NUM_STYLE_ID; numEl.textContent = NUM_CSS;
        sr.appendChild(numEl);
      }
      if (!sr.querySelector(`#${GAP_STYLE_ID}`)) {
        const gapEl = document.createElement("style");
        gapEl.id = GAP_STYLE_ID; gapEl.textContent = GAP_CSS;
        sr.appendChild(gapEl);
      }
      sr.querySelector("#liza-fab-style")?.remove();
      sr.querySelector("#liza-btn-style")?.remove();
      const isLong = editor === this._longEditorEl;
      const sequence = isLong ? this._longtouchSequence() : this._sequence;
      const hasAction = sequence && sequence.length > 0;
      // Long touch runs one action, always: it is a second gesture on the same
      // button, not a second press of the first one.
      const cycling = !isLong && hasAction && this._cycleEnabled(this._selectedButton?.key);
      // Home Assistant's own Add-action button stays hidden in every state now,
      // and our proxy clicks it. It used to take over once a cycle had its
      // first action, which meant the control that adds a press was labelled
      // "Add action" -- true of the dialog it opens, silent about what the new
      // action becomes, and in HA's shadow root where we cannot translate it.
      // One button in both states also means one position: below the list,
      // where the empty-state button already sat.
      styleEl.disabled = false;
      // Only a cycle has presses to number. A plain button's single action is
      // not "press 1 of 1", and a long touch is a different gesture, not a
      // step -- numbering either would invent an order that is not there.
      numEl.disabled = !cycling || sequence.length < 2;
      let btn = editor.parentElement?.querySelector(".liza-add-action-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.className = "liza-add-action-btn";
        btn.addEventListener("click", () => {
          const nativeBtn = sr.querySelector(".buttons ha-button") || sr.querySelector("ha-button-menu");
          if (nativeBtn) nativeBtn.click();
        });
        editor.parentElement?.appendChild(btn);
      }
      // Set on every pass, not just on creation: the same button now says two
      // different things, and which one depends on state that changes under it.
      //
      // "Press", not "action". The list above is a list of presses -- that is
      // what the card calls them, what the chips count and what the rows below
      // are titled -- and "action" is only how one is built. "Next" because
      // this always appends: the new press runs after every press already
      // there, which is the one thing a user cannot tell from a button that
      // just says "add".
      const label = this._t(this._addActionLabelKey({ isLong, cycling }));
      const wanted = `+ ${label}`;
      if (btn.textContent !== wanted) btn.textContent = wanted;
      // Shown while the button has no action at all -- the first action is what
      // makes a button a button -- and then again only for a cycle, which is
      // the one kind that runs more than one. For everything else the cap is
      // the point: a second action would never run.
      btn.style.display = this._addActionVisible({ hasAction, cycling }) ? "" : "none";
      return true;
    };
    if (!inject()) {
      let tries = 0;
      const id = setInterval(() => { if (inject() || ++tries > 30) clearInterval(id); }, 100);
    }
    editor.style.cssText = "";
  }

  /**
   * What the add button says.
   *
   * Split out of the injector because it is the whole decision and the
   * injector around it needs a live shadow root to run at all.
   *
   * "Press", not "action", once the button cycles. The list above is a list of
   * presses -- that is what the card calls them, what the chips count and what
   * the appearance rows are titled -- and an action is only how one is built.
   * "Next" because this always appends: the new press runs after every press
   * already there, which is the one thing a user cannot tell from a control
   * that just says "add". A long touch is a different gesture rather than a
   * further press, so it never reaches the cycling wording.
   */
  _addActionLabelKey({ isLong, cycling }) {
    if (cycling) return "toggle_add_press";
    return isLong ? "add_longtouch_action" : "add_click_action";
  }

  /**
   * Whether the add button is offered at all.
   *
   * Two separate reasons to show it, and they do not overlap: a button with no
   * action needs its first one, and a cycling button can always take another
   * press. Everything in between is the cap -- a second action on a button
   * that runs one would never fire, so offering it would be a lie.
   */
  _addActionVisible({ hasAction, cycling }) {
    return !hasAction || !!cycling;
  }

  // =================== RENDERING ===================
  _render() {
    try {
      // Every render replaces the shadow tree wholesale, so the icon pass's
      // record of which entities are on screen describes markup that is about
      // to stop existing.
      this._invalidateFaceCaches();
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
          // `close()` fires `close`, which a dialog listening for its own
          // dismissal cannot tell from Escape. The flag says this one is ours,
          // so it does not tear itself down and leave its buttons dead.
          this._reattachingOverlays = true;
          try {
            if (overlay.open) overlay.close();
            overlay.showModal();
          } finally {
            this._reattachingOverlays = false;
          }
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

  /**
   * The `<style>` tag a render has to carry, if any.
   *
   * Empty once the stylesheet has been adopted by the shadow root, which is
   * the normal case: the root keeps it across every `innerHTML` rewrite, so
   * repeating it in the markup would only make the browser parse the same
   * hundred kilobytes again on every render.
   */
  _styleTag() {
    return this._stylesAdopted ? "" : `<style>${STYLES}</style>`;
  }

  _renderDeviceList() {
    this.shadowRoot.innerHTML = `
      ${this._styleTag()}
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
              ${this._htmlDiagnosticsMenuButton(d.entry_id, "device-item-menu")}
            </div>`;
            }).join("")}</div>`}
      </div></ha-card></div>
      ${this._htmlDiagnosticsPill?.() || ""}
      <div class="toast" role="status" aria-live="polite"></div>`;
    const mb = this.shadowRoot.querySelector("ha-menu-button");
    if (mb) { mb.hass = this._hass; mb.narrow = this._narrow; }
    this.shadowRoot.querySelectorAll(".device-item").forEach(el =>
      el.addEventListener("click", () => this._selectDevice(el.dataset.entry)));
    this._wireDiagnosticsMenus?.();
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
      ${this._styleTag()}
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
        <!-- Outside the tablist: it is not a tab, and a reader walking the
             tabs with the arrow keys must not land on it. -->
        ${this._htmlDiagnosticsMenuButton(this._currentEntry, "toolbar-menu")}
      </div>
      <!-- tabindex="-1", not "0": a tabpanel earns a tab stop only when it has
           no focusable content, and this one wraps the entire view. -->
      <div class="view" id="liza-tabpanel" role="tabpanel" aria-labelledby="liza-tab-${this._activeTab}" tabindex="-1">
        ${this._activeTab === "buttons" ? this._htmlButtonsView(bp)
          : this._activeTab === "debug" ? (this._htmlDebugView?.() ?? "")
          : this._activeTab === "settings" ? this._htmlSettingsView()
          : this._htmlActionsView()}
      </div>
      ${this._htmlDiagnosticsPill?.() || ""}
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
    // After the tabs' own wiring: the toolbar menu and the pill sit outside
    // every view, and a view that threw would otherwise take them with it.
    this._wireDiagnosticsMenus?.();
  }

}

// Apply mixins. I18n goes first: every other mixin calls `_t`.
Object.assign(LizaRemotePanel.prototype, I18nMixin);
Object.assign(LizaRemotePanel.prototype, DataMixin);
Object.assign(LizaRemotePanel.prototype, HelpersMixin);
Object.assign(LizaRemotePanel.prototype, VariablesMixin);
Object.assign(LizaRemotePanel.prototype, StatesMixin);
Object.assign(LizaRemotePanel.prototype, ButtonsViewMixin);
Object.assign(LizaRemotePanel.prototype, ButtonTipMixin);
Object.assign(LizaRemotePanel.prototype, ActionsViewMixin);
Object.assign(LizaRemotePanel.prototype, SettingsViewMixin);
Object.assign(LizaRemotePanel.prototype, A11yMixin);

if (!customElements.get("liza-remote-panel")) {
  customElements.define("liza-remote-panel", LizaRemotePanel);
}

// Exported so the panel tests can exercise a prototype method directly: the
// element itself cannot be constructed outside a browser.
export { LizaRemotePanel };

