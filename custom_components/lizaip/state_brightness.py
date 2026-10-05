"""A button icon's fill level, derived from the bound light's brightness.

A lit lamp's tile is drawn partly filled, so the remote shows *how* bright it
is and not merely that it is on::

    brightness 0-255  ->  0-100  ->  snapped to the fill step  ->  ?percent=N

imgserv turns that number into the picture (``render.apply_percent_tint``): the
bottom ``percent``% of the finished image keeps its alpha and the rows above are
dimmed. Nothing about the glyph or its colour changes, so this composes with the
tint in :mod:`state_color` -- a lit lamp's URL carries both ``fg=`` and
``percent=``.

Two deliberate departures, the same two :mod:`state_color` makes and for the
same reasons:

* **Quantised** to :data:`DEFAULT_ICON_FILL_STEP` (or the per-entry override). The value ends up in a *URL*: the
  device caches images by it and ``state_listener`` dedupes on it, so an
  unquantised dimmer ramp would cost a cache entry and a fetch per frame.

  The step is a pixel budget, not a round number. A tile is 50px tall
  (``imgserv.const.SIZE_IDS``) and the glyph is 48px of that after ``crop``, so
  one percent is 0.48 of a row and the fill boundary's *solid* edge can only
  land on ~48 distinct rows however fine the number is. At the old step of 20
  the boundary jumped a fifth of the glyph -- nearly 10px -- at a time, which
  read as the fill snapping between a handful of poses rather than tracking the
  dimmer. At 10 it moved ~4.8px per step: better, but still a visible jump
  between consecutive frames, and that jump is what remained of the
  "steppiness".

  2 is where that stops paying, and it was measured rather than guessed. Every
  tile is 50px (``SIZE_IDS``), so the renderer has a hard ceiling on how many
  distinguishable pictures it can produce; running each candidate step through
  ``render.apply_percent_tint`` and comparing the resulting alpha columns gives:

  ==== ======  ==================  ===============================
  step levels  distinct renders    adjacent levels that differ
  ==== ======  ==================  ===============================
  10       10  10                  9 of 9
  5        20  20                  19 of 19
  2        50  50                  49 of 49
  1       100  **51**              **50 of 99**
  ==== ======  ==================  ===============================

  2 saturates the renderer: every level is its own picture. 1 adds a further 50
  levels and *one* new picture -- half of its levels are byte-identical to their
  neighbour, so they are cache entries and ``set_page`` traffic buying nothing.
  The value is in the URL and one lamp can own a button on three pages, so that
  cost is real while the benefit is not.

  **The default is 5, not the 2 the renderer could carry.** Saturating the
  renderer turned out to be the wrong thing to optimise, because the renderer
  is not the bottleneck -- the device is. Measured on hardware, a ``set_page``
  carrying a ``percent`` the device has never seen takes p50 ~220 ms against
  ~58 ms for one already in its cache, because the novel URL costs it an image
  fetch before it can draw. A sweep at step 2 mints 50 distinct URLs per lamp
  per page and pays that penalty on most of them; at step 5 it mints 20 and
  warms its cache two and a half times sooner, which is what a dimmer sweep
  actually feels like. The renderer still resolves every one of those 20
  levels distinctly, so nothing is lost to aliasing -- only to resolution, and
  2 is still there for anyone who wants it. 5 is the default because it is the
  better *felt* trade, not the finer one.

  Note this is not a *frame-rate* choice either way: ``state_listener`` caps
  pushes at roughly 5/sec whatever the step is. What a finer step buys is that
  each of those frames lands closer to the value the finger is actually at
  rather than on the nearest multiple of the step -- consecutive frames move by
  however far the finger moved instead of by a fixed quantum, which is what the
  remaining "steppiness" was. Sub-row movement survives because
  ``render.apply_percent_tint`` feathers the boundary and the feather's alpha
  can express less than a whole row.
* **Off means no fill** -- ``None``, leaving the URL exactly as it is today. An
  off lamp already says so with its own glyph, and ``percent=0`` would dim that
  glyph whole, which on this display reads as "unavailable" rather than "dark".
  For the same reason a lamp that *is* on never falls below one step: the empty
  tile is spoken for.
"""
from __future__ import annotations

import math
from typing import Final

from homeassistant.core import State

# The one domain with a brightness worth drawing. A fan's percentage and a
# cover's position would fit the same URL, but they are not what this is for.
_BRIGHTNESS_DOMAIN = "light"

#: What HA's ``brightness`` attribute counts up to.
_BRIGHTNESS_MAX = 255

#: Option key on the config entry. Kept here beside the logic it configures,
#: the same way ``slider_throttle`` keeps its own -- the quantiser is the only
#: thing that reads it, and the panel is handed the resolved value rather than
#: the key.
CONF_ICON_FILL_STEP: Final = "icon_fill_step"

#: Bounds device-side image-cache churn and matches what the renderer can
#: actually show. See the docstring for how this number was measured.
DEFAULT_ICON_FILL_STEP: Final = 5

#: A step of 0 has no meaning -- the fill has to advance by *something* -- and
#: the floor doubles as the minimum level an on lamp is held at.
ICON_FILL_STEP_MIN: Final = 1

#: Above this the fill stops describing a level. 25 leaves four visible
#: positions, which is about where it starts reading as a status light rather
#: than a dimmer; 20 (the original) is still reachable for comparison.
ICON_FILL_STEP_MAX: Final = 25

#: Whether a light's brightness fills its button icon at all.
CONF_ICON_FILL_ENABLED: Final = "icon_fill_enabled"

#: Off, so a remote never told to draw fills keeps the flat tiles it has always
#: had. Independent of the tint: a fill is a level, a tint is a colour.
DEFAULT_ICON_FILL_ENABLED: Final = False


def read_fill_enabled(options: object) -> bool:
    """Whether the brightness fill is switched on for an entry's ``options``.

    Defensive like :func:`read_fill_step`: only a real ``True`` switches it on,
    so a damaged option leaves the tiles alone rather than drawing unasked.
    """
    get = getattr(options, "get", None)
    if get is None:
        return DEFAULT_ICON_FILL_ENABLED
    return get(CONF_ICON_FILL_ENABLED) is True


def read_fill_step(options: object) -> int:
    """Return the configured quantise step for an entry's ``options``.

    Takes the mapping rather than the entry so this stays free of Home
    Assistant types, exactly as ``slider_throttle.read_cooldown_seconds`` does.

    Defensive for the same reason that one is: options survive restarts and
    downgrades and can be hand-edited in ``.storage``, and a bad value here
    would raise inside a state callback on every icon update. Anything unusable
    falls back to the default rather than propagating, and a value outside the
    bounds is clamped rather than rejected -- a fill that is coarser than asked
    for is still a fill.
    """
    get = getattr(options, "get", None)
    if get is None:
        return DEFAULT_ICON_FILL_STEP

    raw = get(CONF_ICON_FILL_STEP)
    if raw is None or isinstance(raw, bool):
        return DEFAULT_ICON_FILL_STEP
    # OverflowError too: a hand-edited option can hold an int too large for a
    # float, and this runs in state callbacks where raising stops icon updates.
    try:
        val = float(raw)
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_ICON_FILL_STEP
    # NaN fails every comparison, so it would slip past a naive bounds check
    # and then make `round(percent / step)` return NaN for every tile.
    if not math.isfinite(val):
        return DEFAULT_ICON_FILL_STEP
    return max(ICON_FILL_STEP_MIN, min(ICON_FILL_STEP_MAX, int(val)))


def has_brightness(entity_id: str) -> bool:
    """Whether *entity_id* is in the one domain that can carry a fill level.

    "Could this ever be filled", not "is it filled now": an off lamp yields no
    percent, and that is exactly when its button has to be told to drop the fill
    it is still wearing.
    """
    return entity_id.startswith(f"{_BRIGHTNESS_DOMAIN}.")


def entity_brightness_percent(
    state: State | None,
    assume_state: str | None = None,
    *,
    step: int | None = None,
) -> int | None:
    """Return a 0-100 fill level for *state*, or ``None`` for "no fill".

    *step* is the quantise step, defaulting to :data:`DEFAULT_ICON_FILL_STEP`.
    Passed in rather than read from the entry here so this stays a pure
    function of its arguments -- it is the Python half of a cross-language
    contract with the config panel (``tests/parity_cases.json``), and the panel
    is handed the same resolved number.

    *assume_state* overrides the on/off test without touching the attributes,
    exactly as it does in :func:`state_color.entity_icon_color`, so a press
    predicted to turn a lamp off does not keep drawing the level it is about to
    stop holding.

    Defensive on the attribute itself: ``brightness`` is whatever the source
    integration wrote, and a malformed one must fall back to "no fill", never
    raise inside a state callback.
    """
    if state is None:
        return None
    if not has_brightness(state.entity_id):
        return None

    effective_state = assume_state if assume_state is not None else state.state
    if effective_state != "on":
        return None

    raw = (state.attributes or {}).get("brightness")
    # bool is an int subclass, and `light.brightness: true` out of hand-written
    # YAML would otherwise read as brightness 1.
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    # `raw` is already narrowed to a non-bool int or float, so the only way this
    # fails is an int too large to fit a float.
    try:
        brightness = float(raw)
    except OverflowError:
        return None
    # NaN and the infinities pass the isinstance test and then poison the
    # arithmetic below, where every comparison against NaN is False.
    if not math.isfinite(brightness):
        return None

    percent = max(0.0, min(100.0, brightness / _BRIGHTNESS_MAX * 100))
    quantum = DEFAULT_ICON_FILL_STEP if step is None else step
    snapped = round(percent / quantum) * quantum
    # A lit lamp never draws an empty tile. Below half a step the arithmetic
    # says 0, which dims the glyph whole -- the very picture "off" is supposed
    # to have to itself, so a lamp at 1/255 would be indistinguishable from one
    # that is not on at all. The floor says "on, barely" instead. At a step of
    # 10 it engages below brightness 13/255, so the bottom 5% of the dimmer all
    # draws the same tile -- the price of the coarser step, and a region where
    # the glyph has barely any rows to spend anyway.
    return int(max(quantum, min(100, snapped)))
