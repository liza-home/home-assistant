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
from typing import Any

from homeassistant.config_entries import (
    SIGNAL_CONFIG_ENTRY_CHANGED,
    ConfigEntry,
    ConfigEntryChange,
)
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_state_change_event

from ..action_controller.helpers import _get_store, _resolve_device_id
from ..action_controller.toggle import rule_icon, rule_label, toggle_rules
from ..variables_calc import (
    _EXPR_ENTITY_RE,
    FUNCTION_TOKEN_RE,
    read_variables_enabled,
    DEFAULT_VARIABLES_INTERVAL,
    read_variables_interval,
)
from ..shared.history import history_entity
from ..shared.tokens import (
    DEVICE_TOKEN_RE,
    ENTITY_TOKEN_RE,
    current_page_layout,
    expand_device_alias,
    page_scope,
)
from .const import CONFIG_CHANGED_EVENT

_LOGGER = logging.getLogger(__name__)

# A sensor reporting many times a second must not redraw its tiles every time.
# The first change goes out at once and opens the window; every change inside
# it waits for the window to close and then goes out together. The window is
# the remote's own setting (gear tab); this is its default.
VARIABLE_THROTTLE_SECONDS = DEFAULT_VARIABLES_INTERVAL / 1000

_VARIABLE_FIELDS = ("label", "image")

#: What a variable reads off its entity: an attribute's name, or ``None`` for
#: the state -- which in text comes with its unit, so the unit counts too.
_Reads = dict[str, set[str | None]]


def _token_reads(text) -> _Reads:
    graphed = history_entity(text)
    if graphed is not None:
        # A graph moves when its entity's state does.
        return {graphed: {None}}
    if not isinstance(text, str) or "${" not in text:
        return {}
    if "_device" in text:
        # `${_device.attr}` is the entity of the page in scope.
        text = expand_device_alias(text, current_page_layout())
    found: _Reads = {}
    for m in ENTITY_TOKEN_RE.finditer(text):
        found.setdefault(m.group(1).lower(), set()).add(m.group(2))
    for m in FUNCTION_TOKEN_RE.finditer(text):
        for e in _EXPR_ENTITY_RE.finditer(m.group(1)):
            found.setdefault(e.group(1).lower(), set()).add(e.group(2))
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
    layouts: dict[int, Any] = {}
    for page in await store.async_get_pages(device_id):
        if not isinstance(page, dict):
            continue
        page_id = page.get("id", 1)
        layouts[page_id] = page.get("layout")
        assignments = await store.async_get_assignments(device_id, page_id)
        # `${_device.attr}` is the page's own entity under another name.
        with page_scope(layouts[page_id]):
            _note(_token_reads(page.get("image")), page_id)
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
            with page_scope(layouts[page_id]):
                for action_id in action_ids:
                    _note(_action_reads(library.get(action_id)), page_id)
    return uses


def _names_device(value: Any) -> bool:
    """Whether ``${_device}`` (the name) is anywhere in *value*."""
    if isinstance(value, str):
        return bool(DEVICE_TOKEN_RE.search(value))
    if isinstance(value, dict):
        return any(_names_device(v) for v in value.values())
    if isinstance(value, list):
        return any(_names_device(v) for v in value)
    return False


async def async_device_title_targets(
    hass: HomeAssistant, device_id: str,
) -> dict[str, set[int]]:
    """The layout targets named by ``${_device}`` on a page, and where.

    The title counts, every button, and the action each button runs. Keyed by
    what the name is read from: the bound device's registry id, or the hub's
    config entry id.
    """
    store = _get_store(hass)
    targets: dict[str, set[int]] = {}
    library: dict | None = None
    for page in await store.async_get_pages(device_id):
        if not isinstance(page, dict):
            continue
        layout = page.get("layout")
        if not isinstance(layout, dict):
            continue
        named = _names_device(page.get("image"))
        if not named:
            assignments = (await store.async_get_assignments(device_id, page.get("id", 1))) or {}
            named = _names_device(assignments)
            if not named:
                if library is None:
                    library = {
                        a.get("id"): a
                        for a in await store.async_get_action_library(device_id) or ()
                        if isinstance(a, dict)
                    }
                named = any(
                    _names_device(library.get(a.get("action_id")))
                    for a in assignments.values() if isinstance(a, dict)
                )
        if not named:
            continue
        target = layout.get("target") if isinstance(layout, dict) else None
        if not isinstance(target, dict):
            continue
        key = target.get("config_entry") or target.get("device")
        if key:
            targets.setdefault(key, set()).add(page.get("id", 1))
    return targets


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
    # `${_device}` titles: the device or hub each one names, and the hub titles
    # as last seen -- a config entry's update signal does not say what changed.
    title_targets: dict[str, set[int]] = {}
    hub_titles: dict[str, str] = {}
    pending: set[int] = set()
    timer: list[asyncio.TimerHandle | None] = [None]
    stop_tracking: list[Callable[[], None]] = [lambda: None]

    async def _refresh_watched() -> None:
        uses.clear()
        title_targets.clear()
        hub_titles.clear()
        # Resolved on every refresh: on a first boot the device may only be
        # registered after this listener was set up.
        try:
            device_id = _resolve_device_id(hass, entry.entry_id)
            if device_id:
                uses.update(await async_variable_uses(hass, device_id))
                title_targets.update(await async_device_title_targets(hass, device_id))
            for key in title_targets:
                hub = hass.config_entries.async_get_entry(key)
                if hub is not None:
                    hub_titles[key] = hub.title
        except Exception as err:  # noqa: BLE001 - live values must never break setup
            _LOGGER.debug("Variable listener: cannot read pages: %s", err)
        _LOGGER.debug("Variable listener: watching %s", sorted(uses))
        # Subscribe to exactly the entities read now; HA skips all others.
        stop_tracking[0]()
        stop_tracking[0] = async_track_state_change_event(
            hass, list(uses), _on_state_change,
        )

    @callback
    def _flush() -> None:
        page_ids = set(pending)
        pending.clear()
        if not page_ids:
            timer[0] = None
            return
        hass.async_create_task(refresh(hass, entry, page_ids))
        # Whatever moves while this push is on its way waits one window.
        window = read_variables_interval(getattr(entry, "options", None)) / 1000
        timer[0] = hass.loop.call_later(window, _flush)

    @callback
    def _queue(page_ids: set[int]) -> None:
        pending.update(page_ids)
        if timer[0] is None:
            _flush()

    @callback
    def _on_state_change(event: Event) -> None:
        use = uses.get(event.data.get("entity_id"))
        if use is None or not read_variables_enabled(getattr(entry, "options", None)):
            return
        if not variable_value_changed(
            event.data.get("old_state"), event.data.get("new_state"), use.reads,
        ):
            return
        _queue(use.pages)

    @callback
    def _on_device_renamed(event: Event) -> None:
        pages = title_targets.get(event.data.get("device_id"))
        changes = event.data.get("changes") or {}
        if pages and event.data.get("action") == "update" and (
            "name" in changes or "name_by_user" in changes
        ):
            _queue(pages)

    @callback
    def _on_hub_changed(change: ConfigEntryChange, hub: ConfigEntry) -> None:
        pages = title_targets.get(hub.entry_id)
        if not pages or change is not ConfigEntryChange.UPDATED:
            return
        if hub_titles.get(hub.entry_id) != hub.title:
            hub_titles[hub.entry_id] = hub.title
            _queue(pages)

    async def _on_config_changed(event: Event) -> None:
        if event.data.get("entry_id") == entry.entry_id:
            # The config sync that the same event starts rebuilds every page,
            # so a refresh still waiting would only repeat it.
            pending.clear()
            await _refresh_watched()

    await _refresh_watched()
    unsubs = [
        hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed),
        hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, _on_device_renamed),
        async_dispatcher_connect(hass, SIGNAL_CONFIG_ENTRY_CHANGED, _on_hub_changed),
    ]

    def _cleanup() -> None:
        stop_tracking[0]()
        for unsub in unsubs:
            unsub()
        if timer[0] is not None:
            timer[0].cancel()
            timer[0] = None
        pending.clear()
        uses.clear()

    return _cleanup
