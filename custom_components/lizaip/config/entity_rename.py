"""Follow an entity id rename through everything a remote has stored.

Renaming an entity in Home Assistant rewrites the entity registry and nothing
else: a button bound to ``light.kitchen`` keeps the old id, the service call
fails silently, and ``${light.kitchen.state}`` draws an empty value. Nothing
tells the user why, because from the panel's side the page is unchanged.

The rewrite is deliberately structural rather than a list of known paths. A
stored page is an arbitrarily nested document -- action steps, toggle rules,
fixed-button overrides, slider configuration, the action library -- and a path
list would miss whatever is added next. Instead every ``entity_id`` /
``target_entity`` value is matched exactly, and every string is scanned for the
old id spelled out, which is what ``${…}`` tokens and ``history:`` images are.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Final

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .events import fire_config_changed
from ..const import DOMAIN
from ..runtime import find_store
from ..shared.logs import device_id_logger

_LOGGER: Final = logging.getLogger(__name__)

#: Keys whose value *is* an entity id, as a string or a list of them.
_ENTITY_KEYS: Final = frozenset({"entity_id", "target_entity"})

#: Renames are followed one at a time; see `async_follow_entity_rename`.
_RENAMES: Final = asyncio.Lock()


def _spelled_out(entity_id: str) -> re.Pattern[str]:
    """The old id where it is written into a string, and nowhere else.

    Guarded on both sides so ``sensor.a`` cannot match inside
    ``binary_sensor.a`` or ``sensor.a_backup``. A following dot is allowed
    through: that is ``${light.kitchen.state}``, the id plus an attribute.
    Case is ignored because a token is read case-insensitively
    (``variables.py`` lower-cases what it finds), so ``${Light.Kitchen}``
    names the same entity and has to follow the rename too.
    """
    return re.compile(rf"(?<![\w.]){re.escape(entity_id)}(?!\w)", re.IGNORECASE)


def _rewrite(value: Any, old: str, new: str, spelled: re.Pattern[str]) -> Any:
    """A copy of *value* with every reference to *old* replaced."""
    if isinstance(value, str):
        return spelled.sub(new, value)
    if isinstance(value, list):
        return [_rewrite(item, old, new, spelled) for item in value]
    if isinstance(value, dict):
        return {
            key: _rewrite_target(item, old, new) if key in _ENTITY_KEYS
            else _rewrite(item, old, new, spelled)
            for key, item in value.items()
        }
    return value


def _rewrite_target(value: Any, old: str, new: str) -> Any:
    """An ``entity_id`` field, which is one id or a list of them: exact matches only."""
    if isinstance(value, str):
        return new if value == old else value
    if isinstance(value, list):
        return [new if item == old else item for item in value]
    return value


async def _async_follow_for_device(
    hass: HomeAssistant, entry_id: str, device_id: str, old: str, new: str,
) -> bool:
    """Rewrite one remote's stored configuration. True if anything changed."""
    store = find_store(hass)
    if store is None:
        return False
    spelled = _spelled_out(old)

    pages = await store.async_get_pages(device_id)
    assignments = await store.async_get_all_assignments(device_id)
    library = await store.async_get_action_library(device_id)

    new_pages = _rewrite(pages, old, new, spelled)
    pages_changed = new_pages != pages
    pages = new_pages
    rewritten = {
        page_id: new_buttons
        for page_id, buttons in assignments.items()
        if (new_buttons := _rewrite(buttons, old, new, spelled)) != buttons
    }
    new_library = _rewrite(library, old, new, spelled)
    library_changed = new_library != library
    library = new_library

    if not (pages_changed or rewritten or library_changed):
        return False

    log = device_id_logger(_LOGGER, hass, device_id)
    # Page metadata first, then the assignments: `async_set_pages` rewrites
    # every page file from the assignments the store already holds, so an
    # assignment write afterwards is the one that lands.
    if pages_changed:
        await store.async_set_pages(device_id, pages)
    for page_id, buttons in rewritten.items():
        await store.async_set_assignments(device_id, page_id, buttons)
    if pages_changed:
        # A page's hash covers its title, which may itself have named the old
        # id. The recompute writes nothing where the hash already matches.
        for page in pages:
            if isinstance(page, dict) and page.get("id"):
                await store.async_recompute_page_hash(device_id, page["id"])
    if library_changed:
        await store.async_set_action_library(device_id, library)

    log.info("Entity %s was renamed to %s; stored references rewritten", old, new)
    # The same three steps every binding save takes: the rewritten targets are
    # not watched, drawn or pushed to until the listeners are rebuilt on them.
    from .websocket.common import refresh_state_listener, schedule_push_rescan
    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    schedule_push_rescan(hass, entry_id)
    return True


async def async_follow_entity_rename(hass: HomeAssistant, old: str, new: str) -> None:
    """Rewrite every remote's references to *old* so they name *new*.

    The device comes from the registry, not from the entry's connection: a
    remote that is disabled or not loaded has no connection, and its stored
    bindings would be the ones left naming an entity that is gone.

    One rename at a time. Home Assistant renames every entity of a device in
    one go, and each event is its own task: two of them reading the same
    stored pages before either has written would have the second write undo
    the first, leaving an id behind that nothing names any more.
    """
    async with _RENAMES:
        registry = dr.async_get(hass)
        for entry in hass.config_entries.async_entries(DOMAIN):
            for device in dr.async_entries_for_config_entry(registry, entry.entry_id):
                try:
                    await _async_follow_for_device(
                        hass, entry.entry_id, device.id, old, new,
                    )
                except Exception:  # noqa: BLE001 — one unwritable remote must not stop the rest
                    _LOGGER.exception(
                        "Could not follow the rename of %s on %s", old, device.id,
                    )


@callback
def async_setup_entity_rename(hass: HomeAssistant) -> None:
    """Listen for entity id renames, once for the integration."""

    async def _renamed(event) -> None:
        data = event.data
        if data.get("action") != "update":
            return
        old = (data.get("old_entity_id") or "").strip()
        new = (data.get("entity_id") or "").strip()
        if not old or not new or old == new:
            return
        await async_follow_entity_rename(hass, old, new)

    hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, _renamed)
