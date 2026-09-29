"""PHU (custom-brand-icons) renderer.

Loads icon data from the HACS-installed ``custom-brand-icons`` JS bundle
and renders individual icons via the shared SVG engine.

Returns foreground pixels on a transparent canvas — step 1 of the pipeline
in ``render.py``. Cropping, the background and the PNG encode happen once,
in ``finalize_png``, and not here.
"""
from __future__ import annotations

import glob
import json
import logging
import os
import re

from PIL import Image

from .const import DEFAULT_FG_COLOR
from .render import render_svg_icon

_LOGGER = logging.getLogger(__name__)

# Where the HACS *frontend* plugin installs: the config directory, not
# site-packages. The glob catches installs whose config root is neither
# /config nor /homeassistant. Both are specific to this loader.
_JS_PATHS = (
    "/config/www/community/custom-brand-icons/custom-brand-icons.js",
    "/config/www/community/custom-brand-icons/dist/custom-brand-icons.js",
    "/homeassistant/www/community/custom-brand-icons/custom-brand-icons.js",
)
_JS_GLOB = "/*/www/community/custom-brand-icons/custom-brand-icons.js"

# The bundle is a JS assignment, not JSON: ``var icons = { … };``. The prefix is
# sliced off by length before the rest is parsed as JSON.
_JS_ASSIGNMENT_PREFIX = "var icons = "

# Lazy-loaded icon cache: icon_name -> {"viewBox": (...), "path": "..."}
_PHU_ICONS: dict[str, dict] | None = None


def _load_phu_icons() -> dict[str, dict]:
    """Load custom-brand-icons from the HACS JS file (cached).

    The JS file has the shape ``var icons = {"name": [x,y,w,h,"path_d"], ...};``
    """
    global _PHU_ICONS
    if _PHU_ICONS is not None:
        return _PHU_ICONS

    _PHU_ICONS = {}

    # Search well-known paths for the JS bundle
    candidates = [*_JS_PATHS, *glob.glob(_JS_GLOB)]

    js_path = next((p for p in candidates if os.path.isfile(p)), None)

    if not js_path:
        _LOGGER.warning("PHU: custom-brand-icons JS not found, searched: %s", candidates[:3])
        return _PHU_ICONS

    _LOGGER.info("PHU: loading from %s", js_path)
    try:
        with open(js_path) as fh:
            content = fh.read()

        # Locate the end of the JS object literal: \n};\n
        end_match = re.search(r"\n\};\s*\n", content)
        if not end_match:
            _LOGGER.error("PHU: could not find end of icons object in %s", js_path)
            return _PHU_ICONS

        # Extract JSON (skip the leading "var icons = ")
        icons_str = content[len(_JS_ASSIGNMENT_PREFIX) : end_match.start() + 2]
        icons_str = re.sub(r",\s*\}", "}", icons_str)  # trailing-comma fix
        raw = json.loads(icons_str)

        for name, val in raw.items():
            if isinstance(val, list) and len(val) >= 5 and isinstance(val[4], str):
                _PHU_ICONS[name] = {
                    "viewBox": (val[0], val[1], val[2], val[3]),
                    "path": val[4],
                }
    except Exception as err:
        _LOGGER.error("PHU: failed to parse custom-brand-icons: %s", err, exc_info=True)

    if _PHU_ICONS:
        _LOGGER.info("PHU: loaded %d icons from custom-brand-icons", len(_PHU_ICONS))
    else:
        _LOGGER.warning("PHU: no icons loaded from custom-brand-icons")

    return _PHU_ICONS


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def render_phu_icon(
    icon_name: str,
    width: int,
    height: int,
    fg_color: tuple = DEFAULT_FG_COLOR,
) -> Image.Image:
    """Render a phu: icon as foreground pixels on a transparent canvas.

    Raises ``ValueError`` if the icon name is not found.
    """
    icons = _load_phu_icons()
    icon_name = icon_name.removeprefix("phu:").removeprefix("phu-")

    icon_data = icons.get(icon_name)
    if not icon_data:
        raise ValueError(f"PHU icon '{icon_name}' not found ({len(icons)} icons loaded)")

    # viewBox stored as (minX, minY, maxX, maxY) - convert to (x, y, w, h)
    vb = icon_data["viewBox"]
    viewbox = (float(vb[0]), float(vb[1]), float(vb[2]) - float(vb[0]), float(vb[3]) - float(vb[1]))

    return render_svg_icon(icon_data["path"], viewbox, width, height, fg_color)
