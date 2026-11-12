"""How an imgserv source is spelled: its type, and the parts a title is made of.

A source is ``<type>:<value>`` (``mdi:home``, ``logo:hue``, ``text:Hi``) or a
bare picture address; a title or caption may set several side by side
(``logo:hue Wohnzimmer``), which :func:`split_source_parts` reads apart. The
source types are listed once here, and the extra icon sets the browser has
registered (``hue:``, ``fapro:`` ...) are kept beside them, because both decide
what starts a part.

Pure string handling: nothing here draws, so the config side can import it
without Pillow.
"""
from __future__ import annotations

import re
from typing import Final

# ── Source types ──────────────────────────────────────────────────────────

#: The subjects imgserv draws itself, one handler each in ``httpsocket._SOURCES``
#: (a test pins the two together). Every other list of source types is derived
#: from this one.
SOURCE_TYPES: Final = ("mdi", "logo", "text", "media", "history")
#: A whole request stored under a short key (``ref:<djb2>``), expanded before
#: anything is parsed; see ``httpsocket._resolve_reference``.
REF_SOURCE_TYPE: Final = "ref"
#: The custom-brand-icons set: a browser icon set like any other, but always
#: read as a source, registered yet or not.
PHU_SOURCE_TYPE: Final = "phu"


# Every source but words has a slug for its value, which can never hold a
# space: a logo is a file we ship (`hue`, `netflix_wide`), an icon a
# hyphenated name (`mdi:play-circle`, `phu:sonos`, a registered set's
# `hue:bulb`), a graph an entity id and a picture an address, which spells a
# space `%20`. After one of those the first space starts something else.
WORDS_SOURCE: Final = "text:"

# A picture written as a bare address: an HA path (`/local/a.png`,
# `${_device.entity_picture}`) or an http(s) URL. It is a part of its own, as
# `media:` is, so a title can put a cover beside a mark and a name.
_ADDRESS = re.compile(r"^(?:/\S|https?://)", re.IGNORECASE)


def is_address(word: str) -> bool:
    """Whether *word* is a picture written as a bare address."""
    return bool(_ADDRESS.match(word))

# What may stand between two parts once a space has already divided them. A
# bare hyphen cannot be a separator on its own -- `mdi:play-circle` holds one
# -- but a spaced hyphen can, as can the plus that used to be the spelling.
_PART_LEAD_INS: Final = ("-", "+")

# What a part looks like from the outside: a scheme, then a colon. A word not
# shaped like that belongs to the part it follows, so `text:Hello world` is
# one phrase.
_PART_START = re.compile(r"^([a-z][a-z0-9_]*):")

# The source types that start a part: the ones imgserv draws, a reference and
# ``phu``. Only one of these -- or a registered extra icon set -- starts a
# part: words that merely end in a colon do not, or a label like "Go to page:
# Sonos" would ask imgserv for a `page:` source.
PART_SOURCE_TYPES: Final = frozenset((*SOURCE_TYPES, REF_SOURCE_TYPE, PHU_SOURCE_TYPE))


def has_source_type(word: str) -> bool:
    """Whether *word* is written ``type:…`` at all, a type imgserv knows or not.

    An escaped colon (``text\\:``) writes no type, and nor does a colon a
    space follows: ``battery: 50`` and ``Battery: ${level}`` are words, as a
    label is written. ``battery:50`` names a type, unknown or not yet
    registered.
    """
    m = _PART_START.match(word)
    if not m:
        return False
    rest = word[m.end():]
    return bool(rest) and not rest[0].isspace() or names_a_source(word)


def names_a_source(word: str) -> bool:
    """Whether *word* starts with a source type imgserv draws (``mdi:``, ``hue:``…)."""
    m = _PART_START.match(word)
    return bool(m) and (m.group(1) in PART_SOURCE_TYPES or m.group(1) in _custom_icon_prefixes)


def _is_part_start(word: str) -> bool:
    """Whether *word* names a source, and so starts a part of its own."""
    return is_address(word) or names_a_source(word)


def split_source_parts(source: str) -> tuple[str, ...]:
    """Split *source* into the parts drawn side by side, in order.

    A part ends where the next one starts, and a part starts at a word naming
    a source (``logo:``, ``text:``, ``mdi:``, ``media:``..., or a registered
    icon set) -- not at any word ending in a colon, which is just punctuation. After a slug
    subject plain words start a part too, and are read as the ``text:`` they
    would have to be spelled as anywhere else, so all of these draw the hue
    mark beside the word "Wohnzimmer"::

        logo:hue Wohnzimmer
        logo:hue - Wohnzimmer
        logo:hue + Wohnzimmer
        logo:hue + text:Wohnzimmer
        logo:hue text:Wohnzimmer

    A lone ``-`` or ``+`` between two parts is punctuation and is dropped,
    except where dropping it would change what a part means: a ``text:1 +
    1`` whose next word is not a part of its own is one phrase.

    One part is the common case and comes back as a tuple of one. The rule is
    the whole rule: `_draws_words` and the panel's `_splitSourceParts` read a
    title by it, so preview and device cannot drift apart.
    """
    text = (source or "").strip()
    if not text or " " not in text:
        return (text,) if text else ()

    words = text.split(" ")
    parts: list[str] = [words[0]]
    i = 1
    while i < len(words):
        word = words[i]
        if not word:
            i += 1
            continue
        nxt = next((w for w in words[i + 1:] if w), "")
        if word in _PART_LEAD_INS and (
            _is_part_start(nxt) or _is_slug_part(parts[-1])
        ):
            # Punctuation between two parts, not a part and not a value.
            i += 1
            continue
        if _is_part_start(word) or _is_slug_part(parts[-1]):
            parts.append(word if _is_part_start(word) else f"text:{word}")
        else:
            parts[-1] = f"{parts[-1]} {word}"
        i += 1
    return tuple(p for p in (p.strip() for p in parts) if p)


def _is_slug_part(part: str) -> bool:
    """Whether *part* is a slug subject still holding nothing but its slug."""
    return (
        is_address(part) or (names_a_source(part) and not part.startswith(WORDS_SOURCE))
    ) and " " not in part


#: imgserv's own source types. A browser icon set registered under one of
#: these names never shadows it. ``phu`` is deliberately not among them: the
#: custom-brand-icons set is a browser registration like any other, and its
#: shapes arrive through the upload path instead of a JS bundle read off disk.
#: ``history`` is not among them either, as it never was: a browser set of
#: that name is accepted, though ``httpsocket`` still draws ``history:`` itself.
NATIVE_SOURCE_TYPES: Final = frozenset(SOURCE_TYPES) - {"history"}

#: Icon sets the frontend has registered beyond the native ones (``phu``,
#: ``hue``, ``fapro``, ...), as last reported by the panel. They exist only in
#: the browser, so imgserv draws them from the shapes the panel uploaded
#: (``render_custom.py``). Module state because the classifiers here
#: need it and none of them has ``hass`` to look it up with.
_custom_icon_prefixes: set[str] = set()

_ICON_PREFIX_RE: Final = re.compile(r"^[a-z0-9_-]+$")


def set_custom_icon_prefixes(prefixes) -> None:
    """Replace the registered extra icon sets; native and malformed names are dropped."""
    _custom_icon_prefixes.clear()
    _custom_icon_prefixes.update(
        p for p in prefixes or ()
        if isinstance(p, str) and _ICON_PREFIX_RE.match(p) and p not in NATIVE_SOURCE_TYPES
    )


def custom_icon_prefixes() -> frozenset[str]:
    """The extra icon sets currently registered."""
    return frozenset(_custom_icon_prefixes)
