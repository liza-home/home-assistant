"""Debug tooling for the device — pre-release builds only.

This module is *not shipped in a stable release*. `scripts/public_repo.sh`
leaves it out unless the version carries a PEP 440 pre-release suffix, so on a
normal release the code is absent rather than merely switched off. Everything
that reaches for it therefore has to tolerate its absence — see
`runtime.debug_available` and the panel's dynamic import.

What is left here is everything that *writes or listens*: opening the device's
debug port, following its log stream, setting and resetting log levels, writing
traffic to Home Assistant's log. Those are the reasons the module is withheld —
undocumented endpoints and a listening socket on the remote — and that is a
reasonable trade in a build someone opted into, an unreasonable one to put in
front of everybody.

Reading is no longer part of that bargain and lives in `report`, which ships
everywhere: the diagnostics bundle a user assembles for support needs the
device's own endpoints and its log, and a bundle that carried them only on
pre-release builds would be missing the one thing most reports turn on. The
read half is re-exported here so callers written against this module — and its
tests — keep working.

Written as functions over a connection rather than methods on it, so that
removing the file removes the feature whole.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import weakref
from typing import TYPE_CHECKING, Any

import aiohttp
from aiohttp import ClientTimeout
from homeassistant.exceptions import HomeAssistantError

from ..const import DOMAIN
from ..shared.logs import device_logger
from .const import DEBUG_LOG_PORT
from .http import device_base_url, device_session, error_detail
from .report import (  # noqa: F401 — re-exported for callers of this module
    DEFAULT_LOG_LEVEL,
    LOG_LEVELS,
    LOGGING_ENDPOINT,
    MAX_SECTION_CHARS,
    REPORT_ENDPOINTS,
    _parse_logging_setup,
    async_fetch_report,
    async_fetch_section,
    async_get_logging_setup,
    async_probe_reachability,
    logging_setup_from_section,
    report_plan,
)
from .traffic import TRAFFIC_LOGGER

if TYPE_CHECKING:
    from .connection import LizaIPConnection

_LOGGER = logging.getLogger(__name__)

#: Module names are keys in a payload sent to the device. The device rejects the
#: ones it does not know, but a name is still checked before it is sent: it
#: arrives from a browser, and this keeps anything that is not a plain
#: identifier out of the request entirely.
_MODULE_NAME = re.compile(r"^[A-Za-z0-9_]{1,32}$")

#: Key in the device's response that carries the real outcome. The HTTP status
#: does not: a refused value comes back as 200 with StatusId -1, so reading the
#: HTTP code as success would report a change that never happened.
_STATUS_OK = 0

#: Longest single log line re-emitted. A device stuck mid-line must not be able
#: to put an unbounded string into Home Assistant's log.
_MAX_LINE = 2000

#: The device colours its log output with VT100 escapes, and both destinations
#: render them: the panel does it itself, and Home Assistant's log page runs the
#: text through its own `ha-ansi-to-html`. So the colours are passed through
#: rather than dropped -- they are the device's own statement about a line.
#:
#: What is taken out is everything that cannot be rendered: escapes that are not
#: colour (cursor moves, window titles) and bare control characters. Home
#: Assistant's parser would read some of those as attributes -- `ESC[2J` reaches
#: its code 2 and comes out dim -- so leaving them in would not be neutral.
#: Tab and newline are kept; both destinations lay the dump out with them.
_NON_SGR = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-ln-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])"
)

#: An ESC that does not begin a colour code, once the sequences above are gone.
_STRAY_ESC = re.compile(r"\x1b(?!\[[0-9;]*m)")

#: Control characters other than ESC, tab and newline.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]")

#: A colour code cut in half by the length limit. Truncation happens after the
#: rest is cleaned, so this is the one broken sequence that can still appear.
_PARTIAL_SGR = re.compile(r"\x1b\[[0-9;]*$")


def _log_safe(text: str) -> str:
    """Keep the device's colouring, drop what neither destination can render."""
    # Truncation comes before the stray-ESC pass on purpose: a colour code cut
    # in half by the limit has to be recognised as one and removed whole, and
    # afterwards there is no ESC left to recognise it by.
    cleaned = _PARTIAL_SGR.sub("", _NON_SGR.sub("", text)[:_MAX_LINE])
    return _CONTROL_CHARS.sub("", _STRAY_ESC.sub("", cleaned))

#: Connections currently following their device's log, and the level the shared
#: stream logger had before the first of them started. One logger serves every
#: remote, so a plain save/restore pair would silence a second remote that is
#: still streaming when the first stops.
_FOLLOWING: weakref.WeakSet[LizaIPConnection] = weakref.WeakSet()
_PRIOR_LEVEL: int | None = None


def _stream_logger() -> logging.Logger:
    """The logger the device's own lines are re-emitted on."""
    return logging.getLogger(f"{__package__}.log")


def _follow_stream_logger(conn: LizaIPConnection) -> None:
    """Turn the stream logger up, so the lines it carries are actually visible.

    They are emitted at DEBUG on purpose (see ``_log_stream_loop``), which means
    a default installation drops them. Without this the switch would open the
    device's port, read its output, and write it all into a level nobody is
    listening to — and the panel's link to the log would lead to a page with no
    lines on it.

    Only the stream's own logger is touched, never the integration's, and only
    while someone is following it.
    """
    global _PRIOR_LEVEL
    if not _FOLLOWING:
        _PRIOR_LEVEL = _stream_logger().level
        _stream_logger().setLevel(logging.DEBUG)
    _FOLLOWING.add(conn)


def _unfollow_stream_logger(conn: LizaIPConnection) -> None:
    """Put the stream logger back once the last follower has stopped."""
    global _PRIOR_LEVEL
    _FOLLOWING.discard(conn)
    if not _FOLLOWING and _PRIOR_LEVEL is not None:
        _stream_logger().setLevel(_PRIOR_LEVEL)
        _PRIOR_LEVEL = None


#: Connections writing their traffic to the log, and the traffic logger's level
#: before the first of them started -- the same bookkeeping as the stream's.
_TRAFFIC_LOGGING: weakref.WeakSet[LizaIPConnection] = weakref.WeakSet()
_TRAFFIC_PRIOR_LEVEL: int | None = None


def set_traffic_logging(conn: LizaIPConnection, enabled: bool) -> None:
    """Write every frame with *conn*'s remote to the HA log, or stop.

    Frames go out at INFO, which a default installation drops, so the traffic
    logger is raised while anyone is logging and put back after the last stops.
    """
    global _TRAFFIC_PRIOR_LEVEL
    logger = TRAFFIC_LOGGER
    conn.protocol.traffic.log_enabled = enabled
    if enabled:
        if not _TRAFFIC_LOGGING:
            _TRAFFIC_PRIOR_LEVEL = logger.level
            logger.setLevel(logging.INFO)
        _TRAFFIC_LOGGING.add(conn)
        return
    _TRAFFIC_LOGGING.discard(conn)
    if not _TRAFFIC_LOGGING and _TRAFFIC_PRIOR_LEVEL is not None:
        logger.setLevel(_TRAFFIC_PRIOR_LEVEL)
        _TRAFFIC_PRIOR_LEVEL = None


async def async_set_debug_port(conn: LizaIPConnection, enabled: bool) -> None:
    """Open or close the device's debug log port, and follow or stop following it.

    Enabling is deliberately not persisted: a debug port left open across
    restarts is a listening socket nobody remembers opening, so the device is
    asked afresh each time.
    """
    log = device_logger(_LOGGER, conn)
    log.debug("DebugPort request for %s: %s", conn.peer_ip, enabled)
    await conn.async_device_control({"DebugPort": bool(enabled)})

    # Only after the device has agreed. Starting the reader first would produce
    # a connection refused that looks like a fault but is only a race with a
    # port that was never opened.
    if enabled:
        _follow_stream_logger(conn)
        start_log_stream(conn)
    else:
        await conn.async_cancel_aux_tasks()
        _unfollow_stream_logger(conn)


def start_log_stream(conn: LizaIPConnection) -> None:
    """Begin following the device's debug log port."""
    task = conn.hass.async_create_background_task(
        _log_stream_loop(conn), name=f"lizaip_debug_log_{id(conn)}"
    )
    conn.register_aux_task(task)


async def _log_stream_loop(conn: LizaIPConnection) -> None:
    """Read the device's debug log and re-emit it into Home Assistant's log.

    Lines go to a logger of their own so that Home Assistant's ``logger:``
    configuration can turn the device's chatter up or down without touching the
    integration's own output — and so a flood of firmware lines cannot bury our
    messages.

    Everything arrives at DEBUG. The device's severities are not parsed and
    promoted: a remote that decides something is a warning would otherwise
    write warnings into a user's log unbidden, and the stream exists only
    because someone switched it on.
    """
    log = device_logger(logging.getLogger(f"{__package__}.log"), conn)
    stream_log = device_logger(_LOGGER, conn)
    backoff = 1.0
    while True:
        writer = None
        try:
            peer_ip = conn.peer_ip
            if not peer_ip:
                return
            reader, writer = await asyncio.open_connection(peer_ip, DEBUG_LOG_PORT)
            stream_log.debug("Debug log stream open to %s:%d", peer_ip, DEBUG_LOG_PORT)
            backoff = 1.0
            while True:
                try:
                    raw = await reader.readuntil(b"\n")
                except asyncio.LimitOverrunError:
                    # A line longer than the stream buffer: take what is there
                    # and carry on, rather than letting one malformed line end
                    # the session.
                    raw = await reader.read(4096)
                except asyncio.IncompleteReadError as err:
                    raw = err.partial
                    if not raw:
                        break
                if not raw:
                    break
                line = _log_safe(raw.decode("utf-8", errors="replace")).rstrip("\r\n")
                if line:
                    log.debug("[%s] %s", peer_ip, line)
        except asyncio.CancelledError:
            raise
        except OSError as err:
            stream_log.debug("Debug log stream to %s failed: %s", conn.peer_ip, err)
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

        # The device closes this port when it reboots, which is exactly when a
        # debug session is most wanted — so reconnect rather than give up,
        # backing off so a device refusing outright is not hammered.
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)


def _device_status(text: str) -> tuple[int, str]:
    """Read the device's own verdict out of a control response.

    The HTTP status carries none of it. A refused value and an accepted one both
    come back as 200, and the difference is `Action.Result.StatusId` — so taking
    the HTTP code for success reports a change the device declined to make.

    An unreadable body is treated as a failure rather than a success: this is
    asked only after a write, and "the device said something we cannot parse" is
    not grounds for telling the user it worked.
    """
    try:
        result = json.loads(text)["Action"]["Result"]
        return int(result["StatusId"]), str(result.get("StatusInfo", ""))
    except (ValueError, KeyError, TypeError):
        return -1, f"Unreadable response: {text[:200]}"


async def async_set_log_level(conn: LizaIPConnection, module: str, level: str) -> None:
    """Set one module's log level on the device.

    One module at a time, and sent as a payload containing only that module: the
    device merges what it is given and leaves the rest untouched, so writing the
    whole set back would turn every change into a chance to overwrite a level
    that something else had just altered.

    Both arguments arrive from a browser and are checked here rather than left
    to the device. The level is refused outright if it is not one the firmware
    takes -- the device would refuse it too, but with a message about a range
    rather than a list -- and the module name has to look like an identifier
    before it is placed into a request at all.
    """
    if level not in LOG_LEVELS:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_level_unknown",
            translation_placeholders={"level": str(level)},
        )
    if not _MODULE_NAME.match(module):
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_module_unknown",
            translation_placeholders={"module": str(module)},
        )
    if not conn.peer_ip or not conn.device_http_port:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="device_ip_unknown",
        )

    device_logger(_LOGGER, conn).debug(
        "LoggingSetup %s=%s for %s", module, level, conn.peer_ip
    )
    await _async_post_logging(conn, {module: level})


async def _async_post_logging(conn: LizaIPConnection, levels: dict[str, str]) -> None:
    """POST a LoggingSetup payload and hold the device to its own verdict.

    Shared by the single-module write and the reset, because the trap is the
    same for both: the device answers a refused change with HTTP 200, and only
    `Action.Result.StatusId` distinguishes it from an accepted one.
    """
    if not conn.peer_ip or not conn.device_http_port:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="device_ip_unknown",
        )

    session = device_session(conn.hass)
    url = f"{device_base_url(conn)}{LOGGING_ENDPOINT}"

    try:
        async with session.post(
            url,
            json={"Device": {"LoggingSetup": levels}},
            timeout=ClientTimeout(total=10),
        ) as resp:
            text = await resp.text()
            status = resp.status
    except (aiohttp.ClientError, asyncio.TimeoutError) as err:
        detail = error_detail(err)
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_level_unreachable",
            translation_placeholders={"error": detail},
        ) from err

    if status != 200:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_level_http",
            translation_placeholders={"status": str(status)},
        )

    status_id, info = _device_status(text)
    if status_id != _STATUS_OK:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_level_refused",
            translation_placeholders={"reason": info or f"StatusId {status_id}"},
        )


async def async_reset_log_levels(conn: LizaIPConnection) -> None:
    """Put every module back to the level the device ships with.

    The module list is read from the device first rather than taken from a set
    compiled into this build: a firmware with a module we have never heard of
    would otherwise have that one module left behind at whatever it was set to,
    which is precisely the module someone would then fail to find.

    Sent as one request. Measured on the device: a payload naming several
    modules is accepted whole, so a reset does not need one round trip per
    module -- and a partial failure part-way through nineteen writes would
    leave the levels in a state nobody asked for.
    """
    setup = await async_get_logging_setup(conn)
    if not setup.get("available"):
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="device_ip_unknown",
        )
    if setup.get("error"):
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_level_unreachable",
            translation_placeholders={"error": str(setup["error"])},
        )

    # The names come from the device, but they are going into a request, so they
    # are still checked for being identifiers before they are put there.
    levels = {
        module: DEFAULT_LOG_LEVEL
        for module in setup["modules"]
        if _MODULE_NAME.match(module)
    }
    if not levels:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="log_reset_no_modules",
        )

    await _async_post_logging(conn, levels)


async def async_get_debug_port(conn: LizaIPConnection) -> dict[str, Any]:
    """Read whether the device's debug log port is open, and whether we read it.

    Two separate facts, and they come apart. The port survives on the device
    across a restart of Home Assistant, while the task that reads it does not --
    so a freshly started Home Assistant can meet a remote whose port is open
    with nothing listening to it. Reporting only the port would show a switch
    turned on that produces no lines; reporting only our own state would call an
    open port closed.

    `GET /Device/Control` carries the answer. An earlier version of this module
    claimed the firmware offered no way to read it back and started from "off"
    instead: that was wrong, and only ever checked `/Device/Status`.
    """
    plan = report_plan(conn)
    if not plan["available"]:
        return plan

    section = await async_fetch_section(conn, "/Device/Control")
    if "error" in section:
        return {"available": True, "error": section["error"]}
    if section["status"] != 200:
        return {"available": True, "error": f"HTTP {section['status']}"}

    try:
        control = json.loads(section["body"])["Device"]["Control"]
        enabled = bool(control["DebugPort"])
    except (ValueError, KeyError, TypeError) as err:
        return {"available": True, "error": f"Unreadable response: {err}"}

    return {"available": True, "enabled": enabled, "following": conn in _FOLLOWING}
