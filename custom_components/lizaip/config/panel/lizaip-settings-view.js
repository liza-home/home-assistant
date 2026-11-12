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
 *
 * This file holds the tab itself -- its groups, search and cards; the theme
 * picker and editor live in `settings/theme.js`, and the font pickers
 * and Fontbook in `settings/fonts.js`.
 */

import { applyMixins } from "./lizaip-mixins.js";
import { SettingsThemeMixin, THEME_BLANK } from "./settings/theme.js";
import { SettingsFontsMixin, FONTBOOK_PANEL, FONTBOOK_ICON } from "./settings/fonts.js";

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

const SettingsTabMixin = {
  /** Where the chosen group is kept, like the page-links preference. */
  SETTINGS_GROUP_PREF: "liza.remote.settingsGroup",

  /** Load what the tab shows. Also the source of the title previews' style. */
  async _loadTextSettings() {
    if (!this._currentEntry) return;
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
    this._ensureFontFaces(this._textSettings?.fonts);
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
      this._settingsGroupId = this._settingsGroups().some((g) => g.id === stored) ? stored : SETTINGS_DEFAULT_GROUP;
    }
    return this._settingsGroupId;
  },

  /** The section the route named, if the panel has one by that name. */
  _applySettingsSection(id) {
    if (!this._settingsGroups().some((g) => g.id === id)) return;
    this._settingsGroupId = id;
  },

  /**
   * A chip clears the search as well as moving the page: the results belong
   * to no chip. The render writes the new section into the address bar.
   */
  _setSettingsGroup(id) {
    if (!this._settingsGroups().some((g) => g.id === id)) return;
    if (id === this._settingsGroup() && !this._settingsQuery) return;
    this._settingsGroupId = id;
    this._settingsQuery = "";
    try {
      window.localStorage?.setItem(this.SETTINGS_GROUP_PREF, id);
    } catch (e) { /* Blocked storage: the chip still works for this session. */ }
    this._render();
  },

  /**
   * The Buttons card: the remote's press-behaviour switches.
   *
   * All are off until asked for, and for the same reason -- a remote set up
   * before any existed must keep behaving exactly as it did. That makes the
   * row shape shared rather than coincidental, so it is written once.
   */
  _htmlSettingsButtonsCard() {
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlCardHeader("settings_buttons", { icon: "mdi:gesture-tap-button", level: 3 })}
        <div class="settings-body">
          <div class="settings-switch-list">
            ${this._htmlFeatureSwitch("longtouch", "settings_longtouch", "settings_longtouch_hint")}
            ${this._htmlFeatureSwitch("toggle", "settings_toggle", "settings_toggle_hint")}
            ${this._htmlFeatureSwitch("options", "settings_options", "settings_options_hint")}
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
        ${this._htmlCardHeader("settings_variables", { icon: "mdi:code-braces", level: 3 })}
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
        ${this._htmlCardHeader("settings_icons", { icon: "mdi:lightbulb-on-outline", level: 3 })}
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
          ${this._htmlCornerRadius()}
        </div>
      </ha-card>`;
  },

  /** Corner radius of whole pictures: a slider with a sample that follows it. */
  _htmlCornerRadius() {
    const opts = this._iconOptions;
    const limits = opts?.limits?.icon_corner_radius;
    if (!limits) return "";
    const id = "liza-settings-icon-corner-radius";
    const value = opts.icon_corner_radius ?? opts.defaults?.icon_corner_radius ?? limits.max;
    return `
      <div class="config-field settings-radius">
        <div class="settings-radius-row">
          <div class="settings-radius-sample" aria-hidden="true"
               style="border-radius:${this._esc(value / 2)}%">
            <ha-icon icon="mdi:image-outline"></ha-icon>
          </div>
          <div class="settings-radius-control">
            <label for="${id}">${this._esc(this._t("settings_corner_radius"))}</label>
            <div class="settings-step-input settings-range-input">
              <ha-slider id="${id}" class="settings-corner-radius"
                         min="${limits.min}" max="${limits.max}" step="${limits.step || 1}"
                         value="${this._esc(value)}"
                         ${this._iconOptionsBusy ? "disabled" : ""}></ha-slider>
              <output class="settings-step-unit settings-range-value" for="${id}">${this._esc(value)} %</output>
            </div>
          </div>
        </div>
        <span class="config-field-hint">${this._esc(this._t("settings_corner_radius_hint", { min: limits.min, max: limits.max }))}</span>
      </div>`;
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
    return `
      <ha-card outlined class="settings-card">
        ${this._htmlCardHeader("settings_editor", { icon: "mdi:monitor-edit", level: 3 })}
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
    const placeholder = this._t("settings_search_placeholder");
    return `
      <div class="settings-bar">
        ${this._htmlSettingsTabs()}
        <ha-input-search appearance="outlined" class="settings-search settings-search-input"
                         value="${this._esc(this._settingsQuery || "")}"
                         placeholder="${this._esc(placeholder)}" accessible-label="${this._esc(placeholder)}"></ha-input-search>
      </div>`;
  },

  /** The chips, on their own: a search repaints them without the box beside them. */
  _htmlSettingsTabs() {
    const current = this._settingsGroup();
    const searching = this._settingsSearch() !== "";
    // What the chips on screen were drawn for, so a keystroke that leaves it
    // unchanged leaves them alone.
    this._settingsTabsSearching = searching;
    // While results are up no group is the one shown, so none is marked; the
    // remembered one is still what the tab group falls back to.
    const tab = (group) => `
        <ha-tab-group-tab slot="nav" panel="${group.id}" class="settings-chip" data-group="${group.id}"
                          id="liza-settings-chip-${group.id}"${!searching && group.id === current ? " active" : ""}>
          <ha-icon icon="${group.icon}" aria-hidden="true"></ha-icon>
          ${this._esc(group.title || this._t(group.label))}
        </ha-tab-group-tab>`;
    return `<ha-tab-group class="settings-nav" ${searching ? "" : `active="${current}"`}
                      aria-label="${this._esc(this._t("settings_groups"))}">
          ${this._settingsGroups().map(tab).join("")}
        </ha-tab-group>`;
  },

  /** The groups to offer: Fontbook's, beside Appearance, while it is installed. */
  _settingsGroups() {
    const panel = this._fontbookPanel();
    if (!panel) return SETTINGS_GROUPS;
    const fontbook = {
      id: FONTBOOK_PANEL, icon: panel.icon || FONTBOOK_ICON, title: panel.title || "Fontbook",
    };
    return SETTINGS_GROUPS.flatMap((g) => (g.id === "appearance" ? [g, fontbook] : [g]));
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
    return `
      <div class="settings-view">
        ${this._htmlSettingsNav()}
        ${this._htmlSettingsBody()}
      </div>`;
  },

  /** Everything below the bar: the group shown, or the search results. */
  _htmlSettingsBody() {
    const needle = this._settingsSearch();
    const group = this._settingsGroups().find((g) => g.id === this._settingsGroup())
      || SETTINGS_GROUPS.find((g) => g.id === SETTINGS_DEFAULT_GROUP);
    if (needle) return this._htmlSettingsResults(needle);
    if (group.id === FONTBOOK_PANEL) return this._htmlFontbookSection();
    return this._htmlSettingsSection(group, this._htmlSettingsGroupCards(group.id));
  },

  /**
   * Repaint what a search changes -- the body, and the chips when results
   * come or go -- and leave the search box itself alone, so the caret and
   * the focus stay where the user is typing. The tab-stop observer on the
   * shadow root sees the new nodes, as it does any partial repaint.
   */
  _repaintSettingsBody() {
    const view = this.shadowRoot?.querySelector(".settings-view");
    const bar = view?.querySelector(".settings-bar");
    if (!bar || bar.parentNode !== view) {
      this._render();
      return;
    }
    const scrolls = this._captureScroll?.();
    this._stopSettingsDemos();
    let tabs = false;
    const nav = bar.querySelector(".settings-nav");
    if (nav && (this._settingsSearch() !== "") !== this._settingsTabsSearching) {
      nav.insertAdjacentHTML("beforebegin", this._htmlSettingsTabs());
      nav.remove();
      tabs = true;
    }
    while (bar.nextSibling) bar.nextSibling.remove();
    view.insertAdjacentHTML("beforeend", `
        ${this._htmlSettingsBody()}
      `);
    this._restoreScroll?.(scrolls);
    this._wireSettingsView(view, { tabs, search: false });
  },

  /**
   * Save *settings* and show what the backend stored.
   *
   * A refused save puts the stored settings back on screen: leaving the
   * rejected value in the field would show a setting the remote does not have.
   */
  async _saveTextSettings(settings) {
    return this._runBusy("_textSettingsBusy", async () => {
      this._textSettings = await this._hass.callWS({
        type: "lizaip_config/set_settings", entry_id: this._currentEntry, settings,
      });
      this._ensureFontFaces(this._textSettings?.fonts);
      this._toast(this._t("settings_saved"));
    }, { toast: "settings_save_failed" });
  },

  /**
   * Save one or more icon options and redraw the card around them.
   *
   * Like the text settings, a refused save puts the stored values back.
   */
  async _saveIconOptions(changes) {
    return this._runBusy("_iconOptionsBusy", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/set_icon_options", entry_id: this._currentEntry, ...changes,
      });
      this._applyIconOptions(r);
      this._toast(this._t("settings_saved"));
    }, { toast: "settings_save_failed" });
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
        ${this._htmlCardHeader("settings_clear_pages", { icon: "mdi:alert-outline", level: 3 })}
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
    // The panel's own confirmation, like every other destructive step here,
    // rather than the browser's unstyled, unlocalised prompt.
    const confirmed = await this._confirmDestructive({
      title: this._t("settings_clear_pages_confirm"),
      message: this._t("settings_clear_pages_hint"),
      confirmText: this._t("settings_clear_pages"),
    });
    if (!confirmed) return;
    await this._runBusy("_clearPagesBusy", async () => {
      await this._hass.callWS({
        type: "lizaip_config/clear_device_pages", entry_id: this._currentEntry,
      });
      this._toast(this._t("settings_clear_pages_done"));
    }, { toast: "settings_clear_pages_failed" });
  },

  /**
   * *root* is the shadow root after a render, or the view after
   * `_repaintSettingsBody`, which says which of the bar's parts are new.
   */
  _wireSettingsView(root = this.shadowRoot, { tabs = true, search = true } = {}) {
    root.querySelectorAll(".settings-feature-switch").forEach((el) =>
      el.addEventListener("change", (ev) =>
        this._changeTextSetting(el.dataset.section, "enabled", ev.target.checked)));
    root.querySelectorAll("ha-expansion-panel[data-group]").forEach((el) =>
      el.addEventListener("expanded-changed", (ev) =>
        this._themeGroupToggled(root, el, !!ev.detail?.expanded)));
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
    const radius = root.querySelector(".settings-corner-radius");
    if (radius) radius.valueFormatter = (v) => `${v} %`;
    radius?.addEventListener("input", (ev) => {
      const el = ev.currentTarget;
      const out = el.parentElement?.querySelector(".settings-range-value");
      if (out) out.textContent = `${el.value} %`;
      const sample = root.querySelector(".settings-radius-sample");
      if (sample) sample.style.borderRadius = `${Number(el.value) / 2}%`;
    });
    radius?.addEventListener("change", async (ev) => {
      const value = Number(ev.currentTarget.value);
      if (!Number.isInteger(value) || value === this._iconOptions?.icon_corner_radius) return;
      // Shown as chosen while the save runs, so the busy re-render does not
      // flash the old radius before the new one.
      const previous = this._iconOptions?.icon_corner_radius;
      if (this._iconOptions) this._iconOptions.icon_corner_radius = value;
      if (!await this._saveIconOptions({ icon_corner_radius: value }) && this._iconOptions) {
        this._iconOptions.icon_corner_radius = previous;
        this._render();
      }
    });
    root.querySelectorAll(".settings-icon-switch").forEach((el) =>
      el.addEventListener("change", () =>
        this._saveIconOptions({ [el.dataset.key]: el.checked === true })));
    // Local to the browser, so nothing is saved to the backend and there is no
    // busy state to wait on or failure to report.
    root.querySelector(".settings-pagelinks-switch")?.addEventListener("change", (ev) =>
      this._setPageLinksEnabled(ev.currentTarget.checked === true));
    // A click on a name reaches the setting through its switch's own change
    // handler, so each kind of switch keeps one meaning.
    this._wireSwitchLabels(root, ".settings-switch-text label");
    root.querySelector(".settings-clear-pages")?.addEventListener(
      "click", () => this._clearDevicePages());
    this._wireSettingsNav(root, { tabs, search });
    this._wireSettingsDemos(root);
  },

  /** Chips move the page; a11y.js already moves between them with the arrows. */
  _wireSettingsNav(root, { tabs = true, search = true } = {}) {
    // A click as well as the tab group's own event: re-pressing the shown
    // group while results are up has to leave the search, and the group does
    // not announce a tab that is already its active one.
    if (tabs) {
      root.querySelector(".settings-nav")?.addEventListener("wa-tab-show", (ev) =>
        this._setSettingsGroup(ev.detail?.name));
      root.querySelectorAll(".settings-chip").forEach((el) =>
        el.addEventListener("click", () => this._setSettingsGroup(el.dataset.group)));
    }
    const fontbook = root.querySelector(".fontbook-host");
    if (fontbook) this._mountFontbook(fontbook);
    if (search) this._wireSettingsSearch(root);
  },

  /**
   * The search box. A keystroke repaints only what is below it
   * (`_repaintSettingsBody`), so the box keeps its node, its focus and its
   * caret; a full render that does rebuild it puts the focus back through
   * `_a11yCaptureFocus` like any other control.
   */
  _wireSettingsSearch(root) {
    const search = root.querySelector(".settings-search-input");
    if (!search) return;
    const show = (value) => {
      this._settingsQuery = value;
      this._repaintSettingsBody();
    };
    search.addEventListener("input", (ev) => show(ev.currentTarget.value ?? ""));
    search.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !this._settingsQuery) return;
      ev.preventDefault();
      // A render used to empty the box by drawing it again; it is kept now,
      // so it is emptied here.
      search.value = "";
      show("");
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

// The tab itself above; the theme editor and the fonts each in a slice of their
// own, composed back into the one mixin the panel applies.
export const SettingsViewMixin = applyMixins(
  {},
  SettingsTabMixin,
  SettingsThemeMixin,
  SettingsFontsMixin,
);
