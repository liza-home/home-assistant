"""Watching entity states and pushing icon updates to the device."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback

from .. import optimistic
from ..const import (
    ICON_UPDATE_EVENT,
    PREDICTED_UPDATE_EVENT,
    catchall_state_icon,
    resolve_icon_url,
    resolve_image_tokens,
)
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
from .toggle import runtime_assign
from ..config.text_style import toggle_enabled

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
    # -inf, not 0: `time.monotonic()` has an arbitrary origin, so "never
    # flushed" has to be a value no elapsed-time comparison can mistake for
    # "just did". Monotonic rather than `hass.loop.time()` because this only
    # ever measures an interval, and a plain clock is one less thing for a test
    # double to have to imitate.
    last_flush: list[float] = [float("-inf")]

    @callback
    def _flush():
        timer_handle[0] = None
        last_flush[0] = time.monotonic()
        entities = list(dirty)
        dirty.clear()
        if not entities:
            return
        hass.async_create_task(_async_flush(entities))

    async def _async_flush(entities: list[str]):
        # Inline: device_sync -> action_controller -> this module, so a top-level
        # import re-enters a half-built package (and `lizaip.reload` re-executes
        # both in its own order). Reusing its resolver is what keeps the live
        # push and the full sync agreeing on the glyph by construction.
        from ..config.device_sync import _get_service_icons, _resolve_button_icon

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
                # No early-out on a missing `action_icon` here. A one-way
                # service (light.turn_on / turn_off) has a fixed glyph, so
                # `_match_state_icon` returns None, and so does a toggle's
                # derived action -- yet both can still need a repaint, one for
                # its tint and one for its next rule. Neither is knowable until
                # the button is in hand, so the decision moved into the button
                # loop below.
                for page in current_pages:
                    pid = page.get("id", _DEFAULT_PAGE_ID)
                    page_color = page.get("default_color", "")
                    for btn_key, assign in await _get_assignments(hass, device_id, pid):
                        if assign.get("action_id") != action_id:
                            continue
                        assign = runtime_assign(assign, toggles)
                        config = assign.get("config", [])
                        step = config[0] if isinstance(config, list) and config else {}
                        targets = resolve_target_entities(step, hass)
                        if eid not in targets:
                            continue
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
                        elif is_styleable(eid):
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
                            # Absent, so the consumer omits img_tooltip and the
                            # device keeps the label the sync gave it.
                            tooltip = None
                        else:
                            # Nothing to say: no rule, no state glyph, and no
                            # tint this entity could carry.
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

        hass.bus.async_fire(ICON_UPDATE_EVENT, {
            "device_id": device_id,
            "updates": changed,
        })

    @callback
    def _on_state_change(event: Event):
        eid = event.data.get("entity_id")
        if eid not in watched_entities:
            return
        # A real update is the authority, so let it retire any prediction it
        # agrees with before the flush reads the entity back. `settle` keeps a
        # prediction the lamp has not reached yet, which is what stops a
        # mid-ramp report from yanking the tile back down.
        if event.event_type != PREDICTED_UPDATE_EVENT:
            optimistic.settle(hass.states.get(eid))
        dirty.add(eid)

        if timer_handle[0] is not None:
            timer_handle[0].cancel()
            timer_handle[0] = None

        elapsed = time.monotonic() - last_flush[0]
        # Leading edge. A change arriving after a quiet spell is the one the
        # user is waiting to see -- a lamp switched on, a scene recalled -- and
        # making it wait out a debounce is pure latency: there is no burst to
        # coalesce yet. `last_sent` already drops flushes that change nothing,
        # so firing eagerly costs an event only when there is news.
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

    unsub = hass.bus.async_listen(EVENT_STATE_CHANGED, _on_state_change)
    # The same handler, so a prediction is coalesced by the same throttle as a
    # real change -- a drag must not be able to outrun the device.
    unsub_predicted = hass.bus.async_listen(PREDICTED_UPDATE_EVENT, _on_state_change)

    def _cleanup():
        unsub()
        unsub_predicted()
        if timer_handle[0] is not None:
            timer_handle[0].cancel()
        dirty.clear()
        # Predictions deliberately survive this. They are module-level and keyed
        # by entity alone, while this runs once per config entry: two remotes
        # watching one lamp would have the first unload drop the second's live
        # prediction and cancel its expiry, leaving its tile on a guess nothing
        # would correct. Settlement and the TTL own that lifecycle instead, and
        # the TTL is short enough that a reload cannot inherit a stale guess.

    return _cleanup
