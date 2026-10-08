"""WebSocket commands for the debug tools — pre-release builds only.

Not shipped in a stable release: `scripts/public_repo.sh` leaves this file, its
device-side counterpart and the panel's debug view out of the published tree
unless the version carries a pre-release suffix. `register_debug_commands` is
therefore called through a guarded import, and the panel asks
`lizaip_config/get_features` whether the tab exists at all.

The test builds we deploy ourselves rsync the working tree, so the tools are
always present there — presence of the file is the switch, not the version.
"""
from __future__ import annotations

import logging
import random
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from ..device import debug
from ..imgserv.render_mdi import _load_mdi_paths
from .const import generate_page_id
from .snapshot import _fire_config_changed, _get_store, _resolve_device_id

_LOGGER = logging.getLogger(__name__)

#: Page helpers that live in `websocket`, which imports this module and so
#: cannot be imported back; `register_debug_commands` is handed them.
_PAGE_TOOLS: dict[str, Any] = {}


def _connection_for(hass: HomeAssistant, entry_id: str):
    """Return the entry's connection object, or ``None`` if there is none.

    Unlike the send paths, this does not insist on ``conn.connected``. The debug
    tools exist for a remote that is misbehaving, and "not connected" is the
    single most likely thing being investigated — refusing to run the probe in
    exactly that case would withhold the answer being asked for. The device's
    HTTP API is reached over its own address and does not depend on our
    WebSocket being up.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    if not entry or not getattr(entry, "runtime_data", None):
        return None
    return entry.runtime_data


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/debug_probe",
    vol.Required("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_debug_probe(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report whether the device's HTTP API answers, and how quickly."""
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    result = await debug.async_probe_reachability(conn)
    connection.send_result(msg["id"], {**result, "connected": bool(conn.connected)})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/set_debug_port",
    vol.Required("entry_id"): str,
    vol.Required("enabled"): bool,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_debug_port(hass: HomeAssistant, connection, msg: dict) -> None:
    """Open or close the device's debug log port."""
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    try:
        await debug.async_set_debug_port(conn, msg["enabled"])
    except HomeAssistantError as err:
        # Carries a translation key — the panel shows the rendered message.
        connection.send_error(msg["id"], "control_failed", str(err))
        return
    connection.send_result(
        msg["id"],
        {"success": True, "enabled": msg["enabled"], "peer_ip": conn.peer_ip},
    )


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/debug_report",
    vol.Required("entry_id"): str,
    vol.Optional("endpoint"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_debug_report(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return the report's plan, or one section of it.

    Split in two so the panel can show the list at once and fill each row in as
    it lands. Collected in one call, the reader would stare at nothing until the
    slowest endpoint returned — and the slowest is the device's log, which is
    both the largest and the one most often asked for.

    The endpoint is checked against the known list rather than passed on. It
    reaches this from a browser, and a server that will fetch any path it is
    handed is one an admin session can aim at the device's own API.
    """
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return

    endpoint = msg.get("endpoint")
    if endpoint is None:
        connection.send_result(msg["id"], debug.report_plan(conn))
        return

    if endpoint not in debug.REPORT_ENDPOINTS:
        connection.send_error(msg["id"], "unknown_endpoint", f"Unknown endpoint {endpoint}")
        return

    plan = debug.report_plan(conn)
    if not plan["available"]:
        connection.send_result(msg["id"], plan)
        return

    section = await debug.async_fetch_section(conn, endpoint)
    connection.send_result(msg["id"], {"endpoint": endpoint, "section": section})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/debug_logging",
    vol.Required("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_debug_logging(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report which modules are logging and at what level."""
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    connection.send_result(msg["id"], await debug.async_get_logging_setup(conn))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/set_log_level",
    vol.Required("entry_id"): str,
    vol.Required("module"): str,
    # Constrained here as well as in the setter. The schema rejects an unknown
    # level before any device is looked up, and the setter refuses it again for
    # callers that do not come through this command.
    vol.Required("level"): vol.In(debug.LOG_LEVELS),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_log_level(hass: HomeAssistant, connection, msg: dict) -> None:
    """Set one module's log level on the device."""
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    try:
        await debug.async_set_log_level(conn, msg["module"], msg["level"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "control_failed", str(err))
        return
    # The device is read back rather than the request echoed: it merges what it
    # is given, and a level it silently adjusted would otherwise be reported to
    # the user as the one they asked for.
    connection.send_result(msg["id"], await debug.async_get_logging_setup(conn))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/debug_port_state",
    vol.Required("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_debug_port_state(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report whether the device's log port is open, and whether we read it."""
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    connection.send_result(msg["id"], await debug.async_get_debug_port(conn))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/reset_log_levels",
    vol.Required("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_reset_log_levels(hass: HomeAssistant, connection, msg: dict) -> None:
    """Put every module back to the level the device ships with."""
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    await debug.async_reset_log_levels(conn)
    connection.send_result(msg["id"], await debug.async_get_logging_setup(conn))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/debug_traffic",
    vol.Required("entry_id"): str,
    vol.Optional("limit", default=200): vol.All(int, vol.Range(min=0, max=1000)),
    vol.Optional("reset", default=False): bool,
    vol.Optional("log_enabled"): bool,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_debug_traffic(hass: HomeAssistant, connection, msg: dict) -> None:
    """The WebSocket traffic with the remote: round trips, losses, frames.

    ``reset`` starts the counts afresh; ``log_enabled`` switches writing every
    frame to the HA log on or off. Both apply before the snapshot is taken.
    """
    conn = _connection_for(hass, msg["entry_id"])
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    traffic = conn._protocol.traffic
    if msg["reset"]:
        traffic.reset()
    if "log_enabled" in msg:
        debug.set_traffic_logging(conn, msg["log_enabled"])
    connection.send_result(msg["id"], {
        **traffic.snapshot(msg["limit"]), "connected": bool(conn.connected),
    })


def random_page_buttons(
    keys: list[str], pool: list[str], tooltip: str, rng: random.Random,
) -> dict[str, dict]:
    """One page's buttons: an icon from *pool* each, all with one tooltip.

    The pool is dealt out before any icon repeats, so a page with as many
    buttons as the pool has icons shows every one of them.
    """
    deck: list[str] = []
    buttons = {}
    for key in keys:
        if not deck:
            deck = list(pool)
            rng.shuffle(deck)
        buttons[key] = {
            "action_id": None, "config": [], "state_icons": {},
            "label": tooltip or None, "label_edited": bool(tooltip),
            "image": f"mdi:{deck.pop()}", "image_pinned": True,
        }
    return buttons


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/debug_random_pages",
    vol.Required("entry_id"): str,
    vol.Optional("count", default=10): vol.All(int, vol.Range(min=1, max=500)),
    vol.Optional("images", default=12): vol.All(int, vol.Range(min=1, max=5000)),
    vol.Optional("tooltip", default=""): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_debug_random_pages(hass: HomeAssistant, connection, msg: dict) -> None:
    """Add *count* test pages titled ``page <id>``, filled with random icons.

    The icons are *images* distinct MDI names, drawn once and shared by every
    page, so the remote's image store grows with that number rather than with
    the page count. Every button carries the same *tooltip*, for the same
    reason. The pages are plain ones, bound to no layout, and are appended
    after the existing pages.

    Response: ``{success, page_id, page_ids, pages}``; ``page_id`` is the first
    new page, which the panel opens.
    """
    entry_id = msg["entry_id"]
    device_id = _resolve_device_id(hass, entry_id)
    if not device_id:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return

    names = sorted(await hass.async_add_executor_job(_load_mdi_paths))
    if not names:
        connection.send_error(msg["id"], "no_icons", "No MDI icons available")
        return
    rng = random.Random()
    pool = rng.sample(names, min(msg["images"], len(names)))
    keys = [btn["key"] for btn in (await _PAGE_TOOLS["blueprint"](hass, entry_id)).get("buttons", [])]

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    reserved = await _PAGE_TOOLS["reserved_page_ids"](
        store, device_id, {p["id"] for p in pages if isinstance(p, dict)},
    )
    new_ids: list[int] = []
    for _ in range(msg["count"]):
        page_id = generate_page_id(reserved)
        reserved.add(page_id)
        new_ids.append(page_id)
        pages.append({"id": page_id, "image": f"text:page {page_id}", "hash": 0})
        await store.async_set_assignments(
            device_id, page_id, random_page_buttons(keys, pool, msg["tooltip"], rng),
        )
    await store.async_set_pages(device_id, pages)
    for page_id in new_ids:
        await store.async_recompute_page_hash(device_id, page_id)

    await _PAGE_TOOLS["refresh_state_listener"](hass, entry_id)
    await _fire_config_changed(hass, entry_id)
    _LOGGER.info(
        "Added %d random test pages (%d images) for device %s",
        len(new_ids), len(pool), device_id,
    )
    connection.send_result(msg["id"], {
        "success": True,
        "page_id": new_ids[0],
        "page_ids": new_ids,
        "pages": await store.async_get_pages(device_id),
    })


def register_debug_commands(
    hass: HomeAssistant, page_tools: dict[str, Any] | None = None,
) -> None:
    """Register the debug commands; *page_tools* are `websocket`'s page helpers."""
    _PAGE_TOOLS.update(page_tools or {})
    for handler in (ws_debug_probe, ws_set_debug_port, ws_debug_report,
                    ws_debug_logging, ws_set_log_level,
                    ws_debug_port_state, ws_reset_log_levels, ws_debug_traffic,
                    ws_debug_random_pages):
        websocket_api.async_register_command(hass, handler)
