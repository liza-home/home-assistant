"""HTTP WebSocket endpoint for lizaIP device connections."""
from __future__ import annotations

import logging
from ipaddress import ip_address

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.network import is_cloud_connection

from .connection import LizaIPConnection
from ..const import DOMAIN
from ..runtime import entry_connection
from ..shared.logs import device_logger
from .const import WS_PATH
from .protocol import PING_INTERVAL

_LOGGER = logging.getLogger(__name__)

# The remote pings every PING_INTERVAL seconds once connected (PROTOCOL.md § Keepalive).
# aiohttp's heartbeat sits on top as a backstop: it pings a peer that has gone quiet and
# closes the socket if no pong follows. Two intervals keeps it from racing the remote's own.
_HEARTBEAT_SECONDS = PING_INTERVAL * 2


def _from_local_network(hass: HomeAssistant, request: web.Request) -> bool:
    """Whether *request* comes from a loopback, private or link-local address.

    ``request.remote`` is the client as Home Assistant's own HTTP setup sees
    it: behind a reverse proxy listed in ``trusted_proxies`` it is the real
    client. A request relayed by Home Assistant Cloud is never local.
    """
    if is_cloud_connection(hass):
        return False
    try:
        address = ip_address(request.remote or "")
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


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
        # A remote is on the same network as Home Assistant. Without this, the
        # MAC alone -- broadcast over mDNS -- would let anyone who reaches the
        # HTTP port from the internet take its place and press its buttons.
        if not _from_local_network(hass, request):
            _LOGGER.info(
                "Refusing a device connection from %s: not on the local network",
                request.remote,
            )
            return web.Response(status=403, text="Devices connect from the local network")

        device_id = request.query.get("device_id", "")

        if not device_id:
            return web.Response(status=400, text="Missing device_id parameter")

        connection = self._find_connection(hass, device_id)
        if connection is None:
            # Check if a config entry exists but hasn't finished setup yet
            pending = next(
                (
                    e
                    for e in hass.config_entries.async_entries(DOMAIN)
                    if e.unique_id == device_id
                ),
                None,
            )
            if pending is not None:
                device_logger(_LOGGER, pending).debug(
                    "Device '%s' has a config entry but runtime_data is not ready yet "
                    "(HA still starting or setup failed)",
                    device_id,
                )
                return web.Response(
                    status=503,
                    text="Device config entry exists but is not ready yet — retry shortly",
                )
            # Unknown device: it is set up through zeroconf discovery, not here.
            _LOGGER.info("Unknown device '%s' — not configured yet, refusing", device_id)
            return web.Response(status=409, text="Device not configured yet")

        # A live connection for this device already exists. Rather than rejecting the
        # newcomer, accept it and let LizaIPConnection.accept() evict the stale one —
        # this covers the device rebooting/reconnecting before HA's heartbeat noticed
        # the old socket was dead.
        if connection.connected:
            device_logger(_LOGGER, connection).info(
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
            if entry.unique_id == device_id and (conn := entry_connection(entry)) is not None:
                return conn
        return None

