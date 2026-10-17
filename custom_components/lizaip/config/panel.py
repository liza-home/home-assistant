"""Panel registration and per-entry state tracking for the lizaIP config."""
from __future__ import annotations

import logging
import os

from aiohttp import web

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.panel_custom import async_register_panel

from ..action_controller import (
    forget_remote,
    get_current_page,
    setup as setup_action_dispatch,
    setup_state_listener,
)
from ..const import DOMAIN, SIGNAL_ICON_UPDATE
from ..shared.i18n import action_labels
from ..shared.icon_urls import resolve_tooltip_url
from ..runtime import entry_connection, _get_store
from .const import CONFIG_CHANGED_EVENT
from .icon_push import IconPushQueue
from .panel_entry import add_panel_entry, pop_panel_entry
from . import device_sync as _device_sync_mod
from .layouts import refresh as _layout_refresh
from .variables import async_setup_variable_listener
from .websocket import register_commands
from ..device.const import LIZAIP_HELLO_EVENT

_LOGGER = logging.getLogger(__name__)

PANEL_DIR = os.path.join(os.path.dirname(__file__), "panel")
PANEL_URL_BASE = "/lizaip_config_panel"
FRONTEND_URL_PATH = "lizaip"


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


def needs_device_sync(event_data: dict, entry_id: str) -> bool:
    """Whether a ``config_changed`` event still has work for the device sync.

    A reorder whose ``set_main_pages`` push already succeeded is marked
    ``order_only``: the device holds the new order, so a sync would rebuild
    every page payload only to find nothing to send. That rebuild is the one
    part of a sync that grows with the number of pages.
    """
    if event_data.get("entry_id") != entry_id:
        return False
    if event_data.get("order_only"):
        _LOGGER.debug("Page order already pushed, skipping the full sync")
        return False
    if event_data.get("sync_handled"):
        # A restore wipes the remote and rebuilds it, which a diffing sync
        # cannot do; two of them at once would undo each other's work.
        _LOGGER.debug("The caller is syncing the device itself, skipping")
        return False
    return True


async def async_setup_panel(hass: HomeAssistant) -> None:
    """One-time setup: register the sidebar panel and WS commands."""
    if hass.data.get(DOMAIN, {}).get("_panel_registered"):
        return

    hass.data.setdefault(DOMAIN, {})

    # Before anything can ask for a label: the ladder that builds tooltips is
    # synchronous and cannot await, so its translations are read here, once,
    # off the loop.
    await action_labels.async_preload(hass)

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

    panel_entry = add_panel_entry(hass, entry.entry_id)

    # Resolve device_id once via the device registry for all closures
    dev_reg = dr.async_get(hass)
    device_id: str | None = None
    for dev in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        if any(ident[0] == DOMAIN for ident in dev.identifiers):
            device_id = dev.id
            break

    # The live icon-update callback below cannot await; read the text settings
    # now so it finds them kept rather than falling back to the defaults.
    store = _get_store(hass)
    if device_id is not None:
        await store.async_get_settings(device_id)

    # State listener → icon updates
    panel_entry.replace_state_listener(await setup_state_listener(hass, entry))

    async def _on_config_changed(event: Event) -> None:
        if needs_device_sync(event.data, entry.entry_id):
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

    async def _send_page(
        page_id: int, buttons: list[dict], img_title: str | None = None,
    ) -> None:
        """One `set_page` round-trip, resolving the connection at send time.

        Looked up per send rather than captured: the queue coalesces across the
        await, so a drain that began while the device was connected can reach
        this line after it dropped. Nothing goes out mid-handshake either: the
        remote answers -4 until its hello is done, and the sync that follows
        the hello sends the current icons anyway.
        """
        conn = entry_connection(entry)
        if not _device_sync_mod.is_ready(conn):
            return
        fields: dict = {"buttons": buttons} if buttons else {}
        if img_title is not None:
            fields["img_title"] = img_title
        await conn.set_page(page_id, **fields)
        _device_sync_mod.note_partial_page(conn, page_id, buttons, img_title)

    push_queue = IconPushQueue(
        _send_page,
        current_page=lambda: get_current_page(entry.entry_id),
    )
    panel_entry.icon_push_queue = push_queue

    # Entity variables in tooltips and icons → push what moved when their
    # entity does, through the queue above.
    panel_entry.on_close(await async_setup_variable_listener(
        hass, entry, _device_sync_mod.async_push_variable_pages
    ))

    # A plain callback, so it cannot start a concurrent round-trip of its own.
    # The tooltip style therefore comes from `cached_settings`, warmed during
    # entry setup, rather than an awaited disk read.
    @callback
    def _on_icon_update(updates: list[dict]) -> None:
        # Resolve page IDs — they are 32-bit integers matching protocol page IDs
        # Group updates by page for efficiency (one set_page call per page)
        page_buttons: dict[int, list[dict]] = {}
        # The same font and size the page sync drew the tooltip in; without
        # them a live update would redraw it in the defaults.
        tooltip_style = None
        for upd in updates:
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
                    tooltip_style = store.cached_settings(device_id)["tooltip"]
                btn_data["img_tooltip"] = resolve_tooltip_url(
                    tooltip, page_color, tooltip_style,
                )

            if len(btn_data) > 1:  # has more than just "name"
                page_buttons.setdefault(pid_int, []).append(btn_data)

        # Handed to the queue rather than sent here, so a dimmer ramp cannot
        # stack four `set_page` requests deep and turn a ~111 ms acknowledgement
        # into a 1.5 s one.
        for pid_int, buttons in page_buttons.items():
            push_queue.submit(pid_int, buttons)
        push_queue.schedule(
            lambda coro: entry.async_create_background_task(
                hass, coro, "lizaip_icon_push",
            ),
        )

    panel_entry.on_close(hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed))
    if device_id is not None:
        panel_entry.on_close(async_dispatcher_connect(
            hass, SIGNAL_ICON_UPDATE.format(device_id), _on_icon_update,
        ))
    panel_entry.on_close(hass.bus.async_listen(LIZAIP_HELLO_EVENT, _on_device_hello))

    # Dynamic-source refresh triggers (goto_page navigation).
    for stop in _layout_refresh.async_setup_entry_triggers(hass, entry):
        panel_entry.on_close(stop)
    _layout_refresh.async_register_service(hass)

    # Source-side push triggers.
    try:
        panel_entry.push_triggers = await _layout_refresh.async_setup_push_triggers(hass, entry)
    except Exception as err:  # noqa: BLE001 - an optimisation must never break setup
        _LOGGER.debug("Dynamic push triggers unavailable for %s: %s", entry.title, err)

    # Initial device sync (best-effort; device likely not connected yet on first boot)
    hass.async_create_task(_device_sync_mod.sync_config_to_device(hass, entry))


async def async_unload_config_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Tear down config-panel listeners for one device entry."""
    panel_entry = pop_panel_entry(hass, entry.entry_id)

    # Gestures, selection and cycle positions all belonged to this entry.
    forget_remote(entry.entry_id)

    # Closing the queue, the listeners and the pending refreshes all at once:
    # a refresh that fired after the entry is gone would resolve a device that
    # no longer exists.
    if panel_entry is not None:
        panel_entry.close()

    # NOTE: the button listener ("_button_unsub") is deliberately NOT torn down here.
    # It is integration-scoped — registered by action_controller.setup() from
    # async_setup, which Home Assistant runs only once per process. This function
    # runs on every entry *unload*, and an unload is not a removal: a plain config
    # entry reload unloads and sets up again. Unsubscribing here would leave the
    # listener dead with nothing to re-register it, so button presses would stop
    # working until Home Assistant restarted.

