"""What Home Assistant services do: state maps, icon scopes and service classification."""

from __future__ import annotations

import re
from typing import Any

from .icon_defaults import icon_defaults

# ---------------------------------------------------------------------------
# Shared translation data for dynamic tooltips / labels
# ---------------------------------------------------------------------------

# Maps current entity state → action key (what pressing the button will DO)
NEXT_STATE_MAP: dict[str, str] = {
    "on": "off", "off": "on",
    "playing": "pause", "paused": "play", "idle": "play",
    "open": "close", "closed": "open",
    "locked": "unlock", "unlocked": "lock",
}

# Maps current HA state → predicted next HA state (used for optimistic icon lookup).
# Distinct from NEXT_STATE_MAP which maps to *action keys* (e.g. "pause"),
# while icon rules match against *HA states* (e.g. "paused").
PREDICTED_HA_STATE_MAP: dict[str, str] = {
    "on": "off", "off": "on",
    "playing": "paused", "paused": "playing",
    "idle": "playing",
    "open": "closed", "closed": "open",
    "locked": "unlocked", "unlocked": "locked",
}

# Which state's icon covers a live state that has no row of its own.
#
# `_TWO_WAY_STATE_SCOPE` narrows play/pause to two rows, but the speaker still
# reports `idle` when its queue empties and `buffering` on every stream start.
# Those are not extra faces: core's `async_media_play_pause` is binary, so
# anything not playing presses play, and `paused` is already that bucket's icon.
# Without this a user's custom "Paused" icon would vanish the moment the speaker
# went idle. Mirrored by STATE_CATCHALL in liza-remote-states.js.
STATE_CATCHALL: dict[str, dict[str, str]] = {
    "media_player": {"active": "playing", "inactive": "paused"},
}

# Narrower row lists for two-way services. Only play/pause needs one: it has two
# faces however many states its entity reports. The `off` row was actively
# misleading -- its shipped icon is mdi:power, right for a power button, while
# the press calls `async_media_play`. `toggle` is absent on purpose; it really
# can land on any state its entity reports, so it keeps the full list.
_TWO_WAY_STATE_SCOPE: dict[str, tuple[str, ...]] = {
    "media_play_pause": ("playing", "paused"),
}


def icon_varies_with_state(svc: str) -> bool:
    """True when a button's icon must follow the entity rather than stay put.

    Only two-way services (they cannot name their own direction) and
    attribute-backed ones (``volume_mute`` reads ``is_volume_muted``) qualify.
    Everything else does one thing, so its icon is fixed and HA already ships
    one for it.

    Derived rather than enumerated on purpose: a hand-kept list of one-way
    services was always one short of reality. ``search_media`` is neither
    stateless nor a toggle, so it fell into the "has states" branch and drew the
    media_player table's first row -- mdi:pause on a search button. Anything HA
    adds tomorrow would do the same. Reusing ``is_two_way_service`` also keeps
    one definition of "two-way" instead of a second list that can drift.
    """
    if is_two_way_service(svc):
        return True
    if is_stateless_service(svc):
        return False
    attr = service_to_attribute(svc)
    return bool(attr and attr in icon_defaults.attribute_icons)


def service_state_scope(svc: str) -> tuple[str, ...] | None:
    """Which states *svc* may wear: a tuple, or None for "no restriction".

    An empty tuple means the icon never varies, so no state row applies. That
    is now derived rather than listed, which is what lets a service nobody
    thought about -- `search_media`, or whatever HA ships next -- get the right
    answer without an entry here.
    """
    if not icon_varies_with_state(svc):
        return ()
    return _TWO_WAY_STATE_SCOPE.get(svc)


def service_fixed_icon(domain: str, svc: str) -> str | None:
    """Our override for a fixed-icon service, or None to defer to HA.

    Two layers, most specific first. ``domain_service_icons`` exists because
    ``service_icons`` is keyed by service name alone, and a few services need a
    different icon per domain: HA gives `media_player` the same mdi:power for
    both `turn_on` and `turn_off`, so an On/Off pair would be indistinguishable,
    while `light.turn_off` wants HA's mdi:lightbulb-off rather than a generic
    power glyph.
    """
    by_domain = icon_defaults.domain_service_icons.get(domain, {})
    return by_domain.get(svc) or icon_defaults.service_icons.get(svc)


def scoped_icon_state(svc: str, domain: str, live_state: str) -> str | None:
    """Which state's default icon *svc* should wear, or None when it has none.

    ``None`` means "this button has no state-keyed icon" -- the caller must name
    the service instead of borrowing a row from the state table. That borrowing
    is what put mdi:pause on Play and Search buttons alike.
    """
    allowed = service_state_scope(svc)
    if allowed is None:
        return live_state
    if not allowed:
        return None
    if live_state in allowed:
        return live_state
    return state_catchall(domain, live_state)


def state_catchall(domain: str, live_state: str) -> str | None:
    """Return the state whose icon covers *live_state*, or None."""
    rule = STATE_CATCHALL.get(domain)
    if not rule:
        return None
    return rule["active"] if live_state == rule["active"] else rule["inactive"]


#: Nested containers are never identity themselves — they hold it or describe it.
_PAYLOAD_NON_CONTAINER_KEYS = frozenset({"metadata", "target", "extra"})


def normalise_payload(data) -> dict:
    """Flatten a step's ``data`` into the flat view identity lookups expect.

    ``media_player.play_media`` nests the identifying keys under ``media`` while
    older configs keep them flat; both must resolve to the same identity. Merging
    is for *reading* only — the input is never mutated, and existing top-level
    keys always win.
    """
    if not isinstance(data, dict):
        return {}
    flat = dict(data)
    for key, value in data.items():
        if key in _PAYLOAD_NON_CONTAINER_KEYS or not isinstance(value, dict):
            continue
        for nested_key, nested_value in value.items():
            flat.setdefault(nested_key, nested_value)
    return flat


def split_service(service: str) -> tuple[str, str]:
    """Split ``"domain.service"``; a bare name is assumed to be ``homeassistant``."""
    if "." in service:
        domain, name = service.split(".", 1)
        return domain, name
    return "homeassistant", service


def service_name(service: str) -> str:
    """The service half of ``"domain.service"``, or the string itself if bare."""
    return split_service(service)[1]


def catchall_state_icon(
    state_icons: dict, domain: str, live_state: str, service: str
) -> str | None:
    """Look up a per-button override via the domain's catch-all state.

    Only for a service whose row list was *narrowed* (``media_play_pause``), so
    an override has to stretch to cover the states that lost a row. A service
    showing every row (``toggle``) is excluded: a missing entry there means the
    user chose not to set one, and borrowing another row would override that
    choice. A fixed-icon service is excluded too -- it has no rows at all.

    ``service`` is taken with or without its domain prefix, like
    ``scope_action_states``; it is required, because defaulting it would quietly
    opt a caller into catch-all behaviour for a service that must not have it.
    """
    if not state_icons:
        return None
    svc = service_name(service)
    if not service_state_scope(svc):
        return None
    fallback = state_catchall(domain, live_state)
    if not fallback or fallback == live_state:
        return None
    return state_icons.get(fallback) or None


def scope_action_states(service: str, states: Any) -> list[dict]:
    """Drop stored state rules a narrowed service can never reach.

    `states` is persisted on the action-library entry, so entries written before
    the service was scoped -- and every page built from `layouts.py` before the
    same fix -- still carry `idle` and `off` rows for `media_play_pause`, and a
    full set of rows for one-way services that have no faces at all. Every
    consumer walks that list *before* any fallback runs, so a stale `off` rule
    would keep winning and the button would keep wearing `mdi:power`.

    Filtering on read makes the fix retroactive without a store migration: the
    panel re-persists the trimmed list on its next save.

    Attribute-keyed rules are kept — they match an attribute value, not a domain
    state, so the service's state scope has nothing to say about them.

    An action with no service at all is left alone. There is nothing to reason
    from, and the empty service name reads as "fixed icon", which would strip
    every rule off an entry that never named a service.

    Rows are proven to be dicts on every path, not only the narrowed one. This
    function is the chokepoint the state readers go through -- `icons.py` and
    `buttons.py` walk its result calling `.get` -- so an unscoped service like
    `toggle`, which keeps every row, would otherwise hand them the junk
    untouched. Nothing in the repo writes a malformed `states`: `layouts.py`
    derives a list of dicts and the panel round-trips that. But the value comes
    back from the store over the websocket with no schema in between, so a
    hand-edited entry arrives unchecked, and dropping the bad rows here keeps a
    page sync running instead of taking out every button on the page. Hence the
    signature: `states` is whatever the store held, and `list[dict]` is the
    guarantee this function adds.
    """
    rows = [s for s in states if isinstance(s, dict)] if isinstance(states, list) else []
    svc = service_name(service)
    if not svc:
        return rows
    allowed = service_state_scope(svc)
    if allowed is None:
        return rows
    return [s for s in rows if s.get("attribute") or s.get("state") in allowed]


# Maps HA service name (after domain prefix) → action key
SERVICE_ACTION_MAP: dict[str, str] = {
    "turn_on": "on", "turn_off": "off",
    "open_cover": "open", "close_cover": "close", "stop_cover": "stop",
    "lock": "lock", "unlock": "unlock",
    "media_play": "play", "media_pause": "pause", "media_stop": "stop",
    "media_next_track": "next", "media_previous_track": "previous",
    "volume_mute": "mute",
}

# ---------------------------------------------------------------------------
# Cyclable attributes — the single source of truth
# ---------------------------------------------------------------------------
#
# One row per attribute: the values it cycles through, **in order**, each paired
# with the action key naming *arriving at* that value. The two maps below are
# derived from this.
#
# Also the **allowlist** for both attribute rungs of ``state_token_label``:
# without the gate, every service whose data names an attribute value literally
# (``select_source``, ``set_hvac_mode``, ...) would print raw HA values. Only
# cyclable attributes — where "the next value" has one answer — belong here.
#
# ``swing_mode`` is deliberately absent: ``swing_modes`` is a free-form
# per-device list, so no static cycle is correct for it.
#
# ``repeat``'s order is HA's own (``setMediaPlayerRepeatAction`` in
# ``frontend/src/data/media-player.ts``): off → all → one → off. HA's
# "anything else → off" fallback is deliberately not copied — it would name a
# direction for a value we do not recognise; unknown values degrade instead.
# Do not re-derive the order from ``knownAttrStates`` in
# ``liza-remote-states.js``: that enumerates legal values, it does not order the
# cycle.
#
# Mirrored in ``panel/liza-remote-helpers.js``; ``tests/label_parity_cases.json``
# pins the two together.
ATTR_ACTION_CYCLES: dict[str, tuple[tuple[str, str], ...]] = {
    "is_volume_muted": (("true", "mute"), ("false", "unmute")),
    "shuffle": (("true", "shuffle_on"), ("false", "shuffle_off")),
    "oscillating": (("true", "oscillate_on"), ("false", "oscillate_off")),
    "direction": (("forward", "forward"), ("reverse", "reverse")),
    "repeat": (("off", "repeat_off"), ("all", "repeat_all"), ("one", "repeat_one")),
}

# Maps attribute → the value it would be set to → the action key naming that
# set. ``volume_mute`` with ``is_volume_muted: true`` in its data is a button
# that mutes, whatever the speaker is doing right now. This is the cycle read
# in place: each value named by itself.
ATTR_VALUE_ACTION_MAP: dict[str, dict[str, str]] = {
    attribute: dict(cycle) for attribute, cycle in ATTR_ACTION_CYCLES.items()
}

# Maps attribute → its *current* value → the action key a press produces next:
# the cycle read one step ahead, wrapping at the end. The attribute counterpart
# of ``NEXT_STATE_MAP``, and the same "show the NEXT value" rule
# ``attribute_icons:`` in ``icon_defaults.yaml`` already follows — a muted
# speaker draws ``mdi:volume-high`` because pressing unmutes it.
ATTR_ACTION_MAP: dict[str, dict[str, str]] = {
    attribute: {
        value: cycle[(i + 1) % len(cycle)][1]
        for i, (value, _) in enumerate(cycle)
    }
    for attribute, cycle in ATTR_ACTION_CYCLES.items()
}

# ---------------------------------------------------------------------------
# Service classification
# ---------------------------------------------------------------------------

# Services that fire and forget — they leave no state to reflect on the button
STATELESS_SERVICES: frozenset[str] = frozenset({
    "media_next_track", "media_previous_track", "media_seek",
    "play_media", "clear_playlist", "join", "unjoin",
    "volume_up", "volume_down",
    "send_command", "learn_command",
    "select_source",
})

# Services that flip an entity between two states
TOGGLE_SERVICES: frozenset[str] = frozenset({
    "turn_on", "turn_off", "toggle",
    "open_cover", "close_cover", "stop_cover",
    "lock", "unlock",
    "media_play", "media_pause", "media_stop", "media_play_pause",
})

# Services whose attribute name can't be derived from the service name
_ATTR_IRREGULARS: dict[str, str] = {
    "volume_mute": "is_volume_muted",
    "oscillate": "oscillating",
}


def attr_str(value: Any) -> str:
    """Stringify an attribute value for icon-map lookups.

    Home Assistant stores boolean attributes (``is_volume_muted``, ``shuffle``,
    ``oscillating``) as Python bools, but the icon maps in ``icon_defaults.yaml``
    are keyed by the lowercase YAML forms ``"true"`` / ``"false"``. Without this
    normalisation ``str(True)`` yields ``"True"`` and never matches.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def service_to_attribute(svc: str) -> str | None:
    """Map a service name to the attribute it modifies."""
    if svc in _ATTR_IRREGULARS:
        return _ATTR_IRREGULARS[svc]
    m = re.match(r"^set_(.+)$", svc)
    if m:
        return m.group(1)
    m = re.match(r"^(.+)_set$", svc)
    if m:
        return m.group(1)
    m = re.match(r"^select_(.+)$", svc)
    if m:
        return m.group(1)
    return None


def is_stateless_service(svc: str) -> bool:
    """Return True if *svc* leaves no state worth reflecting on the button."""
    if svc in STATELESS_SERVICES:
        return True
    return bool(re.match(r"^(browse|send|clear)_", svc))


def is_state_toggle_service(svc: str) -> bool:
    """Return True if *svc* flips an entity between two states."""
    return svc in TOGGLE_SERVICES


def is_two_way_service(svc: str) -> bool:
    """Return True if *svc* flips an entity and cannot say which way by itself.

    ``toggle`` and ``media_play_pause`` are the whole set: every other service
    in ``TOGGLE_SERVICES`` names its own direction via ``SERVICE_ACTION_MAP``
    (``turn_on`` always means "On"). These are the buttons whose label has to
    move with the entity, so these are the ones the panel labels with a
    ``${_state}`` template rather than a fixed word.
    """
    return svc in TOGGLE_SERVICES and svc not in SERVICE_ACTION_MAP


def attribute_cycle_for(svc: str) -> dict[str, str] | None:
    """The value→next-action cycle for *svc*, or None if it has no attribute.

    The single gate for everything attribute-driven: ``ATTR_ACTION_CYCLES`` is
    an allowlist, so a service whose attribute is not a cyclable one answers
    None and every caller falls back to what it did before.
    """
    attribute = service_to_attribute(svc)
    return ATTR_ACTION_MAP.get(attribute) if attribute else None


def is_attribute_state_service(svc: str) -> bool:
    """True if what *svc* changes lives in a cyclable attribute, not the state.

    ``volume_mute``, ``shuffle_set``, ``oscillate``, ``set_direction`` and
    ``repeat_set``. A muted speaker is still ``playing``, so these buttons
    cannot be read from ``state.state`` the way a toggle can.
    """
    return attribute_cycle_for(svc) is not None
