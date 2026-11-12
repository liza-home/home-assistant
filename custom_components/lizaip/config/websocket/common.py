"""Small helpers shared by the websocket handler modules: errors and lookups."""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from ...runtime import entry_connection, resolve_device_id
from ...shared.logs import entry_id_logger

_LOGGER = logging.getLogger(__name__)


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
    log = entry_id_logger(logger, hass, msg.get("entry_id", ""))
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
        device_id = resolve_device_id(hass, msg["entry_id"])
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
