"""lizaIP Image Server — sub-package of the lizaIP integration.

Provides an HTTP endpoint that serves dynamically generated PNG images:

    GET /api/imgserv/<source>:<value>?<options>

Sources: ``mdi:``, ``phu:``, ``logo:``, ``text:``, ``file:``, ``media:``.
Options: ``size``, ``fg``/``color``, ``bg``, ``mode``, ``crop``, ``alpha``,
``percent``, ``font``, ``font_size`` — see ``httpsocket.py`` for the full
request table and ``render.py`` for the shared pipeline they drive.
"""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

from .const import IMG_PATH
from .httpsocket import LizaIPImageView

_LOGGER = logging.getLogger(__name__)


async def async_setup_imgserv(hass: HomeAssistant) -> None:
    """Register the image server HTTP view."""
    hass.http.register_view(LizaIPImageView)
    _LOGGER.info("lizaIP Image Server registered at %s", IMG_PATH)
