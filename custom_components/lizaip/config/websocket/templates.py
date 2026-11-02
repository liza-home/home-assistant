"""Templates: generating a page for a device or integration, and retargeting it.

A template (``templates/presets``) describes a page for one kind of device. Adding
it to a remote resolves it against a real device; retargeting rewrites an
existing template page to point at a different one.
"""
from __future__ import annotations

import logging
import re
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
from ...config.page_templates import (
    list_templates,
    load_template,
    resolve_template_variables,
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

_LOGGER = logging.getLogger(__name__)


def _schedule_page_refresh(hass: HomeAssistant, entry_id: str, page_id: int) -> None:
    """Re-read one page's dynamic buttons in the background.

    Browsing a media source can take seconds; the editor should not wait for
    it. Guarded like ``common.schedule_push_rescan``, for the same reason.
    """
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        return
    log = entry_log(_LOGGER, hass, entry_id)

    async def _refresh() -> None:
        try:
            await template_refresh.async_refresh_and_sync(hass, entry_id, page_id=page_id)
        except Exception as err:  # noqa: BLE001
            log.debug("Dynamic refresh of page %s failed: %s", page_id, err)

    try:
        create_task(_refresh())
    except Exception as err:  # noqa: BLE001
        log.debug("Could not schedule page refresh: %s", err)


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/list_templates"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_templates(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return template metadata: {id, name, icon, description, target_selector}.

    Each also says whether Home Assistant has anything it could be bound to
    (``available``), so the panel leaves out a template whose device is not
    there rather than offer a dialog with nothing to pick.
    """
    templates = await hass.async_add_executor_job(list_templates)
    index = _target_index(hass)
    for entry in templates:
        entry["available"] = _template_has_target(hass, entry, index)
    connection.send_result(msg["id"], {"templates": templates})


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
    if template.get("unbound") or template.get("action"):
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
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_template_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """List devices matching a template's integration and primary domain.

    Server-side filtering keeps the panel from reimplementing device/entity
    registry joins and guarantees the later add-page validation matches it.
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

    connection.send_result(msg["id"], {"devices": _eligible_devices(hass, device_sel)})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_template_config_entries",
    vol.Required("template_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_template_config_entries(hass: HomeAssistant, connection, msg: dict) -> None:
    """List config entries for templates bound to an integration instance.

    The Hue template binds to a bridge/config entry, not one lamp; the page is
    populated from everything that entry owns.
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
    connection.send_result(msg["id"], {"entries": entries})


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
    # A template that shows what tiles can do needs nothing to point them at. It
    # says so in as many words, so one that merely forgot its selector is still
    # refused below rather than quietly built unbound.
    if template.get("unbound"):
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
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_add_template_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Create a page from a template, bound to a device or config entry target.

    Config-entry templates have no primary entity; their grids come from dynamic
    sources filtered to that entry.

    Response payload:
      {success: true, page_id, pages}
    """
    entry_id = msg["entry_id"]
    template_id = msg["template_id"]
    target_device = msg.get("target_device") or ""
    target_config_entry = msg.get("target_config_entry") or ""

    try:
        new_page_id = await async_create_page_from_template(
            hass, entry_id, device_id, template_id,
            target_device=target_device, target_config_entry=target_config_entry,
        )
    except TemplatePageError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    target_entity = target_device or target_config_entry
    store = _get_store(hass)

    pages = await store.async_get_pages(device_id)

    device_id_logger(_LOGGER, hass, device_id).info(
        "Added template page '%s' (template=%s, target=%s)",
        new_page_id, template_id, target_entity,
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
    vol.Required("type"): "lizaip_config/retarget_template_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
})
@websocket_api.require_admin
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

    page["template"] = {**page_template, "target": new_target}
    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, page_id)

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
    })
    fire_config_changed(hass, entry_id)
    schedule_push_rescan(hass, entry_id)
    # Dynamic buttons list what the *new* device offers -- its apps, its
    # inputs -- and only a refresh reads that.
    _schedule_page_refresh(hass, entry_id, page_id)
    await refresh_state_listener(hass, entry_id)


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
) -> int:
    """Add a page made from the shipped template *template_id*; return its id.

    What **Add page → Template** does, for the panel and for the LLM tools
    alike: the target is checked against the template's selector, the
    template's variables are resolved against it and the remote, and the page
    is written by :func:`async_add_template_page`.
    """
    template = await hass.async_add_executor_job(load_template, template_id)
    if not template:
        raise TemplatePageError(f"Template '{template_id}' not found")

    error, target_entity, domain_entities = _resolve_template_target(
        hass, template_id, template, target_device, target_config_entry,
    )
    if error:
        code, message = error
        raise TemplatePageError(message, code)

    template = await resolve_template_variables(
        hass, template, target_entity, domain_entities or None, target_config_entry,
        remote_entry=entry_id,
    )

    template_meta = None
    all_templates = await hass.async_add_executor_job(list_templates)
    for lt in all_templates:
        if lt["id"] == template_id:
            template_meta = lt
            break

    # `page_image` may hold `${…}` variables, which the picker cannot draw, so
    # it is kept apart from the `icon` the picker shows.
    page_icon = (
        template_meta.get("page_image", template_meta["icon"])
        if template_meta else "mdi:remote"
    )

    return await async_add_template_page(
        hass, entry_id, device_id, template_id, template,
        page_image=page_icon,
        target_entity=target_entity,
        target_device=target_device,
        target_config_entry=target_config_entry,
        domain_entities=domain_entities or None,
        subpage=subpage,
    )


async def async_add_template_page(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    template_id: str,
    template: dict,
    *,
    page_image: str,
    target_entity: str = "",
    target_device: str = "",
    target_config_entry: str = "",
    domain_entities: dict[str, str] | None = None,
    subpage: bool = False,
    generated: tuple[list[dict], dict[str, dict]] | None = None,
) -> int:
    """Turn a *resolved* template into a new page on a remote; return its id.

    The one path from a template to a stored page, shared by the panel's
    ``add_template_page`` and the LLM tools (``llm_api.py``, which append an
    ordinary page through an unbound definition): generation makes
    the action-library entries and assignments, the page is appended, every
    button the template leaves alone is written empty, and the remote, the
    state listener and the push triggers are told.
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

    existing_lib = await store.async_get_action_library(device_id)
    existing_by_id = {a["id"]: i for i, a in enumerate(existing_lib) if "id" in a}
    for action in new_actions:
        if action["id"] in existing_by_id:
            existing_lib[existing_by_id[action["id"]]] = action
        else:
            existing_lib.append(action)
    await store.async_set_action_library(device_id, existing_lib)

    pages = await store.async_get_pages(device_id)
    existing_ids = {p["id"] for p in pages if isinstance(p, dict)}
    new_page_id = generate_page_id(
        await reserved_page_ids(store, device_id, existing_ids)
    )

    new_page: dict[str, Any] = {
        "id": new_page_id,
        "image": page_image,
        "hash": 0,
    }
    if subpage:
        new_page[PAGE_SUBPAGE_KEY] = True
    # An unbound template leaves an ordinary page: there is no device to change
    # it to, nothing to refresh from, and no `${_device}` to answer.
    if not template.get("unbound"):
        new_page["template"] = {
            "type": template_id,
            "target": {
                "entity_id": target_entity,
                **({"device": target_device} if target_device else {}),
                **(
                    {"config_entry": target_config_entry}
                    if target_config_entry else {}
                ),
            },
        }
    pages.append(new_page)
    await store.async_set_pages(device_id, pages)

    bp = await async_get_blueprint(hass, entry_id)
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
    return new_page_id
