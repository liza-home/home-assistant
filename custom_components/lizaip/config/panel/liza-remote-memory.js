/**
 * lizaIP Panel — device memory bars
 *
 * Small meters in the header, right of the device name: RAM (heap), how
 * fragmented that heap is, and the two flash areas (pictures, file system).
 * Off until switched on in the settings tab.
 *
 * The device has no push for these numbers, so they are polled -- after every
 * transfer that reached the device (`lizaip_config_device_synced`), on a
 * reconnect, and at least every MEMORY_POLL_MS while the panel is open.
 *
 * `_renderDeviceConfig` replaces the whole shadow root, so the reading is kept
 * in `this._memory` and drawn from there; a fresh reading patches the existing
 * container instead of re-rendering the panel.
 */

const MEMORY_POLL_MS = 5 * 60 * 1000;
// A burst of edits ends in one reading rather than one per page.
const MEMORY_DEBOUNCE_MS = 1500;

const WARN = 80;
const CRITICAL = 90;

export const MemoryViewMixin = {
  /**
   * The memory-bars switch: off until asked for, like the Buttons ones. Shown
   * on the debug tab, not here -- the bars are a tool for looking into the
   * remote, which is what that tab is for.
   */
  _htmlSettingsMemoryCard() {
    return `
      <ha-card outlined class="settings-card">
        <div class="actions-card-header">
          <h2 class="actions-card-title">${this._esc(this._t("settings_memory_card"))}</h2>
        </div>
        <div class="settings-body">
          <div class="settings-switch-list">
            ${this._htmlFeatureSwitch("memory", "settings_memory", "settings_memory_hint")}
          </div>
        </div>
      </ha-card>`;
  },

  _memoryEnabled() {
    return this._featureEnabled("memory");
  },

  _memoryDevice() {
    return (this._devices || []).find(d => d?.entry_id === this._currentEntry);
  },

  _formatBytes(n) {
    if (!Number.isFinite(n)) return "?";
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  },

  /**
   * The four meters, always all four while the feature is on: a value the
   * device has not reported (yet) is drawn empty with "–" rather than left
   * out, so the header does not change shape from one reading to the next.
   */
  _memoryItems() {
    const m = this._memory;
    const d = m && m.entry === this._currentEntry ? m.data || {} : {};
    const used = (part) => this._t("memory_used_of", {
      used: this._formatBytes(part.used), total: this._formatBytes(part.size),
    });
    const unknown = this._t("memory_unknown");
    return [
      { key: "ram", label: this._t("memory_ram"), pct: d.ram?.used_percent,
        tip: d.ram ? used(d.ram) : unknown },
      { key: "frag", label: this._t("memory_frag"), pct: d.ram?.fragmentation_percent,
        tip: d.ram?.fragmentation_percent != null
          ? this._t("memory_frag_tip", {
            largest: this._formatBytes(d.ram.largest), free: this._formatBytes(d.ram.free),
          })
          : unknown },
      { key: "img", label: this._t("memory_flash_images"), pct: d.image_flash?.used_percent,
        tip: d.image_flash ? used(d.image_flash) : unknown },
      { key: "fs", label: this._t("memory_flash_files"), pct: d.file_flash?.used_percent,
        tip: d.file_flash ? used(d.file_flash) : unknown },
    ].map((i) => ({ ...i, pct: Number.isFinite(i.pct) ? i.pct : null }));
  },

  /** The meters' markup; empty only when the feature is off. */
  _htmlMemoryBars() {
    if (!this._memoryEnabled()) return "";
    return this._memoryItems().map((i) => {
      const known = i.pct !== null;
      const level = !known ? "unknown" : i.pct >= CRITICAL ? "crit" : i.pct >= WARN ? "warn" : "ok";
      const value = known ? `${i.pct}%` : "–";
      const name = `${i.label} — ${i.tip}`;
      return `
        <span class="mem-item" title="${this._esc(name)}">
          <span class="mem-label" aria-hidden="true">${this._esc(i.label)}</span>
          <span class="mem-bar ${level}" role="meter" aria-label="${this._esc(name)}"
                aria-valuemin="0" aria-valuemax="100" ${known ? `aria-valuenow="${i.pct}"` : ""}
                aria-valuetext="${this._esc(`${i.label}: ${known ? value : i.tip}`)}"><span class="mem-fill" style="width:${known ? i.pct : 0}%"></span></span>
          <span class="mem-val" aria-hidden="true">${value}</span>
        </span>`;
    }).join("");
  },

  _paintMemory() {
    const el = this.shadowRoot?.querySelector(".toolbar-memory");
    if (el) el.innerHTML = this._htmlMemoryBars();
  },

  async _memoryFetch() {
    const entry = this._currentEntry;
    const device = this._memoryDevice();
    if (!entry || !device?.available || !this._memoryEnabled()) return;
    try {
      const data = await this._hass.callWS({ type: "lizaip_config/device_memory", entry_id: entry });
      if (entry !== this._currentEntry || !this._memoryEnabled()) return;
      // A part that did not answer this time keeps its last reading: the
      // device's endpoints fail one at a time (a busy heap report answers 500
      // while the flash one still answers), and a bar that blinks out and
      // back on every poll says nothing about memory.
      const before = this._memory?.entry === entry ? this._memory.data || {} : {};
      const fresh = data?.available ? data : {};
      this._memory = {
        entry,
        data: {
          ram: fresh.ram ?? before.ram,
          image_flash: fresh.image_flash ?? before.image_flash,
          file_flash: fresh.file_flash ?? before.file_flash,
        },
      };
    } catch (e) {
      console.debug("[LIZA] device memory read failed:", e);
      return;
    }
    this._paintMemory();
  },

  _memoryFetchSoon() {
    clearTimeout(this._memoryDebounce);
    this._memoryDebounce = setTimeout(() => this._memoryFetch(), MEMORY_DEBOUNCE_MS);
  },

  _memoryStop() {
    clearInterval(this._memoryTimer);
    clearTimeout(this._memoryDebounce);
    this._memoryTimer = null;
    this._memoryDebounce = null;
    this._memoryTimerEntry = null;
  },

  /**
   * Make the poll match the state: running for the selected, online device
   * while the feature is on, stopped otherwise. Called after every render, so
   * it must be cheap and must not fetch when nothing changed.
   */
  _memorySync() {
    const wanted = this._memoryEnabled() && this._memoryDevice()?.available;
    if (!wanted) {
      this._memoryStop();
      return;
    }
    if (this._memoryTimer && this._memoryTimerEntry === this._currentEntry) return;
    this._memoryStop();
    this._memoryTimerEntry = this._currentEntry;
    this._memoryTimer = setInterval(() => this._memoryFetch(), MEMORY_POLL_MS);
    this._memoryFetch();
  },

  async _subscribeDeviceSynced() {
    if (this._syncedUnsub || !this._hass?.connection) return;
    try {
      this._syncedUnsub = await this._hass.connection.subscribeEvents((ev) => {
        if (ev?.data?.entry_id !== this._currentEntry) return;
        if (this._memoryEnabled()) this._memoryFetchSoon();
      }, "lizaip_config_device_synced");
    } catch (e) {
      console.debug("[LIZA] device_synced subscription failed:", e);
    }
  },

  _unsubscribeDeviceSynced() {
    if (this._syncedUnsub) {
      Promise.resolve(this._syncedUnsub).then(u => u && u()).catch(() => {});
      this._syncedUnsub = null;
    }
    this._memoryStop();
  },
};
