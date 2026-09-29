"""MDI (Material Design Icons) renderer.

Loads icon SVG path data from Home Assistant's bundled ``hass_frontend``
package and renders individual icons via the shared SVG engine.

Returns foreground pixels on a transparent canvas — step 1 of the pipeline
in ``render.py``. Cropping, the background and the PNG encode happen once,
in ``finalize_png``, and not here.
"""
from __future__ import annotations

import glob
import json
import logging
import os

from PIL import Image

from .const import DEFAULT_FG_COLOR
from .render import render_svg_icon

_LOGGER = logging.getLogger(__name__)

# Where MDI lives when ``hass_frontend`` cannot be imported — an unusual
# container layout, mostly. Specific to this loader, so it stays with it.
_MDI_FALLBACK_GLOB = "/usr/local/lib/python3.*/site-packages/hass_frontend/static/mdi"

# Lazy-loaded icon path cache: icon_name -> SVG d string
_MDI_PATHS: dict[str, str] | None = None


def _load_mdi_paths() -> dict[str, str]:
    """Load MDI icon-name -> SVG-path-d from HA's bundled frontend (cached)."""
    global _MDI_PATHS
    if _MDI_PATHS is not None:
        return _MDI_PATHS

    _MDI_PATHS = {}

    # Locate the mdi JSON directory shipped with hass_frontend
    try:
        import hass_frontend
        mdi_dir = os.path.join(os.path.dirname(hass_frontend.__file__), "static", "mdi")
    except ImportError:
        dirs = glob.glob(_MDI_FALLBACK_GLOB)
        mdi_dir = dirs[0] if dirs else None

    if mdi_dir and os.path.isdir(mdi_dir):
        for path in sorted(glob.glob(os.path.join(mdi_dir, "*.json"))):
            try:
                with open(path) as fh:
                    chunk = json.loads(fh.read())
                if isinstance(chunk, dict):
                    # Each JSON file maps icon names to SVG path-d strings.
                    # Quick sanity check: values should be long-ish strings.
                    sample = next(iter(chunk.values()), "")
                    if isinstance(sample, str) and len(sample) > 20:
                        _MDI_PATHS.update(chunk)
            except Exception:
                _LOGGER.warning("MDI: failed to load %s", path, exc_info=True)
                continue

    if _MDI_PATHS:
        _LOGGER.info("MDI: loaded %d icons from hass_frontend", len(_MDI_PATHS))
    else:
        _LOGGER.error("MDI: could not load icons \u2014 ensure hass_frontend is installed")

    return _MDI_PATHS


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def render_mdi_icon(
    icon_name: str,
    width: int,
    height: int,
    fg_color: tuple = DEFAULT_FG_COLOR,
) -> Image.Image:
    """Render an MDI icon and return foreground pixels on a transparent canvas.

    Raises ``ValueError`` if the icon name is not found.
    """
    paths = _load_mdi_paths()
    icon_name = icon_name.removeprefix("mdi:").removeprefix("mdi-")

    path_str = paths.get(icon_name)
    if not path_str:
        raise ValueError(f"Icon '{icon_name}' not found ({len(paths)} icons loaded)")

    # All MDI icons use a 24x24 viewBox
    return render_svg_icon(path_str, (0, 0, 24, 24), width, height, fg_color)
