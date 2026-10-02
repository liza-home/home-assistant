"""Which fonts text can be drawn in, and where a font id's file is.

Two places hold fonts: the ones shipped in ``fonts/`` next to this module, and
a directory the user drops their own into (``<ha_config>/lizaip/fonts``). A
font's id is its file name without the extension, lowercased -- the name the
font picker stores and ``?font=`` carries.
"""
from __future__ import annotations

import logging
import os
from typing import Final

from PIL import ImageFont

from .const import COLOR_EMOJI_FONT, DEFAULT_FONT, EMOJI_FONT, FONTS_DIR, find_font

_LOGGER = logging.getLogger(__name__)

FONT_EXTENSIONS: Final = (".ttf", ".otf", ".ttc")

# Below HA's config directory, next to the per-remote folders.
USER_FONTS_SUBDIR: Final = ("lizaip", "fonts")

# The emoji fonts are fallbacks for glyphs the chosen font lacks, not a choice.
_FALLBACK_ONLY: Final = frozenset(
    os.path.splitext(f)[0].lower() for f in (EMOJI_FONT, COLOR_EMOJI_FONT)
)


def user_fonts_dir(hass) -> str:
    """Where the user's own fonts go: ``<ha_config>/lizaip/fonts``."""
    return hass.config.path(*USER_FONTS_SUBDIR)


def font_id(path: str) -> str:
    """The id a font file goes by: its name without the extension, lowercased."""
    return os.path.splitext(os.path.basename(path))[0].lower()


def _font_files(directory: str | None) -> list[str]:
    if not directory or not os.path.isdir(directory):
        return []
    return sorted(
        os.path.join(directory, f)
        for f in os.listdir(directory)
        if f.lower().endswith(FONT_EXTENSIONS)
        and not f.startswith(".")
        and os.path.splitext(f)[0].lower() not in _FALLBACK_ONLY
    )


def _display_name(path: str) -> str:
    try:
        family, style = ImageFont.truetype(path, 12).getname()
    except Exception:  # noqa: BLE001 - an unreadable file must not hide the rest
        return ""
    family = (family or "").strip()
    style = (style or "").strip()
    if not family:
        return ""
    return family if not style or style.lower() == "regular" else f"{family} {style}"


def list_fonts(user_dir: str | None = None) -> list[dict[str, str]]:
    """Every font text can be drawn in: ``[{"id", "name", "source"}]``.

    Shipped fonts come first, then the user's, each sorted by file name. A user
    font whose id a shipped font already has is left out: ``?font=`` resolves
    that id to the shipped one, so listing both would offer a choice that does
    nothing. A file Pillow cannot open is left out as well -- picking it would
    silently draw in the default font.
    """
    fonts: list[dict[str, str]] = []
    seen: set[str] = set()
    for source, directory in (("bundled", FONTS_DIR), ("user", user_dir)):
        for path in _font_files(directory):
            fid = font_id(path)
            if fid in seen:
                continue
            name = _display_name(path)
            if not name:
                _LOGGER.warning("Font file %s cannot be read; it is not offered", path)
                continue
            seen.add(fid)
            fonts.append({"id": fid, "name": name, "source": source})
    return fonts


def resolve_font_path(name: str | None, user_dir: str | None = None) -> str | None:
    """The file a font id names, or ``None`` when no font matches.

    An exact id wins over a fuzzy match, and a shipped font over a user font:
    the fuzzy lookup alone takes the first file that merely contains the name,
    so with ``Inter.ttf`` and ``Inter-Bold.ttf`` side by side ``inter`` could
    draw in bold.
    """
    if not name:
        return None
    wanted = name.lower().replace(" ", "")
    directories = (FONTS_DIR, user_dir)
    for directory in directories:
        for path in _font_files(directory):
            if font_id(path) == wanted:
                return path
    for directory in directories:
        if directory and (path := find_font(name, directory)):
            return path
    return None


# The id the default font has in the picker. ``DEFAULT_FONT`` is the shorter
# name ``?font=`` has always accepted for it.
DEFAULT_FONT_ID: Final = font_id(resolve_font_path(DEFAULT_FONT) or DEFAULT_FONT)
