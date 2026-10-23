"""Answering the remote's own page queries (PROTOCOL.md §8).

A remote may ask Home Assistant what a page should contain instead of waiting
to be told, and the two queries answer the same way round as they do when HA
asks the remote: ``get_pages`` lists every page as ``page_id`` plus ``hash``,
``get_page`` returns the one page in full.

Both are answered from the very payloads :mod:`device_sync` would push --
built by :mod:`page_payload`, under the same variable scope -- so what a
remote pulls is what a sync would have written to it, and the listed ``hash``
is the one the page it can fetch will carry.

Nothing here touches ``page_cache``: a page handed out on request is not a
page known to have been applied, and recording it as written would let the
next sync skip the one page the remote may never have stored.
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from ..device.protocol import is_valid_page_id
from ..runtime import _get_store, entry_device_id
from ..shared.logs import device_logger
from .page_payload import build_page_payload, build_sync_context

_LOGGER = logging.getLogger(__name__)


async def async_page_payloads(
    hass: HomeAssistant, entry: ConfigEntry, page_id: int | None = None
) -> list[dict]:
    """The ``set_page`` payloads of *entry*'s pages, in stored order.

    With *page_id* given, the list holds that one page, or nothing at all when
    the remote asked for a page this installation does not have -- which the
    caller answers with a 404 rather than an empty page.

    Pages whose stored ``id`` is not a valid ``page_id`` are skipped, as they
    are during a sync: one hand-edited YAML file must not cost the remote every
    other page of the answer.
    """
    device_id = entry_device_id(entry)
    if not device_id:
        return []

    pages = await _get_store(hass).async_get_pages(device_id)
    wanted = [p for p in pages if is_valid_page_id(p.get("id", 1))]
    if len(wanted) != len(pages):
        device_logger(_LOGGER, entry).warning(
            "Skipping %d stored page(s) with an invalid page_id while answering "
            "the remote", len(pages) - len(wanted),
        )
    if page_id is not None:
        wanted = [p for p in wanted if p.get("id", 1) == page_id]
        if not wanted:
            return []

    # `all_pages` stays the whole list even for a single page: an internal
    # command is cross-checked against every page that exists, not against
    # the one being answered.
    ctx = await build_sync_context(hass, entry, pages)
    return [
        await build_page_payload(
            hass, entry, page.get("id", 1), page, pages, ctx=ctx,
        )
        for page in wanted
    ]


async def async_page_listing(hass: HomeAssistant, entry: ConfigEntry) -> list[dict]:
    """Every page of *entry* as ``{"page_id": ..., "hash": ...}``.

    The listing answers ``get_pages``, which is a cache check rather than a
    read: the remote compares each hash against what it holds and fetches only
    the pages that differ with ``get_page``.

    The hashes come from the built payloads, not from the stored page files.
    Those two differ -- the stored hash is the editor's, the payload's covers
    what actually goes to the remote, entity-dependent titles and all -- and a
    listing the remote cannot match against a later ``get_page`` would have it
    re-fetch everything, every time.
    """
    return [
        {"page_id": payload["page_id"], "hash": payload.get("hash")}
        for payload in await async_page_payloads(hass, entry)
    ]
