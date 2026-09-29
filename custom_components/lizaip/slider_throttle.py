"""Deciding whether a slider movement is worth acting on.

A drag emits a continuous stream of events — the firmware reports while the
finger is down, and ``PROTOCOL.md`` gives no way to ask it for a slower rate
(events are fire-and-forget, and the only configuration channel to the device
covers networking and DemoMode). So the thinning has to happen here, on the
two paths that each turn one event into one piece of work:

* the executor, where every event becomes a ``hass.services.async_call``
* the ``number`` entity, where every event becomes a state write — and every
  state write becomes a recorder row

**The rate limiting itself is Home Assistant's**
:class:`homeassistant.helpers.debounce.Debouncer`, with ``immediate=True``:
the first movement goes through at once and the rest are collapsed into one
call at the end of the cooldown. Its trailing execution is what makes dropping
an event safe — a movement held back is re-run when the cooldown expires
rather than waiting for the finger to lift.

``homeassistant.util.Throttle`` was the other candidate and does not fit: its
``min_time`` is fixed when the decorator is constructed, so it cannot be
configured per config entry, it measures against the wall clock, and it drops
held-back calls outright instead of running the last one.

What is left here is the part no rate limiter can answer, because it is about
*values* rather than timing: whether the position has changed at all since the
last one sent.
"""
from __future__ import annotations

import math
from typing import Final

#: Option key on the config entry. Kept here beside the logic it configures
#: rather than in ``const.py`` — nothing else in the integration reads it.
CONF_SLIDER_MIN_INTERVAL_MS: Final = "slider_min_interval_ms"

#: Roughly four updates a second: fast enough that a drag still looks
#: continuous, slow enough to cut a typical gesture down by an order of
#: magnitude.
DEFAULT_SLIDER_MIN_INTERVAL_MS: Final = 250.0

#: Upper bound for the option. Above this the slider stops behaving like one:
#: two seconds of latency reads as a broken remote.
SLIDER_MIN_INTERVAL_MS_MAX: Final = 2000.0


def _clamped_float(raw: object, default: float, hi: float) -> float:
    """Read an option as a float in ``0..hi``, falling back to `default`.

    Options come from a config entry, which survives restarts and downgrades
    and can be edited by hand in ``.storage``. A bad value here would raise on
    *every event of every drag*, so anything unusable falls back rather than
    propagating.
    """
    if raw is None:
        return default
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return default
    # NaN fails every comparison, so it would slip through a naive bounds check
    # and then be handed to the Debouncer as a cooldown that can never elapse.
    # Infinity is clamped below rather than rejected.
    if math.isnan(val):
        return default
    if val < 0.0:
        return 0.0
    if val > hi:
        return hi
    return val


def read_cooldown_seconds(options: object) -> float:
    """Return the ``Debouncer`` cooldown in seconds for an entry.

    Takes the entry's ``options`` mapping rather than the entry itself so this
    stays free of Home Assistant types. The returned unit is the one used
    downstream — seconds — while the option itself is in milliseconds, which is
    how the value is actually discussed.
    """
    get = getattr(options, "get", None)
    if get is None:
        return DEFAULT_SLIDER_MIN_INTERVAL_MS / 1000.0

    interval_ms = _clamped_float(
        get(CONF_SLIDER_MIN_INTERVAL_MS),
        DEFAULT_SLIDER_MIN_INTERVAL_MS,
        SLIDER_MIN_INTERVAL_MS_MAX,
    )
    return interval_ms / 1000.0


def has_moved(position: float, last_emitted: float | None) -> bool:
    """Whether `position` differs from the last one sent.

    This is the half of the filtering a rate limiter cannot do. The
    ``Debouncer`` decides *how often*; this decides *whether at all*, and a
    movement rejected here is not scheduled, so it does not even become the
    trailing call at the end of a cooldown.

    `last_emitted` is the last position that actually reached the entity — not
    the last event seen. `None` means nothing has been sent yet, which always
    passes.

    The firmware keeps reporting while a finger rests on the slider, so without
    this a motionless touch would send the same value for as long as it stayed
    there.
    """
    return last_emitted is None or position != last_emitted

