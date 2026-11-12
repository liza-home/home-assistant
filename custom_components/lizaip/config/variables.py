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
from typing import Any, Final

from homeassistant.config_entries import (
    SIGNAL_CONFIG_ENTRY_CHANGED,
    ConfigEntry,
    ConfigEntryChange,
)
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import label_registry as lr
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_state_change_event

from ..action_controller.helpers import resolve_target_entities
from ..runtime import get_store, resolve_device_id
from ..action_controller.toggle import toggle_rules
from ..shared.variables_calc import (
    _EXPR_ENTITY_RE,
    FUNCTION_TOKEN_RE,
    DEFAULT_VARIABLES_INTERVAL,
    read_variables_interval,
)
from .media_queue.alias import expand_queue_alias
from ..shared.history import history_entities, history_entity
from ..shared.logs import device_logger
from ..shared.tokens import (
    COMPUTED_FACTS,
    DEVICE_FACT_TOKEN_RE,
    DEVICE_FACTS,
    DEVICE_TOKEN_RE,
    ENTITY_TOKEN_RE,
    button_scope,
    current_page_template,
    expand_device_alias,
    template_target_device,
    template_target_entity,
    page_scope,
)
from .const import CONFIG_CHANGED_EVENT
from .default_pages import async_effective_pages

_LOGGER = logging.getLogger(__name__)

# A sensor reporting many times a second must not redraw its tiles every time.
# The first change goes out at once and opens the window; every change inside
# it waits for the window to close and then goes out together. The window is
# the remote's own setting (gear tab); this is its default.
VARIABLE_THROTTLE_SECONDS = DEFAULT_VARIABLES_INTERVAL / 1000

_VARIABLE_FIELDS = ("tooltip", "icon")

#: What a variable reads off its entity: an attribute's name, or ``None`` for
#: the state -- which in text comes with its unit, so the unit counts too.
_Reads = dict[str, set[str | None]]


def _token_reads(text, subjects: tuple[str, ...] = ()) -> _Reads:
    graphed = history_entity(text)
    if graphed is not None:
        # A graph moves when its entity's state does.
        return {graphed: {None}}
    # A graph that is one part of a composite moves the same way.
    found_graphs: _Reads = {e: {None} for e in history_entities(text)}
    if not isinstance(text, str) or "${" not in text:
        return found_graphs
    named_by = ""
    if "_device" in text:
        template = current_page_template()
        facts = {m.group(1) for m in DEVICE_FACT_TOKEN_RE.finditer(text)}
        # The name can be the page entity's own: it is whenever the page is
        # bound to an entity with no device behind it, as a KNX light set up
        # in YAML has none. A device rename arrives by another road
        # (`async_device_title_targets`); an entity rename only arrives here.
        if DEVICE_TOKEN_RE.search(text) or facts:
            named_by = template_target_entity(template)
        # A fact read from the device has no state to subscribe to. Dropped
        # before the rest, so only what is left is watched.
        text = DEVICE_FACT_TOKEN_RE.sub("", text)
        # `${_device.attr}` is the entity of the page in scope.
        text = expand_device_alias(text, template)
    # `${_queue.x}` is an attribute of the queue sensor of whichever speaker
    # the button points at, so each of them is a separate text to scan. Read
    # as the literal id `_queue.x`, nothing subscribed to what it named.
    texts = [text]
    if "_queue" in text:
        texts = [expand_queue_alias(text, subject) for subject in subjects or (None,)]
    found: _Reads = {}
    for candidate in texts:
        for m in ENTITY_TOKEN_RE.finditer(candidate):
            found.setdefault(m.group(1).lower(), set()).add(m.group(2))
        for m in FUNCTION_TOKEN_RE.finditer(candidate):
            for e in _EXPR_ENTITY_RE.finditer(m.group(1)):
                found.setdefault(e.group(1).lower(), set()).add(e.group(2))
    if named_by:
        found.setdefault(named_by.lower(), set()).add("friendly_name")
    return _merge(found, found_graphs)


def _merge(into: _Reads, more: _Reads) -> _Reads:
    for entity_id, reads in more.items():
        into.setdefault(entity_id, set()).update(reads)
    return into


def _queue_subjects(config, hass) -> tuple[str, ...]:
    """The speakers a step points at, whose queue sensors its tooltip may read."""
    if hass is None or not isinstance(config, list) or not config:
        return ()
    return tuple(
        entity_id
        for entity_id in resolve_target_entities(config[0], hass)
        if entity_id.startswith("media_player.")
    )


def _button_reads(button: dict, subjects: tuple[str, ...] = ()) -> _Reads:
    found: _Reads = {}
    for key in _VARIABLE_FIELDS:
        _merge(found, _token_reads(button.get(key), subjects))
    state_icons = button.get("state_icons")
    if isinstance(state_icons, dict):
        for icon in state_icons.values():
            _merge(found, _token_reads(icon, subjects))
    return found


def _assignment_reads(assign, hass=None) -> _Reads:
    if not isinstance(assign, dict):
        return {}
    subjects = _queue_subjects(assign.get("config"), hass)
    # On a plain page `${_device.x}` is the button's own entity, as drawn.
    with button_scope(subjects[0] if subjects else None, hass):
        return _assignment_reads_in_scope(assign, subjects, hass)


def _assignment_reads_in_scope(assign: dict, subjects: tuple[str, ...], hass) -> _Reads:
    found = _button_reads(assign, subjects)
    overrides = assign.get("overrides")
    if isinstance(overrides, dict):
        for override in overrides.values():
            if isinstance(override, dict):
                _merge(found, _button_reads(override, subjects))
    # A toggle's press rules count too. They are not an override of the
    # button's fields but a replacement for them -- a cycle paints the step
    # that is next, so whichever press is up *is* the button's face -- and
    # they accept the same ``${entity}`` syntax. Missing them meant a press
    # variable read correctly at the moment of the press and then sat frozen:
    # nothing here named the sensor, so nothing resyncing the page when it
    # moved. Both live repaint paths (``state_listener`` and ``device_sync``)
    # already render the current step, so the only piece that was absent is
    # the subscription.
    for rule in toggle_rules(assign):
        # A rule's own target, not the button's: a cycle step may point at a
        # different speaker, and its tooltip reads that one's queue.
        rule_subjects = _queue_subjects(rule.get("config"), hass)
        # Read as a button is: a press stores its picture and text under the
        # same names (`icon`, `state_icons`, `tooltip`).
        _merge(found, _button_reads(rule, rule_subjects))
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


async def async_variable_uses(
    hass: HomeAssistant, device_id: str, entry: ConfigEntry | None = None,
) -> dict[str, VariableUse]:
    """Every entity named by a variable on the device's pages, and where.

    The page title counts as well as every button, and the icons of every
    action a button runs -- on the page of the button that runs it.

    *entry* lets a remote with no pages of its own be watched too: the
    placeholders it shows read its battery and addresses, and without this
    their tiles would freeze at whatever the last sync drew.
    """
    store = get_store(hass)
    uses: dict[str, VariableUse] = {}

    def _note(reads: _Reads, page_id: int) -> None:
        for entity_id, what in reads.items():
            use = uses.setdefault(entity_id, VariableUse())
            use.reads |= what
            use.pages.add(page_id)

    actions_by_page: dict[int, set[str]] = {}
    templates: dict[int, Any] = {}
    pages = await store.async_get_pages(device_id)
    stand_in: dict[int, dict] | None = None
    if not pages and entry is not None:
        effective = await async_effective_pages(hass, entry)
        pages = effective.pages
        stand_in = effective.assignments
    for page in pages:
        if not isinstance(page, dict):
            continue
        page_id = page.get("id", 1)
        templates[page_id] = page.get("template")
        assignments = (
            stand_in.get(page_id, {}) if stand_in is not None
            else await store.async_get_assignments(device_id, page_id)
        )
        # `${_device.attr}` is the page's own entity under another name.
        with page_scope(templates[page_id]):
            _note(_token_reads(page.get("title")), page_id)
            for assign in (assignments or {}).values():
                _note(_assignment_reads(assign, hass), page_id)
                if isinstance(assign, dict) and assign.get("action_id"):
                    actions_by_page.setdefault(page_id, set()).add(assign["action_id"])
    if actions_by_page:
        library = {
            a.get("id"): a
            for a in await store.async_get_action_library(device_id) or ()
            if isinstance(a, dict)
        }
        for page_id, action_ids in actions_by_page.items():
            with page_scope(templates[page_id]):
                for action_id in action_ids:
                    _note(_action_reads(library.get(action_id)), page_id)
    return uses


#: The device registry fields a ``${_device…}`` can draw, by the name the
#: registry's update event calls them: the two a name is made of, the room it
#: is filed under, the labels stuck on it, and the facts that are their own
#: field.
#:
#: Which facts are *not* its fields is taken from :data:`COMPUTED_FACTS`
#: rather than written out again here. Written out, this would be a second
#: place to remember, and forgetting it is silent -- the integration would
#: watch a field the registry does not have while the fact it should repaint
#: for went unwatched, and the page would simply stop keeping up.
_DEVICE_FACT_FIELDS: Final = frozenset(
    {"name", "name_by_user", "area_id", "labels"}
    | {f for f in DEVICE_FACTS if f not in COMPUTED_FACTS},
)

#: The fields that can move a hub page to a different bridge: which entries a
#: device belongs to, and whether it sits behind another.
_BRIDGE_FIELDS: Final = frozenset({"config_entries", "primary_config_entry", "via_device_id"})

#: What an entity can carry of its own, overriding or standing in for its
#: device's: the room it is filed under and the labels stuck on it. Nothing
#: else reports either moving.
_ENTITY_OWN_FIELDS: Final = frozenset({"area_id", "labels"})


def _names_device(value: Any) -> bool:
    """Whether ``${_device}`` or a fact about it is anywhere in *value*."""
    if isinstance(value, str):
        return bool(DEVICE_TOKEN_RE.search(value) or DEVICE_FACT_TOKEN_RE.search(value))
    if isinstance(value, dict):
        return any(_names_device(v) for v in value.values())
    if isinstance(value, list):
        return any(_names_device(v) for v in value)
    return False


async def async_device_title_targets(
    hass: HomeAssistant, device_id: str,
) -> dict[str, set[int]]:
    """The template targets named by ``${_device}`` on a page, and where.

    The title counts, every button, and the action each button runs. Keyed by
    what the name is read from: the bound device's registry id, or the hub's
    config entry id -- and a hub page under its bridge's registry id as well,
    because the name it draws comes from that device first.

    A page bound to an entity alone is keyed by that entity, because it has
    neither of the other two and would otherwise be in no group at all: the
    room and the labels it draws are the entity's own, and the repaint that
    follows a rename of either reaches only the pages this map holds.
    """
    store = get_store(hass)
    targets: dict[str, set[int]] = {}
    library: dict | None = None
    for page in await store.async_get_pages(device_id):
        if not isinstance(page, dict):
            continue
        template = page.get("template")
        if not isinstance(template, dict):
            continue
        named = _names_device(page.get("title"))
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
        target = template.get("target") if isinstance(template, dict) else None
        if not isinstance(target, dict):
            continue
        page_id = page.get("id", 1)
        key = (
            target.get("config_entry")
            or target.get("device")
            or target.get("entity_id")
        )
        if key:
            targets.setdefault(key, set()).add(page_id)
        if target.get("config_entry"):
            bridge = template_target_device(hass, template)
            if bridge is not None:
                targets.setdefault(bridge.id, set()).add(page_id)
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
    # Set by the cleanup: a refresh still reading the store when the entry
    # unloads must not subscribe afterwards, with nothing left to unsubscribe.
    closed = [False]

    log = device_logger(_LOGGER, entry)

    async def _refresh_watched() -> None:
        uses.clear()
        title_targets.clear()
        hub_titles.clear()
        # Resolved on every refresh: on a first boot the device may only be
        # registered after this listener was set up.
        try:
            device_id = resolve_device_id(hass, entry.entry_id)
            if device_id:
                uses.update(await async_variable_uses(hass, device_id, entry))
                title_targets.update(await async_device_title_targets(hass, device_id))
            for key in title_targets:
                hub = hass.config_entries.async_get_entry(key)
                if hub is not None:
                    hub_titles[key] = hub.title
        except Exception as err:  # noqa: BLE001 - live values must never break setup
            log.debug("Variable listener: cannot read pages: %s", err)
        if closed[0]:
            return
        log.debug("Variable listener: watching %s", sorted(uses))
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
        if use is None:
            return
        if not variable_value_changed(
            event.data.get("old_state"), event.data.get("new_state"), use.reads,
        ):
            return
        _queue(use.pages)

    def _hub_pages(device: dr.DeviceEntry | None = None) -> set[int]:
        """Hub pages whose bridge *device* may have changed; all of them if none."""
        entries = set(hub_titles)
        if device is not None:
            entries &= set(device.config_entries) | {
                getattr(device, "primary_config_entry", None),
            }
        return {page for entry in entries for page in title_targets.get(entry, ())}

    @callback
    def _on_device_changed(event: Event) -> None:
        device_id = event.data.get("device_id")
        action = event.data.get("action")
        changes = event.data.get("changes") or {}
        # Every fact a page can draw off the device, not the name alone: a
        # firmware update moves `${_device.sw_version}` and the page should
        # say so without waiting for a reload.
        pages = title_targets.get(device_id)
        if pages and action == "update" and changes.keys() & _DEVICE_FACT_FIELDS:
            _queue(pages)
            # No return: one update can carry a fact and the topology both --
            # a device renamed as it is re-parented changes `name` and
            # `via_device_id` together. Returning here would repaint the page
            # and leave the mapping pointing at the bridge that was, so the
            # next rename of the real one would go nowhere.
        if action == "remove":
            # The gone device cannot be read, and its leaving may hand the
            # entry to a bridge that was one root among several.
            stale = _hub_pages()
        elif action == "create":
            device = dr.async_get(hass).async_get(device_id)
            stale = _hub_pages(device) if device is not None else set()
        elif changes.keys() & _BRIDGE_FIELDS:
            # Not filtered by the device, as a creation is. A membership it
            # has just left is no longer among the ones it holds, so asking
            # which hubs it belongs to now would skip the very hub it left --
            # the one page that must go looking for its bridge again.
            stale = _hub_pages()
        else:
            return
        if stale:
            # The repaint reads the bridge afresh, so it needs no help; the
            # mapping is what has gone stale. Which device answers for a hub
            # is resolved once and then watched by its registry id, so a
            # bridge that is replaced leaves the old id listening and the new
            # one unheard. Ask again, or the next rename goes nowhere.
            _queue(stale)
            entry.async_create_background_task(
                hass, _refresh_watched(), "lizaip variable listener refresh",
            )

    def _repaint_every_titled_page() -> None:
        # Neither the area nor the label registry says in its event which
        # device was affected, and what a page draws from them is read afresh
        # on every repaint, so there is no mapping to rebuild -- only the
        # repaint is owed, by every page that names a device.
        pages = {page for group in title_targets.values() for page in group}
        if pages:
            _queue(pages)

    @callback
    def _on_named_registry_changed(_event: Event) -> None:
        # The area and the label registry are watched for the same reason and
        # answered the same way, so they share one listener rather than two
        # that would have to be kept saying the same thing.
        _repaint_every_titled_page()

    @callback
    def _on_entity_changed(event: Event) -> None:
        # An entity can be filed under a room of its own, and labelled on its
        # own -- and a KNX light set up in YAML has no device, so its own are
        # the only ones it has. Nothing else reports either moving.
        if event.data.get("action") != "update":
            return
        if not _ENTITY_OWN_FIELDS & set(event.data.get("changes") or {}):
            return
        use = uses.get(event.data.get("entity_id"))
        if use is not None:
            _queue(use.pages)

    @callback
    def _on_hub_changed(change: ConfigEntryChange, hub: ConfigEntry) -> None:
        pages = title_targets.get(hub.entry_id)
        if not pages or change is not ConfigEntryChange.UPDATED:
            return
        if hub_titles.get(hub.entry_id) != hub.title:
            hub_titles[hub.entry_id] = hub.title
            _queue(pages)

    async def _on_config_changed(event: Event) -> None:
        if event.data.get("entry_id") != entry.entry_id:
            return
        if event.data.get("order_only"):
            # The same pages with the same content, in a new order: no use
            # moved, and no sync follows to send what is still pending.
            return
        # The config sync that the same event starts rebuilds every page,
        # so a refresh still waiting would only repeat it.
        pending.clear()
        await _refresh_watched()

    await _refresh_watched()
    unsubs = [
        hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed),
        hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, _on_device_changed),
        hass.bus.async_listen(ar.EVENT_AREA_REGISTRY_UPDATED, _on_named_registry_changed),
        hass.bus.async_listen(lr.EVENT_LABEL_REGISTRY_UPDATED, _on_named_registry_changed),
        hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, _on_entity_changed),
        async_dispatcher_connect(hass, SIGNAL_CONFIG_ENTRY_CHANGED, _on_hub_changed),
    ]

    def _cleanup() -> None:
        closed[0] = True
        stop_tracking[0]()
        stop_tracking[0] = lambda: None
        for unsub in unsubs:
            unsub()
        if timer[0] is not None:
            timer[0].cancel()
            timer[0] = None
        pending.clear()
        uses.clear()

    return _cleanup
