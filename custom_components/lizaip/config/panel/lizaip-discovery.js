/**
 * lizaIP Panel — remotes waiting to be added.
 *
 * Adding a second remote used to mean leaving for Settings → Devices &
 * services, finding the Discovered card and coming back. The panel owns
 * everything else about a remote, so that one detour was the odd one out.
 *
 * Two facts about this integration decide the shape of what follows.
 *
 * It is discovery-only: `async_step_user` aborts with `discovery_only`, so a
 * remote can arrive by mDNS and no other way. A button that starts a fresh
 * flow -- including the deep link to `/config/integrations/dashboard/add`,
 * which is what Home Assistant's own Add integration does -- would land on
 * "Manual setup is not supported". The honest subject here is therefore not
 * "add a device" but "a remote was found; confirm it".
 *
 * And its one user-facing step takes no input: `async_step_confirm` shows a
 * form with no schema, so submitting an empty body creates the entry. The
 * expensive half of driving a config flow yourself -- rendering `ha-form` and
 * its selectors -- does not exist for us, which is why this can be a button
 * rather than a hand-built copy of Home Assistant's dialog.
 *
 * Everything below is public, admin-gated API. The panel is registered with
 * `require_admin=True`, which matches the gate on every call used here, so
 * there is no non-admin branch to draw.
 */

/** This integration's config flow handler, which is also its domain. */
const DISCOVERY_HANDLER = "lizaip";

/**
 * The discovery source we act on. `config_entries/flow/subscribe` carries
 * every domain's flows, and within ours a `reauth` or `reconfigure` flow is
 * not a new remote -- it is an existing one asking for attention, and
 * offering Add for it would be a lie.
 */
const DISCOVERY_SOURCE = "zeroconf";

/** How long the opening route waits for the snapshot of pending flows. */
const DISCOVERY_OPENING_TIMEOUT_MS = 1500;

export const DiscoveryMixin = {
  // ── The pending flows ──────────────────────────────────────────────

  /** Remotes found on the network and not yet added. Never undefined, so
   *  the device list can count them before the subscription has replied. */
  _discovered() {
    return this._discoveryFlows || [];
  },

  /**
   * Follow the flows Home Assistant has in progress.
   *
   * Subscribed rather than polled: `config_entries/flow/subscribe` replies
   * with the current set and then streams `added`/`removed` as flows come and
   * go, which is the same feed the integrations dashboard reads. A remote
   * powered on while the panel is open therefore appears without a reload.
   *
   * Failure is quiet and total: the banner and the count simply never appear,
   * and the panel is otherwise exactly what it was. This is an addition to
   * the device list, not a dependency of it.
   */
  async _subscribeDiscovery() {
    if (this._discoveryUnsub || !this._hass?.connection) return;
    // Adding a remote goes through `config_entries/*`, which Home Assistant
    // restricts to administrators. Without this a non-admin would be shown a
    // remote waiting on the network and nothing but errors on pressing it.
    if (!this._isAdmin?.()) {
      this._discoveryFlows = [];
      this._discoveryOpened = Promise.resolve();
      return;
    }
    // Dropped rather than kept: the snapshot this subscription is about to
    // send is the whole truth, and anything added or ignored elsewhere while
    // the panel was detached is not in it.
    this._discoveryFlows = [];
    // Subscribing resolves as soon as the server acknowledges it, which is
    // before the snapshot of flows already in progress arrives. Anything that
    // has to know whether a remote is waiting -- the panel's opening route --
    // waits on this instead, and on a timeout besides, so a feed that never
    // speaks costs a moment rather than the panel.
    this._discoveryOpened = new Promise((resolve) => {
      this._discoveryOpenedResolve = resolve;
      setTimeout(resolve, DISCOVERY_OPENING_TIMEOUT_MS);
    });
    try {
      await this._holdSubscription("_discoveryUnsub", () => this._hass.connection.subscribeMessage(
        (msg) => this._onDiscoveryMessage(msg),
        { type: "config_entries/flow/subscribe" },
      ));
    } catch (e) {
      console.debug("[lizaIP] discovery subscription failed:", e);
      this._discoveryOpenedResolve?.();
    }
  },

  /** Drop it. The subscription lives on the shared connection, so a panel the
   *  user has navigated away from would otherwise keep re-rendering. */
  _unsubscribeDiscovery() {
    if (!this._discoveryUnsub) return;
    Promise.resolve(this._discoveryUnsub).then(u => u && u()).catch(() => {});
    this._discoveryUnsub = null;
  },

  /**
   * One message from the feed.
   *
   * Always an array of changes, never a list of flows: the first reply is the
   * set already in progress, each wrapped as `{type: null, flow_id, flow}`,
   * and every later one carries the one flow that has changed. A `removed`
   * has no `flow` at all, which is why it is matched by id against what we
   * already hold rather than by looking at the payload.
   */
  _onDiscoveryMessage(msg) {
    // The first message is the snapshot of what was already in progress, and
    // is what the opening route is waiting on -- including when it is empty.
    this._discoveryOpenedResolve?.();
    this._discoveryOpenedResolve = null;
    const before = this._discovered();
    let flows = before;
    for (const change of (Array.isArray(msg) ? msg : [msg])) {
      if (change?.type === "removed") {
        flows = flows.filter(f => f.flow_id !== change.flow_id);
      } else if (this._isDiscoveredRemote(change?.flow)
        && !flows.some(f => f.flow_id === change.flow.flow_id)) {
        // Guarded against a repeat: the opening set and an `added` racing it
        // can carry the same flow, and a duplicate would draw two rows for
        // one remote.
        flows = [...flows, change.flow];
      }
    }
    if (flows === before) return;
    this._discoveryFlows = flows;
    this._renderDiscovery();
  },

  /** Ours, and a new remote rather than one asking for attention. */
  _isDiscoveredRemote(flow) {
    return !!flow
      && flow.handler === DISCOVERY_HANDLER
      && flow.context?.source === DISCOVERY_SOURCE;
  },

  /**
   * What a found remote is called.
   *
   * `async_step_zeroconf` puts the name in `title_placeholders`, which is the
   * same field Home Assistant's own Discovered card reads. A flow that has
   * not set one is still worth offering, so it falls back to the product name
   * rather than being hidden.
   */
  _discoveredName(flow) {
    const name = (flow?.context?.title_placeholders?.name || "").trim();
    return name || this._t("discovery_fallback_name");
  },

  // ── Acting on one ──────────────────────────────────────────────────

  /**
   * Finish the confirm step, which is the whole of adding a remote.
   *
   * An empty body because the step has no fields; the reply is the flow
   * result, and only `create_entry` means a remote was added. An `abort` is
   * the ordinary outcome of confirming a flow that something else already
   * finished -- another tab, or the integrations page -- so it is reported as
   * the flow being gone rather than as a failure.
   */
  async _addDiscoveredRemote(flowId) {
    if (!flowId || this._discoveryBusy) return;
    this._discoveryBusy = flowId;
    try {
      // Inside the try, and the latch cleared before anything else can fail:
      // a render that threw here used to escape before the flow was posted
      // and leave the row disabled with no way back to it.
      this._renderDiscovery();
      const result = await this._hass.callApi(
        "post", `config/config_entries/flow/${flowId}`, {},
      );
      if (result?.type === "create_entry") {
        await this._afterDiscoveryChange(flowId);
        this._toast(this._t("discovery_added", { name: result.title || this._t("discovery_fallback_name") }));
      } else {
        await this._afterDiscoveryChange(flowId);
        this._toast(this._t("discovery_gone"));
      }
    } catch (e) {
      this._discoveryBusy = null;
      this._renderDiscovery();
      this._toast(this._t("discovery_add_failed", { error: e?.message || e }));
    }
  },

  /**
   * Put the panel back in step with what just happened.
   *
   * The flow is dropped here rather than waited for: the `removed` message is
   * on its way, but the button the user clicked is still on screen until it
   * lands, and a second click in that window would post to a flow that no
   * longer exists.
   *
   * Rendered whole rather than patched, because a remote that was just added
   * is now in the list below and only a render draws it. Inside a remote
   * nothing may be redrawn under the user, so there the rows and the toolbar
   * are patched as before. Callers toast after this, not before: a render
   * replaces the shadow tree the toast would have been hanging in.
   */
  async _afterDiscoveryChange(flowId) {
    this._discoveryFlows = this._discovered().filter(f => f.flow_id !== flowId);
    this._discoveryBusy = null;
    try {
      await this._listDevices();
    } catch (e) {
      console.debug("[lizaIP] device list refresh after discovery failed:", e);
    }
    if (this._currentEntry) this._renderDiscovery();
    else this._render();
  },

  /**
   * Put the rows on screen, or -- inside a remote -- the way back to them.
   *
   * The rows belong to the device list and nowhere else: a remote's own pages
   * are no place to be offered a different remote. Inside one the only thing
   * that changes is the leading toolbar control, which becomes a Back arrow
   * so there is a way out to the list that has them. Both are patched rather
   * than re-rendered, so news landing mid-edit costs no focus.
   */
  _renderDiscovery() {
    if (!this.isConnected && this.isConnected !== undefined) return;
    if (this._currentEntry) {
      this._syncToolbarLead?.();
      return;
    }
    const slot = this.shadowRoot?.querySelector(".discovery-slot");
    if (!slot) return;
    const html = this._htmlDiscoverySection();
    if (slot.innerHTML === html) return;
    const focused = this._discoveryFocus(slot);
    slot.innerHTML = html;
    this._wireDiscovery();
    this._restoreDiscoveryFocus(focused);
  },

  /**
   * Which row the keyboard was on, if it was on one of these.
   *
   * Named by flow rather than held as a node: the node is about to be
   * replaced, and a remote found or taken away while someone is tabbing the
   * rows would otherwise drop focus out of the panel entirely.
   */
  _discoveryFocus(slot) {
    const active = this.shadowRoot?.activeElement;
    const row = active?.closest?.(".discovery-row");
    if (!row || !slot.contains(row)) return null;
    return { flow: row.dataset.flow, index: this._discoveryRowIndex(row) };
  },

  _discoveryRowIndex(row) {
    return [...(this.shadowRoot?.querySelectorAll(".discovery-row") || [])].indexOf(row);
  },

  /**
   * Put it back on the same row, or on the one that took its place.
   *
   * A row that has gone hands focus to whichever row now sits where it did,
   * and the last row hands it to the one before. When none are left there is
   * nothing here to hold it, so it goes to the list's own heading.
   *
   * Through `_focusWhenReady`, because the control is an `ha-button` the line
   * above has just parsed: it forwards `focus()` to a node its first render
   * creates, and focusing it in this tick throws on a null.
   */
  _restoreDiscoveryFocus(focused) {
    if (!focused) return;
    const rows = [...(this.shadowRoot?.querySelectorAll(".discovery-row") || [])];
    if (!rows.length) {
      this._focusWhenReady(this.shadowRoot?.querySelector(".list-section-title"));
      return;
    }
    const same = rows.find(r => r.dataset.flow === focused.flow);
    const row = same || rows[Math.min(focused.index, rows.length - 1)];
    this._focusWhenReady(row.querySelector(".discovery-row-add"));
  },

  // ── The rows, at the head of the device list ───────────────────────

  /**
   * The slot the device list keeps for them.
   *
   * Rendered empty or not, so there is always a node to patch and the list
   * does not have to know how the rows are built.
   */
  _htmlDiscoverySlot() {
    return `<div class="discovery-slot">${this._htmlDiscoverySection()}</div>`;
  },

  /**
   * Home Assistant's discovered-device group, in our list.
   *
   * There is nothing for the user to start. HA's zeroconf browser is already
   * listening, so a remote that joins the network announces itself and the
   * panel has only to say so -- which is why this is a group that appears and
   * not a button that sits there waiting to be pressed.
   *
   * Headed and kept apart from the remotes below it the way the integrations
   * dashboard keeps them: these are not the user's yet, and a row sitting
   * flush against the ones that are invites a click meant for neither.
   */
  _htmlDiscoverySection() {
    const rows = this._discovered();
    if (!rows.length) return "";
    return `
      <section class="list-section">
        <h2 class="list-section-title" tabindex="-1">${this._esc(this._t("discovered_heading"))}</h2>
        ${rows.map(f => this._htmlDiscoveryRow(f)).join("")}
      </section>`;
  },

  _htmlDiscoveryRow(flow) {
    const busy = this._discoveryBusy === flow.flow_id;
    const disabled = busy ? "disabled" : "";
    return `
      <div class="discovery-row" data-flow="${this._esc(flow.flow_id)}">
        <span class="discovery-row-name">${this._esc(this._discoveredName(flow))}</span>
        <ha-button variant="success" class="discovery-row-add" ${disabled}>${this._esc(this._t(busy ? "discovery_adding" : "discovery_add"))}</ha-button>
      </div>`;
  },

  // ── Wiring, after every render that draws the rows ────────────────

  _wireDiscovery() {
    this.shadowRoot?.querySelectorAll(".discovery-row").forEach((row) => {
      row.querySelector(".discovery-row-add")
        ?.addEventListener("click", () => this._addDiscoveredRemote(row.dataset.flow));
    });
  },
};
