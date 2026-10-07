"""Keeping entity variables in tooltips and icons current on the remote.

A button tooltip or icon, or a page title, may name an entity -- ``Outside ${sensor.outdoor}``,
``mdi:weather-${weather.home}`` -- and the page payload carries its current
value. The value moves, so the payload does too, but only as far as it has to:
a change is acted on only when it moves something a variable actually reads,
only the pages that name the entity are rebuilt, and only the tiles and
tooltips that came out different are pushed (``refresh``, normally
``device_sync.async_push_variable_pages``).
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback

from ..action_controller.helpers import _get_store, _resolve_device_id
from ..action_controller.toggle import rule_icon, rule_label, toggle_rules
from ..const import ENTITY_TOKEN_RE
from .const import CONFIG_CHANGED_EVENT

_LOGGER = logging.getLogger(__name__)

# A sensor reporting every second must not resend its page every second. The
# first change opens the window; every change inside it rides along.
VARIABLE_THROTTLE_SECONDS = 2.0

_VARIABLE_FIELDS = ("label", "image")

#: What a variable reads off its entity: an attribute's name, or ``None`` for
#: the state -- which in text comes with its unit, so the unit counts too.
_Reads = dict[str, set[str | None]]


def _token_reads(text) -> _Reads:
    if not isinstance(text, str) or "${" not in text:
        return {}
    found: _Reads = {}
    for m in ENTITY_TOKEN_RE.finditer(text):
        found.setdefault(m.group(1).lower(), set()).add(m.group(2))
    return found


def _merge(into: _Reads, more: _Reads) -> _Reads:
    for entity_id, reads in more.items():
        into.setdefault(entity_id, set()).update(reads)
    return into


def _button_reads(button: dict) -> _Reads:
    found: _Reads = {}
    for key in _VARIABLE_FIELDS:
        _merge(found, _token_reads(button.get(key)))
    state_icons = button.get("state_icons")
    if isinstance(state_icons, dict):
        for icon in state_icons.values():
            _merge(found, _token_reads(icon))
    return found


def _assignment_reads(assign) -> _Reads:
    if not isinstance(assign, dict):
        return {}
    found = _button_reads(assign)
    overrides = assign.get("overrides")
    if isinstance(overrides, dict):
        for override in overrides.values():
            if isinstance(override, dict):
                _merge(found, _button_reads(override))
    # A toggle's press rules count too. They are not an override of the
    # button's fields but a replacement for them -- a cycle paints the step
    # that is next, so whichever press is up *is* the button's face -- and
    # they accept the same ``${entity}`` syntax. Missing them meant a press
    # variable read correctly at the moment of the press and then sat frozen:
    # nothing here named the sensor, so nothing resyncing the page when it
    # moved. Both live repaint paths (``state_listener`` and ``device_sync``)
    # already render the current step, so the only piece that was absent is
    # the subscription.
    #
    # `icon`/`label` rather than `image`/`label`: a rule names its glyph the
    # way an action does, not the way an assignment does.
    for rule in toggle_rules(assign):
        _merge(found, _token_reads(rule_icon(rule)))
        _merge(found, _token_reads(rule_label(rule)))
    return found


def _action_reads(action) -> _Reads:
    if not isinstance(action, dict):
        return {}
    found = _token_reads(action.get("icon"))
    for row in action.get("states") or ():
        if isinstance(row, dict):
            _merge(found, _token_reads(row.get("icon")))
    return found


def assignment_variable_entities(assign) -> set[str]:
    """Every entity a button's tooltip or icons name.

    Its overrides and its toggle's press rules included.
    """
    return set(_assignment_reads(assign))


def action_variable_entities(action) -> set[str]:
    """Every entity a library action's icon or per-state icons name."""
    return set(_action_reads(action))


@dataclass
class VariableUse:
    """Where one entity is named, and which of its values are read there."""

    reads: set[str | None] = field(default_factory=set)
    pages: set[int] = field(default_factory=set)


async def async_variable_uses(hass: HomeAssistant, device_id: str) -> dict[str, VariableUse]:
    """Every entity named by a variable on the device's pages, and where.

    The page title counts as well as every button, and the icons of every
    action a button runs -- on the page of the button that runs it.
    """
    store = _get_store(hass)
    uses: dict[str, VariableUse] = {}

    def _note(reads: _Reads, page_id: int) -> None:
        for entity_id, what in reads.items():
            use = uses.setdefault(entity_id, VariableUse())
            use.reads |= what
            use.pages.add(page_id)

    actions_by_page: dict[int, set[str]] = {}
    for page in await store.async_get_pages(device_id):
        if not isinstance(page, dict):
            continue
        page_id = page.get("id", 1)
        _note(_token_reads(page.get("image")), page_id)
        assignments = await store.async_get_assignments(device_id, page_id)
        for assign in (assignments or {}).values():
            _note(_assignment_reads(assign), page_id)
            if isinstance(assign, dict) and assign.get("action_id"):
                actions_by_page.setdefault(page_id, set()).add(assign["action_id"])
    if actions_by_page:
        library = {
            a.get("id"): a
            for a in await store.async_get_action_library(device_id) or ()
            if isinstance(a, dict)
        }
        for page_id, action_ids in actions_by_page.items():
            for action_id in action_ids:
                _note(_action_reads(library.get(action_id)), page_id)
    return uses


async def async_variable_entities(hass: HomeAssistant, device_id: str) -> set[str]:
    """Every entity named by a variable anywhere on the device's pages."""
    return set(await async_variable_uses(hass, device_id))


def _read(state, what: str | None):
    if state is None:
        return None
    attributes = state.attributes or {}
    if what is None:
        return (state.state, attributes.get("unit_of_measurement"))
    return attributes.get(what)


def variable_value_changed(old_state, new_state, reads) -> bool:
    """Whether the change moved anything a variable reads.

    A weather entity updates its temperature, wind and humidity far more often
    than its condition; a page reading only the condition has nothing to redraw.
    """
    return any(_read(old_state, what) != _read(new_state, what) for what in reads)


async def async_setup_variable_listener(
    hass: HomeAssistant,
    entry: ConfigEntry,
    refresh: Callable[[HomeAssistant, ConfigEntry, set[int]], Awaitable[object]],
) -> Callable[[], None]:
    """Refresh the pages that name an entity whenever a value they read moves.

    *refresh* is awaited as ``refresh(hass, entry, page_ids)`` -- normally
    ``device_sync.async_push_variable_pages``, passed in so this module stays
    below ``device_sync`` in the import graph. Returns a cleanup callable.
    """
    uses: dict[str, VariableUse] = {}
    pending: set[int] = set()
    timer: list[asyncio.TimerHandle | None] = [None]

    async def _refresh_watched() -> None:
        uses.clear()
        # Resolved on every refresh: on a first boot the device may only be
        # registered after this listener was set up.
        try:
            device_id = _resolve_device_id(hass, entry.entry_id)
            if device_id:
                uses.update(await async_variable_uses(hass, device_id))
        except Exception as err:  # noqa: BLE001 - live values must never break setup
            _LOGGER.debug("Variable listener: cannot read pages: %s", err)
        _LOGGER.debug("Variable listener: watching %s", sorted(uses))

    await _refresh_watched()

    @callback
    def _flush() -> None:
        timer[0] = None
        page_ids = set(pending)
        pending.clear()
        if page_ids:
            hass.async_create_task(refresh(hass, entry, page_ids))

    @callback
    def _on_state_change(event: Event) -> None:
        use = uses.get(event.data.get("entity_id"))
        if use is None or not variable_value_changed(
            event.data.get("old_state"), event.data.get("new_state"), use.reads,
        ):
            return
        pending.update(use.pages)
        if timer[0] is None:
            timer[0] = hass.loop.call_later(VARIABLE_THROTTLE_SECONDS, _flush)

    async def _on_config_changed(event: Event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            # The config sync that the same event starts rebuilds every page,
            # so a refresh still waiting would only repeat it.
            pending.clear()
            await _refresh_watched()

    unsubs = [
        hass.bus.async_listen(EVENT_STATE_CHANGED, _on_state_change),
        hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed),
    ]

    def _cleanup() -> None:
        for unsub in unsubs:
            unsub()
        if timer[0] is not None:
            timer[0].cancel()
            timer[0] = None
        pending.clear()
        uses.clear()

    return _cleanup
