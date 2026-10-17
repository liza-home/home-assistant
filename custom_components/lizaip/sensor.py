"""Sensor platform for lizaIP — the device's own readings, and queue sensors."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .device.sensor import async_setup_entry as _async_setup_device_sensors
from .media_queue.sensor import async_setup_entry as _async_claim_queue_sensors


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    await _async_setup_device_sensors(hass, entry, async_add_entities)
    # Claims ownership only; the sensors themselves are added once the config
    # has been read and the speakers the buttons point at are known.
    await _async_claim_queue_sensors(hass, entry, async_add_entities)
