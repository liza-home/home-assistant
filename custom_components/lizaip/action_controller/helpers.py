"""Small shared readers: stores, entity resolution, page-id coercion."""
from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from typing import Any

from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import floor_registry as fr
from homeassistant.helpers import label_registry as lr
from homeassistant.helpers.target import (
    TargetSelection,
    async_extract_referenced_entity_ids,
)

from ..const import DOMAIN, service_name, split_service  # noqa: F401
from ..runtime import _get_store, _resolve_device_id  # noqa: F401
from ._state import _DEFAULT_PAGE_ID, _current_page

_LOGGER = logging.getLogger(__name__)


def _resolve_entry_id(hass: HomeAssistant, data: dict) -> str | None:
    """Resolve the config entry_id an event belongs to.

    Prefers the device registry, falls back to an explicit ``entry_id`` in the
    payload, and finally to the sole config entry when only one exists.
    """
    device_id = data.get("device_id")
    entry_id: str | None = None
    if device_id:
        device = dr.async_get(hass).async_get(device_id)
        if device:
            for eid in device.config_entries:
                e = hass.config_entries.async_get_entry(eid)
                if e and e.domain == DOMAIN:
                    entry_id = eid
                    break
    if not entry_id:
        entry_id = data.get("entry_id")
    if not entry_id:
        entries = hass.config_entries.async_entries(DOMAIN)
        if len(entries) == 1:
            entry_id = entries[0].entry_id
    return entry_id


def _raw_page_id(data: dict) -> int | None:
    """The event's ``page_id`` as an int, or None when it names no page.

    Split out of :func:`_coerce_page_id` because the page-change check needs the
    device's *literal* answer: "unset" and "page 1" have to stay distinguishable
    there, or every uninitialised event would read as a navigation to page 1 and
    clear the selection the user just made. The fallback belongs to the
    assignment lookup, which has to have *some* page, and only to it.
    """
    raw = data.get("page_id")
    if raw is None:
        return None
    try:
        page_id = int(raw)
    except (TypeError, ValueError):
        return None
    return page_id or None


def _coerce_page_id(data: dict, entry_id: str | None = None) -> int:
    """Return a usable int page_id.

    The device sends 0 (or a string) before its page state is initialised, and
    pages are 1-based, so both must fall back rather than propagate downstream.

    The fallback prefers the page *this* entry was last seen on, and only then
    page 1. An uninitialised event is the device failing to say where it is, not
    the device saying it is at the start — and resolving it against page 1's
    assignments while the user is on page 3 runs the other page's action, which
    is the same bug the page-change reset exists to fix, reached from the other
    side.
    """
    page_id = _raw_page_id(data)
    if page_id:
        return page_id
    if entry_id:
        return _current_page.get(entry_id) or _DEFAULT_PAGE_ID
    return _DEFAULT_PAGE_ID


def _normalize_position(raw_position) -> float | None:
    """Convert a protocol slider position (0-100 percent) to a 0.0-1.0 ratio.

    PROTOCOL.md fixes ``position`` at 0-100, so convert unconditionally.
    Sniffing the scale per-event (">1 means percent") cannot work: 1 is a
    legitimate percentage near the bottom of the track, and treating it as a
    ratio would send the value to 100% — the exact inverse of what the user did.

    A missing or unparseable position stays None rather than defaulting to 0.0:
    firmware that omits ``position`` on the lift event would otherwise look like
    a drag to the very bottom and slam the value to its minimum.
    """
    try:
        return max(0.0, min(1.0, float(raw_position) / 100.0))
    except (TypeError, ValueError):
        return None



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _noop() -> None:
    """No-op cleanup callable, returned when there is nothing to tear down."""


def first_id(value: Any) -> str | None:
    """The first id out of a target field, which may be a scalar or a list.

    Every target field HA writes is ``str | list[str]``. An empty list and an
    empty string both mean "nothing named here", so both collapse to ``None``.
    """
    if isinstance(value, list):
        value = value[0] if value else None
    return value or None


def get_entity_from_step(step: dict) -> str | None:
    """Extract the target entity_id from a single action step dict.

    ``target`` / ``data`` may be present but explicitly null (placeholder
    assignments are written as ``{"action_id": None, "config": []}``, and
    configs round-trip through the panel as free-form JSON), so ``or {}`` is
    used rather than a ``.get`` default — the default only applies when the
    key is absent, not when it is present and None.
    """
    return (
        first_id((step.get("target") or {}).get("entity_id"))
        or first_id((step.get("data") or {}).get("entity_id"))
    )


def resolve_target_entities(
    step: dict, hass: HomeAssistant, service_domain: str | None = None,
) -> list[str]:
    """Resolve a step's target to the entity_ids it acts on.

    Delegates to HA's ``async_extract_referenced_entity_ids``, the same resolver
    the service layer uses, so a button resolves the way its call will. Sorted
    because those are sets and the first element is stored as the button's name.
    """
    eid = get_entity_from_step(step)
    if eid:
        return [eid]

    target = step.get("target") or {}
    if not target:
        return []

    if not service_domain:
        svc = step.get("action") or step.get("service") or ""
        service_domain = svc.split(".")[0] if "." in svc else ""

    selected = async_extract_referenced_entity_ids(hass, TargetSelection(target))
    return [
        entity_id
        for entity_id in sorted(selected.referenced | selected.indirectly_referenced)
        if not service_domain or entity_id.split(".")[0] == service_domain
    ]


def _subject_name(
    registry: object, lookup: str, hass: HomeAssistant, item_id: str,
) -> str:
    """The name a registry entry shows in the UI, a rename winning where there
    is one. Only devices carry ``name_by_user``; the rest answer with ``name``.
    """
    item = getattr(registry.async_get(hass), lookup)(item_id)
    if not item:
        return ""
    return getattr(item, "name_by_user", None) or item.name or ""


#: Target kinds that name something other than an entity, narrowest first, each
#: paired with the registry that knows its name and how that registry is asked.
#: Mirrored by `SUBJECT_KINDS` in `liza-remote-helpers.js`.
_SUBJECT_REGISTRIES = (
    ("device_id", dr, "async_get"),
    ("area_id", ar, "async_get_area"),
    ("floor_id", fr, "async_get_floor"),
    ("label_id", lr, "async_get_label"),
)


def target_subject_name(step: dict, hass: HomeAssistant) -> str:
    """The name of the thing a step points at, when that is not an entity.

    A button aimed at an area is about the area, so it reads "Office" rather
    than borrowing the name of whichever lamp happened to sort first. Empty for
    an entity target: there the entity's own friendly name is the subject.
    """
    if get_entity_from_step(step):
        return ""
    target = step.get("target") or {}
    for key, registry, lookup in _SUBJECT_REGISTRIES:
        item_id = first_id(target.get(key))
        if item_id:
            return _subject_name(registry, lookup, hass, item_id)
    return ""


#: States that carry no information about the thing itself.
_ABSENT_STATES = frozenset({"unavailable", "unknown"})

#: What "not doing anything" looks like across domains, the deny-list HA's own
#: `stateActive` reduces to. Anything else counts as active, so one member in
#: it speaks for the group the way a light group is on if any lamp is.
_INACTIVE_STATES = _ABSENT_STATES | {
    "off", "closed", "locked", "standby", "idle", "docked", "paused",
    "not_home", "disarmed",
}


def resolve_group_state(
    entity_ids: list[str], hass: HomeAssistant,
) -> State | None:
    """The state a set of entities presents together, Home Assistant style.

    Members with nothing to report are skipped, so one dead lamp cannot answer
    for a room whose other six are reachable.
    """
    states = [state for eid in entity_ids if (state := hass.states.get(eid))]
    present = [state for state in states if state.state not in _ABSENT_STATES]
    for state in present:
        if state.state not in _INACTIVE_STATES:
            return state
    if present:
        return present[0]
    return states[0] if states else None


def resolve_step_state(step: dict, hass: HomeAssistant) -> State | None:
    """The state a step's target presents, across every entity behind it."""
    return resolve_group_state(resolve_target_entities(step, hass), hass)


def resolve_step_entity(step: dict, hass: HomeAssistant) -> str | None:
    """The one entity a step acts on, whichever target kind names it.

    For callers with a single subject; the rest call ``resolve_target_entities``
    directly. Reading only ``entity_id`` is why a device-bound TV got no wake.
    """
    entities = resolve_target_entities(step, hass)
    return entities[0] if entities else None


def first_step(assign: dict) -> dict:
    """A button's first config step, which is the one its label describes."""
    config = assign.get("config", []) if isinstance(assign, dict) else []
    if not (isinstance(config, list) and config):
        return {}
    return config[0] if isinstance(config[0], dict) else {}


def subject_for_assign(
    assign: dict, hass: HomeAssistant, fallback_state: State | None = None,
) -> tuple[str, State | None]:
    """The name and state a button's label should speak about.

    The single source for both producers -- ``device_sync`` at sync time and
    ``icons`` on every state change -- because a label they each derived read
    one thing on the remote and another the moment a member entity moved.
    """
    step = first_step(assign)
    if not step:
        return "", fallback_state
    return (
        target_subject_name(step, hass),
        resolve_step_state(step, hass) or fallback_state,
    )


async def _get_assignments(
    hass: HomeAssistant, device_id: str, page_id: int,
) -> list[tuple[str, dict]]:
    """Return (button_key, assignment_dict) pairs for every button on *page_id*."""
    assignments = await _get_store(hass).async_get_assignments(device_id, page_id)
    return [
        (key, assign) for key, assign in assignments.items()
        if isinstance(assign, dict)
    ]


def _attrs(state: State | None) -> Mapping[str, Any]:
    """Return a state's attributes as a mapping, whatever the state is.

    Every predicate below reads attributes, and this runs against live states,
    hand-edited configs and test doubles alike — so "no state" and "a state
    whose attributes are not a mapping" both have to degrade to "no attributes"
    rather than raise inside a touch event.
    """
    attributes = getattr(state, "attributes", None)
    return attributes if isinstance(attributes, Mapping) else {}


def _color_modes(state: State | None) -> list:
    modes = _attrs(state).get("supported_color_modes")
    return list(modes) if isinstance(modes, (list, tuple, set)) else []


def _attr_num(state: State | None, key: str) -> float | None:
    """A numeric attribute that is present and finite, else None."""
    try:
        value = float(_attrs(state).get(key))
    except (TypeError, ValueError):
        return None
    # NaN and ±inf reach here from hand-edited YAML and from integrations that
    # publish a placeholder range; either would poison the delta arithmetic
    # downstream, where every comparison against NaN is False.
    return value if math.isfinite(value) else None
