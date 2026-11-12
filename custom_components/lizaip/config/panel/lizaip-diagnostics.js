/**
 * lizaIP Panel — diagnostics: the ⋮ menu on the toolbar and the device list,
 * the downloads it offers, and the dialog a bundle is built in.
 *
 * Assigned onto the panel's prototype like every other mixin, so these methods
 * run with `this` bound to the panel element.
 */

export const DiagnosticsMixin = {
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
   * diagnostics report, from one place on every screen. Not the user guide:
   * this menu is what is done *to a device*, and help is neither per-device
   * nor an action, so it is a toolbar button instead.
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
    // Last, and set apart: who may configure this remote is an
    // administrator's decision. Greyed out until somebody other than an
    // administrator could be given it.
    if (this._isAdmin?.()) {
      items.push({ separator: true }, {
        cls: "diag-menu-people",
        icon: "mdi:account-multiple",
        label: this._t("assign_user_menu"),
        disabled: !this._hasAssignablePeople,
        run: () => this._openAssignedPeopleDialog(entryId),
      });
    }
    this._openMenu(ev, items, { keepCase: true, anchor: anchor || ev?.currentTarget });
  },

  /** The ⋮ button itself. One markup helper, used by the toolbar and the rows. */
  _htmlDiagnosticsMenuButton(entryId, cls = "") {
    const label = this._esc(this._t("overflow_menu"));
    return `<ha-icon-button class="diag-menu-btn ${cls}" data-entry="${this._esc(entryId || "")}"
                    aria-haspopup="menu" label="${label}">
              <ha-icon icon="mdi:dots-vertical" aria-hidden="true"></ha-icon>
            </ha-icon-button>`;
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
      <div class="template-dialog-actions">
        ${job.state === "error" ? `
        <ha-button variant="brand" class="debug-btn primary diag-dialog-retry">
          ${this._esc(this._t("diagnostics_retry"))}
        </ha-button>` : ""}
        <ha-button appearance="plain" class="debug-btn diag-dialog-close">
          ${this._esc(this._t(job.state === "running" ? "diagnostics_hide" : "close"))}
        </ha-button>
      </div>`;
  },
};
