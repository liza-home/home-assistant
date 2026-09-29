"""HTTP endpoint for the lizaIP Image Server.

    GET /api/imgserv/<source>:<value>?<options>

**Sources** — ``mdi:``, ``phu:``, ``logo:``, ``text:``, ``file:``, ``media:``.

**Options**, all optional, all shared by every source:

======================  ==================================================
``size``                ``tile`` (60×60), ``title`` (200×60), ``WxH``, ``N``
``fg`` (alias ``color``)  foreground: ``RRGGBB``, ``RRGGBBAA`` or a name
``bg``                  background mounted behind it; default transparent
``mode``                ``dark``/``light`` — a default ``fg``, never a ``bg``
``crop``                trim the transparent margin (on; ignored by text)
``alpha``               keep the alpha channel instead of flattening to black
``percent``             0–100 fill level via alpha: bottom stays opaque,
                        upper remainder is dimmed to ``PERCENT_TINT_ALPHA``
``font``                font ID, ``text:`` only
``font_size``           size in pixels, ``text:`` only (default image height)
======================  ==================================================

The query is parsed once into :class:`_Options`, each handler answers only
"what does this subject look like", and :meth:`LizaIPImageView.get` finishes
every response the same way — see the note above ``_SOURCES``.
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from aiohttp import web
from PIL import Image

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    COLOR_NAMES,
    DEFAULT_BG_COLOR,
    DEFAULT_FG_COLOR,
    DEFAULT_SIZE,
    IMG_PATH,
    MAX_SIZE,
    MODE_DEFAULTS,
    SIZE_IDS,
)
from .render import finalize_png
from .render_logo import render_logo
from .render_mdi import render_mdi_icon
from .render_phu import render_phu_icon
from .render_static import load_static_image
from .render_text import render_text

_LOGGER = logging.getLogger(__name__)

# ── Transport policy ──────────────────────────────────────────────────────
#
# These three describe how this endpoint *answers*, not what an image looks
# like, so they belong to the HTTP layer rather than to const.py.

# Sent with every generated image. An hour is long enough that a page of tiles
# costs one render pass, short enough that a changed logo appears the same day;
# callers that need to defeat it add a version parameter to the URL.
_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}

# Unbounded text drives an expensive layout pass in render_text — cap it well
# above any realistic tile/title label to bound per-request CPU cost.
_MAX_TEXT_LENGTH = 200

# Query flags (``?crop=``, ``?alpha=``) count as off for these spellings and as
# on for anything else. Compared after lowercasing, so entries must be lower
# case; an empty value means "unset" and is handled before this is consulted.
_FALSE_VALUES = ("0", "false", "no")



class _ImgservError(Exception):
    """A refusal with an HTTP status: raised by handlers, answered in ``get``.

    Handlers return images, so they need some other way to say "404". Raising
    keeps their return type honest and puts every error response in one place.
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _try_parse_color(color_str: str | None) -> tuple | None:
    """Parse a color value and return RGBA, or None when invalid/missing."""
    if not color_str:
        return None
    named = COLOR_NAMES.get(color_str.lower())
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


def _parse_color(color_str: str | None, default: tuple) -> tuple:
    """Parse 'FF0000', 'FF0000FF', or a symbolic name like 'yellow'."""
    return _try_parse_color(color_str) or default


def _parse_size(size_str: str | None) -> tuple[int, int]:
    """Parse '64', '100x200', or symbolic IDs like 'tile'. Returns (w, h)."""
    if not size_str:
        return DEFAULT_SIZE
    size_str = size_str.strip()
    named = SIZE_IDS.get(size_str.lower())
    if named:
        return named
    try:
        if "x" in size_str:
            w, h = (int(p) for p in size_str.split("x", 1))
        else:
            w = h = int(size_str)
    except ValueError:
        return DEFAULT_SIZE
    return (max(1, min(w, MAX_SIZE)), max(1, min(h, MAX_SIZE)))


def _parse_font_size(raw: str | None) -> int | None:
    """Parse an optional integer font_size query param."""
    if not raw:
        return None
    try:
        return int(raw)
    except (ValueError, TypeError):
        return None


def _parse_percent(raw: str | None) -> int | None:
    """Parse optional fill percentage query (0..100)."""
    if raw is None or raw.strip() == "":
        return None
    try:
        percent = int(raw)
    except (ValueError, TypeError) as err:
        raise ValueError("percent must be an integer") from err
    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")
    return percent


def _parse_flag(raw: str | None, default: bool) -> bool:
    """Parse a boolean query flag. Absent *or empty* means *default*."""
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in _FALSE_VALUES


def _resolve_colors(
    mode: str,
    fg_raw: str | None,
    color_raw: str | None,
    bg_raw: str | None,
) -> tuple[tuple, tuple]:
    """Resolve fg/bg RGBA tuples from mode + explicit params.

    ``mode`` provides defaults for *both* fg and bg, but an explicit ``fg``/``color``
    or ``bg`` query parameter always takes priority over the mode-derived default for
    its own channel independently.
    """
    default_fg, default_bg = MODE_DEFAULTS.get(mode, (DEFAULT_FG_COLOR, DEFAULT_BG_COLOR))
    fg = _parse_color(fg_raw or color_raw, default_fg)
    bg = _parse_color(bg_raw, default_bg)
    return fg, bg


@dataclass(frozen=True)
class _Options:
    """Everything the query string says, parsed once, before any rendering.

    Handlers are handed this instead of the request: the answers are the same
    for every source type, and parsing them in one place is what lets ``get``
    reject a bad ``percent`` before a renderer has done any work.
    """

    width: int
    height: int
    fg: tuple
    bg: tuple
    crop: bool
    keep_alpha: bool
    percent: int | None
    font_id: str | None
    font_size: int | None
    mode: str
    explicit_fg: bool

    @classmethod
    def from_query(cls, query) -> _Options:
        """Parse a query mapping. Raises ``_ImgservError`` (400) on bad input."""
        mode = query.get("mode", "").lower()
        fg, bg = _resolve_colors(mode, query.get("fg"), query.get("color"), query.get("bg"))

        try:
            percent = _parse_percent(query.get("percent"))
        except ValueError as err:
            raise _ImgservError(400, str(err)) from err

        width, height = _parse_size(query.get("size"))
        return cls(
            width=width,
            height=height,
            fg=fg,
            bg=bg,
            crop=_parse_flag(query.get("crop"), True),
            keep_alpha=_parse_flag(query.get("alpha"), False),
            percent=percent,
            font_id=query.get("font", "").lower() or None,
            font_size=_parse_font_size(query.get("font_size")),
            mode=mode,
            explicit_fg=bool(query.get("fg") or query.get("color")),
        )


def _split_source(source: str, query) -> tuple[str, str]:
    """Split ``type:value``, falling back to the legacy bare ``?text=`` form."""
    if not source:
        text = query.get("text")
        if not text:
            raise _ImgservError(400, "Provide a source (mdi:name, text:string, file:path)")
        source = f"text:{text}"

    if ":" not in source:
        raise _ImgservError(400, "Source must be type:value (e.g. mdi:home)")

    source_type, value = source.split(":", 1)

    # Strip surrounding quotes from text values
    if source_type == "text" and len(value) >= 2:
        if (value[0] == value[-1]) and value[0] in ('"', "'"):
            value = value[1:-1]

    return source_type, value


def _png_response(data: bytes, content_type: str = "image/png") -> web.Response:
    """Return a cached image response."""
    return web.Response(body=data, content_type=content_type, headers=_CACHE_HEADERS)


# ═══════════════════════════════════════════════════════════════════════════
# The view
# ═══════════════════════════════════════════════════════════════════════════

class LizaIPImageView(HomeAssistantView):
    """Serve dynamically generated PNG images.

    URL:  /api/imgserv/{source_type}:{value}?size=&fg=&bg=&crop=&alpha=&percent=&font=
    Examples:
        /api/imgserv/mdi:play-circle?fg=FFFFFF&size=100x200
        /api/imgserv/mdi:battery?fg=green&percent=40&size=tile
        /api/imgserv/text:22°C?fg=FF8800&size=64x64&font=filson-light&font_size=28
        /api/imgserv/logo:spotify?size=60
        /api/imgserv/file:icons/play.png?size=64x64&alpha=1
    """

    url = IMG_PATH + "/{source:.+}"
    extra_urls = [IMG_PATH + "/"]
    name = "api:imgserv"
    requires_auth = False

    async def get(self, request: web.Request, source: str = "") -> web.Response:
        """Parse, dispatch, finalize — the only place a response is built."""
        hass: HomeAssistant = request.app["hass"]
        _LOGGER.debug("imgserv GET %s", request.rel_url)

        try:
            options = _Options.from_query(request.query)
            source_type, value = _split_source(source, request.query)
            source_def = _SOURCES.get(source_type)
            if source_def is None:
                raise _ImgservError(400, f"Unknown source type: '{source_type}'")
            image = await source_def.handler(hass, value, options)
        except _ImgservError as err:
            return web.Response(status=err.status, text=err.message)

        if isinstance(image, web.Response):
            return image  # media: passthrough of bytes Pillow could not decode

        return _png_response(
            *finalize_png(
                image,
                options.keep_alpha,
                options.percent,
                options.bg,
                crop=options.crop and source_def.croppable,
            )
        )


# ═══════════════════════════════════════════════════════════════════════════
# Per-source handlers
# ═══════════════════════════════════════════════════════════════════════════
#
# A handler answers one question — "what does this subject look like?" — and
# returns a PIL image. It never encodes bytes, never paints a background and
# never builds a response; ``get`` does all three, once, for every source:
#
#   render_* → autocrop → percent alpha → mount on bg → save_png → web.Response
#
# That is worth stating because a handler finishing its own response would
# silently skip the shared steps for its source type only — the kind of gap
# that shows up as "percent works on icons but not on logos" months later.


async def _render_icon(hass, render_fn, value, label, options: _Options, **kwargs):
    """Run an icon renderer in the executor and translate its failures.

    Shared by ``mdi``, ``phu`` and ``logo``: same dispatch, same error mapping,
    different function and extra kwargs.
    """
    if not value:
        raise _ImgservError(400, f"Missing {label}")
    try:
        img = await hass.async_add_executor_job(
            partial(render_fn, value, options.width, options.height, options.fg, **kwargs)
        )
    except ValueError as err:
        raise _ImgservError(404, f"{label} '{value}' not found") from err
    except Exception as err:
        _LOGGER.error("%s render error for %r", label, value, exc_info=True)
        raise _ImgservError(500, "Render error") from err
    if img is None:
        raise _ImgservError(404, f"{label} '{value}' not found")
    return img


async def _handle_mdi(hass, value, options: _Options):
    return await _render_icon(hass, render_mdi_icon, value, "MDI icon", options)


async def _handle_phu(hass, value, options: _Options):
    return await _render_icon(hass, render_phu_icon, value, "PHU icon", options)


async def _handle_logo(hass, value, options: _Options):
    """Native colours unless the caller asked for a colour of their own.

    ``mode`` alone is not such an ask — it only supplies a default foreground —
    so it still prefers a PNG's own colours where one exists.
    """
    return await _render_icon(
        hass, render_logo, value, "Logo", options,
        native_color=not options.explicit_fg and not options.mode,
        prefer_native_png=bool(options.mode) and not options.explicit_fg,
    )


async def _handle_text(hass, value, options: _Options):
    if not value:
        raise _ImgservError(400, "Missing text (e.g. text:Hello)")
    if len(value) > _MAX_TEXT_LENGTH:
        raise _ImgservError(400, f"text exceeds {_MAX_TEXT_LENGTH} characters")
    return await hass.async_add_executor_job(
        render_text, value, options.width, options.height, options.fg,
        options.font_size, options.font_id,
    )


async def _handle_file(hass, value, options: _Options):
    if not value:
        raise _ImgservError(400, "Missing filename (e.g. file:icon.png)")
    www_dir = Path(hass.config.path("www"))
    try:
        file_path = (www_dir / value).resolve()
        if not file_path.is_relative_to(www_dir.resolve()):
            raise _ImgservError(403, "Forbidden")
    except (OSError, ValueError) as err:
        raise _ImgservError(403, "Forbidden") from err

    img = await hass.async_add_executor_job(
        load_static_image, file_path, options.width, options.height
    )
    if img is None:
        raise _ImgservError(404, f"File '{value}' not found")
    return img


async def _handle_media(hass, value, options: _Options):
    """Proxy and resize a media thumbnail HA can reach.

    Usage:  /api/imgserv/media:<url-or-ha-path>?size=tile

    Returns a raw ``web.Response`` — the one exception to "handlers return
    images" — when Pillow cannot decode what came back, so an unusual but valid
    image format still reaches the caller instead of an error.
    """
    if not value:
        raise _ImgservError(400, "Missing media URL path")

    from homeassistant.helpers.network import get_url
    try:
        ha_base = get_url(hass, prefer_external=False)
    except Exception:
        ha_base = "http://localhost:8123"

    url = f"{ha_base}{value}" if value.startswith("/") else value

    session = async_get_clientsession(hass)
    try:
        async with session.get(url, timeout=10) as resp:
            if resp.status != 200:
                raise _ImgservError(502, f"Upstream returned {resp.status}")
            img_bytes = await resp.read()
    except _ImgservError:
        raise
    except Exception as exc:
        _LOGGER.warning("media: fetch failed for %s: %s", value[:80], exc)
        raise _ImgservError(502, "Failed to fetch media image") from exc

    try:
        img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
        return img.resize((options.width, options.height), Image.LANCZOS)
    except Exception as exc:
        _LOGGER.warning("media: resize failed: %s", exc)
        content_type = "image/jpeg" if img_bytes[:3] == b"\xff\xd8\xff" else "image/png"
        return _png_response(img_bytes, content_type)


@dataclass(frozen=True)
class _Source:
    """One source type: how to render it, and whether ``?crop=`` means anything.

    ``text`` is not croppable: ``render_text`` already sizes the canvas to the
    string, and trimming the remaining vertical margin would make the height
    depend on which glyphs the label happens to contain — "Hi" and "Hg" would
    come back different sizes and a row of tiles would jitter.
    """

    handler: object
    croppable: bool = True


_SOURCES: dict[str, _Source] = {
    "mdi": _Source(_handle_mdi),
    "phu": _Source(_handle_phu),
    "logo": _Source(_handle_logo),
    "text": _Source(_handle_text, croppable=False),
    "file": _Source(_handle_file),
    "media": _Source(_handle_media),
}
