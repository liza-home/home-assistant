"""Matching an entity state to an icon, and to a tooltip."""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant, State

from ..const import (
    NEXT_STATE_MAP,
    attr_str,
    clean_label_text,
    friendly_svc,
    get_action_label,
    get_default_icon,
    get_ui_language,
    is_attribute_state_service,
    is_state_toggle_service,
    is_stateless_service,
    is_token_only_label,
    is_two_way_service,
    localize_static_name,
    name_is_source_owned,
    name_is_user_written,
    scope_action_states,
    scoped_icon_state,
    service_to_attribute,
    state_token_label,
    substitute_label_tokens,
)
from .helpers import (
    first_step,
    resolve_step_entity,
    service_name,
    subject_for_assign,
)

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tooltip computation
# ---------------------------------------------------------------------------

def _compute_next_state_tooltip(
    action: dict,
    assign: dict,
    state: State | None,
    hass: HomeAssistant,
    entry=None,
) -> str:
    """Compute dynamic tooltip showing the next state action will trigger.

    Cleaned on the way out for the same reason as ``device_sync``'s ladder: the
    result ends up inside an ``imgserv://`` URL, where a brace is fatal.

    *entry* carries the device's language option. It has to reach here as well
    as ``device_sync``: this is the *live* producer of the same tooltip, so a
    device left out of it would relabel itself in Home Assistant's language the
    first time its entity moved.
    """
    return clean_label_text(
        _compute_next_state_tooltip_inner(action, assign, state, hass, entry)
    )


def _compute_next_state_tooltip_inner(
    action: dict,
    assign: dict,
    state: State | None,
    hass: HomeAssistant,
    entry=None,
) -> str:
    """The ladder itself. See ``_compute_next_state_tooltip``."""
    service = action.get("service", "")
    svc = service_name(service)
    static_name = assign.get("label") or action.get("name") or ""
    # "${STATE}" is a shape, not a name — never hand it out as a fallback, or a
    # brace reaches the imgserv URL.
    if is_token_only_label(static_name):
        static_name = action.get("name") or ""

    lang = get_ui_language(hass, entry) if hass else "en"
    # Same rung `device_sync` localizes, or this overwrites the synced text.
    static_name = localize_static_name(static_name, lang, name_is_user_written(assign))

    if not svc:
        return static_name

    # What a setter's `${STATE}` reads: the entity's attributes, and the step's
    # own service data when it names a literal value. Both producers of this
    # tooltip must pass the same pair or the label flickers the first time the
    # entity changes -- `device_sync._fill_label_tokens` is the other one.
    _step = first_step(assign)
    step_data = _step.get("data") or {}

    # The subject is what the button targets, not the entity whose change woke
    # this. Resolved by the same helper `device_sync` uses: deriving the pair
    # separately let an unnamed target take two different states.
    subject_name, state = subject_for_assign(assign, hass, state)

    attrs = dict(state.attributes or {}) if state else None
    # What `${STATE}` resolves to for this button. Computed once: all three
    # rungs below that answer from the entity ask exactly the same question,
    # and three copies of the call is three places to forget an argument --
    # `step_data` was already missing from one of them once.
    token_state = state_token_label(svc, state.state if state else "", lang, attrs, step_data)

    # A label the user typed wins here exactly as it does in `device_sync`'s
    # tooltip ladder. Without this the two producers disagree: the initial sync
    # would send the custom label and the first state change would overwrite it
    # with an entity-derived one, so a `${STATE}` label lost its prefix.
    stored_name = (assign.get("label") or "").strip()
    token_only = is_token_only_label(stored_name)
    # See `device_sync`'s ladder: a recorded edit outranks the guess below it,
    # and releases the source-owned guard, so a lamp the user renamed by hand
    # keeps its own words on every state change too.
    user_named = name_is_user_written(assign)
    # See `device_sync`'s ladder: a name a dynamic source wrote names the
    # button's subject, so a toggle is allowed to print the state after it.
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
        and (user_named or stored_name != (action.get("name") or ""))
    ):
        # Empty after cleaning means the label was only wreckage; fall through
        # rather than blanking the tooltip. Mirrors `device_sync`'s rung.
        resolved = clean_label_text(
            substitute_label_tokens(
                stored_name,
                {"state": token_state},
            )
        )
        if resolved:
            return resolved

    entity_name = subject_name
    if not entity_name and state:
        entity_name = (
            state.attributes.get("friendly_name", "")
            or state.entity_id.split(".")[-1].replace("_", " ").title()
        )
    elif not entity_name:
        eid = resolve_step_entity(_step, hass) if _step else None
        if eid:
            entity_name = eid.split(".")[-1].replace("_", " ").title()

    # `not token_only`: "${STATE}" is a shape, not a subject, and taking it as
    # the entity name would drop the lamp from the front of the label.
    if bound_toggle and stored_name and not token_only:
        entity_name = stored_name
        if not state:
            return stored_name

    # "${STATE}" names nothing by itself, so the entity goes in front of it —
    # the same shape `device_sync` produces for the very same stored label.
    if token_only:
        resolved = substitute_label_tokens(
            stored_name,
            {"state": token_state},
        )
        if resolved:
            return f"{entity_name} {resolved}" if entity_name else resolved

    # An unrenamed attribute button announces its next action, exactly as an
    # unrenamed toggle announces its next state below. Mirrors the rung of the
    # same name in `device_sync._resolve_button_tooltip_ladder`; the two must
    # agree or the label changes the first time the entity moves.
    if is_attribute_state_service(svc):
        if token_state:
            return f"{entity_name} {token_state}" if entity_name else token_state

    if is_state_toggle_service(svc) and state:
        next_key = NEXT_STATE_MAP.get(state.state)
        if next_key:
            label = get_action_label(next_key, lang)
            return f"{entity_name} {label}" if entity_name else label

    label = friendly_svc(svc, lang)
    if label:
        return f"{entity_name} {label}" if entity_name else label

    return static_name or entity_name


# ---------------------------------------------------------------------------
# Icon / state matching
# ---------------------------------------------------------------------------

def _match_state_icon(action: dict, state: State) -> str | None:
    """Return the icon for the first matching state rule, or None."""
    for rule in scope_action_states(
        action.get("service", ""), action.get("states"),
    ):
        attr = rule.get("attribute")
        if attr:
            if attr_str(state.attributes.get(attr, "")) == rule.get("state"):
                return rule.get("icon")
        else:
            if rule.get("state") == state.state:
                return rule.get("icon")

    service = action.get("service", "")
    if not service:
        return None
    svc = service_name(service)
    # Icons follow the *entity's* domain, not the service's: a cross-domain
    # step (e.g. homeassistant.toggle on a media_player) must still resolve
    # media_player icons. The sole caller skips falsy states, and a HA State
    # always carries entity_id, so no fallback is reachable here.
    domain = state.entity_id.split(".")[0]

    if is_stateless_service(svc):
        return None

    attribute = service_to_attribute(svc)
    if attribute:
        attr_val = attr_str(state.attributes.get(attribute, ""))
        return get_default_icon(domain, attribute, attr_val)

    if is_state_toggle_service(svc):
        # A service narrower than its domain reads the shared icon table through
        # its catch-all, so `media_play_pause` on an off TV shows "press to play"
        # rather than the power glyph that entry carries for `turn_on`. A
        # one-way service gets no state-keyed icon at all.
        lookup = scoped_icon_state(svc, domain, state.state)
        return get_default_icon(domain, None, lookup) if lookup else None

    return None
