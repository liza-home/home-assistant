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
 *   - lizaip-data.js      — backend communication (load/auto-save)
 *   - lizaip-helpers.js   — utilities, icon resolution, labeling
 *   - lizaip-variables.js — ${…} variables in the previews, answered by the backend
 *   - lizaip-states.js    — state derivation & states editor
 *   - lizaip-buttons-view.js — Buttons tab HTML + wiring
 *   - lizaip-button-tip.js — the hover card over a shape on the face
 *   - lizaip-actions-view.js — Actions tab HTML + wiring
 *   - lizaip-styles.js    — CSS styles
 *   - lizaip-stylesheet.js — adopts those styles onto the shadow root
 *   - lizaip-svg.js       — SVG rendering
 */

import { STYLES } from "./lizaip-styles.js";
import { adoptStyles } from "./lizaip-stylesheet.js";
import { DataMixin } from "./lizaip-data.js";
import { HelpersMixin, syncCustomIcons, isMovableSlot } from "./lizaip-helpers.js";
import { VariablesMixin } from "./lizaip-variables.js";
import { A11yMixin } from "./lizaip-a11y.js";
import { I18nMixin } from "./lizaip-i18n.js";
import { StatesMixin } from "./lizaip-states.js";
import {
  ButtonsViewMixin,
  OVERRIDABLE_FIXED_BUTTONS,
  isGridBtn,
  isConfigured,
} from "./lizaip-buttons-view.js";
import { ActionsViewMixin } from "./lizaip-actions-view.js";
import { SettingsViewMixin, THEME_DEFAULT } from "./lizaip-settings-view.js";
import { RestoreViewMixin } from "./lizaip-restore-view.js";
import { ThemeDownloadMixin } from "./lizaip-theme-download.js";
import { GuideViewMixin, PANEL_MIN } from "./lizaip-guide-view.js";
import { DiscoveryMixin } from "./lizaip-discovery.js";
import { PeopleViewMixin } from "./lizaip-people-view.js";
import { ButtonTipMixin } from "./lizaip-button-tip.js";
import { RouteMixin, ROUTE_PREFIX } from "./lizaip-route.js";
import { SETUP_STEP_ICONS, SETUP_QR } from "./lizaip-setup-steps.js";


/**
 * Panel routines a template may name instead of a page to write.
 *
 * Empty here on purpose: a module that owns such a routine registers it when
 * it loads, the way a Home Assistant component registers its own services. So
 * a build that never loaded the debug tools holds no name for them, and the
 * card naming one it does not have is dropped before anything draws it.
 */
const TEMPLATE_ACTIONS = {};

/** Offer `{action: method}` names to the add-page dialog. */
export function registerTemplateActions(actions) {
  Object.assign(TEMPLATE_ACTIONS, actions);
}

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
    // A restore being written. Only the applying half: the reading half
    // happens inside the restore window, which says so itself, and the ⋮ has
    // nothing to add while a window is open in front of it.
    this._restoreBusy = null;
    // The open restore window, so a second ⋮ click does not stack another.
    this._restoreDialog = null;
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
    // Pessimistic until a scan says otherwise: everything that deletes in bulk
    // reads this, and the unsafe answer is the optimistic one.
    this._usageScanComplete = false;
    this._actionFilter = "";
    this._actionScope = "all";
    this._actionSort = "domain";
    // Both directions are tracked, because the default flips with library
    // size; see `_isActionGroupCollapsed`.
    this._collapsedActionGroups = new Set();
    this._expandedActionGroups = new Set();
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
    // The same deferral for the caller's scope: an assignment that moves
    // mid-load must still close a remote that is no longer theirs.
    this._scopeStale = false;
    // True while a page add/delete/reorder is in flight, so the config_changed
    // the backend fires mid-operation is ignored rather than raced against.
    this._pageOpInFlight = false;
    // A dynamic refresh announced during that operation, applied once it ends.
    this._refreshAfterPageOp = false;
    this._haComponentsLoaded = false;
    // Whether the build-static tables have been fetched already. `_init` runs
    // again on every re-attach, and these answer to the build rather than to
    // any remote, so a second fetch can only return what is already here.
    this._staticLoaded = false;
    this._sliderControlsLoaded = false;
    // The path last written to the address bar, so an unchanged selection
    // costs one string compare per render, and so the `location-changed` echo
    // of our own `replaceState` is recognised rather than followed.
    this._lastRoutePath = null;
    // True while `_routeNavigate` is fetching, so a second navigation cannot
    // interleave its load with the first one's.
    this._routeNavigating = false;
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

  /**
   * Keep `.panel-narrow` and `--liza-toolbar-h` in step with the toolbar.
   *
   * This used to be `@media (max-width: 600px)`, which was right until the
   * guide drawer took a column out of the panel: a media query asks the
   * viewport, so a 500px panel inside a 1600px window was still told it was
   * roomy and kept a wide toolbar that then wrapped into a ragged stack.
   *
   * The bar is measured rather than the host because the two are no longer
   * the same width: the guide now starts *below* the toolbar, so the toolbar
   * keeps the whole panel while the view under it gives up the column. What
   * has to fit is the bar, so the bar is what is asked.
   *
   * Its height is published in the same pass, because that is where the
   * drawer's top edge goes and the bar is not a fixed 56px -- at 200% text it
   * wraps to two rows and three on a narrow panel.
   *
   * A ResizeObserver rather than a resize listener: the panel's width changes
   * without the window's when HA collapses its own sidebar. `container-type:
   * inline-size` would say the first half in CSS alone, but it makes the host
   * a containing block for `position: fixed` descendants, which is exactly
   * what the drawer relies on not being true.
   */
  _narrowWatch() {
    if (typeof ResizeObserver === "undefined") {
      // No observer here means no reflow, which is a WCAG 1.4.10 failure, so
      // fall back to the viewport: wrong under a collapsed HA sidebar, right
      // otherwise.
      this._narrowApply(window.innerWidth || 0);
      return;
    }
    this._narrowObs ||= new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.borderBoxSize?.[0];
      // The border box, not the content box: the bar's own padding is part of
      // what it has to fit its contents into, and `contentRect` is the
      // documented fallback for an observer that reports neither.
      this._narrowApply(box ? box.inlineSize : entry?.contentRect?.width ?? 0);
      this._toolbarHeight(entry?.target);
    });
    // Every render replaces the bar, so the old node is observed and the new
    // one is not. Re-pointed here, which each render calls.
    const bar = this.shadowRoot?.querySelector(".toolbar");
    if (!bar || bar === this._narrowEl) return;
    this._narrowObs.disconnect();
    this._narrowObs.observe(bar);
    this._narrowEl = bar;
    // The observer's first callback is a frame away, and the drawer may be
    // restored before it arrives.
    this._toolbarHeight(bar);
    this._narrowApply(bar.getBoundingClientRect?.().width ?? 0);
  }

  _narrowApply(width) {
    // 0 is what a detached or display:none host reports; it is not narrow,
    // it is unmeasured, and acting on it flickers the toolbar on every hide.
    if (!width) return;
    this.classList.toggle("panel-narrow", width < PANEL_MIN);
  }

  /** Where the guide's top edge goes, so it starts under the bar. */
  _toolbarHeight(bar) {
    const height = bar?.getBoundingClientRect?.().height || 0;
    if (!height) return;
    this.style.setProperty("--liza-toolbar-h", `${Math.round(height)}px`);
  }

  _narrowStop() {
    this._narrowObs?.disconnect();
    this._narrowObs = null;
    this._narrowEl = null;
  }

  connectedCallback() {
    console.log("[lizaIP] connectedCallback, initialized:", this._initialized, "hass:", !!this._hass);
    this._a11yInit();
    this._narrowWatch();
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
    this._narrowStop();
    this._stopSettingsDemos?.();
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
    // The handler coalesces into a frame callback, so a resize in the same
    // frame as the teardown would otherwise draw into a detached element.
    if (this._gotoLinkResizeFrame != null) {
      (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(
        this._gotoLinkResizeFrame,
      );
      this._gotoLinkResizeFrame = null;
    }
    // Same shape: the guide drawer watches the viewport for the width at which
    // it has to give up and become a dialog again.
    this._guideTeardown?.();
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
    if (this._labelRegistryUnsub) {
      Promise.resolve(this._labelRegistryUnsub).then(u => u && u()).catch(() => {});
      this._labelRegistryUnsub = null;
    }
    this._unsubscribeDeviceSynced?.();
    this._unsubscribeDiscovery?.();
    if (this._devicesUnsub) {
      Promise.resolve(this._devicesUnsub).then(u => u && u()).catch(() => {});
      this._devicesUnsub = null;
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
    if (!this._canSubscribeEvents()) return;
    try {
      this._configChangedUnsub = await this._hass.connection.subscribeEvents(
        (ev) => this._onConfigChanged(ev),
        "lizaip_config_config_changed",
      );
    } catch (e) {
      // Live updates are a convenience; the refresh control still works.
      console.debug("[lizaIP] config_changed subscription failed:", e);
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
    if (!this._canSubscribeEvents()) return;
    try {
      this._helloUnsub = await this._hass.connection.subscribeEvents(
        (ev) => this._onDeviceHello(ev),
        "lizaip_device_hello",
      );
    } catch (e) {
      console.debug("[lizaIP] device_hello subscription failed:", e);
    }
  }

  async _onDeviceHello(ev) {
    if (!this._currentEntry || ev?.data?.entry_id !== this._currentEntry) return;
    if (this._loading) return;
    // A reconnect is often a reboot, which closes the log port.
    this._recheckDebugPort?.();
    if (this._memoryEnabled?.()) this._memoryFetchSoon();
    // Re-rendered only on a real change: every reconnect lands here, and the
    // usual case is a device whose model the backend already knew. Safe to run
    // mid-edit, unlike `_reloadFromBackend` — nothing the user has typed lives
    // in the blueprint, so there is no unflushed state to discard.
    if (await this._refreshBlueprint()) this._render();
  }

  /**
   * Whether the signed-in user administers Home Assistant.
   *
   * Only an explicit `is_admin: false` counts as "no". A `hass` without a user
   * on it is not evidence of anything, and guessing somebody is not an
   * administrator would hide controls from the one person who needs them. The
   * commands behind every gated control refuse the wrong caller anyway -- this
   * is about not offering what cannot be done, not about the boundary.
   */
  _isAdmin() {
    const user = this._hass?.user;
    return !user || user.is_admin !== false;
  }

  /**
   * Whether this user may subscribe to the integration's own events.
   *
   * Home Assistant reserves `subscribe_events` for administrators, so for
   * anybody else the call is refused and logged as an error on the way. The
   * subscriptions are a convenience either way -- every view they feed has a
   * refresh of its own -- so an assigned user is simply not asked to make a
   * request that cannot succeed.
   */
  _canSubscribeEvents() {
    return this._isAdmin();
  }

  /**
   * Follow the device list, which is now a per-user answer.
   *
   * A remote can be taken away from somebody while they are looking at it, or
   * handed to them while the panel is open, so the list cannot be a snapshot
   * taken at load. The backend re-sends the caller's own scoped list whenever
   * an assignment moves; here that becomes a repaint, and -- when the remote
   * being configured is the one that went away -- a fall back to the list.
   *
   * Availability is not its concern: `_onAvailabilityChanged` owns the badges
   * and arrives far more often.
   */
  async _subscribeDevices() {
    if (this._devicesUnsub || !this._hass?.connection) return;
    try {
      this._devicesUnsub = await this._hass.connection.subscribeMessage(
        (msg) => this._onDevicesChanged(msg),
        { type: "lizaip_config/subscribe_devices", language: this._uiLanguage() },
      );
    } catch (e) {
      console.debug("[lizaIP] device subscription failed:", e);
    }
  }

  async _onDevicesChanged(msg) {
    const devices = msg?.devices;
    if (!Array.isArray(devices)) return;
    this._devices = devices;
    // Mid-load the route has not been resolved yet, so the check is deferred
    // rather than dropped: a remote revoked during a load would stay open.
    if (!this._initDone || this._loading) {
      this._scopeStale = true;
      return;
    }
    this._applyScope();
    this._render();
  }

  /**
   * Leave the open remote if the last device list no longer carries it.
   */
  _applyScope() {
    this._scopeStale = false;
    const open = this._currentEntry;
    if (!open || this._devices.some(d => d?.entry_id === open)) return;
    // The remote being configured is no longer the user's. Back to the
    // list, which is now either somebody else's remotes or the empty state.
    this._clearEntrySelection();
    this._routeNavigate?.(ROUTE_PREFIX);
  }

  _flushScope() {
    if (!this._scopeStale) return;
    this._applyScope();
    this._render();
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
    if (!this._canSubscribeEvents()) return;
    try {
      this._availabilityUnsub = await this._hass.connection.subscribeEvents(
        (ev) => this._onAvailabilityChanged(ev),
        "lizaip_device_availability",
      );
    } catch (e) {
      console.debug("[lizaIP] availability subscription failed:", e);
    }
  }

  /**
   * Follow the label registry, which `hass` does not carry.
   *
   * The other registries arrive on every `hass` update, so a label renamed in
   * another tab corrects itself. `_labels` is fetched once by `_init`, and
   * without this it would keep naming the label it was called when the panel
   * opened -- on the settings header, where `${_device.label_names}` is
   * previewed, and in the picker. The remote itself is never wrong: the
   * backend reads the live registry on each repaint. This is the editor
   * catching up with it.
   */
  async _subscribeLabelRegistry() {
    if (this._labelRegistryUnsub || !this._hass?.connection) return;
    try {
      this._labelRegistryUnsub = await this._hass.connection.subscribeEvents(
        () => this._onLabelRegistryChanged(),
        "label_registry_updated",
      );
    } catch (e) {
      console.debug("[lizaIP] label_registry subscription failed:", e);
    }
  }

  async _onLabelRegistryChanged() {
    // The event says only that something moved, so the list is refetched
    // whole -- the same call `_init` makes, and the same shape.
    await this._loadLabels();
    if (this._initDone) this._render();
  }

  async _onAvailabilityChanged(ev) {    // Not filtered by `_currentEntry` the way the other two handlers are: every
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
      console.debug("[lizaIP] connection-ready hook unavailable:", e);
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
    //
    // Except a dynamic refresh, which is a change of its own rather than an echo
    // of the operation: adding a page makes the Table of contents fill a slot for
    // it, and dropping that left its cached buttons -- and so its link to the
    // new page -- stale until a reload. It is applied once the operation ends.
    if (this._pageOpInFlight) {
      if (ev?.data?.refreshed) this._refreshAfterPageOp = true;
      return;
    }

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
  /**
   * Resolves once no page add/delete/reorder is running.
   *
   * Each of them sends or receives the whole page list: a delete sent while
   * an add is still saving names a list without the added pages, and the
   * add's answer then brings back the page just deleted.
   */
  _whenPageOpsIdle() {
    if (!this._pageOpInFlight) return Promise.resolve();
    return new Promise(resolve => (this._pageOpWaiters ||= []).push(resolve));
  }

  /** End a page add/delete/reorder, applying a refresh deferred meanwhile. */
  _endPageOp() {
    this._pageOpInFlight = false;
    for (const resolve of this._pageOpWaiters?.splice(0) || []) resolve();
    if (!this._refreshAfterPageOp) return;
    this._refreshAfterPageOp = false;
    this._pendingConfigReload = true;
    this._flushPendingConfigReload();
  }

  _isEditingLive() {
    if (this._autoSaveTimer) return true;
    // A save that has started but not landed is just as unsafe as an unflushed
    // keystroke: the backend does not hold the edit yet, so a reload would read
    // the pre-edit state back over it and the change would vanish. The flush
    // sites hand back a promise for exactly this, but most of them cannot await
    // it, so the in-flight save is tracked here instead of at each call site.
    if (this._saveInFlight) return true;
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
      console.debug("[lizaIP] config_changed reload failed:", e);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass) return;
    if (this._editorEl) this._editorEl.hass = this._editorHass();
    // Fontbook's panel, shown in the settings, follows Home Assistant as it
    // would in a panel of its own.
    if (this._fontbookEl) this._fontbookEl.hass = hass;
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
        // An open dialog is not part of the render, and its pictures still
        // ask for the other mode: white marks on a page that just went white.
        this._applyDeviceUrls();
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
      this._refreshBatteryPill?.();
    }
  }
  set narrow(n) { this._narrow = n; }
  set panel(p) { this._panel = p; }
  /**
   * Home Assistant's router, telling the panel where the browser is.
   *
   * Assigned on every location change under `/lizaip/**`, which is how Back,
   * Forward, a pasted URL and the sidebar entry all reach the panel -- a
   * custom panel is never torn down and rebuilt for a path within itself.
   *
   * Ignored until the first load has finished: `_init` reads the location for
   * itself, and an assignment arriving mid-init would race the staged
   * resolution it is doing. `_routeNavigate` recognises the path the panel
   * wrote itself, which is what the `location-changed` event in `_syncRoute`
   * causes to be echoed back here.
   */
  set route(r) {
    this._route = r;
    if (!this._initDone) return;
    const prefix = r?.prefix ?? ROUTE_PREFIX;
    this._routeNavigate(`${prefix}${r?.path ?? ""}`);
  }

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
    // The debug commands are administrators-only, so for anyone else the tab
    // would be a row of "unauthorized" -- the same reason the backend is asked
    // before the module is imported.
    if (!this._isAdmin()) return;
    try {
      const features = await this._hass.callWS({ type: "lizaip_config/get_features" });
      if (!features?.debug_tools) return;
      const mod = await import("./lizaip-debug-view.js");
      Object.assign(LizaRemotePanel.prototype, mod.DebugViewMixin);
      registerTemplateActions(mod.TEMPLATE_ACTIONS);
      // The memory bars are a debug tool too, and stripped with the tab.
      const memory = await import("./lizaip-memory.js");
      Object.assign(LizaRemotePanel.prototype, memory.MemoryViewMixin);
      this._debugTools = true;
    } catch (e) {
      console.debug("[lizaIP] debug tools unavailable:", e);
    }
  }

  /**
   * Boot the panel, once at a time.
   *
   * `connectedCallback` and the `hass` setter can both reach here before
   * either has finished, and the loads they start share one set of page
   * fields: a reply from the superseded boot would land on the other's page
   * and be cached under its id. A second call joins the first instead.
   */
  async _init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._initOnce();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _initOnce() {
    try {
      console.log("[lizaIP] _init starting...");
      this._initDone = false;
      // The address bar is wherever the navigation that brought us here left
      // it, not what this element last wrote. Cleared so the render at the
      // end of `_init` writes the restored path, not its own stale copy.
      this._lastRoutePath = null;
      // The loaders below are not awaited, so one can render before the route
      // is read. That render syncs a bare `/lizaip`, which `_routeRemember`
      // reads as "forget" -- wiping the memory `_routeRequested` needs.
      this._routeBooting = true;
      // Before anything is fetched, so no edge falls into the gap between the
      // list being read and the listener existing. The handler defers whatever
      // arrives before `_initDone`, and the flush at the end applies it.
      await this._loadDebugTools();
      await this._subscribeAvailability();
      await this._subscribeDevices();
      await this._subscribeDiscovery();
      this._watchForMissedEdges();
      // The static half: tables that belong to the build or to Home Assistant
      // rather than to any remote, so they cannot have moved. `_init` runs on
      // every re-attach, and refetching them bought a dozen round trips.
      //
      // `_loadDebugTools` above is in the same category but stays
      // unconditional: it is idempotent, cheap, and the `_debugTools` flag it
      // sets is what the tab resolution below consults.
      if (!this._staticLoaded) {
        this._staticLoaded = true;
        this._loadHaComponents();
        this._fetchServiceIcons();
        this._loadIconDefaults();
        this._loadPalette();
        this._loadInternalCommands();
        // Extra icon sets live in the browser; imgserv needs their shapes.
        syncCustomIcons(this._hass);
      }
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
      // `_loadButtonTooltips` is awaited for the same reason: the first render
      // prints button names, and `_getButtonTooltip` degrades to a title-cased
      // key until the table arrives. Unawaited, a fresh panel would flash the
      // bare key wording and only then settle on the translated one.
      // `_loadLabels` likewise: a label-targeted button is named after its
      // label, and would flash its entity's name until the registry landed.
      //
      // Unlike the four above, which are deliberately not awaited at all
      // because nothing in the first render depends on them.
      //
      // The slider table is the integration's own capability map, fixed for
      // the build. The other four answer to things outside the panel, and
      // `disconnectedCallback` drops the subscriptions that reported them.
      await Promise.all([
        this._sliderControlsLoaded ? null : Promise.resolve(this._loadSliderControls()).then(() => {
          this._sliderControlsLoaded = true;
        }),
        this._loadButtonTooltips(),
        this._loadLabels(),
        this._loadBlueprint(),
        this._listDevices(),
      ]);
      // Not awaited: only the ⋮ menu reads it, and that opens on a click.
      this._loadAssignablePeople?.()?.catch(() => {});
      console.log("[lizaIP] blueprint:", this._blueprint?.name, "buttons:", this._blueprint?.buttons?.length);
      console.log("[lizaIP] devices:", this._devices?.length, this._devices);

      // Where the browser is pointing, or -- on a bare `/lizaip` -- where this
      // session last was. Resolved in levels, each falling back to the nearest
      // one that still exists; the render below writes the corrected path.
      //
      // Read after `_loadDebugTools` and `_listDevices`, both awaited by here:
      // an entry cannot be checked against a device list that has not
      // arrived, nor the debug tab ruled out without knowing the build.
      const requested = this._routeRequested();
      // `_routeApply` is given `load: false` because `_loadAll` is called
      // here explicitly -- going through `_selectDevice` would reset the very
      // fields the route is about to set.
      // A remote waiting on the network is the one thing the device list has
      // that a remote's own pages do not, so nothing opens over it -- not the
      // path this session left behind, and not the single remote that would
      // otherwise be opened straight onto.
      //
      // Awaited rather than read, because subscribing resolves before the
      // snapshot of flows already in progress arrives.
      await this._discoveryOpened;
      const pending = !!this._discovered?.().length;
      // Home Assistant re-attaches this element rather than building a new
      // one, so a remote opened before the panel was last left is still the
      // current entry here, and skipping the route below would leave it open.
      if (pending) this._clearEntrySelection();
      const landed = pending ? false : await this._routeApply(requested, { load: false });
      if (landed) {
        await this._loadAll();
      } else if (this._devices.length === 1 && !pending) {
        // A single remote has no list worth showing, so the panel opens on it
        // whatever the URL said. An unknown entry in the URL lands here too,
        // which is the intended fallback rather than an accident of ordering.
        //
        // Unless one has been found: then the list is the only place the new
        // remote can be added from, and opening over it would hide the one
        // thing the user has come back to the panel for.
        this._currentEntry = this._devices[0].entry_id;
        await this._loadAll();
      }

      // Opening onto a tab is an entry too, and `_switchTab` never runs for
      // it. Without this the settings render over no fonts, the actions tab
      // over no usage counts, and debug shows the previous remote's stream.
      this._routeEnterTab();
      console.log("[lizaIP] _init done, currentEntry:", this._currentEntry, "pages:", this._pages?.length);
      this._routeBooting = false;
      this._render();
      this._subscribeConfigChanged();
      this._subscribeDeviceHello();
      this._subscribeLabelRegistry();
      this._subscribeDeviceSynced?.();
      this._initDone = true;
      this._flushAvailability();
      this._flushScope();
    } catch (e) {
      console.error("[lizaIP] _init failed:", e);
      this._routeBooting = false;
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
    // The incoming device's pages have not been scanned yet, and the flag the
    // outgoing one left behind describes a page set that is no longer loaded.
    this._usageScanComplete = false;
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
    // The library is the incoming device's, so a scope or a collapsed group
    // chosen against the outgoing one describes entries that are now gone.
    this._actionScope = "all";
    this._collapsedActionGroups = new Set();
    this._expandedActionGroups = new Set();
    this._pages = [];
    this._actions = [];
    this._assignments = {};
    this._currentPageIdx = 0;
    this._loading = true;
    // Returned, not just started: a caller that has *changed* the device's
    // configuration -- a restore -- has to know when the screen it is
    // describing is actually the restored one.
    return this._loadAll().then(() => {
      this._loading = false;
      // The debug readings were cleared above; on the debug tab, read them
      // for the remote now shown, or its log-stream switch stays at "off".
      if (this._activeTab === "debug" && this._currentEntry === entryId) this._enterDebugTab?.();
      this._render();
      // `_loadAll` fetches the selected remote's config, not the device list,
      // so an edge that arrived during the switch is still unapplied here.
      this._flushAvailability();
      this._flushScope();
    });
  }

  _goBack() {
    this._clearEntrySelection();
    this._render();
  }

  /**
   * Leave the remote that was open, without drawing anything.
   *
   * Split out of `_goBack` because a boot that finds a remote waiting has to
   * do the same thing: the element survives Home Assistant re-attaching the
   * panel, and with it whichever remote was open last.
   */
  _clearEntrySelection() {
    this._flushAutoSave();
    this._currentEntry = null;
    this._editingActionIdx = -1;
    this._selectedButtonIdx = -1;
    this._contextKey = null;
    this._pageTitleSelected = false;
    this._editorEl = null;
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
    return `${a?.icon || ""}\u0000${a?.tooltip || ""}`;
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
    // Press 1 wears the assignment's own `icon` and `tooltip`; `rules[0].icon`
    // is never read. So to the matcher slot 0 looked faceless, and only half a
    // reorder happened: dragging Stop to the top moved `mdi:stop` onto a
    // `rules[0].icon` nothing renders, left `mdi:play` sitting on the button,
    // and gave Play's new row nothing at all. Lending slot 0 the assignment's
    // face lets it be matched and moved like any other press.
    //
    // Seeded onto a copy -- the caller's snapshot is not ours to edit.
    const prev = prevRaw.map((r, i) => (i === 0
      ? { ...r, icon: r.icon || target.icon || "", tooltip: r.tooltip || target.tooltip || "" }
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
      if (was?.tooltip) rule.tooltip = was.tooltip;
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
      if (lead.icon) target.icon = lead.icon; else delete target.icon;
      // A name that travelled in with a press is one the user typed, and the
      // flag is what stops the generated name overwriting it on next render.
      if (lead.tooltip) { target.tooltip = lead.tooltip; target.tooltip_edited = true; }
      else { delete target.tooltip; delete target.tooltip_edited; }
      delete lead.icon;
      delete lead.tooltip;
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
    // meaningful once the user has actually typed in it (_tooltipEdited).
    const nameInput = this.shadowRoot?.querySelector(".config-tooltip-input");
    const customName = existing._tooltipEdited ? (nameInput?.value?.trim() || "") : "";
    // Emptying the field names nothing, so it hands the button back to the
    // derived label instead of claiming a blank one — the same release ↺ does.
    const tooltipCleared = !!existing._tooltipEdited && !customName;
    if (tooltipCleared) delete existing.tooltip_edited;
    // A label typed in an earlier session is just as much the user's as one
    // typed a moment ago, but `_tooltipEdited` does not survive a reload —
    // `tooltip_edited` is the stored half of the same fact. Without it, picking a
    // new action for the button below re-derived `label` and silently threw a
    // label the user typed last week away.
    const typedName = customName || (existing.tooltip_edited ? existing.tooltip : "");

    if (!this._sequence.length) {
      // No action in editor — only update label if needed
      if (customName || tooltipCleared) {
        existing.tooltip = customName;
        if (customName) existing.tooltip_edited = true;
        this._editAssignEnsure(btn.key);
        const target = this._editAssign(btn.key);
        Object.assign(target, existing);
        // `Object.assign` copies keys, it cannot remove one — the release above
        // only reaches the stored record if we delete it there as well.
        if (tooltipCleared) delete target.tooltip_edited;
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
    // nothing better to say — keep whatever the template or the user already set
    // rather than blanking it.
    const autoTooltip = this._computeTooltip(action, entity, seq);
    existing.tooltip = typedName || autoTooltip || existing.tooltip || "";
    if (customName) existing.tooltip_edited = true;

    // An image inherited from a template (or from a previously selected media item)
    // must not survive a payload change — only a user-pinned one does.
    if (!existing.icon_pinned && existing.icon && prevPayload?.thumbnail !== nextPayload?.thumbnail) {
      delete existing.icon;
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
    if (assign.icon) return true;
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
    // Not awaited: the save keeps the page it was made on, and coming back
    // reads the copy cached below.
    this._flushAutoSave();
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
    // Show a dialog asking whether to add a blank page or a template page
    await this._showAddPageDialog();
  }

  /**
   * The add-page options that come from the preset tree.
   *
   * A folder directly under `presets/` is drawn on the first screen rather
   * than being left to be found inside another one; the backend marks it
   * `scope: option`. Nothing here knows their names, and a folder with
   * nothing to offer grows no card -- which is what hides Debug from a
   * release.
   */
  _addPageOptions(templates) {
    const seen = new Map();
    for (const t of templates) {
      const first = this._groupChain(t)[0];
      if (first?.scope === "option" && !seen.has(first.id)) seen.set(first.id, first);
    }
    return [...seen.values()].sort(
      (a, b) => this._groupLabel(a).localeCompare(this._groupLabel(b)),
    );
  }

  /**
   * Adding a page, from the first question to the last, in one dialog.
   *
   * The template list is read *before* the dialog is drawn: the options are
   * folders of templates, so appending them to a dialog already on screen
   * would move the buttons under the pointer. The blank page is a template
   * like any other, so a failed read leaves nothing to offer.
   *
   * `options` is `{key, pageId, name, entity}` when the page being added is a
   * button's options subpage: only the options templates that button's device
   * answers are offered, and with none there is no dialog, only a toast.
   */
  async _showAddPageDialog(options = null) {
    let templates = [];
    try {
      templates = (await this._loadTemplates(options?.entity))
        .filter(t => t.available !== false && this._templateAction(t) !== null);
      // A button's options page is made only from an options template its
      // own device answers; those templates are offered nowhere else.
      templates = templates.filter(t => (options ? t.options && t.fits : !t.options));
    } catch (e) {
      console.warn("[lizaIP] Add-page options unavailable:", e);
    }
    if (options && !templates.length) {
      this._toast(this._t("no_options", { name: options.name }));
      return;
    }
    if (options && templates.length === 1) {
      await this._applyOnlyOption(templates[0], options);
      return;
    }
    this._openAddPageSteps(options
      ? this._addOptionsFirstStep(templates, options)
      : this._addPageFirstStep(templates));
  }

  /**
   * The one options template a button's device answers, applied without a
   * dialog: there is nothing to choose, and the device it binds to is the
   * button's own. Only where that device cannot be proposed is it asked for.
   */
  async _applyOnlyOption(template, options) {
    const hub = Boolean(template.target_selector?.config_entry);
    let suggested = "";
    if (!template.unbound) {
      ({ suggested = "" } = hub
        ? await this._loadTemplateConfigEntries(template.id, options.entity)
        : await this._loadTemplateDevices(template.id, options.entity));
    }
    if (suggested) {
      // Reports for itself: a toast for what it wrote, or why it could not.
      await this._addTemplatePage(template.id, suggested, hub ? "config_entry" : "device", options);
      return;
    }
    await this._showTemplateEntityPicker(template.id, template, { options });
  }

  /**
   * The first screen, as a step like any other.
   *
   * It is a grid of folders, led by the templates sitting loose at the root
   * of the tree -- the blank page is one. Everything carries the same `items`
   * the deeper steps do, so one piece of code draws and binds them all.
   */
  /** A template's description. */
  _templateDesc(t) {
    return t?.description || "";
  }

  /** "(3 pages)" after a template's name when adding it makes more than one. */
  _templatePagesHtml(t) {
    if (!(t?.page_count > 1)) return "";
    return ` <span class="template-pages">${this._esc(this._t("template_page_count", { count: t.page_count }))}</span>`;
  }

  _addPageFirstStep(templates) {
    const loose = templates.filter(t => !this._groupChain(t).length);
    return {
      kind: "options",
      title: this._t("add_page"),
      crumbs: [{ label: this._t("add_page_root"), icon: "mdi:plus-box-outline" }],
      all: templates,
      items: [
        // In no folder, so there is nothing to open on the way: the card adds
        // the page itself, and leads because it is what most pages start from.
        ...loose.map(t => this._templateCard(t)),
        ...this._addPageOptions(templates).map(group => ({
          group: group.id,
          scope: group.scope || "option",
          primary: group.primary === true,
          name: this._groupLabel(group),
          icon: group.icon || "mdi:folder-outline",
          desc: this._groupLabel(group, { desc: true }),
          members: templates.filter(t => this._groupChain(t)[0]?.id === group.id),
        })),
      ],
      depth: 0,
    };
  }

  /** A card that adds *template* itself, rather than opening a folder. */
  _templateCard(template) {
    return {
      template,
      primary: true,
      name: template.name,
      icon: template.icon,
      desc: this._templateDesc(template),
    };
  }

  /**
   * The first screen of an options walk: what this button's device answers.
   *
   * *templates* are already only those, so they are drawn flat, folders
   * and all: there are a handful at most.
   */
  _addOptionsFirstStep(templates, options) {
    return {
      kind: "options",
      options,
      title: this._t("add_options_title"),
      crumbs: [{ label: this._t("add_options_title"), icon: "mdi:tune-variant" }],
      all: templates,
      items: templates.map(t => this._templateCard(t)),
      depth: 0,
    };
  }

  /** One folder deeper, in the same dialog and from the same step shape. */
  _addPageSubStep(step, item) {
    const depth = (step.depth || 0) + 1;
    return {
      title: item.name,
      items: this._groupTemplates(item.members, depth),
      crumbs: [...(step.crumbs || []), { label: item.name, icon: item.icon, group: item.group }],
      all: step.all,
      options: step.options,
      depth,
      back: step,
    };
  }

  /** The chain of steps that leads here, outermost first. */
  _stepChain(step) {
    const chain = [];
    for (let s = step; s; s = s.back) chain.unshift(s);
    return chain;
  }

  /**
   * One grid step: which template, within the folder the step before chose.
   *
   * `group` is a folder path (`templates`, `templates/sonos`): every step of
   * the walk is inside one, since the first screen offers the folders
   * themselves. `null` when there is nothing to show.
   */
  _templateStep(all, { group, back, crumbs }) {
    // A template Home Assistant has nothing to bind to is left out: its dialog
    // could only say there is nothing to pick. `available` is absent from an
    // older backend, which offers them all.
    const templates = all.filter(t => this._groupChain(t).some(g => g.id === group));
    const opened = this._groupById(all, group);
    if (!templates.length) {
      this._toast(this._t("no_templates"));
      return null;
    }

    // One flat grid, deliberately not one grid per category: every shipped
    // template carries a category of its own, so each group held one card and
    // the `1fr` column stretched it across the whole dialog.
    //
    // A folder is the case grouping was meant for: the four Sonos templates
    // would be four of a dozen cards for a choice that is really "which
    // device", so they collapse into one card that opens a step.
    // From the chain, not the id: `options/sonos` is a top-level folder.
    const depth = this._groupChain(templates[0]).findIndex(g => g.id === group) + 1;
    return {
      title: opened ? this._groupLabel(opened) : this._t("choose_template"),
      items: this._groupTemplates(templates, depth),
      crumbs: [...(crumbs || []), {
        label: opened ? this._groupLabel(opened) : this._t("choose_template"),
        icon: opened?.icon || "mdi:folder-outline",
        group,
      }],
      all,
      options: back?.options,
      depth,
      back,
    };
  }

  /** A template's folders, outermost first. `[]` for a top-level template. */
  _groupChain(template) {
    return Array.isArray(template?.groups) ? template.groups : [];
  }

  /**
   * The routine a card runs instead of writing a page.
   *
   * `undefined` for an ordinary template, the bound handler for one whose
   * `action` this build knows, and `null` for one it does not -- which is how
   * a card is dropped before anything counts or draws it.
   */
  _templateAction(template) {
    if (!template?.action) return undefined;
    const fn = this[TEMPLATE_ACTIONS[template.action]];
    return typeof fn === "function" ? fn.bind(this) : null;
  }

  /**
   * How well `text` matches `q`, and which letters matched. `null` for no
   * match, `{score, hits}` otherwise.
   *
   * A subsequence scan rather than a substring one, so "sr" still finds
   * "Sonos Radio". A letter carrying on from the one before, or opening a
   * word, is worth more than one reached by skipping ahead, so a tight run
   * outranks a scatter; the length penalty settles two otherwise equal hits
   * in favour of the shorter name.
   */
  _fuzzyMatch(text, q) {
    const hay = String(text ?? "").toLowerCase();
    const needle = String(q ?? "").toLowerCase();
    if (!needle) return { score: 0, hits: [] };
    const hits = [];
    let from = 0, score = 0, last = -2;
    for (const ch of needle) {
      const at = hay.indexOf(ch, from);
      if (at < 0) return null;
      const opensWord = at === 0 || /[\s\-_./]/.test(hay[at - 1]);
      score += at === last + 1 ? 14 : opensWord ? 11 : 2;
      score -= Math.min(at - from, 9) * 0.6;
      hits.push(at);
      last = at;
      from = at + 1;
    }
    if (hay === needle) score += 70;
    else if (hay.startsWith(needle)) score += 26;
    return { score: score - hay.length * 0.5, hits };
  }

  /**
   * The templates a query finds, best first, wherever they sit in the tree.
   *
   * The name or the folder path has to match. A description is a tiebreaker
   * only: letters that appear there and nowhere else are not why anyone typed
   * them, and letting a description qualify on its own filled the grid with
   * pages that merely happened to hold them in order. The floor then drops
   * the long tail of weak matches, which is noise rather than results.
   */
  _searchTemplates(templates, q) {
    const query = String(q ?? "").trim();
    if (!query) return [];
    const found = [];
    for (const t of templates) {
      const name = t.name || t.id;
      const chain = this._groupChain(t);
      const onName = this._fuzzyMatch(name, query);
      const onPath = this._fuzzyMatch(chain.map(g => this._groupLabel(g)).join(" "), query);
      if (!onName && !onPath) continue;
      const onDesc = this._fuzzyMatch(t.description || "", query);
      found.push({
        template: t, name, icon: t.icon, desc: this._templateDesc(t),
        hits: onName ? onName.hits : [],
        path: chain.map(g => this._groupLabel(g)),
        score: (onName ? onName.score * 3 : 0)
          + (onPath ? onPath.score * 1.4 : 0)
          + (onDesc ? onDesc.score * 0.3 : 0),
      });
    }
    found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const best = found.length ? found[0].score : 0;
    return found.filter(r => r.score >= best * 0.45);
  }

  /** `text`, escaped, with the matched letters wrapped in `<mark>`. */
  _markHits(text, hits) {
    const lit = new Set(hits || []);
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const ch = this._esc(text[i]);
      out += lit.has(i) ? `<mark>${ch}</mark>` : ch;
    }
    return out;
  }

  /**
   * A folder's card by path, taken from whichever template carries it.
   *
   * Every template in a folder repeats the same ancestry, so any of them
   * answers; a path no template sits under is not a folder that exists.
   */
  _groupById(templates, id) {
    for (const t of templates) {
      const found = this._groupChain(t).find(g => g.id === id);
      if (found) return found;
    }
    return null;
  }

  /**
   * A folder's name, translated when it asked to be.
   *
   * `name_key` names an entry in the panel's translation table, which is how
   * a shipped folder keeps its translations. `_t` answers an unknown id with
   * the id itself, so a missing key falls back to the folder's own name.
   */
  _groupLabel(group, { desc = false } = {}) {
    const key = desc ? group.description_key : group.name_key;
    if (key) {
      const text = this._t(key);
      if (text !== key) return text;
    }
    return (desc ? group.description : group.name) || (desc ? "" : group.id);
  }

  /**
   * What a template's card is called at this depth.
   *
   * The folder it sits in is named by the crumb above the grid already, so a
   * name opening with that folder says the same thing twice: inside Sonos,
   * "Sonos Radio" is just "Radio". A search result keeps the whole name,
   * there being no folder on screen there to supply the rest.
   */
  _leafLabel(template, depth) {
    const full = template.name || template.id;
    const folder = this._groupChain(template)[depth - 1];
    const prefix = folder ? this._groupLabel(folder) : "";
    if (!prefix || !full.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) return full;
    const rest = full.slice(prefix.length + 1).trim();
    return rest ? rest[0].toUpperCase() + rest.slice(1) : full;
  }

  /**
   * Fold templates into the folders they sit in, one level at a time.
   *
   * `depth` is how far down the tree this step already is, so the folders it
   * returns are the ones *directly* below it; deeper ones are reached by
   * opening the card that holds them.
   *
   * A folder of one is not a folder: a subtree holding a single template
   * shows that template's own card rather than hiding a one-card step behind
   * a click. An option folder is never folded -- it is a button either way.
   */
  _groupTemplates(templates, depth = 0) {
    const folders = new Map();
    const items = [];
    for (const t of templates) {
      const here = this._groupChain(t)[depth];
      if (!here) {
        items.push({ template: t, name: this._leafLabel(t, depth), icon: t.icon, desc: this._templateDesc(t) });
        continue;
      }
      let folder = folders.get(here.id);
      if (!folder) {
        folder = {
          group: here.id,
          scope: here.scope || "grid",
          name: this._groupLabel(here),
          icon: here.icon || "mdi:folder-outline",
          desc: this._groupLabel(here, { desc: true }),
          members: [],
        };
        folders.set(here.id, folder);
        items.push(folder);
      }
      folder.members.push(t);
    }
    return items.map(item => {
      if (!item.members || item.members.length !== 1 || item.scope === "option") return item;
      const only = item.members[0];
      return { template: only, name: this._leafLabel(only, depth), icon: only.icon, desc: this._templateDesc(only) };
    });
  }

  /**
   * The add-page walk: one dialog, however many steps.
   *
   * Going a step further in replaces what this dialog shows rather than
   * opening another one on top of it -- a second popup for a second click
   * reads as a new question, when it is the same question narrowing down.
   * The breadcrumb is how that reads as one place: it names where the walk
   * is and is the way back out of it.
   */
  _openAddPageSteps(step) {
    const { dlg: overlay, close } = this._openModal(`
      <div class="add-page-dialog template-dialog" id="liza-template-step"></div>
    `, { labelledBy: "liza-dlg-title" });
    const host = overlay.querySelector("#liza-template-step");
    // See the no-anim rule: a hidden tab never starts the entrance animation,
    // and its backwards fill would leave every card at opacity 0 for good.
    if (globalThis.document?.hidden) host.classList?.add?.("no-anim");
    // A step is `{title, items, crumbs, all, depth, back}`; the
    // first screen adds `kind: "options"` for its headed groups. `back` is
    // the step to return to, so the chain of them is the walk so far.
    const state = { step, query: "" };

    const repaint = () => {
      const body = host.querySelector(".add-page-body");
      if (!body) return;
      body.innerHTML = this._addPageBodyHtml(state.step, state.query);
      this._bindAddPageBody(host, state.step, show, close, state);
      const count = host.querySelector(".add-page-count");
      if (count) count.textContent = this._addPageCountText(state.step, state.query);
    };

    const show = (next) => {
      state.step = next;
      // A query is about the whole tree, not this folder, so walking into a
      // folder is an answer to it and the field starts empty again.
      state.query = "";
      host.innerHTML = this._addPageChromeHtml(next, state.query);
      this._bindAddPageStep(host, next, show, close, state, repaint);
      this._bindAddPageBody(host, next, show, close, state);
      // The dialog is open by the time a step is drawn, so `autofocus` is
      // never honoured: each step hands the keyboard its first choice itself.
      // That focus has to exist for the arrow keys to have a starting point
      // (WCAG 2.4.7), but drawing a ring on it reads as a recommendation --
      // and next to the chosen row as a second, contradictory highlight. So
      // the step opens quiet and the indicator appears at the first key.
      host.classList?.add?.("focus-quiet");
      // Its first choice, or -- on a step that offers none -- the way out.
      // Named rather than "button": Cancel is ha-button and Back is an
      // ha-icon-button-arrow-prev, so neither answers a bare tag selector.
      this._focusWhenReady(
        host.querySelector(".template-row") || host.querySelector(".add-page-cancel"));
    };
    host.addEventListener?.("keydown", () => host.classList?.remove?.("focus-quiet"), true);
    show(step);
  }

  /**
   * The walk's way back, where Home Assistant puts it in a stepped dialog:
   * an arrow at the start of the header, beside the title, rather than a
   * worded button in the foot. Same element HA's own flows use, so it
   * carries HA's icon and turns around in right-to-left languages.
   */
  _addPageBackHtml(hasBack) {
    if (!hasBack) return "";
    return `<ha-icon-button-arrow-prev class="add-page-back"
              label="${this._esc(this._t("back"))}"></ha-icon-button-arrow-prev>`;
  }

  /** Hand the arrow `hass` -- it reads the language off it to decide which
   *  way to point -- and the step to walk back to. */
  _wireAddPageBack(root, onBack) {
    const el = root?.querySelector?.(".add-page-back");
    if (!el) return;
    el.hass = this._hass;
    el.addEventListener("click", onBack);
  }

  /** The chrome every step shares: where you are, a search, the grid. */
  _addPageChromeHtml(step, query) {
    return `
        <div class="add-page-head">
          ${this._addPageBackHtml(step.back)}
          ${this._addPageCrumbsHtml(step)}
          <h2 class="liza-sr-only" id="liza-dlg-title">${this._esc(step.title || this._t("add_page"))}</h2>
        </div>
        <div class="add-page-search">
          <ha-input-search appearance="outlined" class="add-page-search-input" autocomplete="off"
                 value="${this._esc(query)}" accessible-label="${this._esc(this._t("search_templates"))}"
                 placeholder="${this._esc(this._t("search_templates"))}"></ha-input-search>
        </div>
        <div class="add-page-body">${this._addPageBodyHtml(step, query)}</div>
        <div class="add-page-foot">
          <span class="add-page-count">${this._esc(this._addPageCountText(step, query))}</span>
          <ha-button appearance="plain" class="add-page-cancel">${this._t("cancel")}</ha-button>
        </div>
    `;
  }

  /**
   * The trail of folders, each one a way back to itself.
   *
   * It replaces both the step's title and a Back button: a title says what
   * you are looking at and a Back button says there is somewhere behind it,
   * and one row of crumbs says both, plus how far in the walk has gone.
   */
  _addPageCrumbsHtml(step) {
    const crumbs = step.crumbs || [];
    const last = crumbs.length - 1;
    const parts = crumbs.map((crumb, i) => {
      const label = this._esc(crumb.label);
      if (i === last) return `<span class="add-page-crumb is-current" aria-current="page">${label}</span>`;
      return `<button class="add-page-crumb" type="button" data-crumb="${i}">${label}</button>`;
    });
    return `<nav class="add-page-crumbs" aria-label="${this._esc(this._t("add_page"))}">${
      parts.join('<span class="add-page-crumb-sep" aria-hidden="true">/</span>')
    }</nav>`;
  }

  /**
   * How much a query found, while one is being typed.
   *
   * Nothing while browsing: the cards are right there to be counted, and a
   * number beside them only reads as a result count for a search nobody ran.
   */
  _addPageCountText(step, query) {
    if (!query) return "";
    return this._t("search_result_count", { count: this._searchTemplates(step.all || [], query).length });
  }

  /** The grid for this step, or the results for whatever was typed. */
  _addPageBodyHtml(step, query) {
    if (query) {
      const results = this._searchTemplates(step.all || [], query);
      if (!results.length) {
        return `
          <div class="add-page-empty">
            ${this._renderChromeIconHtml("mdi:magnify-close", 40)}
            <p class="add-page-empty-title">${this._esc(this._t("search_no_matches", { query }))}</p>
            <p class="add-page-empty-hint">${this._esc(this._t("search_no_matches_hint"))}</p>
          </div>`;
      }
      const found = results.map((r) => this._templateRowHtml({
        attr: `data-template-id="${this._esc(r.template.id)}"`,
        icon: r.icon, name: r.name, hits: r.hits, template: r.template,
        desc: r.path.length ? r.path.join(" / ") : (r.desc || ""),
      })).join("");
      return this._templateListHtml(found);
    }

    const items = this._sortedStepItems(step.items || []);
    const options = step.kind === "options";
    // The first screen leads with the two things most pages start from: an
    // empty page, and the folder of ready-made remotes. HA's own pickers name
    // such a group rather than only ruling a line under it, so each is headed.
    // A page that needs no folder opening comes first whatever it is called.
    const leads = options ? items.filter(i => i.primary) : [];
    const lead = [...leads.filter(i => !i.members), ...leads.filter(i => i.members)];
    const rest = lead.length ? items.filter(i => !i.primary) : items;
    const rows = [];
    const rowsFor = (list) => list.map(item => this._templateRowHtml({
      attr: item.members
        ? `data-group="${this._esc(item.group)}"`
        : `data-template-id="${this._esc(item.template.id)}"`,
      icon: item.icon,
      name: item.name,
      // Counted through the sub-folders: like Home Assistant's "5 entities",
      // this measures what is inside rather than promising how many rows
      // come next, and it is what decides whether a folder is worth opening.
      desc: item.members
        ? this._tCount("template_count", item.members.length)
        : (item.desc || ""),
      kind: item.members ? "folder" : "leaf",
      template: item.members ? null : item.template,
    })).join("");
    rows.push(rowsFor(lead));
    const tail = [rowsFor(rest)];
    // One empty page over the rest is a running order, not two groups worth
    // naming: the headings earn their place once a folder claims the lead.
    if (!lead.some(i => i.members)) {
      return this._templateListHtml([...rows, ...tail].join(""));
    }
    return `
        <p class="template-list-title" id="liza-tpl-lead">${this._t("suggested_options")}</p>
        ${this._templateListHtml(rows.join(""), { cls: "is-lead", labelledBy: "liza-tpl-lead" })}
        <p class="template-list-title" id="liza-tpl-rest">${this._t("other_options")}</p>
        ${this._templateListHtml(tail.join(""), { labelledBy: "liza-tpl-rest" })}`;
  }

  /**
   * One row: a picture, a name, a line under it, and a tail.
   *
   * Every screen of the walk is built out of this -- the folders, the
   * templates inside one, the search results -- so moving between them
   * changes what is listed rather than the shape of the dialog. Only a
   * folder carries a tail, where its count and a chevron say it opens.
   */
  _templateRowHtml({ attr, icon, name, desc, hits, kind = "leaf", template = null }) {
    const nameHtml = `${hits?.length ? this._markHits(name, hits) : this._esc(name)}${this._templatePagesHtml(template)}`;
    // A folder says it opens, and is the only kind with a tail.
    const chevron = kind === "folder" ? '<span class="template-row-chevron"></span>' : "";
    if (this._haLists()) {
      // Home Assistant's list row: the picture leads, the name and the line
      // under it are its headline and supporting text. A target is an option
      // of a listbox, which marks the chosen one itself.
      const tag = kind === "target" ? "ha-list-item-option" : "ha-list-item-button";
      return `
        <${tag} class="template-row" ${attr}>
          ${kind === "target" ? "" : `<span slot="start">${this._tilePlateHtml(icon)}</span>`}
          <span slot="headline" class="template-row-name">${nameHtml}</span>
          ${desc ? `<span slot="supporting-text" class="template-row-desc">${this._esc(desc)}</span>` : ""}
          ${chevron ? `<span slot="end" class="template-row-tail">${chevron}</span>` : ""}
        </${tag}>`;
    }
    // A target is chosen rather than opened, so it wears a radio at its head:
    // the receipt above already carries the mark a plate would repeat.
    const tail = chevron ? `<span class="template-row-tail">${chevron}</span>` : "";
    const head = kind === "target"
      ? '<span class="template-row-radio" aria-hidden="true"></span>'
      : this._tilePlateHtml(icon);
    return `
        <button class="template-row" ${attr}>
          ${head}
          <span class="template-row-text">
            <span class="template-row-name">${nameHtml}</span>
            <span class="template-row-desc">${this._esc(desc || "")}</span>
          </span>
          ${tail}
        </button>`;
  }

  /** Whether Home Assistant's own lists are loaded (they come with the
   *  config panel `_loadHaComponents` pulls in); the walk's own buttons stand
   *  in until they are. */
  _haLists() {
    const ce = globalThis.customElements;
    return !!(ce?.get?.("ha-list-base") && ce.get("ha-list-item-button")
      && ce.get("ha-list-selectable") && ce.get("ha-list-item-option"));
  }

  /** The rows of one step as a list: Home Assistant's, which moves between
   *  them with the arrow keys and is one tab stop. */
  _templateListHtml(rowsHtml, { cls = "", labelledBy = "" } = {}) {
    const label = labelledBy ? ` aria-labelledby="${labelledBy}"` : "";
    if (this._haLists()) {
      return `<ha-list-base class="template-list${cls ? ` ${cls}` : ""}"${label}>${rowsHtml}</ha-list-base>`;
    }
    return `<div class="template-list${cls ? ` ${cls}` : ""}"${labelledBy ? ` role="group"${label}` : ""}>${rowsHtml}</div>`;
  }


  /**
   * The plate the picture sits on, one width for every row.
   *
   * These are rasters from imgserv, not glyphs CSS can tint, and the two
   * kinds are shaped nothing alike: a `logo:` is a wide wordmark and an
   * `mdi:` a roughly square white shape that needs colour behind it to read
   * at all. The plate is the same box for both so the names line up.
   */
  _tilePlateHtml(icon) {
    const val = String(icon ?? "").trim() || "mdi:remote";
    const wordmark = val.startsWith("logo:");
    // Three times the box, for a 3x screen; see _browserImgSrc. Neither kind
    // is themed: a glyph is a CSS-tinted vector, and the wordmark asks
    // imgserv for the default theme, since the plate identifies a template.
    const art = wordmark
      ? this._renderIconHtml(val, 16, "", { w: 42, h: 16 }, { srcSize: 126, theme: THEME_DEFAULT })
      : this._renderChromeIconHtml(val, 22, "", null, { srcSize: 66 });
    return `<span class="tile-plate ${wordmark ? 'is-wordmark' : 'is-glyph'}">${art}</span>`;
  }

  /** Rows read in the order they are drawn, so a click finds what it hit:
   *  by file name -- a folder by its directory's -- so a file named `01_…`
   *  leads its folder, digits sorting before letters. */
  _sortedStepItems(items) {
    const key = (item) => item.members
      ? String(item.group || "").split("/").pop()
      : String(item.template?.file || item.template?.id || item.name || "");
    return [...items].sort((a, b) => key(a).localeCompare(key(b)));
  }

  /** The chrome: breadcrumbs, the search field and the way out. */
  _bindAddPageStep(host, step, show, close, state, repaint) {
    const chain = this._stepChain(step);
    (step.crumbs || []).forEach((_, i) => {
      if (i === (step.crumbs || []).length - 1) return;
      host.querySelector(`[data-crumb="${i}"]`)?.addEventListener("click", () => {
        if (chain[i]) show(chain[i]);
      });
    });

    const field = host.querySelector(".add-page-search-input");
    // Its own clear button reports itself as an input that emptied the box.
    field?.addEventListener?.("input", () => {
      state.query = field.value ?? "";
      repaint();
    });
    field?.addEventListener?.("keydown", (e) => {
      if (e.key === "Escape" && state.query) {
        e.stopPropagation();
        e.preventDefault();
        state.query = "";
        if (field) field.value = "";
        repaint();
        return;
      }
      // The field is where the keyboard lands, so the grid has to be
      // reachable from it without a Tab through the chrome.
      if (e.key === "ArrowDown" || (e.key === "Enter" && state.query)) {
        const first = host.querySelector(".template-row");
        if (!first) return;
        e.preventDefault();
        if (e.key === "Enter") first.click?.();
        else first.focus?.();
      }
    });
    this._wireAddPageBack(host, () => show(step.back));
    host.querySelector(".add-page-cancel").addEventListener("click", close);
  }

  /** The cards, which are redrawn whenever the query changes. */
  _bindAddPageBody(host, step, show, close, state) {
    const sorted = this._sortedStepItems(step.items || []);
    const results = state?.query ? this._searchTemplates(step.all || [], state.query) : null;

    const pick = (template, label = template.name) => {
      // Which device, asked in this same dialog: it is the last step of one
      // question, so it goes back to the templates like every other step.
      this._showTemplateEntityPicker(template.id, template, {
        host,
        close,
        back: () => show(step),
        options: step.options,
        // The trail the walk already built, with the template on the end
        // under the name the row gave it: a folder crumb already says
        // "Sonos", so the one under it says "Cover", not "Sonos Cover".
        crumbs: [...(step.crumbs || []), { label }],
        onCrumb: (i) => {
          const chain = this._stepChain(step);
          if (chain[i]) show(chain[i]);
        },
      }).catch((e) => {
        console.warn("[lizaIP] Template picker failed:", e);
        close();
        this._toast(this._t("template_picker_failed"));
      });
    };

    host.querySelectorAll(".template-row").forEach(card => {
      card.addEventListener("click", () => {
        if (card.dataset.group) {
          const item = sorted.find(i => i.group === card.dataset.group);
          if (!item) return;
          // One step down, in the same dialog, by the same call however deep
          // it goes -- the first screen's folders included, which used to be
          // built by hand and lost the debug tools doing it.
          const next = step.kind === "options"
            ? this._templateStep(step.all, { group: item.group, back: step, crumbs: step.crumbs })
            : this._addPageSubStep(step, item);
          if (next) show(next);
          return;
        }
        const id = card.dataset.templateId;
        const found = results
          ? results.find(r => r.template.id === id)
          : sorted.find(i => i.template && i.template.id === id);
        if (!found) return;
        // A result that is also a row of the folder on screen takes that
        // row's shortened label, so searching inside Sonos still ends in
        // "Sonos / Cover"; one found elsewhere keeps its whole name.
        const here = results && sorted.find(i => i.template && i.template.id === id);
        const label = here ? here.name : found.name;
        // A routine is the walk's last step like the device question is, so it
        // is handed the same chrome rather than opening a dialog of its own.
        const run = this._templateAction(found.template);
        if (run) {
          run(found.template, {
            host,
            close,
            back: () => show(step),
            crumbs: [...(step.crumbs || []), { label }],
            onCrumb: (i) => {
              const chain = this._stepChain(step);
              if (chain[i]) show(chain[i]);
            },
          });
          return;
        }
        pick(found.template, label);
      });
    });
  }

  /**
   * Ask which device (or hub) a template should drive.
   *
   * Adding a template page and moving one to another device ask the very same
   * question under the very same rules, so they share this dialog; only what
   * the confirm button says and does differs. `onConfirm(target, kind)` does
   * the work and returns the toast to show once the dialog is closed.
   *
   * `host` and `close` draw this step into a dialog that is already open --
   * the add-page walk, of which this is the last step -- instead of opening
   * one. `back` is the step to return to; moving an existing page has nothing
   * to go back to and passes neither.
   */
  async _showTemplateEntityPicker(templateId, templateMeta, {
    // Set when the page being added is a button's options subpage: it binds to
    // the button's own device without asking, where the template allows it.
    options = null,
    confirmLabel = this._t(options ? "add_options_title" : "add_page"),
    busyLabel = this._t("adding"),
    host = null,
    close: hostClose = null,
    back = null,
    // The walk's crumb trail, and where each crumb goes. Moving an existing
    // page is not a walk and passes neither.
    crumbs = null,
    onCrumb = null,
    // Where the devices come from, and which one to propose: a template's own
    // list by default; binding a page no template made offers every device.
    loadDevices = null,
    onConfirm = async (target, kind) => {
      await this._addTemplatePage(templateId, target, kind, options);
      // The options path reports for itself: it toasts what it wrote, or why
      // it could not, before this ever gets a chance to.
      if (options) return "";
      return this._t("template_added", { name: templateMeta?.name || templateId });
    },
  } = {}) {
    // Bound to nothing, so there is nothing to ask: the page is added as it
    // stands, like a blank one. Here rather than at the caller so no path to
    // this dialog can show one that only says it cannot be used.
    if (templateMeta?.unbound) {
      hostClose?.();
      try {
        const done = await onConfirm(null, "device");
        if (done) this._toast(done);
      } catch (e) {
        this._toast(this._t("add_page_error", { error: e?.message || e }));
      }
      return;
    }
    const deviceSelector = templateMeta?.target_selector?.device || null;
    const entrySelector = templateMeta?.target_selector?.config_entry || null;
    const description = this._templateDesc(templateMeta);
    const fieldLabel = this._t(entrySelector ? "target_hub" : "target_device");

    const name = this._esc(templateMeta?.name || templateId);
    const field = `
        <div class="template-entity-picker">
          <p class="template-entity-caption" id="liza-template-target">${fieldLabel}</p>
          ${this._haLists()
            ? '<ha-list-selectable class="template-list template-target-list" aria-labelledby="liza-template-target"></ha-list-selectable>'
            : '<div class="template-list template-target-list" role="radiogroup" aria-labelledby="liza-template-target"></div>'}
          <!-- Replaced asynchronously with the outcome of a round-trip, which
               moves no focus, so a screen reader would otherwise never hear it. -->
          <p class="template-entity-hint" role="status" aria-live="polite">${this._t(entrySelector ? "loading_hubs" : "loading_devices")}</p>
        </div>`;

    // The last of the walk's steps, wearing the same chrome as the rest so the
    // trail does not vanish at the one moment something is committed to.
    // Opened on its own it stays the plain dialog it always was.
    const body = host ? `
        <div class="add-page-head">
          ${this._addPageBackHtml(back)}
          ${this._addPageCrumbsHtml({ crumbs: crumbs || [] })}
          <h2 class="liza-sr-only" id="liza-dlg-title">${name}</h2>
        </div>
        <div class="add-page-body is-form-body">
          <div class="template-receipt">
            ${this._tilePlateHtml(templateMeta?.icon)}
            <span class="template-receipt-text">
              <span class="template-receipt-name">${name}${this._templatePagesHtml(templateMeta)}</span>
              <span class="template-receipt-sub">${this._esc(description)}</span>
            </span>
          </div>
          ${field}
        </div>
        <div class="add-page-foot is-form-foot">
          <ha-button appearance="plain" class="add-page-cancel">${this._t("cancel")}</ha-button>
          <ha-button variant="brand" class="template-confirm-btn" disabled>${this._esc(confirmLabel)}</ha-button>
        </div>
    ` : `
        <h2 class="add-page-dialog-title" id="liza-dlg-title">
          ${this._renderChromeIconHtml(templateMeta?.icon || 'mdi:remote', 24, "", null, { srcSize: 72, theme: THEME_DEFAULT })}
          ${name}${this._templatePagesHtml(templateMeta)}
        </h2>
        ${description ? `<p class="template-dialog-desc">${description}</p>` : ""}
        ${field}
        <div class="template-dialog-actions">
          <ha-button appearance="plain" class="add-page-cancel">${this._t("cancel")}</ha-button>
          <ha-button variant="brand" class="template-confirm-btn" disabled>${this._esc(confirmLabel)}</ha-button>
        </div>
    `;
    let overlay;
    let close;
    // Cancel, Back or Escape while a target is being looked up: what comes
    // back then belongs to a step nobody is on any more.
    let dismissed = false;
    if (host) {
      host.innerHTML = body;
      overlay = host;
      close = hostClose;
    } else {
      ({ dlg: overlay, close } = this._openModal(
        `<div class="add-page-dialog template-dialog">${body}</div>`,
        { labelledBy: "liza-dlg-title" },
      ));
    }
    this._wireAddPageBack(overlay, () => { dismissed = true; back(); });
    // Bound before the lookup that fills the list: a load that fails or finds
    // nothing returns early, and a Cancel that does nothing is a trap.
    overlay.querySelector(".add-page-cancel").addEventListener("click", () => {
      dismissed = true;
      close();
    });
    (crumbs || []).forEach((_, i) => {
      if (i === crumbs.length - 1) return;
      overlay.querySelector(`[data-crumb="${i}"]`)?.addEventListener("click", () => onCrumb?.(i));
    });

    const list = overlay.querySelector(".template-target-list");
    const hint = overlay.querySelector(".template-entity-hint");
    // The hint carries the wait and anything that went wrong with it. Once
    // rows are on screen they say it all themselves, so the line goes rather
    // than restating the caption above them.
    const settled = () => {
      hint.textContent = "";
      hint.hidden = true;
    };
    const confirmBtn = overlay.querySelector(".template-confirm-btn");
    let chosen = "";
    const getTarget = () => chosen;
    const targetKind = entrySelector ? "config_entry" : "device";

    // Every other step focuses its first choice once drawn. This one's
    // arrives from a round-trip, so it is focused when it lands -- unless the
    // keyboard has deliberately been moved somewhere by then.
    let focusClaimed = false;
    const claimFocus = (el) => {
      if (!host || focusClaimed) return;
      focusClaimed = true;
      if (overlay.contains?.(this.shadowRoot?.activeElement)) return;
      el?.focus?.();
    };

    /**
     * The things this template can bind to, drawn as the rows every other
     * step of the walk is made of.
     *
     * The server returns exactly the eligible ones, so the list needs no
     * filtering and a pick needs no validating: choosing a row is the whole
     * interaction. One candidate is not a choice, so it arrives already
     * chosen and Add confirms it.
     */
    const paint = (targets, preselect = "") => {
      // One list, one row height. Areas are optional per device, so without
      // this the group reads as a ragged stack rather than a column.
      list.classList.toggle("is-two-line", targets.some((t) => t.desc));
      const ha = this._haLists();
      list.innerHTML = targets.map((t) => this._templateRowHtml({
        attr: ha
          ? `value="${this._esc(t.id)}" data-target="${this._esc(t.id)}"`
          : `type="button" role="radio" aria-checked="false" tabindex="-1" data-target="${this._esc(t.id)}"`,
        name: t.name,
        desc: t.desc || "",
        kind: "target",
      })).join("");
      const rows = [...list.querySelectorAll(".template-row")];
      const mark = (id) => {
        chosen = id;
        rows.forEach((row) => {
          const on = row.dataset.target === id;
          if (ha) row.selected = on;
          else {
            row.classList.toggle("is-chosen", on);
            row.setAttribute("aria-checked", on ? "true" : "false");
            row.tabIndex = on ? 0 : -1;
          }
        });
        confirmBtn.disabled = !id;
      };
      if (ha) {
        // Home Assistant's listbox: the arrow keys move between the rows,
        // Enter, Space or a click chooses one.
        list.addEventListener("ha-list-item-selected", (e) => {
          const row = rows[Number(e.detail)];
          if (row) mark(row.dataset.target);
        });
      } else {
        for (const row of rows) {
          row.addEventListener("click", () => mark(row.dataset.target));
        }
        // A radio group is one tab stop, and the arrows move within it.
        const STEP = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        list.addEventListener("keydown", (e) => {
          const here = rows.indexOf(e.target.closest?.(".template-row"));
          if (here < 0 || !rows.length) return;
          const next = e.key in STEP
            ? (here + STEP[e.key] + rows.length) % rows.length
            : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
          if (next < 0) return;
          e.preventDefault();
          mark(rows[next].dataset.target);
          rows[next].focus();
        });
        if (rows[0]) rows[0].tabIndex = 0;
      }
      if (preselect) mark(preselect);
      claimFocus(rows.find((r) => r.dataset.target === preselect) || rows[0]);
    };

    if (!deviceSelector && !entrySelector) {
      // Every shipped template declares a device or a config-entry selector; the
      // entity selector they replaced is gone. Saying so beats the old
      // behaviour of quietly painting an unfiltered entity picker, which let a
      // template bind to something none of its actions could service.
      hint.textContent = this._t("template_no_target");
      return;
    }

    // The one way this dialog commits, whether a target was chosen here or --
    // for an options page the button's own device already answers -- bound
    // without ever drawing the step.
    const commit = async (target) => {
      const done = await onConfirm(target, targetKind);
      close();
      if (done) this._toast(done);
      this._render();
    };
    const bindSilently = async (target) => {
      // Escape and the scrim close the dialog without passing through Cancel,
      // and it stays in the tree through the closing animation: its open
      // state is asked as well as the flag and the list.
      if (dismissed || list.isConnected === false) return;
      const dlg = overlay.closest?.(".add-page-overlay")
        || this.shadowRoot?.querySelector(".add-page-overlay");
      if (dlg && (dlg.isConnected === false || dlg.open === false)) return;
      try {
        await commit(target);
      } catch (e) {
        close();
        this._toast(this._t("failed", { error: e.message || e }));
      }
    };

    if (entrySelector) {
      // Config-entry templates are bound to one instance of an integration -- a
      // Hue bridge -- and generate their whole grid from what it owns.
      const { entries, error, suggested = "" } = await this._loadTemplateConfigEntries(
        templateId, options?.entity);
      const integration = entrySelector.integration || "";
      if (error) {
        hint.textContent = this._t("hubs_load_failed", { error });
        return;
      }
      if (!entries.length) {
        hint.textContent = integration
          ? this._t("no_hub_found", { integration })
          : this._t("no_hub_found_generic");
        return;
      }
      const proposed = entries.some((e) => e.id === suggested) ? suggested : "";
      if (options && proposed) return bindSilently(proposed);
      const only = entries.length === 1 ? entries[0].id : "";
      paint(entries.map((e) => ({ id: e.id, name: e.title })), proposed || only);
      settled();
    } else {
      // Device-mode templates span several entity domains of one device. The
      // eligible-device list is resolved server-side against the device and
      // entity registries, so this only has to present it.
      const { devices, error, suggested = "" } = loadDevices
        ? await loadDevices() : await this._loadTemplateDevices(templateId, options?.entity);
      if (error) {
        hint.textContent = this._t("devices_load_failed", { error });
        return;
      }
      if (!devices.length) {
        const integration = deviceSelector.integration || "";
        hint.textContent = integration
          ? this._t("no_matching_devices", { integration })
          : this._t("no_matching_devices_generic");
        return;
      }
      // Proposed, not chosen: preselected so one click confirms it.
      const allowed = new Set(devices.map((d) => d.id));
      const proposed = allowed.has(suggested) ? suggested : "";
      // An options page is about one button, and the button already names its
      // device: there is no question left to ask.
      if (options && proposed) return bindSilently(proposed);
      paint(devices.map((d) => ({ id: d.id, name: d.name, desc: d.area || "" })), proposed);
      settled();
    }

    confirmBtn.addEventListener("click", async () => {
      const target = getTarget();
      if (!target) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = busyLabel;
      try {
        await commit(target);
      } catch (e) {
        this._toast(this._t("failed", { error: e.message || e }));
        confirmBtn.disabled = false;
        confirmBtn.textContent = confirmLabel;
      }
    });
  }

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
  }

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

    this._pageOpInFlight = true;
    try {
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
    } finally {
      this._endPageOp();
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
      console.error("[lizaIP] page reorder failed, reverting:", err);
      this._pages = before;
      this._currentPageIdx = beforeIdx;
      this._render();
    } finally {
      this._endPageOp();
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

  // Whether a button may be given an options page. It is opened by the long
  // touch, so that switch has to be on as well.
  _optionsFeatureEnabled() {
    return this._longtouchEnabled() && this._featureEnabled("options");
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
   * much as a template one: the button that adds a press should say so, and HA's
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
   * frontends, back to the 2026.11.0 floor `hacs.json` asks for.
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
      // Lets the stylesheet put the remote's black screen behind every
      // preview, which only a dark page can show without a hole in the card.
      this.classList.toggle("liza-dark", this._getThemeMode() === "dark");
      // The tile menu is transient and `innerHTML` below would strip the node
      // while leaving the panel holding a reference to it and a live keydown
      // listener on the window. Closed here rather than at each caller, since
      // every path that changes the face renders.
      this._closeFaceMenu?.();
      // Modal dialogs are appended to this shadow root, which _renderDeviceList
      // and _renderDeviceConfig replace wholesale via innerHTML. Any render
      // landing while a dialog is open would therefore silently destroy it —
      // and one always can, because `_init` defers a render until `_loadAll`
      // resolves, and the template dialogs await WS round-trips of their own.
      // Detaching and re-appending the nodes keeps their listeners intact,
      // since the elements themselves are never recreated. The guide drawer
      // rides along for the same reason, and needs it more: it is meant to
      // stay open across exactly the edits that cause these renders.
      const overlays = [...(this.shadowRoot?.querySelectorAll(".add-page-overlay, .guide-drawer") || [])];
      const pagesList = this.shadowRoot?.querySelector(".pages-list");
      const pagesScroll = pagesList?.scrollLeft || 0;
      // Rewriting `innerHTML` empties the host for an instant, and a scroller
      // that suddenly has nothing in it is clamped to the top. Every edit the
      // user made below the fold therefore threw them back to the first card.
      const scrolls = this._captureScroll();
      // `innerHTML` below destroys the focused element and focus drops to the
      // document, so every re-rendering control was usable exactly once per
      // trip through the tab order.
      const focus = this._a11yCaptureFocus();
      if (!this._currentEntry) this._renderDeviceList();
      else this._renderDeviceConfig();
      // Before anything below can read a layout, so the measurements they take
      // are of the page where the user actually left it.
      this._restoreScroll(scrolls);
      // After every render, whichever view: switching the bars on and the
      // device coming online both end in one, and each must start the poll
      // with a reading at once rather than five minutes later.
      this._memorySync?.();
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
        } else if (overlay.localName === "ha-dialog" && overlay.open) {
          // Detached, ha-dialog forgot it was showing; `open` going false and
          // back is what shows it again. Not a way out: `closed` is ignored.
          overlay._lizaReopening = true;
          overlay.open = false;
          Promise.resolve(overlay.updateComplete).then(() => {
            overlay.open = true;
            return overlay.updateComplete;
          }).finally(() => { overlay._lizaReopening = false; });
        }
      }
      this._a11yRestoreFocusSoon(focus);
      // The bar is a new node after the `innerHTML` above, so the observer
      // measuring it is pointed at one that no longer exists. Before the
      // drawer is restored, which reads the height this publishes.
      this._narrowWatch();
      // A drawer the user left open comes back. After the re-append above, so
      // a drawer that is already here is seen and nothing opens twice.
      this._guideRestore?.();
      // `innerHTML` above dropped the status region; put the same node back so
      // it keeps announcing rather than starting over empty each render.
      this._a11yLiveRegion();
      if (pagesScroll) {
        requestAnimationFrame(() => {
          const list = this.shadowRoot?.querySelector(".pages-list");
          if (list) list.scrollLeft = pagesScroll;
        });
      }
      // The single place the address bar is written. Every selection the URL
      // describes ends in a render, so one call here covers all of them
      // without a call threaded through each and one of them forgotten.
      //
      // Costs a string build and a compare on an unchanged path, the common
      // case. Last, so a render that threw has not already claimed a
      // selection the user cannot see.
      this._syncRoute();
    } catch (e) {
      console.error("[lizaIP] _render failed:", e);
    }
  }

  /** Every scroller above this panel that is not at the top. Ancestors only:
   *  the shadow tree is about to be replaced, so its own scrollers are new
   *  nodes a moment later and have nothing to restore. */
  _captureScroll() {
    const seen = [];
    let node = this;
    while (node) {
      if (node.scrollTop > 0) seen.push([node, node.scrollTop]);
      node = node.parentElement || node.parentNode?.host || null;
    }
    return seen;
  }

  /** Put them back, now and again next frame: a card that fills its shadow
   *  root a tick later changes the height we were clamped against. A scroller
   *  the user has since moved further down is left alone. */
  _restoreScroll(entries) {
    if (!entries?.length) return;
    const apply = () => {
      for (const [node, top] of entries) {
        if (node.isConnected && node.scrollTop < top) node.scrollTop = top;
      }
    };
    apply();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
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
    // The setup steps, under the setup page's heading, are for an
    // administrator with no remote yet; anybody else waits to be given one.
    const setup = !this._devices.length && this._isAdmin();
    this.shadowRoot.innerHTML = `
      ${this._styleTag()}
      <div class="toolbar"><ha-menu-button></ha-menu-button><h1 class="main-title">lizaIP</h1></div>
      <div class="view"><ha-card outlined><div class="card-content">
        <div class="device-list">
          ${this._htmlDiscoverySlot?.() || ""}
          <section class="list-section">
            <h2 class="list-section-title"${setup ? " data-setup" : ""} tabindex="-1">${this._esc(this._t(setup ? "setup_steps_heading" : "devices_heading"))}</h2>
            ${!this._devices.length ? this._htmlNoDevices() : this._devices.map(d => {
              // Same reasoning as the config toolbar: the id is spelled out by
              // a screen reader and read by nobody, so the meta line carries
              // only the firmware version.
              const version = d.sw_version ? `<span>${this._esc(`v${d.sw_version}`)}</span>` : '';
              const assigned = this._htmlAssignedChip(d);
              const displayTitle = (d?.title || '').trim() || d.device_id || d.entry_id || 'lizaIP';
              return `
            <div class="device-item" data-entry="${d.entry_id}" role="button" tabindex="0">
              <div class="device-icon-wrap"><ha-icon icon="mdi:remote" style="color:#fff;--mdc-icon-size:20px" aria-hidden="true"></ha-icon></div>
              <div class="device-info">
                <div class="device-title">${this._esc(displayTitle)}</div>
                ${!version && !assigned ? '' : `<div class="device-meta">${version}${assigned}</div>`}
              </div>
              <div class="status-badge ${d.available ? 'online' : 'offline'}"><span class="dot" aria-hidden="true"></span>${this._t(d.available ? 'device_online' : 'device_offline')}</div>
              ${this._htmlDiagnosticsMenuButton(d.entry_id, "device-item-menu")}
            </div>`;
            }).join("")}
          </section>
        </div>
      </div></ha-card></div>
      ${this._htmlDiagnosticsPill?.() || ""}
      <div class="toast" role="status" aria-live="polite"></div>`;
    const mb = this.shadowRoot.querySelector("ha-menu-button");
    if (mb) { mb.hass = this._hass; mb.narrow = this._narrow; }
    this.shadowRoot.querySelectorAll(".device-item").forEach(el =>
      el.addEventListener("click", () => this._selectDevice(el.dataset.entry)));
    this._wireDiagnosticsMenus?.();
    this._wireDiscovery?.();
    this._wireUserBadges?.();
  }

  /**
   * The control at the head of a remote's toolbar.
   *
   * A Back arrow whenever there is a list worth going to -- more than one
   * remote, or one found on the network and waiting in it. A single remote
   * with nothing waiting has no list behind it, so the sidebar's own menu
   * button takes the place instead.
   *
   * Home Assistant's own back control rather than an arrow of our own: it
   * carries HA's icon, its "Back" label, and the flip to a right-pointing
   * arrow in right-to-left languages.
   */
  _htmlToolbarLead() {
    return (this._devices.length > 1 || this._discovered?.().length)
      ? `<ha-icon-button-arrow-prev id="btn-back" label="${this._esc(this._t("back"))}"></ha-icon-button-arrow-prev>`
      : `<ha-menu-button></ha-menu-button>`;
  }

  _wireToolbarLead() {
    const mb = this.shadowRoot.querySelector("ha-menu-button");
    if (mb) { mb.hass = this._hass; mb.narrow = this._narrow; }
    const bb = this.shadowRoot.querySelector("#btn-back");
    if (bb) {
      // `ha-icon-button-arrow-prev` reads the language off `hass` to decide
      // which way its arrow points; without it the arrow stays left-pointing.
      bb.hass = this._hass;
      bb.addEventListener("click", () => this._goBack());
    }
  }

  /**
   * Swap that control when a remote is found or taken away.
   *
   * Patched rather than rendered: this lands while the user is inside a
   * remote, and redrawing the view would cost them whatever they were part
   * way through.
   */
  _syncToolbarLead() {
    const slot = this.shadowRoot?.querySelector(".toolbar-lead");
    if (!slot) return;
    const html = this._htmlToolbarLead();
    if (slot.innerHTML === html) return;
    slot.innerHTML = html;
    this._wireToolbarLead();
  }

  /**
   * The list with nothing in it: the first three steps of the setup page
   * (wake up, connect, provision), with its icons and QR code. Nothing here
   * for the user to press; a remote joining the network announces itself and
   * Home Assistant hands it to the panel.
   */
  _htmlNoDevices() {
    // An administrator is waiting for a remote to join the network, so the
    // steps help. Anybody else is waiting to be given one, and they would be
    // sent setting up hardware they cannot add.
    if (!this._isAdmin()) {
      return `
      <div class="no-devices">
        <ha-icon icon="mdi:remote" aria-hidden="true"></ha-icon>
        <p>${this._esc(this._t("no_assigned_remotes"))}</p>
      </div>`;
    }
    const step = (key) => `
        <li class="setup-step">
          <svg class="setup-step-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${SETUP_STEP_ICONS[key]}"/></svg>
          <div>
            <h3 class="setup-step-title">${this._esc(this._t(`setup_${key}_title`))}</h3>
            <p>${this._t(`setup_${key}_text`)}</p>
          </div>
        </li>`;
    // Beside the list rather than in the Provision row, so its height does
    // not push that row away from the others.
    return `
      <div class="no-devices-setup">
        <ol class="no-devices">${step("wake")}${step("connect")}${step("provision")}
        </ol>
        <img class="setup-qr" src="${SETUP_QR}" alt="" width="96" height="96">
      </div>`;
  }

  /**
   * What the toolbar pill says, as one answer both the markup and the live
   * region read from. Three states, not two: a missing record means we never
   * heard back, which is not the same claim as the device being offline.
   */
  _deviceStatus(device) {
    const state = !device ? "unknown" : device.available ? "online" : "offline";
    const key = { online: "device_online", offline: "device_offline", unknown: "device_unknown" }[state];
    return { state, label: this._t(key), battery: this._deviceBattery(device) };
  }

  /**
   * The remote's charge as a whole number, or null when there is nothing to
   * show. Read from `hass` rather than from the device list: the list is
   * fetched once, states arrive continuously.
   *
   * Anything that is not a number between 0 and 100 -- `unknown`, `unavailable`,
   * a sensor that has not reported yet -- is nothing to show rather than zero,
   * which would draw an empty battery and claim the remote is about to die.
   */
  _deviceBattery(device) {
    const id = device?.battery_entity;
    if (!id) return null;
    const raw = this._hass?.states?.[id]?.state;
    // `Number("")` is 0, and an empty state is no reading at all.
    if (raw === undefined || raw === null || String(raw).trim() === "") return null;
    const level = Number(raw);
    if (!Number.isFinite(level)) return null;
    return Math.max(0, Math.min(100, Math.round(level)));
  }

  /**
   * The pill's markup, shared by the toolbar and whatever else needs it.
   *
   * The percentage is text, not just fill width: a gauge whose only reading is
   * how far the green reaches conveys information by shape alone (1.4.1), and
   * says nothing at all to a screen reader. `--liza-battery` is what the fill
   * is drawn from, so the level can later be updated without re-rendering.
   */
  _htmlStatusPill(status) {
    const hasBattery = status.battery !== null && status.battery !== undefined;
    const charge = hasBattery ? `${status.battery}%` : "";
    return `
        <span class="toolbar-status ${status.state}${hasBattery ? ' has-battery' : ''}"${hasBattery ? ` style="--liza-battery:${status.battery}%"` : ''}>
          <span class="toolbar-status-fill" aria-hidden="true"></span>
          <span class="toolbar-status-dot ${status.state}" aria-hidden="true"></span>
          <span class="toolbar-status-text">${this._esc(status.label)}${hasBattery ? ` <span class="toolbar-status-charge">${charge}</span>` : ''}</span>
        </span>`;
  }

  /**
   * Follow the battery between renders.
   *
   * `set hass` deliberately does not re-render, so the pill would otherwise
   * hold the charge it was painted with. Patching the two things that change
   * -- the fill width and the number beside the word -- costs one query per
   * state change and leaves the rest of the view alone.
   */
  _refreshBatteryPill() {
    const pill = this.shadowRoot?.querySelector(".toolbar-status");
    if (!pill) return;
    const level = this._deviceBattery(this._devices?.find(d => d.entry_id === this._currentEntry));
    const charge = pill.querySelector(".toolbar-status-charge");
    if (level === null) {
      pill.classList.remove("has-battery");
      pill.style.removeProperty("--liza-battery");
      if (charge) charge.remove();
      return;
    }
    pill.classList.add("has-battery");
    pill.style.setProperty("--liza-battery", `${level}%`);
    if (charge) { charge.textContent = `${level}%`; return; }
    const text = pill.querySelector(".toolbar-status-text");
    if (!text) return;
    const span = document.createElement("span");
    span.className = "toolbar-status-charge";
    span.textContent = `${level}%`;
    text.append(" ", span);
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
    // The markup below replaces whatever view is up, the settings demos
    // included, and a timer left running would draw into the detached one.
    this._stopSettingsDemos?.();
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
        <span class="toolbar-lead">${this._htmlToolbarLead()}</span>
        ${this._htmlStatusPill(status)}
        <h1 class="main-title">${titleInner}</h1>
        ${!this._htmlMemoryBars ? "" : `<div class="toolbar-memory" role="group" aria-label="${this._esc(this._t("memory_group"))}">${this._htmlMemoryBars()}</div>`}
        <!-- No aria-label: it read "Buttons / Actions", which is just the two
             tabs' own names concatenated, so a reader heard "Buttons" twice
             before reaching anything. A tablist's name is optional and there is
             only one on the page, so there is nothing to disambiguate. -->
        <!-- HA's tab group, which supplies the tablist and tab roles and the
             arrow keys; the tabs carry HA's icons, not emoji. -->
        <ha-tab-group class="toolbar-tabs" active="${this._activeTab}">
          <ha-tab-group-tab slot="nav" panel="buttons" class="toolbar-tab" data-tab="buttons"
                            id="liza-tab-buttons"${this._activeTab === 'buttons' ? ' active' : ''}><ha-icon icon="mdi:view-grid-outline" aria-hidden="true"></ha-icon>${this._t("tab_pages")}</ha-tab-group-tab>
          ${"" /* Actions tab hidden for now; the view and its route stay, so
             putting the tab back is uncommenting these two lines.
          <ha-tab-group-tab slot="nav" panel="actions" class="toolbar-tab" data-tab="actions"
                            id="liza-tab-actions"${this._activeTab === 'actions' ? ' active' : ''}><ha-icon icon="mdi:lightning-bolt-outline" aria-hidden="true"></ha-icon>${this._t("actions")}</ha-tab-group-tab>
          */}
          ${!this._debugTools ? "" : `
          <ha-tab-group-tab slot="nav" panel="debug" class="toolbar-tab" data-tab="debug"
                            id="liza-tab-debug"${this._activeTab === 'debug' ? ' active' : ''}><ha-icon icon="mdi:stethoscope" aria-hidden="true"></ha-icon>${this._t("tab_debug")}</ha-tab-group-tab>`}
          <!-- Last and icon-only: settings are visited rarely, and a gear at
               the far end is where they are looked for. The name a reader
               hears comes from aria-label; title shows it on hover.
               NB: no backticks in this comment; it sits in a template. -->
          <ha-tab-group-tab slot="nav" panel="settings" class="toolbar-tab toolbar-tab-icon" data-tab="settings"
                            id="liza-tab-settings"${this._activeTab === 'settings' ? ' active' : ''}
                            aria-label="${this._esc(this._t("tab_settings"))}" title="${this._esc(this._t("tab_settings"))}"><ha-icon icon="mdi:cog" aria-hidden="true"></ha-icon></ha-tab-group-tab>
        </ha-tab-group>
        <!-- Outside the tablist: neither is a tab, and a reader walking the
             tabs with the arrow keys must not land on them. -->
        ${this._htmlGuideButton?.("toolbar-guide") || ""}
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

    this._wireToolbarLead();
    // After the markup, because announcing re-attaches the live region to a
    // shadow root the assignment above has just emptied.
    this._announceDeviceStatus(status, title);
    // The group's own event covers the arrow keys, which move the selection
    // without a click; the click covers a press on the tab already shown.
    this.shadowRoot.querySelector(".toolbar-tabs")?.addEventListener("wa-tab-show", (ev) => {
      if (ev.detail?.name && ev.detail.name !== this._activeTab) this._switchTab(ev.detail.name);
    });
    this.shadowRoot.querySelectorAll(".toolbar-tab").forEach(el =>
      el.addEventListener("click", () => this._switchTab(el.dataset.tab)));

    if (this._activeTab === "buttons") this._wireButtonsView(bp);
    else if (this._activeTab === "debug") this._wireDebugView?.();
    else if (this._activeTab === "settings") this._wireSettingsView();
    else this._wireActionsView();
    // After the tabs' own wiring: the toolbar menu and the pill sit outside
    // every view, and a view that threw would otherwise take them with it.
    this._wireDiagnosticsMenus?.();
    this._wireGuideButton?.();
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
Object.assign(LizaRemotePanel.prototype, RestoreViewMixin);
Object.assign(LizaRemotePanel.prototype, ThemeDownloadMixin);
Object.assign(LizaRemotePanel.prototype, GuideViewMixin);
Object.assign(LizaRemotePanel.prototype, DiscoveryMixin);
Object.assign(LizaRemotePanel.prototype, PeopleViewMixin);
Object.assign(LizaRemotePanel.prototype, A11yMixin);
Object.assign(LizaRemotePanel.prototype, RouteMixin);

// The name `panel.py` registers with Home Assistant's frontend: the two move
// together. A browser tab still open from before a rename holds the old tag
// and needs a reload.
if (!customElements.get("lizaip-panel")) {
  customElements.define("lizaip-panel", LizaRemotePanel);
}

// Exported so the panel tests can exercise a prototype method directly: the
// element itself cannot be constructed outside a browser.
export { LizaRemotePanel };

