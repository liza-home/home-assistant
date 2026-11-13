"""The LAN hosts Home Assistant itself has put into a ``media:`` picture.

imgserv answers without authentication, so it must not fetch whatever LAN
address a request names: that would let anyone who reaches port 8123 read a
camera snapshot or switch a device with a GET. But some pictures legitimately
live on the LAN -- a TV serves its app icons from its own address. Every
``media:`` value Home Assistant builds passes through ``encode_media_source``,
which records the host here; imgserv fetches a non-public host only when it is
one of these.

Kept in memory and bounded: after a restart a host is known again as soon as
a page naming it is built, and a kept app icon covers the moment before.
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Final
from urllib.parse import unquote, urlsplit

_MAX_HOSTS: Final = 512
_DEFAULT_PORTS: Final = {"http": 80, "https": 443}

_hosts: OrderedDict[tuple[str, int], None] = OrderedDict()


def _key(url: str) -> tuple[str, int] | None:
    try:
        parts = urlsplit(unquote(url))
        scheme = parts.scheme.lower()
        if scheme not in _DEFAULT_PORTS or not parts.hostname:
            return None
        return parts.hostname.lower(), parts.port or _DEFAULT_PORTS[scheme]
    except ValueError:
        return None


def remember(url: str) -> None:
    """Note that Home Assistant handed out a picture at *url*'s host."""
    if (key := _key(url)) is None:
        return
    _hosts[key] = None
    _hosts.move_to_end(key)
    while len(_hosts) > _MAX_HOSTS:
        _hosts.popitem(last=False)


def is_known(url: str) -> bool:
    """Whether Home Assistant has handed out a picture at *url*'s host and port."""
    key = _key(url)
    return key is not None and key in _hosts


def forget_all() -> None:
    """For tests."""
    _hosts.clear()
