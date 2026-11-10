/**
 * lizaIP Panel — Restore View
 * Putting a downloaded configuration back on a remote: the counterpart of the
 * download in the ⋮ menu, and deliberately the longer road.
 *
 * One window walks the whole job in three marked steps — choose a file, look
 * at what is in it, watch it go in — and nothing is written until the user has
 * pressed Restore on the middle one, which they can also step back out of.
 *
 * The archive is checked by `config/restore.py` before anything is touched,
 * and the review step draws its pages as the faces the remote will show, from
 * the same `drawSVG` the editor draws with.
 */

import {
  drawSVG, getPathBounds, cropFace, overlayStyle, titleFit,
} from "./lizaip-svg.js";

export const RestoreViewMixin = {
  /**
   * Put a downloaded configuration back: the counterpart of `_downloadConfig`,
   * and deliberately the longer road. One window walks the whole way -- choose
   * a file, look at what is in it, watch it go in -- headed by the three steps
   * so the user can see how far there is left to go, and with a way back out
   * of the middle one.
   */
  _openRestoreDialog(entryId = null) {
    const entry = entryId || this._currentEntry;
    if (!entry || this._restoreBusy) return;
    const device = (this._devices || []).find((d) => d.entry_id === entry) || null;
    // Everything the window paints itself from, owned by the window: a
    // restore closed half-way leaves nothing for the next one to inherit.
    const ctx = {
      entry, stage: "pick", file: null, summary: null, error: "",
      progress: 0, result: null,
    };
    // The chooser is the operating system's window, but its Escape reaches the
    // page too, where the dialog took it for its own and closed.
    let picking = false;
    // Cleared late: the chooser's events and the dialog's Escape arrive in
    // whichever order, and clearing on the first lets the second through.
    const stopPicking = () => { setTimeout(() => { picking = false; }, 250); };

    const { dlg, close } = this._openModal(this._htmlRestoreDialog(ctx, device), {
      labelledBy: "liza-dlg-title",
      describedBy: "liza-restore-body",
      // Nothing to cancel in the middle of the write, and the chooser's own
      // Escape is delivered here as well.
      canClose: () => !picking && ctx.stage !== "working",
    });
    this._restoreDialog = { dlg, ctx };
    // Regaining focus is the one signal every browser gives for a chooser that
    // is gone, however it went; `cancel` on the input is newer than some.
    window.addEventListener?.("focus", stopPicking);
    // Not the picker itself: the press that opens the chooser would otherwise
    // start the timer that says it is closed again.
    dlg.addEventListener?.("pointerdown", (e) => {
      if (e?.target?.closest?.(".restore-drop")) return;
      stopPicking();
    });
    const forget = () => {
      window.removeEventListener?.("focus", stopPicking);
      if (this._restoreDialog?.dlg === dlg) this._restoreDialog = null;
    };
    dlg._onOverlayClose = forget;

    /** The way out, wherever it is taken from. */
    const leave = () => {
      close();
      // WCAG 2.4.3: the ⋮ the window was opened from is either gone -- a
      // finished restore re-renders the panel -- or sitting in a toolbar whose
      // menu closed long ago, and the focus a dialog hands back on close
      // leaves it ringed. The window lands on the panel instead, once now and
      // once after the frame in case the browser restores focus behind us.
      const land = () => {
        const active = this.shadowRoot?.activeElement;
        if (active && !active.classList?.contains("diag-menu-btn")) return;
        this._a11yFocusFallback?.();
        if (this.shadowRoot?.activeElement === active) active?.blur?.();
      };
      land();
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(land);
    };

    // WCAG 4.1.3: the window changes under the reader -- checking, the
    // review, a refusal -- and none of it moves focus on its own. The
    // node outlives the repaints so a reader keeps watching the same region.
    const live = document.createElement("p");
    live.className = "liza-sr-only";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");

    // WCAG 2.4.3: a repaint replaces every node in the window, so the control
    // the user was on is gone. A change they asked for puts focus on whatever
    // answers it; one that arrives on its own leaves their place alone.
    const repaint = ({ focus = false } = {}) => {
      // A repaint nobody asked for still deletes the node the user is on, so
      // the control they were using is looked up again and handed the keyboard
      // back. Its first class is the one the window's own markup gives it.
      const held = focus ? null : this.shadowRoot?.activeElement;
      const keep = held && dlg.contains?.(held)
        ? String(held.className || "").split(" ")[0] : "";
      dlg.innerHTML = this._htmlRestoreDialog(ctx, device);
      dlg.appendChild?.(live);
      wire();
      const said = this._restoreAnnouncement(ctx);
      if (said) setTimeout(() => { live.textContent = said; }, 50);
      if (!focus) {
        if (keep) this._focusWhenReady(dlg.querySelector(`.${keep}`));
        return;
      }
      this._focusWhenReady(dlg.querySelector(`.${this._restoreFocusClass(ctx)}`));
    };

    const take = (file) => {
      if (!file || ctx.stage === "reading") return;
      ctx.file = file;
      ctx.error = "";
      ctx.progress = 0;
      ctx.stage = "reading";
      repaint();
      // The bar is moved rather than repainted: a repaint per progress event
      // would rebuild the window dozens of times and re-wire it each time.
      const onProgress = (fraction) => {
        ctx.progress = fraction;
        const fill = dlg.querySelector(".restore-bar-fill");
        if (fill?.style) fill.style.width = `${Math.round(fraction * 100)}%`;
      };
      this._uploadRestoreArchive(file, onProgress).then(
        (summary) => { ctx.summary = summary; ctx.stage = "review"; repaint({ focus: true }); },
        (err) => {
          // The window stays open on a refusal: the next thing the user wants
          // is to pick a different file, and a toast over a closed window
          // would mean starting from the menu again.
          ctx.error = this._restoreErrorText(err);
          ctx.summary = null;
          ctx.stage = "pick";
          repaint({ focus: true });
        },
      );
    };

    /** Back to the file: the token is simply never spent and expires by itself. */
    const back = () => {
      ctx.stage = "pick";
      ctx.summary = null;
      ctx.file = null;
      ctx.error = "";
      repaint({ focus: true });
    };

    const wire = () => {
      const input = dlg.querySelector(".restore-input");
      // The chooser is about to cover the window: hold its Escape until then.
      input?.addEventListener("click", () => { picking = true; });
      input?.addEventListener("cancel", stopPicking);
      // `change` is what a picker fires; some browsers deliver only `input`
      // when the file is chosen with the picker's own Open button. Both can
      // arrive for one choice, which `take` makes harmless.
      input?.addEventListener("change", () => { stopPicking(); take(input.files?.[0]); });
      input?.addEventListener("input", () => { stopPicking(); take(input.files?.[0]); });
      const pick = dlg.querySelector(".restore-pick-btn");
      pick?.addEventListener("click", (e) => {
        // The box below would open the chooser a second time.
        e.stopPropagation();
        if (!pick.disabled) input?.click();
      });
      const drop = dlg.querySelector(".restore-drop");
      if (drop) {
        drop.addEventListener("click", (e) => {
          // The input's own click bubbles here on its way out.
          if (e?.target === input || pick?.disabled) return;
          input?.click();
        });
        // Dropping the ZIP straight onto the window is the shortest road of
        // all, and the browser would otherwise navigate away to the file.
        ["dragenter", "dragover"].forEach((type) =>
          drop.addEventListener(type, (e) => {
            e.preventDefault();
            drop.classList.add("over");
          }));
        ["dragleave", "drop"].forEach((type) =>
          drop.addEventListener(type, () => drop.classList.remove("over")));
        drop.addEventListener("drop", (e) => {
          e.preventDefault();
          take(e.dataTransfer?.files?.[0]);
        });
      }
      dlg.querySelector(".restore-back-btn")?.addEventListener("click", () => back());
      dlg.querySelector(".restore-close-btn")?.addEventListener("click", () => leave());
      dlg.querySelector(".restore-dialog-close")?.addEventListener("click", () => leave());
      dlg.querySelector(".restore-confirm-btn")?.addEventListener("click", () => run());
      // The faces are SVG rather than markup, so they are drawn onto the
      // containers the repaint just made, like the editor's own thumbnails.
      this._drawRestoreFaces(dlg, ctx.summary);
    };

    /**
     * Do the restore, and stay to say how it went. The window holds the last
     * step while the files are written and the panel re-reads them, and then
     * says so rather than vanishing and leaving a toast to explain itself.
     */
    const run = async () => {
      if (ctx.stage !== "review" || !ctx.summary) return;
      ctx.stage = "working";
      ctx.error = "";
      repaint();
      let result = null;
      try {
        result = await this._applyRestore(entry, ctx.summary);
      } catch (e) {
        ctx.error = this._restoreErrorText(e);
      }
      if (!result) {
        // The token is spent either way, so there is no going back to the
        // review: the window returns to asking for a file.
        ctx.summary = null;
        ctx.file = null;
        ctx.stage = "pick";
        repaint({ focus: true });
        return;
      }
      await this._reloadAfterRestore(entry);
      ctx.result = result;
      ctx.stage = "done";
      repaint({ focus: true });
    };

    wire();
    // The corner button comes first in the window; what the user came to do
    // is pick a file, so that is what is handed the keyboard.
    dlg.querySelector(".restore-pick-btn")?.focus?.();
  },

  /** The restore window, in whichever of its steps it is in. */
  _htmlRestoreDialog(ctx, device) {
    // `list_devices` calls it `title`; `name` was never a field on these,
    // so every stage of this window used to be headed by a raw device id.
    const name = device?.title || device?.name || device?.device_id || "";
    const subtitle = name
      ? `<span class="confirm-dialog-subtitle">${this._esc(name)}</span>` : "";
    const closeLabel = this._esc(this._t("close"));
    // Nothing to abandon while the files are being written, so the corner
    // button is not offered then.
    const corner = ctx.stage === "working" ? "" : `
        <ha-icon-button class="restore-dialog-close" label="${closeLabel}">
          <ha-icon icon="mdi:close" aria-hidden="true"></ha-icon>
        </ha-icon-button>`;
    return `
      <div class="add-page-dialog restore-dialog" role="document">${corner}
        <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._esc(this._t("restore_config"))}${subtitle}</h2>
        ${this._htmlRestoreSteps(ctx)}
        <div id="liza-restore-body">${this._htmlRestoreBody(ctx)}</div>
        ${this._htmlRestoreActions(ctx)}
      </div>`;
  },

  /**
   * The buttons, which are the step's: a way back and the red press on the
   * review, a single Close once it is over, and none at all while it runs.
   */
  _htmlRestoreActions(ctx) {
    if (ctx.stage === "working") return "";
    if (ctx.stage === "done") {
      return `<div class="template-dialog-actions">
          <ha-button variant="brand" class="debug-btn primary restore-close-btn">${this._esc(this._t("close"))}</ha-button>
        </div>`;
    }
    if (ctx.stage !== "review" || !ctx.summary) return "";
    return `<div class="template-dialog-actions">
        <ha-button appearance="plain" class="confirm-cancel-btn restore-back-btn">${this._esc(this._t("back"))}</ha-button>
        <ha-button variant="danger" class="confirm-danger-btn restore-confirm-btn">${this._esc(this._t("restore_confirm_action"))}</ha-button>
      </div>`;
  },

  /** Which step the window is on, as the user counts them. */
  _restoreStep(ctx) {
    if (ctx.stage === "review") return 1;
    if (ctx.stage === "working" || ctx.stage === "done") return 2;
    return 0;
  },

  /** The control a repaint the user asked for hands the keyboard to. */
  _restoreFocusClass(ctx) {
    if (ctx.stage === "review") return "restore-confirm-btn";
    if (ctx.stage === "done") return "restore-close-btn";
    return "restore-pick-btn";
  },

  /** The three steps, with the one being taken marked as such. */
  _htmlRestoreSteps(ctx) {
    const at = this._restoreStep(ctx);
    const keys = ["restore_step_choose", "restore_step_review", "restore_step_apply"];
    const items = keys.map((key, i) => {
      const state = i < at ? "done" : i === at ? "current" : "";
      const mark = i < at
        ? '<ha-icon icon="mdi:check" aria-hidden="true"></ha-icon>'
        : String(i + 1);
      const current = i === at ? ' aria-current="step"' : "";
      return `<li class="restore-steps-item ${state}"${current}>
          <span class="restore-steps-mark">${mark}</span>
          <span class="restore-steps-name">${this._esc(this._t(key))}</span>
        </li>`;
    }).join("");
    return `<ol class="restore-steps">${items}</ol>`;
  },

  /** What is between the steps and the buttons, which is all that changes. */
  _htmlRestoreBody(ctx) {
    if (ctx.stage === "working") return this._htmlRestoreWorking(ctx);
    if (ctx.stage === "done") return this._htmlRestoreDone(ctx);
    if (ctx.stage === "review" && ctx.summary) return this._htmlRestoreReview(ctx);
    return this._htmlRestorePick(ctx);
  },

  /** Step one: the file, however the user would rather hand it over. */
  _htmlRestorePick(ctx) {
    const reading = ctx.stage === "reading";
    const checking = this._esc(this._t("restore_checking", { filename: ctx.file?.name || "" }));
    const status = reading
      ? `<p class="restore-status">${checking}</p>${this._htmlRestoreBar(ctx.progress)}`
      : ctx.error
        ? `<p class="restore-status error">${this._esc(
            this._t("restore_failed", { error: ctx.error }))}</p>`
        : "";
    // HA's button, opening a file input that is never shown: the native one
    // draws its own button and a file name beside it. The whole box answers a
    // click, not just the button inside it: a dashed frame that says "drop a
    // file here" and answers only in its middle is a target lying about its
    // own size.
    return `
      <div class="restore-drop">
        <input type="file" class="restore-input" accept=".zip" hidden
               ${reading ? "disabled" : ""}>
        <ha-icon icon="mdi:folder-zip-outline" aria-hidden="true"></ha-icon>
        <ha-button variant="brand" class="restore-pick-btn" ${reading ? "disabled" : ""}>
          ${this._esc(this._t("restore_pick_file"))}
        </ha-button>
        <span class="restore-drop-hint">${this._esc(this._t("restore_drop_hint"))}</span>
      </div>
      ${status}`;
  },

  /**
   * Step two: what is in the archive, and what it costs to put it back.
   *
   * The archive leads, as a card headed by its own name, and the sentences
   * under it are what that card means -- rather than five paragraphs the user
   * has to tell apart by reading all of them.
   */
  _htmlRestoreReview(ctx) {
    const lines = this._restoreSummaryLines(ctx.file, ctx.summary);
    const line = (key) => lines.find((l) => l.key === key);
    const meta = [
      line("saved")?.text,
      this._restoreCount("restore_pages_heading", ctx.summary?.pages ?? 0, "pages"),
    ].filter(Boolean).join(" · ");
    const warn = line("warn");
    const rest = warn
      ? `<p class="restore-line ${this._esc(warn.cls)}"><ha-icon icon="mdi:alert-outline"
          aria-hidden="true"></ha-icon><span>${this._esc(warn.text)}</span></p>`
      : "";
    return `
      <div class="restore-card">
        <ha-icon class="restore-card-icon" icon="mdi:folder-zip-outline" aria-hidden="true"></ha-icon>
        <span class="restore-card-text">
          <span class="restore-line file" title="${this._esc(line("file")?.text || "")}"
            >${this._esc(line("file")?.text || "")}</span>
          <span class="restore-card-meta">${this._esc(meta)}</span>
        </span>
      </div>
      ${rest}${this._htmlRestorePages(ctx.summary)}`;
  },

  /** Step three, while it runs. The write is one call the browser cannot see
   *  into, so the bar sweeps rather than claiming a number it does not have. */
  _htmlRestoreWorking(ctx) {
    return `<p class="restore-line">${this._esc(this._restoreWorkingLine(ctx))}</p>
      ${this._htmlRestoreBar(null)}`;
  },

  /** Step three, once it is over. It waits to be dismissed: a window that
   *  closes itself is a window the user is left wondering about. */
  _htmlRestoreDone(ctx) {
    const pages = ctx.result?.pages ?? ctx.summary?.pages ?? 0;
    return `
      <p class="restore-done">
        <ha-icon class="restore-done-icon" icon="mdi:check-circle" aria-hidden="true"></ha-icon>
        <span>${this._esc(this._restoreCount("restore_done", pages, "pages"))}</span>
      </p>`;
  },

  /**
   * The bar. A real fraction while the file goes up, a sweep while the server
   * writes -- that half is one call the browser cannot see into, and a bar
   * pretending to measure it would be making the number up.
   */
  _htmlRestoreBar(fraction) {
    if (fraction == null) {
      return `<div class="restore-bar sweeping" role="progressbar" aria-busy="true">
        <div class="restore-bar-fill"></div></div>`;
    }
    const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    return `<div class="restore-bar" role="progressbar" aria-valuemin="0"
      aria-valuemax="100" aria-valuenow="${percent}">
      <div class="restore-bar-fill" style="width:${percent}%"></div></div>`;
  },

  /**
   * The pages in the archive, in the order the remote would show them, drawn
   * as the faces the editor draws -- the same shapes, the same icons -- so
   * what is about to replace the configuration can be recognised rather than
   * read. The faces are filled in by `_drawRestoreFaces` once the markup is
   * on screen, because they are SVG the editor builds node by node.
   */
  _htmlRestorePages(summary) {
    const rows = this._restorePageTiles(summary);
    if (!rows.length) return "";
    const cells = rows.map((row, i) => `
        <li class="restore-page">
          <div class="pg-svg-container restore-face" data-restore-page="${i}"
               role="img" aria-label="${this._esc(row.title)}"></div>
          <span class="restore-page-title" title="${this._esc(row.title)}">${
            this._esc(row.title)}</span>
          <span class="restore-page-count">${this._esc(
            this._restoreCount("restore_page_buttons", row.buttons, "n"))}</span>
        </li>`).join("");
    return `<ol class="restore-pages">${cells}</ol>`;
  },

  /**
   * Draw the archive's pages onto the faces the review step laid out, over
   * the blueprint of the remote being restored onto -- which is what they
   * will be drawn on once they are written.
   */
  _drawRestoreFaces(dlg, summary) {
    const bp = this._blueprint;
    const faces = dlg?.querySelectorAll?.(".restore-face");
    if (!bp || !faces?.length) return;
    const list = Array.isArray(summary?.page_list) ? summary.page_list : [];
    const mode = this._getThemeMode?.() || "dark";
    faces.forEach((container) => {
      const page = list[Number(container.dataset?.restorePage)];
      if (!page) return;
      const icons = page.icons && typeof page.icons === "object" ? page.icons : {};
      // Named means configured, which is how the shape is drawn; the icon
      // beside the name is what the archive could resolve before the restore.
      const configured = (key) => Object.hasOwn(icons, key);
      container.classList.toggle("face-dark", mode === "dark");
      drawSVG(container, bp, -1, configured, null, { interactive: false });
      cropFace(container.querySelector("svg"));
      this._drawRestoreTitle(container, bp, page.title, mode);
      this._drawRestoreFaceIcons(container, bp, icons, mode);
    });
  },

  /** The archived page's own title, drawn in the bar it will occupy. */
  _drawRestoreTitle(container, bp, image, mode) {
    const img = this._restoreTitleImg(image);
    const btn = (bp.buttons || []).find((b) => b.key === "slider_horizontal");
    const b = btn && getPathBounds(btn.d);
    if (!img || !b) return;
    const clip = document.createElement("div");
    clip.className = "pg-title-clip";
    clip.style.cssText = overlayStyle(b, b.w, b.h);
    const el = document.createElement("img");
    el.className = "pg-btn-img pg-title-img";
    el.alt = "";
    // The picture's own size is only known once it is there, so the bar holds
    // it at the whole title area until then.
    const size = () => Object.assign(
      el.style, titleFit(b, el.naturalWidth, el.naturalHeight),
    );
    el.addEventListener("load", size);
    if (img.src) el.src = img.src;
    else el.setAttribute("data-dev-key", img.key);
    size();
    clip.appendChild(el);
    container.appendChild(clip);
  },

  /**
   * The image server's address for an archived page's title, or nothing when
   * the archive alone cannot say what it shows. A title with no source of its
   * own is a word, which the server draws as text.
   */
  _restoreTitleImg(image) {
    const raw = String(image || "").trim();
    if (!raw || raw.includes("${")) return null;
    if (/^(file:|media:|https?:|\/|data:)/i.test(raw)) return null;
    const img = this._deviceImg(raw, "title");
    return img.src === "" ? null : img;
  },

  /** The icon overlays on one archived page, positioned over its shapes. */
  _drawRestoreFaceIcons(container, bp, icons, mode) {
    for (const btn of bp.buttons || []) {
      // The title bar is not a button: it carries the page's own title.
      if (btn.key === "slider_horizontal") continue;
      const icon = String(icons[btn.key] || "").trim();
      const b = icon && getPathBounds(btn.d);
      const tile = b && this._buildTileImgUrl?.(icon, mode, "", false, null);
      if (!tile || tile.src === "") continue;
      const el = document.createElement("img");
      el.className = "pg-btn-img";
      if (tile.src) el.src = tile.src;
      else el.setAttribute("data-dev-key", tile.key);
      el.alt = "";
      if (this._fitTileImg) this._fitTileImg(el, b, tile.key);
      else el.style.cssText = overlayStyle(b, Math.min(b.w, b.h) * 0.5);
      container.appendChild(el);
    }
  },

  /**
   * The archive's pages as the window draws them. A page has no name of its
   * own: its title comes from the title-image the panel resolves everywhere
   * else, so the same helper names them here.
   */
  _restorePageTiles(summary) {
    const list = Array.isArray(summary?.page_list) ? summary.page_list : [];
    return list.map((page) => {
      const raw = typeof page?.title === "string" ? page.title : "";
      const named = this._pageTitle?.({ title: raw }) || "";
      // A title that is a template is a name only once the remote has state to
      // resolve it against, and the archive carries none: showing the template
      // itself reads as a broken page rather than as a page called that.
      const title = named && !named.includes("${")
        ? named : this._t("page_fallback", { n: page?.id });
      return { id: page?.id, title, buttons: Number(page?.buttons) || 0 };
    });
  },

  /** What is being put on the remote, named by the file it came from. */
  _restoreWorkingLine(ctx) {
    return this._t("restore_working", { filename: ctx.file?.name || "" });
  },

  /** What a reader is told when the window changes state on its own. */
  _restoreAnnouncement(ctx) {
    if (ctx.stage === "working") return this._restoreWorkingLine(ctx);
    if (ctx.stage === "reading") {
      return this._t("restore_checking", { filename: ctx.file?.name || "" });
    }
    if (ctx.stage === "done") {
      return this._restoreCount("restore_done", ctx.result?.pages ?? 0, "pages");
    }
    if (ctx.stage === "review" && ctx.summary) {
      return this._restoreSummaryLines(ctx.file, ctx.summary, ctx.entry)
        .map((l) => l.text).join(" ");
    }
    if (ctx.error) return this._t("restore_failed", { error: ctx.error });
    return "";
  },

  /** A count in the user's language, with the one-of-them form where the
   *  language has one: "1 page", not "1 pages". */
  _restoreCount(key, count, name) {
    const strings = count === 1 ? `${key}_one` : key;
    return this._t(strings, { [name]: count });
  },

  /**
   * When the archive was downloaded, read out of the name it was given.
   *
   * The stamp is the remote's own local time, so it is read as local time;
   * a file the user renamed has none, and its own modified time is the
   * closest thing left to the truth.
   */
  _restoreArchiveDate(file) {
    const stamp = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.zip$/i.exec(file?.name || "");
    const when = stamp
      ? new Date(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6])
      : (file?.lastModified ? new Date(file.lastModified) : null);
    return when && !Number.isNaN(when.getTime()) ? when : null;
  },

  /**
   * What the archive is, and what it is about to replace.
   *
   * Separate from the markup so the wording can be tested without a DOM.
   */
  _restoreSummaryLines(file, summary) {
    const when = this._restoreArchiveDate(file);
    return [
      { key: "file", cls: "file", text: file?.name || "" },
      when
        ? { key: "saved", cls: "note", text: this._t("restore_saved_on", { when: when.toLocaleString() }) }
        : null,
      { key: "warn", cls: "warn", text: this._t("restore_confirm_body", { pages: summary?.pages ?? 0 }) },
    ].filter(Boolean);
  },

  /**
   * Spend the token the upload handed back: the upload parked a checked
   * archive, and this is the half that writes. Split from the reading so that
   * cancelling the window is simply never calling it -- an unspent token
   * expires on its own.
   */
  async _applyRestore(entryId, summary) {
    const entry = entryId || this._currentEntry;
    if (!entry || !summary?.token || this._restoreBusy) return null;
    this._restoreBusy = "applying";
    this._render();
    try {
      // The result carries the page count and whether the remote could be
      // reached -- the difference between "it worked" and "why is my remote
      // still showing the old pages" -- and the window says which.
      return await this._hass.callWS({
        type: "lizaip_config/restore_config",
        entry_id: entry,
        token: summary.token,
      });
    } finally {
      this._restoreBusy = null;
      this._render();
    }
  },

  /** POST the archive and return `{token, device_id, pages, page_list, files}`.
   *
   * `XMLHttpRequest` rather than `fetch`, and the access token by hand: this
   * is the one request the panel makes outside `callWS`, it carries no
   * credentials of its own, and only XHR says how much of it has gone up.
   */
  _uploadRestoreArchive(file, onProgress = null) {
    const auth = this._hass?.auth?.accessToken || this._hass?.auth?.data?.access_token;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/lizaip/restore");
      xhr.setRequestHeader("Content-Type", "application/zip");
      if (auth) xhr.setRequestHeader("Authorization", "Bearer " + auth);
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e?.lengthComputable && e.total) onProgress(e.loaded / e.total);
        };
      }
      const fail = (message, code) => {
        const err = new Error(message);
        if (code) err.code = code;
        reject(err);
      };
      xhr.onerror = () => fail("The upload could not be sent");
      xhr.onload = () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch (_) { /* a body we cannot read */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
          return;
        }
        fail(payload?.message || `HTTP ${xhr.status}`, payload?.code);
      };
      xhr.send(file);
    });
  },

  /** A refusal in the user's language, or the backend's sentence verbatim.
   *
   * `_t` answers an unknown key with the key, which would put `restore_error_
   * failed` on screen; a translation that is still its own name means there is
   * none, and the backend's own detail beats a generic refusal.
   */
  _restoreErrorText(err) {
    const code = err?.code || err?.error?.code;
    const key = code ? `restore_error_${code}` : "";
    const said = key ? this._t(key) : "";
    return (said && said !== key ? said : "") || String(err?.message || err);
  },

  /**
   * Show what was restored, not what was on screen a moment ago. `_loadAll`
   * alone is not enough: the page cache, the selected button and an open
   * editor are all held by index into a page list the restore just replaced,
   * and re-selecting the device is the one path that drops all of it.
   *
   * A restore started from a device-list row, for a remote that is not the
   * one open, has nothing on screen to correct.
   */
  async _reloadAfterRestore(entryId = null) {
    const entry = entryId || this._currentEntry;
    try {
      if (entry && entry === this._currentEntry && this._selectDevice) {
        // Awaited: `_selectDevice` clears the caches straight away but only
        // renders once `_loadAll` answers, and a window that says "done"
        // before that is a window that says it over the old pages.
        await this._selectDevice(entry);
        return;
      }
      await this._loadAll?.();
    } catch (_) { /* the reload is a courtesy; the restore already happened */ }
    this._render();
  },
};
