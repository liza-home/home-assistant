"""The device event listener: routes button, slider and page events."""
from __future__ import annotations

import asyncio
import logging
import time

from homeassistant.core import Event, HomeAssistant

from ..device.const import LIZAIP_EVENT
from ._state import (
    REPEAT_HEARTBEAT_TIMEOUT,
    REPEAT_MAX_SECONDS,
    _SELECTING_INTERACTIONS,
    _note_page,
    _page_changed,
    clear_slider_state,
    get_current_page,
    remote_state,
)
from . import longtouch
from .buttons import execute_action, resolve_button_assignment
from ..runtime import get_store
from ..data import lizaip_data
from ..config.text_style import key_repeat_timing
from ..shared.assignment import key_repeats
from .helpers import _coerce_page_id, _normalize_position, _raw_page_id, _resolve_entry_id
from ..shared.logs import device_id_logger
from .selection import _record_selection
from .slider_exec import execute_slider_action
from .sliders import SLIDER_NAME_ALIASES

_LOGGER = logging.getLogger(__name__)


def _heartbeat(entry_id: str, button_key: str) -> None:
    """The remote says *button_key* is still down."""
    state = remote_state(entry_id)
    if button_key in state.repeat_tasks:
        state.repeat_heartbeat[button_key] = time.monotonic()


def _stop_repeat(entry_id: str, button_key: str) -> None:
    state = remote_state(entry_id)
    task = state.repeat_tasks.pop(button_key, None)
    if task is not None:
        task.cancel()
    state.repeat_heartbeat.pop(button_key, None)


async def _start_repeat(
    hass: HomeAssistant, entry_id: str, button_key: str, page_id: int,
    resolved: tuple[str | None, dict | None] | None = None,
) -> None:
    """Begin key repeat for a just-pressed button, if it repeats.

    *resolved* is the press's ``(device_id, assignment)``, when already read.
    """
    if resolved is None:
        resolved = await resolve_button_assignment(hass, entry_id, button_key, page_id)
    device_id, assign = resolved
    if not key_repeats(assign):
        return
    settings = await get_store(hass).async_get_settings(device_id) if device_id else None
    delay, interval = key_repeat_timing(settings)
    _stop_repeat(entry_id, button_key)
    state = remote_state(entry_id)
    state.repeat_heartbeat[button_key] = time.monotonic()
    state.repeat_tasks[button_key] = asyncio.get_running_loop().create_task(
        _repeat_loop(hass, entry_id, button_key, page_id, delay, interval)
    )


async def _repeat_loop(
    hass: HomeAssistant, entry_id: str, button_key: str, page_id: int,
    delay: float, interval: float,
) -> None:
    """Press *button_key* again every *interval* after *delay*, while it is held.

    Each press is waited for before the next is timed, so an action slower than
    the rate lowers the rate rather than queueing presses behind it.
    """
    state = remote_state(entry_id)
    try:
        await asyncio.sleep(delay)
        deadline = time.monotonic() + REPEAT_MAX_SECONDS
        while time.monotonic() < deadline:
            last = state.repeat_heartbeat.get(button_key)
            if last is None or time.monotonic() - last > REPEAT_HEARTBEAT_TIMEOUT:
                return
            started = time.monotonic()
            await execute_action(hass, entry_id, button_key, page_id)
            await asyncio.sleep(max(0.0, interval - (time.monotonic() - started)))
    finally:
        if state.repeat_tasks.get(button_key) is asyncio.current_task():
            state.repeat_tasks.pop(button_key, None)
            state.repeat_heartbeat.pop(button_key, None)


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

        log = device_id_logger(_LOGGER, hass, data.get("device_id"))
        log.debug("action_controller: %s event %s", event_type, data)

        entry_id = _resolve_entry_id(hass, data)
        if not entry_id:
            log.warning(
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
            log.debug(
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
                log.debug("action_controller: slider event with no slider_name")
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

        if interaction == "touch":
            # A touch after the press means the key came up and the finger
            # merely rests on it: the repeat stops here, not on release.
            _stop_repeat(entry_id, button_key)
            await longtouch.on_touch(hass, entry_id, button_key, page_id)
        elif interaction == "release":
            _stop_repeat(entry_id, button_key)
            await longtouch.on_release(hass, entry_id, button_key)
        elif interaction == "repeat":
            # The remote's own repeat is only a sign the key is still pressed:
            # the presses come from the virtual repeat, at the remote's rate.
            _heartbeat(entry_id, button_key)
            return

        if interaction != "click":
            log.debug("  → ignoring interaction=%s (only click fires)", interaction)
            return

        if longtouch.on_click(entry_id, button_key):
            log.debug("  → click held until release (button has a long touch)")
            return

        # Read once for the repeat and the press; repeats read it afresh.
        resolved = await resolve_button_assignment(hass, entry_id, button_key, page_id)
        await _start_repeat(hass, entry_id, button_key, page_id, resolved)
        await execute_action(hass, entry_id, button_key, page_id, resolved=resolved)

    data = lizaip_data(hass)
    previous_unsub, data.button_unsub = data.button_unsub, None
    if previous_unsub:
        previous_unsub()

    data.button_unsub = hass.bus.async_listen(
        LIZAIP_EVENT, _on_device_event,
    )
