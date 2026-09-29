"""Static-image renderer for the lizaIP Image Server.

Resizes an existing image file (from ``/config/www/``) to the requested
dimensions. Path-traversal protection is applied by the caller in
``httpsocket.py`` before this module is reached.
"""
from __future__ import annotations

import logging
from pathlib import Path

from PIL import Image

_LOGGER = logging.getLogger(__name__)


def load_static_image(path: Path, width: int, height: int) -> Image.Image | None:
    """Resize a static image file to the requested dimensions.

    Returns ``None`` if the file does not exist or cannot be decoded.
    """
    if not path.exists():
        return None
    try:
        return Image.open(path).convert("RGBA").resize((width, height), Image.LANCZOS)
    except Exception as err:
        _LOGGER.error("Failed to process image %s: %s", path, err)
        return None
