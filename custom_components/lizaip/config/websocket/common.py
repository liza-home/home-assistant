"""Small helpers shared by the websocket handler modules."""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from ...action_controller import setup_state_listener
from ...runtime import _resolve_device_id, entry_connection
from ...shared.logs import DeviceLogger, device_logger
from ..const import step_service
from ..internal_commands import pinned_page_ids
from ..panel_entry import get_panel_entry

_LOGGER = logging.getLogger(__name__)


def entry_log(logger: logging.Logger, hass: HomeAssistant, entry_id: str) -> DeviceLogger:
    """*logger*, naming the remote *entry_id* configures.

    The registry is read through ``getattr`` because a handler may be called
    with a stand-in ``hass`` that has none; an unresolved entry logs unprefixed.
    """
    registry = getattr(hass, "config_entries", None)
    entry = registry.async_get_entry(entry_id) if registry is not None else None
    return device_logger(logger, entry)


def schedule_push_rescan(hass: HomeAssistant, entry_id: str) -> None:
    """Re-subscribe push triggers after the bound speakers may have changed.

    Fire-and-forget, and guarded twice over: a re-scan is an optimisation, so
    neither a missing scheduler nor a failing scan may take down the save the
    user actually asked for.
    """
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        return

    panel_entry = get_panel_entry(hass, entry_id)
    if panel_entry is None or panel_entry.push_triggers is None:
        return
    triggers = panel_entry.push_triggers

    async def _rescan() -> None:
        try:
            await triggers.async_rescan()
        except Exception as err:  # noqa: BLE001
            entry_log(_LOGGER, hass, entry_id).debug(
                "Push trigger re-scan failed: %s", err,
            )

    try:
        create_task(_rescan())
    except Exception as err:  # noqa: BLE001
        entry_log(_LOGGER, hass, entry_id).debug(
            "Could not schedule push trigger re-scan: %s", err,
        )


EMPTY_BUTTON = {"action_id": None, "config": [], "tooltip": None, "icon": None, "icon_pinned": False, "state_icons": {}}


def send_failure(
    hass: HomeAssistant,
    connection,
    msg: dict,
    code: str,
    exc: Exception,
    *,
    logger: logging.Logger = _LOGGER,
    what: str = "Request",
) -> None:
    """Tell the panel a request failed, and the log why.

    Two kinds of failure reach a handler and they are not the same thing. A
    ``HomeAssistantError`` is something the integration decided and worded on
    purpose -- the disk refused the write, the device is not connected -- so its
    message is meant for the user and is passed through. Anything else is a bug
    here: its text names internals the user can do nothing with, so they get a
    fixed sentence and the traceback goes to the log, where it is useful.

    Either way the panel gets an error rather than silence, which is the point:
    a save that failed must not look like a save that worked.
    """
    log = entry_log(logger, hass, msg.get("entry_id", ""))
    if isinstance(exc, HomeAssistantError):
        log.error("%s failed: %s", what, exc)
        connection.send_error(msg["id"], code, str(exc))
        return
    log.error("%s failed unexpectedly", what, exc_info=True)
    connection.send_error(
        msg["id"], code, f"{what} failed. See the Home Assistant log for details.",
    )


def requires_device(handler):
    """Resolve ``msg["entry_id"]`` to a device id, or answer "not found".

    Deliberately does not set ``__wrapped__``: this decorator *is* the handler's
    public 3-argument contract, so callers unwrapping the HA decorators should
    stop here rather than reach the ``device_id`` form underneath.
    """
    async def wrapper(hass: HomeAssistant, connection, msg: dict) -> None:
        device_id = _resolve_device_id(hass, msg["entry_id"])
        if not device_id:
            connection.send_error(msg["id"], "not_found", "Device not found")
            return
        await handler(hass, connection, msg, device_id)

    wrapper.__name__ = handler.__name__
    wrapper.__qualname__ = handler.__qualname__
    wrapper.__doc__ = handler.__doc__
    wrapper.__module__ = handler.__module__
    return wrapper


def live_connection(hass: HomeAssistant, connection, msg: dict):
    """The remote's connection, or ``None`` after telling the panel why not."""
    conn = entry_connection(hass.config_entries.async_get_entry(msg["entry_id"]))
    if conn is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return None
    if not conn.connected:
        connection.send_error(msg["id"], "not_connected", "Device not connected")
        return None
    return conn


async def refresh_state_listener(hass: HomeAssistant, entry_id: str) -> None:
    """Rebuild a loaded remote's state listener after its buttons changed."""
    panel_entry = get_panel_entry(hass, entry_id)
    entry = hass.config_entries.async_get_entry(entry_id)
    if panel_entry is None or entry is None:
        return
    stop = await setup_state_listener(hass, entry)
    if get_panel_entry(hass, entry_id) is not panel_entry:
        stop()  # unloaded while the listener was being built
        return
    panel_entry.replace_state_listener(stop)


async def reserved_page_ids(store, device_id: str, in_use: set[int]) -> set[int]:
    """Page ids unavailable to newly created pages.

    Ids are reserved while any stored goto button still points at them; otherwise
    a deleted page id could be recycled and a stale goto would open the wrong
    page. Page ids are 32-bit, so reserving a few is harmless.

    The reservation is not only the current page list: buttons can pin page ids
    inside their stored action payloads, and those stale references must stay
    harmless until the user repoints or deletes them.
    """
    reserved = set(in_use)
    for page_assigns in (await store.async_get_all_assignments(device_id)).values():
        for assign in (page_assigns or {}).values():
            if not isinstance(assign, dict):
                continue
            config = assign.get("config", [])
            step = (
                config[0]
                if isinstance(config, list) and config and isinstance(config[0], dict)
                else {}
            )
            reserved |= pinned_page_ids(step.get("data"), step_service(config))
    return reserved
