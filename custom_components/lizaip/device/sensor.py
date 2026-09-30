"""Sensor entities for lizaIP — diagnostic readings."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfRatio
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
    async_add_entities(
        [LizaIPBatterySensor(connection, entry), LizaIPAddressSensor(connection, entry)]
    )


class LizaIPBatterySensor(LizaIPEntity, SensorEntity):
    """Battery level sensor for a lizaIP device."""

    _attr_translation_key = "battery"
    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = UnitOfRatio.PERCENTAGE

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


class LizaIPAddressSensor(LizaIPEntity, SensorEntity):
    """The address the remote is connected from.

    Home Assistant's device page has no field for an address, and an
    integration cannot add one -- a diagnostic entity is the supported way to
    put a fact about the device on that page, and it lands in the Diagnostic
    section beside the battery reading.

    There is no polling and no request: the remote dials us, so the address is
    simply the peer of the socket it opened. That also makes it the honest
    answer for a device behind DHCP, which a value copied from the config entry
    at setup would not be.
    """

    _attr_translation_key = "ip_address"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_ip_address"

    @property
    def native_value(self) -> str | None:
        # Read live rather than cached on the availability edge: the base class
        # already re-renders the entity on both edges, and `accept` assigns the
        # peer before announcing the connection, so the value is current by the
        # time anything asks for it.
        return self._connection.peer_ip
