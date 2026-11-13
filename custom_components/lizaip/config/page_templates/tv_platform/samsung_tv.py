"""Samsung TV: the apps it has, and starting one.

A Tizen TV from 2020 on ignores the request for its installed apps that Home
Assistant's integration sends, so its ``source_list`` is just ``TV`` and
``HDMI``; it ignores the integration's websocket launch too. Its REST API on
port 8001 still answers for one app at a time:

    GET  /api/v2/applications/<id>   its name when installed, 404 when not
    POST /api/v2/applications/<id>   start it

So the TV is asked about every app of Samsung's own TV app store for its
country -- the list the TV's store shows, with each app's icon -- about 2,700
questions, some 25 seconds. What it has is kept in HA's storage and answers at
once; the TV is asked again in the background every few hours. Apps built into
the TV and not in the store (Samsung TV Plus) are not found.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Final

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .base import TvPlatform

_LOGGER = logging.getLogger(__name__)

PORT: Final = 8001
PLATFORM: Final = "samsungtv"
_TIMEOUT_S: Final = 4
_PARALLEL: Final = 16

#: Samsung's TV app store listing, the one its TVs read.
STORE_API: Final = "https://vdapi.samsung.com/tvs/tvpersonalize/api/tvapps/appserver/list"
_STORE_PAGE: Final = 1000
_STORE_TIMEOUT_S: Final = 60
_STORE_MAX_AGE_S: Final = 7 * 86400
_ICON_SIZE: Final = "198x198"
#: How long a TV's apps stand before it is asked again, in the background.
RESCAN_S: Final = 6 * 3600

#: What the store lists as apps but are the TV's own settings pages: privacy
#: choices, Samsung TV Plus privacy settings, SecurityCenter, the user guide.
NOT_APPS: Final = frozenset({"3202001019999", "3202104023374", "3202407036314", "20252100002"})

STORAGE_KEY: Final = "lizaip.samsung_apps"
_DATA_KEY: Final = "lizaip_samsung_apps"


class _State:
    def __init__(self, hass: Any) -> None:
        self.store = None
        if getattr(hass, "config", None) is not None:
            from homeassistant.helpers.storage import Store

            self.store = Store(hass, 1, STORAGE_KEY)
        #: country -> {"at": epoch, "icons": {app id: icon url}}
        self.stores: dict[str, dict] = {}
        #: host -> {"at": epoch, "apps": [browse rows]}
        self.tvs: dict[str, dict] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.loaded = self.store is None

    async def load(self) -> None:
        if self.loaded:
            return
        data = await self.store.async_load() or {}
        self.stores = dict(data.get("stores") or {})
        self.tvs = dict(data.get("tvs") or {})
        self.loaded = True

    def save(self) -> None:
        if self.store is not None:
            self.store.async_delay_save(lambda: {"stores": self.stores, "tvs": self.tvs}, 5)


#: A hass without ``data`` (a test's) still gets one state.
_fallback: _State | None = None


async def _state(hass: Any) -> _State:
    global _fallback
    data = getattr(hass, "data", None)
    if isinstance(data, dict):
        if _DATA_KEY not in data:
            data[_DATA_KEY] = _State(hass)
        state = data[_DATA_KEY]
    else:
        _fallback = _fallback or _State(None)
        state = _fallback
    await state.load()
    return state


def samsung_host(hass: HomeAssistant, entity_id: str) -> str:
    """The address of the Samsung TV behind *entity_id*, or ``""``."""
    from homeassistant.helpers import entity_registry as er

    try:
        entry = er.async_get(hass).async_get(entity_id)
    except Exception:  # noqa: BLE001 - no registry, no Samsung
        return ""
    if entry is None or entry.platform != PLATFORM or not entry.config_entry_id:
        return ""
    config_entry = hass.config_entries.async_get_entry(entry.config_entry_id)
    return str((config_entry.data.get("host") if config_entry else "") or "")


async def launch(hass: HomeAssistant, host: str, app_id: str) -> bool:
    """Start *app_id* on the TV at *host*; ``False`` when it did not."""
    url = f"http://{host}:{PORT}/api/v2/applications/{app_id}"
    try:
        async with async_get_clientsession(hass).post(url, timeout=_TIMEOUT_S) as resp:
            return resp.status == 200
    except Exception as exc:  # noqa: BLE001 - an off TV
        _LOGGER.debug("Samsung app %s on %s not started: %s", app_id, host, exc)
        return False


async def _country(hass: HomeAssistant, host: str) -> str | None:
    """The TV's store country, or ``None`` while it cannot be asked."""
    try:
        async with async_get_clientsession(hass).get(
            f"http://{host}:{PORT}/api/v2/", timeout=_TIMEOUT_S,
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
    except Exception:  # noqa: BLE001 - an off TV
        return None
    device = data.get("device") if isinstance(data, dict) else None
    return str((device or {}).get("countryCode") or "").upper() or None


async def _fetch_store(hass: HomeAssistant, country: str) -> dict[str, str]:
    icons: dict[str, str] = {}
    session = async_get_clientsession(hass)
    for page in range(20):
        params = {
            "country_code": country, "language_code": "en-US",
            "offset": str(page), "size": str(_STORE_PAGE), "order": "asc",
        }
        async with session.get(STORE_API, params=params, timeout=_STORE_TIMEOUT_S) as resp:
            resp.raise_for_status()
            payload = await resp.json(content_type=None)
        batch = ((payload or {}).get("data") or {}).get("tvApp") or []
        for app in batch:
            app_id, url = str(app.get("appId") or ""), str(app.get("appImageUrl") or "")
            if app_id:
                icons[app_id] = url.replace("{w}x{h}", _ICON_SIZE).replace("http://", "https://", 1)
        if len(batch) < _STORE_PAGE:
            break
    return icons


async def _store_icons(hass: HomeAssistant, state: _State, country: str) -> dict[str, str]:
    """The store's apps for *country* and their icons; a stale list beats none."""
    kept = state.stores.get(country) or {}
    if kept.get("icons") and time.time() - kept.get("at", 0) < _STORE_MAX_AGE_S:
        return kept["icons"]
    try:
        icons = await _fetch_store(hass, country)
    except Exception as exc:  # noqa: BLE001 - offline: the list kept stands
        _LOGGER.debug("Samsung store list for %s not read: %s", country, exc)
        return kept.get("icons") or {}
    if icons:
        state.stores[country] = {"at": time.time(), "icons": icons}
        state.save()
    return icons or kept.get("icons") or {}


async def _installed(hass: HomeAssistant, host: str, app_id: str, gate: asyncio.Semaphore) -> str | None:
    """The app's name when the TV has it, else ``None``."""
    url = f"http://{host}:{PORT}/api/v2/applications/{app_id}"
    try:
        async with gate, async_get_clientsession(hass).get(url, timeout=_TIMEOUT_S) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
    except Exception:  # noqa: BLE001 - an app not asked is an app not listed
        return None
    name = data.get("name") if isinstance(data, dict) else None
    return name if isinstance(name, str) and name else None


async def _scan(hass: HomeAssistant, state: _State, host: str) -> list[dict] | None:
    """Ask the TV about every store app; ``None`` when it cannot be asked."""
    lock = state.locks.setdefault(host, asyncio.Lock())
    async with lock:
        if (country := await _country(hass, host)) is None:
            return None
        icons = await _store_icons(hass, state, country)
        if not icons:
            return None
        gate = asyncio.Semaphore(_PARALLEL)
        ids = [i for i in icons if i not in NOT_APPS]
        names = await asyncio.gather(*(_installed(hass, host, i, gate) for i in ids))
        rows = [
            {"title": name, "media_content_id": app_id, "media_content_type": "app",
             "thumbnail": icons[app_id]}
            for app_id, name in zip(ids, names) if name
        ]
        _LOGGER.debug("Samsung TV %s has %d of %d store apps", host, len(rows), len(ids))
        if rows:
            state.tvs[host] = {"at": time.time(), "apps": rows}
            state.save()
        return rows


async def installed_apps(hass: HomeAssistant, host: str) -> list[dict]:
    """The store apps the TV at *host* has, as browse entries with their icons."""
    state = await _state(hass)
    kept = state.tvs.get(host) or {}
    if kept.get("apps"):
        lock = state.locks.get(host)
        if time.time() - kept.get("at", 0) > RESCAN_S and not (lock and lock.locked()):
            hass.async_create_background_task(
                _scan(hass, state, host), f"lizaip samsung apps {host}",
            )
        return [dict(r) for r in kept["apps"] if r.get("media_content_id") not in NOT_APPS]
    return [dict(r) for r in (await _scan(hass, state, host) or [])]


async def entity_apps(hass: HomeAssistant, entity: Any) -> list[dict]:
    """The apps of the Samsung TV behind the media player *entity*."""
    host = samsung_host(hass, getattr(entity, "entity_id", "") or "")
    return await installed_apps(hass, host) if host else []


class SamsungTv(TvPlatform):
    integration = "samsungtv"

    async def fallback_apps(self, hass: HomeAssistant, entity: Any) -> list[dict]:
        return await entity_apps(hass, entity)
