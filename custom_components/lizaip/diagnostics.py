"""Diagnostics support for the lizaIP integration."""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .config.layouts import refresh as layout_refresh
from .device.connection import LizaIPConnection


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: ConfigEntry,
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    connection: LizaIPConnection = entry.runtime_data

    return {
        "entry": {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "unique_id": entry.unique_id,
            "version": entry.version,
            "data": {
                "sw_version": entry.data.get("sw_version"),
            },
        },
        "device": {
            "connected": connection.connected,
            "protocol_version": connection.device_protocol_version,
            "device_version": connection.device_version,
            "device_mac": connection.device_mac,
        },
        "capabilities": connection.last_discovery,
        # A stale binding is invisible on the remote, so this is the one place
        # the count is actually legible.
        "dynamic": await layout_refresh.async_binding_summary(hass, entry.entry_id),
    }

