"""LG webOS TV: what the player keeps about each of its sources.

Home Assistant's webOS integration keeps a record of the TV's sources on the
player entity (``_source_list``, title -> app or input), in the TV's own
order. These read it; a player without one has no artwork, no inputs and no
order to give, and every answer falls back to plain names.
"""
from __future__ import annotations

from typing import Any

from .base import TvPlatform


#: Where an app's picture is found in what a player knows about one of its
#: sources, best first. LG webOS keeps each app's details by the name in
#: ``source_list`` -- the same ``largeIcon``/``icon`` Home Assistant itself
#: shows for the app that is playing.
_ARTWORK_KEYS = ("largeIcon", "icon")


def source_artwork(entity: Any, source: str) -> str:
    """The picture a player keeps for one of its sources, or ``""``.

    Read from the player entity's own record of its sources, which only some
    integrations keep (LG webOS: ``_source_list``, title -> app). Anything else
    -- no such record, no picture, not a URL -- is simply no artwork, and the
    button falls back to the source's name.
    """
    record = getattr(entity, "_source_list", None)
    info = record.get(source) if isinstance(record, dict) else None
    if not isinstance(info, dict):
        return ""
    for key in _ARTWORK_KEYS:
        value = info.get(key)
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            return value
    return ""


def source_record(entity: Any, title: str) -> dict:
    """The device's own record of source *title*, or ``{}``."""
    record = getattr(entity, "_source_list", None)
    info = record.get(title) if isinstance(record, dict) else None
    return info if isinstance(info, dict) else {}


def is_input(entity: Any, title: str) -> bool:
    """Whether *title* is one of the device's inputs rather than an app.

    LG webOS builds its sources from two lists the TV keeps apart: its apps
    (a record with a ``title`` and an ``id``) and its external inputs (a
    ``label`` and an ``appId``) -- so the record says which one a source is,
    in any language and whatever the user renamed the input to.
    """
    info = source_record(entity, title)
    return "label" in info and "title" not in info


def source_ids(entity: Any, title: str) -> tuple[str, ...]:
    """What a source may be named by in an exclude list: its title, its id."""
    info = source_record(entity, title)
    return tuple(str(v) for v in (title, info.get("id"), info.get("appId")) if v)


def in_device_order(entity: Any, source_list: list) -> list:
    """*source_list* in the order the device keeps its sources, where it does.

    LG webOS keeps its record of sources (``_source_list``, title -> app) in
    the order the TV lists them -- its apps as on the home screen, then its
    inputs -- and only the ``source_list`` it shows Home Assistant is sorted
    by name. A source the record does not know keeps its place after the rest.
    """
    record = getattr(entity, "_source_list", None)
    if not isinstance(record, dict) or not record:
        return source_list
    rank = {title: i for i, title in enumerate(record)}
    return sorted(source_list, key=lambda title: rank.get(title, len(rank)))


class WebOsTv(TvPlatform):
    integration = "webostv"

    def source_artwork(self, entity: Any, source: str) -> str:
        return source_artwork(entity, source)

    def source_ids(self, entity: Any, title: str) -> tuple[str, ...]:
        return source_ids(entity, title)

    def is_input(self, entity: Any, title: str) -> bool:
        return is_input(entity, title)

    def source_order(self, entity: Any, titles: list) -> list:
        return in_device_order(entity, titles)
