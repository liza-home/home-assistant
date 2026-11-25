"""An IR device: a config subentry of the IR devices entry.

Its code set is stored with the subentry, so a key works without the
catalogue. It has no entities: a key is sent by a device action or
``lizaip.send_ir``, always through the one remote it names.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Final

from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.device_registry import DeviceInfo

from ..const import DOMAIN
from ..device.protocol import ProtocolError
from ..runtime import entry_connection
from ..shared.logs import device_logger
from . import blob as ir_blob
from .keys import KEYS, IrKey

_LOGGER = logging.getLogger(__name__)

SUBENTRY_TYPE: Final = "ir_device"

CONF_TYPE: Final = "type_id"
CONF_BRAND: Final = "brand_id"
CONF_BRAND_NAME: Final = "brand_name"
CONF_CODE_SET: Final = "code_set_id"
CONF_KEYS: Final = "keys"
CONF_BLOB: Final = "code_set_blob"
#: Key name → base64 signal of an IR device whose codes were entered by hand.
CONF_CODES: Final = "custom_codes"
#: The ``type_id`` of such a device.
TYPE_CUSTOM: Final = "custom"
#: The catalogue's television type, the only one offered.
TYPE_TELEVISION: Final = "1"


def ir_subentries(entry: ConfigEntry) -> list[ConfigSubentry]:
    """The IR devices configured on *entry*."""
    return [
        sub for sub in entry.subentries.values() if sub.subentry_type == SUBENTRY_TYPE
    ]


def device_keys(data: Mapping[str, Any]) -> tuple[IrKey, ...]:
    """The keys of a device: the catalogue's in its table's order, then its own."""
    custom = data.get(CONF_CODES) or {}
    names = set(data.get(CONF_KEYS) or ())
    return (
        *(key for name, key in KEYS.items() if name in names and name not in custom),
        *(IrKey(name, 0) for name in custom),
    )


class IrDevice:
    """Sends the keys of one IR device through a remote."""

    def __init__(self, subentry: ConfigSubentry) -> None:
        self.subentry = subentry
        self.keys = device_keys(subentry.data)
        self._codes: Mapping[str, str] = subentry.data.get(CONF_CODES) or {}
        blob = subentry.data.get(CONF_BLOB)
        self._blob = ir_blob.decode(blob) if blob else b""

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self.subentry.subentry_id)},
            name=self.subentry.title,
            manufacturer=self.subentry.data.get(CONF_BRAND_NAME),
            model_id=SUBENTRY_TYPE,
        )

    def code(self, name: str) -> str:
        """The base64 signal of the key *name* (``power``, ``cursor_up`` …)."""
        if name in self._codes:
            return self._codes[name]
        key = KEYS.get(name)
        if key is None or key not in self.keys:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="ir_unknown_key",
                translation_placeholders={"key": name, "device": self.subentry.title},
            )
        try:
            return ir_blob.for_key(self._blob, key.key_id)
        except ir_blob.IrBlobError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="ir_catalog_unavailable",
                translation_placeholders={"error": str(err)},
            ) from err

    async def async_send(self, name: str, via: ConfigEntry) -> None:
        """Transmit the key *name* through the remote *via*."""
        code = self.code(name)
        connection = entry_connection(via)
        if connection is None or not connection.connected:
            raise HomeAssistantError(translation_domain=DOMAIN, translation_key="not_connected")
        log = device_logger(_LOGGER, via)
        log.debug("send_ir %s/%s", self.subentry.title, name)
        try:
            await connection.send_ir(code)
        except ProtocolError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="ir_send_refused",
                translation_placeholders={"error": str(err)},
            ) from err
