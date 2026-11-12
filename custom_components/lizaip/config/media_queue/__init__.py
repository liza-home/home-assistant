"""What plays next on a Sonos speaker, as ``${_queue.next_song}`` and friends.

- :mod:`.queue` -- reading the queue, and which track is either side.
- :mod:`.sensor` -- the result, as an ordinary entity, so that
  :mod:`.alias` can make ``${_queue.next_song}`` a plain variable.
"""

from __future__ import annotations

import asyncio
import logging

from homeassistant.core import HomeAssistant

from ...shared.logs import device_logger
from .alias import QUEUE_ALIAS_RE, expand_queue_alias, queue_entity_id
from .queue import QUEUE_KEYS

__all__ = [
    "QUEUE_ALIAS_RE",
    "QUEUE_KEYS",
    "async_queue_targets",
    "async_sync_sensors",
    "expand_queue_alias",
    "queue_entity_id",
]

_LOGGER = logging.getLogger(__name__)


async def async_queue_targets(hass: HomeAssistant) -> set[str]:
    """Every media player a button points at, across every remote.

    Membership is the button's *target*, not whether a ``${_queue.x}`` token
    happens to be on it today. A sensor that only appears once the token is
    typed would not be there for the panel to offer, or for the preview to
    read, at the moment the user is choosing it.
    """
    from ...action_controller.helpers import resolve_target_entities
    from ...runtime import get_assignments, get_store, resolve_device_id
    from ...action_controller.toggle import representative_steps
    from ...const import DEFAULT_PAGE_ID, DOMAIN

    targets: set[str] = set()
    store = get_store(hass)
    for entry in hass.config_entries.async_entries(DOMAIN):
        try:
            device_id = resolve_device_id(hass, entry.entry_id)
            if not device_id:
                continue
            for page in await store.async_get_pages(device_id):
                page_id = page.get("id", DEFAULT_PAGE_ID)
                # The page's own player, for `${_device.media_title_prev}`.
                template_target = (page.get("template") or {}).get("target") or {}
                if isinstance(template_target.get("entity_id"), str):
                    targets.add(template_target["entity_id"])
                for _button, assign in await get_assignments(hass, device_id, page_id):
                    for config in representative_steps(assign):
                        targets.update(resolve_target_entities(config, hass))
        except Exception as err:  # noqa: BLE001 - discovery must never break setup
            device_logger(_LOGGER, entry).debug(
                "Queue sensors: cannot read the configuration: %s", err,
            )

    return {
        entity_id
        for entity_id in targets
        if entity_id.startswith("media_player.")
    }


async def async_sync_sensors(hass: HomeAssistant) -> None:
    """Make the live queue sensors match what the buttons point at.

    Safe to call whenever the config may have changed; a no-op until some
    entry's sensor platform is set up.
    """
    from .sensor import async_sync

    # Every loaded remote calls this on the same config change. Calls that
    # arrive while a scan runs share the one scan after it, and each call
    # still returns only once a scan begun after it has finished.
    state = hass.data.get(_SYNC_STATE)
    if state is None:
        state = hass.data[_SYNC_STATE] = _SyncState()
    state.requested += 1
    ticket = state.requested
    async with state.lock:
        if state.covered >= ticket:
            return
        state.covered = state.requested
        try:
            await async_sync(hass, await async_queue_targets(hass))
        except Exception as err:  # noqa: BLE001 - a tooltip must never raise
            _LOGGER.debug("Queue sensors: cannot sync: %s", err)


class _SyncState:
    """How many syncs were asked for, and how many the last scan covered."""

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.requested = 0
        self.covered = 0


_SYNC_STATE = "lizaip_media_queue_sync"
