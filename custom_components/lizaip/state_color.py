"""A button icon's foreground colour, derived from the bound entity's state.

A port of HA's ``hui-tile-card._computeStateColor``, so a lamp looks the same in
the dashboard and on the remote::

    rgb2hsv(rgb_color)         # h 0-360, s 0-1, v 0-255
    if s < 0.1:  v = 225       # near-white: dim it for contrast
    elif s < 0.4: s = 0.4      # washed out: boost saturation
    hsv2rgb(...) -> hex        # handed to imgserv as ?fg=RRGGBB

Two departures from HA, both because the colour ends up in a *URL* rather than a
CSS variable:

* **Quantised** to :data:`_QUANTIZE_STEP`. The device caches images by URL and
  ``state_listener`` dedupes on it, so an unquantised fade would cost a cache
  entry and a fetch per frame.
* **Off means no colour** — ``""``, letting the page default take over. HA keeps
  ``rgb_color`` on an off light and greys it via CSS, which has no analogue here.
"""
from __future__ import annotations

import math
from typing import Final

from homeassistant.core import State

# Other domains are coloured by state in HA via CSS, which has no analogue here.
_COLORED_DOMAIN = "light"

# Bounds device-side image-cache churn, not a looks decision. See the docstring.
_QUANTIZE_STEP = 8

# HA writes `rgb_color` as three 0-255 integers. Anything outside that is not a
# colour this code can reason about, and a channel far enough out drives the HSV
# arithmetic to NaN rather than merely clipping. See `_parse_rgb`.
_CHANNEL_MAX = 255.0

# HA's contrast fix, verbatim: below _NEAR_WHITE_SATURATION the hue carries
# nothing worth keeping, so dim instead of saturating.
_NEAR_WHITE_SATURATION = 0.1
_MIN_SATURATION = 0.4
_NEAR_WHITE_VALUE = 225

# The one colour mode that is exempt from the two rules above.
#
# The blackbody line HA walks for `color_temp_kelvin` has a near-constant hue,
# so saturation is the *only* thing telling 2700K from 5000K apart. Clamping it
# to _MIN_SATURATION collapses the whole cool half of a tunable-white lamp onto
# one colour -- measured, 3750K through 5500K all came out FFC898 -- and
# _NEAR_WHITE_VALUE then discards the hue and renders 5750K upwards as grey.
# Dragging the temperature slider moved the icon not at all, then snapped it.
#
# Both rules are HA's, and correct in HA: a dashboard can be on a light theme,
# where a pale 5000K white on white cannot be seen. This display is not that.
# `imgserv` flattens every tile onto FLATTEN_COLOR -- black -- so a near-white
# tint reads perfectly, and the contrast those rules buy is contrast already
# had. Only colour-temp lights are exempt; an rgb/hs/xy light keeps HA's
# behaviour exactly, so the divergence is confined to the case that needs it.
_COLOR_TEMP_MODE = "color_temp"

#: Whether a light's colour tints its button icon at all.
CONF_ICON_COLOR_ENABLED: Final = "icon_color_enabled"

#: Off, so a remote that has never been told to tint keeps the flat white
#: glyphs it has always had. Independent of the fill: see
#: ``state_brightness.DEFAULT_ICON_FILL_ENABLED``.
DEFAULT_ICON_COLOR_ENABLED: Final = False


def read_color_enabled(options: object) -> bool:
    """Whether the colour tint is switched on for an entry's ``options``.

    Defensive like ``state_brightness.read_fill_enabled``, and for the same
    reason: only a real ``True`` switches the tint on, so a damaged option
    leaves the glyphs as they were rather than tinting them unasked.
    """
    get = getattr(options, "get", None)
    if get is None:
        return DEFAULT_ICON_COLOR_ENABLED
    return get(CONF_ICON_COLOR_ENABLED) is True


def _rgb_to_hsv(r: float, g: float, b: float) -> tuple[float, float, float]:
    """Port of HA frontend's ``rgb2hsv``. Returns (h 0-360, s 0-1, v 0-255)."""
    v = max(r, g, b)
    c = v - min(r, g, b)
    if not c:
        h = 0.0
    elif v == r:
        h = (g - b) / c
    elif v == g:
        h = 2 + (b - r) / c
    else:
        h = 4 + (r - g) / c
    if h < 0:
        h += 6
    return (60 * h, (c / v) if v else 0.0, v)


def _hsv_to_rgb(h: float, s: float, v: float) -> tuple[float, float, float]:
    """Port of HA frontend's ``hsv2rgb``. Inverse of :func:`_rgb_to_hsv`."""
    def f(n: float) -> float:
        k = (n + h / 60) % 6
        return v - v * s * max(min(k, 4 - k, 1), 0)

    return (f(5), f(3), f(1))


def _channel(value: float) -> int:
    """Clamp a channel to 0-255 and quantise it to :data:`_QUANTIZE_STEP`."""
    clamped = max(0, min(255, round(value)))
    return min(255, round(clamped / _QUANTIZE_STEP) * _QUANTIZE_STEP)


def _parse_rgb(raw: object) -> tuple[float, float, float] | None:
    """Validate an ``rgb_color`` attribute into a 3-tuple of numbers.

    Defensive on purpose: attributes are whatever the source integration wrote,
    and a malformed one must fall back, never raise inside a state callback.
    """
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        return None
    out = []
    for component in raw:
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            return None
        # NaN and the infinities pass the isinstance test and then blow up in
        # `round()`, and an int too big for a float blows up in the conversion
        # itself. Finite is not enough either: a channel far outside 0-255
        # survives the clamp but drives the HSV arithmetic to NaN, which raises
        # out of the same callback. The panel applies the identical range, so
        # rejecting here is also what keeps the two in step.
        try:
            value = float(component)
        except (OverflowError, ValueError):
            return None
        if not math.isfinite(value) or not 0.0 <= value <= _CHANNEL_MAX:
            return None
        out.append(value)
    return (out[0], out[1], out[2])


def is_tintable(entity_id: str) -> bool:
    """Whether *entity_id* is in the one domain that can carry a tint.

    "Could this ever be tinted", not "is it tinted now": an off lamp yields no
    colour, and that is exactly when its button must be told to drop the one it
    is still wearing.
    """
    return entity_id.startswith(f"{_COLORED_DOMAIN}.")


def entity_icon_color(state: State | None, assume_state: str | None = None) -> str:
    """Return a 6-char hex tint for *state*, or ``""`` for "use the default".

    *assume_state* overrides the on/off test without touching the attributes, so
    a press predicted to turn a lamp off does not paint the off icon in the
    colour the lamp is about to stop showing.

    A light *group* is an ordinary light here, drawn in the ``rgb_color`` it
    reports itself — the value HA's tile card uses, so the two always agree.
    Deriving it from the members was tried and dropped: it disagreed with the
    dashboard, and two lamps in different colours average to a colour neither is
    showing.
    """
    if state is None:
        return ""
    if not is_tintable(state.entity_id):
        return ""

    effective_state = assume_state if assume_state is not None else state.state
    if effective_state != "on":
        return ""

    attributes = state.attributes or {}
    rgb = _parse_rgb(attributes.get("rgb_color"))
    if rgb is None:
        return ""

    h, s, v = _rgb_to_hsv(*rgb)
    # A tunable-white lamp is handed on as HA computed it: the two rules below
    # would erase the only difference between one temperature and the next.
    if attributes.get("color_mode") != _COLOR_TEMP_MODE:
        if s < _NEAR_WHITE_SATURATION:
            v = _NEAR_WHITE_VALUE
        elif s < _MIN_SATURATION:
            s = _MIN_SATURATION

    r, g, b = _hsv_to_rgb(h, s, v)
    return f"{_channel(r):02X}{_channel(g):02X}{_channel(b):02X}"
