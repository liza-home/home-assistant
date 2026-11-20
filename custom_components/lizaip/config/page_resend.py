"""Resend a page when the remote opens it, so it fetches images it dropped.

The remote keeps the images of all its pages in a cache of about 400 tiles
(``tile_lru.c`` in the firmware). Past that it drops the oldest, and drawing a
page later only looks its images up there: a dropped one stays blank. Every
``set_page`` makes the remote fetch the images it is missing
(``DISPSVC_EVT__FETCH_ALL_IMAGES``), so sending the page it has just opened
again brings that page's images back.

What is sent is the copy Home Assistant last gave the remote
(``conn.page_cache.pages``), hash and all, so nothing about the page changes
and nothing is rebuilt. Per remote, on by default (``resend_on_page_open``).
"""
from __future__ import annotations

import logging
from typing import Any, Final

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later

from ..runtime import entry_connection
from ..shared.logs import device_logger
from .device_sync import is_ready

_LOGGER = logging.getLogger(__name__)

CONF_RESEND_ON_PAGE_OPEN: Final = "resend_on_page_open"
DEFAULT_RESEND_ON_PAGE_OPEN: Final = True

#: How long a page has to stay open before it is resent. Swiping through the
#: pages opens each one on the way; only the page the user stops on is sent.
RESEND_DELAY: Final = 0.5

#: Pending resends, one per remote: entry id -> cancel callback.
_pending: dict[str, CALLBACK_TYPE] = {}


def read_resend_on_page_open(options: object) -> bool:
    """Whether an entry's ``options`` resend a page when it is opened. Only a real False stops it."""
    get = getattr(options, "get", None)
    if get is None:
        return DEFAULT_RESEND_ON_PAGE_OPEN
    return get(CONF_RESEND_ON_PAGE_OPEN) is not False


@callback
def schedule_page_resend(hass: HomeAssistant, entry_id: str, page_id: Any) -> None:
    """Resend *page_id* to *entry_id*'s remote once it has stayed open a moment."""
    cancel = _pending.pop(entry_id, None)
    if cancel is not None:
        cancel()
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or not isinstance(page_id, int) or isinstance(page_id, bool):
        return
    if not read_resend_on_page_open(getattr(entry, "options", None)):
        return

    @callback
    def _fire(_now: Any) -> None:
        _pending.pop(entry_id, None)
        entry.async_create_background_task(
            hass, async_resend_page(entry, page_id), f"lizaip resend page {page_id}",
        )

    _pending[entry_id] = async_call_later(hass, RESEND_DELAY, _fire)


async def async_resend_page(entry: Any, page_id: int) -> bool:
    """Send the remote its own copy of *page_id* again; whether it went out.

    Skipped while a sync holds the page lock -- it is writing the pages anyway --
    and for a page the remote's copy of is not known.
    """
    conn = entry_connection(entry)
    if not is_ready(conn):
        return False
    cache = conn.page_cache
    if cache.lock.locked():
        return False
    payload = (cache.pages or {}).get(page_id)
    if not payload:
        return False
    log = device_logger(_LOGGER, entry)
    async with cache.lock:
        try:
            await conn.set_page(**{**payload, "page_id": page_id})
        except Exception as err:  # noqa: BLE001 - a missed resend only leaves the tiles blank
            log.debug("Resending page %s on open failed: %s", page_id, err)
            return False
    log.debug("Resent page %s on open", page_id)
    return True


@callback
def cancel_page_resend(entry_id: str) -> None:
    """Drop a resend still waiting for *entry_id* (the entry is unloading)."""
    cancel = _pending.pop(entry_id, None)
    if cancel is not None:
        cancel()
