"""What every source hands back: :class:`DynamicItem`, and its defaults.

Item shape is normalized across sources:

    title      — display name, becomes the button's ``tooltip``
    thumbnail  — artwork URL or an ``mdi:`` icon (``""`` when absent)
    action     — HA service to call, e.g. ``media_player.play_media``
    data       — service payload
    identity   — stable id recorded on the assignment for future refreshes
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


#: How many items a source is asked for when nothing narrower is requested.
#: Deliberately not part of the cache key: pages whose highest tokens differ
#: must still share one browse result.
DEFAULT_MAX_ITEMS = 24

#: Fields a new binding tracks unless its source opts into more.
#:
#: ``action`` is excluded here and added back per source: most sources use one
#: service for every item, while entity-backed sources may vary by domain.
DEFAULT_TRACKED_FIELDS = ("tooltip", "icon", "data")


def _squash(title: str) -> str:
    """A title reduced to its letters and digits, for table lookups.

    Integrations spell the same input half a dozen ways — ``Line-in``,
    ``Line In``, ``LINE_IN`` — and which one arrives depends on the speaker's
    firmware, so matching on the literal would work on one device and not the
    next.
    """
    return "".join(ch for ch in title.lower() if ch.isalnum())


#: Sources that are a socket rather than a recording, keyed by squashed title.
#:
#: These never have artwork and never will: browsing a line-in returns nothing
#: to illustrate, so without this the button sits among the album covers as a
#: text tile forever. An icon is the honest answer, not a placeholder.
_TITLE_ICONS: dict[str, str] = {
    "linein": "mdi:audio-input-stereo-minijack",
    "analogin": "mdi:audio-input-stereo-minijack",
}


@dataclass
class DynamicItem:
    title: str = ""
    thumbnail: str = ""
    action: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    identity: str = ""
    #: What the button's tooltip stores, when it is not the title itself.
    tooltip: str = ""

    @property
    def button_tooltip(self) -> str:
        return self.tooltip or self.title

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "thumbnail": self.thumbnail,
            "action": self.action,
            "data": dict(self.data),
            "identity": self.identity or self.title,
        }

    @property
    def icon(self) -> str:
        """Button-icon form of the thumbnail.

        Artwork URLs are wrapped in ``media:`` so imgserv can resize them.
        ``mdi:`` names are already device icons; wrapping them would produce
        ``media:mdi:palette`` and a 404. Missing artwork falls back to a known
        icon for the handful of sources that can never have any, and otherwise
        to a text tile so the button is not blank.
        """
        thumb = self.thumbnail
        if thumb and not thumb.startswith("media:"):
            return f"media:{thumb}" if thumb.startswith(("http", "/")) else thumb
        if thumb:
            return thumb
        if not self.title:
            return ""
        return _TITLE_ICONS.get(_squash(self.title)) or f"text:{self.title}"


@dataclass
class ResolveResult:
    items: list[DynamicItem] = field(default_factory=list)
    error: str | None = None
    succeeded_at: float = 0.0


class SourceUnavailable(RuntimeError):
    """The source could not be read, as opposed to having nothing to give.

    Resolution treats this as a hard error, keeps last-known button content and
    marks it stale instead of blanking it as an empty source.
    """
