"""Watching entity states and pushing icon updates to the device."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback

from ..const import ICON_UPDATE_EVENT, catchall_state_icon, resolve_icon_url
from ._state import _DEFAULT_PAGE_ID, _STATE_DEBOUNCE_SECONDS
from .helpers import (
    _get_assignments,
    _get_store,
    _noop,
    _resolve_device_id,
    resolve_target_entities,
)
from .icons import _compute_next_state_tooltip, _match_state_icon

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# State listener — tracks entity changes → fires icon update events
# ---------------------------------------------------------------------------

async def setup_state_listener(
    hass: HomeAssistant, entry: ConfigEntry,
) -> Callable[[], None]:
    """Watch entities used in button assignments; fire icon-update events on change.

    Returns a cleanup callable.
    """
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

    if not watched_entities:
        _LOGGER.debug("State listener: nothing to watch")
        return _noop

    _LOGGER.debug("State listener: watching %d entities", len(watched_entities))

    dirty: set[str] = set()
    timer_handle: list[asyncio.TimerHandle | None] = [None]
    last_sent: dict[tuple[int, str], tuple[str, str | None]] = {}

    @callback
    def _flush():
        timer_handle[0] = None
        entities = list(dirty)
        dirty.clear()
        hass.async_create_task(_async_flush(entities))

    async def _async_flush(entities: list[str]):
        current_lib = await store.async_get_action_library(device_id)
        current_pages = await store.async_get_pages(device_id)

        updates = []
        for eid in entities:
            state = hass.states.get(eid)
            if not state:
                continue
            for action in current_lib:
                # Library entries are user/panel-authored; every other consumer
                # (device_sync, websocket) guards for a missing "id". A bare
                # subscript here would abort the whole flush and silently stop
                # icon updates for the device.
                action_id = action.get("id")
                if not action_id:
                    continue
                action_icon = _match_state_icon(action, state)
                if not action_icon:
                    continue
                for page in current_pages:
                    pid = page.get("id", _DEFAULT_PAGE_ID)
                    page_color = page.get("default_color", "")
                    for btn_key, assign in await _get_assignments(hass, device_id, pid):
                        if assign.get("action_id") != action_id:
                            continue
                        config = assign.get("config", [])
                        step = config[0] if isinstance(config, list) and config else {}
                        if eid not in resolve_target_entities(step, hass):
                            continue
                        state_icons = assign.get("state_icons") or {}
                        override = state_icons.get(state.state) or catchall_state_icon(
                            state_icons,
                            eid.split(".")[0],
                            state.state,
                            action.get("service", ""),
                        )
                        icon = override if override else action_icon
                        resolved = resolve_icon_url(icon, color=page_color)
                        tooltip = _compute_next_state_tooltip(action, assign, state, hass, entry)
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
        changed = [
            u for u in by_key.values()
            if last_sent.get((u["page_id"], u["button_key"])) != (u["icon"], u.get("tooltip"))
        ]
        if not changed:
            return

        for u in changed:
            last_sent[(u["page_id"], u["button_key"])] = (u["icon"], u.get("tooltip"))

        hass.bus.async_fire(ICON_UPDATE_EVENT, {
            "device_id": device_id,
            "updates": changed,
        })

    @callback
    def _on_state_change(event: Event):
        eid = event.data.get("entity_id")
        if eid not in watched_entities:
            return
        dirty.add(eid)
        if timer_handle[0] is not None:
            timer_handle[0].cancel()
        timer_handle[0] = hass.loop.call_later(_STATE_DEBOUNCE_SECONDS, _flush)

    unsub = hass.bus.async_listen(EVENT_STATE_CHANGED, _on_state_change)

    def _cleanup():
        unsub()
        if timer_handle[0] is not None:
            timer_handle[0].cancel()
        dirty.clear()

    return _cleanup
