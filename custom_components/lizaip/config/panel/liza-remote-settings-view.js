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
    Promise.all([this._loadTextSettings(), this._loadIconOptions()]).then(() => {
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
      <ha-card outlined>
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
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t("settings_buttons"))}</h2>
        </div>
        <div class="settings-body">
          <div class="settings-switch-list">
            ${this._htmlFeatureSwitch("longtouch", "settings_longtouch", "settings_longtouch_hint")}
            ${this._htmlFeatureSwitch("toggle", "settings_toggle", "settings_toggle_hint")}
          </div>
        </div>
      </ha-card>`;
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
   * The Variables card: the switch, and under it how often a value that keeps
   * changing is sent. Empty when the backend sends no limits for the interval.
   */
  _htmlSettingsVariablesCard() {
    const opts = this._iconOptions;
    const limits = opts?.limits?.variables_interval_ms;
    if (!limits) return "";
    const id = "liza-settings-variables-interval";
    const hintId = `${id}-hint`;
    const on = opts.variables_enabled !== false;
    const value = opts.variables_interval_ms ?? opts.defaults?.variables_interval_ms;
    return `
      <ha-card outlined>
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t("settings_variables"))}</h2>
        </div>
        <div class="settings-body">
          <div class="settings-switch-list">
            ${this._htmlIconSwitch("variables_enabled", "settings_variables_enabled", "settings_variables_enabled_hint")}
            <div class="settings-switch-detail${on ? "" : " is-off"}">
              <div class="config-field">
                <label for="${id}">${this._esc(this._t("settings_variables_interval"))}</label>
                <div class="settings-step-input settings-range-input">
                  <input type="range" id="${id}" class="settings-variables-interval"
                         min="${limits.min}" max="${limits.max}" step="${limits.step || 100}"
                         value="${this._esc(value)}" aria-describedby="${hintId}"
                         aria-valuetext="${this._esc(this._formatInterval(value))}"
                         ${this._iconOptionsBusy || !on ? "disabled" : ""}>
                  <output class="settings-step-unit settings-range-value" for="${id}">${this._esc(this._formatInterval(value))}</output>
                </div>
                <span class="config-field-hint" id="${hintId}">${this._esc(this._t("settings_variables_interval_hint", {
                  min: this._formatInterval(limits.min), max: this._formatInterval(limits.max),
                  default: this._formatInterval(opts.defaults?.variables_interval_ms ?? 500),
                }))}</span>
              </div>
            </div>
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
    const descId = "liza-settings-icon-description";
    const hintId = `${id}-hint`;
    const fillOn = opts.icon_fill_enabled === true;
    // The step only means something while the fill is drawn, so it is nested
    // under that switch and dimmed with it rather than sitting as a third
    // field of equal weight.
    const stepOff = fillOn ? "" : " is-off";
    return `
      <ha-card outlined>
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t("settings_icons"))}</h2>
        </div>
        <div class="settings-body">
          <p class="settings-card-description" id="${descId}">${this._esc(this._t("settings_icon_card_description"))}</p>
          <div class="settings-switch-list">
            ${this._htmlIconSwitch("icon_color_enabled", "settings_icon_color_enabled", "settings_icon_color_enabled_hint")}
            ${this._htmlIconSwitch("icon_fill_enabled", "settings_icon_fill_enabled", "settings_icon_fill_enabled_hint")}
            <div class="settings-switch-detail${stepOff}">
              <div class="config-field">
                <label for="${id}">${this._esc(this._t("settings_fill_step"))}</label>
                <div class="settings-step-input">
                  <input type="number" id="${id}" class="settings-fill-step"
                         inputmode="numeric" step="1" min="${limits.min}" max="${limits.max}"
                         value="${this._esc(opts.icon_fill_step)}" aria-describedby="${hintId}"
                         ${this._iconOptionsBusy || !fillOn ? "disabled" : ""}>
                  <span class="settings-step-unit" aria-hidden="true">%</span>
                </div>
                <span class="config-field-hint" id="${hintId}">${this._esc(this._t("settings_fill_step_hint", { min: limits.min, max: limits.max }))}</span>
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

  _htmlSettingsView() {
    if (!this._textSettings) {
      const msg = this._textSettingsError
        ? `<p class="debug-error">${this._esc(this._textSettingsError)}</p>`
        : `<p class="hint-text">${this._esc(this._t("settings_loading"))}</p>`;
      return `<div class="settings-view">${msg}</div>`;
    }
    const s = this._textSettings;
    const isDefault = TEXT_KINDS.every(
      (kind) => JSON.stringify(s.settings[kind]) === JSON.stringify(s.defaults[kind]));
    const fontsPath = { path: "/config/lizaip/fonts" };
    // The reset sits with the font cards and their hint: it restores the fonts
    // only, not the icon options below.
    return `
      <div class="settings-view">
        ${TEXT_KINDS.map((kind) => this._htmlSettingsCard(kind)).join("")}
        <p class="hint-text settings-fonts-hint">${this._esc(this._t("settings_fonts_hint", fontsPath))} ${this._esc(this._t("settings_emoji_hint", fontsPath))}</p>
        <div class="settings-actions">
          <button type="button" class="debug-btn settings-reset" ${isDefault || this._textSettingsBusy ? "disabled" : ""}>
            ${this._esc(this._t("settings_reset"))}
          </button>
        </div>
        ${this._htmlSettingsIconCard()}
        ${this._htmlSettingsVariablesCard()}
        ${this._htmlSettingsButtonsCard()}
        ${this._htmlSettingsDeviceCard()}
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

  /**
   * Save one or more icon options and redraw the previews in them.
   *
   * Like the text settings, a refused save puts the stored values back.
   */
  async _saveIconOptions(changes) {
    if (!this._currentEntry || this._iconOptionsBusy) return;
    this._iconOptionsBusy = true;
    // Render now, not just in `finally`: the controls carry a `disabled` bound
    // to this flag, and without a repaint a second toggle mid-save hits the
    // guard above and is dropped with no error and no trace.
    this._render();
    try {
      const r = await this._hass.callWS({
        type: "lizaip_config/set_icon_options", entry_id: this._currentEntry, ...changes,
      });
      this._applyIconOptions(r);
      this._toast(this._t("settings_saved"));
    } catch (e) {
      this._toast(this._t("settings_save_failed", { error: String(e?.message || e) }));
    } finally {
      this._iconOptionsBusy = false;
      this._render();
    }
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
   * The device card: actions that change the remote itself, not the stored
   * configuration.
   *
   * It sits last because clearing the pages is the heaviest thing on the
   * screen, and the hint has to say plainly that nothing is lost — the store
   * keeps the pages and the rebuild follows the wipe.
   */
  _htmlSettingsDeviceCard() {
    return `
      <ha-card outlined class="settings-card">
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t("settings_device"))}</h2>
        </div>
        <div class="settings-body">
          <p class="config-field-hint">${this._esc(this._t("settings_clear_pages_hint"))}</p>
          <div class="settings-actions">
            <button type="button" class="debug-btn settings-clear-pages" ${this._clearPagesBusy ? "disabled" : ""}>
              ${this._esc(this._t(this._clearPagesBusy ? "settings_clear_pages_busy" : "settings_clear_pages"))}
            </button>
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
    this._clearPagesBusy = true;
    this._render();
    try {
      await this._hass.callWS({
        type: "lizaip_config/clear_device_pages", entry_id: this._currentEntry,
      });
      this._toast(this._t("settings_clear_pages_done"));
    } catch (e) {
      this._toast(this._t("settings_clear_pages_failed", { error: String(e?.message || e) }));
    } finally {
      this._clearPagesBusy = false;
      this._render();
    }
  },

  _wireSettingsView() {
    const root = this.shadowRoot;
    root.querySelectorAll(".settings-feature-switch").forEach((el) =>
      el.addEventListener("change", (ev) =>
        this._changeTextSetting(el.dataset.section, "enabled", ev.target.checked)));
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
    interval?.addEventListener("input", (ev) => {
      const el = ev.currentTarget;
      const text = this._formatInterval(Number(el.value));
      el.setAttribute("aria-valuetext", text);
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
    // `ha-switch` is not a native input, so `<label for>` does not reach it.
    // `preventDefault` so that a browser which *does* forward the click cannot
    // toggle the switch as well and have the two handlers undo each other.
    // Both kinds of row share this label, so where the new value goes is read
    // off the switch rather than off the row it was found in.
    root.querySelectorAll(".settings-switch-text label").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const sw = root.querySelector(`#${el.getAttribute("for")}`);
        if (!sw || sw.disabled) return;
        if (sw.dataset.section) this._changeTextSetting(sw.dataset.section, "enabled", !sw.checked);
        else this._saveIconOptions({ [sw.dataset.key]: !sw.checked });
      }));
    root.querySelector(".settings-clear-pages")?.addEventListener(
      "click", () => this._clearDevicePages());
    root.querySelector(".settings-reset")?.addEventListener("click", () => {
      const { settings, defaults } = this._textSettings ?? {};
      if (!settings || !defaults) return;
      // Fonts only: the long-touch switch keeps its state.
      const next = structuredClone(settings);
      for (const kind of TEXT_KINDS) next[kind] = structuredClone(defaults[kind]);
      this._saveTextSettings(next);
    });
  },
};
