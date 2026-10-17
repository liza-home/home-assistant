"""Which Sonos track is either side of the one playing.

Home Assistant describes what a player is playing *now* and nothing about what
comes next. Sonos is the one integration that says: ``sonos.get_queue`` is a
service with ``SupportsResponse.ONLY``, and ``queue_position`` / ``queue_size``
are extra attributes on its ``media_player`` entities. Reading it and the
arithmetic on top of it live here, together; a second integration can be
given its own reader when one appears.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from homeassistant.core import HomeAssistant

PLATFORM: Final = "sonos"
GET_QUEUE_SERVICE: Final = "get_queue"

#: The four values, and the names they carry as attributes of the queue
#: sensor -- so ``${_queue.next_song}`` is the sensor's ``next_song``.
NEXT_SONG: Final = "next_song"
NEXT_ARTIST: Final = "next_artist"
PREV_SONG: Final = "prev_song"
PREV_ARTIST: Final = "prev_artist"
QUEUE_KEYS: Final = (NEXT_SONG, NEXT_ARTIST, PREV_SONG, PREV_ARTIST)

#: How much of a queue to keep. Past the cut it answers "no next track", the
#: same honest blank radio gets.
MAX_TRACKS: Final = 1000


def blank() -> dict[str, str]:
    """All four keys, empty -- a value to collapse, not wreckage to strip."""
    return dict.fromkeys(QUEUE_KEYS, "")


def text(value: Any) -> str:
    return str(value or "").strip()


def reads_queue(hass: HomeAssistant, entity_id: str) -> bool:
    """Whether *entity_id* is a Sonos player, whose queue can be read."""
    try:
        from homeassistant.helpers import entity_registry as er

        entry = er.async_get(hass).async_get(entity_id)
    except Exception:  # noqa: BLE001 - a missing registry is not an error here
        return False
    return getattr(entry, "platform", "") == PLATFORM


async def async_fetch(hass: HomeAssistant, entity_id: str) -> list[dict[str, str]] | None:
    """The queue as ``{"title", "artist"}`` rows, or None when it cannot be read."""
    if not hass.services.has_service(PLATFORM, GET_QUEUE_SERVICE):
        return None
    response = await hass.services.async_call(
        PLATFORM, GET_QUEUE_SERVICE, {"entity_id": entity_id},
        blocking=True, return_response=True,
    )
    # An entity service with a response answers per entity, keyed by its id.
    rows = (response or {}).get(entity_id) if isinstance(response, Mapping) else None
    if not isinstance(rows, list):
        return None
    return [
        {"title": text(row.get("media_title")), "artist": text(row.get("media_artist"))}
        for row in rows[:MAX_TRACKS]
        if isinstance(row, Mapping)
    ]


def position(attributes: Mapping[str, Any]) -> int:
    """The 1-based position of the playing track, 0 with no queue (radio, TV)."""
    try:
        value = int(attributes.get("queue_position"))
    except (TypeError, ValueError):
        return 0
    return max(value, 0)


def resolve(
    attributes: Mapping[str, Any], tracks: list[dict[str, str]] | None, held_size: Any,
) -> tuple[dict[str, str], bool]:
    """``(values, stale)``: the neighbours of the playing track.

    Blank, and not stale, wherever there is honestly nothing to name: no queue
    (radio), shuffle (the stored order is not the played one), the ends of a
    queue that does not repeat, a position past the held copy. Stale -- worth
    a refetch -- when nothing is held, the speaker reports another queue
    length, or the held copy names another track in the playing slot.
    ``repeat: one`` names the playing track: it really is what plays next.
    """
    index = position(attributes) - 1
    if index < 0 or attributes.get("shuffle"):
        return blank(), False
    if tracks is None or attributes.get("queue_size") != held_size:
        return blank(), True
    if index >= len(tracks):
        return blank(), False
    current = tracks[index]
    playing = text(attributes.get("media_title"))
    if playing and current["title"] != playing:
        return blank(), True

    repeat = text(attributes.get("repeat")).lower()
    if repeat == "one":
        return _values(current, current), False

    def neighbour(i: int) -> dict[str, str] | None:
        if 0 <= i < len(tracks):
            return tracks[i]
        return tracks[i % len(tracks)] if repeat == "all" else None

    return _values(neighbour(index + 1), neighbour(index - 1)), False


def _values(next_track, prev_track) -> dict[str, str]:
    next_track, prev_track = next_track or {}, prev_track or {}
    return {
        NEXT_SONG: next_track.get("title", ""),
        NEXT_ARTIST: next_track.get("artist", ""),
        PREV_SONG: prev_track.get("title", ""),
        PREV_ARTIST: prev_track.get("artist", ""),
    }
