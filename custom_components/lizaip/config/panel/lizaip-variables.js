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

export const VariablesMixin = {
  _variableState() {
    // `deps`: the entities each answer read, by key. `drawn`: the keys the
    // current view read outside the faces, since the last render; `faces`:
    // those the faces read, since they were last drawn. Only these warrant a
    // redraw, and `faces` only of the faces.
    return (this._variables ||= {
      values: new Map(), items: new Map(), entities: new Set(), states: {}, timer: null, queued: new Set(),
      deps: new Map(), drawn: new Set(), faces: new Set(), inFaces: false,
    });
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
    if (v.values.has(key)) return { found: true, value: v.values.get(key) };
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
    } catch (e) { /* unanswered: fall through to the fallback */ }
    if (v.values.size > CACHE_LIMIT) {
      v.values.clear(); v.items.clear(); v.entities.clear(); v.deps.clear();
    }
    // "page": something outside the faces shows a changed answer; "faces":
    // only the faces do.
    let changed = null;
    const remember = (kind, text, value) => {
      const key = this._variableKey(kind, text);
      if (!v.values.has(key) || v.values.get(key) !== value) {
        // A new answer only matters to a view that showed the old one.
        if (v.drawn.has(key) || (!v.values.has(key) && !v.faces.has(key))) changed = "page";
        else if (v.faces.has(key) && changed !== "page") changed = "faces";
      }
      v.values.set(key, value);
      v.items.set(key, { kind, text });
      if (answer) {
        // A backend without `depends` gets the old behaviour: every entity.
        const read = answer.depends ? (answer.depends[text] || []) : (answer.entities || []);
        v.deps.set(key, new Set(read));
      }
    };
    for (const text of texts) {
      remember("text", text, answer ? (answer.texts?.[text] ?? "") : unanswered(text));
    }
    for (const image of images) remember("image", image, answer ? (answer.images?.[image] ?? null) : null);
    // A failed request is remembered as the fallback so it is not asked again
    // in a loop; the next entity change tries once more.
    if (answer) {
      for (const e of answer.entities || []) {
        v.entities.add(e);
        v.states[e] = this._hass?.states?.[e];
      }
    }
    if (changed) this._variablesLoaded(changed);
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
      if (!read || [...read].some((e) => moved.has(e))) keys.push(key);
    }
    if (keys.length) this._queueVariables(keys, REFRESH_MS);
  },

  /**
   * New answers arrived: draw what depends on them again, without stealing an
   * edit. *scope* "faces" means only the remote faces showed them, and only
   * those are redrawn, in place.
   */
  _variablesLoaded(scope = "page") {
    this._refreshSVGIcons?.();
    if (!this._initialized || this._loading) return;
    if (scope === "faces" && this._refreshSVG) {
      // A tile on the open face is rebuilt too; its focus comes back with it.
      const focus = this._a11yCaptureFocus?.();
      this._refreshSVG();
      this._applyDeviceUrls?.();
      if (focus) this._a11yRestoreFocus?.(focus);
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
};
