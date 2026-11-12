"""A device for a page that was not made from a template.

A template page is bound to a device: ``${_device…}`` reads it, and **Change
device…** moves the page to another one. A page built by hand had no such
binding. ``assign_page_device`` gives it one -- ``template: {target: …}``
without a ``type``, since no template made it -- and on a page that already has
one, moves it as **Change device…** moves a template page.
"""
from __future__ import annotations

import logging
from collections import Counter
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from ...runtime import get_store, resolve_device_id
from ...shared.logs import device_id_logger
from ..const import PAGE_ID_SCHEMA
from ..device_entities import _resolve_device_domain_entities
from ..events import fire_config_changed
from ..listeners import refresh_state_listener, schedule_push_rescan
from .common import requires_device, send_failure
from ..template_targets import device_entry_ids, eligible_devices, entry_domains
from .templates import (
    _referenced_entities,
    _reference_pattern,
    _retarget_mapping,
    _rewrite_assignments,
)
from ..access import require_device_access

_LOGGER = logging.getLogger(__name__)

#: Which of a device's entities is "the" device, most telling first: a page
#: bound to a TV is about its media player, not its power switch.
_PRIMARY_DOMAINS = (
    "media_player", "remote", "climate", "light", "cover", "fan", "vacuum",
    "humidifier", "water_heater", "lock", "lawn_mower", "valve", "switch",
    "camera", "select", "number", "button", "sensor", "binary_sensor",
)


def _owner_integration(hass: HomeAssistant, device: Any) -> str | None:
    """The integration that set *device* up."""
    domains = entry_domains(hass)
    for entry_id in sorted(device_entry_ids(device)):
        if entry_id in domains:
            return domains[entry_id]
    return None


def _primary_entity(domain_entities: dict[str, str]) -> str:
    for domain in _PRIMARY_DOMAINS:
        if domain in domain_entities:
            return domain_entities[domain]
    return domain_entities[sorted(domain_entities)[0]] if domain_entities else ""


def _device_entities(hass: HomeAssistant, device_id: str) -> tuple[Any, str | None, dict[str, str]]:
    """``(device, owning integration, {domain: entity})`` for *device_id*."""
    device = dr.async_get(hass).async_get(device_id) if device_id else None
    if device is None:
        return None, None, {}
    integration = _owner_integration(hass, device)
    return device, integration, _resolve_device_domain_entities(hass, device_id, integration)


def _page_of(pages: list, page_id: int) -> dict | None:
    return next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)


def suggest_device(hass: HomeAssistant, assignments: dict) -> str:
    """The device most of the page's buttons act on, "" when none does.

    Counted per button rather than per reference, so one button naming a device
    five times does not outvote four buttons naming another once each. A tie
    goes to the device met first, in button order.
    """
    from homeassistant.helpers import entity_registry as er

    ent_reg = er.async_get(hass)
    counts: Counter[str] = Counter()
    order: dict[str, int] = {}
    for key in sorted(assignments or {}):
        btn = assignments[key]
        if not isinstance(btn, dict):
            continue
        devices = set()
        for entity_id in _referenced_entities(btn, set()):
            entry = ent_reg.async_get(entity_id)
            if entry is not None and entry.device_id:
                devices.add(entry.device_id)
        for device in sorted(devices):
            counts[device] += 1
            order.setdefault(device, len(order))
    if not counts:
        return ""
    return max(counts, key=lambda d: (counts[d], -order[d]))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_all_devices",
    # Required, not optional: the reply is the whole device registry, and the
    # guard above lets a message naming no remote through.
    vol.Required("entry_id"): str,
    vol.Optional("page_id"): PAGE_ID_SCHEMA,
})
@require_device_access
@websocket_api.async_response
async def ws_list_all_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """Every enabled device with entities, for binding a page that has none.

    Given the page, ``suggested`` is the device most of its buttons act on.
    """
    suggested = ""
    device_id = resolve_device_id(hass, msg["entry_id"])
    if device_id and msg.get("page_id") is not None:
        assignments = await get_store(hass).async_get_assignments(device_id, msg["page_id"]) or {}
        suggested = suggest_device(hass, assignments)
    devices = eligible_devices(hass, {})
    if suggested not in {d["id"] for d in devices}:
        suggested = ""
    connection.send_result(msg["id"], {"devices": devices, "suggested": suggested})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/assign_page_device",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Required("target_device"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_assign_page_device(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Bind a page that no template made to a device, or move it to another.

    Moving rewrites the buttons' references to the old device's entities, domain
    by domain, as moving a template page does; buttons aimed elsewhere stay.

    Response:
      {success: true, pages, buttons_changed: n}
    """
    entry_id = msg["entry_id"]
    page_id = msg["page_id"]
    store = get_store(hass)
    pages = await store.async_get_pages(device_id)
    page = _page_of(pages, page_id)
    if page is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {page_id} not found")
        return
    page_template = page.get("template") if isinstance(page.get("template"), dict) else {}
    if page_template.get("type"):
        connection.send_error(
            msg["id"], "template_page",
            f"Page {page_id} was made from a template; change its device there",
        )
        return

    device, _integration, domain_entities = _device_entities(hass, msg["target_device"])
    if device is None:
        connection.send_error(msg["id"], "not_found", f"Device '{msg['target_device']}' not found")
        return
    if not domain_entities:
        connection.send_error(msg["id"], "not_found", f"Device '{msg['target_device']}' has no usable entities")
        return
    new_target = {"entity_id": _primary_entity(domain_entities), "device": msg["target_device"]}

    old_target = dict(page_template.get("target") or {})
    buttons_changed = 0
    if old_target.get("device") and old_target.get("device") != new_target["device"]:
        _old, _old_integration, old_domain_entities = _device_entities(hass, old_target["device"])
        assignments = await store.async_get_assignments(device_id, page_id) or {}
        mapping = _retarget_mapping(
            hass, old_target, new_target, old_domain_entities, domain_entities,
            _referenced_entities(assignments, set()),
        )
        if mapping:
            rewritten = _rewrite_assignments(assignments, _reference_pattern(mapping), mapping)
            buttons_changed = sum(1 for key in rewritten if rewritten[key] != assignments.get(key))

    page["template"] = {**page_template, "target": new_target}
    try:
        if buttons_changed:
            await store.async_set_assignments(device_id, page_id, rewritten)
        await store.async_set_pages(device_id, pages)
    except Exception as err:  # noqa: BLE001
        send_failure(
            hass, connection, msg, "save_failed", err, logger=_LOGGER, what="Binding the page to a device",
        )
        return

    device_id_logger(_LOGGER, hass, device_id).info(
        "Bound page %s to device %s (was %s): %d button(s) changed",
        page_id, new_target, old_target or "none", buttons_changed,
    )
    # Answered before the rest: rebuilding the remote's state listener reads
    # every page and took seconds, all of which the dialog sat waiting for.
    connection.send_result(msg["id"], {
        "success": True,
        "pages": await store.async_get_pages(device_id),
        "buttons_changed": buttons_changed,
    })
    fire_config_changed(hass, entry_id)
    schedule_push_rescan(hass, entry_id)
    await refresh_state_listener(hass, entry_id)
