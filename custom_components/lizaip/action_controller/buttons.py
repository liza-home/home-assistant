"""Compiling and running the action behind a button press."""
from __future__ import annotations

import hashlib
import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.core import Context, HomeAssistant, State
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.script import SCRIPT_MODE_PARALLEL, Script

from ..config.internal_commands import get_internal_command
from ..config.text_style import longtouch_enabled, settings_theme, toggle_enabled
from ..const import CONF_OPTIMISTIC_UPDATES, DOMAIN, SIGNAL_ICON_UPDATE
from ..shared.preludes import (
    ENSURE_ON_SETTLE,
    build_ensure_on_prelude,
    build_launch_capture,
    build_launch_verification,
)
from ..shared.services import (
    PREDICTED_HA_STATE_MAP,
    attribute_toggle_template,
    is_state_toggle_service,
    normalise_payload,
    service_name,
    service_to_attribute,
    toggles_attribute,
)
from ..shared.tokens import (
    button_scope,
    clean_tooltip_text,
    page_scope,
)
from ..shared.i18n import get_ui_language, language_scope
from ..shared.logs import device_id_logger, device_logger
from ..shared.assignment import longtouch_steps
from ..shared.icon_urls import resolve_icon_url
from ..state_icon import entity_icon_style, read_icon_style_options
from ._state import (
    _DEFAULT_PAGE_ID,
    advance_cycle,
    cycle_index,
    get_selected_button,
)
from ..runtime import entry_connection, get_store, resolve_device_id
from .helpers import first_step, resolve_step_entity
from .icons import _compute_next_state_tooltip, _match_state_icon, toggle_icon
from .overrides import resolve_fixed_action
from .toggle import (
    MODE_CYCLE,
    TOGGLE_KEY,
    resolve_rule_tooltip,
    rule_steps,
    runtime_assign,
    step_tooltip,
    toggle_mode,
    toggle_rules,
)

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Execute a button action
# ---------------------------------------------------------------------------

def _script_cache(
    hass: HomeAssistant, entry_id: str,
) -> dict[tuple[int, str], tuple[str, Script]] | None:
    """Return the compiled-Script cache living on the entry's connection.

    ``None`` means the entry is gone or unloaded. Callers must not fall back to
    an uncached Script: every ``Script`` registers itself in ``hass.data`` with a
    strong reference, so one that nobody can reach later is one that leaks until
    Home Assistant restarts.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        return None
    return getattr(entry_connection(entry), "script_cache", None)


def _actions_fingerprint(actions: list) -> str:
    """A stable digest of an action list, for spotting edits.

    The cache used to keep a `deepcopy` of the actions beside the compiled
    Script purely to compare against next time -- a second full copy of every
    button's action tree, held for as long as the entry is loaded. The digest
    answers the same question in a few dozen bytes.

    `repr` rather than a serialiser because it is cheap and the content is
    plain scalars, lists and dicts read from YAML. It distinguishes values a
    serialiser might flatten (`1` from `"1"`, `True` from `1`), which is the
    safe direction: a false "changed" recompiles a Script, a false "unchanged"
    would run the button's old behaviour until the next reload.
    """
    return hashlib.md5(repr(actions).encode()).hexdigest()


async def _get_script(
    hass: HomeAssistant,
    entry_id: str,
    page_id: int,
    button_key: str,
    actions: list,
    gesture: str = "click",
    step: int | None = None,
) -> Script | None:
    """Return the cached Script, rebuilding when the source config changed.

    *step* is a cycle button's step: each keeps a Script of its own, so a
    press of the next step neither recompiles nor stops the one still running.
    """
    log = device_logger(_LOGGER, hass.config_entries.async_get_entry(entry_id))
    cache = _script_cache(hass, entry_id)
    if cache is None:
        log.warning(
            "No script cache — the entry is unloaded; "
            "skipping %s/%s", page_id, button_key,
        )
        return None

    # A click keeps the key it always had; a long touch is a second script on
    # the same button.
    cache_key = (page_id, button_key) if gesture == "click" else (page_id, f"{button_key}:{gesture}")
    if step is not None:
        cache_key = (page_id, f"{cache_key[1]}#{step}")
    fingerprint = _actions_fingerprint(actions)
    cached = cache.get(cache_key)
    if cached is not None and cached[0] == fingerprint:
        return cached[1]

    # cv.SCRIPT_SCHEMA compiles stored template strings before Script runs them.
    try:
        sequence = cv.SCRIPT_SCHEMA(actions)
    except vol.Invalid as exc:
        # Keep HA-accepted service calls running, but without template support.
        log.warning(
            "Action config for %s/%s failed script validation (%s) — "
            "running unvalidated; templates in this action will not render",
            page_id, button_key, exc,
        )
        sequence = actions

    # Reused Scripts must allow rapid/auto-repeat presses.
    script = Script(
        hass,
        sequence,
        f"liza_{button_key}_{gesture}",
        DOMAIN,
        script_mode=SCRIPT_MODE_PARALLEL,
    )
    # Keyed by content, so a later edit recompiles even if the caller mutated
    # the list it handed in.
    cache[cache_key] = (fingerprint, script)
    if cached is not None:
        # Build first, then retire the old one: the superseded Script holds
        # condition listeners and sub-scripts that only `async_unload` releases.
        await _retire_script(cached[1])
    return script


async def _retire_script(script: Script) -> None:
    """Unload a superseded Script, unless a run of it is still going.

    `async_unload` stops in-flight runs; an IR sequence halfway through its
    delays would be cut off. A running one is left to finish and be collected.
    """
    if script.is_running:
        return
    await script.async_unload()


async def _evict_cycle_steps(
    hass: HomeAssistant, entry_id: str, page_id: int, button_key: str, count: int,
) -> None:
    """Drop the Scripts of cycle steps a shortened rule list no longer has."""
    cache = _script_cache(hass, entry_id)
    if not cache:
        return
    prefix = f"{button_key}#"
    for key in list(cache):
        if key[0] != page_id or not key[1].startswith(prefix):
            continue
        index = key[1][len(prefix):]
        if index.isdigit() and int(index) >= count:
            await _retire_script(cache.pop(key)[1])


async def async_unload_scripts(hass: HomeAssistant, entry_id: str) -> None:
    """Release every compiled Script held for a config entry.

    Called from `async_unload_entry` while `runtime_data` is still reachable.
    Without this each reload would strand a full set of Scripts — and their
    condition caches and sub-script trees — in `hass.data` for the rest of the
    Home Assistant run.
    """
    cache = _script_cache(hass, entry_id)
    if not cache:
        return
    log = device_logger(_LOGGER, hass.config_entries.async_get_entry(entry_id))
    for key in list(cache):
        _, script = cache.pop(key)
        try:
            await script.async_unload()
        except Exception:  # noqa: BLE001
            # Teardown must not fail the unload; a stuck Script is better than
            # an entry that cannot be removed.
            log.debug("Unloading script %s failed", key, exc_info=True)
    log.debug("Released compiled scripts")


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
    buttons a template never saw (the panel builds `play_media` / `select_source`
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
    if _launch_step(hass, step) is not None:
        # Started over the TV's own API, and a Samsung reports no ``app_id``.
        return [], []

    return (
        [build_launch_capture(entity_id)],
        build_launch_verification(entity_id, expected, retry_steps),
    )


def _launch_step(hass: HomeAssistant, step: Any) -> dict | None:
    """``lizaip.launch_app`` for an app launch on a Samsung TV, else ``None``.

    Such a TV drops the launch ``media_player.play_media`` sends, so the step
    is rerouted when the button runs; the button keeps its ``play_media``.
    """
    from ..config.page_templates.samsung_tv import samsung_host

    if not isinstance(step, dict):
        return None
    if (step.get("action") or step.get("service")) != "media_player.play_media":
        return None
    flat = normalise_payload(step.get("data") or step.get("service_data") or {})
    app_id = flat.get("media_content_id")
    if flat.get("media_content_type") != _APP_LAUNCH_CONTENT_TYPE or not isinstance(app_id, str):
        return None
    entity_id = resolve_step_entity(step, hass)
    if not isinstance(entity_id, str) or not app_id or not samsung_host(hass, entity_id):
        return None
    return {"action": f"{DOMAIN}.launch_app", "data": {"entity_id": entity_id, "app_id": app_id}}


def _reroute_launches(hass: HomeAssistant, actions: list) -> list:
    return [_launch_step(hass, step) or step for step in actions]


def _toggle_attribute_step(hass: HomeAssistant, step: Any) -> dict | None:
    """The step rewritten to flip its boolean attribute, else ``None``.

    `volume_mute` writes the value it is handed, so a stored direction would
    make the button one-way. The stored boolean stays the plain checkbox HA's
    editor writes and the direction is filled in here, as Jinja so that every
    press runs the same sequence.
    """
    if not isinstance(step, dict):
        return None
    service = step.get("action") or step.get("service") or ""
    attribute = service_to_attribute(service_name(service))
    key = "service_data" if "service_data" in step else "data"
    data = step.get(key) or {}
    if not attribute or not toggles_attribute(service, data):
        return None
    entity_id = resolve_step_entity(step, hass)
    if entity_id:
        value: Any = attribute_toggle_template(entity_id, attribute)
    elif attribute not in data:
        # Nothing to read the current value from, and HA requires the field:
        # set it rather than send a call that fails.
        value = True
    else:
        return None
    return {**step, key: {**data, attribute: value}}


def _runnable_steps(
    hass: HomeAssistant, actions: list, entry_id: str, toggle: bool = True,
) -> list:
    """Rewrite stored steps into the form the Script runs.

    *toggle* is false for a cycle press, whose direction the user spelled out
    face by face and which must run exactly as written.
    """
    if toggle:
        actions = [_toggle_attribute_step(hass, step) or step for step in actions]
    return _bind_internal_steps(_reroute_launches(hass, actions), entry_id)


def _is_optimistic(hass: HomeAssistant, entry_id: str) -> bool:
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        _LOGGER.debug("Optimistic: entry %s not found", entry_id)
        return False
    enabled = entry.options.get(CONF_OPTIMISTIC_UPDATES, True)
    device_logger(_LOGGER, entry).debug(
        "Optimistic: options=%s → enabled=%s", dict(entry.options), enabled,
    )
    return enabled


async def _fire_cycle_update(
    hass: HomeAssistant,
    device_id: str,
    page_id: int,
    button_key: str,
    assign: Mapping,
    entry_id: str,
) -> None:
    """:func:`_fire_cycle_update_in_scope`, reading ``${_device}`` as the page has it."""
    template, page_color = await _page_meta(get_store(hass), device_id, page_id)
    with page_scope(template), button_scope(
        resolve_step_entity(first_step(dict(assign)), hass), hass,
    ), language_scope(get_ui_language(
        hass, hass.config_entries.async_get_entry(entry_id) if entry_id else None,
    )):
        await _fire_cycle_update_in_scope(
            hass, device_id, page_id, button_key, assign, entry_id,
            page_color=page_color,
        )


async def _page_meta(store: Any, device_id: str, page_id: int) -> tuple[Any, str]:
    """``(template, default_color)`` of the page, read once per press."""
    for page in await store.async_get_pages(device_id):
        if page.get("id", _DEFAULT_PAGE_ID) == page_id:
            return page.get("template"), page.get("default_color", "")
    return None, ""


async def _fire_cycle_update_in_scope(
    hass: HomeAssistant,
    device_id: str,
    page_id: int,
    button_key: str,
    assign: Mapping,
    entry_id: str,
    *,
    page_color: str | None = None,
) -> None:
    """Repaint a cycle button with the step its *next* press will run.

    Cycle mode exists for devices that report nothing back, so no
    ``EVENT_STATE_CHANGED`` is ever going to arrive and the state listener will
    never repaint this tile. The press is the only moment the glyph can change,
    which makes this the one update that has to happen here.

    Deliberately not gated on ``CONF_OPTIMISTIC_UPDATES``, unlike
    ``_fire_optimistic_update`` beside it. That option governs *guessing* at a
    device's state from a service call; the cycle position is not a guess but a
    fact this integration owns, and suppressing it would leave the button
    permanently showing step one while quietly running the others.

    Called after ``resolve_toggle_steps`` has already advanced the position, so
    ``toggle_icon`` reads the step that comes next — which is exactly the one
    the tile should advertise.
    """
    store = get_store(hass)
    theme = settings_theme(await store.async_get_settings(device_id))
    entity = resolve_step_entity(first_step(dict(assign)), hass)
    icon = toggle_icon(
        assign, None, entry_id, page_id, button_key,
        entity.split(".")[0] if entity else "",
        hass=hass, icons=theme.icons,
    )
    if not icon:
        # Rule icons are optional, and a cycle with none is a button the user
        # chose to leave looking constant. Firing a blank would erase the glyph
        # device_sync painted rather than leave it alone.
        return

    rules = toggle_rules(assign)
    if not rules:
        return
    index = cycle_index(entry_id, page_id, button_key, len(rules))

    if page_color is None:
        page_color = (await _page_meta(store, device_id, page_id))[1]

    # Same order as `icons.toggle_tooltip`: the press's own words, the ones it
    # derives from its step, then the button's label. Resolved, not just
    # cleaned, so a `${sensor.x}` is filled in rather than stripped.
    entry = hass.config_entries.async_get_entry(entry_id) if entry_id else None
    tooltip = clean_tooltip_text(
        resolve_rule_tooltip(rules[index], hass, entry)
        or step_tooltip(rules[index], hass, entry)
        or resolve_rule_tooltip(assign, hass, entry)
    )

    device_id_logger(_LOGGER, hass, device_id).debug(
        "Cycle update: %s/%s → next step %d/%d icon=%s",
        page_id, button_key, index + 1, len(rules), icon,
    )

    async_dispatcher_send(hass, SIGNAL_ICON_UPDATE.format(device_id), [{
        "page_id": page_id,
        "button_key": button_key,
        "icon": resolve_icon_url(
            icon, color=page_color, theme=theme.theme_id,
            radius=read_icon_style_options(getattr(entry, "options", None)).radius,
        ),
        "tooltip": tooltip,
        "page_color": page_color,
    }])


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
    ``PREDICTED_HA_STATE_MAP``. Stateless services (send_command, play_media, …) and
    attribute-setting ones (volume_set, …) are skipped — their outcome either
    has no icon or cannot be predicted from the current state alone.

    Uses the same resolution path as the real state listener
    (``_match_state_icon`` + ``resolve_icon_url``), so the optimistic icon
    matches what lands on confirmation — no flicker. A wrong prediction is
    self-correcting: the real ``EVENT_STATE_CHANGED`` overwrites it."""
    log = device_id_logger(_LOGGER, hass, device_id)
    if not own_actions:
        log.debug("Optimistic: no own_actions — skipping")
        return

    step = own_actions[0] if isinstance(own_actions[0], dict) else {}
    service = step.get("action") or step.get("service") or ""
    if not isinstance(service, str) or "." not in service:
        log.debug("Optimistic: no valid service in step — skipping (step=%s)", step)
        return
    svc = service_name(service)

    if not is_state_toggle_service(svc):
        log.debug("Optimistic: service '%s' is not a toggle service — skipping", service)
        return

    entity_id = resolve_step_entity(step, hass)
    if not entity_id:
        log.debug("Optimistic: no entity_id resolved from step — skipping")
        return

    state = hass.states.get(entity_id)
    if state is None:
        log.debug("Optimistic: entity %s has no state — skipping", entity_id)
        return

    # Predict from state-machine knowledge, not icon rule ordering.
    predicted_ha_state = PREDICTED_HA_STATE_MAP.get(state.state)
    if not predicted_ha_state:
        log.debug(
            "Optimistic: current state '%s' has no predicted successor — skipping",
            state.state,
        )
        return

    store = get_store(hass)
    # The remote's theme picks the icon table and rides in the URL built below,
    # so this repaint and the correcting state listener cannot disagree.
    theme = settings_theme(await store.async_get_settings(device_id))

    # Asked against the *predicted* state through the table the listener reads,
    # so the optimistic glyph is the one confirmation lands on.
    predicted = State(entity_id, predicted_ha_state, state.attributes)
    action_icon = _match_state_icon(service, predicted, theme.icons)
    if not action_icon:
        log.debug(
            "Optimistic: theme has no icon for predicted state '%s' — skipping",
            predicted_ha_state,
        )
        return

    # Variables read as the sync reads them; one with no value falls back to
    # the themed icon, and with neither there is nothing to predict.
    template, page_color = await _page_meta(store, device_id, page_id)

    with page_scope(template), button_scope(
        resolve_step_entity(first_step(dict(assign)), hass), hass,
    ), language_scope(get_ui_language(
        hass, hass.config_entries.async_get_entry(entry_id) if entry_id else None,
    )):
        # The sync's order, so a picture the user gave the button survives the
        # press instead of giving way to the predicted state's glyph.
        from ..config.button_rendering import library_names, live_button_icon

        icon = live_button_icon(assign, predicted, service, action_icon, hass)
    if not icon:
        log.debug("Optimistic: predicted icon has no value — skipping")
        return

    # Resolved here rather than below with the language, because the style call
    # needs it: the fill quantum has to match the one the sync and the listener
    # used, or this optimistic repaint would show a level neither of them draws.
    entry = hass.config_entries.async_get_entry(entry_id) if entry_id else None

    # Against the *predicted* state, not the current one: a press that turns a
    # lamp off must not draw the off icon in the style it is about to lose.
    style_options = read_icon_style_options(getattr(entry, "options", None))
    tile_style = entity_icon_style(
        state,
        assume_state=predicted_ha_state,
        step=style_options.step,
        fill=style_options.fill,
        tint=style_options.tint,
    ).on_page(page_color)

    resolved = resolve_icon_url(
        icon, color=tile_style.color, percent=tile_style.percent,
        theme=theme.theme_id, radius=style_options.radius,
    )

    # The ladder the sync and the correcting state listener read, against the
    # predicted state: a label the user wrote, and its variables, survive the
    # press instead of being swapped for a generic "<name> <action>".
    names = library_names(await store.async_get_action_library(device_id))
    tooltip = _compute_next_state_tooltip(
        assign, predicted, hass, entry, names.get(assign.get("action_id")),
    )

    log.debug(
        "Optimistic update: %s/%s → predicted %s → icon=%s tooltip=%s",
        page_id, button_key, predicted_ha_state, resolved, tooltip,
    )

    async_dispatcher_send(hass, SIGNAL_ICON_UPDATE.format(device_id), [{
        "page_id": page_id,
        "button_key": button_key,
        "icon": resolved,
        "tooltip": tooltip,
        "page_color": page_color,
    }])


async def resolve_button_assignment(
    hass: HomeAssistant,
    entry_id: str,
    button_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
) -> tuple[str | None, dict | None]:
    """``(device_id, assignment)`` a press of *button_key* runs right now.

    The fixed-button context applies, so this is the override when the selected
    grid button has one.
    """
    device_id = resolve_device_id(hass, entry_id)
    if not device_id:
        return None, None
    assignments = await get_store(hass).async_get_assignments(device_id, page_id)
    assign = resolve_fixed_action(assignments, get_selected_button(entry_id), button_key)
    return device_id, assign if isinstance(assign, dict) else None


async def longtouch_assignment(
    hass: HomeAssistant,
    entry_id: str,
    button_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
) -> list:
    """The long-touch steps *button_key* runs now; ``[]`` when it has none.

    Also ``[]`` while the remote's settings have long touch off: the steps stay
    stored, but the button clicks on press as if they were not there.
    """
    device_id, assign = await resolve_button_assignment(hass, entry_id, button_key, page_id)
    steps = longtouch_steps(assign)
    if not steps:
        return []
    settings = await get_store(hass).async_get_settings(device_id)
    return steps if longtouch_enabled(settings) else []


def _bind_internal_steps(actions: list, entry_id: str) -> list:
    """Point device-local steps that name no remote at this one.

    A button's ``lizaip.*`` step stores no target, meaning "the remote this
    button is on". Run by Home Assistant instead of the remote, the same call
    without a target addresses every remote, so the entry is filled in.
    """
    bound = []
    for step in actions:
        if (
            isinstance(step, dict)
            and get_internal_command(step.get("action") or step.get("service")) is not None
            and not step.get("target")
            and not (step.get("data") or {}).get("config_entry_id")
        ):
            step = {**step, "data": {**(step.get("data") or {}), "config_entry_id": entry_id}}
        bound.append(step)
    return bound


async def execute_longtouch(
    hass: HomeAssistant,
    entry_id: str,
    button_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
) -> None:
    """Run the long-touch steps of *button_key*.

    Only the wake prelude is inferred, as for a click: a long touch that
    starts an app on a sleeping TV still has to wake it first. Launch
    verification and the optimistic icon belong to the click, whose state the
    button shows.
    """
    log = device_logger(_LOGGER, hass.config_entries.async_get_entry(entry_id))
    actions = await longtouch_assignment(hass, entry_id, button_key, page_id)
    if not actions:
        log.debug("execute_longtouch: no long touch for %s/%s", page_id, button_key)
        return
    before = _inferred_prelude(hass, actions[0])
    actions = _runnable_steps(hass, actions, entry_id)
    script = await _get_script(
        hass, entry_id, page_id, button_key,
        (before or []) + actions, gesture="longtouch",
    )
    if script is None:
        return
    log.info(
        "Executing %s (%d steps) for page=%s button=%s",
        script.name, len(script.sequence), page_id, button_key,
    )
    try:
        await script.async_run(context=Context())
    except Exception:
        log.exception("Long touch failed for %s/%s", page_id, button_key)


def resolve_toggle_steps(
    hass: HomeAssistant,
    entry_id: str,
    page_id: int,
    button_key: str,
    assign: Mapping,
    actions: list[dict],
) -> list[dict]:
    """Pick the steps this press should run, honouring an optional ``toggle``.

    ``toggle`` is a sibling of ``config``, never a replacement for it: six other
    call sites (icons, tooltips, the watched-entity set, device_sync labels, the
    optimistic update and the panel's action matcher) read ``config[0]`` as "the
    step that represents this button". Returning ``actions`` unchanged whenever
    the toggle is absent, malformed or unmatched is what keeps those honest.

    The returned list is substituted for ``own_actions``, so the inferred wake
    prelude and launch verification are derived from the step actually about to
    run rather than from the declared default.
    """
    mode = toggle_mode(assign)
    if mode is None:
        return actions

    rules = toggle_rules(assign)
    if not rules:
        return actions

    if mode == MODE_CYCLE:
        index = cycle_index(entry_id, page_id, button_key, len(rules))
        # Advance before running, not after: a step that fails on an IR blaster
        # gives no feedback either way, and leaving the position parked would
        # trap the user on the broken entry with no way to step past it.
        advance_cycle(entry_id, page_id, button_key, len(rules))
        device_logger(_LOGGER, hass.config_entries.async_get_entry(entry_id)).debug(
            "toggle(cycle): step %d/%d for %s/%s",
            index + 1, len(rules), page_id, button_key,
        )
        return rule_steps(rules[index])

    return actions


async def execute_action(
    hass: HomeAssistant,
    entry_id: str,
    button_key: str,
    page_id: int = _DEFAULT_PAGE_ID,
    *,
    resolved: tuple[str | None, dict | None] | None = None,
) -> None:
    """Run the HA script action assigned to a clicked button.

    *resolved* is what `resolve_button_assignment` already answered for this
    press, so the event handler reads the assignment once.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    log = device_logger(_LOGGER, entry)
    if resolved is None:
        resolved = await resolve_button_assignment(hass, entry_id, button_key, page_id)
    device_id, assign = resolved
    if not device_id:
        log.warning("execute_action: device not found")
        return
    if not assign:
        log.info(
            "execute_action: no assignment for button '%s' on page %s",
            button_key, page_id,
        )
        return

    # Asked only of a button that actually carries a block. This runs on every
    # press of every button, and the overwhelming majority have no toggle to
    # suppress -- so the common path stays exactly the lookup-free press it was
    # before the feature existed.
    if TOGGLE_KEY in assign:
        assign = runtime_assign(
            assign,
            toggle_enabled(await get_store(hass).async_get_settings(device_id)),
        )

    actions = assign.get("config", [])
    if not isinstance(actions, list) or not actions:
        log.debug("execute_action: empty action config for %s/%s", page_id, button_key)
        return

    # Preserve the button's own steps for verification retries. A ``toggle``
    # block may substitute a different rule's steps here; ``config`` stays the
    # declared default that everything else in the integration reads.
    cycle_step: int | None = None
    if toggle_mode(assign) == MODE_CYCLE and (rules := toggle_rules(assign)):
        # Read before `resolve_toggle_steps` advances it: the step this press runs.
        cycle_step = cycle_index(entry_id, page_id, button_key, len(rules))
        await _evict_cycle_steps(hass, entry_id, page_id, button_key, len(rules))
    own_actions = resolve_toggle_steps(
        hass, entry_id, page_id, button_key, assign, actions,
    )

    # ``before`` is a sibling of ``config`` because panel/device_sync treat
    # ``config[0]`` as the action. Absence licenses inference; ``[]`` suppresses.
    # Inference reads ``own_actions[0]``, not ``actions[0]``: when a toggle rule
    # swapped the step in, the device that needs waking is the one the rule is
    # about to talk to.
    before = assign.get("before")
    if before is None:
        before = _inferred_prelude(hass, own_actions[0])
        if before:
            log.debug(
                "Inferred wake prelude for %s/%s (%s on %s): %s",
                page_id, button_key,
                own_actions[0].get("action") or own_actions[0].get("service"),
                resolve_step_entity(own_actions[0], hass), before,
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
            log.debug(
                "Inferred launch verification for %s/%s: %s",
                page_id, button_key, after,
            )

    # Order: wake, capture, button action, check; non-list siblings are ignored.
    actions = _runnable_steps(
        hass, own_actions, entry_id, toggle=toggle_mode(assign) != MODE_CYCLE,
    )
    if capture:
        actions = capture + actions
    if isinstance(before, list) and before:
        actions = before + actions
    if isinstance(after, list) and after:
        actions = actions + after

    script = await _get_script(
        hass, entry_id, page_id, button_key, actions, step=cycle_step,
    )
    if script is None:
        return
    log.info(
        "Executing %s (%d steps) for page=%s button=%s",
        script.name, len(script.sequence), page_id, button_key,
    )

    # A cycle button has no state listener to correct it, so its repaint is
    # unconditional and comes first: see _fire_cycle_update.
    if toggle_mode(assign) == MODE_CYCLE:
        await _fire_cycle_update(
            hass, device_id, page_id, button_key, assign, entry_id,
        )
    # Optimistic icon updates are corrected by the real state listener.
    elif _is_optimistic(hass, entry_id):
        await _fire_optimistic_update(
            hass, device_id, page_id, button_key, assign, own_actions, entry_id,
        )
    try:
        # Context lets HA trace resulting service calls back to this press.
        await script.async_run(context=Context())
    except Exception:
        # User-authored action failures must not tear down device event dispatch.
        log.exception("Action failed for %s/%s", page_id, button_key)
