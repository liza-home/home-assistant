"""Layouts: generating a page for a device or integration, and retargeting it.

A layout (``layouts/presets``) describes a page for one kind of device. Adding
it to a remote resolves it against a real device; retargeting rewrites an
existing layout page to point at a different one.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from ...runtime import _get_store
from ...shared.assignment import ASSIGNMENT_LONGTOUCH_KEY, ASSIGNMENT_DYNAMIC_KEY
from ..blueprint import async_get_blueprint
from ..const import PAGE_ID_SCHEMA, generate_page_id
from ..device_entities import _resolve_device_domain_entities
from ..events import fire_config_changed
from ..layouts import (
    list_layouts,
    load_layout,
    resolve_layout_variables,
    generate_assignments as layout_generate_assignments,
    refresh as layout_refresh,
)
from .common import (
    EMPTY_BUTTON,
    refresh_state_listener,
    requires_device,
    reserved_page_ids,
    schedule_push_rescan,
)

_LOGGER = logging.getLogger(__name__)


def _schedule_page_refresh(hass: HomeAssistant, entry_id: str, page_id: int) -> None:
    """Re-read one page's dynamic buttons in the background.

    Browsing a media source can take seconds; the editor should not wait for
    it. Guarded like ``common.schedule_push_rescan``, for the same reason.
    """
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        return

    async def _refresh() -> None:
        try:
            await layout_refresh.async_refresh_and_sync(hass, entry_id, page_id=page_id)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Dynamic refresh of page %s failed: %s", page_id, err)

    try:
        create_task(_refresh())
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not schedule page refresh: %s", err)


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/list_layouts"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_layouts(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return layout metadata: {id, name, icon, description, target_selector}."""
    layouts = await hass.async_add_executor_job(list_layouts)
    connection.send_result(msg["id"], {"layouts": layouts})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_layout_devices",
    vol.Required("layout_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_layout_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """List devices matching a layout's integration and primary domain.

    Server-side filtering keeps the panel from reimplementing device/entity
    registry joins and guarantees the later add-page validation matches it.
    """
    from homeassistant.helpers import device_registry as dr
    from homeassistant.helpers import entity_registry as er

    layout_id = msg["layout_id"]
    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "not_found", f"Layout '{layout_id}' not found")
        return

    device_sel = (layout.get("target_selector") or {}).get("device") or {}
    if not device_sel:
        connection.send_error(
            msg["id"], "invalid_layout", f"Layout '{layout_id}' does not target a device"
        )
        return

    integration = device_sel.get("integration")
    primary_domain = device_sel.get("primary_domain")

    entry_ids = {e.entry_id for e in hass.config_entries.async_entries(integration)} if integration else None

    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    devices = []
    for device in dev_reg.devices:
        if device.disabled_by is not None:
            continue
        # `config_entries`, not `config_entry_id`: these are other integrations'
        # devices. A device restored from before HA 2026.8 can still report
        # several entries, and HA deliberately exempts those from the
        # deprecation. Narrowing to one id would hide such a device from the
        # picker.
        if entry_ids is not None and not (device.config_entries & entry_ids):
            continue
        domain_entities = _resolve_device_domain_entities(hass, device.id, integration, ent_reg)
        if primary_domain and primary_domain not in domain_entities:
            continue
        devices.append({
            "id": device.id,
            "name": device.name_by_user or device.name or device.id,
            "domains": sorted(domain_entities),
        })

    devices.sort(key=lambda d: d["name"].lower())
    connection.send_result(msg["id"], {"devices": devices})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_layout_config_entries",
    vol.Required("layout_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_layout_config_entries(hass: HomeAssistant, connection, msg: dict) -> None:
    """List config entries for layouts bound to an integration instance.

    The Hue layout binds to a bridge/config entry, not one lamp; the page is
    populated from everything that entry owns.
    """
    layout_id = msg["layout_id"]
    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "not_found", f"Layout '{layout_id}' not found")
        return

    entry_sel = (layout.get("target_selector") or {}).get("config_entry") or {}
    if not entry_sel:
        connection.send_error(
            msg["id"],
            "invalid_layout",
            f"Layout '{layout_id}' does not target a config entry",
        )
        return

    integration = entry_sel.get("integration")
    entries = [
        {"id": entry.entry_id, "title": entry.title or entry.entry_id}
        for entry in hass.config_entries.async_entries(integration)
        if not entry.disabled_by
    ]
    entries.sort(key=lambda e: e["title"].lower())
    connection.send_result(msg["id"], {"entries": entries})


def _resolve_layout_target(
    hass: HomeAssistant,
    layout_id: str,
    layout: dict,
    target_device: str,
    target_config_entry: str,
) -> tuple[tuple[str, str] | None, str, dict[str, str]]:
    """Check a device or config entry against a layout's target selector.

    Shared by adding a layout page and by moving one to another device, so both
    accept exactly the same targets.

    Returns ``(error, target_entity, domain_entities)``; ``error`` is a
    ``(code, message)`` pair, or ``None`` when the target fits.
    """
    selector = layout.get("target_selector") or {}
    device_sel = selector.get("device") or {}
    entry_sel = selector.get("config_entry") or {}

    domain_entities: dict[str, str] = {}
    target_entity = ""

    if entry_sel:
        if not target_config_entry:
            return ("invalid_target", f"Layout '{layout_id}' needs a config entry to bind to"), "", {}
        integration = entry_sel.get("integration")
        target_entry = hass.config_entries.async_get_entry(target_config_entry)
        if target_entry is None or (integration and target_entry.domain != integration):
            return ("not_found", f"Config entry '{target_config_entry}' does not belong to "
                f"integration '{integration}' required by layout '{layout_id}'"), "", {}
        # Disabled entries own no live entities, so dynamic pages would stay empty.
        # Worded operation-neutral: this check also runs when retargeting an
        # existing page, where "before adding a page" was simply wrong.
        if target_entry.disabled_by:
            return ("invalid_target", f"Config entry '{target_config_entry}' is disabled; "
                f"enable it before using it for a '{layout_id}' page"), "", {}
    elif device_sel:
        if not target_device:
            return ("invalid_target", f"Layout '{layout_id}' needs a device to bind to"), "", {}
        # Device layouts need same-device sibling entities by service domain; an
        # entity selector cannot express androidtv_remote remote.* plus
        # media_player.* app-launch buttons.
        integration = device_sel.get("integration")
        # Match the picker: require the layout's integration, not just a domain.
        if integration:
            device = dr.async_get(hass).async_get(target_device)
            entry_ids = {
                e.entry_id for e in hass.config_entries.async_entries(integration)
            }
            # Deliberately the `config_entries` set — see the device picker
            # above. This must accept the same devices the picker offered.
            if not device or not (device.config_entries & entry_ids):
                return ("not_found", f"Device '{target_device}' does not belong to integration "
                    f"'{integration}' required by layout '{layout_id}'"), "", {}

        domain_entities = _resolve_device_domain_entities(
            hass, target_device, integration
        )
        if not domain_entities:
            return ("not_found", f"Device '{target_device}' has no usable entities"), "", {}
        primary_domain = device_sel.get("primary_domain")
        target_entity = domain_entities.get(primary_domain) if primary_domain else ""
        if not target_entity:
            return ("not_found", f"Device '{target_device}' has no '{primary_domain}' entity required by layout '{layout_id}'"), "", {}
    else:
        return ("invalid_layout", f"Layout '{layout_id}' declares no device or config entry selector"), "", {}

    return None, target_entity, domain_entities


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/add_layout_page",
    vol.Required("entry_id"): str,
    vol.Required("layout_id"): str,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_add_layout_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Create a page from a layout, bound to a device or config entry target.

    Config-entry layouts have no primary entity; their grids come from dynamic
    sources filtered to that entry.

    Response payload:
      {success: true, page_id, pages}
    """
    entry_id = msg["entry_id"]
    layout_id = msg["layout_id"]
    target_device = msg.get("target_device") or ""
    target_config_entry = msg.get("target_config_entry") or ""


    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "layout_error", f"Layout '{layout_id}' not found")
        return

    error, target_entity, domain_entities = _resolve_layout_target(
        hass, layout_id, layout, target_device, target_config_entry,
    )
    if error:
        connection.send_error(msg["id"], *error)
        return

    layout = await resolve_layout_variables(
        hass, layout, target_entity, domain_entities or None, target_config_entry,
    )

    # Layout generation is the only place target-specific variables become
    # stored action-library entries and button assignments.
    new_actions, assignments = layout_generate_assignments(
        layout_id, target_entity, layout, domain_entities or None, hass
    )

    if not assignments:
        connection.send_error(msg["id"], "layout_error", f"Layout '{layout_id}' produced no assignments")
        return

    store = _get_store(hass)

    existing_lib = await store.async_get_action_library(device_id)
    existing_by_id = {a["id"]: i for i, a in enumerate(existing_lib) if "id" in a}
    for action in new_actions:
        if action["id"] in existing_by_id:
            existing_lib[existing_by_id[action["id"]]] = action
        else:
            existing_lib.append(action)
    await store.async_set_action_library(device_id, existing_lib)

    layout_meta = None
    all_layouts = await hass.async_add_executor_job(list_layouts)
    for lt in all_layouts:
        if lt["id"] == layout_id:
            layout_meta = lt
            break

    # `page_image` may hold `${…}` variables, which the picker cannot draw, so
    # it is kept apart from the `icon` the picker shows.
    page_icon = (
        (layout_meta.get("page_image") or layout_meta["icon"])
        if layout_meta else "mdi:remote"
    )

    pages = await store.async_get_pages(device_id)
    existing_ids = {p["id"] for p in pages if isinstance(p, dict)}
    new_page_id = generate_page_id(
        await reserved_page_ids(store, device_id, existing_ids)
    )

    new_page = {
        "id": new_page_id,
        "image": page_icon,
        "hash": 0,
        "layout": {
            "type": layout_id,
            "target": {
                "entity_id": target_entity,
                **({"device": target_device} if target_device else {}),
                **(
                    {"config_entry": target_config_entry}
                    if target_config_entry else {}
                ),
            },
        },
    }
    pages.append(new_page)
    await store.async_set_pages(device_id, pages)

    bp = await async_get_blueprint(hass, msg["entry_id"])
    all_keys = [btn["key"] for btn in bp.get("buttons", [])]
    for key in all_keys:
        if key not in assignments:
            assignments[key] = dict(EMPTY_BUTTON)

    await store.async_set_assignments(device_id, new_page_id, assignments)
    await store.async_recompute_page_hash(device_id, new_page_id)

    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    # Re-scan after writes so new dynamic bindings get push subscriptions; the
    # scanner re-reads stored pages.
    schedule_push_rescan(hass, entry_id)

    pages = await store.async_get_pages(device_id)

    _LOGGER.info(
        "Added layout page '%s' (layout=%s, target=%s) for device %s",
        new_page_id, layout_id, target_entity, device_id,
    )

    # Do not navigate here; the panel sends goto_page for every page-creation path.
    connection.send_result(msg["id"], {
        "success": True,
        "page_id": new_page_id,
        "pages": pages,
    })


#: Keys under which a stored button names the entity it acts on. Only values
#: found here are candidates for the dead-reference fallback below: a bare
#: `domain.name` string elsewhere is as likely a service (`light.toggle`).
_ENTITY_REFERENCE_KEYS: Final = frozenset({"entity_id", "entity", "target_entity"})


def _referenced_entities(value: Any, out: set[str]) -> set[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _ENTITY_REFERENCE_KEYS:
                for eid in item if isinstance(item, list) else [item]:
                    if isinstance(eid, str) and "." in eid:
                        out.add(eid)
            _referenced_entities(item, out)
    elif isinstance(value, list):
        for item in value:
            _referenced_entities(item, out)
    return out


def _rewrite_references(value: Any, pattern: re.Pattern, mapping: dict[str, str]) -> Any:
    """Return ``value`` with every whole-token reference in ``mapping`` swapped.

    Whole tokens, so `media_player.tv` does not rewrite `media_player.tv_2`
    and `select.tv` does not rewrite `input_select.tv`; inside strings too, so
    a template's `states('media_player.tv')` follows. Keys are left alone: a
    button's dicts are keyed by button, state or field, never by entity.
    """
    if isinstance(value, str):
        return pattern.sub(lambda m: mapping[m.group(0)], value)
    if isinstance(value, dict):
        return {k: _rewrite_references(v, pattern, mapping) for k, v in value.items()}
    if isinstance(value, list):
        return [_rewrite_references(v, pattern, mapping) for v in value]
    return value


#: Button fields that can actually name an entity to act on. Everything else
#: on a button -- `label`, `label_edited`, `action_id`, `state_icons`,
#: `internal_target_name` -- is presentation or identity metadata the user
#: wrote or that merely echoes it; it is left alone even when it happens to
#: contain an old entity id as plain text, because retargeting must not
#: rewrite what the user authored (only what the page itself depends on).
_ENTITY_BEARING_BUTTON_KEYS: Final = frozenset(
    {"config", ASSIGNMENT_LONGTOUCH_KEY, "overrides", "slider_actions", ASSIGNMENT_DYNAMIC_KEY}
)


def _rewrite_assignments(
    assignments: dict, pattern: re.Pattern, mapping: dict[str, str]
) -> dict:
    """Swap entity references inside stored button assignments.

    Walks only the entity-bearing fields of each button (see
    ``_ENTITY_BEARING_BUTTON_KEYS``); every other field is copied through
    unchanged.
    """
    result = {}
    for btn_key, btn_val in assignments.items():
        if not isinstance(btn_val, dict):
            result[btn_key] = btn_val
            continue
        new_btn = dict(btn_val)
        for field in _ENTITY_BEARING_BUTTON_KEYS:
            if field in new_btn:
                new_btn[field] = _rewrite_references(new_btn[field], pattern, mapping)
        result[btn_key] = new_btn
    return result


def _retarget_mapping(
    hass: HomeAssistant,
    old_target: dict,
    new_target: dict,
    old_domain_entities: dict[str, str],
    new_domain_entities: dict[str, str],
    referenced: set[str],
) -> dict[str, str]:
    """Which old references become which new ones.

    The old device's entities map to the new device's entity of the same
    domain. The old device may be gone -- often the reason it is being
    replaced -- and its entities with it, so an entity a button names that no
    longer exists at all also maps by domain. An entity that still exists and
    is not the old device's is the user's own addition, and is left alone.
    """
    mapping: dict[str, str] = {}
    for domain, old in old_domain_entities.items():
        new = new_domain_entities.get(domain)
        if new:
            mapping[old] = new
    old_entity = old_target.get("entity_id") or ""
    new_entity = new_target.get("entity_id") or ""
    if old_entity and new_entity:
        mapping[old_entity] = new_entity

    from homeassistant.helpers import entity_registry as er

    ent_reg = er.async_get(hass)
    for eid in referenced:
        if eid in mapping:
            continue
        if hass.states.get(eid) is not None or ent_reg.async_get(eid) is not None:
            continue
        new = new_domain_entities.get(eid.split(".", 1)[0])
        if new:
            mapping[eid] = new

    old_entry = old_target.get("config_entry") or ""
    new_entry = new_target.get("config_entry") or ""
    if old_entry and new_entry:
        mapping[old_entry] = new_entry
    old_device = old_target.get("device") or ""
    new_device = new_target.get("device") or ""
    if old_device and new_device:
        mapping[old_device] = new_device
    return {old: new for old, new in mapping.items() if old != new}


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/retarget_layout_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_retarget_layout_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Point a layout page at another device (or hub), keeping its buttons.

    The page is not regenerated: buttons the user changed stay changed. Only
    references to the old target are swapped for the new one's, domain by
    domain. What the new device lacks keeps pointing where it did.

    Response:
      {success: true, pages, replaced: {old: new}, buttons_changed: n}
    """
    entry_id = msg["entry_id"]
    page_id = msg["page_id"]
    target_device = msg.get("target_device") or ""
    target_config_entry = msg.get("target_config_entry") or ""

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    page = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)
    if page is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {page_id} not found")
        return
    page_layout = page.get("layout") if isinstance(page.get("layout"), dict) else {}
    layout_id = page_layout.get("type") or ""
    if not layout_id:
        connection.send_error(msg["id"], "not_a_layout_page", f"Page {page_id} was not made from a layout")
        return

    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "layout_error", f"Layout '{layout_id}' not found")
        return

    error, target_entity, new_domain_entities = _resolve_layout_target(
        hass, layout_id, layout, target_device, target_config_entry,
    )
    if error:
        connection.send_error(msg["id"], *error)
        return

    old_target = dict(page_layout.get("target") or {})
    new_target = {
        "entity_id": target_entity,
        **({"device": target_device} if target_device else {}),
        **({"config_entry": target_config_entry} if target_config_entry else {}),
    }
    integration = ((layout.get("target_selector") or {}).get("device") or {}).get("integration")
    old_device = old_target.get("device") or ""
    old_domain_entities = (
        _resolve_device_domain_entities(hass, old_device, integration) if old_device else {}
    )

    assignments = await store.async_get_assignments(device_id, page_id)
    buttons_changed = 0
    mapping = _retarget_mapping(
        hass, old_target, new_target, old_domain_entities, new_domain_entities,
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

    page["layout"] = {**page_layout, "target": new_target}
    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, page_id)

    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    schedule_push_rescan(hass, entry_id)
    # Dynamic buttons list what the *new* device offers -- its apps, its
    # inputs -- and only a refresh reads that.
    _schedule_page_refresh(hass, entry_id, page_id)

    _LOGGER.info(
        "Moved layout page %s (%s) from %s to %s: %d button(s) changed",
        page_id, layout_id, old_target, new_target, buttons_changed,
    )
    connection.send_result(msg["id"], {
        "success": True,
        "pages": await store.async_get_pages(device_id),
        "replaced": mapping,
        "buttons_changed": buttons_changed,
    })
