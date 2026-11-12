/**
 * A theme as the YAML file it is stored as: downloaded from a tile, and
 * added back by dropping such a file on the Add tile.
 *
 * The file is what lands in `/config/lizaip/themes` on another Home
 * Assistant, so a theme travels as a plain attachment rather than through
 * a panel of its own.
 */

/** A theme file is a few kilobytes; anything far past that is not one. */
const THEME_FILE_MAX_BYTES = 256 * 1024;

/** What a dragged theme tile carries: its id, under a type no file or other
 * drag in the page uses, so a drop can tell the two apart. */
const THEME_DRAG_TYPE = "application/x-lizaip-theme";

export const ThemeDownloadMixin = {
  /** Fetch the theme's own file and hand it to the browser as `<id>.yaml`. */
  async _downloadTheme(themeId) {
    if (!themeId) return;
    await this._runBusy("_themeDownloadBusy", async () => {
      const r = await this._hass.callWS({
        type: "lizaip_config/export_theme", theme_id: themeId,
      });
      const url = URL.createObjectURL(new Blob([r.text], { type: "text/yaml" }));
      this._saveDiagnosticsFile({ url, filename: `${themeId}.yaml` });
      // The anchor has been clicked by now, so the blob has done its job.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, { toast: "settings_theme_download_failed" });
  },
  /** Add a dropped file as a new theme of the user's own. The backend picks
   * a free name, so nothing already there is written over. */
  async _importThemeFile(file) {
    if (!file) return;
    if (file.size > THEME_FILE_MAX_BYTES) {
      this._toast(this._t("settings_theme_import_failed",
        { error: this._t("settings_theme_import_too_big") }));
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (e) {
      this._toast(this._t("settings_theme_import_failed", { error: String(e?.message || e) }));
      return;
    }
    await this._runBusy("_themeImportBusy", async () => {
      const r = await this._hass.callWS({ type: "lizaip_config/import_theme", text });
      if (this._textSettings) this._textSettings.themes = r.themes;
      this._forgetDeviceUrls?.();
      this._toast(this._t("settings_theme_import_done",
        { name: this._themeById(r.id)?.name || r.id }));
    }, { toast: "settings_theme_import_failed" });
  },

  /** Make *el* take a dropped theme file, or a theme tile dragged onto it,
   * which opens a copy of that theme. It is lit while either is held over it;
   * the browser would otherwise open the file in place of the panel. */
  _wireThemeDrop(el) {
    const over = (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      el.classList.add("is-drop-over");
    };
    el.addEventListener("dragenter", over);
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", (ev) => {
      // Moving onto a child of the tile is still over it.
      if (ev.relatedTarget && el.contains?.(ev.relatedTarget)) return;
      el.classList.remove("is-drop-over");
    });
    el.addEventListener("drop", (ev) => {
      ev.preventDefault();
      el.classList.remove("is-drop-over");
      const tile = ev.dataTransfer?.getData?.(THEME_DRAG_TYPE);
      if (tile) this._newThemeEditor(tile);
      else this._importThemeFile(ev.dataTransfer?.files?.[0]);
    });
  },

  /** Let a theme tile be dragged onto Create… to start a copy of it. The
   * whole tile -- frame, preview and name -- is what travels under the
   * pointer, wherever on it the drag began: its pictures are not draggable
   * on their own, and the tile is named as the drag image outright. */
  _wireThemeDrag(el, themeId) {
    el.setAttribute?.("draggable", "true");
    el.querySelectorAll?.("img").forEach((img) => img.setAttribute("draggable", "false"));
    el.addEventListener("dragstart", (ev) => {
      const dt = ev.dataTransfer;
      if (!dt) return;
      dt.setData(THEME_DRAG_TYPE, themeId);
      dt.effectAllowed = "copy";
      const box = el.getBoundingClientRect?.();
      if (box && typeof dt.setDragImage === "function") {
        dt.setDragImage(el, ev.clientX - box.left, ev.clientY - box.top);
      }
    });
  },
};
