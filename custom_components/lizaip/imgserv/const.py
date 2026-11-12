"""Constants for the lizaIP Image Server.

**What belongs here:** the vocabulary of an image — colours, sizes,
transparency, alpha, fonts — plus the HTTP names built from them (``SIZE_IDS``,
``COLOR_NAMES``, ``MODE_DEFAULTS``, ``PALETTE_NAMES``). These are shared by
several modules *and* by the config panel, and they are what a user actually
sees, so one file is the right home for them.

Reading a font file is :mod:`.fonts`'s, and how a source is spelled --
its type and the parts of a title -- is :mod:`.source_parse`'s.

**What does not:** numbers that only make sense next to the code they steer —
the SVG supersampling factor, the text padding, where a dashboard plugin installs
its JS. Those live in the module that uses them, where the comment explaining
them is one screen away from the algorithm they belong to. Hoisting them here
would only put distance between a value and its reason.
"""
from __future__ import annotations

import re
from functools import cache
from pathlib import Path
from typing import Any, Final, NamedTuple

import yaml

# ── The default theme ─────────────────────────────────────────────────────

#: The look a remote has when it has picked no theme: its colours, its text
#: and its glyphs. The single place those are written down -- the colour
#: names, the palette, the title and tooltip font below and the icon table in
#: ``shared.icon_defaults`` are all read from it, so there is no second copy
#: in code to drift from what the panel shows and edits.
DEFAULT_THEME_FILE: Final = (
    Path(__file__).parent.parent / "assets" / "themes" / "default.yaml"
)


@cache
def load_default_theme_file() -> dict[str, Any]:
    """``default.yaml`` as read, once. Fails loudly: nothing draws without it.

    This is the file shipped with the integration, never a user's copy, so a
    failure here is a broken install rather than a typo to be tolerated.
    """
    try:
        with DEFAULT_THEME_FILE.open(encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except (OSError, yaml.YAMLError) as err:
        raise RuntimeError(f"lizaIP: cannot read {DEFAULT_THEME_FILE}: {err}") from err
    if not isinstance(data, dict):
        raise RuntimeError(f"lizaIP: {DEFAULT_THEME_FILE} holds no theme")
    return data


def _default_rgba(value: Any, label: str) -> tuple[int, int, int, int]:
    raw = str(value).strip().lstrip("#") if isinstance(value, str) else ""
    if not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", raw):
        raise RuntimeError(
            f"lizaIP: {DEFAULT_THEME_FILE.name}: {label} is not a quoted hex colour: {value!r}"
        )
    alpha = int(raw[6:8], 16) if len(raw) == 8 else 255
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), alpha)


def _default_colors() -> tuple[dict[str, tuple], dict[str, tuple], tuple]:
    """``(palette, states, default)`` from the default theme's ``colors:``."""
    colors = load_default_theme_file().get("colors") or {}
    palette = {
        str(entry["name"]).strip().lower(): _default_rgba(entry.get("hex"), f"palette {entry['name']!r}")
        for entry in colors.get("palette") or []
        if isinstance(entry, dict) and entry.get("name")
    }
    states = {
        name: _default_rgba((colors.get("states") or {}).get(name), f"state {name!r}")
        for name in ("on", "off", "unavailable", "default")
    }
    return palette, states, states["default"]


def _default_text(kind: str) -> dict[str, Any]:
    given = (load_default_theme_file().get("text") or {}).get(kind) or {}
    font, size = given.get("font"), given.get("font_size")
    if not isinstance(font, str) or not font.strip() or not isinstance(size, int):
        raise RuntimeError(
            f"lizaIP: {DEFAULT_THEME_FILE.name}: text.{kind} needs a font and a font_size"
        )
    return {"font": font.strip().lower(), "font_size": size}


_DEFAULT_PALETTE, _DEFAULT_STATES, _DEFAULT_FG = _default_colors()

# Default image settings
MAX_SIZE: Final = 512

class SizeSpec(NamedTuple):
    """A symbolic size: the canvas, and the font size text is drawn at on it."""

    width: int
    height: int
    font_size: int


# Symbolic size IDs. A text render without an explicit `font_size=` takes the
# font size from here. The page title and tooltip URLs sent to the remote carry
# it explicitly as well (`resolve_title_url`, `resolve_tooltip_url`): the remote
# caches images by URL, so a new value here has to change the URL to reach it.
#
# The canvas is the device's; the title and tooltip font sizes are the default
# theme's, so they come from ``default.yaml``.
SIZE_IDS: Final = {
    "tile": SizeSpec(50, 52, 52),
    "title": SizeSpec(200, 50, _default_text("title")["font_size"]),
    "tooltip": SizeSpec(200, 40, _default_text("tooltip")["font_size"]),
}

# Smaller than this is unreadable on the remote's screen. It sits beside the
# strip heights because they are the other half of the same range, and both
# the panel's validator and the theme writer need it.
MIN_FONT_SIZE: Final = 6

# A request that says nothing about size is overwhelmingly a button face, so the
# tile is what it gets. Asking for an image without naming a size used to yield
# a 60×60 square that fit nothing on the device and had to be scaled by whoever
# received it; making the common case correct by default removes that step.
DEFAULT_SIZE_ID: Final = "tile"
DEFAULT_SIZE: Final = SIZE_IDS[DEFAULT_SIZE_ID][:2]

# Symbolic color names → (R, G, B, A)
#
# The hues and the four state names (`on`, `off`, `unavailable`, `default`)
# are the default theme's and are read from ``default.yaml``, where the
# reasons for each value are written beside it. Only the two that are not a
# looks decision stay here: `black` is what `?mode=light` draws with, and
# `transparent` is the empty canvas itself.
#: State colour names from before the rename, still read in a URL so a page
#: saved with ``?fg=disabled`` keeps its colour. Never written.
LEGACY_COLOR_ALIASES: Final = {"enabled": "on", "disabled": "off"}

COLOR_NAMES: Final = {
    **_DEFAULT_PALETTE,
    "black": (0, 0, 0, 255),
    "transparent": (0, 0, 0, 0),
    **_DEFAULT_STATES,
}


# ── Transparency and alpha ────────────────────────────────────────────────

#: Where ``render_text`` records the rows of its line, ``(top, baseline,
#: bottom)`` in ``Image.info``: from the highest any glyph of the font reaches to the
#: lowest. ``?crop=`` cuts a text image to exactly that band, never to its ink.
TEXT_BAND_INFO: Final = "lizaip_text_band"

# The canvas every renderer draws on, and the colour ``autocrop`` trims away.
# Renderers never paint a background, so "empty" always means exactly this —
# which is what lets the crop step run without being told which colour the
# mount step will use.
TRANSPARENT: Final = (0, 0, 0, 0)

# What ``flatten_alpha`` composites onto when the alpha channel is dropped.
# Black because that is what the device's screen is: a flattened PNG then
# matches what an alpha-capable client would have composited anyway.
FLATTEN_COLOR: Final = (0, 0, 0)

# The single opacity the percent overlay works at, for both halves of the
# effect: the filled band is tinted *with* it, the unfilled remainder is laid
# over ``bg_color`` *at* it. One constant, because they are one visual idea —
# "this much of the icon is full" — and two numbers would let the fill and the
# dimming drift apart.
PERCENT_TINT_ALPHA: Final = 0.70

# How much of the image height the fill boundary is blurred across, as a
# fraction. A hard switch from ``PERCENT_TINT_ALPHA`` to full alpha draws a
# visible horizontal rule across the glyph, and on a 50px tile that line is as
# prominent as the fill it is meant to describe. Ramping the alpha across a few
# rows instead reads as a level rather than a cut, and it hides the residual
# quantisation step: the boundary between two adjacent ``percent`` values moves
# by less than the width of the ramp, so the fill appears to slide.
PERCENT_FEATHER_FRACTION: Final = 0.08

# Never let the ramp collapse to nothing on a small image — below two rows it
# is a hard edge again — and never let it grow so wide on a large one that the
# fill stops having a discernible top.
PERCENT_FEATHER_MIN_ROWS: Final = 2



# ── Fonts and colours ─────────────────────────────────────────────────────

# The font a text render uses when no ?font= is given: the default theme's
# title font, so a bare `text:` matches the title strip.
DEFAULT_FONT: Final = _default_text("title")["font"]

# Emoji fallback font filename (monochrome, for text tinting)
EMOJI_FONT: Final = "NotoEmoji-Regular.ttf"
# Color emoji font (CBDT bitmap, renders at native EMOJI_NATIVE_SIZE only)
COLOR_EMOJI_FONT: Final = "NotoColorEmoji.ttf"
EMOJI_NATIVE_SIZE: Final = 109  # only valid pixel size for NotoColorEmoji CBDT

DEFAULT_FG_COLOR: Final = _DEFAULT_FG
# The default background is *no* background: the subject is served with its
# alpha intact so the device composites it onto its own dark screen.
DEFAULT_BG_COLOR: Final = TRANSPARENT

FALLBACK_EMOJI_PATHS: Final = (
    "/usr/share/fonts/noto/NotoEmoji-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
)


# ?mode= presets → (default_fg, default_bg).
# These only supply *defaults*: an explicit ?fg=/?color= or ?bg= query param
# always overrides the mode-derived value for its own channel.
MODE_DEFAULTS: Final = {
    "dark": (COLOR_NAMES["white"], COLOR_NAMES["transparent"]),
    "light": (COLOR_NAMES["black"], COLOR_NAMES["transparent"]),
}

# Names offered as icon-tint swatches in the config panel, in display order:
# the default theme's palette, as `default.yaml` lists it.
#
# This is a *subset* of COLOR_NAMES, not all of it, because COLOR_NAMES doubles
# as the `?fg=`/`?bg=` parser's vocabulary — it has to accept values that make no
# sense as a foreground pick:
#   - `transparent` is not a colour; tinting an icon with it renders nothing.
#   - `black` is invisible against the device's permanently dark screen.
#   - `on`/`off`/`unavailable`/`default` name a state, not a pick. Each one
#     draws the same hex as a swatch already on offer, so listing them would put
#     the same colour in the picker twice under a name that promises it tracks
#     a state — which a one-click tint does not.
# All stay parseable (an explicit `?fg=black` still works), they are just not
# offered as one-click choices.
PALETTE_NAMES: Final = tuple(_DEFAULT_PALETTE)


def color_hex(name: str) -> str:
    """Return the ``RRGGBB`` hex for a COLOR_NAMES entry.

    Alpha is dropped: every consumer of this (CSS swatches, the panel's
    ``default_color``, imgserv's own ``?fg=``) works in 6-char hex.
    """
    r, g, b, _a = COLOR_NAMES[name]
    return f"{r:02X}{g:02X}{b:02X}"


def build_palette() -> list[dict[str, str]]:
    """The icon-tint swatch list shared by imgserv and the config panel.

    Returns ``[{"name": "yellow", "hex": "FED430"}, ...]``. The name is what
    imgserv's ``?fg=`` accepts symbolically; the hex is what the panel stores in
    a page's ``default_color`` and paints the swatch with.
    """
    return [{"name": name, "hex": color_hex(name)} for name in PALETTE_NAMES]


# URL base path. Shared by the view (which builds its routes from it) and by
# ``__init__``'s log line, so it is not local to either.
IMG_PATH: Final = "/api/imgserv"


def parse_color(color_str: str | None, names: dict | None = None) -> tuple | None:
    """Parse a color value and return RGBA, or None when invalid/missing.

    *names* is the symbolic vocabulary to read, which a remote's theme may have
    re-coloured. It only ever re-points a name, never removes one, so a button
    configured with ``?fg=blue`` keeps drawing under every theme.
    """
    if not color_str:
        return None
    key = color_str.lower()
    named = (names or COLOR_NAMES).get(LEGACY_COLOR_ALIASES.get(key, key))
    if named:
        return named
    color_str = color_str.lstrip("#")
    try:
        if len(color_str) == 6:
            r, g, b = int(color_str[0:2], 16), int(color_str[2:4], 16), int(color_str[4:6], 16)
            return (r, g, b, 255)
        if len(color_str) == 8:
            r, g, b, a = int(color_str[0:2], 16), int(color_str[2:4], 16), int(color_str[4:6], 16), int(color_str[6:8], 16)
            return (r, g, b, a)
    except ValueError:
        return None
    return None
