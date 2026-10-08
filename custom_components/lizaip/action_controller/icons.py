"""Matching an entity state to an icon, and to a tooltip."""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant, State

from ..const import (
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
    NEXT_STATE_MAP,
    resolve_image_tokens,
    scope_action_states,
    scoped_icon_state,
    service_to_attribute,
    state_token_label,
    substitute_label_tokens,
)
from ._state import cycle_index
from .helpers import (
    first_step,
    resolve_step_entity,
    service_name,
    subject_for_assign,
)
from .toggle import (
    MODE_CYCLE,
    rule_icon,
    rule_label,
    resolve_rule_label,
    step_icon,
    toggle_mode,
    toggle_rules,
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
    # Rung 0: a toggle rule speaks for the step actually about to run, which no
    # rung below it knows about. Only cycle mode needs the button's identity to
    # answer, and this caller repaints from a state change — which cycle mode
    # never sees — so there is nothing to pass and nothing lost by not passing
    # it. Labels are optional, so None is the ordinary answer.
    rule_text = toggle_tooltip(assign, state, hass=hass, entry=entry)
    if rule_text:
        return rule_text
    service = action.get("service", "")
    svc = service_name(service)
    static_name = assign.get("label") or action.get("name") or ""
    # "${_state}" is a shape, not a name — never hand it out as a fallback, or a
    # brace reaches the imgserv URL.
    if is_token_only_label(static_name):
        static_name = action.get("name") or ""

    lang = get_ui_language(hass, entry) if hass else "en"
    # Same rung `device_sync` localizes, or this overwrites the synced text.
    static_name = localize_static_name(static_name, lang, name_is_user_written(assign))

    if not svc:
        return static_name

    # What a setter's `${_state}` reads: the entity's attributes, and the step's
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
    # What `${_state}` resolves to for this button. Computed once: all three
    # rungs below that answer from the entity ask exactly the same question,
    # and three copies of the call is three places to forget an argument --
    # `step_data` was already missing from one of them once.
    token_state = state_token_label(svc, state.state if state else "", lang, attrs, step_data)

    # A label the user typed wins here exactly as it does in `device_sync`'s
    # tooltip ladder. Without this the two producers disagree: the initial sync
    # would send the custom label and the first state change would overwrite it
    # with an entity-derived one, so a `${_state}` label lost its prefix.
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
    # Deleting the entity prefix in front of "${_state}" is the one way to ask
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
                {"_state": token_state},
                hass,
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

    # `not token_only`: "${_state}" is a shape, not a subject, and taking it as
    # the entity name would drop the lamp from the front of the label.
    if bound_toggle and stored_name and not token_only:
        entity_name = stored_name
        if not state:
            return stored_name

    # "${_state}" names nothing by itself, so the entity goes in front of it —
    # the same shape `device_sync` produces for the very same stored label.
    if token_only:
        resolved = substitute_label_tokens(
            stored_name,
            {"_state": token_state},
            hass,
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


# ---------------------------------------------------------------------------
# Toggle rule icons
# ---------------------------------------------------------------------------

def toggle_icon(
    assign: dict,
    state: State | None,
    entry_id: str | None = None,
    page_id: int | None = None,
    button_key: str | None = None,
    entity_domain: str = "",
    service_icons: dict | None = None,
    hass: HomeAssistant | None = None,
) -> str | None:
    """The glyph a ``toggle`` block asks this button to wear right now.

    ``None`` means "nothing to say" and hands the question back to the ordinary
    ladder (``state_icons`` → the action library's ``states`` → the domain
    defaults). That is the common case even for a configured toggle: rule icons
    are optional in ``state`` mode precisely because the existing resolution
    usually gets it right, so this must not shadow it with a blank.

    Two different questions share one function because callers ask it at the
    same point in their ladder:

    * ``state`` mode answers "which rule does the subject's state select", and
      needs no identity — the state is the whole input.
    * ``cycle`` mode answers "what will the *next* press do", which is a
      property of this button on this page, so it needs the key triple. Without
      it there is no position to read and the answer is ``None`` rather than a
      guess at the first step: a caller that cannot identify the button is a
      caller that would paint the wrong one.
    """
    mode = toggle_mode(assign)
    if mode is None:
        return None

    rules = toggle_rules(assign)
    if not rules:
        return None

    if mode == MODE_CYCLE:
        if entry_id is None or page_id is None or button_key is None:
            return None
        # cycle_index reads the position the *next* press will run, which is
        # exactly what the tile should advertise. Reading never advances, so
        # repainting an icon cannot skip a step.
        index = cycle_index(entry_id, page_id, button_key, len(rules))
        # Position 0 is the button's own declared action -- the editor keeps
        # `rules[0]` a mirror of `config` -- so at rest the button wears the
        # face it would wear with no toggle at all. Handing the question back
        # means the Image field, `state_icons` and the domain defaults answer,
        # which is what the card's own Image preview already shows. Answering
        # here instead would let a cycle quietly override a pinned image.
        if index == 0:
            return None
        rule = rules[index]
        # A press icon takes the same `${sensor.x}` a button's Image does, and
        # was reaching the device with the braces still in it -- `mdi:battery-
        # ${sensor.foo}` is not an icon name, so the tile drew nothing. The
        # assignment's own image has been resolved by `with_resolved_image`
        # all along; this is the same rule, applied to the same syntax, from
        # the one place all three callers of this function pass through.
        #
        # A variable that reads nothing drops the whole value, exactly as it
        # does for a button image -- and here that is not a blank but a fall
        # through to `step_icon`, which is a better answer than half a name.
        icon = rule_icon(rule)
        if icon and hass is not None:
            icon = resolve_image_tokens(icon, hass)
        # Derived when the user picked nothing. Falling through to the
        # ordinary ladder here answers with the *declared* action's face — the
        # one glyph that is certainly wrong, because the press is about to run
        # something else and no state will ever correct it. `step_icon` names
        # the step instead.
        return icon or step_icon(rule, entity_domain, service_icons)

    return None


def toggle_tooltip(
    assign: dict,
    state: State | None,
    entry_id: str | None = None,
    page_id: int | None = None,
    button_key: str | None = None,
    hass: HomeAssistant | None = None,
    entry=None,
) -> str | None:
    """The words a ``toggle`` block asks this button to print right now.

    The tooltip twin of :func:`toggle_icon`, selecting by exactly the same
    rules so a button's face and its words can never disagree about which step
    is next — the failure the two being resolved separately would produce.

    ``None`` again means "nothing to say", handing the question to the ordinary
    tooltip ladder, which phrases "Living Room TV — pause" from the service and
    the subject's state. A label is worth storing only when that would be
    wrong — which on a cycle step, whose service is often a bare key code, is
    most of the time.
    """
    mode = toggle_mode(assign)
    if mode is None:
        return None

    rules = toggle_rules(assign)
    if not rules:
        return None

    if mode == MODE_CYCLE:
        if entry_id is None or page_id is None or button_key is None:
            return None
        index = cycle_index(entry_id, page_id, button_key, len(rules))
        # The icon twin's reasoning: position 0 mirrors `config`, so the
        # ordinary tooltip ladder already phrases it from the declared action
        # and the subject's state, and a stored label would only shadow the
        # Tooltip field the user can see on the card.
        if index == 0:
            return None
        # Resolved, not raw. This is the *other* producer of a press tooltip --
        # the one that answers while the page is being rendered, where
        # `buttons.py` answers when a press actually runs -- and it handed the
        # stored text out verbatim, so a `${_state}` press printed its braces
        # onto the tile until the first press rewrote it. The two must agree;
        # see `resolve_rule_label`.
        #
        # Without `hass` there is nothing to resolve against, and the raw text
        # is still better than nothing: the callers that can pass it do.
        if hass is None:
            return rule_label(rules[index])
        return resolve_rule_label(rules[index], hass, entry) or None

    return None
