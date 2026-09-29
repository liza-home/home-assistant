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

from .connection import LizaIPConnection
from .entity import LizaIPEntity

PARALLEL_UPDATES = 0  # Push-only — the device sends events, we never poll.


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data
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
        self._connection.register_sensor("in_hand", self._handle_update)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_sensor("in_hand")
        await super().async_will_remove_from_hass()

    def _handle_update(self, value: float) -> None:
        self._attr_is_on = bool(value)
        self.async_write_ha_state()


class LizaIPChargingSensor(LizaIPEntity, BinarySensorEntity):
    """Whether the remote is currently charging.

    The device sends ``diag`` events with ``diag=charging`` and ``value=0|1``.
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
        self._connection.register_sensor("charging", self._handle_update)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_sensor("charging")
        await super().async_will_remove_from_hass()

    def _handle_update(self, value: float) -> None:
        self._attr_is_on = bool(value)
        self.async_write_ha_state()


