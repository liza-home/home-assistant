"""Short references to long ``media:`` URLs (``ref:<md5>``).

The remote's firmware fails on long image URLs, so a picture whose imgserv URL
would exceed ``MAX_URL_LENGTH`` is sent as ``imgserv://ref:<md5>`` instead and
imgserv looks the source up here. The table lives in memory and keeps the
``MAX_REFS`` most recently used sources; a reference that has dropped out (or
predates a restart) is answered with 404 until the page is pushed again.

TEMPORARY: remove this module (and the ``ref:`` source in ``httpsocket`` and
its use in ``const._media_url``) once LZIP-8 is implemented.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from typing import Final

#: Longer imgserv URLs are sent to the remote as a reference.
MAX_URL_LENGTH: Final = 200
#: How many sources the table keeps, least recently used dropped first.
MAX_REFS: Final = 200

_refs: OrderedDict[str, str] = OrderedDict()


def remember(source: str) -> str:
    """Store *source* and return its key (the md5 hex digest)."""
    key = hashlib.md5(source.encode()).hexdigest()
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


def clear() -> None:
    """Forget every reference (tests)."""
    _refs.clear()
