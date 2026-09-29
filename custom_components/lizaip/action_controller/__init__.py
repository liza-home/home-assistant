"""Action controller — single source of truth for action dispatch and state tracking.

Owns the entire chain:
  Device event (click) → resolve button → execute HA Script action
  Entity state change → match icon → fire icon-update event

Also owns the slider: the capability table (what a slider can drive on a given
entity, and with which service), the device selection a last-touched slider
tracks, and the touch executor itself.

This module is a **facade**. The implementation lives in submodules, split by
concern, but every importer keeps addressing ``action_controller`` — the name
this integration has used since before the split, and the one the hot-reload
list in ``__init__.py`` and a dozen call sites already spell:

* :mod:`._state`         — process-global mutable state (selection, gestures,
                           the script cache) and the accessors that clear it.
* :mod:`.helpers`        — store access, entity resolution, page-id coercion.
* :mod:`.sliders`        — the capability table, and what a stored slider
                           config means.
* :mod:`.overrides`      — grid buttons overriding what a fixed button does.
* :mod:`.icons`          — state → icon, and state → tooltip.
* :mod:`.buttons`        — compiling and running a button's action, including
                           the wake prelude, launch verification and the
                           optimistic icon update.
* :mod:`.selection`      — recording what the grid last selected.
* :mod:`.slider_exec`    — executing a slider gesture.
* :mod:`.state_listener` — watching entities, pushing icon updates.
* :mod:`.dispatch`       — the device event listener that routes into all of it.

Submodules import strictly downwards in that order, so the package has no
import cycles.

**Names are re-exported below rather than left to be reached through their
submodule**, and that is load-bearing in two directions. Callers keep working
unchanged. And tests that patch a module attribute — ``Script``, ``cv``, ``er``,
``get_default_icon`` — must patch it *where it is looked up*, which is the
submodule, not here: rebinding ``action_controller.Script`` would leave
``buttons.Script`` untouched. See ``tests/test_action_controller.py``.
"""
from __future__ import annotations

from ._state import (
    SLIDER_GESTURE_TIMEOUT,
    _clear_selected_device,
    _current_page,
    _live_touch,
    _note_page,
    _page_changed,
    _SCRIPT_CACHE,
    _selected_button,
    _selected_control,
    _selected_entity,
    _selected_factor,
    _SELECTING_INTERACTIONS,
    _slider_gesture_active,
    _slider_touch_state,
    _STATE_DEBOUNCE_SECONDS,
    _DEFAULT_PAGE_ID,
    clear_script_cache_for_device,
    clear_slider_state,
    get_current_page,
    get_selected_button,
    get_selected_control,
    get_selected_entity,
    get_selected_factor,
)
from .helpers import (
    _attr_num,
    _attrs,
    _coerce_page_id,
    _color_modes,
    _get_assignments,
    _get_store,
    _noop,
    _normalize_position,
    _raw_page_id,
    _resolve_device_id,
    _resolve_entry_id,
    get_entity_from_step,
    first_step,
    resolve_step_entity,
    subject_for_assign,
    resolve_target_entities,
)
from .sliders import (
    SLIDER_CONTROLS,
    SLIDER_NAME_ALIASES,
    SLIDER_TARGET_ENTITY,
    SLIDER_TARGET_LAST_TOUCHED,
    SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY,
    SLIDER_VERTICAL_KEY,
    SliderControl,
    _effective_target,
    _matches,
    control_range,
    controls_for_entity,
    follows_selection,
    follows_selection_only,
    last_touched_or_entity_slider_actions,
    last_touched_slider_actions,
    resolve_control,
    serialized_controls,
    slider_follows,
    targets_entity,
    targets_last_touched,
    targets_last_touched_or_entity,
)
from .overrides import (
    LIVE_OVERRIDE_ACTION_ID,
    OVERRIDABLE_FIXED_BUTTONS,
    OVERRIDABLE_FIXED_KEYS,
    fixed_overrides,
    live_override,
    is_grid_button,
    may_be_context,
    resolve_fixed_action,
    sanitize_slider_override,
    slider_control_override,
    slider_override,
    slider_subject_entity,
)
from .icons import (
    _compute_next_state_tooltip,
    _compute_next_state_tooltip_inner,
    _match_state_icon,
)
from .buttons import (
    _fire_optimistic_update,
    _get_script,
    _inferred_prelude,
    _inferred_verification,
    _is_optimistic,
    execute_action,
)
from .selection import _record_selected_entity, _record_selection
from .slider_exec import (
    SLIDER_FACTOR_MAX,
    SLIDER_FACTOR_MIN,
    _resolve_selection_config,
    _slider_num,
    execute_slider_action,
)
from .state_listener import setup_state_listener
from .dispatch import setup

__all__ = [
    "LIVE_OVERRIDE_ACTION_ID",
    "OVERRIDABLE_FIXED_BUTTONS",
    "OVERRIDABLE_FIXED_KEYS",
    "SLIDER_CONTROLS",
    "SLIDER_FACTOR_MAX",
    "SLIDER_FACTOR_MIN",
    "SLIDER_GESTURE_TIMEOUT",
    "SLIDER_NAME_ALIASES",
    "SLIDER_VERTICAL_KEY",
    "SLIDER_TARGET_ENTITY",
    "SLIDER_TARGET_LAST_TOUCHED",
    "SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY",
    "SliderControl",
    "clear_script_cache_for_device",
    "clear_slider_state",
    "control_range",
    "controls_for_entity",
    "execute_action",
    "execute_slider_action",
    "fixed_overrides",
    "live_override",
    "follows_selection",
    "follows_selection_only",
    "get_current_page",
    "get_entity_from_step",
    "get_selected_button",
    "get_selected_control",
    "get_selected_entity",
    "get_selected_factor",
    "is_grid_button",
    "last_touched_or_entity_slider_actions",
    "last_touched_slider_actions",
    "may_be_context",
    "resolve_control",
    "resolve_fixed_action",
    "sanitize_slider_override",
    "slider_control_override",
    "slider_override",
    "slider_subject_entity",
    "first_step",
    "resolve_step_entity",
    "subject_for_assign",
    "resolve_target_entities",
    "serialized_controls",
    "setup",
    "setup_state_listener",
    "slider_follows",
    "targets_entity",
    "targets_last_touched",
    "targets_last_touched_or_entity",
]

