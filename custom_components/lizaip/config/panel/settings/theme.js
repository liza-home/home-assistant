/**
 * lizaIP Panel — Settings View: the theme picker and the custom theme editor.
 *
 * One slice of `SettingsViewMixin`, composed in `lizaip-settings-view.js`, so
 * these methods run with `this` bound to the panel element.
 */

import { INACTIVE_STATES } from "../lizaip-helpers.js";
import { EMOJI_AUTO } from "./fonts.js";

const TEXT_KINDS = ["title", "tooltip"];

// The three axes a theme file describes. A remote picks one theme for all
// three; the facets survive only as building blocks inside the custom editor,
// and as the shape a remote set up before that may still hold.
const FACETS = ["colors", "text", "icons"];
export const THEME_DEFAULT = "default";
// "Start from nothing": the draft still opens on the standard look, so every
// field is there and the theme saves, but it belongs to no other theme.
export const THEME_BLANK = "";
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

// What the editor offers a glyph pair for: the four domains whose two states
// differ at a glance. The active state comes first in every pair, so each
// column holds one state colour -- and a lock counts as active when unlocked.
const THEME_EDIT_DOMAINS = [
  { domain: "light", states: ["on", "off"] },
  { domain: "switch", states: ["on", "off"] },
  { domain: "fan", states: ["on", "off"] },
  { domain: "lock", states: ["unlocked", "locked"] },
];

export const SettingsThemeMixin = {
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
      const { src, key } = this._deviceImg(icon, "tile", color, opts);
      return `<img class="theme-tile" ${src ? `src="${this._esc(src)}"` : ""}
        data-dev-key="${this._esc(key)}" data-keep-mode alt=""
        title="${this._esc(label)}">`;
    };
    // Each strip at the remote's own pixel size -- title 200x50, tooltip
    // 200x40 -- centred in the 240x60 frame the remote gives it, so what is
    // previewed is the size it is seen at, not a stretched copy.
    const strip = (kind) => {
      const sample = this._t(kind === "title" ? "settings_sample_title" : "settings_sample_tooltip");
      const { src, key } = this._deviceImg(`text:${sample}`, kind, "", opts);
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

  _themeById(id) {
    const themes = this._textSettings?.themes || [];
    return themes.find((t) => t.id === id);
  },

  /** The theme on screen, read as one. An id naming parts rather than a file
   * is a leftover mix, resolved part by part the way the backend reads it. */
  _storedTheme() {
    const id = this._storedThemeId();
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
    // Downloading a theme is open to anyone; the shared library itself is an
    // administrator's to change.
    if (theme.source !== "user" || !this._isAdmin?.()) return download;
    return download + this._htmlPresetIcon("data-delete", id, "mdi:trash-can-outline",
      "settings_theme_delete", " theme-preset-delete");
  },

  /** The mix a remote set up before this picker was simplified still draws
   * with. It has no file to be re-picked by, but it is shown so the screen
   * tells the truth, and dragging it onto Create… lifts it into a theme of
   * its own. */
  _htmlMixTile() {
    const mix = this._storedTheme();
    if (!mix) return "";
    const on = !(this._themeEdit && !this._themeEdit.id);
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
    // theme the remote is on stays put but is not shown as chosen.
    const creating = Boolean(this._themeEdit) && !this._themeEdit.id;
    const chosen = creating ? null : this._storedThemeId();
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
    if (!this._isAdmin?.()) return `${this._storedIsMix() ? this._htmlMixTile() : ""}${buttons}`;
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

  /** The Theme card: pick one look and the remote draws with it at once.
   * Mixing parts is what the custom editor is for. The tile row opens the
   * card under its own title, so it carries no heading or rule of its own.
   * Every tile is drawn as the screen it gives, so there is no separate
   * result to look at. */
  _htmlSettingsThemeCard() {
    const themes = this._textSettings?.themes || [];
    if (!themes.length) return "";
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlCardHeader("settings_theme", { icon: "mdi:palette-outline", level: 3 })}
        <div class="settings-body">
          <div class="theme-presets">
            <div class="theme-preset-row">${this._htmlPresetButtons()}</div>
          </div>
        </div>
      </ha-card>`;
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
      text: {
        ...Object.fromEntries(
          TEXT_KINDS.map((kind) => [kind, { ...(seed.text?.[kind] || {}) }])),
        // "" lets imgserv find one; "none" draws emoji in the text font.
        emoji: { font: seed.text?.emoji?.font || "" },
      },
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

  /** A facet's section of the editor: what it is called, what it is set to
   * now, and the controls that set it by hand. Folded shut so the editor
   * opens as a page rather than a wall. */
  _htmlThemeEditGroup(facet, labelKey, body, icon) {
    const open = this._themeEditOpen === facet;
    return `
      <ha-expansion-panel class="theme-edit-group" data-group="${this._esc(facet)}" outlined${open ? " expanded" : ""}>
        <ha-icon slot="leading-icon" class="theme-edit-lead" icon="${this._esc(icon)}" aria-hidden="true"></ha-icon>
        <span slot="header" class="theme-edit-head">
          <span class="theme-facet-label">${this._esc(this._t(labelKey))}</span>
        </span>
        <div class="theme-edit-body"><div class="theme-edit-slot"${
  this._themeEdit?.readonly ? " inert" : ""}>${body}</div></div>
      </ha-expansion-panel>`;
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

  /** Under Colours: what a tile is tinted with by itself. One block, so it
   * carries no heading of its own -- the section is already named. */
  _htmlThemeEditColors(draft) {
    const states = THEME_STATE_COLORS
      .map((s) => this._htmlThemeEditColor(
        this._t(`settings_theme_state_${s}`), "states", s, draft.states[s])).join("");
    const body = `
      <div class="theme-edit-block">
        <span class="config-field-hint">${this._esc(this._t("settings_theme_states_hint"))}</span>
        <div class="theme-edit-colors">${states}</div>
      </div>`;
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
            <ha-select id="${fontId}" class="theme-edit-font" data-kind="${kind}"
              label="${this._esc(this._t(kind === "title" ? "settings_title" : "settings_tooltip"))}"${this._haSelectAttrs(
                this._htmlSettingsFontOptions(style.font), style.font)}></ha-select>
          </div>
          <div class="config-field">
            <ha-input type="number" appearance="outlined" id="${sizeId}" class="settings-step-input theme-edit-size" data-kind="${kind}"
              inputmode="numeric" step="1" min="${limits.min ?? ""}" max="${limits.max ?? ""}"
              label="${this._esc(this._t("settings_font_size"))}"
              value="${this._esc(style.font_size ?? "")}"></ha-input>
          </div>
        </div>`;
    }).join("");
    const fontsPath = { path: "/config/www/fonts" };
    // Only while there is an emoji font to pick, or the theme names one:
    // Automatic and None alone are no choice worth a field.
    const hasEmojiFont = (this._textSettings?.fonts || []).some((f) => f.emoji)
      || !!draft.text?.emoji?.font;
    const emojiFont = draft.text?.emoji?.font || "";
    // ha-select shows nothing for an empty value, so "find one" has a name.
    const emojiRow = !hasEmojiFont ? "" : `
        <div class="settings-field-row">
          <div class="config-field">
            <ha-select id="liza-theme-emoji" class="theme-edit-emoji"
              label="${this._esc(this._t("settings_emoji_font"))}"${this._haSelectAttrs(
                this._htmlEmojiFontOptions(emojiFont), emojiFont || EMOJI_AUTO)}></ha-select>
          </div>
        </div>`;
    const body = `${rows}${emojiRow}
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
        ${this._htmlCardHeader(titleKey, { icon, action: close, level: 3 })}
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

  /** Pick a theme: the remote is given it at once. The pick also opens
   * beneath the list -- to edit when it is the user's own, else only to
   * read -- and replaces whatever was there, unsaved changes included. */
  async _pickTheme(themeId) {
    const edit = this._themeEdit;
    const shown = Boolean(edit?.id) && edit.id === themeId;
    if (!shown && this._themeById(themeId)) {
      // The slide plays when the details first appear, not on every switch.
      this._themeEditEnter = !edit;
      this._setThemeDraft(this._themeEditorDraft(themeId));
      this._themeEditOpen = null;
    }
    this._render();
    if (themeId !== this._storedThemeId()) await this._applyTheme(themeId);
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
   * folding was meant to avoid. The expansion panel animates itself. */
  _themeGroupToggled(root, el, open) {
    if (open) {
      root.querySelectorAll("ha-expansion-panel[data-group]").forEach((other) => {
        if (other !== el && other.expanded) other.expanded = false;
      });
      this._themeEditOpen = el.dataset.group;
    } else if (this._themeEditOpen === el.dataset.group) {
      this._themeEditOpen = null;
    }
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

  /** Save the draft and give the remote the theme it just wrote. */
  async _saveThemeEdit() {
    if (this._themeEdit?.readonly || this._themeNameProblem()) return;
    // The picker stays live while the save is out: another tile or Create…
    // may have replaced the details by the time it lands, and those are not
    // the user's to lose. The remote may have been swapped too, and the theme
    // belongs to the one it was saved from.
    const saving = this._themeEdit;
    const entry = this._currentEntry;
    let savedId = null;
    await this._runBusy("_themeEditBusy", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/save_theme", theme: this._themeEditPayload(),
      });
      if (this._textSettings) this._textSettings.themes = r.themes;
      if (this._themeEdit === saving) this._setThemeDraft(null);
      savedId = r.id;
      this._forgetDeviceUrls();
      this._toast(this._t("settings_saved"));
    }, { toast: "settings_theme_save_failed" });
    if (!savedId || this._currentEntry !== entry) return;
    if (savedId !== this._storedThemeId()) await this._applyTheme(savedId);
    else await this._rereadSettings();
  },

  /** The remote's resolved settings again, editor state untouched. The theme
   * supplies the title and tooltip text and the default glyphs and colours,
   * so rewriting the theme the remote is already on changes all three. */
  async _rereadSettings() {
    try {
      this._textSettings = await this._hass.callWS({
        type: "lizaip_config/get_settings", entry_id: this._currentEntry,
      });
      this._ensureFontFaces(this._textSettings?.fonts);
    } catch {
      return;
    }
    await this._loadIconDefaults(false);
    this._render();
  },

  /** Confirm in the same modal used for page and action deletion. */
  async _askDeleteTheme(themeId) {
    const theme = this._themeById(themeId);
    if (theme?.source !== "user") return;
    // No subtitle: the open page's title has nothing to do with the theme,
    // whose name the title already carries.
    const confirmed = await this._confirmDestructive({
      title: this._t("settings_theme_delete_confirm", { name: theme.name }),
      message: this._t("settings_theme_delete_hint"),
      confirmText: this._t("delete"),
    });
    if (!confirmed) return;
    this._setThemeDraft(null);
    await this._deleteTheme(themeId);
  },

  /** Removes a theme of the user's own. A remote still on the deleted theme
   * is written back to the default look, which is what it now draws with. */
  async _deleteTheme(themeId) {
    if (!themeId) return;
    const entry = this._currentEntry;
    let gone = false;
    await this._runBusy("_themeEditBusy", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/delete_theme", theme_id: themeId,
      });
      if (this._textSettings) this._textSettings.themes = r.themes;
      this._setThemeDraft(null);
      gone = !(r.themes || []).some((t) => t.id === themeId);
      this._forgetDeviceUrls();
      this._render();
      this._toast(this._t("settings_saved"));
    }, { toast: "settings_theme_save_failed" });
    // Asked again now the reply is in: the remote may have been given another
    // theme, or swapped altogether, while the deletion was out.
    if (!gone || this._currentEntry !== entry) return;
    if (this._storedThemeId() === themeId) await this._applyTheme(THEME_DEFAULT);
  },

  /** Give the remote a theme and redraw everything that reads one. The title
   * and tooltip text is the theme's, so the save carries nothing about it.
   * A pick made while an earlier one is still out is kept and sent after it,
   * because the tiles stay live and a click must not vanish. */
  async _applyTheme(themeId) {
    if (!themeId || !this._textSettings?.settings) return;
    if (this._textSettingsBusy) { this._themeWanted = themeId; return; }
    for (let wanted = themeId; wanted; ) {
      this._themeWanted = null;
      const current = this._textSettings?.settings;
      if (!current) return;
      const next = structuredClone(current);
      next.theme = wanted;
      for (const kind of TEXT_KINDS) delete next[kind];
      const saved = await this._saveTextSettings(next);
      if (!saved) return;
      // The shipped glyph table never follows a theme, so only the themed one
      // is read again.
      await this._loadIconDefaults(false);
      this._render();
      // A pick that arrived meanwhile is sent too, unless the remote has it.
      wanted = this._themeWanted;
      if (wanted === this._storedThemeId()) wanted = null;
    }
  },

  /** Saving is offered only once there is something to save. The fields are
   * edited without a redraw, so the state is read off the draft here rather
   * than left to the next render. */
  _refreshThemeSave(root) {
    const el = root.querySelector?.(".theme-edit-save");
    if (el) el.disabled = this._themeSaveBlocked(this._themeNameProblem());
  },

  /** The editor's fields write straight into the draft rather than re-rendering
   * on each keystroke: a redraw would take the caret out of whatever is being
   * typed into, and nothing here changes what the other fields offer. */
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
        if (scope === "states") draft.states[key] = hex;
      };
      // Dragging the picker fires "input" by the dozen: Save follows along,
      // and the rest of the editor is rebuilt once it is let go.
      el.addEventListener("input", () => { take(); this._refreshThemeSave(root); });
      el.addEventListener("change", () => { take(); this._render(); });
    });
    root.querySelectorAll(".theme-edit-font").forEach((el) => {
      const kind = el.dataset.kind;
      this._wireHaSelect(el, (value) => {
        draft.text[kind] = { ...draft.text[kind], font: value };
        this._refreshThemeSave(root);
      });
      this._wireFontPreview(el);
    });
    root.querySelectorAll(".theme-edit-emoji").forEach((el) => {
      this._wireHaSelect(el, (value) => {
        draft.text.emoji = { font: value === EMOJI_AUTO ? "" : value };
        this._refreshThemeSave(root);
      });
      this._wireFontPreview(el);
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
        this._refreshThemeSave(root);
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
        this._refreshThemeSave(root);
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
};
