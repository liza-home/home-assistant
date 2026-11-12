"""Which fonts text can be drawn in, and where a font id's file is.

Two places hold fonts: the directory the user drops their own into
(``<ha_config>/www/fonts``), and the web fonts
Home Assistant's own frontend ships (Roboto). Nothing is shipped with the
integration; the default font is Roboto Light from Home Assistant. A font's id is its file name
without the extension, lowercased -- the name the font picker stores and
``?font=`` carries.

Pillow cannot read ``.woff``/``.woff2``. Listing one reads only its name; it is
decoded in memory the first time text is drawn in it (see :func:`open_font`),
and nothing is written to disk.
"""
from __future__ import annotations

import io
import logging
import os
import threading
from functools import lru_cache
from typing import Any, Final
from urllib.parse import quote

from PIL import ImageFont

from .const import DEFAULT_FONT

_LOGGER = logging.getLogger(__name__)


# ── Reading a font file ───────────────────────────────────────────────────

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


# Probing a font for a glyph opens the file and draws it; both are cached per
# file version so a label is not re-read character by character on every render.
_GLYPH_PROBE_LOCK = threading.Lock()


@lru_cache(maxsize=8)
def _glyph_probe_font(path: str, _mtime: float) -> tuple[ImageFont.FreeTypeFont, bytes]:
    font = open_font(path, 40)
    notdef_mask = font.getmask("\ufffe", mode="1")
    return font, bytes(notdef_mask) if notdef_mask else b""


@lru_cache(maxsize=8192)
def _font_has_glyph(path: str, mtime: float, ch: str) -> bool:
    # A FreeType face is not safe to draw from two threads at once.
    with _GLYPH_PROBE_LOCK:
        font, notdef_bytes = _glyph_probe_font(path, mtime)
        mask = font.getmask(ch, mode="1")
        if not mask or mask.size == (0, 0):
            return False
        return not (bytes(mask) == notdef_bytes and notdef_bytes)


def font_has_all_glyphs(font_path: str, text: str) -> bool:
    """Return False if *font_path* renders any character as the .notdef glyph."""
    try:
        mtime = os.path.getmtime(font_path)
        _glyph_probe_font(font_path, mtime)  # an unreadable font has no glyphs
        for ch in text:
            if ord(ch) <= 0x20:
                continue
            if not _font_has_glyph(font_path, mtime, ch):
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


# Below HA's config directory; served as ``/local/fonts``.
WWW_FONTS_SUBDIR: Final = ("www", "fonts")

def www_fonts_dir(hass) -> str:
    """Where the user's own fonts go: ``<ha_config>/www/fonts``."""
    return hass.config.path(*WWW_FONTS_SUBDIR)


def font_id(path: str) -> str:
    """The id a font file goes by: its name without the extension, lowercased."""
    return os.path.splitext(os.path.basename(path))[0].lower()


def _font_files(directory: str | None) -> list[str]:
    """Font and web-font files in *directory* and its sub-folders."""
    if not directory or not os.path.isdir(directory):
        return []
    found: list[str] = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        found.extend(
            os.path.join(root, f) for f in files
            if f.lower().endswith(FONT_EXTENSIONS + WEBFONT_EXTENSIONS)
            and not f.startswith(".")
        )
    return sorted(found)


def _frontend_fonts_dir() -> str | None:
    """Home Assistant's own ``static/fonts``, or ``None`` when it is not there."""
    try:
        import hass_frontend  # noqa: PLC0415 - only present inside Home Assistant
        path = os.path.join(hass_frontend.where(), "static", "fonts")
    except Exception:  # noqa: BLE001 - no frontend package means no HA fonts
        return None
    return path if os.path.isdir(path) else None


def _font_sources(fonts_dir: str | None) -> list[tuple[str, str | None]]:
    """``(source, directory)`` pairs, in the order a font id is looked up."""
    return [("user", fonts_dir), ("ha", _frontend_fonts_dir())]


# A browser draws from a downloaded file, so only the formats it reads get a
# URL; ``.ttc`` collections are Pillow-only.
_WEB_EXTENSIONS: Final = (".ttf", ".otf") + WEBFONT_EXTENSIONS

# Where each source's font directory is reachable from a browser: ``www/`` is
# served as ``/local``, and Home Assistant's frontend package as ``/static``.
_URL_BASES: Final = {"user": "/local/fonts", "ha": "/static/fonts"}


def _font_url(source: str, directory: str, path: str) -> str:
    """The URL a browser can load *path* from, or ``""`` when it cannot."""
    base = _URL_BASES.get(source)
    if not base or not path.lower().endswith(_WEB_EXTENSIONS):
        return ""
    rel = os.path.relpath(path, directory)
    if rel.startswith(os.pardir):
        return ""
    return "/".join([base, *(quote(part) for part in rel.split(os.sep))])


def _names(path: str) -> tuple[str, str]:
    """A font's family and style; a web font's are read without decoding it.

    A colour bitmap font (Noto Color Emoji) opens in Pillow at its own sizes
    only, so its names are read from the file as a web font's are.
    """
    if not path.lower().endswith(WEBFONT_EXTENSIONS):
        try:
            return ImageFont.truetype(path, 12).getname()
        except OSError:
            pass
    from fontTools.ttLib import TTFont  # noqa: PLC0415 - not needed for most fonts
    with TTFont(path, lazy=True) as font:
        name = font["name"]
        return (str(name.getBestFamilyName() or ""), str(name.getBestSubFamilyName() or ""))


#: What a font must hold to be offered for emoji: a face and a house, from the
#: two blocks every emoji font covers and no text font does.
_EMOJI_PROBES = (0x1F600, 0x1F3E0)


@lru_cache(maxsize=256)
def _has_emoji(path: str, _mtime: float) -> bool:
    """Whether the font at *path* draws emoji (read from its character map)."""
    from fontTools.ttLib import TTFont  # noqa: PLC0415 - read once per file

    try:
        with TTFont(path, lazy=True, fontNumber=0) as font:
            cmap = font.getBestCmap() or {}
    except Exception:  # noqa: BLE001 - an unreadable file is simply no emoji font
        return False
    return all(code in cmap for code in _EMOJI_PROBES)


def is_emoji_font(path: str) -> bool:
    try:
        return _has_emoji(path, os.path.getmtime(path))
    except OSError:
        return False


def _display_name(path: str) -> str:
    try:
        family, style = _names(path)
    except Exception:  # noqa: BLE001 - an unreadable file must not hide the rest
        return ""
    family = (family or "").strip()
    style = (style or "").strip()
    if not family:
        return ""
    return family if not style or style.lower() == "regular" else f"{family} {style}"


def list_fonts(fonts_dir: str | None = None) -> list[dict[str, str]]:
    """Every font text can be drawn in: ``[{"id", "name", "source", "url", "emoji"}]``.

    Sorted by name, the user's and Home Assistant's mixed. A Home Assistant font
    whose id a user font already has is left out: ``?font=`` resolves
    that id to the earlier one, so listing both would offer a choice that does
    nothing. A file Pillow cannot open is left out as well -- picking it would
    silently draw in the default font.

    ``url`` is where a browser can load the file from, so the font picker can
    draw each name in its own font. It is ``""`` for a format no browser reads.
    """
    fonts: list[dict[str, str]] = []
    seen: set[str] = set()
    for source, directory in _font_sources(fonts_dir):
        for path in _font_files(directory):
            fid = font_id(path)
            if fid in seen:
                continue
            name = _display_name(path)
            if not name:
                _LOGGER.warning("Font file %s cannot be read; it is not offered", path)
                continue
            seen.add(fid)
            fonts.append({
                "id": fid,
                "name": name,
                "source": source,
                "url": _font_url(source, directory, path),
                # Offered for the theme's emoji font; the text fonts are not.
                "emoji": is_emoji_font(path),
            })
    return sorted(fonts, key=lambda f: (f["name"].casefold(), f["id"]))


def resolve_font_path(name: str | None, fonts_dir: str | None = None) -> str | None:
    """The file a font id names, or ``None`` when no font matches.

    An exact id wins over a fuzzy match, and a user font over a Home Assistant one:
    the fuzzy lookup alone takes the first file that merely contains the name,
    so with ``Inter.ttf`` and ``Inter-Bold.ttf`` side by side ``inter`` could
    draw in bold.
    """
    if not name:
        return None
    wanted = name.lower().replace(" ", "")
    directories = [d for _, d in _font_sources(fonts_dir)]
    for directory in directories:
        for path in _font_files(directory):
            if font_id(path) == wanted:
                return path
    for directory in directories:
        for folder in sorted({os.path.dirname(p) for p in _font_files(directory)}):
            if ((path := find_font(name, folder))
                    and path.lower().endswith(FONT_EXTENSIONS + WEBFONT_EXTENSIONS)):
                return path
    return None


# The id the default font has in the picker. ``DEFAULT_FONT`` is the shorter
# name ``?font=`` has always accepted for it.
DEFAULT_FONT_ID: Final = font_id(resolve_font_path(DEFAULT_FONT) or DEFAULT_FONT)
