/**
 * lizaIP Panel — State Derivation Logic
 * Determines which states an action can have, maps services to attributes,
 * provides default icons, and renders the states editor section.
 */

// Two-way services (`toggle`, `media_play_pause`) are the only ones whose icon
// depends on the entity. One-way services are deliberately derived rather than
// listed -- see `icon_varies_with_state` in const.py for why a list never held.

// Narrower row lists for two-way services; mirrors `_TWO_WAY_STATE_SCOPE` in
// const.py, which carries the rationale.
//
// Deliberately not a `supported_features` test. Features describe which
// services an entity accepts, not which states it can report: a Sonos
// advertises PLAY|PAUSE and still goes `idle` on an empty queue. Gating rows on
// feature bits was tried and removed — it changed nothing here, and where it
// did apply it dropped the `paused` row from a PLAY-only streamer (stranding
// the catch-all, which points at it) and the `idle` row from power buttons.
const TWO_WAY_STATE_SCOPE = {
  media_play_pause: ["playing", "paused"],
};

// The state whose icon covers a live state that has no row of its own; mirrors
// STATE_CATCHALL in const.py. Narrowing the rows is only safe if something
// covers what they used to.
const STATE_CATCHALL = {
  media_player: { active: "playing", inactive: "paused" },
};

export const StatesMixin = {
  _getStatesForAction(action, entityId) {
    const service = action.service || "";
    const domain = service.split(".")[0] || "";
    const svc = service.split(".")[1] || "";

    // A device-local command runs on the remote and touches no entity, so there
    // is no state to derive and no attribute to watch.
    if (this._internalCommand(service) || this._isStatelessService(svc)) {
      return { attribute: null, states: [] };
    }

    const attrName = this._serviceToAttribute(svc);
    if (!attrName) {
      if (this._isStateToggleService(svc)) {
        const scope = this._serviceStateScope(svc);
        const domainStates = this._getStatesForDomain(domain);
        return {
          attribute: null,
          states: scope ? domainStates.filter(s => scope.includes(s)) : domainStates,
        };
      }
      return { attribute: null, states: [] };
    }

    const eid = entityId || this._getEntityFromAction(action);
    const stateObj = eid ? this._hass?.states?.[eid] : null;
    if (stateObj) {
      const attrs = stateObj.attributes || {};
      if (typeof attrs[attrName] === "boolean") {
        return { attribute: attrName, states: ["true", "false"] };
      }
      const listAttr = attrs[attrName + "_list"] || attrs[attrName + "s"] || attrs[attrName + "_modes"];
      if (Array.isArray(listAttr) && listAttr.length > 0) {
        return { attribute: attrName, states: listAttr.map(String) };
      }
      if (attrName in attrs) {
        const val = attrs[attrName];
        if (val === true || val === false || val === "true" || val === "false") {
          return { attribute: attrName, states: ["true", "false"] };
        }
      }
    }

    // Static fallback for known attributes without live entity data
    const knownAttrStates = {
      is_volume_muted: ["true", "false"],
      repeat: ["off", "one", "all"],
      shuffle: ["true", "false"],
      oscillating: ["true", "false"],
      direction: ["forward", "reverse"],
      hvac_mode: ["heat", "cool", "heat_cool", "auto", "dry", "fan_only", "off"],
    };
    if (knownAttrStates[attrName]) {
      return { attribute: attrName, states: knownAttrStates[attrName] };
    }

    // Numeric/continuous attributes (volume, brightness, temperature, etc.)
    // — no per-value states; don't fall back to domain states
    return { attribute: attrName, states: [] };
  },

  _isStateToggleService(svc) {
    const toggles = [
      "turn_on", "turn_off", "toggle",
      "media_play_pause", "media_play", "media_pause", "media_stop",
      "open_cover", "close_cover", "stop_cover", "toggle_cover",
      "lock", "unlock",
      "alarm_arm_home", "alarm_arm_away", "alarm_arm_night",
      "alarm_arm_vacation", "alarm_disarm", "alarm_trigger",
      "close_valve", "open_valve", "toggle_valve",
      "start", "stop", "pause", "return_to_base",
    ];
    return toggles.includes(svc);
  },

  _getEntityFromAction(action) {
    return this._getTargetEntityFromConfig(action.config);
  },

  /**
   * Which states a domain can report, read from the default theme's icons.
   *
   * This used to be a switch listing eight domains by hand, which was a second
   * copy of `DOMAIN_STATE_ICONS` -- the executor derived its rows from the yaml
   * while the panel read the literal, so adding `media_player: "on"` to the
   * yaml silently fixed only one of the two surfaces.
   *
   * Reading the same yaml means any domain added there works on both sides with
   * no code change, and a domain nobody has added yet degrades to on/off rather
   * than to a wrong answer.
   */
  _getStatesForDomain(domain) {
    const rows = this._iconDefaults?.domain_state_icons?.[domain];
    const states = rows ? Object.keys(rows) : [];
    return states.length ? states : ["on", "off"];
  },

  /**
   * Does this service's icon follow the entity, or does it stay put?
   *
   * Mirrors `icon_varies_with_state` in const.py. Only a two-way service
   * (`toggle`, `media_play_pause`) or an attribute-backed one (`volume_mute`)
   * varies. Everything else does one thing, so its icon says what that is.
   */
  _iconVariesWithState(svc) {
    if (this._isTwoWayService(svc)) return true;
    if (this._isStatelessService(svc)) return false;
    const attr = this._serviceToAttribute(svc);
    return !!(attr && this._iconDefaults?.attribute_icons?.[attr]);
  },

  /**
   * Which states `svc` may wear: an array, or null for "no restriction".
   *
   * Mirrors `service_state_scope` in const.py. An empty array means the icon
   * never varies, so no state row applies — derived, not listed, which is what
   * lets a service nobody enumerated get the right answer.
   */
  _serviceStateScope(svc) {
    if (!this._iconVariesWithState(svc)) return [];
    return TWO_WAY_STATE_SCOPE[svc] || null;
  },

  /**
   * Our override for a fixed-icon service, or "" to defer to Home Assistant.
   *
   * Mirrors `service_fixed_icon` in const.py — per-domain first, because
   * `service_icons` is keyed by service name alone and HA gives `media_player`
   * the same mdi:power for turn_on and turn_off.
   */
  _serviceFixedIcon(domain, svc) {
    const d = this._iconDefaults;
    return d?.domain_service_icons?.[domain]?.[svc] || d?.service_icons?.[svc] || "";
  },

  /** Whether a stored rule holds the shipped icon rather than a chosen one.
   * Mirrors `is_seeded_icon` in services.py, and compares against the
   * *unthemed* table so a theme's own glyph is never read as seeded. */
  _isSeededIcon(domain, rule) {
    const icon = rule && rule.icon;
    if (!icon) return false;
    const state = rule.state;
    if (state === undefined || state === null) return false;
    const d = this._shippedIconDefaults;
    const table = rule.attribute
      ? (d?.attribute_icons?.[rule.attribute] || { true: "mdi:check-circle", false: "mdi:close-circle" })
      : (d?.domain_state_icons?.[domain] || { on: "mdi:check-circle", off: "mdi:close-circle" });
    return icon === table[String(state)];
  },

  /**
   * Drop stored state rules a narrowed service can never reach.
   *
   * Mirrors `scope_action_states` in const.py — see there for why this is a
   * read-side filter rather than a store migration.
   */
  _scopeActionStates(service, states) {
    // Rows are proven to be objects on every path, not only the narrowed one:
    // this is the chokepoint the state readers go through, so an unscoped
    // service like `toggle` would otherwise hand `_getDisplayIconForState` the
    // junk untouched. Nothing writes a malformed list, but it comes back from
    // the store over the websocket with no schema, and a throw here would blank
    // the whole view rather than one button -- every view is a single
    // interpolated template string.
    // A row must be a plain object. `typeof` alone is not that test: it answers
    // "object" for arrays too, where Python's `isinstance(s, dict)` does not,
    // and the two sides have to agree on what counts as a row.
    const rows = Array.isArray(states)
      ? states.filter(s => s && typeof s === "object" && !Array.isArray(s))
      : [];
    const svc = (service || "").split(".")[1] || "";
    // No service means nothing to reason from; an empty name reads as "fixed
    // icon", which would strip every rule off an entry that never named one.
    if (!svc) return rows;
    const domain = service.includes(".") ? service.split(".")[0] : "";
    const kept = domain ? rows.filter(s => !this._isSeededIcon(domain, s)) : rows;
    const allowed = this._serviceStateScope(svc);
    if (!allowed) return kept;
    return kept.filter(s => s.attribute || allowed.includes(s.state));
  },

  /**
   * Does this service read the state table at all, under a narrowed row list?
   *
   * Mirrors `state_icon_override` (shared/services.py). An unscoped service
   * still shows every row, so a missing entry there is a choice, not a gap.
   */
  _isScopedStateService(svc) {
    const allowed = this._serviceStateScope(svc || "");
    return Array.isArray(allowed) && allowed.length > 0;
  },

  /**
   * Which state's icon to draw when the live state matches no configured row.
   *
   * Mirrors `state_catchall` in const.py; see STATE_CATCHALL above for why the
   * non-playing states collapse into one face.
   */
  _catchAllState(domain, liveState) {
    const rule = STATE_CATCHALL[domain];
    if (!rule) return null;
    return liveState === rule.active ? rule.active : rule.inactive;
  },

  _getDefaultIcons(domain, attribute) {
    const d = this._iconDefaults;
    if (attribute) {
      return d?.attribute_icons?.[attribute] || { true: "mdi:check-circle", false: "mdi:close-circle" };
    }
    return d?.domain_state_icons?.[domain] || { on: "mdi:check-circle", off: "mdi:close-circle" };
  },
};
