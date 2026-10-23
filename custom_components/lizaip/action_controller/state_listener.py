"""Watching entity states and pushing icon updates to the device."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.helpers.event import async_track_state_change_event

from .. import optimistic
from ..config.text_style import toggle_enabled
from ..const import SIGNAL_ICON_UPDATE, SIGNAL_PREDICTED_UPDATE
from ..shared.services import catchall_state_icon
from ..shared.logs import device_logger
from ..shared.tokens import page_scope, resolve_image_tokens
from ..shared.icon_urls import resolve_icon_url
from ..state_icon import (
    icon_style_for_entities,
    is_styleable,
    read_icon_style_options,
)
from ._state import (
    _DEFAULT_PAGE_ID,
    _STATE_DEBOUNCE_SECONDS,
    _STATE_MAX_WAIT_SECONDS,
)
from .helpers import (
    _get_assignments,
    _get_store,
    _noop,
    _resolve_device_id,
    resolve_target_entities,
)
from .icons import _compute_next_state_tooltip, _match_state_icon, toggle_icon
from .toggle import runtime_assign, toggle_rules

_LOGGER = logging.getLogger(__name__)

# One button, with everything about it that a flush would otherwise have to
# recompute per state event: which page it sits on, the assignment as it will
# actually run, and the entities that can move it.
_IndexedButton = tuple[int, str, Any, str, dict, str, set[str]]


async def _index_buttons_by_entity(
    hass: HomeAssistant,
    store: Any,
    device_id: str,
    pages: list[dict],
    lib_by_id: dict[str, dict],
    toggles: bool,
) -> dict[str, list[_IndexedButton]]:
    """Map each watched entity to the buttons a change to it can repaint.

    Built once per flush and thrown away after, which is what makes it safe:
    every input (the page list, the assignments, the toggle setting, the
    target resolution) is read under the flush lock and cannot change while
    the flush runs. Without it the flush walked entities x actions x pages and
    asked the store for a page's assignments inside that walk, so a remote
    with a full action library paid thousands of store reads and target
    resolutions for a single light turning on.

    Buttons whose action is not in the library are dropped here rather than
    skipped in the loop: the library is what supplies the glyph, so there is
    nothing to paint without it.
    """
    index: dict[str, list[_IndexedButton]] = {}
    for page in pages:
        if not isinstance(page, dict):
            continue
        pid = page.get("id", _DEFAULT_PAGE_ID)
        page_color = page.get("default_color", "")
        template = page.get("template")
        # `${_device}` in a target resolves against the page it sits on, so the
        # scope has to be open while the targets are worked out, exactly as it
        # was when this happened inside the flush loop.
        with page_scope(template):
            for btn_key, assign in await _get_assignments(hass, device_id, pid):
                action_id = assign.get("action_id")
                if not action_id or action_id not in lib_by_id:
                    continue
                assign = runtime_assign(assign, toggles)
                config = assign.get("config", [])
                step = config[0] if isinstance(config, list) and config else {}
                targets = resolve_target_entities(step, hass)
                entry: _IndexedButton = (
                    pid, page_color, template, btn_key, assign, action_id, targets,
                )
                for eid in targets:
                    index.setdefault(eid, []).append(entry)
    return index


# ---------------------------------------------------------------------------
# State listener — tracks entity changes → sends icon updates
# ---------------------------------------------------------------------------

async def setup_state_listener(
    hass: HomeAssistant, entry: ConfigEntry,
) -> Callable[[], None]:
    """Watch entities used in button assignments; send icon updates when they change.

    Returns a cleanup callable.
    """
    log = device_logger(_LOGGER, entry)
    device_id = _resolve_device_id(hass, entry.entry_id)
    if not device_id:
        return _noop

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)

    watched_entities: set[str] = set()
    for page in pages:
        page_id = page.get("id", _DEFAULT_PAGE_ID)
        for _btn, assign in await _get_assignments(hass, device_id, page_id):
            config = assign.get("config", [])
            step = config[0] if isinstance(config, list) and config else {}
            watched_entities.update(resolve_target_entities(step, hass))
            # A cycle rule may point at a different entity from the assignment
            # it sits on, and its label reads that one. Unwatched, the tooltip
            # would be computed once and never repainted.
            for rule in toggle_rules(assign):
                rule_config = rule.get("config")
                if isinstance(rule_config, list) and rule_config:
                    watched_entities.update(
                        resolve_target_entities(rule_config[0], hass),
                    )

    if not watched_entities:
        log.debug("State listener: nothing to watch")
        return _noop

    log.debug("State listener: watching %d entities", len(watched_entities))

    dirty: set[str] = set()
    timer_handle: list[asyncio.TimerHandle | None] = [None]
    last_sent: dict[tuple[int, str], tuple[str, str | None]] = {}
    # -inf, not 0: `time.monotonic()` has an arbitrary origin, so "never
    # flushed" has to be a value no elapsed-time comparison can mistake for
    # "just did". Monotonic rather than `hass.loop.time()` because this only
    # ever measures an interval, and a plain clock is one less thing for a test
    # double to have to imitate.
    last_flush: list[float] = [float("-inf")]
    # One flush at a time. Without it a second flush can start while the first
    # is still reading pages and resolving icons, letting a stale update
    # overtake a newer one on the wire.
    flush_lock = asyncio.Lock()
    # The in-flight flush task, so unload can cancel it instead of letting it
    # keep touching `store` and `entry` after the listener is gone.
    # Flushes serialise on `flush_lock`, so a second can be created and queued
    # while the first is still running. Holding only the newest would leave the
    # older one to go on touching `store` and `entry` after unload cancelled
    # the handle it was not in.
    flush_tasks: set[asyncio.Task] = set()

    @callback
    def _flush():
        timer_handle[0] = None
        last_flush[0] = time.monotonic()
        entities = list(dirty)
        dirty.clear()
        if not entities:
            return
        task = hass.async_create_task(_async_flush(entities))
        flush_tasks.add(task)
        task.add_done_callback(flush_tasks.discard)

    async def _async_flush(entities: list[str]):
        async with flush_lock:
            await _async_flush_locked(entities)

    async def _async_flush_locked(entities: list[str]):
        # Inline: button_rendering -> action_controller -> this module, so a
        # top-level import re-enters a half-built package (and `lizaip.reload`
        # re-executes both in its own order). Reusing the full sync's resolver
        # is what keeps the live push and the sync agreeing on the glyph.
        from ..config.button_rendering import _get_service_icons, _resolve_button_icon

        current_lib = await store.async_get_action_library(device_id)
        current_pages = await store.async_get_pages(device_id)
        # Lazy, at most once per flush: only the one-way branch needs it, and it
        # is the expensive part of this function.
        service_icons: dict | None = None

        updates = []
        # Resolved once per flush, not per button: it cannot change mid-flush,
        # and `device_sync` hoists the identical call for the same reason.
        style_options = read_icon_style_options(getattr(entry, "options", None))
        # Read once per flush for the same reason as the options above: the
        # remote's settings cannot change mid-flush, and the per-button filter
        # below must not ask the store once per button.
        toggles = toggle_enabled(await store.async_get_settings(device_id))
        # Library entries are user/panel-authored; every other consumer
        # (device_sync, websocket) guards for a missing "id". A bare subscript
        # anywhere below would abort the whole flush and silently stop icon
        # updates for the device.
        lib_by_id = {
            action["id"]: action
            for action in current_lib
            if isinstance(action, dict) and action.get("id")
        }
        # Built once per flush, keyed by the entity that can move it, so an
        # event costs a dict lookup instead of a walk over every action x page
        # x button. Everything folded in here is flush-stable for the same
        # reason the options and toggles above are: the store cannot change
        # while the flush lock is held. The store reads in particular used to
        # happen once per (entity, action, page) -- thousands of them on a
        # remote with a full library.
        buttons_by_entity = await _index_buttons_by_entity(
            hass, store, device_id, current_pages, lib_by_id, toggles,
        )
        for eid in entities:
            state = hass.states.get(eid)
            if not state:
                continue
            # Memoised across the buttons this entity moves: one action
            # commonly backs several of them, and the match only depends on
            # the action and the state.
            state_icon_cache: dict[str, str | None] = {}
            for pid, page_color, template, btn_key, assign, action_id, targets in (
                buttons_by_entity.get(eid, ())
            ):
                action = lib_by_id[action_id]
                if action_id in state_icon_cache:
                    action_icon = state_icon_cache[action_id]
                else:
                    action_icon = _match_state_icon(action, state)
                    state_icon_cache[action_id] = action_icon
                # No early-out on a missing `action_icon` here. A one-way
                # service (light.turn_on / turn_off) has a fixed glyph, so
                # `_match_state_icon` returns None, and so does a toggle's
                # derived action -- yet both can still need a repaint, one for
                # its tint and one for its next rule. Neither is knowable until
                # the button is in hand, so the decision is taken below.
                # `${_device}` in a tile or tooltip is this page's device.
                with page_scope(template):
                    # A toggle rule outranks every other source: it is
                    # the only one that knows the button is about to do
                    # something other than its declared action, so letting
                    # state_icons win would paint a lie. Rule icons are
                    # optional, so None falls through to the usual ladder.
                    rule_glyph = toggle_icon(
                        assign, state, entry.entry_id, pid, btn_key,
                        eid.split(".")[0], hass=hass,
                    )
                    tooltip: str | None
                    # A label with a placeholder reads the entity, so
                    # it must be recomputed whenever that entity moves,
                    # even when the glyph never changes.
                    dynamic_label = "${" in str(assign.get("label") or "")
                    if rule_glyph or action_icon:
                        state_icons = assign.get("state_icons") or {}
                        override = state_icons.get(state.state) or catchall_state_icon(
                            state_icons,
                            eid.split(".")[0],
                            state.state,
                            action.get("service", ""),
                        )
                        # A rule glyph outranks the rest and arrives
                        # already resolved from `toggle_icon`. The other
                        # two read their variables as the sync reads them;
                        # one with no value falls back to the action's own
                        # icon.
                        icon = (
                            rule_glyph
                            or resolve_image_tokens(override, hass)
                            or resolve_image_tokens(action_icon, hass)
                        )
                        if not icon:
                            continue
                        tooltip = _compute_next_state_tooltip(
                            action, assign, state, hass, entry,
                        )
                    elif is_styleable(eid) or dynamic_label:
                        # Colour-only: resolve the glyph through the *same*
                        # function the sync used, so a recolour cannot
                        # become a redraw.
                        if service_icons is None:
                            service_icons = await _get_service_icons(hass)
                        icon = _resolve_button_icon(
                            action, assign, hass, service_icons,
                        )
                        if not icon:
                            continue
                        # Absent for a pure recolour, so the device
                        # keeps the label the sync gave it. Present
                        # when the label itself reads the entity.
                        tooltip = _compute_next_state_tooltip(
                            action, assign, state, hass, entry,
                        ) if dynamic_label else None
                    else:
                        # Nothing to say: no rule, no state glyph, no
                        # tint this entity could carry, and a label that
                        # reads nothing from it.
                        continue
                    # Only the tile is styled; the tooltip keeps the page
                    # colour, as a tinted label is only harder to read.
                    # Resolved from the whole target, not from `state`: an
                    # area- or device-targeted button has several entities,
                    # and taking the style of whichever one happened to
                    # change lets an off lamp wipe a lit one's, with the
                    # winner decided by set-iteration order.
                    tile_style = icon_style_for_entities(
                        hass, targets, page_color, step=style_options.step,
                        fill=style_options.fill, tint=style_options.tint,
                    )
                    resolved = resolve_icon_url(
                        icon,
                        color=tile_style.color,
                        percent=tile_style.percent,
                    )
                    updates.append({
                        "page_id": pid,
                        "button_key": btn_key,
                        "icon": resolved,
                        "tooltip": tooltip,
                        "page_color": page_color,
                    })

        if not updates:
            return

        by_key = {(u["page_id"], u["button_key"]): u for u in updates}
        changed = []
        for key, upd in by_key.items():
            previous = last_sent.get(key)
            current = (upd["icon"], upd.get("tooltip"))
            if previous == current:
                continue
            last_sent[key] = current
            # The device fetches every field it is handed, so repeating a
            # tooltip that did not change buys a second image request per
            # button and per page. A brightness ramp only ever moves the tile,
            # and one lamp can occupy a button on several pages, so that is the
            # difference between one fetch and six for a single dimmer step --
            # on a device that already takes up to a second to acknowledge a
            # set_page. Omitting the key is how the consumer is told to keep
            # the tooltip it has; `last_sent` still records the real value, so
            # a later genuine change is still detected.
            if previous is not None and previous[1] == current[1]:
                upd = {**upd, "tooltip": None}
            changed.append(upd)
        if not changed:
            return

        async_dispatcher_send(hass, SIGNAL_ICON_UPDATE.format(device_id), changed)

    @callback
    def _mark_dirty(eid: str) -> None:
        dirty.add(eid)

        if timer_handle[0] is not None:
            timer_handle[0].cancel()
            timer_handle[0] = None

        elapsed = time.monotonic() - last_flush[0]
        # Leading edge. A change arriving after a quiet spell is the one the
        # user is waiting to see -- a lamp switched on, a scene recalled -- and
        # making it wait out a debounce is pure latency: there is no burst to
        # coalesce yet. `last_sent` already drops flushes that change nothing,
        # so flushing eagerly costs a push only when there is news.
        if elapsed >= _STATE_MAX_WAIT_SECONDS:
            _flush()
            return

        # Mid-burst. Still coalesce, but clamp the wait to what is left of the
        # max so a held dimmer keeps updating instead of restarting the timer
        # forever. See `_STATE_MAX_WAIT_SECONDS`.
        delay = min(
            _STATE_DEBOUNCE_SECONDS, max(0.0, _STATE_MAX_WAIT_SECONDS - elapsed),
        )
        timer_handle[0] = hass.loop.call_later(delay, _flush)

    @callback
    def _on_state_change(event: Event) -> None:
        eid = event.data["entity_id"]
        # A real update is the authority, so let it retire any prediction it
        # agrees with before the flush reads the entity back. `settle` keeps a
        # prediction the lamp has not reached yet, which is what stops a
        # mid-ramp report from yanking the tile back down.
        optimistic.settle(hass.states.get(eid))
        _mark_dirty(eid)

    @callback
    def _on_predicted(eid: str) -> None:
        # Through the same throttle as a real change, so a drag cannot outrun
        # the device.
        if eid in watched_entities:
            _mark_dirty(eid)

    unsubs = [
        async_track_state_change_event(hass, watched_entities, _on_state_change),
        async_dispatcher_connect(hass, SIGNAL_PREDICTED_UPDATE, _on_predicted),
    ]

    def _cleanup():
        for unsub in unsubs:
            unsub()
        if timer_handle[0] is not None:
            timer_handle[0].cancel()
        # A flush started moments before unload would otherwise go on reading
        # the store and pushing to a device this entry no longer owns. Every
        # in-flight flush is cancelled, not just the most recent.
        for task in list(flush_tasks):
            if not task.done():
                task.cancel()
        flush_tasks.clear()
        dirty.clear()
        # Predictions deliberately survive this. They are module-level and keyed
        # by entity alone, while this runs once per config entry: two remotes
        # watching one lamp would have the first unload drop the second's live
        # prediction and cancel its expiry, leaving its tile on a guess nothing
        # would correct. Settlement and the TTL own that lifecycle instead, and
        # the TTL is short enough that a reload cannot inherit a stale guess.

    return _cleanup
