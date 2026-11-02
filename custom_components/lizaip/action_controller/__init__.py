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

**Only the public API is re-exported below.** Private helpers (leading
underscore) stay in their submodule, and code that needs one — tests mostly —
imports it from there. Tests that patch a module attribute — ``Script``,
``cv``, ``er`` — must patch it *where it is looked up*, which is the submodule,
not here: rebinding ``action_controller.Script`` would leave ``buttons.Script``
untouched. See ``tests/test_action_controller.py``.
"""
from __future__ import annotations

from ._state import (
    SLIDER_GESTURE_TIMEOUT,
    clear_slider_state,
    forget_remote,
    get_current_page,
    get_selected_button,
    get_selected_control,
    get_selected_entity,
    get_selected_factor,
)
from .helpers import (
    get_entity_from_step,
    first_step,
    resolve_step_entity,
    subject_for_assign,
    resolve_target_entities,
    resolve_group_state,
)
from .sliders import (
    SLIDER_CONTROLS,
    SLIDER_NAME_ALIASES,
    SLIDER_TARGET_ENTITY,
    SLIDER_TARGET_LAST_TOUCHED,
    SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY,
    SLIDER_VERTICAL_KEY,
    SliderControl,
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
# Only what is used outside this package. The rest of `toggle`'s surface is
# read by its own siblings and by tests, which import it from `.toggle`
# directly -- the same way `icons.toggle_icon` is reached.
from .toggle import (
    TOGGLE_KEY,
    sanitize_toggle,
)
from .buttons import async_unload_scripts, execute_action
from .slider_exec import SLIDER_FACTOR_MAX, SLIDER_FACTOR_MIN, execute_slider_action
from .state_listener import setup_state_listener
from .dispatch import setup

__all__ = [
    "LIVE_OVERRIDE_ACTION_ID",
    "async_unload_scripts",
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
    "TOGGLE_KEY",
    "clear_slider_state",
    "forget_remote",
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
    "sanitize_toggle",
    "slider_control_override",
    "slider_override",
    "slider_subject_entity",
    "first_step",
    "resolve_step_entity",
    "subject_for_assign",
    "resolve_target_entities",
    "resolve_group_state",
    "serialized_controls",
    "setup",
    "setup_state_listener",
    "slider_follows",
    "targets_entity",
]

