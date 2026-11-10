"""Icons from sets that exist only in the browser (``phu:``, ``hue:``, ...).

HA's frontend lets a plugin register an icon set in ``window.customIcons``;
``ha-icon`` asks it for a shape with ``getIcon(name)``. That code runs in the
browser and nowhere else, but the remote asks imgserv for its pictures
directly, with no browser involved. So the config panel does the browser's
part: it reports which sets are registered, looks up the shapes the remote
needs and uploads them here, where imgserv draws them like any other icon.

Most sets also ship their shapes as a plain table in the file that registers
them, and those are read from ``<config>/www`` directly (:mod:`icon_sets`), so
every icon of such a set draws without any browser -- a name a variable makes
up at runtime included. For the rest the panel stays the source:

Which shapes are needed is known two ways. The panel uploads a value as the
user saves it, so a hand-picked icon is in place before the remote ever asks.
A name the remote asked for and imgserv did not have -- typically one a
template made up, e.g. a battery level -- is remembered as *missing*, and the
panel fills those in the next time it opens.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from ..const import DOMAIN
from .const import NATIVE_SOURCE_TYPES, custom_icon_prefixes, set_custom_icon_prefixes
from .icon_sets import IconSetFiles
from .render import render_multi_path_svg

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY: Final = f"{DOMAIN}.custom_icons"
STORAGE_VERSION: Final = 1
_DATA_KEY: Final = "_custom_icons"

#: Bounds on what a panel can make the integration keep. A set's paths are a
#: few hundred bytes to a few kilobytes; the caps only stop a runaway.
MAX_ICONS: Final = 5000
MAX_PATH_LENGTH: Final = 50_000
MAX_MISSING: Final = 200

#: A miss looks at the files again at most this often, so a set installed or
#: updated through the Marketplace is picked up without a restart.
FILE_RESCAN_SECONDS: Final = 60.0

#: Material's own grid, which ``ha-icon`` assumes when a set gives no viewBox.
DEFAULT_VIEWBOX: Final = (0.0, 0.0, 24.0, 24.0)

_NAME_RE: Final = re.compile(r"^[A-Za-z0-9_.+-]{1,100}$")
_PREFIX_RE: Final = re.compile(r"^[a-z0-9_-]{1,40}$")


def parse_viewbox(value: Any) -> tuple[float, float, float, float]:
    """``"x y w h"`` or four numbers; anything else is the 24x24 default."""
    parts = value.replace(",", " ").split() if isinstance(value, str) else value
    try:
        x, y, w, h = (float(v) for v in parts)
    except (TypeError, ValueError):
        return DEFAULT_VIEWBOX
    return (x, y, w, h) if w > 0 and h > 0 else DEFAULT_VIEWBOX


class CustomIcons:
    """The uploaded shapes, the registered sets, and the names still missing."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.files = IconSetFiles(hass.config.path("www"))
        self._scanned_at: float | None = None
        self._scan_task: asyncio.Task | None = None
        self.icons: dict[str, dict] = {}
        self._reported: set[str] = set()
        #: Insertion-ordered, oldest first, so the cap drops the stalest.
        self.missing: dict[str, None] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        icons = data.get("icons")
        self.icons = icons if isinstance(icons, dict) else {}
        self._reported = set(data.get("prefixes") or [])
        await self.async_scan_files()

    async def async_scan_files(self) -> None:
        """Read the set files under ``www`` again, the changed ones only."""
        self._scanned_at = time.monotonic()
        try:
            await self._hass.async_add_executor_job(self.files.scan)
        except Exception as err:  # noqa: BLE001 - a broken file must not stop imgserv
            _LOGGER.debug("Icon set files could not be read: %s", err)
        self._publish()

    async def async_scan_if_stale(self) -> None:
        """After a miss: look at the files again, unless that was done just now."""
        if self._scanned_at is not None and time.monotonic() - self._scanned_at < FILE_RESCAN_SECONDS:
            return
        if self._scan_task is None or self._scan_task.done():
            self._scan_task = self._hass.async_create_task(self.async_scan_files())
        await asyncio.shield(self._scan_task)

    def has(self, prefix: str, name: str) -> bool:
        return f"{prefix}:{name}" in self.icons or self.files.get(prefix, name) is not None

    def _publish(self) -> None:
        """Registered = what the browser reported plus every set with a stored shape.

        A plugin can register its set after the panel first looks, and a phone's
        browser may not run the plugin at all; neither may turn a saved
        ``hue:bulb`` back into the words "hue:bulb".
        """
        set_custom_icon_prefixes(
            self._reported | {k.partition(":")[0] for k in self.icons} | set(self.files.sets)
        )

    def _data(self) -> dict:
        return {"prefixes": sorted(self._reported), "icons": self.icons}

    def _save(self) -> None:
        self._store.async_delay_save(self._data, 1)

    def set_prefixes(self, prefixes) -> None:
        """Adopt the panel's view of which sets are registered."""
        before = custom_icon_prefixes()
        self._reported = set(prefixes or ())
        self._publish()
        self._reported &= custom_icon_prefixes()
        if custom_icon_prefixes() != before:
            self._save()

    def put(self, prefix: str, name: str, path: str,
            secondary_path: str = "", view_box: Any = None) -> bool:
        """Keep one shape; ``False`` when it is not acceptable."""
        if not _PREFIX_RE.match(prefix or "") or prefix in NATIVE_SOURCE_TYPES:
            return False
        if not _NAME_RE.match(name or ""):
            return False
        if not isinstance(path, str) or not path or len(path) > MAX_PATH_LENGTH:
            return False
        if not isinstance(secondary_path, str) or len(secondary_path) > MAX_PATH_LENGTH:
            secondary_path = ""
        key = f"{prefix}:{name}"
        entry = {"path": path, "view_box": list(parse_viewbox(view_box))}
        if secondary_path:
            entry["secondary_path"] = secondary_path
        self.missing.pop(key, None)
        if self.icons.get(key) == entry:
            return True
        self.icons.pop(key, None)
        self.icons[key] = entry
        while len(self.icons) > MAX_ICONS:
            self.icons.pop(next(iter(self.icons)))
        self._publish()
        self._save()
        return True

    def note_missing(self, prefix: str, name: str) -> None:
        """Remember a name the remote asked for and imgserv did not have."""
        if prefix not in custom_icon_prefixes() or not _NAME_RE.match(name or ""):
            return
        key = f"{prefix}:{name}"
        self.missing.pop(key, None)
        self.missing[key] = None
        while len(self.missing) > MAX_MISSING:
            self.missing.pop(next(iter(self.missing)))

    def missing_for(self, prefixes) -> list[dict[str, str]]:
        wanted = set(prefixes)
        return [
            {"prefix": p, "name": n}
            for p, _, n in (k.partition(":") for k in self.missing)
            if p in wanted
        ]

    def sync(self, prefixes) -> dict:
        """``lizaip_config/sync_custom_icons``: take the sets, answer what is missing."""
        self.set_prefixes(prefixes)
        return {"missing": self.missing_for(custom_icon_prefixes())}

    def store(self, items) -> dict:
        """``lizaip_config/store_custom_icons``: keep the shapes, answer how many."""
        return {"stored": sum(
            self.put(i["prefix"], i["name"], i["path"], i.get("secondary_path", ""), i.get("view_box"))
            for i in items
        )}

    def render(self, prefix: str, name: str, width: int, height: int, fg_color: tuple):
        """Draw a stored shape; ``ValueError`` when there is none."""
        entry = self.icons.get(f"{prefix}:{name}") or self.files.get(prefix, name)
        if not entry:
            raise ValueError(f"{prefix}:{name} is neither in its set's file nor uploaded")
        paths = [entry["path"], *([entry["secondary_path"]] if entry.get("secondary_path") else [])]
        return render_multi_path_svg(paths, parse_viewbox(entry.get("view_box")), width, height, fg_color)


def get_custom_icons(hass: HomeAssistant) -> CustomIcons | None:
    return hass.data.get(DOMAIN, {}).get(_DATA_KEY)


async def async_setup_custom_icons(hass: HomeAssistant) -> CustomIcons:
    icons = CustomIcons(hass)
    await icons.async_load()
    hass.data.setdefault(DOMAIN, {})[_DATA_KEY] = icons
    websocket_api.async_register_command(hass, ws_sync_custom_icons)
    websocket_api.async_register_command(hass, ws_store_custom_icons)
    return icons


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/sync_custom_icons",
    vol.Required("prefixes"): [str],
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_sync_custom_icons(hass: HomeAssistant, connection, msg: dict) -> None:
    """Take the browser's registered icon sets; answer the names still missing."""
    icons = get_custom_icons(hass)
    if icons is None:
        connection.send_error(msg["id"], "not_ready", "imgserv is not set up")
        return
    connection.send_result(msg["id"], icons.sync(msg["prefixes"]))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/store_custom_icons",
    vol.Required("icons"): [{
        vol.Required("prefix"): str,
        vol.Required("name"): str,
        vol.Required("path"): str,
        vol.Optional("secondary_path"): str,
        vol.Optional("view_box"): vol.Any(str, [vol.Coerce(float)]),
    }],
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_store_custom_icons(hass: HomeAssistant, connection, msg: dict) -> None:
    """Keep the shapes the panel looked up; answer how many were taken."""
    icons = get_custom_icons(hass)
    if icons is None:
        connection.send_error(msg["id"], "not_ready", "imgserv is not set up")
        return
    connection.send_result(msg["id"], icons.store(msg["icons"]))
