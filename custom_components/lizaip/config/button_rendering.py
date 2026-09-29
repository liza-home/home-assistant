"""How a button looks: its label, its tooltip, and its icon.

Everything here answers one question — given an assignment, what text and what
icon should the device draw? None of it talks to a device or knows a page
exists. :mod:`device_sync` calls into it while building a page payload, and
that is the only direction the dependency runs.

The icon rules are the bulk of it. An icon can come from nine different places
and the order matters, so the candidates are written as a ladder of small
``_icon_from_*`` functions tried in turn (see ``_ICON_LADDER``) rather than one
branching function. Each rung answers only for the cases it owns and returns
``None`` otherwise, which keeps "why did this button get that icon?" answerable
by reading one short function instead of unwinding a chain of conditionals.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

# Here since HA 2024.2, the release that introduced icon translations and with
# them the per-service icons this module reads. `hacs.json` asks for 2024.7.0,
# so the import cannot fail. It used to point at `homeassistant.loader`, which
# has never held this function in any release; the resulting ImportError was
# swallowed silently and left every button on its coarse per-domain icon.
from homeassistant.helpers.icon import async_get_icons

from ..const import (
    service_name,
    ATTR_ICONS,
    DOMAIN_ICONS,
    DOMAIN_STATE_ICONS,
    NEXT_STATE_MAP,
    attr_str,
    catchall_state_icon,
    friendly_svc,
    get_action_label,
    STATE_TOKEN,
    get_default_icon,
    get_ui_language,
    is_attribute_state_service,
    is_state_toggle_service,
    icon_varies_with_state,
    is_stateless_service,
    is_token_only_label,
    is_two_way_service,
    localize_static_name,
    name_is_source_owned,
    name_is_user_written,
    scope_action_states,
    scoped_icon_state,
    service_fixed_icon,
    service_to_attribute,
    state_token_label,
    clean_label_text,
    substitute_label_tokens,
)
from .const import (
    ASSIGNMENT_INTERNAL_TARGET_NAME_KEY,
    BROKEN_TARGET_ICON,
    UNCONFIGURED_ICON,
    is_borrowed_identity_icon,
    is_payload_service,
    is_unconfigured_step,
    payload_display,
    step_service,
)
from ..action_controller import (
    first_step,
    resolve_step_entity,
    subject_for_assign,
)
from .internal_commands import (
    command_label as internal_command_label,
    command_target_name as internal_command_target_name,
    get_internal_command,
    resolve_action as resolve_internal_action,
)

_LOGGER = logging.getLogger(__name__)


async def _get_service_icons(hass: HomeAssistant) -> dict:
    """Fetch HA's service icon registry, shaped ``{domain: {service: {"service": icon}}}``.

    Where nearly every button icon comes from. On ``{}`` the resolver degrades to
    the much coarser per-domain fallback -- every ``light.*`` button becomes
    ``mdi:lightbulb`` -- which reads as an icon bug, so a failure is logged
    loudly.

    Deliberately not cached here. ``async_get_icons`` defaults to
    ``hass.config.top_level_components``, so it answers for the integrations
    loaded *so far*; a page sync during startup sees a partial registry. Holding
    that in a module global would pin the partial answer for the rest of the
    process, and the buttons of any integration that loaded later would keep
    their fallback icons until a reload. HA already caches the expensive part
    per component in its own ``_IconsCache`` and only reads the ones it has not
    seen, so calling through each time is cheap and self-healing.
    """
    try:
        result = await async_get_icons(hass, "services")
    except Exception:  # noqa: BLE001 - never let an icon lookup break a page sync
        _LOGGER.exception("Failed to read HA's service icon registry")
        return {}
    if not result:
        _LOGGER.warning("HA's service icon registry came back empty")
        return {}
    return result


def _entity_id_for_assign(assign: dict, hass: HomeAssistant) -> str:
    """Read the entity a button's first config step targets.

    The same resolver the executor uses, so the label names what the press will
    actually hit, whichever target kind the action editor wrote.
    """
    return resolve_step_entity(first_step(assign), hass) or ""


def _internal_target_hint(assign: dict) -> str:
    """The name a device-local command's target had when the button was saved.

    Stored beside the step rather than inside it. A second target field in the
    step itself would have to keep agreeing with the id, and
    ``_goto_page_params`` disarms a button whose two target fields disagree —
    so renaming a page would break a button that works. As a note alongside, it
    can go stale harmlessly: it is only ever read once the real target is gone.
    """
    if not isinstance(assign, dict):
        return ""
    hint = assign.get(ASSIGNMENT_INTERNAL_TARGET_NAME_KEY)
    return hint.strip() if isinstance(hint, str) else ""


def _fill_label_tokens(
    text: str,
    action_def: dict,
    assign: dict,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
    internal_context: dict | None = None,
) -> str:
    """Resolve ``${STATE}``/``${NAME}`` (and any future token) in a typed label.

    *entry* carries the device's own language option; without it the label is
    built in Home Assistant's language, which is what every caller got before
    the option existed.
    """
    if not text or "${" not in text:
        return text

    service = action_def.get("service", "")
    svc = service_name(service)
    lang = get_ui_language(hass, entry)

    _, state_obj = subject_for_assign(assign, hass)
    current_state = state_obj.state if state_obj else ""
    attributes = dict(state_obj.attributes or {}) if state_obj else None

    # The step's own service data: a button that names a literal value for the
    # attribute it sets (`is_volume_muted: true`) says its own direction.
    config = assign.get("config", []) if isinstance(assign, dict) else []
    step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}
    data = step.get("data") or {}

    values = {"state": state_token_label(svc, current_state, lang, attributes, data)}

    # `${NAME}` is a device-local command's token and nobody else's. The key is
    # only added when the button actually carries one, so on a plain HA action
    # the token stays unknown and collapses to nothing — rather than resolving
    # to an empty string that reads as a supported-but-blank token. The step's
    # service, not the library entry's, matching the internal-command rung: the
    # command lives on the step.
    internal_service = step_service(config) or service
    if get_internal_command(internal_service) is not None:
        values["name"] = internal_command_target_name(
            internal_service, data, internal_context, _internal_target_hint(assign)
        )

    return substitute_label_tokens(text, values)


def _resolve_button_tooltip(
    action_def: dict,
    assign: dict,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
    internal_context: dict | None = None,
) -> str:
    """Compute the text the remote prints under a button.

    A thin wrapper over the ladder so that *every* rung's answer is cleaned on
    the way out — the result is interpolated into an ``imgserv://`` URL, and a
    brace there is rejected by the HTTP parser before any handler runs, which
    shows up on the device as a silently blank tooltip.
    """
    return clean_label_text(
        _resolve_button_tooltip_ladder(action_def, assign, hass, entry, internal_context)
    )


def _resolve_button_tooltip_ladder(
    action_def: dict,
    assign: dict,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
    internal_context: dict | None = None,
) -> str:
    """Compute a dynamic tooltip showing the next state the button will trigger.

    Returns a string like "Schreibtisch Aus" (entity name + translated action).
    Uses HA's configured language for translations.
    """
    service = action_def.get("service", "")
    svc = service_name(service)

    # A payload-carrying button (play_media, select_source) names itself — the
    # shared action-library entry would name a different media item entirely.
    # A name the user actually typed still wins; a name that merely mirrors the
    # library entry was auto-filled and must not shadow the payload.
    # Stripped before the comparison below, as `action_controller` does. A
    # stored "Toggle " is the library name with a stray space, but compared raw
    # it read as the user's own words: the tooltip said "Toggle" at sync time
    # and "Schreibtisch Off" on the next live update.
    stored_name = (assign.get("label") or "").strip()
    # The panel records who wrote the name, so the comparison below is only the
    # fallback for buttons stored before it did. A layout button stores its own
    # name *and* mints its library entry from it (`layouts.py`), so comparing
    # the two called "CH+" auto-filled and printed "Wohnzimmer CH+" — and
    # deleting the room name in the panel stored what was already stored, so
    # nothing moved. A recorded edit is not a guess, and outranks all of it.
    user_named = name_is_user_written(assign)
    # A label made only of placeholders ("${STATE}") names nothing on its own,
    # so it is a shape rather than the user's words: it is resolved below and
    # given the entity prefix, exactly as a short static name like "Next" is.
    # True of a typed one too — typing "${STATE}" asks for the derived label.
    token_only = is_token_only_label(stored_name)
    # …and a name a dynamic source wrote is not the user's words either. On a
    # page of toggles — every lamp on a Hue bridge — the name is the lamp, and
    # returning it here is what left eleven buttons reading "Kitchen" while the
    # twelfth read "Kitchen Off" purely because its name happened to match the
    # shared library entry's. A name the user typed over one of those lamps is
    # theirs again, which is why `user_named` releases this guard too.
    bound_toggle = (
        not user_named and name_is_source_owned(assign) and is_two_way_service(svc)
    )
    # A token-only name is a shape rather than words *unless the user wrote it*.
    # Deleting the entity prefix in front of "${STATE}" is the one way to ask
    # for the bare state word, and treating that edit as a shape put the prefix
    # straight back -- the label could not be changed at all.
    if (
        stored_name
        and (user_named or not token_only)
        and not bound_toggle
        and (user_named or stored_name != (action_def.get("name") or ""))
    ):
        resolved = clean_label_text(
            _fill_label_tokens(
                stored_name, action_def, assign, hass, entry, internal_context
            )
        )
        # A label that is nothing but a damaged placeholder ("${STATE") cleans
        # away to nothing. Returning it would blank the tooltip *and* stop the
        # ladder, so the button loses the name it would otherwise have derived.
        if resolved:
            return resolved

    # An internal command has no entity, so none of the state machinery below
    # applies — it names itself after what it does ("Living Room" for the page
    # it opens), which beats the service-derived "Goto Page".
    config = assign.get("config", [])
    internal_step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}
    internal_service = step_service(config) or service
    internal_cmd = get_internal_command(internal_service)
    if internal_cmd is not None:
        label = internal_command_label(
            internal_service,
            internal_step.get("data"),
            internal_context,
            _internal_target_hint(assign),
        )
        return label or stored_name or internal_cmd.name

    payload_title, _ = payload_display(assign)
    if payload_title:
        return payload_title

    # Static name fallback. Never borrow the library entry's name for a
    # payload-carrying service — it describes whichever button created it.
    static_name = "" if token_only else (
        stored_name or ("" if is_payload_service(service) else (action_def.get("name") or ""))
    )

    # The device's own language option first, then the panel/HA language.
    lang = get_ui_language(hass, entry)
    # Presets hardcode English here ("Power", "Volume Up").
    static_name = localize_static_name(static_name, lang, user_named)

    if not svc:
        return static_name

    # Get entity friendly name and current state
    entity_id = _entity_id_for_assign(assign, hass)

    entity_name, state_obj = subject_for_assign(assign, hass)
    current_state = state_obj.state if state_obj else ""

    if not entity_name and state_obj:
        entity_name = (
            state_obj.attributes.get("friendly_name", "")
            or state_obj.entity_id.split(".")[-1]
        )
    if not entity_name:
        entity_name = entity_id.split(".")[-1] if entity_id else ""

    # `not token_only`: "${STATE}" is a shape, not a subject. The panel asks for
    # the prefix by resolving the token alone, and taking it as the entity name
    # left the field reading a bare "${STATE}" with no lamp in front of it.
    if bound_toggle and stored_name and not token_only:
        # The source picked the subject's name; the registry's friendly name is
        # the same string in the ordinary case and the wrong one when it is not
        # (a source is free to title an item however it likes).
        entity_name = stored_name
        if not current_state:
            # Nothing to append — an unavailable lamp still deserves its name
            # rather than the generic "Toggle" the bottom of the ladder derives.
            return stored_name

    # A token-only label resolves to the state alone; the entity goes in front,
    # so "${STATE}" reads "Unnamed Room Pause" just as "Next" reads
    # "Unnamed Room Next". When the token cannot resolve (a state absent from
    # NEXT_STATE_MAP) it collapses to nothing and the ladder carries on below.
    if token_only:
        resolved = _fill_label_tokens(stored_name, action_def, assign, hass, entry)
        if resolved:
            return f"{entity_name} {resolved}" if entity_name else resolved

    # An unrenamed attribute button announces its next action, exactly as an
    # unrenamed toggle announces its next state below. Without this a
    # `volume_mute` button whose stored name is still the library's "Mute" would
    # read a frozen "Mute" while its own icon already showed the opposite.
    if is_attribute_state_service(svc):
        attr_label = _fill_label_tokens(STATE_TOKEN, action_def, assign, hass, entry)
        if attr_label:
            return f"{entity_name} {attr_label}" if entity_name else attr_label

    # Toggle services — show the opposite of current state
    if is_state_toggle_service(svc) and current_state:
        next_key = NEXT_STATE_MAP.get(current_state)
        if next_key:
            label = get_action_label(next_key, lang)
            return f"{entity_name} {label}" if entity_name else label

    # Stateless services with a predefined name — use the button name as tooltip
    # (e.g., layout buttons: "CH+", "Up", "OK" instead of generic "Send Command")
    if is_stateless_service(svc) and static_name:
        return f"{entity_name} {static_name}" if entity_name else static_name

    # All other services — derive friendly label from service name
    label = friendly_svc(svc, lang)
    if label:
        return f"{entity_name} {label}" if entity_name else label

    # Fallback: static name
    return static_name or entity_name


def button_image_wins(assign: dict, svc_name: str, payload_thumb: str | None) -> bool:
    """Does the button's own stored image win over deriving an icon from state?

    This is the panel/device parity rule. The panel's `_resolveButtonIcon`
    returns `assign.image` before deriving anything, so whenever the device
    derives instead, the two surfaces disagree -- the user picks an icon in the
    button config view and the device shows something else.

    The device may only overrule the stored image when it has something better
    to say, which is the *current state*. That is exactly a service whose icon
    varies with state: `toggle` shows Pause while playing, and a frozen image
    could not. Every other service has one face, so the stored image stands.

    It used to ask `is_stateless_service`, a strictly narrower set:
    `media_player.turn_off` is one-way rather than stateless, so its stored
    image was discarded and re-derived as a generic power glyph.

    The payload clause is unchanged: a play_media button carries its own media
    identity, and a pinned image inherited from a layout may belong to a
    different item, so the payload thumbnail wins unless the user pinned it.
    """
    image = assign.get("image")
    if not image:
        return False
    if svc_name and icon_varies_with_state(svc_name):
        return False
    return bool(
        assign.get("image_pinned") or not payload_thumb or image == payload_thumb
    )


@dataclass(frozen=True)
class _IconSubject:
    """Everything the icon ladder asks about one button, resolved once."""

    action_def: dict
    assign: dict
    service: str
    svc_domain: str
    svc_name: str
    config: Any
    internal_cmd: Any
    current_state: Any
    entity_id: str | None
    states: list
    service_icons: dict | None
    internal_context: dict | None

    @property
    def entity_domain(self) -> str:
        """The domain the icon tables are keyed by, falling back to the service's."""
        return self.entity_id.split(".")[0] if self.entity_id else self.svc_domain

    @property
    def state_icons(self) -> dict:
        return self.assign.get("state_icons") or {}

    @property
    def varies_with_state(self) -> bool:
        return icon_varies_with_state(self.svc_name)


def _lone_domain_entity(hass: HomeAssistant, svc_domain: str) -> str | None:
    """The only entity in *svc_domain*, when there is exactly one to infer from."""
    if not svc_domain or svc_domain == "homeassistant":
        return None
    found = [
        s.entity_id for s in hass.states.async_all()
        if s.entity_id.startswith(f"{svc_domain}.")
    ]
    return found[0] if len(found) == 1 else None


def _derived_states(subject: _IconSubject, hass: HomeAssistant) -> list:
    """The per-state rows to match against, derived from domain defaults if unset.

    Only for a service whose icon actually follows the entity -- deriving rows
    for a fixed-icon service is what let it borrow an unrelated state's glyph.
    """
    states = scope_action_states(subject.service, subject.action_def.get("states"))
    if states or not subject.service or not subject.varies_with_state:
        return states

    attr = service_to_attribute(subject.svc_name)
    if attr:
        return [
            {"state": s, "icon": i, "attribute": attr}
            for s, i in ATTR_ICONS.get(attr, {}).items() if i
        ]
    if is_state_toggle_service(subject.svc_name):
        return scope_action_states(
            subject.service,
            [
                {"state": s, "icon": i}
                for s, i in DOMAIN_STATE_ICONS.get(subject.svc_domain, {}).items() if i
            ],
        )
    return states


def _icon_from_button_overrides(s: _IconSubject) -> str | None:
    """Rung 1: the per-button state_icons the user set on this button alone."""
    state_icons = s.state_icons
    if state_icons and s.current_state:
        matched = state_icons.get(s.current_state.state)
        if matched:
            return matched
        for key, icon in state_icons.items():
            if icon and ":" in key:
                attr_name, attr_val = key.split(":", 1)
                if attr_str(s.current_state.attributes.get(attr_name, "")) == attr_val:
                    return icon
        # A state with no row of its own (idle, buffering) wears the face of the
        # state that stands in for it, so a custom icon keeps applying.
        catchall = catchall_state_icon(
            state_icons,
            s.current_state.entity_id.split(".")[0],
            s.current_state.state,
            s.svc_name,
        )
        if catchall:
            return catchall
    if state_icons:
        return next((v for v in state_icons.values() if v), None)
    return None


def _icon_from_button_identity(s: _IconSubject) -> str | None:
    """Rung 2: the button's own image or payload thumbnail.

    Checked inside the resolver rather than by the caller because the config
    card is the source of truth, and the panel's `_resolveButtonIcon` applies
    the same rule -- one that lived in a single caller is one the other surface
    silently would not have. The button's own media identity beats the shared,
    service-keyed action-library icon, which may belong to a different item.
    """
    _, payload_thumb = payload_display(s.assign)
    if button_image_wins(s.assign, s.svc_name, payload_thumb):
        return s.assign["image"]
    return payload_thumb or None


def _icon_for_unresolvable(s: _IconSubject) -> str | None:
    """Rungs 3-4: the two markers for a button that cannot act.

    "Unconfigured" is a button naming an action nobody can resolve -- not even a
    service. An *unassigned* slot is not that, and keeps the generic fallbacks.

    "Broken" is a different statement and deliberately a different glyph: a
    device-local command whose target is gone is disarmed by `resolve_action`,
    so showing its registry icon would leave a button that looks armed and lies.
    That icon is generic (every goto button shares one), so nothing the user
    chose is overridden here -- a pinned per-button image wins further up.
    """
    config = s.config
    has_action = bool(s.assign.get("action_id") or (isinstance(config, list) and config))
    if has_action and is_unconfigured_step(config, s.service):
        return UNCONFIGURED_ICON

    if s.internal_cmd is not None:
        step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}
        if resolve_internal_action(
            step_service(config) or s.service, step.get("data"), s.internal_context
        ) == ("ha_event", {}):
            return BROKEN_TARGET_ICON
    return None


def _icon_from_action(s: _IconSubject) -> str | None:
    """Rungs 5-6: the action's own icon, then an internal command's registry default.

    The action icon is honoured whenever the icon does not vary with state; if
    it does, the state rules below are more specific and win. For payload
    services the library entry is shared across buttons, so item artwork on it
    belongs to whichever button created it -- a generic mdi: icon carries no
    such identity and stays usable.
    """
    action_icon = s.action_def.get("icon")
    if action_icon and (not s.svc_name or not s.varies_with_state):
        if not (is_payload_service(s.service) and is_borrowed_identity_icon(action_icon)):
            return action_icon

    # An internal command has no entity and no states, so every rung below would
    # have nothing to match against.
    if s.internal_cmd is not None:
        return s.internal_cmd.icon
    return None


def _icon_from_configured_states(s: _IconSubject) -> str | None:
    """Rung 7: a user-configured per-state row matching the live state."""
    if not s.current_state:
        return None
    for row in s.states:
        if not isinstance(row, dict) or not row.get("icon"):
            continue
        attr = row.get("attribute")
        if attr:
            if attr_str(s.current_state.attributes.get(attr, "")) == row.get("state"):
                return row["icon"]
        elif row.get("state") == s.current_state.state:
            return row["icon"]
    return None


def _icon_from_live_state(s: _IconSubject) -> str | None:
    """Rung 8: the shipped default matching the entity's current state."""
    if not (s.service and s.current_state and s.varies_with_state):
        return None
    attribute = service_to_attribute(s.svc_name)
    if attribute:
        attr_val = attr_str(s.current_state.attributes.get(attribute, ""))
        return get_default_icon(s.entity_domain, attribute, attr_val) or None
    if is_state_toggle_service(s.svc_name):
        # A narrowed service reads the table through its catch-all, so an idle
        # speaker still shows "press to play".
        lookup = scoped_icon_state(s.svc_name, s.entity_domain, s.current_state.state)
        return (get_default_icon(s.entity_domain, None, lookup) if lookup else None) or None
    return None


def _icon_from_any_state_row(s: _IconSubject) -> str | None:
    """Rung 9: the first row that has an icon, with no state to match against."""
    return next(
        (r["icon"] for r in s.states if isinstance(r, dict) and r.get("icon")), None
    )


def _icon_from_service(s: _IconSubject) -> str | None:
    """Rungs 10-11: the service's own default, then its domain's.

    Everything above is an override the user set, which is why this runs last.
    What is left splits in two: a state-dependent service reads the state table,
    and every other service is simply *named*.
    """
    if not s.service:
        return None

    if not s.varies_with_state:
        # One answer, whatever the entity is doing. Borrowing a row from the
        # state table here is what drew mdi:pause on Play and Search buttons.
        override = service_fixed_icon(s.entity_domain, s.svc_name)
        if override:
            return override
    else:
        attribute = service_to_attribute(s.svc_name)
        icons = (
            ATTR_ICONS.get(attribute, {}) if attribute
            else DOMAIN_STATE_ICONS.get(s.svc_domain, {})
        )
        first_icon = next(iter(icons.values()), None)
        if first_icon:
            return first_icon

    # Ask Home Assistant for whichever branch got this far. Core ships an icon
    # for essentially every service, so this needs no list of which ones --
    # `search_media` and anything HA adds later resolve without a code change.
    # A state-dependent service only reaches here when our tables have nothing
    # for its domain, which is every domain nobody has added yet.
    if s.service_icons:
        svc_icon = s.service_icons.get(s.svc_domain, {}).get(s.svc_name, {}).get("service")
        if svc_icon:
            return svc_icon

    return DOMAIN_ICONS.get(s.svc_domain)


#: Tried in order; the first to answer wins. See each rung for why it sits here.
_ICON_LADDER = (
    _icon_from_button_overrides,
    _icon_from_button_identity,
    _icon_for_unresolvable,
    _icon_from_action,
    _icon_from_configured_states,
    _icon_from_live_state,
    _icon_from_any_state_row,
    _icon_from_service,
)


def _resolve_button_icon(
    action_def: dict,
    assign: dict,
    hass: HomeAssistant,
    service_icons: dict | None = None,
    internal_context: dict | None = None,
) -> str:
    """Resolve the best icon for a button, most specific rung first.

    The order is the whole contract -- see `_ICON_LADDER` and the rung each
    entry names.
    """
    service = action_def.get("service", "")
    svc_domain = service.split(".")[0] if "." in service else ""
    config = assign.get("config", [])

    # The same state the label speaks about, so an area-bound button's face and
    # its words agree about whether the room is on.
    _, current_state = subject_for_assign(assign, hass)
    entity_id = _entity_id_for_assign(assign, hass) or None
    if not entity_id and service:
        inferred = _lone_domain_entity(hass, svc_domain)
        if inferred:
            entity_id = inferred
            current_state = hass.states.get(entity_id)

    subject = _IconSubject(
        action_def=action_def,
        assign=assign,
        service=service,
        svc_domain=svc_domain,
        svc_name=service_name(service),
        config=config,
        # An internal command fires and forgets on the device itself -- no
        # entity, no state, so the ladder answers from the registry.
        internal_cmd=get_internal_command(step_service(config) or service),
        current_state=current_state,
        entity_id=entity_id,
        states=[],
        service_icons=service_icons,
        internal_context=internal_context,
    )
    subject = replace(subject, states=_derived_states(subject, hass))

    for rung in _ICON_LADDER:
        icon = rung(subject)
        if icon:
            return icon
    return "mdi:cog"
