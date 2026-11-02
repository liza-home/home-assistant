"""HTTP endpoint for the lizaIP Image Server.

    GET /api/imgserv/<source>:<value>?<options>

**Sources** — ``mdi:``, ``logo:``, ``text:``, ``media:``, ``history:``, and any
icon set the browser registered, ``phu:`` among them (``render_custom.py``).

**Options**, all optional, all shared by every source:

======================  ==================================================
``size``                ``tile`` (60×60), ``title`` (200×60), ``WxH``, ``N``
``box``                 ``x,y,w,h`` — answer with that piece of the sized
                        image, for cutting one picture into several buttons
``fg`` (alias ``color``)  foreground: ``RRGGBB``, ``RRGGBBAA`` or a name
``bg``                  background mounted behind it; default transparent
``mode``                ``dark``/``light`` — a default ``fg``, never a ``bg``
``crop``                trim the transparent margin (on; text: to the font's band; off with a bg)
``alpha``               keep the alpha channel instead of flattening to black
``percent``             0–100 fill level via alpha: bottom stays opaque,
                        upper remainder is dimmed to ``PERCENT_TINT_ALPHA``
``font``                font ID, ``text:`` only
``font_size``           size in pixels, ``text:`` only (default: the symbolic
                        ``size``'s font size, else the image height)
``hours``/``days``      the period a ``history:`` graph covers, up to a week
``start_time``,         an absolute period for a ``history:`` graph, instead
``end_time``            of the moving one ``hours``/``days`` ask for
======================  ==================================================

The query is parsed once into :class:`_Options`, each handler answers only
"what does this subject look like", and :meth:`LizaIPImageView.get` finishes
every response the same way — see the note above ``_SOURCES``.
"""
from __future__ import annotations

import io
import ipaddress
import logging
import time
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from functools import partial
from urllib.parse import parse_qsl, unquote, urlsplit

from aiohttp import web
from multidict import MultiDict
from yarl import URL
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util
from PIL import Image

from ..shared import theme as theme_registry
from ..shared.history import is_servable
from . import media_refs
from .const import (
    COLOR_NAMES,
    LEGACY_COLOR_ALIASES,
    DEFAULT_BG_COLOR,
    DEFAULT_FG_COLOR,
    DEFAULT_SIZE,
    IMG_PATH,
    MAX_SIZE,
    MODE_DEFAULTS,
    SIZE_IDS,
    TRANSPARENT,
    custom_icon_prefixes,
    split_source_parts,
)
from .fonts import user_fonts_dir
from .render import finalize_png
from .render_caption import compose_parts
from .render_history import (
    DEFAULT_HOURS,
    MAX_DAYS,
    MAX_HOURS,
    async_history_points,
    render_history,
)
from .render_logo import render_logo
from .render_mdi import render_mdi_icon
from .render_text import render_text, render_text_fitted

_LOGGER = logging.getLogger(__name__)

# ── Transport policy ──────────────────────────────────────────────────────
#
# These three describe how this endpoint *answers*, not what an image looks
# like, so they belong to the HTTP layer rather than to const.py.

# Sent with every generated image. An hour is long enough that a page of tiles
# costs one render pass, short enough that a changed logo appears the same day;
# callers that need to defeat it add a version parameter to the URL.
_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}
# A fetched picture may be a camera frame or a cover behind a token: no shared
# cache may keep it.
_PRIVATE_CACHE_HEADERS = {"Cache-Control": "private, max-age=3600"}

# Unbounded text drives an expensive layout pass in render_text — cap it well
# above any realistic tile/title label to bound per-request CPU cost.
_MAX_TEXT_LENGTH = 200
# What one request may draw: a title of a few marks, words and covers.
_MAX_PARTS = 8
_MAX_MEDIA_PARTS = 4

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


def _try_parse_color(color_str: str | None, names: dict | None = None) -> tuple | None:
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


def _parse_color(color_str: str | None, default: tuple, names: dict | None = None) -> tuple:
    """Parse 'FF0000', 'FF0000FF', or a symbolic name like 'yellow'."""
    return _try_parse_color(color_str, names) or default


def _parse_size(size_str: str | None) -> tuple[int, int]:
    """Parse '64', '100x200', or symbolic IDs like 'tile'. Returns (w, h)."""
    if not size_str:
        return DEFAULT_SIZE
    size_str = size_str.strip()
    named = SIZE_IDS.get(size_str.lower())
    if named:
        return named[:2]
    try:
        if "x" in size_str:
            w, h = (int(p) for p in size_str.split("x", 1))
        else:
            w = h = int(size_str)
    except ValueError:
        return DEFAULT_SIZE
    return (max(1, min(w, MAX_SIZE)), max(1, min(h, MAX_SIZE)))


def _parse_box(raw: str | None) -> tuple[int, int, int, int] | None:
    """Parse ``x,y,w,h``: the piece of the sized image to answer with.

    It is read after ``size``, not instead of it -- ``?size=180x186&box=0,0,60,62``
    scales the picture to 180×186 and cuts the top left of nine tiles out of it.
    """
    if not raw or not raw.strip():
        return None
    parts = raw.strip().split(",")
    if len(parts) != 4:
        raise ValueError("box takes four numbers: x,y,w,h")
    try:
        x, y, w, h = (int(p) for p in parts)
    except ValueError:
        raise ValueError("box takes whole numbers: x,y,w,h") from None
    if x < 0 or y < 0:
        raise ValueError("box starts at 0,0 or further in, never before it")
    if w < 1 or h < 1:
        raise ValueError("box needs a width and a height of at least 1")
    return (x, y, min(w, MAX_SIZE), min(h, MAX_SIZE))


def _cut_box(image, box: tuple[int, int, int, int]):
    """The ``x,y,w,h`` piece of *image*, in exactly the size that was asked for.

    Where the box reaches past the edge the piece is transparent there rather
    than short: nine tiles of a picture whose size does not divide evenly stay
    nine tiles of one size, and the device's buttons stay a grid.
    """
    x, y, w, h = box
    return image.convert("RGBA").crop((x, y, x + w, y + h))


def _parse_font_size(raw: str | None) -> int | None:
    """Parse an optional integer font_size query param."""
    if not raw:
        return None
    try:
        size = int(raw)
    except (ValueError, TypeError):
        return None
    return size if 0 < size <= MAX_SIZE else None


def _default_font_size(size_str: str | None) -> int | None:
    """The font size a symbolic ``size`` names; ``None`` leaves it to the canvas."""
    named = SIZE_IDS.get((size_str or "").strip().lower())
    return named.font_size if named else None


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


def _parse_span(query) -> timedelta:
    """How long a ``history:`` graph covers, from ``hours`` or ``days``.

    The two spell the same thing, so asking for both is a mistake rather than a
    question of precedence. Either way the period stays within ``MAX_HOURS``.
    """
    hours_raw, days_raw = query.get("hours"), query.get("days")
    has_hours = hours_raw is not None and hours_raw.strip() != ""
    has_days = days_raw is not None and days_raw.strip() != ""
    if has_hours and has_days:
        raise ValueError("use hours or days, not both")
    if has_days:
        try:
            days = int(days_raw)
        except (ValueError, TypeError) as err:
            raise ValueError("days must be an integer") from err
        if not 1 <= days <= MAX_DAYS:
            raise ValueError(f"days must be between 1 and {MAX_DAYS}")
        return timedelta(days=days)
    if not has_hours:
        return timedelta(hours=DEFAULT_HOURS)
    try:
        hours = int(hours_raw)
    except (ValueError, TypeError) as err:
        raise ValueError("hours must be an integer") from err
    if not 1 <= hours <= MAX_HOURS:
        raise ValueError(f"hours must be between 1 and {MAX_HOURS}")
    return timedelta(hours=hours)


def _parse_time(raw: str | None, name: str) -> datetime | None:
    """An absolute ``start_time``/``end_time`` in UTC, or ``None`` when absent.

    A time written without a zone is read in Home Assistant's own time zone,
    which is what someone typing ``start_time=2026-10-10T08:00:00`` means.
    """
    if raw is None or raw.strip() == "":
        return None
    parsed = dt_util.parse_datetime(raw.strip())
    if parsed is None:
        raise ValueError(f"{name} must be a date and time (e.g. 2026-10-10T08:00:00Z)")
    return dt_util.as_utc(parsed)


def _parse_period(query) -> tuple[datetime, datetime]:
    """The period a ``history:`` graph covers, as UTC start and end.

    ``start_time``/``end_time`` name a period outright; whichever end is
    missing is filled in from the span (``hours``/``days``), and with neither
    the period is that span up to now -- the moving graph a remote's page asks
    for. An absolute period stands still, so its picture no longer changes.
    """
    span = _parse_span(query)
    start = _parse_time(query.get("start_time"), "start_time")
    end = _parse_time(query.get("end_time"), "end_time")

    if end is None:
        end = dt_util.utcnow()
    if start is None:
        start = end - span

    if end <= start:
        raise ValueError("end_time must be after start_time")
    if end - start > timedelta(hours=MAX_HOURS):
        raise ValueError(f"the period must not be longer than {MAX_HOURS} hours")
    return start, end


def _parse_flag(raw: str | None, default: bool) -> bool:
    """Parse a boolean query flag. Absent *or empty* means *default*."""
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in _FALSE_VALUES


def _first_param(query, *names: str) -> str | None:
    """The first non-empty value among ``names``, in query-string order."""
    for key, value in query.items():
        if key in names and value:
            return value
    return None


def _resolve_colors(
    mode: str,
    fg_raw: str | None,
    color_raw: str | None,
    bg_raw: str | None,
    theme=None,
) -> tuple[tuple, tuple]:
    """Resolve fg/bg RGBA tuples from mode + explicit params.

    ``mode`` provides defaults for *both* fg and bg, but an explicit ``fg``/``color``
    or ``bg`` query parameter always takes priority over the mode-derived default for
    its own channel independently.

    *theme* supplies the names and the default foreground for the remote that
    asked. The default theme reproduces ``COLOR_NAMES`` and ``DEFAULT_FG_COLOR``
    exactly, so a request without ``?theme=`` resolves as it always did.
    """
    names = theme.colors if theme is not None else COLOR_NAMES
    mode_fg, default_bg = MODE_DEFAULTS.get(mode, (DEFAULT_FG_COLOR, DEFAULT_BG_COLOR))
    # Only ``light`` names a colour of its own; ``dark`` and no mode at all
    # mean "whatever this remote draws in", which is the theme's.
    fallback_fg = (
        _parse_color("black", mode_fg, names) if mode == "light"
        else (theme.color("default") or mode_fg if theme is not None else mode_fg)
    )
    fg = _parse_color(fg_raw or color_raw, fallback_fg, names)
    bg = _parse_color(bg_raw, default_bg, names)
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
    box: tuple[int, int, int, int] | None
    fg: tuple
    bg: tuple
    crop: bool
    keep_alpha: bool
    percent: int | None
    font_id: str | None
    font_size: int | None
    mode: str
    explicit_fg: bool
    explicit_font_size: bool
    period: tuple[datetime, datetime]
    #: How a `media:` picture meets the size: ``contain`` keeps its proportions
    #: (the default), ``fill`` stretches it to exactly that size.
    fit: str = "contain"

    @classmethod
    def from_query(cls, query) -> _Options:
        """Parse a query mapping. Raises ``_ImgservError`` (400) on bad input."""
        mode = query.get("mode", "").lower()
        theme = theme_registry.get_theme(query.get("theme"))
        fg, bg = _resolve_colors(
            mode, _first_param(query, "fg", "color"), None,
            _first_param(query, "bg"), theme,
        )

        try:
            percent = _parse_percent(query.get("percent"))
            period = _parse_period(query)
            box = _parse_box(query.get("box"))
        except ValueError as err:
            raise _ImgservError(400, str(err)) from err

        width, height = _parse_size(query.get("size"))
        return cls(
            width=width,
            height=height,
            box=box,
            fg=fg,
            bg=bg,
            crop=_parse_flag(query.get("crop"), True),
            keep_alpha=_parse_flag(query.get("alpha"), False),
            percent=percent,
            font_id=query.get("font", "").lower() or None,
            font_size=(
                _parse_font_size(query.get("font_size"))
                or _default_font_size(query.get("size"))
            ),
            mode=mode,
            explicit_fg=bool(_first_param(query, "fg", "color")),
            explicit_font_size=_parse_font_size(query.get("font_size")) is not None,
            period=period,
            fit=_parse_fit(query.get("fit")),
        )

    def untinted(self) -> _Options:
        """The same options with nothing said about colour.

        What a part is given when it must keep its own colours although the
        picture around it was asked for in one: the ask is still on record for
        the parts that spend it.
        """
        return replace(self, explicit_fg=False, mode="")


def _parse_fit(raw: str | None) -> str:
    if not raw:
        return "contain"
    fit = raw.strip().lower()
    if fit not in ("contain", "fill"):
        raise _ImgservError(400, "fit must be contain or fill")
    return fit


def _split_parts(source: str) -> tuple[str, ...]:
    """`split_source_parts`, with the cap every part of it is held to.

    The rule lives in `imgserv/const.py` so that the device's URL builder and
    the panel's preview can read a title the same way; only the refusal is
    this module's business, because only this module renders.
    """
    parts = split_source_parts(source)
    if not parts:
        raise _ImgservError(400, "Provide a source (mdi:name, text:string, media:url)")
    # Every part is rendered and every picture fetched: one request must not
    # fan out into an unbounded number of either.
    if len(parts) > _MAX_PARTS:
        raise _ImgservError(400, f"at most {_MAX_PARTS} parts")
    if sum(p.startswith("media:") for p in parts) > _MAX_MEDIA_PARTS:
        raise _ImgservError(400, f"at most {_MAX_MEDIA_PARTS} pictures")
    for part in parts:
        if part.startswith("text:") and len(part) - len("text:") > _MAX_TEXT_LENGTH:
            # The same cap as a lone `text:`, and for the same reason: the
            # words are laid out by the very same renderer, repeatedly, as
            # they are shrunk to fit.
            raise _ImgservError(400, f"text exceeds {_MAX_TEXT_LENGTH} characters")
    return parts


def _split_source(source: str) -> tuple[str, str]:
    """Split ``type:value``."""
    if not source:
        raise _ImgservError(400, "Provide a source (mdi:name, text:string, media:url)")

    if ":" not in source:
        raise _ImgservError(400, "Source must be type:value (e.g. mdi:home)")

    source_type, value = source.split(":", 1)

    # Strip surrounding quotes from text values
    if source_type == "text" and len(value) >= 2:
        if (value[0] == value[-1]) and value[0] in ('"', "'"):
            value = value[1:-1]

    return source_type, value


def _source_def_for(source_type: str) -> _Source:
    """The renderer for *source_type*, custom icon prefixes included."""
    source_def = _SOURCES.get(source_type)
    if source_def is None and source_type in custom_icon_prefixes():
        source_def = _Source(partial(_handle_custom, source_type=source_type))
    if source_def is None:
        raise _ImgservError(400, f"Unknown source type: '{source_type}'")
    return source_def


def _png_response(
    data: bytes, content_type: str = "image/png", *, private: bool = False,
) -> web.Response:
    """Return a cached image response."""
    headers = _PRIVATE_CACHE_HEADERS if private else _CACHE_HEADERS
    return web.Response(body=data, content_type=content_type, headers=headers)


def _resolve_reference(source: str, query):
    """Expand ``ref:<djb2>`` back into the request it stands for.

    A reference stands for a whole URL -- source *and* options -- so it is
    expanded before anything is parsed and then read exactly as the
    spelled-out URL would have been. The stored source part is still
    percent-encoded, as in a real path, so it holds no literal ``?``.

    TEMPORARY: remove once LZIP-8 is implemented (see ``media_refs``).
    """
    if not source.startswith("ref:"):
        return source, query

    key = source[len("ref:"):]
    stored = media_refs.lookup(key)
    if stored is None:
        raise _ImgservError(404, f"Unknown reference '{key}'")

    path, _, raw_query = stored.partition("?")
    return unquote(path), MultiDict(parse_qsl(raw_query))


# ═══════════════════════════════════════════════════════════════════════════
# The view
# ═══════════════════════════════════════════════════════════════════════════

class LizaIPImageView(HomeAssistantView):
    """Serve dynamically generated PNG images.

    URL:  /api/imgserv/{source_type}:{value}?size=&fg=&bg=&crop=&alpha=&percent=&font=&hours=
    Examples:
        /api/imgserv/mdi:play-circle?fg=FFFFFF&size=100x200
        /api/imgserv/mdi:battery?fg=green&percent=40&size=tile
        /api/imgserv/text:22°C?fg=FF8800&size=64x64&font=filson-light&font_size=28
        /api/imgserv/logo:spotify?size=60
        /api/imgserv/history:sensor.outdoor_temperature?hours=24&size=title&fg=FF8800
        /api/imgserv/history:sensor.outdoor_temperature?days=7&size=title
        /api/imgserv/history:sensor.house_power?start_time=2026-10-10T08:00:00Z&end_time=2026-10-10T20:00:00Z
    """

    url = IMG_PATH + "/{source:.+}"
    extra_urls = [IMG_PATH + "/"]
    name = "api:imgserv"
    requires_auth = False

    async def get(self, request: web.Request, source: str = "") -> web.Response:
        """Parse, dispatch, finalize — the only place a response is built."""
        hass: HomeAssistant = request.app["hass"]
        _LOGGER.debug("imgserv GET %s", request.rel_url)
        started = time.monotonic()

        try:
            source, query = _resolve_reference(source, request.query)
            options = _Options.from_query(query)
            parts = _split_parts(source)
            resolved = []
            for part in parts:
                stype, value = _split_source(part)
                resolved.append((stype, value, _source_def_for(stype)))
            # Words beside a picture are rendered by the compositor, not by
            # the `text:` handler: only there is there a size to draw them at,
            # because a mark is sized from the words it stands next to.
            rendered: list = []
            for stype, value, source_def in resolved:
                if len(resolved) > 1:
                    if stype == "text":
                        rendered.append(value)
                        continue
                    if stype == "logo":
                        # A colour asked for a title is spent on its words and
                        # its marks; a brand beside them keeps its own.
                        rendered.append(
                            await source_def.handler(hass, value, options.untinted())
                        )
                        continue
                rendered.append(await source_def.handler(hass, value, options))
        except _ImgservError as err:
            return web.Response(status=err.status, text=err.message)

        if len(rendered) > 1:
            # Before `finalize_png`, so the composed picture is cropped,
            # dimmed, mounted and encoded as one subject -- the same five
            # steps every single-part image walks.
            try:
                image = await hass.async_add_executor_job(
                    partial(
                        compose_parts,
                        rendered,
                        options.width,
                        options.height,
                        options.fg,
                        options.font_size,
                        options.font_id,
                        user_fonts_dir(hass),
                    )
                )
            except Exception:
                _LOGGER.error("Composite render error for %r", source, exc_info=True)
                return web.Response(status=500, text="Render error")
        else:
            image = rendered[0]

        # Cropping, mounting and above all PNG encoding are CPU work: done on
        # the event loop they stall every other request -- nine cover tiles
        # asked for at once were answered one after another -- and the
        # remote's own websocket with them.
        response = _png_response(
            *await hass.async_add_executor_job(
                _finish, image, options, _crop_mode(options, resolved),
            ),
            private=any(stype == "media" for stype, _value, _def in resolved),
        )
        _LOGGER.debug(
            "imgserv answered %s in %d ms",
            str(request.rel_url)[:60], (time.monotonic() - started) * 1000,
        )
        return response


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

    Shared by ``mdi``, ``logo`` and the browser icon sets: same dispatch, same
    error mapping, different function and extra kwargs.
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


async def _handle_custom(hass, value, options: _Options, *, source_type: str):
    """An icon set registered in the browser, drawn from its file or an upload.

    A name in neither (after a fresh look at the files) is noted, so the panel
    can fetch it the next time it opens.
    """
    from .render_custom import get_custom_icons  # needs the root const; see __init__

    icons = get_custom_icons(hass)
    if icons is None:
        raise _ImgservError(404, f"{source_type} icon '{value}' not found")
    if not icons.has(source_type, value):
        await icons.async_scan_if_stale()
    if not icons.has(source_type, value):
        icons.note_missing(source_type, value)
    return await _render_icon(
        hass, partial(icons.render, source_type), value, f"{source_type} icon", options,
    )


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
    # A font size the caller named is theirs to keep, however wide the words
    # come out -- the device scrolls a title. Without one, the words are made
    # to fit the picture asked for: a tile does not scroll.
    draw = render_text if options.explicit_font_size else render_text_fitted
    return await hass.async_add_executor_job(
        draw, value, options.width, options.height, options.fg,
        options.font_size, options.font_id, user_fonts_dir(hass),
    )


async def _handle_history(hass, value, options: _Options):
    entity_id = value.strip().lower()
    if not entity_id:
        raise _ImgservError(400, "Missing entity (e.g. history:sensor.temperature)")
    # Only what a remote's page or the admin panel asked for (shared/history.py).
    if not is_servable(entity_id):
        raise _ImgservError(403, f"No history image uses '{entity_id}'")
    try:
        points, start, end = await async_history_points(hass, entity_id, *options.period)
    except KeyError as err:
        raise _ImgservError(503, "The recorder is not running") from err
    return await hass.async_add_executor_job(
        render_history, points, start, end, options.width, options.height, options.fg,
    )


_upstream_failures_logged: set[str] = set()

#: The largest answer a picture host may send, and the largest picture decoded.
_MEDIA_MAX_BYTES = 10 * 1024 * 1024
_MEDIA_MAX_PIXELS = 40_000_000
#: Redirects followed for an outside picture; an HA path gets none.
_MEDIA_MAX_REDIRECTS = 3
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
#: What a fetched picture may be. Anything else is not decoded at all.
_MEDIA_FORMATS = ("JPEG", "PNG", "WEBP", "GIF", "BMP")
#: The HA paths that serve pictures: a player's cover, a camera's or image
#: entity's frame, a user's picture, the `www` folder, a media source. imgserv
#: answers without auth and fetches as HA, so no other path of HA's own is
#: reachable through it -- in particular not imgserv itself.
_HA_PICTURE_PATHS = (
    "/local/",
    "/api/media_player_proxy/",
    "/api/camera_proxy/",
    "/api/image_proxy/",
    "/api/image/serve/",
    "/media/",
)


def _redacted(url: str) -> str:
    """*url* without its query or fragment, for the log: covers carry tokens."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.netloc else parts.path


def _warn_upstream_once(value: str, status: int) -> None:
    """Say why a remote got a 502 for a cover -- once per URL.

    The remote shows only "HTTP Get Error: -502" and retries the same cover on
    every page view, so without this the cause never reaches the HA log.
    """
    if value in _upstream_failures_logged:
        return
    if len(_upstream_failures_logged) >= 100:
        _upstream_failures_logged.clear()
    _upstream_failures_logged.add(value)
    _LOGGER.warning(
        "media: %s answered HTTP %s for %s",
        urlsplit(value).netloc or "HA", status, _redacted(value),
    )


def _check_ha_path(value: str) -> None:
    """Refuse an HA path that is not one of HA's picture paths."""
    path = value.split("?", 1)[0].split("#", 1)[0]
    low = path.lower()
    # Before the prefix test: `..`, an encoded dot or slash or a backslash
    # could be normalised by the client into a path the prefix never saw.
    if ".." in path or "\\" in path or "%2e" in low or "%2f" in low or "%5c" in low:
        raise _ImgservError(403, "Not a picture path")
    if not path.startswith(_HA_PICTURE_PATHS):
        raise _ImgservError(403, "Not a picture path")


def _check_outside_url(value: str) -> None:
    """Refuse an outside URL that is not http(s), or whose host is ambiguous.

    A value that hides a `/`, `?` or `#` behind percent-encoding can make the
    client read its host from what was meant as the path.
    """
    if urlsplit(value).scheme.lower() not in ("http", "https"):
        raise _ImgservError(400, "media: takes an http(s) URL or an HA path")
    if urlsplit(value).netloc.lower() != urlsplit(unquote(value)).netloc.lower():
        raise _ImgservError(400, "Ambiguous media URL")


async def _handle_media(hass, value, options: _Options):
    """Proxy and resize a media thumbnail HA can reach.

    Usage:  /api/imgserv/media:<url-or-ha-path>?size=tile
    """
    if not value:
        raise _ImgservError(400, "Missing media URL path")
    # Deliberately open: imgserv answers anyone who can reach port 8123, and
    # so fetches any http(s) address it is asked for -- the remote has no token
    # to prove where a request came from, and every picture it shows passes
    # through here. What is limited is what HA itself is asked for (picture
    # paths only), how much is read and decoded, and that the answer is a PNG.
    # See "imgserv is open by design" in the README before adding a gate.
    internal = value.startswith("/") and not value.startswith("//")
    if internal:
        _check_ha_path(value)
    else:
        _check_outside_url(value)

    from homeassistant.helpers.network import get_url
    try:
        ha_base = get_url(hass, prefer_external=False)
    except Exception:
        ha_base = "http://localhost:8123"

    url = f"{ha_base}{value}" if internal else value
    if urlsplit(url).scheme.lower() not in ("http", "https"):
        raise _ImgservError(400, "media: takes an http(s) URL or an HA path")
    key = (url, options.width, options.height, options.fit)

    cached = _media_cache.get(key)
    if cached is not None and cached[0] > _media_clock():
        # A copy: what follows crops and mounts, and the next tile needs the
        # same picture untouched.
        return cached[1].copy()

    result = await _fetch_and_scale(
        hass, url, value, options.width, options.height, options.fit, internal=internal,
    )
    # The nine tiles of a cover name the same picture: the remote asks for
    # them one after another, and all but the first are answered from here.
    _media_cache.pop(key, None)
    _media_cache[key] = (_media_clock() + _MEDIA_CACHE_TTL, result)
    if len(_media_cache) > _MEDIA_CACHE_SIZE:
        del _media_cache[next(iter(_media_cache))]
    return result.copy()


#: Scaled media pictures by (url, width, height, fit): (expiry, image), oldest first.
_media_cache: dict[tuple[str, int, int, str], tuple[float, Image.Image]] = {}
#: Long enough for a page's tiles and the remote's refetch after a page change;
#: short enough that a picture changed under an unchanged URL is soon seen.
_MEDIA_CACHE_TTL = 30.0
_MEDIA_CACHE_SIZE = 16
#: The cache's own clock, so a test can age it without stopping the event loop's.
_media_clock = time.monotonic


async def _check_redirect(hass, current: str, target: str) -> None:
    """Refuse a redirect an outside picture may not follow.

    Only to http(s). To the same host it may go; to another only when every
    address that host resolves to is a public one, so a signed cover cannot
    be bounced onto the LAN, an add-on or HA itself.
    """
    nxt = urlsplit(target)
    if nxt.scheme.lower() not in ("http", "https") or not nxt.hostname:
        raise _ImgservError(502, "Upstream redirected somewhere else")
    if nxt.hostname.lower() == (urlsplit(current).hostname or "").lower():
        return
    try:
        infos = await hass.loop.getaddrinfo(nxt.hostname, nxt.port or 443)
        addresses = {ipaddress.ip_address(info[4][0].split("%", 1)[0]) for info in infos}
    except (OSError, ValueError) as err:
        raise _ImgservError(502, "Upstream redirected somewhere else") from err
    if not addresses or not all(addr.is_global for addr in addresses):
        raise _ImgservError(502, "Upstream redirected somewhere else")


async def _read_capped(resp) -> bytes:
    """The body of *resp*, refused once it outgrows ``_MEDIA_MAX_BYTES``."""
    if (resp.content_length or 0) > _MEDIA_MAX_BYTES:
        raise _ImgservError(502, "Upstream picture is too large")
    body = bytearray()
    async for chunk in resp.content.iter_chunked(64 * 1024):
        body.extend(chunk)
        if len(body) > _MEDIA_MAX_BYTES:
            raise _ImgservError(502, "Upstream picture is too large")
    return bytes(body)


async def _fetch_and_scale(
    hass, url: str, value: str, width: int, height: int, fit: str = "contain",
    *, internal: bool = False,
):
    """The picture at *url* at *width*×*height*; always an image, or a 502."""
    session = async_get_clientsession(hass)
    started = time.monotonic()
    current = url
    try:
        for _hop in range(_MEDIA_MAX_REDIRECTS + 1):
            async with session.get(current, timeout=10, allow_redirects=False) as resp:
                if resp.status in _REDIRECT_STATUSES:
                    location = resp.headers.get("Location")
                    if internal or not location:
                        raise _ImgservError(502, "Upstream redirected somewhere else")
                    target = str(resp.url.join(URL(location)))
                    await _check_redirect(hass, current, target)
                    current = target
                    continue
                if resp.status != 200:
                    _warn_upstream_once(value, resp.status)
                    raise _ImgservError(502, f"Upstream returned {resp.status}")
                img_bytes = await _read_capped(resp)
                break
        else:
            raise _ImgservError(502, "Upstream redirected too often")
    except _ImgservError:
        raise
    except Exception as exc:
        _LOGGER.warning("media: fetch failed for %s: %s", _redacted(value), exc)
        raise _ImgservError(502, "Failed to fetch media image") from exc
    fetched = time.monotonic()

    img = await hass.async_add_executor_job(_decode_and_scale, img_bytes, width, height, fit)
    _LOGGER.debug(
        "media: %s fetched in %d ms (%d bytes), scaled to %dx%d in %d ms",
        _redacted(value), (fetched - started) * 1000, len(img_bytes), width, height,
        (time.monotonic() - fetched) * 1000,
    )
    if img is None:
        # imgserv answers with a PNG or not at all.
        raise _ImgservError(502, "Upstream did not return a picture")
    return img


def _decode_and_scale(img_bytes: bytes, width: int, height: int, fit: str = "contain"):
    """Decode and resize; ``None`` when Pillow cannot or may not read the bytes.

    ``contain`` scales the picture as large as fits *width*×*height* without
    changing its proportions -- a square cover in a title stays square;
    ``fill`` stretches it to exactly that size, for a picture whose size was
    written on it (the cover cut into a 3×3 grid of tiles).

    Only the formats a cover comes in are decoded, and only up to
    ``_MEDIA_MAX_PIXELS``: opening reads the header alone, so a picture that
    would decode to gigabytes is refused before it does.
    """
    try:
        img = Image.open(io.BytesIO(img_bytes), formats=_MEDIA_FORMATS)
        if img.width * img.height > _MEDIA_MAX_PIXELS:
            _LOGGER.warning("media: %dx%d is too large to decode", img.width, img.height)
            return None
        if fit != "fill" and img.width and img.height:
            scale = min(width / img.width, height / img.height)
            width = max(1, round(img.width * scale))
            height = max(1, round(img.height * scale))
        # A JPEG can be decoded at 1/2, 1/4 or 1/8 scale for a fraction of the
        # work; draft never goes below the size asked for, so the resize that
        # follows still has the pixels it needs.
        img.draft("RGB", (width, height))
        return img.convert("RGBA").resize((width, height), Image.LANCZOS)
    except Exception as exc:  # noqa: BLE001 - answered as a 502
        _LOGGER.warning("media: resize failed: %s", exc)
        return None


def _finish(image, options: _Options, crop: bool | str) -> tuple[bytes, str]:
    """Box, fill and finalize *image* -- every step after the renderer."""
    if options.box:
        # The piece asked for is the picture from here on: a `bg=` fills
        # the tile rather than the whole image it was cut from.
        image = _cut_box(image, options.box)
        options = replace(options, width=image.width, height=image.height)

    image = _fill_requested_size(image, options)
    return finalize_png(image, options.keep_alpha, options.percent, options.bg, crop=crop)


def _fill_requested_size(image, options: _Options):
    """*image* centred on the whole size asked for, when a ``bg=`` paints it.

    A background is meant to fill the picture asked for, but some renderers
    size their canvas to the subject -- ``text:`` to its words -- and the
    background would cover only that. Never shrinks: words wider than the
    strip keep their width, as the device scrolls them.
    """
    if options.bg[3] == 0:
        return image
    width, height = max(image.width, options.width), max(image.height, options.height)
    if (width, height) == image.size:
        return image
    canvas = Image.new("RGBA", (width, height), TRANSPARENT)
    canvas.paste(
        image.convert("RGBA"), ((width - image.width) // 2, (height - image.height) // 2),
    )
    return canvas


def _crop_mode(options: _Options, resolved) -> bool | str:
    """What ``finalize_png`` crops: the most careful mode among the parts.

    Nothing when a ``bg=`` paints something: the background is meant to fill
    the whole picture asked for, and a crop would shrink it to the subject.
    Nothing either when a ``box=`` named the piece to answer with -- trimming
    a tile to its ink would leave the tiles beside it out of line.
    """
    if not options.crop or options.bg[3] > 0 or options.box:
        return False
    modes = {d.crop for _, _, d in resolved}
    if "none" in modes:
        return False
    return "vertical" if "vertical" in modes else True


@dataclass(frozen=True)
class _Source:
    """One source type: how to render it, and whether ``?crop=`` means anything.

    ``crop`` is what ``?crop=`` does to it: ``"full"`` trims every transparent
    margin, ``"vertical"`` cuts top and bottom only, ``"none"`` leaves it alone.

    ``text`` crops vertically, to the band ``render_text`` records: the font's
    full reach above and below the baseline, not the ink -- so "Hi" and "Hg"
    still come back the same size on the same line across a row of tiles.
    """

    handler: object
    crop: str = "full"


_SOURCES: dict[str, _Source] = {
    "mdi": _Source(_handle_mdi),
    "logo": _Source(_handle_logo),
    "text": _Source(_handle_text, crop="vertical"),
    "media": _Source(_handle_media),
    # No "ref": a reference stands for a whole request, not for a subject to
    # draw, so it is expanded in ``get`` before anything is parsed.
    # Not croppable: trimming would stretch the time axis to the drawn part.
    "history": _Source(_handle_history, crop="none"),
}
