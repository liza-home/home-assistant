"""Panel registration and per-entry state tracking for the lizaIP config."""
from __future__ import annotations

import logging
import os

from aiohttp import web

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.panel_custom import async_register_panel

from ..action_controller import (
    clear_slider_state,
    setup as setup_action_dispatch,
    setup_state_listener,
)
from ..const import (
    DOMAIN,
    ICON_UPDATE_EVENT,
    async_preload_action_labels,
    resolve_tooltip_url,
)
from .const import CONFIG_CHANGED_EVENT
from . import device_sync as _device_sync_mod
from .layouts import refresh as _layout_refresh
from .websocket import register_commands
from ..device.const import LIZAIP_HELLO_EVENT

_LOGGER = logging.getLogger(__name__)

PANEL_DIR = os.path.join(os.path.dirname(__file__), "panel")
PANEL_URL_BASE = "/lizaip_config_panel"
FRONTEND_URL_PATH = "liza-remote"


def _panel_version() -> str:
    """Content-derived version string for the panel asset bundle.

    Uses the newest mtime across the panel directory so the version only moves
    when a file actually changes, and always moves when one does — otherwise the
    browser keeps serving the previous bundle from cache.

    Touches the disk, so callers inside the event loop hand it to an executor.
    """
    try:
        newest = max(
            os.path.getmtime(os.path.join(PANEL_DIR, name))
            for name in os.listdir(PANEL_DIR)
            if name.endswith(".js")
        )
    except (OSError, ValueError):
        return "0"
    return str(int(newest))


class LizaIPPanelView(HomeAssistantView):
    """Serve the panel's JS modules under a version-prefixed, no-cache URL.

    The version lives in the *path* rather than a `?v=` query string because the
    panel has no build step: its modules import each other with plain relative
    specifiers (`./liza-remote-svg.js`), which the browser resolves against the
    importing module's URL. Versioning the directory therefore busts the whole
    module graph at once. Versioning only the entry point (the previous
    approach) left the browser free to satisfy those relative imports from cache,
    producing a mixed old/new graph and errors such as
    "Importing binding name 'getPathBounds' is not found".
    """

    url = PANEL_URL_BASE + "/{version}/{filename}"
    name = "lizaip:config_panel"
    requires_auth = False  # panel modules are fetched by the browser without a token

    async def get(self, request: web.Request, version: str, filename: str) -> web.StreamResponse:
        """Return one panel asset, or 404 for anything outside the panel dir."""
        # Reject traversal: only a bare filename directly inside PANEL_DIR is served.
        if filename != os.path.basename(filename) or not filename.endswith(".js"):
            return web.Response(status=404)
        path = os.path.join(PANEL_DIR, filename)
        if not os.path.isfile(path):
            return web.Response(status=404)
        return web.FileResponse(
            path,
            headers={
                "Content-Type": "text/javascript; charset=utf-8",
                # The version prefix already makes each bundle uniquely addressable;
                # no-cache keeps a stale bundle from surviving a version bump that
                # the browser has not noticed yet (e.g. an open tab).
                "Cache-Control": "no-cache, must-revalidate",
            },
        )


async def async_setup_panel(hass: HomeAssistant) -> None:
    """One-time setup: register the sidebar panel and WS commands."""
    if hass.data.get(DOMAIN, {}).get("_panel_registered"):
        return

    hass.data.setdefault(DOMAIN, {})

    # Before anything can ask for a label: the ladder that builds tooltips is
    # synchronous and cannot await, so its translations are read here, once,
    # off the loop.
    await async_preload_action_labels(hass)

    hass.http.register_view(LizaIPPanelView)

    await async_register_frontend_panel(hass)

    register_commands(hass)

    hass.data[DOMAIN]["_panel_registered"] = True


async def async_register_frontend_panel(hass: HomeAssistant) -> None:
    """(Re-)register the sidebar panel at the current asset version.

    Safe to call repeatedly: the existing panel is removed first. Only the panel
    registration is redone — the view and static paths keep their single, stable
    routes.
    """
    version = await hass.async_add_executor_job(_panel_version)
    async_remove_panel(hass, FRONTEND_URL_PATH, warn_if_unknown=False)
    await async_register_panel(
        hass,
        webcomponent_name="liza-remote-panel",
        frontend_url_path=FRONTEND_URL_PATH,
        module_url=f"{PANEL_URL_BASE}/{version}/liza-remote-panel.js",
        sidebar_title="lizaIP",
        sidebar_icon="mdi:remote",
        require_admin=True,
    )
    _LOGGER.debug("lizaIP panel registered at asset version %s", version)


async def async_setup_config_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Set up config-panel state tracking for one device entry."""
    # Re-bind the shared button listener. It is integration-scoped and normally
    # survives an entry reload (async_unload_config_entry no longer removes it),
    # but action_controller.setup() is idempotent, so calling it here is a cheap
    # safety net that also covers a listener lost to a partial/failed setup.
    setup_action_dispatch(hass)

    entry_data = hass.data[DOMAIN].setdefault(entry.entry_id, {})

    # Resolve device_id once via the device registry for all closures
    dev_reg = dr.async_get(hass)
    device_id: str | None = None
    for dev in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        if any(ident[0] == DOMAIN for ident in dev.identifiers):
            device_id = dev.id
            break

    # State listener → icon updates
    entry_data["state_unsub"] = await setup_state_listener(hass, entry)

    async def _on_config_changed(event: Event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            await _device_sync_mod.sync_config_to_device(hass, entry)

    async def _on_device_hello(event: Event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            _LOGGER.debug("Device hello received, syncing config for %s", entry.title)
            # Refresh dynamic bindings first, so the sync that follows carries
            # current items. HA may have been down while the user reorganised
            # their favorites, which is exactly when the stored snapshot is
            # least trustworthy.
            await _layout_refresh.async_handle_hello(hass, entry)
            await _device_sync_mod.sync_config_to_device(hass, entry)

    async def _on_icon_update(event: Event) -> None:
        if event.data.get("device_id") != device_id:
            return
        # Get device connection
        conn = entry.runtime_data if hasattr(entry, "runtime_data") else None
        if conn is None or not getattr(conn, "connected", False):
            return

        # Resolve page IDs — they are 32-bit integers matching protocol page IDs
        # Group updates by page for efficiency (one set_page call per page)
        page_buttons: dict[int, list[dict]] = {}
        # The same font and size the page sync drew the tooltip in; without
        # them a live update would redraw it in the defaults.
        tooltip_style = None
        for upd in event.data.get("updates", []):
            btn_name = upd.get("button_key", "")
            if not btn_name:
                continue
            pid_int = upd.get("page_id", 1)
            if not isinstance(pid_int, int):
                try:
                    pid_int = int(pid_int)
                except (ValueError, TypeError):
                    continue

            btn_data: dict[str, str] = {"name": btn_name}
            icon = upd.get("icon", "")
            if icon:
                btn_data["img_tile"] = icon
            tooltip = upd.get("tooltip")
            if tooltip is not None:
                page_color = upd.get("page_color", "")
                if tooltip_style is None:
                    settings = await hass.data[DOMAIN]["_store"].async_get_settings(device_id)
                    tooltip_style = settings["tooltip"]
                btn_data["img_tooltip"] = resolve_tooltip_url(
                    tooltip, page_color, tooltip_style,
                )

            if len(btn_data) > 1:  # has more than just "name"
                page_buttons.setdefault(pid_int, []).append(btn_data)

        # Send partial set_page per page (only changed buttons)
        for pid_int, buttons in page_buttons.items():
            try:
                await conn.set_page(pid_int, buttons=buttons)
            except Exception as err:
                _LOGGER.warning("set_page (partial) failed for page %s: %s", pid_int, err)

    entry_data["sync_unsub"] = hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed)
    entry_data["icon_sync_unsub"] = hass.bus.async_listen(ICON_UPDATE_EVENT, _on_icon_update)
    entry_data["hello_sync_unsub"] = hass.bus.async_listen(LIZAIP_HELLO_EVENT, _on_device_hello)

    # Dynamic-source refresh triggers (goto_page navigation).
    entry_data.update(_layout_refresh.async_setup_entry_triggers(hass, entry))
    _layout_refresh.async_register_service(hass)

    # Source-side push triggers.
    try:
        entry_data.update(
            await _layout_refresh.async_setup_push_triggers(hass, entry)
        )
    except Exception as err:  # noqa: BLE001 - an optimisation must never break setup
        _LOGGER.debug("Dynamic push triggers unavailable for %s: %s", entry.title, err)

    # Initial device sync (best-effort; device likely not connected yet on first boot)
    hass.async_create_task(_device_sync_mod.sync_config_to_device(hass, entry))


async def async_unload_config_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Tear down config-panel listeners for one device entry."""
    entry_data = hass.data.get(DOMAIN, {}).pop(entry.entry_id, {})

    # An in-flight slider gesture cannot survive the entry going away: its
    # base value was read from an entity this entry owns.
    clear_slider_state(entry.entry_id)

    for key in (
        "state_unsub",
        "sync_unsub",
        "icon_sync_unsub",
        "hello_sync_unsub",
        "dynamic_goto_unsub",
        "dynamic_debounce_unsub",
    ):
        unsub = entry_data.get(key)
        if unsub:
            unsub()

    # Cancelling the pending debounce matters as much as unsubscribing: a
    # scheduled refresh that fires after the entry is gone would resolve a
    # device that no longer exists. Listed explicitly rather than matched on a
    # "dynamic_push_" prefix, because that key space also holds the signal
    # callback and the watched-entity set — calling either would be a bug
    # (the handler would schedule a refresh during teardown).
    for key in ("dynamic_push_unsub", "dynamic_push_debounce_unsub"):
        unsub = entry_data.get(key)
        if not unsub:
            continue
        try:
            unsub()
        except Exception as err:  # noqa: BLE001 - teardown must not raise
            _LOGGER.debug("Push trigger teardown failed for %s: %s", key, err)

    # NOTE: the button listener ("_button_unsub") is deliberately NOT torn down here.
    # It is integration-scoped — registered by action_controller.setup() from
    # async_setup, which Home Assistant runs only once per process. This function
    # runs on every entry *unload*, and an unload is not a removal: a plain config
    # entry reload unloads and sets up again. Unsubscribing here would leave the
    # listener dead with nothing to re-register it, so button presses would stop
    # working until Home Assistant restarted.

