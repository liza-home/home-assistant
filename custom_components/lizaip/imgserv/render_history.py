"""Drawing a ``history:`` graph: an entity's recorded states over a period.

A numeric entity is drawn as a line with a faint fill underneath, scaled to its
own minimum and maximum. Anything else is drawn as a band that is filled while
the entity was active (``on``, ``open``, ``home``, ``playing``). Unknown and
unavailable stretches stay empty in both.
"""
from __future__ import annotations

from datetime import datetime

from homeassistant.core import HomeAssistant
from PIL import Image, ImageDraw

#: How far back a graph looks unless the URL says otherwise, and the longest
#: period it may cover, however the URL spells it.
DEFAULT_HOURS = 24
MAX_HOURS = 168
MAX_DAYS = MAX_HOURS // 24

#: States drawn as "active" in a band; everything else known is inactive.
_ACTIVE_STATES = frozenset({"on", "open", "home", "playing", "true"})
_GAP_STATES = frozenset({"unknown", "unavailable", ""})

#: Drawn this many times larger, then scaled down, for smooth lines.
_SCALE = 4

#: A point in time (POSIX seconds) and the state the entity changed to.
Point = tuple[float, str]


async def async_history_points(
    hass: HomeAssistant, entity_id: str, start: datetime, end: datetime,
) -> tuple[list[Point], float, float]:
    """The state changes of *entity_id* between *start* and *end*, oldest first.

    Returned with the period's start and end (POSIX seconds). Includes the
    state the entity was in when the period began, so a sensor that has not
    changed for a day still has a line to draw. Raises ``KeyError`` when the
    recorder is not running.
    """
    from homeassistant.components.recorder import get_instance, history  # noqa: PLC0415

    found = await get_instance(hass).async_add_executor_job(
        history.state_changes_during_period, hass, start, end, entity_id, True,
    )
    points = [(s.last_changed.timestamp(), s.state) for s in found.get(entity_id, [])]
    return points, start.timestamp(), end.timestamp()


def _number(state: str) -> float | None:
    try:
        return float(state)
    except (TypeError, ValueError):
        return None


def _samples(points: list[Point], start: float, end: float, width: int, numeric: bool) -> list:
    """One value per pixel column: the state in force at that column's moment.

    ``None`` where the entity was unknown or unavailable (or not yet recorded),
    a number for a numeric entity, and active/inactive (bool) for the rest.
    One pass over *points*, which arrive oldest first.
    """
    out: list = []
    index, current = 0, None
    for x in range(width):
        t = start + (end - start) * (x + 0.5) / width
        while index < len(points) and points[index][0] <= t:
            current = points[index][1]
            index += 1
        if current is None or current in _GAP_STATES:
            out.append(None)
        else:
            out.append(_number(current) if numeric else current in _ACTIVE_STATES)
    return out


def render_history(
    points: list[Point], start: float, end: float,
    width: int, height: int, color: tuple,
) -> Image.Image:
    """Draw *points* between *start* and *end* on a transparent canvas."""
    w, h = width * _SCALE, height * _SCALE
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    numeric = any(_number(state) is not None for _when, state in points)
    samples = _samples(points, start, end, width, numeric)
    fill = color[:3] + (90,)
    line = color[:3] + (255,)

    if not numeric:
        top, bottom = h // 4, h - h // 4
        for x, active in enumerate(samples):
            if active is not None:
                draw.rectangle(
                    (x * _SCALE, top, (x + 1) * _SCALE - 1, bottom),
                    fill=line if active else fill,
                )
        return img.reduce(_SCALE)

    values = [v for v in samples if v is not None]
    if not values:
        return img.reduce(_SCALE)
    low, high = min(values), max(values)
    span = (high - low) or 1.0
    margin = 2 * _SCALE

    def y_of(v: float) -> float:
        # A flat line is drawn through the middle rather than along an edge.
        if high == low:
            return h / 2
        return margin + (h - 2 * margin) * (1 - (v - low) / span)

    # Consecutive known samples form one segment; a gap starts a new one.
    segment: list[tuple[float, float]] = []
    for x, v in enumerate(samples + [None]):
        if v is not None:
            segment.append(((x + 0.5) * _SCALE, y_of(v)))
            continue
        if segment:
            first_x, last_x = segment[0][0], segment[-1][0]
            draw.polygon([(first_x, h), *segment, (last_x, h)], fill=fill)
            if len(segment) > 1:
                draw.line(segment, fill=line, width=2 * _SCALE, joint="curve")
            else:
                draw.point(segment, fill=line)
            segment = []
    return img.reduce(_SCALE)
