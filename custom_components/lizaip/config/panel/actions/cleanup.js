/**
 * lizaIP Panel — Actions View: library cleanup.
 *
 * The three ways a library entry goes away: deleted on its own, swept with
 * every other unused entry, or merged into an identical twin. All three have
 * the same obligation -- no page may be left pointing at an id that no longer
 * exists -- so all three go through `_applyToAllPages`, which walks every
 * page rather than the one on screen and reports the ones it could not read.
 */

export const ActionsCleanupMixin = {
  /**
   * Remove one library entry and every reference to it.
   *
   * Confirmed through `_confirmDestructive` rather than the browser's
   * `confirm`, which blocks the whole tab, cannot be styled to say which
   * remote it is talking about, and is suppressible -- a suppressed confirm
   * turns a destructive button into a silent one.
   */
  async _deleteAction(idx) {
    const action = this._actions[idx];
    if (!action) return;
    const uses = this._globalUsageCount(action.id);
    const ok = await this._confirmDestructive({
      title: this._t("delete_action_confirm", { name: action.name }),
      subtitle: action.name,
      // Says what will break, not just that something will: an entry on five
      // buttons is a different decision from one on none, and the count is
      // the only thing that distinguishes them at this point.
      message: uses > 0
        ? this._t("delete_action_in_use", { n: uses })
        : this._t("delete_action_unused_hint"),
      confirmText: this._t("delete"),
    });
    if (!ok) return;

    const deletedId = action.id;
    this._actions.splice(idx, 1);
    this._reindexEditingAfterRemoval([idx]);

    const { currentChanged, failedPages } =
      await this._applyToAllPages(assigns => this._purgeActionFromAssignments(assigns, deletedId));

    await this._saveActionsToBackend();
    if (currentChanged) await this._saveAssignments();
    await this._loadGlobalUsage();
    this._render();
    if (failedPages.length) {
      this._toast(this._t("action_deleted_pages_failed", { pages: failedPages.join(", ") }));
    }
  },

  /**
   * Delete every entry the usage scan proved nobody is using.
   *
   * Refuses outright when the scan was incomplete. `_loadGlobalUsage` falls
   * back to a cached or empty page when a read fails, and its own comment
   * calls under-counting "the dangerous direction": an unreadable page makes
   * the actions on it look unused. One row saying "unused" wrongly costs the
   * user one undo; this button would act on all of them at once.
   */
  async _removeUnusedActions() {
    if (!this._usageScanComplete) {
      this._toast(this._t("usage_scan_incomplete"));
      return;
    }
    const doomed = this._unusedActionIds();
    if (!doomed.size) return;
    const ok = await this._confirmDestructive({
      title: this._t("remove_unused_confirm", { n: doomed.size }),
      message: this._t("remove_unused_hint"),
      confirmText: this._t("remove_unused_action", { n: doomed.size }),
    });
    if (!ok) return;

    const prevActions = this._actions;
    const removedIdx = [];
    this._actions.forEach((a, idx) => { if (doomed.has(a.id)) removedIdx.push(idx); });
    this._actions = this._actions.filter(a => !doomed.has(a.id));
    this._reindexEditingAfterRemoval(removedIdx);

    // An unused entry is by definition referenced by nothing, so there is
    // nothing to purge -- but the scan is a snapshot and a reference added
    // since is exactly what must not be left dangling. The purge is cheap and
    // its absence is unrecoverable, so it runs anyway.
    const { currentChanged, failedPages } = await this._applyToAllPages(assigns => {
      let changed = false;
      for (const id of doomed) {
        if (this._purgeActionFromAssignments(assigns, id)) changed = true;
      }
      return changed;
    });

    // References go first and the library second, never the other way round.
    // Interrupted in this order, the entries survive on disk with nothing
    // pointing at them -- they come back as unused and the sweep can simply be
    // run again. Writing the library first would, on the same interruption,
    // leave a button pointing at an id that no longer exists.
    try {
      await this._saveActionsToBackend();
      if (currentChanged) await this._saveAssignments();
    } catch (err) {
      // The library on disk still holds them, so showing them again is what
      // matches disk rather than a guess at it.
      this._actions = prevActions;
      this._closeActionEditor();
      throw err;
    } finally {
      await this._loadGlobalUsage();
      this._render();
    }
    this._toast(failedPages.length
      ? this._t("action_deleted_pages_failed", { pages: failedPages.join(", ") })
      : this._t("removed_unused_toast", { n: doomed.size }));
  },

  /**
   * Collapse every set of identical entries onto the oldest of each set.
   *
   * Safe to run without the usage scan, unlike the sweep above: this never
   * drops a reference, it repoints one at an entry `_actionMergeKey` has
   * established is indistinguishable. A page that cannot be read is still
   * reported, because its buttons keep pointing at ids this removes.
   */
  async _mergeDuplicateActions() {
    const groups = [...this._duplicateActionGroups().values()];
    if (!groups.length) return;
    const doomed = new Set();
    const idMap = new Map();
    for (const group of groups) {
      const keeper = group[0];
      for (const dupe of group.slice(1)) {
        doomed.add(dupe.id);
        idMap.set(dupe.id, keeper.id);
      }
    }
    const ok = await this._confirmDestructive({
      title: this._t("merge_duplicates_confirm", { n: doomed.size }),
      message: this._t("merge_duplicates_hint"),
      confirmText: this._t("merge_duplicates_action", { n: doomed.size }),
    });
    if (!ok) return;

    const prevActions = this._actions;
    const removedIdx = [];
    this._actions.forEach((a, idx) => { if (doomed.has(a.id)) removedIdx.push(idx); });
    this._actions = this._actions.filter(a => !doomed.has(a.id));
    this._reindexEditingAfterRemoval(removedIdx);

    const { currentChanged, failedPages } =
      await this._applyToAllPages(assigns => this._remapActionInAssignments(assigns, idMap));

    // Same order as the sweep, for the same reason: repointed first, pruned
    // second. Interrupted here, the duplicates are still on disk and the merge
    // can be run again; pruning first would strand the buttons this has not
    // reached yet on ids the library no longer has.
    try {
      await this._saveActionsToBackend();
      if (currentChanged) await this._saveAssignments();
    } catch (err) {
      this._actions = prevActions;
      this._closeActionEditor();
      throw err;
    } finally {
      await this._loadGlobalUsage();
      this._render();
    }
    this._toast(failedPages.length
      ? this._t("action_merge_pages_failed", { pages: failedPages.join(", ") })
      : this._t("merged_duplicates_toast", { n: doomed.size }));
  },

  /**
   * Keep `_editingActionIdx` pointing at the entry it was opened on.
   *
   * The inline editor addresses its action by position, so removing anything
   * above it silently moves the editor onto a different action -- the next
   * keystroke in the name field would rename a neighbour. Closed when the
   * open entry is itself one of the removals, since there is nothing left to
   * edit and the stale `_editorEl` and `_sequence` belong to it.
   */
  /** Shut the inline editor and drop the step list it was editing. */
  _closeActionEditor() {
    this._editingActionIdx = -1;
    this._editorEl = null;
    this._sequence = [];
  },

  _reindexEditingAfterRemoval(removedIdx) {
    if (this._editingActionIdx < 0) return;
    if (removedIdx.includes(this._editingActionIdx)) {
      this._closeActionEditor();
      return;
    }
    const before = removedIdx.filter(i => i < this._editingActionIdx).length;
    this._editingActionIdx -= before;
  },
};
