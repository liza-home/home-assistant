"""``history:`` images: a graph of an entity's recorded history, drawn by imgserv.

``history:sensor.outdoor_temperature?hours=24`` names the entity and the period
to graph (``days``, or ``start_time``/``end_time``, say it too). When a remote's
page is built, the image gets the entity's last state change as a version
(``&v=…``): the remote caches images by URL, so a new version is how a moved
graph reaches it, through the same push that updates ``${…}`` variables.

imgserv answers without authentication (the remote cannot log in), so it only
graphs entities the integration itself put into a ``history:`` image -- a
remote's stored page or the admin panel's preview, both of which go through
:func:`versioned_history_image`. Anyone else asking for an entity gets nothing.
"""
from __future__ import annotations

import re
from typing import Any, Final

from homeassistant.core import HomeAssistant

HISTORY_SCHEME: Final = "history:"

_ENTITY_ID_RE: Final = re.compile(r"[a-z0-9_]+\.[a-z0-9_]+")

#: Entities a ``history:`` image was built for, the only ones imgserv graphs.
_servable: set[str] = set()


def history_entity(image: Any) -> str | None:
    """The entity a ``history:`` image graphs, or ``None`` for anything else."""
    if not isinstance(image, str) or not image.startswith(HISTORY_SCHEME):
        return None
    # `&` too: in a combination, the whole value's `&v=` may follow the entity.
    entity_id = image[len(HISTORY_SCHEME):].split("?", 1)[0].split("&", 1)[0].strip().lower()
    return entity_id if _ENTITY_ID_RE.fullmatch(entity_id) else None


def _history_parts(image: Any) -> list[str]:
    """Every ``history:`` part of *image*, a lone graph or a composite's."""
    if not isinstance(image, str) or HISTORY_SCHEME not in image:
        return []
    from ..imgserv.source_parse import split_source_parts

    return [p for p in split_source_parts(image) if history_entity(p) is not None]


def history_entities(image: Any) -> set[str]:
    """The entities every ``history:`` part of *image* graphs."""
    return {history_entity(p) for p in _history_parts(image)}


_VERSION_PARAM_RE: Final = re.compile(r"([?&])v=[^&\s]*&?")


def _last_changed(entity_id: str, hass: HomeAssistant | None) -> int:
    _servable.add(entity_id)
    state = hass.states.get(entity_id) if hass is not None else None
    return int(state.last_changed.timestamp()) if state is not None else 0


def versioned_history_image(image: Any, hass: HomeAssistant | None) -> Any:
    """*image* with a version that moves when one of its graphs does.

    The remote caches a picture by its whole URL, so one ``v=`` is added to the
    value as a whole -- a lone graph or a combination (``Battery … +
    history:sensor.x``) alike -- and only when at least one part is a graph:
    the newest last state change among them. Anything without a ``history:``
    part is returned unchanged; a version already in the value is replaced, so
    resolving twice is harmless.
    """
    parts = _history_parts(image)
    if not parts:
        return image
    version = max(_last_changed(history_entity(p), hass) for p in parts)
    image = _VERSION_PARAM_RE.sub(lambda m: m.group(1) if m.group(0).endswith("&") else "", image)
    image = image.rstrip("?&").strip()
    return f"{image}{'&' if '?' in image else '?'}v={version}"


def is_servable(entity_id: str) -> bool:
    """Whether imgserv may graph *entity_id* (see the module docstring)."""
    return entity_id in _servable
