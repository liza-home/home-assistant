/**
 * lizaIP Panel — Actions View
 * HTML generation and wiring for the Actions tab (action library).
 */

export const ActionsViewMixin = {
  _htmlActionsView() {
    return `
      <div class="actions-view">
        <ha-card outlined class="actions-list-card">
          <div class="actions-card-header">
            <h2 class="actions-card-title">${this._t("action_library")}</h2>
            <div class="actions-search">
              <ha-icon icon="mdi:magnify" style="--mdc-icon-size:18px"></ha-icon>
              <input type="text" class="search-input" aria-label="${this._esc(this._t("filter"))}" placeholder="${this._esc(this._t("filter"))}" value="${this._esc(this._actionFilter || '')}" />
            </div>
          </div>
          <div class="actions-list">
            ${this._htmlActionRows()}
          </div>
        </ha-card>
      </div>`;
  },

  _htmlActionRows() {
    if (this._actions.length === 0) {
      return `<p class="hint-text" style="padding: 16px 0; text-align: center;">${this._esc(this._t("no_actions_yet", { tab: "🎛️ " + this._t("tab_buttons") }))}</p>`;
    }
    const rows = this._actions.map((a, idx) => this._renderActionRow(a, idx)).filter(Boolean);
    return rows.length > 0 ? rows.join("")
      : `<p class="hint-text" style="padding: 16px 0; text-align: center;">${this._esc(this._t("no_actions_match", { filter: this._actionFilter }))}</p>`;
  },

  _renderActionRow(a, idx) {
    if (this._actionFilter) {
      const q = this._actionFilter.toLowerCase();
      if (!(a.name || "").toLowerCase().includes(q)) return "";
    }
    const isEditing = idx === this._editingActionIdx;
    const subtitle = this._getActionSubtitle(a);
    const usage = this._globalUsageCount(a.id);
    const stateCount = (a.states || []).length;

    // Named only while it is open, because only then is it a focus target:
    // `_a11yFocusFallback` lands here, and focus arriving on an unnamed element
    // announces nothing. A closed row needs no name -- the delete button and
    // the chevron inside it both already say which action they act on.
    // `data-a11y-name`, not `aria-label`: the open row is a programmatic focus
    // target and _a11yFocusFallback announces this itself, but a roleless div
    // with an accessible name is exposed as a group -- so naming it was what
    // put "group" back after the role had been removed.
    const rowAttrs = isEditing
      ? ` data-a11y-name="${this._esc(a.name)}" tabindex="-1"`
      : '';
    let html = `
      <div class="action-row ${isEditing ? 'editing' : ''}" data-idx="${idx}"${rowAttrs}>
        <div class="action-icon">${this._renderIconHtml(this._getActionDisplayIcon(a), 20)}</div>
        <div class="action-info">
          <div class="action-name">${this._esc(a.name)}</div>
          <div class="action-subtitle">${this._esc(subtitle)}</div>
        </div>
        <div class="action-badges">
          ${usage > 0 ? `<span class="action-badge usage" aria-label="${this._esc(this._t("a11y_usage_count", { n: usage }))}"><ha-icon icon="mdi:gesture-tap-button" style="--mdc-icon-size:13px" aria-hidden="true"></ha-icon> ${usage}</span>` : `<span class="action-badge unused">${this._t("badge_unused")}</span>`}
          ${stateCount > 0 ? `<span class="action-badge states" title="${this._esc(this._t("a11y_state_icons", { n: stateCount }))}" aria-label="${this._esc(this._t("a11y_state_icons", { n: stateCount }))}"><ha-icon icon="mdi:palette-outline" style="--mdc-icon-size:13px" aria-hidden="true"></ha-icon> ${stateCount}</span>` : ''}
        </div>
        <button class="action-delete-btn" data-idx="${idx}" title="${this._esc(this._t("delete"))}" aria-label="${this._esc(this._t("delete"))} ${this._esc(a.name)}"><ha-icon icon="mdi:delete-outline" style="--mdc-icon-size:18px" aria-hidden="true"></ha-icon></button>
        <ha-icon icon="mdi:chevron-${isEditing ? 'up' : 'down'}" class="btn-expand-icon" style="--mdc-icon-size:18px"
                 role="button" tabindex="0" aria-expanded="${isEditing ? 'true' : 'false'}" aria-label="${this._esc(a.name)}"></ha-icon>
      </div>`;

    if (isEditing) {
      const assignedItems = this._globalUsageDetails[a.id] || [];
      const assignedHtml = assignedItems.length > 0
        ? assignedItems.map(i => {
            const label = i.buttonName || i.button.replace(/_/g, " ");
            const via = i.interaction ? ` (${this._esc(i.interaction)})` : "";
            return `<span class="assigned-chip" role="button" tabindex="0" data-page-idx="${i.pageIdx}" data-button="${i.button}"><ha-icon icon="mdi:gesture-tap-button" style="--mdc-icon-size:12px" aria-hidden="true"></ha-icon> ${this._esc(i.page)} › ${this._esc(label)}${via}</span>`;
          }).join("")
        : `<span class="assigned-none">${this._t("not_assigned_to_button")}</span>`;

      html += `
        <div class="action-inline-editor">
          <div class="inline-editor-row">
            <label for="liza-action-name-${idx}">${this._t("name")}</label>
            <input type="text" id="liza-action-name-${idx}" class="meta-input action-name-input" value="${this._esc(a.name)}" />
          </div>
          <div class="assigned-to-section">
            <label id="liza-assigned-label-${idx}">${this._t("assigned_to")}</label>
            <div class="assigned-chips">${assignedHtml}</div>
          </div>
          <h3 class="section-title">${this._t("button_icons")}</h3>
          <div class="states-list" id="states-container"></div>
        </div>`;
    }
    return html;
  },

  _wireActionsView() {
    const searchInput = this.shadowRoot.querySelector(".actions-search .search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this._actionFilter = searchInput.value;
        const listEl = this.shadowRoot.querySelector(".actions-list");
        if (listEl) {
          listEl.innerHTML = this._htmlActionRows();
          this._wireActionRows();
          // The rebuild above re-emits an expanded row's empty
          // `#states-container`, and only `_wireActionsView` used to refill it —
          // so filtering with an action open blanked its Button Icons section.
          if (this._editingActionIdx >= 0) this._renderStatesSection();
        }
      });
    }

    this._wireActionRows();

    if (this._editingActionIdx >= 0) {
      this._renderStatesSection();
    }
  },

  _wireActionRows() {
    this.shadowRoot.querySelectorAll(".action-row").forEach(el =>
      el.addEventListener("click", () => this._editAction(parseInt(el.dataset.idx))));
    this.shadowRoot.querySelectorAll(".action-delete-btn").forEach(el =>
      el.addEventListener("click", (e) => { e.stopPropagation(); this._deleteAction(parseInt(el.dataset.idx)).catch(err => this._toast(this._t("delete_failed") + ": " + (err.message || err))); }));

    const nameInput = this.shadowRoot.querySelector(".action-name-input");
    if (nameInput && this._editingActionIdx >= 0) {
      nameInput.addEventListener("click", (e) => e.stopPropagation());
      nameInput.addEventListener("input", () => this._onActionNameChange(nameInput.value));
    }

    this.shadowRoot.querySelectorAll(".assigned-chip").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const pageIdx = parseInt(el.dataset.pageIdx);
        const buttonKey = el.dataset.button;
        this._navigateToButton(pageIdx, buttonKey);
      });
    });
  },

  // --- Actions tab interactions ---
  _editAction(idx) {
    // Every other flush site flushes the debounced save first, and this one has
    // to as well: a live `_autoSaveTimer` keeps `_isEditingLive()` true, so the
    // flush below would refuse — and once the timer fires on its own there is
    // no further flush point on this tab to apply the change.
    this._flushAutoSave();
    if (this._editingActionIdx === idx) {
      this._editingActionIdx = -1;
    } else {
      this._editingActionIdx = idx;
    }
    this._render();
    // Collapsing the inline editor is this tab's "nothing is being edited any
    // more", so a deferred external change can land now.
    this._flushPendingConfigReload();
  },

  _addAction() {
    const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
    this._actions.push({ id, name: "New Action", service: "", states: [] });
    this._editingActionIdx = this._actions.length - 1;
    this._scheduleAutoSave();
    this._render();
  },

  async _deleteAction(idx) {
    const action = this._actions[idx];
    if (!action) return;
    if (!confirm(this._t("delete_action_confirm", { name: action.name }))) return;
    const deletedId = action.id;
    this._actions.splice(idx, 1);
    if (this._editingActionIdx === idx) { this._editingActionIdx = -1; this._editorEl = null; this._sequence = []; }
    else if (this._editingActionIdx > idx) this._editingActionIdx--;

    // Clear references on EVERY page, not just the one that happens to be loaded.
    // `this._assignments` only holds the current page, so deleting an action while
    // viewing another page used to leave buttons pointing at an id that no longer
    // exists — the button kept rendering from its own config, so the delete looked
    // like it had done nothing at all.
    const assignChanged = this._purgeActionFromAssignments(this._assignments, deletedId);
    const failedPages = [];
    for (const page of this._pages) {
      if (page.id === this._currentPageId) continue;
      let assigns = this._pageCache[page.id];
      if (!assigns) {
        try {
          const r = await this._hass.callWS({ type: "lizaip_config/get_assignments", entry_id: this._currentEntry, page_id: page.id });
          assigns = r?.assignments || {};
          this._pageCache[page.id] = assigns;
        } catch {
          // Treating an unreachable page as empty would report it as clean; skip
          // it instead and tell the user which pages still need attention.
          failedPages.push(page.name || page.id);
          continue;
        }
      }
      if (!this._purgeActionFromAssignments(assigns, deletedId)) continue;
      try {
        await this._saveAssignments(assigns, page.id);
      } catch {
        failedPages.push(page.name || page.id);
      }
    }

    await this._saveActionsToBackend();
    if (assignChanged) await this._saveAssignments();
    await this._loadGlobalUsage();
    this._render();
    if (failedPages.length) {
      this._toast(this._t("action_deleted_pages_failed", { pages: failedPages.join(", ") }));
    }
  },

  _onActionNameChange(value) {
    if (this._editingActionIdx < 0) return;
    this._actions[this._editingActionIdx].name = value;
    this._scheduleAutoSave();
  },
};

