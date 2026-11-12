"""Binary sensor entities for lizaIP — diagnostic readings from the device."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .connection import LizaIPConnection
from .entity import LizaIPEntity

PARALLEL_UPDATES = 0  # Push-only — the device sends events, we never poll.


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data.connection
    async_add_entities([
        LizaIPInHandSensor(connection, entry),
        LizaIPChargingSensor(connection, entry),
    ])


class LizaIPInHandSensor(LizaIPEntity, BinarySensorEntity):
    """Whether the remote is currently being held (proximity / accelerometer).

    The device sends ``diag`` events with ``diag=in_hand`` and ``value=0|1``.
    Diagnostic category: this is a hardware signal, not a user-facing control.
    """

    _attr_translation_key = "in_hand"
    # Keep this sensor generic so HA does not map its state to home/away.
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def icon(self) -> str:
        """Return hand icon based on state."""
        if self._attr_is_on:
            return "mdi:hand-back-left"
        return "mdi:hand-back-left-off"

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_in_hand"
        # Unknown until the first event arrives — HA shows "Unknown" rather
        # than a stale False that looks like the device is on the table.
        self._attr_is_on: bool | None = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._connection.register_sensor("in_hand", self._handle_update))


    def _handle_update(self, value: float) -> None:
        self._attr_is_on = bool(value)
        self.async_write_ha_state()


class LizaIPChargingSensor(LizaIPEntity, BinarySensorEntity, RestoreEntity):
    """Whether the remote is currently charging.

    The device sends ``diag`` events with ``diag=charging`` and ``value=0|1``,
    only when it changes, so the last one is restored when Home Assistant
    starts rather than reading "unknown" until the next.
    """

    _attr_translation_key = "charging"
    _attr_device_class = BinarySensorDeviceClass.BATTERY_CHARGING

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_charging"
        self._attr_is_on: bool | None = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self._attr_is_on is None and (last := await self.async_get_last_state()):
            if last.state in ("on", "off"):
                self._attr_is_on = last.state == "on"
        self.async_on_remove(self._connection.register_sensor("charging", self._handle_update))


    def _handle_update(self, value: float) -> None:
        self._attr_is_on = bool(value)
        self.async_write_ha_state()


