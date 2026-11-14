/**
 * lizaIP Panel — Debug View
 * HTML generation and wiring for the Debug tab (expert troubleshooting tools).
 *
 * Not part of a stable release: the build strips this file along with its
 * backend. The panel imports it dynamically after asking
 * `lizaip_config/get_features`, so its absence is ordinary rather than broken.
 *
 * Three tools, all aimed at the same question: is this remote reachable, and if
 * not, where does it stop?
 *
 *   - A reachability probe against the device's own HTTP API. Not a ping: see
 *     `async_probe_reachability` in device/debug.py for why ICMP is the
 *     wrong instrument here.
 *   - A switch for the device's debug log port, which the firmware opens as a
 *     plain TCP stream on request.
 *   - A report gathered from the device's read-only diagnostic endpoints.
 *
 * Its actions are `ha-button`, Home Assistant's own, so their fill, radius,
 * focus ring and disabled state come from the active theme rather than from
 * a drawing of ours that has to be kept in step with it.
 *
 * The tab reports only what it has been told. It never infers a state it has
 * not measured — an address the device has not supplied reads "unknown", not
 * "none".
 *
 * That applies to the log port too, which is read from the device rather than
 * assumed: `GET /Device/Control` carries `DebugPort`. An earlier version of
 * this tab started from "off" on the grounds that the firmware offered no way
 * to read it back — which was wrong, and came from having looked only at
 * `/Device/Status`. The port outlives a restart of Home Assistant while the
 * task reading it does not, so the two are reported separately: a port that is
 * open with nothing listening is a state the tab can show rather than one it
 * has to mislabel.
 */

/**
 * The generator this module offers the add-page dialog, registered as the
 * panel loads it. A template naming `random_pages` runs it; a build without
 * this file registers nothing, so the card never appears.
 */
export const TEMPLATE_ACTIONS = { random_pages: "_showRandomPagesDialog" };

export const DebugViewMixin = {
  /**
   * Forget every debug reading: at construction, and whenever the device
   * changes. Every one belongs to the device being left. A probe result or a
   * log-port state carried across would describe the wrong remote -- and the
   * port toggle would offer to switch off a stream on a device it was never
   * started for.
   *
   * Lives here rather than in the panel because a stable release strips this
   * file, and with it every field below; the panel calls it optionally.
   */
  _resetDebugState() {
    this._debugProbe = null;
    this._debugReport = null;
    // Loaded by the debug tab itself when it is opened, rather than on demand:
    // null means "not read yet", which is what triggers that first read. Cleared
    // to null rather than kept: these are one device's log levels, and showing
    // them under another would invite a change aimed at the wrong remote.
    this._debugLogging = null;
    this._debugLoggingError = null;
    // Which report sections the reader has indented, by endpoint.
    this._debugPretty = {};
    // Which report sections are expanded, and which are being read right now.
    // Kept here rather than left to the `<details>` elements: every render
    // rebuilds them, so an expansion that lived only in the DOM would close
    // itself the moment the section it asked for arrived.
    this._debugOpen = {};
    this._debugSectionBusy = {};
    // "off" is where the switch starts, not what the device is: the port is
    // read from `/Device/Control` when the tab opens. `_known` says whether
    // that read has happened, `_following` whether we are reading the port --
    // an open port outlives a restart of Home Assistant, the task reading it
    // does not.
    this._debugPortOn = false;
    this._debugPortKnown = false;
    this._debugPortFollowing = null;
    // One error slot per action, not one shared one: a shared slot showed a
    // failed report inside the reachability card. The matching busy flags are
    // not reset -- a call still running belongs to the device it started on,
    // and each one checks for itself whether that is still the one shown.
    this._debugProbeError = null;
    this._debugReportError = null;
    this._debugPortError = null;
    this._debugTraffic = null;
    this._debugTrafficError = null;
  },

  /**
   * Ask for the numbers behind a batch of random test pages, then add them.
   *
   * The last step of the add-page walk, drawn into the dialog already open and
   * wearing its chrome: the trail stays readable and Back returns to the
   * folder the card was clicked in. Every button gets one icon from a pool of
   * the chosen size and the one tooltip, so how many images the remote has to
   * hold is set here rather than by the page count.
   */
  _showRandomPagesDialog(meta, { host, close, back, crumbs = [], onCrumb } = {}) {
    const name = this._esc(meta?.name || this._t("random_pages"));
    const desc = this._esc(meta?.description || this._t("random_pages_desc"));
    const field = (id, label, attrs) => `
        <div class="config-field">
          <ha-input appearance="outlined" id="${id}" label="${this._esc(this._t(label))}" ${attrs}></ha-input>
        </div>`;
    host.innerHTML = `
        <div class="add-page-head">
          ${this._addPageBackHtml(back)}
          ${this._addPageCrumbsHtml({ crumbs })}
          <h2 class="liza-sr-only" id="liza-dlg-title">${name}</h2>
        </div>
        <div class="add-page-body is-form-body">
          <div class="template-receipt">
            ${this._tilePlateHtml(meta?.icon)}
            <span class="template-receipt-text">
              <span class="template-receipt-name">${name}</span>
              <span class="template-receipt-sub">${desc}</span>
            </span>
          </div>
          ${field("liza-random-count", "random_pages_count",
                  'type="number" inputmode="numeric" min="1" max="500" value="10"')}
          ${field("liza-random-images", "random_pages_images",
                  'type="number" inputmode="numeric" min="1" max="5000" value="12"')}
          ${field("liza-random-tooltip", "random_pages_tooltip",
                  'autocomplete="off" value="Test"')}
        </div>
        ${this._htmlDialogActions({
          row: "add-page-foot is-form-foot",
          dismiss: { cls: "add-page-cancel", label: this._t("cancel") },
          commit: { cls: "template-confirm-btn", label: this._t("random_pages_create") },
        })}`;

    this._wireAddPageBack(host, () => back());
    host.querySelector(".add-page-cancel").addEventListener("click", close);
    crumbs.forEach((_, i) => {
      if (i === crumbs.length - 1) return;
      host.querySelector(`[data-crumb="${i}"]`)?.addEventListener("click", () => onCrumb?.(i));
    });
    // Every step of the walk arrives ready to be answered from the keyboard.
    host.querySelector("#liza-random-count")?.focus?.();

    const num = (id, def, max) => {
      const v = parseInt(host.querySelector(id).value, 10);
      return Number.isFinite(v) ? Math.min(max, Math.max(1, v)) : def;
    };
    host.querySelector(".template-confirm-btn").addEventListener("click", async () => {
      const count = num("#liza-random-count", 10, 500);
      const images = num("#liza-random-images", 12, 5000);
      const tooltip = host.querySelector("#liza-random-tooltip").value.trim();
      const entry = this._currentEntry;
      close();
      try {
        await this._createPage(() => this._hass.callWS({
          type: "lizaip_config/debug_random_pages",
          entry_id: entry, count, images, tooltip,
        }));
        this._toast(this._t("random_pages_added", { count }));
      } catch (e) {
        console.error("[lizaIP] Random pages failed:", e);
        this._toast(this._t("random_pages_failed", { error: e.message || e }));
      }
    });
  },

  _htmlDebugView() {
    return `
      <div class="debug-view">
        <!-- First: how full the remote's memories are, as bars in the header.
             NB: no backticks in this comment; it sits in a template. -->
        ${this._htmlDebugMemoryCard?.() || ""}

        <ha-card outlined class="debug-card">
          ${this._htmlCardHeader("debug_reachability")}
          <div class="debug-body">
            ${this._htmlDebugProbeResult()}
            ${this._debugProbeError ? `<p class="debug-error">${this._esc(this._debugProbeError)}</p>` : ""}
            <div class="debug-actions">
              <ha-button variant="brand" class="debug-btn primary debug-probe-btn" ${this._debugProbeBusy ? "disabled" : ""}>
                ${this._esc(this._t(this._debugProbeBusy ? "debug_pinging" : "debug_ping"))}
              </ha-button>
            </div>
          </div>
        </ha-card>

        <!-- Then: how the WebSocket link behaves once it is up -- round
             trips, answers that came late or never. Read-only, like the
             probe above it.
             NB: no backticks in this comment; it sits in a template. -->
        ${this._htmlDebugTrafficCard()}

        <ha-card outlined class="debug-card">
          ${this._htmlCardHeader("debug_report", { action: !this._debugReport ? "" : `
            <ha-button appearance="outlined" class="debug-btn debug-report-copy" title="${this._esc(this._t("debug_report_copy"))}" aria-label="${this._esc(this._t("debug_report_copy"))}">
              <ha-icon slot="start" icon="mdi:content-copy" style="--mdc-icon-size:18px" aria-hidden="true"></ha-icon>
              ${this._esc(this._t("debug_report_copy"))}
            </ha-button>` })}
          <div class="debug-body">
            <p class="hint-text">${this._esc(this._t("debug_report_hint"))}</p>
            ${this._debugReportBusy ? `<p class="hint-text">${this._esc(this._t("debug_report_fetching"))}</p>` : ""}
            ${this._htmlDebugReport()}
            ${this._debugReportError ? `<p class="debug-error">${this._esc(this._debugReportError)}</p>` : ""}
          </div>
        </ha-card>

        <!-- Next, and still a read: which modules were logging and at what
             level. It sits above the log-port card because that one changes
             the device, and below the report because it is a detail of it --
             but it loads by itself rather than waiting for a press, since it
             is the one answer here that is needed *before* deciding what to
             collect.
             NB: no backticks in this comment; it sits in a template. -->
        <ha-card outlined class="debug-card">
          ${this._htmlCardHeader("debug_logging")}
          <div class="debug-body">
            <p class="hint-text">${this._esc(this._t("debug_logging_hint"))}</p>
            ${this._htmlDebugLogging()}
            ${this._debugLoggingError ? `<p class="debug-error">${this._esc(this._debugLoggingError)}</p>` : ""}
            <div class="debug-actions">
              <ha-button appearance="outlined" class="debug-btn debug-logging-reset" ${this._debugLoggingBusy || !this._debugLogging ? "disabled" : ""}>
                ${this._esc(this._t(this._debugLoggingBusy ? "debug_logging_loading" : "debug_logging_reset"))}
              </ha-button>
            </div>
          </div>
        </ha-card>

        <!-- Last, and deliberately so: the two cards above only read from the
             device, while this one changes it -- it opens a listening socket
             that stays open until it is switched off. Ordering the tab by
             increasing consequence puts the harmless checks first, which is
             also the order someone actually troubleshooting works through.
             NB: no backticks in this comment; it sits in a template. -->
        <ha-card outlined class="debug-card">
          ${this._htmlCardHeader("debug_log_port")}
          <div class="debug-body">
            <p class="hint-text">${this._esc(this._t("debug_log_port_hint"))}</p>
            ${this._debugPortError ? `<p class="debug-error">${this._esc(this._debugPortError)}</p>` : ""}
            <div class="debug-actions">
              <!-- A switch, not a button: the log stream is a state that stays
                   on until it is turned off, and a switch is what a screen
                   reader announces as on or off rather than reading a verb.
                   NB: no backticks in this comment; it sits in a template. -->
              <div class="debug-switch">
                <ha-switch id="liza-debug-port" class="debug-port-toggle"
                           aria-label="${this._esc(this._t("debug_log_port"))}"
                           ${this._debugPortOn ? "checked" : ""}
                           ${this._debugPortBusy ? "disabled" : ""}></ha-switch>
                <label for="liza-debug-port">${this._esc(this._t(this._debugPortOn ? "debug_stream_on" : "debug_stream_off"))}</label>
              </div>
            </div>
            ${!(this._debugPortOn && this._debugPortFollowing === false) ? "" : `
              <p class="hint-text">${this._esc(this._t("debug_stream_detached"))}</p>`}
            ${!this._debugPortOn ? "" : `<p class="debug-live">${this._t("debug_stream_live", {
              link: `<a href="/config/logs?filter=lizaip.device.log">${this._esc(this._t("debug_stream_live_link"))}</a>`,
              // Escaped, unlike link: this one is a label, and it comes from
              // Home Assistant's own translations rather than from this file.
              button: this._esc(this._t("debug_stream_raw_button")),
            })}</p>`}
          </div>
        </ha-card>
      </div>`;
  },

  /**
   * Render the device's per-module log levels as a list, not as JSON.
   *
   * The device answers with one flat object of module -> level plus a `Version`
   * that is the schema's, not a module's. Listing that among the modules would
   * invent a twentieth one, so it is named separately.
   *
   * Every key the device sends is shown, including ones this build has never
   * heard of: the list is the device's answer about itself, and silently
   * dropping an unrecognised module would hide exactly the newly added thing
   * someone is likely to be chasing.
   */
  _htmlDebugLogging() {
    const s = this._debugLogging;
    if (!s) {
      return this._debugLoggingBusy
        ? `<p class="hint-text">${this._esc(this._t("debug_logging_loading"))}</p>`
        : "";
    }
    const modules = Object.entries(s.modules || {});
    if (!modules.length) {
      return `<p class="hint-text">${this._esc(this._t("debug_logging_empty"))}</p>`;
    }
    // The levels come from the device's reply rather than from a list compiled
    // in here, so a firmware that gains one offers it without a panel change.
    const levels = s.levels?.length ? s.levels : [];
    const rows = modules.map(([mod, level]) => {
      // A level the device reports but does not offer is still shown, and shown
      // as selected: dropping it would silently reassign the module to whatever
      // option happened to come first.
      const options = (levels.includes(level) ? levels : [level, ...levels])
        .map((l) => ({ value: l, label: l }));
      return `
          <ha-select id="liza-log-${this._esc(mod)}" class="debug-level-select"
                  label="${this._esc(mod)}" data-module="${this._esc(mod)}"${this._haSelectAttrs(options, level)}
                  ${this._debugLoggingBusy ? "disabled" : ""}></ha-select>`;
    }).join("");
    return `
      <div class="debug-levels">${rows}</div>
      ${s.version ? `<p class="hint-text">${this._esc(this._t("debug_logging_version", { version: s.version }))}</p>` : ""}`;
  },

  /**
   * Send one module's level, and take the device's answer over the request.
   *
   * The reply is the device's whole setup read back, which is what is stored:
   * a level the firmware adjusted or declined would otherwise be displayed as
   * the one that was asked for. On failure the previous setup is kept and the
   * error shown beside it, so the list never claims a change that did not take.
   */
  async _setDebugLogLevel(module, level) {
    await this._runDebug("_debugLoggingBusy", "_debugLoggingError",
      (entry) => this._hass.callWS({
        type: "lizaip_config/set_log_level",
        entry_id: entry,
        module,
        level,
      }),
      (setup) => { if (setup?.modules) this._debugLogging = setup; });
  },

  /**
   * One read or write against the selected remote, the way every tool on this
   * tab makes it: skipped without a remote or while *busyField* is set, which
   * is held for the duration; *errorField* cleared before and set from a
   * failure (`apply` may throw to report one); `onError` undoes what a failure
   * leaves stale. An answer, or a failure, arriving after the selection moved
   * is dropped: it describes the device that was asked, and posting it under
   * another one is worse than showing nothing. The guard, the flag and the
   * inline error are `_runBusy`'s; this adds the tab's quiet start and the
   * check that the answer is still wanted.
   */
  async _runDebug(busyField, errorField, request, apply, onError = null) {
    // Read before the first await: `_enterDebugTab` sets it only while it
    // starts its loads, and draws for all of them itself.
    const quiet = this._debugQuiet === true;
    await this._runBusy(busyField, async (entry) => {
      const result = await request(entry);
      if (this._currentEntry !== entry) return;
      apply(result);
    }, { errorField, onError, render: !quiet });
  },

  /**
   * Read which modules are logging, and at what level.
   *
   * Parsed by the backend rather than here: the same shape is needed after a
   * write, and one parser means the two cannot disagree about what the device
   * said.
   *
   * Runs on its own when the tab is opened, unlike the other three tools. It
   * costs one small read, and it is the answer needed *before* deciding what
   * else to collect -- a log is unreadable without knowing which modules were
   * even writing to it. Retried only on request: a failure that re-fetched
   * itself would hammer an already-struggling device on every render.
   */
  async _loadDebugLogging() {
    await this._runDebug("_debugLoggingBusy", "_debugLoggingError",
      (entry) => this._hass.callWS({
        type: "lizaip_config/debug_logging",
        entry_id: entry,
      }),
      (setup) => this._takeDebugLogging(setup),
      () => { this._debugLogging = null; });
  },

  /** A whole logging setup read back from the device, or why there is none. */
  _takeDebugLogging(setup) {
    if (setup?.error) throw new Error(setup.error);
    this._debugLogging = setup?.modules ? setup : null;
    if (!this._debugLogging) this._debugLoggingError = this._t("debug_logging_empty");
  },

  /**
   * Read whether the device's log port is open, and whether we are reading it.
   *
   * The two come apart: the port stays open on the device across a restart of
   * Home Assistant, while the task that reads it is gone. Asking the device is
   * the only way to tell an open port from a closed one, and asking ourselves
   * is the only way to tell a stream that is running from one that is not.
   *
   * A failure leaves the switch showing what it last knew rather than guessing
   * "off": claiming a port is closed is how someone ends up leaving one open.
   */
  async _loadDebugPortState() {
    if (!this._currentEntry) return;
    const entry = this._currentEntry;
    // Busy only counts for this remote: a read still in flight for the one
    // just left must not stop the new one from being read.
    if (this._debugPortBusy && this._debugPortBusyFor === entry) return;
    const quiet = this._debugQuiet === true;
    this._debugPortBusy = true;
    this._debugPortBusyFor = entry;
    if (!quiet) this._render();
    try {
      const state = await this._hass.callWS({
        type: "lizaip_config/debug_port_state",
        entry_id: entry,
      });
      if (this._currentEntry !== entry) return;
      if (state?.error || typeof state?.enabled !== "boolean") {
        this._debugPortError = state?.error || this._t("debug_port_unknown");
        return;
      }
      this._debugPortOn = state.enabled;
      this._debugPortFollowing = state.following ?? null;
      this._debugPortKnown = true;
    } catch (e) {
      if (this._currentEntry !== entry) return;
      this._debugPortError = this._wsErrorText(e);
    } finally {
      if (this._debugPortBusyFor === entry) this._debugPortBusy = false;
      if (!quiet) this._render();
    }
  },

  /**
   * Re-read the log-stream switch whenever the debug page comes back into
   * view without being re-entered: the browser tab foregrounded, Home
   * Assistant's connection restored, the remote reconnected. The port is the
   * device's, and any of those can mean it changed -- a reboot closes it --
   * while the switch went on showing what it last knew.
   */
  _recheckDebugPort() {
    if (this._activeTab !== "debug" || !this._currentEntry) return;
    this._loadDebugPortState();
  },

  /**
   * Called when the debug tab is opened, and only then.
   *
   * Everything this tab shows is a statement about the device *now*: levels a
   * reboot has reset, a port someone else has closed. Holding on to the last
   * answer would present all of that as current, so entering the tab throws it
   * away and asks again. This is also the only retry a failed read gets --
   * there is no reload button to press, which is the point: a button that only
   * ever means "ask again" is a chore handed to the reader, and re-entering
   * the tab is the thing they were going to do anyway.
   *
   * Not `_wireDebugView`, which runs on every render: this is an edge, and
   * hanging the reads off a render would fetch in a loop.
   *
   * The report's list of readable endpoints is fetched here for the same
   * reason as the rest: it costs one call, carries no device data, and asking
   * the reader to press a button to be shown a set of headings demanded
   * something of them and told them nothing. The choice that matters is which
   * section to expand, and that is where the device is actually read.
   */
  _enterDebugTab() {
    this._debugLogging = null;
    this._debugLoggingError = null;
    this._debugPortKnown = false;
    this._debugPortError = null;
    // Cleared here rather than left to `_fetchDebugReport`, which also clears
    // it: the fetch is a round trip, and until it returns the card would go on
    // showing the rows of the reading just left as though they were current.
    // The rest of the report's state -- what was expanded, what was formatted
    // -- is reset there, where the new list is built.
    this._debugReport = null;
    this._debugTraffic = null;
    this._debugTrafficError = null;
    // The four reads each drew the tab on the way in and again on the way
    // out. Started quiet, they raise their busy flags, the tab is drawn once
    // with all of them, and once more when the last has answered.
    let loads;
    this._debugQuiet = true;
    try {
      loads = [
        this._loadDebugTraffic(),
        this._loadDebugLogging(),
        this._loadDebugPortState(),
        this._fetchDebugReport(),
      ];
    } finally {
      this._debugQuiet = false;
    }
    this._render();
    Promise.allSettled(loads).then(() => this._render());
  },

  /**
   * Put every module back to the level the device ships with.
   *
   * The device's answer to the reset is the new list, so the card is refreshed
   * from what came back rather than from a second read: two requests could
   * disagree, and the one that wrote is the one that knows.
   */
  async _resetDebugLogging() {
    await this._runDebug("_debugLoggingBusy", "_debugLoggingError",
      (entry) => this._hass.callWS({
        type: "lizaip_config/reset_log_levels",
        entry_id: entry,
      }),
      (setup) => this._takeDebugLogging(setup));
  },

  _htmlDebugProbeResult() {
    const p = this._debugProbe;
    if (!p) {
      return `<p class="hint-text">${this._esc(this._t("debug_not_tested"))}</p>`;
    }

    // "no_address" is the one outcome that is not a failure to report but a
    // state to explain: the remote dials us, so until it has connected once
    // there is no address to probe. Saying "unreachable" there would blame the
    // network for a device that has simply never been seen.
    if (p.reason === "no_address") {
      return `<p class="hint-text">${this._esc(this._t("debug_never_connected"))}</p>`;
    }

    const rows = [];
    if (p.peer_ip) rows.push([this._t("debug_address"), `${p.peer_ip}${p.http_port ? ":" + p.http_port : ""}`]);
    if (typeof p.latency_ms === "number") rows.push([this._t("debug_latency"), `${p.latency_ms} ms`]);
    if (typeof p.status === "number") rows.push(["HTTP", String(p.status)]);
    if (p.error) rows.push([this._t("debug_error"), p.error]);
    rows.push([this._t("debug_websocket"), this._t(p.connected ? "debug_connected" : "debug_disconnected")]);

    const verdict = p.reachable ? this._t("debug_reachable") : this._t("debug_unreachable");
    return `
      <p class="debug-verdict ${p.reachable ? "ok" : "bad"}">${this._esc(verdict)}</p>
      <dl class="debug-facts">
        ${rows.map(([k, v]) => `<dt>${this._esc(k)}</dt><dd>${this._esc(String(v))}</dd>`).join("")}
      </dl>`;
  },

  _htmlDebugReport() {
    const r = this._debugReport;
    if (!r) return "";
    if (!r.available) {
      return `<p class="hint-text">${this._esc(this._t("debug_never_connected"))}</p>`;
    }
    // Each endpoint is shown with its own outcome, including its failure. A
    // firmware that does not implement one of them must not make the report
    // read as though the device were unreachable.
    //
    // A row is read from the device when it is expanded, not when the report is
    // started. Collecting all of them up front spent a request -- and, for the
    // log, a quarter of a megabyte -- on every endpoint to answer a question
    // about one of them, and made the reader wait for the slowest before the
    // list settled.
    return Object.entries(r.sections || {}).map(([endpoint, section]) => {
      const open = !!this._debugOpen?.[endpoint];
      const busy = !!this._debugSectionBusy?.[endpoint];
      const pretty = !!this._debugPretty?.[endpoint];
      // Offered only where it can actually be done, decided by parsing rather
      // than by which endpoint this is: a body cut short, or a firmware that
      // answers with something other than JSON, has no pretty form and must
      // not get a button that silently does nothing.
      const json = section && !section.error
        ? this._sectionJsonHtml(section)
        : null;

      let state = "";
      if (busy) state = ` — ${this._t("debug_section_pending")}`;
      else if (section?.status) state = ` — ${section.status}`;

      let inner = "";
      if (busy) {
        inner = `<p class="hint-text">${this._esc(this._t("debug_section_pending"))}</p>`;
      } else if (section) {
        const body = section.error
          ? this._ansiToHtml(section.error)
          : (pretty && json ? json : this._ansiToHtml(section.body || ""));
        inner = `<pre class="debug-dump">${body}</pre>${
          section.truncated ? `
          <div class="debug-section-note">${this._esc(
            this._t("debug_section_truncated").replace(
              "{length}", String(section.length ?? ""),
            ),
          )}</div>` : ""}`;
      }

      // Home Assistant's expansion panel. The button sits on its heading row
      // so the heading and its one control read as one row; its own click is
      // stopped from also collapsing the section it formats.
      return `
        <ha-expansion-panel class="debug-section" data-endpoint="${this._esc(endpoint)}" outlined ${open ? "expanded" : ""}>
          <span slot="header" class="debug-section-name">${this._esc(endpoint)}${this._esc(state)}</span>
          ${json ? `
            <ha-button slot="icons" class="debug-pretty-btn" data-endpoint="${this._esc(endpoint)}"
                    size="s" appearance="${pretty ? "filled" : "outlined"}"
                    aria-pressed="${pretty ? "true" : "false"}">
              ${this._esc(this._t(pretty ? "debug_raw" : "debug_pretty"))}
            </ha-button>` : ""}
          ${inner}
        </ha-expansion-panel>`;
    }).join("");
  },

  /**
   * Render the device's own colouring, rather than dropping it or showing the
   * codes it is made of.
   *
   * The dump is device output and is never trusted as markup: every run of text
   * is HTML-escaped first, and the only tags produced are the spans this builds
   * itself. Colour numbers stay the device's own -- they are not mapped onto
   * theme colours, so the panel shows what a terminal would show.
   *
   * Escapes that are not colour (cursor moves, window titles) and bare control
   * characters are dropped: nothing here can act on them, and they would only
   * appear as noise.
   */
  _ansiToHtml(text) {
    const src = String(text ?? "");
    // One pass, alternation ordered so a complete escape wins over the stray
    // ESC that the trailing control-character class would otherwise match.
    const token = /\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
    const out = [];
    const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
    let open = false;
    let last = 0;

    const closeSpan = () => {
      if (open) { out.push("</span>"); open = false; }
    };
    const openSpan = () => {
      const cls = [];
      const style = [];
      if (typeof st.fg === "number") cls.push("a-fg-" + st.fg);
      else if (st.fg) style.push("color:" + st.fg);
      if (typeof st.bg === "number") cls.push("a-bg-" + st.bg);
      else if (st.bg) style.push("background-color:" + st.bg);
      if (st.bold) cls.push("a-bold");
      if (st.dim) cls.push("a-dim");
      if (st.italic) cls.push("a-italic");
      if (st.underline) cls.push("a-underline");
      if (!cls.length && !style.length) return;
      out.push('<span class="' + cls.join(" ") + '" style="' + style.join(";") + '">');
      open = true;
    };
    const emit = (chunk) => {
      if (!chunk) return;
      if (!open) openSpan();
      out.push(this._esc(chunk));
    };

    let m;
    while ((m = token.exec(src)) !== null) {
      emit(src.slice(last, m.index));
      last = token.lastIndex;
      if (m[1] === undefined) continue;   // not a colour code: drop it
      closeSpan();
      this._applySgr(st, m[1]);
    }
    emit(src.slice(last));
    closeSpan();
    return out.join("");
  },

  /**
   * Fold one SGR parameter list into the running state.
   *
   * An empty list means reset, which is what a bare ESC[m is. Extended colour
   * is read as a unit because its arguments follow in the same list, and its
   * components are clamped to bytes -- they end up in a style attribute, so
   * nothing from the device may reach it unchecked.
   */
  _applySgr(st, params) {
    const codes = (params === "" ? "0" : params).split(";").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { st.fg = st.bg = null; st.bold = st.dim = st.italic = st.underline = false; }
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 38 || c === 48) {
        const target = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) { st[target] = this._ansiColor256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2) {
          const b = (n) => Math.max(0, Math.min(255, codes[n] | 0));
          st[target] = "rgb(" + b(i + 2) + "," + b(i + 3) + "," + b(i + 4) + ")";
          i += 4;
        }
      }
    }
  },

  /** The 256-colour cube, as the numbered palette or an explicit rgb(). */
  _ansiColor256(n) {
    const v = Math.max(0, Math.min(255, n | 0));
    if (v < 16) return v;                       // the same 16 the classes cover
    if (v < 232) {
      const c = v - 16;
      const step = (x) => (x === 0 ? 0 : 55 + x * 40);
      return "rgb(" + step(Math.floor(c / 36) % 6) + "," +
        step(Math.floor(c / 6) % 6) + "," + step(c % 6) + ")";
    }
    const g = 8 + (v - 232) * 10;               // the greyscale ramp
    return "rgb(" + g + "," + g + "," + g + ")";
  },

  /** The same text with the colouring taken out, for a bug report. */
  _ansiPlain(text) {
    return String(text ?? "").replace(
      /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])|[\x00-\x08\x0b-\x1f\x7f]/g,
      "",
    );
  },

  /**
   * List what can be read from the device. Reading it is a separate step.
   *
   * Only the plan is fetched here. The sections follow one at a time, when the
   * reader expands one -- see `_toggleDebugSection`.
   */
  async _fetchDebugReport() {
    await this._runDebug("_debugReportBusy", "_debugReportError",
      (entry) => this._hass.callWS({
        type: "lizaip_config/debug_report",
        entry_id: entry,
      }),
      (plan) => this._takeDebugReport(plan),
      () => { this._debugReport = null; });
  },

  _takeDebugReport(plan) {
    if (!plan.available) {
      this._debugReport = plan;
      return;
    }

    // A row that has not been read is null, which is what tells the renderer
    // it has nothing to show yet. Seeding them all keeps the list in the
    // device's order rather than in the order the reader happens to open
    // them.
    const sections = {};
    for (const endpoint of plan.endpoints) sections[endpoint] = null;
    this._debugReport = { ...plan, sections };
    // A second run starts from a clean slate: these describe rows of the
    // report just replaced, and an expansion carried over would re-read an
    // endpoint the reader did not ask for again.
    this._debugOpen = {};
    this._debugSectionBusy = {};
    this._debugPretty = {};
  },

  /**
   * Record an expansion, and read the section the first time it is opened.
   *
   * Read once, not on every expansion: re-reading on each open would mean a
   * section could change under a reader who collapsed it to look at another,
   * and would make comparing two of them a matter of timing. The button at the
   * top is what takes a fresh reading.
   */
  async _toggleDebugSection(endpoint, open) {
    this._debugOpen = { ...this._debugOpen, [endpoint]: open };
    const r = this._debugReport;
    if (!open || !r?.sections || r.sections[endpoint] !== null) return;
    if (this._debugSectionBusy?.[endpoint]) return;

    const entry = this._currentEntry;
    this._debugSectionBusy = { ...this._debugSectionBusy, [endpoint]: true };
    this._render();
    let section;
    try {
      const answer = await this._hass.callWS({
        type: "lizaip_config/debug_report",
        entry_id: entry,
        endpoint,
      });
      section = answer.section;
    } catch (e) {
      // The failure is a fact about the device and belongs in the row that
      // asked for it, not in the report's own error line -- the other rows are
      // unaffected and must keep saying so.
      section = { error: this._wsErrorText(e) };
    }
    // Selection moved on while the read was out: writing it now would file one
    // device's answer under another.
    if (this._currentEntry !== entry) return;
    this._debugSectionBusy = { ...this._debugSectionBusy, [endpoint]: false };
    if (!this._debugReport?.sections) return;
    this._debugReport = {
      ...this._debugReport,
      sections: { ...this._debugReport.sections, [endpoint]: section },
    };
    this._render();
  },

  /**
   * The body as indented, coloured HTML -- or null when it is not JSON.
   *
   * Built by walking the *parsed* value rather than by running a regex over the
   * text. A regex over JSON has to decide for itself where a string ends, which
   * means getting `\"` right, and getting it wrong colours half a document as a
   * string. Walking the parse cannot make that mistake, and every piece of text
   * that reaches the output goes through `_esc` on the way.
   *
   * Returning null rather than the original text is what lets the caller know
   * there is nothing to offer, so no button appears.
   */
  _jsonHtml(text) {
    const trimmed = String(text ?? "").trim();
    // Cheap gate so a 270 KB device log is not handed to the parser on every
    // render. It decides nothing the parse would not decide.
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return this._jsonNode(value, "");
  },

  /**
   * `_jsonHtml` of a section's body, worked out once per answer rather than
   * on every render of the tab. Kept beside the section object, which is
   * replaced whenever a new answer arrives, and checked against the body too,
   * so an answer can never be shown in the pretty form of an older one.
   */
  _sectionJsonHtml(section) {
    const cache = (this._debugJsonCache ||= new WeakMap());
    const body = section.body || "";
    const hit = cache.get(section);
    if (hit && hit.body === body) return hit.html;
    const html = this._jsonHtml(body);
    cache.set(section, { body, html });
    return html;
  },

  _jsonNode(value, pad) {
    if (value === null) return `<span class="json-null">null</span>`;
    const type = typeof value;
    if (type === "boolean") return `<span class="json-bool">${value}</span>`;
    if (type === "number") return `<span class="json-num">${this._esc(String(value))}</span>`;
    if (type === "string") {
      return `<span class="json-str">${this._esc(JSON.stringify(value))}</span>`;
    }
    const inner = pad + "  ";
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      const items = value.map((v) => inner + this._jsonNode(v, inner));
      return `[\n${items.join(",\n")}\n${pad}]`;
    }
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const items = keys.map((k) =>
      `${inner}<span class="json-key">${this._esc(JSON.stringify(k))}</span>: `
      + this._jsonNode(value[k], inner));
    return `{\n${items.join(",\n")}\n${pad}}`;
  },

  _toggleDebugPretty(endpoint) {
    this._debugPretty = this._debugPretty || {};
    this._debugPretty[endpoint] = !this._debugPretty[endpoint];
    this._render();
  },

  /**
   * Indent a JSON body so it can be read, leaving anything else untouched.
   *
   * Decided by whether it parses rather than by which endpoint it came from:
   * the device's log is not JSON and must survive verbatim, a body cut off by
   * the size limit is no longer valid JSON and would be mangled by any
   * formatter willing to guess, and a firmware that changes what an endpoint
   * returns cannot make this wrong. Only the whitespace differs from what the
   * device sent -- keys keep their order, because `JSON.parse` preserves
   * insertion order for string keys and the device's order is information.
   *
   * The opening-brace check decides nothing that the parse does not already
   * decide; it is there to keep 20 KB of log off `JSON.parse` on every render.
   */
  _prettyJson(text) {
    const src = String(text ?? "");
    const trimmed = src.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return src;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return src;
    }
  },

  /**
   * Render the report as text meant for a bug report, not as raw JSON.
   *
   * Includes the reachability reading when one has been taken: "the report was
   * empty" and "the device was not answering when it was taken" are different
   * complaints, and the second is invisible from the sections alone.
   */
  _debugReportText() {
    const r = this._debugReport;
    if (!r) return "";
    const out = [`lizaIP device report — ${new Date().toISOString()}`];
    if (r.peer_ip) out.push(`Device: ${r.peer_ip}`);

    const p = this._debugProbe;
    if (p) {
      out.push(`Reachable: ${p.reachable ? "yes" : "no"}${
        p.reason && p.reason !== "ok" ? ` (${p.reason})` : ""
      }${typeof p.latency_ms === "number" ? ` — ${p.latency_ms} ms` : ""}`);
      out.push(`WebSocket: ${p.connected ? "connected" : "disconnected"}`);
    }

    for (const [endpoint, section] of Object.entries(r.sections || {})) {
      // Copying is possible while the report is still filling in. Saying so is
      // the point: a section quietly missing from a pasted report reads as one
      // the device did not answer, which is a different fault entirely.
      if (!section) {
        out.push("", `=== ${endpoint} ===`, "(not collected yet)");
        continue;
      }
      out.push("", `=== ${endpoint}${section.status ? ` — HTTP ${section.status}` : ""} ===`);
      // What was copied is what was being looked at: a reader who indented a
      // section to make sense of it is the one pasting it somewhere.
      const raw = this._ansiPlain(section.body || "");
      const shown = this._debugPretty?.[endpoint] ? this._prettyJson(raw) : raw;
      out.push(section.error ? `ERROR: ${section.error}` : shown.trim());
      // A cut has to survive the paste, or the bug report shows a log that
      // simply stops and reads as a device that stopped logging.
      if (section.truncated) {
        out.push(`(cut off — device sent ${section.length} characters)`);
      }
    }
    return out.join("\n");
  },

  async _copyDebugReport() {
    await this._copyDebugText(this._debugReportText(), "debug_report_copied");
  },

  async _copyDebugText(text, doneKey) {
    if (!text) return;
    try {
      // `navigator.clipboard` exists only in a secure context, and Home
      // Assistant is commonly reached over plain HTTP on a LAN address — where
      // it is not merely blocked but undefined. The textarea fallback is the
      // one that actually runs for most users, so it is not an afterthought.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        // Off-screen rather than hidden: `display:none` cannot hold a selection.
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        this.shadowRoot.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("execCommand refused");
      }
      this._toast(this._t(doneKey));
    } catch (e) {
      this._toast(this._t("debug_report_copy_failed", { error: e?.message || e }));
    }
  },

  _wireDebugView() {
    const root = this.shadowRoot;
    // The memory-bars switch, which lives on this tab in the settings tab's
    // row.
    root.querySelectorAll(".settings-feature-switch").forEach((el) =>
      el.addEventListener("change", (ev) =>
        this._changeTextSetting(el.dataset.section, "enabled", ev.target.checked)));
    this._wireSwitchLabels(root, ".settings-switch-text label, .debug-switch label");
    root.querySelector(".debug-probe-btn")?.addEventListener("click", () => this._runDebugProbe());
    root.querySelector(".debug-port-toggle")
        ?.addEventListener("change", (ev) => this._setDebugPort(!!ev.target.checked));
    root.querySelector(".debug-report-copy")?.addEventListener("click", () => this._copyDebugReport());
    root.querySelector(".debug-logging-reset")?.addEventListener("click", () => this._resetDebugLogging());
    root.querySelector(".debug-traffic-refresh")?.addEventListener("click", () => this._loadDebugTraffic());
    root.querySelector(".debug-traffic-reset")
        ?.addEventListener("click", () => this._loadDebugTraffic({ reset: true }));
    root.querySelector(".debug-traffic-copy")
        ?.addEventListener("click", () => this._copyDebugText(this._debugTrafficText(), "debug_traffic_copied"));
    root.querySelector(".debug-traffic-log")
        ?.addEventListener("change", (ev) =>
          this._loadDebugTraffic({ log_enabled: !!ev.target.checked }));
    root.querySelectorAll(".debug-pretty-btn").forEach((el) =>
      el.addEventListener("click", (e) => {
        // The button sits in the expansion panel's header row, where a click
        // is the panel's own way of collapsing the section. Formatting a
        // section and closing it are opposite intentions.
        e.preventDefault();
        e.stopPropagation();
        this._toggleDebugPretty(el.dataset.endpoint);
      }));
    // The state that changed, not a click on the heading: it is also reached
    // by keyboard. It fires on a change, not on a render, so a section that
    // re-renders with its body filled in does not ask for that body again.
    root.querySelectorAll(".debug-section").forEach((el) =>
      el.addEventListener("expanded-changed", (e) =>
        this._toggleDebugSection(el.dataset.endpoint, !!e.detail?.expanded)));
    // A pick, not each option passed over on the way to it: anything else
    // would send the device every level between the old and the new.
    root.querySelectorAll(".debug-level-select").forEach((el) =>
      this._wireHaSelect(el, (level) => this._setDebugLogLevel(el.dataset.module, level)));
  },

  /**
   * The Traffic card: how the WebSocket link with the remote behaves.
   *
   * Numbers first -- they answer "is it slow, is it losing things" at a
   * glance -- then the messages themselves, newest first, so the one that just
   * went wrong is at the top. Read on demand rather than polled: a re-render
   * every second would close an open select elsewhere on the tab.
   */
  _htmlDebugTrafficCard() {
    const tr = this._debugTraffic;
    const logOn = !!tr?.log_enabled;
    const busy = !!this._debugTrafficBusy;
    return `
        <ha-card outlined class="debug-card debug-traffic">
          ${this._htmlCardHeader("debug_traffic", { action: !tr ? "" : `
            <ha-button appearance="outlined" class="debug-btn debug-traffic-copy" title="${this._esc(this._t("debug_report_copy"))}" aria-label="${this._esc(this._t("debug_report_copy"))}">
              <ha-icon slot="start" icon="mdi:content-copy" style="--mdc-icon-size:18px" aria-hidden="true"></ha-icon>
              ${this._esc(this._t("debug_report_copy"))}
            </ha-button>` })}
          <div class="debug-body">
            ${tr ? `<p class="hint-text">${this._esc(this._t("debug_traffic_hint", {
              since: this._debugTime(tr.stats.since * 1000, false),
            }))}</p>` : ""}
            ${this._htmlDebugTrafficStats()}
            ${this._debugTrafficError ? `<p class="debug-error">${this._esc(this._debugTrafficError)}</p>` : ""}
            <div class="debug-actions">
              <ha-button variant="brand" class="debug-btn primary debug-traffic-refresh" ${busy ? "disabled" : ""}>
                ${this._esc(this._t("debug_traffic_refresh"))}
              </ha-button>
              <ha-button appearance="outlined" class="debug-btn debug-traffic-reset" ${busy || !tr ? "disabled" : ""}>
                ${this._esc(this._t("debug_traffic_reset"))}
              </ha-button>
              <div class="debug-switch">
                <ha-switch id="liza-debug-traffic-log" class="debug-traffic-log"
                           aria-label="${this._esc(this._t("debug_traffic_log"))}"
                           ${logOn ? "checked" : ""}
                           ${busy || !tr ? "disabled" : ""}></ha-switch>
                <label for="liza-debug-traffic-log">${this._esc(this._t("debug_traffic_log"))}</label>
              </div>
            </div>
            ${!logOn ? "" : `<p class="debug-live">${this._t("debug_traffic_log_live", {
              link: `<a href="/config/logs?filter=lizaip.device.traffic">${this._esc(this._t("debug_stream_live_link"))}</a>`,
            })}</p>`}
            ${this._htmlDebugTrafficFrames()}
          </div>
        </ha-card>`;
  },

  _htmlDebugTrafficStats() {
    const st = this._debugTraffic?.stats;
    if (!st) return "";
    const r = st.rtt_ms || {};
    const ms = (v) => (typeof v === "number" ? `${v} ms` : "–");
    const kb = (v) => `${(v / 1024).toFixed(1)} KB`;
    const rows = [
      [this._t("debug_websocket"), this._t(this._debugTraffic.connected ? "debug_connected" : "debug_disconnected")],
      [this._t("debug_traffic_requests"), String(st.requests)],
      [this._t("debug_traffic_answered"), String(st.answered)],
      [this._t("debug_traffic_timeouts"), String(st.timeouts)],
      [this._t("debug_traffic_late"), String(st.late)],
      [this._t("debug_traffic_lost"), `${st.lost} (${st.lost_pct} %)`],
      [this._t("debug_traffic_errors"), String(st.errors)],
      [this._t("debug_traffic_unmatched"), String(st.unmatched)],
      [this._t("debug_traffic_rtt"), r.n
        ? `min ${ms(r.min)} · ⌀ ${ms(r.avg)} · p50 ${ms(r.p50)} · p95 ${ms(r.p95)} · max ${ms(r.max)} (n=${r.n})`
        : "–"],
      [this._t("debug_traffic_gap"), ms(st.max_gap_ms)],
      [this._t("debug_traffic_gaps"), String(st.gaps)],
      [this._t("debug_traffic_connections"), `${st.connects} / ${st.disconnects}`],
      [this._t("debug_traffic_volume"), `${kb(st.tx_bytes)} (${st.tx}) / ${kb(st.rx_bytes)} (${st.rx})`],
    ];
    const bad = st.lost > 0 || st.timeouts > 0;
    return `
      <dl class="debug-facts${bad ? " debug-traffic-bad" : ""}">
        ${rows.map(([k, v]) => `<dt>${this._esc(k)}</dt><dd>${this._esc(String(v))}</dd>`).join("")}
      </dl>`;
  },

  _htmlDebugTrafficFrames() {
    const frames = this._debugTraffic?.frames;
    if (!frames) return "";
    if (!frames.length) return `<p class="hint-text">${this._esc(this._t("debug_traffic_empty"))}</p>`;
    const rows = frames.slice().reverse().map((f) => {
      const cls = f.type === "timeout" || f.type === "disconnected" || f.late || f.error != null
        ? "bad" : (f.gap_ms != null ? "warn" : "");
      return `<tr class="${cls}">
          <td>${this._esc(this._debugTime(f.t * 1000, true))}</td>
          <td>${f.dir === "tx" ? "→" : f.dir === "rx" ? "←" : "•"}</td>
          <td>${this._esc(this._debugTrafficNote(f))}</td>
        </tr>`;
    }).join("");
    return `
      <h3 class="debug-traffic-subtitle">${this._esc(this._t("debug_traffic_frames"))}</h3>
      <div class="debug-traffic-frames">
        <table><tbody>${rows}</tbody></table>
      </div>`;
  },

  // One message, as a line: what it was, and what came of it.
  _debugTrafficNote(f) {
    const parts = [f.type, f.name];
    if (f.seq != null) parts.push(`#${f.seq}`);
    if (f.size != null) parts.push(`${f.size} B`);
    if (f.rtt_ms != null) parts.push(`${f.late ? "late, " : ""}${f.rtt_ms} ms`);
    if (f.error != null) parts.push(`error ${f.error}`);
    if (f.gap_ms != null) parts.push(`after ${(f.gap_ms / 1000).toFixed(1)} s silence`);
    return parts.filter(Boolean).join(" ");
  },

  _debugTime(ms, withMillis) {
    const d = new Date(ms);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return withMillis ? `${t}.${pad(d.getMilliseconds(), 3)}` : t;
  },

  _debugTrafficText() {
    const tr = this._debugTraffic;
    if (!tr) return "";
    const out = [JSON.stringify(tr.stats, null, 2), ""];
    for (const f of tr.frames || []) {
      const dir = f.dir === "tx" ? "HA → remote" : f.dir === "rx" ? "remote → HA" : "--";
      out.push(`${this._debugTime(f.t * 1000, true)}  ${dir}  ${this._debugTrafficNote(f)}`);
    }
    return out.join("\n");
  },

  async _loadDebugTraffic(opts = {}) {
    await this._runDebug("_debugTrafficBusy", "_debugTrafficError",
      (entry) => this._hass.callWS({
        type: "lizaip_config/debug_traffic",
        entry_id: entry,
        ...opts,
      }),
      (tr) => { this._debugTraffic = tr; });
  },

  // A probe that cannot run is itself a finding, so its failure is shown
  // rather than swallowed into the console.
  async _runDebugProbe() {
    await this._runDebug("_debugProbeBusy", "_debugProbeError",
      (entry) => this._hass.callWS({
        type: "lizaip_config/debug_probe",
        entry_id: entry,
      }),
      (probe) => { this._debugProbe = probe; },
      () => { this._debugProbe = null; });
  },

  async _setDebugPort(enabled) {
    if (!this._currentEntry) return;
    const entry = this._currentEntry;
    if (this._debugPortBusy && this._debugPortBusyFor === entry) return;
    this._debugPortBusy = true;
    this._debugPortBusyFor = entry;
    this._debugPortError = null;
    this._render();
    try {
      await this._hass.callWS({
        type: "lizaip_config/set_debug_port",
        entry_id: entry,
        enabled,
      });
      if (this._currentEntry !== entry) return;
      // A write settles both facts: the port is what we just asked for, and we
      // start reading it exactly when we open it. No re-read needed.
      this._debugPortOn = enabled;
      this._debugPortFollowing = enabled;
      this._debugPortKnown = true;
    } catch (e) {
      if (this._currentEntry !== entry) return;
      this._debugPortError = this._wsErrorText(e);
    } finally {
      if (this._debugPortBusyFor === entry) this._debugPortBusy = false;
      this._render();
    }
  },
};
