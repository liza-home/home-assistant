"""Matching an entity state to an icon, and to a tooltip."""
from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant, State

from ..shared.services import (
    attr_str,
    is_state_toggle_service,
    is_stateless_service,
    scoped_icon_state,
    service_to_attribute,
    service_name,
)
from ..shared.tokens import (
    resolve_image_tokens,
)
from ..shared.icon_defaults import icon_defaults
from ._state import cycle_index
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
    assign: dict,
    state: State | None,
    hass: HomeAssistant,
    entry=None,
    library_name: str | None = None,
) -> str:
    """The tooltip a live update sends: the page sync's own ladder.

    One ladder, so the label cannot read one thing at sync time and another the
    first time *state* -- the entity whose change woke this -- moves.
    """
    # Imported here: `button_rendering` imports this module.
    from ..config.button_rendering import _resolve_button_tooltip

    return _resolve_button_tooltip(
        assign, hass, entry, state=state, library_name=library_name,
    )


# ---------------------------------------------------------------------------
# Icon / state matching
# ---------------------------------------------------------------------------

def _match_state_icon(service: str, state: State, icons=None) -> str | None:
    """Return the themed icon *service* wears for *state*, or None.

    *icons* is the asking remote's table; the shipped one when a caller speaks
    for no remote.
    """
    table = icons or icon_defaults
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
        return table.for_state(domain, attribute, attr_val)

    if is_state_toggle_service(svc):
        # A service narrower than its domain reads the shared icon table through
        # its catch-all, so `media_play_pause` on an off TV shows "press to play"
        # rather than the power glyph that entry carries for `turn_on`. A
        # one-way service gets no state-keyed icon at all.
        lookup = scoped_icon_state(svc, domain, state.state)
        return table.for_state(domain, None, lookup) if lookup else None

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
    icons=None,
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
        return icon or step_icon(rule, entity_domain, service_icons, icons)

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
