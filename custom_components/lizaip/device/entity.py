"""Shared entity base for lizaIP platforms."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo

from .connection import LizaIPConnection


class LizaIPEntity:
    """Mixin providing device info and connection-availability tracking."""

    _attr_has_entity_name = True

    def __init__(self, connection: LizaIPConnection, entry: ConfigEntry) -> None:
        self._connection = connection
        self._attr_device_info = DeviceInfo(identifiers={(entry.domain, entry.entry_id)})

    @property
    def available(self) -> bool:
        return self._connection.connected

    async def async_added_to_hass(self) -> None:
        self._connection.register_availability(self._handle_availability)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_availability(self._handle_availability)

    def _handle_availability(self, available: bool) -> None:
        self.async_write_ha_state()

