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

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from ..device import debug


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


def register_debug_commands(hass: HomeAssistant) -> None:
    """Register the debug commands."""
    for handler in (ws_debug_probe, ws_set_debug_port, ws_debug_report,
                    ws_debug_logging, ws_set_log_level,
                    ws_debug_port_state, ws_reset_log_levels):
        websocket_api.async_register_command(hass, handler)
