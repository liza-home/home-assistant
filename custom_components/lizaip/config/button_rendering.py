"""How a button looks: its label, its tooltip, and its icon.

Everything here answers one question — given an assignment, what text and what
icon should the device draw? None of it talks to a device or knows a page
exists. :mod:`page_payload` calls into it while building a page payload, and
that is the only direction the dependency runs.

The icon rules are the bulk of it. An icon can come from nine different places
and the order matters, so the candidates are written as a ladder of small
``_icon_from_*`` functions tried in turn (see ``_ICON_LADDER``) rather than one
branching function. Each rung answers only for the cases it owns and returns
``None`` otherwise, which keeps "why did this button get that icon?" answerable
by reading one short function instead of unwinding a chain of conditionals.

The tooltip is a ladder too, in :func:`_resolve_button_tooltip_ladder`. It
answers both while a page is being built and on every state change
(:func:`action_controller.icons._compute_next_state_tooltip` calls it with the
state that moved), so the label cannot read one thing at sync time and another
the first time the entity moves.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, State

# Here since HA 2024.2, the release that introduced icon translations and with
# them the per-service icons this module reads. `hacs.json` asks for 2024.7.0,
# so the import cannot fail. It used to point at `homeassistant.loader`, which
# has never held this function in any release; the resulting ImportError was
# swallowed silently and left every button on its coarse per-domain icon.
from homeassistant.helpers.icon import async_get_icons

from ..shared.tokens import (
    button_scope,
    entity_token_entities,
    resolve_image_tokens,
    clean_label_text,
    finish_tooltip,
    substitute_label_tokens,
)
from ..shared.services import (
    service_name,
    NEXT_STATE_MAP,
    attr_str,
    catchall_state_icon,
    is_attribute_state_service,
    is_state_toggle_service,
    is_two_way_service,
    icon_varies_with_state,
    is_stateless_service,
    scope_action_states,
    scoped_icon_state,
    service_fixed_icon,
    service_to_attribute,
)
from ..shared.history import history_entities
from ..shared.icon_defaults import icon_defaults
from ..shared.i18n import action_labels, get_ui_language
from ..shared.labels import (
    STATE_TOKEN,
    state_token_label,
)
from ..shared.assignment import (
    name_is_user_written,
    ASSIGNMENT_INTERNAL_TARGET_NAME_KEY,
)
from .const import (
    BROKEN_TARGET_ICON,
    UNCONFIGURED_ICON,
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
from ..action_controller.icons import toggle_icon, toggle_tooltip
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


def library_names(library: Any) -> dict[str, str]:
    """The action library's names, keyed by the ``action_id`` a button carries."""
    return {
        a["id"]: (a.get("name") or "").strip()
        for a in library or ()
        if isinstance(a, dict) and a.get("id")
    }


def _label_is_auto_filled(
    stored: str, assign: dict, hass: HomeAssistant,
    state: State | None = None,
    library_name: str | None = None,
) -> bool:
    """Is *stored* only the auto-filled library name, standing in for a derived one?

    The mirror of the panel's ``_labelIsAutoFilled`` with ``_computeLabel``: the
    Tooltip field shows the derived label instead of the stored name in
    exactly these cases -- ``${_state}``, or a payload button's own item over a
    name copied from the shared library entry -- and the stored name everywhere
    else. *library_name* is that entry's name; without one the stored name was
    never copied from anywhere and is the button's own.
    """
    if not stored or name_is_user_written(assign):
        return False
    if stored != (library_name or "").strip():
        return False
    config = assign.get("config", []) if isinstance(assign, dict) else []
    service = step_service(config) or ""
    # `_computeLabel`'s rungs before `${_state}`: a command names its target, a
    # payload its item, an unfinished step nothing.
    if get_internal_command(service) is not None:
        return False
    if payload_display(assign)[0]:
        return is_payload_service(service)
    if is_unconfigured_step(config, service):
        return False
    svc = service_name(service)
    if not (is_two_way_service(svc) or is_attribute_state_service(svc)):
        return False
    subject, state_obj = subject_for_assign(assign, hass, state)
    return bool(subject or state_obj or _entity_id_for_assign(assign, hass))


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
    assign: dict,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
    internal_context: dict | None = None,
    state: State | None = None,
) -> str:
    """Resolve ``${_state}``/``${_name}`` (and any future token) in a typed label.

    *entry* carries the device's own language option; without it the label is
    built in Home Assistant's language, which is what every caller got before
    the option existed.
    """
    if not text or "${" not in text:
        return text

    config = assign.get("config", []) if isinstance(assign, dict) else []
    service = step_service(config) or ""
    svc = service_name(service)
    lang = get_ui_language(hass, entry)

    _, state_obj = subject_for_assign(assign, hass, state)
    current_state = state_obj.state if state_obj else ""
    attributes = dict(state_obj.attributes or {}) if state_obj else None

    # The step's own service data: a button that names a literal value for the
    # attribute it sets (`is_volume_muted: true`) says its own direction.
    step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}
    data = step.get("data") or {}

    values = {"_state": state_token_label(svc, current_state, lang, attributes, data)}

    # `${_name}` is a device-local command's token and nobody else's. The key
    # is only added when the button carries one, so on a plain HA action the
    # token collapses to nothing rather than to a supported-but-blank string.
    if get_internal_command(service) is not None:
        values["_name"] = internal_command_target_name(
            service, data, internal_context, _internal_target_hint(assign)
        )

    return substitute_label_tokens(
        text, values, hass, getattr(state_obj, "entity_id", None),
    )


def _resolve_button_tooltip(
    assign: dict,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
    internal_context: dict | None = None,
    button_ref: tuple[str, int, str] | None = None,
    state: State | None = None,
    library_name: str | None = None,
) -> str:
    """Compute the text the remote prints under a button.

    The one ladder for both producers: the page sync, and the live update that
    passes the *state* whose change woke it (``icons._compute_next_state_tooltip``).

    A thin wrapper over the ladder so that *every* rung's answer is cleaned on
    the way out — the result is interpolated into an ``imgserv://`` URL, and a
    brace there is rejected by the HTTP parser before any handler runs, which
    shows up on the device as a silently blank tooltip.
    """
    with button_scope(_entity_id_for_assign(assign, hass), hass):
        return finish_tooltip(
            _resolve_button_tooltip_ladder(
                assign, hass, entry, internal_context, button_ref, state,
                library_name,
            ),
            hass,
        )


def _resolve_button_tooltip_ladder(
    assign: dict,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
    internal_context: dict | None = None,
    button_ref: tuple[str, int, str] | None = None,
    state: State | None = None,
    library_name: str | None = None,
) -> str:
    """Compute a dynamic tooltip showing the next state the button will trigger.

    Returns a string like "Aus" (the translated action). A stored label wins
    and is printed as it reads. Uses HA's configured language for translations.
    """
    # Rung 0, mirroring `_icon_from_toggle_rule`: the toggle block is the only
    # thing that knows the button is about to do something other than its
    # declared action, so its words outrank every derivation below.
    entry_id = page_id = button_key = None
    if button_ref:
        entry_id, page_id, button_key = button_ref
    _, toggle_state = subject_for_assign(assign, hass, state)
    rule_text = toggle_tooltip(
        assign, toggle_state, entry_id, page_id, button_key, hass, entry,
    )
    if rule_text:
        return rule_text

    config = assign.get("config", [])
    service = step_service(config) or ""
    svc = service_name(service)

    # A payload-carrying button (play_media, select_source) names itself, so a
    # name it was merely given must not shadow the payload; one the user typed
    # still wins. Stripped first, as `action_controller` does.
    stored_name = (assign.get("label") or "").strip()
    # The panel records who wrote the name.
    user_named = name_is_user_written(assign)
    # A stored label is printed as it reads, its placeholders filled -- empty
    # included: `${_device.media_title_prev}` with nothing before it reads as
    # nothing, not as a derived "Previous". It is what the panel's Tooltip field
    # shows, and the remote must print what that field says; the one exception
    # is the field's own: see `_label_is_auto_filled`.
    if stored_name and not _label_is_auto_filled(
        stored_name, assign, hass, state, library_name,
    ):
        if "${" not in stored_name:
            # As the panel's `_displayLabel`: a preset's English name in the
            # remote's language, a name the user typed as typed.
            return clean_label_text(
                action_labels.localize(stored_name, get_ui_language(hass, entry), user_named)
            )
        return clean_label_text(
            _fill_label_tokens(
                stored_name, assign, hass, entry, internal_context, state
            )
        )

    # An internal command has no entity, so none of the state machinery below
    # applies — it names itself after what it does ("Living Room" for the page
    # it opens), which beats the service-derived "Goto Page".
    internal_step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}
    internal_cmd = get_internal_command(service)
    if internal_cmd is not None:
        label = internal_command_label(
            service,
            internal_step.get("data"),
            internal_context,
            _internal_target_hint(assign),
        )
        return label or stored_name or internal_cmd.name

    payload_title, _ = payload_display(assign)
    if payload_title:
        return payload_title

    static_name = stored_name

    # The device's own language option first, then the panel/HA language.
    lang = get_ui_language(hass, entry)
    # Presets hardcode English here ("Power", "Volume Up").
    static_name = action_labels.localize(static_name, lang, user_named)

    if not svc:
        return static_name

    _, state_obj = subject_for_assign(assign, hass, state)
    current_state = state_obj.state if state_obj else ""

    # An unrenamed attribute button announces its next action, exactly as an
    # unrenamed toggle announces its next state below. Without this a
    # `volume_mute` button whose stored name is still the library's "Mute" would
    # read a frozen "Mute" while its own icon already showed the opposite.
    if is_attribute_state_service(svc):
        attr_label = _fill_label_tokens(
            STATE_TOKEN, assign, hass, entry, state=state,
        )
        if attr_label:
            return attr_label

    # Toggle services — show the opposite of current state
    if is_state_toggle_service(svc) and current_state:
        next_key = NEXT_STATE_MAP.get(current_state)
        if next_key:
            return action_labels.get(next_key, lang)

    # Stateless services with a predefined name — use the button name as tooltip
    # (e.g., template buttons: "CH+", "Up", "OK" instead of generic "Send Command")
    if is_stateless_service(svc) and static_name:
        return static_name

    # All other services — derive friendly label from service name
    label = action_labels.for_service(svc, lang)
    if label:
        return label

    # Nothing the button does has a word: an empty button stays empty, rather
    # than borrowing the name of what it acts on.
    return static_name


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
    identity, and a pinned image inherited from a template may belong to a
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
    # Identifies the button to the cycle-position store. Optional because only
    # a `toggle` in cycle mode needs it and most callers (tests, previews) have
    # no page to speak of; `toggle_icon` answers None rather than guessing when
    # it is absent.
    button_ref: tuple[str, int, str] | None = None
    # Only so a toggle rule's icon can resolve its `${entity}` variables, the
    # same way the assignment's own image does. Optional because the rungs that
    # existed before all answer from the fields already on this subject.
    hass: HomeAssistant | None = None
    # The remote's icon table: the shipped one with its theme laid over it.
    # Optional because most callers (tests, previews) speak for no remote, and
    # the shipped table is what a remote without a theme reads anyway.
    icons: Any = None

    @property
    def entity_domain(self) -> str:
        """The domain the icon tables are keyed by, falling back to the service's."""
        return self.entity_id.split(".")[0] if self.entity_id else self.svc_domain

    @property
    def icon_table(self):
        """The table the rungs read. Never the singleton when a theme is set."""
        return self.icons or icon_defaults

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
    if not subject.service or not subject.varies_with_state:
        return []

    attr = service_to_attribute(subject.svc_name)
    if attr:
        return [
            {"state": s, "icon": i, "attribute": attr}
            for s, i in subject.icon_table.attribute_icons.get(attr, {}).items() if i
        ]
    if is_state_toggle_service(subject.svc_name):
        return scope_action_states(
            subject.service,
            [
                {"state": s, "icon": i}
                for s, i in subject.icon_table.domain_state_icons.get(subject.svc_domain, {}).items() if i
            ],
        )
    return []


def _icon_from_toggle_rule(s: _IconSubject) -> str | None:
    """Rung 0: the face the button's ``toggle`` block asks for right now.

    Above `state_icons` because it is strictly better informed. A toggle button
    is about to run something other than its declared action, and only the
    toggle block knows which; a `state_icons` row keyed by the subject's state
    would paint the declared action's face over it.

    A step's own icon is optional -- `step_icon` derives one from its service --
    so `None` simply hands the question to the rung below.
    """
    entry_id = page_id = button_key = None
    if s.button_ref:
        entry_id, page_id, button_key = s.button_ref
    return toggle_icon(
        s.assign, s.current_state, entry_id, page_id, button_key,
        s.entity_domain, s.service_icons, hass=s.hass, icons=s.icon_table,
    )


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


def _icon_from_internal_command(s: _IconSubject) -> str | None:
    """Rung 5: an internal command's registry default.

    An internal command has no entity and no states, so every rung below would
    have nothing to match against.
    """
    return s.internal_cmd.icon if s.internal_cmd is not None else None


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
        return s.icon_table.for_state(s.entity_domain, attribute, attr_val) or None
    if is_state_toggle_service(s.svc_name):
        # A narrowed service reads the table through its catch-all, so an idle
        # speaker still shows "press to play".
        lookup = scoped_icon_state(s.svc_name, s.entity_domain, s.current_state.state)
        return (s.icon_table.for_state(s.entity_domain, None, lookup) if lookup else None) or None
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
        override = service_fixed_icon(s.entity_domain, s.svc_name, s.icon_table)
        if override:
            return override
    else:
        attribute = service_to_attribute(s.svc_name)
        icons = (
            s.icon_table.attribute_icons.get(attribute, {}) if attribute
            else s.icon_table.domain_state_icons.get(s.svc_domain, {})
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

    return s.icon_table.domain_icons.get(s.svc_domain)


#: Tried in order; the first to answer wins. See each rung for why it sits here.
_ICON_LADDER = (
    _icon_from_toggle_rule,
    _icon_from_button_overrides,
    _icon_from_button_identity,
    _icon_for_unresolvable,
    _icon_from_internal_command,
    _icon_from_configured_states,
    _icon_from_live_state,
    _icon_from_any_state_row,
    _icon_from_service,
)


def with_resolved_image(assign: dict, hass: HomeAssistant) -> dict:
    """*assign* with the entity variables in its image filled in.

    ``mdi:weather-${weather.home}`` or ``text:${sensor.outdoor}`` follow the
    entity, and a weather entity alone (``${weather.home}``) or after ``mdi:``
    is drawn as its condition's icon. An image that resolves to nothing (the
    entity is unavailable) is dropped, so the button falls back to the icon it
    would derive without one.
    """
    image = assign.get("image") if isinstance(assign, dict) else None
    # A `history:` graph is resolved too: it gets the version that moves it.
    if not entity_token_entities(image) and not history_entities(image):
        return assign
    # The rules themselves are in `resolve_image_tokens`, shared with the
    # toggle rule icons that accept exactly the same syntax -- weather
    # conditions included, which is why that helper and not a copy of it.
    return {**assign, "image": resolve_image_tokens(image, hass)}


def _resolve_button_icon(
    assign: dict,
    hass: HomeAssistant,
    service_icons: dict | None = None,
    internal_context: dict | None = None,
    button_ref: tuple[str, int, str] | None = None,
    icons: Any = None,
) -> str:
    """Resolve the best icon for a button, ``${_device…}`` reading as it does."""
    with button_scope(_entity_id_for_assign(assign, hass), hass):
        return _resolve_button_icon_ladder(
            assign, hass, service_icons, internal_context, button_ref, icons,
        )


def _resolve_button_icon_ladder(
    assign: dict,
    hass: HomeAssistant,
    service_icons: dict | None = None,
    internal_context: dict | None = None,
    button_ref: tuple[str, int, str] | None = None,
    icons: Any = None,
) -> str:
    """Resolve the best icon for a button, most specific rung first.

    The order is the whole contract -- see `_ICON_LADDER` and the rung each
    entry names.
    """
    config = assign.get("config", [])
    service = step_service(config) or ""
    svc_domain = service.split(".")[0] if "." in service else ""
    assign = with_resolved_image(assign, hass)

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
        assign=assign,
        service=service,
        svc_domain=svc_domain,
        svc_name=service_name(service),
        config=config,
        # An internal command fires and forgets on the device itself -- no
        # entity, no state, so the ladder answers from the registry.
        internal_cmd=get_internal_command(service),
        current_state=current_state,
        entity_id=entity_id,
        states=[],
        service_icons=service_icons,
        internal_context=internal_context,
        button_ref=button_ref,
        hass=hass,
        icons=icons,
    )
    subject = replace(subject, states=_derived_states(subject, hass))

    for rung in _ICON_LADDER:
        # Every picture a button can carry reads variables the same way --
        # per-state icons and the action's own icons as much as the image. One
        # with no value now falls to the next rung, as an empty image does.
        icon = resolve_image_tokens(rung(subject), hass)
        if icon:
            return icon
    return "mdi:cog"
