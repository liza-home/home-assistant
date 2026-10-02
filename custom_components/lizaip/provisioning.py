"""Telling a remote where Home Assistant is.

The remote builds its connection as ``wss://<ha_hostname>:<ha_port>/api/lizaip/ws``,
so those two values are the whole of how it finds us. They are written over the
device's own HTTP management API (``POST /api/config/ha``), which means the
repair only ever happens in one direction: Home Assistant has to reach the
device.

That is why this lives in a module of its own rather than inside the config
flow. Discovery is not the only moment we can reach a remote, and for a
battery-powered one it is the *least* reliable: a sleeping device answers no
HTTP at all, and an mDNS record that outlived its address sends provisioning to
a host that is not there. The moment that does work is the one the device
chooses — when it opens its WebSocket, Home Assistant learns its real address
from the connection itself and can repair it there.

Both callers need the same two answers (what to send, and what the device
currently holds), and two copies of that would be two chances to disagree.
"""
from __future__ import annotations

import importlib
import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urlparse

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.network import get_url

from .device.cert import get_ha_certificate_pem

_LOGGER = logging.getLogger(__name__)

PROVISION_TIMEOUT = aiohttp.ClientTimeout(total=5)

#: The remote's HTTP management port.
DEVICE_HTTP_PORT = 80

# Last-resort name when HA's own hostname cannot be determined. Not unique —
# only correct on a single-HA network — so it is used strictly as a fallback.
FALLBACK_HA_HOSTNAME = "homeassistant.local"

# Last-resort port, used only when the running server cannot be read either.
# It is a guess, and on a Supervisor install a wrong one -- see `server_port()`.
LAST_RESORT_HA_PORT = 8123

# The port a URL means when it does not say one. Home Assistant normalizes its
# configured URLs through `homeassistant.util.network.normalize_url`, which
# *strips* a port that is the scheme's default -- so "http://ha.example.com"
# is not a URL with an unknown port, it is one that provably means 80.
#
# Reading 8123 into it would be the integration's own default speaking, not the
# deployment's: it is where Home Assistant listens when nobody put anything in
# front of it, and a URL naming that port keeps it here because 8123 is not a
# default that normalization removes. A portless http URL is the reverse-proxy
# case, and 8123 is exactly where the proxy is not.
#
# Where there is no URL at all to read a scheme from, the answer comes from the
# running server instead -- see `server_port()`.
SCHEME_PORTS = {"http": 80, "https": 443}

# HAOS/Supervisor advertises the host over mDNS as "<hostname>.local".
MDNS_DOMAIN = ".local"

# Nabu Casa remote UI. A public relay requiring cloud auth — never routable for
# a device on the LAN, so it must never be handed out as ha_hostname.
CLOUD_DOMAIN = ".ui.nabu.casa"


# ---------------------------------------------------------------------------
# Host facts
# ---------------------------------------------------------------------------


def is_ip(hostname: str) -> bool:
    """True when *hostname* is a bare IPv4/IPv6 literal."""
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return True


def local_ip() -> str | None:
    """This HA host's LAN address, as seen from the local network."""
    for family, probe in ((socket.AF_INET, "10.255.255.255"), (socket.AF_INET6, "fe80::1")):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                sock.settimeout(0)
                sock.connect((probe, 1))
                addr = sock.getsockname()[0]
        except OSError:
            continue
        if addr and not ipaddress.ip_address(addr).is_loopback:
            return addr
    return None


def resolve_all(hostname: str) -> set[str]:
    """Every address *hostname* currently resolves to, or an empty set."""
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return set()
    return {info[4][0] for info in infos}


def supervisor_api() -> tuple[Any, Any]:
    """Resolve ``(is_hassio, get_host_info)`` across HA versions."""
    is_hassio = get_host_info = None
    for module in ("homeassistant.helpers.hassio", "homeassistant.components.hassio"):
        try:
            mod = importlib.import_module(module)
        except ImportError:
            continue
        is_hassio = is_hassio or getattr(mod, "is_hassio", None)
        get_host_info = get_host_info or getattr(mod, "get_host_info", None)

    if not (is_hassio and get_host_info):
        _LOGGER.debug(
            "Supervisor API unavailable (is_hassio=%s, get_host_info=%s)",
            bool(is_hassio), bool(get_host_info),
        )
    return is_hassio, get_host_info


# ---------------------------------------------------------------------------
# HA address resolution — what we send to the device
# ---------------------------------------------------------------------------


def supervisor_hostname(hass: HomeAssistant) -> str | None:
    """HA's OS hostname from the Supervisor, qualified as ``<name>.local``."""
    try:
        is_hassio, get_host_info = supervisor_api()
        if not (is_hassio and get_host_info) or not is_hassio(hass):
            return None
        hostname = ((get_host_info(hass) or {}).get("hostname") or "").strip()
    except Exception as err:
        _LOGGER.debug("Supervisor host info unavailable: %s", err)
        return None
    if not hostname:
        return None
    return hostname if hostname.endswith(MDNS_DOMAIN) else f"{hostname}{MDNS_DOMAIN}"


def server_port(hass: HomeAssistant) -> int:
    """The port Home Assistant is actually listening on.

    Only ever a fallback: it is where HA binds *locally*, so with a reverse
    proxy, Nabu Casa, or a Docker port mapping in front of it, this is not the
    port the device must use -- the configured URL is, and it wins.

    But when no URL yields a port, a constant is the worst available answer.
    Under Supervisor the default is 80, not 8123
    (``http/config.py:default_server_port``), and ``SETUP_PORT`` or the UI's
    "Server port" can move it anywhere. This reads it instead of guessing.
    """
    port = getattr(getattr(hass, "http", None), "server_port", None)
    if isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536:
        return port
    return LAST_RESORT_HA_PORT


def url_address(hass: HomeAssistant, **kwargs: Any) -> tuple[str | None, int | None]:
    """``(hostname, port)`` from one of HA's configured URLs.

    Returns ``(None, None)`` when the URL is unset, unparseable, or points at
    Nabu Casa's remote-UI relay.
    """
    try:
        parsed = urlparse(get_url(hass, allow_cloud=False, **kwargs))
    except Exception as err:
        _LOGGER.debug("get_url(%s) failed: %s", kwargs, err)
        return None, None

    hostname = parsed.hostname
    if not hostname or hostname.lower().endswith(CLOUD_DOMAIN):
        return None, None
    return hostname.rstrip("."), parsed.port or SCHEME_PORTS.get(
        parsed.scheme, server_port(hass)
    )


def external_address(hass: HomeAssistant) -> tuple[str | None, int | None]:
    """``(hostname, port)`` from HA's external URL, or ``(None, None)``.

    Bare IPs, Nabu Casa relays, and ``.local`` names are excluded — the point of
    this source is a hostname that resolves via normal DNS, so the device can
    reconnect without mDNS.
    """
    host, port = url_address(hass, allow_internal=False)
    if not host or is_ip(host) or host.lower().endswith(MDNS_DOMAIN):
        return None, None
    return host, port


def ha_address(hass: HomeAssistant) -> tuple[str, int]:
    """Return the ``(ha_hostname, ha_port)`` to send to the device.

    Priority:

    1. **External URL hostname** — a real DNS name the device can resolve
       without mDNS, and unambiguous on a multi-HA network.
    2. **Supervisor OS hostname** (``<name>.local``) — unique per host,
       published over mDNS.
    3. **Internal URL hostname**, when it is a name (not an IP).
    4. ``homeassistant.local`` — last resort.

    The port always travels with the hostname it came from.
    """
    ext_host, ext_port = external_address(hass)
    if ext_host:
        return ext_host, ext_port or server_port(hass)

    _, internal_port = url_address(hass, allow_external=False)
    port = internal_port or server_port(hass)

    if hostname := supervisor_hostname(hass):
        return hostname, port

    internal_host, _ = url_address(hass, allow_external=False)
    if internal_host and not is_ip(internal_host):
        return internal_host, port

    return FALLBACK_HA_HOSTNAME, port


async def async_ha_address(hass: HomeAssistant) -> tuple[str, int]:
    """``ha_address()`` with the mDNS name verified to point back at *us*.

    A ``.local`` candidate is resolved and checked against this host's own LAN
    address. If it points elsewhere, the IP is sent instead.
    """
    hostname, port = ha_address(hass)

    if is_ip(hostname) or not hostname.lower().endswith(MDNS_DOMAIN):
        return hostname, port

    own_ip = await hass.async_add_executor_job(local_ip)
    if not own_ip:
        return hostname, port

    resolved = await hass.async_add_executor_job(resolve_all, hostname)
    if own_ip in resolved:
        return hostname, port

    _LOGGER.warning(
        "%s resolves to %s, not to this Home Assistant (%s) — provisioning "
        "with the IP instead",
        hostname, ", ".join(sorted(resolved)) or "nothing", own_ip,
    )
    return own_ip, port


# ---------------------------------------------------------------------------
# The device's side
# ---------------------------------------------------------------------------


async def async_read_ha_config(
    hass: HomeAssistant, device_ips: list[str], port: int = DEVICE_HTTP_PORT
) -> dict | None:
    """The Home Assistant the device is set to reach, as it has it stored.

    Returns the parsed ``GET /api/config/ha`` body, or ``None`` when no IP could
    answer. Callers read ``ha_hostname`` to learn whether the device is
    provisioned at all, and ``ha_port`` to learn whether it is aimed at a port we
    would still send -- both answers come from the same one request, and asking
    twice would invite the two to disagree.

    Decided by reading the values that decide it rather than by a ``status``
    field.

    This used to ask ``GET /api/info`` for ``status == "unconfigured"``.
    ``Document/PROTOCOL.md`` described such a field, but its own example response
    did not contain one, and firmware 11.2.7 does not send one either (measured:
    ``device_id``, ``device_name``, ``version``, ``protocol_version``,
    ``capabilities``). So the check read ``None`` every time, never matched, and
    a remote that had lost its configuration was never repaired. The simulator
    implemented the sentence rather than the example, which is why it went
    unnoticed.

    ``None`` is its own answer and must stay one: "we could not ask" is not the
    same as "it is fine", and treating it as one is what left a factory-reset
    remote unrepaired for so long.
    """
    session = async_get_clientsession(hass, verify_ssl=False)
    for device_ip in device_ips:
        url = f"http://{device_ip}:{port}/api/config/ha"
        try:
            async with session.get(url, timeout=PROVISION_TIMEOUT) as resp:
                if resp.status != 200:
                    _LOGGER.debug("GET %s returned %s", url, resp.status)
                    continue
                # `content_type=None` because the parse is the check: this
                # firmware answers an unknown path with its Wi-Fi setup page
                # under HTTP 200, so a body that is not JSON means the endpoint
                # is absent, not that the device is unprovisioned.
                cfg = await resp.json(content_type=None)
        except Exception as err:
            _LOGGER.debug("GET %s failed: %s", url, err)
            continue
        if not isinstance(cfg, dict):
            _LOGGER.debug("GET %s did not return an object", url)
            continue
        _LOGGER.debug(
            "Device %s reports ha_hostname=%r ha_port=%r",
            device_ip, cfg.get("ha_hostname"), cfg.get("ha_port"),
        )
        return cfg
    return None


async def async_build_payload(hass: HomeAssistant) -> dict[str, object]:
    """The body of ``POST /api/config/ha``.

    Carries HA's stable instance UUID so the device can tell it is reconnecting
    to the same Home Assistant rather than to a neighbour that happens to answer
    to the same hostname, and HA's TLS certificate for WSS pinning. Both are
    omitted when unavailable rather than sent empty.
    """
    ha_hostname, ha_port = await async_ha_address(hass)

    try:
        from homeassistant.helpers.instance_id import async_get as _async_get_instance_id
        ha_uuid = await _async_get_instance_id(hass)
    except Exception:
        ha_uuid = None

    payload: dict[str, object] = {"ha_hostname": ha_hostname, "ha_port": ha_port}
    if ha_uuid:
        payload["ha_uuid"] = ha_uuid

    wss_cert = await hass.async_add_executor_job(get_ha_certificate_pem, hass)
    if wss_cert:
        payload["wss_cert"] = wss_cert

    return payload


async def async_provision(
    hass: HomeAssistant, device_ips: list[str], port: int = DEVICE_HTTP_PORT
) -> bool:
    """Push HA's address to the device so it can open its WebSocket.

    Returns whether any of *device_ips* accepted it. Tries them in order and
    stops at the first success: they are candidate addresses for one device, not
    several devices to configure.
    """
    session = async_get_clientsession(hass, verify_ssl=False)
    payload = await async_build_payload(hass)

    for device_ip in device_ips:
        url = f"http://{device_ip}:{port}/api/config/ha"
        try:
            async with session.post(url, json=payload, timeout=PROVISION_TIMEOUT) as resp:
                if resp.status == 200:
                    _LOGGER.info(
                        "Provisioned device at %s:%d -> %s:%s",
                        device_ip, port,
                        payload["ha_hostname"], payload["ha_port"],
                    )
                    return True
                _LOGGER.debug("POST %s returned %s", url, resp.status)
        except Exception as err:
            _LOGGER.debug("POST %s failed: %s", url, err)

    _LOGGER.warning("Provisioning failed for all IPs %s (port %d)", device_ips, port)
    return False
