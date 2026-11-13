/**
 * lizaIP Panel — Helper Utilities
 * Icon resolution, label computation, rendering helpers.
 */

/**
 * `{translate: ${_state}}` -- the spelling the panel writes into a label it
 * fills in for the user -- and a bare `${_state}` both print the state's word
 * in the remote's language. Mirrors `STATE_TOOLTIP` / `STATE_PLACEHOLDER_RE`
 * in `shared/tooltips.py`.
 */
export const STATE_TOOLTIP = "{translate: ${_state}}";
const STATE_PLACEHOLDER_RE = /\{\s*translate\s*:\s*\$\{\s*_state\s*\}\s*\}|\$\{\s*_state\s*\}/gi;
const LEADING_SEPARATORS_RE = /^[\s:;,/\-–—]*$/;
const TWO_WAY_SERVICES = ["toggle", "media_play_pause"];

/**
 * The two face keys drawn like buttons that hold no button record:
 * `slider_horizontal` is the page's title bar, and `slider_vertical` stores
 * mechanics (`slider_actions`) where a button stores `action_id` and `icon`.
 */
export const NON_BUTTON_KEYS = new Set(["slider_horizontal", "slider_vertical"]);

/**
 * Whether `key` names a slot that exchanges *button* configurations. Asked of
 * both ends of a move, because a kind mismatch has no direction. A plain
 * function because both the view and the panel ask it.
 */
export function isMovableSlot(key) {
  return !!key && !NON_BUTTON_KEYS.has(key);
}

/**
 * The target of a device-local command, named in the user's label. Mirrors
 * `NAME_TOKEN` in `const.py`. Only offered on a button carrying such a
 * command: a plain HA action has no target apart from its entity, so the
 * token resolves to nothing there and collapses away like any unknown one.
 */
export const NAME_TOKEN = "${_name}";

/**
 * The wording used when the backend serves a command without a template — an
 * older backend, or one mid-upgrade. Mirrors the `tooltip_template` default on
 * `InternalCommand`; the served value always wins.
 */
const DEFAULT_COMMAND_TOOLTIP_TEMPLATE = "${_cmd}: ${_name}";

/**
 * The attribute a press moves, and where it moves it to. Mirrors
 * `ATTR_ACTION_CYCLES` in `const.py`, which is the single source of truth for
 * everything attribute-driven on the Python side; `tests/label_parity_cases.json`
 * pins the two together.
 *
 * One row per attribute: the values it cycles through, *in order*, each paired
 * with the action key that names *arriving at* that value. The two maps the
 * label ladder actually reads are derived below rather than written out again,
 * so adding an attribute is one row instead of three consistent edits.
 *
 * The table is also the allowlist: an attribute absent from it is not cyclable,
 * so its service keeps behaving exactly as it did before. That is what stops
 * the value setters (`select_source`, `set_hvac_mode`, ...) printing raw HA
 * values on buttons nobody asked to change.
 *
 * `repeat`'s cycle is HA's own, from `home-assistant/frontend`
 * `src/data/media-player.ts`: off -> all -> one -> off. `swing_mode` is
 * deliberately absent -- climate defines five swing values (`on`, `off`,
 * `both`, `vertical`, `horizontal`) plus a free-form per-device list, so no
 * static cycle is correct for it.
 */
export const ATTR_ACTION_CYCLES = {
  is_volume_muted: [["true", "mute"], ["false", "unmute"]],
  shuffle: [["true", "shuffle_on"], ["false", "shuffle_off"]],
  oscillating: [["true", "oscillate_on"], ["false", "oscillate_off"]],
  direction: [["forward", "forward"], ["reverse", "reverse"]],
  repeat: [["off", "repeat_off"], ["all", "repeat_all"], ["one", "repeat_one"]],
};

/** attribute -> the value a cycle press *sets* -> the action naming that set. */
export const ATTR_VALUE_ACTION_MAP = Object.fromEntries(
  Object.entries(ATTR_ACTION_CYCLES).map(([attr, cycle]) => [attr, Object.fromEntries(cycle)]),
);

/** attribute -> its *current* value -> the action the next press performs. */
export const ATTR_ACTION_MAP = Object.fromEntries(
  Object.entries(ATTR_ACTION_CYCLES).map(([attr, cycle]) => [
    attr,
    Object.fromEntries(cycle.map(([value], i) => [value, cycle[(i + 1) % cycle.length][1]])),
  ]),
);

/**
 * Mirrors `SERVICE_ACTION_MAP` / `NEXT_STATE_MAP` / `_ATTR_IRREGULARS` in
 * `const.py`. Module-level rather than inline in the one function that reads
 * them: a literal rebuilt inside a call is a copy that drifts silently, and
 * these already had.
 */
export const SERVICE_ACTION_MAP = {
  turn_on: "on", turn_off: "off",
  open_cover: "open", close_cover: "close", stop_cover: "stop",
  lock: "lock", unlock: "unlock",
  media_play: "play", media_pause: "pause", media_stop: "stop",
  media_next_track: "next", media_previous_track: "previous",
  volume_mute: "mute",
};

export const NEXT_STATE_MAP = {
  on: "off", off: "on",
  playing: "pause", paused: "play", idle: "play",
  open: "close", closed: "open",
  locked: "unlock", unlocked: "lock",
};

/**
 * Target kinds that name something other than an entity, in precedence order:
 * the narrowest one a target names wins. HA hardcodes the same closed set in
 * `TargetSelection`. Mirrors `_SUBJECT_REGISTRIES` in `helpers.py`.
 */
export const SUBJECT_KINDS = ["device", "area", "floor", "label"];

/**
 * States that say nothing about the thing itself, and what "not doing
 * anything" looks like across domains -- the deny-list HA's own `stateActive`
 * reduces to. Anything else counts as active. Mirrors `helpers.py`.
 */
const ABSENT_STATES = ["unavailable", "unknown"];
export const INACTIVE_STATES = [
  ...ABSENT_STATES,
  "off", "closed", "locked", "standby", "idle", "docked", "paused",
  "not_home", "disarmed",
];

export const ATTR_IRREGULARS = {volume_mute: "is_volume_muted", oscillate: "oscillating"};

/**
 * A target field as a list of ids. Every one HA writes is `string | string[]`:
 * a multi-pick emits a list, hand-written YAML a scalar.
 */
function asIdList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

/**
 * True when a number field holds text the browser could not parse. Browsers
 * blank `.value` in that case, so only `validity.badInput` reports it; the
 * NaN test stays for DOM shims that keep the raw text instead.
 */
export function badNumber(el) {
  if (!el || (el.type || el.getAttribute?.("type")) !== "number") return false;
  if ((el.validity ?? nativeInput(el)?.validity)?.badInput) return true;
  const raw = (el.value || "").trim();
  return !!raw && !Number.isFinite(Number(raw));
}

// The <input> inside HA's ha-input, which sits one or two shadow roots down
// and is the only thing that knows the browser rejected what was typed.
function nativeInput(el) {
  let scope = [el];
  for (let depth = 0; depth < 3 && scope.length; depth++) {
    const roots = scope.map((n) => n.shadowRoot).filter(Boolean);
    for (const r of roots) {
      const hit = r.querySelector("input");
      if (hit) return hit;
    }
    scope = roots.flatMap((r) => [...r.querySelectorAll("*")].filter((n) => n.shadowRoot));
  }
  return null;
}

/**
 * The first id out of a target field, mirroring `first_id()` in
 * `action_controller/helpers.py`. `[]` and `""` both collapse to `null`, which
 * matters because `[]` is truthy in JS and would swallow a fallback.
 */
function firstId(value) {
  return asIdList(value)[0] || null;
}

const FIELD_ERR_ID_PREFIX = "liza-field-err-";
let fieldErrUid = 0;

// The picture field's suggestion list (`_wireMediaInput`).
const ICON_SUGGESTION_LIMIT = 50;
let _mediaListSeq = 0;

/**
 * The icon names HA itself offers for *set*, from the lists its own icon
 * picker reads: the frontend's `mdi` list, or the registered provider's
 * `getIconList()`. Logos come from imgserv's bundled and user directories.
 * Asked each time, not cached here: the browser caches the
 * static file and a provider keeps its list in memory.
 */
async function iconNameList(set, hass) {
  const toNames = (list) => (Array.isArray(list) ? list : [])
    .map((i) => (typeof i === "string" ? i : i?.name))
    .filter(Boolean);
  if (set === "mdi") {
    const res = await fetch("/static/mdi/iconList.json");
    return res.ok ? toNames(await res.json()) : [];
  }
  if (set === "logo") {
    return hass.callWS({ type: "lizaip_config/list_logos" });
  }
  const getIconList = customIconRegistry()[set]?.getIconList;
  return typeof getIconList === "function" ? toNames(await getIconList()) : [];
}

/** HA's custom icon registry, as its own `custom_icons.ts` reads it. */
function customIconRegistry() {
  return globalThis.customIcons || globalThis.parent?.customIcons || {};
}

/** `media_player` -> "Media player": a heading, not an identifier. */
function domainLabel(hass, domain) {
  const localized = hass?.localize?.(`component.${domain}.title`);
  if (localized) return localized;
  const words = String(domain || "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The built-in `mdi` and imgserv's `logo`, plus each provider a plugin
 * registered in `window.customIcons` (`phu` from custom-brand-icons, `hue`,
 * ...) that can list its icons.
 */
export function iconProviders() {
  const custom = Object.keys(customIconRegistry())
    .filter((k) => typeof customIconRegistry()[k]?.getIconList === "function");
  return ["mdi", "logo", ...custom.filter((k) => k !== "mdi" && k !== "logo")];
}

/** imgserv's own source types; a browser icon set by one of these names never shadows it. */
const NATIVE_SOURCE_TYPES = new Set(["mdi", "logo", "text", "media"]);

/**
 * The extra icon set *value* is drawn from (`"hue"` for `hue:bulb`), or "".
 * One a plugin registered in the browser that imgserv has no renderer of its
 * own for: the panel uploads its shapes (`uploadCustomIcon`), imgserv draws
 * them from those.
 */
export function customIconSet(value) {
  const m = /^([a-z0-9_-]+):/.exec(String(value ?? "").trim());
  if (!m || NATIVE_SOURCE_TYPES.has(m[1])) return "";
  return typeof customIconRegistry()[m[1]]?.getIcon === "function" ? m[1] : "";
}

/** A monochrome icon (`mdi:`, `phu:` or another extra set): drawn in the tint. */
export function isIconSource(value) {
  const v = String(value ?? "").trim();
  return v.startsWith("mdi:") || v.startsWith("phu:") || !!customIconSet(v);
}

/** The upload entry for one shape, as `getIcon` gives it; null when it has none. */
async function customIconEntry(prefix, name) {
  try {
    const icon = await customIconRegistry()[prefix]?.getIcon?.(name);
    if (!icon?.path) return null;
    const entry = { prefix, name, path: String(icon.path) };
    if (icon.secondaryPath) entry.secondary_path = String(icon.secondaryPath);
    if (icon.viewBox) entry.view_box = String(icon.viewBox);
    return entry;
  } catch (e) {
    return null;
  }
}

/**
 * Hand imgserv the shape behind *value* (`hue:bulb`), which only the browser
 * can look up. A name with a template in it is made up at run time; imgserv
 * notes it when the remote asks, and `syncCustomIcons` fills it in.
 */
export async function uploadCustomIcon(hass, value) {
  const prefix = customIconSet(value);
  if (!prefix || !hass?.callWS) return;
  const name = String(value).trim().slice(prefix.length + 1).split("?")[0];
  if (!name || /[{}]/.test(name)) return;
  const entry = await customIconEntry(prefix, name);
  if (!entry) return;
  try {
    await hass.callWS({ type: "lizaip_config/store_custom_icons", icons: [entry] });
  } catch (e) { /* the remote shows the words until the next sync */ }
}

/** Shapes already handed to imgserv in this browser session. */
const _ensured = new Set();

/**
 * Make sure imgserv can draw *value* before anything asks it to.
 *
 * Saving an icon uploads it, but a value saved by an older version -- or one a
 * variable made up -- was never offered, and imgserv answers 404 for a shape it
 * does not have. Every preview and every tile goes through here, so the panel
 * drawing a set's icon is itself what teaches imgserv to draw it.
 *
 * Once per session per name: the answer cannot change while the plugin that
 * supplies it stays loaded, and a suggestion list redraws on every keystroke.
 * *onUploaded* runs after the shape is in place, for the images that asked for
 * it too early and came back empty.
 */
function ensureCustomIcon(hass, value, onUploaded) {
  const key = customIconKey(value);
  if (!key || !hass?.callWS || _ensured.has(key)) return;
  _ensured.add(key);
  uploadCustomIcon(hass, value).then(() => onUploaded?.(key));
}

/** `"hue:bulb"` for a drawable extra-set value, else `""` (no query, no template). */
function customIconKey(value) {
  const prefix = customIconSet(value);
  if (!prefix) return "";
  const name = String(value).trim().slice(prefix.length + 1).split("?")[0];
  return !name || /[{}]/.test(name) ? "" : `${prefix}:${name}`;
}

/**
 * Tell imgserv which extra icon sets the browser has, and upload the shapes
 * the remote asked for that it did not have yet.
 */
export async function syncCustomIcons(hass) {
  if (!hass?.callWS) return;
  const registry = customIconRegistry();
  const prefixes = Object.keys(registry)
    .filter((k) => !NATIVE_SOURCE_TYPES.has(k) && typeof registry[k]?.getIcon === "function");
  try {
    const { missing = [] } = await hass.callWS({ type: "lizaip_config/sync_custom_icons", prefixes }) || {};
    const icons = (await Promise.all(missing.map(({ prefix, name }) => customIconEntry(prefix, name))))
      .filter(Boolean);
    if (icons.length) await hass.callWS({ type: "lizaip_config/store_custom_icons", icons });
  } catch (e) { /* an older backend, or none: nothing to keep in step */ }
}

/**
 * The source types imgserv draws itself; mirrors `PART_SOURCE_TYPES` in
 * `imgserv/const.py`. Only one of these, or a registered icon set, starts a
 * part -- "Go to page: Sonos" is one phrase, not a `page:` source.
 */
const PART_SOURCE_TYPES = new Set(["mdi", "logo", "text", "media", "ref", "history", "phu"]);

/**
 * A picture written as a bare address -- an HA path or an http(s) URL; mirrors
 * `is_address` in `imgserv/const.py`. It is a part of its own, as `media:` is.
 */
const isAddress = (word) => /^(?:\/\S|https?:\/\/)/i.test(word);

/** Whether *word* names a source, and so starts a part of its own. */
const isPartStart = (word) => {
  if (isAddress(word)) return true;
  const m = /^([a-z][a-z0-9_]*):/.exec(word);
  return !!m && (PART_SOURCE_TYPES.has(m[1]) || !!customIconSet(word));
};

/** Whether *part* is a slug subject still holding nothing but its slug: any
 * source but `text:` -- an icon of any set, a logo, a graph, a picture. */
const isSlugPart = (part) =>
  (isAddress(part) || (isPartStart(part) && !part.startsWith("text:")))
  && !part.includes(" ");

/**
 * Where each part of a composite *value* begins and ends, in order.
 *
 * The panel's reading of `split_source_parts` in `imgserv/const.py`, kept as
 * spans because the suggestion list must know which part the caret is in to
 * replace that one and leave the rest of the title standing.
 */
export function sourcePartSpans(value) {
  const text = String(value ?? "");
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index }));
  if (!words.length) return [];
  const spans = [{ start: words[0].start, end: words[0].start + words[0].text.length }];
  const textOf = (span) => text.slice(span.start, span.end);
  for (let i = 1; i < words.length; i++) {
    const { text: word, start } = words[i];
    const next = words[i + 1]?.text || "";
    const last = spans[spans.length - 1];
    if ((word === "-" || word === "+")
      && (isPartStart(next) || isSlugPart(textOf(last)))) continue;
    if (isPartStart(word) || isSlugPart(textOf(last))) {
      spans.push({ start, end: start + word.length });
    } else {
      last.end = start + word.length;
    }
  }
  return spans.map((s) => ({ ...s, text: textOf(s) }));
}

/**
 * The span of the part *caret* sits in, or null when it sits in none: between
 * two parts, or past the last, is a part not typed yet and nothing to offer.
 */
export function partSpanAt(value, caret) {
  const text = String(value ?? "");
  const at = Number.isInteger(caret) ? caret : text.length;
  return sourcePartSpans(text).find((s) => at >= s.start && at <= s.end) || null;
}

/**
 * Split *value* into the parts drawn side by side, in order -- the mirror of
 * `split_source_parts` in `imgserv/const.py`, which states the rule.
 */
function splitSourceParts(value) {
  return sourcePartSpans(value).map(
    (part, i) => (i > 0 && !isPartStart(part.text) ? `text:${part.text}` : part.text),
  );
}

/** `{set, term}` once *value* starts with a registered icon prefix, else null. */
export function iconQuery(value, providers = iconProviders()) {
  const m = /^([a-z0-9_-]+):([^?]*)$/.exec(String(value ?? "").trimStart());
  return m && providers.includes(m[1]) ? { set: m[1], term: m[2].trim().toLowerCase() } : null;
}

/** The entity being typed after `history:` (lowercased, maybe ""), or null. */
export function historyQuery(value) {
  const m = /^history:([^?]*)$/.exec(String(value ?? "").trimStart());
  return m ? m[1].trim().toLowerCase() : null;
}

/** Names containing *term*, those starting with it first, at most a screenful. */
export function matchIconNames(names, term, limit = ICON_SUGGESTION_LIMIT) {
  if (!term) return names.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const n of names) {
    const i = n.toLowerCase().indexOf(term);
    if (i === 0) starts.push(n);
    else if (i > 0) contains.push(n);
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

/**
 * The `${…` the caret sits inside, or null.
 *
 * A variable is `${domain.object_id}` or `${domain.object_id.attribute}`, so
 * what is typed so far is either an entity id (`stage: "entity"`, `term` the
 * text since the `${`) or, once a second dot has been typed, an attribute of
 * the entity before it (`stage: "attribute"`). `start` is where the `${` begins
 * and `end` the caret, the span a pick replaces. Anything that cannot become a
 * variable -- a closed `${…}`, a space-separated phrase, `${_state}` -- gives null.
 */
export function variableQuery(value, caret) {
  const text = String(value ?? "");
  const end = Number.isInteger(caret) ? caret : text.length;
  const before = text.slice(0, end);
  const start = before.lastIndexOf("${");
  if (start < 0) return null;
  let inside = before.slice(start + 2).trimStart();
  // In a calculation (`${round(`, `${sensor.a * `, `${(sensor.a + `) the variable
  // is what follows the last operator, bracket or comma. `entityStart` says
  // where it begins so a pick can leave the rest standing, and `func` names
  // the function the calculation opens with.
  let func;
  let entityStart;
  if (/[-+*/%(,]/.test(inside)) {
    if (!/^[\w\s.+\-*/%(),]*$/.test(inside)) return null;
    const wrapped = /^([A-Za-z_]\w*)\s*\(/.exec(inside);
    if (wrapped && VARIABLE_FUNCTIONS.includes(wrapped[1].toLowerCase())) func = wrapped[1].toLowerCase();
    const raw = inside.slice(Math.max(...[..."-+*/%(,"].map((c) => inside.lastIndexOf(c))) + 1).trimStart();
    entityStart = end - raw.length;
    inside = raw;
  }
  if (!/^[A-Za-z0-9_.]*$/.test(inside)) return null;
  const parts = inside.split(".");
  if (parts.length > 3) return null;
  const query = parts.length === 3
    ? { stage: "attribute", entity: `${parts[0]}.${parts[1]}`.toLowerCase(), term: parts[2].toLowerCase(), start, end }
    : { stage: "entity", entity: "", term: inside.toLowerCase(), start, end };
  if (entityStart !== undefined) Object.assign(query, func ? { func, entityStart } : { entityStart });
  return query;
}

/** The functions a variable can be wrapped in, in the order they are offered. */
const VARIABLE_FUNCTIONS = ["round", "min", "max", "abs"];

/** Function names starting with *term*, as list entries ending in `(`. */
export function matchFunctions(term) {
  return VARIABLE_FUNCTIONS.filter((f) => f.startsWith(term)).map((f) => ({ id: `${f}(`, name: "function" }));
}

/**
 * Entities matching *term*, best first: id starts with it, id contains it,
 * then friendly name contains it. `states` is `hass.states`.
 */
export function matchEntities(states, term, limit = ICON_SUGGESTION_LIMIT) {
  const ids = Object.keys(states || {}).sort();
  if (!term) return ids.slice(0, limit).map((id) => ({ id, name: states[id]?.attributes?.friendly_name || "" }));
  const starts = [];
  const contains = [];
  const byName = [];
  for (const id of ids) {
    const name = states[id]?.attributes?.friendly_name || "";
    const i = id.indexOf(term);
    if (i === 0) starts.push({ id, name });
    else if (i > 0) contains.push({ id, name });
    else if (String(name).toLowerCase().includes(term)) byName.push({ id, name });
  }
  return starts.concat(contains, byName).slice(0, limit);
}

/** Names of *entity*'s attributes that hold a plain value and match *term*. */
export function matchAttributes(states, entity, term, limit = ICON_SUGGESTION_LIMIT) {
  const attrs = states?.[entity]?.attributes || {};
  const names = Object.keys(attrs).filter((k) => {
    const v = attrs[k];
    return v !== null && typeof v !== "object";
  }).sort();
  return matchIconNames(names, term, limit);
}

/**
 * The panel-side label tokens offered for *term*, as list entries.
 *
 * `${_state}`, `${_queue.…}` and friends are not the backend's variables: they are
 * filled in here, by `_substituteTooltipTokens`, which is why they were missing
 * from this list for as long as it was built out of `hass.states`. *tokens* is
 * the already-gated set the field was wired with — which token can say
 * anything depends on the button, not on the text being typed, so that verdict
 * is reached once at the call site rather than re-derived per keystroke.
 */
export function matchTooltipTokens(term, tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return [];
  const needle = String(term || "").toLowerCase();
  return tokens
    .filter((t) => typeof t?.id === "string" && t.id.toLowerCase().startsWith(needle))
    .map((t) => ({ id: t.id, name: t.name || "" }));
}

/**
 * `${_device.media_title_prev}` and friends: the page player's queue, read as
 * if the neighbouring tracks were attributes of the player. Mirrors
 * `DEVICE_QUEUE_ATTRIBUTES` in `config/media_queue/alias.py`.
 */
export const DEVICE_QUEUE_ATTRIBUTES = {
  media_title_prev: "prev_song",
  media_title_next: "next_song",
  media_artist_prev: "prev_artist",
  media_artist_next: "next_artist",
};

/**
 * What `${_device.…}` can ask about the device rather than about its state.
 * Mirrors `DEVICE_FACTS` in `shared/tokens.py`: offered on every page, in
 * alphabetical order, which is the order the editor offers them in.
 *
 * `friendly_name` says what `${_device}` says, and both are offered.
 */
export const DEVICE_FACTS = [
  "area_name", "friendly_name", "label_names",
  "manufacturer", "model", "sw_version",
];

/**
 * One of `DEVICE_FACTS` as the whole variable, mirroring
 * `DEVICE_FACT_TOKEN_RE`. A fresh one each time: a global regexp remembers
 * where it got to, and one shared between callers would start reading from
 * the middle.
 */
export function deviceFactTokenRe() {
  return new RegExp(`\\$\\{\\s*_device\\.(${DEVICE_FACTS.join("|")})\\s*\\}`, "g");
}

/** `entity.attribute` -- or, for a queue name above, its queue sensor's. */
export function deviceAttribute(entity, attribute) {
  const mapped = DEVICE_QUEUE_ATTRIBUTES[String(attribute).toLowerCase()];
  return mapped ? `sensor.${entity.split(".").slice(1).join(".")}_queue.${mapped}` : `${entity}.${attribute}`;
}

/**
 * `${_device}` and `${_device.attribute}` matching *term*, for a field that
 * knows its page's device (*device*: `{entity, name, facts}`); else nothing.
 * The attributes are the page entity's, under the alias; each fact is
 * offered with what it says beside it, `model` with its `BSB002`.
 */
export function matchDeviceAlias(states, device, term, limit = ICON_SUGGESTION_LIMIT) {
  if (!device) return [];
  const alias = "_device";
  if (term.startsWith(`${alias}.`)) {
    const typed = term.slice(alias.length + 1);
    // The facts come first: they are what the device itself says, so they are
    // offered on every page -- a hub, with no state to read an attribute from,
    // can still answer these.
    const facts = DEVICE_FACTS.filter((f) => f.startsWith(typed.toLowerCase()));
    // What the fact says, beside it. A fact the integration never filled in
    // gets no note, which is the same thing it will draw: nothing.
    const fact = (attr) => ({
      id: `${alias}.${attr}`, name: String(device.facts?.[attr] ?? ""),
    });
    if (!device.entity) return facts.slice(0, limit).map(fact);
    // The queue names are offered on a player whose queue the integration reads.
    const queue = states[deviceAttribute(device.entity, "media_title_prev").split(".").slice(0, 2).join(".")]
      ? Object.keys(DEVICE_QUEUE_ATTRIBUTES).filter((a) => a.startsWith(typed.toLowerCase()))
      : [];
    const attrs = matchAttributes(states, device.entity, typed, limit)
      // A fact is read from the device, not from the entity attribute it is
      // spelled after. It is already offered above, as the fact it is, and
      // must not appear again here as an attribute it would not be read as.
      .filter((attr) => !DEVICE_FACTS.includes(attr));
    return [
      ...facts.map(fact),
      ...[...attrs, ...queue].map((attr) => ({ id: `${alias}.${attr}`, name: "" })),
    ].slice(0, limit);
  }
  return alias.startsWith(term) ? [{ id: alias, name: device.name || device.entity || "" }] : [];
}

/**
 * *value* with the `${…` described by *query* completed to `${pick}`.
 * What is left of the word after the caret and a closing brace already there are replaced, not doubled. Returns the new text
 * and where the caret goes: just before the `}`, so `.attribute` can follow.
 */
export function applyVariablePick(value, query, pick) {
  const text = String(value ?? "");
  const isFunction = pick.endsWith("(");
  const key = query.stage === "attribute" ? `${query.entity}.${pick}` : pick;
  const calculation = query.entityStart !== undefined;
  const head = calculation ? text.slice(0, query.entityStart) : `${text.slice(0, query.start)}\${`;
  const before = head + key;
  const opened = before.slice(before.lastIndexOf("${"));
  const open = (opened.match(/\(/g) || []).length - (opened.match(/\)/g) || []).length;
  const tail = text.slice(query.end).replace(/^[A-Za-z0-9_.]*/, "");
  // In a calculation what follows the caret up to the variable's own `}`
  // (`, 2)`, ` + 1`) stays as typed; only brackets and the brace still missing
  // are supplied. Elsewhere that stretch is dropped.
  const m = /^([^{}$]*)\}/.exec(tail);
  const inside = m && (calculation || /^\s*$/.test(m[1])) ? m[1] : "";
  const rest = m && (calculation || /^\s*$/.test(m[1])) ? tail.slice(m[0].length) : tail;
  const kept = calculation ? inside : "";
  const missing = Math.max(open - (inside.match(/\)/g) || []).length, 0);
  return { value: `${before}${kept}${")".repeat(missing)}}${rest}`, caret: before.length, isFunction };
}

/** The field's own error element. A `children` scan, not `:scope > …`, which
 *  is unsupported inside a shadow root and so matched nothing here. */
const findFieldError = (host) =>
  Array.prototype.find.call(host.children, (n) => n.classList?.contains("field-error")) || null;

export const HelpersMixin = {
  /**
   * What to show a user for a rejected `hass.callWS`.
   *
   * Home Assistant's websocket client does not always reject with an error
   * object. When the browser's connection to Home Assistant drops, every
   * command still in flight is rejected with a bare *number* from
   * `home-assistant-js-websocket`'s `errors.ts` -- `ERR_CONNECTION_LOST` is
   * literally `3`. `e?.message || String(e)` therefore wrote a red "3" into
   * the panel, which names neither what failed nor what to do about it, and
   * did so in every card at once because every card shares that idiom.
   *
   * The numeric codes are translated; anything carrying a message keeps it,
   * since a backend error already says more than this could.
   */
  _wsErrorText(e) {
    const CODES = {
      1: "ws_err_cannot_connect",
      2: "ws_err_invalid_auth",
      3: "ws_err_connection_lost",
      4: "ws_err_host_required",
      5: "ws_err_https_to_http",
      6: "ws_err_auth_callback",
    };
    // `e.code` as well as `e` itself: a rejection is sometimes the bare code
    // and sometimes an object carrying it, and the object form arrives without
    // a message exactly when it is one of these.
    const code = typeof e === "number" ? e : (typeof e?.code === "number" ? e.code : null);
    if (code != null && CODES[code]) return this._t(CODES[code]);
    return e?.message || e?.code || String(e);
  },

  /** Say what went wrong, next to the thing that went wrong (WCAG 3.3.1).
   *  `role="alert"` because it answers what the user just did; the id is
   *  *appended* to `aria-describedby` so the field's hint survives. */
  _setFieldError(el, msg) {
    if (!el) return;
    const host = el.closest(".config-field") || el.parentElement;
    if (!host) return;
    let err = findFieldError(host);
    if (!err) {
      err = document.createElement("span");
      err.className = "field-error";
      err.setAttribute("role", "alert");
      err.id = `${FIELD_ERR_ID_PREFIX}${++fieldErrUid}`;
      host.appendChild(err);
    }
    // Only when it actually changes. Rewriting the same text into a live
    // region re-announces it, so a second bad keystroke would repeat the
    // message on top of itself.
    if (err.textContent !== msg) err.textContent = msg;
    el.setAttribute("aria-invalid", "true");
    const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!ids.includes(err.id)) {
      ids.push(err.id);
      el.setAttribute("aria-describedby", ids.join(" "));
    }
  },

  /**
   * HA's ha-select takes its options as a property, which markup cannot carry.
   * They ride along as data attributes instead, so a template stays one string
   * and `_wireHaSelect` hands them over once the element exists.
   */
  _haSelectAttrs(options, value) {
    return ` data-options="${this._esc(JSON.stringify(options || []))}" data-value="${this._esc(value ?? "")}"`;
  },

  /**
   * Give an ha-select its options and current value, and call *onPick* with
   * each choice. The element reports a pick and leaves showing it to its
   * owner, so the value is written back here before anyone else sees it. A
   * pick of the empty value is a placeholder, never a choice.
   */
  _wireHaSelect(el, onPick) {
    if (!el) return;
    try {
      el.options = JSON.parse(el.dataset?.options || "[]");
    } catch {
      el.options = [];
    }
    el.value = el.dataset?.value ?? "";
    el.addEventListener("selected", (ev) => {
      const value = ev.detail?.value;
      // A native select says "change" only on a change; so does this.
      if (value === undefined || value === null || value === "" || value === el.value) return;
      el.value = value;
      if (el.dataset) el.dataset.value = value;
      onPick(value, ev);
    });
  },

  /**
   * Make each label matching *selector* flip the `ha-switch` its `for` names.
   * `ha-switch` is not a native input, so `<label for>` does not reach it;
   * `preventDefault` keeps a browser that does forward the click from
   * toggling it a second time. The flip is announced as the switch's own
   * `change`, so its change handler is the one place that acts on it.
   */
  _wireSwitchLabels(root, selector) {
    root.querySelectorAll(selector).forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const sw = root.querySelector(`#${el.getAttribute("for")}`);
        if (!sw || sw.disabled) return;
        sw.checked = !sw.checked;
        sw.dispatchEvent(new Event("change", { bubbles: true }));
      }));
  },

  /** Withdraw a `_setFieldError`, including the describedby it added. */
  _clearFieldError(el) {
    if (!el) return;
    const host = el.closest(".config-field") || el.parentElement;
    const err = host ? findFieldError(host) : null;
    el.removeAttribute("aria-invalid");
    // Strip our ids before the early return, not after. Two fields can share
    // one `.config-field` -- Min and Max do -- so clearing the first removes
    // the node the second still points at. Keyed off the id prefix rather than
    // off `err`, which is already gone by then, and a describedby left aimed
    // at a missing node resolves to no description at all.
    const ids = (el.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && !id.startsWith(FIELD_ERR_ID_PREFIX));
    if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
    else el.removeAttribute("aria-describedby");
    if (err) err.remove();
  },

  _getThemeMode() {
    return this._hass?.themes?.darkMode === false ? "light" : "dark";
  },

  /**
   * Run one guarded, busy-flagged backend call against the open remote, and
   * report its failure. Every busy flag in the panel goes through here.
   *
   * Skipped without a remote, or while *flag* is already raised; the flag is
   * held for the duration and the view repainted on the way in and out, so the
   * controls that bind `disabled` to it really are disabled while it runs. The
   * copies this replaced had drifted on exactly that: one never repainted when
   * it raised its flag, so a second click was swallowed by the re-entry guard
   * with no error and no trace.
   *
   * *work* gets the entry it was started for. A failure is reported one of two
   * ways:
   * - `toast`: an i18n key, shown with the error in its `{error}`;
   * - `errorField`: the error's text written into that field for the view to
   *   draw inline, cleared when the run starts. An inline error belongs to the
   *   remote it was made on, so one arriving after the selection moved is
   *   dropped -- posting it under another device is worse than showing nothing.
   *   `onError` undoes what the failure leaves stale.
   * `render: false` leaves the drawing to the caller.
   *
   * Resolves whether *work* succeeded.
   */
  async _runBusy(flag, work, { toast = null, errorField = null, onError = null, render = true } = {}) {
    if (!this._currentEntry || this[flag]) return false;
    const entry = this._currentEntry;
    this[flag] = true;
    if (errorField) this[errorField] = null;
    if (render) this._render();
    try {
      await work(entry);
      return true;
    } catch (e) {
      if (errorField) {
        if (this._currentEntry !== entry) return false;
        onError?.();
        this[errorField] = this._wsErrorText(e);
      }
      if (toast) this._toast(this._t(toast, { error: String(e?.message || e) }));
      return false;
    } finally {
      this[flag] = false;
      if (render) this._render();
    }
  },

  /**
   * A card header: the name, an optional glyph before it and an optional
   * action on the right. Every card in the panel wears this one, so a card that
   * carries an action does not have to grow a header shape of its own for it.
   *
   * `level` is the heading's place in the outline, and it differs by tab: the
   * Settings cards sit under the search-results heading and over their own h4
   * subheadings, so they are h3; elsewhere a card is the first heading under
   * the toolbar's h1.
   */
  _htmlCardHeader(titleKey, { icon = "", action = "", level = 2 } = {}) {
    const glyph = icon
      ? `
        <ha-icon class="settings-card-icon" icon="${icon}" aria-hidden="true"></ha-icon>`
      : "";
    return `
      <div class="actions-card-header${icon ? " settings-card-header" : ""}">${glyph}
        <h${level} class="actions-card-title">${this._esc(this._t(titleKey))}</h${level}>
        ${action}
      </div>`;
  },

  /**
   * A dialog's row of buttons, in the panel's one convention: the way out is a
   * plain button on the left, the step forward on the right -- brand when it
   * commits, danger when it destroys. Each is `{cls, label, attrs?}`, the label
   * already translated; one that is left out is not drawn. `row` is the class of
   * the row itself, which differs between a dialog and the add-page walk's foot.
   */
  _htmlDialogActions({ dismiss = null, commit = null, danger = null, row = "template-dialog-actions" } = {}) {
    const button = (look, b) => b
      ? `
          <ha-button ${look} class="${b.cls}"${b.attrs ? ` ${b.attrs}` : ""}>${this._esc(b.label)}</ha-button>`
      : "";
    return `<div class="${row}">${button('appearance="plain"', dismiss)}${
      button('variant="brand"', commit)}${button('variant="danger"', danger)}
        </div>`;
  },

  /**
   * HTML-escape a value for interpolation into a template string.
   *
   * Coerces before escaping: callers pass whatever a store handed them, and not
   * all of it is a string. `main_pages.yaml` holds page ids as bare integers, so
   * an unnamed page reaches here as `page.name || page.id` -> a number, and
   * `.replace` blew up the whole `_render`, not just the one chip.
   *
   * Falsy input still returns "" rather than "0"/"false", which is what the 50
   * existing call sites already relied on.
   */
  _esc(s) {
    if (!s) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  },

  _isImageUrl(val) {
    if (!val) return false;
    return val.startsWith("http://") || val.startsWith("https://") || val.startsWith("/") || val.startsWith("data:");
  },

  /**
   * @param {string} val   Icon source spec (`mdi:`, `text:`, a URL, …).
   * @param {number|string} size  Rendered size in px, or `title` / `tooltip`.
   * @param {string} color Page `default_color`, or "" to leave the icon untinted.
   *
   * The picture is the remote's: a numeric *size* asks for the `tile` it
   * draws, `title` and `tooltip` for those strips, and *color* is spent by
   * the integration's rule, not this panel's.
   *
   * *opts.theme* draws it in a named theme instead of the remote's stored
   * one, for a picture that is panel chrome rather than a preview.
   *
   * *box* is the space the preview occupies on screen and defaults to the
   * square a numeric size implies. The two are separate because a title is not
   * square: the strip the remote draws is shown whole, at the box's size.
   */
  _renderIconHtml(val, size = 20, color = "", box = null, opts = {}) {
    const boxW = box?.w ?? size;
    const boxH = box?.h ?? size;
    // See _browserImgSrc: the remote's tile is far too few pixels for a
    // picture this big, and the round trip that fills a late `src` in reads
    // the number back off the element.
    const srcSize = opts.srcSize ? Math.round(opts.srcSize) : 0;
    // Normalise once, like resolve_icon_url's icon.strip(): a value pasted with a
    // trailing space or newline must still match the startsWith branches below, or
    // the preview disagrees with what the device renders.
    val = String(val ?? "").trim();
    if (!val) return `<ha-icon icon="mdi:radiobox-blank" style="--mdc-icon-size:${boxH}px"></ha-icon>`;

    // Every picture this panel draws is the one the remote is sent: the URL
    // comes from the integration (`_deviceImg`), so a colour, a text style or
    // a source type is turned into a URL in one place for both. `ha-icon` used
    // to draw `mdi:` and the browser's own sets from the plugins loaded in
    // *this* tab -- a vector, tinted by CSS, that looked right while the remote
    // showed nothing. An extra set (`phu:`, `hue:`) shows it plainest: its
    // shapes reach imgserv only by upload.
    const customKey = customIconKey(val);
    if (customKey) this._ensureCustomIcon(val);
    const kind = size === "title" || size === "tooltip" ? size : "tile";
    const { src, key } = this._deviceImg(val, kind, color, {
      size: srcSize,
      ...(opts.theme ? { theme: opts.theme } : {}),
    });
    const attrs = [
      src ? `src="${this._esc(src)}"` : "",
      key ? `data-dev-key="${this._esc(key)}"` : "",
      srcSize ? `data-img-size="${srcSize}"` : "",
      customKey ? `data-icon-key="${this._esc(customKey)}"` : "",
    ].filter(Boolean).join(" ");
    return `<img ${attrs} class="liza-dev-img" alt="" style="width:${boxW}px;height:${boxH}px;object-fit:contain;border-radius:4px" />`;
  },

  /** An icon for the panel's own chrome, which is not a picture the remote
   *  will ever draw: a vector the frontend theme tints, so a device theme
   *  cannot colour it. A `logo:`/`phu:` source still has to come from imgserv. */
  _renderChromeIconHtml(val, size = 20, ...rest) {
    const icon = String(val ?? "").trim();
    if (!icon.startsWith("mdi:")) return this._renderIconHtml(icon, size, ...rest);
    return `<ha-icon icon="${this._esc(icon)}"
      style="--mdc-icon-size:${size}px" aria-hidden="true"></ha-icon>`;
  },

  /** Teach imgserv this value's shape, and repaint what asked for it too early. */
  _ensureCustomIcon(val) {
    ensureCustomIcon(this._hass, val, (key) => this._repaintCustomIcon(key));
  },

  /**
   * Re-request the images drawn for *key*, now that imgserv has its shape.
   *
   * The `src` is unchanged, so a bare reassignment would repaint the 404 the
   * browser already has; a throwaway parameter -- which imgserv ignores, it
   * reading only the options it knows -- makes it a request it has not made.
   */
  _repaintCustomIcon(key) {
    const sel = `img[data-icon-key="${(globalThis.CSS?.escape ?? ((s) => s))(key)}"]`;
    this.shadowRoot?.querySelectorAll?.(sel).forEach((img) => {
      const src = img.getAttribute?.("src") || "";
      if (src) img.setAttribute("src", `${src.replace(/&_r=\d+/, "")}&_r=${Date.now()}`);
    });
  },

  // What an icon field previews.
  //
  // Three states, not two. An explicit image is drawn as itself. With none, the
  // icon the device would derive stands in at reduced opacity -- it is what the
  // button will show, so saying "no image" over the top of it was false, and the
  // field read as broken next to a face that was drawing something. Only with
  // nothing to derive either is the slot genuinely empty, and then it says so
  // without naming a glyph.
  //
  // It lives here rather than on the buttons view because it is no longer the
  // button card's: the page title, the slider, the per-state rows and the action
  // editor all preview through it, and the empty arm in particular is the one
  // thing every icon field on this panel must agree about.
  _configImagePreviewHtml(buttonIconVal, autoIcon, color = "", shape = null) {
    // Stored and derived are drawn identically on purpose. Which one a button
    // has is an implementation detail -- a template button looks preselected only
    // because generate_assignments copied its YAML icon into `icon` -- so
    // fading the derived one would invent a distinction the user cannot act on,
    // and disagree with the picker, which shows it at full strength.
    //
    // `shape` overrides the square a button gets. It exists for the page title,
    // whose slot on the device is 4:1, and it carries both halves of that --
    // what to ask imgserv for and how much room to give the answer -- because a
    // wide box holding an image requested as a square would letterbox the very
    // difference it was widened to show.
    let icon = String(buttonIconVal || autoIcon || "").trim();
    const size = shape?.size ?? 28;
    const glyph = shape?.box?.h ?? 28;
    // Words are drawn as words, as the device draws them: the integration
    // reads anything that is not a picture as `text:`, so the value goes as is.
    if (icon) return this._renderIconHtml(icon, size, color, shape?.box ?? null);
    return `<span class="cch-preview-empty"><ha-icon icon="mdi:image-off-outline" style="--mdc-icon-size:${glyph}px;"></ha-icon></span>`;
  },

  /**
   * Whether *value* names a picture rather than words to print.
   *
   * Mirrors `is_media_source` in const.py, which decides what the device is
   * sent: URL schemes case-insensitively, imgserv source types exactly.
   */
  _isMediaSource(value) {
    const v = String(value ?? "").trim();
    const low = v.toLowerCase();
    return ["http://", "https://", "ha://", "imgserv://", "local://", "data:"].some(p => low.startsWith(p))
      || ["mdi:", "phu:", "logo:", "text:", "media:", "history:", "/"].some(p => v.startsWith(p))
      || !!customIconSet(v);
  },

  /**
   * One picture field, everywhere one is offered.
   *
   * The page title, a button's Image, its Tooltip, the slider and the
   * per-state rows all ask the same question -- *what goes here* -- and take
   * the same answers: anything imgserv draws (`mdi:`, `phu:`, `logo:`,
   * `text:`, `media:`, a URL), or plain words, which are drawn as
   * `text:` without the prefix being written into the field.
   *
   * A plain text input, because a value has to be copyable out of one field
   * and pastable into another. HA's icon picker showed a chosen icon as a chip
   * with no text to select. Icon names are still offered, as a list under the
   * input once it starts with a registered icon prefix; see `_wireMediaInput`.
   *
   * `value` is what the preview draws, `inputValue` what the input holds; they
   * differ only for the tooltip, whose preview reads its `${…}` tokens.
   * `label` is escaped here because one caller passes a state name, which
   * comes from the entity and is not ours; `hint` and `action` are not,
   * because every caller passes panel markup.
   */
  _htmlIconField({ label, value = "", inputValue = value, autoIcon = "", color = "", shape = null,
                   previewClass = "", slotId = "", slotAttrs = "", hint = "",
                   inputClass = "", placeholder = "", disabled = false, action = "" }) {
    // A variable is previewed as what it reads now; one with no value previews
    // the derived icon, which is what the remote falls back to as well. The
    // derived icon may hold variables too (an action's own icon).
    const preview = this._configImagePreviewHtml(
      this._resolveImageVariables(value) || "", this._resolveImageVariables(autoIcon) || "", color, shape,
    );
    // Every picture field explains its variables the same way, so a per-state
    // icon says what it reads now just like the Image field does.
    if (!hint && this._hasEntityToken(inputValue)) hint = this._imageVariableHint(inputValue);
    const inputId = slotId ? `${slotId}-input` : "";
    return `
        <div class="config-field">
          <label${inputId ? ` for="${inputId}"` : ""}>${this._esc(label)}</label>
          <div class="icon-picker-row">
            <div class="icon-preview${previewClass ? ` ${previewClass}` : ""}">${preview}</div>
            <div class="icon-picker-slot"${slotId ? ` id="${slotId}"` : ""}${slotAttrs ? ` ${slotAttrs}` : ""} data-label="${this._esc(label)}">${this._htmlMediaInput({ id: inputId, value: inputValue, label, inputClass, placeholder, disabled })}</div>${action}
          </div>${hint ? `
          <span class="config-field-hint">${hint}</span>` : ""}
        </div>`;
  },

  /** "Now reads …" plus the variable hint, for a picture field holding `${…}`. */
  _imageVariableHint(value) {
    const now = this._resolveImageVariables(value);
    return `${now ? this._t("label_now_reads", { text: this._esc(now) }) : ""}${this._t("variable_hint")}`;
  },

  _htmlMediaInput({ id = "", value = "", label = "", inputClass = "", placeholder = "", disabled = false }) {
    return `<input type="text" class="liza-media-input${inputClass ? ` ${inputClass}` : ""}"${id ? ` id="${id}"` : ""} value="${this._esc(value)}"${placeholder ? ` placeholder="${this._esc(placeholder)}"` : ""}${label ? ` aria-label="${this._esc(label)}"` : ""} autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false"${disabled ? " disabled" : ""} /><ul class="liza-media-suggest" role="listbox" popover="manual"${label ? ` aria-label="${this._esc(label)}"` : ""} hidden></ul>`;
  },

  /**
   * Wire the input `_htmlIconField` rendered into *slot*.
   *
   * *value* is what the field shows. For a button's Image that may be the
   * derived icon: showing it is display only, because a commit happens only
   * when the text differs from what the field was opened with. *onChange*
   * receives the trimmed new value.
   */
  _mountIconPicker(slot, value, onChange, options = {}) {
    if (!slot) return null;
    let input = slot.querySelector?.("input.liza-media-input") || null;
    if (!input) {
      slot.innerHTML = this._htmlMediaInput({ label: slot.dataset?.label || "" });
      input = slot.querySelector?.("input.liza-media-input") || null;
      if (!input) return null;
    }
    // The selector focus restoration finds the field by after a render.
    const key = slot.id || (slot.dataset?.label || "").trim();
    if (key && input.dataset) input.dataset.a11yPicker = key;
    input.value = value || "";
    this._wireMediaInput(input, slot.querySelector?.(".liza-media-suggest") || null, onChange, options);
    return input;
  },

  /**
   * Commit on Enter or leaving the field; Escape puts it back.
   *
   * A value is committed whole, never per keystroke: a half-typed
   * `mdi:lightb` is not an icon, and pushed to the remote it would draw as
   * nothing between keystrokes.
   *
   * Once the text starts with a registered icon prefix (`mdi:`, `phu:`, ...) a list of matching names
   * opens under it. Picking one commits at once -- the choice is complete.
   * After `history:` the list offers entities to graph, and picking one
   * commits `history:<entity>` the same way.
   * The one other time it opens is inside an unclosed `${`: entities while the
   * id is typed (or a function name such as `round(`), then the entity's attributes
   * after a second dot; the same inside `${round(…)}`. A field given a
   * *device* (a template page's title) also offers `${_device}` and, after its
   * dot, the page entity's attributes. That pick
   * completes the variable in place and keeps editing; see `variableQuery`.
   * The list never opens for anything else, so typing words or pasting a URL
   * is never interrupted by suggestions that cannot apply.
   */
  _wireMediaInput(input, list, onCommit, { device = null, tokens = null } = {}) {
    let pristine = input.value.trim();
    let matches = [];
    let active = -1;
    // The `${…` being completed while the list shows entities or attributes;
    // null while it shows icon names.
    let variable = null;
    // The span of the part being completed, when the field holds more than
    // one: a pick replaces that span and leaves the other parts standing.
    // null while the whole field is the one thing being named.
    let part = null;
    // Bumped by every open and close, so a slow answer for text that has
    // since changed is dropped rather than shown.
    let seq = 0;
    const listId = list ? (list.id ||= `liza-media-${++_mediaListSeq}`) : "";

    // The cards clip their content (overflow: hidden), so a list hanging off
    // the field would be cut at the card's edge and arrowing would move into
    // options nobody can see. It is shown in the top layer instead, placed
    // against the field, below it or above when there is no room below.
    const place = () => {
      const r = input.getBoundingClientRect?.();
      if (!r || !list) return;
      const room = (globalThis.innerHeight || 0) - r.bottom;
      const above = room < 200 && r.top > room;
      list.style.left = `${r.left}px`;
      list.style.width = `${r.width}px`;
      list.style.top = above ? "auto" : `${r.bottom + 2}px`;
      list.style.bottom = above ? `${(globalThis.innerHeight || 0) - r.top + 2}px` : "auto";
    };
    const follow = () => { if (matches.length) place(); };
    const unfollow = () => {
      globalThis.removeEventListener?.("scroll", follow, true);
      globalThis.removeEventListener?.("resize", follow);
    };
    const close = () => {
      seq += 1;
      matches = [];
      active = -1;
      variable = null;
      part = null;
      unfollow();
      if (list) {
        try { if (list.matches?.(":popover-open")) list.hidePopover(); } catch (e) { /* not a popover here */ }
        list.hidden = true;
        list.innerHTML = "";
      }
      input.setAttribute?.("aria-expanded", "false");
      input.removeAttribute?.("aria-activedescendant");
    };
    const commit = (raw) => {
      close();
      const val = String(raw ?? "").trim();
      if (val === pristine) return;
      pristine = val;
      // An extra icon set's shape goes to imgserv first, so the preview the
      // save repaints -- and the remote -- find it there. Every part is
      // offered: one imgserv was never given is a blank in the picture.
      const shapes = this._splitSourceParts(val).filter((p) => customIconSet(p));
      if (shapes.length) {
        Promise.all(shapes.map((shape) => uploadCustomIcon(this._hass, shape)))
          .finally(() => onCommit(val));
      } else onCommit(val);
    };
    const highlight = (idx) => {
      active = idx;
      list?.querySelectorAll?.(".liza-media-option").forEach((li, i) => {
        const on = i === idx;
        li.setAttribute?.("aria-selected", on ? "true" : "false");
        // A class beside the ARIA state: the attribute is what a screen reader
        // reads, the class is what the stylesheet selects on. Styling the
        // attribute alone put the only visible highlight behind an attribute
        // selector, with nothing left to show if that one rule was dropped.
        li.classList?.toggle?.("active", on);
        if (on) li.scrollIntoView?.({ block: "nearest" });
      });
      if (idx >= 0) input.setAttribute?.("aria-activedescendant", `${listId}-${idx}`);
      else input.removeAttribute?.("aria-activedescendant");
    };
    const show = () => {
      list.hidden = false;
      place();
      try { if (!list.matches?.(":popover-open")) list.showPopover?.(); } catch (e) { /* not a popover here */ }
      globalThis.addEventListener?.("scroll", follow, true);
      globalThis.addEventListener?.("resize", follow);
      input.setAttribute?.("aria-controls", listId);
      input.setAttribute?.("aria-expanded", "true");
      active = -1;
    };
    // A variable is not a finished value: picking completes the `${…}` in the
    // text and leaves the field being edited, with the caret before the `}`
    // so `.attribute` can follow. Nothing is committed until the user is done.
    const openVariables = (query) => {
      const states = this._hass?.states || {};
      seq += 1;
      // Not inside a calculation: `${round(_state)}` is not a thing a label
      // token can be part of, where `_device.attribute` genuinely is.
      const plain = query.stage === "entity" && query.entityStart === undefined;
      const label = plain ? matchTooltipTokens(query.term, tokens) : [];
      // Offered inside a calculation too, where `_device.attribute` is a variable.
      const alias = query.stage === "entity" ? matchDeviceAlias(states, device, query.term) : [];
      const found = query.stage === "attribute"
        ? matchAttributes(states, query.entity, query.term).map((id) => ({ id, name: "" }))
        : [
          // First: a short, exact list of what this button can say, ahead of
          // hundreds of entities that merely start with the same letter.
          ...label,
          ...alias,
          ...(query.term.startsWith("_device.") || query.term.startsWith("_queue.") ? [] : [
            ...matchFunctions(query.term),
            ...matchEntities(states, query.term),
          ]),
        ];
      if (!found.length || !list) return close();
      matches = found.map((f) => f.id);
      variable = query;
      part = null;
      list.innerHTML = found.map((f, i) =>
        `<li class="liza-media-option" role="option" id="${listId}-${i}" data-value="${this._esc(f.id)}" aria-selected="false"><span>${this._esc(f.id)}</span>${f.name ? `<span class="liza-media-note">${this._esc(f.name)}</span>` : ""}</li>`,
      ).join("");
      show();
    };
    // A part is not the whole value: picking replaces that part and leaves
    // the field being edited, so the next part can be typed. The same
    // bargain a variable pick strikes.
    const pickPart = (pick) => {
      const span = part;
      close();
      const text = input.value;
      input.value = text.slice(0, span.start) + pick + text.slice(span.end);
      const caret = span.start + pick.length;
      try { input.setSelectionRange?.(caret, caret); } catch (e) { /* not a text input here */ }
    };
    const pickVariable = (pick) => {
      const q = variable;
      close();
      const done = applyVariablePick(input.value, q, pick);
      input.value = done.value;
      try { input.setSelectionRange?.(done.caret, done.caret); } catch (e) { /* not a text input here */ }
    };
    // After `history:`, the entity to graph; picking one is the whole value.
    const openHistory = (term) => {
      seq += 1;
      const found = matchEntities(this._hass?.states || {}, term);
      if (!found.length || !list) return close();
      matches = found.map((f) => `history:${f.id}`);
      variable = null;
      list.innerHTML = found.map((f, i) =>
        `<li class="liza-media-option" role="option" id="${listId}-${i}" data-value="${this._esc(matches[i])}" aria-selected="false"><span>${this._esc(f.id)}</span>${f.name ? `<span class="liza-media-note">${this._esc(f.name)}</span>` : ""}</li>`,
      ).join("");
      show();
    };
    const open = async () => {
      const typing = variableQuery(input.value, input.selectionStart);
      if (typing) return openVariables(typing);
      // The part being typed is the one the caret is in: `logo:hue mdi:li`
      // offers lightbulbs. A field holding a single part is completed whole,
      // so the common case behaves exactly as it always did.
      const spans = sourcePartSpans(input.value);
      const here = spans.length > 1 ? partSpanAt(input.value, input.selectionStart) : null;
      if (spans.length > 1 && !here) return close();
      const subject = here ? here.text : input.value;
      const graphed = historyQuery(subject);
      if (graphed !== null) { part = here; return openHistory(graphed); }
      const query = iconQuery(subject);
      if (!query || !list) return close();
      const mine = ++seq;
      let names = [];
      try { names = await iconNameList(query.set, this._hass); } catch (e) { /* no list, no suggestions */ }
      if (mine !== seq) return;
      matches = matchIconNames(names, query.term).map(n => `${query.set}:${n}`);
      variable = null;
      part = here;
      if (!matches.length) return close();
      list.innerHTML = matches.map((v, i) =>
        `<li class="liza-media-option" role="option" id="${listId}-${i}" data-value="${this._esc(v)}" aria-selected="false">${this._renderIconHtml(v, 20)}<span>${this._esc(v)}</span></li>`,
      ).join("");
      show();
    };

    input.addEventListener("input", open);
    input.addEventListener("keydown", (e) => {
      const isOpen = matches.length > 0;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) {
          open().then(() => { if (matches.length) highlight(0); });
          return;
        }
        const step = e.key === "ArrowDown" ? 1 : -1;
        // From nothing selected, ArrowUp means the last option. Counting from
        // -1 instead landed on the second to last and the list could never be
        // entered from the bottom.
        highlight(active < 0
          ? (step > 0 ? 0 : matches.length - 1)
          : (active + step + matches.length) % matches.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isOpen && active >= 0 && variable) return pickVariable(matches[active]);
        if (isOpen && active >= 0 && part) return pickPart(matches[active]);
        if (isOpen && active >= 0) input.value = matches[active];
        commit(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Two steps, like any combobox: close the list, then undo the edit.
        if (isOpen) close();
        else input.value = pristine;
      }
    });
    input.addEventListener("blur", () => commit(input.value));
    // Pressing a suggestion would blur the input first and commit the
    // half-typed text before the pick arrives.
    list?.addEventListener("mousedown", (e) => e.preventDefault());
    list?.addEventListener("click", (e) => {
      const li = e.target?.closest?.(".liza-media-option");
      if (!li) return;
      if (variable) return pickVariable(li.dataset.value);
      if (part) return pickPart(li.dataset.value);
      input.value = li.dataset.value;
      commit(input.value);
    });
  },

  // ── Pictures as the remote is sent them ──────────────────────────────
  //
  // Every preview of something the remote shows is drawn from the URL the
  // remote is sent, built by the integration's own `resolve_*_url`
  // (`lizaip_config/image_urls`): the panel adds only what a browser needs --
  // `alpha=1`, and `mode=light` on a light theme -- so preview and remote can
  // only differ in those two.
  //
  // The answer is asynchronous, so a picture not yet known is drawn without a
  // `src` and carries `data-dev-key`; `_applyDeviceUrls` fills it in.

  /**
   * `{src, key}` for *value* drawn as the remote draws a *kind* picture
   * (`tile`, `title` or `tooltip`); `src` is null while the URL is asked for,
   * and "" when there is nothing to draw.
   *
   * *opts.keepMode* leaves `mode=dark` alone, for a preview drawn on black.
   * *opts.theme* draws the picture in a named theme instead of this remote's,
   * which is how the theme picker shows a combination before it is saved.
   */
  _deviceImg(value, kind = "tile", color = "", opts = {}) {
    const v = String(value ?? "").trim();
    if (!v || !this._currentEntry) return { src: "", key: "" };
    const theme = String(opts.theme || "");
    // A picture asked for in a named theme does not depend on the stored
    // settings, so it must not be re-fetched when they change.
    const style = theme || JSON.stringify(this._textSettings?.settings ?? null);
    const key = JSON.stringify([
      this._currentEntry, style, kind, v, String(color || "").replace(/^#/, "").toUpperCase(),
    ]);
    const cache = (this._deviceUrlCache ||= new Map());
    if (cache.has(key)) return { src: this._browserImgSrc(cache.get(key), opts), key };
    (this._deviceUrlQueue ||= new Map()).set(key, {
      value: v, kind, color: String(color || "").replace(/^#/, ""),
      ...(theme ? { theme } : {}),
    });
    if (!this._deviceUrlTimer) {
      this._deviceUrlTimer = setTimeout(() => this._flushDeviceUrls(), 0);
    }
    return { src: null, key };
  },

  /**
   * What a browser asks for the remote's *url*: transparent, and legible on
   * the theme.
   *
   * *opts.size* asks imgserv for a picture that many pixels tall instead of
   * the remote's own tile, which is 50x16 for a wordmark and is a smear once
   * a screen of any density draws it at dialog size. The remote is still
   * sent the tile; only this browser asks for more of it.
   */
  _browserImgSrc(url, opts = {}) {
    if (!url) return "";
    if (!url.startsWith("imgserv://")) return url;
    let src = `/api/imgserv/${url.slice("imgserv://".length)}`;
    if (opts.size) src = src.replace(/([?&]size=)tile\b/, `$1${Math.round(opts.size)}`);
    const q = src.indexOf("?");
    if (!opts.keepMode && this._getThemeMode() === "light") {
      // A light page under white glyphs would show nothing at all.
      if (/[?&]mode=/.test(src)) src = src.replace(/([?&]mode=)dark\b/, "$1light");
      else src += `${q >= 0 ? "&" : "?"}mode=light`;
    }
    // A whole `media:` picture is drawn round since `round1`; the version
    // makes a browser holding the old, square one ask again.
    if (/^\/api\/imgserv\/media:/.test(src) && !/[?&](box|rv|radius)=/.test(src)) src += `${src.includes("?") ? "&" : "?"}rv=round1`;
    return `${src}${src.includes("?") ? "&" : "?"}alpha=1`;
  },

  /** Ask for every URL queued since the last ask, in one call per 400. */
  async _flushDeviceUrls() {
    this._deviceUrlTimer = null;
    const queue = this._deviceUrlQueue;
    if (!queue?.size || !this._hass) return;
    this._deviceUrlQueue = new Map();
    const entries = [...queue.entries()];
    const entry = this._currentEntry;
    for (let i = 0; i < entries.length; i += 400) {
      const chunk = entries.slice(i, i + 400);
      let urls;
      try {
        ({ urls } = await this._hass.callWS({
          type: "lizaip_config/image_urls", entry_id: entry,
          items: chunk.map(([, item]) => item),
        }));
      } catch (e) {
        console.warn("lizaip: image_urls failed", e);
        continue;
      }
      const cache = (this._deviceUrlCache ||= new Map());
      chunk.forEach(([key], n) => cache.set(key, urls?.[n] ?? ""));
      this._applyDeviceUrls();
    }
  },

  /** Forget every resolved picture address, so the next render asks again:
   * a theme's URL only changes when its content does, and nothing else here
   * would notice that it has. */
  _forgetDeviceUrls() {
    this._deviceUrlCache?.clear();
  },

  /** Give every picture drawn before its URL was known the URL it now has. */
  _applyDeviceUrls() {
    const cache = this._deviceUrlCache;
    this.shadowRoot?.querySelectorAll?.("img[data-dev-key]").forEach((img) => {
      const key = img.getAttribute("data-dev-key");
      if (!cache?.has(key)) return;
      const src = this._browserImgSrc(cache.get(key), {
        keepMode: img.hasAttribute("data-keep-mode"),
        size: Number(img.getAttribute("data-img-size")) || 0,
      });
      if (!src) {
        img.style.visibility = "hidden";
        return;
      }
      // Compared rather than "has any `src` already": a tile that kept showing
      // its old picture while this round trip ran is exactly the one waiting
      // for the answer.
      if (img.getAttribute("src") === src) return;
      img.style.removeProperty?.("visibility");
      img.setAttribute("src", src);
    });
  },

  /** `splitSourceParts`, for the templates and callers that reach it as a method. */
  _splitSourceParts(value) {
    return splitSourceParts(value);
  },

  /** Tint applied to previews of the page being edited; "" when none is set. */
  _currentPageColor() {
    return this._pages?.[this._currentPageIdx]?.default_color || "";
  },

  /**
   * The icon for a service, optionally resolved against the entity it targets.
   *
   * `entityId` matters for cross-domain steps, which this repo treats as
   * first-class (`homeassistant.toggle` aimed at a media_player). Icons follow
   * the *entity's* domain, not the service's — the same rule
   * `_resolve_button_icon` follows in device_sync.py, which passes
   * `entity_id.split(".")[0]`. Without it the two surfaces disagreed:
   * `homeassistant.turn_off` on a media_player drew mdi:power-off on the device
   * (from `domain_service_icons.media_player`) and HA's generic icon here.
   *
   * Falls back to the service's own domain when no entity is known, which is
   * what the callers that have no target still get.
   */
  _getServiceIcon(service, entityId = "") {
    if (!service) return "mdi:cog";
    // A device-local command is not in HA's service icon registry — it brings
    // its own default from the backend registry.
    const internal = this._internalCommand(service);
    if (internal?.icon) return internal.icon;
    const svcDomain = service.split(".")[0];
    const svc = service.split(".")[1] || "";
    const domain = (entityId && entityId.split(".")[0]) || svcDomain;

    // Same precedence as the device (device_sync._resolve_button_icon): our own
    // The default theme's icon table wins over HA's service registry, so both surfaces agree.
    // Per-domain first — see _serviceFixedIcon for why that layer exists.
    //
    // Entity domain here, service domain below: our override table is about
    // what the button *controls*, but HA's registry is keyed by the domain that
    // *defines* the service, so `homeassistant.turn_off` only exists under
    // `homeassistant`. device_sync.py splits it the same way.
    const yamlIcon = this._serviceFixedIcon(domain, svc);
    if (yamlIcon) return yamlIcon;

    if (this._serviceIconsCache) {
      const domainIcons = this._serviceIconsCache[svcDomain];
      if (domainIcons?.[svc]?.service) return domainIcons[svc].service;
    }

    // Last resort: the domain's own icon, from the same yaml the executor reads
    // (`DOMAIN_ICONS`). This was a hardcoded literal that disagreed with the
    // yaml on three entries -- media_player was mdi:cast here and mdi:play-circle
    // there, script mdi:script vs mdi:script-text, and `remote` existed only
    // here, so deferring to the yaml dropped a whole domain to mdi:cog. The
    // yaml now carries `remote: mdi:remote`, which fixes the device too: it
    // reads the same table and never had the entry either.
    return this._iconDefaults?.domain_icons?.[domain] || "mdi:cog";
  },

  _targetAreaId(entry) {
    return entry.area_id || this._hass?.devices?.[entry.device_id]?.area_id || null;
  },

  _entryMatchesTarget(entry, target) {
    if (asIdList(target.device_id).includes(entry.device_id)) return true;

    const areaId = this._targetAreaId(entry);
    if (areaId && asIdList(target.area_id).includes(areaId)) return true;

    const area = areaId ? this._hass?.areas?.[areaId] : null;
    if (area?.floor_id && asIdList(target.floor_id).includes(area.floor_id)) return true;

    const labelIds = asIdList(target.label_id);
    if (labelIds.length) {
      const device = this._hass?.devices?.[entry.device_id];
      const owned = [
        ...(entry.labels || []),
        ...(device?.labels || []),
        ...(area?.labels || []),
      ];
      if (owned.some((label) => labelIds.includes(label))) return true;
    }

    return false;
  },

  /**
   * The entity a button's first step acts on -- the mirror of
   * `resolve_target_entities` in `action_controller/helpers.py`, so the label
   * names what a press will actually hit.
   *
   * Like HA's own target helper: hidden and `entity_category` entities are
   * skipped, the kinds are a union rather than a precedence chain, and the
   * result is sorted before the first is taken.
   */
  _getTargetEntitiesFromConfig(config) {
    const step = config?.[0];
    if (!step || typeof step !== "object") return [];

    const eid = firstId(step.target?.entity_id) || firstId(step.data?.entity_id);
    if (eid) return [eid];

    const target = step.target;
    const registry = this._hass?.entities;
    if (!target || !registry) return [];

    const svc = step.action || step.service || "";
    const domain = svc.includes(".") ? svc.split(".")[0] : "";

    const matched = [];
    for (const entry of Object.values(registry)) {
      if (!entry?.entity_id) continue;
      if (entry.hidden || entry.entity_category) continue;
      if (domain && entry.entity_id.split(".")[0] !== domain) continue;
      if (this._entryMatchesTarget(entry, target)) matched.push(entry.entity_id);
    }
    return matched.sort();
  },

  _getTargetEntityFromConfig(config) {
    return this._getTargetEntitiesFromConfig(config)[0] || null;
  },

  /**
   * The name of the thing a step points at, when that is not an entity --
   * the mirror of `target_subject_name` in `action_controller/helpers.py`.
   * A button aimed at an area is about the area, so it reads "Office" rather
   * than borrowing the name of whichever lamp sorted first.
   */
  _getTargetSubjectName(config) {
    const step = config?.[0];
    if (!step || typeof step !== "object") return "";
    if (firstId(step.target?.entity_id) || firstId(step.data?.entity_id)) return "";

    const target = step.target;
    if (!target) return "";
    for (const kind of SUBJECT_KINDS) {
      const id = firstId(target[`${kind}_id`]);
      if (!id) continue;
      const item = this._subjectRegistry(kind)?.[id];
      return item?.name_by_user || item?.name || "";
    }
    return "";
  },

  /**
   * Where a kind's names live. `hass` carries every registry but the label one,
   * which HA's own pickers fetch separately too -- `_loadLabels` primes it into
   * the same id-keyed shape.
   */
  _subjectRegistry(kind) {
    return kind === "label" ? this._labels : this._hass?.[`${kind}s`];
  },

  /**
   * The state a step's target presents, across every entity behind it --
   * the mirror of `resolve_group_state`. Members with nothing to report are
   * skipped, so one dead lamp cannot answer for a room.
   */
  _getTargetStateObj(config) {
    const states = this._getTargetEntitiesFromConfig(config)
      .map((eid) => this._hass?.states?.[eid])
      .filter(Boolean);
    const present = states.filter((s) => !ABSENT_STATES.includes(s.state));
    return (
      present.find((s) => !INACTIVE_STATES.includes(s.state))
      || present[0]
      || states[0]
      || null
    );
  },

  _getDisplayIconForState(action, entityId, stateIcons) {
    if (action.icon && (!action.states || action.states.length === 0)) return action.icon;
    let states = action.states;
    if ((!states || states.length === 0) && action.service) {
      const { attribute, states: derivedStates } = this._getStatesForAction(action, entityId);
      if (derivedStates.length > 0) {
        const domain = action.service.split(".")[0];
        const defaults = this._getDefaultIcons(domain, attribute);
        states = derivedStates.map(s => ({ state: s, icon: defaults[s] || "", attribute: attribute || undefined }));
      }
    }
    if (states && states.length > 0) {
      if (entityId) {
        const stateObj = this._hass?.states?.[entityId];
        if (stateObj) {
          for (const s of states) {
            const matchState = s.attribute
              ? String(stateObj.attributes?.[s.attribute] ?? "")
              : stateObj.state;
            if (matchState === s.state) {
              if (stateIcons && stateIcons[s.state]) return stateIcons[s.state];
              if (s.icon) return s.icon;
            }
          }
          // Nothing matched. Before falling back to the generic service icon,
          // ask whether this domain collapses its non-active states into one
          // face — `media_play_pause` does, and since its row list was narrowed
          // to the two a press can produce, an idle speaker arrives here on
          // every empty queue. The generic icon would be a visible regression.
          const [svcDomain, svcName] = (action.service || "").split(".");
          const catchAll = this._isScopedStateService(svcName)
            ? this._catchAllState(svcDomain, stateObj.state)
            : null;
          if (catchAll) {
            if (stateIcons && stateIcons[catchAll]) return stateIcons[catchAll];
            const row = states.find(s => !s.attribute && s.state === catchAll);
            if (row?.icon) return row.icon;
          }
        }
      }
      if (stateIcons) {
        const firstOverride = states.find(s => stateIcons[s.state]);
        if (firstOverride) return stateIcons[firstOverride.state];
      }
      const withIcon = states.find(s => s.icon);
      if (withIcon) return withIcon.icon;
    }
    // The entity we just matched against, not just the service: a cross-domain
    // step (`homeassistant.turn_off` on a media_player) resolves through our
    // per-domain override table only when the entity domain comes along, and
    // dropping it here would answer differently from `_resolveButtonIcon`,
    // which does pass it. Unlike `_getActionDisplayIcon` below, this one is
    // handed the entity outright.
    return this._getServiceIcon(action.service, entityId || "");
  },

  // No entity to offer: the actions list renders shared library entries, and the
  // target lives on whichever button uses one. The service's own domain is the
  // honest answer here, not a guess borrowed from an arbitrary button.
  _getActionDisplayIcon(action) {
    const own = this._resolveImageVariables(action.icon);
    if (own) return own;
    if (action.states && action.states.length > 0) {
      for (const row of action.states) {
        const icon = this._resolveImageVariables(row?.icon);
        if (icon) return icon;
      }
    }
    if (action.service) {
      const { attribute, states: derivedStates } = this._getStatesForAction(action);
      if (derivedStates.length > 0) {
        const domain = action.service.split(".")[0];
        const defaults = this._getDefaultIcons(domain, attribute);
        const firstIcon = defaults[derivedStates[0]];
        if (firstIcon) return firstIcon;
      }
    }
    return this._getServiceIcon(action.service);
  },

  _getActionSubtitle(action) {
    return action.service || this._t("no_service_subtitle");
  },

  /**
   * The default name for a newly created action library entry.
   *
   * Uses `_serviceRef` -- `{translate: previous}` and friends, the same
   * vocabulary the device prints and the shipped templates use -- rather
   * than a mechanical verb + domain transform. This name is stored on the
   * library entry and flows straight into the button label, so the transform
   * reached the device as "play:5 Media play media_player" (and, worse,
   * "play:5 Open cover cover") sitting beside neighbours that said
   * "play:5 Next". A one-way service like `media_play` has no `${_state}` to
   * resolve, so this default name IS the label the user ends up with.
   *
   * The domain is not lost by dropping it here: `_getActionSubtitle` renders
   * the full service under the name in the action list, which is the place
   * that actually needs to tell `light.turn_on` from `media_player.turn_on`.
   */
  _deriveActionName(service) {
    if (!service) return "New Action";
    // A device-local command has no domain+verb to split — the registry names it.
    const internal = this._internalCommand(service);
    if (internal) return internal.name;
    const action = service.split(".")[1];
    if (!action) return service;
    return this._serviceRef(action) || service;
  },

  // --- Internal (device-local) commands -------------------------------------
  //
  // These run on the remote itself: no entity, no state, no HA round trip. The
  // descriptors come from the backend registry (`_loadInternalCommands`), so
  // everything below stays true for a command that does not exist yet.

  /** The registry descriptor for `service`, or null when it is a plain HA call. */
  _internalCommand(service) {
    if (!service) return null;
    return (this._internalCommands || []).find(c => c.service === service) || null;
  },

  /** The internal command a button's config carries, or null. */
  _internalCommandFor(config, fallbackService = "") {
    return this._internalCommand(this._stepService(config) || fallbackService);
  },

  /** The target a step names, as the raw values it was stored with. */
  _internalTarget(config, fallbackService = "") {
    const cmd = this._internalCommandFor(config, fallbackService);
    if (!cmd) return null;
    const payload = this._stepPayload(config);
    const keyOf = (type) => cmd.target_params?.find(p => p.type === type)?.key;
    const nameKey = keyOf("page_name");
    const idKey = keyOf("page_id");
    const rawName = nameKey ? payload[nameKey] : undefined;
    const rawId = idKey ? payload[idKey] : undefined;
    const id = typeof rawId === "string" ? parseInt(rawId, 10) : rawId;
    return {
      name: typeof rawName === "string" ? rawName.trim() : "",
      id: Number.isInteger(id) ? id : null,
    };
  },

  /**
   * The page a step points at, or null when it points at nothing that exists.
   *
   * Mirrors the backend's resolution deliberately, including the cases it
   * refuses: a name matching two pages, and a name and an id that disagree.
   * The panel has to reach the same verdict, or it would show a button as fine
   * that the device is about to receive disarmed.
   */
  _internalTargetPage(config, fallbackService = "") {
    const target = this._internalTarget(config, fallbackService);
    if (!target) return null;
    const pages = this._pages || [];
    if (target.name) {
      const key = target.name.toLowerCase();
      const matches = pages.filter(p => this._pageLabel(p).toLowerCase() === key);
      if (!matches.length) return null;
      // An id alongside the name is how a shared name is made unambiguous, so
      // an id that is one of the matches settles it and one that is none of
      // them means the two fields describe different pages.
      if (target.id !== null) return matches.find(p => p.id === target.id) || null;
      return matches.length === 1 ? matches[0] : null;
    }
    if (target.id === null) return null;
    return pages.find(p => p.id === target.id) || null;
  },

  /** True when *cmd* targets a page, so the page-aware resolution below applies. */
  _targetsPages(cmd) {
    return (cmd?.target_params || []).some(
      p => p.type === "page_id" || p.type === "page_name",
    );
  },

  /**
   * The name a device-local command's target had when the button was saved.
   *
   * Mirrors `_internal_target_hint` in device_sync.py. Held beside the step,
   * not inside it: the step stores a page id, and a second target field there
   * would have to keep agreeing with that id — `_goto_page_params` disarms a
   * button whose two target fields disagree, so a rename would break a working
   * button. As a note alongside it can go stale harmlessly, because it is only
   * read once the real target is gone.
   */
  _internalTargetHint(assign) {
    const hint = assign?.internal_target_name;
    return typeof hint === "string" ? hint.trim() : "";
  },

  /**
   * The stored value of the first target param holding text — the panel's
   * mirror of `_stored_target_name` in `internal_commands/registry.py`.
   *
   * Type-agnostic on purpose, and text-only for the same reason the Python is:
   * this is the floor every command gets, so a new one targeting something
   * that is not a page still names itself from what the user picked, with no
   * change here. A type that can do better than the raw stored value — turning
   * a page id into that page's title — says so in the branch above.
   */
  _internalStoredTargetName(config, fallbackService = "") {
    const cmd = this._internalCommandFor(config, fallbackService);
    if (!cmd) return "";
    const payload = this._stepPayload(config);
    for (const param of cmd.target_params || []) {
      const value = payload[param.key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  },

  /**
   * What an internal command's button points *at*, in words. "" when nothing.
   *
   * Mirrors `command_target_name()` in `internal_commands/registry.py`: this is the
   * value of `${_name}`, both in the auto label and in one the user typed, so
   * a hand-written "Go to ${_name}" cannot name a different page than the
   * default label does.
   *
   * `fallback` is the name the target had when the button was saved. The
   * dropdown stores a page *id*, so a deleted page could otherwise only be
   * reported as "Page 3" — a number the user never chose and cannot act on.
   * Read only when the target is unresolvable, so a renamed page still follows
   * its rename.
   */
  _internalCommandTargetName(config, fallbackService = "", fallback = "") {
    const cmd = this._internalCommandFor(config, fallbackService);
    if (!cmd) return "";
    if (this._targetsPages(cmd)) {
      const page = this._internalTargetPage(config, fallbackService);
      if (page) return this._pageLabel(page);
      // Unresolvable: say what it was looking for rather than going blank.
      const target = this._internalTarget(config, fallbackService);
      if (target?.name) return target.name;
      if (target?.id === null || target?.id === undefined) return "";
      return fallback || `Page ${target.id}`;
    }
    return this._internalStoredTargetName(config, fallbackService) || fallback;
  },

  /**
   * Why a device-local command will not run, or "" when it will.
   *
   * The device *disarms* a command whose target it cannot resolve — it is sent
   * a bare `ha_event` that does nothing. Nothing in the panel said so: the
   * button kept its icon and a confident "Go to page: Kitchen" label while a
   * press did nothing at all. The label is deliberately still the target the
   * user asked for (going blank would hide which page it wanted), so the
   * brokenness has to be surfaced beside it rather than baked into it.
   *
   * Mirrors the verdicts `_goto_page_params` raises, one for one, so the panel
   * and the device never disagree about whether a button works.
   */
  _internalCommandProblem(config, fallbackService = "") {
    const cmd = this._internalCommandFor(config, fallbackService);
    if (!cmd || !this._targetsPages(cmd)) return "";
    const target = this._internalTarget(config, fallbackService);
    const hasName = !!target?.name;
    const hasId = target?.id !== null && target?.id !== undefined;
    // `no_page_target`
    if (!hasName && !hasId) return this._t("goto_no_page");
    // Resolvable: the device will accept it.
    if (this._internalTargetPage(config, fallbackService)) return "";
    const named = `“${target.name}”`;
    if (hasName && hasId) {
      // `conflicting_page_target` — the two fields describe different pages.
      return this._t("goto_name_id_disagree", { name: named, id: target.id });
    }
    if (hasName) {
      const key = target.name.toLowerCase();
      const matches = (this._pages || []).filter(p => this._pageLabel(p).toLowerCase() === key);
      // `ambiguous_page_name` — refusing to guess is why this is not resolved.
      if (matches.length > 1) {
        return this._t("goto_ambiguous_name", { count: matches.length, name: named });
      }
      // `unknown_page_name`
      return this._t("goto_name_gone", { name: named });
    }
    // A bare id that no page carries — `is_available` refuses it.
    return this._t("goto_id_gone", { id: target.id });
  },

  /**
   * Auto label for an internal command: what it does, and to what.
   *
   * Mirrors `command_tooltip()` in `internal_commands/registry.py`, template included --
   * the panel labels a button before the backend ever sees it, and a different
   * wording here would rename every button the moment it was saved. Which is
   * why the template is served by the registry rather than written out again
   * here: a command that changes its wording changes it in one place.
   */
  _internalCommandTooltip(config, fallbackService = "") {
    const cmd = this._internalCommandFor(config, fallbackService);
    if (!cmd) return "";
    // Nothing to point at yet: store the bare command name. A template whose
    // `${_name}` will never fill in cleans away to a dangling "Go to page:".
    if (!this._internalCommandTargetName(config, fallbackService)) return cmd.name;
    const template = cmd.tooltip_template || DEFAULT_COMMAND_TOOLTIP_TEMPLATE;
    // `${_cmd}` is resolved now and `${_name}` deliberately is not. This
    // return value is persisted into `assign.tooltip`, and the page a button
    // points at can be renamed long after the button was stored -- baking the
    // name in here would freeze "Go to page: Android" onto a page since called
    // something else. The command's own wording cannot drift that way, so it
    // is filled in and the user sees words rather than a second placeholder.
    // Exactly how a two-way service stores a bare `${_state}`.
    return this._substituteTooltipTokens(template, {
      _cmd: cmd.name,
      _name: NAME_TOKEN,
    }) || cmd.name;
  },

  /**
   * A page's name in words, "" when its spec yields none.
   *
   * Mirrors `page_title()` in `internal_commands/goto_page.py`, and has to keep mirroring
   * it: the backend resolves a stored name against these words, so a panel that
   * derived different ones would label and warn about the wrong page. See there
   * for why the query string and the scheme are not part of the name.
   */
  _pageTitle(page) {
    let raw = page?.title;
    if (typeof raw !== "string") return "";
    raw = raw.trim();
    if (!raw) return "";

    const SCHEMES = ["text:", "mdi:", "logo:", "phu:", "media:", "history:",
                     "imgserv://", "http://", "https://", "data:"];
    const low = raw.toLowerCase();
    const scheme = SCHEMES.find(s => low.startsWith(s))
      || (customIconSet(raw) ? `${customIconSet(raw)}:` : "");
    let value = raw.slice(scheme.length);

    if (scheme === "imgserv://") return this._pageTitle({ title: value });
    if (scheme === "data:") return "";
    if (scheme === "history:") {
      const id = value.split("?")[0].trim();
      return this._hass?.states?.[id]?.attributes?.friendly_name || id;
    }

    value = value.split("?")[0];
    try { value = decodeURIComponent(value); } catch (e) { /* keep it raw */ }
    value = value.trim();
    if (!value) return "";

    if (scheme === "mdi:" || scheme === "logo:" || scheme === "phu:" || (scheme && !SCHEMES.includes(scheme))) {
      return this._humanisePageSlug(value);
    }
    // A slash the user typed is part of their words ("AC/DC"), not a path.
    if (scheme === "text:") return value;
    // Schemeless is words, as the device draws it, unless it is an HA path.
    if (!scheme && !value.startsWith("/")) return value;
    const EXT = /\.[a-z0-9]{2,4}$/i;

    const segment = this._humanisePageSlug(
      value.replace(/\/+$/, "").split(/[/:]/).pop().replace(EXT, ""),
    );
    const opaque = !segment.includes(" ")
      && (segment.length >= 16 || /^[0-9a-f]{8,}$/i.test(segment));
    return opaque ? "" : segment;
  },

  /** Remote-key words a reader should spell out rather than pronounce. */
  _keyAcronyms: ["ok", "tv", "dvd", "cd", "usb", "hdmi", "av", "pip", "epg",
    "pc", "aux", "fm", "am", "hd", "uhd", "sd", "vod", "3d"],

  /**
   * A button key as words: `button_ok` -> "OK", `button_volume_up` -> "Volume
   * up". Separate from _humanisePageSlug, which names page images and would
   * change what pages are called.
   */
  _humaniseButtonKey(key) {
    const words = String(key || "").replace(/^button_/, "").split(/[_-]+/).filter(Boolean);
    return words.map((w, i) => {
      if (this._keyAcronyms.includes(w.toLowerCase())) return w.toUpperCase();
      return i === 0 ? w.slice(0, 1).toUpperCase() + w.slice(1) : w;
    }).join(" ");
  },

  /** Turn an icon or logo slug into words; `text:` labels are never touched. */
  _humanisePageSlug(value) {
    // A `${…}` variable is code, not words: kept as written.
    return value.split(/(\$\{[^}]*\})/).map((part, i) => (i % 2 ? part
      : part.replace(/[-_+]+/g, " ").split(/\s+/).filter(Boolean)
        .map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ")))
      .filter(Boolean).join(" ");
  },

  /**
   * A page's name, never empty — what the dropdown offers and what a name is
   * resolved against, so a page with no words is named after its id.
   */
  _pageLabel(page) {
    return this._pageTitle(page)
      || (this._t ? this._t("page_fallback", { n: page?.id }) : `Page ${page?.id}`);
  },

  /**
   * Which page this is, as the user sees it shown anywhere a page is named:
   * "Page 3/9 (#24)" -- its place in the run and the id the backend and the
   * debug tools know it by. The title is deliberately left out; it goes on a
   * line of its own (`_pageTitle`), or after a separator where only one line
   * fits (`_pageDisplayLine`). Not for matching: names are resolved by
   * `_pageLabel`.
   */
  _pagePosition(page) {
    const pages = this._pages || [];
    const i = pages.findIndex((p) => String(p?.id) === String(page?.id));
    const t = (key, vars, fallback) => (this._t ? this._t(key, vars) : fallback);
    if (i < 0) return t("page_fallback", { n: page?.id }, `Page ${page?.id}`);
    return t("page_position", { n: i + 1, m: pages.length, id: page?.id },
      `Page ${i + 1}/${pages.length} (#${page?.id})`);
  },

  /**
   * `_pageTitle` for showing: its `${…}` variables filled in as the remote
   * fills them, so a device's own name reads as the name. Not for matching --
   * the backend resolves a stored name against the unexpanded words.
   */
  _pageTitleShown(page) {
    const title = this._pageTitle(page);
    if (!title.includes("${")) return title;
    const filled = this._substituteEntityTokens?.(this._expandPageDevice?.(title, page) ?? title) ?? title;
    return this._cleanTooltipText(filled) || title.replace(/\$\{[^}]*\}/g, "").trim();
  },

  /** `_pagePosition` and the title on one line, for places that have only one
   *  (an HA dropdown option, a toast, a tooltip line). */
  _pageDisplayLine(page) {
    const pos = this._pagePosition(page);
    const title = this._pageTitleShown(page);
    return title ? `${pos} · ${title}` : pos;
  },

  /** Payload keys that carry a button's own identity (what it plays/selects/sends). */
  _payloadIdentityKeys: ["media_content_id", "source", "command", "ir_code", "button"],
  _payloadIdentityExtraKeys: ["payload"],

  /**
   * Flatten a step's `data` into the flat view identity lookups expect.
   *
   * `media_player.play_media` declares a single required `media` field with a media
   * selector, so current HA writes the payload nested (`data.media.media_content_id`)
   * while older configs and other payload services keep those keys flat. Both mean
   * the same thing, so both must resolve to the same identity: nested dicts are
   * merged up one level for *reading* only. Existing top-level keys win; `metadata`
   * is left alone because it describes rather than identifies.
   *
   * Returns a new object — the stored config keeps whatever shape HA expects when
   * the step is executed.
   */
  _normalisePayload(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const skip = new Set(["metadata", "target", "extra"]);
    const flat = { ...data };
    for (const [key, value] of Object.entries(data)) {
      if (skip.has(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (!(nestedKey in flat)) flat[nestedKey] = nestedValue;
      }
    }
    return flat;
  },

  /** Normalised payload of a config's first step. */
  _stepPayload(config) {
    if (!Array.isArray(config) || !config.length) return {};
    return this._normalisePayload(config[0]?.data);
  },

  /**
   * Stable identity string for a payload, "" when it carries none.
   * Lets two buttons of the same service stay distinct instead of collapsing
   * onto one action-library entry.
   */
  _payloadIdentity(data) {
    const flat = this._normalisePayload(data);
    const parts = this._payloadIdentityKeys.map(k => String(flat[k] ?? ""));
    // Appended only when present, as `PAYLOAD_IDENTITY_EXTRA_KEYS` is.
    for (const k of this._payloadIdentityExtraKeys) if (flat[k]) parts.push(String(flat[k]));
    return parts.some(Boolean) ? parts.join("|") : "";
  },

  /** The service of a button's first step, "" when it has none. */
  _stepService(config) {
    if (!Array.isArray(config) || !config.length) return "";
    const step = config[0] || {};
    return step.action || step.service || "";
  },

  /**
   * True when we cannot tell what a button does at all.
   *
   * "At all" is deliberate and narrow: no step AND no resolvable service, from
   * either the button's own config or the action-library entry it points at.
   * That is the dangling-reference case — the button claims an action nobody
   * can name.
   *
   * Everything less than that keeps an honest icon:
   *  - A service with no target is still a known *action*. A service icon says
   *    "this plays media"; it never claims to know *which player*. Targetless
   *    steps also occur in real configs (HA's media browser writes play_media
   *    steps whose target is filled in later).
   *  - A payload service with an empty payload is likewise a known action.
   *
   * What must never happen is borrowing another button's *item* identity —
   * that is `_isBorrowedIdentityIcon`'s job, not this one's.
   */
  _isUnconfiguredStep(config, fallbackService = "") {
    return !(this._stepService(config) || fallbackService);
  },

  /**
   * True when `icon` is artwork identifying one specific media item.
   *
   * Action-library entries are keyed by service, so a `media:`/`http` icon on one
   * is the cover art of whichever button created it — reusing it is how "orf ON"
   * ended up showing "Pizzera und Jaus" artwork. A plain `mdi:` icon carries no
   * item identity and is safe to share.
   */
  _isBorrowedIdentityIcon(icon) {
    if (typeof icon !== "string" || !icon) return false;
    return icon.startsWith("media:") || icon.startsWith("http://")
      || icon.startsWith("https://") || icon.startsWith("/");
  },

  /** Services whose identity lives in the payload, not in the service name. */
  _payloadServices: ["play_media", "select_source", "select_sound_mode", "send_command", "button", "publish"],

  /** True when `service` carries its identity in its payload. */
  _isPayloadService(service) {
    const svc = (service || "").split(".")[1] || "";
    return this._payloadServices.includes(svc);
  },

  /**
   * Derive {title, thumbnail} from a button's own action payload.
   *
   * A button that plays a specific media item / selects a specific source carries
   * its identity in `config[0].data`, not in the shared action-library entry (which
   * is keyed by service name and therefore common to every play_media button).
   *
   * HA's media selector writes `data.metadata.{title,thumbnail}` — that is the
   * primary source. Returns null when the payload carries no identity of its own
   * (plain turn_on, volume_up, …), so callers fall back to the library entry.
   *
   * command is deliberately not a title source: it is a protocol token
   * (DPAD_UP), so it identifies a button without describing it.
   */
  _getPayloadDisplay(config) {
    if (!Array.isArray(config) || !config.length) return null;
    const data = this._stepPayload(config);
    if (!Object.keys(data).length) return null;

    const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : null;
    const title = meta?.title || data.source || this._mediaIdTitle(data.media_content_id);
    const thumbnail = this._mediaThumbUrl(meta?.thumbnail);

    if (!title && !thumbnail) return null;
    return { title: title || "", thumbnail: thumbnail || "" };
  },

  /** True when a segment looks like a machine identifier rather than a title. */
  _isOpaqueId(text) {
    if (text.includes(" ")) return false;
    if (text.length >= 16) return true;
    return /^[0-9a-f]{8,}$/i.test(text);
  },

  /** Humanise a media_content_id into a readable title (last meaningful segment).
   *
   * A pathless web address is refused, mirroring `media_id_title`: its last
   * segment is the host, which names a site rather than the media, and the
   * extension stripper below would take the TLD for a file extension.
   */
  _mediaIdTitle(mediaContentId) {
    if (!mediaContentId || typeof mediaContentId !== "string") return "";
    let val;
    try {
      val = decodeURIComponent(mediaContentId.split("?")[0]);
    } catch (e) {
      val = mediaContentId.split("?")[0];
    }
    val = val.replace(/\/+$/, "");
    if (/^https?:\/\/[^/]+$/i.test(val)) return "";
    // URIs nest their identifier behind both separators (spotify:track:<id>)
    const seg = val.split(/[/:]/).pop() || "";
    if (!seg) return "";
    const cleaned = seg.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[\s_+-]+/g, " ").trim();
    if (!cleaned || cleaned.length > 60 || this._isOpaqueId(cleaned)) return "";
    return cleaned;
  },

  /** Wrap a browse-media thumbnail so imgserv proxies/resizes it for the tile pipeline. */
  _mediaThumbUrl(thumb) {
    if (!thumb || typeof thumb !== "string") return "";
    if (thumb.startsWith("media:")) return thumb;
    if (thumb.startsWith("http") || thumb.startsWith("/")) return `media:${thumb}`;
    return "";
  },

  /** Shown when we genuinely do not know what a button does — never a real default. */
  UNCONFIGURED_ICON: "mdi:help-circle-outline",
  // Not the same statement: "?" reads as "not set up yet", which is misleading
  // for a button that *was* set up and is now broken. Mirrors
  // `BROKEN_TARGET_ICON` in config/const.py.
  BROKEN_TARGET_ICON: "mdi:alert-circle-outline",

  /**
   * Single source of truth for a button's displayed icon.
   *
   * Priority:
   *   1. image the user pinned explicitly
   *   2. thumbnail from the button's own payload
   *   3. image inherited from a template (not user-pinned)
   *   4. action-library icon — only for services whose identity *is* the service
   *   5. service icon / caller-supplied default
   *
   * Two rules keep a button from wearing another button's identity:
   *   - For payload-carrying services (play_media, select_source, …) the library
   *     entry is behaviour-only. Its icon belongs to whichever button happened to
   *     create it, so borrowing it shows the wrong artwork.
   *   - A step the user still has to configure gets a neutral "unconfigured" mark
   *     instead of any default, because we do not yet know the target or action.
   */
  _resolveButtonIcon(assign, action, fallback = "", page = undefined) {
    return this._withButtonDevice(
      this._getTargetEntitiesFromConfig(assign?.config)[0],
      () => this._resolveButtonIconInScope(assign, action, fallback, page),
    );
  },

  /**
   * Run *fn* with `${_device…}` reading *entityId* on a page with no device of
   * its own -- the mirror of `button_scope`.
   */
  _withButtonDevice(entityId, fn) {
    const previous = this._buttonDeviceEntity;
    this._buttonDeviceEntity = entityId || "";
    try {
      return fn();
    } finally {
      this._buttonDeviceEntity = previous;
    }
  },

  _resolveButtonIconInScope(assign, action, fallback = "", page = undefined) {
    const a = assign || {};
    const image = this._resolveImageVariables(a.icon, page);
    if (a.icon_pinned && image) return image;

    const payload = this._getPayloadDisplay(a.config);
    if (payload?.thumbnail) return payload.thumbnail;

    if (image) return image;

    const service = this._stepService(a.config) || action?.service || "";

    // A button that names an action nobody can resolve — not even a service —
    // is genuinely unknown. An *unassigned* slot is not: it keeps the caller's
    // fallback. Anything with a service is describable and falls through.
    // (Narrower than `_isButtonAssigned`: an image-only slot runs nothing.)
    const hasAction = !!(a.action_id || (Array.isArray(a.config) && a.config.length));
    if (hasAction && this._isUnconfiguredStep(a.config, action?.service)) return this.UNCONFIGURED_ICON;

    // A device-local command whose target was never chosen, or has since gone,
    // is disarmed on the device and does nothing when pressed — so it is marked
    // rather than keeping a registry glyph that says it still works. The
    // *broken* marker, not the unknown one: the button is not unfinished.
    // Mirrors `_resolve_button_icon`'s disarmed rung. A deliberately chosen
    // per-button image is honoured above and still wins.
    if (this._internalCommandProblem(a.config, action?.service)) return this.BROKEN_TARGET_ICON;

    // A payload service's library entry is shared, so item artwork on it belongs
    // to whichever button created it. A generic mdi: icon carries no item
    // identity and stays usable — an unconfigured play_media is still honestly
    // "a media play", so it shows a play icon rather than a bare "?".
    const actionIcon = this._resolveImageVariables(action?.icon, page);
    if (actionIcon
        && !(this._isPayloadService(service) && this._isBorrowedIdentityIcon(actionIcon))) {
      return actionIcon;
    }
    if (service) {
      const eid = this._getTargetEntityFromConfig(a.config) || "";
      return this._getServiceIcon(service, eid) || fallback;
    }
    return fallback;
  },

  _computeTooltip(action, entityId, config) {
    // An internal command has no entity to borrow a name from, so it names
    // itself after its target ("Living Room") rather than its service.
    const internalTooltip = this._internalCommandTooltip(config, action?.service);
    if (internalTooltip) return internalTooltip;

    // The button's own payload wins over the shared (service-keyed) library entry:
    // two play_media buttons share one action but play different things.
    const payload = this._getPayloadDisplay(config);
    if (payload?.title) return payload.title;

    // Nothing to describe yet — say so rather than inventing a name.
    if (this._isUnconfiguredStep(config, action?.service)) return "";

    if (!action) return "";
    // Both from the action library. Shared-ness is a property of the library
    // entry, so the payload check below has to ask about `action.service`:
    // with a play_media entry whose step ran light.toggle, the step said
    // "not payload" and the shared name "orf ON" was stored on the button.
    // The button's *own* payload is already handled above, from the config.
    const service = action.service || "";
    const svc = service.split(".")[1] || "";
    const hasSubject = !!(this._getTargetSubjectName(config)
      || this._getTargetStateObj(config) || entityId);
    const lang = this._tooltipLang();

    // A two-way service gets a *template*, not a resolved state. The caller
    // persists this string into `assign.tooltip`, so returning "Lampe Aus" here
    // would freeze whatever the entity happened to be doing when the button
    // was configured. The state is resolved per render, on the device side.
    if (hasSubject && this._isStateTooltipService(svc)) return STATE_TOOLTIP;

    // An explicit action name is only *this* button's name when the service has no
    // payload. For play_media & friends the library entry is shared, so its name
    // describes whichever button created it — never borrow it.
    if (action.name && !this._isPayloadService(service)) {
      return action.name;
    }

    // Never fall back to a bare entity name here. This return value is written
    // straight into `assign.tooltip`, so "Wohnzimmer" would replace a real button
    // name ("Home") with one that says nothing about what the button does —
    // and the original is then gone from storage. Returning "" leaves the
    // stored name alone.
    if (!svc) return "";

    return this._serviceRef(svc);
  },

  /** Services that flip an entity but cannot say which way by themselves. */
  _isTwoWayService(svc) {
    return TWO_WAY_SERVICES.includes(svc);
  },

  /** Mirrors `attribute_cycle_for` in const.py. The one attribute gate. */
  _attributeCycleFor(svc) {
    const attribute = this._serviceToAttribute(svc);
    return (attribute ? ATTR_ACTION_MAP[attribute] : null) || null;
  },

  /** Mirrors `is_attribute_state_service`: what it changes is an attribute. */
  _isAttributeStateService(svc) {
    return this._attributeCycleFor(svc) !== null;
  },

  /**
   * Mirrors `is_state_tooltip_service` in const.py: does this button's label
   * have to move with the entity?
   *
   * Deliberately *not* `_isTwoWayService`, which is also the predicate for the
   * `nextState` rung of `_stateTokenTooltip` -- a rung keyed by `state.state`,
   * which says nothing about an attribute. Widening that one would make a
   * `shuffle_set` button on an `on` entity read "Off".
   */
  _isStateTooltipService(svc) {
    return this._isTwoWayService(svc) || this._isAttributeStateService(svc);
  },

  /** Resolve `${TOKEN}` placeholders for *display only* — never for storage. */
  _substituteTooltipTokens(text, values) {
    if (!text) return text;
    // `{translate: …}` is the backend's, in the remote's language -- and words,
    // so it is filled in before anything below could strip its braces.
    if (!this._isMediaSource(text) && text.includes("{translate:")) {
      text = this._substituteEntityTokens?.(text) ?? text;
    }
    if (!text.includes("${")) return text;
    text = this._expandPageDevice?.(text) ?? text;
    const lookup = {};
    for (const [k, v] of Object.entries(values)) lookup[k.toLowerCase()] = v;
    // Ahead of everything, where the remote's `expand_queue_alias` runs: a
    // dotted token looks like an entity variable, so the entity pass would
    // look `_queue.next_song` up as an entity and strip it.
    if (text.toLowerCase().includes("_queue.")) {
      text = text.replace(
        /\$\{\s*(_queue\.[A-Za-z0-9_]+)\s*\}/gi,
        (_, name) => lookup[name.toLowerCase()] ?? "",
      );
    }
    // A picture keeps its entity variables for the picture rules (see
    // `_resolveTooltip`); only the button's own words are filled in.
    if (this._isMediaSource(text)) {
      return text.replace(/\$\{\s*(\w*)\s*\}/g, (_, name) => lookup[name.toLowerCase()] ?? "");
    }
    // Entity variables are the backend's (lizaip-variables.js); ${_state} and
    // friends are filled in below.
    if (this._hasEntityToken?.(text)) text = this._substituteEntityTokens(text);
    // `\w*`, not `\w+`: `${}` and `${ }` must be consumed too, or a brace
    // survives into the rendered label.
    let out = text.replace(/\$\{\s*(\w*)\s*\}/g, (_, name) => lookup[name.toLowerCase()] ?? "");
    // `{translate: ${_state}}` waited for its value; the backend looks it up now.
    if (out.includes("{translate:")) out = this._substituteEntityTokens?.(out) ?? out;
    // A token that collapsed can leave a separator joining nothing ("Go to
    // page:"). Trimmed here rather than in `_cleanTooltipText`, which sees the
    // text after this and cannot tell it from a colon the user typed.
    return out.replace(/^[\s:;,/\-–—]+|[\s:;,/\-–—]+$/g, "").split(/\s+/).filter(Boolean).join(" ");
  },

  /** Mirrors `state_word`: lowercase, unless the language's `state_words` says otherwise. */
  _stateWord(key, lang) {
    return this._stateWords?.[key] || this._getButtonTooltip(key, lang).toLowerCase();
  },

  /** Mirrors `state_label`: the label word when it opens a label, else the sentence word. */
  _stateLabel(key, lang, opensLabel) {
    return opensLabel ? this._getButtonTooltip(key, lang) : this._stateWord(key, lang);
  },

  /** Mirrors `state_token_tooltip`: the word a label made of the state placeholder prints. */
  _stateTokenTooltip(svc, stateVal, lang, attributes, data) {
    const key = this._stateTokenKey(svc, stateVal, attributes, data);
    return key ? this._stateLabel(key, lang, true) : "";
  },

  /** Mirrors `translate_state`: each state placeholder as the word for *key*. */
  _translateState(text, key, lang) {
    if (!text || !text.includes("${")) return text;
    return text.replace(STATE_PLACEHOLDER_RE, (_m, offset) => (
      // No key: left for the token pass, which also drops the separator it joined.
      key ? this._stateLabel(key, lang, LEADING_SEPARATORS_RE.test(text.slice(0, offset))) : "${_state}"
    ));
  },

  /** Name the state a press produces — the service decides before the entity. */
  _stateTokenKey(svc, stateVal, attributes, data) {
    // Mirrors `state_token_key` in shared/tooltips.py, rung for rung. The two attribute
    // rungs sit above the service map because a setter (`volume_mute`) does not
    // name its own direction: the answer is in a cycle press's data or in the
    // attribute it inverts, never in `state.state` — a muted speaker is still
    // `playing`. `attrAction` is the allowlist for both, so the value setters
    // (`select_source`, `set_hvac_mode`, …) cannot start printing raw HA values.
    // `repeat`'s cycle is HA's own, from `src/data/media-player.ts`:
    // off → all → one → off. `swing_mode` is deliberately absent — climate
    // defines five swing values, so no static two-value cycle is correct.
    const attribute = this._serviceToAttribute(svc);
    const cycle = this._attributeCycleFor(svc);
    if (cycle) {
      if (data && data[attribute] !== undefined) {
        const target = ATTR_VALUE_ACTION_MAP[attribute]?.[this._attrStr(data[attribute])];
        if (target) return target;
      }
      if (attributes && attributes[attribute] !== undefined) {
        const nextKey = cycle[this._attrStr(attributes[attribute])];
        if (nextKey) return nextKey;
      }
    }
    const serviceAction = SERVICE_ACTION_MAP[svc];
    if (serviceAction) return serviceAction;
    if (this._isTwoWayService(svc) && stateVal && NEXT_STATE_MAP[stateVal]) {
      return NEXT_STATE_MAP[stateVal];
    }
    return "";
  },

  /** Mirrors `attr_str` in const.py: HA bools are keyed as "true" / "false". */
  _attrStr(value) {
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value ?? "");
  },

  /** Mirrors `service_to_attribute` in const.py. */
  _serviceToAttribute(svc) {
    if (ATTR_IRREGULARS[svc]) return ATTR_IRREGULARS[svc];
    let m = /^set_(.+)$/.exec(svc);
    if (m) return m[1];
    m = /^(.+)_set$/.exec(svc);
    if (m) return m[1];
    m = /^select_(.+)$/.exec(svc);
    if (m) return m[1];
    return null;
  },

  /**
   * What the remote will actually print for a stored label.
   *
   * Read-only: this must never be written back to `assign.tooltip`, or the
   * template collapses into a frozen state on the next save.
   */
  _displayTooltip(name, action, entityId, config, assign = null, press = false) {
    return this._withButtonDevice(
      entityId || this._getTargetEntitiesFromConfig(config)[0],
      () => this._displayTooltipInScope(name, action, entityId, config, assign, press),
    );
  },

  _displayTooltipInScope(name, action, entityId, config, assign = null, press = false) {
    // Unlike its Python counterpart this is a display path in its own right,
    // so it cleans on the way out too rather than only via `_resolveTooltip`.
    if (!name || !name.includes("${")) return this._displayName(name);
    // The action library's service, not the first step's. `_fill_tooltip_tokens`
    // in device_sync.py reads `action_def["service"]`, and this has to answer
    // what the remote will print. Where the two differ -- a library entry of
    // light.toggle whose step runs light.turn_on -- step-first said "On" while
    // the device said "Off".
    const svc = ((action?.service || "").split(".")[1]) || "";
    // The target's state, not one member's: `${_state}` has to resolve to what
    // the label says, and a room whose first lamp is unavailable collapsed the
    // token while the label itself read "On". `_fill_tooltip_tokens` in
    // device_sync.py reads the same pair.
    const stateObj = this._getTargetStateObj(config)
      || (entityId && this._hass?.states?.[entityId]) || null;
    const stateVal = stateObj?.state || "";
    const attributes = stateObj?.attributes || null;
    // The first step's own service data, matching `_fill_tooltip_tokens`. Read
    // for a cycle, which runs every face verbatim, and so names the direction
    // it stores; a plain action toggles the attribute instead.
    const step = Array.isArray(config) && config[0] && typeof config[0] === "object" ? config[0] : {};
    const data = step.data || {};
    const asPress = press || assign?.toggle?.mode === "cycle";
    const stateKey = this._stateTokenKey(svc, stateVal, attributes, asPress ? data : null);
    name = this._translateState(name, stateKey, this._tooltipLang());
    const values = {
      _state: stateKey,
      // `${_queue.…}` aliases the target's queue sensor, which only the remote
      // can resolve. Blank rather than absent, for the separator reason above.
      "_queue.next_song": "",
      "_queue.next_artist": "",
      "_queue.prev_song": "",
      "_queue.prev_artist": "",
    };
    // `${_name}` belongs to device-local commands and nobody else. The key is
    // only added when the button carries one, so on a plain HA action the
    // token stays unknown and collapses -- rather than resolving to a blank
    // that reads as supported. Mirrors `_fill_tooltip_tokens` in device_sync.py,
    // which keys off the step's service for the same reason.
    if (this._internalCommandFor(config, action?.service)) {
      values._name = this._internalCommandTargetName(
        config, action?.service, this._internalTargetHint(assign),
      );
    }
    return this._cleanTooltipText(this._substituteTooltipTokens(name, values));
  },

  /**
   * Is this stored label the auto-filled library name rather than the user's
   * own words? Lives here so the card and its tests read the same rule instead
   * of each carrying a copy.
   *
   * Trimmed on both sides, as the tooltip ladder is: a stored "Toggle " is
   * still the library's name, and compared raw it drew the field as a
   * user-typed label the remote would never print.
   */
  _tooltipIsAutoFilled(stored, action, autoTooltip, assign = null) {
    if (!stored) return false;
    // A name the user typed is never auto-filled, whatever it happens to equal.
    // Without this the field would offer the derived `${_state}` back to someone
    // who had just replaced it, and the ladder — which honours the edit —
    // would print something the field never showed.
    if (assign?.tooltip_edited) return false;
    if (stored.trim() !== (action?.name || "").trim()) return false;
    if (this._isTokenOnlyTooltip(autoTooltip)) return true;
    // A payload service's library entry is shared, so a name copied from it
    // belongs to whichever item created it: the button's own item names it.
    // Mirrors `_tooltip_is_auto_filled` in button_rendering.py.
    return !!autoTooltip && this._isPayloadService(action?.service || "")
      && autoTooltip === this._getPayloadDisplay(assign?.config)?.title;
  },

  /**
   * Does this text contain a `${_state}` placeholder specifically? The hint
   * under the field names that one token, so a label holding some other token
   * shape (`${NOPE}`, `${}`) must not trigger it — nothing would be replaced.
   * Whitespace and case are tolerated, matching `_substituteTooltipTokens`.
   */
  _tooltipHasStateToken(text) {
    return !!text && /\$\{\s*_state\s*\}/i.test(text);
  },

  /**
   * Does this text name a track? `${_device.media_title}` or
   * `${_device.media_artist}`, with the same tolerance for case and inner
   * whitespace as `_substituteTooltipTokens`, and the same reason as
   * `_tooltipHasStateToken`: the hint under the field names these two, so some
   * other token shape must not claim their lesson.
   */
  _tooltipHasMediaToken(text) {
    return !!text && /\$\{[^{}]*(?<![\w.])_device\.media_(title|artist)\b/i.test(text);
  },

  /**
   * Does *config* point at a media player? Read off the resolved target rather
   * than the first step's raw `entity_id`, so an area or a label target answers
   * the same way the tooltip preview does — `_getTargetStateObj` is what reads
   * the track in the first place.
   */
  _targetsMediaPlayer(config) {
    const stateObj = this._getTargetStateObj(config);
    return String(stateObj?.entity_id || "").startsWith("media_player.");
  },

  /**
   * Does *config* point at a player whose queue can be read?
   *
   * The gate for `${_queue.…}`: the integration keeps a queue sensor
   * (`sensor.<speaker>_queue`, see `config/media_queue/alias.py`) for exactly those
   * speakers, so its existence is the answer -- no list of integrations to
   * keep in step here.
   */
  _targetsQueue(config) {
    if (!this._targetsMediaPlayer(config)) return false;
    const eid = this._getTargetStateObj(config)?.entity_id || "";
    return !!this._hass?.states?.[`sensor.${eid.split(".").slice(1).join(".")}_queue`];
  },

  /**
   * The label tokens worth offering on *config*, for `_wireMediaInput`.
   *
   * Gated, not a fixed list: a token that cannot say anything on this button
   * would complete into text that silently collapses, which teaches the wrong
   * thing about a feature most people meet through this list. `${_queue.…}`
   * only off a player whose queue can be read, `${_name}` only on a
   * device-local command, `${_state}` wherever there is a service whose press
   * has a state to name.
   *
   * The notes are translated here because this is the mixin; `matchTooltipTokens`
   * stays a pure filter over what it is handed.
   */
  _tooltipTokenOptions(config, fallbackService = "") {
    const svc = this._stepService?.(config) || fallbackService;
    const tokens = [];
    if (svc) tokens.push({ id: "_state", name: this._t("token_state_note") });
    // Nothing is pushed for the playing track: `${_device.media_title}` is an
    // ordinary variable the `_device` completion already offers after its dot,
    // and the dotted list below is for the values no entity carries.
    if (this._targetsQueue(config)) {
      tokens.push({ id: "_queue.next_song", name: this._t("token_queue_next_song_note") });
      tokens.push({ id: "_queue.next_artist", name: this._t("token_queue_next_artist_note") });
      tokens.push({ id: "_queue.prev_song", name: this._t("token_queue_prev_song_note") });
      tokens.push({ id: "_queue.prev_artist", name: this._t("token_queue_prev_artist_note") });
    }
    if (this._internalCommandFor(config, fallbackService)) {
      tokens.push({ id: "_name", name: this._t("token_name_note") });
    }
    return { tokens };
  },

  /**
   * The title image the remote draws for *page*, trimmed. Entity variables
   * read as they do there; one with no value leaves the strip blank, exactly
   * as `device_sync` sends it.
   */
  _resolvedPageTitle(page) {
    return String(this._resolveImageVariables(this._expandPageDevice(page?.title, page)) || "").trim();
  },

  /**
   * *text* with `${_device…}` read as *page* has it (by default the page being
   * edited), as `device_sync` does before anything else. `${_device.attr}` is
   * the page's entity under another name, so it becomes that entity's
   * variable; `${_device}` is the device's name, which holds no variable of its
   * own. A page with no template has no device, so both read as nothing.
   *
   * What only the device knows — `${_device.model}`, where it stands, what it
   * is called — is read first and answers on every page, a hub's included.
   */
  _expandPageDevice(text, page = this._pages?.[this._currentPageIdx]) {
    if (typeof text !== "string" || !/\$\{[^{}]*(?<![\w.])_device\b/.test(text)) return text;
    // A plain page has no device of its own: the button being drawn stands in,
    // as `button_scope` has it on the remote.
    const own = this._buttonDeviceEntity;
    if (!page?.template?.target && own) {
      const device = this._hass?.entities?.[own]?.device_id;
      page = { ...(page || {}), template: { target: { entity_id: own, ...(device ? { device } : {}) } } };
    }
    const entity = page?.template?.target?.entity_id || "";
    if (page?.template?.target) {
      const facts = this._pageDeviceFacts(page);
      text = text.replace(deviceFactTokenRe(), (_whole, fact) => facts[fact] ?? "");
    }
    // Inside a calculation as well: `${_device.volume_level * 100}`.
    let out = text.replace(/\$\{([^{}]*)\}/g, (whole, body) => {
      if (!/(?<![\w.])_device\.[A-Za-z0-9_]/.test(body)) return whole;
      if (!entity) return "";
      return `\${${body.replace(/(?<![\w.])_device\.([A-Za-z0-9_]+)/g, (_, attr) => deviceAttribute(entity, attr)).trim()}}`;
    });
    if (/\$\{\s*_device\s*\}/.test(out)) {
      const name = this._templateDeviceName(page) || "";
      out = out.replace(/\$\{\s*_device\s*\}/g, () => name);
    }
    return out.trim();
  },

  /** The `device` option for a picker or input on *page*: `{}` off a template page. */
  _pageDeviceOption(page = this._pages?.[this._currentPageIdx]) {
    if (!page?.template?.type && !page?.template?.target?.device) return {};
    return {
      device: {
        entity: page.template.target?.entity_id || "",
        name: this._templateDeviceName(page) || "",
        facts: this._pageDeviceFacts(page),
      },
    };
  },

  /**
   * What each `${_device.fact}` says on *page*, for the suggestion list to
   * show beside it. Mirrors `_device_fact_token` and `COMPUTED_FACTS`: the
   * facts below are worked out, and every other one is read straight off the
   * device entry.
   */
  _pageDeviceFacts(page = this._pages?.[this._currentPageIdx]) {
    const device = this._templateTargetDevice(page);
    const computed = {
      friendly_name: () => this._templateDeviceName(page) || "",
      area_name: () => this._templateAreaName(page),
      label_names: () => this._templateLabelNames(page),
    };
    const facts = {};
    for (const fact of DEVICE_FACTS) {
      facts[fact] = computed[fact] ? computed[fact]() : String(device?.[fact] ?? "");
    }
    return facts;
  },

  /**
   * The device registry entry a template page is bound to, null when none.
   * Mirrors `template_target_device`: a hub page names a config entry rather
   * than a device, and the device of that entry is the one behind nothing
   * else — the bridge, not the lamps it speaks for. An entry with several
   * such devices is answered by none unless one is what the others sit behind.
   */
  _templateTargetDevice(page) {
    const target = page?.template?.target || {};
    const devices = this._hass?.devices || {};
    if (target.device) return devices[target.device] || null;
    if (!target.config_entry) return null;
    // Both spellings: a device registry entry carries the set it belongs to as
    // `config_entries`, and the one it came from as `primary_config_entry`.
    const ofEntry = (d) => (d.config_entries || []).includes(target.config_entry)
      || d.primary_config_entry === target.config_entry;
    const entries = Object.entries(devices).filter(([, d]) => d && ofEntry(d));
    const roots = entries.filter(([, d]) => d.via_device_id == null);
    if (roots.length === 1) return roots[0][1];
    const behind = new Set(entries.map(([, d]) => d.via_device_id));
    const hubs = roots.filter(([id, d]) => behind.has(d.id ?? id));
    return hubs.length === 1 ? hubs[0][1] : null;
  },

  /**
   * The title of the config entry a hub page is bound to; "" when there is
   * none, and "" while it is still being fetched — the fetch renders again.
   */
  _templateEntryTitle(page) {
    const id = page?.template?.target?.config_entry;
    if (!id) return "";
    const titles = (this._templateEntryTitles ||= {});
    if (!(id in titles)) {
      titles[id] = null;
      Promise.resolve(this._hass?.callWS?.({ type: "config_entries/get_single", entry_id: id }))
        .then((r) => { titles[id] = r?.config_entry?.title || ""; })
        .catch(() => { titles[id] = ""; })
        .then(() => this._render?.());
    }
    return titles[id] || "";
  },

  /** The friendly name of the entity a page is bound to; "" when it has none. */
  _templateEntityName(page) {
    const ent = page?.template?.target?.entity_id;
    return (ent && this._hass?.states?.[ent]?.attributes?.friendly_name) || "";
  },

  /**
   * What `${_device}` says on *page*; "" when it is bound to nothing.
   * Mirrors `template_target_name`: the device's own name, the user's rename
   * first — an entry title only when there is no bridge to ask, and the
   * entity's own name only when it has no device, as a YAML light has none.
   */
  _templateDeviceName(page) {
    const bound = this._templateTargetDevice(page);
    return bound?.name_by_user || bound?.name
      || this._templateEntryTitle(page)
      || this._templateEntityName(page);
  },

  /**
   * What `${_device.area_name}` says on *page*; "" when nothing is filed.
   * Mirrors `_template_area_name`: the entity's own room wins, because an
   * entity may be filed away from its device and one set up in YAML has no
   * device to inherit from at all.
   */
  _templateAreaName(page) {
    const ent = page?.template?.target?.entity_id;
    const areaId = (ent && this._hass?.entities?.[ent]?.area_id)
      || this._templateTargetDevice(page)?.area_id
      || null;
    const area = areaId ? this._hass?.areas?.[areaId] : null;
    return area?.name || "";
  },

  /**
   * What `${_device.label_names}` says on *page*; "" when nothing is stuck on
   * it. Mirrors `_label_names`: the entity's own labels before its device's,
   * the rule the room already follows, and sorted because a set has no order
   * and the page would otherwise reshuffle itself across a restart.
   *
   * `_subjectRegistry` is where the label names already live: `hass` carries
   * every registry but that one, so `_loadLabels` primes it at startup and
   * the names are there to be read rather than fetched again here.
   */
  _templateLabelNames(page) {
    const ent = page?.template?.target?.entity_id;
    let ids = (ent && this._hass?.entities?.[ent]?.labels) || null;
    if (!ids?.length) ids = this._templateTargetDevice(page)?.labels || null;
    if (!ids?.length) return "";
    const registry = this._subjectRegistry("label") || {};
    const names = ids.map((id) => registry[id]?.name || "").filter(Boolean);
    return names.sort().join(", ");
  },

  /** The same test for `${_name}`, which only device-local commands resolve. */
  _tooltipHasNameToken(text) {
    return !!text && /\$\{\s*_name\s*\}/i.test(text);
  },

  /** True when a label is nothing but placeholders. Mirrors `is_token_only_tooltip`. */
  _isTokenOnlyTooltip(text) {
    if (!text || !text.includes("${")) return false;
    // Leftover braces are wreckage and a separator between two placeholders
    // is shape, not a name: "${_state} - ${_device.media_title}" is as unnamed
    // as "${_state}". The dotted tokens count as placeholders too.
    return !text
      .replace(/\$\{\s*(\w*)\s*\}/g, "")
      .replace(/\$\{\s*(?:_queue|_device)\.[A-Za-z0-9_]+\s*\}/gi, "")
      .replace(/\{\s*translate\s*:/gi, "")
      .replace(/[{}]/g, "")
      .replace(/[\s:;,/\-–—]+/g, "")
      .trim();
  },

  /**
   * Services that leave no state worth reflecting. Mirrors `is_stateless_service`.
   *
   * The single definition. A second copy lived in lizaip-states.js and was
   * permanently dead: `lizaip-panel.js` merges HelpersMixin then
   * StatesMixin onto the prototype, so the later copy silently won every call —
   * which is why `select_source` had to be added to *that* list to take effect
   * while the one here already had it and did nothing.
   */
  _statelessServices: [
    "media_next_track", "media_previous_track", "media_seek",
    "play_media", "clear_playlist", "join", "unjoin",
    "volume_up", "volume_down",
    "send_command", "learn_command",
    "select_source",
  ],

  _isStatelessService(svc) {
    return this._statelessServices.includes(svc) || /^(browse|send|clear)_/.test(svc);
  },

  /** Services that flip an entity between two states. Mirrors `TOGGLE_SERVICES`. */
  _stateToggleServices: [
    "turn_on", "turn_off", "toggle",
    "open_cover", "close_cover", "stop_cover",
    "lock", "unlock",
    "media_play", "media_pause", "media_stop", "media_play_pause",
  ],

  /**
   * The exact string the remote will print for a button — the panel's mirror of
   * `_resolve_button_tooltip` in `config/device_sync.py`.
   *
   * `_computeTooltip` answers a different question: what to *store* when filling a
   * label in for the user. The two were being used interchangeably, so the panel
   * showed a name the remote never printed. An Android TV `Home` button is a case
   * in point: the template stores `Home` and the remote prints it, but
   * `_computeTooltip` — which cannot see the stored name and rightly refuses to
   * borrow a payload service's shared library name — offered `Send Command`.
   *
   * Display only. `tests/label_parity_cases.json` pins this against the Python.
   */
  _resolveTooltip(action, entityId, config, storedName = "", assign = null) {
    const out = this._cleanTooltipText(
      this._resolveTooltipLadder(action, entityId, config, storedName, assign)
    );
    // A tooltip naming a picture goes through the same steps as a button's
    // image and a page's title, as `finish_tooltip` does for the remote.
    return out && this._isMediaSource(out) ? (this._resolveImageVariables(out) ?? "") : out;
  },

  /**
   * What to call this button out loud: the same words the remote prints on it.
   *
   * Naming it from `assign.tooltip` read the stored text verbatim, so a screen
   * reader spoke the placeholder — "dollar sign, left brace, STATE".
   */
  _buttonSpokenLabel(assign) {
    if (!assign || !this._resolveTooltip) return "";
    const action = assign.action_id
      ? (this._actions || []).find(a => a.id === assign.action_id)
      : null;
    const entityId = (assign.config && this._getTargetEntityFromConfig)
      ? this._getTargetEntityFromConfig(assign.config)
      : null;
    const resolved = this._resolveTooltip(action, entityId, assign.config, assign.tooltip || "", assign);
    // A label that resolves to nothing leaves the caller to fall back to the
    // key, which names the button at least as well as an empty string does.
    return resolved || "";
  },

  /**
   * Mirrors `clean_tooltip_text`. The panel claims to show what the remote will
   * print, so it has to drop the same wreckage the device does: a stored name
   * of `Schreibtisch ${STATE` reads `Schreibtisch` there but was still reading
   * `Schreibtisch ${STATE` here.
   *
   * `\w*\}?` is bounded to a token-shaped run rather than running to the next
   * brace, which would eat the rest of the label and turn "Vor ${STATE nach"
   * into "Vor".
   */
  _cleanTooltipText(text) {
    // A picture is finished by the picture rules, not tidied as words.
    if (!text || this._isMediaSource(text)) return text;
    let out = text;
    const hadToken = out.includes("${");
    // A whole unfilled variable goes first, calculation and all, as in
    // `_WHOLE_TOKEN_RE`; otherwise only "${floor" would be stripped.
    if (hadToken) out = out.replace(/\$\{[^{}$]*\}/g, "").replace(/\$\{\s*[\w.]*\s*\}?/g, "");
    // Anything still holding a brace cannot be parsed as a URL by the device.
    if (out.includes("{") || out.includes("}")) out = out.replace(/[{}]/g, "");
    // A separator left joining nothing once a placeholder resolved away --
    // "Go to page:" on a goto whose page was deleted. Mirrors
    // `_DANGLING_SEPARATOR_RE`, and is likewise gated on the label having held
    // a placeholder, so a name the user ended in a colon is left alone.
    if (hadToken) out = out.replace(/^[\s:;,/\-–—]+|[\s:;,/\-–—]+$/g, "");
    return out.split(/\s+/).filter(Boolean).join(" ");
  },

  _resolveTooltipLadder(action, entityId, config, storedName = "", assign = null) {
    // Both from the action library, as the Python ladder is: `service` decides
    // payload-ness, and taking it from the step misclassified a button whose
    // step service differs from its library entry's.
    const service = action?.service || "";
    const svc = service.split(".")[1] || "";
    const lang = this._tooltipLang();

    const stored = (storedName || "").trim();
    // A stored label is printed as it reads, its placeholders filled -- empty
    // included: `${_device.media_title_prev}` with nothing before it reads as
    // nothing, not as a derived "Previous". It is what the Tooltip field shows,
    // and the preview beside the field must say what the field says. The one
    // exception is the field's own: a stored name standing in for `${_state}`,
    // which the field replaces by `${_state}` too (`_tooltipIsAutoFilled`).
    if (stored && !this._tooltipIsAutoFilled(stored, action, this._computeTooltip(action, entityId, config), assign)) {
      return this._displayTooltip(stored, action, entityId, config, assign);
    }
    const payload = this._getPayloadDisplay(config);
    if (payload?.title) return payload.title;

    const staticName = this._displayName(
      stored || (this._isPayloadService(service) ? "" : (action?.name || "")),
    );
    if (!svc) return staticName;

    const stateObj = this._getTargetStateObj(config)
      || (entityId && this._hass?.states?.[entityId]);
    const stateVal = stateObj?.state || "";

    // An unrenamed attribute button announces its next action, exactly as an
    // unrenamed toggle announces its next state below. Mirrors the rung of the
    // same name in `button_rendering._resolve_button_tooltip_ladder`; without it
    // the panel would print `${_state}` while the device printed a frozen "Mute".
    if (this._isAttributeStateService(svc)) {
      const attrTooltip = this._displayTooltip(STATE_TOOLTIP, action, entityId, config);
      if (attrTooltip) return attrTooltip;
    }

    if (this._stateToggleServices.includes(svc) && stateVal && NEXT_STATE_MAP[stateVal]) {
      return this._stateLabel(NEXT_STATE_MAP[stateVal], lang, true);
    }

    if (this._isStatelessService(svc) && staticName) return staticName;

    const label = this._friendlySvc(svc, lang);
    if (label) return label;

    // Nothing the button does has a word: an empty button stays empty.
    return staticName;
  },

  /**
   * The word for an action key, from the integration's own translations.
   *
   * `_buttonTooltips` is filled by `_loadButtonTooltips` from
   * `lizaip_config/get_button_tooltips`, which serves the `button_tooltips` section
   * of `translations/<lang>.json` -- the same file `get_button_tooltip` in
   * `const.py` reads. The panel used to carry a hardcoded copy of the table;
   * two copies of a wording is a drift nobody sees, because no screen shows the
   * panel's label and the device's label together.
   *
   * The fallback is the same shape as Python's: an unknown key title-cases into
   * something readable rather than rendering blank. That also covers the window
   * before the load resolves, and a panel opened while the backend is down.
   */
  _getButtonTooltip(key, lang) {
    const label = this._buttonTooltips?.[key];
    if (label) return label;
    return String(key ?? "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  },

  /** A stored name as it reads: words as written, `{translate: …}` translated. */
  _displayName(name) {
    return this._cleanTooltipText(this._substituteTooltipTokens(name, {}));
  },

  /** Mirrors `ButtonTooltips.service_ref`: what a button stores to name *svc*. */
  _serviceRef(svc) {
    if (SERVICE_ACTION_MAP[svc]) return `{translate: ${SERVICE_ACTION_MAP[svc]}}`;
    return this._friendlySvc(svc, "en");
  },

  _friendlySvc(svc, lang) {
    if (SERVICE_ACTION_MAP[svc]) return this._getButtonTooltip(SERVICE_ACTION_MAP[svc], lang);
    let name = svc;
    for (const prefix of ["media_", "set_"]) {
      if (name.startsWith(prefix)) { name = name.slice(prefix.length); break; }
    }
    return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  },

  // The language to *display* in: the one the backend resolved for this device
  // (it may be pinned to Italian), falling back to the browser's.
  _tooltipLang() {
    return this._buttonTooltipsLang || this._hass?.language || "en";
  },

  // The language the panel *asks* in: this browser's, and nothing else.
  // Not `_tooltipLang`, which is the backend's answer — sending that back would
  // rank one device's pinned language as the next device's browser default.
  _uiLanguage() {
    return this._hass?.language || "en";
  },

  _localizeState(state, entityId, attribute) {
    if (!this._hass?.localize || !state) return state;
    const domain = entityId ? entityId.split(".")[0] : "";
    if (domain) {
      if (attribute) {
        const attrKey = `component.${domain}.entity_component._.state_attributes.${attribute}.state.${state}`;
        const attrTranslated = this._hass.localize(attrKey);
        if (attrTranslated) return attrTranslated;
      }
      const domainKey = `component.${domain}.entity_component._.state.${state}`;
      const translated = this._hass.localize(domainKey);
      if (translated) return translated;
    }
    const defaultKey = `state.default.${state}`;
    const translated = this._hass.localize(defaultKey);
    return translated || state;
  },

  /** Open a modal and return it with its close function: Home Assistant's
   *  own `ha-dialog` -- its scrim, surface, sizing, animation and focus trap
   *  -- holding the caller's content, which brings its own heading. A native
   *  <dialog> stands in only while HA has not loaded `ha-dialog` (or in a
   *  test without it): the focus trap, Escape, inertness, role and focus
   *  return come from the platform either way. The caller supplies the name.
   *
   *  `onClose` is called once, on every way out -- the returned function,
   *  Escape, the scrim, and being pushed aside by the next modal. A caller
   *  that owns state behind the dialog should tear it down here rather than
   *  on the element's own close event, which a re-render also fires.
   *
   *  `role: "alertdialog"` makes it an alert dialog, HA's kind for a
   *  confirmation: it stays a dialog on a phone. `canClose` guards closing
   *  (a window covered by a file chooser); Escape and the scrim ask it. */
  _openModal(innerHtml, {
    labelledBy = "", describedBy = "", role = "", onClose = null, canClose = null,
  } = {}) {
    const sr = this.shadowRoot;
    // One at a time: these dialogs open each other.
    const stale = sr.querySelector(".add-page-overlay");
    if (stale) {
      const owner = stale._onOverlayClose;
      stale._onOverlayClose = null;
      if (stale.open && stale.close) stale.close();
      stale.remove();
      owner?.();
    }

    const ha = !!globalThis.customElements?.get?.("ha-dialog");
    const dlg = document.createElement(ha ? "ha-dialog" : "dialog");
    dlg.className = "add-page-overlay";
    if (labelledBy) dlg.setAttribute("aria-labelledby", labelledBy);
    // Without this a reader announces the dialog's name and its focused
    // control and nothing else, so the body text -- which is the whole point
    // of a confirmation -- was never spoken.
    if (describedBy) dlg.setAttribute("aria-describedby", describedBy);
    if (ha) {
      // The caller's content carries the heading, so HA's header row (title
      // and close button) is left out rather than drawn empty.
      dlg.setAttribute("without-header", "");
      if (role === "alertdialog") dlg.setAttribute("type", "alert");
      if (canClose) dlg.setAttribute("prevent-scrim-close", "");
    } else if (role) {
      dlg.setAttribute("role", role);
    }
    dlg.innerHTML = innerHtml;
    if (ha && labelledBy) {
      // ha-dialog's <dialog> sits in its own shadow root, where an IDREF into
      // this content cannot reach; it takes its name as text instead.
      const heading = dlg.querySelector(`#${globalThis.CSS?.escape?.(labelledBy) ?? labelledBy}`);
      if (heading) dlg.accessibleLabel = heading.textContent.replace(/\s+/g, " ").trim();
    }

    dlg._onOverlayClose = onClose;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const owner = dlg._onOverlayClose;
      dlg._onOverlayClose = null;
      dlg.remove();
      owner?.();
    };
    const close = () => {
      if (ha && dlg.isConnected && dlg.open) {
        // Closed the way HA closes one, animation and focus return included;
        // `closed` then tears it down like any other way out.
        dlg.open = false;
        return;
      }
      // `close()` before `remove()`: removing the node drops it from the top
      // layer without firing `close`, and the focus the browser was holding
      // for the opener goes with it.
      if (!ha && dlg.open) dlg.close();
      finish();
    };

    if (ha) {
      // Every way out ends here: Escape, the scrim, a [data-dialog="close"]
      // button, and `close` above. Not while `_render` is putting it back.
      dlg.addEventListener("closed", () => {
        if (!dlg._lizaReopening) finish();
      });
      if (canClose) {
        // Guarded: `prevent-scrim-close` holds Escape back, and this lets it
        // through once the guard says so. Capture, ahead of ha-dialog's own
        // handler, which stops the key going further.
        dlg.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && canClose()) close();
        }, true);
      }
      // The control the caller focused, or marked `autofocus`, keeps the
      // focus: the dialog's own show moves it to the surface once its
      // animation has run. A focus asked for before then does not take at all
      // (the inner <dialog> is not open yet), hence the attribute.
      let chosen = null;
      dlg.addEventListener("focusin", (e) => { if (!chosen) chosen = e.composedPath?.()[0] || e.target; });
      dlg.addEventListener("after-show", () => {
        const target = chosen?.isConnected && dlg.contains(chosen)
          ? chosen : dlg.querySelector("[autofocus]");
        if (target) this._focusWhenReady(target);
      });
      sr.appendChild(dlg);
      dlg.open = true;
      return { dlg, close };
    }

    // Escape. Prevented so the browser does not close it underneath us and
    // skip the teardown.
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      if (canClose && !canClose()) return;
      close();
    });
    // Click outside the card. The dialog element fills the viewport and
    // centres the card inside it, so anything that lands on the dialog itself
    // was a click on the scrim.
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg) return;
      if (canClose && !canClose()) return;
      close();
    });

    sr.appendChild(dlg);
    dlg.showModal();
    return { dlg, close };
  },

  /** Focus a control that may still be drawing. Home Assistant's elements
   *  forward `focus()` to a native node their first render creates, so one
   *  focused in the tick its markup was parsed throws on a null.
   *
   *  The throw is the point: from a promise executor it rejected the whole
   *  dialog, which is how a page delete came to open its confirmation and
   *  then do nothing at all. */
  _focusWhenReady(el) {
    if (typeof el?.focus !== "function") return;
    const put = () => { try { el.focus(); } catch { /* gone with the next render */ } };
    const tag = el.localName || "";
    const upgraded = !tag.includes("-") || !!customElements?.get?.(tag);
    Promise.resolve(upgraded ? null : customElements.whenDefined(tag))
      .then(() => el.updateComplete)
      .then(put, put);
  },

  /** WCAG 3.3.4: confirm a destructive action. Built on `_openModal`, so the
   *  focus trap, Escape and focus-return are the platform's. The confirm
   *  button takes initial focus, so a deletion started from the keyboard
   *  (the Delete key on a page) is confirmed with Enter; Escape still
   *  cancels, and every path that is not Confirm resolves false. */
  _confirmDestructive({ title, subtitle = "", message, confirmText }) {
    return new Promise((resolve) => {
      // The subtitle is part of the heading (it names what the title asks
      // about), so it sits inside the labelled element and is read with it.
      const subtitleHtml = subtitle
        ? `<span class="confirm-dialog-subtitle">${this._esc(subtitle)}</span>`
        : "";
      let settled = false;
      const settle = (answer) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      };
      const { dlg, close } = this._openModal(`
        <div class="add-page-dialog confirm-dialog" role="document">
          <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._esc(title)}${subtitleHtml}</h2>
          <p class="confirm-dialog-message" id="liza-dlg-message">${this._esc(message)}</p>
          ${this._htmlDialogActions({
            dismiss: { cls: "confirm-cancel-btn", label: this._t("cancel") },
            danger: { cls: "confirm-danger-btn", label: confirmText, attrs: "autofocus" },
          })}
        </div>
      `, {
        labelledBy: "liza-dlg-title", describedBy: "liza-dlg-message", role: "alertdialog",
        // Every way out runs this: the buttons below, Escape, the scrim, and
        // being displaced by the next modal. Anything that is not an explicit
        // confirm is a no.
        //
        // Not the dialog's `close` event, which browsers fire from a queued
        // task: a re-render re-appends the dialog with `close(); showModal()`,
        // so the event answered the question while it was still on screen.
        onClose: () => settle(false),
      });

      dlg.querySelector(".confirm-cancel-btn")?.addEventListener("click", () => { settle(false); close(); });
      dlg.querySelector(".confirm-danger-btn")?.addEventListener("click", () => { settle(true); close(); });
      // Left/Right move between the two buttons, as Tab does. Not wrapped:
      // the arrow points at the button it moves to. They are ha-button now,
      // so the pair is named by class rather than by tag.
      const buttons = [...dlg.querySelectorAll(
        ".template-dialog-actions .confirm-cancel-btn, .template-dialog-actions .confirm-danger-btn")];
      dlg.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const at = buttons.indexOf(e.target);
        if (at < 0) return;
        const next = buttons[at + (e.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        e.preventDefault();
        next.focus();
      });
      this._focusWhenReady(dlg.querySelector(".confirm-danger-btn"));
    });
  },

  _toast(msg) {
    // Home Assistant's own toast, the one every other part of HA shows: it
    // is drawn at the bottom of the app and announced to screen readers.
    if (this.isConnected && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(new CustomEvent("hass-notification", {
        detail: { message: String(msg) }, bubbles: true, composed: true,
      }));
      return;
    }
    // Not attached to Home Assistant's page: the panel's own toast.
    let t = this.shadowRoot?.querySelector(".toast");
    let fresh = false;
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      this.shadowRoot.appendChild(t);
      fresh = true;
    }
    // Announced, not just shown; `polite` because these are successful
    // outcomes. Set on every path, not only where the element is created --
    // the device-config view ships its own `.toast` in its template.
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    // A live region only reports changes made after it is observed, so one
    // filled in the tick it was appended announces nothing.
    const show = () => {
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2500);
    };
    if (fresh) requestAnimationFrame(show); else show();
  },
};
