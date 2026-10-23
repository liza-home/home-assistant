/**
 * lizaIP Panel — Actions View
 * HTML generation and wiring for the Actions tab (action library).
 *
 * A barrel over three concerns: the model that decides what is shown
 * (`actions/library.js`), the operations that remove entries
 * (`actions/cleanup.js`), and the markup below.
 */

import { ActionsLibraryMixin, actionDomain } from "./actions/library.js";
import { ActionsCleanupMixin } from "./actions/cleanup.js";

/** Scope chips, in the order they are shown. */
const ACTION_SCOPES = [
  { id: "all", label: "scope_all" },
  { id: "used", label: "scope_in_use" },
  { id: "unused", label: "scope_unused" },
  { id: "duplicates", label: "scope_duplicates" },
];

const ACTION_SORTS = [
  { id: "domain", label: "sort_by_domain" },
  { id: "name", label: "sort_by_name" },
  { id: "usage", label: "sort_by_usage" },
];

export const ActionsViewMixin = {
  ...ActionsLibraryMixin,
  ...ActionsCleanupMixin,

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
          ${this._htmlActionsToolbar()}
          ${this._htmlActionsCleanupBar()}
          <div class="actions-list">
            ${this._htmlActionRows()}
          </div>
        </ha-card>
      </div>`;
  },

  /**
   * The scope chips and the sort control.
   *
   * Hidden entirely for a library small enough to read at a glance: four
   * chips and a dropdown over five actions is more chrome than content, and
   * every one of them would be a no-op or close to it.
   */
  _htmlActionsToolbar() {
    if (this._actions.length < 6) return "";
    const counts = this._actionScopeCounts();
    const scope = this._actionScope || "all";
    // A scope with nothing in it is still shown, disabled, rather than
    // removed: chips that come and go move the ones beside them, so the
    // target you were aiming at is not the one you press.
    const chips = ACTION_SCOPES.map(({ id, label }) => {
      const n = counts[id];
      const disabled = n === 0 && id !== "all";
      return `<button type="button" class="scope-chip${scope === id ? " active" : ""}" data-scope="${id}"
                      aria-pressed="${scope === id ? "true" : "false"}"${disabled ? " disabled" : ""}>${this._t(label)}<span class="scope-chip-count">${n}</span></button>`;
    }).join("");
    const options = ACTION_SORTS.map(({ id, label }) =>
      `<option value="${id}"${(this._actionSort || "domain") === id ? " selected" : ""}>${this._esc(this._t(label))}</option>`).join("");
    return `
      <div class="actions-toolbar">
        <div class="scope-chips" role="group" aria-label="${this._esc(this._t("filter_by_usage"))}">${chips}</div>
        <label class="actions-sort">
          <span class="actions-sort-label" id="liza-action-sort-label">${this._t("sort_label")}</span>
          <select class="action-sort-select" aria-labelledby="liza-action-sort-label">${options}</select>
        </label>
      </div>`;
  },

  /**
   * The bulk offer, shown only while its scope is selected.
   *
   * Tied to the scope so the list on screen *is* the preview of what the
   * button acts on. A sweep offered from the unfiltered list would be asking
   * the user to trust a count whose contents they cannot see.
   */
  _htmlActionsCleanupBar() {
    const scope = this._actionScope || "all";
    if (scope === "unused") {
      // The scan decides whether this is an offer or an explanation. Showing
      // the button anyway and failing on press would be advertising something
      // that cannot work.
      if (!this._usageScanComplete) {
        return `<div class="actions-cleanup-bar warning" role="status">
          <ha-icon icon="mdi:alert-outline" style="--mdc-icon-size:16px" aria-hidden="true"></ha-icon>
          <span>${this._t("usage_scan_incomplete")}</span>
        </div>`;
      }
      const n = this._unusedActionIds().size;
      if (!n) return "";
      return `<div class="actions-cleanup-bar">
        <span>${this._t("unused_explainer", { n })}</span>
        <button type="button" class="cleanup-btn danger remove-unused-btn">${this._t("remove_unused_action", { n })}</button>
      </div>`;
    }
    if (scope === "duplicates") {
      const n = this._mergeableActionIds().size;
      if (!n) return "";
      return `<div class="actions-cleanup-bar">
        <span>${this._t("duplicates_explainer", { n })}</span>
        <button type="button" class="cleanup-btn merge-duplicates-btn">${this._t("merge_duplicates_action", { n })}</button>
      </div>`;
    }
    return "";
  },

  _htmlActionRows() {
    if (this._actions.length === 0) {
      return `<p class="hint-text" style="padding: 16px 0; text-align: center;">${this._esc(this._t("no_actions_yet", { tab: "🎛️ " + this._t("tab_buttons") }))}</p>`;
    }
    const indices = this._visibleActionIndices();
    if (indices.length === 0) return this._htmlActionsEmptyState();
    if ((this._actionSort || "domain") !== "domain") {
      return indices.map(idx => this._renderActionRow(this._actions[idx], idx)).join("");
    }
    return this._groupedActionIndices(indices).map(([domain, group]) => {
      const collapsed = this._isActionGroupCollapsed(domain);
      const title = domain ? this._domainLabel(domain) : this._t("group_no_service");
      const body = collapsed ? "" : group.map(idx => this._renderActionRow(this._actions[idx], idx)).join("");
      return `
        <div class="action-group${collapsed ? " collapsed" : ""}">
          <button type="button" class="action-group-header" data-domain="${this._esc(domain)}" aria-expanded="${collapsed ? "false" : "true"}">
            <ha-icon icon="mdi:chevron-${collapsed ? "right" : "down"}" style="--mdc-icon-size:18px" aria-hidden="true"></ha-icon>
            <span class="action-group-title">${this._esc(title)}</span>
            <span class="action-group-count">${group.length}</span>
          </button>
          ${body}
        </div>`;
    }).join("");
  },

  /** Why the list is empty says which control to undo, so each scope has its own. */
  _htmlActionsEmptyState() {
    const scope = this._actionScope || "all";
    let message;
    if (this._actionFilter) message = this._t("no_actions_match", { filter: this._actionFilter });
    else if (scope === "unused") message = this._t("no_unused_actions");
    else if (scope === "duplicates") message = this._t("no_duplicate_actions");
    else if (scope === "used") message = this._t("no_used_actions");
    else message = this._t("no_actions_match", { filter: "" });
    return `<p class="hint-text" style="padding: 16px 0; text-align: center;">${this._esc(message)}</p>`;
  },

  /** `media_player` -> "Media player": a heading, not an identifier. */
  _domainLabel(domain) {
    const localized = this._hass?.localize?.(`component.${domain}.title`);
    if (localized) return localized;
    const words = domain.replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  },

  _renderActionRow(a, idx) {
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
          <div class="action-subtitle">${this._esc(subtitle)}${this._htmlActionWhere(a)}</div>
        </div>
        <div class="action-badges">
          ${this._htmlActionBadges(a, usage, stateCount)}
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

  /**
   * Where the first use of this entry lives, appended to the subtitle.
   *
   * Three rows reading "On / light.turn_on" are the same row three times as
   * far as the user can tell, and the thing that distinguishes them -- the
   * button each is wired to -- was only visible after expanding one. The
   * first use is enough to tell them apart; the rest are a click away, and
   * the count beside it already says how many there are.
   */
  _htmlActionWhere(action) {
    const uses = this._globalUsageDetails[action.id] || [];
    if (!uses.length) return "";
    const first = uses[0];
    const label = first.buttonName || (first.button || "").replace(/_/g, " ");
    if (!label) return "";
    const more = uses.length > 1 ? ` +${uses.length - 1}` : "";
    return ` <span class="action-where">· ${this._esc(first.page)} › ${this._esc(label)}${more}</span>`;
  },

  _htmlActionBadges(a, usage, stateCount) {
    const badges = [];
    if (usage > 0) {
      badges.push(`<span class="action-badge usage" aria-label="${this._esc(this._t("a11y_usage_count", { n: usage }))}"><ha-icon icon="mdi:gesture-tap-button" style="--mdc-icon-size:13px" aria-hidden="true"></ha-icon> ${usage}</span>`);
    } else if (this._usageScanComplete) {
      badges.push(`<span class="action-badge unused">${this._t("badge_unused")}</span>`);
    }
    // No badge at all when the scan was incomplete and nothing was found:
    // "unused" would be a claim the scan is not in a position to make, and it
    // is the claim the delete button next to it is read against.
    if (this._mergeableActionIds().has(a.id)) {
      badges.push(`<span class="action-badge duplicate" title="${this._esc(this._t("badge_duplicate_hint"))}">${this._t("badge_duplicate")}</span>`);
    }
    if (stateCount > 0) {
      badges.push(`<span class="action-badge states" title="${this._esc(this._t("a11y_state_icons", { n: stateCount }))}" aria-label="${this._esc(this._t("a11y_state_icons", { n: stateCount }))}"><ha-icon icon="mdi:palette-outline" style="--mdc-icon-size:13px" aria-hidden="true"></ha-icon> ${stateCount}</span>`);
    }
    return badges.join("\n          ");
  },

  _wireActionsView() {
    const searchInput = this.shadowRoot.querySelector(".actions-search .search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this._actionFilter = searchInput.value;
        this._repaintActionsList();
      });
    }

    this.shadowRoot.querySelectorAll(".scope-chip").forEach(el =>
      el.addEventListener("click", () => this._setActionScope(el.dataset.scope)));

    const sortSelect = this.shadowRoot.querySelector(".action-sort-select");
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        this._actionSort = sortSelect.value;
        this._repaintActionsList();
      });
    }

    this.shadowRoot.querySelector(".remove-unused-btn")?.addEventListener("click", () =>
      this._removeUnusedActions().catch(err => this._toast(this._t("delete_failed") + ": " + (err.message || err))));
    this.shadowRoot.querySelector(".merge-duplicates-btn")?.addEventListener("click", () =>
      this._mergeDuplicateActions().catch(err => this._toast(this._t("merge_failed") + ": " + (err.message || err))));

    this._wireActionRows();

    if (this._editingActionIdx >= 0) {
      this._renderStatesSection();
    }
  },

  /**
   * Repaint just the list, for controls that change what is shown but nothing
   * the backend knows about.
   *
   * A full `_render` would rebuild the search field and take the caret with
   * it, which is why filtering has always worked this way.
   */
  _repaintActionsList() {
    const listEl = this.shadowRoot.querySelector(".actions-list");
    if (!listEl) return;
    listEl.innerHTML = this._htmlActionRows();
    this._wireActionRows();
    // The rebuild above re-emits an expanded row's empty
    // `#states-container`, and only `_wireActionsView` used to refill it —
    // so filtering with an action open blanked its Button Icons section.
    if (this._editingActionIdx >= 0) this._renderStatesSection();
  },

  /**
   * Switching scope repaints the whole tab, not just the list.
   *
   * The cleanup bar belongs to the scope, so it appears and disappears with
   * it -- and it sits outside `.actions-list`, which is all
   * `_repaintActionsList` touches.
   */
  _setActionScope(scope) {
    if (!scope || this._actionScope === scope) return;
    this._actionScope = scope;
    this._render();
  },

  _toggleActionGroup(domain) {
    if (this._isActionGroupCollapsed(domain)) {
      this._collapsedActionGroups.delete(domain);
      this._expandedActionGroups.add(domain);
    } else {
      this._expandedActionGroups.delete(domain);
      this._collapsedActionGroups.add(domain);
    }
    this._repaintActionsList();
  },

  _wireActionRows() {
    this.shadowRoot.querySelectorAll(".action-group-header").forEach(el =>
      el.addEventListener("click", () => this._toggleActionGroup(el.dataset.domain)));
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

  _onActionNameChange(value) {
    if (this._editingActionIdx < 0) return;
    this._actions[this._editingActionIdx].name = value;
    this._scheduleAutoSave();
  },
};

export { actionDomain };
