"""Event entities for lizaIP — dynamically defined by the device."""
from __future__ import annotations

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .connection import LizaIPConnection
from .entity import LizaIPEntity

PARALLEL_UPDATES = 0  # No limit — event entities are push-only


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data
    known: set[str] = set()

    def on_discovery(discovery: dict) -> None:
        all_ids = discovery.get("buttons", [])   # sliders are handled by number.py
        new = [
            LizaIPButton(connection, entry, bid)
            for bid in all_ids
            if bid not in known
        ]
        if new:
            known.update(b._button_id for b in new)
            async_add_entities(new)

    connection.register_discovery(on_discovery)


class LizaIPButton(LizaIPEntity, EventEntity):
    """A button or slider event entity on a lizaIP device."""

    _attr_translation_key = "button"
    _attr_event_types = ["touch", "click", "release", "repeat"]

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
        button_id: str,
    ) -> None:
        super().__init__(connection, entry)
        self._button_id = button_id
        if button_id.startswith("button") and button_id[6:].isdigit():
            display_id = button_id[6:]
        else:
            display_id = button_id.replace("_", " ").title()
        self._attr_translation_placeholders = {"button_id": display_id}
        self._attr_unique_id = f"{entry.entry_id}_{button_id}"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._connection.register_button(self._button_id, self._handle_event)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_button(self._button_id)
        await super().async_will_remove_from_hass()

    def _handle_event(self, event_type: str, extra: dict) -> None:
        self._trigger_event(event_type, extra)
        self.async_write_ha_state()
