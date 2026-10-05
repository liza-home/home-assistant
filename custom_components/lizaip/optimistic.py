"""Short-lived local predictions of where a lamp is heading.

The problem this solves is a round trip. Dragging the remote's slider writes
``light.turn_on`` and then *waits* for the lamp to say what happened before the
icon can follow, and on a Hue bridge that answer is both coalesced and late:
seven commands a quarter-second apart come back as three state events about a
second apart. The fill therefore tracks the lamp's reporting cadence rather than
the user's finger, which reads as lag no amount of tuning on our side can
remove -- the information simply is not here yet.

It is not a Hue defect. Home Assistant's own Hue integration never writes an
optimistic value: ``async_turn_on`` awaits the bridge PUT and returns, and the
entity's brightness is only ever updated from the v2 event stream. The lag is
structural to that design.

So we do what Home Assistant does everywhere it cannot get a fast authoritative
answer -- ``light.template``, ``light.mqtt`` and ``demo`` all set the attribute
they just commanded and write state immediately, flagged by ``assumed_state``.
We already know the value: the slider computed it in order to send it. This
module remembers it for a moment so the tile can be drawn from the user's
intent, and steps aside the instant the lamp confirms.

Deliberately *not* a general state override:

* It only ever carries brightness. A drag cannot change a lamp's colour, and
  guessing at anything else would be inventing state we were never told.
* It expires. A prediction the lamp never confirms -- because it clamped the
  value, was unreachable, or the command was lost -- must not outlive the
  moment it was plausible, or the tile lies until the next gesture.
* It settles on agreement rather than on any update, so the hand-back from
  predicted to real is invisible instead of a flap.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

from homeassistant.core import HomeAssistant, State

from .const import PREDICTED_UPDATE_EVENT

# How long a prediction may stand unconfirmed.
#
# Long enough to cover the bridge's coalescing (~1 s observed) plus a slow
# set_page, short enough that a command the lamp never honoured corrects itself
# within one beat rather than leaving the tile stuck at a level the lamp is not
# showing. The gesture keeps refreshing it, so this is only ever the tail after
# the finger lifts.
PREDICTION_TTL_SECONDS = 2.0

# How close the lamp has to land before the prediction stands down, in raw
# 0-255 brightness.
#
# Sized against the *bridge's* rounding, not against the icon's quantise step.
# Hue stores brightness as a percentage and converts both ways
# (`brightness / 255 * 100`, then back), so a commanded 200 routinely comes back
# as 199 or 201 -- a round-trip error of up to ~1.3. Insisting on equality would
# hold the prediction to its full TTL on every single drag, which is precisely
# the flapping this is meant to avoid.
_BRIGHTNESS_MAX = 255

#
# Tied to the quantise step originally, which was wrong: the step is a
# rendering choice and has since moved, while the error this absorbs is a
# property of the bridge and does not. ~2% of full scale leaves comfortable
# headroom over the observed error without being loose enough to retire a
# prediction the lamp is still ramping towards.
_SETTLE_TOLERANCE = _BRIGHTNESS_MAX * 0.02


@dataclass(frozen=True)
class _Predicted:
    """A `State` stand-in carrying the brightness we just asked for.

    Frozen and minimal on purpose: the readers only ever touch ``entity_id``,
    ``state`` and ``attributes``, and a shim that cannot be written to cannot
    drift from the real state object it stands in for.
    """

    entity_id: str
    state: str
    attributes: dict


_predictions: dict[str, tuple[float, float]] = {}
_expiry_handles: dict[str, object] = {}


def _drop(entity_id: str) -> bool:
    """Forget *entity_id*'s prediction and its pending expiry. True if there was one."""
    handle = _expiry_handles.pop(entity_id, None)
    if handle is not None:
        handle.cancel()
    return _predictions.pop(entity_id, None) is not None


def _expire(hass: HomeAssistant, entity_id: str) -> None:
    """The TTL ran out with no word from the lamp, so redraw the real state.

    Cancelled by every other removal path, so reaching here means the prediction
    is still standing and the tile on the device is still showing it.
    """
    _expiry_handles.pop(entity_id, None)
    if _predictions.pop(entity_id, None) is None:
        return
    hass.bus.async_fire(PREDICTED_UPDATE_EVENT, {"entity_id": entity_id})


def predict(hass: HomeAssistant, entity_id: str, brightness: float) -> None:
    """Record that *entity_id* was just commanded to *brightness*.

    Fires :data:`PREDICTED_UPDATE_EVENT` so the icon path wakes on the command
    rather than on the lamp's eventual reply -- the whole point being that the
    reply is the slow part.
    """
    if not isinstance(brightness, (int, float)) or isinstance(brightness, bool):
        return
    # Both checks precede the clamp: `min(255.0, nan)` is 255.0, so clamping
    # first would turn a NaN into a confident full-brightness prediction.
    try:
        brightness = float(brightness)
    except OverflowError:
        return
    if not math.isfinite(brightness):
        return
    brightness = max(0.0, min(float(_BRIGHTNESS_MAX), brightness))
    _drop(entity_id)
    _predictions[entity_id] = (brightness, time.monotonic() + PREDICTION_TTL_SECONDS)
    _expiry_handles[entity_id] = hass.loop.call_later(
        PREDICTION_TTL_SECONDS, lambda: _expire(hass, entity_id),
    )
    hass.bus.async_fire(PREDICTED_UPDATE_EVENT, {"entity_id": entity_id})


def predicted_brightness(entity_id: str) -> float | None:
    """The live prediction for *entity_id*, or ``None`` if there is not one.

    The timer scheduled by `predict` is what actually retires a prediction and
    repaints. This check only covers a read that beats the callback to it, so
    the two can never disagree about whether a prediction is still standing.
    """
    entry = _predictions.get(entity_id)
    if entry is None:
        return None
    brightness, expires = entry
    if time.monotonic() >= expires:
        _drop(entity_id)
        return None
    return brightness


def settle(state: State | None) -> None:
    """Retire the prediction for *state* once the lamp agrees with it.

    Called for every real state change, so it is also where a lamp that went
    off cancels a prediction outright: a fill level is meaningless then, and
    holding one would keep a dark lamp's tile lit for the rest of the TTL.
    """
    if state is None:
        return
    entity_id = getattr(state, "entity_id", None)
    if entity_id is None or entity_id not in _predictions:
        return

    if getattr(state, "state", None) != "on":
        _drop(entity_id)
        return

    actual = (getattr(state, "attributes", None) or {}).get("brightness")
    if isinstance(actual, bool) or not isinstance(actual, (int, float)):
        return
    predicted = predicted_brightness(entity_id)
    if predicted is None:
        return
    # A lamp reporting an int too large for a float must not raise out of the
    # state callback; it simply tells us nothing about whether we were right.
    try:
        settled = abs(float(actual) - predicted) <= _SETTLE_TOLERANCE
    except OverflowError:
        return
    if settled:
        _drop(entity_id)


def clear_all() -> None:
    """Drop every prediction, cancelling any pending expiry. Tests only."""
    for entity_id in list(_predictions) + list(_expiry_handles):
        _drop(entity_id)


def apply(state: State | None, entity_id: str | None = None) -> State | None:
    """*state* with a live prediction substituted in, if there is one.

    Returns the real state untouched when nothing is predicted, so every caller
    can route through here unconditionally.

    *entity_id* covers the case the prediction exists for: a lamp currently
    ``off`` that the user is dragging *up*. Home Assistant drops ``brightness``
    while a light is off, and the state object may even be missing entirely, so
    without the caller naming the entity there would be nothing to key on --
    and that first push out of off is the most visible one there is.
    """
    key = entity_id or getattr(state, "entity_id", None)
    if key is None:
        return state
    brightness = predicted_brightness(key)
    if brightness is None:
        return state

    attributes = dict(getattr(state, "attributes", None) or {})

    # Zero is the one brightness that does *not* mean "on". Home Assistant
    # coerces the service value to an int, so anything below 1 reaches the lamp
    # as 0, and `light.turn_on` with 0 switches it off -- measured on hardware,
    # not assumed. Predicting "on" there drew a lit tile for a dark lamp, and
    # nothing took it back: dragging down on an *already* off lamp leaves the
    # state unchanged, so no event arrives for `settle` to retire the
    # prediction on, and the fill's floor (one whole step, never 0%) kept the
    # bulb glowing for the full TTL -- refreshed by every slide event, so for
    # the entire gesture plus the tail.
    if int(brightness) == 0:
        attributes.pop("brightness", None)
        return _Predicted(entity_id=key, state="off", attributes=attributes)

    attributes["brightness"] = brightness
    # "on" otherwise: we only predict as a consequence of commanding a
    # brightness, and `light.turn_on` with a non-zero one turns the lamp on.
    # Reporting it as still off would draw an empty tile for the whole trip.
    return _Predicted(entity_id=key, state="on", attributes=attributes)
