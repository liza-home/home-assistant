"""Number entities for lizaIP — static config controls and dynamically discovered sliders."""
from __future__ import annotations

import logging

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from ..slider_throttle import has_moved, read_cooldown_seconds
from .connection import LizaIPConnection
from .entity import LizaIPEntity

_LOGGER = logging.getLogger(__name__)

PARALLEL_UPDATES = 1  # Serialize brightness commands to a single device


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data

    # Brightness is HA → device direction (static entity, always present)
    async_add_entities([LizaIPBrightness(connection, entry)])

    known: set[str] = set()

    def on_discovery(discovery: dict) -> None:
        # Only register non-brightness sliders (h/v are device → HA direction)
        new = [
            LizaIPSlider(connection, entry, sid)
            for sid in discovery.get("sliders", [])
            if sid not in known and sid != "slider_brightness"
        ]
        if new:
            known.update(s._slider_id for s in new)
            async_add_entities(new)

    connection.register_discovery(on_discovery)




class LizaIPBrightness(LizaIPEntity, NumberEntity):
    """Brightness control — HA sends value to the device (HA → device direction)."""

    _attr_translation_key = "brightness"
    _attr_mode = NumberMode.SLIDER
    _attr_native_min_value = 1
    _attr_native_max_value = 255
    _attr_native_step = 1
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, connection: LizaIPConnection, entry: ConfigEntry) -> None:
        super().__init__(connection, entry)
        self._attr_unique_id = f"{entry.entry_id}_brightness"
        self._attr_native_value = connection.brightness_value
        self._automatic = connection.brightness_automatic

    @property
    def available(self) -> bool:
        # Keep the value visible but block edits while automatic mode is active.
        return super().available and not self._automatic

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._connection.register_brightness(self._handle_brightness_state)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_brightness(self._handle_brightness_state)
        await super().async_will_remove_from_hass()

    def _handle_brightness_state(self, value: float, automatic: bool) -> None:
        self._automatic = automatic
        self._attr_native_value = float(value)
        self._attr_extra_state_attributes = {"automatic": automatic}
        self.async_write_ha_state()

    async def async_set_native_value(self, value: float) -> None:
        if self._automatic:
            _LOGGER.debug("Ignoring manual brightness change while automatic mode is enabled")
            return
        try:
            await self._connection.set_brightness(value)
        except Exception as err:
            _LOGGER.warning("Failed to set brightness to %s: %s", value, err)


class LizaIPSlider(LizaIPEntity, NumberEntity):
    """A slider entity on a lizaIP device."""

    _attr_translation_key = "slider"
    _attr_mode = NumberMode.SLIDER
    _attr_native_min_value = 0
    _attr_native_max_value = 100
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "%"

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
        slider_id: str,
    ) -> None:
        super().__init__(connection, entry)
        self._slider_id = slider_id
        self._attr_translation_placeholders = {"slider_id": slider_id.replace("slider_", "")}
        self._attr_unique_id = f"{entry.entry_id}_{slider_id}"
        self._attr_native_value: float = 0
        # Kept for its options: the rate is configured per config entry.
        self._entry = entry
        # Last position actually written, as a fraction of full travel — the
        # units `has_moved` compares in. None means nothing has been
        # written for the gesture in progress.
        self._last_emitted: float | None = None
        # Created in `async_added_to_hass`, where `self.hass` exists.
        self._debouncer: Debouncer | None = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        cooldown = read_cooldown_seconds(self._entry.options)
        # `immediate=True` so the first movement of a drag is written at once;
        # anything during the cooldown is collapsed into a single trailing call
        # when it expires. That trailing call is what makes dropping events
        # safe: a movement held back is still written a quarter-second later,
        # rather than waiting for the finger to lift.
        self._debouncer = Debouncer(
            self.hass,
            _LOGGER,
            cooldown=cooldown,
            immediate=True,
            function=self._write_now,
        )
        self._connection.register_button(self._slider_id, self._handle_event)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_button(self._slider_id)
        if self._debouncer is not None:
            # Without this a pending trailing call would fire against a removed
            # entity and raise on `async_write_ha_state`.
            self._debouncer.async_shutdown()
            self._debouncer = None
        await super().async_will_remove_from_hass()

    async def _write_now(self) -> None:
        """Publish the current value. Called by the debouncer, never directly."""
        self._last_emitted = float(self._attr_native_value) / 100.0
        self.async_write_ha_state()

    def _handle_event(self, event_type: str, extra: dict) -> None:
        """Mirror a slider event, writing state only when it is worth writing.

        Every state write becomes a recorder row, and a drag emits events for
        as long as the finger is down — so an unfiltered slider writes hundreds
        of rows per gesture, all of them interpolation between two positions
        the user actually chose.

        The value itself is always updated in memory; only the *write* is rate
        limited. That is what makes dropping an event safe here: whatever the
        last event carried is already in `_attr_native_value`, so any write —
        the debouncer's trailing call or the one on release — publishes the
        true current position rather than the last one that survived the filter.
        """
        position = extra.get("position")
        if position is not None:
            self._attr_native_value = float(position)
        meta = {k: v for k, v in extra.items() if k not in ("position", "name", "page_id")}
        if meta:
            self._attr_extra_state_attributes = meta

        # The ends of a gesture always write, and never through the debouncer:
        # the position the finger lifts at is the one that has to be right, so
        # it must not wait out a cooldown. Cancelling first drops any pending
        # trailing call, which would otherwise re-write this same value a
        # moment later. Clearing `_last_emitted` ends the gesture, so the next
        # touch is judged fresh rather than against this drag's last position.
        # An event with no position carries no movement to rate limit.
        if position is None or event_type in ("click", "release"):
            if self._debouncer is not None:
                self._debouncer.async_cancel()
            self._last_emitted = None
            self.async_write_ha_state()
            return

        if not has_moved(float(position) / 100.0, self._last_emitted):
            # Not scheduled at all, so it does not become the trailing call
            # either — a motionless report is discarded, not delayed.
            return

        if self._debouncer is None:
            # Before `async_added_to_hass`, or after removal.
            return
        self._debouncer.async_schedule_call()

    async def async_set_native_value(self, value: float) -> None:
        _LOGGER.warning(
            "Cannot set %s from HA — protocol v1 has no slider-set command; "
            "sliders are device → HA only",
            self._slider_id,
        )
        self._attr_native_value = value
        self.async_write_ha_state()
