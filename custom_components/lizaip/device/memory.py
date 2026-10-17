"""How full the remote's memories are, read from its own HTTP API.

Two endpoints carry it, and neither is part of the WebSocket protocol:

``/Device/DeviceMetrics``
    ``Heap`` -- the RAM the firmware allocates from, as ``Size``, ``Free`` and
    ``Largest`` (the biggest block still allocatable).

``/Device/DeviceNvmMetrics``
    ``H7.ImagePartition`` -- the flash that holds the pictures, ``Size`` and
    ``Used`` in bytes -- and ``M4.Storage`` -- the flash file system, counted
    in blocks.

The numbers are reduced to percentages here so the panel only has to draw
them. Fragmentation is derived: ``1 - Largest / Free``. A heap can have plenty
free and still refuse a 25 KB allocation because the free space is in small
pieces, and that -- not the free total -- is what ran the remote out of memory
under load.

A part the firmware does not report is left out rather than reported as zero:
an empty bar would claim a memory is empty.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp
from aiohttp import ClientTimeout
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

METRICS_ENDPOINT = "/Device/DeviceMetrics"
NVM_ENDPOINT = "/Device/DeviceNvmMetrics"

_TIMEOUT = ClientTimeout(total=8)


def _percent(used: float, total: float) -> int | None:
    if not total or total <= 0 or used < 0:
        return None
    return max(0, min(100, round(used * 100 / total)))


def _number(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_heap(metrics: Any) -> dict[str, Any] | None:
    """RAM figures from a ``DeviceMetrics`` document, or ``None`` if absent."""
    heap = (((metrics or {}).get("Device") or {}).get("Metrics") or {}).get("Heap")
    if not isinstance(heap, dict):
        return None
    size, free, largest = (_number(heap.get(k)) for k in ("Size", "Free", "Largest"))
    if not size or free is None:
        return None
    used = size - free
    result: dict[str, Any] = {
        "size": size,
        "used": used,
        "free": free,
        "used_percent": _percent(used, size),
    }
    if largest is not None and free > 0:
        result["largest"] = largest
        result["fragmentation_percent"] = _percent(free - largest, free)
    return result


def parse_image_flash(nvm: Any) -> dict[str, Any] | None:
    """The picture partition of a ``DeviceNvmMetrics`` document."""
    part = ((((nvm or {}).get("Device") or {}).get("NvmMetrics") or {})
            .get("H7") or {}).get("ImagePartition")
    if not isinstance(part, dict):
        return None
    size, used = _number(part.get("Size")), _number(part.get("Used"))
    if not size or used is None:
        return None
    return {
        "size": size,
        "used": used,
        "used_percent": _percent(used, size),
    }


def parse_file_flash(nvm: Any) -> dict[str, Any] | None:
    """The file system of a ``DeviceNvmMetrics`` document, in bytes."""
    storage = ((((nvm or {}).get("Device") or {}).get("NvmMetrics") or {})
               .get("M4") or {}).get("Storage")
    if not isinstance(storage, dict):
        return None
    block = _number(storage.get("DeviceBlockSize"))
    capacity = _number(storage.get("DeviceBlocksCapacity"))
    allocated = _number(storage.get("NumOfAllocatedBlocks"))
    if not block or not capacity or allocated is None:
        return None
    return {
        "size": block * capacity,
        "used": block * allocated,
        "used_percent": _percent(allocated, capacity),
    }


async def _fetch_json(hass, base: str, endpoint: str) -> Any:
    session = async_get_clientsession(hass)
    async with session.get(f"{base}{endpoint}", timeout=_TIMEOUT) as resp:
        if resp.status != 200:
            raise aiohttp.ClientResponseError(
                resp.request_info, resp.history, status=resp.status)
        return json.loads(await resp.text())


async def async_read_memory(conn) -> dict[str, Any]:
    """Read the remote's memory use; the failure is part of the answer.

    ``{"available": False, "reason": ...}`` says why nothing could be read.
    Otherwise each of ``ram``, ``image_flash`` and ``file_flash`` is present
    when the device reported it. The two endpoints are read together, and one
    failing leaves the other's bars on screen.
    """
    if not conn.peer_ip or not conn.device_http_port:
        return {"available": False, "reason": "no_address"}
    base = f"http://{conn.peer_ip}:{conn.device_http_port}"
    metrics, nvm = await asyncio.gather(
        _fetch_json(conn.hass, base, METRICS_ENDPOINT),
        _fetch_json(conn.hass, base, NVM_ENDPOINT),
        return_exceptions=True,
    )
    parsed = {
        "ram": None if isinstance(metrics, BaseException) else parse_heap(metrics),
        "image_flash": None if isinstance(nvm, BaseException) else parse_image_flash(nvm),
        "file_flash": None if isinstance(nvm, BaseException) else parse_file_flash(nvm),
    }
    for name, err in (("metrics", metrics), ("nvm", nvm)):
        if isinstance(err, BaseException):
            _LOGGER.debug("Reading the remote's %s failed: %r", name, err)
    result: dict[str, Any] = {k: v for k, v in parsed.items() if v is not None}
    if not result:
        return {"available": False, "reason": "unreachable"}
    result["available"] = True
    return result
