"""Constants for the lizaIP device sub-package."""
from typing import Final

from ..const import DOMAIN  # noqa: F401 — re-exported; canonical definition lives in the root const

LIZAIP_EVENT: Final = "lizaip_event"
LIZAIP_HELLO_EVENT: Final = "lizaip_device_hello"  # fired after hello handshake — triggers config sync
#: Fired on both edges of the device's WebSocket, carrying ``entry_id`` and
#: ``connected``. The hello event cannot stand in for it: hello only fires on
#: the way up, and only once the handshake succeeded, so nothing on the bus
#: said a device had dropped. The config panel draws an online badge and needs
#: both edges.
LIZAIP_AVAILABILITY_EVENT: Final = "lizaip_device_availability"
MANUFACTURER: Final = "ruwido austria GmbH"
MODEL: Final = "lizaIP"
# Hardware product SKU — matches the firmware release channel at
# https://firmware.api.ruwido.com/<MODEL_ID>/
MODEL_ID: Final = "3029-000"
ZEROCONF_SERVICE_TYPE: Final = "_lizaip._tcp.local."

WS_PATH: Final = "/api/lizaip/ws"

#: TCP port the firmware opens for its debug log stream once
#: ``Device.Control.DebugPort`` is switched on. Fixed in firmware, so it is a
#: constant rather than something discovered or configured.
DEBUG_LOG_PORT: Final = 37246


