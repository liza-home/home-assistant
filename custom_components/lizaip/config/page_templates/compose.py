"""Turn one template into the pages it describes, without writing anything.

A template file may describe more than one page: its own, and any it lists
under ``pages:``. A generic remote brings a cursor page with digits and
shortcuts behind it; a speaker brings now-playing with playlists and radio.
The pages are made together because they refer to each other — a button that
sends the remote to another page needs that page's id, which exists only once
the whole set is being made.

This module is the half that has no opinion about storage: it is given the ids
the pages will have, and returns what each page should contain. Adding a
template writes that out; the placeholder pages a remote with none is shown
keep it in memory.
"""
from __future__ import annotations

import asyncio

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from homeassistant.core import HomeAssistant

from ...shared.i18n import get_ui_language, page_titles, translate_fallback, translate_key
from .generate import (
    async_load_template,
    generate_assignments,
    page_source,
    page_buttons,
    NEXT_PART,
    paginated_placeholder,
    part_buttons,
    template_pages,
)
from .resolver import resolve_template_variables

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ComposedPage:
    """One page of a template, resolved and ready to be stored or sent."""

    #: Its name inside the template; empty for the blank page.
    name: str
    page_id: int
    title: str
    subpage: bool = False
    #: Action-library entries the page's buttons refer to.
    actions: list[dict] = field(default_factory=list)
    assignments: dict[str, dict] = field(default_factory=dict)
    #: Which repeat of a paginated page this is; 1 for every other page.
    part: int = 1


async def async_compose_pages(
    hass: HomeAssistant,
    template_id: str,
    template: dict[str, Any],
    page_ids: list[int],
    *,
    target_entity: str = "",
    domain_entities: dict[str, str] | None = None,
    target_config_entry: str = "",
    remote_entry: str = "",
    entry: Any = None,
    fallback_title: str | None = None,
) -> list[ComposedPage]:
    """Resolve *template* into one :class:`ComposedPage` per id it was given.

    ``page_ids`` is as long as :func:`template_pages`, in the same order, so
    the links between the pages can be written before any of them exists.
    ``fallback_title`` heads the first page when it states no title of its
    own -- the template's icon, as the add-page dialog shows it; *entry* is
    the remote the pages are for, which says what language to head them in.
    """
    pages = template_pages(template_id, template)
    ids_by_name = {name: page_ids[i] for i, (name, _) in enumerate(pages)}

    # Side by side: each page may browse the device (a speaker's favourites,
    # its playlists, its radio), and the pages do not depend on one another.
    # A paginated page starts as its first part; a refresh adds the rest once
    # it has counted the items.
    return list(await asyncio.gather(*(
        async_compose_part(
            hass, template_id, template, name, page, ids_by_name,
            first=index == 0,
            target_entity=target_entity, domain_entities=domain_entities,
            target_config_entry=target_config_entry, remote_entry=remote_entry,
            entry=entry, fallback_title=fallback_title if index == 0 else None,
        )
        for index, (name, page) in enumerate(pages)
    )))


async def async_compose_part(
    hass: HomeAssistant,
    template_id: str,
    template: dict[str, Any],
    name: str,
    page: dict[str, Any],
    ids_by_name: dict[str, int],
    *,
    part: int = 1,
    first: bool = False,
    target_entity: str = "",
    domain_entities: dict[str, str] | None = None,
    target_config_entry: str = "",
    remote_entry: str = "",
    entry: Any = None,
    fallback_title: str | None = None,
) -> ComposedPage:
    """Compose one page of *template* -- part *part* of it, if it paginates.

    *ids_by_name* gives every page of the set its id, this one included under
    *name*, and the neighbouring parts under ``next`` and ``previous`` where
    they exist.
    """
    started = time.monotonic()
    include = str(page.get("template") or "")
    included = await async_load_template(hass, include) if include else None
    page_shared, buttons = page_source(template_id, template, page, included)
    buttons = part_buttons(
        buttons, paginated_placeholder(page), part, last=NEXT_PART not in ids_by_name,
    )
    page_template = {
        **page_shared,
        "buttons": page_buttons(
            buttons, ids_by_name, template_id=template_id, page_name=name,
        ),
    }
    title = part_title(_page_title(hass, entry, page, page_shared, fallback_title), part)
    page_template = await resolve_template_variables(
        hass, page_template, target_entity, domain_entities,
        target_config_entry, remote_entry=remote_entry,
    )
    actions, assignments = generate_assignments(
        template_id, target_entity, page_template, domain_entities, hass,
    )
    _LOGGER.debug(
        "Composed page %r (part %d) of %s in %.2f s",
        name, part, template_id, time.monotonic() - started,
    )
    return ComposedPage(
        name=name,
        page_id=ids_by_name[name],
        title=title,
        # The page the remote lands on is the first one, whatever it is
        # called, and is never a subpage.
        subpage=not first and bool(page.get("subpage")),
        actions=actions,
        assignments=assignments,
        part=part,
    )


def part_title(title: str, part: int) -> str:
    """A part's title: the page's, numbered from the second part on."""
    return f"{title} {part}" if part > 1 and title else title


def _page_title(
    hass: HomeAssistant,
    entry: Any,
    page: dict[str, Any],
    shared: dict[str, Any],
    fallback: str | None,
) -> str:
    """A page's title strip, before its variables are expanded.

    The page states it, or the template it names does for its own first page.
    ``{translate: <key>}`` names an entry in the shipped page titles instead,
    so a page is headed in the language the remote is set to. A page that
    says nothing gets *fallback*, or no title. Presence, not truth: an empty
    ``title`` is a page that wants no title.
    """
    for source in (page, shared):
        if "title" not in source:
            continue
        value = source["title"]
        key = translate_key(value)
        if key:
            title = page_titles.get(key, get_ui_language(hass, entry))
            title = title or translate_fallback(value, "")
            return f"text:{title}" if title else ""
        return "" if isinstance(value, dict) else str(value or "")
    return fallback or ""
