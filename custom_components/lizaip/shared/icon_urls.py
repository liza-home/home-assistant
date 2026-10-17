"""The URLs the device fetches icons, tooltips and titles from."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import quote, unquote, urlencode

from ..imgserv import media_refs
from ..imgserv.const import (
    SIZE_IDS,
    _custom_icon_prefixes,
    split_source_parts,
)
from ..imgserv.fonts import DEFAULT_FONT_ID

#: imgserv options a picture may carry after a ``|``: ``media:<url>|size=200x200``.
MEDIA_OPTION_KEYS: Final = ("size", "mode", "fg", "bg", "crop", "alpha")

#: A numeric ``size=`` in the URL's own query, which is read as imgserv's.
_QUERY_SIZE_RE: Final = re.compile(r"([?&])size=(\d+(?:x\d+)?)(?=&|#|$)", re.IGNORECASE)


def split_media_options(value: str) -> tuple[str, dict[str, str]]:
    """``(url, options)`` for ``<url>|key=value&key=value``.

    The options are imgserv's own, which the URL's query cannot carry: the URL
    is sent encoded, so its query would only reach the image's host. ``|``
    never occurs in a URL unencoded. Unknown keys are dropped; a tail without a
    single known key is not options at all and stays part of the URL.

    A numeric ``size=200x200`` (or ``size=200``) in the URL's own query is taken
    out of it and read as imgserv's size too, as that is where it gets typed;
    a ``|size=`` wins over it. Any other ``size=`` (``size=large``) is the
    host's and stays.
    """
    url, sep, tail = value.rpartition("|")
    options: dict[str, str] = {}
    if sep:
        for part in tail.split("&"):
            key, eq, val = part.partition("=")
            key = key.strip().lower()
            if eq and key in MEDIA_OPTION_KEYS and val.strip():
                options[key] = val.strip()
    if options:
        url = url.strip()
    else:
        url = value
    m = _QUERY_SIZE_RE.search(url)
    if m:
        options.setdefault("size", m.group(2).lower())
        start, end = m.span()
        rest = url[end:]
        if m.group(1) == "?":
            # The first parameter goes; the next one, if any, takes its `?`.
            url = url[:start] + ("?" + rest[1:] if rest.startswith("&") else rest)
        else:
            url = url[:start] + rest
    return url, options


def _media_url(url: str, size: str, pct: str) -> str:
    """``imgserv://media:…`` for *url*, its ``|`` options over the defaults."""
    url, options = split_media_options(url)
    query = urlencode({"size": size, "mode": "dark", **options}, safe=",")
    source = encode_media_source(url)
    result = f"imgserv://{source}?{query}{pct}"
    if len(result) > media_refs.MAX_URL_LENGTH:
        # The remote fails on long URLs; imgserv gets the source by reference,
        # exactly as it would have received it (decoded once, like the path).
        # TEMPORARY: remove once LZIP-8 is implemented (see imgserv/media_refs).
        key = media_refs.remember(unquote(source.removeprefix("media:")))
        result = f"imgserv://ref:{key}?{query}{pct}"
    return result


def encode_media_source(url: str) -> str:
    """Build the ``media:<value>`` imgserv source for an image *url*.

    imgserv splits the request path on the first ``:`` and reads its own options
    (``size``, ``fg``, …) from the request query string, so a raw URL carrying its
    own query — ``https://cdn/art.jpg?token=abc`` — would lose everything after the
    ``?`` once ``&size=tile`` is appended.  Percent-encoding the whole URL into a
    single path segment keeps it intact; aiohttp decodes the path once before the
    handler sees it, so no extra unquoting happens server-side.

    Already-encoded values are returned unchanged so the function is idempotent.
    The comparison ignores hex case because ``quote`` emits uppercase escapes while a
    hand-written value may use lowercase ones: ``%2f`` and ``%2F`` are the same octet,
    and treating the former as "not encoded" would double-encode it to ``%252f``,
    which survives aiohttp's single unquote and reaches the handler still escaped.
    Only escape casing can differ here — ``quote`` preserves the case of every
    character it does not escape — so a genuinely unencoded URL is never mistaken for
    an encoded one.  The value is returned with its original casing either way, so
    signed URLs stay byte-exact.
    """
    if quote(unquote(url), safe="").lower() == url.lower():
        return f"media:{url}"
    return f"media:{quote(url, safe='')}"


def _ascii_safe_path(value: str) -> str:
    """Percent-encode non-ASCII so the device's URL encoder cannot mangle it.

    The remote builds its GET line from this URL with a minimal encoder: it
    escapes a space as ``%20`` and passes every other ASCII character through
    untouched -- ``:``, ``-`` and ``+`` all arrive literally. For anything above
    U+007F it emits the low byte of the code point *followed by* the code point
    in hex, so ``Top 50 – Global`` left the device as::

        GET /api/imgserv/text:Top%2050\\xa000a0\\x132013%20Global HTTP/1.1

    which aiohttp rejects outright -- ``InvalidURLError: 400`` before any
    handler runs, so the tooltip simply never appears. That hits any accented
    character, so a German label like "Küche" was equally unrenderable.

    Encoding here keeps the URL pure ASCII, which the device passes through
    verbatim and aiohttp decodes back for us. ASCII input is returned byte for
    byte, so every label that worked before is unchanged -- including the ``?``
    that the caller uses to decide its query separator.

    Why the fix lives here rather than in ``imgserv/``, which is in this same
    integration and would look like the natural home: aiohttp rejects that
    request line while *parsing* it, so routing never happens and the imgserv
    view is never entered. There is no handler code that could be taught to
    decode ``\\xa000a0`` back into U+00A0. Getting underneath HA's own aiohttp
    app is not something an integration can reasonably do.

    The true root cause is the firmware's encoder, which is not in this repo.
    ``resolve_icon_url`` is the one chokepoint every device-bound URL passes
    through, so it is the only reachable place to make the problem impossible.

    One assumption, worth stating because it is not measured: that the firmware
    passes ``%`` through unescaped. It does not escape ``:``, ``-`` or ``+``, so
    it is plainly not a general URL encoder, but this was never confirmed
    against the device. If it is wrong, ``%C2%A0`` would arrive doubled as
    ``%25C2%25A0`` and render as literal text rather than failing.
    """
    # A literal ``#`` starts the URL fragment, which the HTTP request drops, so
    # ``fg=#112233`` would reach imgserv as ``fg=``. Written as ``%23`` it
    # arrives intact, and imgserv's colour parser reads either form.
    value = value.replace("#", "%23")
    if value.isascii():
        return value
    return "".join(c if c.isascii() else quote(c, safe="") for c in value)


def resolve_icon_url(
    icon: str, size: str = "tile", color: str = "", percent: int | None = None,
) -> str:
    """Convert an icon value to a fetchable URL.

    - MDI strings (mdi:lightbulb) → imgserv://mdi:lightbulb?size={size}[&fg={color}]
    - imgserv source types (logo:hue, text:foo, phu:bar, file:img.png) → imgserv://{icon}?size={size}&mode=dark[&fg={color}]
    - External URLs (http://, https://) and HA paths (/…) → imgserv://media:{encoded}?size={size}&mode=dark
    - imgserv:// / ha:// / local:// / data: → passed through unchanged

    External images are routed through imgserv's ``media:`` proxy rather than handed
    to the device: HA fetches them, resizes to the requested size, and re-encodes to
    PNG, so the device never has to reach a third-party host or decode an arbitrary
    image format.  HA-relative paths (``/api/media_player_proxy/…``) take the same
    route: the firmware does not resolve ``ha://`` (it requests ``/ha://…``).

    The device display always has a dark background, so mode=dark ensures
    monochrome icons (logo/phu without explicit color) render white.

    The optional `color` param (6-char hex, no #) overrides the default
    foreground color for MDI icons and appends &fg= for source types.
    Icons that already contain an explicit `fg=` in their value are not modified.

    Values are stripped of surrounding whitespace before dispatch: a URL copied out
    of a browser very often arrives with a trailing space or newline, and an
    unnormalised ``startswith`` would miss every branch below and hand the raw
    third-party URL straight to the device.

    URL *schemes* are additionally matched case-insensitively, since they are
    case-insensitive by RFC 3986 and ``HTTPS://`` is a plausible paste.  imgserv
    source types are not: the server dispatches on an exact ``_SOURCES`` lookup,
    so accepting ``LOGO:`` here would only produce a URL it answers with 400.

    `default_source` names the imgserv source type to assume for a value that
    matched no branch above.  It is opt-in because the right fallback differs by
    field.  A *page title* must always end up a PNG (PROTOCOL.md §3: ``img_title``
    is a URL to a 200×60 image), so ``page_payload`` passes ``"text"`` and a bare
    ``My Page`` renders as text — mirroring the panel's own preview
    (``_renderPageIconPreview``).  A *button icon* has no such guarantee, so the
    default keeps the historical passthrough: an unrecognised scheme such as
    ``ftp://host/a.png`` is handed on untouched rather than silently turned into
    a picture of the word "ftp://host/a.png".

    The optional `percent` param (0-100) is imgserv's fill level: the bottom
    `percent`% of the finished image keeps its alpha and the rows above are
    dimmed, which is how a lamp's brightness reaches its tile. It is appended
    only on the branches that address imgserv -- a `ha://`, `local://` or
    `data:` value is fetched or decoded by the device itself, and an already
    written `imgserv://` value belongs to whoever typed it, query and all.
    """
    icon = icon.strip() if icon else ""
    if not icon:
        return ""
    pct = f"&percent={percent}" if percent is not None else ""
    # Scheme tests run against a lowercased copy; the returned value always uses the
    # original casing so signed URLs and file names stay byte-exact.
    low = icon.lower()
    if low.startswith(("ha://", "imgserv://", "local://", "data:")):
        # Already addressed at the device, so the value is passed on as-is --
        # but it still travels through the firmware's encoder, so a non-ASCII
        # character in a hand-written `imgserv://text:Küche` would be mangled
        # exactly as it is on any other branch. ASCII is returned byte for
        # byte, so an already percent-encoded URL is untouched.
        return _ascii_safe_path(icon)
    if low.startswith(("http://", "https://")):
        return _media_url(icon, size, pct)
    if icon.startswith("/"):
        # An HA path (a player's `entity_picture`, `/local/…`) is fetched by
        # imgserv too: the remote's firmware does not resolve `ha://` and would
        # ask HA for `/ha://api/…`.
        return _media_url(icon, size, pct)
    fg = color.lstrip("#") if color else ""
    if icon.startswith("mdi:"):
        # The value may carry its own query (`mdi:lightbulb?color=blue`): join
        # with `&`, and only add the page colour when the value has none of its own.
        sep = "&" if "?" in icon else "?"
        own = re.search(r"[?&](fg|color)=", icon)
        fg_part = f"&fg={fg}" if fg and not own else ""
        return f"imgserv://{_ascii_safe_path(icon)}{sep}size={size}{fg_part}{pct}"
    if icon.startswith("media:"):
        # The value is a URL in its own right — encode it so its query survives.
        return _media_url(icon[6:], size, pct)
    # imgserv source types: logo:, text:, phu:, file:, history:, and the extra
    # icon sets the frontend registered (drawn from their uploaded shapes).
    custom = custom_icon_scheme(icon)
    if icon.startswith(("logo:", "text:", "phu:", "file:", "history:")) or custom:
        sep = "&" if "?" in icon else "?"
        # Tint monochrome sources (text:, icons, a graph's line); leave
        # logos/photos untouched. A composite is tinted as soon as one of its
        # parts can take it -- imgserv is what decides which parts spend it.
        tintable = any(
            part.startswith(("text:", "phu:", "history:", "mdi:")) or custom_icon_scheme(part)
            for part in split_source_parts(icon)
        )
        color_suffix = f"&fg={fg}" if fg and tintable and not re.search(r"[?&](fg|color)=", icon) else ""
        return f"imgserv://{_ascii_safe_path(icon)}{sep}size={size}&mode=dark{color_suffix}{pct}"

    return resolve_icon_url(_words_source(icon), size, color, percent)


def _words_source(words: str) -> str:
    """Plain *words* as the ``text:`` source drawing them.

    Their own ``?`` is part of what they say, not the start of a query:
    unescaped, "What?" reached imgserv as the text "What".
    """
    return "text:" + words.replace("?", "%3F")


def _text_style_query(kind: str, style: Mapping[str, Any] | None) -> str:
    """``&font_size=…[&font=…]`` for a title or tooltip drawn in *style*.

    *style* is that kind's entry of the remote's text settings; ``None`` means
    the defaults. The font size rides in the URL although imgserv would supply
    the default one: the remote caches images by URL, so only a changed URL
    makes it redraw. The default font is left out, so a remote on default
    settings keeps the URLs it had before the settings existed.
    """
    style = style or {}
    size = style.get("font_size") or SIZE_IDS[kind].font_size
    query = f"&font_size={size}"
    font = style.get("font")
    if font and font != DEFAULT_FONT_ID:
        query += f"&font={quote(font, safe='')}"
    return query


# What `resolve_icon_url` dispatches on before its text fallback. URL schemes are
# case-insensitive (RFC 3986); imgserv source types are not, the server matching
# them exactly.
_URL_PREFIXES: Final = ("http://", "https://", "ha://", "imgserv://", "local://", "data:")
_SOURCE_PREFIXES: Final = ("mdi:", "phu:", "logo:", "text:", "file:", "media:", "history:", "/")


def custom_icon_scheme(value: str) -> str:
    """``"hue:"`` when *value* starts with a registered extra icon set, else ``""``."""
    head, sep, _ = (value or "").partition(":")
    return f"{head}:" if sep and head in _custom_icon_prefixes else ""


def is_media_source(value: str) -> bool:
    """True when *value* names a picture rather than words to print.

    Mirrors `_isMediaSource` in liza-remote-helpers.js: the editor draws its
    preview by the same rule, so a field cannot preview text and send an icon.
    """
    value = value.strip() if value else ""
    return (
        value.lower().startswith(_URL_PREFIXES)
        or value.startswith(_SOURCE_PREFIXES)
        or bool(custom_icon_scheme(value))
    )


def _draws_words(url: str) -> bool:
    """True when *url* prints words, as ``text:`` or as part of a composite.

    Both take the font settings: the words should look like every other word
    on the screen. The reading is `split_source_parts`, so a file called
    ``text:summary.png`` is a file and a ``logo:hue Küche`` is words.
    """
    if not url.startswith("imgserv://"):
        return False
    path = url[len("imgserv://"):].partition("?")[0]
    return any(part.startswith("text:") for part in split_source_parts(path))


def resolve_tooltip_url(
    text: str, color: str = "", style: Mapping[str, Any] | None = None,
) -> str:
    """The URL for what is printed under a button; ``""`` clears it.

    The tooltip takes the same values as a button's image and a page's title:
    anything imgserv can draw, with plain words drawn as ``text:``. Only words
    take the tooltip font, and a value naming its own ``font_size=`` or
    ``font=`` keeps it -- the rule `resolve_title_url` applies.
    """
    value = text.strip() if text else ""
    if not value:
        return ""
    explicit = is_media_source(value)
    if not explicit:
        value = _words_source(value)
    url = resolve_icon_url(value, size="tooltip", color=color)
    if not _draws_words(url) or (
        explicit and (
            value.lower().startswith("imgserv://")
            or "font_size=" in value
            or "font=" in value
        )
    ):
        return url
    return url + _text_style_query("tooltip", style)


def resolve_title_url(
    image: str, color: str = "", style: Mapping[str, Any] | None = None,
) -> str:
    """The URL for a page's title strip; ``""`` when the page has none.

    Only a title that draws words takes the ``title`` font size: an icon, logo
    or picture has no font, unless a ``+ text:`` has given it one. A ready-made
    ``imgserv://`` URL is passed on as written, and a title that names its own
    ``font_size=`` or ``font=`` keeps all of it: the settings are a default,
    not an override.
    """
    value = image.strip() if image else ""
    url = resolve_icon_url(value, size="title", color=color)
    if (
        not _draws_words(url)
        or value.lower().startswith("imgserv://")
        or "font_size=" in value
        or "font=" in value
    ):
        return url
    return url + _text_style_query("title", style)
