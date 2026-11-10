"""Constants for the lizaIP Image Server.

**What belongs here:** the vocabulary of an image — colours, sizes,
transparency, alpha, fonts — plus the HTTP names built from them (``SIZE_IDS``,
``COLOR_NAMES``, ``MODE_DEFAULTS``, ``PALETTE_NAMES``). These are shared by
several modules *and* by the config panel, and they are what a user actually
sees, so one file is the right home for them.

**What does not:** numbers that only make sense next to the code they steer —
the SVG supersampling factor, the text padding, where a dashboard plugin installs
its JS. Those live in the module that uses them, where the comment explaining
them is one screen away from the algorithm they belong to. Hoisting them here
would only put distance between a value and its reason.
"""
from __future__ import annotations

import io
import os
import re
from functools import cache, lru_cache
from pathlib import Path
from typing import Any, Final, NamedTuple

import yaml
from PIL import ImageFont

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

# Every source but words has a slug for its value, which can never hold a
# space: a logo is a file we ship (`hue`, `netflix_wide`), an icon a
# hyphenated name (`mdi:play-circle`, `phu:sonos`, a registered set's
# `hue:bulb`), a graph an entity id and a picture an address, which spells a
# space `%20`. After one of those the first space starts something else.
WORDS_SOURCE: Final = "text:"

# A picture written as a bare address: an HA path (`/local/a.png`,
# `${_device.entity_picture}`) or an http(s) URL. It is a part of its own, as
# `media:` is, so a title can put a cover beside a mark and a name.
_ADDRESS = re.compile(r"^(?:/\S|https?://)", re.IGNORECASE)


def is_address(word: str) -> bool:
    """Whether *word* is a picture written as a bare address."""
    return bool(_ADDRESS.match(word))

# What may stand between two parts once a space has already divided them. A
# bare hyphen cannot be a separator on its own -- `mdi:play-circle` holds one
# -- but a spaced hyphen can, as can the plus that used to be the spelling.
_PART_LEAD_INS: Final = ("-", "+")

# What a part looks like from the outside: a scheme, then a colon. A word not
# shaped like that belongs to the part it follows, so `text:Hello world` is
# one phrase.
_PART_START = re.compile(r"^([a-z][a-z0-9_]*):")

# The source types imgserv draws itself. Only one of these -- or a registered
# extra icon set -- starts a part: words that merely end in a colon do not, or
# a label like "Go to page: Sonos" would ask imgserv for a `page:` source.
PART_SOURCE_TYPES: Final = frozenset(
    ("mdi", "logo", "text", "media", "ref", "history", "phu"),
)


def has_source_type(word: str) -> bool:
    """Whether *word* is written ``type:…`` at all, a type imgserv knows or not.

    An escaped colon (``text\\:``) writes no type, and nor does a colon a
    space follows: ``battery: 50`` and ``Battery: ${level}`` are words, as a
    label is written. ``battery:50`` names a type, unknown or not yet
    registered.
    """
    m = _PART_START.match(word)
    if not m:
        return False
    rest = word[m.end():]
    return bool(rest) and not rest[0].isspace() or names_a_source(word)


def names_a_source(word: str) -> bool:
    """Whether *word* starts with a source type imgserv draws (``mdi:``, ``hue:``…)."""
    m = _PART_START.match(word)
    return bool(m) and (m.group(1) in PART_SOURCE_TYPES or m.group(1) in _custom_icon_prefixes)


def _is_part_start(word: str) -> bool:
    """Whether *word* names a source, and so starts a part of its own."""
    return is_address(word) or names_a_source(word)


def split_source_parts(source: str) -> tuple[str, ...]:
    """Split *source* into the parts drawn side by side, in order.

    A part ends where the next one starts, and a part starts at a word naming
    a source (``logo:``, ``text:``, ``mdi:``, ``media:``..., or a registered
    icon set) -- not at any word ending in a colon, which is just punctuation. After a slug
    subject plain words start a part too, and are read as the ``text:`` they
    would have to be spelled as anywhere else, so all of these draw the hue
    mark beside the word "Wohnzimmer"::

        logo:hue Wohnzimmer
        logo:hue - Wohnzimmer
        logo:hue + Wohnzimmer
        logo:hue + text:Wohnzimmer
        logo:hue text:Wohnzimmer

    A lone ``-`` or ``+`` between two parts is punctuation and is dropped,
    except where dropping it would change what a part means: a ``text:1 +
    1`` whose next word is not a part of its own is one phrase.

    One part is the common case and comes back as a tuple of one. The rule is
    the whole rule: `_draws_words` and the panel's `_splitSourceParts` read a
    title by it, so preview and device cannot drift apart.
    """
    text = (source or "").strip()
    if not text or " " not in text:
        return (text,) if text else ()

    words = text.split(" ")
    parts: list[str] = [words[0]]
    i = 1
    while i < len(words):
        word = words[i]
        if not word:
            i += 1
            continue
        nxt = next((w for w in words[i + 1:] if w), "")
        if word in _PART_LEAD_INS and (
            _is_part_start(nxt) or _is_slug_part(parts[-1])
        ):
            # Punctuation between two parts, not a part and not a value.
            i += 1
            continue
        if _is_part_start(word) or _is_slug_part(parts[-1]):
            parts.append(word if _is_part_start(word) else f"text:{word}")
        else:
            parts[-1] = f"{parts[-1]} {word}"
        i += 1
    return tuple(p for p in (p.strip() for p in parts) if p)


def _is_slug_part(part: str) -> bool:
    """Whether *part* is a slug subject still holding nothing but its slug."""
    return (
        is_address(part) or (names_a_source(part) and not part.startswith(WORDS_SOURCE))
    ) and " " not in part


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



# ── Font lookup ───────────────────────────────────────────────────────────

FONT_EXTENSIONS: Final = (".ttf", ".otf", ".ttc")
WEBFONT_EXTENSIONS: Final = (".woff", ".woff2")


# Only the three web fonts used last stay decoded, in memory only.
@lru_cache(maxsize=3)
def _decoded_webfont(path: str, _mtime: float) -> bytes:
    from fontTools.ttLib import TTFont  # noqa: PLC0415 - only needed for web fonts
    font = TTFont(path)
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def open_font(path: str, size: int, **kwargs: Any) -> ImageFont.FreeTypeFont:
    """Load *path* with Pillow; a ``.woff``/``.woff2`` is decoded in memory on first use."""
    if path.lower().endswith(WEBFONT_EXTENSIONS):
        data = _decoded_webfont(path, os.path.getmtime(path))
        return ImageFont.truetype(io.BytesIO(data), size, **kwargs)
    return ImageFont.truetype(path, size, **kwargs)


def font_has_all_glyphs(font_path: str, text: str) -> bool:
    """Return False if *font_path* renders any character as the .notdef glyph."""
    try:
        font = open_font(font_path, 40)
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


def find_font(name: str, fonts_dir: str) -> str | None:
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


#: imgserv's own source types. A browser icon set registered under one of
#: these names never shadows it. ``phu`` is deliberately not among them: the
#: custom-brand-icons set is a browser registration like any other, and its
#: shapes arrive through the upload path instead of a JS bundle read off disk.
NATIVE_SOURCE_TYPES: Final = frozenset({"mdi", "logo", "text", "media"})

#: Icon sets the frontend has registered beyond the native ones (``phu``,
#: ``hue``, ``fapro``, ...), as last reported by the panel. They exist only in
#: the browser, so imgserv draws them from the shapes the panel uploaded
#: (``render_custom.py``). Module state because the classifiers in the root
#: ``const.py`` need it and none of them has ``hass`` to look it up with.
_custom_icon_prefixes: set[str] = set()

_ICON_PREFIX_RE: Final = re.compile(r"^[a-z0-9_-]+$")


def set_custom_icon_prefixes(prefixes) -> None:
    """Replace the registered extra icon sets; native and malformed names are dropped."""
    _custom_icon_prefixes.clear()
    _custom_icon_prefixes.update(
        p for p in prefixes or ()
        if isinstance(p, str) and _ICON_PREFIX_RE.match(p) and p not in NATIVE_SOURCE_TYPES
    )


def custom_icon_prefixes() -> frozenset[str]:
    """The extra icon sets currently registered."""
    return frozenset(_custom_icon_prefixes)


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
