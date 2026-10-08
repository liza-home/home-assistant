"""WebSocket API handlers for the lizaIP configuration panel.

The voluptuous schemas below are the wire contract with ``panel/*.js``; handler
responses preserve the JSON shapes those views consume.
"""
from __future__ import annotations

import copy
import importlib.util
import logging
import math
import os
import re
from typing import Any, Final

import voluptuous as vol
import yaml
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from ..action_controller import (
    OVERRIDABLE_FIXED_BUTTONS,
    SLIDER_FACTOR_MAX,
    SLIDER_FACTOR_MIN,
    SLIDER_TARGET_ENTITY,
    SLIDER_TARGET_LAST_TOUCHED,
    SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY,
    SLIDER_VERTICAL_KEY,
    TOGGLE_KEY,
    follows_selection_only,
    is_grid_button,
    last_touched_slider_actions,
    sanitize_slider_override,
    sanitize_toggle,
    serialized_controls,
    setup_state_listener,
    targets_entity,
    targets_last_touched,
    targets_last_touched_or_entity,
)
from ..const import (
    ASSIGNMENT_LONGTOUCH_KEY,
    DOMAIN,
    ICON_DEFAULTS,
    async_preload_action_labels,
    entity_token_entities,
    get_ui_language,
    load_action_labels,
    longtouch_steps,
    resolve_image_tokens,
    substitute_entity_tokens,
    variables_scope,
)
from ..imgserv.const import build_palette
from ..imgserv.fonts import list_fonts, user_fonts_dir
from ..state_brightness import (
    CONF_ICON_FILL_ENABLED,
    CONF_ICON_FILL_STEP,
    DEFAULT_ICON_FILL_ENABLED,
    DEFAULT_ICON_FILL_STEP,
    ICON_FILL_STEP_MAX,
    ICON_FILL_STEP_MIN,
    read_fill_enabled,
    read_fill_step,
)
from ..state_color import (
    CONF_ICON_COLOR_ENABLED,
    DEFAULT_ICON_COLOR_ENABLED,
    read_color_enabled,
)
from ..variables_calc import (
    CONF_VARIABLES_ENABLED,
    CONF_VARIABLES_INTERVAL,
    DEFAULT_VARIABLES_ENABLED,
    DEFAULT_VARIABLES_INTERVAL,
    VARIABLES_INTERVAL_MAX,
    VARIABLES_INTERVAL_MIN,
    VARIABLES_INTERVAL_STEP,
    read_variables_enabled,
    read_variables_interval,
)
from .const import (
    ASSIGNMENT_DYNAMIC_KEY,
    ASSIGNMENT_INTERNAL_TARGET_NAME_KEY,
    ASSIGNMENT_LABEL_EDITED_KEY,
    DEFAULT_BLUEPRINT_ID,
    PAGE_ID_SCHEMA,
    PAGE_SUBPAGE_KEY,
    generate_page_id,
    is_subpage,
    payload_display,
    step_service,
)
from .device_entities import (
    _resolve_device_domain_entities,  # noqa: F401  (re-exported)
)
from .device_sync import step_targets_entry, sync_config_to_device
from .internal_commands import get_internal_command, panel_descriptors, pinned_page_ids
from .layouts import (
    DEFAULT_MAX_ITEMS,
    DEFAULT_TRACKED_FIELDS,
    SOURCES,
    async_resolve_source,
    get_source,
    list_layouts,
    load_layout,
    resolve_layout_variables,
    validate_spec,
)
from .layouts import (
    generate_assignments as layout_generate_assignments,
)
from .layouts import refresh as layout_refresh
from .snapshot import (  # noqa: F401  (re-exported; see test_config_imports)
    _fire_config_changed,
    _get_store,
    _resolve_device_id,
    build_full_config_payload,
)
from .text_style import (
    TEXT_KINDS,
    default_settings,
    font_size_limits,
    validate_settings,
)

_LOGGER = logging.getLogger(__name__)


def debug_available() -> bool:
    """Whether the optional debug tools are part of this build.

    They are stripped from a stable release by `scripts/public_repo.sh`, so a
    missing module is the expected state there rather than a broken install.
    Checked by import rather than by version so that a build we deploy
    ourselves -- which rsyncs the working tree, suffix or not -- always has the
    tools it shipped.
    """
    return importlib.util.find_spec(f"{__package__}.debug_websocket") is not None


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_features"})
@websocket_api.async_response
async def ws_get_features(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report which optional features this build carries.

    The panel cannot infer this: its own files are served from disk regardless,
    so it has to be told whether the backing commands exist before it offers a
    tab that would only produce "unknown command".
    """
    connection.send_result(msg["id"], {"debug_tools": debug_available()})


#: A page holds at most a few hundred texts; the cap only stops a runaway caller.
_MAX_VARIABLE_ITEMS: Final = 500


@websocket_api.websocket_command({
    "type": "lizaip_config/resolve_variables",
    vol.Optional("texts", default=list): [vol.All(str, vol.Length(max=2000))],
    vol.Optional("images", default=list): [vol.All(str, vol.Length(max=2000))],
    vol.Optional("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_resolve_variables(hass: HomeAssistant, connection, msg: dict) -> None:
    """What ``${…}`` variables read right now, as the remote will print them.

    The panel shows a preview of tooltips, pictures and titles and must not carry
    a second implementation of the rules, so it asks. *texts* are tooltips and
    titles (:func:`substitute_entity_tokens`), *images* are pictures
    (:func:`resolve_image_tokens`, None when a variable has no value). *entities*
    lists every entity the answers read, so the panel knows when to ask again.
    With *entry_id*, that remote's Variables switch applies: off, nothing is read.
    """
    entry = hass.config_entries.async_get_entry(msg["entry_id"]) if msg.get("entry_id") else None
    with variables_scope(getattr(entry, "options", None)):
        _reply_variables(hass, connection, msg)


def _reply_variables(hass: HomeAssistant, connection, msg: dict) -> None:
    texts = msg["texts"][:_MAX_VARIABLE_ITEMS]
    images = msg["images"][:_MAX_VARIABLE_ITEMS]
    entities: set[str] = set()
    for item in (*texts, *images):
        entities |= entity_token_entities(item)
    connection.send_result(msg["id"], {
        "texts": {t: substitute_entity_tokens(t, hass) for t in texts},
        "images": {i: resolve_image_tokens(i, hass) for i in images},
        "entities": sorted(entities),
    })


def _schedule_push_rescan(hass: HomeAssistant, entry_id: str) -> None:
    """Re-subscribe push triggers after the bound speakers may have changed.

    Fire-and-forget, and guarded twice over: a re-scan is an optimisation, so
    neither a missing scheduler nor a failing scan may take down the save the
    user actually asked for.
    """
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        return

    async def _rescan() -> None:
        try:
            await layout_refresh.async_rescan_push_triggers(hass, entry_id)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Push trigger re-scan failed for %s: %s", entry_id, err)

    try:
        create_task(_rescan())
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not schedule push trigger re-scan: %s", err)


def _schedule_page_refresh(hass: HomeAssistant, entry_id: str, page_id: int) -> None:
    """Re-read one page's dynamic buttons in the background.

    Browsing a media source can take seconds; the editor should not wait for
    it. Guarded like the re-scan above, for the same reason.
    """
    create_task = getattr(hass, "async_create_task", None)
    if create_task is None:
        return

    async def _refresh() -> None:
        try:
            await layout_refresh.async_refresh_and_sync(hass, entry_id, page_id=page_id)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Dynamic refresh of page %s failed: %s", page_id, err)

    try:
        create_task(_refresh())
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not schedule page refresh: %s", err)


EMPTY_BUTTON = {"action_id": None, "config": [], "label": None, "image": None, "image_pinned": False, "state_icons": {}}


def _num_or(value, default: float) -> float:
    """Coerce to float, falling back to *default* for None/""/non-numeric.

    The panel sends numbers as strings from ``<input type="number">``, and an
    emptied field arrives as ``""`` — which ``float()`` would raise on.

    Non-finite values fall back too. ``float()`` happily parses "inf"/"nan", and
    persisting either would write a literal ``Infinity``/``NaN`` into the store's
    JSON — which is not valid JSON and would fail on the way back in.
    """
    if value is None or value == "":
        return default
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return num if math.isfinite(num) else default


# Sensitivity bounds for the drag factor. Defined by the executor, which is the
# one point downstream of both this path and layout YAML — see
# ``action_controller.SLIDER_FACTOR_MIN`` for why they are enforced at all.
_FACTOR_MIN = SLIDER_FACTOR_MIN
_FACTOR_MAX = SLIDER_FACTOR_MAX


def _clamped_factor(raw) -> float:
    """Panel drag factor, coerced and clamped once for both slider modes.

    The executor is downstream of both panel saves and layout YAML, so the
    shared bounds are enforced there too; keeping this path in step prevents a
    saved value the executor would immediately clamp or reject.
    """
    return max(_FACTOR_MIN, min(_FACTOR_MAX, _num_or(raw, 1.0)))


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
        out = last_touched_slider_actions(_clamped_factor(raw.get("factor")))
        # Preserve an explicit target key; do not normalise unrelated saves.
        if targets_last_touched(raw):
            out["target"] = SLIDER_TARGET_LAST_TOUCHED
        return out

    out = {
        "mode": "proportional",
        "target_entity": str(raw.get("target_entity") or ""),
        "factor": _clamped_factor(raw.get("factor")),
        "min": _num_or(raw.get("min"), 0.0),
        "max": _num_or(raw.get("max"), 1.0),
    }
    # last_touched_or_entity stores a complete default, including min/max.
    # Those same range keys would be stale on strict last_touched configs.
    if targets_last_touched_or_entity(raw):
        out["target"] = SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY
    # Preserve explicit pinning even though the panel cannot create it; otherwise
    # saving any other button would convert a pinned slider into a following one.
    elif targets_entity(raw):
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
    entry = _build_assignment_entry(raw, lib_by_id)
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


def _drop_own_device_target(hass: HomeAssistant, entry, assign: Any) -> None:
    """Strip a device-local step's target when it only names this remote.

    Home Assistant's action editor fills ``target`` from the ``target:`` selector
    ``services.yaml`` declares, so picking ``lizaip.goto_page`` writes the very
    remote the button already lives on. :func:`step_targets_entry` answers the
    same ``True`` for that target and for no target at all — "wherever this runs,
    which here is this remote" — so dropping it changes nothing the device sees.
    It only keeps the stored page free of a field that reads as load-bearing.

    A target naming a *different* remote is kept. That is how cross-device
    navigation is spelled: ``device_sync`` demotes such a step to a button event
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
        _drop_own_device_target(hass, entry, override)


def _build_assignment_entry(
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
    # Payload title outranks the shared library label; play_media/select_source
    # actions can identify a media item better than their shared action id can.
    # Whitespace is not a label, matching the panel's Label trimming.
    submitted_label = assign_data.get("label")
    if isinstance(submitted_label, str):
        submitted_label = submitted_label.strip()
    label = submitted_label or None
    if not label and entry["action_id"]:
        payload_title, _ = payload_display(entry)
        action_def = lib_by_id.get(entry["action_id"], {})
        label = payload_title or action_def.get("name")
    entry["label"] = label
    # label_edited marks only a submitted non-empty label. A cleared Label field
    # asks for derivation again; marking the fallback as edited would freeze it.
    if assign_data.get(ASSIGNMENT_LABEL_EDITED_KEY) and submitted_label:
        entry[ASSIGNMENT_LABEL_EDITED_KEY] = True
    # Internal target name is allowlisted so panel-written hints survive save.
    target_hint = assign_data.get(ASSIGNMENT_INTERNAL_TARGET_NAME_KEY)
    if isinstance(target_hint, str) and target_hint.strip():
        entry[ASSIGNMENT_INTERNAL_TARGET_NAME_KEY] = target_hint.strip()
    entry["image"] = assign_data.get("image") or None
    entry["image_pinned"] = bool(assign_data.get("image_pinned"))
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


def register_commands(hass: HomeAssistant) -> None:
    for handler in (
        ws_list_devices,
        ws_get_blueprint,
        ws_get_actions,
        ws_save_actions,
        ws_get_assignments,
        ws_get_all_assignments,
        ws_save_assignments,
        ws_get_pages,
        ws_set_pages,
        ws_update_page,
        ws_duplicate_page,
        ws_get_icon_defaults,
        ws_get_palette,
        ws_get_settings,
        ws_set_settings,
        ws_get_action_labels,
        ws_get_slider_controls,
        ws_get_internal_commands,
        ws_goto_page,
        ws_clear_device_pages,
        ws_list_layouts,
        ws_list_layout_devices,
        ws_list_layout_config_entries,
        ws_add_layout_page,
        ws_retarget_layout_page,
        ws_browse_media,
        ws_list_dynamic_sources,
        ws_preview_dynamic_source,
        ws_refresh_dynamic,
        ws_set_dynamic_binding,
        ws_get_features,
        ws_resolve_variables,
        ws_get_icon_options,
        ws_set_icon_options,
    ):
        websocket_api.async_register_command(hass, handler)

    # The debug tools are not part of a stable release -- the build strips
    # their files out -- so their absence is normal and must not be an error.
    # Presence of the module is the switch; `ws_get_features` tells the panel
    # the same thing so it can leave the tab out.
    if debug_available():
        from .debug_websocket import register_debug_commands

        # Handed over rather than imported: debug_websocket importing this
        # module back would be a cycle.
        register_debug_commands(hass, page_tools={
            "blueprint": _async_blueprint,
            "reserved_page_ids": _reserved_page_ids,
            "refresh_state_listener": _refresh_state_listener,
        })


def _requires_device(handler):
    """Resolve ``msg["entry_id"]`` to a device id, or answer "not found".

    Deliberately does not set ``__wrapped__``: this decorator *is* the handler's
    public 3-argument contract, so callers unwrapping the HA decorators should
    stop here rather than reach the ``device_id`` form underneath.
    """
    async def wrapper(hass: HomeAssistant, connection, msg: dict) -> None:
        device_id = _resolve_device_id(hass, msg["entry_id"])
        if not device_id:
            connection.send_error(msg["id"], "not_found", "Device not found")
            return
        await handler(hass, connection, msg, device_id)

    wrapper.__name__ = handler.__name__
    wrapper.__qualname__ = handler.__qualname__
    wrapper.__doc__ = handler.__doc__
    wrapper.__module__ = handler.__module__
    return wrapper


#: Cache slot for the parsed blueprints, in ``hass.data[DOMAIN]`` beside
#: ``_ui_language``. Underscore-prefixed because the other keys there are
#: config entry ids. Holds a dict keyed by blueprint id, not a single
#: blueprint: two remotes of different models may be set up at once, and each
#: has to keep its own face.
_BLUEPRINT_CACHE_KEY: Final = "_blueprints"

#: How many parsed faces to keep. The key is the device-reported ``model_id``,
#: which is not a value this integration controls, so an unbounded dict here
#: grows with every string a remote has ever reported. Well past any real
#: household: a site with more distinct models than this re-parses the least
#: recently used one, which is a disk read, not an error.
_BLUEPRINT_CACHE_MAX: Final = 8


def _blueprint_id(hass: HomeAssistant, entry_id: str | None) -> str:
    """Which blueprint this config entry's remote wears.

    The device's own answer if it has given one — ``model_id`` is written into
    the entry when the hello handshake reports it — and the shipped default
    otherwise. Older firmware says nothing, and a remote that has not connected
    since the option was added has nothing stored yet, so the fallback is not
    an error path: it is the normal state for the one model that exists.

    Kept as a lookup rather than a stored panel setting because the face is a
    property of the hardware, not a preference. The user cannot pick wrong, and
    a remote swapped for a different model picks up its own face on reconnect.
    """
    if not entry_id:
        return DEFAULT_BLUEPRINT_ID
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        return DEFAULT_BLUEPRINT_ID
    model_id = entry.data.get("model_id")
    if isinstance(model_id, str) and model_id.strip():
        return model_id.strip()
    return DEFAULT_BLUEPRINT_ID


def _parse_blueprint(blueprint_id: str) -> dict:
    """Read and parse one blueprint. Blocking — call via `_async_blueprint`.

    A model with no blueprint of its own falls back to the default rather than
    rendering an empty panel: an unknown remote almost certainly shares the
    ``lizaIP`` face, and a wrong-but-usable panel beats a blank one. The
    fallback is logged once per model, because it is the signal that a variant
    needs its own file.
    """
    directory = os.path.join(os.path.dirname(__file__), "blueprints")
    path = os.path.join(directory, f"{blueprint_id}.yaml")
    if blueprint_id != DEFAULT_BLUEPRINT_ID and not os.path.isfile(path):
        _LOGGER.warning(
            "No blueprint for model %s — falling back to %s",
            blueprint_id, DEFAULT_BLUEPRINT_ID,
        )
        blueprint_id = DEFAULT_BLUEPRINT_ID
        path = os.path.join(directory, f"{blueprint_id}.yaml")

    try:
        with open(path, "r") as fh:
            bp = yaml.safe_load(fh)
    except (FileNotFoundError, yaml.YAMLError) as exc:
        _LOGGER.error("Blueprint parse error: %s", exc)
        return {"buttons": [], "viewBox": "0 0 172 500", "name": "lizaIP"}

    buttons = [
        {"index": idx, "key": btn.get("key", f"button_{idx + 1}"), "d": btn.get("d", "")}
        for idx, btn in enumerate(bp.get("buttons", []))
    ]
    return {
        "name": bp.get("name", "lizaIP"),
        "buttons": buttons,
        "viewBox": bp.get("viewBox", "0 0 172 500"),
    }


async def _async_blueprint(hass: HomeAssistant, entry_id: str | None = None) -> dict:
    """The parsed blueprint for one remote, read from disk at most once per run.

    The files ship inside the integration and are never written at runtime, so
    re-reading on every panel save was pure cost. More importantly the read has
    to leave the event loop: `open()` on the loop stalls every other
    integration for its duration, and Home Assistant detects it and logs a
    warning naming this module.

    Caching is per blueprint id rather than global, so a second model set up
    alongside the first does not serve the first one's face — and two entries
    of the same model still share one parse.

    ``entry_id`` is optional because one caller genuinely has no device in
    hand: the panel asks for a blueprint before it knows which remote is
    selected, and gets the default so it has something to draw.

    A failed parse is deliberately not cached. It returns a usable fallback so
    the panel still renders, but caching that would outlive the cause and hide
    a blueprint restored underneath a running instance.
    """
    store = hass.data.setdefault(DOMAIN, {})
    cache = store.setdefault(_BLUEPRINT_CACHE_KEY, {})
    blueprint_id = _blueprint_id(hass, entry_id)
    cached = cache.get(blueprint_id)
    if cached is not None:
        # Re-insert so the eviction below drops the face nobody is wearing.
        cache[blueprint_id] = cache.pop(blueprint_id)
        return cached

    parsed = await hass.async_add_executor_job(_parse_blueprint, blueprint_id)
    if parsed.get("buttons"):
        cache[blueprint_id] = parsed
        while len(cache) > _BLUEPRINT_CACHE_MAX:
            cache.pop(next(iter(cache)))
    return parsed


async def _empty_page_assignments(
    hass: HomeAssistant, entry_id: str | None = None,
) -> dict[str, dict]:
    bp = await _async_blueprint(hass, entry_id)
    return {btn["key"]: dict(EMPTY_BUTTON) for btn in bp.get("buttons", [])}


async def _refresh_state_listener(hass: HomeAssistant, entry_id: str) -> None:
    entry_data = hass.data.get(DOMAIN, {}).get(entry_id, {})
    old_unsub = entry_data.get("state_unsub")
    if old_unsub:
        old_unsub()
    fresh = hass.config_entries.async_get_entry(entry_id)
    if fresh:
        entry_data["state_unsub"] = await setup_state_listener(hass, fresh)


@websocket_api.websocket_command({
    "type": "lizaip_config/list_devices",
    vol.Optional("language"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    if "language" in msg:
        hass.data.setdefault(DOMAIN, {})["_ui_language"] = msg["language"]

    dev_reg = dr.async_get(hass)
    devices = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is not ConfigEntryState.LOADED:
            continue
        entry_devices = dr.async_entries_for_config_entry(dev_reg, entry.entry_id)
        if not entry_devices:
            continue
        available = hasattr(entry, "runtime_data") and entry.runtime_data and entry.runtime_data.connected
        conn = entry.runtime_data if available else None
        dev = entry_devices[0]
        device_name = (dev.name_by_user or dev.name or "").strip()
        device_id = conn._device_id if conn else (entry.unique_id or entry.data.get("device_id"))
        title = device_name or (entry.title or "").strip() or device_id or entry.entry_id or "lizaIP"
        devices.append({
            "entry_id": entry.entry_id,
            "title": title,
            "available": available,
            "device_id": device_id,
            "sw_version": entry.data.get("sw_version"),
        })
    connection.send_result(msg["id"], devices)


@websocket_api.websocket_command({
    "type": "lizaip_config/get_blueprint",
    vol.Optional("entry_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_get_blueprint(hass: HomeAssistant, connection, msg: dict) -> None:
    """The face of one remote, or the default when the panel has not picked one.

    ``entry_id`` is optional rather than required because the panel loads the
    blueprint in the same opening round-trip as the device list -- it has
    nothing to name yet -- and asks again once a device is selected. Requiring
    it would mean an empty panel until the second request landed.
    """
    result = await _async_blueprint(hass, msg.get("entry_id"))
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({"type": "lizaip_config/get_actions", "entry_id": str})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_get_actions(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    store = _get_store(hass)
    connection.send_result(msg["id"], {"actions": await store.async_get_action_library(device_id)})


@websocket_api.websocket_command({
    "type": "lizaip_config/save_actions",
    "entry_id": str,
    vol.Required("actions"): list,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_save_actions(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:

    try:
        store = _get_store(hass)
        await store.async_set_action_library(device_id, msg["actions"])

        await _refresh_state_listener(hass, msg["entry_id"])
        await _fire_config_changed(hass, msg["entry_id"])

        connection.send_result(msg["id"], {"success": True})
    except Exception as exc:
        connection.send_error(msg["id"], "save_failed", str(exc))


@websocket_api.websocket_command({
    "type": "lizaip_config/get_assignments",
    "entry_id": str,
    vol.Optional("page_id", default=1): PAGE_ID_SCHEMA,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_get_assignments(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:

    page_id = msg.get("page_id", 1)
    store = _get_store(hass)
    assignments = await store.async_get_assignments(device_id, page_id)
    connection.send_result(msg["id"], {"assignments": assignments, "page_id": page_id})


@websocket_api.websocket_command({
    "type": "lizaip_config/get_all_assignments",
    "entry_id": str,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_get_all_assignments(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Every page's assignments in one answer.

    The panel's usage scan -- which action is still used, and where -- needs
    all of them, and used to ask page by page. That is one round trip per
    page on every config change, so the cost of editing anything grew with
    the number of pages; at a hundred pages it was a hundred round trips for
    a single rename.

    Keys are strings because JSON has no integer keys: the client reads them
    back as the strings it sends elsewhere, so page ids are stringified here
    rather than leaving each caller to guess which form it got.
    """
    store = _get_store(hass)
    all_assignments = await store.async_get_all_assignments(device_id)
    connection.send_result(msg["id"], {
        "assignments": {str(pid): assigns for pid, assigns in all_assignments.items()},
    })


@websocket_api.websocket_command({
    "type": "lizaip_config/save_assignments",
    "entry_id": str,
    vol.Optional("page_id", default=1): PAGE_ID_SCHEMA,
    vol.Required("assignments"): dict,
    vol.Optional("language"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_save_assignments(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Save a page's button assignments.

    Request payload:
      {type, entry_id, page_id?, language?, assignments: {button_key: assignment}}
    Response:
      {success: true}
    """
    if "language" in msg:
        hass.data.setdefault(DOMAIN, {})["_ui_language"] = msg["language"]


    page_id = msg.get("page_id", 1)
    assignments = msg["assignments"]

    try:
        store = _get_store(hass)

        blueprint = await _async_blueprint(hass, msg["entry_id"])
        all_btn_keys = [btn["key"] for btn in blueprint.get("buttons", [])]

        library = await store.async_get_action_library(device_id)
        lib_by_id = {a["id"]: a for a in library if "id" in a}

        # Existing bindings must survive a panel save. The panel rebuilds each
        # button from scratch and only sends the fields it knows about, so a
        # binding it never learned to round-trip would be destroyed the first
        # time a user touched anything on the page.
        stored = await store.async_get_assignments(device_id, page_id) or {}
        full_assignments: dict[str, dict] = {
            btn_key: _build_assignment_entry(
                assignments.get(btn_key) or {}, lib_by_id, btn_key,
                stored.get(btn_key),
            )
            for btn_key in all_btn_keys
        }
        # Cosmetic only: a missing registry (test doubles) just leaves the
        # editor-written target in place.
        registry = getattr(hass, "config_entries", None)
        config_entry = registry.async_get_entry(msg["entry_id"]) if registry else None
        for assign in full_assignments.values():
            _drop_own_device_target(hass, config_entry, assign)

        await store.async_set_assignments(device_id, page_id, full_assignments)
        await store.async_recompute_page_hash(device_id, page_id)

        await _fire_config_changed(hass, msg["entry_id"])
        await _refresh_state_listener(hass, msg["entry_id"])
        # Re-scan after whole-page saves so push subscriptions match stored bindings.
        _schedule_push_rescan(hass, msg["entry_id"])

        _LOGGER.info(
            "Saved %d assignments for %s (page=%s)",
            len(full_assignments), msg["entry_id"], page_id,
        )
        connection.send_result(msg["id"], {"success": True})
    except Exception as exc:
        _LOGGER.error("Save assignments failed: %s", exc)
        connection.send_error(msg["id"], "save_failed", str(exc))


def icon_options_for_entry(hass: HomeAssistant, entry_id: str) -> dict:
    """The icon-rendering settings for one entry, as the panel receives them.

    Kept out of the handler so it can be exercised without Home Assistant's
    websocket decorators, which replace the handler with a task-scheduling
    wrapper.

    Always answers: an unknown entry, or one whose options cannot be read,
    yields the default rather than an error, because the default is the right
    value for every entry that has not changed the setting and a panel left
    without a reply renders no preview at all.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    return _icon_options_reply(getattr(entry, "options", None))


def _icon_options_reply(options: object) -> dict:
    """The values plus what the gear tab needs to edit them."""
    return {
        "icon_fill_step": read_fill_step(options),
        "icon_fill_enabled": read_fill_enabled(options),
        "icon_color_enabled": read_color_enabled(options),
        "variables_enabled": read_variables_enabled(options),
        "variables_interval_ms": read_variables_interval(options),
        "defaults": {
            "icon_fill_step": DEFAULT_ICON_FILL_STEP,
            "icon_fill_enabled": DEFAULT_ICON_FILL_ENABLED,
            "icon_color_enabled": DEFAULT_ICON_COLOR_ENABLED,
            "variables_enabled": DEFAULT_VARIABLES_ENABLED,
            "variables_interval_ms": DEFAULT_VARIABLES_INTERVAL,
        },
        "limits": {
            "icon_fill_step": {"min": ICON_FILL_STEP_MIN, "max": ICON_FILL_STEP_MAX},
            "variables_interval_ms": {
                "min": VARIABLES_INTERVAL_MIN,
                "max": VARIABLES_INTERVAL_MAX,
                "step": VARIABLES_INTERVAL_STEP,
            },
        },
    }


def set_icon_options_for_entry(hass: HomeAssistant, entry_id: str, changes: dict) -> dict:
    """Save the icon options named in *changes*; returns the new reply.

    Stored in ``entry.options`` as before the gear tab took it over, so every
    reader keeps working and no migration is needed. The options update fires
    the entry's update listener, which resyncs the remote with the new values.

    A partial update, so one field can be changed without the caller sending
    back the two it is not touching and clobbering a concurrent change.

    Raises ``KeyError`` for an unknown entry and ``ValueError`` for a bad step
    or a non-boolean switch -- strictly, unlike `read_fill_step`, because a
    typo should be refused, not silently clamped.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        raise KeyError(entry_id)

    updates: dict = {}
    if CONF_ICON_FILL_STEP in changes:
        fill_step = changes[CONF_ICON_FILL_STEP]
        # bool is an int subclass; JSON `true` must not pass as 1.
        if (
            isinstance(fill_step, bool)
            or not isinstance(fill_step, int)
            or not ICON_FILL_STEP_MIN <= fill_step <= ICON_FILL_STEP_MAX
        ):
            raise ValueError(
                f"icon_fill_step must be a whole number from "
                f"{ICON_FILL_STEP_MIN} to {ICON_FILL_STEP_MAX}"
            )
        updates[CONF_ICON_FILL_STEP] = fill_step

    if CONF_VARIABLES_INTERVAL in changes:
        interval = changes[CONF_VARIABLES_INTERVAL]
        if (
            isinstance(interval, bool)
            or not isinstance(interval, int)
            or not VARIABLES_INTERVAL_MIN <= interval <= VARIABLES_INTERVAL_MAX
        ):
            raise ValueError(
                f"{CONF_VARIABLES_INTERVAL} must be a whole number of ms from "
                f"{VARIABLES_INTERVAL_MIN} to {VARIABLES_INTERVAL_MAX}"
            )
        updates[CONF_VARIABLES_INTERVAL] = interval

    for key in (CONF_ICON_FILL_ENABLED, CONF_ICON_COLOR_ENABLED, CONF_VARIABLES_ENABLED):
        if key in changes:
            value = changes[key]
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be true or false")
            updates[key] = value

    if updates:
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, **updates},
        )
    return _icon_options_reply({**entry.options, **updates})


@websocket_api.websocket_command({
    "type": "lizaip_config/get_icon_options",
    "entry_id": str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_get_icon_options(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report the icon-rendering settings the panel has to mirror.

    The panel draws its own preview of every button rather than fetching the
    device's images, so anything that changes how a tile is rendered has to
    reach it as a value. The brightness fill step is configurable per entry,
    and a panel still assuming the default would quietly disagree with the
    hardware it is supposed to be showing.

    Entry-scoped, unlike `get_features`: that answers what this *build*
    contains, which is the same for every entry, whereas this is a setting one
    entry can hold differently from the next.
    """
    connection.send_result(msg["id"], icon_options_for_entry(hass, msg["entry_id"]))


@websocket_api.websocket_command({
    "type": "lizaip_config/set_icon_options",
    "entry_id": str,
    vol.Optional("icon_fill_step"): object,
    vol.Optional("icon_fill_enabled"): object,
    vol.Optional("icon_color_enabled"): object,
    vol.Optional("variables_enabled"): object,
    vol.Optional("variables_interval_ms"): object,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_icon_options(hass: HomeAssistant, connection, msg: dict) -> None:
    """Save the icon-rendering settings edited in the gear tab."""
    changes = {
        key: msg[key]
        for key in ("icon_fill_step", "icon_fill_enabled", "icon_color_enabled", "variables_enabled",
                    "variables_interval_ms")
        if key in msg
    }
    try:
        reply = set_icon_options_for_entry(hass, msg["entry_id"], changes)
    except KeyError:
        connection.send_error(msg["id"], "not_found", "Config entry not found")
        return
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    connection.send_result(msg["id"], reply)


@websocket_api.websocket_command({"type": "lizaip_config/get_pages", "entry_id": str})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_get_pages(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    store = _get_store(hass)
    connection.send_result(msg["id"], {"pages": await store.async_get_pages(device_id)})


async def _reserved_page_ids(store, device_id: str, in_use: set[int]) -> set[int]:
    """Page ids unavailable to newly created pages.

    Ids are reserved while any stored goto button still points at them; otherwise
    a deleted page id could be recycled and a stale goto would open the wrong
    page. Page ids are 32-bit, so reserving a few is harmless.

    The reservation is not only the current page list: buttons can pin page ids
    inside their stored action payloads, and those stale references must stay
    harmless until the user repoints or deletes them.
    """
    reserved = set(in_use)
    for page_assigns in (await store.async_get_all_assignments(device_id)).values():
        for assign in (page_assigns or {}).values():
            if not isinstance(assign, dict):
                continue
            config = assign.get("config", [])
            step = (
                config[0]
                if isinstance(config, list) and config and isinstance(config[0], dict)
                else {}
            )
            reserved |= pinned_page_ids(step.get("data"), step_service(config))
    return reserved


def _deliverable_main_pages(conn, pages: list) -> list[int] | None:
    """The main-page order to push straight from the panel, or ``None``.

    `set_main_pages` is all-or-nothing -- naming one page the device does not
    hold makes it reject the whole order -- and a rejection arrives without a
    `seq_id`, costing the caller a ten-second timeout. So this shortcut is
    taken only when the device holds every main page and nothing has to be
    added first.

    Returning ``None`` costs nothing: the full sync that follows filters the
    order down to the pages that actually landed and sends it from there,
    which is what lets a remote with one unstorable page still be reordered.
    """
    if not _device_holds_every_page(conn, pages):
        return None
    return [p["id"] for p in pages if not is_subpage(p)]


def _device_holds_every_page(conn, pages: list) -> bool:
    """Whether the device holds every main page, so a sync has nothing to add.

    Narrowing a `config_changed` event to "order only" lets the sync skip
    rebuilding page payloads, which is only safe once there is nothing else
    for it to do. While one page is missing it still has to retry adding it.
    """
    known = getattr(conn, "_known_pages", None)
    return known is not None and all(
        p["id"] in known for p in pages if not is_subpage(p)
    )


def _reordered_pages(stored: list, incoming: list) -> list | None:
    """*incoming* as a pure reorder of *stored*, or ``None`` if it is not one.

    A reorder keeps every page and every field; only the sequence moves. Any
    page added, removed or edited means the caller has to take the full path,
    which rewrites the page files. The stored dicts are returned rather than
    the client's, so nothing the panel omitted can be dropped.
    """
    if len(stored) != len(incoming):
        return None

    by_id: dict = {}
    for page in stored:
        if not isinstance(page, dict) or not page.get("id"):
            return None
        by_id[page["id"]] = page

    out = []
    seen = set()
    for page in incoming:
        if not isinstance(page, dict):
            return None
        base = by_id.get(page.get("id"))
        if base is None or page["id"] in seen:
            return None
        # The panel echoes back the page it was given, so a field that differs
        # is an edit riding along with the move and has to take the slow path.
        merged = dict(base)
        merged.update(page)
        if merged != base:
            return None
        seen.add(page["id"])
        out.append(base)

    return out


async def _reorder_pages_fast(
    hass: HomeAssistant, connection, msg: dict, device_id: str, store, pages: list
) -> None:
    """Persist and push a page reorder, answering the panel before touching the device.

    Order is two lists of ids on disk (``page_order.yaml``, ``main_pages.yaml``)
    and one ``set_main_pages`` on the wire — PROTOCOL.md §"display order is
    defined solely by `set_main_pages`" — and page order is not part of
    ``compute_page_hash``, so no page payload changes and none needs resending.

    The reply goes out first. Everything after it is bookkeeping the panel does
    not have to wait on, and used to add a device round trip plus a full
    config-payload rebuild to the time a dragged thumbnail took to land.
    """
    await store.async_set_page_order(device_id, pages)
    connection.send_result(msg["id"], {"success": True, "pages": pages})

    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    conn = getattr(entry, "runtime_data", None) if entry else None
    order_only = False
    deliverable = (
        _deliverable_main_pages(conn, pages)
        if conn is not None and getattr(conn, "connected", False)
        else None
    )
    if deliverable is not None and deliverable == conn._known_main_pages:
        # Already the order the device holds. `set_main_pages` makes it rewrite
        # its whole page setup, so sending it again is work with no effect.
        deliverable = None
        order_only = _device_holds_every_page(conn, pages)
    if deliverable is not None:
        try:
            await conn.set_main_pages(deliverable)
            conn._known_main_pages = list(deliverable)
            order_only = _device_holds_every_page(conn, pages)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("set_main_pages after reorder failed: %s", err)
            # Forgetting the order is what makes the next sync notice it is
            # wrong and resend it; remembering a value we failed to write
            # would make the device's real order invisible. The page contents
            # go with it: a device that refused this is not a device we can
            # still claim to know.
            conn._known_pages = None
            conn._known_main_pages = None

    # Other open panels still learn about the move from this. It no longer sits
    # between the drop and the reply, which is the part that was felt, and when
    # the device is already in step it skips rebuilding every page payload --
    # measured at 124 ms on a 22-page remote, growing with the page count.
    await _fire_config_changed(hass, msg["entry_id"], order_only=order_only)


@websocket_api.websocket_command({
    "type": "lizaip_config/set_pages",
    "entry_id": str,
    vol.Required("pages"): list,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_set_pages(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Replace the ordered page list.

    Request payload:
      {type, entry_id, pages: [{id?, image, hash, ...}]}
    Response:
      {success: true, pages}
    """

    pages = msg["pages"]

    store = _get_store(hass)

    stored_pages = await store.async_get_pages(device_id)
    reordered = _reordered_pages(stored_pages, pages)
    if reordered is not None:
        await _reorder_pages_fast(hass, connection, msg, device_id, store, reordered)
        return

    reserved_ids = await _reserved_page_ids(
        store, device_id, {p["id"] for p in pages if p.get("id")}
    )
    # New pages must not inherit stored fields from a recycled id.
    is_new = [not p.get("id") for p in pages]
    minted_ids: set[int] = set()
    for p in pages:
        if not p.get("id"):
            new_id = generate_page_id(reserved_ids)
            p["id"] = new_id
            reserved_ids.add(new_id)
            minted_ids.add(new_id)

    # Preserve page fields the client did not send (layout/default_color/etc.):
    # async_set_pages is handed the whole list, so a field missing here would
    # be read as removed. The store writes only the files whose content moved,
    # so a pure reorder touches none of them. Reuses the read the reorder check
    # already did rather than paying for a second one.
    stored_by_id = {
        p["id"]: p for p in stored_pages
        if isinstance(p, dict) and p.get("id")
    }
    merged = []
    for p, fresh in zip(pages, is_new):
        base = {} if fresh else dict(stored_by_id.get(p["id"], {}))
        base.update(p)
        page = {"id": base["id"], "image": base.get("image", ""), "hash": base.get("hash", 0)}
        page.update({k: v for k, v in base.items() if k not in page})
        merged.append(page)
    pages = merged

    # A pure reorder: the same pages with the same content in new positions.
    # Decided here, while the store still holds the previous list -- once
    # async_set_pages runs, the old content is gone.
    order_only = set(stored_by_id) == {p["id"] for p in pages} and all(
        p == stored_by_id[p["id"]] for p in pages
    )

    existing_assignments = await store.async_get_all_assignments(device_id)
    empty = await _empty_page_assignments(hass, msg["entry_id"])
    for p in pages:
        # A freshly minted page is blanked even when the store already holds
        # assignments under its id. Ids are recycled once nothing points at them
        # any more, and the page that previously held this one is very often
        # deleted by this same call — its buttons are still in
        # `existing_assignments`, which is read before `async_set_pages` prunes
        # them. Seeding only on "id not present" therefore handed the new page
        # the dead page's buttons, fully configured and invisible in the panel
        # until the user opened it.
        if p["id"] in minted_ids or p["id"] not in existing_assignments:
            await store.async_set_assignments(device_id, p["id"], empty)

    await store.async_set_pages(device_id, pages)

    # The list is on disk, which is all the panel asked about. Answered now,
    # before the device is touched: `set_main_pages` waits for the page-sync
    # lock -- held for the whole of any running sync -- and then for a remote
    # that may be asleep, and a deleted page used to sit on screen for all of
    # that. The same split `_reorder_pages_fast` makes.
    connection.send_result(msg["id"], {"success": True, "pages": pages})
    # Deleted pages can remove the last binding for a push subscription. Only
    # scheduled, so it stays here rather than behind the device round trip.
    _schedule_push_rescan(hass, msg["entry_id"])
    try:
        await _push_page_list(hass, msg["entry_id"], pages, order_only)
    except Exception:  # noqa: BLE001 - the reply has gone; a raise would send a second one
        _LOGGER.exception("Pushing the page list after set_pages failed")


async def _push_page_list(
    hass: HomeAssistant, entry_id: str, pages: list, order_only: bool
) -> None:
    """Tell the device and the other panels about a page list already stored."""
    entry = hass.config_entries.async_get_entry(entry_id)
    order_pushed = False
    conn = None
    page_ids = None
    if entry and hasattr(entry, "runtime_data") and entry.runtime_data and entry.runtime_data.connected:
        conn = entry.runtime_data
        # PROTOCOL.md §set_main_pages: every id must already exist on the
        # device, and the call is all-or-nothing -- naming one page it does not
        # hold makes it reject the whole order, which is how reordering pages
        # 1-20 silently failed while a refused page sat in the list. So the
        # order carries only the pages the device actually holds, and goes out
        # under the lock the full sync holds so the two never interleave.
        page_ids = _deliverable_main_pages(conn, pages)
        if page_ids == conn._known_main_pages:
            # Unchanged: `set_main_pages` makes the device rewrite its whole
            # page setup, so it goes out only when the list actually moved --
            # not on every edit.
            page_ids = None
            order_pushed = _device_holds_every_page(conn, pages)
    if page_ids is None:
        _LOGGER.debug(
            "Leaving the page order to the full sync: the device does not "
            "hold every page yet",
        )
    else:
        async with conn._page_sync_lock:
            try:
                await conn.set_main_pages(page_ids)
                # Keep cache in sync so the next full sync does not see stale order.
                conn._known_main_pages = list(page_ids)
                order_pushed = _device_holds_every_page(conn, pages)
            except Exception as err:
                _LOGGER.warning("set_main_pages after set_pages failed: %s", err)
                # Both, not just the order: a half-remembered device state is
                # what made the next sync diff against pages it no longer knew
                # the device held.
                conn._known_pages = None
                conn._known_main_pages = None

    await _fire_config_changed(
        hass, entry_id, order_only=order_only and order_pushed
    )


@websocket_api.websocket_command({
    "type": "lizaip_config/update_page",
    "entry_id": str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("image"): str,
    vol.Optional("default_color"): str,
    vol.Optional(PAGE_SUBPAGE_KEY): bool,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_update_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Update page metadata while preserving other stored page fields.

    Request payload:
      {type, entry_id, page_id, image?, default_color?}
    Response:
      {success: true, pages}
    """

    page_id = msg["page_id"]

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    page = next((p for p in pages if p["id"] == page_id), None)
    if not page:
        connection.send_error(msg["id"], "page_not_found", f"Page {page_id} not found")
        return

    if "image" in msg:
        page["image"] = msg["image"]
    if "default_color" in msg:
        page["default_color"] = msg["default_color"]
    if PAGE_SUBPAGE_KEY in msg:
        # Written whether true or false: the store only keeps the key when it is
        # true, so clearing it is how a page becomes a main page again.
        page[PAGE_SUBPAGE_KEY] = msg[PAGE_SUBPAGE_KEY]

    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, page_id)
    pages = await store.async_get_pages(device_id)
    await _fire_config_changed(hass, msg["entry_id"])

    _LOGGER.debug("Updated page %s: image=%s, default_color=%s", page_id, page.get("image", ""), page.get("default_color", ""))
    connection.send_result(msg["id"], {"success": True, "pages": pages})


@websocket_api.websocket_command({
    "type": "lizaip_config/duplicate_page",
    "entry_id": str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_duplicate_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Copy a page under a new id, directly after the original.

    The copy keeps every stored page field -- including whether it is a
    subpage -- and gets its own deep copy of the button assignments, so editing
    one page never changes the other.

    Response:
      {success: true, page_id, pages}
    """
    entry_id = msg["entry_id"]
    source_id = msg["page_id"]

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    source_idx = next(
        (i for i, p in enumerate(pages) if isinstance(p, dict) and p.get("id") == source_id),
        None,
    )
    if source_idx is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {source_id} not found")
        return

    new_page_id = generate_page_id(
        await _reserved_page_ids(
            store, device_id, {p["id"] for p in pages if isinstance(p, dict)}
        )
    )
    new_page = copy.deepcopy(pages[source_idx])
    new_page["id"] = new_page_id
    new_page["hash"] = 0
    pages.insert(source_idx + 1, new_page)

    assignments = copy.deepcopy(await store.async_get_assignments(device_id, source_id))
    await store.async_set_assignments(device_id, new_page_id, assignments)
    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, new_page_id)

    await _refresh_state_listener(hass, entry_id)
    await _fire_config_changed(hass, entry_id)
    # The copy carries the same dynamic bindings, which need push subscriptions.
    _schedule_push_rescan(hass, entry_id)

    pages = await store.async_get_pages(device_id)
    _LOGGER.info("Duplicated page %s as %s for device %s", source_id, new_page_id, device_id)
    connection.send_result(msg["id"], {
        "success": True,
        "page_id": new_page_id,
        "pages": pages,
    })


@websocket_api.websocket_command({
    "type": "lizaip_config/goto_page",
    "entry_id": str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
})
@websocket_api.async_response
async def ws_goto_page(hass: HomeAssistant, connection, msg: dict) -> None:
    """Send a 32-bit page id to the device without changing stored page order."""
    entry_id = msg["entry_id"]
    entry = hass.config_entries.async_get_entry(entry_id)
    if not entry or not hasattr(entry, "runtime_data") or not entry.runtime_data:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    conn = entry.runtime_data
    if not conn.connected:
        connection.send_error(msg["id"], "not_connected", "Device not connected")
        return
    page_id = msg["page_id"]
    try:
        await conn.goto_page(page_id)
        connection.send_result(msg["id"], {"success": True})
    except Exception as err:
        connection.send_error(msg["id"], "failed", str(err))


@websocket_api.websocket_command({
    "type": "lizaip_config/clear_device_pages",
    "entry_id": str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_clear_device_pages(hass: HomeAssistant, connection, msg: dict) -> None:
    """Wipe every page off the device, then rebuild it from the store.

    This is the protocol's full re-sync (PROTOCOL.md §clear_all) and the way
    back from a device whose page table no longer matches what it reports --
    stale pages, a half-written setup, a firmware that has run out of room.
    Nothing is lost: the store is the source of truth and the rebuild follows
    immediately.

    Held under the same lock as an ordinary sync, so a scheduled one cannot
    land between the wipe and the rebuild and write pages into a device that is
    halfway through being emptied.
    """
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if not entry or not getattr(entry, "runtime_data", None):
        connection.send_error(msg["id"], "not_found", "Device not found")
        return
    conn = entry.runtime_data
    if not conn.connected:
        connection.send_error(msg["id"], "not_connected", "Device not connected")
        return
    try:
        async with conn._page_sync_lock:
            await conn.clear_all()
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "failed", str(err))
        return

    # Outside the lock: `sync_config_to_device` takes it itself.
    rebuilt = await sync_config_to_device(hass, entry)
    connection.send_result(msg["id"], {"success": True, "rebuilt": rebuilt})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_icon_defaults"})
@websocket_api.async_response
async def ws_get_icon_defaults(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return icon default mappings loaded from icon_defaults.yaml."""
    connection.send_result(msg["id"], ICON_DEFAULTS)


async def _async_list_fonts(hass: HomeAssistant) -> list[dict[str, str]]:
    return await hass.async_add_executor_job(list_fonts, user_fonts_dir(hass))


def _settings_reply(settings: dict, fonts: list[dict[str, str]]) -> dict:
    return {
        "settings": settings,
        "defaults": default_settings(),
        "fonts": fonts,
        "limits": {
            kind: dict(zip(("min", "max"), font_size_limits(kind))) for kind in TEXT_KINDS
        },
    }


@websocket_api.websocket_command({
    "type": "lizaip_config/get_settings",
    "entry_id": str,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_get_settings(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """The remote's text settings, with what the editor needs to change them.

    ``fonts`` is re-read on every call, so a font dropped into the font folder
    shows up the next time the settings tab opens.
    """
    settings = await _get_store(hass).async_get_settings(device_id)
    fonts = await _async_list_fonts(hass)
    connection.send_result(msg["id"], _settings_reply(settings, fonts))


@websocket_api.websocket_command({
    "type": "lizaip_config/set_settings",
    "entry_id": str,
    vol.Required("settings"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_set_settings(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Save the text settings and redraw the remote's pages with them."""
    fonts = await _async_list_fonts(hass)
    store = _get_store(hass)
    # What the remote has now, so a font that went missing since it was chosen
    # is carried through rather than refusing the save -- see validate_settings.
    stored = await store.async_get_settings(device_id)
    try:
        settings = validate_settings(msg["settings"], {f["id"] for f in fonts}, stored)
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    stored = await store.async_set_settings(device_id, settings)
    await _fire_config_changed(hass, msg["entry_id"])
    connection.send_result(msg["id"], _settings_reply(stored, fonts))


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_palette"})
@websocket_api.async_response
async def ws_get_palette(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return icon-tint swatches from imgserv's renderable color palette.

    The panel stores the selected hex as ``default_color`` and sends it back as
    ``?fg=`` on icon URLs, so the choices must be colors imgserv can render.
    """
    connection.send_result(msg["id"], {"colors": build_palette()})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/get_action_labels",
    vol.Optional("entry_id"): str,
    vol.Optional("language"): str,
})
@websocket_api.async_response
async def ws_get_action_labels(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return translated action labels for the device language, with English fallback.

    The panel and device share ``translations/<lang>.json`` so labels cannot
    drift; an entry-pinned language outranks the browser language.

    Response payload:
      {language, labels}
    """
    entry = (
        hass.config_entries.async_get_entry(msg["entry_id"])
        if msg.get("entry_id") else None
    )
    # Precedence lives in `get_ui_language`, so it cannot drift per call site.
    lang = get_ui_language(hass, entry, fallback=msg.get("language"))
    # A no-op once setup has run, which is always the case by the time a panel
    # can send this — kept so the command does not depend on that ordering to
    # stay off the disk.
    await async_preload_action_labels(hass)
    labels = {**load_action_labels("en"), **load_action_labels(lang)}
    connection.send_result(msg["id"], {"language": lang, "labels": labels})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_slider_controls"})
@websocket_api.async_response
async def ws_get_slider_controls(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return static slider capabilities; authenticated but not admin-gated.

    The table is public domain capability data, not user home data, matching the
    non-admin ``get_icon_defaults`` command.
    """
    connection.send_result(msg["id"], {"controls": serialized_controls()})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_internal_commands"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_get_internal_commands(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return device-local command descriptors consumed by the panel.

    Serving the registry keeps internal command labels/icons out of JavaScript;
    future device-local commands should be backend-only additions.
    """
    connection.send_result(msg["id"], {"commands": panel_descriptors()})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/list_layouts"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_layouts(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return layout metadata: {id, name, icon, description, target_selector}."""
    layouts = await hass.async_add_executor_job(list_layouts)
    connection.send_result(msg["id"], {"layouts": layouts})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_layout_devices",
    vol.Required("layout_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_layout_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """List devices matching a layout's integration and primary domain.

    Server-side filtering keeps the panel from reimplementing device/entity
    registry joins and guarantees the later add-page validation matches it.
    """
    from homeassistant.helpers import device_registry as dr
    from homeassistant.helpers import entity_registry as er

    layout_id = msg["layout_id"]
    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "not_found", f"Layout '{layout_id}' not found")
        return

    device_sel = (layout.get("target_selector") or {}).get("device") or {}
    if not device_sel:
        connection.send_error(
            msg["id"], "invalid_layout", f"Layout '{layout_id}' does not target a device"
        )
        return

    integration = device_sel.get("integration")
    primary_domain = device_sel.get("primary_domain")

    entry_ids = {e.entry_id for e in hass.config_entries.async_entries(integration)} if integration else None

    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    devices = []
    for device in dev_reg.devices:
        if device.disabled_by is not None:
            continue
        # `config_entries`, not `config_entry_id`: these are other integrations'
        # devices. A device restored from before HA 2026.8 can still report
        # several entries, and HA deliberately exempts those from the
        # deprecation. Narrowing to one id would hide such a device from the
        # picker.
        if entry_ids is not None and not (device.config_entries & entry_ids):
            continue
        domain_entities = _resolve_device_domain_entities(hass, device.id, integration, ent_reg)
        if primary_domain and primary_domain not in domain_entities:
            continue
        devices.append({
            "id": device.id,
            "name": device.name_by_user or device.name or device.id,
            "domains": sorted(domain_entities),
        })

    devices.sort(key=lambda d: d["name"].lower())
    connection.send_result(msg["id"], {"devices": devices})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_layout_config_entries",
    vol.Required("layout_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_layout_config_entries(hass: HomeAssistant, connection, msg: dict) -> None:
    """List config entries for layouts bound to an integration instance.

    The Hue layout binds to a bridge/config entry, not one lamp; the page is
    populated from everything that entry owns.
    """
    layout_id = msg["layout_id"]
    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "not_found", f"Layout '{layout_id}' not found")
        return

    entry_sel = (layout.get("target_selector") or {}).get("config_entry") or {}
    if not entry_sel:
        connection.send_error(
            msg["id"],
            "invalid_layout",
            f"Layout '{layout_id}' does not target a config entry",
        )
        return

    integration = entry_sel.get("integration")
    entries = [
        {"id": entry.entry_id, "title": entry.title or entry.entry_id}
        for entry in hass.config_entries.async_entries(integration)
        if not entry.disabled_by
    ]
    entries.sort(key=lambda e: e["title"].lower())
    connection.send_result(msg["id"], {"entries": entries})


def _resolve_layout_target(
    hass: HomeAssistant,
    layout_id: str,
    layout: dict,
    target_device: str,
    target_config_entry: str,
) -> tuple[tuple[str, str] | None, str, dict[str, str]]:
    """Check a device or config entry against a layout's target selector.

    Shared by adding a layout page and by moving one to another device, so both
    accept exactly the same targets.

    Returns ``(error, target_entity, domain_entities)``; ``error`` is a
    ``(code, message)`` pair, or ``None`` when the target fits.
    """
    selector = layout.get("target_selector") or {}
    device_sel = selector.get("device") or {}
    entry_sel = selector.get("config_entry") or {}

    domain_entities: dict[str, str] = {}
    target_entity = ""

    if entry_sel:
        if not target_config_entry:
            return ("invalid_target", f"Layout '{layout_id}' needs a config entry to bind to"), "", {}
        integration = entry_sel.get("integration")
        target_entry = hass.config_entries.async_get_entry(target_config_entry)
        if target_entry is None or (integration and target_entry.domain != integration):
            return ("not_found", f"Config entry '{target_config_entry}' does not belong to "
                f"integration '{integration}' required by layout '{layout_id}'"), "", {}
        # Disabled entries own no live entities, so dynamic pages would stay empty.
        # Worded operation-neutral: this check also runs when retargeting an
        # existing page, where "before adding a page" was simply wrong.
        if target_entry.disabled_by:
            return ("invalid_target", f"Config entry '{target_config_entry}' is disabled; "
                f"enable it before using it for a '{layout_id}' page"), "", {}
    elif device_sel:
        if not target_device:
            return ("invalid_target", f"Layout '{layout_id}' needs a device to bind to"), "", {}
        # Device layouts need same-device sibling entities by service domain; an
        # entity selector cannot express androidtv_remote remote.* plus
        # media_player.* app-launch buttons.
        integration = device_sel.get("integration")
        # Match the picker: require the layout's integration, not just a domain.
        if integration:
            device = dr.async_get(hass).async_get(target_device)
            entry_ids = {
                e.entry_id for e in hass.config_entries.async_entries(integration)
            }
            # Deliberately the `config_entries` set — see the device picker
            # above. This must accept the same devices the picker offered.
            if not device or not (device.config_entries & entry_ids):
                return ("not_found", f"Device '{target_device}' does not belong to integration "
                    f"'{integration}' required by layout '{layout_id}'"), "", {}

        domain_entities = _resolve_device_domain_entities(
            hass, target_device, integration
        )
        if not domain_entities:
            return ("not_found", f"Device '{target_device}' has no usable entities"), "", {}
        primary_domain = device_sel.get("primary_domain")
        target_entity = domain_entities.get(primary_domain) if primary_domain else ""
        if not target_entity:
            return ("not_found", f"Device '{target_device}' has no '{primary_domain}' entity required by layout '{layout_id}'"), "", {}
    else:
        return ("invalid_layout", f"Layout '{layout_id}' declares no device or config entry selector"), "", {}

    return None, target_entity, domain_entities


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/add_layout_page",
    vol.Required("entry_id"): str,
    vol.Required("layout_id"): str,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_add_layout_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Create a page from a layout, bound to a device or config entry target.

    Config-entry layouts have no primary entity; their grids come from dynamic
    sources filtered to that entry.

    Response payload:
      {success: true, page_id, pages}
    """
    entry_id = msg["entry_id"]
    layout_id = msg["layout_id"]
    target_device = msg.get("target_device") or ""
    target_config_entry = msg.get("target_config_entry") or ""


    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "layout_error", f"Layout '{layout_id}' not found")
        return

    error, target_entity, domain_entities = _resolve_layout_target(
        hass, layout_id, layout, target_device, target_config_entry,
    )
    if error:
        connection.send_error(msg["id"], *error)
        return

    layout = await resolve_layout_variables(
        hass, layout, target_entity, domain_entities or None, target_config_entry,
    )

    # Layout generation is the only place target-specific variables become
    # stored action-library entries and button assignments.
    new_actions, assignments = layout_generate_assignments(
        layout_id, target_entity, layout, domain_entities or None, hass
    )

    if not assignments:
        connection.send_error(msg["id"], "layout_error", f"Layout '{layout_id}' produced no assignments")
        return

    store = _get_store(hass)

    existing_lib = await store.async_get_action_library(device_id)
    existing_by_id = {a["id"]: i for i, a in enumerate(existing_lib) if "id" in a}
    for action in new_actions:
        if action["id"] in existing_by_id:
            existing_lib[existing_by_id[action["id"]]] = action
        else:
            existing_lib.append(action)
    await store.async_set_action_library(device_id, existing_lib)

    layout_meta = None
    all_layouts = await hass.async_add_executor_job(list_layouts)
    for lt in all_layouts:
        if lt["id"] == layout_id:
            layout_meta = lt
            break

    # `page_image` may hold `${…}` variables, which the picker cannot draw, so
    # it is kept apart from the `icon` the picker shows.
    page_icon = (
        (layout_meta.get("page_image") or layout_meta["icon"])
        if layout_meta else "mdi:remote"
    )

    pages = await store.async_get_pages(device_id)
    existing_ids = {p["id"] for p in pages if isinstance(p, dict)}
    new_page_id = generate_page_id(
        await _reserved_page_ids(store, device_id, existing_ids)
    )

    new_page = {
        "id": new_page_id,
        "image": page_icon,
        "hash": 0,
        "layout": {
            "type": layout_id,
            "target": {
                "entity_id": target_entity,
                **({"device": target_device} if target_device else {}),
                **(
                    {"config_entry": target_config_entry}
                    if target_config_entry else {}
                ),
            },
        },
    }
    pages.append(new_page)
    await store.async_set_pages(device_id, pages)

    bp = await _async_blueprint(hass, msg["entry_id"])
    all_keys = [btn["key"] for btn in bp.get("buttons", [])]
    for key in all_keys:
        if key not in assignments:
            assignments[key] = dict(EMPTY_BUTTON)

    await store.async_set_assignments(device_id, new_page_id, assignments)
    await store.async_recompute_page_hash(device_id, new_page_id)

    await _refresh_state_listener(hass, entry_id)
    await _fire_config_changed(hass, entry_id)
    # Re-scan after writes so new dynamic bindings get push subscriptions; the
    # scanner re-reads stored pages.
    _schedule_push_rescan(hass, entry_id)

    pages = await store.async_get_pages(device_id)

    _LOGGER.info(
        "Added layout page '%s' (layout=%s, target=%s) for device %s",
        new_page_id, layout_id, target_entity, device_id,
    )

    # Do not navigate here; the panel sends goto_page for every page-creation path.
    connection.send_result(msg["id"], {
        "success": True,
        "page_id": new_page_id,
        "pages": pages,
    })


#: Keys under which a stored button names the entity it acts on. Only values
#: found here are candidates for the dead-reference fallback below: a bare
#: `domain.name` string elsewhere is as likely a service (`light.toggle`).
_ENTITY_REFERENCE_KEYS: Final = frozenset({"entity_id", "entity", "target_entity"})


def _referenced_entities(value: Any, out: set[str]) -> set[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _ENTITY_REFERENCE_KEYS:
                for eid in item if isinstance(item, list) else [item]:
                    if isinstance(eid, str) and "." in eid:
                        out.add(eid)
            _referenced_entities(item, out)
    elif isinstance(value, list):
        for item in value:
            _referenced_entities(item, out)
    return out


def _rewrite_references(value: Any, pattern: re.Pattern, mapping: dict[str, str]) -> Any:
    """Return ``value`` with every whole-token reference in ``mapping`` swapped.

    Whole tokens, so `media_player.tv` does not rewrite `media_player.tv_2`
    and `select.tv` does not rewrite `input_select.tv`; inside strings too, so
    a template's `states('media_player.tv')` follows. Keys are left alone: a
    button's dicts are keyed by button, state or field, never by entity.
    """
    if isinstance(value, str):
        return pattern.sub(lambda m: mapping[m.group(0)], value)
    if isinstance(value, dict):
        return {k: _rewrite_references(v, pattern, mapping) for k, v in value.items()}
    if isinstance(value, list):
        return [_rewrite_references(v, pattern, mapping) for v in value]
    return value


#: Button fields that can actually name an entity to act on. Everything else
#: on a button -- `label`, `label_edited`, `action_id`, `state_icons`,
#: `internal_target_name` -- is presentation or identity metadata the user
#: wrote or that merely echoes it; it is left alone even when it happens to
#: contain an old entity id as plain text, because retargeting must not
#: rewrite what the user authored (only what the page itself depends on).
_ENTITY_BEARING_BUTTON_KEYS: Final = frozenset(
    {"config", ASSIGNMENT_LONGTOUCH_KEY, "overrides", "slider_actions", ASSIGNMENT_DYNAMIC_KEY}
)


def _rewrite_assignments(
    assignments: dict, pattern: re.Pattern, mapping: dict[str, str]
) -> dict:
    """Swap entity references inside stored button assignments.

    Walks only the entity-bearing fields of each button (see
    ``_ENTITY_BEARING_BUTTON_KEYS``); every other field is copied through
    unchanged.
    """
    result = {}
    for btn_key, btn_val in assignments.items():
        if not isinstance(btn_val, dict):
            result[btn_key] = btn_val
            continue
        new_btn = dict(btn_val)
        for field in _ENTITY_BEARING_BUTTON_KEYS:
            if field in new_btn:
                new_btn[field] = _rewrite_references(new_btn[field], pattern, mapping)
        result[btn_key] = new_btn
    return result


def _retarget_mapping(
    hass: HomeAssistant,
    old_target: dict,
    new_target: dict,
    old_domain_entities: dict[str, str],
    new_domain_entities: dict[str, str],
    referenced: set[str],
) -> dict[str, str]:
    """Which old references become which new ones.

    The old device's entities map to the new device's entity of the same
    domain. The old device may be gone -- often the reason it is being
    replaced -- and its entities with it, so an entity a button names that no
    longer exists at all also maps by domain. An entity that still exists and
    is not the old device's is the user's own addition, and is left alone.
    """
    mapping: dict[str, str] = {}
    for domain, old in old_domain_entities.items():
        new = new_domain_entities.get(domain)
        if new:
            mapping[old] = new
    old_entity = old_target.get("entity_id") or ""
    new_entity = new_target.get("entity_id") or ""
    if old_entity and new_entity:
        mapping[old_entity] = new_entity

    from homeassistant.helpers import entity_registry as er

    ent_reg = er.async_get(hass)
    for eid in referenced:
        if eid in mapping:
            continue
        if hass.states.get(eid) is not None or ent_reg.async_get(eid) is not None:
            continue
        new = new_domain_entities.get(eid.split(".", 1)[0])
        if new:
            mapping[eid] = new

    old_entry = old_target.get("config_entry") or ""
    new_entry = new_target.get("config_entry") or ""
    if old_entry and new_entry:
        mapping[old_entry] = new_entry
    old_device = old_target.get("device") or ""
    new_device = new_target.get("device") or ""
    if old_device and new_device:
        mapping[old_device] = new_device
    return {old: new for old, new in mapping.items() if old != new}


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/retarget_layout_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("target_device"): str,
    vol.Optional("target_config_entry"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_retarget_layout_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Point a layout page at another device (or hub), keeping its buttons.

    The page is not regenerated: buttons the user changed stay changed. Only
    references to the old target are swapped for the new one's, domain by
    domain. What the new device lacks keeps pointing where it did.

    Response:
      {success: true, pages, replaced: {old: new}, buttons_changed: n}
    """
    entry_id = msg["entry_id"]
    page_id = msg["page_id"]
    target_device = msg.get("target_device") or ""
    target_config_entry = msg.get("target_config_entry") or ""

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    page = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)
    if page is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {page_id} not found")
        return
    page_layout = page.get("layout") if isinstance(page.get("layout"), dict) else {}
    layout_id = page_layout.get("type") or ""
    if not layout_id:
        connection.send_error(msg["id"], "not_a_layout_page", f"Page {page_id} was not made from a layout")
        return

    layout = await hass.async_add_executor_job(load_layout, layout_id)
    if not layout:
        connection.send_error(msg["id"], "layout_error", f"Layout '{layout_id}' not found")
        return

    error, target_entity, new_domain_entities = _resolve_layout_target(
        hass, layout_id, layout, target_device, target_config_entry,
    )
    if error:
        connection.send_error(msg["id"], *error)
        return

    old_target = dict(page_layout.get("target") or {})
    new_target = {
        "entity_id": target_entity,
        **({"device": target_device} if target_device else {}),
        **({"config_entry": target_config_entry} if target_config_entry else {}),
    }
    integration = ((layout.get("target_selector") or {}).get("device") or {}).get("integration")
    old_device = old_target.get("device") or ""
    old_domain_entities = (
        _resolve_device_domain_entities(hass, old_device, integration) if old_device else {}
    )

    assignments = await store.async_get_assignments(device_id, page_id)
    buttons_changed = 0
    mapping = _retarget_mapping(
        hass, old_target, new_target, old_domain_entities, new_domain_entities,
        _referenced_entities(assignments, set()),
    )
    if mapping:
        pattern = re.compile(
            r"(?<![A-Za-z0-9_])("
            + "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
            + r")(?![A-Za-z0-9_])"
        )
        rewritten = _rewrite_assignments(assignments, pattern, mapping)
        buttons_changed = sum(1 for key in rewritten if rewritten[key] != assignments.get(key))
        if buttons_changed:
            await store.async_set_assignments(device_id, page_id, rewritten)

    page["layout"] = {**page_layout, "target": new_target}
    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, page_id)

    await _refresh_state_listener(hass, entry_id)
    await _fire_config_changed(hass, entry_id)
    _schedule_push_rescan(hass, entry_id)
    # Dynamic buttons list what the *new* device offers -- its apps, its
    # inputs -- and only a refresh reads that.
    _schedule_page_refresh(hass, entry_id, page_id)

    _LOGGER.info(
        "Moved layout page %s (%s) from %s to %s: %d button(s) changed",
        page_id, layout_id, old_target, new_target, buttons_changed,
    )
    connection.send_result(msg["id"], {
        "success": True,
        "pages": await store.async_get_pages(device_id),
        "replaced": mapping,
        "buttons_changed": buttons_changed,
    })


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/browse_media",
    vol.Required("entity_id"): str,
    vol.Optional("media_content_type", default=""): str,
    vol.Optional("media_content_id", default=""): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_browse_media(hass: HomeAssistant, connection, msg: dict) -> None:
    """Browse media and return plain JSON for button assignments."""
    entity_id = msg["entity_id"]
    media_content_type = msg.get("media_content_type", "")
    media_content_id = msg.get("media_content_id", "")

    try:
        from homeassistant.components.media_player import (
            BrowseMedia,
        )
        from homeassistant.components.media_player import (
            async_browse_media as mp_browse,
        )
    except ImportError:
        try:
            from homeassistant.components.media_player import BrowseMedia
            mp_browse = None
        except ImportError:
            connection.send_error(msg["id"], "not_supported", "media_player component not available")
            return

    try:
        if mp_browse:
            result: BrowseMedia = await mp_browse(
                hass, entity_id, media_content_type or None, media_content_id or None,
            )
        else:
            state = hass.states.get(entity_id)
            if not state:
                connection.send_error(msg["id"], "not_found", f"Entity {entity_id} not found")
                return
            component = hass.data.get("media_player")
            if not component:
                connection.send_error(msg["id"], "not_supported", "media_player not loaded")
                return
            entity = component.get_entity(entity_id)
            if not entity or not hasattr(entity, "async_browse_media"):
                connection.send_error(msg["id"], "not_supported", f"{entity_id} doesn't support browse_media")
                return
            result = await entity.async_browse_media(media_content_type or None, media_content_id or None)
    except Exception as exc:
        _LOGGER.warning("browse_media failed for %s: %s", entity_id, exc)
        connection.send_error(msg["id"], "browse_failed", str(exc))
        return

    def _serialize_item(item) -> dict:
        out = {
            "title": item.title or "",
            "media_content_type": item.media_content_type or "",
            "media_content_id": item.media_content_id or "",
            "can_play": getattr(item, "can_play", False),
            "can_expand": getattr(item, "can_expand", False),
            "thumbnail": item.thumbnail or "",
        }
        return out

    items = []
    if hasattr(result, "children") and result.children:
        for child in result.children:
            items.append(_serialize_item(child))

    connection.send_result(msg["id"], {
        "title": result.title or "",
        "media_content_type": result.media_content_type or "",
        "media_content_id": result.media_content_id or "",
        "can_play": getattr(result, "can_play", False),
        "can_expand": getattr(result, "can_expand", False),
        "thumbnail": result.thumbnail or "",
        "children": items,
    })



@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_dynamic_sources",
})
@websocket_api.require_admin
@websocket_api.callback
def ws_list_dynamic_sources(hass: HomeAssistant, connection, msg: dict) -> None:
    connection.send_result(msg["id"], {
        "sources": [SOURCES[key].describe() for key in sorted(SOURCES)],
        "default_max_items": DEFAULT_MAX_ITEMS,
    })


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/preview_dynamic_source",
    vol.Required("source"): str,
    vol.Optional("spec", default=dict): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_preview_dynamic_source(hass: HomeAssistant, connection, msg: dict) -> None:
    """Preview dynamic-source items without storing a binding."""
    source_id = msg["source"]
    spec = msg.get("spec") or {}

    error = validate_spec(source_id, spec)
    if error:
        connection.send_error(msg["id"], "invalid_spec", error)
        return

    entry = await async_resolve_source(hass, source_id, spec, best_effort=True)
    connection.send_result(msg["id"], {
        "source": source_id,
        "items": [item.as_dict() for item in entry.items],
        "error": entry.error or "",
        "age": int(entry.age()),
    })


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/refresh_dynamic",
    vol.Required("entry_id"): str,
    vol.Optional("page_id"): PAGE_ID_SCHEMA,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_refresh_dynamic(hass: HomeAssistant, connection, msg: dict) -> None:
    try:
        changed = await layout_refresh.async_refresh_and_sync(
            hass,
            msg["entry_id"],
            page_id=msg.get("page_id"),
        )
    except Exception as exc:  # noqa: BLE001
        _LOGGER.error("Dynamic refresh failed for %s: %s", msg["entry_id"], exc)
        connection.send_error(msg["id"], "refresh_failed", str(exc))
        return

    connection.send_result(msg["id"], {"success": True, "changed": changed})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/set_dynamic_binding",
    vol.Required("entry_id"): str,
    vol.Optional("page_id", default=1): PAGE_ID_SCHEMA,
    vol.Required("button"): str,
    vol.Required("binding"): vol.Any(dict, None),
})
@websocket_api.require_admin
@websocket_api.async_response
@_requires_device
async def ws_set_dynamic_binding(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Set one button's dynamic binding; ``binding: null`` detaches without blanking."""

    page_id = msg.get("page_id", 1)
    button = msg["button"]
    binding = msg["binding"]

    if binding is not None:
        source_id = binding.get("source") or ""
        error = validate_spec(source_id, binding.get("spec") or {})
        if error:
            connection.send_error(msg["id"], "invalid_spec", error)
            return
        try:
            index = int(binding.get("index") or 0)
        except (TypeError, ValueError):
            index = 0
        if index < 1:
            connection.send_error(msg["id"], "invalid_spec", "index must be >= 1")
            return

    try:
        store = _get_store(hass)
        assignments = dict(await store.async_get_assignments(device_id, page_id) or {})
        assign = dict(assignments.get(button) or dict(EMPTY_BUTTON))

        if binding is None:
            assign.pop(ASSIGNMENT_DYNAMIC_KEY, None)
        else:
            source = get_source(binding.get("source") or "")
            assign[ASSIGNMENT_DYNAMIC_KEY] = {
                "source": binding.get("source"),
                "spec": binding.get("spec") or {},
                "index": index,
                # Track action only for sources whose items can change service.
                "fields": binding.get("fields") or (
                    source.default_fields if source else list(DEFAULT_TRACKED_FIELDS)
                ),
                "target_entity": binding.get("target_entity") or "",
                "identity": binding.get("identity") or "",
                "stale": False,
            }
        assignments[button] = assign

        await store.async_set_assignments(device_id, page_id, assignments)
        await store.async_recompute_page_hash(device_id, page_id)
    except Exception as exc:  # noqa: BLE001
        _LOGGER.error("set_dynamic_binding failed: %s", exc)
        connection.send_error(msg["id"], "save_failed", str(exc))
        return

    _schedule_push_rescan(hass, msg["entry_id"])

    changed = await layout_refresh.async_refresh_and_sync(
        hass, msg["entry_id"], page_id=page_id,
    )
    if not changed:
        await _fire_config_changed(hass, msg["entry_id"])

    connection.send_result(msg["id"], {"success": True})
