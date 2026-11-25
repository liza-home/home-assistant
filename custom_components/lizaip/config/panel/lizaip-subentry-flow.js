// lizaIP Panel — a config subentry flow, walked inside the add-page dialog.
// HA's flow dialog cannot be opened from a custom panel, so the flow runs over
// its REST API and each step is drawn like the walk's own (rows, search, fields).

const FLOW_URL = "config/config_entries/subentries/flow";
/** Rows a searchable choice shows before anything is typed. */
const SEARCH_ROWS = 100;

export const SubentryFlowMixin = {
  /** `[entry_id, subentry_type]` of the loaded entry that adds what a template's
   *  device selector asks for, or null when nothing here can add one. */
  async _subentryFlowHandler(sel) {
    const type = sel?.subentry_type;
    if (!type || !sel.integration || !this._isAdmin()) return null;
    try {
      const entries = await this._hass.callWS({ type: "config_entries/get", domain: sel.integration });
      const entry = (entries || []).find(
        (e) => e.state === "loaded" && e.supported_subentry_types?.[type],
      );
      return entry ? [entry.entry_id, type] : null;
    } catch (e) {
      console.debug("[lizaIP] config entries unavailable:", e);
      return null;
    }
  },

  /** The integration's flow and selector wording; "" for a key it lacks. */
  async _subentryLocalize(domain) {
    let localize = this._hass?.localize;
    try {
      await this._hass?.loadBackendTranslation?.("selector", domain);
      localize = (await this._hass?.loadBackendTranslation?.("config_subentries", domain))
        || this._hass?.localize;
    } catch (e) {
      console.debug("[lizaIP] flow translations unavailable:", e);
    }
    return (key, placeholders) => {
      const text = localize?.(key, placeholders);
      return text && text !== key ? text : "";
    };
  },

  /** Walk a subentry flow in *host*; `crumbs`' last crumb and the back arrow
   *  return through `back`. `done(alive)` runs once the subentry exists, and
   *  `alive()` says whether the dialog still shows this walk. */
  async _runSubentryFlow({ host, handler, domain, crumbs = [], onCrumb, back, close, done }) {
    const localize = await this._subentryLocalize(domain);
    const base = `component.${domain}.config_subentries.${handler[1]}`;
    let flowId = null;
    let busy = false;
    let live = true;

    const discard = () => {
      live = false;
      if (flowId) this._hass.callApi("delete", `${FLOW_URL}/${flowId}`).catch(() => {});
      flowId = null;
    };
    // Escape and the scrim close the dialog without passing through Cancel.
    const alive = () => {
      if (live && (host.isConnected === false || host.closest?.(".add-page-overlay")?.open === false)) {
        discard();
      }
      return live;
    };
    const failed = (e) => this._toast(this._t("failed", {
      error: e?.body?.message || e?.message || e,
    }));
    const submit = async (data) => {
      if (busy || !flowId) return;
      busy = true;
      try {
        const result = await this._hass.callApi("post", `${FLOW_URL}/${flowId}`, data);
        if (alive()) show(result);
      } catch (e) {
        if (alive()) failed(e);
      } finally {
        busy = false;
      }
    };

    const chrome = (title, body, { search = false, next = false } = {}) => {
      host.innerHTML = `
        <div class="add-page-head">
          ${this._addPageBackHtml(true)}
          ${this._addPageCrumbsHtml({ crumbs: [...crumbs, { label: title }] })}
          <h2 class="liza-sr-only" id="liza-dlg-title">${this._esc(title)}</h2>
        </div>
        ${search ? `
        <div class="add-page-search">
          <ha-input-search appearance="outlined" class="add-page-search-input" autocomplete="off"
                 accessible-label="${this._esc(title)}" placeholder="${this._esc(title)}"></ha-input-search>
        </div>` : ""}
        <div class="add-page-body${search ? "" : " is-form-body"}">${body}</div>
        ${this._htmlDialogActions({
          row: "add-page-foot is-form-foot",
          dismiss: { cls: "add-page-cancel", label: this._t("cancel") },
          commit: next ? { cls: "subentry-flow-next", label: this._t("next") } : null,
        })}`;
      this._wireAddPageBack(host, () => { discard(); back(); });
      host.querySelector(".add-page-cancel").addEventListener("click", () => { discard(); close(); });
      crumbs.forEach((_, i) => {
        host.querySelector(`[data-crumb="${i}"]`)?.addEventListener("click", () => {
          discard();
          if (i === crumbs.length - 1) back();
          else onCrumb?.(i);
        });
      });
    };

    const rowsHtml = (options) => this._templateListHtml(options.map((o) => this._templateRowHtml({
      attr: `${this._haLists() ? "" : 'type="button" '}data-value="${this._esc(o.value)}"`,
      name: o.label,
      hits: o.hits,
      kind: "choice",
    })).join(""));
    const bindRows = (field) => {
      host.querySelectorAll(".template-row").forEach((row) => {
        row.addEventListener("click", () => submit({ [field]: row.dataset.value }));
      });
    };

    const showForm = (result) => {
      const L = (key, p) => localize(`${base}.step.${result.step_id}.${key}`, p);
      const title = L("title") || this._t("new_device");
      const desc = L("description", result.description_placeholders || {});
      const errors = Object.values(result.errors || {})
        .map((err) => localize(`${base}.error.${err}`) || err);
      const head = `
        ${desc ? `<p class="template-entity-caption">${this._esc(desc)}</p>` : ""}
        ${errors.length ? `<p class="template-entity-hint" role="alert">${this._esc(errors.join(" "))}</p>` : ""}`;
      const schema = result.data_schema || [];
      const select = schema.length === 1 ? schema[0].selector?.select : null;

      if (select) {
        const field = schema[0].name;
        const options = (select.options || []).map((o) => {
          const value = typeof o === "string" ? o : o.value;
          const label = typeof o === "string" ? o : o.label;
          const named = select.translation_key
            ? localize(`component.${domain}.selector.${select.translation_key}.options.${value}`) : "";
          return { value, label: named || label || value };
        });
        if (!select.custom_value) {
          chrome(title, head + rowsHtml(options));
          bindRows(field);
          this._focusWhenReady(host.querySelector(".template-row"));
          return;
        }
        chrome(title, `${head}<div class="subentry-flow-rows"></div>`, { search: true });
        const input = host.querySelector(".add-page-search-input");
        const paint = (query) => {
          const found = query
            ? options.map((o) => ({ ...o, match: this._fuzzyMatch(o.label, query) }))
              .filter((o) => o.match)
              .sort((a, b) => b.match.score - a.match.score)
              .map((o) => ({ ...o, hits: o.match.hits }))
            : options;
          host.querySelector(".subentry-flow-rows").innerHTML = rowsHtml(found.slice(0, SEARCH_ROWS));
          bindRows(field);
        };
        input.addEventListener("input", () => paint(input.value ?? ""));
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || !(input.value ?? "").trim()) return;
          e.preventDefault();
          submit({ [field]: input.value.trim() });
        });
        paint("");
        this._focusWhenReady(input);
        return;
      }

      const dropdownOptions = (f) => (f.selector.select.options || []).map((o) => {
        const value = typeof o === "string" ? o : o.value;
        const label = typeof o === "string" ? o : o.label;
        return { value, label: label || value };
      });
      const inputs = schema.map((f) => (f.selector?.select
        ? `<ha-select class="subentry-flow-input subentry-flow-select" data-name="${this._esc(f.name)}"
                 label="${this._esc(L(`data.${f.name}`) || f.name)}"${
          this._haSelectAttrs(dropdownOptions(f), f.default ?? "")}></ha-select>`
        : `<ha-input appearance="outlined" class="subentry-flow-input" data-name="${this._esc(f.name)}"
                 label="${this._esc(L(`data.${f.name}`) || f.name)}"
                 value="${this._esc(f.default ?? "")}" autocomplete="off"></ha-input>`)).join("");
      chrome(title, head + inputs, { next: true });
      host.querySelectorAll(".subentry-flow-select").forEach((el) => this._wireHaSelect(el, () => {}));
      const send = () => {
        const data = {};
        host.querySelectorAll(".subentry-flow-input").forEach((el) => {
          data[el.dataset.name] = el.value ?? "";
        });
        submit(data);
      };
      host.querySelector(".subentry-flow-next").addEventListener("click", send);
      host.querySelectorAll("ha-input.subentry-flow-input").forEach((el) => el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); send(); }
      }));
      this._focusWhenReady(host.querySelector("ha-input.subentry-flow-input"));
    };

    const show = (result) => {
      flowId = result?.flow_id || null;
      if (result?.type === "create_entry") {
        flowId = null;
        done(alive);
      } else if (result?.type === "form") {
        showForm(result);
      } else {
        flowId = null;
        const reason = result?.reason || "";
        const text = localize(`${base}.abort.${reason}`, result?.description_placeholders || {}) || reason;
        chrome(this._t("new_device"), `
          <div class="add-page-empty">
            ${this._renderChromeIconHtml("mdi:alert-circle-outline", 40)}
            <p class="add-page-empty-title">${this._esc(text)}</p>
          </div>`);
        this._focusWhenReady(host.querySelector(".add-page-cancel"));
      }
    };

    try {
      const result = await this._hass.callApi("post", FLOW_URL, { handler, show_advanced_options: false });
      flowId = result?.flow_id || null;
      if (!alive()) return discard();
      show(result);
    } catch (e) {
      if (!alive()) return;
      failed(e);
      back();
    }
  },
};
