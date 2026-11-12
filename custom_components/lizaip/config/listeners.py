"""Rebuilding what listens to a remote's buttons after its configuration changed.

The state listener follows the entities the buttons show; the push triggers
follow the speakers a dynamic page is bound to. Both are built from the stored
configuration, so every save that changes buttons calls these afterwards --
from the panel, the LLM tools and an entity rename alike.
"""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

from ..action_controller import setup_state_listener
from ..shared.logs import entry_id_logger
from .panel_entry import get_panel_entry

_LOGGER = logging.getLogger(__name__)


async def refresh_state_listener(hass: HomeAssistant, entry_id: str) -> None:
    """Rebuild a loaded remote's state listener after its buttons changed."""
    panel_entry = get_panel_entry(hass, entry_id)
    entry = hass.config_entries.async_get_entry(entry_id)
    if panel_entry is None or entry is None:
        return
    stop = await setup_state_listener(hass, entry)
    if get_panel_entry(hass, entry_id) is not panel_entry:
        stop()  # unloaded while the listener was being built
        return
    panel_entry.replace_state_listener(stop)


def schedule_push_rescan(hass: HomeAssistant, entry_id: str) -> None:
    """Re-subscribe push triggers after the bound speakers may have changed.

    Fire-and-forget, and guarded twice over: a re-scan is an optimisation, so
    neither a failing schedule nor a failing scan may take down the save the
    user actually asked for.
    """
    panel_entry = get_panel_entry(hass, entry_id)
    if panel_entry is None or panel_entry.push_triggers is None:
        return
    triggers = panel_entry.push_triggers

    async def _rescan() -> None:
        try:
            await triggers.async_rescan()
        except Exception as err:  # noqa: BLE001
            entry_id_logger(_LOGGER, hass, entry_id).debug(
                "Push trigger re-scan failed: %s", err,
            )

    try:
        hass.async_create_background_task(_rescan(), f"lizaip push trigger re-scan {entry_id}")
    except Exception as err:  # noqa: BLE001
        entry_id_logger(_LOGGER, hass, entry_id).debug(
            "Could not schedule push trigger re-scan: %s", err,
        )
