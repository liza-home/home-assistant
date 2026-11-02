/**
 * lizaIP Panel — Actions View: library model.
 *
 * The questions the Actions tab asks about the library, separated from the
 * markup that asks them: which entries are duplicates of one another, which
 * are provably unused, and which survive the current filter, scope and sort.
 *
 * Nothing here touches the DOM or the backend, which is what makes it
 * testable on its own -- the view module is almost entirely string building,
 * and the rules below are the part worth pinning.
 */

/** Domain shown as a group heading; "" for an entry with no service. */
export function actionDomain(action) {
  const service = action?.service || "";
  const dot = service.indexOf(".");
  return dot > 0 ? service.slice(0, dot) : "";
}

export const ActionsLibraryMixin = {
  /**
   * The key two library entries must share before one may replace the other.
   *
   * Deliberately stricter than `_findMatchingAction`, which answers "may this
   * button reuse that entry" and is content with the service alone. This
   * answers "may this entry be deleted and its buttons pointed at that one",
   * and the only honest yes is when nothing observable differs: a merge is
   * silent and bulk, so anything it loses is lost without being shown.
   *
   * So the name and the icons are in the key even though neither changes what
   * the action *does*. The name flows into the button label, and `states`
   * carries the per-state icon overrides -- merging two entries that differ
   * there would quietly repaint buttons the user never touched.
   *
   * Returns "" for an entry that may never be merged: one with no service has
   * no behaviour to compare, so two of them are not evidently the same thing.
   */
  _actionMergeKey(action) {
    if (!action?.service) return "";
    const identity = action.payload_identity
      ?? this._payloadIdentity(action.config?.[0]?.data);
    const states = (action.states || []).map(s => `${s?.state || ""}:${s?.icon || ""}`).join(",");
    return JSON.stringify([action.service, identity || "", action.name || "", action.icon || "", states]);
  },

  /**
   * Library entries that have an identical twin, grouped by merge key.
   *
   * Insertion order is kept, so the first entry of each group is the oldest
   * and becomes the one the merge keeps. That matters beyond tidiness: the
   * oldest is the one the longest-standing buttons already point at, so
   * keeping it is the choice that rewrites the fewest assignments.
   */
  _duplicateActionGroups() {
    const groups = new Map();
    for (const action of this._actions) {
      const key = this._actionMergeKey(action);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(action);
    }
    for (const [key, group] of groups) {
      if (group.length < 2) groups.delete(key);
    }
    return groups;
  },

  /** Ids that a merge would delete, i.e. every duplicate but its group's first. */
  _mergeableActionIds() {
    const ids = new Set();
    for (const group of this._duplicateActionGroups().values()) {
      for (const action of group.slice(1)) ids.add(action.id);
    }
    return ids;
  },

  /**
   * Whether this entry is *provably* unused.
   *
   * Gated on the scan having read every page. `_globalUsageDetails` is built
   * from whatever pages answered, and its own fallback comments explain that
   * a page it could not read drops out of the count -- so after a failed read
   * "no uses found" means "none found on the pages we saw", which is not the
   * same claim at all. Everything destructive in this tab goes through here
   * rather than comparing the count to zero itself.
   */
  _isActionUnused(action) {
    return this._usageScanComplete && this._globalUsageCount(action.id) === 0;
  },

  _unusedActionIds() {
    return new Set(this._actions.filter(a => this._isActionUnused(a)).map(a => a.id));
  },

  /**
   * Does this entry match the typed filter?
   *
   * Matches the service and the names of the buttons it is assigned to as
   * well as its own name. Three entries called "On" are told apart by where
   * they are used, so a filter that could not see that was unable to find any
   * one of them -- which is the state the list is in before you type.
   */
  _actionMatchesFilter(action) {
    const query = (this._actionFilter || "").trim().toLowerCase();
    if (!query) return true;
    const haystack = [
      action.name || "",
      action.service || "",
      ...(this._globalUsageDetails[action.id] || []).flatMap(use => [use.page || "", use.buttonName || ""]),
    ];
    // String(): a use's page is its number, and a number has no toLowerCase --
    // so one used action used to throw here and leave the list unfiltered.
    return haystack.some(text => String(text).toLowerCase().includes(query));
  },

  _actionMatchesScope(action) {
    switch (this._actionScope) {
      case "used": return this._globalUsageCount(action.id) > 0;
      case "unused": return this._isActionUnused(action);
      case "duplicates": return this._duplicateActionGroups().has(this._actionMergeKey(action));
      default: return true;
    }
  },

  /** How many entries each scope chip would show, for the counts beside them. */
  _actionScopeCounts() {
    let used = 0;
    let unused = 0;
    for (const action of this._actions) {
      if (this._globalUsageCount(action.id) > 0) used++;
      if (this._isActionUnused(action)) unused++;
    }
    let duplicates = 0;
    for (const group of this._duplicateActionGroups().values()) duplicates += group.length;
    return { all: this._actions.length, used, unused, duplicates };
  },

  /**
   * The entries to render, as indices into `this._actions`.
   *
   * Indices rather than entries because every control in a row addresses its
   * action by `data-idx` into the unsorted library, and re-sorting the list
   * must not move what a delete button deletes.
   */
  _visibleActionIndices() {
    const indices = [];
    this._actions.forEach((action, idx) => {
      if (!this._actionMatchesScope(action)) return;
      if (!this._actionMatchesFilter(action)) return;
      indices.push(idx);
    });
    const by = this._actionSort || "domain";
    if (by === "name") {
      indices.sort((a, b) => (this._actions[a].name || "").localeCompare(this._actions[b].name || ""));
    } else if (by === "usage") {
      // Descending, and ties broken by name so the order is stable rather than
      // left to whatever the sort happened to do with equal keys.
      indices.sort((a, b) => {
        const delta = this._globalUsageCount(this._actions[b].id) - this._globalUsageCount(this._actions[a].id);
        return delta || (this._actions[a].name || "").localeCompare(this._actions[b].name || "");
      });
    }
    return indices;
  },

  /**
   * Visible entries bucketed under their domain, ordered by size.
   *
   * Only used when sorting by domain; the other sorts are flat on purpose,
   * since their whole point is an ordering that cuts across the groups.
   */
  _groupedActionIndices(indices) {
    const groups = new Map();
    for (const idx of indices) {
      const domain = actionDomain(this._actions[idx]);
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain).push(idx);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  },

  /**
   * Whether the list is long enough to be worth collapsing by default.
   *
   * Below the threshold the whole library fits on screen, and collapsing it
   * would add a click to reach what was already visible.
   */
  _actionGroupsStartCollapsed() {
    return this._actions.length > 15;
  },

  /**
   * Collapsed state, tracked as two explicit sets rather than one.
   *
   * The default flips as the library grows past the threshold, so a single
   * set could not tell "the user collapsed this" from "this was never opened
   * and the default has since changed". Recording both directions means a
   * group the user opened stays open when the fifteenth action is added.
   */
  _isActionGroupCollapsed(domain) {
    if (this._expandedActionGroups.has(domain)) return false;
    if (this._collapsedActionGroups.has(domain)) return true;
    return this._actionGroupsStartCollapsed();
  },
};
