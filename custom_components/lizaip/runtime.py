"""Lookups into the integration's live runtime state.

A leaf module on purpose: both ``action_controller`` and ``config`` need these,
and defining them here is what keeps the dependency between those two packages
one-directional.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant

from .const import DOMAIN

if TYPE_CHECKING:
    from .config.store import LizaRemoteStore


def _get_store(hass: HomeAssistant) -> LizaRemoteStore:
    """Get the shared store instance."""
    return hass.data[DOMAIN]["_store"]


def _resolve_device_id(hass: HomeAssistant, entry_id: str) -> str | None:
    """Resolve entry_id to device_id.

    The ``getattr`` guards matter: an entry whose runtime data exists but has
    not finished setting up yet has no ``_device_id``, and reading through it
    would raise rather than report "no device".
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is not None and getattr(entry, "runtime_data", None):
        return getattr(entry.runtime_data, "_device_id", None)
    return None
