"""Templates: generating a page for a device or integration, and retargeting it.

A template (``templates/presets``) describes a page for one kind of device. Adding
it to a remote resolves it against a real device; retargeting rewrites an
existing template page to point at a different one.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr

from ...runtime import _get_store
from ...shared.assignment import ASSIGNMENT_LONGTOUCH_KEY, ASSIGNMENT_DYNAMIC_KEY
from ...shared.logs import device_id_logger
from ..blueprint import async_get_blueprint
from ..const import PAGE_ID_SCHEMA, PAGE_SUBPAGE_KEY, generate_page_id
from ..device_entities import _resolve_device_domain_entities
from ..events import fire_config_changed
from ...config.page_templates.generate import favorites_kind, paginated_placeholder
from ...config.page_templates.sources import FAVORITE_CATEGORIES, favorite_kinds
from ...config.page_templates import (
    ComposedPage,
    async_compose_pages,
    list_templates,
    is_unbound,
    load_template,
    template_pages,
    TEMPLATE_VERSION,
    TEMPLATE_VERSION_KEY,
    generate_assignments as template_generate_assignments,
    refresh as template_refresh,
)
from .common import (
    EMPTY_BUTTON,
    entry_log,
    refresh_state_listener,
    requires_device,
    reserved_page_ids,
    schedule_push_rescan,
)
from ..access import require_any_device_access, require_device_access

_LOGGER = logging.getLogger(__name__)


def template_set_page_ids(pages: list, page_id: int) -> list[int]:
    """*page_id* and the pages its template brought with it, that page first.

    A page that belongs to no set is a set of one.
    """
    page = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)
    template = page.get("template") if isinstance(page, dict) else None
    instance = template.get("instance") if isinstance(template, dict) else None
    if instance is None:
        return [page_id]
    return [page_id] + [
        p["id"] for p in pages
        if isinstance(p, dict) and p.get("id") != page_id
        and isinstance(p.get("template"), dict)
        and p["template"].get("instance") == instance
    ]


def _schedule_page_refresh(hass: HomeAssistant, entry_id: str, *page_ids: int) -> None:
    """Re-read these pages' dynamic buttons in the background, one after another.

    Browsing a media source can take seconds; the editor should not wait for
    it. Guarded like ``common.schedule_push_rescan``, for the same reason.
    One task for all of them, so two refreshes never write the store at once.
    """
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        return
    log = entry_log(_LOGGER, hass, entry_id)

    async def _refresh() -> None:
        for page_id in page_ids:
            try:
                await template_refresh.async_refresh_and_sync(hass, entry_id, page_id=page_id)
            except Exception as err:  # noqa: BLE001
                log.debug("Dynamic refresh of page %s failed: %s", page_id, err)

    try:
        create_task(_refresh())
    except Exception as err:  # noqa: BLE001
        log.debug("Could not schedule page refresh: %s", err)


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
    index = _target_index(hass)
    owners = _entity_selector_match(hass, msg.get("entity_id") or "")
    asked: dict[str, set[str] | None] = {}
    for entry in templates:
        entry["available"] = _template_has_target(hass, entry, index)
        kind = entry.get("favorites")
        if entry["available"] and kind in FAVORITE_CATEGORIES:
            device_sel = (entry.get("target_selector") or {}).get("device") or {}
            entry["available"] = bool(await _with_favorites(
                hass, _eligible_devices(hass, device_sel), device_sel, kind, asked,
            ))
        if owners and _template_fits(entry, owners):
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
@websocket_api.require_admin
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
        owners = _entity_selector_match(hass, entity_id)
        fits[entity_id] = bool(owners) and any(_template_fits(t, owners) for t in options)
    connection.send_result(msg["id"], {"fits": fits})


def selector_integrations(selector: dict) -> tuple[str, ...]:
    """The integrations a target selector accepts: one name, or a list of them."""
    value = (selector or {}).get("integration")
    if isinstance(value, str):
        return (value,) if value else ()
    if isinstance(value, (list, tuple)):
        return tuple(v for v in value if isinstance(v, str) and v)
    return ()


def _entry_domains(hass: HomeAssistant) -> dict[str, str]:
    """``{config entry id: integration}`` for every config entry, read once.

    Asking ``async_entries(integration)`` again for every device made listing
    the devices for one template take seconds on a house of a few hundred.
    """
    return {e.entry_id: e.domain for e in hass.config_entries.async_entries()}


def _device_domains(hass: HomeAssistant) -> dict[str, set[str]]:
    """``{device id: domains of its enabled entities}``, in one pass.

    Asking the registry device by device cost seconds on a house of a few
    hundred devices, and every template listed asked again.
    """
    from homeassistant.helpers import entity_registry as er

    domains: dict[str, set[str]] = {}
    for entry in er.async_get(hass).entities.values():
        if entry.device_id and entry.disabled_by is None:
            domains.setdefault(entry.device_id, set()).add(entry.domain)
    return domains


def _device_entry_ids(device: Any) -> set[str]:
    """The config entries *device* belongs to.

    ``config_entry_id`` where Home Assistant has it (2026.8 on): from 2026.10
    every read of the old ``config_entries`` files a deprecation report, which
    inspects the stack -- about 11 ms a device, seconds for a template list on a
    house of a few hundred. An older Home Assistant only has ``config_entries``.
    """
    entry_id = getattr(device, "config_entry_id", None)
    if isinstance(entry_id, str) and entry_id:
        return {entry_id}
    return set(getattr(device, "config_entries", None) or ())


def _device_integration(
    hass: HomeAssistant, device: Any, integrations: tuple[str, ...],
    entry_domains: dict[str, str] | None = None,
) -> str | None:
    """Which of *integrations* owns *device*, or None if none does."""
    if entry_domains is None:
        entry_domains = _entry_domains(hass)
    owners = {entry_domains.get(e) for e in _device_entry_ids(device)}
    return next((i for i in integrations if i in owners), None)


def _eligible_devices(hass: HomeAssistant, device_sel: dict) -> list[dict]:
    """Devices a device-mode template can bind to, named and sorted for a picker."""
    integrations = selector_integrations(device_sel)
    primary_domain = device_sel.get("primary_domain")
    entry_domains = _entry_domains(hass) if integrations else {}
    device_domains = _device_domains(hass)
    # Read only if something actually has an area: most templates resolve
    # without one, and the registry is a real lookup.
    areas = None
    devices = []
    for device in dr.async_get(hass).devices:
        if device.disabled_by is not None:
            continue
        if integrations and _device_integration(hass, device, integrations, entry_domains) is None:
            continue
        domains = device_domains.get(device.id, set())
        if not domains or (primary_domain and primary_domain not in domains):
            continue
        area_name = ""
        if device.area_id:
            if areas is None:
                areas = ar.async_get(hass)
            area = areas.async_get_area(device.area_id)
            area_name = area.name if area else ""
        devices.append({
            "id": device.id,
            "name": device.name_by_user or device.name or device.id,
            "area": area_name,
            "domains": sorted(domains),
        })
    devices.sort(key=lambda d: d["name"].lower())
    return devices


def _entity_owners(hass: HomeAssistant, entity_id: str) -> tuple[str, str]:
    """``(device id, config entry id)`` of *entity_id*, empty where unknown."""
    if not entity_id:
        return "", ""
    from homeassistant.helpers import entity_registry as er

    entry = er.async_get(hass).async_get(entity_id)
    if entry is None:
        return "", ""
    return entry.device_id or "", entry.config_entry_id or ""


def _entity_selector_match(
    hass: HomeAssistant, entity_id: str,
) -> tuple[frozenset[str], frozenset[str], str] | None:
    """What a selector has to accept to fit *entity_id*, or ``None`` for none.

    The integrations and entity domains of the device it belongs to, and the
    integration of its config entry -- the three things a target selector asks
    about.
    """
    device_id, entry_id = _entity_owners(hass, entity_id)
    if not device_id and not entry_id:
        return None
    domain_of_entry = _entry_domains(hass)
    device = dr.async_get(hass).async_get(device_id) if device_id else None
    integrations = frozenset(
        domain_of_entry[e] for e in _device_entry_ids(device) if e in domain_of_entry
    ) if device else frozenset()
    domains = frozenset(_device_domains(hass).get(device_id, ())) if device_id else frozenset()
    return integrations, domains, domain_of_entry.get(entry_id, "")


def _template_fits(
    template: dict, owners: tuple[frozenset[str], frozenset[str], str],
) -> bool:
    """Whether the entity behind *owners* answers *template*'s target selector.

    The same question the device picker asks of a whole house, put to one
    device. A template that binds to nothing fits nothing in particular.
    """
    if template.get("unbound") or template.get("action"):
        return False
    selector = template.get("target_selector") or {}
    integrations, domains, entry_integration = owners
    entry_sel = selector.get("config_entry") or {}
    if entry_sel:
        return entry_integration in selector_integrations(entry_sel)
    device_sel = selector.get("device") or {}
    return bool(device_sel) and _device_selector_accepts(device_sel, [(integrations, domains)])


def _target_index(hass: HomeAssistant) -> list[tuple[frozenset[str], frozenset[str]]]:
    """``(owning integrations, entity domains)`` for every enabled device.

    Read once per request, so every template listed is answered from one pass
    over the registries rather than walking them again for each.
    """
    domain_of_entry = _entry_domains(hass)
    device_domains = _device_domains(hass)
    return [
        (
            frozenset(domain_of_entry[e] for e in _device_entry_ids(device) if e in domain_of_entry),
            frozenset(device_domains.get(device.id, ())),
        )
        for device in dr.async_get(hass).devices
        if device.disabled_by is None
    ]


def _template_has_target(
    hass: HomeAssistant, template: dict,
    index: list[tuple[frozenset[str], frozenset[str]]] | None = None,
) -> bool:
    """Whether Home Assistant has anything *template* could be bound to right now.

    Asks the same thing as the device picker -- a device of one of the
    template's integrations carrying its primary domain -- from *index*
    (``_target_index``) when given. An unbound template needs nothing, and
    neither does a card that runs a panel routine instead of writing a page.
    """
    if is_unbound(template) or template.get("action"):
        return True
    selector = template.get("target_selector") or {}
    entry_sel = selector.get("config_entry") or {}
    if entry_sel:
        return any(
            not entry.disabled_by
            for integration in selector_integrations(entry_sel)
            for entry in hass.config_entries.async_entries(integration)
        )
    device_sel = selector.get("device") or {}
    if not device_sel:
        return False
    if index is None:
        return bool(_eligible_devices(hass, device_sel))
    return _device_selector_accepts(device_sel, index)


def _device_selector_accepts(
    device_sel: dict, index: list[tuple[frozenset[str], frozenset[str]]],
) -> bool:
    """Whether a device of *index* -- ``(integrations, domains)`` each -- fits *device_sel*."""
    integrations = set(selector_integrations(device_sel))
    primary_domain = device_sel.get("primary_domain")
    return any(
        (not integrations or owners & integrations)
        and (not primary_domain or primary_domain in domains)
        for owners, domains in index
    )


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

    devices = _eligible_devices(hass, device_sel)
    # A page of one kind of favourite only on a speaker that has some.
    if (kind := favorites_kind(template)) in FAVORITE_CATEGORIES:
        devices = await _with_favorites(hass, devices, device_sel, kind, {})
    device_id, _entry_id = _entity_owners(hass, msg.get("entity_id") or "")
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
    _device_id, entry_id = _entity_owners(hass, msg.get("entity_id") or "")
    suggested = entry_id if any(e["id"] == entry_id for e in entries) else ""
    connection.send_result(msg["id"], {"entries": entries, "suggested": suggested})


def _resolve_template_target(
    hass: HomeAssistant,
    template_id: str,
    template: dict,
    target_device: str,
    target_config_entry: str,
) -> tuple[tuple[str, str] | None, str, dict[str, str]]:
    """Check a device or config entry against a template's target selector.

    Shared by adding a template page and by moving one to another device, so both
    accept exactly the same targets.

    Returns ``(error, target_entity, domain_entities)``; ``error`` is a
    ``(code, message)`` pair, or ``None`` when the target fits.
    """
    # A template that names no selector needs nothing to point its tiles at.
    # One whose selector names neither a device nor a hub is still refused below.
    if is_unbound(template):
        return None, "", {}

    selector = template.get("target_selector") or {}
    device_sel = selector.get("device") or {}
    entry_sel = selector.get("config_entry") or {}

    domain_entities: dict[str, str] = {}
    target_entity = ""

    if entry_sel:
        if not target_config_entry:
            return ("invalid_target", f"Template '{template_id}' needs a config entry to bind to"), "", {}
        integration = entry_sel.get("integration")
        target_entry = hass.config_entries.async_get_entry(target_config_entry)
        if target_entry is None or (integration and target_entry.domain != integration):
            return ("not_found", f"Config entry '{target_config_entry}' does not belong to "
                f"integration '{integration}' required by template '{template_id}'"), "", {}
        # Disabled entries own no live entities, so dynamic pages would stay empty.
        # Worded operation-neutral: this check also runs when retargeting an
        # existing page, where "before adding a page" was simply wrong.
        if target_entry.disabled_by:
            return ("invalid_target", f"Config entry '{target_config_entry}' is disabled; "
                f"enable it before using it for a '{template_id}' page"), "", {}
    elif device_sel:
        if not target_device:
            return ("invalid_target", f"Template '{template_id}' needs a device to bind to"), "", {}
        # Device templates need same-device sibling entities by service domain; an
        # entity selector cannot express androidtv_remote remote.* plus
        # media_player.* app-launch buttons.
        integrations = selector_integrations(device_sel)
        integration = None
        # Match the picker: require one of the template's integrations, not just a domain.
        if integrations:
            device = dr.async_get(hass).async_get(target_device)
            integration = _device_integration(hass, device, integrations) if device else None
            if integration is None:
                return ("not_found", f"Device '{target_device}' does not belong to integration "
                    f"'{' / '.join(integrations)}' required by template '{template_id}'"), "", {}

        domain_entities = _resolve_device_domain_entities(
            hass, target_device, integration
        )
        if not domain_entities:
            return ("not_found", f"Device '{target_device}' has no usable entities"), "", {}
        primary_domain = device_sel.get("primary_domain")
        target_entity = domain_entities.get(primary_domain) if primary_domain else ""
        if not target_entity:
            return ("not_found", f"Device '{target_device}' has no '{primary_domain}' entity required by template '{template_id}'"), "", {}
    else:
        return ("invalid_template", f"Template '{template_id}' declares no device or config entry selector"), "", {}

    return None, target_entity, domain_entities


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
    store = _get_store(hass)

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

    store = _get_store(hass)
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

    error, target_entity, new_domain_entities = _resolve_template_target(
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
            _device_integration(hass, old_device_entry, integrations)
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
        pattern = re.compile(
            r"(?<![A-Za-z0-9_])("
            + "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
            + r")(?![A-Za-z0-9_])"
        )
        for group_page_id, assignments in assignments_by_page.items():
            rewritten = _rewrite_assignments(assignments, pattern, mapping)
            changed = sum(1 for key in rewritten if rewritten[key] != assignments.get(key))
            if changed:
                buttons_changed += changed
                await store.async_set_assignments(device_id, group_page_id, rewritten)

    for group_page in group:
        group_page["template"] = {**group_page["template"], "target": new_target}
    await store.async_set_pages(device_id, pages)
    for group_page in group:
        await store.async_recompute_page_hash(device_id, group_page["id"])

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
    _schedule_page_refresh(hass, entry_id, *(p["id"] for p in group))
    await refresh_state_listener(hass, entry_id)


def _config_entry(hass: HomeAssistant, entry_id: str):
    """The remote's config entry, or None where there is no registry to ask."""
    entries = getattr(hass, "config_entries", None)
    return entries.async_get_entry(entry_id) if entries is not None else None


class TemplatePageError(Exception):
    """A template that cannot become a page; ``code`` is the websocket error code."""

    def __init__(self, message: str, code: str = "template_error") -> None:
        super().__init__(message)
        self.code = code


async def async_create_page_from_template(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    template_id: str,
    *,
    target_device: str = "",
    target_config_entry: str = "",
    subpage: bool = False,
    back_to_page: int | None = None,
    insert_after: int | None = None,
    title: str = "",
) -> int:
    """Add a page made from the shipped template *template_id*; return its id.

    What **Add page → Template** does, for the panel and for the LLM tools
    alike: the target is checked against the template's selector, the
    template's variables are resolved against it and the remote, and the pages
    it describes -- its own, and any it brings behind it -- are written
    together so the buttons that lead between them can be made at once.

    *insert_after* seats the set right behind a page already there instead of
    at the end, and *title* names a first page the template leaves nameless.
    """
    template = await hass.async_add_executor_job(load_template, template_id)
    if not template:
        raise TemplatePageError(f"Template '{template_id}' not found")
    pages_def = template_pages(template_id, template)
    if not pages_def:
        raise TemplatePageError(f"Template '{template_id}' names no pages under 'pages:'")
    # A page that repeats over its items grows parts of its own, and those
    # parts are pages of the swipe list: nothing behind one button can hide
    # them again, so such a template is no options page.
    if subpage and any(paginated_placeholder(page) for _, page in pages_def):
        raise TemplatePageError(
            f"Template '{template_id}' grows pages of its own and cannot be "
            "a button's options page",
            "template_paginated",
        )

    error, target_entity, domain_entities = _resolve_template_target(
        hass, template_id, template, target_device, target_config_entry,
    )
    if error:
        code, message = error
        raise TemplatePageError(message, code)

    # The title of a first page that states none: what the caller asked for,
    # else the icon the picker showed.
    fallback_title = title or template.get("icon", "mdi:remote")

    store = _get_store(hass)
    stored = await store.async_get_pages(device_id)
    reserved = await reserved_page_ids(
        store, device_id, {p["id"] for p in stored if isinstance(p, dict)},
    )
    # Every page of the set is given its id before any is made, so the buttons
    # that lead from one to another can be written straight away.
    page_ids: list[int] = []
    for _ in pages_def:
        page_ids.append(generate_page_id(reserved))
        reserved.add(page_ids[-1])

    _LOGGER.debug("Template %s: target and page ids ready", template_id)
    composed = await async_compose_pages(
        hass, template_id, template, page_ids,
        target_entity=target_entity,
        domain_entities=domain_entities or None,
        target_config_entry=target_config_entry,
        remote_entry=entry_id,
        entry=_config_entry(hass, entry_id),
        fallback_title=fallback_title,
    )
    if pages_def[0][1].get("buttons") and not composed[0].assignments:
        raise TemplatePageError(f"Template '{template_id}' produced no assignments")

    _LOGGER.debug("Template %s: composed, storing", template_id)
    main_page_id = await async_store_template_pages(
        hass, entry_id, device_id, template_id, template, composed,
        target_entity=target_entity,
        target_device=target_device,
        target_config_entry=target_config_entry,
        subpage=subpage,
        back_to_page=back_to_page,
        insert_after=insert_after,
    )
    # A page that repeats over its items is made as its first part; the
    # refresh counts the items and adds the parts they need.
    paginated = {name for name, page in pages_def if paginated_placeholder(page)}
    _schedule_page_refresh(
        hass, entry_id, *(p.page_id for p in composed if p.name in paginated),
    )
    return main_page_id


async def async_add_template_page(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    template_id: str,
    template: dict,
    *,
    title: str,
    target_entity: str = "",
    target_device: str = "",
    target_config_entry: str = "",
    domain_entities: dict[str, str] | None = None,
    subpage: bool = False,
    generated: tuple[list[dict], dict[str, dict]] | None = None,
) -> int:
    """Turn a *resolved* template into a new page on a remote; return its id.

    The one path from a template definition that is already resolved to a
    stored page, used by the LLM tools (``llm_api.py``, which append an
    ordinary page through an unbound definition). The panel's **Add page →
    Template** goes through :func:`async_create_page_from_template`, which may
    make a whole set of pages at once.
    """
    # Template generation is the only place target-specific variables become
    # stored action-library entries and button assignments. A caller that has
    # already generated them -- and renamed what it made -- hands them in.
    new_actions, assignments = generated or template_generate_assignments(
        template_id, target_entity, template, domain_entities, hass
    )
    # A definition that lists buttons and resolves to none is broken; one that
    # lists none is a deliberately empty page, which is what the blank-page
    # option adds.
    if template.get("buttons") and not assignments:
        raise TemplatePageError(f"Template '{template_id}' produced no assignments")

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    new_page_id = generate_page_id(
        await reserved_page_ids(
            store, device_id, {p["id"] for p in pages if isinstance(p, dict)},
        )
    )
    composed = [ComposedPage(
        name="",
        page_id=new_page_id,
        title=title,
        actions=new_actions,
        assignments=assignments,
    )]
    return await async_store_template_pages(
        hass, entry_id, device_id, template_id, template, composed,
        target_entity=target_entity,
        target_device=target_device,
        target_config_entry=target_config_entry,
        subpage=subpage,
    )


async def async_store_template_pages(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    template_id: str,
    template: dict,
    composed: list[ComposedPage],
    *,
    target_entity: str = "",
    target_device: str = "",
    target_config_entry: str = "",
    subpage: bool = False,
    instance: int | None = None,
    insert_after: int | None = None,
    back_to_page: int | None = None,
) -> int:
    """Write a template's composed pages to a remote; return the first page's id.

    *instance* and *insert_after* add pages to a set already on the remote --
    the parts a paginated page grows -- after the page *insert_after*, which
    also seats a page made beside the one that asked for it.
    *back_to_page* gives the first page a hardware Back that leads there --
    what **Add options…** makes for a button.

    All of them land in one pass: the action library, the pages themselves,
    and every button the template leaves alone written empty. Then the remote,
    the state listener and the push triggers are told, once.
    """
    store = _get_store(hass)

    existing_lib = await store.async_get_action_library(device_id)
    existing_by_id = {a["id"]: i for i, a in enumerate(existing_lib) if "id" in a}
    for page in composed:
        for action in page.actions:
            if action["id"] in existing_by_id:
                existing_lib[existing_by_id[action["id"]]] = action
            else:
                existing_by_id[action["id"]] = len(existing_lib)
                existing_lib.append(action)
    await store.async_set_action_library(device_id, existing_lib)

    pages = await store.async_get_pages(device_id)
    existing_ids = {p["id"] for p in pages if isinstance(p, dict) and "id" in p}
    main_page_id = composed[0].page_id
    bound = not is_unbound(template)
    # An unbound template leaves an ordinary page: no device to change it to,
    # nothing to refresh from. One that brings pages behind it still says
    # which set they are, or deleting the page the user sees would strand them.
    # A page that repeats over its items gets parts later, which join its set.
    set_of_pages = len(composed) > 1 or any(
        paginated_placeholder(page) for _, page in template_pages(template_id, template)
    )
    for page in composed:
        new_page: dict[str, Any] = {
            "id": page.page_id,
            "title": page.title,
            "hash": 0,
        }
        if page.subpage or (subpage and page.page_id == main_page_id):
            new_page[PAGE_SUBPAGE_KEY] = True
        if bound or set_of_pages:
            new_page["template"] = {
                "type": template_id,
                # The format it was made under: what a later release reads to
                # bring an older page up to date.
                TEMPLATE_VERSION_KEY: TEMPLATE_VERSION,
                # Which page of the template this is, and which set it belongs
                # to, so retargeting and deleting can treat the set as one.
                **({"page": page.name} if page.name else {}),
                **({"part": page.part} if page.part > 1 else {}),
                **({"instance": instance or main_page_id} if set_of_pages else {}),
                **({"target": {
                    "entity_id": target_entity,
                    **({"device": target_device} if target_device else {}),
                    **(
                        {"config_entry": target_config_entry}
                        if target_config_entry else {}
                    ),
                }} if bound else {}),
            }
        at = next(
            (i + 1 for i, p in enumerate(pages)
             if isinstance(p, dict) and p.get("id") == insert_after),
            len(pages),
        )
        pages.insert(at, new_page)
        if insert_after is not None:
            insert_after = page.page_id
    await store.async_set_pages(device_id, pages)

    bp = await async_get_blueprint(hass, entry_id)
    all_keys = [btn["key"] for btn in bp.get("buttons", [])]
    for page in composed:
        assignments = dict(page.assignments)
        # After generation, so a template that carries a Back of its own --
        # the TV remotes do -- gives way to the one that leads out of this
        # subpage.
        if (page.page_id == main_page_id and back_to_page is not None
                and back_to_page in existing_ids):
            assignments["button_back"] = {
                **dict(EMPTY_BUTTON),
                "tooltip": "Back",
                "icon": "mdi:keyboard-backspace",
                "config": [{"action": "lizaip.goto_page", "data": {"page_id": back_to_page}}],
            }
        for key in all_keys:
            if key not in assignments:
                assignments[key] = dict(EMPTY_BUTTON)
        await store.async_set_assignments(device_id, page.page_id, assignments)
        await store.async_recompute_page_hash(device_id, page.page_id)

    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    # Re-scan after writes so new dynamic bindings get push subscriptions; the
    # scanner re-reads stored pages.
    schedule_push_rescan(hass, entry_id)
    return main_page_id
