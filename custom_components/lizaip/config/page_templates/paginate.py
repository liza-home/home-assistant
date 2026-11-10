"""Parts of a paginated template page: as many as its items need.

A template page that says ``paginate: <placeholder>`` repeats while that
placeholder has more items than one page shows -- a TV with thirty apps gets
three Apps pages. Adding the template makes the first part; this module,
run with every refresh of the remote, counts the items and adds the parts
that are missing or removes trailing ones that have emptied, then points each
part's ``next`` and ``previous`` buttons at its neighbours.

It counts only when the source answers: a TV that is off keeps the parts it
has rather than losing them all.
"""
from __future__ import annotations

import logging
import math
from typing import Any

from homeassistant.core import HomeAssistant

from ..const import generate_page_id
from .compose import ComposedPage, async_compose_part
from .generate import (
    NEXT_PART,
    PAGE_LINK_KEY,
    PREVIOUS_PART,
    async_load_template,
    page_max_parts,
    page_source,
    has_more_parts,
    part_buttons,
    part_items,
    paginated_placeholder,
    template_pages,
)
from ...shared.assignment import ASSIGNMENT_DYNAMIC_KEY
from .resolver import parse_token, template_bindings
from .sources import async_resolve_source

_LOGGER = logging.getLogger(__name__)


def _meta(page: Any) -> dict[str, Any]:
    meta = page.get("template") if isinstance(page, dict) else None
    return meta if isinstance(meta, dict) else {}


def _part(page: dict[str, Any]) -> int:
    part = _meta(page).get("part")
    return part if isinstance(part, int) and part > 1 else 1


def _paginated_sets(pages: list[dict]) -> dict[tuple, list[dict]]:
    """Template pages grouped by ``(instance, type, page name)``, parts in order."""
    sets: dict[tuple, list[dict]] = {}
    for page in pages:
        meta = _meta(page)
        # A page made on its own, before its template paginated, is a set of
        # one: itself.
        instance = meta.get("instance", page.get("id") if _part(page) == 1 else None)
        if not meta.get("type") or instance is None:
            continue
        key = (instance, str(meta["type"]), str(meta.get("page") or ""))
        sets.setdefault(key, []).append(page)
    for parts in sets.values():
        parts.sort(key=_part)
    return sets


def _placeholder_keys(buttons: dict[str, Any], placeholder: str) -> list[str]:
    """The buttons that show one of *placeholder*'s items."""
    keys = []
    for key, value in buttons.items():
        values = value.values() if isinstance(value, dict) else [value]
        if any((parse_token(v) or ("",))[0] == placeholder for v in values):
            keys.append(key)
    return keys


def _link_keys(buttons: dict[str, Any]) -> list[str]:
    return [k for k, v in buttons.items() if isinstance(v, dict) and PAGE_LINK_KEY in v]


def _is_empty(assignment: Any) -> bool:
    return not isinstance(assignment, dict) or not assignment.get("config")


def _holds_only_items(assignment: Any) -> bool:
    """Whether a slot is empty or shows an item of its source, as made."""
    return _is_empty(assignment) or isinstance(assignment.get(ASSIGNMENT_DYNAMIC_KEY), dict)


def _is_link_or_empty(assignment: Any) -> bool:
    """Whether a slot holds what a link button writes, an item of the page's
    own source, or nothing -- never a button the user put there."""
    if _holds_only_items(assignment):
        return True
    step = assignment["config"][0] if isinstance(assignment["config"][0], dict) else {}
    return str(step.get("action") or "").endswith(".goto_page")


async def async_paginate(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    store: Any,
    *,
    page_id: int | None = None,
) -> bool:
    """Give every paginated page set the parts its items need. True if any moved.

    With *page_id*, only the set that page belongs to.
    """
    pages = await store.async_get_pages(device_id)
    changed = False
    for (instance, template_id, name), parts in _paginated_sets(pages).items():
        if page_id is not None and page_id not in {p.get("id") for p in parts}:
            continue
        template = await async_load_template(hass, template_id)
        if not isinstance(template, dict):
            continue
        defined = dict(template_pages(template_id, template))
        page_def = defined.get(name)
        placeholder = paginated_placeholder(page_def or {})
        if not placeholder:
            continue
        try:
            changed |= await _async_fit(
                hass, entry_id, device_id, store, template_id, template,
                name, page_def, placeholder, instance, parts, pages,
            )
        except Exception as exc:  # noqa: BLE001 - one set must not stop the rest
            _LOGGER.debug("Paginating %s page %r failed: %s", template_id, name, exc)
        pages = await store.async_get_pages(device_id)
    return changed


async def _async_page_source(
    hass: HomeAssistant, template_id: str, template: dict, page_def: dict,
) -> tuple[dict, dict]:
    """The page's shared part and buttons, those of a page template it names included."""
    include = str(page_def.get("template") or "")
    included = await async_load_template(hass, include) if include else None
    return page_source(template_id, template, page_def, included)


def _domain_entities(hass: HomeAssistant, target: dict) -> dict[str, str] | None:
    """The target device's entities by domain, as the page was made with.

    A device's primary entity may be a ``remote.*`` that lists nothing; a
    source then reads the device's sibling of its domain (the TV's
    ``media_player``), and so must the count and every new part.
    """
    device = str(target.get("device") or "")
    if not device:
        return None
    from homeassistant.helpers import entity_registry as er

    from ..device_entities import _resolve_device_domain_entities

    try:
        registry = er.async_get(hass)
        primary = registry.async_get(str(target.get("entity_id") or ""))
        integration = primary.platform if primary is not None else None
        return _resolve_device_domain_entities(hass, device, integration, registry) or None
    except Exception:  # noqa: BLE001 - no registry: the target alone
        return None


async def _async_count(
    hass: HomeAssistant,
    shared: dict,
    buttons: dict,
    placeholder: str,
    first: dict,
    max_items: int,
    domain_entities: dict[str, str] | None = None,
) -> int | None:
    """How many items the placeholder has now, or ``None`` if it cannot say."""
    keys = _placeholder_keys(buttons, placeholder)
    target = _meta(first).get("target") or {}
    bindings = template_bindings(
        {**shared, "buttons": dict(buttons)},
        str(target.get("entity_id") or ""), str(target.get("config_entry") or ""),
        domain_entities,
    )
    binding = next((bindings[k] for k in keys if k in bindings), None)
    if not binding:
        return None
    result = await async_resolve_source(
        hass, binding["source"], binding.get("spec") or {}, max_items=max_items,
    )
    if result.error:
        return None
    return len(result.items)


async def _async_fit(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    store: Any,
    template_id: str,
    template: dict,
    name: str,
    page_def: dict,
    placeholder: str,
    instance: int,
    parts: list[dict],
    pages: list[dict],
) -> bool:
    shared, buttons = await _async_page_source(hass, template_id, template, page_def)
    span, extra = part_items(buttons, placeholder)
    # A button with `more_parts:` shows an item on the last part only.
    more = [k for k, v in buttons.items() if has_more_parts(v)]
    item_buttons = {k: v for k, v in part_buttons(buttons, "").items() if k not in more}
    max_parts = page_max_parts(page_def)
    if span < 1:
        return False
    target = _meta(parts[0]).get("target") or {}
    domain_entities = _domain_entities(hass, target)
    count = await _async_count(
        hass, shared, item_buttons, placeholder, parts[0], span * max_parts + extra,
        domain_entities,
    )
    if count is None:
        return False
    # The last part also shows an item where the others lead on: twelve fit
    # one page, twenty-three two.
    wanted = min(max(math.ceil(max(count - extra, 0) / span), 1), max_parts)
    _LOGGER.debug(
        "%s page %r: %d items, %d part(s) wanted, %d there", template_id, name, count, wanted, len(parts),
    )

    removed = await _async_drop_empty_parts(store, device_id, item_buttons, placeholder, parts, wanted)
    if len(parts) >= wanted and not removed:
        # Nothing to add; and a part kept for a button of the user's own
        # stays as it is.
        return False

    # The ids of the set's other pages, for links such as Back to the remote.
    ids_by_name: dict[str, int] = {}
    for page in pages:
        meta = _meta(page)
        if meta.get("instance") == instance and _part(page) == 1:
            ids_by_name[str(meta.get("page") or "")] = page["id"]

    part_ids = [p["id"] for p in parts]
    reserved = await _reserved(store, device_id, pages)
    for _ in range(len(parts), wanted):
        part_ids.append(generate_page_id(reserved))
        reserved.add(part_ids[-1])

    target_entity = str(target.get("entity_id") or "")
    first_name = next(iter(dict(template_pages(template_id, template))), "")
    entry = hass.config_entries.async_get_entry(entry_id) if getattr(hass, "config_entries", None) else None

    async def compose(part: int) -> ComposedPage:
        links = dict(ids_by_name)
        links[name] = part_ids[part - 1]
        if part < len(part_ids):
            links[NEXT_PART] = part_ids[part]
        if part > 1:
            links[PREVIOUS_PART] = part_ids[part - 2]
        return await async_compose_part(
            hass, template_id, template, name, page_def, links,
            part=part, first=name == first_name,
            target_entity=target_entity, domain_entities=domain_entities,
            target_config_entry=str(target.get("config_entry") or ""),
            remote_entry=entry_id, entry=entry,
        )

    # New parts first, after the last one there is.
    new = [await compose(part) for part in range(len(parts) + 1, wanted + 1)]
    if new and "instance" not in _meta(parts[0]):
        # Its parts join it, so deleting it takes them along.
        stored = await store.async_get_pages(device_id)
        for page in stored:
            if page.get("id") == parts[0]["id"]:
                page["template"] = {**page["template"], "instance": instance}
        await store.async_set_pages(device_id, stored)
    if new:
        from ..websocket.templates import async_store_template_pages

        await async_store_template_pages(
            hass, entry_id, device_id, template_id, template, new,
            target_entity=target_entity,
            target_device=str(target.get("device") or ""),
            target_config_entry=str(target.get("config_entry") or ""),
            instance=instance,
            insert_after=parts[-1]["id"],
        )
        _LOGGER.debug(
            "%s page %r: %d items, added part(s) %s",
            template_id, name, count, [p.part for p in new],
        )

    # Then the links of the parts that were there: a new neighbour, or none --
    # and on the one now last, an item where it led on.
    for part in range(1, len(parts) + 1):
        await _async_relink(
            store, device_id, part_ids[part - 1], await compose(part),
            [*_link_keys(buttons), *more],
        )
    return bool(new) or removed


async def _async_drop_empty_parts(
    store: Any,
    device_id: str,
    buttons: dict,
    placeholder: str,
    parts: list[dict],
    wanted: int,
) -> bool:
    """Remove trailing parts past *wanted*: they hold nothing but items.

    A part a user put a button of their own on stays -- one of its item
    slots holding something that is no item of the source.
    """
    keys = _placeholder_keys(buttons, placeholder)
    drop: list[int] = []
    while len(parts) > wanted:
        last = parts[-1]
        assignments = await store.async_get_assignments(device_id, last["id"]) or {}
        if not all(_holds_only_items(assignments.get(k)) for k in keys):
            break
        drop.append(last["id"])
        parts.pop()
    if not drop:
        return False
    pages = await store.async_get_pages(device_id)
    await store.async_set_pages(device_id, [p for p in pages if p.get("id") not in drop])
    _LOGGER.debug("Removed emptied part page(s) %s", drop)
    return True


async def _async_relink(
    store: Any, device_id: str, page_id: int, composed: ComposedPage, keys: list[str],
) -> None:
    """Write a part's link buttons as *composed* has them, where they changed."""
    assignments = await store.async_get_assignments(device_id, page_id) or {}
    changed = False
    for key in keys:
        new = composed.assignments.get(key)
        if new is None or assignments.get(key) == new:
            continue
        if not _is_link_or_empty(assignments.get(key)):
            continue
        assignments[key] = new
        changed = True
    if not changed:
        return
    library = await store.async_get_action_library(device_id)
    known = {a.get("id") for a in library}
    added = [a for a in composed.actions if a.get("id") not in known]
    if added:
        await store.async_set_action_library(device_id, [*library, *added])
    await store.async_set_assignments(device_id, page_id, assignments)
    await store.async_recompute_page_hash(device_id, page_id)


async def _reserved(store: Any, device_id: str, pages: list[dict]) -> set[int]:
    from ..websocket.common import reserved_page_ids

    return await reserved_page_ids(
        store, device_id, {p["id"] for p in pages if isinstance(p, dict) and "id" in p},
    )

