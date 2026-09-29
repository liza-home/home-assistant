"""Sensor entities for lizaIP — diagnostic readings."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .connection import LizaIPConnection
from .entity import LizaIPEntity

PARALLEL_UPDATES = 0  # No limit — sensor entities are push-only


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data
    async_add_entities([LizaIPBatterySensor(connection, entry)])


class LizaIPBatterySensor(LizaIPEntity, SensorEntity):
    """Battery level sensor for a lizaIP device."""

    _attr_translation_key = "battery"
    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = PERCENTAGE

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_battery"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._connection.register_sensor("battery", self._handle_update)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_sensor("battery")
        await super().async_will_remove_from_hass()

    def _handle_update(self, value: float) -> None:
        self._attr_native_value = value
        self.async_write_ha_state()
