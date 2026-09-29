"""Executing a slider gesture against whatever it resolves to."""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass

from homeassistant.core import HomeAssistant

from ..slider_throttle import has_moved, read_cooldown_seconds
from ._state import (
    _DEFAULT_PAGE_ID,
    _live_touch,
    _slider_gesture_active,
    _slider_touch_state,
    get_selected_control,
    get_selected_entity,
    get_selected_factor,
)
from .helpers import _get_store, _resolve_device_id, split_service
from .sliders import (
    SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY,
    _effective_target,
    last_touched_slider_actions,
    resolve_control,
    slider_follows,
)

_LOGGER = logging.getLogger(__name__)

#: Sensitivity bounds for the drag factor. The panel advertises them on its
#: number input, but those attributes only feed form validity — and layout YAML
#: reaches the executor without any sanitising — so they are enforced here too.
#: A factor of 0 makes every delta zero; a negative one inverts the drag.
SLIDER_FACTOR_MIN = 0.1
SLIDER_FACTOR_MAX = 5.0

#: Canonical slider phases. Firmware and the virtual remote still speak the
#: button vocabulary, so those names are translated in `_gesture_for`.
_TOUCH_START = "touch_start"
_SLIDE = "slide"
_TOUCH_END = "touch_end"
_TOUCH_CANCEL = "touch_cancel"


def _min_interval_for(hass: HomeAssistant, entry_id: str) -> float:
    """This entry's minimum gap between two slide updates, in seconds.

    Read per event because the option can change between drags. The interval
    is enforced inline rather than by a `Debouncer`: every phase of a drag is
    computed *in* the gesture, so a detached timer callback would put the
    trailing call in a race with the lift.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    return read_cooldown_seconds(entry.options if entry is not None else None)


def _slider_num(
    slider_cfg: dict,
    key: str,
    default: float,
    lo: float | None = None,
    hi: float | None = None,
) -> float:
    """Read a numeric slider setting, falling back to `default` if unusable.

    Layout YAML is user-editable and reaches here unsanitised, so a typo must
    not raise once per event of a drag. NaN and ±inf are treated as unusable
    rather than clamped: YAML parses both, and every NaN comparison is False,
    so they would slip through a naive bounds check.
    """
    raw = slider_cfg.get(key, default)
    try:
        val = float(raw)
    except (TypeError, ValueError):
        _LOGGER.warning(
            "Slider config: %r is not a valid number for '%s' — falling back to %s",
            raw, key, default,
        )
        return default

    if not math.isfinite(val):
        _LOGGER.warning(
            "Slider config: %r is not a finite number for '%s' — falling back to %s",
            raw, key, default,
        )
        return default

    if lo is not None and val < lo:
        _LOGGER.warning(
            "Slider config: '%s' of %s is below the minimum of %s — clamping",
            key, val, lo,
        )
        return lo
    if hi is not None and val > hi:
        _LOGGER.warning(
            "Slider config: '%s' of %s is above the maximum of %s — clamping",
            key, val, hi,
        )
        return hi
    return val


@dataclass(frozen=True)
class _Mechanics:
    """What a resolved slider config drives, and how far.

    Built once per event from an already-resolved config, so nothing downstream
    re-reads the raw dict or re-derives a range.
    """

    target_entity: str
    attribute: str
    service: str
    data_key: str
    factor: float
    val_min: float
    val_max: float

    @classmethod
    def from_config(cls, slider_cfg: dict) -> "_Mechanics":
        attribute = slider_cfg.get("attribute", "volume_level")
        return cls(
            target_entity=slider_cfg.get("target_entity", ""),
            attribute=attribute,
            service=slider_cfg.get("service", "media_player.volume_set"),
            data_key=slider_cfg.get("data_key", attribute),
            factor=_slider_num(
                slider_cfg, "factor", 1.0, SLIDER_FACTOR_MIN, SLIDER_FACTOR_MAX,
            ),
            val_min=_slider_num(slider_cfg, "min", 0.0),
            val_max=_slider_num(slider_cfg, "max", 1.0),
        )

    def has_usable_range(self, slider_key: str) -> bool:
        """Whether the range is orderable; warns and returns False when not.

        An inverted range would collapse the clamp to a constant and reverse
        the drag direction, leaving a slider that looks functional.
        """
        if self.val_max > self.val_min:
            return True
        _LOGGER.warning(
            "Slider %s: max (%s) must be greater than min (%s) — ignoring event",
            slider_key, self.val_max, self.val_min,
        )
        return False

    def value_at(self, base_value: float, travelled: float) -> float:
        """The value `travelled` (in normalized track units) away from `base_value`."""
        delta = travelled * self.factor * (self.val_max - self.val_min)
        return max(self.val_min, min(self.val_max, base_value + delta))

    async def write(self, hass: HomeAssistant, value: float) -> None:
        """Call the configured service with `value`."""
        domain, svc = split_service(self.service)
        await hass.services.async_call(
            domain, svc, {"entity_id": self.target_entity, self.data_key: round(value, 3)},
        )


def _resolve_selected_control(
    hass: HomeAssistant, entry_id: str, slider_key: str,
) -> dict | None:
    """The mechanics of the currently selected device, or None.

    The auto-derive step, and where a button's own declared control is honoured
    — a lamp asking for colour temperature rather than brightness. Whether the
    entity really supports it is `resolve_control`'s decision, made against live
    state, and it always returns one whole row of `SLIDER_CONTROLS`, so a caller
    can never merge a partial blob over something else.
    """
    entity_id = get_selected_entity(entry_id)
    if not entity_id:
        return None
    resolved = resolve_control(hass, entity_id, get_selected_control(entry_id))
    if not resolved:
        return None
    _LOGGER.debug(
        "Slider %s: driving %s → %s", slider_key, entity_id, resolved["control"],
    )
    return resolved


def _resolve_selection_config(
    hass: HomeAssistant, entry_id: str, slider_cfg: dict, slider_key: str,
) -> dict | None:
    """Turn a selection-following target into concrete mechanics, or None.

    Resolved at gesture time, not at config time: the target does not exist
    until the user touches a button, and the entity's live state decides both
    which control to drive and over what range.

    Two sources, in order, and exactly one wins outright — they are never
    blended, because service, data key and range only describe one device
    *together*. **The selection branch reads nothing out of `slider_cfg` but
    `factor`**, which is not a device mechanic but the length of the physical
    track, so it survives every retarget. Reading anything else from it writes
    one device's range onto another's.

    None means the caller must not start a gesture at all; storing no state is
    what makes a failed start self-healing.
    """
    resolved = _resolve_selected_control(hass, entry_id, slider_key)
    if resolved:
        override = get_selected_factor(entry_id)
        return {
            **resolved,
            "factor": override if override is not None else slider_cfg.get("factor", 1.0),
        }

    # `_effective_target`, not `targets_last_touched_or_entity`: a bare
    # proportional slider naming an entity resolves here too, and its stored
    # blob is a complete pinned config for the same reason.
    if _effective_target(slider_cfg) == SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY:
        # Whole and unmodified — it already *is* a complete pinned config.
        # `target` goes because from here on this is an ordinary drag.
        default = {k: v for k, v in slider_cfg.items() if k != "target"}
        _LOGGER.debug(
            "Slider %s: nothing selected — falling back to the page default %s",
            slider_key, default.get("target_entity"),
        )
        return default

    _LOGGER.debug(
        "Slider %s: nothing touched yet, so nothing to drive (selection=%s)",
        slider_key, get_selected_entity(entry_id),
    )
    return None


def _read_base_value(
    hass: HomeAssistant,
    slider_key: str,
    target_entity: str,
    attribute: str,
    val_min: float,
) -> float | None:
    """The value a gesture should start from, or None if it can't be read.

    None (rather than a default) keeps the caller's "bail without storing
    state" behaviour, so the next touch is re-read as a fresh start rather than
    as a slide against a bogus origin.
    """
    entity_state = hass.states.get(target_entity)
    if not entity_state:
        _LOGGER.warning("Slider target %s not found", target_entity)
        return None

    current_val = entity_state.attributes.get(attribute)
    if current_val is not None:
        try:
            return float(current_val)
        except (ValueError, TypeError):
            _LOGGER.warning("Cannot parse %s.%s=%s", target_entity, attribute, current_val)
            return None

    # Some entities carry the value as the state itself.
    try:
        return float(entity_state.state)
    except (ValueError, TypeError):
        pass

    # HA drops `brightness` while a light is off. Start from the bottom of the
    # range so dragging up switches it on rather than doing nothing.
    if entity_state.state in ("off", "unavailable", "unknown", "idle"):
        _LOGGER.debug(
            "Slider %s: %s is '%s' and has no '%s' — basing at min (%.3f)",
            slider_key, target_entity, entity_state.state, attribute, val_min,
        )
        return val_min

    _LOGGER.warning("Cannot read %s.%s for slider", target_entity, attribute)
    return None


def _gesture_for(interaction: str, state_key: tuple[str, str]) -> str:
    """Translate a device interaction into a canonical slider phase.

    The device vocabulary is the shipping v1 contract, so it is translated here
    rather than changed on the wire. Canonical names pass straight through.
    """
    if interaction == "touch":
        return _SLIDE if _slider_gesture_active(state_key) else _TOUCH_START
    if interaction in ("click", "release"):
        return _TOUCH_END
    return interaction


async def _load_slider_cfg(
    hass: HomeAssistant, device_id: str, slider_key: str, page_id: int,
) -> tuple[dict | None, bool]:
    """This slider's stored config and whether it follows the selection.

    `follows` is asked once, from the key and the raw assignment, and reused for
    the rest of the event — re-deriving it is how two shipped bugs got in. A
    config of None means there is nothing stored to drive.
    """
    store = _get_store(hass)
    assignments = await store.async_get_assignments(device_id, page_id)
    assign = assignments.get(slider_key)
    if not isinstance(assign, dict):
        assign = {}

    slider_cfg = assign.get("slider_actions")
    follows = slider_follows(slider_key, assign)
    if not isinstance(slider_cfg, dict) or not slider_cfg:
        return (last_touched_slider_actions(1.0) if follows else None), follows
    return slider_cfg, follows


def _pinned_config(
    hass: HomeAssistant,
    entry_id: str,
    state_key: tuple[str, str],
    slider_cfg: dict,
    slider_key: str,
    gesture: str,
) -> dict | None:
    """The mechanics a selection-following gesture is pinned to, or None to bail.

    Resolved once, at `touch_start`, and read back from the gesture afterwards.
    Re-resolving per event would let a button touched mid-drag retarget the
    slider while a delta computed against the previous entity is still in
    flight, so a selection made during a gesture takes effect on the next one.
    """
    if gesture == _TOUCH_START:
        return _resolve_selection_config(hass, entry_id, slider_cfg, slider_key)

    resolved = (_live_touch(state_key) or {}).get("resolved")
    if not resolved:
        # Either no gesture is in flight or its `touch_start` bailed with
        # nothing to drive. Popping matters in the first case: leaving the state
        # would make every later touch read as a slide and bail here again,
        # killing the slider until the staleness cutoff.
        _slider_touch_state.pop(state_key, None)
        _LOGGER.debug(
            "Slider %s: '%s' with no resolved target — ignoring", slider_key, gesture,
        )
    return resolved


def _shape_changed_mid_gesture(state_key: tuple[str, str], follows: bool) -> bool:
    """Whether the stored config changed between following and fixed mid-drag.

    The delta in flight was computed against the old shape's base value and
    would land on the new one's entity. Discarding is the conservative answer:
    the next touch reads as a fresh `touch_start`.
    """
    live = _live_touch(state_key)
    return live is not None and (live.get("resolved") is not None) != follows


def _begin_gesture(
    state_key: tuple[str, str], base_value: float, position: float, pinned_cfg: dict | None,
) -> None:
    """Store the origin a drag is measured from."""
    _slider_touch_state[state_key] = {
        "base_value": base_value,
        "zero_pos": position,
        # What actually reached the entity, so `touch_end` can tell whether it
        # still owes a write.
        "last_pos": position,
        "ts": time.monotonic(),
        # None lets the first movement through without waiting out an interval.
        "last_emit_ts": None,
        # The most recent position the throttle held back. Only read when a
        # release carries no position of its own.
        "pending_pos": None,
        # Selection-following only: the mechanics this gesture is pinned to.
        "resolved": pinned_cfg,
    }


def _throttled(
    hass: HomeAssistant, entry_id: str, touch: dict, position: float, now: float,
) -> bool:
    """Whether this movement should be held back rather than written.

    Two questions in this order: has the slider moved at all, and is it too
    soon after the last update. Order matters — a position identical to the
    last one sent must be dropped however long it has been, or a resting finger
    would still emit once per interval forever.
    """
    min_interval = _min_interval_for(hass, entry_id)
    last_emit_ts = touch.get("last_emit_ts")
    unchanged = not has_moved(position, touch.get("last_pos"))
    too_soon = (
        last_emit_ts is not None
        and min_interval > 0.0
        and (now - last_emit_ts) < min_interval
    )
    return unchanged or too_soon


async def _do_start(
    hass: HomeAssistant,
    state_key: tuple[str, str],
    mech: _Mechanics,
    slider_key: str,
    position: float | None,
    pinned_cfg: dict | None,
) -> None:
    """Pin the zero-point and base value a drag is measured from."""
    if position is None:
        # Pinning a guessed zero-point would make every later slide wrong.
        _LOGGER.warning("Slider %s: touch_start without a position — ignoring", slider_key)
        return
    base_value = _read_base_value(
        hass, slider_key, mech.target_entity, mech.attribute, mech.val_min,
    )
    if base_value is None:
        return
    _begin_gesture(state_key, base_value, position, pinned_cfg)
    _LOGGER.debug(
        "Slider touch_start: %s base=%.3f zero_pos=%.3f", slider_key, base_value, position,
    )


async def _do_slide(
    hass: HomeAssistant,
    entry_id: str,
    state_key: tuple[str, str],
    mech: _Mechanics,
    slider_key: str,
    position: float | None,
) -> None:
    """Write the value the finger has moved to, unless it is being throttled."""
    touch = _live_touch(state_key)
    if not touch:
        return
    if position is None:
        _LOGGER.debug("Slider %s: slide without a position — ignoring", slider_key)
        return

    # Updated unconditionally and up front: it tracks that the finger is still
    # down, not what was written, so a failing call must not let a slow drag
    # hit the staleness cutoff.
    now = time.monotonic()
    touch["ts"] = now

    if _throttled(hass, entry_id, touch, position, now):
        # Remembered, not discarded: if the finger lifts without the device
        # restating the position, this is the only record of where it ended.
        touch["pending_pos"] = position
        return

    await _write(hass, mech, touch, _SLIDE, slider_key, position)
    # Only after the write landed. `last_pos` is the record of what reached the
    # entity, and `touch_end` skips its commit when the final position matches
    # it — advancing it on a failed write would strand the gesture.
    touch["last_pos"] = position
    touch["last_emit_ts"] = now
    touch["pending_pos"] = None


async def _do_end(
    hass: HomeAssistant,
    state_key: tuple[str, str],
    mech: _Mechanics,
    slider_key: str,
    position: float | None,
    interaction: str,
) -> None:
    """Commit whatever the throttle held back, never throttled itself.

    This is the position the user chose. The lift's own wins when it has one;
    falling back to `pending_pos` matters because the tail of a drag may exist
    nowhere else.
    """
    touch = _live_touch(state_key, pop=True)
    final_pos = position if position is not None else (touch or {}).get("pending_pos")
    if touch and final_pos is not None and final_pos != touch.get("last_pos"):
        await _write(hass, mech, touch, _TOUCH_END, slider_key, final_pos)
    _LOGGER.debug("Slider touch_end: %s (from '%s')", slider_key, interaction)


async def _write(
    hass: HomeAssistant,
    mech: _Mechanics,
    touch: dict,
    phase: str,
    slider_key: str,
    pos: float,
) -> None:
    """Write the value `pos` implies, relative to the gesture's origin.

    Deliberately unguarded: `execute_slider_action` already wraps the whole
    coroutine, and letting a failure propagate is what keeps the `last_pos`
    bookkeeping honest — a swallowed one is indistinguishable from success.
    """
    new_value = mech.value_at(touch["base_value"], pos - touch["zero_pos"])
    _LOGGER.debug(
        "Slider %s: %s pos=%.3f new=%.3f → %s(%s)",
        slider_key, phase, pos, new_value, mech.service, mech.target_entity,
    )
    await mech.write(hass, new_value)


async def execute_slider_action(
    hass: HomeAssistant,
    entry_id: str,
    slider_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
    interaction: str = "click",
    position: float | None = None,
) -> None:
    """Handle a slider event, guarding the shared event listener from failures.

    See :func:`_execute_slider_action` for the behaviour.
    """
    try:
        await _execute_slider_action(
            hass, entry_id, slider_key, page_id, interaction, position
        )
    except Exception:
        # Deliberately broad, as in `execute_action`: this runs off the shared
        # device event listener and slider config can come from user-editable
        # YAML, so one bad slider must not take out every button on the device.
        _LOGGER.exception("Slider action failed for %s/%s", page_id, slider_key)


async def _execute_slider_action(
    hass: HomeAssistant,
    entry_id: str,
    slider_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
    interaction: str = "click",
    position: float | None = None,
) -> None:
    """Handle slider touch events with proportional zero-point logic.

    Slider config, stored as the assignment under `slider_key`::

        slider_actions:
          mode: "proportional"
          target_entity: "media_player.living_room"
          attribute: "volume_level"    # attribute holding the current value
          service: "media_player.volume_set"
          data_key: "volume_level"     # service data key to set
          factor: 1.0                  # scaling multiplier
          min: 0.0
          max: 1.0

    With ``target: last_touched`` everything but `factor` comes from whichever
    button was last touched, resolved at `touch_start` and pinned for the rest
    of the gesture; with nothing touched the gesture is dropped. With
    ``target: last_touched_or_entity`` the stored config above drives instead
    whenever nothing is selected. :data:`SLIDER_VERTICAL_KEY` with no config at
    all reads as ``last_touched_slider_actions(1.0)``; any other key is ignored.

    Position is normalized to 0.0-1.0 (0=bottom), or None when the event carried
    none. Sliding up from position p can add at most ``(1-p)*factor*(max-min)``
    and down at most ``p*factor*(max-min)``, which is what lets one formula
    drive a 0.0-1.0 volume and a 0-255 brightness alike.
    """
    device_id = _resolve_device_id(hass, entry_id)
    if not device_id:
        return

    state_key = (entry_id, slider_key)
    slider_cfg, follows = await _load_slider_cfg(hass, device_id, slider_key, page_id)
    if slider_cfg is None:
        # Any live state is stale — the slider was reconfigured mid-gesture —
        # and a delta against its zero-point would land on the next touch.
        _slider_touch_state.pop(state_key, None)
        _LOGGER.debug(
            "execute_slider_action: %s has no slider_actions — ignoring", slider_key,
        )
        return

    gesture = _gesture_for(interaction, state_key)
    if gesture == _TOUCH_CANCEL:
        _slider_touch_state.pop(state_key, None)
        _LOGGER.debug("Slider %s: gesture cancelled — state discarded", slider_key)
        return

    if gesture != _TOUCH_START and _shape_changed_mid_gesture(state_key, follows):
        _slider_touch_state.pop(state_key, None)
        _LOGGER.debug(
            "Slider %s: config changed shape mid-gesture — discarding it", slider_key,
        )
        return

    mode = slider_cfg.get("mode", "proportional")
    pinned_cfg: dict | None = None
    if follows:
        # Resolved before any of the maths reads the config, so there is exactly
        # one implementation of the drag: from here down there is only a target
        # entity and a range.
        pinned_cfg = _pinned_config(
            hass, entry_id, state_key, slider_cfg, slider_key, gesture,
        )
        if pinned_cfg is None:
            return
        slider_cfg = pinned_cfg
        mode = "proportional"

    # The only mode the executor implements. The panel-save path drops anything
    # else, but `layouts.py` writes straight from YAML.
    if mode != "proportional":
        _LOGGER.warning(
            "Slider %s: unsupported slider mode %r — ignoring event", slider_key, mode,
        )
        return

    mech = _Mechanics.from_config(slider_cfg)
    if not mech.has_usable_range(slider_key):
        return

    if gesture == _TOUCH_START:
        await _do_start(hass, state_key, mech, slider_key, position, pinned_cfg)
    elif gesture == _SLIDE:
        await _do_slide(hass, entry_id, state_key, mech, slider_key, position)
    elif gesture == _TOUCH_END:
        await _do_end(hass, state_key, mech, slider_key, position, interaction)
    else:
        _LOGGER.debug("Slider %s: unhandled interaction '%s'", slider_key, interaction)
