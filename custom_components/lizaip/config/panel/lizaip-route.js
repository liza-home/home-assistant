/**
 * The panel's URL, and the panel's place in it.
 *
 * The panel used to live at exactly one address. Which remote was open and
 * which tab was held in the element's fields and nowhere else, so a reload
 * landed on the device list and "the kitchen remote's settings" was a
 * sentence with no link behind it.
 *
 * The scheme is a path, not a query string, because Home Assistant's panel
 * router matches only the *first* segment: everything under `/lizaip/**`
 * resolves to this element with no backend route to register.
 *
 *     /lizaip                     the device list
 *     /lizaip/<entry_id>          a remote, default tab
 *     /lizaip/<entry_id>/<tab>    pages|actions|settings|debug
 *
 * The remote is named by id rather than by name, so that a rename does not
 * break a link someone saved. The walk stops at the tab: a page and a control
 * are a selection inside the open tab, not a place of their own, and spelling
 * them out made the address bar churn on every click for a link nobody wrote
 * by hand. Paths that still carry those segments are read up to the tab and
 * rewritten without them.
 */

/** The panel's own prefix, matching `FRONTEND_URL_PATH` in `config/panel.py`. */
export const ROUTE_PREFIX = "/lizaip";

/** Where a restored place is kept between panels. See `_routeRemember`. */
export const ROUTE_MEMORY_KEY = "lizaip:last-route";

/**
 * The tabs a path may name.
 *
 * "buttons" is absent on purpose: the set decides whether a segment *is* a
 * tab, and `/lizaip/<entry>/buttons` parses through the same default that an
 * absent tab does.
 */
const TABS = new Set(["buttons", "actions", "settings", "debug"]);

// Module scope on purpose: a navigation entry belongs to the document, and so
// does one evaluation of this module.
let initialRoute;
let initialRouteSpent = false;

/**
 * The route the browser was *asked* for, or null.
 *
 * Home Assistant rewrites `/lizaip/<id>/actions` to `/lizaip` client-side
 * before this module is fetched, so by the time `_init` reads the location the
 * deep link is gone. The navigation timing entry is the only surviving record.
 *
 * It stays available until the panel puts its own path in the address bar.
 * `_init` runs several times while the panel boots, and handing the link to
 * only the first of them let the later ones reset to the default tab.
 */
export function consumeInitialRoute() {
  if (initialRouteSpent) return null;
  if (initialRoute === undefined) {
    try {
      const nav = performance?.getEntriesByType?.("navigation")?.[0];
      initialRoute = routeFromNavigationEntry(nav?.name, window.location?.origin);
    } catch {
      // No performance API, no navigation entry, an unparseable name: all mean
      // there is nothing to recover.
      initialRoute = null;
    }
  }
  return initialRoute;
}

/**
 * Give up the opening route: the panel has established its own URL.
 *
 * Without this the entry would still be there when Home Assistant re-attaches
 * the panel, and would yank the user back to the link they opened an hour ago.
 */
export function spendInitialRoute() {
  initialRouteSpent = true;
}

/** Forget the opening route entirely, so one test cannot bleed into the next. */
export function resetInitialRoute() {
  initialRoute = undefined;
  initialRouteSpent = false;
}

/**
 * The route an opening URL names, or null.
 *
 * Split from the cache so it can be exercised directly: the cache is a fact
 * about the document, while this is a pure function of a string.
 *
 * @param {string|undefined} name    The navigation entry's URL.
 * @param {string|undefined} origin  Where this document is served from.
 */
export function routeFromNavigationEntry(name, origin) {
  if (!name) return null;
  let url;
  try {
    url = new URL(name, origin || undefined);
  } catch {
    return null;
  }
  // A cross-origin opener is not this panel's URL to act on, and `new URL`
  // would happily have parsed one.
  if (origin && url.origin !== origin) return null;
  // Only this panel's own paths. A document opened at `/lovelace/0` would
  // otherwise parse as a remote named "lovelace" and, being preferred over
  // the memory, outrank the place the user actually left.
  const path = url.pathname || "";
  if (path !== ROUTE_PREFIX && !path.startsWith(`${ROUTE_PREFIX}/`)) return null;
  return parseRoutePath(path, url.search);
}

/**
 * Decode one path segment, or null if it is not decodable.
 *
 * A URL is user input: `%E0%A4%A` is a truncated escape that makes
 * `decodeURIComponent` throw, and an exception here would take the whole
 * panel down to its error screen over one bad segment.
 */
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Split a pathname into the panel's segments.
 *
 * Returns nulls rather than throwing for anything unrecognised: a path is user
 * input, arriving from a bookmark or a paste, and the caller's job is to fall
 * back to the nearest level it can honour.
 *
 * @param {string} pathname
 * @param {string} search  The query string, for the legacy `?entry_id=` form.
 */
export function parseRoutePath(pathname = "", search = "") {
  const out = { entryId: null, tab: null, section: null };
  const parts = String(pathname || "")
    .split("/")
    .filter(Boolean);
  // The prefix may or may not be present depending on who is asking; drop it
  // when it is, so both `/lizaip/x` and a already-relative `x` parse alike.
  if (parts[0] === ROUTE_PREFIX.slice(1)) parts.shift();

  if (parts.length) {
    // An undecodable segment stops the walk and leaves the levels above it
    // standing: a bad tab name still lands on the right remote.
    out.entryId = decodeSegment(parts[0]);
    if (!out.entryId) return out;
    if (parts.length > 1 && TABS.has(parts[1])) out.tab = parts[1];
    // The settings tab hangs its open section off the level below the tab.
    // Which names are real is the settings view's business.
    if (out.tab === "settings" && parts.length > 2) out.section = decodeSegment(parts[2]);
    // Anything deeper is an older link naming a page and a control. It is
    // read no further on purpose: the tab it names is the place, and
    // `_syncRoute` writes the shortened path back over it.
    return out;
  }

  // Nothing in the path. The query form is what the panel shipped with, and
  // what every `configuration_url` written before this change still carries,
  // so it keeps working — the caller rewrites it into a path once honoured.
  const params = new URLSearchParams(String(search || ""));
  const entry = params.get("entry_id");
  const tab = params.get("tab");
  if (entry) out.entryId = entry;
  if (tab && TABS.has(tab)) out.tab = tab;
  return out;
}

/**
 * Build the path for a selection.
 *
 * Trailing nothing: a selection that stops at the device produces
 * `/lizaip/<id>`, not `/lizaip/<id>/`, because an empty segment would parse
 * back as an empty tab name rather than as absence.
 */
export function buildRoutePath({ entryId, tab, section } = {}) {
  if (!entryId) return ROUTE_PREFIX;
  const parts = [ROUTE_PREFIX, encodeURIComponent(entryId)];
  // The default tab is the shortest path that means it, so it is left out --
  // nothing hangs off it any more that would need it spelled.
  if (tab && tab !== "buttons") parts.push(tab);
  if (tab === "settings" && section) parts.push(encodeURIComponent(section));
  return parts.join("/");
}

export const RouteMixin = {
  /**
   * How a remote is spelled in the URL.
   *
   * The entry id is a 26-character ULID: correct, and unreadable. The slug is
   * the remote's short hex, the one in its title, so a user can recognise it
   * in a bookmark. Deliberately not `device_id`, which is Home Assistant's
   * registry id while the remote is connected and the short id while it is
   * not -- a URL built on it would change spelling when the remote went
   * offline. Falls back to the entry id for a remote that has neither.
   */
  _routeSlug(entryId) {
    const dev = this._devices?.find?.((d) => d.entry_id === entryId);
    return dev?.slug || entryId;
  },

  /**
   * The entry id a URL segment names, or null.
   *
   * Every spelling the panel has written is accepted for as long as it
   * exists: bookmarks and `configuration_url` values predating this change
   * carry the entry id, and the registry id is what the device list calls
   * `device_id` while a remote is connected. Case-insensitive because hex and
   * ULIDs are both case-blind and no two remotes differ only in case.
   */
  _routeResolveEntry(segment) {
    if (!segment) return null;
    const want = String(segment).toLowerCase();
    const devices = this._devices || [];
    const by = (field) =>
      devices.find((d) => String(d[field] || "").toLowerCase() === want);
    const hit = by("slug") || by("entry_id") || by("device_id");
    return hit ? hit.entry_id : null;
  },

  /**
   * The path describing what is on screen right now.
   *
   * Reads two fields and joins strings; it touches no DOM, because `_render`
   * calls it on every pass.
   */
  _routePath() {
    if (!this._currentEntry) return ROUTE_PREFIX;
    const tab = this._activeTab || "buttons";
    return buildRoutePath({
      entryId: this._routeSlug(this._currentEntry),
      tab,
      section: tab === "settings" ? this._settingsGroup?.() : null,
    });
  },

  /**
   * Put the current selection in the address bar, if it is not there already.
   *
   * `replaceState`, never `pushState`: the URL describes what is on screen,
   * and every click in the panel is a change of selection rather than a
   * change of place. Pushing would make Back a tour of the user's clicking.
   *
   * The `location-changed` event is how a custom panel tells Home Assistant's
   * router that the location moved underneath it; without it the frontend
   * goes on believing the old path and restores it at the next navigation.
   */
  _syncRoute() {
    // A load started before the user left can still render afterwards. The
    // panel is gone by then, so writing its path would drag the address bar
    // back to lizaIP from whatever they moved on to.
    if (this.isConnected === false) return;
    // Still resolving the opening route: a loader's render must not put a
    // bare `/lizaip` up and forget where the session was. See `_init`.
    if (this._routeBooting) return;
    const path = this._routePath();
    if (path === this._lastRoutePath) return;
    this._lastRoutePath = path;
    // The panel now owns the address bar, so the link the document was opened
    // with has done its job and must not reassert itself later.
    if (path !== ROUTE_PREFIX) spendInitialRoute();
    try {
      // The query string is dropped rather than carried: the only parameters
      // the panel had were `entry_id` and `tab`, and the path now says both.
      // Two spellings of one fact are free to disagree after the next click.
      window.history?.replaceState?.(window.history.state ?? null, "", path);
      window.dispatchEvent?.(
        new CustomEvent("location-changed", {
          detail: { replace: true },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e) {
      // An address bar that will not move is a cosmetic failure; the panel
      // behind it still works, so this must never take a render down.
      console.debug("[lizaIP] route sync failed:", e);
    }
    this._routeRemember(path);
  },

  /**
   * Remember where the user is, for the next bare `/lizaip`.
   *
   * The sidebar link has no segments, so without this, stepping out to the
   * Settings page and back would land on the device list however deep you
   * were. Session storage rather than local: coming back within the same
   * browser session is continuing a piece of work, while a browser opened
   * tomorrow is starting one. Written from `_syncRoute` only, so there is one
   * writer and the memory cannot drift from the address bar.
   */
  _routeRemember(path) {
    try {
      if (!path || path === ROUTE_PREFIX) window.sessionStorage?.removeItem(ROUTE_MEMORY_KEY);
      else window.sessionStorage?.setItem(ROUTE_MEMORY_KEY, path);
    } catch (e) {
      // Private browsing, or a storage quota. Nothing to do but forget.
      console.debug("[lizaIP] route memory unavailable:", e);
    }
  },

  /** The remembered path, or null. */
  _routeRecall() {
    try {
      const path = window.sessionStorage?.getItem(ROUTE_MEMORY_KEY);
      return path && path !== ROUTE_PREFIX ? path : null;
    } catch {
      return null;
    }
  },

  /** Forget the remembered path — the "go home" gesture. */
  _routeForget() {
    this._routeRemember(ROUTE_PREFIX);
  },

  /**
   * What the panel should open on, given where the browser is.
   *
   * A bare `/lizaip` is where the sidebar link points, and it is ambiguous by
   * construction: it is both "take me to lizaIP" and "take me back to what I
   * was doing". It is read as the latter, by restoring the remembered path —
   * the former is served by `_routeGoHome`, which the sidebar click reaches
   * through `set route` on an element that is already connected.
   *
   * The opening URL is tried before the memory, and only when the location
   * has no remote in it: a pasted deep link is an instruction about *now*,
   * while on every later read it is spent and the memory is all that is left.
   */
  _routeRequested() {
    const pathname = window.location?.pathname || "";
    const search = window.location?.search || "";
    const parsed = parseRoutePath(pathname, search);
    if (parsed.entryId) return parsed;
    const opened = this._routeInitialRoute();
    if (opened?.entryId) return opened;
    const remembered = this._routeRecall();
    return remembered ? parseRoutePath(remembered) : parsed;
  },

  /** Seam over `consumeInitialRoute`, so a test can speak for the browser. */
  _routeInitialRoute() {
    return consumeInitialRoute();
  },

  /**
   * Resolve a parsed route against what is actually loaded, and apply it.
   *
   * Every level falls back to the nearest one that exists rather than
   * refusing: a link travels, and the configuration it names moves. A page
   * deleted since the link was written leaves the right remote and the right
   * tab perfectly good. `_syncRoute` writes the corrected path back.
   *
   * Call it with the device list already fetched. It awaits `_loadAll`
   * through `_selectDevice` when the entry changes, because page and button
   * cannot be resolved against a configuration that has not arrived.
   *
   * @returns {Promise<boolean>} whether a device ended up selected.
   */
  async _routeApply(route, { load = true } = {}) {
    // Both spellings resolve here, so the rest of the method only ever deals
    // in entry ids -- the slug never reaches `_selectDevice` or `_currentEntry`.
    let wanted = this._routeResolveEntry(route?.entryId);
    if (!wanted) {
      // The URL named a remote this install does not have, or named none at
      // all. The nearest real place wins rather than the device list:
      //
      //   the remote already open  →  the one last worked on  →  the only one
      //   there is  →  the list
      //
      // The list is reached only with several remotes, none open and none
      // remembered. The sidebar entry gets back to it by `_routeGoHome`,
      // which forgets before a route is applied.
      wanted =
        this._currentEntry ||
        this._routeResolveEntry(parseRoutePath(this._routeRecall() || "").entryId) ||
        (this._devices?.length === 1 ? this._devices[0].entry_id : null);
      if (!wanted) return false;
    }
    if (this._currentEntry !== wanted) {
      // The outgoing remote's debounced edits have to land before the entry
      // moves: after that a pending save is dropped, or lands on the remote
      // that just arrived.
      await this._flushAutoSave?.();
      if (load) await this._selectDevice(wanted);
      else {
        // `_selectDevice` is skipped so the caller can load the configuration
        // itself, but the caches it would have emptied are keyed by page id,
        // and page ids repeat across remotes.
        this._currentEntry = wanted;
        this._pageCache = {};
        this._pages = [];
        this._assignments = {};
        this._currentPageIdx = 0;
      }
    }

    // "debug" is not merely hidden on a stable build, it is stripped, so a
    // link to it pasted into a bug report and opened on a release would
    // otherwise render a panel with no tab highlighted at all.
    const tab = route.tab;
    if (tab && (tab !== "debug" || this._debugTools)) this._activeTab = tab;
    else this._activeTab = "buttons";
    // The settings view decides whether the name is one of its own; an
    // unknown one leaves the remembered section standing.
    if (this._activeTab === "settings") this._applySettingsSection?.(route.section);

    return true;
  },

  /**
   * Run the entry work the tab a route landed on would have had from a click.
   *
   * `_switchTab` is where a tab's data is fetched -- the settings' fonts and
   * icon options, the actions tab's usage counts, the debug tab's log-port
   * state. A route sets `_activeTab` directly, so without this a deep link
   * renders the right tab over no data, and the debug tab shows what it read
   * for the previous remote.
   *
   * Separate from `_routeApply` because `_init` has to call it after
   * `_loadAll`. Not `_switchTab` itself: that flushes an auto-save and
   * renders, neither wanted halfway through resolving a URL.
   */
  _routeEnterTab() {
    if (!this._currentEntry) return;
    switch (this._activeTab) {
      case "settings":
        this._enterSettingsTab?.();
        break;
      case "actions":
        Promise.resolve(this._loadGlobalUsage?.()).then((changed) => {
          if (changed) this._render();
        });
        break;
      case "debug":
        // The guard in `_routeApply` has already ruled out a build without the
        // tab, so reaching here with no `_enterDebugTab` would be a bug rather
        // than a stripped release.
        this._enterDebugTab?.();
        break;
      default:
        this._editingActionIdx = -1;
    }
  },

  /**
   * The sidebar entry, clicked while the panel is already open.
   *
   * The only gesture that means "out of this remote" rather than "into it",
   * and the only reason bare `/lizaip` can still reach the device list once
   * the panel remembers where you were. It forgets deliberately, so the next
   * bare visit does not restore the place this click just left.
   *
   * With a single remote there is no list worth showing, so the click resets
   * to that remote's pages instead of emptying the panel.
   */
  async _routeGoHome() {
    this._routeForget();
    const only = this._devices?.length === 1 ? this._devices[0].entry_id : null;
    if (!only) {
      if (this._currentEntry) this._goBack();
      else this._render();
      return;
    }
    await this._flushAutoSave?.();
    if (this._currentEntry !== only) await this._selectDevice(only);
    this._activeTab = "buttons";
    // `_switchPageTo` carries the assignments and the page cache back to the
    // first page; it returns early when already there, so the explicit resets
    // below still have to happen either way.
    await this._switchPageTo(0);
    this._selectedButtonIdx = -1;
    this._contextKey = null;
    this._pageTitleSelected = false;
    this._editingActionIdx = -1;
    this._render();
  },

  /**
   * Follow the browser to a path this panel did not write.
   *
   * Back and Forward, a pasted URL, and the sidebar entry all arrive here, by
   * way of Home Assistant re-assigning `route` on the element. Our own
   * `replaceState` comes back the same way, which is why the first thing this
   * does is recognise the path it just wrote and do nothing.
   *
   * @param {string} fullPath  prefix + path, as Home Assistant spells it.
   */
  async _routeNavigate(fullPath) {
    // A trailing slash is the same place, and HA's router is not consistent
    // about emitting one; without this, `/lizaip/` would read as a navigation
    // away from `/lizaip` and bounce the user to the device list.
    let path = String(fullPath || "") || ROUTE_PREFIX;
    if (path.length > ROUTE_PREFIX.length && path.endsWith("/")) path = path.slice(0, -1);
    if (path === this._lastRoutePath) return;
    // Home Assistant can hand back the path just written minus its tab, which
    // would read as "go to the default tab" and undo a deep link. Only the
    // bare remote is ignored: dropping a button or page is a real navigation.
    if (path !== ROUTE_PREFIX && this._lastRoutePath?.startsWith(`${path}/`)) {
      const rest = path.slice(ROUTE_PREFIX.length + 1);
      if (rest && !rest.includes("/")) return;
    }
    // A second navigation arriving while the first is still fetching would
    // interleave two `_selectDevice` loads and leave the later one's pages
    // under the earlier one's selection.
    if (this._routeNavigating) return;

    this._routeNavigating = true;
    try {
      // Bare, on a panel already showing a remote: the sidebar entry. A fresh
      // attach never reaches here -- `_init` reads the location itself.
      if (path === ROUTE_PREFIX) {
        await this._routeGoHome();
        return;
      }
      const landed = await this._routeApply(parseRoutePath(path), { load: true });
      // A link to a remote this install does not have. The list is the only
      // honest destination, and `_goBack` is how the panel already gets there.
      if (!landed) this._goBack();
      else {
        this._routeEnterTab();
        this._render();
      }
    } catch (e) {
      console.debug("[lizaIP] route navigation failed:", e);
    } finally {
      this._routeNavigating = false;
    }
  },
};
