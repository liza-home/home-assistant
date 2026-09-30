"""The device event listener: routes button, slider and page events."""
from __future__ import annotations

import logging

from homeassistant.core import Event, HomeAssistant

from ..const import DOMAIN
from ..device.const import LIZAIP_EVENT
from ._state import (
    _SELECTING_INTERACTIONS,
    _note_page,
    _page_changed,
    clear_slider_state,
    get_current_page,
)
from .buttons import execute_action
from .helpers import _coerce_page_id, _normalize_position, _raw_page_id, _resolve_entry_id
from .selection import _record_selection
from .slider_exec import execute_slider_action
from .sliders import SLIDER_NAME_ALIASES

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public setup / teardown
# ---------------------------------------------------------------------------

def setup(hass: HomeAssistant) -> None:
    """Subscribe to device button and slider events.

    Safe to call repeatedly: any previous subscription is dropped first.
    """
    async def _on_device_event(event: Event) -> None:
        data = event.data
        event_type = data.get("type")
        if event_type not in ("button", "slider", "goto_page"):
            return

        _LOGGER.debug("action_controller: %s event %s", event_type, data)

        entry_id = _resolve_entry_id(hass, data)
        if not entry_id:
            _LOGGER.warning(
                "action_controller: no entry_id for device_id=%s", data.get("device_id"),
            )
            return

        raw_page_id = _raw_page_id(data)

        if event_type == "goto_page":
            # A page change abandons any in-flight slider gesture: the slider
            # may not even exist on the new page, and no touch_end will arrive.
            # Leaving the state behind would make the next touch resume from a
            # stale zero-point. The device selection goes with it — the buttons
            # that produced it are no longer on screen.
            #
            # Unconditional, unlike the check below: an announced navigation is
            # a page change even when it names the page we already thought we
            # were on, because the device is telling us it moved.
            clear_slider_state(entry_id)
            _note_page(entry_id, raw_page_id)
            return

        # Not every page change is announced. Firmware may omit `goto_page`
        # entirely, and navigation the host itself commanded produces only a
        # protocol response. Every button and slider event carries the page it
        # happened on, though, so the change is recoverable from the traffic
        # that is already flowing — and it has to be applied *before* this event
        # is handled, so that the first touch on the new page is already clean
        # rather than the one that pays for the old page's state.
        if _page_changed(entry_id, raw_page_id):
            _LOGGER.debug(
                "action_controller: %s event on page %s, last seen on %s — "
                "treating as a page change",
                event_type, raw_page_id, get_current_page(entry_id),
            )
            clear_slider_state(entry_id)

        # The literal page, never the coerced one: recording the fallback would
        # let an uninitialised event install page 1 as the page every later
        # uninitialised event falls back to.
        _note_page(entry_id, raw_page_id)
        page_id = _coerce_page_id(data, entry_id)
        interaction = data.get("interaction", "click")

        if event_type == "slider":
            raw_slider_name = data.get("slider_name") or ""
            if not raw_slider_name:
                _LOGGER.debug("action_controller: slider event with no slider_name")
                return
            # Normalised once, here: this is the only ingress into the
            # assignment lookup, so the key the lookup, the gesture state and
            # the button fallthrough all use agrees from this point on.
            slider_key = SLIDER_NAME_ALIASES.get(raw_slider_name, raw_slider_name)
            await execute_slider_action(
                hass, entry_id, slider_key, page_id,
                interaction, _normalize_position(data.get("position")),
            )
            return

        button_key = data.get("button_name") or data.get("button") or ""
        if not button_key:
            return

        # Recorded before the click filter below, and on `touch` as well as
        # `click`, because a last-touched slider's target is "the thing you just put
        # your finger on" — waiting for the press to complete would mean a
        # touch-and-drag from a button to the slider drives the *previous*
        # selection.
        if interaction in _SELECTING_INTERACTIONS:
            await _record_selection(
                hass, entry_id, button_key, page_id, interaction=interaction,
            )

        if interaction != "click":
            _LOGGER.debug("  → ignoring interaction=%s (only click fires)", interaction)
            return

        await execute_action(hass, entry_id, button_key, page_id)

    hass.data.setdefault(DOMAIN, {})
    previous_unsub = hass.data[DOMAIN].pop("_button_unsub", None)
    if previous_unsub:
        previous_unsub()

    hass.data[DOMAIN]["_button_unsub"] = hass.bus.async_listen(
        LIZAIP_EVENT, _on_device_event,
    )
