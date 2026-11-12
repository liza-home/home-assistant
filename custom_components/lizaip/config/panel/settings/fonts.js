/**
 * lizaIP Panel — Settings View: the font pickers, their previews, and the Fontbook group.
 *
 * One slice of `SettingsViewMixin`, composed in `lizaip-settings-view.js`, so
 * these methods run with `this` bound to the panel element.
 */

// The font picker draws every name in the font it names. The @font-face rules
// that makes possible live in one document-level <style>: a shadow root's are
// ignored by the browser, so they cannot join the panel's own stylesheet.
const FONT_FACE_STYLE_ID = "liza-font-faces";

// The emoji picker's two choices that are no font: imgserv's own pick (stored
// as no setting at all) and none, emoji drawn in the text font.
export const EMOJI_AUTO = "auto";
const EMOJI_NONE = "none";

const FONT_FORMATS = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

// ha-select renders its options into its own shadow root; older frontends used
// list items for the same job.
const FONT_OPTION_SELECTOR = "ha-dropdown-item, ha-list-item, mwc-list-item";

// The font a name is drawn in when it has no preview of its own. It cannot be
// `inherit`: an option inherits from the picker, which wears the picked font.
const UI_FONT = "var(--ha-font-family-body, sans-serif)";


const raf = (fn) => (typeof requestAnimationFrame === "function"
  ? requestAnimationFrame(fn)
  : setTimeout(fn, 0));

/**
 * The family an installed font is drawn under. Anything CSS will not take in
 * a bare identifier is escaped as `_<hex>_`, which never collides: a literal
 * underscore is escaped too, so an underscore only ever opens an escape.
 */
function fontFaceFamily(id) {
  const safe = String(id).replace(
    /[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0).toString(16)}_`);
  return `liza-font-${safe}`;
}

// Fontbook (its own integration, a panel of its own) manages the fonts this
// tab picks from. While it is installed it is a group here, beside Appearance,
// showing Fontbook's own panel.
export const FONTBOOK_PANEL = "fontbook";
export const FONTBOOK_ICON = "mdi:format-font";

export const SettingsFontsMixin = {
  /** The emoji fonts to offer: imgserv's own choice, none, or a font. */
  _htmlEmojiFontOptions(current) {
    const fonts = this._htmlSettingsFontOptions(
      current && current !== EMOJI_NONE ? current : "", { emoji: true });
    return [
      { value: EMOJI_AUTO, label: this._t("settings_emoji_auto") },
      { value: EMOJI_NONE, label: this._t("settings_emoji_none") },
      ...fonts,
    ];
  },

  /** The fonts to offer, as ha-select options: the emoji fonts for emoji,
   * the others for words -- an emoji font has no letters to draw a title in. */
  _htmlSettingsFontOptions(current, { emoji = false } = {}) {
    const installed = this._textSettings?.fonts || [];
    const fonts = installed.filter((f) => !!f.emoji === emoji || f.id === current);
    const options = fonts.map((f) => ({
      value: f.id,
      label: f.name,
    }));
    // A font named in settings.yaml but no longer installed is still the
    // setting: listing it keeps the select from silently showing another one.
    if (current && !installed.some((f) => f.id === current)) {
      options.unshift({ value: current, label: this._t("settings_font_missing", { name: current }) });
    }
    return options;
  },

  /**
   * Teach the document the installed fonts, so the picker can draw each name
   * in its own. Rebuilt from the current list: a font that is gone takes its
   * rule with it, and the <style> goes too once nothing is loadable.
   */
  _ensureFontFaces(fonts) {
    const css = (fonts || [])
      .filter((f) => f?.id && f?.url)
      .map((f) => {
        const url = String(f.url).replace(/["'()\s]/g, encodeURIComponent);
        const format = FONT_FORMATS[url.split(".").pop().toLowerCase()];
        return `@font-face{font-family:"${fontFaceFamily(f.id)}";`
          + `src:url("${url}")${format ? ` format("${format}")` : ""};`
          + "font-display:swap}";
      })
      .join("\n");
    const doc = this.ownerDocument || globalThis.document;
    let style = doc?.getElementById?.(FONT_FACE_STYLE_ID);
    if (!css) {
      style?.remove();
      return;
    }
    if (!style) {
      style = doc.createElement("style");
      style.id = FONT_FACE_STYLE_ID;
      doc.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  },

  /** What to set `font-family` to for a font id, or "" when it cannot load. */
  _fontFamilyCss(id) {
    if (!id) return "";
    const font = (this._textSettings?.fonts || []).find((f) => f?.id === id);
    if (!font?.url) return "";
    return `"${fontFaceFamily(id)}", ${UI_FONT}`;
  },

  /**
   * Draw a font picker in the fonts it offers: the closed field in the one
   * picked, each option in its own. ha-select keeps its options in its own
   * shadow root, so a frontend that moves them leaves the picker plain.
   */
  _applyFontPreview(el) {
    if (!el) return;
    el.style.fontFamily = this._fontFamilyCss(el.value);
    const options = el.shadowRoot?.querySelectorAll(FONT_OPTION_SELECTOR) || [];
    options.forEach((opt) => {
      opt.style.fontFamily = this._fontFamilyCss(opt.value) || UI_FONT;
    });
  },

  /** Keep `_applyFontPreview` true across the picker's own repaints. */
  _wireFontPreview(el) {
    const apply = () => this._applyFontPreview(el);
    Promise.resolve(el.updateComplete).then(apply, apply);
    ["click", "wa-show", "opened", "selected"].forEach((name) =>
      el.addEventListener(name, () => raf(apply)));
  },

  /** Home Assistant's entry for Fontbook's panel, when it has one to load. */
  _fontbookPanel() {
    const panel = this._hass?.panels?.[FONTBOOK_PANEL];
    return panel?.config?._panel_custom?.name ? panel : null;
  },

  /**
   * `{name, url}`: the element Fontbook's panel is and where its module is.
   * Fontbook says so itself (`fontbook/info`); one from before that command
   * is read off the panel Home Assistant registered for it.
   */
  async _fontbookElementInfo(panel) {
    if (!this._fontbookInfo) {
      try {
        const info = await this._hass.callWS({ type: "fontbook/info" });
        if (info?.element && info?.module_url) {
          this._fontbookInfo = { name: info.element, url: info.module_url };
        }
      } catch (e) { /* an older Fontbook: its panel's own entry says */ }
    }
    if (this._fontbookInfo) return this._fontbookInfo;
    const custom = panel.config._panel_custom;
    return { name: custom.name, url: custom.module_url || custom.js_url };
  },

  /** The Fontbook group: a place for Fontbook's own panel. */
  _htmlFontbookSection() {
    const panel = this._fontbookPanel();
    const title = this._esc(panel?.title || "Fontbook");
    const failed = this._fontbookError
      ? `<p class="hint-text">${this._esc(this._t("settings_fontbook_failed"))}
           <a href="/${this._esc(panel?.url_path || FONTBOOK_PANEL)}">${title}</a></p>`
      : "";
    return `
      <section class="settings-section settings-fontbook" id="liza-settings-panel-${FONTBOOK_PANEL}"
               role="region" aria-label="${title}" tabindex="-1">
        ${failed}<div class="fontbook-host"></div>
      </section>`;
  },

  /**
   * Put Fontbook's panel into *host*. One element for the life of the view:
   * every render rebuilds the markup around it, and a new one each time would
   * forget what the user was doing in it. Its module is loaded the first time.
   */
  async _mountFontbook(host) {
    const panel = this._fontbookPanel();
    if (!panel) return;
    let custom;
    try {
      custom = await this._fontbookElementInfo(panel);
      if (!customElements.get(custom.name)) {
        await import(custom.url);
        await customElements.whenDefined(custom.name);
      }
    } catch (e) {
      console.warn("[lizaIP] Fontbook could not be loaded:", e);
      if (!this._fontbookError) { this._fontbookError = true; this._render(); }
      return;
    }
    if (!host.isConnected) return;
    if (!this._fontbookEl) this._fontbookEl = document.createElement(custom.name);
    const el = this._fontbookEl;
    el.hass = this._hass;
    el.narrow = !!this.narrow;
    // The library alone: no toolbar, tabs or menu button of its own.
    el.embedded = true;
    if (el.parentNode !== host) host.appendChild(el);
  },
};
