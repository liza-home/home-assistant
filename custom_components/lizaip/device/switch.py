"""Switch entities for lizaIP device controls."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .connection import LizaIPConnection
from .entity import LizaIPEntity

PARALLEL_UPDATES = 1


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data
    async_add_entities([LizaIPBrightnessAutomatic(connection, entry)])


class LizaIPBrightnessAutomatic(LizaIPEntity, SwitchEntity):
    """Toggle automatic brightness mode on the device."""

    _attr_translation_key = "brightness_automatic"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:brightness-auto"

    def __init__(self, connection: LizaIPConnection, entry: ConfigEntry) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_brightness_automatic"
        self._attr_is_on = connection.brightness_automatic

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._connection.register_brightness(self._handle_brightness_state)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_brightness(self._handle_brightness_state)
        await super().async_will_remove_from_hass()

    def _handle_brightness_state(self, value: float, automatic: bool) -> None:
        self._attr_is_on = automatic
        self._attr_extra_state_attributes = {"device_brightness": int(round(value))}
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs) -> None:
        await self._connection.set_brightness(-1)

    async def async_turn_off(self, **kwargs) -> None:
        await self._connection.set_brightness(self._connection.brightness_value)

