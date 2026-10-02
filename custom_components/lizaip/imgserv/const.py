"""Constants for the lizaIP Image Server.

**What belongs here:** the vocabulary of an image — colours, sizes,
transparency, alpha, fonts — plus the HTTP names built from them (``SIZE_IDS``,
``COLOR_NAMES``, ``MODE_DEFAULTS``, ``PALETTE_NAMES``). These are shared by
several modules *and* by the config panel, and they are what a user actually
sees, so one file is the right home for them.

**What does not:** numbers that only make sense next to the code they steer —
the SVG supersampling factor, the text padding, where a HACS plugin installs
its JS. Those live in the module that uses them, where the comment explaining
them is one screen away from the algorithm they belong to. Hoisting them here
would only put distance between a value and its reason.
"""
from __future__ import annotations

import os
from typing import Final, NamedTuple

from PIL import ImageFont

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
SIZE_IDS: Final = {
    "tile": SizeSpec(50, 50, 50),
    "title": SizeSpec(200, 50, 48),
    "tooltip": SizeSpec(200, 40, 24),
}

# A request that says nothing about size is overwhelmingly a button face, so the
# tile is what it gets. Asking for an image without naming a size used to yield
# a 60×60 square that fit nothing on the device and had to be scaled by whoever
# received it; making the common case correct by default removes that step.
DEFAULT_SIZE_ID: Final = "tile"
DEFAULT_SIZE: Final = SIZE_IDS[DEFAULT_SIZE_ID][:2]

# Symbolic color names → (R, G, B, A)
COLOR_NAMES: Final = {
    "yellow": (254, 212, 48, 255),
    "blue": (72, 203, 245, 255),
    "red": (234, 90, 92, 255),
    "green": (102, 202, 179, 255),
    "white": (255, 255, 255, 255),
    "black": (0, 0, 0, 255),
    "inactive": (140, 143, 166, 255),
    "transparent": (0, 0, 0, 0),
}


# ── Transparency and alpha ────────────────────────────────────────────────

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



# ── Fonts and colours ─────────────────────────────────────────────────────

# Default font ID (used when no ?font= is specified)
DEFAULT_FONT: Final = "filson-light"

# Emoji fallback font filename (monochrome, for text tinting)
EMOJI_FONT: Final = "NotoEmoji-Regular.ttf"
# Color emoji font (CBDT bitmap, renders at native EMOJI_NATIVE_SIZE only)
COLOR_EMOJI_FONT: Final = "NotoColorEmoji.ttf"
EMOJI_NATIVE_SIZE: Final = 109  # only valid pixel size for NotoColorEmoji CBDT

DEFAULT_FG_COLOR: Final = COLOR_NAMES["white"]
# The default background is *no* background: the subject is served with its
# alpha intact so the device composites it onto its own dark screen.
DEFAULT_BG_COLOR: Final = TRANSPARENT

# Bundled fonts directory. This one lives here rather than in render_text
# because ``find_font`` below defaults to it — the lookup and the directory are
# the same thought. The logos directory has no such tie and stays in
# render_logo.py, next to the traversal check that uses it.
FONTS_DIR: Final = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")

# System fallback paths tried when the bundled font is not found
FALLBACK_FONT_PATHS: Final = (
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
)

FALLBACK_EMOJI_PATHS: Final = (
    "/usr/share/fonts/noto/NotoEmoji-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
)



# ── Font lookup ───────────────────────────────────────────────────────────

def font_has_all_glyphs(font_path: str, text: str) -> bool:
    """Return False if *font_path* renders any character as the .notdef glyph."""
    try:
        font = ImageFont.truetype(font_path, 40)
        notdef_mask = font.getmask("\ufffe", mode="1")
        notdef_bytes = bytes(notdef_mask) if notdef_mask else b""
        for ch in text:
            if ord(ch) <= 0x20:
                continue
            mask = font.getmask(ch, mode="1")
            if not mask or mask.size == (0, 0):
                return False
            if bytes(mask) == notdef_bytes and notdef_bytes:
                return False
        return True
    except Exception:
        return False


def find_font(name: str, fonts_dir: str = FONTS_DIR) -> str | None:
    """Find a font file in *fonts_dir* matching *name* (case-insensitive, fuzzy)."""
    if not os.path.isdir(fonts_dir):
        return None
    name_lower = name.lower().replace(" ", "")
    for f in os.listdir(fonts_dir):
        f_lower = f.lower()
        f_base = os.path.splitext(f_lower)[0]
        if f_lower == name_lower or f_base == name_lower:
            return os.path.join(fonts_dir, f)
        name_parts = name_lower.replace("-", " ").replace("_", " ").split()
        f_parts = f_base.replace("-", " ").replace("_", " ").split()
        if all(any(np_ in fp for fp in f_parts) for np_ in name_parts):
            return os.path.join(fonts_dir, f)
    if "regular" not in name_lower:
        return find_font(name + "-regular", fonts_dir)
    return None


# ?mode= presets → (default_fg, default_bg).
# These only supply *defaults*: an explicit ?fg=/?color= or ?bg= query param
# always overrides the mode-derived value for its own channel.
MODE_DEFAULTS: Final = {
    "dark": (COLOR_NAMES["white"], COLOR_NAMES["transparent"]),
    "light": (COLOR_NAMES["black"], COLOR_NAMES["transparent"]),
}

# Names offered as icon-tint swatches in the config panel, in display order.
#
# This is a *subset* of COLOR_NAMES, not all of it, because COLOR_NAMES doubles
# as the `?fg=`/`?bg=` parser's vocabulary — it has to accept values that make no
# sense as a foreground pick:
#   - `transparent` is not a colour; tinting an icon with it renders nothing.
#   - `black` is invisible against the device's permanently dark screen.
# Both stay parseable (an explicit `?fg=black` still works), they are just not
# offered as one-click choices.
PALETTE_NAMES: Final = ("white", "yellow", "blue", "green", "red", "inactive")


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


