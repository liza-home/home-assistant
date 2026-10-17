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

  /** The sample words as the remote draws them in the *kind* strip, `{src, key}`. */
  _settingsPreview(kind) {
    const sample = this._t(kind === "title" ? "settings_sample_title" : "settings_sample_tooltip");
    // Dark whatever the theme: the preview sits on black, like the remote.
    return this._deviceImg(`text:${sample}`, kind, "", null, { keepMode: true });
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
            ${(() => {
              const { src, key } = this._settingsPreview(kind);
              return `<img ${src ? `src="${this._esc(src)}"` : ""} data-dev-key="${this._esc(key)}" data-keep-mode
                 alt="${this._esc(this._t("settings_preview"))}">`;
            })()}
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

  /**
   * The Editor card: how this panel draws, not how the remote behaves.
   *
   * Every other card on this tab is a *device* setting that is saved to the
   * backend and reaches the remote. This one is neither — it changes what the
   * Buttons tab draws over its own page strip, for this browser only. Kept on
   * the gear tab regardless, because that is where a user goes to look for a
   * switch; the hint is what says which kind of switch it is.
   */
  _htmlSettingsEditorCard() {
    const id = "liza-settings-page-links";
    const hintId = `${id}-hint`;
    const labelId = `${id}-label`;
    const tipId = "liza-settings-button-tips";
    const tipHintId = `${tipId}-hint`;
    const tipLabelId = `${tipId}-label`;
    return `
      <ha-card outlined>
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t("settings_editor"))}</h2>
        </div>
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
        ${this._htmlSettingsEditorCard()}
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
   * diagnostics report, from one place on every screen.
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
    const label = this._esc(this._t("diagnostics_menu"));
    return `<button type="button" class="diag-menu-btn ${cls}" data-entry="${this._esc(entryId || "")}"
                    aria-haspopup="menu" aria-label="${label}" title="${label}">
              <ha-icon icon="mdi:dots-vertical" aria-hidden="true"></ha-icon>
            </button>`;
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
      <div class="layout-dialog-actions">
        ${job.state === "error" ? `
        <button type="button" class="debug-btn diag-dialog-retry">
          ${this._esc(this._t("diagnostics_retry"))}
        </button>` : ""}
        <button type="button" class="debug-btn primary diag-dialog-close">
          ${this._esc(this._t(job.state === "running" ? "diagnostics_hide" : "close"))}
        </button>
      </div>`;
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
