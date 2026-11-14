"""The apps a TV listed last, and their icons, for when it lists none.

A TV that is off answers with no apps -- Samsung drops them from its sources,
webOS cannot reach its icons -- so an Apps page would empty, or hide, every
evening. What a TV listed the last time it listed anything is kept here, in
HA's storage, and stands in while it lists nothing; the icons are kept as
files, and imgserv answers from them while the TV does not.

A runtime cache of what the TV and the stores served this box, never shipped.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import Any
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = "lizaip.app_cache"
STORAGE_VERSION = 1
ICON_DIR = ("lizaip", "app_icons")

_DATA_KEY = "lizaip_app_cache"


class _Cache:
    def __init__(self, hass) -> None:
        from homeassistant.helpers.storage import Store

        self.hass = hass
        self.store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.lists: dict[str, list[dict]] = {}
        self.icons: set[str] = set()
        #: The lists whose icons were prefetched since Home Assistant started.
        self.prefetched: set[str] = set()
        self.loaded = False
        self.lock = asyncio.Lock()

    async def async_load(self) -> None:
        async with self.lock:
            if self.loaded:
                return
            data = await self.store.async_load() or {}
            lists = data.get("lists") if isinstance(data, dict) else None
            self.lists = lists if isinstance(lists, dict) else {}
            self.icons = {_icon_key(i.get("thumbnail")) for v in self.lists.values() for i in v} - {""}
            _remember_hosts(self.icons)
            self.loaded = True


def _get(hass) -> _Cache | None:
    """The cache, or ``None`` where HA's storage is not there (a test's hass)."""
    data = getattr(hass, "data", None)
    if not isinstance(data, dict) or getattr(hass, "config", None) is None:
        return None
    if _DATA_KEY not in data:
        try:
            data[_DATA_KEY] = _Cache(hass)
        except Exception as exc:  # noqa: BLE001 - no cache is no reason to fail
            _LOGGER.debug("App cache unavailable: %s", exc)
            return None
    return data[_DATA_KEY]


def cache_key(entity_id: str, exclude: list[str]) -> str:
    """One list per TV and per set of apps left out."""
    return entity_id if not exclude else f"{entity_id}|{'|'.join(sorted(exclude))}"


def _norm(value: str) -> str:
    """*value* without the ``token`` HA's media proxy turns over every few minutes."""
    value = unquote(value)
    parts = urlsplit(value)
    if "token=" not in parts.query:
        return value
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "token"])
    return urlunsplit(parts._replace(query=query))


def _remember_hosts(icons: set[str]) -> None:
    """Let imgserv fetch from the hosts these icons are on.

    imgserv fetches from a LAN host only once Home Assistant has handed out a
    picture there (``imgserv/media_hosts.py``). An app list is exactly that --
    the TV integration's own answer -- but its icons were not registered until
    a page spelled them, so the prefetch that keeps them was refused, and a TV
    that was then switched off had no icon to fall back on. Also run on load,
    since the record does not survive a restart.
    """
    from ...imgserv import media_hosts

    for icon in icons:
        media_hosts.remember(icon)


def _icon_key(thumbnail: Any) -> str:
    thumb = str(thumbnail or "")
    if thumb.startswith("media:"):
        thumb = thumb[len("media:"):]
    return _norm(thumb) if thumb.startswith(("http", "/")) else ""


async def async_get(hass, key: str) -> list[dict]:
    """The apps last kept under *key*, as item fields; ``[]`` when there are none."""
    cache = _get(hass)
    if cache is None:
        return []
    await cache.async_load()
    return [dict(d) for d in cache.lists.get(key) or [] if isinstance(d, dict)]


async def async_put(hass, key: str, items: list[dict]) -> None:
    """Keep *items* (item fields) as what the TV lists, and fetch their icons.

    An app the TV now lists without its picture -- a TV whose icons live on the
    TV, read while it wakes -- keeps the one it had.
    """
    cache = _get(hass)
    if cache is None or not items:
        return
    await cache.async_load()
    before = {d.get("identity"): d for d in cache.lists.get(key) or [] if isinstance(d, dict)}
    rows = []
    for item in items:
        row = dict(item)
        old = before.get(row.get("identity")) or {}
        if not row.get("thumbnail") and old.get("thumbnail"):
            row["thumbnail"] = old["thumbnail"]
        rows.append(row)
    if cache.lists.get(key) == rows:
        # Unchanged, but once a session its icons are fetched all the same: one
        # refused or missed before is otherwise never asked for again.
        if key in cache.prefetched:
            return
    else:
        cache.lists[key] = rows
        cache.icons = {_icon_key(i.get("thumbnail")) for v in cache.lists.values() for i in v} - {""}
        _remember_hosts(cache.icons)
        cache.store.async_delay_save(lambda: {"lists": cache.lists}, 5)
    cache.prefetched.add(key)
    # Fetched as listed: the proxy's token is what lets imgserv in.
    new = [unquote(str(r.get("thumbnail") or "")).removeprefix("media:") for r in rows]
    hass.async_create_background_task(
        _async_prefetch(hass, [v for v in new if _icon_key(v)]), "lizaip app icon prefetch",
    )


async def async_is_app_icon(hass, value: str) -> bool:
    """Whether imgserv should keep and fall back to the picture at *value*."""
    cache = _get(hass)
    if cache is None:
        return False
    await cache.async_load()
    return _norm(value) in cache.icons


def _icon_path(hass, value: str) -> str:
    name = hashlib.sha256(_norm(value).encode()).hexdigest()[:32]
    return hass.config.path(*ICON_DIR, name)


def _write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _read(path: str) -> bytes | None:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


async def async_save_icon(hass, value: str, data: bytes) -> None:
    """Keep the bytes of an app's icon that was just fetched."""
    if not await async_is_app_icon(hass, value):
        return
    path = _icon_path(hass, value)
    try:
        if await hass.async_add_executor_job(_read, path) != data:
            await hass.async_add_executor_job(_write, path, data)
    except OSError as exc:
        _LOGGER.debug("App icon could not be kept: %s", exc)


async def async_load_icon(hass, value: str) -> bytes | None:
    """The kept bytes of an app's icon, for when it cannot be fetched."""
    if not await async_is_app_icon(hass, value):
        return None
    return await hass.async_add_executor_job(_read, _icon_path(hass, value))


async def _async_prefetch(hass, values: list[str]) -> None:
    """Fetch, one at a time, the icons that are not on disk yet."""
    from ...imgserv.httpsocket import async_fetch_media_bytes

    for value in dict.fromkeys(values):
        path = _icon_path(hass, value)
        if await hass.async_add_executor_job(os.path.exists, path):
            continue
        try:
            data = await async_fetch_media_bytes(hass, value)
        except Exception as exc:  # noqa: BLE001 - the remote fetches it again later
            _LOGGER.debug("App icon prefetch failed for %s: %s", value[:80], exc)
            continue
        await async_save_icon(hass, value, data)
