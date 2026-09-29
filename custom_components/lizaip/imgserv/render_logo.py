"""Logo renderer - bundled SVG/PNG logos from the ``logos/`` directory.

Supports three rendering modes:
  1. **Native-colour PNG** - if a ``.png`` exists, serve it directly.
  2. **Native-colour SVG** via ``cairosvg`` - if installed.
  3. **Monochrome SVG** - parse ``<path>``/``<circle>`` and render with
     ``fg_color`` using the shared SVG engine.

Before any of that, the *shape* is chosen: a brand that ships both an upright
mark and a wide wordmark is stored as ``<logo>`` and ``<logo>_wide``, and the
one whose proportions sit closer to the requested canvas is the one rendered.
See ``_pick_shape``.

Returns an image with whatever transparency the source has — step 1 of the
pipeline in ``render.py``. Cropping, the background and the PNG encode happen
once, in ``finalize_png``, and not here.
"""
from __future__ import annotations

import io
import logging
import math
import os
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

from PIL import Image

from .const import DEFAULT_FG_COLOR, MAX_SIZE
from .render import (
    collect_svg_paths,
    parse_svg_viewbox,
    render_multi_path_svg,
)

_LOGGER = logging.getLogger(__name__)

# Bundled brand logos, a sibling of this module. Resolved once at import,
# because ``_resolve_under`` checks containment against it — an unresolved base
# (a symlinked install path) would make every containment test fail and turn
# every logo into a 404.
LOGOS_DIR = Path(os.path.dirname(os.path.abspath(__file__)), "logos").resolve()

# Some brands publish two marks: an upright one and a wide wordmark. A file
# named ``<logo>_wide`` beside ``<logo>`` is taken as the second, and whichever
# fits the requested canvas better is used. Nothing has to be registered — the
# file being there is the whole declaration.
WIDE_SUFFIX = "_wide"


def render_logo(
    logo_name: str,
    width: int,
    height: int,
    fg_color: tuple = DEFAULT_FG_COLOR,
    native_color: bool = False,
    prefer_native_png: bool = False,
) -> Image.Image | None:
    """Render a bundled logo and return the image.

    When *native_color* is ``True`` the original colours are preserved
    (PNG preferred, then cairosvg).  Otherwise the logo is rendered in
    ``fg_color`` monochrome.

    When *prefer_native_png* is ``True`` and a ``.png`` file exists, it is
    served in its original colours (bypassing monochrome).  If only an SVG
    exists, monochrome rendering is used.  This is used when ``?mode=`` is
    set without an explicit ``?fg=`` - the PNG's own colours are appropriate.
    """
    logos_dir = LOGOS_DIR
    logo_name = _pick_shape(logos_dir, logo_name, width, height)
    svg_path = _resolve_under(logos_dir, logo_name if logo_name.endswith(".svg") else f"{logo_name}.svg")
    png_path = _resolve_under(logos_dir, logo_name if logo_name.endswith(".png") else f"{logo_name}.png")
    if svg_path is None or png_path is None:
        _LOGGER.warning("Rejected logo_name outside logos dir: %r", logo_name)
        return None

    width, height = min(width, MAX_SIZE), min(height, MAX_SIZE)

    # --- PNG first (native colour *or* when no SVG exists) ---
    if png_path.exists() and (native_color or prefer_native_png or not svg_path.exists()):
        return _load_png(png_path, width, height)

    if not svg_path.exists():
        return None

    # --- Native colour via cairosvg ---
    if native_color:
        result = _try_cairosvg(svg_path, width, height)
        if result is not None:
            return result
        # fall through to monochrome

    # --- Monochrome SVG ---
    try:
        tree = ET.parse(svg_path)
    except Exception as err:
        _LOGGER.error("Failed to parse SVG %s: %s", svg_path, err, exc_info=True)
        return None

    root = tree.getroot()
    viewbox = parse_svg_viewbox(root)
    paths_d = collect_svg_paths(root)
    if not paths_d:
        _LOGGER.warning("No <path> elements found in %s", svg_path)
        return None

    return render_multi_path_svg(paths_d, viewbox, width, height, fg_color)


# -- Internal helpers -------------------------------------------------------

@lru_cache(maxsize=64)
def _natural_aspect(path_str: str) -> float | None:
    """Width over height of a logo file, from its viewBox or its pixels.

    Cached on the path: the logos ship with the integration and do not change
    under a running instance, so this is one parse per file per process rather
    than one per request.
    """
    path = Path(path_str)
    try:
        if path.suffix == ".svg":
            _, _, width, height = parse_svg_viewbox(ET.parse(path).getroot())
        else:
            with Image.open(path) as img:
                width, height = img.size
    except Exception as err:  # noqa: BLE001 - a bad file must not break the request
        _LOGGER.debug("Cannot read dimensions of %s: %s", path, err)
        return None
    return width / height if height else None


def _shape_of(logos_dir: Path, name: str) -> float | None:
    """The aspect ratio a bare logo name renders at, SVG first."""
    for suffix in (".svg", ".png"):
        candidate = _resolve_under(logos_dir, f"{name}{suffix}")
        if candidate is not None and candidate.exists():
            aspect = _natural_aspect(str(candidate))
            if aspect:
                return aspect
    return None


def _pick_shape(logos_dir: Path, logo_name: str, width: int, height: int) -> str:
    """Choose between ``<logo>`` and ``<logo>_wide`` for the requested canvas.

    The one whose own proportions are closer to the canvas wins, rather than a
    fixed "counts as widescreen" threshold: what matters is not whether the
    canvas is wide in the abstract but which of the two marks leaves less of it
    empty, and that depends on both.

    Compared in log space, because aspect ratios are multiplicative. A 4:1
    wordmark and a 1:1 badge are then equally far from a 2:1 tile, which is the
    honest answer; compared as plain differences the wordmark would look twice
    as wrong as the badge and never be chosen for anything but extreme shapes.

    A name that already carries the suffix, or names a file outright, is left
    alone: the caller asked for something specific.
    """
    if width <= 0 or height <= 0:
        return logo_name
    if logo_name.endswith((".svg", ".png")) or logo_name.endswith(WIDE_SUFFIX):
        return logo_name

    wide_name = f"{logo_name}{WIDE_SUFFIX}"
    wide = _shape_of(logos_dir, wide_name)
    if wide is None:
        return logo_name

    canvas = math.log(width / height)
    upright = _shape_of(logos_dir, logo_name)
    if upright is None:
        return wide_name

    if abs(math.log(wide) - canvas) < abs(math.log(upright) - canvas):
        return wide_name
    return logo_name


def _resolve_under(base_dir: Path, name: str) -> Path | None:
    """Resolve *name* under *base_dir*, rejecting absolute paths and ``..`` escapes.

    ``Path.__truediv__`` silently discards *base_dir* if *name* is absolute, and
    ``..`` segments are never checked - either lets a crafted *name* read files
    outside *base_dir*. Returns ``None`` if the resolved path would escape.
    """
    candidate = (base_dir / name).resolve()
    if not candidate.is_relative_to(base_dir):
        return None
    return candidate


def _load_png(png_path: Path, width: int, height: int) -> Image.Image | None:
    try:
        img = Image.open(png_path).convert("RGBA")
        img.thumbnail((width, height), Image.LANCZOS)
        return img
    except Exception as err:
        _LOGGER.error("Logo PNG error %s: %s", png_path, err, exc_info=True)
        return None


def _try_cairosvg(svg_path: Path, width: int, height: int) -> Image.Image | None:
    try:
        import cairosvg
        png_data = cairosvg.svg2png(url=str(svg_path), output_width=width, output_height=height)
        return Image.open(io.BytesIO(png_data)).convert("RGBA")
    except ImportError:
        _LOGGER.debug("cairosvg not available, falling back to monochrome")
    except Exception as err:
        _LOGGER.error("cairosvg error for %s: %s", svg_path, err, exc_info=True)
    return None
