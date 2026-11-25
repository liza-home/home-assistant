"""The Ruwido IR code catalogue: types, brands, then a brand's signals.

``base64_blob`` carries the bytes and ``json`` names each signal; both are
needed. The two list levels are cached, signals are not.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Final

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

#: Ruwido's public catalogue. This key answers the signal endpoint too, and
#: returns the full 40-key code sets; others are cut down to about eleven.
API_BASE: Final = "https://app.api.ruwido.com/rc_config"
API_KEY: Final = "57a730a6808f"

_TIMEOUT_S: Final = 20
#: A catalogue listing stands this long before it is fetched again.
_CACHE_TTL_S: Final = 12 * 3600
_DATA_KEY: Final = "lizaip_ir_catalogue"

#: How many brands ``?top=`` puts above the alphabetical list.
TOP_BRANDS: Final = 10


class IrCatalogError(Exception):
    """The catalogue could not be read; carries a translation key for the panel."""

    def __init__(self, message: str, translation_key: str = "ir_catalog_unavailable") -> None:
        super().__init__(message)
        self.translation_key = translation_key


@dataclass(frozen=True, slots=True)
class IrEntry:
    """One row of a catalogue list: a device type or a brand."""

    id: str
    name: str


@dataclass(frozen=True, slots=True)
class IrCodeSet:
    """One code set of a brand: its catalogue id, base64 blob and named signals.

    ``signals`` maps a key name to hex and is empty when only blobs were asked for.
    """

    id: str
    blob: str
    signals: dict[str, str]


class _Cache:
    def __init__(self) -> None:
        self.entries: dict[str, tuple[float, tuple[IrEntry, ...]]] = {}
        self.lock = asyncio.Lock()

    def get(self, key: str) -> tuple[IrEntry, ...] | None:
        hit = self.entries.get(key)
        if hit is None or time.monotonic() - hit[0] > _CACHE_TTL_S:
            return None
        return hit[1]

    def put(self, key: str, value: tuple[IrEntry, ...]) -> None:
        self.entries[key] = (time.monotonic(), value)


def _cache(hass: Any) -> _Cache:
    data = getattr(hass, "data", None)
    if not isinstance(data, dict):
        return _Cache()
    if _DATA_KEY not in data:
        data[_DATA_KEY] = _Cache()
    cache: _Cache = data[_DATA_KEY]
    return cache


async def _fetch(hass: HomeAssistant, path: str, params: dict[str, str]) -> dict[str, Any]:
    """A catalogue response as a dict, or raise :class:`IrCatalogError`."""
    url = f"{API_BASE}/{API_KEY}/v3/list/{path}"
    try:
        async with async_get_clientsession(hass).get(
            url, params=params, timeout=aiohttp.ClientTimeout(total=_TIMEOUT_S),
        ) as resp:
            if resp.status != 200:
                raise IrCatalogError(f"{url} answered {resp.status}")
            payload = await resp.json(content_type=None)
    except IrCatalogError:
        raise
    except asyncio.TimeoutError as exc:
        raise IrCatalogError(f"{url} timed out", "ir_catalog_timeout") from exc
    except Exception as exc:  # noqa: BLE001 - network, DNS, malformed JSON
        raise IrCatalogError(f"{url} failed: {exc}") from exc
    if not isinstance(payload, dict):
        raise IrCatalogError(f"{url} answered {type(payload).__name__}, not an object")
    return payload


def _rows(payload: dict[str, Any], section: str, row_key: str = "item") -> list[dict[str, Any]]:
    """The rows of a response section; empty where the section is absent.

    An unknown brand answers with an empty section, not a 404; one row may
    arrive bare rather than as a list of one.
    """
    wrapper = payload.get(section)
    rows = wrapper.get(row_key) if isinstance(wrapper, dict) else None
    if isinstance(rows, dict):
        return [rows]
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def _entries(payload: dict[str, Any], section: str) -> tuple[IrEntry, ...]:
    """List rows as entries, dropping those with no id; unlabelled rows are named by it."""
    out = []
    for row in _rows(payload, section):
        row_id = str(row.get("id") or "").strip()
        if row_id:
            out.append(IrEntry(row_id, str(row.get("content") or "").strip() or row_id))
    return tuple(out)


async def _cached(
    hass: HomeAssistant, cache_key: str, path: str, params: dict[str, str], section: str,
) -> tuple[IrEntry, ...]:
    cache = _cache(hass)
    hit = cache.get(cache_key)
    if hit is not None:
        return hit
    async with cache.lock:
        hit = cache.get(cache_key)
        if hit is not None:
            return hit
        entries = _entries(await _fetch(hass, path, params), section)
        cache.put(cache_key, entries)
        return entries


async def async_types(hass: HomeAssistant) -> tuple[IrEntry, ...]:
    """The catalogue's device types (television, set-top box …)."""
    return await _cached(hass, "types", "", {}, "types")


async def async_brands(
    hass: HomeAssistant, type_id: str | int, top: int | None = None,
) -> tuple[IrEntry, ...]:
    """The brands of a device type, alphabetically, or the *top* most common.

    Filtered in the panel: the API accepts ``search`` and then ignores it.
    """
    params = {"top": str(top)} if top else {}
    key = f"brands:{type_id}:{top or 0}"
    return await _cached(hass, key, f"{type_id}/", params, "brands")


async def async_code_sets(
    hass: HomeAssistant, type_id: str | int, brand_id: str | int,
) -> tuple[IrCodeSet, ...]:
    """Every code set of a brand, each with its blob and its signal names.

    The empty model segment asks for all models. Bytes and names come from two
    requests, paired by their order.
    """
    path = f"{type_id}/{brand_id}//signal"
    blobs, named = await asyncio.gather(
        _fetch(hass, path, {"output": "base64_blob"}),
        _fetch(hass, path, {"output": "json"}),
    )
    blob_rows = _rows(blobs, "remotes", "remote")
    named_rows = _rows(named, "remotes", "remote")
    if len(blob_rows) != len(named_rows):
        raise IrCatalogError(
            f"catalogue listed {len(blob_rows)} blobs for {len(named_rows)} code sets"
        )

    sets = []
    for blob_row, named_row in zip(blob_rows, named_rows):
        wrapper = blob_row.get("base64")
        blob = str((wrapper or {}).get("content") or "").strip() if isinstance(
            wrapper, dict) else ""
        if not blob:
            continue
        signals = {}
        for signal in named_row.get("signal") or []:
            name = str(signal.get("name") or "").strip()
            if name:
                signals[name] = str(signal.get("content") or "")
        sets.append(IrCodeSet(
            id=str(named_row.get("id") or blob_row.get("id") or "").strip(),
            blob=blob,
            signals=signals,
        ))
    if not sets:
        raise IrCatalogError("catalogue returned no usable code set", "ir_catalog_empty")
    _LOGGER.debug("IR catalogue: %d code sets for %s/%s", len(sets), type_id, brand_id)
    return tuple(sets)
