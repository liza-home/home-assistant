"""WebSocket API handlers for the lizaIP configuration panel.

The voluptuous schemas below are the wire contract with ``panel/*.js``; handler
responses preserve the JSON shapes those views consume.
"""
from __future__ import annotations


import logging
import math
import os
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
    SLIDER_VERTICAL_KEY,
    SLIDER_TARGET_ENTITY,
    SLIDER_TARGET_LAST_TOUCHED,
    SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY,
    follows_selection_only,
    is_grid_button,
    last_touched_slider_actions,
    sanitize_slider_override,
    targets_entity,
    targets_last_touched,
    targets_last_touched_or_entity,
    serialized_controls,
    setup_state_listener,
)
from ..const import (
    DOMAIN,
    ICON_DEFAULTS,
    get_ui_language,
    load_action_labels,
)
from ..imgserv.const import build_palette
from .internal_commands import get_internal_command, panel_descriptors, pinned_page_ids
from .device_sync import step_targets_entry
from .const import (
    ASSIGNMENT_DYNAMIC_KEY,
    ASSIGNMENT_INTERNAL_TARGET_NAME_KEY,
    ASSIGNMENT_LABEL_EDITED_KEY,
    DEFAULT_BLUEPRINT_ID,
    PAGE_ID_SCHEMA,
    generate_page_id,
    payload_display,
    step_service,
)
from .snapshot import (  # noqa: F401  (re-exported; see test_config_imports)
    _fire_config_changed,
    _get_store,
    _resolve_device_id,
    build_full_config_payload,
)
from .device_entities import _resolve_device_domain_entities  # noqa: F401  (re-exported)
from .layouts import (
    DEFAULT_MAX_ITEMS,
    DEFAULT_TRACKED_FIELDS,
    SOURCES,
    async_resolve_source,
    generate_assignments as layout_generate_assignments,
    get_source,
    list_layouts,
    load_layout,
    resolve_layout_variables,
    validate_spec,
)
from .layouts import refresh as layout_refresh

_LOGGER = logging.getLogger(__name__)


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
        ws_save_assignments,
        ws_get_pages,
        ws_set_pages,
        ws_update_page,
        ws_get_icon_defaults,
        ws_get_palette,
        ws_get_action_labels,
        ws_get_slider_controls,
        ws_get_internal_commands,
        ws_goto_page,
        ws_list_layouts,
        ws_list_layout_devices,
        ws_list_layout_config_entries,
        ws_add_layout_page,
        ws_browse_media,
        ws_list_dynamic_sources,
        ws_preview_dynamic_source,
        ws_refresh_dynamic,
        ws_set_dynamic_binding,
    ):
        websocket_api.async_register_command(hass, handler)


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
        return cached

    parsed = await hass.async_add_executor_job(_parse_blueprint, blueprint_id)
    if parsed.get("buttons"):
        cache[blueprint_id] = parsed
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
        entry_devices = list(dev_reg.devices.get_devices_for_config_entry_id(entry.entry_id))
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

    reserved_ids = await _reserved_page_ids(
        store, device_id, {p["id"] for p in pages if p.get("id")}
    )
    # New pages must not inherit stored fields from a recycled id.
    is_new = [not p.get("id") for p in pages]
    for p in pages:
        if not p.get("id"):
            new_id = generate_page_id(reserved_ids)
            p["id"] = new_id
            reserved_ids.add(new_id)

    # Preserve page fields the client did not send (layout/default_color/etc.);
    # async_set_pages rewrites every page file, not only the changed page.
    stored_by_id = {
        p["id"]: p for p in await store.async_get_pages(device_id)
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

    existing_assignments = await store.async_get_all_assignments(device_id)
    empty = await _empty_page_assignments(hass, msg["entry_id"])
    for p in pages:
        if p["id"] not in existing_assignments:
            await store.async_set_assignments(device_id, p["id"], empty)

    await store.async_set_pages(device_id, pages)

    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry and hasattr(entry, "runtime_data") and entry.runtime_data and entry.runtime_data.connected:
        page_ids = [p["id"] for p in pages]
        try:
            await entry.runtime_data.set_main_pages(page_ids)
            # Keep cache in sync so the next full sync does not see stale order.
            entry.runtime_data._known_main_pages = list(page_ids)
        except Exception as err:
            _LOGGER.warning("set_main_pages after set_pages failed: %s", err)

    await _fire_config_changed(hass, msg["entry_id"])

    # Deleted pages can remove the last binding for a push subscription.
    _schedule_push_rescan(hass, msg["entry_id"])

    connection.send_result(msg["id"], {"success": True, "pages": pages})


@websocket_api.websocket_command({
    "type": "lizaip_config/update_page",
    "entry_id": str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("image"): str,
    vol.Optional("default_color"): str,
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

    await store.async_set_pages(device_id, pages)
    await store.async_recompute_page_hash(device_id, page_id)
    pages = await store.async_get_pages(device_id)
    await _fire_config_changed(hass, msg["entry_id"])

    _LOGGER.debug("Updated page %s: image=%s, default_color=%s", page_id, page.get("image", ""), page.get("default_color", ""))
    connection.send_result(msg["id"], {"success": True, "pages": pages})


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


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_icon_defaults"})
@websocket_api.async_response
async def ws_get_icon_defaults(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return icon default mappings loaded from icon_defaults.yaml."""
    connection.send_result(msg["id"], ICON_DEFAULTS)


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
    from homeassistant.helpers import device_registry as dr, entity_registry as er

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
    for device in dev_reg.devices.values():
        if device.disabled_by is not None:
            continue
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

    selector = layout.get("target_selector") or {}
    device_sel = selector.get("device") or {}
    entry_sel = selector.get("config_entry") or {}

    domain_entities: dict[str, str] = {}
    target_entity = ""

    if entry_sel:
        if not target_config_entry:
            connection.send_error(
                msg["id"],
                "invalid_target",
                f"Layout '{layout_id}' needs a config entry to bind to",
            )
            return
        integration = entry_sel.get("integration")
        target_entry = hass.config_entries.async_get_entry(target_config_entry)
        if target_entry is None or (integration and target_entry.domain != integration):
            connection.send_error(
                msg["id"],
                "not_found",
                f"Config entry '{target_config_entry}' does not belong to "
                f"integration '{integration}' required by layout '{layout_id}'",
            )
            return
        # Disabled entries own no live entities, so dynamic pages would stay empty.
        if target_entry.disabled_by:
            connection.send_error(
                msg["id"],
                "invalid_target",
                f"Config entry '{target_config_entry}' is disabled; "
                f"enable it before adding a '{layout_id}' page",
            )
            return
    elif device_sel:
        if not target_device:
            connection.send_error(
                msg["id"],
                "invalid_target",
                f"Layout '{layout_id}' needs a device to bind to",
            )
            return
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
            if not device or not (device.config_entries & entry_ids):
                connection.send_error(
                    msg["id"],
                    "not_found",
                    f"Device '{target_device}' does not belong to integration "
                    f"'{integration}' required by layout '{layout_id}'",
                )
                return

        domain_entities = _resolve_device_domain_entities(
            hass, target_device, integration
        )
        if not domain_entities:
            connection.send_error(
                msg["id"], "not_found", f"Device '{target_device}' has no usable entities"
            )
            return
        primary_domain = device_sel.get("primary_domain")
        target_entity = domain_entities.get(primary_domain) if primary_domain else ""
        if not target_entity:
            connection.send_error(
                msg["id"],
                "not_found",
                f"Device '{target_device}' has no '{primary_domain}' entity required by layout '{layout_id}'",
            )
            return
    else:
        connection.send_error(
            msg["id"],
            "invalid_layout",
            f"Layout '{layout_id}' declares no device or config entry selector",
        )
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

    page_icon = layout_meta["icon"] if layout_meta else "mdi:remote"

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
            async_browse_media as mp_browse,
            BrowseMedia,
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
