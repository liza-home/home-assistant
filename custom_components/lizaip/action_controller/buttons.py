"""Compiling and running the action behind a button press."""
from __future__ import annotations

import logging
from collections.abc import Mapping
from copy import deepcopy

import voluptuous as vol

from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import SCRIPT_MODE_PARALLEL, Script

from ..const import normalise_payload
from ..const import (
    CONF_OPTIMISTIC_UPDATES,
    DOMAIN,
    ENSURE_ON_SETTLE,
    ICON_UPDATE_EVENT,
    NEXT_STATE_MAP,
    PREDICTED_HA_STATE_MAP,
    build_ensure_on_prelude,
    build_launch_capture,
    build_launch_verification,
    catchall_state_icon,
    get_action_label,
    get_ui_language,
    is_state_toggle_service,
    resolve_icon_url,
    scope_action_states,
)
from ._state import (
    _DEFAULT_PAGE_ID,
    _SCRIPT_CACHE,
    get_selected_button,
)
from .helpers import (
    _get_store,
    _resolve_device_id,
    resolve_step_entity,
    service_name,
)
from .overrides import resolve_fixed_action

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Execute a button action
# ---------------------------------------------------------------------------

def _get_script(
    hass: HomeAssistant,
    device_id: str,
    page_id: int,
    button_key: str,
    actions: list,
) -> Script:
    """Return the cached Script, rebuilding when the source config changed."""
    cache_key = (device_id, page_id, button_key)
    cached = _SCRIPT_CACHE.get(cache_key)
    if cached is not None and cached[0] == actions:
        return cached[1]

    # cv.SCRIPT_SCHEMA compiles stored template strings before Script runs them.
    try:
        sequence = cv.SCRIPT_SCHEMA(actions)
    except vol.Invalid as exc:
        # Keep HA-accepted service calls running, but without template support.
        _LOGGER.warning(
            "Action config for %s/%s failed script validation (%s) — "
            "running unvalidated; templates in this action will not render",
            page_id, button_key, exc,
        )
        sequence = actions

    # Reused Scripts must allow rapid/auto-repeat presses.
    script = Script(
        hass,
        sequence,
        f"liza_{button_key}_click",
        DOMAIN,
        script_mode=SCRIPT_MODE_PARALLEL,
    )
    # Snapshot to detect later edits even if the caller mutates the list.
    _SCRIPT_CACHE[cache_key] = (deepcopy(actions), script)
    return script


#: Payload services whose commands are silently lost when the target sleeps.
#: Deliberately excludes POWER/send_command, toggles, volume and transport.
#: Mirrors panel ``_payloadServices`` minus ``send_command``.
_WAKE_BEFORE_SERVICES: frozenset[str] = frozenset({
    "play_media",
    "select_source",
    "select_sound_mode",
})

#: ``MediaPlayerDeviceClass.TV`` literal; avoid importing a non-manifest dependency.
_TV_DEVICE_CLASS = "tv"

#: ``MediaPlayerEntityFeature.TURN_ON`` literal. Only safe while every
#: ``_WAKE_BEFORE_SERVICES`` entry is media_player; bit 128 is domain-specific.
_TURN_ON_FEATURE = 128


def _inferred_prelude(hass: HomeAssistant, step: dict) -> list[dict]:
    """Infer a wake prelude for *step*, or return ``[]`` if it needs none.

    Decided at press time, not page-creation time, so the wake also reaches
    buttons a layout never saw (the panel builds `play_media` / `select_source`
    buttons of its own, and pages created before this existed).

    Two halves with different scopes:

    * The **wake gate** (`homeassistant.turn_on` + `wait_template`) is correct
      for any qualifying service on any domain, and free when already on.
    * The **settle** is not, so it is gated on `device_class: tv`, which
      `androidtv_remote/media_player.py` sets itself. An Android TV reports `on`
      about a second after the POWER keycode but needs ~ten more before it can
      service an app-link intent. Ungated, every Sonos favourite (`@favorites[N]`
      expands to `media_player.play_media`) would stall ten seconds waiting out
      a boot that never happens.

    An entity whose `supported_features` lacks `TURN_ON` is skipped — see
    `_TURN_ON_FEATURE`.

    Runs on every press over possibly hand-edited JSON, so every lookup is
    defensive; a state object may be missing for an unseen entity."""
    if not isinstance(step, dict):
        return []

    service = step.get("action") or step.get("service") or ""
    if not isinstance(service, str) or "." not in service:
        return []
    if service_name(service) not in _WAKE_BEFORE_SERVICES:
        return []

    entity_id = resolve_step_entity(step, hass)
    if not entity_id or not isinstance(entity_id, str):
        return []

    settle = 0.0
    state = hass.states.get(entity_id)
    if state is not None:
        attributes = getattr(state, "attributes", None)
        if not isinstance(attributes, Mapping):
            attributes = {}
        device_class = attributes.get("device_class")
        features = attributes.get("supported_features")

        # Only an explicit int without TURN_ON suppresses; unknown still wakes.
        if (
            isinstance(features, int)
            and not isinstance(features, bool)
            and not features & _TURN_ON_FEATURE
        ):
            return []

        if device_class == _TV_DEVICE_CLASS:
            settle = ENSURE_ON_SETTLE

    return build_ensure_on_prelude(entity_id, settle)


#: Services whose outcome can be verified. Add one at a time: a wrong expected
#: value re-issues a command the user did not request.
_VERIFIABLE_SERVICES: frozenset[str] = frozenset({"play_media"})

#: Only app launches are observable in ``app_id``.
_APP_LAUNCH_CONTENT_TYPE = "app"


def _inferred_verification(
    hass: HomeAssistant, step: dict, retry_steps: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Infer a launch verification for *step*, or ``([], [])`` if it has none.

    The halves are returned separately because they are spliced into different
    places: the *capture* immediately before the button's own action, the
    *check* immediately after it.

    The wake prelude in front of a `play_media` is open-loop, and
    `androidtv_remote` writes the launch straight to its socket, so a drop is
    invisible at the service layer but visible at the state layer via `app_id`.
    This closes that loop.

    Emitted **only** for a `play_media` whose payload is an app launch — a
    `media_content_type` of `app`. That narrowness is load-bearing:

    * A Sonos favourite is also `media_player.play_media` with a
      `media_content_id`, but a speaker never publishes `app_id`. Verifying it
      would wait out the whole window, find `app_id` unchanged (absent both
      times) and re-issue the play — a duplicate command on a working button.
    * A `play_media` carrying a URL has no observable success signal either, and
      a retry with no success signal is a command re-issued at random.

    The payload is read through `normalise_payload` because HA nests
    `play_media` under a single `media:` field — the shape the shipped
    `android-tv.yaml` ORF button actually has. Reading `data["media_content_id"]`
    flat would find nothing on the one button this feature exists for.

    Reads no state at all: everything the check needs is resolved inside the
    script, which keeps the emitted sequence identical from press to press."""
    if not isinstance(step, dict):
        return [], []

    service = step.get("action") or step.get("service") or ""
    if not isinstance(service, str) or "." not in service:
        return [], []
    if service_name(service) not in _VERIFIABLE_SERVICES:
        return [], []

    entity_id = resolve_step_entity(step, hass)
    if not entity_id or not isinstance(entity_id, str):
        return [], []

    data = step.get("data") or step.get("service_data") or {}
    flat = normalise_payload(data)
    if flat.get("media_content_type") != _APP_LAUNCH_CONTENT_TYPE:
        return [], []
    expected = flat.get("media_content_id")
    if not expected or not isinstance(expected, str):
        return [], []

    return (
        [build_launch_capture(entity_id)],
        build_launch_verification(entity_id, expected, retry_steps),
    )


def _is_optimistic(hass: HomeAssistant, entry_id: str) -> bool:
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        _LOGGER.debug("Optimistic: entry %s not found", entry_id)
        return False
    enabled = entry.options.get(CONF_OPTIMISTIC_UPDATES, False)
    _LOGGER.debug(
        "Optimistic: entry %s options=%s → enabled=%s",
        entry_id, dict(entry.options), enabled,
    )
    return enabled


async def _fire_optimistic_update(
    hass: HomeAssistant,
    device_id: str,
    page_id: int,
    button_key: str,
    assign: dict,
    own_actions: list,
    entry_id: str | None = None,
) -> None:
    """Predict the next state and fire an immediate icon update.

    Only for toggle services whose next state is predictable via
    ``NEXT_STATE_MAP``. Stateless services (send_command, play_media, …) and
    attribute-setting ones (volume_set, …) are skipped — their outcome either
    has no icon or cannot be predicted from the current state alone.

    Uses the same resolution path as the real state listener
    (``_match_state_icon`` + ``resolve_icon_url``), so the optimistic icon
    matches what lands on confirmation — no flicker. A wrong prediction is
    self-correcting: the real ``EVENT_STATE_CHANGED`` overwrites it."""
    if not own_actions:
        _LOGGER.debug("Optimistic: no own_actions — skipping")
        return

    step = own_actions[0] if isinstance(own_actions[0], dict) else {}
    service = step.get("action") or step.get("service") or ""
    if not isinstance(service, str) or "." not in service:
        _LOGGER.debug("Optimistic: no valid service in step — skipping (step=%s)", step)
        return
    svc = service_name(service)

    if not is_state_toggle_service(svc):
        _LOGGER.debug("Optimistic: service '%s' is not a toggle service — skipping", service)
        return

    entity_id = resolve_step_entity(step, hass)
    if not entity_id:
        _LOGGER.debug("Optimistic: no entity_id resolved from step — skipping")
        return

    state = hass.states.get(entity_id)
    if state is None:
        _LOGGER.debug("Optimistic: entity %s has no state — skipping", entity_id)
        return

    action_id = assign.get("action_id")
    if not action_id:
        _LOGGER.debug("Optimistic: no action_id on assignment — skipping")
        return

    store = _get_store(hass)
    lib = await store.async_get_action_library(device_id)
    action_def = next((a for a in lib if a.get("id") == action_id), None)
    if not action_def:
        _LOGGER.debug(
            "Optimistic: action_id '%s' not found in library — skipping", action_id,
        )
        return

    # Predict from state-machine knowledge, not icon rule ordering.
    predicted_ha_state = PREDICTED_HA_STATE_MAP.get(state.state)
    if not predicted_ha_state:
        _LOGGER.debug(
            "Optimistic: current state '%s' has no predicted successor — skipping",
            state.state,
        )
        return

    # Look up the icon for the predicted state from the action library's rules.
    state_rules = [
        r for r in scope_action_states(
            action_def.get("service", ""), action_def.get("states"),
        )
        if not r.get("attribute")  # Attribute rules are not predictable from state alone.
    ]
    matching_rule = next(
        (r for r in state_rules if r.get("state") == predicted_ha_state), None,
    )
    if not matching_rule:
        _LOGGER.debug(
            "Optimistic: no icon rule for predicted state '%s' in action '%s' "
            "(available rules: %s) — skipping",
            predicted_ha_state, action_id,
            [r.get("state") for r in state_rules],
        )
        return

    action_icon = matching_rule.get("icon")

    if not action_icon:
        _LOGGER.debug("Optimistic: predicted rule has no icon — skipping")
        return

    # Tooltip action keys can differ from HA states; NEXT_STATE_MAP has the key.
    predicted_action_key = NEXT_STATE_MAP.get(state.state, predicted_ha_state)

    state_icons = assign.get("state_icons") or {}
    override = state_icons.get(predicted_ha_state) or catchall_state_icon(
        state_icons, state.entity_id.split(".")[0], predicted_ha_state, svc,
    )

    icon = override if override else action_icon

    pages = await store.async_get_pages(device_id)
    page_color = ""
    for p in pages:
        if p.get("id", _DEFAULT_PAGE_ID) == page_id:
            page_color = p.get("default_color", "")
            break

    resolved = resolve_icon_url(icon, color=page_color)

    # Use the device language; the correcting state listener uses the same entry.
    entry = hass.config_entries.async_get_entry(entry_id) if entry_id else None
    lang = get_ui_language(hass, entry)
    tooltip_label = get_action_label(predicted_action_key, lang)
    entity_name = (
        state.attributes.get("friendly_name", "")
        or entity_id.split(".")[-1].replace("_", " ").title()
    )
    tooltip = f"{entity_name} {tooltip_label}" if entity_name else tooltip_label

    _LOGGER.debug(
        "Optimistic update: %s/%s → predicted %s → icon=%s tooltip=%s",
        page_id, button_key, predicted_ha_state, resolved, tooltip,
    )

    hass.bus.async_fire(ICON_UPDATE_EVENT, {
        "device_id": device_id,
        "updates": [{
            "page_id": page_id,
            "button_key": button_key,
            "icon": resolved,
            "tooltip": tooltip,
            "page_color": page_color,
        }],
    })


async def execute_action(
    hass: HomeAssistant,
    entry_id: str,
    button_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
) -> None:
    """Run the HA script action assigned to a clicked button."""
    device_id = _resolve_device_id(hass, entry_id)
    if not device_id:
        _LOGGER.warning("execute_action: device for entry %s not found", entry_id)
        return

    store = _get_store(hass)
    assignments = await store.async_get_assignments(device_id, page_id)
    # Overrides share the cache key with defaults, but _get_script validates by
    # action content so switching contexts rebuilds instead of running stale code.
    assign = resolve_fixed_action(assignments, get_selected_button(entry_id), button_key)
    if not assign or not isinstance(assign, dict):
        _LOGGER.info(
            "execute_action: no assignment for button '%s' on page %s "
            "(device=%s, assigned_keys=%s)",
            button_key, page_id, device_id,
            list(assignments.keys()) if assignments else "none",
        )
        return

    if not assign.get("action_id"):
        _LOGGER.debug("execute_action: no action_id for %s/%s", page_id, button_key)
        return

    actions = assign.get("config", [])
    if not isinstance(actions, list) or not actions:
        _LOGGER.debug("execute_action: empty action config for %s/%s", page_id, button_key)
        return

    # Preserve the button's own steps for verification retries.
    own_actions = actions

    # ``before`` is a sibling of ``config`` because panel/device_sync treat
    # ``config[0]`` as the action. Absence licenses inference; ``[]`` suppresses.
    before = assign.get("before")
    if before is None:
        before = _inferred_prelude(hass, actions[0])
        if before:
            _LOGGER.debug(
                "Inferred wake prelude for %s/%s (%s on %s): %s",
                page_id, button_key,
                actions[0].get("action") or actions[0].get("service"),
                resolve_step_entity(actions[0], hass), before,
            )

    # Keep wake/check conditions inside the script; Python-side state branching
    # would churn the Script cache on every state flip. ``after`` follows the
    # same sibling-key rule as ``before``; absence infers, ``[]`` suppresses.
    # Inferred verification captures after wake and before the action.
    capture: list[dict] = []
    after = assign.get("after")
    if after is None:
        capture, after = _inferred_verification(hass, own_actions[0], own_actions)
        if after:
            _LOGGER.debug(
                "Inferred launch verification for %s/%s: %s",
                page_id, button_key, after,
            )

    # Order: wake, capture, button action, check; non-list siblings are ignored.
    actions = own_actions
    if capture:
        actions = capture + actions
    if isinstance(before, list) and before:
        actions = before + actions
    if isinstance(after, list) and after:
        actions = actions + after

    script = _get_script(hass, device_id, page_id, button_key, actions)
    _LOGGER.info(
        "Executing %s (%d steps) for page=%s button=%s",
        script.name, len(script.sequence), page_id, button_key,
    )

    # Optimistic icon updates are corrected by the real state listener.
    if _is_optimistic(hass, entry_id):
        await _fire_optimistic_update(
            hass, device_id, page_id, button_key, assign, own_actions, entry_id,
        )
    try:
        # Context lets HA trace resulting service calls back to this press.
        await script.async_run(context=Context())
    except Exception:
        # User-authored action failures must not tear down device event dispatch.
        _LOGGER.exception("Action failed for %s/%s", page_id, button_key)
