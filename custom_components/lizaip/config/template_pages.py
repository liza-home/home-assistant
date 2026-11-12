"""Making pages from templates: the logic behind **Add page → Template**.

Shared by the panel's websocket handlers (``config.websocket.templates``) and
the LLM tools (``llm_api``): checking a target against a template's selector,
composing the pages it describes and handing them to
``template_writes.async_store_template_pages``, which stores them and tells the
remote, the state listener and the push triggers.
"""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from ..runtime import get_store
from ..shared.logs import entry_id_logger
from .const import generate_page_id
from .device_entities import _resolve_device_domain_entities
from .page_list import reserved_page_ids
from .page_templates import (
    ComposedPage,
    async_compose_pages,
    generate_assignments as template_generate_assignments,
    is_unbound,
    load_template,
    refresh as template_refresh,
    template_pages,
)
from .page_templates.parts import paginated_placeholder
from .template_writes import async_store_template_pages
from .template_targets import device_integration, selector_integrations

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


def schedule_page_refresh(hass: HomeAssistant, entry_id: str, *page_ids: int) -> None:
    """Re-read these pages' dynamic buttons in the background, one after another.

    Browsing a media source can take seconds; the editor should not wait for
    it. Guarded like ``listeners.schedule_push_rescan``, for the same reason.
    One task for all of them, so two refreshes never write the store at once.
    """
    log = entry_id_logger(_LOGGER, hass, entry_id)

    async def _refresh() -> None:
        for page_id in page_ids:
            try:
                await template_refresh.async_refresh_and_sync(hass, entry_id, page_id=page_id)
            except Exception as err:  # noqa: BLE001
                log.debug("Dynamic refresh of page %s failed: %s", page_id, err)

    try:
        hass.async_create_background_task(_refresh(), f"lizaip page refresh {entry_id}")
    except Exception as err:  # noqa: BLE001
        log.debug("Could not schedule page refresh: %s", err)


def resolve_template_target(
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
            integration = device_integration(hass, device, integrations) if device else None
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

    error, target_entity, domain_entities = resolve_template_target(
        hass, template_id, template, target_device, target_config_entry,
    )
    if error:
        code, message = error
        raise TemplatePageError(message, code)

    # The title of a first page that states none: what the caller asked for,
    # else the icon the picker showed.
    fallback_title = title or template.get("icon", "mdi:remote")

    store = get_store(hass)
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
    schedule_page_refresh(
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

    store = get_store(hass)
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
