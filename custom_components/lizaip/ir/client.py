"""The Ruwido IR code catalogue: types, brands, then a brand's signals.

Its API key is looked up per remote model; without a model or a key every
call fails with ``ir_catalog_no_key``. A code set is read from its
``base64_blob`` alone: each record carries its key id. Nothing is cached: every
call asks the catalogue.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import quote

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import blob as ir_blob

_LOGGER = logging.getLogger(__name__)

#: Ruwido's catalogue; ``getKey/v3/<model_id>`` hands out the key for a model.
API_BASE: Final = "https://app.api.ruwido.com/rc_config"

_TIMEOUT_S: Final = 20

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
    """One code set of a brand: its id (the blob's CRC32), base64 blob and key ids."""

    id: str
    blob: str
    key_ids: frozenset[int]


async def _get(hass: HomeAssistant, url: str, params: dict[str, str]) -> str:
    """The body of a catalogue response, or raise :class:`IrCatalogError`."""
    try:
        async with async_get_clientsession(hass).get(
            url, params=params, timeout=aiohttp.ClientTimeout(total=_TIMEOUT_S),
        ) as resp:
            if resp.status != 200:
                raise IrCatalogError(f"{url} answered {resp.status}")
            return await resp.text()
    except IrCatalogError:
        raise
    except TimeoutError as exc:
        raise IrCatalogError(f"{url} timed out", "ir_catalog_timeout") from exc
    except Exception as exc:
        raise IrCatalogError(f"{url} failed: {exc}") from exc


async def _api_key(hass: HomeAssistant, model_id: str | None) -> str | None:
    """The catalogue key for *model_id*, fetched every time; ``None`` if unknown.

    No model, a failed request and an empty or malformed answer all give ``None``.
    """
    if not model_id:
        return None
    url = f"{API_BASE}/getKey/v3/{quote(model_id, safe='')}"
    try:
        body = await _get(hass, url, {})
    except IrCatalogError as err:
        _LOGGER.debug("No catalogue key for %s: %s", model_id, err)
        return None
    return _parse_key(body)


def _parse_key(body: str) -> str | None:
    """The key of a ``getKey`` answer, ``{"key": "…"}``; an unknown model answers ``[]``.

    The key goes into the URL path, so only ASCII letters and digits are taken.
    """
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    key = payload.get("key") if isinstance(payload, dict) else None
    if isinstance(key, str) and key.isascii() and key.isalnum():
        return key
    return None


async def _require_key(hass: HomeAssistant, model_id: str | None) -> str:
    """The catalogue key for *model_id*, or raise: nothing works without one."""
    key = await _api_key(hass, model_id)
    if key is None:
        raise IrCatalogError(f"no catalogue key for model {model_id!r}", "ir_catalog_no_key")
    return key


async def _fetch(
    hass: HomeAssistant, key: str, path: str, params: dict[str, str],
) -> dict[str, Any]:
    """A catalogue response as a dict, or raise :class:`IrCatalogError`."""
    url = f"{API_BASE}/{key}/v3/list/{path}"
    body = await _get(hass, url, params)
    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise IrCatalogError(f"{url} answered no JSON") from exc
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


async def _list(
    hass: HomeAssistant, model_id: str | None, path: str, params: dict[str, str], section: str,
) -> tuple[IrEntry, ...]:
    key = await _require_key(hass, model_id)
    return _entries(await _fetch(hass, key, path, params), section)


async def async_types(hass: HomeAssistant, model_id: str | None) -> tuple[IrEntry, ...]:
    """The catalogue's device types (television, set-top box …)."""
    return await _list(hass, model_id, "", {}, "types")


async def async_brands(
    hass: HomeAssistant, model_id: str | None, type_id: str | int, top: int | None = None,
) -> tuple[IrEntry, ...]:
    """The brands of a device type, alphabetically, or the *top* most common.

    Filtered in the panel: the API accepts ``search`` and then ignores it.
    """
    params = {"top": str(top)} if top else {}
    return await _list(hass, model_id, f"{type_id}/", params, "brands")


async def async_code_sets(
    hass: HomeAssistant, model_id: str | None, type_id: str | int, brand_id: str | int,
) -> tuple[IrCodeSet, ...]:
    """Every readable code set of a brand, with the key ids its blob carries.

    The empty model segment asks for all models.
    """
    key = await _require_key(hass, model_id)
    payload = await _fetch(
        hass, key, f"{type_id}/{brand_id}//signal", {"output": "base64_blob"},
    )
    sets = []
    for row in _rows(payload, "remotes", "remote"):
        wrapper = row.get("base64")
        blob = str(wrapper.get("content") or "").strip() if isinstance(wrapper, dict) else ""
        if not blob:
            continue
        try:
            records = ir_blob.parse(blob)
        except ir_blob.IrBlobError as err:
            _LOGGER.debug("IR catalogue: skipping an unreadable code set: %s", err)
            continue
        sets.append(IrCodeSet(
            ir_blob.checksum(blob), blob, frozenset(r.key_id for r in records),
        ))
    if not sets:
        raise IrCatalogError("catalogue returned no usable code set", "ir_catalog_empty")
    _LOGGER.debug("IR catalogue: %d code sets for %s/%s", len(sets), type_id, brand_id)
    return tuple(sets)
