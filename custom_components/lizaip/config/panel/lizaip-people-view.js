/**
 * Who a remote belongs to.
 *
 * Administrators only, because assigning a remote is what grants access to it.
 * The dialog asks in terms of *people* -- the names and faces the rest of Home
 * Assistant shows -- and stores the user accounts behind them, which is the
 * only thing the backend can match a connection against.
 *
 * Nothing here is a permission boundary. Every command the dialog drives is
 * administrators-only server-side; this is the way in, not the lock.
 */

/** Above this many people the list stops being scannable and gets a filter. */
const SEARCH_THRESHOLD = 8;

/** How many faces a row draws before the rest become a counter, and how many
 *  names it spells out before they do. Past these the row grows with the
 *  household instead of staying one line. */
const FACE_CAP = 3;
const NAME_CAP = 2;

export const PeopleViewMixin = {
  /**
   * The people this remote is assigned to, for the device list.
   *
   * Names come from `hass.states` rather than from a round-trip: the backend
   * reports ids, and the person entities carrying the names are already in
   * hand. A user with no person entity -- an account nobody linked -- cannot be
   * named, so it is counted rather than listed, which is still true and still
   * useful.
   */
  _assignedPeople(device) {
    const ids = device?.assigned_users;
    if (!Array.isArray(ids) || !ids.length) return { people: [], unnamed: 0 };
    const byUser = new Map();
    for (const st of Object.values(this._hass?.states || {})) {
      const uid = st?.attributes?.user_id;
      if (st?.entity_id?.startsWith("person.") && uid) {
        byUser.set(uid, { name: st.attributes.friendly_name || st.entity_id, key: uid });
      }
    }
    const people = ids.map((id) => byUser.get(id)).filter(Boolean);
    return { people, unnamed: ids.length - people.length };
  },

  /** Every assignee, named, the ones no person entity stands behind counted
   *  at the end. */
  _assignedNameList(device) {
    const { people, unnamed } = this._assignedPeople(device);
    const names = people.map((p) => p.name);
    if (unnamed > 0) names.push(this._t("assigned_people_unnamed", { count: unnamed }));
    return names;
  },

  /** The same set as a sentence, which is what a reader is given. Two are
   *  spelled out and the rest counted, so the row reads the same whether a
   *  remote is held by one person or by the whole household. */
  _assignedNames(device) {
    const names = this._assignedNameList(device);
    if (names.length === 2) {
      return this._t("assigned_people_pair", { first: names[0], second: names[1] });
    }
    if (names.length <= NAME_CAP) return names.join("");
    return this._t("assigned_people_more", {
      names: names.slice(0, NAME_CAP).join(", "),
      count: names.length - NAME_CAP,
    });
  },

  /** One face, drawn by Home Assistant's own badge: it finds the person entity
   *  behind the account and falls back to initials. Decorative -- the names
   *  beside the stack carry the meaning. */
  _htmlUserBadge(cls, key, name) {
    return `<ha-user-badge class="${cls}" aria-hidden="true"
                           data-user="${this._esc(key || "")}"
                           data-name="${this._esc(name || "")}"></ha-user-badge>`;
  },

  /** `ha-user-badge` takes a user object, which no attribute can carry, so the
   *  markup names the account and the element is handed it after it is in the
   *  page. Re-running over a badge that already has one is harmless. */
  _wireUserBadges(root) {
    (root || this.shadowRoot)?.querySelectorAll("ha-user-badge[data-user]").forEach((el) => {
      el.user = { id: el.dataset.user, name: el.dataset.name || "" };
    });
  },

  /** Who holds the remote, as faces followed by the sentence naming them.
   *  Three faces at most and then a counter; the full list is on the tooltip.
   *  Admins only -- it is the only audience: the others are on the list
   *  themselves. */
  _htmlAssignedChip(device) {
    if (!this._isAdmin?.()) return "";
    const names = this._assignedNames(device);
    if (!names) return "";
    const { people } = this._assignedPeople(device);
    const over = people.length - FACE_CAP;
    const faces = people.slice(0, FACE_CAP).map((p) => this._htmlUserBadge("device-face", p.key, p.name)).join("")
      + (over > 0
        ? `<span class="device-face device-face-more" aria-hidden="true">+${over}</span>`
        : "");
    const full = this._t("assigned_people_summary", {
      names: this._assignedNameList(device).join(", "),
    });
    return `<span class="device-assigned" title="${this._esc(full)}">${
      faces ? `<span class="device-faces">${faces}</span>` : ""
    }<span class="device-assigned-names">${this._esc(
      this._t("assigned_people_summary", { names })
    )}</span></span>`;
  },

  /**
   * The dialog itself.
   *
   * Opened from the ⋮ menu, on a row in the list or on an open remote's
   * toolbar, so it takes the entry rather than reading the current one.
   *
   * The people are fetched each time it opens. A household changes rarely, but
   * the cost of being wrong here is somebody keeping or losing access they
   * should not, and a cached list is exactly how that happens.
   */
  async _openAssignedPeopleDialog(entryId) {
    if (!entryId) return;
    const persons = await this._fetchPersons();
    if (!persons) {
      this._toast(this._t("assigned_people_failed"));
      return;
    }

    const device = (this._devices || []).find((d) => d?.entry_id === entryId);
    const selected = new Set(device?.assigned_users || []);
    const title = (device?.title || "").trim() || entryId;

    // Only the people a switch can mean anything for: an administrator has
    // every remote anyway, and an inactive account cannot sign in to use one.
    const assignable = persons.filter((p) => p.assignable && !p.is_admin);
    const rows = assignable.map((p, i) => this._htmlPersonRow(p, i, selected)).join("");
    const search = assignable.length > SEARCH_THRESHOLD
      ? `<ha-input-search appearance="outlined" class="people-search" autocomplete="off"
                          placeholder="${this._esc(this._t("assigned_people_search"))}"
                          accessible-label="${this._esc(
                            this._t("assigned_people_search")
                          )}"></ha-input-search>`
      : "";
    const body = rows
      ? `${search}
         <div class="people-list" role="group" aria-labelledby="liza-people-title">${rows}</div>
         <p class="people-no-match" hidden>${this._esc(
           this._t("assigned_people_no_match")
         )}</p>`
      : `<p class="people-empty">${this._esc(this._t("assigned_people_none"))}</p>`;

    const { dlg, close } = this._openModal(`
      <div class="add-page-dialog people-dialog" role="document">
        <h2 class="add-page-dialog-title" id="liza-people-title">${this._esc(
          this._t("assigned_people")
        )}<span class="confirm-dialog-subtitle">${this._esc(title)}</span></h2>
        <p class="people-hint" id="liza-people-hint">${this._esc(
          this._t("assigned_people_hint")
        )}</p>
        ${assignable.length
          ? `<div class="people-listhead">
               <span class="people-section">${this._esc(
                 this._t("assigned_people_section")
               )}</span>
               <output class="people-count" aria-live="polite">${this._esc(
                 this._t("assigned_people_count", {
                   count: assignable.filter((p) => selected.has(p.user_id)).length,
                   total: assignable.length,
                 })
               )}</output>
             </div>`
          : ""}
        ${body}
        <div class="template-dialog-actions">
          <ha-button appearance="plain" class="people-cancel-btn">${this._esc(
            this._t("cancel")
          )}</ha-button>
          <ha-button variant="brand" class="people-save-btn">${this._esc(
            this._t("save")
          )}</ha-button>
        </div>
      </div>
    `, { labelledBy: "liza-people-title", describedBy: "liza-people-hint" });

    this._wireSwitchList(dlg, {
      selector: ".person-switch",
      chosen: selected,
      field: "user",
      tally: () => this._t("assigned_people_count", {
        count: assignable.filter((p) => selected.has(p.user_id)).length,
        total: assignable.length,
      }),
    });
    this._wireUserBadges(dlg);
    this._wirePeopleSearch(dlg);
    dlg.querySelector(".people-cancel-btn")?.addEventListener("click", () => close());
    this._wirePeopleSave(dlg, close,
      () => this._saveAssignedPeople(entryId, [...selected]));
    this._focusWhenReady(dlg.querySelector(".people-search, .person-switch, .people-cancel-btn"));
  },

  /**
   * A list of switches over a set: the switch and the label beside it both
   * toggle it, and the running count follows.
   */
  _wireSwitchList(dlg, { selector, chosen, field, tally }) {
    const count = dlg.querySelector(".people-count");
    const pick = (sw) => {
      if (sw.checked) chosen.add(sw.dataset[field]);
      else chosen.delete(sw.dataset[field]);
      if (count) count.textContent = tally();
    };
    dlg.querySelectorAll(selector).forEach((el) =>
      el.addEventListener("change", () => pick(el)));
    // `ha-switch` is not a native input, so `<label for>` does not reach it,
    // and `preventDefault` keeps a browser that does forward the click from
    // toggling it a second time.
    dlg.querySelectorAll(".person-info[for]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        const sw = dlg.querySelector(`#${el.getAttribute("for")}`);
        if (!sw || sw.disabled) return;
        sw.checked = !sw.checked;
        pick(sw);
      }));
  },

  /** Filter the list by name. Rows are hidden rather than re-rendered: a
   *  switch that is removed and rebuilt loses the choice made on it. */
  _wirePeopleSearch(dlg) {
    const field = dlg.querySelector(".people-search");
    if (!field) return;
    const rows = dlg.querySelectorAll(".person-row");
    const empty = dlg.querySelector(".people-no-match");
    field.addEventListener("input", () => {
      const needle = String(field.value || "").trim().toLowerCase();
      let shown = 0;
      rows.forEach((row) => {
        const hit = !needle || (row.dataset.name || "").includes(needle);
        row.hidden = !hit;
        if (hit) shown++;
      });
      if (empty) empty.hidden = shown > 0;
    });
  },

  /**
   * One person, as Home Assistant draws the same question elsewhere: a badge,
   * a name and a switch, which is the row in its own "who may see this view"
   * editor.
   */
  _htmlPersonRow(person, index, selected) {
    const id = `liza-person-${index}`;
    const filter = ` data-name="${this._esc(String(person.name || "").toLowerCase())}"`;
    return `
      <div class="person-row person-row-pick"${filter}>
        ${this._htmlUserBadge("person-avatar", person.user_id, person.name)}
        <label class="person-info" id="${id}-label" for="${id}">
          <span class="person-name">${this._esc(person.name)}</span>
        </label>
        <ha-switch id="${id}" class="person-switch" data-user="${this._esc(
          person.user_id
        )}" ${selected.has(person.user_id) ? "checked" : ""}
                   aria-labelledby="${id}-label"></ha-switch>
      </div>`;
  },

  /** The household, fetched every time it is asked for: who may hold a remote
   *  is the one thing here that must not come from a cache. `null` where the
   *  call failed, which is not the same answer as nobody. */
  async _fetchPersons() {
    try {
      const r = await this._hass.callWS({ type: "lizaip_config/list_persons" });
      return r?.persons || [];
    } catch (e) {
      return null;
    }
  },

  /**
   * Whether anybody could be given a remote: an active user who is not an
   * administrator. The ⋮ menu's "Assign user…" is greyed out otherwise.
   * Fetched on every panel attach, so a user added in Home Assistant counts
   * on return.
   */
  async _loadAssignablePeople() {
    if (!this._isAdmin?.()) return;
    const persons = await this._fetchPersons();
    this._hasAssignablePeople = !!persons?.some((p) => p.assignable && !p.is_admin);
  },

  /**
   * Save, the way the rest of the panel saves: the button goes busy, the
   * dialog closes only once the write is through, and a failure leaves it
   * open with the choices still on it rather than closing over a toast.
   */
  _wirePeopleSave(dlg, close, write, after) {
    const btn = dlg.querySelector(".people-save-btn");
    if (!btn) return;
    const label = btn.textContent;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = this._t("assigned_people_saving");
      try {
        await write();
      } catch (e) {
        this._toast(this._t("assigned_people_failed"));
        btn.disabled = false;
        btn.textContent = label;
        return;
      }
      close();
      after?.();
    });
  },

  /** Write the new list, and say so. The backend answers with what it actually
   *  stored, so an id that stopped resolving between opening and saving is
   *  reported rather than assumed. */
  async _saveAssignedPeople(entryId, userIds) {
    await this._hass.callWS({
      type: "lizaip_config/set_device_users", entry_id: entryId, user_ids: userIds,
    });
    this._toast(this._t("assigned_people_saved"));
  },
};
