"""Reading the device's own account of itself — shipped in every build.

This is the half of the former `debug` module that only ever reads: the
read-only HTTP endpoints the remote exposes, the reachability probe, and the
per-module log levels. It was split out because `debug` is *removed* from a
stable release by `scripts/public_repo.sh`, and the diagnostics bundle a user
puts together to send to support needs exactly this material — a bundle that
carried the device's log only on pre-release builds would be missing the one
thing most reports turn on.

What stayed behind in `debug` is everything that writes or listens: opening the
device's debug port, setting log levels, following the log stream. Those are the
reasons that module is withheld from a stable build, and they are untouched by
this split.

Written as functions over a connection rather than methods on it, so the two
halves can be separated at all.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Any

import aiohttp
from aiohttp import ClientTimeout

from .http import device_base_url, device_session, error_detail

if TYPE_CHECKING:
    from .connection import LizaIPConnection

_LOGGER = logging.getLogger(__name__)

#: Endpoint carrying the per-module log levels, readable and writable. The write
#: half lives in `debug`; reading it is part of every report, because a log is
#: unreadable without knowing which levels decided what went into it.
LOGGING_ENDPOINT = "/Device/LoggingSetup"

#: Endpoint carrying the device's own log. Named because the bundle files it
#: separately from the rest of the endpoints.
DEVICE_LOG_ENDPOINT = "/Device/DeviceLogs"

#: Levels the firmware accepts, least to most verbose.
#:
#: Measured, not documented: `warning` is undocumented but accepted, and
#: anything outside this set is refused with StatusId -1.
LOG_LEVELS: tuple[str, ...] = (
    "off", "error", "warning", "important", "notice", "info", "verbose",
)

#: What every module is set to on a device that has not been touched -- measured
#: on a remote before anything was written to it, all nineteen modules reported
#: `important`. This is what the reset puts them back to, so it is a statement
#: about the firmware rather than a preference of ours.
DEFAULT_LOG_LEVEL = "important"

# A ceiling, not a display limit: the device log measured 270993 characters, so
# this leaves it whole. It guards only against a device answering without end,
# and a body that reaches it is reported as cut rather than trimmed quietly.
MAX_SECTION_CHARS = 2_000_000

#: The endpoint the reachability probe reads. Named because two callers hand
#: its answer to each other rather than fetching it twice.
INFO_ENDPOINT = "/api/info"

#: Read-only endpoints the device exposes for diagnosis, widest question first:
#: who it is, who it is trying to talk to, how it is attached to the network,
#: then its own state and metrics, and last its log -- the largest of them and
#: the one that only makes sense once the rest has been read.
#:
#: This tuple is also the allow-list the WebSocket command checks, so a line
#: here is a decision about what the panel may fetch, not only what it shows.
#:
#: `/api/setup/ha` and `/api/networks` are deliberately absent: the device
#: answers any unrecognised path with the same Wi-Fi provisioning page, and
#: a network list triggers a scan, while this report only reads.
REPORT_ENDPOINTS: tuple[str, ...] = (
    INFO_ENDPOINT,
    "/api/config/ha",
    "/api/config/wifi",
    "/Device/Status",
    "/Device/DeviceMetrics",
    "/Device/DeviceNvmMetrics",
    "/Device/LoggingSetup",
    "/Device/DeviceLogs",
)


async def async_probe_reachability(
    conn: LizaIPConnection, *, keep_body: bool = False
) -> dict[str, Any]:
    """Ask the device's ``/api/info`` whether it answers, and how quickly.

    Reports failure as data rather than raising. A probe exists to explain a
    problem, so "no address stored" and "connection refused" are answers in
    their own right — an exception would leave the caller with nothing to show.

    Deliberately not ICMP. Home Assistant usually runs without ``CAP_NET_RAW``,
    so a ping would fail for reasons that look like a network fault but are not,
    and a reply would only prove that something at that address answers — not
    that it is this remote, nor that its HTTP API is up.

    ``keep_body`` returns what ``/api/info`` said as well. The probe has read
    it either way; handing it back lets a caller that wants both the latency
    and the content — the diagnostics bundle — pay for one request instead of
    asking the same endpoint twice.
    """
    if not conn.peer_ip:
        return {"reachable": False, "reason": "no_address"}
    if not conn.device_http_port:
        return {"reachable": False, "reason": "no_port", "peer_ip": conn.peer_ip}

    url = f"{device_base_url(conn)}/api/info"
    session = device_session(conn.hass)
    started = time.monotonic()
    try:
        async with session.get(url, timeout=ClientTimeout(total=5)) as resp:
            body = await resp.text()
            result = {
                "reachable": resp.status == 200,
                "reason": "ok" if resp.status == 200 else "http_status",
                "status": resp.status,
                "latency_ms": round((time.monotonic() - started) * 1000),
                "peer_ip": conn.peer_ip,
                "http_port": conn.device_http_port,
            }
            if keep_body:
                result["body"] = body
            return result
    except (aiohttp.ClientError, asyncio.TimeoutError) as err:
        detail = error_detail(err)
        return {
            "reachable": False,
            "reason": "unreachable",
            "error": detail,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "peer_ip": conn.peer_ip,
            "http_port": conn.device_http_port,
        }


def report_plan(conn: LizaIPConnection) -> dict[str, Any]:
    """Say what the report will consist of, without fetching any of it.

    The panel asks for this first so it can put the list on screen and fill the
    rows in as they arrive. Deciding this separately costs no request: it is
    only a look at whether the device has an address at all.
    """
    if not conn.peer_ip or not conn.device_http_port:
        return {"available": False, "reason": "no_address"}
    return {
        "available": True,
        "peer_ip": conn.peer_ip,
        "endpoints": list(REPORT_ENDPOINTS),
    }


async def async_fetch_section(conn: LizaIPConnection, endpoint: str) -> dict[str, Any]:
    """Fetch one diagnostic endpoint, reporting its failure as a result.

    A failure is returned rather than raised because it belongs in the report:
    "this endpoint timed out" is an answer about the device, and losing it would
    leave the reader unable to tell a broken endpoint from one never asked.
    """
    session = device_session(conn.hass)
    base = device_base_url(conn)
    try:
        async with session.get(
            f"{base}{endpoint}", timeout=ClientTimeout(total=10)
        ) as resp:
            body = await resp.text()
            # Kept verbatim, colour codes and all: both readers render them,
            # and remapping here would change what the device reported.
            #
            # The whole body goes out. An earlier 20000-character cut showed 7%
            # of the device log and said nothing about having dropped the rest.
            full = len(body)
            if full > MAX_SECTION_CHARS:
                return {
                    "status": resp.status,
                    "body": body[:MAX_SECTION_CHARS],
                    "truncated": True,
                    "length": full,
                }
            return {"status": resp.status, "body": body}
    except (aiohttp.ClientError, asyncio.TimeoutError) as err:
        detail = error_detail(err)
        return {"error": detail}


async def async_fetch_report(
    conn: LizaIPConnection, *, prefetched: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Collect the device's read-only diagnostic endpoints.

    Each endpoint is reported separately, including its failure. One endpoint a
    given firmware does not implement must not cost the caller the rest —
    which is the usual case when a report is taken against an older build.

    Sequentially, on purpose: the remote is a small embedded device, and five
    simultaneous requests would test its HTTP server rather than report on it.

    ``prefetched`` supplies sections a caller has already fetched, keyed by
    endpoint. The reachability probe reads ``/api/info`` to time it, and
    reading it a second time a moment later measures nothing new while costing
    the user another second and a half of waiting.
    """
    plan = report_plan(conn)
    if not plan["available"]:
        return plan

    sections: dict[str, Any] = {}
    for endpoint in REPORT_ENDPOINTS:
        if prefetched and endpoint in prefetched:
            sections[endpoint] = prefetched[endpoint]
            continue
        sections[endpoint] = await async_fetch_section(conn, endpoint)

    return {"available": True, "peer_ip": conn.peer_ip, "sections": sections}


def _parse_logging_setup(body: str) -> tuple[dict[str, str], str | None]:
    """Split the device's answer into modules and the schema version.

    `Version` sits among the modules but is not one. Leaving it in would invent
    a module that cannot be set; dropping it silently would lose the only clue
    to which schema the rest follows.
    """
    setup = json.loads(body)["Device"]["LoggingSetup"]
    if not isinstance(setup, dict):
        raise TypeError("LoggingSetup is not an object")
    version = setup.get("Version")
    modules = {k: str(v) for k, v in setup.items() if k != "Version"}
    return modules, str(version) if version is not None else None


def logging_setup_from_section(section: dict[str, Any]) -> dict[str, Any]:
    """Turn a fetched ``/Device/LoggingSetup`` section into the panel's shape.

    Split out from the fetch so a caller that already has the section — the
    diagnostics bundle, which collects every endpoint anyway — can read it
    without asking the device for the same answer a second time.
    """
    if "error" in section:
        return {"available": True, "error": section["error"]}
    if section.get("status") != 200:
        return {"available": True, "error": f"HTTP {section.get('status')}"}

    try:
        modules, version = _parse_logging_setup(section["body"])
    except (ValueError, KeyError, TypeError) as err:
        return {"available": True, "error": f"Unreadable response: {err}"}

    return {
        "available": True,
        "modules": modules,
        "version": version,
        "levels": list(LOG_LEVELS),
    }


async def async_get_logging_setup(conn: LizaIPConnection) -> dict[str, Any]:
    """Read which modules are logging, and at what level.

    Reported rather than raised, like the report's sections: a firmware without
    this endpoint is a fact about the device, and the panel has a place to say
    so.

    Every module the device names is passed on, including ones this build has
    never heard of. The list is the device's statement about itself, and
    filtering it against a set compiled into us would hide precisely the newly
    added module someone is chasing.
    """
    plan = report_plan(conn)
    if not plan["available"]:
        return plan

    return logging_setup_from_section(await async_fetch_section(conn, LOGGING_ENDPOINT))
