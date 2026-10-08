/**
 * `${…}` variables in the panel's previews.
 *
 * ``${sensor.outdoor}``, ``${sensor.battery * 2}``, ``${round(sensor.x / 10)}``
 * are worked out by the backend and nowhere else: the remote receives what
 * Python computes, so the panel asks Python (`lizaip_config/resolve_variables`)
 * rather than carry a second implementation that could drift. Answers are kept
 * in a cache the render code reads synchronously; a miss shows the fallback
 * (no picture, no variable text) and is asked for in one batched request, after
 * which the view is drawn again. A change to an entity an answer read asks again.
 *
 * Only the words `${_state}`, `${_name}` and `${_cmd}` are still resolved here
 * (`_substituteLabelTokens`): they depend on the button being edited, not on
 * Home Assistant.
 */

// A `${…}` that is more than one word: an entity, a calculation. Those belong
// to the backend; `${_state}` and friends are a single word.
const BACKEND_TOKEN = /\$\{(?!\s*\w*\s*\})[^{}$]*\}/;
// Entries kept before the cache starts over, so a long session cannot grow it.
const CACHE_LIMIT = 2000;
// Asking again after an entity changes waits this long, so a sensor reporting
// every second costs one request per interval, not one per report.
const REFRESH_MS = 1000;

export const VariablesMixin = {
  _variableState() {
    return (this._variables ||= {
      values: new Map(), items: new Map(), entities: new Set(), states: {}, timer: null, queued: new Set(),
    });
  },

  /** Forget every answer: the remote's Variables switch changed what they are. */
  _resetVariables() {
    const v = this._variables;
    if (!v) return;
    if (v.timer) clearTimeout(v.timer);
    this._variables = null;
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
    if (v.values.has(key)) return { found: true, value: v.values.get(key) };
    v.items.set(key, { kind, text });
    this._queueVariables([key], 0);
    return { found: false };
  },

  /** A picture's `${…}` filled in, or null while unknown or when one has no value. */
  _resolveImageVariables(image) {
    if (typeof image !== "string" || !image.includes("${")) return image;
    image = this._expandPageDevice?.(image) ?? image;
    if (!image.includes("${")) return image;
    const r = this._variableValue("image", image);
    return r.found ? r.value : null;
  },

  /** A tooltip's or title's entity variables filled in; unknown ones read as nothing until answered. */
  _substituteEntityTokens(text) {
    if (typeof text !== "string" || !text.includes("${")) return text;
    text = this._expandPageDevice?.(text) ?? text;
    if (!text.includes("${")) return text;
    const r = this._variableValue("text", text);
    return r.found ? r.value : text.replace(new RegExp(BACKEND_TOKEN.source, "g"), "");
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
      // The remote's own Variables switch applies to its preview too.
      if (this._currentEntry) ask.entry_id = this._currentEntry;
      answer = await this._hass.callWS(ask);
    } catch (e) { /* unanswered: fall through to the fallback */ }
    if (v.values.size > CACHE_LIMIT) { v.values.clear(); v.items.clear(); v.entities.clear(); }
    let changed = false;
    const remember = (kind, text, value) => {
      const key = this._variableKey(kind, text);
      if (!v.values.has(key) || v.values.get(key) !== value) changed = true;
      v.values.set(key, value);
      v.items.set(key, { kind, text });
    };
    for (const text of texts) {
      remember("text", text, answer ? (answer.texts?.[text] ?? "") : text.replace(new RegExp(BACKEND_TOKEN.source, "g"), ""));
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
    if (changed) this._variablesLoaded();
  },

  /** Ask again for every answer when an entity one of them read has changed. */
  _refreshVariables() {
    const v = this._variables;
    if (!v || !v.entities.size) return;
    const states = this._hass?.states || {};
    let changed = false;
    for (const e of v.entities) {
      if (states[e] !== v.states[e]) { v.states[e] = states[e]; changed = true; }
    }
    if (changed) this._queueVariables([...v.items.keys()], REFRESH_MS);
  },

  /** New answers arrived: draw what depends on them again, without stealing an edit. */
  _variablesLoaded() {
    this._refreshSVGIcons?.();
    if (!this._initialized || this._loading) return;
    const active = this.shadowRoot?.activeElement;
    // A field still holding what the last render put there loses nothing to a
    // render (focus is put back), and it is usually the very field whose
    // variable was just answered. Only unsaved typing waits.
    const typing = active && /^(INPUT|TEXTAREA)$/.test(active.tagName)
      && active.value !== active.defaultValue;
    if (typing || active?.tagName === "SELECT") {
      // Draw it once the typing is committed or the field is left, not never.
      if (!this._variablesRetry) {
        this._variablesRetry = setTimeout(() => { this._variablesRetry = null; this._variablesLoaded(); }, 500);
      }
      return;
    }
    this._render?.();
  },
};
