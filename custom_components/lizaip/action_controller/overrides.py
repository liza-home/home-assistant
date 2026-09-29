"""Grid buttons overriding what a fixed button does."""
from __future__ import annotations

import logging
import re
from typing import Any

from .sliders import SLIDER_VERTICAL_KEY

_LOGGER = logging.getLogger(__name__)

#: The twelve grid buttons — the only keys that may *carry* overrides.
_GRID_BUTTON_RE = re.compile(r"^button_\d+$")

#: The fixed **buttons** whose press a grid button may override.
#:
#: Grid keys are excluded by construction (an override is something a grid
#: button *has*, not something it can target), as is ``slider_horizontal``,
#: which is Page Settings and never a button.
#:
#: Buttons, not controls, and the distinction is load-bearing in three places:
#: :func:`resolve_fixed_action` answers "which assignment does this *press*
#: run", the panel nests these cards' whole record inside the grid button's
#: override table, and PROTOCOL.md §12 lists exactly these as the
#: firmware-fixed buttons. The slider is none of those things — it is dragged,
#: not pressed, and its own record stays on the page — so it is absent here and
#: present in :data:`OVERRIDABLE_FIXED_KEYS`.
#:
#: Mirrored in the panel as ``OVERRIDABLE_FIXED_BUTTONS`` and pinned against it
#: by ``tests/parity_cases.json``.
OVERRIDABLE_FIXED_BUTTONS: frozenset[str] = frozenset({
    "button_power",
    "button_volume_up",
    "button_volume_down",
    "button_back",
    "button_voice",
})

#: The one key inside ``overrides`` that is not a button, and the only one whose
#: value is the slider block.
#:
#: It is the *slot* name, imported rather than respelled here. A grid button's
#: slider settings are an override of the page's ``slider_vertical`` entry, so
#: the two are the same key by construction and not by coincidence: the panel
#: routes the slider's own card and a button's override of it through one
#: `selBtn.key` comparison. A local copy would let them drift apart, and the
#: failure would be silent — a card that edits a key nothing reads.

#: Every key that may appear inside a grid button's ``overrides`` block.
#:
#: The value's shape is the contract, and it follows from the key:
#:
#: * a **button**, **dict** — a frozen sub-assignment with its own ``action_id``,
#:   picked by the user in the panel from the action library. Its target is baked
#:   in at config time.
#: * a **button**, **str** — a service, resolved against the selection's own
#:   entity when the button is pressed.
#: * the **slider**, **dict** — ``{entity_id, control}``: which device this
#:   button points the slider at, and optionally which capability of it a touch
#:   drives. ``entity_id`` is the retarget opt-in, so presence of the block is
#:   presence of the behaviour; ``control`` is omitted when it is the one
#:   :func:`resolve_control` would derive anyway.
#:
#: The slider's dict is emphatically *not* a frozen sub-assignment, and the
#: difference is the whole reason it is a separate shape. What a slider drives is
#: a *capability* whose mechanics (service, attribute, data_key, min, max) are
#: resolved live from the touched entity by :func:`resolve_control` /
#: :func:`control_range`. Freezing them at config time would let one device's
#: range survive into another's — a media player's 0–1 reaching a lamp that wants
#: 0–255. An entity id and a capability id carry no range to go stale.
#:
#: A similar argument covers the buttons, which is why they accept both shapes
#: and layouts only ever write the string one. A frozen ``button_power`` holds
#: an entity id that :func:`_retarget_entity_keys` does not walk, so a refresh
#: that replaced the lamp behind a slot would leave power switching off the
#: previous one. A service name has no entity in it.
OVERRIDABLE_FIXED_KEYS: frozenset[str] = OVERRIDABLE_FIXED_BUTTONS | frozenset({
    SLIDER_VERTICAL_KEY,
})

#: Sentinel ``action_id`` for a press synthesised from a live override.
#:
#: :func:`execute_action` gates on ``action_id`` being present, but the script
#: cache keys on ``(device, page, button)`` and revalidates by comparing action
#: *content* — so a constant here is safe and never runs stale code.
LIVE_OVERRIDE_ACTION_ID = "__live_override__"


def may_be_context(button_key: Any, assign: Any) -> bool:
    """Whether touching *button_key* should become the fixed-button context.

    The executor's half of the panel's ``_mayBeContext``; the two must agree.

    A blank grid button may not be a context — the panel will not let you select
    one, so admitting it here would create an invisible split. Pinned by
    ``test_a_blank_grid_button_may_not_be_a_context``.

    "Configured" is ``action_id``, an image, or a slider mode — the panel's
    ``isConfigured`` verbatim. Resist widening it (``config`` and ``name`` look
    tempting): the disagreement would simply move.

    ``overrides`` is deliberately not in that list even though
    ``_is_empty_button`` *keeps* a grid button carrying only an override table.
    The two answer different questions: the store is preserving data, this is
    deciding behaviour.

    On ``False`` the panel clears its context (a stale one would show the wrong
    card) while the executor keeps its own — touching a blank button on the
    device means nothing at all.
    """
    if not is_grid_button(button_key):
        return False
    if not isinstance(assign, dict):
        return False
    # `isinstance` rather than `(… or {}).get`, which raised AttributeError on a
    # hand-edited `slider_actions: proportional`. That threw from
    # `_record_selection`, awaited *before* dispatch, so the malformed button
    # stopped responding entirely — while the panel read it as merely blank.
    slider_actions = assign.get("slider_actions")
    return bool(
        assign.get("action_id")
        or assign.get("image")
        or (isinstance(slider_actions, dict) and slider_actions.get("mode"))
    )


def is_grid_button(button_key: Any) -> bool:
    """Whether *button_key* names one of the twelve grid buttons.

    The panel's ``isGridBtn`` in Python. Mirrored rather than shared because it
    cannot be; the blueprint fixes both halves.
    """
    return isinstance(button_key, str) and _GRID_BUTTON_RE.match(button_key) is not None


def fixed_overrides(assign: Any) -> dict:
    """The override table a grid button declares, as a plain dict.

    Absence, a non-dict and an empty table all mean "overrides nothing". The
    writers guarantee an empty table never reaches disk (see
    ``_sanitize_overrides``), so that case is defensive against hand-edited YAML.
    """
    overrides = assign.get("overrides") if isinstance(assign, dict) else None
    return overrides if isinstance(overrides, dict) else {}


def _stripped(value: Any) -> str | None:
    """*value* as a usable string, or None for anything that is not one.

    Four callers below ask the same question of four different fields — a
    service name, a device, a control id — and the answer is always "a non-blank
    string, trimmed, else nothing at all". Written out each time it was four
    chances for one of them to start telling ``""`` apart from absence, which is
    the trap this module argues against everywhere else: an absence dressed up
    as a value.

    Stripping happens on this side as well as in the writers because this side
    reads whatever is in the store, and a hand-edited YAML file reaches it
    without passing any writer.
    """
    if not isinstance(value, str):
        return None
    return value.strip() or None


def live_override(assign: Any, fixed_key: Any) -> str | None:
    """The live-resolved service *assign* declares for *fixed_key*, if any.

    A string value names a service, resolved against the selection's own entity
    when the button is pressed. A dict is the panel's frozen sub-assignment and
    is not this function's business — :func:`resolve_fixed_action` reads those.

    Buttons only, in practice: the slider's value is a dict of a third shape
    entirely, so it falls out of :func:`_stripped` rather than needing a guard.
    :func:`slider_control_override` is its reader.
    """
    if fixed_key not in OVERRIDABLE_FIXED_KEYS:
        return None
    return _stripped(fixed_overrides(assign).get(fixed_key))


def slider_override(assign: Any) -> dict:
    """The slider block a grid button declares, as a plain dict.

    Absence, a non-dict and an empty block all mean "says nothing about the
    slider", so the page's own slider config stands. The writers guarantee an
    empty block never reaches disk; that case is defensive against hand-edited
    YAML.
    """
    value = fixed_overrides(assign).get(SLIDER_VERTICAL_KEY)
    return value if isinstance(value, dict) else {}


def slider_subject_entity(assign: Any) -> str | None:
    """The device this button points the slider at, or None to leave it alone.

    Naming a device is the entire opt-in. Absence means "leaves the slider
    alone", so a page of ordinary buttons says nothing and the page's own slider
    config stands.

    Honoured as an instruction, not a hint: the named device is not filtered
    through ``controls_for_entity`` first, because silently skipping a device the
    user named outright would be invisible. If it controls nothing,
    :func:`resolve_control` returns None at gesture time.

    An empty string is a deliberate third state, not a device: it is the
    placeholder a bound-empty slot keeps so ``_retarget_subject`` can refill it,
    and it reads here as "no device" exactly like absence does.
    """
    return _stripped(slider_override(assign).get("entity_id"))


def slider_control_override(assign: Any) -> str | None:
    """Which capability of that device a touch drives, or None to derive one.

    Absence is the spelling of "derive the first available control", which is
    why it is a separate key from ``entity_id`` rather than a second meaning of
    it: one field, one axis. The panel omits it whenever the user's choice
    equals the derived default, so an untouched button stores only the device.
    """
    return _stripped(slider_override(assign).get("control"))


def sanitize_slider_override(value: Any) -> dict:
    """The storable form of a slider block, or ``{}`` for anything unusable.

    The one gate every writer passes through — the WebSocket sanitiser, the
    store's last-chance stripper and the layout generator — so "what may reach
    disk" is answered once rather than three times in three dialects.

    ``entity_id`` must be present and a string: it is the opt-in, and a block
    without it declares a control for a retarget that never happens. The empty
    string survives on purpose, because it is the placeholder a bound-empty slot
    keeps for ``_retarget_subject``; callers that have a binding to consult
    decide whether to keep one (see ``_build_assignment_entry``).

    ``control`` is dropped when absent or blank rather than stored empty, so the
    "derive one" state has a single spelling on disk.
    """
    if not isinstance(value, dict):
        return {}
    entity = value.get("entity_id")
    if not isinstance(entity, str):
        return {}
    block = {"entity_id": entity.strip()}
    control = _stripped(value.get("control"))
    if control:
        block["control"] = control
    return block


def resolve_fixed_action(
    assignments: Any, selected_button_key: Any, fixed_key: Any,
) -> dict | None:
    """Which assignment a press of *fixed_key* should run, given the selection.

    The page default, unless the grid says otherwise — the same shape of
    question as :func:`slider_follows`, and deliberately beside it.

    Five ways to get the page default, all spelled by absence:

    1. *fixed_key* is not overridable. The caller routes every key here
       unfiltered, so this scoping guard is load-bearing.
    2. nothing is selected.
    3. the selection names a button not on *this* page. The weaker of two guards
       against a stale selection — the other being that every page change clears
       it — and not a substitute for it, since two pages built from one layout
       share button keys. Deliberately not a timeout either: a button that
       changes meaning after N seconds, on a device whose glyphs cannot show
       which context is live, is a hidden state machine.
    4. the selected button declares no override for this control. A selection
       with no override changes *nothing*; deriving one (`power` → toggle the
       selected entity) was considered and rejected as unpredictable on a device
       that cannot show the context.
    5. the override declares no action. One with no ``action_id`` would displace
       the page default and run nothing, leaving the control dead rather than
       inherited. Both writers drop these before disk; this is the reader's half.

    Otherwise the override is returned **whole**, never blended with the page
    default — a patch could pair one button's ``action_id`` with another's
    ``config``.

    Returns ``None`` when there is nothing at that key at all, matching what
    ``assignments.get(fixed_key)`` returned before.
    """
    if not isinstance(assignments, dict):
        return None
    default = assignments.get(fixed_key)
    if fixed_key not in OVERRIDABLE_FIXED_BUTTONS:
        return default
    if not selected_button_key:
        return default
    selected = assignments.get(selected_button_key)
    if not isinstance(selected, dict):
        return default
    override = fixed_overrides(selected).get(fixed_key)
    if not isinstance(override, dict) or not override.get("action_id"):
        synthesised = _live_fixed_action(selected, fixed_key)
        if synthesised is not None:
            return synthesised
        return default
    return override


def _live_fixed_action(selected: dict, fixed_key: str) -> dict | None:
    """A press synthesised from a live override, against the selection's entity.

    The counterpart to the frozen table: the layout named a service, and the
    entity is whatever is selected *now*. Nothing is stored per pair, so nothing
    can go stale when a refresh moves the item behind the slot.

    The subject is the slider block's ``entity_id``, the same field the slider
    reads — a button that overrides a control without naming a device has no
    entity to act on and inherits the page default rather than firing at
    nothing. That the button's own subject lives under the slider's key is not
    an accident of storage: naming a device is one act, and it is what opts the
    button into driving anything of the selection's at all.
    """
    service = live_override(selected, fixed_key)
    if service is None or "." not in service:
        return None
    entity = slider_subject_entity(selected)
    if entity is None:
        return None
    return {
        "action_id": LIVE_OVERRIDE_ACTION_ID,
        "config": [{"action": service, "target": {"entity_id": entity}}],
    }
