"""Telling a long touch from a click on buttons that have a long touch.

The remote reports a finger landing (``touch``), the press (``click``, sent
while the finger is still down), auto-repeat (``repeat``) and the finger
leaving (``release``). A long touch is a finger resting on the button for
``LONGTOUCH_SECONDS``, pressed or not.

Because ``click`` arrives before anyone knows how long the touch will be, a
button with a long touch holds its click back: it runs on ``release`` if the
finger left in time, and not at all once the long touch has run. Buttons
without a long touch are not tracked and click on press, as before. So are
all buttons while the remote's settings have long touch off.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from homeassistant.core import HomeAssistant

from ..const import LONGTOUCH_SECONDS
from ._state import _button_gestures as _gestures
from .buttons import execute_action, execute_longtouch, longtouch_assignment

_LOGGER = logging.getLogger(__name__)

#: A touch whose ``release`` never arrives is forgotten this long after the
#: long touch ran, so a lost event cannot swallow the next press.
GESTURE_TIMEOUT = 10.0


@dataclass
class _Gesture:
    page_id: int
    timers: list[asyncio.TimerHandle] = field(default_factory=list)
    clicked: bool = False
    fired: bool = False

    def cancel(self) -> None:
        for timer in self.timers:
            timer.cancel()


async def on_touch(hass: HomeAssistant, entry_id: str, button_key: str, page_id: int) -> None:
    """A finger landed: start timing if the button has a long touch.

    The remote repeats ``touch`` after the press while the finger is still
    down, so a touch on a button already being timed changes nothing.
    """
    key = (entry_id, button_key)
    if key in _gestures:
        return
    if not await longtouch_assignment(hass, entry_id, button_key, page_id) or key in _gestures:
        return
    gesture = _Gesture(page_id)
    loop = asyncio.get_running_loop()
    gesture.timers.append(
        loop.call_later(LONGTOUCH_SECONDS, _fire, hass, entry_id, button_key, gesture)
    )
    gesture.timers.append(
        loop.call_later(LONGTOUCH_SECONDS + GESTURE_TIMEOUT, _forget, key, gesture)
    )
    _gestures[key] = gesture


def on_click(entry_id: str, button_key: str) -> bool:
    """A press: ``True`` when it is held back for the release to decide."""
    gesture = _gestures.get((entry_id, button_key))
    if gesture is None:
        return False
    gesture.clicked = True
    return True


async def on_release(hass: HomeAssistant, entry_id: str, button_key: str) -> None:
    """The finger left: run a held-back click unless the long touch ran."""
    gesture = _gestures.pop((entry_id, button_key), None)
    if gesture is None:
        return
    gesture.cancel()
    if gesture.clicked and not gesture.fired:
        await execute_action(hass, entry_id, button_key, gesture.page_id)


def _fire(hass: HomeAssistant, entry_id: str, button_key: str, gesture: _Gesture) -> None:
    if _gestures.get((entry_id, button_key)) is not gesture:
        return
    gesture.fired = True
    _LOGGER.debug("Long touch on %s (%s)", button_key, entry_id)
    hass.async_create_task(
        execute_longtouch(hass, entry_id, button_key, gesture.page_id),
        f"lizaip_longtouch_{button_key}",
    )


def _forget(key: tuple[str, str], gesture: _Gesture) -> None:
    if _gestures.get(key) is gesture:
        del _gestures[key]
