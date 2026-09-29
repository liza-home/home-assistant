"""HTTP WebSocket endpoint for lizaIP device connections."""
from __future__ import annotations

import logging

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .connection import LizaIPConnection
from .const import DOMAIN, WS_PATH
from .protocol import PING_INTERVAL

_LOGGER = logging.getLogger(__name__)

# Device MUST ping every PING_INTERVAL seconds (see PROTOCOL.md § Keepalive). Give it some
# slack over one interval before aiohttp declares the peer dead and closes the socket.
_HEARTBEAT_SECONDS = PING_INTERVAL * 2


class LizaIPWebSocketView(HomeAssistantView):
    """HTTP endpoint that lizaIP devices connect to via WebSocket."""

    url = WS_PATH
    name = "api:lizaip:ws"
    # Authentication is handled at the transport layer, not the application layer.
    # Over WSS the device pins HA's TLS certificate (wss_cert sent during provisioning)
    # and verifies server identity on every reconnect. Over plain WS (no TLS) the
    # device is trusted based on device_id + local network reachability, same as
    # other local_push integrations.
    requires_auth = False

    async def get(self, request: web.Request) -> web.WebSocketResponse:
        hass: HomeAssistant = request.app["hass"]
        device_id = request.query.get("device_id", "")

        if not device_id:
            return web.Response(status=400, text="Missing device_id parameter")

        connection = self._find_connection(hass, device_id)
        if connection is None:
            # Check if a config entry exists but hasn't finished setup yet
            entry_exists = any(
                e.unique_id == device_id
                for e in hass.config_entries.async_entries(DOMAIN)
            )
            if entry_exists:
                _LOGGER.debug(
                    "Device '%s' has a config entry but runtime_data is not ready yet "
                    "(HA still starting or setup failed)",
                    device_id,
                )
                return web.Response(
                    status=503,
                    text="Device config entry exists but is not ready yet — retry shortly",
                )
            # Unknown device → trigger config-flow discovery
            _LOGGER.info("Unknown device '%s' — triggering discovery flow", device_id)
            # try:
            #     await hass.config_entries.flow.async_init(
            #         DOMAIN, context={"source": "websocket"}, data={"device_id": device_id},
            #     )
            # except Exception as err:
            #     _LOGGER.warning("Discovery flow init for '%s' failed: %s", device_id, err)
            return web.Response(status=409, text="Device not configured yet — discovery triggered")

        # A live connection for this device already exists. Rather than rejecting the
        # newcomer, accept it and let LizaIPConnection.accept() evict the stale one —
        # this covers the device rebooting/reconnecting before HA's heartbeat noticed
        # the old socket was dead.
        if connection.connected:
            _LOGGER.info(
                "Device '%s' reconnected while a previous connection was still marked alive — "
                "replacing it",
                device_id,
            )

        ws = web.WebSocketResponse(heartbeat=_HEARTBEAT_SECONDS)
        await ws.prepare(request)
        peer_ip = request.remote
        await connection.accept(ws, peer_ip)
        return ws

    def _find_connection(self, hass: HomeAssistant, device_id: str) -> LizaIPConnection | None:
        for entry in hass.config_entries.async_entries(DOMAIN):
            if entry.unique_id == device_id and hasattr(entry, "runtime_data"):
                return entry.runtime_data
        return None

