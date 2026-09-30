"""Event entities for lizaIP — dynamically defined by the device."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .connection import LizaIPConnection
from .entity import LizaIPEntity

_LOGGER = logging.getLogger(__name__)

PARALLEL_UPDATES = 0  # No limit — event entities are push-only

#: The English wordings, which decide which buttons get a name of their own.
_STRINGS = Path(__file__).resolve().parent.parent / "strings.json"

_named_buttons_cache: frozenset[str] | None = None


def named_buttons() -> frozenset[str]:
    """Buttons we ship a wording for, read from ``strings.json``.

    Why this is derived rather than written out here: a named button carries a
    translation key instead of a placeholder, because a placeholder is filled
    in Python, where the user's language is not known -- it would read "Volume
    Down" for a German user too. A key is resolved by Home Assistant against
    the user's own language, so "Taste Leiser" becomes possible.

    But a key only works if a wording stands behind it. ``_name_internal``
    reads ``platform_translations.get(key)`` inside an ``and`` chain: with no
    wording the chain is false and the name drops through to UNDEFINED, and
    the button arrives with no name of its own at all. A hand-written list
    here could say "named" about a button no wording covers, and that button
    would go out nameless and silent.

    So the wordings decide, and a button they do not cover falls back to its
    id -- readable, never nameless. For the same reason this is not taken from
    the device's ``static_buttons``, which announces the same five today: that
    list says which buttons exist, not which ones we can name.

    English is enough to ask. Home Assistant always loads it as the fallback
    for missing keys, so a wording present here reaches every language.
    """
    global _named_buttons_cache

    if _named_buttons_cache is None:
        try:
            event = json.loads(_STRINGS.read_text(encoding="utf-8"))["entity"]["event"]
            _named_buttons_cache = frozenset(
                key[len("button_"):] for key in event if key.startswith("button_")
            )
        except (OSError, ValueError, KeyError):
            # Deliberately swallowed: without the wordings every button still
            # gets its id as a name. A packaging accident should cost the
            # translated names, not the entities.
            _LOGGER.warning(
                "Could not read button names from %s; buttons will be named by id",
                _STRINGS,
            )
            _named_buttons_cache = frozenset()

    return _named_buttons_cache


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    connection: LizaIPConnection = entry.runtime_data
    known: set[str] = set()

    # Primed here so the file is read in the executor. Every later call is
    # served from the cache, and the entities are built on the event loop.
    await hass.async_add_executor_job(named_buttons)

    def on_discovery(discovery: dict) -> None:
        all_ids = discovery.get("buttons", [])   # sliders are handled by number.py
        new = [
            LizaIPButton(connection, entry, bid)
            for bid in all_ids
            if bid not in known
        ]
        if new:
            known.update(b._button_id for b in new)
            async_add_entities(new)

    connection.register_discovery(on_discovery)


class LizaIPButton(LizaIPEntity, EventEntity):
    """A button or slider event entity on a lizaIP device."""

    _attr_translation_key = "button"
    _attr_event_types = ["touch", "click", "release", "repeat"]

    def __init__(
        self,
        connection: LizaIPConnection,
        entry: ConfigEntry,
        button_id: str,
    ) -> None:
        super().__init__(connection, entry)
        self._button_id = button_id
        # The firmware sends `button_1`, so the separator has to come off with
        # the prefix. Stripping only "button" left "_1", which is not a digit,
        # and every numbered button fell through to the title-cased branch and
        # was named "Button 1" -- under a translated "Taste", that read
        # "Taste Button 1". `button1` is accepted too; older firmware spells it
        # that way, and both mean the same button.
        if button_id.startswith("button"):
            suffix = button_id[len("button"):].lstrip("_")
        else:
            suffix = button_id
        if suffix.isdigit():
            self._attr_translation_placeholders = {"button_id": suffix}
        elif suffix in named_buttons():
            self._attr_translation_key = f"button_{suffix}"
        else:
            # The prefix comes off here too, or a button this version has no
            # name for would read "Taste Button Instant Replay" -- the same
            # doubling, just one firmware release later. `or button_id` covers
            # an id that is nothing but the prefix, which would otherwise leave
            # the name a bare "Taste".
            self._attr_translation_placeholders = {
                "button_id": (suffix or button_id).replace("_", " ").title()
            }
        self._attr_unique_id = f"{entry.entry_id}_{button_id}"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._connection.register_button(self._button_id, self._handle_event)

    async def async_will_remove_from_hass(self) -> None:
        self._connection.unregister_button(self._button_id)
        await super().async_will_remove_from_hass()

    def _handle_event(self, event_type: str, extra: dict) -> None:
        self._trigger_event(event_type, extra)
        self.async_write_ha_state()
