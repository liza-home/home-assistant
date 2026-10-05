"""Keeping entity variables in tooltips and icons current on the remote.

A button tooltip or icon, or a page title, may name an entity -- ``Outside ${sensor.outdoor}``,
``mdi:weather-${weather.home}`` -- and the page payload carries its current
value. The value moves, so the payload does too: when a named entity changes,
the page is rebuilt and the device sync's hash diff sends exactly the pages
whose text or icon actually changed.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback

from ..action_controller.helpers import _get_store, _resolve_device_id
from ..const import entity_token_entities
from .const import CONFIG_CHANGED_EVENT

_LOGGER = logging.getLogger(__name__)

# A sensor reporting every second must not resend its page every second. The
# first change opens the window; every change inside it rides along.
VARIABLE_THROTTLE_SECONDS = 2.0

_VARIABLE_FIELDS = ("label", "image")


def assignment_variable_entities(assign) -> set[str]:
    """Every entity a button's tooltip or icon names, its overrides included."""
    if not isinstance(assign, dict):
        return set()
    found: set[str] = set()
    for key in _VARIABLE_FIELDS:
        found |= entity_token_entities(assign.get(key))
    overrides = assign.get("overrides")
    if isinstance(overrides, dict):
        for override in overrides.values():
            if isinstance(override, dict):
                for key in _VARIABLE_FIELDS:
                    found |= entity_token_entities(override.get(key))
    return found


async def async_variable_entities(hass: HomeAssistant, device_id: str) -> set[str]:
    """Every entity named by a variable anywhere on the device's pages.

    The page title counts as well as every button.
    """
    store = _get_store(hass)
    found: set[str] = set()
    for page in await store.async_get_pages(device_id):
        if not isinstance(page, dict):
            continue
        found |= entity_token_entities(page.get("image"))
        assignments = await store.async_get_assignments(device_id, page.get("id", 1))
        for assign in (assignments or {}).values():
            found |= assignment_variable_entities(assign)
    return found


async def async_setup_variable_listener(
    hass: HomeAssistant,
    entry: ConfigEntry,
    sync: Callable,
) -> Callable[[], None]:
    """Resync the device whenever an entity a variable names changes.

    *sync* is ``device_sync.sync_config_to_device``; passed in so this module
    stays below ``device_sync`` in the import graph. Returns a cleanup callable.
    """
    watched: set[str] = set()
    timer: list[asyncio.TimerHandle | None] = [None]

    async def _refresh_watched() -> None:
        watched.clear()
        # Resolved on every refresh: on a first boot the device may only be
        # registered after this listener was set up.
        try:
            device_id = _resolve_device_id(hass, entry.entry_id)
            if device_id:
                watched.update(await async_variable_entities(hass, device_id))
        except Exception as err:  # noqa: BLE001 - live values must never break setup
            _LOGGER.debug("Variable listener: cannot read pages: %s", err)
        _LOGGER.debug("Variable listener: watching %s", sorted(watched))

    await _refresh_watched()

    @callback
    def _flush() -> None:
        timer[0] = None
        hass.async_create_task(sync(hass, entry))

    @callback
    def _on_state_change(event: Event) -> None:
        if event.data.get("entity_id") not in watched or timer[0] is not None:
            return
        timer[0] = hass.loop.call_later(VARIABLE_THROTTLE_SECONDS, _flush)

    async def _on_config_changed(event: Event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            await _refresh_watched()

    unsubs = [
        hass.bus.async_listen(EVENT_STATE_CHANGED, _on_state_change),
        hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed),
    ]

    def _cleanup() -> None:
        for unsub in unsubs:
            unsub()
        if timer[0] is not None:
            timer[0].cancel()
            timer[0] = None
        watched.clear()

    return _cleanup
