"""Which lizaIP transmits an IR key, and the logbook line for a sent key."""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import entity_registry as er

from ..const import DOMAIN
from ..runtime import entry_connection, remote_entries
from .device import IrDevice

# The remote whose button is being pressed: ``remote.send_command`` cannot name one.
pressing_entry_id: ContextVar[str | None] = ContextVar("lizaip_pressing_entry_id", default=None)


def sending_remote(hass: HomeAssistant) -> ConfigEntry:
    """The remote of the running button press, else the only connected remote."""
    if (entry_id := pressing_entry_id.get()) is not None:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is not None:
            return entry
    connected = [
        e for e in remote_entries(hass)
        if (conn := entry_connection(e)) is not None and conn.connected
    ]
    if len(connected) == 1:
        return connected[0]
    raise ServiceValidationError(
        translation_domain=DOMAIN, translation_key="ir_remote_ambiguous",
    )


async def async_send_key(
    hass: HomeAssistant, device: IrDevice, key: str, remote: ConfigEntry, context: Context | None,
) -> None:
    """Transmit *key* through *remote* and log it with both names."""
    await device.async_send(key, via=remote)
    event: dict[str, Any] = {
        "name": device.subentry.title,
        "message": f"sent IR key {key} via {remote.title}",
        "domain": DOMAIN,
    }
    if entity_id := er.async_get(hass).async_get_entity_id(
        "remote", DOMAIN, device.subentry.subentry_id,
    ):
        event["entity_id"] = entity_id
    hass.bus.async_fire("logbook_entry", event, context=context)
