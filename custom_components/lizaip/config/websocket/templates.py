"""Templates: generating a page for a device or integration, and retargeting it.

A template (``assets/templates``) describes a page for one kind of device. Adding
it to a remote resolves it against a real device; retargeting rewrites an
existing template page to point at a different one.

Only the handlers live here. Making the pages is ``config.template_pages``,
which the LLM tools share.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from ...runtime import get_store
from ...shared.assignment import ASSIGNMENT_LONGTOUCH_KEY, ASSIGNMENT_DYNAMIC_KEY
from ...shared.logs import device_id_logger
from ..const import PAGE_ID_SCHEMA
from ..device_entities import _resolve_device_domain_entities
from ..events import fire_config_changed
from ...config.page_templates.catalog import favorites_kind
from ...config.page_templates.sources import FAVORITE_CATEGORIES, favorite_kinds
from ...config.page_templates import (
    list_templates,
    load_template,
)
from ..template_targets import (
    device_integration,
    eligible_devices,
    entity_owners,
    entity_selector_match,
    selector_integrations,
    target_index,
    template_fits,
    template_has_target,
)
from ..listeners import refresh_state_listener, schedule_push_rescan
from ..template_pages import (
    TemplatePageError,
    async_create_page_from_template,
    resolve_template_target,
    schedule_page_refresh,
    template_set_page_ids,
)
from .common import requires_device
from ..access import require_any_device_access, require_device_access

_LOGGER = logging.getLogger(__name__)


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_templates",
    vol.Optional("entity_id"): str,
})
@require_any_device_access
@websocket_api.async_response
async def ws_list_templates(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return template metadata: {id, name, icon, description, target_selector}.

    Each also says whether Home Assistant has anything it could be bound to
    (``available``), so the panel leaves out a template whose device is not
    there rather than offer a dialog with nothing to pick.

    ``entity_id`` names what the caller already controls -- the button an
    options page is being made for -- and marks every template that device
    answers ``fits``, which is what the options walk leads with.
    """
    templates = await hass.async_add_executor_job(list_templates)
    index = target_index(hass)
    owners = entity_selector_match(hass, msg.get("entity_id") or "")
    asked: dict[str, set[str] | None] = {}
    for entry in templates:
        entry["available"] = template_has_target(hass, entry, index)
        kind = entry.get("favorites")
        if entry["available"] and kind in FAVORITE_CATEGORIES:
            device_sel = (entry.get("target_selector") or {}).get("device") or {}
            entry["available"] = bool(await _with_favorites(
                hass, eligible_devices(hass, device_sel), device_sel, kind, asked,
            ))
        if owners and template_fits(entry, owners):
            entry["fits"] = True
    connection.send_result(msg["id"], {"templates": templates})


async def _with_favorites(
    hass: HomeAssistant, devices: list[dict], device_sel: dict, kind: str,
    asked: dict[str, set[str] | None],
) -> list[dict]:
    """The *devices* whose player has favourites of *kind*.

    A player that cannot be asked -- off, or not loaded -- is left out with
    the rest: it says of no kind that it has any. *asked* keeps each player's
    answer for the rest of the request.
    """
    integrations = selector_integrations(device_sel)
    kept = []
    for device in devices:
        player = _resolve_device_domain_entities(
            hass, device["id"], integrations[0] if integrations else None,
        ).get("media_player", "")
        if player and player not in asked:
            asked[player] = await favorite_kinds(hass, player)
        if player and kind in (asked.get(player) or ()):
            kept.append(device)
    return kept


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/options_fit",
    vol.Required("entity_ids"): [str],
})
@require_any_device_access
@websocket_api.async_response
async def ws_options_fit(hass: HomeAssistant, connection, msg: dict) -> None:
    """``{fits: {entity_id: bool}}``: whether an options template fits each.

    The question the button menu asks before it offers **Add options…**,
    answered for a whole page of buttons at once, the way ``list_templates``
    marks ``fits`` for one.
    """
    options = [
        t for t in await hass.async_add_executor_job(list_templates) if t.get("options")
    ]
    fits: dict[str, bool] = {}
    for entity_id in msg["entity_ids"]:
        owners = entity_selector_match(hass, entity_id)
        fits[entity_id] = bool(owners) and any(template_fits(t, owners) for t in options)
    connection.send_result(msg["id"], {"fits": fits})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_template_devices",
    vol.Required("template_id"): str,
    vol.Optional("entity_id"): str,
})
@require_any_device_access
@websocket_api.async_response
async def ws_list_template_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """List devices matching a template's integration and primary domain.

    Server-side filtering keeps the panel from reimplementing device/entity
    registry joins and guarantees the later add-page validation matches it.

    ``entity_id`` names something the caller is already about to control -- the
    button an options page is being made for -- and ``suggested`` answers with
    its device when that device is one of the eligible ones.
    """
    template_id = msg["template_id"]
    template = await hass.async_add_executor_job(load_template, template_id)
    if not template:
        connection.send_error(msg["id"], "not_found", f"Template '{template_id}' not found")
        return

    device_sel = (template.get("target_selector") or {}).get("device") or {}
    if not device_sel:
        connection.send_error(
            msg["id"], "invalid_template", f"Template '{template_id}' does not target a device"
        )
        return

    devices = eligible_devices(hass, device_sel)
    # A page of one kind of favourite only on a speaker that has some.
    if (kind := favorites_kind(template)) in FAVORITE_CATEGORIES:
        devices = await _with_favorites(hass, devices, device_sel, kind, {})
    device_id, _entry_id = entity_owners(hass, msg.get("entity_id") or "")
    suggested = device_id if any(d["id"] == device_id for d in devices) else ""
    connection.send_result(msg["id"], {"devices": devices, "suggested": suggested})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_template_config_entries",
    vol.Required("template_id"): str,
    vol.Optional("entity_id"): str,
})
@require_any_device_access
@websocket_api.async_response
async def ws_list_template_config_entries(hass: HomeAssistant, connection, msg: dict) -> None:
    """List config entries for templates bound to an integration instance.

    The Hue template binds to a bridge/config entry, not one lamp; the page is
    populated from everything that entry owns. ``entity_id`` proposes the
    bridge that owns it, the way the device listing proposes a device.
    """
    template_id = msg["template_id"]
    template = await hass.async_add_executor_job(load_template, template_id)
    if not template:
        connection.send_error(msg["id"], "not_found", f"Template '{template_id}' not found")
        return

    entry_sel = (template.get("target_selector") or {}).get("config_entry") or {}
    if not entry_sel:
        connection.send_error(
            msg["id"],
            "invalid_template",
            f"Template '{template_id}' does not target a config entry",
        )
        return

    integration = entry_sel.get("integration")
    entries = [
        {"id": entry.entry_id, "title": entry.title or entry.entry_id}
        for entry in hass.config_entries.async_entries(integration)
        if not entry.disabled_by
    ]
    entries.sort(key=lambda e: e["title"].lower())
    _device_id, entry_id = entity_owners(hass, msg.get("entity_id") or "")
    suggested = entry_id if any(e["id"] == entry_id for e in entries) else ""
    connection.send_result(msg["id"], {"entries": entries, "suggested": suggested})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/add_template_page",
    vol.Required("entry_id"): str,
    vol.Required("template_id"): str,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
    vol.Optional("subpage"): bool,
    vol.Optional("back_to_page"): PAGE_ID_SCHEMA,
    vol.Optional("insert_after"): PAGE_ID_SCHEMA,
    vol.Optional("title"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_add_template_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Create a page from a template, bound to a device or config entry target.

    Config-entry templates have no primary entity; their grids come from dynamic
    sources filtered to that entry.

    ``subpage`` keeps the page out of the remote's swipe list, and
    ``back_to_page`` gives its hardware Back button a way out again -- what
    **Add options…** makes for a button. ``insert_after`` seats the page
    behind one already there, and ``title`` names it where the template
    does not.

    Response payload:
      {success: true, page_id, pages}
    """
    entry_id = msg["entry_id"]
    template_id = msg["template_id"]
    target_device = msg.get("target_device") or ""
    target_config_entry = msg.get("target_config_entry") or ""

    started = time.monotonic()
    try:
        new_page_id = await async_create_page_from_template(
            hass, entry_id, device_id, template_id,
            target_device=target_device, target_config_entry=target_config_entry,
            subpage=bool(msg.get("subpage")), back_to_page=msg.get("back_to_page"),
            insert_after=msg.get("insert_after"), title=msg.get("title") or "",
        )
    except TemplatePageError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    target_entity = target_device or target_config_entry
    store = get_store(hass)

    pages = await store.async_get_pages(device_id)

    device_id_logger(_LOGGER, hass, device_id).info(
        "Added template page '%s' (template=%s, target=%s) in %.2f s",
        new_page_id, template_id, target_entity, time.monotonic() - started,
    )

    # Do not navigate here; the panel sends goto_page for every page-creation path.
    connection.send_result(msg["id"], {
        "success": True,
        "page_id": new_page_id,
        # A template may bring pages behind its own; the panel shows the first.
        "page_ids": template_set_page_ids(pages, new_page_id),
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


def _reference_pattern(mapping: dict[str, str]) -> re.Pattern:
    """Every key of *mapping* as a whole token, longest first."""
    return re.compile(
        r"(?<![A-Za-z0-9_])("
        + "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
        + r")(?![A-Za-z0-9_])"
    )


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
#: on a button -- `tooltip`, `tooltip_edited`, `action_id`, `state_icons`,
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
    vol.Required("type"): "lizaip_config/retarget_template_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_retarget_template_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Point a template page at another device (or hub), keeping its buttons.

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

    store = get_store(hass)
    pages = await store.async_get_pages(device_id)
    page = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)
    if page is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {page_id} not found")
        return
    page_template = page.get("template") if isinstance(page.get("template"), dict) else {}
    template_id = page_template.get("type") or ""
    if not template_id:
        connection.send_error(msg["id"], "not_a_template_page", f"Page {page_id} was not made from a template")
        return

    template = await hass.async_add_executor_job(load_template, template_id)
    if not template:
        connection.send_error(msg["id"], "template_error", f"Template '{template_id}' not found")
        return

    error, target_entity, new_domain_entities = resolve_template_target(
        hass, template_id, template, target_device, target_config_entry,
    )
    if error:
        connection.send_error(msg["id"], *error)
        return

    old_target = dict(page_template.get("target") or {})
    new_target = {
        "entity_id": target_entity,
        **({"device": target_device} if target_device else {}),
        **({"config_entry": target_config_entry} if target_config_entry else {}),
    }
    integrations = selector_integrations((template.get("target_selector") or {}).get("device") or {})
    old_device = old_target.get("device") or ""
    if len(integrations) == 1:
        integration = integrations[0]
    else:
        # Of several, the one that owns the old device decides which of its
        # entities win their domain -- the same answer the picker gave.
        old_device_entry = dr.async_get(hass).async_get(old_device) if old_device else None
        integration = (
            device_integration(hass, old_device_entry, integrations)
            if old_device_entry and integrations else None
        )
    old_domain_entities = (
        _resolve_device_domain_entities(hass, old_device, integration) if old_device else {}
    )

    # A template that brought pages behind it is moved as one: the subpages
    # point at the same device, so they follow it.
    instance = page_template.get("instance")
    group = [page] if instance is None else [
        p for p in pages
        if isinstance(p, dict) and isinstance(p.get("template"), dict)
        and p["template"].get("instance") == instance
    ]

    assignments_by_page = {
        p["id"]: await store.async_get_assignments(device_id, p["id"]) for p in group
    }
    referenced: set[str] = set()
    for page_assignments in assignments_by_page.values():
        referenced |= _referenced_entities(page_assignments, set())

    buttons_changed = 0
    mapping = _retarget_mapping(
        hass, old_target, new_target, old_domain_entities, new_domain_entities,
        referenced,
    )
    if mapping:
        pattern = _reference_pattern(mapping)
        for group_page_id, assignments in assignments_by_page.items():
            rewritten = _rewrite_assignments(assignments, pattern, mapping)
            changed = sum(1 for key in rewritten if rewritten[key] != assignments.get(key))
            if changed:
                buttons_changed += changed
                await store.async_set_assignments(device_id, group_page_id, rewritten)

    for group_page in group:
        group_page["template"] = {**group_page["template"], "target": new_target}
    await store.async_set_pages(device_id, pages)

    device_id_logger(_LOGGER, hass, device_id).info(
        "Moved template page %s (%s) from %s to %s: %d button(s) changed",
        page_id, template_id, old_target, new_target, buttons_changed,
    )
    # Answered before the rest: rebuilding the remote's state listener reads
    # every page and took seconds, all of which the dialog sat waiting for.
    connection.send_result(msg["id"], {
        "success": True,
        "pages": await store.async_get_pages(device_id),
        "replaced": mapping,
        "buttons_changed": buttons_changed,
        # Every page that moved, so the panel re-reads the subpages too.
        "page_ids": [page_id] + [p["id"] for p in group if p["id"] != page_id],
    })
    fire_config_changed(hass, entry_id)
    schedule_push_rescan(hass, entry_id)
    # Dynamic buttons list what the *new* device offers -- its apps, its
    # inputs, a speaker's playlists on a subpage -- and only a refresh reads that.
    schedule_page_refresh(hass, entry_id, *(p["id"] for p in group))
    await refresh_state_listener(hass, entry_id)


