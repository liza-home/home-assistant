/**
 * lizaIP Panel — Settings View
 * The gear tab: which font and size the remote draws page titles and tooltips in,
 * how finely a light's brightness fills its button icon, and whether its
 * buttons react to a long touch.
 *
 * Per remote, like everything else in the device view. The backend owns the
 * defaults, the size limits and the list of installed fonts, and sends them with
 * the settings (`lizaip_config/get_settings`), so nothing here restates a number
 * the server would have to agree with.
 *
 * A change is saved as soon as it is made, like the rest of the panel: there is
 * no form to submit. The backend checks it again and answers with what it
 * stored, which is what the tab then shows.
 *
 * The fill step lives in the config entry's options rather than settings.yaml
 * (`lizaip_config/get_icon_options` / `set_icon_options`), because the state
 * listener and the page sync read it from there.
 */

import { INACTIVE_STATES } from "./lizaip-helpers.js";

const TEXT_KINDS = ["title", "tooltip"];


/**
 * The tab's pages, one chip each. Only the chosen group is rendered, so a
 * group fits the panel without scrolling and anything that queries a control
 * has to tolerate it being absent, as several cards already required.
 */
const SETTINGS_GROUPS = [
  {
    id: "editor", icon: "mdi:monitor-edit",
    label: "settings_group_editor",
  },
  {
    id: "appearance", icon: "mdi:palette-outline",
    label: "settings_group_appearance",
  },
  {
    id: "behaviour", icon: "mdi:gesture-tap-button",
    label: "settings_group_behaviour",
  },
  {
    id: "device", icon: "mdi:tablet",
    label: "settings_device",
  },
];
// The group shown before one has been chosen: the remote's own look, not the
// editor's switches, which only change this browser.
const SETTINGS_DEFAULT_GROUP = "appearance";

// A plain string, not a template literal: the placeholder it shows is written
// in the same syntax a template literal substitutes.
const VARIABLE_SAMPLE = "${sensor.living_room_temperature}";

// The three axes a theme file describes. A remote picks one theme for all
// three; the facets survive only as building blocks inside the custom editor,
// and as the shape a remote set up before that may still hold.
const FACETS = ["colors", "text", "icons"];
export const THEME_DEFAULT = "default";
// "Start from nothing": the draft still opens on the standard look, so every
// field is there and the theme saves, but it belongs to no other theme.
const THEME_BLANK = "";
const THEME_SEPARATOR = ".";

// One tile per state colour, each drawing a different domain from the Icons
// section's left column, so every tile follows a glyph the theme can re-point
// and all four domains are previewed at once.
const THEME_PREVIEW_SLOTS = [
  { state: "on", key: "light.on", glyph: "mdi:lightbulb-on" },
  { state: "off", key: "switch.on", glyph: "mdi:toggle-switch" },
  { state: "unavailable", key: "fan.on", glyph: "mdi:fan" },
  { state: "default", key: "lock.unlocked", glyph: "mdi:lock-open" },
];

// What an icon chip draws when its theme re-points no glyph at all.
const THEME_STATE_GLYPH = "mdi:power";

// The state colours a theme names for a state rather than a hue, in the order
// the editor offers them. `?fg=off` keeps working whatever they hold.
const THEME_STATE_COLORS = ["on", "off", "unavailable", "default"];
// The parts of a draft that end up in the file, so the only ones a discard
// has to put back. `from` and `named` steer the editor, not the theme.
const THEME_EDIT_FACETS = [
  "name", "palette", "states", "text", "glyphs",
];
// Where each colour word ends on the hue circle. The caption follows the
// colour; the name a button asks for never does, so this only names captions.
const COLOR_HUES = [
  [15, "red"], [45, "orange"], [68, "yellow"], [100, "lime"], [155, "green"],
  [178, "teal"], [193, "cyan"], [255, "blue"], [285, "indigo"],
  [320, "purple"], [345, "pink"], [360, "red"],
];
// How two or more swatches landing on one word are told apart, by lightness.
const COLOR_SHADES = {
  2: ["dark", "light"],
  3: ["dark", "", "light"],
  4: ["darkest", "dark", "light", "lightest"],
  5: ["darkest", "dark", "", "light", "lightest"],
  6: ["darkest", "darker", "dark", "light", "lighter", "lightest"],
};

// What the editor offers a glyph pair for: the four domains whose two states
// differ at a glance. The active state comes first in every pair, so each
// column holds one state colour -- and a lock counts as active when unlocked.
const THEME_EDIT_DOMAINS = [
  { domain: "light", states: ["on", "off"] },
  { domain: "switch", states: ["on", "off"] },
  { domain: "fan", states: ["on", "off"] },
  { domain: "lock", states: ["unlocked", "locked"] },
];


export const SettingsViewMixin = {
  /** Where the chosen group is kept, like the page-links preference. */
  SETTINGS_GROUP_PREF: "liza.remote.settingsGroup",

  /** Load what the tab shows. Also the source of the title previews' style. */
  async _loadTextSettings() {
    if (!this._currentEntry) return;
    // An unsaved pick belongs to the remote it was made on, not to the next.
    this._themeDraft = null;
    this._setThemeDraft(null);
    this._themeEditOpen = null;
    this._themeEditEnter = false;
    try {
      this._textSettings = await this._hass.callWS({
        type: "lizaip_config/get_settings", entry_id: this._currentEntry,
      });
      this._textSettingsError = null;
    } catch (e) {
      this._textSettings = null;
      this._textSettingsError = String(e?.message || e);
    }
  },

  _enterSettingsTab() {
    // Fresh each time: a font dropped into the folder appears without a reload.
    Promise.all([this._loadTextSettings(), this._loadIconOptions()]).then(() => {
      if (this._activeTab === "settings") this._render();
    });
  },

  /**
   * Which group the chips are showing: what this browser last chose, because
   * a save repaints the whole view. An unknown value falls back to Appearance.
   * A section named in the URL arrives through `_applySettingsSection`.
   */
  _settingsGroup() {
    if (this._settingsGroupId === undefined) {
      let stored = null;
      try { stored = window.localStorage?.getItem(this.SETTINGS_GROUP_PREF); } catch (e) { stored = null; }
      this._settingsGroupId = SETTINGS_GROUPS.some((g) => g.id === stored) ? stored : SETTINGS_DEFAULT_GROUP;
    }
    return this._settingsGroupId;
  },

  /** The section the route named, if the panel has one by that name. */
  _applySettingsSection(id) {
    if (!SETTINGS_GROUPS.some((g) => g.id === id)) return;
    this._settingsGroupId = id;
  },

  /**
   * A chip clears the search as well as moving the page: the results belong
   * to no chip. The render writes the new section into the address bar.
   */
  _setSettingsGroup(id) {
    if (!SETTINGS_GROUPS.some((g) => g.id === id)) return;
    if (id === this._settingsGroup() && !this._settingsQuery) return;
    if (id !== "appearance") this._discardThemePick();
    this._settingsGroupId = id;
    this._settingsQuery = "";
    try {
      window.localStorage?.setItem(this.SETTINGS_GROUP_PREF, id);
    } catch (e) { /* Blocked storage: the chip still works for this session. */ }
    this._render();
  },

  /** The fonts to offer, as ha-select options. */
  _htmlSettingsFontOptions(current) {
    const fonts = this._textSettings?.fonts || [];
    const options = fonts.map((f) => ({
      value: f.id,
      label: f.source === "user" ? this._t("settings_font_user", { name: f.name }) : f.name,
    }));
    // A font named in settings.yaml but no longer installed is still the
    // setting: listing it keeps the select from silently showing another one.
    if (current && !fonts.some((f) => f.id === current)) {
      options.unshift({ value: current, label: this._t("settings_font_missing", { name: current }) });
    }
    return options;
  },

  /**
   * A card header: a glyph, the name, and an optional action on the right.
   * Every card wears the same one, so a card that carries an action does not
   * have to grow a header shape of its own for it.
   */
  _htmlSettingsCardHeader(icon, titleKey, action = "") {
    return `
      <div class="actions-card-header settings-card-header">
        <ha-icon class="settings-card-icon" icon="${icon}" aria-hidden="true"></ha-icon>
        <h3 class="actions-card-title">${this._esc(this._t(titleKey))}</h3>
        ${action}
      </div>`;
  },

  /** The preview's glyphs as *theme* draws them: its own glyph for a slot's
   * domain and state where it re-draws one, else the shipped one, else the
   * fixed glyph. */
  _themePreviewGlyphs(theme) {
    const own = new Map((Array.isArray(theme?.icons) ? theme.icons : [])
      .filter((o) => o?.section === "domain_state_icons")
      .map((o) => [o.key, o.icon]));
    return THEME_PREVIEW_SLOTS.map(({ key, glyph }) => {
      const [domain, state] = key.split(".");
      return own.get(key) || this._themeGlyphFallback(domain, state) || glyph;
    });
  },

  /** What the remote looks like under *theme*, which may be unsaved. Drawn by
   * imgserv, so the font, sizes, colours and glyphs are the real ones; naming
   * the theme per picture shows a combination before anything is written. */
  _htmlThemeScreen(theme) {
    if (!theme) return "";
    const opts = { keepMode: true, theme: theme.id };
    const tile = (icon, color, label) => {
      if (!icon) return "";
      const { src, key } = this._deviceImg(icon, "tile", color, null, opts);
      return `<img class="theme-tile" ${src ? `src="${this._esc(src)}"` : ""}
        data-dev-key="${this._esc(key)}" data-keep-mode alt=""
        title="${this._esc(label)}">`;
    };
    // Each strip at the remote's own pixel size -- title 200x50, tooltip
    // 200x40 -- centred in the 240x60 frame the remote gives it, so what is
    // previewed is the size it is seen at, not a stretched copy.
    const strip = (kind) => {
      const sample = this._t(kind === "title" ? "settings_sample_title" : "settings_sample_tooltip");
      const { src, key } = this._deviceImg(`text:${sample}`, kind, "", null, opts);
      return `<span class="theme-strip-frame"><img class="theme-strip theme-strip-${kind}" ${src ? `src="${this._esc(src)}"` : ""}
        data-dev-key="${this._esc(key)}" data-keep-mode alt=""></span>`;
    };
    const states = theme.colors?.states || {};
    const tiles = this._themePreviewGlyphs(theme).map((icon, n) => {
      const { state } = THEME_PREVIEW_SLOTS[n];
      return tile(icon, states[state] || "", this._t(`settings_theme_state_${state}`));
    }).join("");
    return `
        <span class="theme-screen">
          ${strip("title")}
          <span class="theme-tiles">${tiles}</span>
          ${strip("tooltip")}
        </span>`;
  },

  // ── Which theme the remote draws with ───────────────────────────────

  /** The one theme id the remote has stored. A remote set up before this
   * picker was simplified may hold three, one per part; they are read as the
   * composite they draw as rather than thrown away. */
  _storedThemeId() {
    const given = this._textSettings?.settings?.theme;
    if (given && typeof given === "object") {
      const parts = FACETS.map(
        (f) => String(given[f] || THEME_DEFAULT).toLowerCase());
      return parts.every((p) => p === parts[0])
        ? parts[0] : parts.join(THEME_SEPARATOR);
    }
    const one = typeof given === "string" && given.trim()
      ? given.trim().toLowerCase() : THEME_DEFAULT;
    return one;
  },

  /** Whether the stored theme is a leftover mix with no tile of its own. */
  _storedIsMix() {
    return this._storedThemeId().includes(THEME_SEPARATOR);
  },

  /** The theme on screen: the unsaved pick if there is one, else the stored. */
  _draftThemeId() {
    return this._themeDraft || this._storedThemeId();
  },

  _themeDirty() {
    return this._draftThemeId() !== this._storedThemeId();
  },

  _themeById(id) {
    const themes = this._textSettings?.themes || [];
    return themes.find((t) => t.id === id);
  },

  /** The theme on screen, read as one. An id naming parts rather than a file
   * is a leftover mix, resolved part by part the way the backend reads it. */
  _draftTheme() {
    const id = this._draftThemeId();
    if (!this._themeById(THEME_DEFAULT)) return null;
    return this._themeById(id) || this._themeOfParts(id);
  },

  /** A dotted id read as one theme: each facet is looked up on its own and
   * anything missing falls back to the default, so the mix stays honest. */
  _themeOfParts(id) {
    const fallback = this._themeById(THEME_DEFAULT);
    if (!fallback) return null;
    const parts = String(id || "").split(THEME_SEPARATOR);
    const part = (n) => this._themeById(parts[n]) || fallback;
    return {
      id,
      name: this._t("settings_theme_mix"),
      colors: part(0).colors,
      text: part(1).text,
      icons: part(2).icons,
    };
  },

  /** One theme, shown as the screen it draws: the remote's title, a tile per
   * state colour and the tooltip, scaled down to fit the tile. It is drawn
   * from the saved file, so an edit reaches it once it is saved. */
  _htmlThemeTile(theme) {
    return `<span class="theme-card-art theme-card-screen">${this._htmlThemeScreen(theme)}</span>`;
  },

  /** One icon on a tile. They are spans inside a button, so they carry their
   * own role and a key handler in the wiring. */
  _htmlPresetIcon(attr, id, icon, key, extra = "") {
    const label = this._esc(this._t(key));
    return `<span class="theme-preset-edit${extra}"
        ${attr}="${this._esc(id)}" role="button" tabindex="0"
        title="${label}" aria-label="${label}">
        <ha-icon icon="${icon}" aria-hidden="true"></ha-icon></span>`;
  },

  /** What rides on a tile. Viewing or editing needs no icon: picking the
   * tile opens it beneath the list, and dragging it onto Create… copies it.
   * Every theme can be downloaded; only one of the user's own deleted. */
  _htmlPresetAction(theme) {
    const id = theme.id;
    const download = this._htmlPresetIcon("data-download", id, "mdi:download",
      "settings_theme_download");
    if (theme.source !== "user") return download;
    return download + this._htmlPresetIcon("data-delete", id, "mdi:trash-can-outline",
      "settings_theme_delete", " theme-preset-delete");
  },

  /** The mix a remote set up before this picker was simplified still draws
   * with. It has no file to be re-picked by, but it is shown so the screen
   * tells the truth, and dragging it onto Create… lifts it into a theme of
   * its own. */
  _htmlMixTile() {
    const mix = this._draftTheme();
    if (!mix) return "";
    const creating = Boolean(this._themeEdit) && !this._themeEdit.id;
    const on = !creating && this._draftThemeId() === this._storedThemeId();
    return `
      <div class="theme-preset theme-preset-mix${on ? " selected" : ""}"
        data-mix aria-current="${on}">
        ${this._htmlThemeTile(mix)}
        <span class="theme-preset-name">
          <span class="theme-preset-title">${this._esc(this._t("settings_theme_mix"))}</span>
          <span class="theme-preset-acts"></span>
        </span>
      </div>`;
  },

  /** Every theme the remote can be set to, plus the tile that opens the
   * editor. A file supplying only one facet says `preset: false` -- those are
   * building blocks, offered inside the editor rather than here. */
  _htmlPresetButtons() {
    // A theme being created is no tile yet: Create… stands for it, so the
    // pick the remote would be given stays put but is not shown as chosen.
    const creating = Boolean(this._themeEdit) && !this._themeEdit.id;
    const chosen = creating ? null : this._draftThemeId();
    const buttons = (this._textSettings?.themes || [])
      .filter((theme) => theme.preset !== false)
      .sort((a, b) => Number(a.source === "user") - Number(b.source === "user"))
      .map((theme) => {
        const on = chosen === theme.id;
        return `
        <button type="button" class="theme-preset${on ? " selected" : ""}"
          data-preset="${this._esc(theme.id)}" aria-pressed="${on}">
          ${this._htmlThemeTile(theme)}
          <span class="theme-preset-name">
            <span class="theme-preset-title" title="${this._esc(theme.name)}"
              >${this._esc(theme.name)}</span>
            <span class="theme-preset-acts">
              ${this._htmlPresetAction(theme)}</span>
          </span>
        </button>`;
      }).join("");
    return `${this._storedIsMix() ? this._htmlMixTile() : ""}${buttons}
      <button type="button" class="theme-preset theme-preset-add${creating ? " selected" : ""}"
        data-theme-new aria-pressed="${creating}" aria-describedby="liza-theme-drop-hint">
        <span class="theme-card-art theme-card-art-add">
          <ha-icon icon="mdi:plus" aria-hidden="true"></ha-icon>
        </span>
        <span class="theme-preset-name">
          <span class="theme-preset-title">${this._esc(this._t("settings_theme_add"))}</span>
          <span class="theme-preset-drop-hint" id="liza-theme-drop-hint">
            ${this._esc(this._t("settings_theme_drop_hint"))}</span>
        </span>
      </button>`;
  },

  /** The Theme card: pick one look and see what it draws. A pick is only
   * shown until Apply sends it. Mixing parts is what the custom editor
   * is for. The tile row opens the card under its own title, so it carries
   * no heading or rule of its own. Every tile is drawn as the screen it
   * gives, so there is no separate result to look at. */
  _htmlSettingsThemeCard() {
    const themes = this._textSettings?.themes || [];
    if (!themes.length) return "";
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlSettingsCardHeader("mdi:palette-outline", "settings_theme")}
        <div class="settings-body">
          <div class="theme-presets">
            <div class="theme-preset-row">${this._htmlPresetButtons()}</div>
          </div>
          ${this._htmlThemeApplyActions()}
        </div>
      </ha-card>`;
  },

  /** Apply writes the picked theme to the remote. It stays available so it
   * can also reaffirm the current theme. */
  _htmlThemeApplyActions() {
    const busy = this._textSettingsBusy;
    return `
          <div class="settings-actions settings-actions-end">
            <ha-button variant="brand" class="debug-btn theme-apply"
              ${busy ? "disabled" : ""}>
              ${this._esc(this._t("settings_theme_apply"))}
            </ha-button>
          </div>`;
  },

  // ── The custom theme editor ──────────────────────────────────────────

  /** A theme's icon changes as `{domain: {state: icon}}`, which is the shape
   * the editor's fields write into. */
  _glyphsOfTheme(theme) {
    const glyphs = {};
    for (const change of theme?.icons || []) {
      if (change.section !== "domain_state_icons") continue;
      const [domain, state] = String(change.key).split(".");
      if (!domain || !state) continue;
      (glyphs[domain] ||= {})[state] = change.icon;
    }
    return glyphs;
  },

  /** The theme's icon sections other than the per-state glyphs, which the
   * editor holds in `glyphs`. */
  _iconsKeptOfTheme(theme) {
    const table = theme?.icon_table;
    if (!table || typeof table !== "object") return {};
    const kept = structuredClone(table);
    delete kept.domain_state_icons;
    return kept;
  },

  /** A draft of the theme *startFrom* supplies the values of. `editing` says
   * which of the two things is happening — a new file or the user's own one —
   * rather than letting the seed's own source decide it. */
  _themeEditSeed(startFrom, editing = false) {
    const blank = startFrom === THEME_BLANK;
    const seed = (blank ? null : this._themeToStartFrom(startFrom))
      || this._themeById(THEME_DEFAULT) || {};
    return {
      id: editing ? seed.id : "",
      from: blank ? THEME_BLANK : (seed.id || THEME_DEFAULT),
      name: editing ? seed.name : this._suggestThemeName(blank ? "" : seed.name),
      palette: (seed.colors?.palette || []).map((swatch) => ({ ...swatch })),
      states: Object.fromEntries(
        THEME_STATE_COLORS.map((s) => [s, seed.colors?.states?.[s] || ""])),
      text: Object.fromEntries(
        TEXT_KINDS.map((kind) => [kind, { ...(seed.text?.[kind] || {}) }])),
      glyphs: this._glyphsOfTheme(seed),
      // Every icon change the editor has no field for, kept as the file holds
      // it so a save -- or a copy -- does not quietly drop them.
      iconsKept: this._iconsKeptOfTheme(seed),
    };
  },

  /** Whether the editor holds changes the file does not. Re-seeding from the
   * saved theme and comparing is the only reading that cannot drift: it asks
   * the same builder that filled the draft in the first place. */
  _themeEditDirty() {
    const draft = this._themeEdit;
    if (!draft?.id) return false;
    const saved = this._themeEditSeed(draft.id, true);
    return THEME_EDIT_FACETS.some((k) => !this._sameThemeValue(draft[k], saved[k]));
  },

  /** Saving is offered only when it would do something. A new theme always
   * would; an existing one only once the draft parts from the file, which
   * leaves the button reading as the sign of unsaved work. */
  _themeSaveBlocked(problem) {
    if (this._themeEditBusy || problem) return true;
    return Boolean(this._themeEdit?.id) && !this._themeEditDirty();
  },

  /** Deep equality for the values a draft is made of: strings, arrays and
   * plain objects. Key order is not compared, so a facet rebuilt by a field
   * handler still reads as unchanged. */
  _sameThemeValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length
        && a.every((v, i) => this._sameThemeValue(v, b[i]));
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      return [...keys].every((k) => this._sameThemeValue(a[k], b[k]));
    }
    return (a ?? "") === (b ?? "");
  },

  /** The theme an id stands for. A leftover mix names its parts rather than a
   * file, so it is resolved the way the preview resolves it — copying the Mix
   * tile then keeps the look it shows instead of falling back to the default. */
  _themeToStartFrom(themeId) {
    const whole = this._themeById(themeId);
    if (whole) return whole;
    return String(themeId || "").includes(THEME_SEPARATOR)
      ? this._themeOfParts(themeId)
      : null;
  },

  /** The id a display name is filed under: the panel's copy of the rule the
   * backend writes the file by, so a clash is caught before Save is pressed. */
  _themeSlug(name) {
    return String(name || "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  },

  /** A name no theme has yet: *Copy of Monochrome*, then *Copy of Monochrome 2*. Two
   * themes sharing a name share a file, which is how one used to overwrite
   * the other the moment it was saved. */
  _suggestThemeName(from) {
    const taken = new Set((this._textSettings?.themes || []).map((t) => t.id));
    const base = from
      ? this._t("settings_theme_new_name", { name: from })
      : this._t("settings_theme_blank_name");
    if (!taken.has(this._themeSlug(base))) return base;
    for (let n = 2; n < 100; n += 1) {
      if (!taken.has(this._themeSlug(`${base} ${n}`))) return `${base} ${n}`;
    }
    return base;
  },

  /** Why the draft cannot be saved yet, as a message, or `""` when it can. */
  _themeNameProblem() {
    const draft = this._themeEdit;
    if (!draft) return "";
    const name = String(draft.name || "").trim();
    if (!name) return this._t("settings_theme_name_missing");
    const id = this._themeSlug(name);
    if (!id) return this._t("settings_theme_name_unusable");
    const clash = (this._textSettings?.themes || [])
      .find((t) => t.id === id && t.id !== draft.id);
    return clash ? this._t("settings_theme_name_taken", { name: clash.name }) : "";
  },

  /** `#RRGGBB` for an `input type=color`, which accepts nothing else. */
  _themeEditHex(value) {
    const raw = String(value || "").replace("#", "").slice(0, 6);
    return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw}` : "#000000";
  },

  /** What a folded section is set to, so the row can be read without opening
   * it: the font and its sizes. */
  _themeEditSummary(facet, draft) {
    // Temporarily disabled: the palette dots, with the palette block itself.
    if (facet === "colors") return "";
    /*
    if (facet === "colors") {
      const dots = (draft.palette || []).slice(0, 6).map((swatch) =>
        `<i style="background:${this._esc(this._themeEditHex(swatch.hex))}"></i>`).join("");
      return dots ? `<span class="theme-edit-dots">${dots}</span>` : "";
    }
    */
    if (facet === "text") {
      const fonts = this._textSettings?.fonts || [];
      const fontId = draft.text?.title?.font;
      const font = fonts.find((f) => f.id === fontId)?.name || fontId || "";
      const sizes = TEXT_KINDS
        .map((kind) => draft.text?.[kind]?.font_size).filter(Boolean).join(" / ");
      return this._esc([font, sizes && `${sizes} px`].filter(Boolean).join(" · "));
    }
    return "";
  },

  /** A facet's section of the editor: what it is called, what it is set to
   * now, and the controls that set it by hand. Folded shut so the editor
   * opens as a page rather than a wall. */
  _htmlThemeEditGroup(facet, labelKey, body, icon) {
    const open = this._themeEditOpen === facet;
    return `
      <details class="theme-edit-group" data-group="${this._esc(facet)}"${open ? " open" : ""}>
        <summary class="theme-edit-summary">
          <ha-icon class="theme-edit-lead" icon="${this._esc(icon)}" aria-hidden="true"></ha-icon>
          <span class="theme-edit-head">
            <span class="theme-facet-label">${this._esc(this._t(labelKey))}</span>
            <span class="theme-edit-value">${this._themeEditSummary(facet, this._themeEdit || {})}</span>
          </span>
          <ha-icon class="theme-edit-chev" icon="mdi:chevron-right" aria-hidden="true"></ha-icon>
        </summary>
        <div class="theme-edit-body"><div class="theme-edit-slot"${
  this._themeEdit?.readonly ? " inert" : ""}>${body}</div></div>
      </details>`;
  },

  _htmlThemeEditColor(label, scope, key, value) {
    const id = `liza-theme-${scope}-${key}`;
    return `
      <div class="theme-edit-color">
        <label for="${id}">${this._esc(label)}</label>
        <input type="color" id="${id}" class="theme-edit-swatch"
          data-scope="${this._esc(scope)}" data-key="${this._esc(key)}"
          value="${this._esc(this._themeEditHex(value))}">
      </div>`;
  },

  /** *hex* as hue, saturation and lightness, each 0..1 but the hue in degrees. */
  _colorHsl(hex) {
    const v = this._themeEditHex(hex).slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0)
      : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  },

  /** The one word *hex* is: a shade of grey when it has next to no colour
   * left in it, else the hue it sits on. Never empty, so a swatch always
   * wears a caption. */
  _colorWord(hex) {
    const [h, s, l] = this._colorHsl(hex);
    if (s < 0.15 || l > 0.96 || l < 0.05) {
      if (l >= 0.93) return "white";
      if (l <= 0.08) return "black";
      return l >= 0.72 ? "silver" : "grey";
    }
    return COLOR_HUES.find(([upto]) => h < upto)[1];
  },

  /** A caption for every swatch at once, so no two different colours read the
   * same: those landing on one word are told apart by lightness. Two swatches
   * painted the identical colour keep the identical caption. */
  _paletteLabels(hexes) {
    const words = hexes.map((hex) => this._colorWord(hex));
    const out = new Array(hexes.length);
    const groups = new Map();
    words.forEach((word, i) => {
      if (!groups.has(word)) groups.set(word, []);
      groups.get(word).push(i);
    });
    for (const [word, idx] of groups) {
      const shades = [...new Set(idx.map((i) => this._themeEditHex(hexes[i])))]
        .sort((a, b) => this._colorHsl(a)[2] - this._colorHsl(b)[2]);
      const ladder = shades.length > 1 ? COLOR_SHADES[Math.min(shades.length, 6)] || [] : [];
      idx.forEach((i) => {
        const step = ladder[shades.indexOf(this._themeEditHex(hexes[i]))] || "";
        const full = step ? `${step} ${word}` : word;
        out[i] = full.charAt(0).toUpperCase() + full.slice(1);
      });
    }
    return out;
  },

  /** Every swatch titled the way the editor captions it: what the colour
   * looks like and its hex. The stored slot name is not used -- a theme
   * recolours a name in place, so `blue` can be a green. */
  _paletteTitles(palette) {
    const captions = this._paletteLabels((palette || []).map((sw) => sw.hex));
    return (palette || []).map(
      (sw, i) => `${captions[i]} · ${this._themeEditHex(sw.hex)}`);
  },

  /** Under Colours: what a tile is tinted with by itself. One block, so it
   * carries no heading of its own -- the section is already named. */
  _htmlThemeEditColors(draft) {
    const states = THEME_STATE_COLORS
      .map((s) => this._htmlThemeEditColor(
        this._t(`settings_theme_state_${s}`), "states", s, draft.states[s])).join("");
    // Temporarily disabled: the six-swatch palette block. Bringing it back
    // also brings back the `settings_theme_states` heading above, which is
    // what told the two blocks apart.
    const paletteBlock = "";
    /*
    const captions = this._paletteLabels(draft.palette.map((sw) => sw.hex));
    const swatches = draft.palette
      .map((sw, i) => this._htmlThemeEditColor(
        captions[i], "palette", i, sw.hex)).join("");
    const paletteBlock = `
      <div class="theme-edit-block">
        <b class="theme-edit-block-head">${this._esc(this._t("settings_theme_palette"))}</b>
        <span class="config-field-hint">${this._esc(this._t("settings_theme_palette_hint"))}</span>
        <div class="theme-edit-colors">${swatches}</div>
      </div>`;
    */
    const body = `
      <div class="theme-edit-block">
        <span class="config-field-hint">${this._esc(this._t("settings_theme_states_hint"))}</span>
        <div class="theme-edit-colors">${states}</div>
      </div>${paletteBlock}`;
    return this._htmlThemeEditGroup(
      "colors", "settings_theme_colors", body,
      "mdi:palette-outline");
  },

  _htmlThemeEditText(draft) {
    const rows = TEXT_KINDS.map((kind) => {
      const limits = this._textSettings?.limits?.[kind] || {};
      const style = draft.text[kind] || {};
      const fontId = `liza-theme-font-${kind}`;
      const sizeId = `liza-theme-size-${kind}`;
      return `
        <div class="settings-field-row">
          <div class="config-field">
            <!-- ha-select takes its options as a property: the wiring hands
                 them over. -->
            <ha-select id="${fontId}" class="theme-edit-font" data-kind="${kind}"
              label="${this._esc(this._t(kind === "title" ? "settings_title" : "settings_tooltip"))}"></ha-select>
          </div>
          <div class="config-field">
            <ha-input type="number" appearance="outlined" id="${sizeId}" class="settings-step-input theme-edit-size" data-kind="${kind}"
              inputmode="numeric" step="1" min="${limits.min ?? ""}" max="${limits.max ?? ""}"
              label="${this._esc(this._t("settings_font_size"))}"
              value="${this._esc(style.font_size ?? "")}"></ha-input>
          </div>
        </div>`;
    }).join("");
    const fontsPath = { path: "/config/lizaip/fonts" };
    const body = `${rows}
      <span class="config-field-hint">${this._esc(this._t("settings_fonts_hint", fontsPath))} ${this._esc(this._t("settings_emoji_hint", fontsPath))}</span>`;
    return this._htmlThemeEditGroup(
      "text", "settings_theme_text", body,
      "mdi:format-size");
  },

  /** The icon a tile shows while the thing is in *state*: the glyph shows the
   * state itself, so "a light that's on" is drawn with a lit bulb. */
  _themeGlyphLabel(domain, state) {
    return this._t(`settings_theme_glyph_${domain}_${state}`);
  },

  /** The glyph a theme draws for *domain* in *state* when it names none of
   * its own: the one the integration ships, not the one the remote's current
   * theme happens to draw, since a theme's glyphs are laid over the shipped
   * table. */
  _themeGlyphFallback(domain, state) {
    const table = (this._shippedIconDefaults || this._iconDefaults)?.domain_state_icons || {};
    return table[domain]?.[state] || "";
  },

  _htmlThemeEditIcons(draft) {
    // A glyph is previewed in the colour its own state is given, so the pair
    // reads as the remote will draw it rather than in the theme it is still on.
    const tint = (state) => {
      const key = INACTIVE_STATES.includes(state) ? "off" : "on";
      const hex = draft.states?.[key] || draft.states?.default;
      return hex ? this._themeEditHex(hex) : "";
    };
    const fields = THEME_EDIT_DOMAINS.map(({ domain, states }) => states.map((state) => {
      const slotId = `liza-theme-glyph-${domain}-${state}`;
      const fallback = this._themeGlyphFallback(domain, state);
      // The glyph in force, written out so it can be edited rather than only
      // retyped: the shipped one stands in the field until the theme names
      // its own.
      const value = draft.glyphs?.[domain]?.[state] || fallback;
      return this._htmlIconField({
        label: this._themeGlyphLabel(domain, state),
        value, inputValue: value, autoIcon: fallback, placeholder: fallback, color: tint(state),
        slotId,
        slotAttrs: `data-domain="${this._esc(domain)}" data-state="${this._esc(state)}" data-tint="${this._esc(tint(state))}"`,
        inputClass: "theme-edit-glyph",
      });
    }).join("")).join("");
    const body = `
      <span class="config-field-hint">${this._esc(this._t("settings_theme_glyphs_hint"))}</span>
      <div class="theme-edit-glyphs">${fields}</div>`;
    return this._htmlThemeEditGroup(
      "icons", "settings_theme_icons", body,
      "mdi:toggle-switch-outline");
  },

  /** The editor, which opens beneath the picker on the theme picked there:
   * picking another tile shows that theme in it instead. */
  _htmlThemeEditorCard() {
    const draft = this._themeEdit;
    if (!draft) return "";
    // Every change of the draft rebuilds the shadow tree. Replaying the slide
    // each time would read as the page reloading, so it plays only on the
    // render that first puts the editor on screen.
    const enter = this._themeEditEnter ? " is-entering" : "";
    this._themeEditEnter = false;
    const readonly = Boolean(draft.readonly);
    const editing = Boolean(draft.id) && !readonly;
    // The name is already the field right below the header, so the heading
    // says only which of the three things the card is doing.
    let titleKey = "settings_theme_view_heading";
    if (editing) titleKey = "settings_theme_edit_heading";
    else if (!readonly) titleKey = "settings_theme_new_title";
    const problem = readonly ? "" : this._themeNameProblem();
    // The header carries the way out, so the footer holds only the one thing
    // the card commits.
    const actions = readonly
      ? `<ha-button variant="brand" class="debug-btn theme-edit-copy">
            ${this._esc(this._t("settings_theme_copy"))}
          </ha-button>`
      : `<ha-button variant="brand" class="debug-btn theme-edit-save"
            ${this._themeSaveBlocked(problem) ? "disabled" : ""}>
            ${this._esc(this._t(editing ? "save" : "settings_theme_create"))}
          </ha-button>`;
    const close = `<ha-icon-button class="theme-edit-close"
            label="${this._esc(this._t("close"))}">
            <ha-icon icon="mdi:close" aria-hidden="true"></ha-icon>
          </ha-icon-button>`;
    const icon = readonly ? "mdi:eye-outline"
      : (editing ? "mdi:pencil-outline" : "mdi:plus-circle-outline");
    const head = readonly
      ? `<p class="config-field-hint theme-edit-readonly">${
        this._esc(this._t("settings_theme_readonly_hint"))}</p>`
      : `<div class="config-field">
            <ha-input appearance="outlined" id="liza-theme-name" class="theme-edit-name"
              label="${this._esc(this._t("settings_theme_name"))}"
              value="${this._esc(draft.name)}" autocomplete="off"></ha-input>
            <span class="config-field-hint" id="liza-theme-name-why">${
  problem
    ? `<b class="theme-edit-why">${this._esc(problem)}</b>`
    : this._esc(this._t("settings_theme_name_hint", { path: "/config/lizaip/themes" }))
}</span>
          </div>`;
    return `
      <ha-card outlined class="settings-card theme-editor-card${enter}">
        ${this._htmlSettingsCardHeader(icon, titleKey, close)}
        <div class="settings-body">
          ${head}
          ${this._htmlThemeEditColors(draft)}
          ${this._htmlThemeEditText(draft)}
          ${this._htmlThemeEditIcons(draft)}
          <div class="settings-actions settings-actions-end">
            ${actions}
          </div>
        </div>
      </ha-card>`;
  },

  /**
   * The Buttons card: the remote's press-behaviour switches.
   *
   * Both are off until asked for, and for the same reason -- a remote set up
   * before either existed must keep behaving exactly as it did. That makes the
   * row shape shared rather than coincidental, so it is written once.
   */
  _htmlSettingsButtonsCard() {
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlSettingsCardHeader("mdi:gesture-tap-button", "settings_buttons")}
        <div class="settings-body">
          <div class="settings-switch-list">
            ${this._htmlFeatureSwitch("longtouch", "settings_longtouch", "settings_longtouch_hint")}
            ${this._htmlFeatureSwitch("toggle", "settings_toggle", "settings_toggle_hint")}
          </div>
          ${this._htmlKeyRepeatFields()}
        </div>
      </ha-card>`;
  },

  /** What a held button would repeat at, as the fields and the demo read it. */
  _keyRepeatValues() {
    const current = this._textSettings?.settings?.key_repeat || {};
    const defaults = this._textSettings?.defaults?.key_repeat || {};
    return {
      delay_ms: Number(current.delay_ms ?? defaults.delay_ms ?? 400),
      rate: Number(current.rate ?? defaults.rate ?? 8),
    };
  },

  /**
   * How a button with key repeat repeats while it is held: the pause
   * before the first repeat, then how many presses a second. Empty when the
   * backend sends no limits for it.
   */
  _htmlKeyRepeatFields() {
    const limits = this._textSettings?.limits?.key_repeat;
    if (!limits) return "";
    const current = this._textSettings?.settings?.key_repeat || {};
    const defaults = this._textSettings?.defaults?.key_repeat || {};
    const field = (key, labelKey, unitKey) => {
      const id = `liza-settings-key-repeat-${key.replace(/_/g, "-")}`;
      const { min, max } = limits[key];
      return `
        <div class="config-field">
          <ha-input type="number" appearance="outlined" id="${id}" class="settings-step-input settings-key-repeat" data-key="${key}"
                    min="${min}" max="${max}" step="1" inputmode="numeric"
                    label="${this._esc(this._t(labelKey))}"
                    value="${this._esc(current[key] ?? defaults[key])}"
                    ${this._textSettingsBusy ? "disabled" : ""}><span slot="end" class="settings-step-unit">${this._esc(this._t(unitKey))}</span></ha-input>
        </div>`;
    };
    return `
      <h4 class="settings-subheading">${this._esc(this._t("settings_key_repeat"))}</h4>
      <div class="settings-field-row">
        ${field("delay_ms", "settings_key_repeat_delay", "unit_ms")}
        ${field("rate", "settings_key_repeat_rate", "unit_per_second")}
      </div>
      ${this._htmlKeyRepeatDemo()}
      <span class="config-field-hint" id="liza-settings-key-repeat-hint">${this._esc(this._t("settings_key_repeat_hint", {
        delay: defaults.delay_ms, rate: defaults.rate,
        delay_min: limits.delay_ms.min, delay_max: limits.delay_ms.max,
        rate_min: limits.rate.min, rate_max: limits.rate.max,
      }))}</span>`;
  },

  /**
   * A button that repeats at the configured delay and rate, so the two
   * numbers above it can be felt rather than guessed. Panel-local: it emits
   * dots, not presses, and the remote hears nothing.
   */
  _htmlKeyRepeatDemo() {
    return `
      <div class="settings-repeat-demo">
        <ha-button appearance="outlined" class="settings-repeat-btn">${this._esc(this._t("settings_key_repeat_demo"))}</ha-button>
        <div class="settings-repeat-pulses" aria-hidden="true"></div>
      </div>
      <span class="config-field-hint">${this._esc(this._t("settings_key_repeat_demo_hint"))}</span>`;
  },

  /**
   * One feature switch.
   *
   * The same row as the icon options below it: a checkbox and a toggle sitting
   * one card apart read as two different kinds of setting, when enabling long
   * touch and enabling the coloured icons are the same kind of decision.
   */
  _htmlFeatureSwitch(section, labelKey, hintKey) {
    const id = `liza-settings-${section}`;
    const hintId = `${id}-hint`;
    const labelId = `${id}-label`;
    return `
      <div class="settings-switch-row">
        <div class="settings-switch-text">
          <label id="${labelId}" for="${id}">${this._esc(this._t(labelKey))}</label>
          <span class="config-field-hint" id="${hintId}">${this._esc(this._t(hintKey))}</span>
        </div>
        <ha-switch id="${id}" class="settings-feature-switch" data-section="${section}"
                   ${this._featureEnabled(section) ? "checked" : ""}
                   ${this._textSettingsBusy ? "disabled" : ""}
                   aria-labelledby="${labelId}" aria-describedby="${hintId}"></ha-switch>
      </div>`;
  },

  /** Seconds as the slider shows them: "0.5 s", "2 s". */
  _formatInterval(ms) {
    return `${Number((ms / 1000).toFixed(1))} s`;
  },

  /**
   * The Variables card: how often a value that keeps changing is sent.
   * Variables are always read; empty when the backend sends no limits for the
   * interval.
   */
  _htmlSettingsVariablesCard() {
    const opts = this._iconOptions;
    const limits = opts?.limits?.variables_interval_ms;
    if (!limits) return "";
    const id = "liza-settings-variables-interval";
    const hintId = `${id}-hint`;
    const value = opts.variables_interval_ms ?? opts.defaults?.variables_interval_ms;
    const fallback = opts.defaults?.variables_interval_ms ?? 500;
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlSettingsCardHeader("mdi:code-braces", "settings_variables")}
        <div class="settings-body">
          <div class="settings-sample">
            <code class="settings-sample-source">${this._esc(VARIABLE_SAMPLE)}</code>
            <ha-icon class="settings-sample-arrow" icon="mdi:arrow-right" aria-hidden="true"></ha-icon>
            <span class="settings-sample-value">${this._esc(this._t("settings_variables_sample_value"))}</span>
          </div>
          <div class="config-field">
            <!-- ha-slider reads its own value out through valueFormatter, set
                 on wiring; the number beside it is for the eye. -->
            <div class="settings-step-input settings-range-input">
              <ha-slider id="${id}" class="settings-variables-interval"
                         label="${this._esc(this._t("settings_variables_interval"))}"
                         min="${limits.min}" max="${limits.max}" step="${limits.step || 100}"
                         value="${this._esc(value)}"
                         ${this._iconOptionsBusy ? "disabled" : ""}></ha-slider>
              <output class="settings-step-unit settings-range-value" for="${id}">${this._esc(this._formatInterval(value))}</output>
            </div>
            <span class="config-field-hint" id="${hintId}">${this._esc(this._t("settings_variables_interval_hint", {
              min: this._formatInterval(limits.min), max: this._formatInterval(limits.max),
              default: this._formatInterval(fallback),
            }))}</span>
          </div>
        </div>
      </ha-card>`;
  },

  /** Empty when the backend sends no limits, i.e. cannot save the step. */
  _htmlSettingsIconCard() {
    const opts = this._iconOptions;
    const limits = opts?.limits?.icon_fill_step;
    if (!limits) return "";
    const id = "liza-settings-icon-fill-step";
    const fillOn = opts.icon_fill_enabled === true;
    // The step only means something while the fill is drawn, so it is nested
    // under that switch and dimmed with it rather than sitting as a third
    // field of equal weight.
    const stepOff = fillOn ? "" : " is-off";
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlSettingsCardHeader("mdi:lightbulb-on-outline", "settings_icons")}
        <div class="settings-body">
          <div class="settings-switch-list">
            ${this._htmlIconSwitch("icon_color_enabled", "settings_icon_color_enabled", "settings_icon_color_enabled_hint")}
            ${this._htmlIconSwitch("icon_fill_enabled", "settings_icon_fill_enabled", "settings_icon_fill_enabled_hint")}
            <div class="settings-switch-detail${stepOff}">
              <div class="config-field">
                <ha-input type="number" appearance="outlined" id="${id}" class="settings-step-input settings-fill-step"
                          inputmode="numeric" step="1" min="${limits.min}" max="${limits.max}"
                          label="${this._esc(this._t("settings_fill_step"))}"
                          value="${this._esc(opts.icon_fill_step)}"
                          ${this._iconOptionsBusy || !fillOn ? "disabled" : ""}><span slot="end" class="settings-step-unit" aria-hidden="true">%</span></ha-input>
                <!-- Beside the field's column, not in its hint slot: the hint
                     is a sentence, and the field is only as wide as two digits. -->
                <span class="config-field-hint">${this._esc(this._t("settings_fill_step_hint", { min: limits.min, max: limits.max }))}</span>
              </div>
            </div>
          </div>
        </div>
      </ha-card>`;
  },

  /**
   * One of the two switches, which are independent of each other.
   *
   * A row rather than a `.config-field`, whose stacked label-above-input shape
   * is for inputs that fill the width and leaves a switch an orphan.
   */
  _htmlIconSwitch(key, labelKey, hintKey) {
    const id = `liza-settings-${key.replace(/_/g, "-")}`;
    const hintId = `${id}-hint`;
    const labelId = `${id}-label`;
    const on = this._iconOptions?.[key] === true;
    return `
      <div class="settings-switch-row">
        <div class="settings-switch-text">
          <label id="${labelId}" for="${id}">${this._esc(this._t(labelKey))}</label>
          <span class="config-field-hint" id="${hintId}">${this._esc(this._t(hintKey))}</span>
        </div>
        <ha-switch id="${id}" class="settings-icon-switch" data-key="${key}"
                   ${on ? "checked" : ""} ${this._iconOptionsBusy ? "disabled" : ""}
                   aria-labelledby="${labelId}" aria-describedby="${hintId}"></ha-switch>
      </div>`;
  },

  /**
   * How this panel draws, not how the remote behaves: every other card is a
   * device setting. Its header says so once, so no hint below has to.
   */
  _htmlSettingsEditorCard() {
    const id = "liza-settings-page-links";
    const hintId = `${id}-hint`;
    const labelId = `${id}-label`;
    const tipId = "liza-settings-button-tips";
    const tipHintId = `${tipId}-hint`;
    const tipLabelId = `${tipId}-label`;
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlSettingsCardHeader("mdi:monitor-edit", "settings_editor")}
        <div class="settings-body">
          <div class="settings-switch-list">
            <div class="settings-switch-row">
              <div class="settings-switch-text">
                <label id="${labelId}" for="${id}">${this._esc(this._t("settings_page_links"))}</label>
                <span class="config-field-hint" id="${hintId}">${this._esc(this._t("settings_page_links_hint"))}</span>
              </div>
              <ha-switch id="${id}" class="settings-pagelinks-switch"
                         ${this._pageLinksEnabled() ? "checked" : ""}
                         aria-labelledby="${labelId}" aria-describedby="${hintId}"></ha-switch>
            </div>
            <div class="settings-switch-row">
              <div class="settings-switch-text">
                <label id="${tipLabelId}" for="${tipId}">${this._esc(this._t("settings_button_tips"))}</label>
                <span class="config-field-hint" id="${tipHintId}">${this._esc(this._t("settings_button_tips_hint"))}</span>
              </div>
              <ha-switch id="${tipId}" class="settings-buttontips-switch"
                         ${this._buttonTipsEnabled() ? "checked" : ""}
                         aria-labelledby="${tipLabelId}" aria-describedby="${tipHintId}"></ha-switch>
            </div>
          </div>
        </div>
      </ha-card>`;
  },

  /**
   * One chip per group, acting as pages rather than jump links, and a box to
   * search every group at once. The row scrolls sideways on a narrow screen
   * instead of wrapping, so it stays one line and the group keeps its height.
   */
  _htmlSettingsNav() {
    const current = this._settingsGroup();
    const searching = this._settingsSearch() !== "";
    // While results are up no group is the one shown, so none is marked; the
    // remembered one is still what the tab group falls back to.
    const tab = (group) => `
        <ha-tab-group-tab slot="nav" panel="${group.id}" class="settings-chip" data-group="${group.id}"
                          id="liza-settings-chip-${group.id}"${!searching && group.id === current ? " active" : ""}>
          <ha-icon icon="${group.icon}" aria-hidden="true"></ha-icon>
          ${this._esc(this._t(group.label))}
        </ha-tab-group-tab>`;
    const placeholder = this._t("settings_search_placeholder");
    return `
      <div class="settings-bar">
        <ha-tab-group class="settings-nav" ${searching ? "" : `active="${current}"`}
                      aria-label="${this._esc(this._t("settings_groups"))}">
          ${SETTINGS_GROUPS.map(tab).join("")}
        </ha-tab-group>
        <ha-input-search appearance="outlined" class="settings-search settings-search-input"
                         value="${this._esc(this._settingsQuery || "")}"
                         placeholder="${this._esc(placeholder)}" accessible-label="${this._esc(placeholder)}"></ha-input-search>
      </div>`;
  },

  /** The chosen group's cards. The pressed chip names it, so no heading
      repeats that name underneath. */
  _htmlSettingsSection(group, cards) {
    return `
      <section class="settings-section" id="liza-settings-panel-${group.id}" role="region"
               aria-label="${this._esc(this._t(group.label))}" tabindex="-1">
        <div class="settings-section-cards">${cards}</div>
      </section>`;
  },

  /** What each group holds, one entry per card. A card with nothing to show
      returns an empty string, so the caller drops the blanks. */
  _settingsGroupCards(id) {
    if (id === "appearance") {
      // The editor opens beneath the picker, on the theme picked there. Both
      // share one grid cell, so a wide page cannot set the editor beside the
      // list it belongs to; the icon card keeps its own place next to them.
      const theme = this._htmlSettingsThemeCard();
      const icons = this._htmlSettingsIconCard();
      if (!this._themeEdit) return [theme, icons];
      return [`<div class="settings-card-stack">${theme}${this._htmlThemeEditorCard()}</div>`, icons];
    }
    if (id === "behaviour") {
      return [this._htmlSettingsButtonsCard(), this._htmlSettingsVariablesCard()];
    }
    if (id === "editor") return [this._htmlSettingsEditorCard()];
    return [this._htmlSettingsDeviceCard()];
  },

  /** Only the chosen group's cards are built. */
  _htmlSettingsGroupCards(id) {
    return this._settingsGroupCards(id).filter(Boolean).join("");
  },

  /** What is being searched for, trimmed and folded, or "" for no search. */
  _settingsSearch() {
    return typeof this._settingsQuery === "string" ? this._settingsQuery.trim().toLowerCase() : "";
  },

  /**
   * A card's own words. Taken from the markup it just produced rather than
   * from a list of keys kept beside it: a list would have to be remembered
   * every time a control is added, and would quietly stop finding it.
   */
  _settingsCardWords(html) {
    return html.replace(/<[^>]+>/g, " ").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").toLowerCase();
  },

  /**
   * The words of a search wrapped in a mark, in a card's text only. Splitting
   * on tags and entities keeps a word from landing inside an attribute or an
   * entity; option labels are skipped, where a mark would not be markup.
   */
  _settingsHighlight(html, words) {
    if (!words.length) return html;
    const rx = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
    let inOption = 0;
    return html.split(/(<[^>]+>|&[#\w]+;)/).map((part, i) => {
      if (i % 2) {
        if (/^<option\b/i.test(part)) inOption += 1;
        else if (/^<\/option>/i.test(part)) inOption = Math.max(0, inOption - 1);
        return part;
      }
      return inOption ? part : part.replace(rx, '<mark class="settings-hit">$&</mark>');
    }).join("");
  },

  /**
   * Every card that answers to *needle*, from all groups, as one grid. Each
   * word has to appear, in any order: "size font" finds the same card as
   * "font size", since a card's words are not read in the order it draws them.
   */
  _htmlSettingsResults(needle) {
    const words = needle.split(" ").filter(Boolean);
    const cards = SETTINGS_GROUPS
      .flatMap((group) => this._settingsGroupCards(group.id))
      .filter(Boolean)
      .filter((html) => {
        const text = this._settingsCardWords(html);
        return words.every((word) => text.includes(word));
      })
      .map((html) => this._settingsHighlight(html, words));
    if (!cards.length) {
      return `
        <section class="settings-section" aria-live="polite">
          <p class="hint-text">${this._esc(this._t("settings_search_none", { query: this._settingsQuery.trim() }))}</p>
        </section>`;
    }
    return `
      <section class="settings-section" aria-live="polite">
        <h2 class="settings-section-title">${this._esc(this._t("settings_search_results", { count: cards.length }))}</h2>
        <p class="settings-section-note">${this._esc(this._t("settings_search_note"))}</p>
        <div class="settings-section-cards">${cards.join("")}</div>
      </section>`;
  },

  _htmlSettingsView() {
    if (!this._textSettings) {
      const msg = this._textSettingsError
        ? `<p class="debug-error">${this._esc(this._textSettingsError)}</p>`
        : `<p class="hint-text">${this._esc(this._t("settings_loading"))}</p>`;
      return `<div class="settings-view">${msg}</div>`;
    }
    const needle = this._settingsSearch();
    const group = SETTINGS_GROUPS.find((g) => g.id === this._settingsGroup());
    const body = needle
      ? this._htmlSettingsResults(needle)
      : this._htmlSettingsSection(group, this._htmlSettingsGroupCards(group.id));
    return `
      <div class="settings-view">
        ${this._htmlSettingsNav()}
        ${body}
      </div>`;
  },

  /**
   * Run one guarded, busy-flagged backend call and report its failure.
   *
   * The three callers below were the same twenty lines three times over, and
   * the copies had already drifted: `_saveTextSettings` never repainted when
   * it raised its flag, even though two of its controls bind `disabled` to
   * that flag -- so during a save they stayed live, and a second click was
   * swallowed by the re-entry guard with no error and no trace. Repainting on
   * the way in is part of the contract here precisely so that cannot differ
   * between callers again.
   *
   * Returns whether *work* succeeded, for a caller that needs to know.
   */
  async _runBusy(flag, failedKey, work) {
    if (!this._currentEntry || this[flag]) return false;
    this[flag] = true;
    this._render();
    try {
      await work();
      return true;
    } catch (e) {
      this._toast(this._t(failedKey, { error: String(e?.message || e) }));
      return false;
    } finally {
      this[flag] = false;
      this._render();
    }
  },

  /**
   * Save *settings* and show what the backend stored.
   *
   * A refused save puts the stored settings back on screen: leaving the
   * rejected value in the field would show a setting the remote does not have.
   */
  async _saveTextSettings(settings) {
    return this._runBusy("_textSettingsBusy", "settings_save_failed", async () => {
      this._textSettings = await this._hass.callWS({
        type: "lizaip_config/set_settings", entry_id: this._currentEntry, settings,
      });
      this._toast(this._t("settings_saved"));
    });
  },

  /**
   * Save one or more icon options and redraw the previews in them.
   *
   * Like the text settings, a refused save puts the stored values back.
   */
  async _saveIconOptions(changes) {
    await this._runBusy("_iconOptionsBusy", "settings_save_failed", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/set_icon_options", entry_id: this._currentEntry, ...changes,
      });
      this._applyIconOptions(r);
      this._toast(this._t("settings_saved"));
    });
  },

  /** Pick the theme to look at. Nothing reaches the remote until Apply is
   * pressed, so themes can be browsed freely. The pick opens beneath the
   * list -- to edit when it is the user's own, else only to read -- and
   * replaces whatever was there, unsaved changes included. */
  _pickTheme(themeId) {
    const edit = this._themeEdit;
    const shown = Boolean(edit?.id) && edit.id === themeId;
    if (themeId === this._draftThemeId() && shown) return;
    this._themeDraft = themeId === this._storedThemeId() ? null : themeId;
    if (!shown && this._themeById(themeId)) {
      // The slide plays when the details first appear, not on every switch.
      this._themeEditEnter = !edit;
      this._setThemeDraft(this._themeEditorDraft(themeId));
      this._themeEditOpen = null;
    }
    this._render();
  },

  /** A pick never applied is dropped when its page is left, not sent. */
  /** The details below the list follow the pick, so they go with it -- unless
   * they hold unsaved edits, which are kept, and the pick with them so the
   * selected tile and the details still name the same theme. */
  _discardThemePick() {
    const edit = this._themeEdit;
    const pinned = Boolean(edit?.id) && edit.id !== this._storedThemeId();
    if (pinned && this._themeEditDirty()) return;
    if (pinned) this._setThemeDraft(null);
    this._themeDraft = null;
  },

  // ── Saving and removing a custom theme ───────────────────────────────

  /** Open the editor on a theme that does not exist yet, taking its values
   * from *startFrom* (`THEME_BLANK` for the standard look). It never carries
   * an id, so saving always writes a new file. */
  _newThemeEditor(startFrom = THEME_BLANK) {
    this._enterThemeEditor(this._themeEditSeed(startFrom, false));
  },

  /** What the editor holds for an installed theme: the user's own to change,
   * a shipped one only to read. */
  _themeEditorDraft(themeId) {
    const seed = this._themeEditSeed(themeId, true);
    return this._themeById(themeId)?.source === "user" ? seed : { ...seed, readonly: true };
  },

  /** The draft and what it opened with, always set together: closing tells
   * work apart from an untouched draft by comparing the two, and a new theme
   * has no file to fall back on. */
  _setThemeDraft(draft) {
    this._themeEdit = draft;
    this._themeEditOrigin = draft ? structuredClone(draft) : null;
  },

  _enterThemeEditor(draft) {
    this._setThemeDraft(draft);
    this._themeEditEnter = true;
    this._themeEditOpen = null;
    this._render();
  },

  /** Whether closing the editor would throw work away: the draft parted from
   * what it opened with, by name or by any facet. */
  _themeEditClosingLoses() {
    const draft = this._themeEdit;
    const origin = this._themeEditOrigin;
    if (!draft || draft.readonly || !origin) return false;
    if ((draft.name || "") !== (origin.name || "")) return true;
    return THEME_EDIT_FACETS.some((k) => !this._sameThemeValue(draft[k], origin[k]));
  },

  /** Close asks first when there is unsaved work, since the editor is the
   * only place that work exists. */
  async _askCloseThemeEditor() {
    if (this._themeEditClosingLoses() && !await this._confirmDestructive({
      title: this._t("settings_theme_close_confirm"),
      message: this._t("settings_theme_close_hint"),
      confirmText: this._t("settings_theme_close_discard"),
    })) return;
    this._closeThemeEditor();
  },

  /** One section at a time: three open at once is the wall of fields the
   * folding was meant to avoid. */
  _toggleThemeGroup(root, el) {
    const open = !el.open;
    if (open) {
      root.querySelectorAll("details[data-group][open]").forEach((other) => {
        if (other !== el) this._slideThemeGroup(other, false);
      });
    }
    this._themeEditOpen = open ? el.dataset.group : null;
    this._slideThemeGroup(el, open);
  },

  /** `<details>` snaps, which reads as the page jumping. The body is given a
   * height to travel instead, and only told it is shut once it has got there. */
  _slideThemeGroup(el, open) {
    const body = el.querySelector(".theme-edit-body");
    const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!body || still || typeof body.animate !== "function") {
      el.open = open;
      return;
    }
    el._slide?.cancel();
    el.open = true;
    const tall = `${body.scrollHeight}px`;
    const anim = body.animate(
      { height: open ? ["0px", tall] : [tall, "0px"], opacity: open ? [0, 1] : [1, 0] },
      { duration: 180, easing: "ease-out" });
    el._slide = anim;
    anim.onfinish = () => {
      el.open = open;
      el._slide = null;
    };
  },

  _closeThemeEditor() {
    this._setThemeDraft(null);
    this._themeEditEnter = false;
    this._render();
  },

  /** The draft as the backend wants it. Colour keys are left out when empty so
   * a theme that only moves its glyphs writes no `colors:` block at all. */
  _themeEditPayload() {
    const draft = this._themeEdit;
    const colors = {};
    const palette = draft.palette
      .map((s) => ({ ...s, name: String(s.name || "").trim().toLowerCase() }))
      .filter((s) => s.name);
    if (palette.length) colors.palette = palette;
    const states = Object.fromEntries(
      Object.entries(draft.states).filter(([, hex]) => hex));
    if (Object.keys(states).length) colors.states = states;
    const glyphs = {};
    for (const [domain, byState] of Object.entries(draft.glyphs || {})) {
      const kept = Object.fromEntries(
        Object.entries(byState).filter(([, icon]) => String(icon || "").trim()));
      if (Object.keys(kept).length) glyphs[domain] = kept;
    }
    return {
      id: draft.id || undefined,
      name: draft.name.trim(),
      colors,
      text: draft.text,
      icons: {
        ...structuredClone(draft.iconsKept || {}),
        ...(Object.keys(glyphs).length ? { domain_state_icons: glyphs } : {}),
      },
    };
  },

  /** Save the draft, then select it for preview. Applying it to the remote is
   * a separate choice on the theme picker. */
  async _saveThemeEdit() {
    if (this._themeEdit?.readonly || this._themeNameProblem()) return;
    // The picker stays live while the save is out: another tile or Create…
    // may have replaced the details by the time it lands, and those are not
    // the user's to lose.
    const saving = this._themeEdit;
    await this._runBusy("_themeEditBusy", "settings_theme_save_failed", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/save_theme", theme: this._themeEditPayload(),
      });
      if (this._textSettings) this._textSettings.themes = r.themes;
      if (this._themeEdit === saving) {
        this._setThemeDraft(null);
        this._themeDraft = r.id === this._storedThemeId() ? null : r.id;
      }
      this._forgetDeviceUrls();
      this._toast(this._t("settings_saved"));
    });
  },

  /** Confirm in the same modal used for page and action deletion. */
  async _askDeleteTheme(themeId) {
    const theme = this._themeById(themeId);
    if (theme?.source !== "user") return;
    const remoteText = this._pageTitle(this._pages?.[this._currentPageIdx]);
    const confirmed = await this._confirmDestructive({
      title: this._t("settings_theme_delete_confirm", { name: theme.name }),
      subtitle: remoteText
        ? this._t("settings_theme_delete_remote_text", { text: remoteText })
        : "",
      message: this._t("settings_theme_delete_hint"),
      confirmText: this._t("delete"),
    });
    if (!confirmed) return;
    this._setThemeDraft(null);
    await this._deleteTheme(themeId);
  },

  /** Removes a theme of the user's own. A remote still naming a deleted theme
   * falls back to the default look, and the picker follows. */
  async _deleteTheme(themeId) {
    if (!themeId) return;
    const wasOnScreen = this._draftThemeId() === themeId;
    await this._runBusy("_themeEditBusy", "settings_theme_save_failed", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/delete_theme", theme_id: themeId,
      });
      if (this._textSettings) this._textSettings.themes = r.themes;
      this._setThemeDraft(null);
      const gone = !(r.themes || []).some((t) => t.id === themeId);
      const fallback = wasOnScreen && gone ? THEME_DEFAULT : null;
      this._themeDraft = fallback === this._storedThemeId() ? null : fallback;
      this._forgetDeviceUrls();
      this._render();
      this._toast(this._t("settings_saved"));
    });
  },

  /** Save the picked theme and redraw everything that reads one. A remote's
   * own title and tooltip blocks are dropped with the pick: they would hide
   * the new theme's text under cards that are folded away. */
  async _applyTheme() {
    const current = this._textSettings?.settings;
    if (!current) return;
    const next = structuredClone(current);
    next.theme = this._draftThemeId();
    for (const kind of TEXT_KINDS) delete next[kind];
    const saved = await this._saveTextSettings(next);
    if (!saved) return;
    this._themeDraft = null;
    // The shipped glyph table never follows a theme, so only the themed one
    // is read again.
    await Promise.all([this._loadIconDefaults(false), this._loadPalette()]);
    this._render();
  },

  _changeTextSetting(kind, key, value) {
    const current = this._textSettings?.settings;
    if (!current) return;
    if (current[kind]?.[key] === value) return;
    const next = structuredClone(current);
    next[kind] = { ...next[kind], [key]: value };
    this._saveTextSettings(next);
  },

  /**
   * An action that changes the remote itself, not the stored configuration.
   * Drawn in the error colour: it is the only thing here that interrupts the
   * device, and a plain card would read as one more setting.
   */
  _htmlSettingsDeviceCard() {
    return `
      <ha-card outlined class="settings-card settings-danger-card">
        <div class="actions-card-header settings-card-header">
          <ha-icon class="settings-card-icon" icon="mdi:alert-outline" aria-hidden="true"></ha-icon>
          <h3 class="actions-card-title">${this._esc(this._t("settings_clear_pages"))}</h3>
        </div>
        <div class="settings-body">
          <p class="config-field-hint">${this._esc(this._t("settings_clear_pages_hint"))}</p>
          <div class="settings-actions">
            <ha-button appearance="outlined" variant="danger" class="debug-btn settings-danger-btn settings-clear-pages" ${this._clearPagesBusy ? "disabled" : ""}>
              ${this._esc(this._t(this._clearPagesBusy ? "settings_clear_pages_busy" : "settings_clear_pages"))}
            </ha-button>
          </div>
        </div>
      </ha-card>`;
  },

  /**
   * Wipe the remote's pages and rebuild them from the store.
   *
   * Confirmed first: it is a visible interruption on the device — the screen
   * empties and fills again — and a mis-click deserves a way out even though
   * no configuration is at risk.
   */
  async _clearDevicePages() {
    if (!this._currentEntry || this._clearPagesBusy) return;
    if (!window.confirm(this._t("settings_clear_pages_confirm"))) return;
    await this._runBusy("_clearPagesBusy", "settings_clear_pages_failed", async () => {
      await this._hass.callWS({
        type: "lizaip_config/clear_device_pages", entry_id: this._currentEntry,
      });
      this._toast(this._t("settings_clear_pages_done"));
    });
  },

  /** How far the diagnostics build has come, as a whole percent. */
  _diagnosticsPercent() {
    const job = this._diagJob;
    if (!job) return 0;
    if (job.state === "done") return 100;
    return job.total ? Math.round((job.index / job.total) * 100) : 0;
  },

  // Which heading each step belongs under. Twenty rows in one list reads as a
  // wall, and eight of them began "Remote:" -- a heading says it once. The
  // backend runs them in this order, so a group is always contiguous.
  _diagnosticsGroupFor(key) {
    if (key.startsWith("remote_") || key === "reachability" || key === "device") return "remote";
    if (key === "config" || key === "settings" || key === "config_files") return "configuration";
    if (key === "ha_log" || key === "system_log" || key === "traffic" || key === "debug") return "logs";
    return "homeassistant";
  },

  /** A step's name in the user's language, falling back to its key.
   *
   * The keys come from the backend, so an untranslated one still gets a row.
   */
  _diagnosticsStepLabel(key) {
    return this._t(`diagnostics_step_${key}`) || key;
  },

  /**
   * The ⋮ menu: a configuration out, a configuration back in, and the
   * diagnostics report, from one place on every screen. Not the user guide:
   * this menu is what is done *to a device*, and help is neither per-device
   * nor an action, so it is a toolbar button instead.
   *
   * `entryId` is passed rather than read from `_currentEntry`, because the
   * device list offers the same menu per row and no device is open there.
   *
   * While the diagnostics build runs, its item says so and reopens the window
   * instead of starting a second build nobody could watch.
   */
  _openDiagnosticsMenu(ev, entryId, anchor = null) {
    ev?.stopPropagation?.();
    const running = this._diagJob?.state === "running";
    const items = [
      {
        cls: "diag-menu-config",
        icon: this._configBusy ? "mdi:progress-download" : "mdi:download",
        label: this._configBusy
          ? `${this._t("diagnostics_scope_config")} — ${this._t("diagnostics_menu_busy")}`
          : this._t("diagnostics_scope_config"),
        run: () => this._downloadConfig(entryId),
      },
      {
        cls: "diag-menu-restore",
        // Nothing to open while one is being written: the window would only
        // refuse, so the row says why and cannot be pressed.
        disabled: !!this._restoreBusy,
        // Not an upload arrow: nothing is leaving. A configuration is coming
        // back in from a file the user downloaded earlier.
        icon: this._restoreBusy ? "mdi:progress-upload" : "mdi:backup-restore",
        label: this._restoreBusy
          ? `${this._t("restore_config")} — ${this._t("restore_running")}`
          : this._t("restore_config"),
        run: () => this._openRestoreDialog(entryId),
      },
      // Set apart from the pair above it: those two are a configuration going
      // out and coming back, this one is a report for support.
      { separator: true },
      {
        cls: "diag-menu-standard",
        // The arrow becomes the progress ring while the build runs: the item
        // is the only thing on screen once the window has been put away.
        icon: running ? "mdi:progress-download" : "mdi:download",
        label: running
          ? `${this._t("diagnostics_scope_standard")} — ${this._t("diagnostics_menu_running", {
              percent: this._diagnosticsPercent(),
            })}`
          : this._t("diagnostics_scope_standard"),
        run: () => (running ? this._openDiagnosticsDialog() : this._downloadDiagnostics(entryId)),
      },
    ];
    this._openMenu(ev, items, { keepCase: true, anchor: anchor || ev?.currentTarget });
  },

  /** The ⋮ button itself. One markup helper, used by the toolbar and the rows. */
  _htmlDiagnosticsMenuButton(entryId, cls = "") {
    const label = this._esc(this._t("overflow_menu"));
    return `<ha-icon-button class="diag-menu-btn ${cls}" data-entry="${this._esc(entryId || "")}"
                    aria-haspopup="menu" label="${label}">
              <ha-icon icon="mdi:dots-vertical" aria-hidden="true"></ha-icon>
            </ha-icon-button>`;
  },

  /** Wire every ⋮ in the current render. Safe to call when there are none. */
  _wireDiagnosticsMenus() {
    this.shadowRoot?.querySelectorAll(".diag-menu-btn").forEach((el) =>
      el.addEventListener("click", (ev) =>
        this._openDiagnosticsMenu(ev, el.dataset.entry || this._currentEntry, el)));
    this.shadowRoot?.querySelectorAll(".diag-pill").forEach((el) =>
      el.addEventListener("click", () => this._openDiagnosticsDialog()));
  },

  /**
   * The pill left behind when the window is dismissed mid-build.
   *
   * Closing the window does not cancel anything -- the build is a backend job
   * -- so the pill says it is still running and brings the window back.
   */
  _htmlDiagnosticsPill() {
    const job = this._diagJob;
    if (!job) return "";
    const name = this._t("diagnostics_scope_standard");
    const label = job.state === "running"
      ? `${name} ${this._diagnosticsPercent()}%`
      : `${name} — ${this._t("diagnostics_dialog_failed")}`;
    if (this._diagDialog) return "";
    return `<div class="diag-pills">
      <button type="button" class="diag-pill ${job.state}"
              aria-label="${this._esc(this._t("diagnostics_reopen"))}">
        <ha-icon icon="${job.state === "running" ? "mdi:progress-download" : "mdi:alert-circle-outline"}" aria-hidden="true"></ha-icon>
        <span>${this._esc(label)}</span>
      </button>
    </div>`;
  },

  /**
   * The configuration, straight to the browser.
   *
   * No window and no progress: this copies a handful of local YAML files and
   * is over before a dialog would have finished opening. A second click while
   * one is in flight is ignored rather than queued.
   */
  async _downloadConfig(entryId = null) {
    const entry = entryId || this._currentEntry;
    if (!entry || this._configBusy) return;
    this._configBusy = true;
    let unsub = null;
    try {
      const result = await new Promise((resolve, reject) => {
        this._hass.connection.subscribeMessage(
          // The command reports its steps to anyone who asks; nothing here is
          // watching them, so only the failure and the finished file matter.
          (ev) => {
            if (ev.event === "error") reject(new Error(ev.message));
            else if (ev.event !== "steps" && ev.event !== "progress") resolve(ev);
          },
          { type: "lizaip_config/build_diagnostics_bundle", entry_id: entry, scope: "config" },
        ).then((fn) => { unsub = fn; }, reject);
      });
      this._saveDiagnosticsFile(result);
      this._toast(this._t("diagnostics_config_done", { filename: result.filename }));
    } catch (e) {
      this._toast(this._t("diagnostics_failed", { error: String(e?.message || e) }));
    } finally {
      try { unsub?.(); } catch (_) { /* the socket may already be gone */ }
      this._configBusy = false;
    }
  },

  /**
   * Build the bundle on the backend and hand it to the browser.
   *
   * A subscription rather than a plain call, because the build spends most of
   * ten seconds on the remote's endpoints and names each step as it starts.
   * The final event carries a signed URL: a link the browser follows sends no
   * Authorization header, so an unsigned one would come back 401.
   */
  async _downloadDiagnostics(entryId = null) {
    const entry = entryId || this._currentEntry;
    if (!entry) return;
    // One build at a time. A second ask is a second click, not a second wish:
    // show what is already running rather than starting a twin. A job left
    // holding a failure is replaced -- that one is there to be read, and the
    // obvious next thing to do with it is to try again.
    if (this._diagJob?.state === "running") {
      this._openDiagnosticsDialog();
      return;
    }
    this._diagDialog?.dismiss();
    const job = { entry, state: "running", steps: [], step: "", index: 0, total: 0, done: [] };
    this._diagJob = job;
    this._render();
    this._openDiagnosticsDialog();

    let unsub = null;
    try {
      await new Promise((resolve, reject) => {
        this._hass.connection.subscribeMessage(
          (ev) => {
            if (ev.event === "steps") {
              job.steps = ev.steps || [];
              job.total = (ev.steps || []).length;
              this._updateDiagnosticsDialog();
              return;
            }
            if (ev.event === "progress") {
              // Every step before the running one is finished: the backend
              // announces a section as it starts, so arriving at one is the
              // only report the previous is done.
              job.done = (job.steps || []).slice(0, ev.index);
              job.step = ev.step;
              job.index = ev.index;
              job.total = ev.total;
              this._updateDiagnosticsDialog();
              return;
            }
            if (ev.event === "error") {
              reject(new Error(ev.message));
              return;
            }
            this._finishDiagnostics(ev);
            resolve();
          },
          { type: "lizaip_config/build_diagnostics_bundle", entry_id: entry, scope: "standard" },
        ).then((fn) => { unsub = fn; }, reject);
      });
    } catch (e) {
      const message = String(e?.message || e);
      if (this._diagJob === job) {
        job.state = "error";
        job.error = message;
      }
      this._toast(this._t("diagnostics_failed", { error: message }));
      this._updateDiagnosticsDialog();
    } finally {
      // The backend is done either way; the subscription only kept the channel
      // open for its events.
      try { unsub?.(); } catch (_) { /* the socket may already be gone */ }
      this._render();
    }
  },

  /** Hand the finished bundle to the browser and get out of the way.
   *
   * No finished state: the download has started by the time this returns, so
   * the toast names the file and the window closes. A failure stays up.
   */
  _finishDiagnostics(result) {
    this._saveDiagnosticsFile(result);
    const skipped = result.skipped?.length || 0;
    this._toast(skipped
      ? this._t("diagnostics_done_partial", { filename: result.filename, count: skipped })
      : this._t("diagnostics_done", { filename: result.filename }));
    this._diagJob = null;
    if (this._diagDialog) this._diagDialog.dismiss();
    else this._render();
  },

  /** Click an invisible anchor, which is what a download is in a browser. */
  _saveDiagnosticsFile(result) {
    const a = document.createElement("a");
    a.href = result.url;
    a.download = result.filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  /**
   * The progress window: one row per section, ticked off as they land.
   *
   * A dialog rather than a bar in a card, because the build outlives the
   * screen it was started from and the device list has no card to put one in.
   */
  _openDiagnosticsDialog() {
    const job = this._diagJob;
    if (!job || this._diagDialog) return;
    // Teardown hangs off `_openModal`'s own close rather than the `close`
    // event: that event also arrives when a render moves the dialog, and it
    // arrives a task late, so a window torn down by it stays on screen with
    // every button dead.
    const forget = () => {
      if (this._diagDialog?.dlg === dlg) this._diagDialog = null;
      // A failure that has been read is done with: leaving it behind would
      // leave a pill saying so with nothing left to say.
      if (this._diagJob?.state === "error") this._diagJob = null;
      // The pill only exists while the window does not, so putting the window
      // away has to repaint the screen behind it.
      this._render();
    };
    const { dlg, close } = this._openModal(
      `<div class="add-page-dialog diag-dialog" role="document">${this._htmlDiagnosticsDialogBody()}</div>`,
      {
        labelledBy: "diag-dialog-title",
        describedBy: "diag-dialog-hint",
        onClose: () => forget(),
      },
    );
    this._diagDialog = { dlg, dismiss: close };
    this._wireDiagnosticsDialog();
  },

  /** Repaint the window's contents without rebuilding the window.
   *
   * The node stays, so focus and scroll survive a step landing -- which
   * happens a dozen times in ten seconds.
   */
  _updateDiagnosticsDialog() {
    const card = this._diagDialog?.dlg?.querySelector?.(".diag-dialog");
    if (!card) {
      // No window, but the pill on the screen behind it is showing a
      // percentage that has just changed.
      const pill = this.shadowRoot?.querySelector(".diag-pill span");
      if (pill && this._diagJob?.state === "running") {
        pill.textContent = `${this._t("diagnostics_scope_standard")} ${this._diagnosticsPercent()}%`;
      }
      return;
    }
    card.innerHTML = this._htmlDiagnosticsDialogBody();
    this._wireDiagnosticsDialog();
  },

  _wireDiagnosticsDialog() {
    const card = this._diagDialog?.dlg?.querySelector?.(".diag-dialog");
    if (!card) return;
    card.querySelector(".diag-dialog-close")
      ?.addEventListener("click", () => this._diagDialog?.dismiss());
    // Same entry as the build that failed: a retry asks the same question
    // again, which is what a failure leaves open.
    const job = this._diagJob;
    card.querySelector(".diag-dialog-retry")
      ?.addEventListener("click", () => this._downloadDiagnostics(job?.entry));
  },

  /** What the window says: a title, the steps, and whatever came of it. */
  _htmlDiagnosticsDialogBody() {
    const job = this._diagJob;
    if (!job) return "";
    const title = job.state === "error"
      ? this._t("diagnostics_dialog_failed")
      : this._t("diagnostics_dialog_running");

    // Before the step list arrives there is nothing to draw but the title; a
    // single row saying "waiting" is more honest than eight empty ones.
    let group = null;
    const rows = (job.steps || []).map((key) => {
      const state = (job.done || []).includes(key) ? "done"
        : key === job.step ? "running" : "waiting";
      const mine = this._diagnosticsGroupFor(key);
      const heading = mine === group ? "" : `
        <li class="diag-group">${this._esc(this._t(`diagnostics_group_${mine}`) || mine)}</li>`;
      group = mine;
      return `${heading}
        <li class="diag-step ${state}">
          <span class="diag-step-mark" aria-hidden="true">${state === "done" ? "✓" : state === "running" ? "●" : "○"}</span>
          <span class="diag-step-label">${this._esc(this._diagnosticsStepLabel(key))}</span>
          <span class="diag-step-state">${this._esc(this._t(`diagnostics_step_${state}`))}</span>
        </li>`;
    }).join("");

    const footer = job.state === "error"
      ? `<p class="diag-dialog-error">${this._esc(job.error || "")}</p>`
      : `<p class="config-field-hint" id="diag-dialog-hint">${this._esc(this._t("diagnostics_dialog_hint"))}</p>`;

    // What the file will contain, said while it is being made rather than
    // after it has been mailed.
    const privacy = job.state === "error" ? "" : `
        <p class="config-field-hint diag-dialog-privacy">${this._esc(this._t("diagnostics_privacy"))}</p>`;

    return `
      <h2 class="add-page-dialog-title" id="diag-dialog-title">${this._esc(title)}</h2>
      <div class="diag-dialog-bar"><div style="width:${this._diagnosticsPercent()}%"></div></div>
      <ol class="diag-steps" aria-live="polite">${rows}</ol>
      ${footer}
      ${privacy}
      <div class="template-dialog-actions">
        ${job.state === "error" ? `
        <ha-button appearance="outlined" class="debug-btn diag-dialog-retry">
          ${this._esc(this._t("diagnostics_retry"))}
        </ha-button>` : ""}
        <ha-button variant="brand" class="debug-btn primary diag-dialog-close">
          ${this._esc(this._t(job.state === "running" ? "diagnostics_hide" : "close"))}
        </ha-button>
      </div>`;
  },

  /** The editor's fields write straight into the draft rather than re-rendering
   * on each keystroke: a redraw would take the caret out of whatever is being
   * typed into, and nothing here changes what the other fields offer. */
  /** What a folded section says it is set to is read off the draft, so a
   * change has to reach it without rebuilding the field being used. */
  _refreshThemeSummaries(root) {
    const draft = this._themeEdit;
    if (!draft) return;
    root.querySelectorAll("details[data-group]").forEach((el) => {
      const slot = el.querySelector(".theme-edit-value");
      if (slot) slot.innerHTML = this._themeEditSummary(el.dataset.group, draft);
    });
    this._refreshThemeSave(root);
  },

  /** Saving is offered only once there is something to save. The fields are
   * edited without a redraw, so the state is read off the draft here rather
   * than left to the next render. */
  _refreshThemeSave(root) {
    const el = root.querySelector?.(".theme-edit-save");
    if (el) el.disabled = this._themeSaveBlocked(this._themeNameProblem());
  },

  /** Relabel the whole row, not the one swatch that moved: a colour leaving a
   * word behind lets the swatch that shared it drop its *Dark* again. */
  _refreshPaletteLabels(root, draft) {
    const captions = this._paletteLabels(draft.palette.map((sw) => sw.hex));
    draft.palette.forEach((sw, i) => {
      const label = root.querySelector(`label[for="liza-theme-palette-${i}"]`);
      if (label) label.textContent = captions[i];
    });
  },

  _wireThemeEditor(root) {
    const draft = this._themeEdit;
    if (!draft) return;
    const name = root.querySelector(".theme-edit-name");
    const save = root.querySelector(".theme-edit-save");
    name?.addEventListener("input", () => {
      draft.name = name.value;
      draft.named = true;
      const problem = this._themeNameProblem();
      const why = root.querySelector("#liza-theme-name-why");
      if (why) {
        why.innerHTML = problem
          ? `<b class="theme-edit-why">${this._esc(problem)}</b>`
          : this._esc(this._t("settings_theme_name_hint", { path: "/config/lizaip/themes" }));
      }
      if (save) save.disabled = this._themeSaveBlocked(problem);
    });
    root.querySelectorAll(".theme-edit-swatch").forEach((el) => {
      const take = () => {
        const hex = el.value.replace("#", "").toUpperCase();
        const { scope, key } = el.dataset;
        if (scope === "palette") {
          draft.palette[Number(key)].hex = hex;
          this._refreshPaletteLabels(root, draft);
        }
        else if (scope === "states") draft.states[key] = hex;
      };
      // Dragging the picker fires "input" by the dozen: the summaries follow
      // along, and the rest of the editor is rebuilt once it is let go.
      el.addEventListener("input", () => { take(); this._refreshThemeSummaries(root); });
      el.addEventListener("change", () => { take(); this._render(); });
    });
    root.querySelectorAll(".theme-edit-font").forEach((el) => {
      const kind = el.dataset.kind;
      el.options = this._htmlSettingsFontOptions(draft.text[kind]?.font);
      el.value = draft.text[kind]?.font;
      el.addEventListener("selected", (ev) => {
        const value = ev.detail?.value;
        if (!value) return;
        // ha-select reports the pick and leaves showing it to its owner.
        el.value = value;
        draft.text[kind] = { ...draft.text[kind], font: value };
        this._refreshThemeSummaries(root);
      });
    });
    root.querySelectorAll(".theme-edit-size").forEach((el) =>
      el.addEventListener("change", () => {
        const size = Number.parseInt(el.value, 10);
        // An emptied box means "leave it alone", not "no size": sending
        // nothing makes the backend refuse the whole save over one field.
        if (!Number.isFinite(size)) {
          el.value = draft.text[el.dataset.kind]?.font_size ?? "";
          return;
        }
        draft.text[el.dataset.kind] = {
          ...draft.text[el.dataset.kind],
          font_size: size,
        };
        this._refreshThemeSummaries(root);
      }));
    root.querySelectorAll(".theme-edit-glyphs .icon-picker-slot").forEach((slot) => {
      const { domain, state, tint } = slot.dataset;
      const fallback = this._themeGlyphFallback(domain, state);
      const preview = slot.closest?.(".icon-picker-row")?.querySelector?.(".icon-preview");
      const show = (icon) => {
        if (preview) preview.innerHTML = this._configImagePreviewHtml(icon || fallback, fallback, tint, null);
      };
      const input = this._mountIconPicker(slot, draft.glyphs?.[domain]?.[state] || fallback, (value) => {
        // The shipped glyph, or nothing, is no override: the file keeps only
        // what the theme changes, and the field shows the shipped one again.
        const own = value && value !== fallback ? value : "";
        const glyphs = ((draft.glyphs ||= {})[domain] ||= {});
        if (own) glyphs[state] = own;
        else delete glyphs[state];
        if (!value && input) input.value = fallback;
        show(own);
        this._refreshThemeSummaries(root);
      });
      // The picture follows the typing, a beat behind it so a half-typed
      // name is not drawn as a blank on every key.
      let wait = null;
      input?.addEventListener("input", () => {
        clearTimeout(wait);
        wait = setTimeout(() => show(input.value.trim()), 250);
      });
    });
    root.querySelectorAll(".theme-edit-close").forEach((el) =>
      el.addEventListener("click", () => this._askCloseThemeEditor()));
    root.querySelector(".theme-edit-copy")?.addEventListener(
      "click", () => this._newThemeEditor(this._themeEdit?.id));
    save?.addEventListener("click", () => this._saveThemeEdit());
  },

  _wireSettingsView() {
    const root = this.shadowRoot;
    root.querySelectorAll(".settings-feature-switch").forEach((el) =>
      el.addEventListener("change", (ev) =>
        this._changeTextSetting(el.dataset.section, "enabled", ev.target.checked)));
    root.querySelectorAll("details[data-group] > summary").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this._toggleThemeGroup(root, el.parentElement);
      }));
    root.querySelectorAll(".theme-preset[data-preset], .theme-preset-add, .theme-preset-mix")
      .forEach((el) => {
        // The icon sits inside the tile so the pair reads as one control;
        // it has to claim the click before the tile acts on it.
        const act = (ev) => {
          const icon = ev.target.closest?.(".theme-preset-edit");
          if (icon?.dataset.delete) this._askDeleteTheme(icon.dataset.delete);
          else if (icon?.dataset.download) this._downloadTheme(icon.dataset.download);
          else if (el.dataset.preset) this._pickTheme(el.dataset.preset);
          else if (!el.hasAttribute("data-mix")) this._newThemeEditor(THEME_BLANK);
        };
      el.addEventListener("click", act);
      // A span with `role="button"` gets no click from the keyboard, and
      // these icons are the only way into the editor.
      el.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        if (!ev.target.closest?.(".theme-preset-edit")) return;
        ev.preventDefault();
        ev.stopPropagation();
        act(ev);
      });
    });
    root.querySelector(".theme-apply")?.addEventListener("click", () => this._applyTheme());
    // The Add tile is also where a theme file is dropped to be added.
    root.querySelectorAll(".theme-preset-add").forEach((el) => this._wireThemeDrop(el));
    // Any theme tile, the leftover mix included, can be dragged there to copy it.
    root.querySelectorAll(".theme-preset[data-preset]").forEach((el) =>
      this._wireThemeDrag(el, el.dataset.preset));
    root.querySelectorAll(".theme-preset-mix").forEach((el) =>
      this._wireThemeDrag(el, this._storedThemeId()));
    this._wireThemeEditor(root);
    // "change", not "input", for the same reason as the font size.
    root.querySelectorAll(".settings-key-repeat").forEach((el) =>
      el.addEventListener("change", () => {
        const key = el.dataset.key;
        const value = Number(el.value);
        const { min, max } = this._textSettings?.limits?.key_repeat?.[key] || {};
        if (!Number.isInteger(value) || value < min || value > max) {
          this._toast(this._t("settings_key_repeat_out_of_range", { min, max }));
          this._render();
          return;
        }
        this._changeTextSetting("key_repeat", key, value);
      }));
    root.querySelector(".settings-fill-step")?.addEventListener("change", (ev) => {
      const el = ev.currentTarget;
      const value = Number(el.value);
      const limits = this._iconOptions?.limits?.icon_fill_step || {};
      if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
        this._toast(this._t("settings_fill_step_hint", { min: limits.min, max: limits.max }));
        this._render();
        return;
      }
      if (value === this._iconOptions?.icon_fill_step) return;
      this._saveIconOptions({ icon_fill_step: value });
    });
    const interval = root.querySelector(".settings-variables-interval");
    // Dragging only moves the number beside it; letting go saves.
    if (interval) interval.valueFormatter = (v) => this._formatInterval(Number(v));
    interval?.addEventListener("input", (ev) => {
      const el = ev.currentTarget;
      const text = this._formatInterval(Number(el.value));
      const out = el.parentElement?.querySelector(".settings-range-value");
      if (out) out.textContent = text;
    });
    interval?.addEventListener("change", (ev) => {
      const value = Number(ev.currentTarget.value);
      if (!Number.isInteger(value) || value === this._iconOptions?.variables_interval_ms) return;
      this._saveIconOptions({ variables_interval_ms: value });
    });
    root.querySelectorAll(".settings-icon-switch").forEach((el) =>
      el.addEventListener("change", () =>
        this._saveIconOptions({ [el.dataset.key]: el.checked === true })));
    // Local to the browser, so nothing is saved to the backend and there is no
    // busy state to wait on or failure to report.
    root.querySelector(".settings-pagelinks-switch")?.addEventListener("change", (ev) =>
      this._setPageLinksEnabled(ev.currentTarget.checked === true));
    root.querySelector(".settings-buttontips-switch")?.addEventListener("change", (ev) =>
      this._setButtonTipsEnabled(ev.currentTarget.checked === true));
    // `ha-switch` is not a native input, so `<label for>` does not reach it.
    // `preventDefault` so that a browser which *does* forward the click cannot
    // toggle the switch as well and have the two handlers undo each other.
    // Every switch in the tab shares this label, so what the click means is
    // read off the switch rather than off the row it was found in -- by class,
    // because that is what each kind has and `dataset` is not: the page-links
    // switch carries neither `data-section` nor `data-key`, so an `else` on
    // those two sent `{ undefined: ... }` to the icon-options endpoint.
    root.querySelectorAll(".settings-switch-text label").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const sw = root.querySelector(`#${el.getAttribute("for")}`);
        if (!sw || sw.disabled) return;
        const next = !sw.checked;
        if (sw.classList.contains("settings-pagelinks-switch")) {
          // Nothing re-renders this one from a stored value -- the preference
          // is browser-local and the view is not rebuilt for it -- so the
          // control is moved here or it does not move at all.
          sw.checked = next;
          this._setPageLinksEnabled(next);
        } else if (sw.classList.contains("settings-buttontips-switch")) {
          sw.checked = next;
          this._setButtonTipsEnabled(next);
        } else if (sw.classList.contains("settings-feature-switch")) {
          this._changeTextSetting(sw.dataset.section, "enabled", next);
        } else if (sw.classList.contains("settings-icon-switch")) {
          this._saveIconOptions({ [sw.dataset.key]: next });
        }
      }));
    root.querySelector(".settings-clear-pages")?.addEventListener(
      "click", () => this._clearDevicePages());
    this._wireSettingsNav(root);
    this._wireSettingsDemos(root);
  },

  /** Chips move the page; a11y.js already moves between them with the arrows. */
  _wireSettingsNav(root) {
    // A click as well as the tab group's own event: re-pressing the shown
    // group while results are up has to leave the search, and the group does
    // not announce a tab that is already its active one.
    root.querySelector(".settings-nav")?.addEventListener("wa-tab-show", (ev) =>
      this._setSettingsGroup(ev.detail?.name));
    root.querySelectorAll(".settings-chip").forEach((el) =>
      el.addEventListener("click", () => this._setSettingsGroup(el.dataset.group)));
    this._wireSettingsSearch(root);
  },

  /**
   * The search box. Every keystroke repaints the whole view, which destroys
   * the box being typed into, so the caret is put back -- but only for a
   * repaint the box asked for, or a switch in the results would lose focus.
   */
  _wireSettingsSearch(root) {
    const search = root.querySelector(".settings-search-input");
    if (!search) return;
    const show = (value, caret = value.length) => {
      this._settingsQuery = value;
      this._settingsSearchTyping = true;
      this._settingsSearchCaret = caret;
      this._render();
    };
    // ha-input-search does not expose the caret, so it is put back at the end
    // -- which is where it is while typing.
    search.addEventListener("input", (ev) => show(ev.currentTarget.value ?? ""));
    search.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !this._settingsQuery) return;
      ev.preventDefault();
      show("");
    });
    if (!this._settingsSearchTyping) return;
    this._settingsSearchTyping = false;
    // The field is a fresh element after the repaint and draws its native
    // input a frame later, so focus waits for that.
    const at = Math.min(this._settingsSearchCaret ?? Infinity, (search.value ?? "").length);
    Promise.resolve(search.updateComplete).then(() => {
      search.focus();
      try { search.setSelectionRange?.(at, at); } catch (e) { /* Not every input allows it. */ }
    });
  },

  /** The repeat demo. It is drawn here only; it never reaches the remote. */
  _wireSettingsDemos(root) {
    const btn = root.querySelector(".settings-repeat-btn");
    const pulses = root.querySelector(".settings-repeat-pulses");
    const stop = () => this._stopSettingsDemos();
    stop();
    if (!btn || !pulses) return;
    const pulse = () => {
      const dot = document.createElement("span");
      dot.className = "settings-repeat-pulse";
      pulses.appendChild(dot);
      if (pulses.children.length > 24) pulses.firstChild?.remove();
    };
    // The timeout pulses before it hands over, or the first repeat would land
    // a whole interval after the delay the card is demonstrating.
    const start = () => {
      stop();
      pulses.textContent = "";
      pulse();
      const { delay_ms: delay, rate } = this._keyRepeatValues();
      this._repeatDemoDelay = setTimeout(() => {
        pulse();
        this._repeatDemoTimer = setInterval(pulse, 1000 / Math.max(1, rate));
      }, delay);
    };
    btn.addEventListener("pointerdown", (ev) => { ev.preventDefault(); start(); });
    // A held Space or Enter is the same gesture, and the native click the key
    // would otherwise fire is a press with no release to stop it.
    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      if (!ev.repeat) start();
    });
    btn.addEventListener("keyup", (ev) => {
      if (ev.key === " " || ev.key === "Enter") stop();
    });
    // focusout as well as blur: the focus sits in ha-button's shadow root, and
    // leaving that is announced to the host as focusout.
    ["pointerup", "pointerleave", "pointercancel", "blur", "focusout"].forEach((type) => btn.addEventListener(type, stop));
  },

  /**
   * Kept on the panel, not in a closure: a repaint, a tab change or a teardown
   * while the button is held detaches it, and the release that would have
   * stopped the timers never arrives.
   */
  _stopSettingsDemos() {
    clearTimeout(this._repeatDemoDelay);
    clearInterval(this._repeatDemoTimer);
    this._repeatDemoDelay = null;
    this._repeatDemoTimer = null;
  },
};
