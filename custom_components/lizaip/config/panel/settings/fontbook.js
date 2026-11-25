/**
 * lizaIP Panel — Settings View: the Fontbook group.
 *
 * Fontbook (its own integration, a panel of its own) manages the fonts the
 * settings pick from. While it is installed it is a group in the gear tab,
 * beside Appearance, showing Fontbook's own panel; without it there is no
 * group and nothing here runs. Everything lizaIP knows about Fontbook is in
 * this file; the settings tab only asks for an embedded group.
 */

const FONTBOOK_PANEL = "fontbook";
const FONTBOOK_ICON = "mdi:format-font";
// It was made to fill a page of its own, so it gets room to work in.
const FONTBOOK_MIN_HEIGHT = "70vh";

export const SettingsFontbookMixin = {
  /** Home Assistant's entry for Fontbook's panel, when it has one to load. */
  _fontbookPanel() {
    const panel = this._hass?.panels?.[FONTBOOK_PANEL];
    return panel?.config?._panel_custom?.name ? panel : null;
  },

  /** The group to add beside Appearance, or null without Fontbook. */
  _embeddedSettingsGroup() {
    const panel = this._fontbookPanel();
    if (!panel) return null;
    return {
      id: FONTBOOK_PANEL, icon: panel.icon || FONTBOOK_ICON,
      title: panel.title || "Fontbook", after: "appearance", embedded: true,
    };
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

  /** The group's body: a place for Fontbook's own panel. */
  _htmlEmbeddedSettingsSection() {
    const panel = this._fontbookPanel();
    const title = this._esc(panel?.title || "Fontbook");
    const failed = this._fontbookError
      ? `<p class="hint-text">${this._esc(this._t("embedded_panel_failed", { name: panel?.title || "Fontbook" }))}
           <a href="/${this._esc(panel?.url_path || FONTBOOK_PANEL)}">${title}</a></p>`
      : "";
    return `
      <section class="settings-section settings-embedded" id="liza-settings-panel-${FONTBOOK_PANEL}"
               role="region" aria-label="${title}" tabindex="-1">
        ${failed}<div class="embedded-host" style="min-height: ${FONTBOOK_MIN_HEIGHT}"></div>
      </section>`;
  },

  /**
   * Put Fontbook's panel into *host*. One element for the life of the view:
   * every render rebuilds the markup around it, and a new one each time would
   * forget what the user was doing in it. Its module is loaded the first time.
   */
  async _mountEmbeddedSettings(host) {
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
    if (!this._fontbookEl) {
      this._fontbookEl = document.createElement(custom.name);
      this._fontbookEl.style.minHeight = FONTBOOK_MIN_HEIGHT;
      this._embedPanel(this._fontbookEl);
    }
    const el = this._fontbookEl;
    el.hass = this._hass;
    el.narrow = !!this.narrow;
    // The library alone: no toolbar, tabs or menu button of its own.
    el.embedded = true;
    if (el.parentNode !== host) host.appendChild(el);
  },
};
