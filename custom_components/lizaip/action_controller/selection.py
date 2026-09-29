"""Recording which button the grid last selected."""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

from ._state import (
    _clear_selected_device,
    _selected_button,
    _selected_control,
    _selected_entity,
    _selected_factor,
    get_selected_entity,
)
from .helpers import _get_store, _resolve_device_id
from .overrides import (
    is_grid_button,
    may_be_context,
    slider_control_override,
    slider_subject_entity,
)
from .slider_exec import SLIDER_FACTOR_MAX, SLIDER_FACTOR_MIN

_LOGGER = logging.getLogger(__name__)

#: The deliberate press, as opposed to a finger crossing the grid.
_CLICK = "click"


def _update_context(
    entry_id: str, button_key: str, assign: dict | None, interaction: str,
) -> None:
    """Record or clear the fixed-button context for this press.

    Decided independently of every slider rule: a context only has to be a real
    grid button someone configured, while the slider needs an entity it can
    *drive*. :func:`may_be_context` owns that rule and is the twin of the
    panel's `_mayBeContext`.

    Only a deliberate *click* of a blank grid button clears. `touch` fires as a
    finger crosses the grid on its way elsewhere, so clearing on it made a
    mostly-blank page impossible to navigate. A press of a blank button is the
    user saying "nothing is selected now", which is also what the panel does in
    `_switchTab` / `_selectButton`.
    """
    if may_be_context(button_key, assign):
        previous = _selected_button.get(entry_id)
        _selected_button[entry_id] = button_key
        if previous != button_key:
            _LOGGER.debug("Context: %s (was %s)", button_key, previous)
        return

    if not is_grid_button(button_key):
        return

    if interaction != _CLICK:
        _LOGGER.debug(
            "Context: %s is blank — keeping %s (interaction=%s)",
            button_key, _selected_button.get(entry_id), interaction,
        )
        return

    previous = _selected_button.pop(entry_id, None)
    # The slider selection goes with it: one gesture, one meaning. Leaving the
    # slider on the last lamp while the fixed buttons reset showed half a face
    # changing on the device with nothing to say why. Scoped to *blank* buttons
    # only -- a configured button that simply declines the slider job keeps the
    # selection, or half a typical grid would become a deselect button.
    _clear_selected_device(entry_id)
    if previous is not None:
        _LOGGER.debug(
            "Context: cleared (was %s) — %s was pressed and is blank",
            previous, button_key,
        )


async def _record_selection(
    hass: HomeAssistant, entry_id: str, button_key: str, page_id: int,
    *, interaction: str = "touch",
) -> None:
    """Remember what this press selected: a fixed-button context, a slider
    target, both, or neither.

    The two halves answer different questions and are deliberately independent.
    *interaction* is ``"touch"`` or ``"click"`` and matters only to the context
    half; the slider half treats both alike, because waiting for a press to
    complete would break touch-and-drag onto the slider. ``"touch"`` is the
    default because it never clears anything.

    The slider half is *not* gated on :func:`is_grid_button`, so a fixed button
    carrying a slider override block can take the selection. No writer produces
    that today -- the panel's picker only targets grid keys -- but hand-edited
    YAML and direct websocket saves still reach it, so it is latent rather than
    fixed. If it is ever closed, guard the *writer*
    (`_build_assignment_entry` in ``websocket.py``): guarding only this side
    leaves the panel storing a key that is silently inert.

    Runs on every touch of every button, so it stays cheap: one cached store
    read and at most one state lookup per candidate entity. It deliberately
    does not resolve the control's mechanics -- that happens at ``touch_start``,
    against the state as it is then.
    """
    device_id = _resolve_device_id(hass, entry_id)
    if not device_id:
        return

    assignments = await _get_store(hass).async_get_assignments(device_id, page_id)
    assign = assignments.get(button_key)

    _update_context(entry_id, button_key, assign, interaction)

    # ``overrides.slider_vertical.entity_id`` is the only spelling that reaches
    # here. A layout says `slider_select: true` because a preset cannot know the
    # entity, and :func:`generate_assignments` resolves that into the block when
    # the preset is applied -- so a guard or migration written against the flag
    # would compile, pass, and mean nothing.
    entity = slider_subject_entity(assign)
    if entity is None:
        _LOGGER.debug(
            "Selection: %s does not drive the slider (no slider subject)", button_key,
        )
        return

    _record_selected_entity(entry_id, entity, assign, button_key)


def _record_selected_entity(
    entry_id: str, entity_id: str, assign: dict, button_key: str,
) -> None:
    """Commit *entity_id* as the selection, with the button's chosen control.

    Split from its caller so that "which entity" and "everything that must be
    true once one is chosen" stay separable. It had two callers while a button
    could also have its device *derived* from its own action; naming the device
    is now the whole opt-in, so there is one, and the split earns its keep as a
    boundary rather than as deduplication.
    """
    previous = get_selected_entity(entry_id)
    _selected_entity[entry_id] = entity_id
    # Set and cleared together with the entity, never left over from an
    # earlier button: a stale control id would ask a speaker for colour
    # temperature. Whether the entity actually supports it is not this
    # function's business — that is decided at gesture time, against the
    # state as it is then (see :func:`resolve_control`).
    control_id = slider_control_override(assign)
    # Stripped by `slider_control_override`: this reads whatever is in the
    # store, which a hand-edited config can reach without passing either writer.
    if control_id:
        _selected_control[entry_id] = control_id
    else:
        _selected_control.pop(entry_id, None)
    # The same rule for sensitivity, and the same reason for reading it here:
    # resolution is sync and has no store, while this function is holding the
    # assignment already. Anything unusable -- a string, a bool, a value outside
    # the bounds the panel advertises -- is dropped rather than clamped, so the
    # page factor applies and the slider behaves as the card with nothing
    # selected says it will. A silent clamp would leave a stored number that no
    # screen anywhere accounts for.
    factor = assign.get("slider_factor")
    if (
        isinstance(factor, (int, float))
        and not isinstance(factor, bool)
        and SLIDER_FACTOR_MIN <= float(factor) <= SLIDER_FACTOR_MAX
    ):
        _selected_factor[entry_id] = float(factor)
    else:
        _selected_factor.pop(entry_id, None)
    if previous != entity_id:
        _LOGGER.debug(
            "Selection: %s → %s (was %s)", button_key, entity_id, previous,
        )
