"""Constants for the lizaIP device sub-package."""
from typing import Final

from ..const import DOMAIN  # noqa: F401 — re-exported; canonical definition lives in the root const

LIZAIP_EVENT: Final = "lizaip_event"
LIZAIP_HELLO_EVENT: Final = "lizaip_device_hello"  # fired after hello handshake — triggers config sync
MANUFACTURER: Final = "ruwido austria GmbH"
MODEL: Final = "lizaIP"
# Hardware product SKU — matches the firmware release channel at
# https://firmware.api.ruwido.com/<MODEL_ID>/
MODEL_ID: Final = "3029-000"
ZEROCONF_SERVICE_TYPE: Final = "_lizaip._tcp.local."

WS_PATH: Final = "/api/lizaip/ws"


