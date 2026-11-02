"""A device for a page that was not made from a template, and a page saved as a template.

A template page is bound to a device: ``${_device…}`` reads it, and **Change
device…** moves the page to another one. A page built by hand had no such
binding. ``assign_page_device`` gives it one -- ``template: {target: …}``
without a ``type``, since no template made it -- and on a page that already has
one, moves it as **Change device…** moves a template page.

``save_page_as_template`` writes a bound page into the user's own template
folder (``<config>/lizaip/templates``), so it can be added again for any
similar device: the bound device's entities become placeholders, and the
device is asked for when the template is added.
"""
from __future__ import annotations

import logging
import os
import re
from collections import Counter
from copy import deepcopy
from typing import Any

import voluptuous as vol
import yaml
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from ...runtime import _get_store, _resolve_device_id
from ...shared.assignment import (
    ASSIGNMENT_DYNAMIC_KEY,
    ASSIGNMENT_LABEL_EDITED_KEY,
)
from ...shared.logs import device_id_logger
from ..const import PAGE_ID_SCHEMA
from ..device_entities import _resolve_device_domain_entities
from ..events import fire_config_changed
from ..internal_commands import get_internal_command
from ...config.page_templates import forget_template, list_templates, user_templates_dir
from .common import refresh_state_listener, requires_device, schedule_push_rescan
from .templates import (
    _device_entry_ids,
    _eligible_devices,
    _entry_domains,
    _referenced_entities,
    _retarget_mapping,
    _rewrite_assignments,
)

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
    domains = _entry_domains(hass)
    for entry_id in sorted(_device_entry_ids(device)):
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
    vol.Optional("entry_id"): str,
    vol.Optional("page_id"): PAGE_ID_SCHEMA,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_all_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """Every enabled device with entities, for binding a page that has none.

    Given the page, ``suggested`` is the device most of its buttons act on.
    """
    suggested = ""
    device_id = _resolve_device_id(hass, msg["entry_id"]) if msg.get("entry_id") else None
    if device_id and msg.get("page_id") is not None:
        assignments = await _get_store(hass).async_get_assignments(device_id, msg["page_id"]) or {}
        suggested = suggest_device(hass, assignments)
    devices = _eligible_devices(hass, {})
    if suggested not in {d["id"] for d in devices}:
        suggested = ""
    connection.send_result(msg["id"], {"devices": devices, "suggested": suggested})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/assign_page_device",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Required("target_device"): str,
})
@websocket_api.require_admin
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
    store = _get_store(hass)
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
            pattern = re.compile(
                r"(?<![A-Za-z0-9_])("
                + "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
                + r")(?![A-Za-z0-9_])"
            )
            rewritten = _rewrite_assignments(assignments, pattern, mapping)
            buttons_changed = sum(1 for key in rewritten if rewritten[key] != assignments.get(key))
            if buttons_changed:
                await store.async_set_assignments(device_id, page_id, rewritten)

    page["template"] = {**page_template, "target": new_target}
    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, page_id)

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


# ── Saving a page as a template ────────────────────────────────────────────

#: What a stored button carries that says nothing in a template: its library
#: id is minted when the page is made, a source binding belongs to this page,
#: and who wrote the label is this page's history.
_PAGE_ONLY_KEYS = ("action_id", ASSIGNMENT_DYNAMIC_KEY, ASSIGNMENT_LABEL_EDITED_KEY, "image_pinned")


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "page"


def _replace_strings(value: Any, fn) -> Any:
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, dict):
        return {k: _replace_strings(v, fn) for k, v in value.items()}
    if isinstance(value, list):
        return [_replace_strings(v, fn) for v in value]
    return value


def _template_text(primary: str):
    """Spell the bound entity as a template does: ``${_device.x}`` in text, ``@target`` as an id."""
    attribute = re.compile(r"(?<![\w.])" + re.escape(primary) + r"\.(?=[A-Za-z_])")
    whole = re.compile(r"(?<![\w.])" + re.escape(primary) + r"(?![\w.])")

    def convert(text: str) -> str:
        return whole.sub("@target", attribute.sub("_device.", text))

    return convert


def _template_button(btn: dict, primary: str, domain_entities: dict[str, str]) -> dict | None:
    """One stored button as a template writes it, or None if it says nothing there."""
    button = deepcopy(btn)
    for key in _PAGE_ONLY_KEYS:
        button.pop(key, None)
    config = button.get("config")
    step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}
    service = step.get("action") or step.get("service") or ""
    if isinstance(service, str) and get_internal_command(service) is not None:
        # A page link names a page id of this remote; on another it is nothing.
        return None
    if not step and not button.get("label") and not button.get("image"):
        return None
    # A step aimed at the device's own entity for its service's domain needs no
    # target: the template derives exactly that one for the device it is added
    # for. Only the first step is derived; anything else is written out below.
    target = step.get("target") if isinstance(step.get("target"), dict) else None
    entity = target.get("entity_id") if target else None
    domain = service.split(".", 1)[0] if isinstance(service, str) and "." in service else ""
    if (
        isinstance(entity, str) and entity != primary
        and domain and domain_entities.get(domain) == entity
        and set(target) == {"entity_id"}
    ):
        step.pop("target")
    return _replace_strings(button, _template_text(primary))


def build_page_template(
    name: str, page: dict, assignments: dict, primary: str,
    integration: str | None, domain_entities: dict[str, str],
) -> dict:
    """The template a bound page becomes: its title, its buttons, its kind of device."""
    image = str(page.get("image") or "").strip()
    first = image.split()[0] if image else ""
    selector: dict[str, Any] = {"primary_domain": primary.split(".", 1)[0]}
    if integration:
        selector = {"integration": integration, **selector}
    buttons = {}
    for key in sorted(assignments):
        btn = assignments[key]
        if isinstance(btn, dict):
            converted = _template_button(btn, primary, domain_entities)
            if converted is not None:
                buttons[key] = converted
    template: dict[str, Any] = {
        "name": name,
        "icon": first if first.startswith(("mdi:", "logo:")) else "mdi:remote",
        "description": f"Saved from the page {name!r}",
        "target_selector": {"device": selector},
    }
    if image:
        template["page_image"] = _template_text(primary)(image)
    template["buttons"] = buttons
    return template


def _write_template(directory: str, template_id: str, template: dict) -> str:
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{template_id}.yaml")
    header = (
        f"# {template['name']} — saved from a lizaIP page.\n"
        "# Edit freely; it is read again when added. The device is asked for\n"
        "# when a page is made from it: `@target` is that device's entity.\n\n"
    )
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(header)
        yaml.safe_dump(template, fh, sort_keys=False, allow_unicode=True)
    return path


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/save_page_as_template",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Required("name"): vol.All(str, vol.Length(min=1, max=80)),
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_save_page_as_template(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Write a page bound to a device into the user's templates.

    Response:
      {success: true, template_id, path, buttons: n}
    """
    directory = user_templates_dir()
    if not directory:
        connection.send_error(msg["id"], "not_ready", "The user template folder is not set up")
        return
    store = _get_store(hass)
    page = _page_of(await store.async_get_pages(device_id), msg["page_id"])
    if page is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {msg['page_id']} not found")
        return
    page_template = page.get("template") if isinstance(page.get("template"), dict) else {}
    target = page_template.get("target") or {}
    if not target.get("device"):
        connection.send_error(msg["id"], "no_device", f"Page {msg['page_id']} has no device to make a template for")
        return
    _device, integration, domain_entities = _device_entities(hass, target["device"])
    primary = target.get("entity_id") or _primary_entity(domain_entities)
    if not primary:
        connection.send_error(msg["id"], "not_found", "The page's device has no usable entities")
        return

    name = msg["name"].strip()
    assignments = await store.async_get_assignments(device_id, msg["page_id"]) or {}
    template = build_page_template(name, page, assignments, primary, integration, domain_entities)

    taken = {t["id"] for t in await hass.async_add_executor_job(list_templates)}
    template_id, n = _slug(name), 2
    while template_id in taken:
        template_id = f"{_slug(name)}-{n}"
        n += 1
    try:
        path = await hass.async_add_executor_job(_write_template, directory, template_id, template)
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", f"Could not write the template: {err}")
        return
    forget_template(template_id)

    device_id_logger(_LOGGER, hass, device_id).info(
        "Saved page %s as template %s (%s)", msg["page_id"], template_id, path,
    )
    connection.send_result(msg["id"], {
        "success": True, "template_id": template_id, "path": path,
        "buttons": len(template["buttons"]),
    })
