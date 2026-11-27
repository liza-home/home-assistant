"""Remote platform of the IR devices entry: one remote per IR device, holding its keys."""
from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Any

from homeassistant.components.remote import (
    ATTR_DELAY_SECS,
    ATTR_NUM_REPEATS,
    DEFAULT_DELAY_SECS,
    RemoteEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .ir.device import IrDevice, ir_subentries
from .ir.sender import async_send_key, sending_remote

PARALLEL_UPDATES = 1


class IrRemote(RemoteEntity):
    """An IR device. It is a store of keys, so it is always on and shows no signals."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = None
    _attr_is_on = True

    def __init__(self, device: IrDevice) -> None:
        self._device = device
        self._attr_unique_id = device.subentry.subentry_id
        self._attr_device_info = device.device_info
        self._attr_extra_state_attributes = {"commands": [k.name for k in device.keys]}

    async def async_send_command(self, command: Iterable[str], **kwargs: Any) -> None:
        keys = list(command)
        for key in keys:
            self._device.code(key)
        remote = sending_remote(self.hass)
        repeats = max(1, int(kwargs.get(ATTR_NUM_REPEATS) or 1))
        delay = float(kwargs.get(ATTR_DELAY_SECS, DEFAULT_DELAY_SECS))
        sends = [key for _ in range(repeats) for key in keys]
        for i, key in enumerate(sends):
            if i:
                await asyncio.sleep(delay)
            await async_send_key(self.hass, self._device, key, remote, self._context)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    for subentry in ir_subentries(entry):
        async_add_entities(
            [IrRemote(IrDevice(subentry))], config_subentry_id=subentry.subentry_id,
        )
