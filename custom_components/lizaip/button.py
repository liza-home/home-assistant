"""Button platform of the IR devices entry: one read-only button per configured key."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import slugify

from .ir.device import IrDevice, ir_subentries
from .ir.sender import async_send_key, sending_remote

PARALLEL_UPDATES = 1


class IrKeyButton(ButtonEntity):
    """A key of an IR device. Its name is fixed; pressing it transmits the key."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "ir_key"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, device: IrDevice, key: str) -> None:
        self._device = device
        self._key = key
        self._attr_name = key
        self._object_id = f"ir_key_{slugify(device.subentry.title)}_{slugify(key)}"
        self._attr_unique_id = f"{device.subentry.subentry_id}_{key}"
        self._attr_device_info = device.device_info

    @property
    def suggested_object_id(self) -> str:
        return self._object_id

    async def async_press(self) -> None:
        await async_send_key(
            self.hass, self._device, self._key, sending_remote(self.hass), self._context,
        )


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    for subentry in ir_subentries(entry):
        device = IrDevice(subentry)
        async_add_entities(
            [IrKeyButton(device, key.name) for key in device.keys],
            config_subentry_id=subentry.subentry_id,
        )
