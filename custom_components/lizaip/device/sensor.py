"""Sensor entities for lizaIP — diagnostic readings."""
from __future__ import annotations

from homeassistant.components.sensor import (
    RestoreSensor,
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfRatio
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from ..provisioning import local_ip
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
        [
            LizaIPBatterySensor(connection, entry),
            LizaIPAddressSensor(connection, entry),
            LizaIPHomeAssistantAddressSensor(connection, entry),
        ]
    )


class LizaIPBatterySensor(LizaIPEntity, RestoreSensor):
    """Battery level sensor for a lizaIP device.

    The remote reports its level only when it changes -- about one percent an
    hour -- and cannot be asked for it. So the last reading is restored when
    Home Assistant starts; otherwise the level read "unknown" for up to an
    hour after every restart, and so did every tile showing it.
    """

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
        if self._attr_native_value is None and (last := await self.async_get_last_sensor_data()):
            self._attr_native_value = last.native_value
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


class LizaIPHomeAssistantAddressSensor(LizaIPEntity, SensorEntity):
    """The address of the Home Assistant this remote talks to.

    The mirror image of the address above: that one says where the remote is,
    this one says where *we* are. It exists because the answer is not obvious
    from the remote -- a remote shows pages, not the host serving them -- and
    because it is the first thing to check when a remote stops reaching Home
    Assistant after the host moved. Putting it on a page ("This remote") makes
    it readable on the device itself, with no app and no browser.

    The value is this host's LAN address, which is what a remote on the same
    network connects to, not the external URL a browser may use. Reading it
    opens a UDP socket to decide which interface would be used, so it is taken
    in the executor and kept, rather than computed inside `native_value`.
    """

    _attr_translation_key = "ha_address"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_ha_address"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        await self._async_refresh()

    def _handle_availability(self, available: bool) -> None:
        # A reconnect is the one moment worth re-reading at: DHCP can have moved
        # this host since startup, and the remote getting back in touch is the
        # cheapest hint that the network changed underneath us.
        if available:
            self.hass.async_create_task(self._async_refresh())
            return
        super()._handle_availability(available)

    async def _async_refresh(self) -> None:
        self._attr_native_value = await self.hass.async_add_executor_job(local_ip)
        self.async_write_ha_state()
