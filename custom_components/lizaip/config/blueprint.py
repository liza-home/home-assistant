"""Blueprints: the button geometry of each remote model.

One YAML file per hardware model in ``blueprints/`` (``3029-000.yaml``) lists
the buttons and their outlines. The panel draws the remote from it, and page
handlers use its button keys. Parsed files are cached in ``hass.data``.
"""
from __future__ import annotations

import logging
import os
from typing import Final

import yaml
from homeassistant.core import HomeAssistant

from ..const import DOMAIN
from .const import DEFAULT_BLUEPRINT_ID

_LOGGER = logging.getLogger(__name__)


#: Cache slot for the parsed blueprints, in ``hass.data[DOMAIN]`` beside
#: ``_ui_language``. Underscore-prefixed because the other keys there are
#: config entry ids. Holds a dict keyed by blueprint id, not a single
#: blueprint: two remotes of different models may be set up at once, and each
#: has to keep its own face.
_BLUEPRINT_CACHE_KEY: Final = "_blueprints"


#: How many parsed faces to keep. The key is the device-reported ``model_id``,
#: which is not a value this integration controls, so an unbounded dict here
#: grows with every string a remote has ever reported. Well past any real
#: household: a site with more distinct models than this re-parses the least
#: recently used one, which is a disk read, not an error.
_BLUEPRINT_CACHE_MAX: Final = 8


def entry_blueprint_id(hass: HomeAssistant, entry_id: str | None) -> str:
    """Which blueprint this config entry's remote wears.

    The device's own answer if it has given one — ``model_id`` is written into
    the entry when the hello handshake reports it — and the shipped default
    otherwise. Older firmware says nothing, and a remote that has not connected
    since the option was added has nothing stored yet, so the fallback is not
    an error path: it is the normal state for the one model that exists.

    Kept as a lookup rather than a stored panel setting because the face is a
    property of the hardware, not a preference. The user cannot pick wrong, and
    a remote swapped for a different model picks up its own face on reconnect.
    """
    if not entry_id:
        return DEFAULT_BLUEPRINT_ID
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        return DEFAULT_BLUEPRINT_ID
    model_id = entry.data.get("model_id")
    if isinstance(model_id, str) and model_id.strip():
        return model_id.strip()
    return DEFAULT_BLUEPRINT_ID


def _parse_blueprint(blueprint_id: str) -> dict:
    """Read and parse one blueprint. Blocking — call via `async_get_blueprint`.

    A model with no blueprint of its own falls back to the default rather than
    rendering an empty panel: an unknown remote almost certainly shares the
    ``lizaIP`` face, and a wrong-but-usable panel beats a blank one. The
    fallback is logged once per model, because it is the signal that a variant
    needs its own file.
    """
    directory = os.path.join(os.path.dirname(__file__), "blueprints")
    path = os.path.join(directory, f"{blueprint_id}.yaml")
    if blueprint_id != DEFAULT_BLUEPRINT_ID and not os.path.isfile(path):
        _LOGGER.warning(
            "No blueprint for model %s — falling back to %s",
            blueprint_id, DEFAULT_BLUEPRINT_ID,
        )
        blueprint_id = DEFAULT_BLUEPRINT_ID
        path = os.path.join(directory, f"{blueprint_id}.yaml")

    try:
        with open(path, "r") as fh:
            bp = yaml.safe_load(fh)
    except (FileNotFoundError, yaml.YAMLError) as exc:
        _LOGGER.error("Blueprint parse error: %s", exc)
        return {"buttons": [], "viewBox": "0 0 172 500", "name": "lizaIP"}

    buttons = [
        {"index": idx, "key": btn.get("key", f"button_{idx + 1}"), "d": btn.get("d", "")}
        for idx, btn in enumerate(bp.get("buttons", []))
    ]
    return {
        "name": bp.get("name", "lizaIP"),
        "buttons": buttons,
        "viewBox": bp.get("viewBox", "0 0 172 500"),
    }


async def async_get_blueprint(hass: HomeAssistant, entry_id: str | None = None) -> dict:
    """The parsed blueprint for one remote, read from disk at most once per run.

    The files ship inside the integration and are never written at runtime, so
    re-reading on every panel save was pure cost. More importantly the read has
    to leave the event loop: `open()` on the loop stalls every other
    integration for its duration, and Home Assistant detects it and logs a
    warning naming this module.

    Caching is per blueprint id rather than global, so a second model set up
    alongside the first does not serve the first one's face — and two entries
    of the same model still share one parse.

    ``entry_id`` is optional because one caller genuinely has no device in
    hand: the panel asks for a blueprint before it knows which remote is
    selected, and gets the default so it has something to draw.

    A failed parse is deliberately not cached. It returns a usable fallback so
    the panel still renders, but caching that would outlive the cause and hide
    a blueprint restored underneath a running instance.
    """
    store = hass.data.setdefault(DOMAIN, {})
    cache = store.setdefault(_BLUEPRINT_CACHE_KEY, {})
    blueprint_id = entry_blueprint_id(hass, entry_id)
    cached = cache.get(blueprint_id)
    if cached is not None:
        # Re-insert so the eviction below drops the face nobody is wearing.
        cache[blueprint_id] = cache.pop(blueprint_id)
        return cached

    parsed = await hass.async_add_executor_job(_parse_blueprint, blueprint_id)
    if parsed.get("buttons"):
        cache[blueprint_id] = parsed
        while len(cache) > _BLUEPRINT_CACHE_MAX:
            cache.pop(next(iter(cache)))
    return parsed
