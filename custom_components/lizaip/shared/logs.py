"""Log lines that say which remote they are about.

A system holds more than one lizaIP, and every one of them runs the same code
through the same module loggers: without a name in the line, "Device
connected", "Failed to clear pages on device" or "Hello handshake failed" are
all unattributable the moment a second remote is paired. The few places that
spelled out ``self._entry.title`` by hand only proved the point -- the others
did not, and could not be made to without threading the entry into every
helper.

The adapter prefixes ``[name] `` and is otherwise the logger it wraps, so a
module keeps its ``_LOGGER.debug(...)`` calls, its logger name and its level::

    _LOGGER = logging.getLogger(__name__)          # module level, unchanged
    log = device_logger(_LOGGER, entry)            # per remote
    log.info("Device connected")                   # -> [Living room] Device connected

The name is read at every call, not captured: a remote renamed in the UI shows
its new name in the next line it logs, and an adapter built before the entry
had a title still picks one up later.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from homeassistant.core import HomeAssistant


class DeviceLogger(logging.LoggerAdapter):
    """A logger that names the remote its messages belong to.

    Built by the helpers below rather than directly; they know where a name
    can be found for the handle a caller happens to hold.
    """

    def __init__(self, logger: logging.Logger | logging.LoggerAdapter,
                 name: Callable[[], str | None]) -> None:
        super().__init__(logger, {})
        self._name = name

    def process(self, msg: Any, kwargs: Any) -> tuple[Any, Any]:
        """Put the remote's name in front -- when there is one.

        A nameless remote (an entry still being set up, a device gone from the
        registry) logs unprefixed rather than ``[None]``: the line is worth
        more than the placeholder.
        """
        try:
            name = self._name()
        except Exception:  # noqa: BLE001 - a log call must never raise
            name = None
        return (f"[{name}] {msg}" if name else msg), kwargs


def _entry_title(source: Any) -> str | None:
    """The title of *source*, which may be an entry or hold one."""
    title = getattr(source, "title", None)
    if isinstance(title, str) and title:
        return title
    entry = getattr(source, "_entry", None) or getattr(source, "entry", None)
    title = getattr(entry, "title", None)
    return title if isinstance(title, str) and title else None


def device_logger(logger: logging.Logger | logging.LoggerAdapter,
                  source: Any) -> DeviceLogger:
    """*logger*, naming the remote *source* stands for.

    *source* is whatever the caller has: a ``ConfigEntry``, a
    ``LizaIPConnection`` (or an entity, or anything else carrying ``entry`` /
    ``_entry``), a plain name, or a callable returning one. ``None`` is
    allowed and logs unprefixed, so a call site does not need a branch for the
    case where the entry has not been resolved.
    """
    if source is None:
        return DeviceLogger(logger, lambda: None)
    if isinstance(source, str):
        return DeviceLogger(logger, lambda: source or None)
    if callable(source):
        return DeviceLogger(logger, source)
    return DeviceLogger(logger, lambda: _entry_title(source))


def device_id_logger(logger: logging.Logger | logging.LoggerAdapter,
                     hass: HomeAssistant, device_id: str | None) -> DeviceLogger:
    """*logger*, naming the remote registered as *device_id*.

    For the half of the integration that works from a device registry id and
    never sees the config entry. The registry is asked at each call so a
    rename shows up; the lookup is a dict hit, and these are log calls that
    were going to format a message anyway.
    """
    def _name() -> str | None:
        if not device_id:
            return None
        from homeassistant.helpers import device_registry as dr

        device = dr.async_get(hass).async_get(device_id)
        if device is None:
            return None
        return device.name_by_user or device.name or None

    return DeviceLogger(logger, _name)
