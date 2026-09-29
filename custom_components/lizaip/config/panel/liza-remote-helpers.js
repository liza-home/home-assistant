/**
 * lizaIP Panel — Helper Utilities
 * Icon resolution, label computation, rendering helpers.
 */

/**
 * Percent-encode a URL into a single `media:` path segment.
 *
 * imgserv splits the request path on the first `:` and reads its own options
 * (`size`, `fg`, …) from the query string, so a URL carrying `?token=…` has to be
 * encoded or it loses everything after the `?`. Mirrors `encode_media_source()` in
 * `const.py`, and is idempotent so an already-encoded value is left alone.
 *
 * The already-encoded test ignores hex case: `encodeURIComponent` emits uppercase
 * escapes, so a hand-written `%2f` would otherwise be re-encoded to `%252f` and
 * survive the server's single unquote still escaped.
 */
export function mediaSource(url) {
  const val = String(url ?? "").trim();
  let alreadyEncoded = false;
  try {
    alreadyEncoded = encodeURIComponent(decodeURIComponent(val)).toLowerCase() === val.toLowerCase();
  } catch (e) {
    alreadyEncoded = false;
  }
  return `media:${alreadyEncoded ? val : encodeURIComponent(val)}`;
}

/** True for URLs the device cannot fetch itself — these go through imgserv's media: proxy. */
export function isExternalUrl(val) {
  const low = String(val ?? "").trim().toLowerCase();
  return low.startsWith("http://") || low.startsWith("https://");
}

/**
 * The spelling the panel writes into a label it fills in for the user, and the
 * services that get one. Mirrors `STATE_TOKEN` / `is_two_way_service` in
 * `const.py`; `tests/label_auto_cases.json` pins the two together.
 */
export const STATE_TOKEN = "${STATE}";
export const TWO_WAY_SERVICES = ["toggle", "media_play_pause"];

/**
 * The target of a device-local command, named in the user's label. Mirrors
 * `NAME_TOKEN` in `const.py`. Only offered on a button carrying such a
 * command: a plain HA action has no target apart from its entity, so the
 * token resolves to nothing there and collapses away like any unknown one.
 */
export const NAME_TOKEN = "${NAME}";

/**
 * The wording used when the backend serves a command without a template — an
 * older backend, or one mid-upgrade. Mirrors the `label_template` default on
 * `InternalCommand`; the served value always wins.
 */
export const DEFAULT_COMMAND_LABEL_TEMPLATE = "${COMMAND}: ${NAME}";

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

/** attribute -> the value a press *sets* -> the action naming that set. */
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
export const ABSENT_STATES = ["unavailable", "unknown"];
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
export function asIdList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

/**
 * True when a number field holds text the browser could not parse. Browsers
 * blank `.value` in that case, so only `validity.badInput` reports it; the
 * NaN test stays for DOM shims that keep the raw text instead.
 */
export function badNumber(el) {
  if (!el || el.type !== "number") return false;
  if (el.validity?.badInput) return true;
  const raw = (el.value || "").trim();
  return !!raw && !Number.isFinite(Number(raw));
}

/**
 * The first id out of a target field, mirroring `first_id()` in
 * `action_controller/helpers.py`. `[]` and `""` both collapse to `null`, which
 * matters because `[]` is truthy in JS and would swallow a fallback.
 */
export function firstId(value) {
  return asIdList(value)[0] || null;
}

const FIELD_ERR_ID_PREFIX = "liza-field-err-";
let fieldErrUid = 0;

/** The field's own error element. A `children` scan, not `:scope > …`, which
 *  is unsupported inside a shadow root and so matched nothing here. */
const findFieldError = (host) =>
  Array.prototype.find.call(host.children, (n) => n.classList?.contains("field-error")) || null;

export const HelpersMixin = {
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

  /** Mixin access to {@link isExternalUrl} for call sites that only have `this`. */
  _isExternalUrl(val) {
    return isExternalUrl(val);
  },

  /** Mixin access to {@link mediaSource} for call sites that only have `this`. */
  _mediaSource(url) {
    return mediaSource(url);
  },

  /**
   * The `<img>` src `_renderIconHtml` uses for an image-ish value.
   *
   * External URLs are routed through imgserv's `media:` proxy; HA-relative paths and
   * `data:` URIs are used verbatim. Kept separate so refresh paths can compare against
   * the src that would be rendered instead of the raw config value.
   */
  _iconImgSrc(val, size = 20) {
    if (this._isExternalUrl(val)) {
      return this._imgservUrl(this._mediaSource(val), size, this._getThemeMode());
    }
    return val;
  },

  /**
   * A page `default_color` as a CSS colour.
   *
   * Colours are stored the way imgserv wants them in a `fg=` query parameter —
   * bare hex, no leading `#` — so CSS needs the `#` put back. A non-hex value is
   * passed through as a colour keyword. Anything else returns "" rather than
   * being interpolated into a style attribute.
   *
   * Only the lengths CSS actually accepts count as hex — 3, 4, 6 or 8 digits.
   * `update_page` takes `default_color` as a bare `str` with no validation, so a
   * 5- or 7-digit value can reach here, and `#12345` would be a declaration the
   * browser silently drops.
   */
  _cssColor(color) {
    const raw = String(color ?? "").trim().replace(/^#/, "");
    if (!raw) return "";
    if (/^(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(raw)) return `#${raw}`;
    return /^[A-Za-z]+$/.test(raw) ? raw : "";
  },

  /**
   * @param {string} val   Icon source spec (`mdi:`, `text:`, a URL, …).
   * @param {number} size  Rendered size in px.
   * @param {string} color Page `default_color`, or "" to leave the icon untinted.
   *
   * `color` is applied at render time, mirroring the grid's rule in _refreshSVG,
   * so a preview cannot disagree with the tile the device draws.
   */
  // `size` is handed to imgserv verbatim, so it may be a number, a `WxH` pair or
  // a named size such as `title`; `box` is the space the preview occupies on
  // screen and defaults to the square a numeric size implies. The two are
  // separate because a title is not square: asking for `size=28` would have
  // imgserv pick the mark that suits a square, which is precisely the mark the
  // device will not draw there.
  _renderIconHtml(val, size = 20, color = "", box = null) {
    const boxW = box?.w ?? size;
    const boxH = box?.h ?? size;
    // Normalise once, like resolve_icon_url's icon.strip(): a value pasted with a
    // trailing space or newline must still match the startsWith branches below, or
    // the preview disagrees with what the device renders.
    val = String(val ?? "").trim();
    if (!val) return `<ha-icon icon="mdi:radiobox-blank" style="--mdc-icon-size:${boxH}px"></ha-icon>`;

    // Only monochrome sources take a tint; a logo or a photo must keep its own
    // colours. A value carrying its own fg= has been coloured deliberately.
    const tintable = !!color && !val.includes("fg=") && (
      val.startsWith("mdi:") || val.startsWith("text:") || val.startsWith("phu:") || !val.includes(":")
    );

    // logo:, text:, file:, media: are imgserv-only source types — not valid HA icon names.
    // phu: and mdi: with embedded params (e.g. phu:sonos?fg=green) also need imgserv.
    const needsImgserv = val.startsWith("logo:") || val.startsWith("text:") || val.startsWith("file:") ||
      val.startsWith("media:") ||
      (val.includes("?") && (val.startsWith("mdi:") || val.startsWith("phu:")));

    // External images go through imgserv so the preview matches what the device renders
    // (same proxy, same resize); HA-relative paths and data: URIs load directly.
    // _isExternalUrl is tested first because it also lowercases, so it catches an
    // `HTTPS://` paste that _isImageUrl's case-sensitive startsWith would miss.
    let src;
    if (this._isExternalUrl(val) || this._isImageUrl(val)) {
      src = this._iconImgSrc(val, size);
    } else if (needsImgserv) {
      src = this._imgservUrl(val, size, this._getThemeMode()) + (tintable ? `&fg=${encodeURIComponent(color)}` : "");
    } else {
      // Tinted via CSS, not imgserv: keeps the vector instead of resampling.
      const css = tintable ? this._cssColor(color) : "";
      const colorStyle = css ? `;color:${css}` : "";
      return `<ha-icon icon="${this._esc(val)}" style="--mdc-icon-size:${boxH}px${colorStyle}"></ha-icon>`;
    }
    return `<img src="${this._esc(src)}" alt="" style="width:${boxW}px;height:${boxH}px;object-fit:contain;border-radius:4px" />`;
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
  _configImagePreviewHtml(imageVal, autoIcon, color = "", shape = null) {
    // Stored and derived are drawn identically on purpose. Which one a button
    // has is an implementation detail -- a layout button looks preselected only
    // because generate_assignments copied its YAML icon into `image` -- so
    // fading the derived one would invent a distinction the user cannot act on,
    // and disagree with the picker, which shows it at full strength.
    //
    // `shape` overrides the square a button gets. It exists for the page title,
    // whose slot on the device is 4:1, and it carries both halves of that --
    // what to ask imgserv for and how much room to give the answer -- because a
    // wide box holding an image requested as a square would letterbox the very
    // difference it was widened to show.
    const icon = imageVal || autoIcon;
    const size = shape?.size ?? 28;
    const glyph = shape?.box?.h ?? 28;
    if (icon) return this._renderIconHtml(icon, size, color, shape?.box ?? null);
    return `<span class="cch-preview-empty"><ha-icon icon="mdi:image-off-outline" style="--mdc-icon-size:${glyph}px;"></ha-icon></span>`;
  },

  /**
   * One icon field, everywhere one is offered.
   *
   * There were five of these — the page title, the slider, a button's Image,
   * the per-state rows under Button icons, and the action editor's state list —
   * and they had drifted into five different gestures for the same decision. Two
   * carried an Icon/URL toggle revealing one of a pair of inputs; one hid its
   * picker behind a ✎ and offered a ✕ beside it; one drew its own empty
   * placeholder; the sizes of the previews disagreed. The question each asked is
   * identical: *which picture goes here*. So they ask it identically now.
   *
   * The toggles went first and took the most code with them. `ha-icon-picker`
   * accepts a custom value, so a URL, a `logo:` or a `text:` label can be typed
   * straight into it — every URL box on this panel was a second input guarding
   * what the first could already do, and every mode button was bookkeeping for
   * that box. Clearing the picker is what ✕ was for, so ✕ went too, and with the
   * editor no longer hidden the ✎ had nothing left to reveal.
   *
   * `slotAttrs` rather than a second id parameter because the state rows are a
   * list: they are found by `data-state`, not by an id that would repeat.
   * `label` is escaped here because one caller passes a state name, which comes
   * from the entity and is not ours; `hint` is not, because every caller passes
   * translated panel text and one of them embeds markup in it.
   */
  _htmlIconField({ label, value = "", autoIcon = "", color = "", shape = null,
                   previewClass = "", slotId = "", slotAttrs = "", hint = "" }) {
    const preview = this._configImagePreviewHtml(value, autoIcon, color, shape);
    return `
        <div class="config-field">
          <label>${this._esc(label)}</label>
          <div class="icon-picker-row">
            <div class="icon-preview${previewClass ? ` ${previewClass}` : ""}">${preview}</div>
            <div class="icon-picker-slot"${slotId ? ` id="${slotId}"` : ""}${slotAttrs ? ` ${slotAttrs}` : ""} data-label="${this._esc(label)}"></div>
          </div>${hint ? `
          <span class="config-field-hint">${hint}</span>` : ""}
        </div>`;
  },

  /**
   * Mount the picker `_htmlIconField` left room for.
   *
   * Assigning `value` is display only: `ha-icon-picker` fires `value-changed`
   * on user input, never on assignment, so preselecting a *derived* icon shows
   * the user what the device will draw without writing it down as a choice they
   * made. That distinction is the whole reason the field can show a stand-in at
   * full strength and still mean "nothing stored here".
   *
   * `stopPropagation` because the event would otherwise reach the panel's own
   * listeners as though a different control had changed.
   */
  _mountIconPicker(slot, value, onChange) {
    if (!slot) return null;
    const picker = document.createElement("ha-icon-picker");
    picker.hass = this._hass;
    // The field's <label> cannot reach the <input> inside the picker's shadow
    // root -- `for` does not cross that boundary and neither does aria-label --
    // so without this the control the user actually focuses has no name at all
    // and is announced as a bare edit field. `label` is HA's own API for it.
    //
    // Read off the slot rather than walked up to: the same name the <label>
    // was rendered from is put there by _htmlIconField, so the two cannot
    // drift, and the mount does not need a live tree to find it.
    const name = (slot.dataset?.label || "").trim();
    if (name) picker.label = name;
    // Nothing on the picker says which field it is -- no id, class or data --
    // so after a render there was no selector to find it by and focus left the
    // card for the page instead of coming back here.
    const key = slot.id || name;
    if (key && picker.dataset) picker.dataset.a11yPicker = key;
    picker.value = value || "";
    picker.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      onChange(ev.detail.value || "");
    });
    slot.appendChild(picker);
    return picker;
  },

  /** Build a safe /api/imgserv URL, correctly joining params when `icon` already contains `?`.
   *
   * Always requests `alpha=1` — this is the config panel (browser preview), which
   * composites the PNG over its own background and needs true transparency.
   * The device itself gets flattened RGB by default (no `alpha` param).
   */
  _imgservUrl(icon, size, mode) {
    icon = String(icon ?? "").trim();
    // A raw media: value is a URL of its own — encode it so its query string does
    // not collide with imgserv's.
    if (icon.startsWith("media:")) icon = this._mediaSource(icon.slice(6));
    const sep = icon.includes("?") ? "&" : "?";
    const modeStr = mode ? `&mode=${mode}` : "";
    return `/api/imgserv/${icon}${sep}size=${size}${modeStr}&alpha=1`;
  },

  /** Tint applied to previews of the page being edited; "" when none is set. */
  _currentPageColor() {
    return this._pages?.[this._currentPageIdx]?.default_color || "";
  },

  // `color` is the page's default_color. It is applied under exactly the rule the
  // device uses (_refreshSVG): only monochrome sources take a tint, and a title
  // carrying its own fg= was coloured deliberately, so it wins.
  _renderPageIconPreview(icon, height = 20, color = "") {
    icon = String(icon ?? "").trim();
    if (!icon) return "";
    let src;
    const mode = this._getThemeMode();
    const tintable = !!color && !icon.includes("fg=") && /^(mdi:|phu:|text:)/.test(icon);
    const fg = tintable ? `&fg=${encodeURIComponent(color)}` : "";
    if (icon.startsWith("mdi:") || icon.startsWith("text:") || icon.startsWith("logo:") || icon.startsWith("phu:") || icon.startsWith("file:") || icon.startsWith("media:")) {
      src = this._imgservUrl(icon, "title", mode) + fg;
    } else if (icon.startsWith("imgserv://")) {
      src = `/api/imgserv/${icon.slice(10)}${icon.includes("?") ? "&" : "?"}alpha=1`;
    } else if (this._isExternalUrl(icon)) {
      src = this._imgservUrl(this._mediaSource(icon), "title", mode);
    } else if (this._isImageUrl(icon)) {
      src = icon;
    } else {
      // A bare word is rendered as text, so it is tintable like an explicit text:.
      // Encoded because it lands in the URL path: a title with a space or a `?`
      // would otherwise malform the request or graft on query structure of its
      // own. Matches the slider's identical construction in _refreshSVG.
      const bareFg = color && !icon.includes("fg=") ? `&fg=${encodeURIComponent(color)}` : "";
      src = `/api/imgserv/text:${encodeURIComponent(icon)}?size=title&mode=${mode}&alpha=1${bareFg}`;
    }
    return `<img src="${this._esc(src)}" alt="" style="height:${height}px;object-fit:contain;border-radius:2px" />`;
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
    // icon_defaults.yaml wins over HA's service registry, so both surfaces agree.
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
    if (action.icon) return action.icon;
    if (action.states && action.states.length > 0) {
      const withIcon = action.states.find(s => s.icon);
      if (withIcon) return withIcon.icon;
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
   * Uses `_friendlySvc` -- the same vocabulary the device prints and the
   * shipped layouts use ("Previous", "Play/Pause", "Next", "Mute") -- rather
   * than a mechanical verb + domain transform. This name is stored on the
   * library entry and flows straight into the button label, so the transform
   * reached the device as "play:5 Media play media_player" (and, worse,
   * "play:5 Open cover cover") sitting beside neighbours that said
   * "play:5 Next". A one-way service like `media_play` has no `${STATE}` to
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
    return this._friendlySvc(action, this._labelLang()) || service;
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
   * The stored value of the first target param holding text — the panel's
   * mirror of `_stored_target_name` in `internal_commands/registry.py`.
   *
   * Type-agnostic on purpose, and text-only for the same reason the Python is:
   * this is the floor every command gets, so a new one targeting something
   * that is not a page still names itself from what the user picked, with no
   * change here. A type that can do better than the raw stored value — turning
   * a page id into that page's title — says so in the branch above.
   */
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
   * value of `${NAME}`, both in the auto label and in one the user typed, so
   * a hand-written "Go to ${NAME}" cannot name a different page than the
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
   * Mirrors `command_label()` in `internal_commands/registry.py`, template included --
   * the panel labels a button before the backend ever sees it, and a different
   * wording here would rename every button the moment it was saved. Which is
   * why the template is served by the registry rather than written out again
   * here: a command that changes its wording changes it in one place.
   */
  _internalCommandLabel(config, fallbackService = "") {
    const cmd = this._internalCommandFor(config, fallbackService);
    if (!cmd) return "";
    // Nothing to point at yet: store the bare command name. A template whose
    // `${NAME}` will never fill in cleans away to a dangling "Go to page:".
    if (!this._internalCommandTargetName(config, fallbackService)) return cmd.name;
    const template = cmd.label_template || DEFAULT_COMMAND_LABEL_TEMPLATE;
    // `${COMMAND}` is resolved now and `${NAME}` deliberately is not. This
    // return value is persisted into `assign.label`, and the page a button
    // points at can be renamed long after the button was stored -- baking the
    // name in here would freeze "Go to page: Android" onto a page since called
    // something else. The command's own wording cannot drift that way, so it
    // is filled in and the user sees words rather than a second placeholder.
    // Exactly how a two-way service stores a bare `${STATE}`.
    return this._substituteLabelTokens(template, {
      command: cmd.name,
      name: NAME_TOKEN,
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
    let raw = page?.image;
    if (typeof raw !== "string") return "";
    raw = raw.trim();
    if (!raw) return "";

    const SCHEMES = ["text:", "mdi:", "logo:", "phu:", "file:", "media:",
                     "imgserv://", "http://", "https://", "data:"];
    const low = raw.toLowerCase();
    const scheme = SCHEMES.find(s => low.startsWith(s)) || "";
    let value = raw.slice(scheme.length);

    if (scheme === "imgserv://") return this._pageTitle({ image: value });
    if (scheme === "data:") return "";

    value = value.split("?")[0];
    try { value = decodeURIComponent(value); } catch (e) { /* keep it raw */ }
    value = value.trim();
    if (!value) return "";

    if (scheme === "mdi:" || scheme === "logo:" || scheme === "phu:") {
      return this._humanisePageSlug(value);
    }
    // A slash the user typed is part of their words ("AC/DC"), not a path.
    if (scheme === "text:") return value;
    const EXT = /\.[a-z0-9]{2,4}$/i;
    if (!scheme && !value.startsWith("/") && !EXT.test(value)) return value;

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
    return value.replace(/[-_+]+/g, " ").trim().split(/\s+/)
      .map(w => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ");
  },

  /**
   * A page's name, never empty — what the dropdown offers and what a name is
   * resolved against, so a page with no words is named after its id.
   */
  _pageLabel(page) {
    return this._pageTitle(page)
      || (this._t ? this._t("page_fallback", { n: page?.id }) : `Page ${page?.id}`);
  },

  /** Payload keys that carry a button's own identity (what it plays/selects/sends). */
  _payloadIdentityKeys: ["media_content_id", "source", "command", "ir_code"],

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
  _payloadServices: ["play_media", "select_source", "select_sound_mode", "send_command"],

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
   *   3. image inherited from a layout (not user-pinned)
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
  _resolveButtonIcon(assign, action, fallback = "") {
    const a = assign || {};
    if (a.image_pinned && a.image) return a.image;

    const payload = this._getPayloadDisplay(a.config);
    if (payload?.thumbnail) return payload.thumbnail;

    if (a.image) return a.image;

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
    if (action?.icon
        && !(this._isPayloadService(service) && this._isBorrowedIdentityIcon(action.icon))) {
      return action.icon;
    }
    if (service) {
      const eid = this._getTargetEntityFromConfig(a.config) || "";
      return this._getServiceIcon(service, eid) || fallback;
    }
    return fallback;
  },

  _computeLabel(action, entityId, config) {
    // An internal command has no entity to borrow a name from, so it names
    // itself after its target ("Living Room") rather than its service.
    const internalLabel = this._internalCommandLabel(config, action?.service);
    if (internalLabel) return internalLabel;

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
    const subject = this._getTargetSubjectName(config);
    const stateObj = this._getTargetStateObj(config)
      || (entityId && this._hass?.states?.[entityId]);
    const titled = (eid) =>
      eid.split(".")[1]?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || "";
    const entityName = subject
      || (stateObj ? stateObj.attributes?.friendly_name || titled(stateObj.entity_id) : "")
      || (entityId ? titled(entityId) : "");
    const lang = this._labelLang();

    // A two-way service gets a *template*, not a resolved state. The caller
    // persists this string into `assign.label`, so returning "Lampe Aus" here
    // would freeze whatever the entity happened to be doing when the button
    // was configured. `${STATE}` is resolved per render, on the device side.
    // The bare template, without the entity name: the device puts the entity in
    // front of it, exactly as it does for a short static name like "Next", so
    // the stored labels on a page stay the same shape as each other.
    if (entityName && this._isStateLabelledService(svc)) return STATE_TOKEN;

    // An explicit action name is only *this* button's name when the service has no
    // payload. For play_media & friends the library entry is shared, so its name
    // describes whichever button created it — never borrow it.
    if (action.name && !this._isPayloadService(service)) {
      return entityName ? `${entityName} ${action.name}` : action.name;
    }

    // Never fall back to a bare entity name here. This return value is written
    // straight into `assign.label`, so "Wohnzimmer" would replace a real button
    // name ("Home") with one that says nothing about what the button does —
    // and the original is then gone from storage. Returning "" leaves the
    // stored name alone.
    if (!svc) return "";

    const label = this._friendlySvc(svc, lang);
    if (label) return entityName ? `${entityName} ${label}` : label;

    return "";
  },

  /** Services that flip an entity but cannot say which way by themselves. */
  _isTwoWayService(svc) {
    return TWO_WAY_SERVICES.includes(svc);
  },

  /**
   * Did a dynamic source, rather than the user, write this button's name?
   * Mirrors `name_is_source_owned` in const.py.
   *
   * The label ladder returns a stored name verbatim because a name the user
   * typed must never be overwritten by a derived one. A name a source wrote is
   * not that: it names the button's *subject* — a lamp, a favorite — which the
   * state belongs next to. Asking the binding is what tells the two apart; the
   * ladder used to guess with `stored !== action.name`, and on a page of
   * toggles that share one library entry the guess is right for exactly one
   * button.
   */
  _nameIsSourceOwned(assign) {
    const fields = assign?.dynamic?.fields;
    return Array.isArray(fields) && fields.includes("label");
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
   * Mirrors `is_state_labelled_service` in const.py: does this button's label
   * have to move with the entity?
   *
   * Deliberately *not* `_isTwoWayService`, which is also the predicate for the
   * `nextState` rung of `_stateTokenLabel` -- a rung keyed by `state.state`,
   * which says nothing about an attribute. Widening that one would make a
   * `shuffle_set` button on an `on` entity read "Off".
   */
  _isStateLabelledService(svc) {
    return this._isTwoWayService(svc) || this._isAttributeStateService(svc);
  },

  /** Resolve `${TOKEN}` placeholders for *display only* — never for storage. */
  _substituteLabelTokens(text, values) {
    if (!text || !text.includes("${")) return text;
    const lookup = {};
    for (const [k, v] of Object.entries(values)) lookup[k.toLowerCase()] = v;
    // `\w*`, not `\w+`: `${}` and `${ }` must be consumed too, or a brace
    // survives into the rendered label.
    const out = text.replace(/\$\{\s*(\w*)\s*\}/g, (_, name) => lookup[name.toLowerCase()] ?? "");
    // A token that collapsed can leave a separator joining nothing ("Go to
    // page:"). Trimmed here rather than in `_cleanLabelText`, which sees the
    // text after this and cannot tell it from a colon the user typed.
    return out.replace(/^[\s:;,/\-–—]+|[\s:;,/\-–—]+$/g, "").split(/\s+/).filter(Boolean).join(" ");
  },

  /** Name the state a press produces — the service decides before the entity. */
  _stateTokenLabel(svc, stateVal, lang, attributes, data) {
    // Mirrors `state_token_label` in const.py, rung for rung. The two attribute
    // rungs sit above the service map because a setter (`volume_mute`) does not
    // name its own direction: the answer is in the button's data or in the
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
        // A template (`{{ not is_state_attr(...) }}`) is not a value of the
        // attribute, so it misses here and falls to the rung below — which is
        // where an inverting button belongs.
        const target = ATTR_VALUE_ACTION_MAP[attribute]?.[this._attrStr(data[attribute])];
        if (target) return this._getActionLabel(target, lang);
      }
      if (attributes && attributes[attribute] !== undefined) {
        const nextKey = cycle[this._attrStr(attributes[attribute])];
        if (nextKey) return this._getActionLabel(nextKey, lang);
      }
    }
    const serviceAction = SERVICE_ACTION_MAP[svc];
    if (serviceAction) return this._getActionLabel(serviceAction, lang);
    if (this._isTwoWayService(svc) && stateVal && NEXT_STATE_MAP[stateVal]) {
      return this._getActionLabel(NEXT_STATE_MAP[stateVal], lang);
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
   * Read-only: this must never be written back to `assign.label`, or the
   * template collapses into a frozen state on the next save.
   */
  _displayLabel(name, action, entityId, config, assign = null) {
    // Unlike its Python counterpart this is a display path in its own right,
    // so it cleans on the way out too rather than only via `_resolveLabel`.
    if (!name || !name.includes("${")) {
      return this._cleanLabelText(
        this._localizePrefixedName(name, action, entityId, config, assign),
      );
    }
    // The action library's service, not the first step's. `_fill_label_tokens`
    // in device_sync.py reads `action_def["service"]`, and this has to answer
    // what the remote will print. Where the two differ -- a library entry of
    // light.toggle whose step runs light.turn_on -- step-first said "On" while
    // the device said "Off".
    const svc = ((action?.service || "").split(".")[1]) || "";
    // The target's state, not one member's: `${STATE}` has to resolve to what
    // the label says, and a room whose first lamp is unavailable collapsed the
    // token while the label itself read "On". `_fill_label_tokens` in
    // device_sync.py reads the same pair.
    const stateObj = this._getTargetStateObj(config)
      || (entityId && this._hass?.states?.[entityId]) || null;
    const stateVal = stateObj?.state || "";
    const attributes = stateObj?.attributes || null;
    // The first step's own service data, matching `_fill_label_tokens`, which
    // reads `assign["config"][0]["data"]`.
    const step = Array.isArray(config) && config[0] && typeof config[0] === "object" ? config[0] : {};
    const data = step.data || {};
    const lang = this._labelLang();
    const values = {
      state: this._stateTokenLabel(svc, stateVal, lang, attributes, data),
    };
    // `${NAME}` belongs to device-local commands and nobody else. The key is
    // only added when the button carries one, so on a plain HA action the
    // token stays unknown and collapses -- rather than resolving to a blank
    // that reads as supported. Mirrors `_fill_label_tokens` in device_sync.py,
    // which keys off the step's service for the same reason.
    if (this._internalCommandFor(config, action?.service)) {
      values.name = this._internalCommandTargetName(
        config, action?.service, this._internalTargetHint(assign),
      );
    }
    return this._cleanLabelText(this._substituteLabelTokens(name, values));
  },

  /**
   * The text the device puts in *front* of a stored label.
   *
   * The layouts ship short names ("Power", "Home", "Next") and the remote
   * prepends the entity live, so the panel's input alone read "Power" where
   * the remote read "Wohnzimmer Power". Rather than baking the entity into
   * storage -- which would go stale the moment the button is pointed at
   * another entity -- the panel draws this in front of the field, so the two
   * read the same without the stored value moving.
   *
   * Derived by subtraction rather than by re-deriving the ladder, so it cannot
   * drift from `_resolveLabel`: whatever the remote adds is the prefix.
   */
  _labelPrefix(action, entityId, config, shownText, assign = null) {
    const device = this._resolveLabel(action, entityId, config, shownText || "", assign);
    if (!device) return "";
    const literal = this._displayLabel(shownText || "", action, entityId, config);
    if (!literal) return device;
    return device.endsWith(` ${literal}`) ? device.slice(0, -(literal.length + 1)) : "";
  },

  /**
   * Is this stored label the auto-filled library name rather than the user's
   * own words? Lives here so the card and its tests read the same rule instead
   * of each carrying a copy.
   *
   * Trimmed on both sides, as the tooltip ladder is: a stored "Toggle " is
   * still the library's name, and compared raw it drew the field as a
   * user-typed label the remote would never print.
   *
   * A name a dynamic source wrote is auto-filled too, whatever it says. Twelve
   * lamps on a Hue bridge share one library entry, so the name comparison holds
   * for exactly one of them — and only that one was offered the `${STATE}` the
   * other eleven equally deserve.
   */
  _labelIsAutoFilled(stored, action, autoLabel, assign = null) {
    if (!stored || !this._isTokenOnlyLabel(autoLabel)) return false;
    // A name the user typed is never auto-filled, whatever it happens to equal.
    // Without this the field would offer the derived `${STATE}` back to someone
    // who had just replaced it, and the ladder — which honours the edit —
    // would print something the field never showed.
    if (assign?.label_edited) return false;
    if (this._nameIsSourceOwned(assign)) return true;
    return stored.trim() === (action?.name || "").trim();
  },

  /**
   * Does this text contain a `${STATE}` placeholder specifically? The hint
   * under the field names that one token, so a label holding some other token
   * shape (`${NOPE}`, `${}`) must not trigger it — nothing would be replaced.
   * Whitespace and case are tolerated, matching `_substituteLabelTokens`.
   */
  _labelHasStateToken(text) {
    return !!text && /\$\{\s*state\s*\}/i.test(text);
  },

  /** The same test for `${NAME}`, which only device-local commands resolve. */
  _labelHasNameToken(text) {
    return !!text && /\$\{\s*name\s*\}/i.test(text);
  },

  /** True when a label is nothing but placeholders. Mirrors `is_token_only_label`. */
  _isTokenOnlyLabel(text) {
    if (!text || !text.includes("${")) return false;
    // Leftover braces are wreckage, not words. Mirrors the Python.
    return !text.replace(/\$\{\s*(\w*)\s*\}/g, "").replace(/[{}]/g, "").trim();
  },

  /**
   * Services that leave no state worth reflecting. Mirrors `is_stateless_service`.
   *
   * The single definition. A second copy lived in liza-remote-states.js and was
   * permanently dead: `liza-remote-panel.js` merges HelpersMixin then
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
   * `_computeLabel` answers a different question: what to *store* when filling a
   * label in for the user. The two were being used interchangeably, so the panel
   * showed a name the remote never printed. An Android TV `Home` button is a case
   * in point: the layout stores `Home`, the remote prints `Wohnzimmer Home`, but
   * `_computeLabel` — which cannot see the stored name and rightly refuses to
   * borrow a payload service's shared library name — offered `Wohnzimmer Send
   * Command`.
   *
   * Display only. `tests/label_parity_cases.json` pins this against the Python.
   */
  _resolveLabel(action, entityId, config, storedName = "", assign = null) {
    return this._cleanLabelText(
      this._resolveLabelLadder(action, entityId, config, storedName, assign)
    );
  },

  /**
   * What to call this button out loud: the same words the remote prints on it.
   *
   * Naming it from `assign.label` read the stored text verbatim, so a screen
   * reader spoke the placeholder — "dollar sign, left brace, STATE" — and a
   * layout button lost the entity the device draws in front of it.
   */
  _buttonSpokenLabel(assign) {
    if (!assign || !this._resolveLabel) return "";
    const action = assign.action_id
      ? (this._actions || []).find(a => a.id === assign.action_id)
      : null;
    const entityId = (assign.config && this._getTargetEntityFromConfig)
      ? this._getTargetEntityFromConfig(assign.config)
      : null;
    const resolved = this._resolveLabel(action, entityId, assign.config, assign.label || "", assign);
    // A label that resolves to nothing leaves the caller to fall back to the
    // key, which names the button at least as well as an empty string does.
    return resolved || "";
  },

  /**
   * Mirrors `clean_label_text`. The panel claims to show what the remote will
   * print, so it has to drop the same wreckage the device does: a stored name
   * of `Schreibtisch ${STATE` reads `Schreibtisch` there but was still reading
   * `Schreibtisch ${STATE` here.
   *
   * `\w*\}?` is bounded to a token-shaped run rather than running to the next
   * brace, which would eat the rest of the label and turn "Vor ${STATE nach"
   * into "Vor".
   */
  _cleanLabelText(text) {
    if (!text) return text;
    let out = text;
    const hadToken = out.includes("${");
    if (hadToken) out = out.replace(/\$\{\s*\w*\s*\}?/g, "");
    // Anything still holding a brace cannot be parsed as a URL by the device.
    if (out.includes("{") || out.includes("}")) out = out.replace(/[{}]/g, "");
    // A separator left joining nothing once a placeholder resolved away --
    // "Go to page:" on a goto whose page was deleted. Mirrors
    // `_DANGLING_SEPARATOR_RE`, and is likewise gated on the label having held
    // a placeholder, so a name the user ended in a colon is left alone.
    if (hadToken) out = out.replace(/^[\s:;,/\-–—]+|[\s:;,/\-–—]+$/g, "");
    return out.split(/\s+/).filter(Boolean).join(" ");
  },

  _resolveLabelLadder(action, entityId, config, storedName = "", assign = null) {
    // Both from the action library, as the Python ladder is: `service` decides
    // payload-ness, and taking it from the step misclassified a button whose
    // step service differs from its library entry's.
    const service = action?.service || "";
    const svc = service.split(".")[1] || "";
    const lang = this._labelLang();

    const stored = (storedName || "").trim();
    // The panel records who wrote the name, and a recorded edit is not a guess:
    // it outranks the library-name comparison below, which called every layout
    // button's own name "auto-filled" and drew the entity in front of it.
    const userNamed = !!assign?.label_edited;
    // A label made only of placeholders names nothing on its own, so it is a
    // shape rather than the user's words: resolved below, behind the entity.
    const tokenOnly = this._isTokenOnlyLabel(stored);
    // …and neither is a name a dynamic source wrote. On a page of toggles —
    // every lamp on a Hue bridge — the name is the lamp, and returning it here
    // is what left eleven buttons reading "Kitchen" while the twelfth read
    // "Kitchen Off", purely because its name matched the shared library entry.
    // A name typed over one of those lamps is the user's again, hence `userNamed`.
    const boundToggle =
      !userNamed && this._nameIsSourceOwned(assign) && this._isTwoWayService(svc);
    // The source's own title for the subject. Read from the binding rather than
    // from `storedName`, because `_labelPrefix` probes the ladder with a bare
    // "${STATE}" to find what the remote draws in front — and answering that
    // with the registry's friendly name put the wrong lamp in the field
    // whenever a source titled an item differently from the entity registry.
    const boundSubject = boundToggle ? (assign?.label || storedName || "").trim() : "";
    // A token-only label is a shape rather than words *unless the user wrote
    // it*. Deleting the entity prefix in front of "${STATE}" is the one way to
    // ask for the bare state word, and treating that edit as a shape put the
    // prefix straight back — the label could not be changed at all.
    if (stored && (userNamed || !tokenOnly) && !boundToggle && (userNamed || stored !== (action?.name || ""))) {
      // Empty means the label was nothing but a damaged placeholder. Falling
      // through leaves the button with its derived name instead of blank.
      const resolved = this._displayLabel(stored, action, entityId, config, assign);
      if (resolved) return resolved;
    }

    const payload = this._getPayloadDisplay(config);
    if (payload?.title) return payload.title;

    const staticName = this._localizeStaticName(
      tokenOnly
        ? ""
        : (stored || (this._isPayloadService(service) ? "" : (action?.name || ""))),
      lang,
      userNamed,
    );
    if (!svc) return staticName;

    const subject = this._getTargetSubjectName(config);
    const stateObj = this._getTargetStateObj(config)
      || (entityId && this._hass?.states?.[entityId]);
    let entityName = subject;
    if (!entityName && stateObj) {
      entityName = stateObj.attributes?.friendly_name || stateObj.entity_id.split(".").pop();
    } else if (!entityName && entityId) {
      entityName = entityId.split(".").pop();
    }
    const stateVal = stateObj?.state || "";

    if (boundSubject && !this._isTokenOnlyLabel(boundSubject)) {
      // The source picked the subject's name; the registry's friendly name is
      // the same string in the ordinary case and the wrong one when it is not
      // (a source is free to title an item however it likes).
      entityName = boundSubject;
      // Nothing to append — an unavailable lamp still deserves its name rather
      // than the generic "Toggle" the bottom of the ladder derives.
      if (!stateVal) return boundSubject;
    }

    if (tokenOnly) {
      const resolved = this._displayLabel(stored, action, entityId, config);
      if (resolved) return entityName ? `${entityName} ${resolved}` : resolved;
    }

    // An unrenamed attribute button announces its next action, exactly as an
    // unrenamed toggle announces its next state below. Mirrors the rung of the
    // same name in `device_sync._resolve_button_tooltip_ladder`; without it the
    // panel would print `${STATE}` while the device printed a frozen "Mute".
    if (this._isAttributeStateService(svc)) {
      const attrLabel = this._displayLabel(STATE_TOKEN, action, entityId, config);
      if (attrLabel) return entityName ? `${entityName} ${attrLabel}` : attrLabel;
    }

    const nextState = {on:"off",off:"on",playing:"pause",paused:"play",idle:"play",
      open:"close",closed:"open",locked:"unlock",unlocked:"lock"};
    if (this._stateToggleServices.includes(svc) && stateVal && nextState[stateVal]) {
      const label = this._getActionLabel(nextState[stateVal], lang);
      return entityName ? `${entityName} ${label}` : label;
    }

    if (this._isStatelessService(svc) && staticName) {
      return entityName ? `${entityName} ${staticName}` : staticName;
    }

    const label = this._friendlySvc(svc, lang);
    if (label) return entityName ? `${entityName} ${label}` : label;

    return staticName || entityName;
  },

  /**
   * The word for an action key, from the integration's own translations.
   *
   * `_actionLabels` is filled by `_loadActionLabels` from
   * `lizaip_config/get_action_labels`, which serves the `action_labels` section
   * of `translations/<lang>.json` -- the same file `get_action_label` in
   * `const.py` reads. The panel used to carry a hardcoded copy of the table;
   * two copies of a wording is a drift nobody sees, because no screen shows the
   * panel's label and the device's label together.
   *
   * The fallback is the same shape as Python's: an unknown key title-cases into
   * something readable rather than rendering blank. That also covers the window
   * before the load resolves, and a panel opened while the backend is down.
   */
  _getActionLabel(key, lang) {
    const label = this._actionLabels?.[key];
    if (label) return label;
    return String(key ?? "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  },

  // Mirrors `localize_static_name` in const.py. A brand ("Alexa") or a symbol
  // ("CH+") has no wording key and comes back untouched.
  _localizeStaticName(name, lang, userNamed) {
    if (!name || userNamed) return name;
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!this._actionLabels?.[slug]) return name;
    const translated = this._getActionLabel(slug, lang);
    // The layout's own spelling is the English source, so a wording that only
    // respells it ("Play/Pause" against the table's "Play / Pause") must not
    // replace it -- that rewrite reads as a user-typed label further up.
    const back = String(translated).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return back === slug ? name : translated;
  },

  // Display only: `_computeLabel` keeps the English, because Reset persists it
  // and storing a translation would freeze one language into the button.
  _localizePrefixedName(name, action, entityId, config, assign) {
    if (!name || assign?.label_edited) return name;
    const lang = this._labelLang();
    const whole = this._localizeStaticName(name, lang, false);
    if (whole !== name) return whole;

    const stateObj = this._getTargetStateObj(config)
      || (entityId && this._hass?.states?.[entityId]) || null;
    const prefix = this._getTargetSubjectName(config)
      || stateObj?.attributes?.friendly_name
      || (stateObj?.entity_id || entityId || "").split(".").pop()
      || "";
    if (!prefix || !name.startsWith(`${prefix} `)) return name;
    const rest = name.slice(prefix.length + 1);
    const translated = this._localizeStaticName(rest, lang, false);
    return translated === rest ? name : `${prefix} ${translated}`;
  },

  _friendlySvc(svc, lang) {
    if (SERVICE_ACTION_MAP[svc]) return this._getActionLabel(SERVICE_ACTION_MAP[svc], lang);
    let name = svc;
    for (const prefix of ["media_", "set_"]) {
      if (name.startsWith(prefix)) { name = name.slice(prefix.length); break; }
    }
    return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  },

  // The language to *display* in: the one the backend resolved for this device
  // (it may be pinned to Italian), falling back to the browser's.
  _labelLang() {
    return this._actionLabelsLang || this._hass?.language || "en";
  },

  // The language the panel *asks* in: this browser's, and nothing else.
  // Not `_labelLang`, which is the backend's answer — sending that back would
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

  /** Open a modal and return it with its close function. A native <dialog>,
   *  as HA's own ha-dialog is: the focus trap, Escape, inertness, role and
   *  focus-return all come from the platform. The caller supplies the name. */
  _openModal(innerHtml, { labelledBy = "", describedBy = "", role = "" } = {}) {
    const sr = this.shadowRoot;
    // One at a time: these dialogs open each other. Closed before it is
    // removed, for the reason `close` gives below.
    const stale = sr.querySelector("dialog.add-page-overlay");
    if (stale) { if (stale.open) stale.close(); stale.remove(); }

    const dlg = document.createElement("dialog");
    dlg.className = "add-page-overlay";
    if (labelledBy) dlg.setAttribute("aria-labelledby", labelledBy);
    // Without this a reader announces the dialog's name and its focused
    // control and nothing else, so the body text -- which is the whole point
    // of a confirmation -- was never spoken. It is the only way a dialog can
    // offer its own prose: the text is not focusable and not a live region.
    if (describedBy) dlg.setAttribute("aria-describedby", describedBy);
    // `alertdialog` for a destructive confirm. It is the role that says the
    // message matters, and readers announce the description on open for it
    // where a plain dialog may not.
    if (role) dlg.setAttribute("role", role);
    dlg.innerHTML = innerHtml;

    const close = () => {
      // `close()` before `remove()`, never the other way round: removing the
      // node drops it from the top layer without ever firing `close`, and the
      // focus the browser was holding for the opener goes with it.
      if (dlg.open) dlg.close();
      dlg.remove();
    };

    // Escape. Prevented so the browser does not also close it underneath us
    // and skip the teardown.
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    // Click outside the card. The dialog element fills the viewport and
    // centres the card inside it, so anything that lands on the dialog itself
    // was a click on the scrim.
    dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });

    sr.appendChild(dlg);
    dlg.showModal();
    return { dlg, close };
  },

  /** WCAG 3.3.4: confirm a destructive action. Built on `_openModal`, so the
   *  focus trap, Escape and focus-return are the platform's. Cancel takes
   *  initial focus so a dialog appearing under a finger on Enter cannot
   *  confirm itself, and every path that is not Confirm resolves false. */
  _confirmDestructive({ title, message, confirmText }) {
    return new Promise((resolve) => {
      const { dlg, close } = this._openModal(`
        <div class="add-page-dialog confirm-dialog" role="document">
          <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._esc(title)}</h2>
          <p class="confirm-dialog-message" id="liza-dlg-message">${this._esc(message)}</p>
          <div class="layout-dialog-actions">
            <button type="button" class="confirm-cancel-btn">${this._esc(this._t("cancel"))}</button>
            <button type="button" class="confirm-danger-btn">${this._esc(confirmText)}</button>
          </div>
        </div>
      `, { labelledBy: "liza-dlg-title", describedBy: "liza-dlg-message", role: "alertdialog" });

      let settled = false;
      const settle = (answer) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      };
      // `close` fires for Escape, the scrim, our own buttons, and a stale
      // dialog being cleared by the next `_openModal`. Anything that is not an
      // explicit confirm is a no.
      dlg.addEventListener("close", () => settle(false));
      dlg.querySelector(".confirm-cancel-btn")?.addEventListener("click", () => { settle(false); close(); });
      dlg.querySelector(".confirm-danger-btn")?.addEventListener("click", () => { settle(true); close(); });
      dlg.querySelector(".confirm-cancel-btn")?.focus?.();
    });
  },

  _toast(msg) {
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

