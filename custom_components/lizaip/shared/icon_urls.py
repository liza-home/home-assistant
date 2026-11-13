"""The URLs the device fetches icons, tooltips and titles from."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import quote, unquote, urlencode

from ..imgserv.const import DEFAULT_FG_COLOR, SIZE_IDS, parse_color
from ..imgserv.source_parse import (
    _custom_icon_prefixes,
    is_address,
    names_a_source,
    split_source_parts,
)
from ..imgserv import media_hosts
from ..imgserv.fonts import DEFAULT_FONT_ID
from .i18n import translate_inline
from .theme import DEFAULT_THEME, DEFAULT_THEME_ID, get_theme

#: imgserv options a picture may carry in its query: ``media:<url>?size=200x200``.
MEDIA_OPTION_KEYS: Final = ("size", "box", "fit", "mode", "fg", "bg", "crop", "alpha", "percent", "radius")

#: Options that are imgserv's wherever they are written, not just on a picture.
#: The drawing options (`font`, `hours`) only mean something to some sources,
#: but none of them is ever a word someone meant to see drawn.
OPTION_KEYS: Final = (*MEDIA_OPTION_KEYS, "color", "font", "font_size", "hours", "days")

#: A numeric ``size=``: pixels, square or ``WxH``. Symbolic ids are separate.
_SIZE_RE: Final = re.compile(r"\d+(?:x\d+)?", re.IGNORECASE)

#: A ``box=``: the four numbers ``x,y,w,h`` of the piece to cut out.
_BOX_RE: Final = re.compile(r"\d+,\d+,\d+,\d+")


def _media_option(part: str) -> tuple[str, str] | None:
    """``(key, value)`` when *part* (``key=value``) is one of imgserv's options."""
    key, eq, val = part.partition("=")
    key, val = key.strip().lower(), val.strip()
    if not eq or not val or key not in MEDIA_OPTION_KEYS:
        return None
    if key == "size":
        # The symbolic ids are imgserv's own vocabulary, so `?size=tile` on a
        # picture means what it means everywhere else; `size=large` is a word
        # imgserv does not know and stays the host's.
        if not (val.lower() in SIZE_IDS or _SIZE_RE.fullmatch(val)):
            return None
        val = val.lower()
    if key == "percent" and not (val.isdigit() and int(val) <= 100):
        return None
    if key == "radius" and not (val.isdigit() and int(val) <= 100):
        return None
    if key == "fit":
        val = val.lower()
        if val not in ("contain", "fill"):
            return None
    if key == "box":
        val = val.replace(" ", "")
        if not _BOX_RE.fullmatch(val):
            return None
    return key, val


def _media_options(query: str) -> tuple[dict[str, str], list[str]]:
    """imgserv's options in *query* (a second ``?`` counts as ``&``), and the rest."""
    options: dict[str, str] = {}
    kept: list[str] = []
    for part in query.replace("?", "&").split("&"):
        option = _media_option(part)
        if option:
            options.setdefault(*option)
        else:
            kept.append(part)
    return options, kept


def _option_parts(query: str) -> list[str]:
    """The parts of *query* that are imgserv options.

    A second ``?`` counts as ``&``. Only the key is judged here, not the
    value: ``size=large`` is still imgserv's ``size`` being asked for
    something it cannot give, and `_media_option` is where a value is
    weighed. A part with no value (``size=``) says nothing and is dropped
    with the rest.
    """
    parts = [p for p in query.replace("?", "&").split("&") if p]
    kept = []
    for part in parts:
        key, _, val = part.partition("=")
        key, val = key.strip().lower(), val.strip()
        if key in OPTION_KEYS and val:
            # Written back tidied: a stray space around `size = tile` would
            # otherwise hide the option from the `[?&]size=` test that keeps
            # the field from writing its own size a second time.
            kept.append(f"{key}={val}")
    return kept


def split_option_query(value: str) -> tuple[str, str]:
    """*value* without its trailing imgserv query, and that query.

    Words are drawn as written, question mark and all ("What?"), so a query
    is only taken for one when at least one part of it is an option imgserv
    knows: ``${sensor.battery}?size=tile`` asks for a size, ``Tea?`` does not.

    Anything else in that query is dropped rather than drawn. There is no
    host behind words for it to belong to, and someone who wrote
    ``${sensor.battery}?size=tile&1rea`` means the size and a typo, not a
    picture of the typo. The options that are there still apply.
    """
    head, q, query = value.rpartition("?")
    if not q:
        return value, ""
    kept = _option_parts(query)
    if not kept:
        return value, ""
    return head, "&".join(kept)


def split_media_options(value: str) -> tuple[str, dict[str, str]]:
    """``(url, options)`` for ``<url>?size=200x200&bg=black``.

    The URL is sent encoded, so its query would only ever reach the image's
    host; imgserv's own options (`MEDIA_OPTION_KEYS`) are taken out of it and
    read as imgserv's. A second ``?`` counts as ``&``, so
    ``${_device.entity_picture}?size=200x200`` works although that picture's
    URL already has a query of its own.

    A URL in quotes (``"…"`` or ``'…'``) is the host's as written, query and
    all; only what follows the closing quote is imgserv's:
    ``'https://a/b.png?size=2000'?size=200x200``.
    """
    quote_char = value[:1]
    if quote_char in ("'", '"'):
        end = value.find(quote_char, 1)
        if end > 0:
            options, _ = _media_options(value[end + 1:].lstrip("?&"))
            return value[1:end], options
    head, q, query = value.partition("?")
    if not q:
        return value, {}
    query, hash_sign, fragment = query.partition("#")
    options, kept = _media_options(query)
    if not options and "?" not in query:
        return value, options
    query = "&".join(p for p in kept if p)
    return head + (f"?{query}" if query else "") + hash_sign + fragment, options


#: Bumped whenever imgserv draws a whole `media:` picture differently, so a
#: device or browser holding the old one fetches it again. A boxed piece is
#: drawn as before and carries none.
MEDIA_RENDER_VERSION: Final = "round1"


#: The corner radius imgserv draws without being told; sent only when it differs.
_DEFAULT_RADIUS: Final = 100


def _media_url(url: str, size: str, pct: str, radius: int | None = None) -> str:
    """``imgserv://media:…`` for *url*, its own options over the defaults."""
    url, options = split_media_options(url)
    if "percent" in options:
        # Written on the picture, it wins over the one the field derives.
        pct = ""
    if "size" in options and "fit" not in options:
        # A size written on the picture is meant exactly: the cover cut into a
        # 3×3 grid needs its 180×186. Without one the picture keeps its own
        # proportions inside the field's size.
        options = {**options, "fit": "fill"}
    source = encode_media_source(url)
    query = urlencode({"size": size, "mode": "dark", **options}, safe=",")
    if "box" not in options:
        query += f"&rv={MEDIA_RENDER_VERSION}"
        if radius is not None and radius != _DEFAULT_RADIUS and "radius" not in options:
            query += f"&radius={radius}"
    return f"imgserv://{source}?{query}" + (f"&{pct}" if pct else "")


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
    media_hosts.remember(url)
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
    # A browser reads a backslash in an http path as a slash, which would cut
    # the escaped colon of `text\\:` in two.
    value = value.replace("\\", "%5C")
    if value.isascii():
        return value
    return "".join(c if c.isascii() else quote(c, safe="") for c in value)


def resolve_icon_url(
    icon: str, size: str = "tile", color: str = "", percent: int | None = None,
    theme: str = "", radius: int | None = None,
) -> str:
    """Convert an icon value to a fetchable URL.

    - MDI strings (mdi:lightbulb) → imgserv://mdi:lightbulb?size={size}[&fg={color}]
    - imgserv source types (logo:hue, text:foo, phu:bar, history:sensor.x) → imgserv://{icon}?size={size}&mode=dark[&fg={color}]
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

    The optional `radius` (0-100) is the corner radius, in percent of the shorter
    side, a whole `media:` picture is cut with; left out, imgserv's default
    (a circle) applies and the URL is unchanged.

    The optional `percent` param (0-100) is imgserv's fill level: the bottom
    `percent`% of the finished image keeps its alpha and the rows above are
    dimmed, which is how a lamp's brightness reaches its tile. It is appended
    only on the branches that address imgserv -- a `ha://`, `local://` or
    `data:` value is fetched or decoded by the device itself, and an already
    written `imgserv://` value belongs to whoever typed it, query and all.

    A ``{translate: <key>}`` in the value is written out in the language being
    drawn in (:func:`..i18n.translate_inline`).
    """
    icon = translate_inline(icon).strip() if icon else ""
    if not icon:
        return ""
    pct = f"percent={percent}" if percent is not None else ""
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
    composite = _with_pictures(icon)
    if composite is None:
        if low.startswith(("http://", "https://", "/")):
            # An HA path (a player's `entity_picture`, `/local/…`) is fetched
            # by imgserv too: the firmware does not resolve `ha://` and would
            # ask HA for `/ha://api/…`.
            return _media_url(icon, size, pct, radius)
        if icon.startswith("media:"):
            # The value is a URL in its own right — encode it so its query survives.
            return _media_url(icon[len("media:"):], size, pct, radius)
        if not names_a_source(icon):
            return resolve_icon_url(_words_source(icon), size, color, percent, theme, radius)
    # Something imgserv draws: an icon, words, a logo, a graph, or several
    # parts with a picture among them (each picture encoded on its own, so its
    # query stays its own). The value may carry its own query
    # (`mdi:lightbulb?color=blue`), which `_with_query` joins with `&`.
    icon = composite or icon
    icon, colour = _drawn_in(icon, color.lstrip("#") if color else "", theme, _tintable(icon))
    # A lone `mdi:` icon is drawn in the foreground without being told to.
    mode = "" if composite is None and icon.startswith("mdi:") else "mode=dark"
    return _with_emoji(_with_query(icon, _size_part(icon, size), mode, colour, pct), theme)


def _with_emoji(url: str, theme: str) -> str:
    """*url* with the emoji font *theme* names, when it draws words.

    Left out while the theme names none, so every URL is the one it was
    before themes could name one -- and the remote's cached pictures hold.
    """
    font = get_theme(theme).emoji_font if theme else ""
    if not font or "emoji=" in url or not _draws_words(url):
        return url
    return f"{url}{'&' if '?' in url else '?'}emoji={quote(font, safe='')}"


#: A colour the value names itself: ``mdi:lightbulb?color=blue``.
_OWN_COLOUR: Final = re.compile(r"(?<=[?&])(?:fg|color)=([^&#]*)", re.IGNORECASE)


def _drawn_in(icon: str, fg: str, theme: str, tinted: bool) -> tuple[str, str]:
    """*icon* and the ``fg=…`` that make its address name the colour it is drawn in.

    The remote caches a picture by its address, so the address has to change
    exactly when the picture does -- and a theme reaches a picture only
    through the one colour imgserv draws it in. A ``media:`` cover or a logo in
    its own colours never changes with the theme and keeps its address; a
    picture drawn in one colour carries that colour (:func:`_spelled`). No
    theme name and no digest: the colour itself is what moves the address.

    *tinted* says whether the page colour *fg* applies to *icon* at all.
    """
    if own := _OWN_COLOUR.search(icon):
        return icon[:own.start(1)] + _spelled(own.group(1), theme) + icon[own.end(1):], ""
    if fg and tinted:
        return icon, f"fg={_spelled(fg, theme)}"
    if (tinted or _monochrome_logo(icon)) and not re.search(r"[?&]mode=light", icon, re.I):
        # Drawn in the theme's foreground.
        spelled = _spelled("", theme)
        return icon, f"fg={spelled}" if spelled else ""
    return icon, ""


def _spelled(colour: str, theme: str) -> str:
    """*colour* (``""``: the foreground) as the address must spell it.

    As given while the remote's theme, the shipped default and the default
    imgserv has loaded all draw it the same -- so an untouched remote keeps
    its addresses -- and otherwise as the exact hex the remote draws.
    """
    def drawn(t):
        return parse_color(colour, t.colors) or t.color("default") or DEFAULT_FG_COLOR

    rgba = drawn(get_theme(theme))
    if rgba == drawn(DEFAULT_THEME) == drawn(get_theme(DEFAULT_THEME_ID)):
        return colour
    return "".join(f"{c:02X}" for c in rgba[:3 if rgba[3] == 255 else 4])


def _monochrome_logo(icon: str) -> bool:
    """Whether *icon* is a lone logo available only as an SVG, which imgserv
    draws in the foreground; one with a PNG keeps the PNG's colours."""
    if not icon.startswith("logo:") or len(split_source_parts(icon)) > 1:
        return False
    from ..imgserv.render_logo import WIDE_SUFFIX, logo_directory

    name = icon[len("logo:"):].split("?", 1)[0].removesuffix(".svg")
    directory = logo_directory(name)
    return any(
        (directory / f"{n}.svg").is_file() and not (directory / f"{n}.png").is_file()
        for n in (name, f"{name}{WIDE_SUFFIX}")
    )


def _tintable(source: str) -> bool:
    """Whether any part of *source* can take a colour (imgserv picks which do)."""
    return any(
        part.startswith(("text:", "phu:", "history:", "mdi:")) or custom_icon_scheme(part)
        for part in split_source_parts(source)
    )


def _is_picture_part(part: str) -> bool:
    return part.startswith("media:") or is_address(part)


def _with_pictures(icon: str) -> str | None:
    """*icon* as an imgserv composite when it puts a picture beside other parts.

    Each picture becomes ``media:<encoded address>``. ``None`` for a single
    part, or a composite without a picture, which the other branches already
    spell.
    """
    parts = split_source_parts(icon)
    if len(parts) < 2 or not any(_is_picture_part(p) for p in parts):
        return None
    spelled: list[str] = []
    for i, part in enumerate(parts):
        if _is_picture_part(part):
            address = part[len("media:"):] if part.startswith("media:") else part
            # imgserv's own options cannot be given per part; only the
            # address goes to its host.
            address, _options = split_media_options(address)
            spelled.append(encode_media_source(address))
        elif i == 0 and not names_a_source(part):
            spelled.append(f"text:{part}")
        else:
            spelled.append(part)
    return " ".join(spelled)


def _with_query(icon: str, *parts: str) -> str:
    """The ``imgserv://`` URL for *icon*, *parts* added to the query it has."""
    written = "&".join(p for p in parts if p)
    path = _ascii_safe_path(icon)
    if not written:
        return f"imgserv://{path}"
    return f"imgserv://{path}{'&' if '?' in path else '?'}{written}"


def _size_part(icon: str, size: str) -> str:
    """``size=…`` for the field, or nothing when *icon* names its own.

    Written twice the first one would win, so the value's would be drawn
    either way -- but only one of them says what the picture is, and a URL
    carrying both reads like a bug to whoever next looks at the traffic.
    """
    return "" if re.search(r"[?&]size=", icon) else f"size={size}"


def _words_source(words: str) -> str:
    """Plain *words* as the ``text:`` source drawing them.

    Their own ``?`` is part of what they say, not the start of a query:
    unescaped, "What?" reached imgserv as the text "What". Only the words
    themselves: a part that follows them ("Battery + history:x?v=1") keeps
    its query, and so does a trailing query that is nothing but options --
    ``${sensor.battery}?size=tile`` asks for a size rather than saying one.

    A query is only read as the words' own when nothing follows them. Once a
    source part does, the trailing ``?`` is that part's -- ``history:x`` is
    the one that takes ``hours=6``, and its cache-busting ``v=`` has to
    survive beside it.
    """
    end = _first_part_after_words(words)
    query = ""
    if end == len(words):
        words, query = split_option_query(words)
        end = _first_part_after_words(words)
    source = "text:" + words[:end].replace("?", "%3F") + words[end:]
    if not query:
        return source
    return source + ("&" if "?" in source else "?") + query


def _first_part_after_words(words: str) -> int:
    """Where the first source part after the leading words starts, or the end."""
    for m in re.finditer(r"\s", words):
        if names_a_source(words[m.end():]):
            return m.start()
    return len(words)


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
_SOURCE_PREFIXES: Final = ("mdi:", "phu:", "logo:", "text:", "media:", "history:", "/")


def custom_icon_scheme(value: str) -> str:
    """``"hue:"`` when *value* starts with a registered extra icon set, else ``""``."""
    head, sep, _ = (value or "").partition(":")
    return f"{head}:" if sep and head in _custom_icon_prefixes else ""


def is_media_source(value: str) -> bool:
    """True when *value* names a picture rather than words to print.

    Mirrors `_isMediaSource` in lizaip-helpers.js: the editor draws its
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
    theme: str = "",
) -> str:
    """The URL for what is printed under a button; ``""`` clears it.

    The tooltip takes the same values as a button's image and a page's title:
    anything imgserv can draw, with plain words drawn as ``text:``. Only words
    take the tooltip font, and a value naming its own ``font_size=`` or
    ``font=`` keeps it -- the rule `resolve_title_url` applies.
    """
    value = translate_inline(text).strip() if text else ""
    if not value:
        return ""
    explicit = is_media_source(value)
    if not explicit:
        value = _words_source(value)
    url = resolve_icon_url(value, size="tooltip", color=color, theme=theme)
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
    theme: str = "",
) -> str:
    """The URL for a page's title strip; ``""`` when the page has none.

    Only a title that draws words takes the ``title`` font size: an icon, logo
    or picture has no font, unless a ``+ text:`` has given it one. A ready-made
    ``imgserv://`` URL is passed on as written, and a title that names its own
    ``font_size=`` or ``font=`` keeps all of it: the settings are a default,
    not an override.
    """
    value = translate_inline(image).strip() if image else ""
    url = resolve_icon_url(value, size="title", color=color, theme=theme)
    if (
        not _draws_words(url)
        or value.lower().startswith("imgserv://")
        or "font_size=" in value
        or "font=" in value
    ):
        return url
    return url + _text_style_query("title", style)
