/**
 * `${…}` variables in the panel's previews.
 *
 * ``${sensor.outdoor}``, ``${sensor.battery * 2}``, ``${round(sensor.x / 10)}``
 * are worked out by the backend and nowhere else: the remote receives what
 * Python computes, so the panel asks Python (`lizaip_config/resolve_variables`)
 * rather than carry a second implementation that could drift. Answers are kept
 * in a cache the render code reads synchronously; a miss shows the fallback
 * (no picture, no variable text) and is asked for in one batched request, after
 * which the view is drawn again. A change to an entity an answer read asks
 * again for the answers that read it -- not every answer: one countdown in one
 * title would otherwise re-ask every variable on every page each second -- and
 * the view is drawn again only when an answer it actually showed changed. An
 * answer only the remote faces show redraws just the faces, in place: a full
 * render would replace the page strip every second and take its focus along.
 *
 * Only the words `${_state}`, `${_name}` and `${_cmd}` are still resolved here
 * (`_substituteTooltipTokens`): they depend on the button being edited, not on
 * Home Assistant.
 */

// A `${…}` that is more than one word: an entity, a calculation. Those belong
// to the backend; `${_state}` and friends are a single word.
const BACKEND_TOKEN = /\$\{(?!\s*\w*\s*\})[^{}$]*\}/;
// `{translate: volume}`: words in the remote's language, from the backend's
// translation tables, so the backend fills them in too.
const TRANSLATE_TOKEN = "{translate:";
// The same, whole, for the fallback: until the backend answers, the words as
// written stand in (`{translate: Volume Up}` reads "Volume Up").
const TRANSLATE_RE = /\{translate:\s*([^{}]*?)\s*\}/g;

/** *text* as shown before the backend has answered for it. */
function unanswered(text) {
  return text.replace(new RegExp(BACKEND_TOKEN.source, "g"), "").replace(TRANSLATE_RE, "$1");
}
// Entries kept before the cache starts over, so a long session cannot grow it.
const CACHE_LIMIT = 2000;
// Asking again after an entity changes waits this long, so a sensor reporting
// every second costs one request per interval, not one per report.
const REFRESH_MS = 1000;
// A request that failed is made again after this, doubling up to the cap.
const RETRY_MS = 2000;
const RETRY_MAX_MS = 60000;
// Tries before the fallback is remembered, until an entity it read changes.
const RETRIES = 5;
// The longest a faces-only redraw waits for the tile pictures on screen.
const FACES_WAIT_MS = 5000;

// Browser-local switches on the Editor settings card, like the page links:
// they change what this editor asks for and draws, nothing the remote does.
//   visibleFaces: a changed variable updates only the pages in view -- a phone
//     shows three pages of twenty-five. On by default.
//   liveValues: the editor's previews and hints follow their entities while
//     shown; off, they are filled in whenever the editor is drawn.
const EDITOR_PREFS = {
  visibleFaces: { key: "liza.remote.visibleFaces", on: true },
  liveValues: { key: "liza.remote.liveValues", on: false },
};

export const VariablesMixin = {
  _variableState() {
    // `deps`: the entities each answer read, by key. `drawn`: the keys the
    // current view read outside the faces, since the last render; `faces`:
    // those the faces read, since they were last drawn. Only these warrant a
    // redraw, and `faces` only of the faces. `pageKeys`: what each page's face
    // read, by page index; `stale`: answers an entity has changed under that
    // nobody was shown, asked for again when somebody is.
    return (this._variables ||= {
      values: new Map(), items: new Map(), entities: new Set(), states: {}, timer: null, queued: new Set(),
      deps: new Map(), drawn: new Set(), faces: new Set(), inFaces: false,
      pageKeys: new Map(), facePage: null, stale: new Set(),
    });
  },

  /** An `EDITOR_PREFS` switch, read once; blocked storage gives its default. */
  _editorPref(name) {
    const prefs = (this._editorPrefs ||= {});
    if (!(name in prefs)) {
      let stored = null;
      try { stored = window.localStorage?.getItem(EDITOR_PREFS[name].key); } catch (e) { /* default */ }
      prefs[name] = stored === "1" || (stored !== "0" && EDITOR_PREFS[name].on);
    }
    return prefs[name];
  },

  _setEditorPref(name, on) {
    (this._editorPrefs ||= {})[name] = !!on;
    try { window.localStorage?.setItem(EDITOR_PREFS[name].key, on ? "1" : "0"); } catch (e) { /* this session only */ }
  },

  /** Is page *idx* in view? Unknown -- no observer, not yet reported, no page -- is yes. */
  _faceVisible(idx) {
    return this._faceVisibility?.get(idx) ?? true;
  },

  /** Does a change to page *idx*'s answers get asked for and drawn now? */
  _facePageLive(idx) {
    return !this._editorPref("visibleFaces") || this._faceVisible(idx);
  },

  /** The face of page *idx* is about to be read: what it reads is its own. */
  _facePageStart(idx, fresh = true) {
    const v = this._variableState();
    v.facePage = idx;
    if (fresh || !v.pageKeys.has(idx)) v.pageKeys.set(idx, new Set());
  },

  _facePageEnd() {
    if (this._variables) this._variables.facePage = null;
  },

  /** Is an answer shown somewhere that follows its entities right now? */
  _variableWanted(key) {
    const v = this._variables;
    if (v.drawn.has(key) && this._editorPref("liveValues")) return true;
    let onPage = false;
    for (const [idx, keys] of v.pageKeys) {
      if (!keys.has(key)) continue;
      if (this._facePageLive(idx)) return true;
      onPage = true;
    }
    // A face read it outside any page's draw: no page to wait for.
    return v.faces.has(key) && !onPage;
  },

  /** Page *idx* came into view: ask for what changed meanwhile, draw what it missed. */
  _faceShown(idx) {
    const v = this._variables;
    const keys = [...(v?.pageKeys.get(idx) || [])].filter((k) => v.stale.has(k));
    for (const k of keys) v.stale.delete(k);
    if (keys.length) this._queueVariables(keys, 0);
    if (this._facesDirty?.delete(idx)) this._variablesLoaded("faces", new Set([idx]));
  },

  /** Does this text name an entity or hold a calculation (`${sensor.outdoor}`)? */
  _hasEntityToken(text) {
    return typeof text === "string" && BACKEND_TOKEN.test(text);
  },

  _variableKey(kind, text) {
    return `${kind}\u0000${text}`;
  },

  /** `{ found, value }` for *text*; a miss is asked for. */
  _variableValue(kind, text) {
    const v = this._variableState();
    const key = this._variableKey(kind, text);
    (v.inFaces ? v.faces : v.drawn).add(key);
    if (v.inFaces && v.facePage !== null) v.pageKeys.get(v.facePage)?.add(key);
    if (v.values.has(key)) {
      // Shown again after a change nobody was shown: asked for now, and drawn
      // when it comes. A face out of view does not count as shown.
      if (v.stale.has(key) && this._facePageLive(v.facePage)) {
        v.stale.delete(key);
        this._queueVariables([key], 0);
      }
      return { found: true, value: v.values.get(key) };
    }
    v.items.set(key, { kind, text });
    this._queueVariables([key], 0);
    return { found: false };
  },

  /**
   * A picture's `${…}` filled in, or null while unknown or when one has no value.
   * A `history:` graph is asked for too: the backend adds the version that
   * changes with its entity, and only graphs what it was asked for this way.
   */
  _resolveImageVariables(image, page) {
    if (typeof image !== "string") return image;
    if (!image.includes("${") && !image.startsWith("history:") && !image.includes(TRANSLATE_TOKEN)) return image;
    // `${_device}` is the device of the page the picture sits on -- not the
    // page being edited, which a thumbnail of another page is not.
    image = (page ? this._expandPageDevice?.(image, page) : this._expandPageDevice?.(image)) ?? image;
    if (!image.includes("${") && !image.startsWith("history:") && !image.includes(TRANSLATE_TOKEN)) return image;
    const r = this._variableValue("image", image);
    return r.found ? r.value : null;
  },

  /** A tooltip's or title's entity variables filled in; unknown ones read as nothing until answered. */
  _substituteEntityTokens(text) {
    if (typeof text !== "string" || !(text.includes("${") || text.includes(TRANSLATE_TOKEN))) return text;
    text = this._expandPageDevice?.(text) ?? text;
    if (!(text.includes("${") || text.includes(TRANSLATE_TOKEN))) return text;
    const r = this._variableValue("text", text);
    return r.found ? r.value : unanswered(text);
  },

  /** Run *draw*, counting what it reads as read by the faces; *fresh*: it redraws them all. */
  _readingFaces(draw, fresh) {
    const v = this._variableState();
    if (fresh) v.faces = new Set();
    const outer = v.inFaces;
    v.inFaces = true;
    try { return draw(); } finally { v.inFaces = outer; }
  },

  _queueVariables(keys, delay) {
    const v = this._variableState();
    keys.forEach((k) => v.queued.add(k));
    if (v.timer) return;
    v.timer = setTimeout(() => this._flushVariables(), delay);
  },

  async _flushVariables() {
    const v = this._variableState();
    v.timer = null;
    const keys = [...v.queued];
    v.queued.clear();
    if (!keys.length || !this._hass?.callWS) return;
    const texts = [];
    const images = [];
    for (const key of keys) {
      const item = v.items.get(key);
      if (item) (item.kind === "image" ? images : texts).push(item.text);
    }
    let answer = null;
    try {
      const ask = { type: "lizaip_config/resolve_variables", texts, images };
      if (this._currentEntry) ask.entry_id = this._currentEntry;
      answer = await this._hass.callWS(ask);
    } catch (e) {
      // Asked again later rather than remembered at once: a phone whose
      // first request was lost otherwise showed every variable picture as
      // its action's icon, and every such title blank, until reloaded. One
      // timer, which the misses meanwhile join, so it is never a loop.
      console.warn("lizaip: resolve_variables failed", e);
      v.failures = (v.failures || 0) + 1;
      if (v.failures <= RETRIES) {
        this._queueVariables(keys, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (v.failures - 1)));
        return;
      }
    }
    if (answer) v.failures = 0;
    if (v.values.size > CACHE_LIMIT) {
      v.values.clear(); v.items.clear(); v.entities.clear(); v.deps.clear();
    }
    // "page": something outside the faces shows a changed answer; "faces":
    // only the faces do.
    let changed = null;
    const changedFaceKeys = new Set();
    const remember = (kind, text, value) => {
      const key = this._variableKey(kind, text);
      if (!v.values.has(key) || v.values.get(key) !== value) {
        // A new answer only matters to a view that showed the old one.
        if (v.drawn.has(key) || (!v.values.has(key) && !v.faces.has(key))) changed = "page";
        else if (v.faces.has(key) && changed !== "page") changed = "faces";
        if (v.faces.has(key)) changedFaceKeys.add(key);
      }
      v.values.set(key, value);
      v.items.set(key, { kind, text });
      if (answer) {
        // A backend without `depends` gets the old behaviour: every entity.
        const read = answer.depends ? (answer.depends[text] || []) : (answer.entities || []);
        v.deps.set(key, new Set(read));
      }
    };
    // Out of tries, the fallback is remembered so that redraws do not ask
    // again; a changed entity does (no `deps`: unknown what it read).
    for (const text of texts) remember("text", text, answer ? (answer.texts?.[text] ?? "") : unanswered(text));
    for (const image of images) remember("image", image, answer?.images?.[image] ?? null);
    for (const e of answer?.entities || []) {
      v.entities.add(e);
      v.states[e] = this._hass?.states?.[e];
    }
    if (changed) this._variablesLoaded(changed, changed === "faces" ? this._pagesReading(changedFaceKeys) : null);
  },

  /** The pages whose faces read any of *keys*; null when one was read outside a page. */
  _pagesReading(keys) {
    const v = this._variables;
    const pages = new Set();
    for (const key of keys) {
      let found = false;
      for (const [idx, read] of v.pageKeys) {
        if (read.has(key)) { pages.add(idx); found = true; }
      }
      if (!found) return null;
    }
    return pages;
  },

  /** Ask again for every answer when an entity one of them read has changed. */
  _refreshVariables() {
    const v = this._variables;
    if (!v || !v.entities.size) return;
    const states = this._hass?.states || {};
    const moved = new Set();
    for (const e of v.entities) {
      if (states[e] !== v.states[e]) { v.states[e] = states[e]; moved.add(e); }
    }
    if (!moved.size) return;
    const keys = [];
    for (const key of v.items.keys()) {
      const read = v.deps.get(key);
      // Not answered yet, or unknown what it read: ask, to be safe.
      if (read && ![...read].some((e) => moved.has(e))) continue;
      // Not on screen, a page out of view, or the editor not following: asked
      // for once somebody is shown it.
      if (this._variableWanted(key)) keys.push(key);
      else v.stale.add(key);
    }
    if (keys.length) this._queueVariables(keys, REFRESH_MS);
  },

  /**
   * New answers arrived: draw what depends on them again, without stealing an
   * edit. *scope* "faces" means only the remote faces showed them, and only
   * those are redrawn, in place.
   */
  _variablesLoaded(scope = "page", pages = null) {
    this._refreshSVGIcons?.();
    if (!this._initialized || this._loading) return;
    if (scope === "faces" && this._refreshSVG) {
      // *pages*: the faces that showed a changed answer; null is every one.
      // Joined while a redraw waits, since only the last one runs.
      this._facesPending = new Set([...(this._facesPending || []), ...(pages || this._facePages())]);
      this._whenTilesSettle(() => {
        const draw = this._facePagesToDraw(this._facesPending);
        this._facesPending = null;
        if (!this._initialized || this._loading || !draw.size) return;
        // A tile on the open face is rebuilt too; its focus comes back with it.
        const focus = this._a11yCaptureFocus?.();
        this._refreshSVG(draw);
        this._applyDeviceUrls?.();
        if (focus) this._a11yRestoreFocus?.(focus);
      });
      return;
    }
    const active = this.shadowRoot?.activeElement;
    // A field still holding what the last render put there loses nothing to a
    // render (focus is put back), and it is usually the very field whose
    // variable was just answered. Only unsaved typing waits.
    // HA's field has no defaultValue; the attribute the render wrote is it.
    const typing = active && /^(INPUT|TEXTAREA|HA-INPUT)$/.test(active.tagName)
      && active.value !== (active.defaultValue ?? active.getAttribute("value") ?? "");
    if (typing || /^(SELECT|HA-SELECT)$/.test(active?.tagName || "")) {
      // Draw it once the typing is committed or the field is left, not never:
      // one listener for whichever of the two comes first, instead of a timer.
      const root = this.shadowRoot;
      if (!this._variablesRetry && root?.addEventListener) {
        const retry = () => {
          root.removeEventListener("change", retry, true);
          root.removeEventListener("focusout", retry, true);
          this._variablesRetry = null;
          this._variablesLoaded(scope);
        };
        this._variablesRetry = retry;
        root.addEventListener("change", retry, true);
        root.addEventListener("focusout", retry, true);
      }
      return;
    }
    this._render?.();
  },

  /** The page index of every face on screen. */
  _facePages() {
    return [...(this.shadowRoot?.querySelectorAll?.(".pg-svg-container") || [])]
      .map((c) => parseInt(c.dataset.pageIdx));
  },

  /**
   * Which of *pages* to redraw now: those not live are remembered and drawn
   * when they come into view (`_faceShown`).
   */
  _facePagesToDraw(pages) {
    const draw = new Set();
    for (const idx of pages) {
      if (this._facePageLive(idx)) draw.add(idx);
      else (this._facesDirty ||= new Set()).add(idx);
    }
    return draw;
  },

  /**
   * Run *draw* once the tile pictures on the faces have loaded or failed, or
   * after `FACES_WAIT_MS` at the latest.
   *
   * A slow phone may need longer than the one-second refresh to load 25
   * pages of tiles; redrawing under it every second only adds work to the
   * loads it is waiting for. Calls while waiting replace *draw*, so a burst
   * of answers ends in one redraw.
   */
  _whenTilesSettle(draw) {
    if (this._tilesWait) {
      this._tilesWait.draw = draw;
      return;
    }
    const loading = [...(this.shadowRoot?.querySelectorAll?.(
      ".pg-svg-container img[data-key][src]") || [])].filter(img => !img.complete);
    if (!loading.length) {
      draw();
      return;
    }
    const pending = new Set(loading);
    const wait = { draw, timer: null };
    this._tilesWait = wait;
    const run = () => {
      if (this._tilesWait !== wait) return;
      this._tilesWait = null;
      clearTimeout(wait.timer);
      wait.draw();
    };
    for (const img of loading) {
      const settled = () => { if (pending.delete(img) && !pending.size) run(); };
      img.addEventListener("load", settled, { once: true });
      img.addEventListener("error", settled, { once: true });
    }
    wait.timer = setTimeout(run, FACES_WAIT_MS);
  },
};
