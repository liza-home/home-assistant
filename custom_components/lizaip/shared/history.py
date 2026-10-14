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
    entity_id = image[len(HISTORY_SCHEME):].split("?", 1)[0].strip().lower()
    return entity_id if _ENTITY_ID_RE.fullmatch(entity_id) else None


def versioned_history_image(image: Any, hass: HomeAssistant | None) -> Any:
    """*image* with the entity's last state change as its version.

    Anything that is not a ``history:`` image is returned unchanged. A version
    already in the value is replaced, so resolving twice is harmless.
    """
    entity_id = history_entity(image)
    if entity_id is None:
        return image
    _servable.add(entity_id)
    state = hass.states.get(entity_id) if hass is not None else None
    version = int(state.last_changed.timestamp()) if state is not None else 0
    base, _, query = image.partition("?")
    params = [p for p in query.split("&") if p and not p.startswith("v=")]
    params.append(f"v={version}")
    return f"{base.strip()}?{'&'.join(params)}"


def is_servable(entity_id: str) -> bool:
    """Whether imgserv may graph *entity_id* (see the module docstring)."""
    return entity_id in _servable
