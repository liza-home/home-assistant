"""Events the config side puts on the Home Assistant bus."""
from __future__ import annotations

from homeassistant.core import HomeAssistant, callback

from .const import CONFIG_CHANGED_EVENT, DEVICE_SYNCED_EVENT


@callback
def fire_config_changed(
    hass: HomeAssistant, entry_id: str, *, order_only: bool = False,
    sync_handled: bool = False, refreshed: bool = False,
) -> None:
    """Announce that a config entry's stored configuration changed.

    Heard by the device sync (``panel.py``), the variable listener and any open
    config panel; each reads what it needs from the store. ``order_only`` marks
    a reorder the device has already received, so the sync can skip it, and
    ``sync_handled`` a caller that rebuilds the device itself. ``refreshed``
    marks a dynamic refresh (an Overview filling a slot for a page just added),
    which the panel must not drop while its own page operation is in flight.
    """
    data: dict = {"entry_id": entry_id}
    if order_only:
        data["order_only"] = True
    if sync_handled:
        data["sync_handled"] = True
    if refreshed:
        data["refreshed"] = True
    hass.bus.async_fire(CONFIG_CHANGED_EVENT, data)


@callback
def fire_device_synced(hass: HomeAssistant, entry_id: str) -> None:
    """Announce that a sync reached the device; the memory bars refresh on it."""
    bus = getattr(hass, "bus", None)
    if bus is not None:
        bus.async_fire(DEVICE_SYNCED_EVENT, {"entry_id": entry_id})
