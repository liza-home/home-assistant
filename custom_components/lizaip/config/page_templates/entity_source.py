"""The registry-backed sources: entities, scenes, scripts and the like.

Items are read from Home Assistant's entity, area, device and label
registries; :func:`subscribe_entity_registry` refreshes a page when a registry
change could alter what it lists.
"""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant

from .items import DEFAULT_MAX_ITEMS, DynamicItem


_LOGGER = logging.getLogger(__name__)


# ── registry-backed entities source ───────────────────────────────────
#
# One parameterised source covers scenes, scripts and filtered entity lists.


_ENTITIES_PARAMS: dict[str, dict[str, Any]] = {
    "domain": {
        "type": "string",
        "required": False,
        "description": "Entity domain to include, e.g. scene, script or light",
    },
    "area": {
        "type": "string",
        "required": False,
        "description": "Area id or name to restrict to",
    },
    "label": {
        "type": "string",
        "required": False,
        "description": "Label id or name to restrict to",
    },
    "config_entry": {
        "type": "string",
        "required": False,
        "description": (
            "Config entry id to restrict to, e.g. one Hue bridge's entry"
        ),
    },
    "device_class": {
        "type": "string",
        "required": False,
        "description": (
            "Device class to restrict to, e.g. battery, temperature or "
            "signal_strength"
        ),
    },
    "translation_key": {
        "type": "string",
        "required": False,
        "description": (
            "Which of an integration's entities, by the key it names them "
            "with, e.g. ip_address -- for telling apart sensors that share "
            "a config entry and no device class"
        ),
    },
}

_AREA_LABEL_PARAMS: dict[str, dict[str, Any]] = {
    key: _ENTITIES_PARAMS[key] for key in ("area", "label")
}

#: Service a domain's items are activated with. Anything not listed falls back
#: to ``homeassistant.turn_on``.
#:
#: ``homeassistant.turn_on`` skips domains without their own ``turn_on``
#: service, so cover/button/valve need explicit services. Domains left to the
#: fallback do register ``turn_on`` with the intended meaning: light, switch,
#: input_boolean, fan, vacuum, climate, siren, humidifier and water_heater.
#:
#: ``lock`` is deliberately absent: choosing lock vs unlock on a physical
#: remote is a security decision for the user.
_DOMAIN_ACTIONS = {
    "automation": "automation.trigger",
    "button": "button.press",
    "cover": "cover.open_cover",
    "scene": "scene.turn_on",
    "script": "script.turn_on",
    "valve": "valve.open_valve",
}

#: Icon used when neither the registry nor state carries one; blank icons look
#: like broken bindings.
#:
#: Literal table on purpose: ``async_get_icons`` is async, while ``_entity_item``
#: is sync and loops over the registry.
_DOMAIN_ICONS = {
    "automation": "mdi:robot",
    "button": "mdi:gesture-tap-button",
    "climate": "mdi:thermostat",
    "cover": "mdi:window-shutter",
    "fan": "mdi:fan",
    "humidifier": "mdi:air-humidifier",
    "input_boolean": "mdi:toggle-switch-outline",
    "light": "mdi:lightbulb",
    "lock": "mdi:lock",
    "media_player": "mdi:speaker",
    "scene": "mdi:palette",
    "script": "mdi:script-text",
    "siren": "mdi:bullhorn",
    "switch": "mdi:toggle-switch",
    "vacuum": "mdi:robot-vacuum",
    "valve": "mdi:valve",
    "water_heater": "mdi:water-boiler",
}
_DEFAULT_ICON = "mdi:shape"


def _domain_of(entity_id: str) -> str:
    return entity_id.split(".", 1)[0] if "." in entity_id else ""


def _wanted_domains(spec: dict[str, Any]) -> set[str]:
    raw = spec.get("domain") or spec.get("domains") or ""
    if isinstance(raw, str):
        raw = [raw]
    return {str(item).strip() for item in raw if str(item).strip()}


def _registries(hass: HomeAssistant) -> tuple[Any, Any, Any, Any]:
    """The four registries this source reads, imported lazily.

    The helpers are heavy and absent from unit-test stubs, so module-scope
    imports would break collection.
    """
    from homeassistant.helpers import area_registry as ar
    from homeassistant.helpers import device_registry as dr
    from homeassistant.helpers import entity_registry as er

    try:
        from homeassistant.helpers import label_registry as lr
    except ImportError:  # pragma: no cover - HA older than labels
        lr = None

    def _get(module):
        if module is None:
            return None
        try:
            return module.async_get(hass)
        except Exception:  # pragma: no cover - registry not loaded
            return None

    return _get(er), _get(ar), _get(dr), _get(lr)


def _reg_mapping(registry, attr: str) -> dict:
    """A registry's id→entry mapping as a real dict."""
    raw = getattr(registry, attr, None) if registry is not None else None
    if isinstance(raw, dict):
        return raw
    try:
        return dict(raw)
    except Exception:
        return {}


def _match_area_ids(area_reg, wanted: str) -> set[str]:
    """Area ids matching *wanted*, which may be an id or a display name."""
    if not wanted or area_reg is None:
        return set()
    needle = wanted.strip().casefold()
    matched = {
        area.id
        for area in _reg_mapping(area_reg, "areas").values()
        if str(getattr(area, "id", "")).casefold() == needle
        or str(getattr(area, "name", "")).casefold() == needle
    }
    # Unknown names must not silently widen to "everything".
    return matched or {wanted.strip()}


def _match_label_ids(label_reg, wanted: str) -> set[str]:
    if not wanted:
        return set()
    needle = wanted.strip().casefold()
    matched = {
        label.label_id
        for label in _reg_mapping(label_reg, "labels").values()
        if str(getattr(label, "label_id", "")).casefold() == needle
        or str(getattr(label, "name", "")).casefold() == needle
    }
    return matched or {wanted.strip()}


def _entry_area_id(entry, device_reg) -> str:
    area_id = getattr(entry, "area_id", None)
    if area_id:
        return str(area_id)
    device_id = getattr(entry, "device_id", None)
    if device_id and device_reg is not None:
        device = device_reg.async_get(device_id)
        if device is not None and getattr(device, "area_id", None):
            return str(device.area_id)
    return ""


def _entity_item(hass: HomeAssistant, entity_id: str, entry) -> DynamicItem:
    domain = _domain_of(entity_id)
    try:
        state = hass.states.get(entity_id)
    except Exception:  # pragma: no cover - state machine unavailable
        state = None
    raw_attrs = getattr(state, "attributes", None) if state is not None else None
    attrs = raw_attrs if isinstance(raw_attrs, dict) else {}

    title = (
        (getattr(entry, "name", None) if entry is not None else None)
        or (getattr(entry, "original_name", None) if entry is not None else None)
        or attrs.get("friendly_name")
        or entity_id
    )
    icon = (
        (getattr(entry, "icon", None) if entry is not None else None)
        or (getattr(entry, "original_icon", None) if entry is not None else None)
        or attrs.get("icon")
        or _DOMAIN_ICONS.get(domain, _DEFAULT_ICON)
    )

    return DynamicItem(
        title=str(title),
        thumbnail=str(icon),
        action=_DOMAIN_ACTIONS.get(domain, "homeassistant.turn_on"),
        data={"entity_id": entity_id},
        identity=entity_id,
        # A variable, not the name as it is now: the button follows a rename
        # the moment it happens, and is a tooltip like any other -- never the
        # library entry's name, which twelve lamps on a Hue page share.
        tooltip=f"${{{entity_id}.friendly_name}}",
    )


async def resolve_entities(
    hass: HomeAssistant,
    spec: dict[str, Any],
    max_items: int = DEFAULT_MAX_ITEMS,
) -> list[DynamicItem]:
    """Entities from the registries, filtered by domain, area and/or label.

    ``config_entry`` narrows to one integration instance — for example one Hue
    bridge — which makes it usable as a template target before a page exists.
    Results are sorted by friendly name then entity id because bindings are by
    position, not identity.
    """
    spec = dict(spec or {})
    domains = _wanted_domains(spec)
    area = str(spec.get("area") or "").strip()
    label = str(spec.get("label") or "").strip()
    config_entry = str(spec.get("config_entry") or "").strip()

    device_class = str(spec.get("device_class") or "").strip().lower()
    translation_key = str(spec.get("translation_key") or "").strip()
    entity_reg, area_reg, device_reg, label_reg = _registries(hass)

    area_ids = _match_area_ids(area_reg, area) if area else set()
    label_ids = _match_label_ids(label_reg, label) if label else set()

    found: dict[str, DynamicItem] = {}

    entries = _reg_mapping(entity_reg, "entities")
    for entity_id, entry in entries.items():
        entity_id = str(entity_id)
        if domains and _domain_of(entity_id) not in domains:
            continue
        if getattr(entry, "disabled_by", None) or getattr(entry, "hidden_by", None):
            continue
        if config_entry and str(getattr(entry, "config_entry_id", "") or "") != config_entry:
            continue
        if area_ids and _entry_area_id(entry, device_reg) not in area_ids:
            continue
        if label_ids and not (set(getattr(entry, "labels", None) or ()) & label_ids):
            continue
        if device_class and _device_class(hass, entity_id, entry) != device_class:
            continue
        if translation_key and str(getattr(entry, "translation_key", "") or "") != translation_key:
            continue
        found[entity_id] = _entity_item(hass, entity_id, entry)

    # YAML scenes/scripts live only in states. Widen only when no registry-only
    # filter (area, label, config entry) is active.
    # A translation key is registry-only too: a state carries none.
    if not area_ids and not label_ids and not config_entry and not translation_key:
        for state in _all_states(hass):
            entity_id = str(getattr(state, "entity_id", "") or "")
            if not entity_id or entity_id in found:
                continue
            if domains and _domain_of(entity_id) not in domains:
                continue
            if device_class and _device_class(hass, entity_id, None) != device_class:
                continue
            found[entity_id] = _entity_item(hass, entity_id, None)

    items = sorted(found.values(), key=lambda it: (it.title.casefold(), it.identity))
    return items[:max_items]


def _device_class(hass: HomeAssistant, entity_id: str, entry) -> str:
    """What kind of value *entity_id* reports: the user's choice, then the
    integration's, then whatever its state says."""
    value = (
        (getattr(entry, "device_class", None) if entry is not None else None)
        or (getattr(entry, "original_device_class", None) if entry is not None else None)
    )
    if not value:
        try:
            state = hass.states.get(entity_id)
        except Exception:  # pragma: no cover - state machine unavailable
            state = None
        attrs = getattr(state, "attributes", None) if state is not None else None
        value = attrs.get("device_class") if isinstance(attrs, dict) else None
    return str(value or "").strip().lower()


def _all_states(hass: HomeAssistant) -> list[Any]:
    try:
        return list(hass.states.async_all() or [])
    except Exception:  # pragma: no cover - state machine unavailable
        return []


def _fixed_domain_resolver(domain: str):
    async def _resolve(
        hass: HomeAssistant,
        spec: dict[str, Any],
        max_items: int = DEFAULT_MAX_ITEMS,
    ) -> list[DynamicItem]:
        merged = dict(spec or {})
        merged["domain"] = domain
        return await resolve_entities(hass, merged, max_items)

    _resolve.__name__ = f"resolve_{domain}s"
    return _resolve


resolve_scenes = _fixed_domain_resolver("scene")
resolve_scripts = _fixed_domain_resolver("script")


def _spec_wants_entity(hass: HomeAssistant, spec: dict[str, Any], entity_id: str) -> bool:
    """Whether *entity_id* could appear in *spec*'s result set.

    Conservative both ways: a false positive costs one resolve, while a false
    negative leaves a stale button until the next generic trigger. Domain is
    checked before registry-backed filters.
    """
    domains = _wanted_domains(spec)
    if domains and _domain_of(entity_id) not in domains:
        return False

    area = str(spec.get("area") or "").strip()
    label = str(spec.get("label") or "").strip()
    config_entry = str(spec.get("config_entry") or "").strip()
    if not area and not label and not config_entry:
        return True

    try:
        entity_reg, area_reg, device_reg, label_reg = _registries(hass)
        entry = entity_reg.async_get(entity_id)
    except Exception:  # noqa: BLE001 - a filter must never break the event loop
        return True

    # Removed or state-only entries may still matter.
    if entry is None:
        return True

    if config_entry and str(getattr(entry, "config_entry_id", "") or "") != config_entry:
        return False
    if area:
        if _entry_area_id(entry, device_reg) not in _match_area_ids(area_reg, area):
            return False
    if label:
        wanted = _match_label_ids(label_reg, label)
        if not (set(getattr(entry, "labels", None) or ()) & wanted):
            return False
    return True


def registry_subscriber(pinned_domain: str = ""):
    """A registry hook for a source whose resolver pins the domain.

    ``scenes`` and ``scripts`` store no ``domain`` key, so filtering must add
    the same pin the resolver adds or every entity would look relevant.
    """

    def _subscribe(hass: HomeAssistant, specs, on_change) -> Any | None:
        pinned = []
        for spec in specs:
            spec = dict(spec)
            spec["domain"] = pinned_domain
            pinned.append(spec)
        return subscribe_entity_registry(hass, pinned, on_change)

    _subscribe.__name__ = f"subscribe_{pinned_domain}_registry"
    return _subscribe


def subscribe_entity_registry(hass: HomeAssistant, specs, on_change) -> Any | None:
    """Fire when a registry change could alter a listed item.

    Registry events are filtered before debounce because every integration's
    entities may fire on restart. YAML scenes/scripts never enter the registry,
    so edits to them still rely on navigation/reconnect triggers.
    """
    from homeassistant.helpers.entity_registry import EVENT_ENTITY_REGISTRY_UPDATED

    specs = list(specs)
    if not specs:
        return None

    def _on_registry_event(event: Any) -> None:
        data = getattr(event, "data", None) or {}
        entity_id = str(data.get("entity_id") or "")
        if not entity_id:
            return
        # "update" carries the changed keys; a move that touched neither the
        # name, the icon nor the area cannot change what we render.
        if data.get("action") == "update":
            changed = data.get("changes") or {}
            if isinstance(changed, dict) and changed and not (
                changed.keys() & {"name", "original_name", "icon", "original_icon",
                                  "area_id", "labels", "entity_id", "disabled_by",
                                  "hidden_by"}
            ):
                return
        if not any(_spec_wants_entity(hass, spec, entity_id) for spec in specs):
            return
        _LOGGER.debug(
            "Entity registry change for %s matches a binding; scheduling refresh",
            entity_id,
        )
        on_change()

    _LOGGER.debug("Watching the entity registry for %d bound spec(s)", len(specs))
    return hass.bus.async_listen(EVENT_ENTITY_REGISTRY_UPDATED, _on_registry_event)
