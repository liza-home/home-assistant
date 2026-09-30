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
 * Plain <button> elements rather than `mwc-button`: nothing else in this panel
 * uses the Material wrappers, and an unregistered custom element renders as an
 * unstyled inline box that does not look clickable at all.
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

export const DebugViewMixin = {
  _htmlDebugView() {
    return `
      <div class="debug-view">
        <ha-card outlined class="debug-card">
          <div class="actions-card-header">
            <h2 class="actions-card-title">${this._t("debug_reachability")}</h2>
          </div>
          <div class="debug-body">
            ${this._htmlDebugProbeResult()}
            ${this._debugProbeError ? `<p class="debug-error">${this._esc(this._debugProbeError)}</p>` : ""}
            <div class="debug-actions">
              <button type="button" class="debug-btn primary debug-probe-btn" ${this._debugProbeBusy ? "disabled" : ""}>
                ${this._debugProbeBusy ? "Ping…" : "Ping"}
              </button>
            </div>
          </div>
        </ha-card>

        <ha-card outlined class="debug-card">
          <div class="actions-card-header">
            <h2 class="actions-card-title">${this._t("debug_report")}</h2>
            ${!this._debugReport ? "" : `
            <button type="button" class="debug-btn debug-report-copy"
                    title="${this._esc(this._t("debug_report_copy"))}"
                    aria-label="${this._esc(this._t("debug_report_copy"))}">
              <ha-icon icon="mdi:content-copy" style="--mdc-icon-size:18px" aria-hidden="true"></ha-icon>
              ${this._esc(this._t("debug_report_copy"))}
            </button>`}
          </div>
          <div class="debug-body">
            <p class="hint-text">${this._esc(this._t("debug_report_hint"))}</p>
            ${this._debugReportBusy ? `<p class="hint-text">${this._esc(this._t("debug_report_fetching"))}</p>` : ""}
            ${this._htmlDebugReport()}
            ${this._debugReportError ? `<p class="debug-error">${this._esc(this._debugReportError)}</p>` : ""}
          </div>
        </ha-card>

        <!-- Third, and still a read: which modules were logging and at what
             level. It sits above the log-port card because that one changes
             the device, and below the report because it is a detail of it --
             but it loads by itself rather than waiting for a press, since it
             is the one answer here that is needed *before* deciding what to
             collect.
             NB: no backticks in this comment; it sits in a template. -->
        <ha-card outlined class="debug-card">
          <div class="actions-card-header">
            <h2 class="actions-card-title">${this._t("debug_logging")}</h2>
          </div>
          <div class="debug-body">
            <p class="hint-text">${this._esc(this._t("debug_logging_hint"))}</p>
            ${this._htmlDebugLogging()}
            ${this._debugLoggingError ? `<p class="debug-error">${this._esc(this._debugLoggingError)}</p>` : ""}
            <div class="debug-actions">
              <button type="button" class="debug-btn debug-logging-reset"
                      ${this._debugLoggingBusy || !this._debugLogging ? "disabled" : ""}>
                ${this._esc(this._t(this._debugLoggingBusy ? "debug_logging_loading" : "debug_logging_reset"))}
              </button>
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
          <div class="actions-card-header">
            <h2 class="actions-card-title">${this._t("debug_log_port")}</h2>
          </div>
          <div class="debug-body">
            <p class="hint-text">${this._esc(this._t("debug_log_port_hint"))}</p>
            ${this._debugPortError ? `<p class="debug-error">${this._esc(this._debugPortError)}</p>` : ""}
            <div class="debug-actions">
              <!-- A switch, not a button: the log stream is a state that stays
                   on until it is turned off, and the switch role is what makes
                   a screen reader announce it as on or off rather than read a
                   verb. Native, because the panel loads no HA form controls --
                   an unregistered element renders as an unstyled box, which is
                   how mwc-button failed here before.
                   NB: no backticks in this comment; it sits in a template. -->
              <button type="button" role="switch" class="debug-switch debug-port-toggle"
                      aria-checked="${this._debugPortOn ? "true" : "false"}"
                      aria-label="${this._esc(this._t("debug_log_port"))}"
                      ${this._debugPortBusy ? "disabled" : ""}>
                <span class="debug-switch-track" aria-hidden="true"><span class="debug-switch-thumb"></span></span>
                <span>${this._esc(this._t(this._debugPortOn ? "debug_stream_on" : "debug_stream_off"))}</span>
              </button>
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
        .map((l) => `<option value="${this._esc(l)}"${
          l === level ? " selected" : ""}>${this._esc(l)}</option>`).join("");
      return `
        <div class="debug-level-row">
          <label for="liza-log-${this._esc(mod)}">${this._esc(mod)}</label>
          <select id="liza-log-${this._esc(mod)}" class="debug-level-select"
                  data-module="${this._esc(mod)}"
                  ${this._debugLoggingBusy ? "disabled" : ""}>${options}</select>
        </div>`;
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
    if (!this._currentEntry || this._debugLoggingBusy) return;
    const entry = this._currentEntry;
    this._debugLoggingBusy = true;
    this._debugLoggingError = null;
    this._render();
    try {
      const setup = await this._hass.callWS({
        type: "lizaip_config/set_log_level",
        entry_id: entry,
        module,
        level,
      });
      if (this._currentEntry !== entry) return;
      if (setup?.modules) this._debugLogging = setup;
    } catch (e) {
      if (this._currentEntry !== entry) return;
      this._debugLoggingError = e?.message || String(e);
    } finally {
      this._debugLoggingBusy = false;
      this._render();
    }
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
    if (!this._currentEntry || this._debugLoggingBusy) return;
    const entry = this._currentEntry;
    this._debugLoggingBusy = true;
    this._debugLoggingError = null;
    this._render();
    try {
      const setup = await this._hass.callWS({
        type: "lizaip_config/debug_logging",
        entry_id: entry,
      });
      if (this._currentEntry !== entry) return;
      if (setup?.error) throw new Error(setup.error);
      this._debugLogging = setup?.modules ? setup : null;
      if (!this._debugLogging) this._debugLoggingError = this._t("debug_logging_empty");
    } catch (e) {
      if (this._currentEntry !== entry) return;
      this._debugLogging = null;
      this._debugLoggingError = e?.message || String(e);
    } finally {
      this._debugLoggingBusy = false;
      this._render();
    }
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
    if (!this._currentEntry || this._debugPortBusy) return;
    const entry = this._currentEntry;
    this._debugPortBusy = true;
    this._render();
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
      this._debugPortError = e?.message || String(e);
    } finally {
      this._debugPortBusy = false;
      this._render();
    }
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
    this._loadDebugLogging();
    this._loadDebugPortState();
    this._fetchDebugReport();
  },

  /**
   * Put every module back to the level the device ships with.
   *
   * The device's answer to the reset is the new list, so the card is refreshed
   * from what came back rather than from a second read: two requests could
   * disagree, and the one that wrote is the one that knows.
   */
  async _resetDebugLogging() {
    if (!this._currentEntry || this._debugLoggingBusy) return;
    const entry = this._currentEntry;
    this._debugLoggingBusy = true;
    this._debugLoggingError = null;
    this._render();
    try {
      const setup = await this._hass.callWS({
        type: "lizaip_config/reset_log_levels",
        entry_id: entry,
      });
      if (this._currentEntry !== entry) return;
      if (setup?.error) throw new Error(setup.error);
      this._debugLogging = setup?.modules ? setup : null;
      if (!this._debugLogging) this._debugLoggingError = this._t("debug_logging_empty");
    } catch (e) {
      if (this._currentEntry !== entry) return;
      this._debugLoggingError = e?.message || String(e);
    } finally {
      this._debugLoggingBusy = false;
      this._render();
    }
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
        ? this._jsonHtml(section.body || "")
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

      // The button sits on the summary line so the heading and its one control
      // read as one row. It is inside the `<summary>`, so its own click has to
      // be stopped from also collapsing the section it formats.
      return `
        <details class="debug-section" data-endpoint="${this._esc(endpoint)}" ${open ? "open" : ""}>
          <summary>
            <span class="debug-section-name">${this._esc(endpoint)}${this._esc(state)}</span>
            ${json ? `
              <button type="button" class="debug-pretty-btn ${pretty ? "on" : ""}"
                      data-endpoint="${this._esc(endpoint)}"
                      aria-pressed="${pretty ? "true" : "false"}">
                ${this._esc(this._t(pretty ? "debug_raw" : "debug_pretty"))}
              </button>` : ""}
          </summary>
          ${inner}
        </details>`;
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
    if (!this._currentEntry || this._debugReportBusy) return;
    const entry = this._currentEntry;
    this._debugReportBusy = true;
    this._debugReportError = null;
    this._render();
    try {
      const plan = await this._hass.callWS({
        type: "lizaip_config/debug_report",
        entry_id: entry,
      });
      if (this._currentEntry !== entry) return;
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
    } catch (e) {
      if (this._currentEntry !== entry) return;
      this._debugReport = null;
      this._debugReportError = e?.message || String(e);
    } finally {
      this._debugReportBusy = false;
      this._render();
    }
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
      section = { error: e?.message || String(e) };
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
    const text = this._debugReportText();
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
      this._toast(this._t("debug_report_copied"));
    } catch (e) {
      this._toast(this._t("debug_report_copy_failed", { error: e?.message || e }));
    }
  },

  _wireDebugView() {
    const root = this.shadowRoot;
    root.querySelector(".debug-probe-btn")?.addEventListener("click", () => this._runDebugProbe());
    root.querySelector(".debug-port-toggle")
        ?.addEventListener("click", () => this._setDebugPort(!this._debugPortOn));
    root.querySelector(".debug-report-copy")?.addEventListener("click", () => this._copyDebugReport());
    root.querySelector(".debug-logging-reset")?.addEventListener("click", () => this._resetDebugLogging());
    root.querySelectorAll(".debug-pretty-btn").forEach((el) =>
      el.addEventListener("click", (e) => {
        // The button lives inside the `<summary>`, where a click is the
        // browser's own way of collapsing the section. Formatting a section
        // and closing it are opposite intentions.
        e.preventDefault();
        e.stopPropagation();
        this._toggleDebugPretty(el.dataset.endpoint);
      }));
    // "toggle", not a click on the summary: it is the state that matters, and
    // it is also reached by keyboard and by the browser's own find-in-page.
    // It fires on a change, not on a render, so a section that re-renders with
    // its body filled in does not ask for that body a second time.
    root.querySelectorAll(".debug-section").forEach((el) =>
      el.addEventListener("toggle", () =>
        this._toggleDebugSection(el.dataset.endpoint, el.open)));
    // "change", not "input": a select fires change once the choice is made,
    // while keyboard navigation through the options fires input for each one
    // passed over -- which would send the device every level between the old
    // and the new.
    root.querySelectorAll(".debug-level-select").forEach((el) =>
      el.addEventListener("change", () => this._setDebugLogLevel(el.dataset.module, el.value)));

    // The levels load by themselves, because the tab cannot be read without
    // them. Guarded on all three states so the repeated renders of a filling
    // report do not each start a fetch, and so a failure is not retried
    // forever -- the reload button is how a failed read is tried again.

  },

  async _runDebugProbe() {
    if (!this._currentEntry || this._debugProbeBusy) return;
    const entry = this._currentEntry;
    this._debugProbeBusy = true;
    this._debugProbeError = null;
    this._render();
    try {
      const probe = await this._hass.callWS({
        type: "lizaip_config/debug_probe",
        entry_id: entry,
      });
      // Dropped rather than shown if the selection moved while the call was
      // out: the answer describes the device that was asked, and posting it
      // under another one is worse than showing nothing.
      if (this._currentEntry !== entry) return;
      this._debugProbe = probe;
    } catch (e) {
      // A probe that cannot run is itself a finding, so it is shown rather
      // than swallowed into the console.
      if (this._currentEntry !== entry) return;
      this._debugProbe = null;
      this._debugProbeError = e?.message || String(e);
    } finally {
      this._debugProbeBusy = false;
      this._render();
    }
  },

  async _setDebugPort(enabled) {
    if (!this._currentEntry || this._debugPortBusy) return;
    const entry = this._currentEntry;
    this._debugPortBusy = true;
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
      this._debugPortError = e?.message || String(e);
    } finally {
      this._debugPortBusy = false;
      this._render();
    }
  },
};
