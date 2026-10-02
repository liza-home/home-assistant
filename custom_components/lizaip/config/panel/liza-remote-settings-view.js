/**
 * lizaIP Panel — Settings View
 * The gear tab: which font and size the remote draws page titles and tooltips in.
 *
 * Per remote, like everything else in the device view. The backend owns the
 * defaults, the size limits and the list of installed fonts, and sends them with
 * the settings (`lizaip_config/get_settings`), so nothing here restates a number
 * the server would have to agree with.
 *
 * A change is saved as soon as it is made, like the rest of the panel: there is
 * no form to submit. The backend checks it again and answers with what it
 * stored, which is what the tab then shows.
 */

const TEXT_KINDS = ["title", "tooltip"];

export const SettingsViewMixin = {
  /** Load what the tab shows. Also the source of the title previews' style. */
  async _loadTextSettings() {
    if (!this._currentEntry) return;
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
    this._loadTextSettings().then(() => {
      if (this._activeTab === "settings") this._render();
    });
  },

  _settingsPreviewUrl(kind) {
    const sample = this._t(kind === "title" ? "settings_sample_title" : "settings_sample_tooltip");
    return `/api/imgserv/text:${encodeURIComponent(sample)}?size=${kind}`
      // Dark whatever the theme: the preview sits on black, like the remote.
      + `&mode=dark&alpha=1${this._textStyleQuery(kind)}`;
  },

  _htmlSettingsFontOptions(current) {
    const fonts = this._textSettings?.fonts || [];
    const options = fonts.map((f) => {
      const label = f.source === "user" ? this._t("settings_font_user", { name: f.name }) : f.name;
      return `<option value="${this._esc(f.id)}" ${f.id === current ? "selected" : ""}>${this._esc(label)}</option>`;
    });
    // A font named in settings.yaml but no longer installed is still the
    // setting: listing it keeps the select from silently showing another one.
    if (current && !fonts.some((f) => f.id === current)) {
      options.unshift(`<option value="${this._esc(current)}" selected>${this._esc(this._t("settings_font_missing", { name: current }))}</option>`);
    }
    return options.join("");
  },

  _htmlSettingsCard(kind) {
    const style = this._textSettings.settings[kind];
    const limits = this._textSettings.limits?.[kind] || {};
    const fontId = `liza-settings-${kind}-font`;
    const sizeId = `liza-settings-${kind}-size`;
    const sizeHintId = `${sizeId}-hint`;
    return `
      <ha-card outlined class="settings-card">
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t(kind === "title" ? "settings_title" : "settings_tooltip"))}</h2>
        </div>
        <div class="settings-body">
          <div class="config-field">
            <label for="${fontId}">${this._esc(this._t("settings_font"))}</label>
            <select id="${fontId}" class="settings-font" data-kind="${kind}">
              ${this._htmlSettingsFontOptions(style.font)}
            </select>
          </div>
          <div class="config-field">
            <label for="${sizeId}">${this._esc(this._t("settings_font_size"))}</label>
            <input type="number" id="${sizeId}" class="settings-size" data-kind="${kind}"
                   inputmode="numeric" step="1" min="${limits.min ?? ""}" max="${limits.max ?? ""}"
                   value="${this._esc(style.font_size)}" aria-describedby="${sizeHintId}">
            <span class="config-field-hint" id="${sizeHintId}">${this._esc(this._t("settings_font_size_hint", { min: limits.min, max: limits.max }))}</span>
          </div>
          <div class="settings-preview">
            <img src="${this._esc(this._settingsPreviewUrl(kind))}"
                 alt="${this._esc(this._t("settings_preview"))}">
          </div>
        </div>
      </ha-card>`;
  },

  _htmlSettingsView() {
    if (!this._textSettings) {
      const msg = this._textSettingsError
        ? `<p class="debug-error">${this._esc(this._textSettingsError)}</p>`
        : `<p class="hint-text">${this._esc(this._t("settings_loading"))}</p>`;
      return `<div class="settings-view">${msg}</div>`;
    }
    const s = this._textSettings;
    const isDefault = JSON.stringify(s.settings) === JSON.stringify(s.defaults);
    return `
      <div class="settings-view">
        ${TEXT_KINDS.map((kind) => this._htmlSettingsCard(kind)).join("")}
        <p class="hint-text settings-fonts-hint">${this._esc(this._t("settings_fonts_hint", { path: "/config/lizaip/fonts" }))}</p>
        <p class="hint-text settings-emoji-hint">${this._esc(this._t("settings_emoji_hint", { path: "/config/lizaip/fonts" }))}</p>
        <div class="settings-actions">
          <button type="button" class="debug-btn settings-reset" ${isDefault || this._textSettingsBusy ? "disabled" : ""}>
            ${this._esc(this._t("settings_reset"))}
          </button>
        </div>
      </div>`;
  },

  /**
   * Save *settings* and show what the backend stored.
   *
   * A refused save puts the stored settings back on screen: leaving the
   * rejected value in the field would show a setting the remote does not have.
   */
  async _saveTextSettings(settings) {
    if (!this._currentEntry || this._textSettingsBusy) return;
    this._textSettingsBusy = true;
    try {
      this._textSettings = await this._hass.callWS({
        type: "lizaip_config/set_settings", entry_id: this._currentEntry, settings,
      });
      this._toast(this._t("settings_saved"));
    } catch (e) {
      this._toast(this._t("settings_save_failed", { error: String(e?.message || e) }));
    } finally {
      this._textSettingsBusy = false;
      this._render();
    }
  },

  _changeTextSetting(kind, key, value) {
    const current = this._textSettings?.settings;
    if (!current) return;
    if (current[kind]?.[key] === value) return;
    const next = structuredClone(current);
    next[kind][key] = value;
    this._saveTextSettings(next);
  },

  _wireSettingsView() {
    const root = this.shadowRoot;
    root.querySelectorAll(".settings-font").forEach((el) =>
      el.addEventListener("change", () => this._changeTextSetting(el.dataset.kind, "font", el.value)));
    // "change", not "input": typing 24 would otherwise save 2 on the way.
    root.querySelectorAll(".settings-size").forEach((el) =>
      el.addEventListener("change", () => {
        const value = Number(el.value);
        const limits = this._textSettings?.limits?.[el.dataset.kind] || {};
        if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
          this._toast(this._t("settings_font_size_hint", { min: limits.min, max: limits.max }));
          this._render();
          return;
        }
        this._changeTextSetting(el.dataset.kind, "font_size", value);
      }));
    root.querySelector(".settings-reset")?.addEventListener("click", () => {
      const defaults = this._textSettings?.defaults;
      if (defaults) this._saveTextSettings(structuredClone(defaults));
    });
  },
};
