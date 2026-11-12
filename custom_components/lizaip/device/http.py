"""What every call to the remote's HTTP(S) management API shares.

Deliberately little. The callers around them look similar but do not share a
contract: `connection` raises a translated `HomeAssistantError` because a user
pressed something and is waiting for an answer, `report` and `debug` return the
failure as *part* of the report because "this endpoint timed out" is itself a
fact about the device, and `memory` raises `ClientResponseError` because its
caller already classifies failures into a reason code. Folding those into one
helper would mean a lowest-common-denominator error contract and would make
three correct behaviours harder to see, so what is shared here is only what is
genuinely identical: how the address and session are built, and how an
exception is turned into something worth showing.
"""
from __future__ import annotations

from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

#: The remote serves its management API on the port its mDNS SRV record
#: advertises: 80 for plain HTTP by default, 443 when it speaks HTTPS.
HTTPS_PORT = 443


def device_url(host: str, port: int, path: str = "") -> str:
    """Return the URL of *path* on the remote at *host*:*port*.

    The scheme follows the port: 443 is HTTPS, anything else plain HTTP.
    """
    scheme = "https" if port == HTTPS_PORT else "http"
    return f"{scheme}://{host}:{port}{path}"


def device_session(hass: HomeAssistant) -> aiohttp.ClientSession:
    """The session for calls to a remote; its HTTPS certificate is self-signed."""
    return async_get_clientsession(hass, verify_ssl=False)


def device_base_url(conn: Any) -> str:
    """Return the base URL of *conn*'s remote, with no trailing slash.

    The port is the one from the mDNS SRV record stored at provisioning time
    and confirmed by the hello handshake -- not a constant, because a second
    remote on the same host does not get the same one.
    """
    return device_url(conn.peer_ip, conn.device_http_port)


def error_detail(err: BaseException) -> str:
    """Describe *err* in a way that is never blank.

    ``str(asyncio.TimeoutError())`` is the empty string, so the obvious
    ``f"...: {err}"`` renders as a sentence ending in a colon with nothing
    after it -- and did, in one of the four copies this replaces, until it was
    found by hand. The class name alone is a poor message but an honest one,
    so it is what an exception with nothing to say falls back to.
    """
    text = str(err)
    return f"{err.__class__.__name__}: {text}" if text else err.__class__.__name__
