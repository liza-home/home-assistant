"""Turning a button assignment the panel sent into the stored form.

Everything here validates and cleans input; none of it talks to the device.
Used by ``assignments.ws_save_assignments``.
"""
from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from ...action_controller import (
    OVERRIDABLE_FIXED_BUTTONS,
    SLIDER_FACTOR_MAX,
    SLIDER_FACTOR_MIN,
    SLIDER_TARGET_ENTITY,
    SLIDER_VERTICAL_KEY,
    TOGGLE_KEY,
    follows_selection_only,
    is_grid_button,
    last_touched_slider_actions,
    sanitize_slider_override,
    sanitize_toggle,
    targets_entity,
)
from ...shared.assignment import (
    ASSIGNMENT_LONGTOUCH_KEY,
    ASSIGNMENT_REPEAT_KEY,
    longtouch_steps,
    key_repeats,
    ASSIGNMENT_DYNAMIC_KEY,
    ASSIGNMENT_INTERNAL_TARGET_NAME_KEY,
    ASSIGNMENT_TOOLTIP_EDITED_KEY,
)
from ...shared.numbers import to_float
from ..const import payload_display
from ..internal_commands import get_internal_command
from ..page_payload import step_targets_entry
from ..const import EMPTY_BUTTON


# Sensitivity bounds for the drag factor. Defined by the executor, which is the
# one point downstream of both this path and template YAML — see
# ``action_controller.SLIDER_FACTOR_MIN`` for why they are enforced at all.
_FACTOR_MIN = SLIDER_FACTOR_MIN


_FACTOR_MAX = SLIDER_FACTOR_MAX


def _clamped_factor(raw) -> float:
    """Panel drag factor, coerced and clamped once for both slider modes.

    The executor is downstream of both panel saves and template YAML, so the
    shared bounds are enforced there too; keeping this path in step prevents a
    saved value the executor would immediately clamp or reject.
    """
    return max(_FACTOR_MIN, min(_FACTOR_MAX, to_float(raw, 1.0)))


def _sanitize_slider_actions(raw) -> dict | None:
    """Return the stored slider_actions schema, dropping unknown panel keys.

    ``None`` means no stored slider config; for the default vertical slider that
    spells "follow the selection". Unknown keys are discarded so malformed JSON
    from the panel cannot wedge the executor.
    """
    if not raw or not isinstance(raw, dict):
        return None

    mode = raw.get("mode")

    if mode != "proportional":
        return None

    if follows_selection_only(raw):
        # Store the thin following shape, not a pinned config with empty
        # entity/range. A bare proportional blob with no entity is the panel's
        # current spelling of "follow selection".
        return last_touched_slider_actions(_clamped_factor(raw.get("factor")))

    out = {
        "mode": "proportional",
        "target_entity": str(raw.get("target_entity") or ""),
        "factor": _clamped_factor(raw.get("factor")),
        "min": to_float(raw.get("min"), 0.0),
        "max": to_float(raw.get("max"), 1.0),
    }
    # Preserve explicit pinning even though the panel cannot create it; otherwise
    # saving any other button would convert a pinned slider into a following one.
    if targets_entity(raw):
        out["target"] = SLIDER_TARGET_ENTITY
    # Omit empty strings so executor .get(..., default) fallbacks still apply.
    for key in ("attribute", "service", "data_key"):
        val = str(raw.get(key) or "").strip()
        if val:
            out[key] = val
    return out


def _sanitize_override_entry(raw: Any, lib_by_id: dict[str, dict]) -> dict:
    """Normalise one fixed-button override; keep only runnable entries.

    Overrides are full sub-assignments using the same allowlist as top-level
    buttons, then stripped back. They must carry ``action_id``: a named but
    actionless override would win over the page default and run nothing. Fixed
    buttons cannot render labels/icons (PROTOCOL.md §12), and overrides cannot
    nest because ``overrides`` is not copied into sub-assignments.

    Absence remains the spelling of "inherit". This is why runnability, not the
    top-level empty-button predicate, decides whether an override is stored.
    """
    if not isinstance(raw, dict):
        return {}
    entry = build_assignment_entry(raw, lib_by_id)
    return entry if entry.get("action_id") else {}


def _sanitize_overrides(raw: Any, lib_by_id: dict[str, dict], binding: Any = None) -> dict:
    """Per-grid-button override table; empty entries/tables never reach disk.

    This is the Python/JS contract: the panel tests override presence with
    ``Object.hasOwn(...)`` and never has to interpret ``{}``, whose truthiness
    differs between languages. Unknown fixed-button keys are dropped because the
    executor never reads them.

    *binding* decides the one case a block's own contents cannot: a slider
    override naming the **empty** entity is a placeholder for
    ``_retarget_subject`` and is meaningful only on a bound slot. On an unbound
    button it is a button that opted into retargeting and named nothing, which
    is the panel's spelling for "off" — so it is dropped rather than stored as a
    setting nothing acts on.

    The invariant is also enforced by ``test_fixed_button_overrides.py``; the
    comment names the cross-language contract the test is protecting.
    """
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, value in raw.items():
        if key == SLIDER_VERTICAL_KEY:
            # Which device this button points the slider at, and optionally
            # which of its capabilities a touch drives. Not a sub-assignment:
            # there is nothing to look up in the library, and freezing the
            # mechanics is the thing this shape exists to avoid.
            block = sanitize_slider_override(value)
            if block and (block["entity_id"] or binding):
                out[key] = block
            continue
        if isinstance(value, str) and key in OVERRIDABLE_FIXED_BUTTONS:
            # A live override names a service; there is no sub-assignment to
            # build and nothing to look up in the library.
            if value.strip():
                out[key] = value.strip()
            continue
        if key not in OVERRIDABLE_FIXED_BUTTONS:
            continue
        entry = _sanitize_override_entry(value, lib_by_id)
        if entry:
            out[key] = entry
    return out


# Separate spelling for "no slider icon"; absence means derive one.
SLIDER_ICON_HIDDEN_KEY = "slider_hide_icon"


def _claims_the_button(entry: dict, stored_entry: dict | None, binding: Any) -> bool:
    """Whether a save re-points a bound slot and therefore claims it.

    Replacing the action on either an empty dynamic slot or a filled source item
    detaches the binding so refresh cannot overwrite the user's choice. Edits
    that keep the same ``action_id`` leave the binding intact.

    From the user's side both cases are the same act: choosing what the button
    does. Only that re-point unbinds; icon, label, slider, and autosave echoes
    keep the source relationship.
    """
    if not isinstance(binding, dict):
        return False
    action_id = entry.get("action_id")
    if not action_id:
        return False
    return action_id != (stored_entry or {}).get("action_id")


def drop_own_device_target(hass: HomeAssistant, entry, assign: Any) -> None:
    """Strip a device-local step's target when it only names this remote.

    Home Assistant's action editor fills ``target`` from the ``target:`` selector
    ``services.yaml`` declares, so picking ``lizaip.goto_page`` writes the very
    remote the button already lives on. :func:`step_targets_entry` answers the
    same ``True`` for that target and for no target at all — "wherever this runs,
    which here is this remote" — so dropping it changes nothing the device sees.
    It only keeps the stored page free of a field that reads as load-bearing.

    A target naming a *different* remote is kept. That is how cross-device
    navigation is spelled: ``page_payload`` demotes such a step to a button event
    so Home Assistant routes it to the remote actually named.

    Applied to override sub-assignments too, which carry their own steps.
    """
    if entry is None or not isinstance(assign, dict):
        return
    config = assign.get("config")
    if isinstance(config, list):
        for step in config:
            if not isinstance(step, dict) or not step.get("target"):
                continue
            if get_internal_command(step.get("action")) is None:
                continue
            if step_targets_entry(hass, entry, [step]):
                step.pop("target", None)
    for override in (assign.get("overrides") or {}).values():
        drop_own_device_target(hass, entry, override)


def build_assignment_entry(
    assign_data: dict, lib_by_id: dict[str, dict], button_key: str | None = None,
    stored_entry: dict | None = None,
) -> dict:
    """Normalise one panel assignment into the store schema.

    The copied key list is the schema: anything absent is erased on save.
    ``button_key`` gates grid-only overrides; ``stored_entry`` preserves dynamic
    bindings the panel may not round-trip.

    ``stored_entry`` is intentionally not used for overrides. The nested call
    has no binding to inherit, and omits ``button_key`` so overrides cannot carry
    overrides of their own.
    """
    entry = dict(EMPTY_BUTTON)
    if assign_data.get("action_id"):
        entry["action_id"] = assign_data["action_id"]
        entry["config"] = assign_data.get("config", [])
    # Payload title outranks the shared library name; play_media/select_source
    # actions can identify a media item better than their shared action id can.
    # Whitespace is not a tooltip, matching the panel's Tooltip trimming.
    submitted_tooltip = assign_data.get("tooltip")
    if isinstance(submitted_tooltip, str):
        submitted_tooltip = submitted_tooltip.strip()
    tooltip = submitted_tooltip or None
    if not tooltip and entry["action_id"]:
        payload_title, _ = payload_display(entry)
        action_def = lib_by_id.get(entry["action_id"], {})
        tooltip = payload_title or action_def.get("name")
    entry["tooltip"] = tooltip
    # tooltip_edited marks only a submitted non-empty tooltip. A cleared Tooltip field
    # asks for derivation again; marking the fallback as edited would freeze it.
    if assign_data.get(ASSIGNMENT_TOOLTIP_EDITED_KEY) and submitted_tooltip:
        entry[ASSIGNMENT_TOOLTIP_EDITED_KEY] = True
    # Internal target name is allowlisted so panel-written hints survive save.
    target_hint = assign_data.get(ASSIGNMENT_INTERNAL_TARGET_NAME_KEY)
    if isinstance(target_hint, str) and target_hint.strip():
        entry[ASSIGNMENT_INTERNAL_TARGET_NAME_KEY] = target_hint.strip()
    entry["icon"] = assign_data.get("icon") or None
    entry["icon_pinned"] = bool(assign_data.get("icon_pinned"))
    entry["state_icons"] = assign_data.get("state_icons") or {}
    # Omitted slider_actions means the default following slider.
    slider_actions = _sanitize_slider_actions(assign_data.get("slider_actions"))
    if slider_actions:
        entry["slider_actions"] = slider_actions
    # Binding is resolved before slider fields; bound-empty slots may store an
    # empty slider subject so refresh can retarget it later. Explicit null
    # unbinds, while absence means "the panel did not know this key; inherit
    # from disk".
    if ASSIGNMENT_DYNAMIC_KEY in assign_data:
        binding = assign_data.get(ASSIGNMENT_DYNAMIC_KEY)
    else:
        binding = (stored_entry or {}).get(ASSIGNMENT_DYNAMIC_KEY)
        if _claims_the_button(entry, stored_entry, binding):
            # User-picked actions detach; cosmetic edits keep the binding.
            binding = None
    # Store only in-range numeric slider_factor. Bounds are enforced, not
    # clamped, because an out-of-range hand edit should fall back to the page
    # factor rather than being rewritten; bool is an int in Python.
    slider_factor = assign_data.get("slider_factor")
    if (
        isinstance(slider_factor, (int, float))
        and not isinstance(slider_factor, bool)
        and SLIDER_FACTOR_MIN <= float(slider_factor) <= SLIDER_FACTOR_MAX
    ):
        entry["slider_factor"] = float(slider_factor)
    # Slider appearance belongs to the selected button and is panel-only; sliders
    # are not part of the device buttons[] payload.
    for key in ("slider_image", "slider_name"):
        val = assign_data.get(key)
        if isinstance(val, str) and val.strip():
            entry[key] = val.strip()
    # Hidden icon is a flag; image absence already means derive one, and using
    # image as a sentinel would make an untouched slider look configured.
    if assign_data.get(SLIDER_ICON_HIDDEN_KEY):
        entry[SLIDER_ICON_HIDDEN_KEY] = True
    if binding:
        entry[ASSIGNMENT_DYNAMIC_KEY] = binding
    # Absence of before/after lets the executor infer wake behavior; writing a
    # default empty list would disable that inference.
    for sibling in ("before", "after"):
        if isinstance(assign_data.get(sibling), list):
            entry[sibling] = assign_data[sibling]
    # Stored only when it has a step: absence is "no long touch", and an empty
    # list would make the device hold back the click for nothing.
    longtouch = longtouch_steps(assign_data)
    if longtouch:
        entry[ASSIGNMENT_LONGTOUCH_KEY] = longtouch
    # A flag: stored only when on, so absence keeps meaning "runs once".
    if key_repeats(assign_data):
        entry[ASSIGNMENT_REPEAT_KEY] = True
    # ``toggle`` is a sibling of ``config`` for the same reason before/after are:
    # ``config[0]`` must keep meaning "the step that represents this button" for
    # icons, tooltips, the watched-entity set and the panel's action matcher.
    # sanitize_toggle returns {} for anything that would not run, and an empty
    # dict is never written — absence is the only spelling for "no toggle".
    toggle = sanitize_toggle(assign_data.get(TOGGLE_KEY))
    if toggle:
        entry[TOGGLE_KEY] = toggle
    # Only grid buttons can contextually override fixed buttons; absence means
    # inherit. Fixed buttons are resolved actions, never contexts.
    if is_grid_button(button_key):
        overrides = _sanitize_overrides(assign_data.get("overrides"), lib_by_id, binding)
        if overrides:
            entry["overrides"] = overrides
    return entry
