"""Which fonts text can be drawn in, and where a font id's file is.

Three places hold fonts: the ones shipped in ``assets/fonts/``, a directory
the user drops their own into (``<ha_config>/lizaip/fonts``), and the web fonts
Home Assistant's own frontend ships (Roboto). A font's id is its file name
without the extension, lowercased -- the name the font picker stores and
``?font=`` carries.

Pillow cannot read ``.woff``/``.woff2``, so those are decoded once into plain
``.ttf`` files in a cache folder and used from there; the cache follows the
source (a removed or newer web font is dropped or redone).
"""
from __future__ import annotations

import logging
import os
import tempfile
from typing import Final

from PIL import ImageFont

from .const import COLOR_EMOJI_FONT, DEFAULT_FONT, EMOJI_FONT, FONTS_DIR, find_font

_LOGGER = logging.getLogger(__name__)

FONT_EXTENSIONS: Final = (".ttf", ".otf", ".ttc")
WEBFONT_EXTENSIONS: Final = (".woff", ".woff2")

# Where decoded web fonts go, inside the user's font folder (dot-named, so it is
# never mistaken for a font file) or the system temp dir without one.
_CACHE_DIRNAME: Final = ".webfont-cache"

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


def _frontend_fonts_dir() -> str | None:
    """Home Assistant's own ``static/fonts``, or ``None`` when it is not there."""
    try:
        import hass_frontend  # noqa: PLC0415 - only present inside Home Assistant
        path = os.path.join(hass_frontend.where(), "static", "fonts")
    except Exception:  # noqa: BLE001 - no frontend package means no HA fonts
        return None
    return path if os.path.isdir(path) else None


def _webfont_files(directory: str | None, recursive: bool = False) -> list[str]:
    if not directory or not os.path.isdir(directory):
        return []
    found: list[str] = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith(".")] if recursive else []
        found.extend(
            os.path.join(root, f) for f in files
            if f.lower().endswith(WEBFONT_EXTENSIONS) and not f.startswith(".")
        )
    return sorted(found)


def _decode_webfont(src: str, dst: str) -> bool:
    try:
        from fontTools.ttLib import TTFont  # noqa: PLC0415 - optional until needed
        font = TTFont(src)
        font.flavor = None
        font.save(dst)
    except Exception as err:  # noqa: BLE001 - a bad file must not hide the rest
        _LOGGER.warning("Web font %s cannot be converted (%s); it is not offered", src, err)
        return False
    return True


def _converted_dir(sources: list[str], cache_dir: str) -> str | None:
    """Decode *sources* into *cache_dir* and return it, dropping stale files."""
    wanted = {os.path.splitext(os.path.basename(p))[0] + ".ttf": p for p in sources}
    if os.path.isdir(cache_dir):
        for name in os.listdir(cache_dir):
            if name.endswith(".ttf") and name not in wanted:
                try:
                    os.remove(os.path.join(cache_dir, name))
                except OSError:
                    pass
    if not wanted:
        return None
    os.makedirs(cache_dir, exist_ok=True)
    for name, src in wanted.items():
        dst = os.path.join(cache_dir, name)
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        _decode_webfont(src, dst)
    return cache_dir


def _font_sources(user_dir: str | None) -> list[tuple[str, str | None]]:
    """``(source, directory)`` pairs, in the order a font id is looked up."""
    base = os.path.join(user_dir, _CACHE_DIRNAME) if user_dir else os.path.join(
        tempfile.gettempdir(), "lizaip" + _CACHE_DIRNAME)
    return [
        ("bundled", FONTS_DIR),
        ("user", user_dir),
        ("user", _converted_dir(_webfont_files(user_dir), os.path.join(base, "user"))),
        ("ha", _converted_dir(
            _webfont_files(_frontend_fonts_dir(), recursive=True), os.path.join(base, "ha"))),
    ]


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

    Shipped fonts come first, then the user's, then Home Assistant's, each sorted by file name. A user
    font whose id a shipped font already has is left out: ``?font=`` resolves
    that id to the shipped one, so listing both would offer a choice that does
    nothing. A file Pillow cannot open is left out as well -- picking it would
    silently draw in the default font.
    """
    fonts: list[dict[str, str]] = []
    seen: set[str] = set()
    for source, directory in _font_sources(user_dir):
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
    directories = [d for _, d in _font_sources(user_dir)]
    for directory in directories:
        for path in _font_files(directory):
            if font_id(path) == wanted:
                return path
    for directory in directories:
        if (directory and (path := find_font(name, directory))
                and path.lower().endswith(FONT_EXTENSIONS)):
            return path
    return None


# The id the default font has in the picker. ``DEFAULT_FONT`` is the shorter
# name ``?font=`` has always accepted for it.
DEFAULT_FONT_ID: Final = font_id(resolve_font_path(DEFAULT_FONT) or DEFAULT_FONT)
