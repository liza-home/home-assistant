"""Events the config side puts on the Home Assistant bus."""
from __future__ import annotations

from homeassistant.core import HomeAssistant, callback

from .const import CONFIG_CHANGED_EVENT


@callback
def fire_config_changed(hass: HomeAssistant, entry_id: str, *, order_only: bool = False) -> None:
    """Announce that a config entry's stored configuration changed.

    Heard by the device sync (``panel.py``), the variable listener and any open
    config panel; each reads what it needs from the store. ``order_only`` marks
    a reorder the device has already received, so the sync can skip it.
    """
    data: dict = {"entry_id": entry_id}
    if order_only:
        data["order_only"] = True
    hass.bus.async_fire(CONFIG_CHANGED_EVENT, data)
