"""Short references to imgserv URLs (``imgserv://ref:<djb2>``).

The remote's firmware fails on long image URLs and builds a page payload in
one allocation, so every imgserv URL in a ``set_page`` is replaced by a fixed
30-character reference just before it is sent (see ``with_references``), and
imgserv expands it back into the spelled-out request. Everything else -- the
page payload, its hash, the panel -- keeps the spelled-out URL.

The table lives in memory and keeps the ``MAX_REFS`` most recently used URLs.
It is empty after a restart, which needs no repair: a fresh connection clears
the remote and writes every page again (``device_sync``), refilling it.

TEMPORARY: remove this module once LZIP-8 is implemented.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Final

#: How many URLs the table keeps, least recently used dropped first. Sized for
#: every picture of an installation plus the album art that comes and goes.
MAX_REFS: Final = 4000

_PREFIX: Final = "imgserv://"
_REF_PREFIX: Final = "imgserv://ref:"

#: djb2 over 64 bits. The keys only have to tell URLs apart, not resist an
#: attacker, so a string hash beats a cryptographic digest here: it is cheaper
#: and half as long (16 hex characters). 64 bits keep collisions out of reach
#: of ``MAX_REFS`` entries, where the classic 32-bit djb2 would not.
_DJB2_INIT: Final = 5381
_MASK64: Final = 0xFFFFFFFFFFFFFFFF

_refs: OrderedDict[str, str] = OrderedDict()


def djb2(text: str) -> str:
    """Daniel J. Bernstein's string hash of *text*, as 16 hex characters."""
    digest = _DJB2_INIT
    for byte in text.encode():
        digest = (digest * 33 + byte) & _MASK64
    return f"{digest:016x}"


def remember(source: str) -> str:
    """Store *source* (an imgserv URL without its scheme) and return its key."""
    key = djb2(source)
    _refs[key] = source
    _refs.move_to_end(key)
    while len(_refs) > MAX_REFS:
        _refs.popitem(last=False)
    return key


def lookup(key: str) -> str | None:
    """The source stored under *key*, or ``None``."""
    source = _refs.get(key)
    if source is not None:
        _refs.move_to_end(key)
    return source


def with_references(value: Any) -> Any:
    """*value* with every imgserv URL in it replaced by its reference."""
    if isinstance(value, str):
        if value.startswith(_PREFIX) and not value.startswith(_REF_PREFIX):
            return _REF_PREFIX + remember(value[len(_PREFIX):])
        return value
    if isinstance(value, dict):
        return {k: with_references(v) for k, v in value.items()}
    if isinstance(value, list):
        return [with_references(v) for v in value]
    return value


def clear() -> None:
    """Forget every reference (tests)."""
    _refs.clear()
