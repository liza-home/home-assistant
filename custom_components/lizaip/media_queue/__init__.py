"""What plays next on a Sonos speaker, as ``${_queue.next_song}`` and friends.

- :mod:`.queue` -- reading the queue, and which track is either side.
- :mod:`.sensor` -- the result, as an ordinary entity, so that
  :mod:`.alias` can make ``${_queue.next_song}`` a plain variable.
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

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
    from ..action_controller.helpers import (
        _get_assignments,
        _get_store,
        _resolve_device_id,
        resolve_target_entities,
    )
    from ..action_controller.toggle import toggle_rules
    from ..const import DOMAIN

    targets: set[str] = set()
    store = _get_store(hass)
    for entry in hass.config_entries.async_entries(DOMAIN):
        try:
            device_id = _resolve_device_id(hass, entry.entry_id)
            if not device_id:
                continue
            for page in await store.async_get_pages(device_id):
                page_id = page.get("id", 1)
                # The page's own player, for `${_device.media_title_prev}`.
                layout_target = (page.get("layout") or {}).get("target") or {}
                if isinstance(layout_target.get("entity_id"), str):
                    targets.add(layout_target["entity_id"])
                for _button, assign in await _get_assignments(hass, device_id, page_id):
                    for config in _configs(assign, toggle_rules):
                        targets.update(resolve_target_entities(config, hass))
        except Exception as err:  # noqa: BLE001 - discovery must never break setup
            _LOGGER.debug("Queue sensors: cannot read %s: %s", entry.entry_id, err)

    return {
        entity_id
        for entity_id in targets
        if entity_id.startswith("media_player.")
    }


def _configs(assign, toggle_rules):
    """The first step of the assignment, and of each of its cycle rules.

    A cycle rule may point at a different speaker from the button it sits on,
    and its own label reads that one.
    """
    config = assign.get("config") if isinstance(assign, dict) else None
    if isinstance(config, list) and config:
        yield config[0]
    for rule in toggle_rules(assign):
        rule_config = rule.get("config")
        if isinstance(rule_config, list) and rule_config:
            yield rule_config[0]


async def async_sync_sensors(hass: HomeAssistant) -> None:
    """Make the live queue sensors match what the buttons point at.

    Safe to call whenever the config may have changed; a no-op until some
    entry's sensor platform is set up.
    """
    from .sensor import async_sync

    try:
        await async_sync(hass, await async_queue_targets(hass))
    except Exception as err:  # noqa: BLE001 - a tooltip must never raise
        _LOGGER.debug("Queue sensors: cannot sync: %s", err)
