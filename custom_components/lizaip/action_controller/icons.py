"""Matching an entity state to an icon, and to a tooltip."""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant, State

from ..shared.services import icon_state_key, state_icon_override
from ..shared.tokens import (
    resolve_image_tokens,
)
from ..shared.icon_defaults import IconDefaults, icon_defaults
from ._state import cycle_index
from .toggle import (
    rule_icon,
    rule_service,
    rule_state_icons,
    rule_tooltip,
    resolve_rule_tooltip,
    step_icon,
    step_tooltip,
    toggle_mode,
    toggle_rules,
)

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

_LOGGER = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tooltip computation
# ---------------------------------------------------------------------------

def _compute_next_state_tooltip(
    assign: dict[str, Any],
    state: State | None,
    hass: HomeAssistant,
    entry: ConfigEntry | None = None,
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

def _match_state_icon(service: str, state: State, icons: IconDefaults | None = None) -> str | None:
    """Return the themed icon *service* wears for *state*, or None.

    *icons* is the asking remote's table; the shipped one when a caller speaks
    for no remote.
    """
    table = icons or icon_defaults
    if not service:
        return None
    # Icons follow the *entity's* domain, not the service's: a cross-domain
    # step (e.g. homeassistant.toggle on a media_player) must still resolve
    # media_player icons.
    attribute, key = icon_state_key(service, state)
    return table.for_state(state.entity_id.split(".")[0], attribute, key) if key else None


# ---------------------------------------------------------------------------
# Toggle rule icons
# ---------------------------------------------------------------------------

def toggle_icon(
    assign: Mapping[str, Any],
    state: State | None,
    entry_id: str | None = None,
    page_id: int | None = None,
    button_key: str | None = None,
    entity_domain: str = "",
    service_icons: dict[str, Any] | None = None,
    hass: HomeAssistant | None = None,
    icons: IconDefaults | None = None,
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
    if toggle_mode(assign) is None:
        return None

    rules = toggle_rules(assign)
    if entry_id is None or page_id is None or button_key is None:
        return None
    # The position the *next* press runs; reading never advances the cycle.
    index = cycle_index(entry_id, page_id, button_key, len(rules))
    # Position 0 mirrors `config`, so the ordinary ladder answers and a cycle
    # never overrides a pinned image.
    if index == 0:
        return None
    rule = rules[index]
    # Resolve `${sensor.x}` like a button Image does; an empty variable drops
    # the value and falls through to `step_icon`.
    icon = state_icon_override(
        rule_state_icons(rule), state, rule_service(rule) or "",
    ) or rule_icon(rule)
    if icon and hass is not None:
        icon = resolve_image_tokens(icon, hass)
    # Nothing picked: name the step, not the declared action's face, which is
    # certainly wrong for a press that runs something else.
    return icon or step_icon(rule, entity_domain, service_icons, icons)


def toggle_tooltip(
    assign: dict[str, Any],
    state: State | None,
    entry_id: str | None = None,
    page_id: int | None = None,
    button_key: str | None = None,
    hass: HomeAssistant | None = None,
    entry: ConfigEntry | None = None,
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
    if toggle_mode(assign) is None:
        return None

    rules = toggle_rules(assign)
    if entry_id is None or page_id is None or button_key is None:
        return None
    index = cycle_index(entry_id, page_id, button_key, len(rules))
    # As for the icon: position 0 mirrors `config`, so the ordinary tooltip
    # ladder answers and the card's Tooltip field is not shadowed.
    if index == 0:
        return None
    # Resolved like `buttons.py` does on press, so `${_state}` never shows its
    # braces; without `hass` the raw text is still better than nothing.
    if hass is None:
        return rule_tooltip(rules[index])
    # The twin of the `icon or step_icon(...)` line above: stored words
    # first, then the ones this press derives from its own step.
    return (
        resolve_rule_tooltip(rules[index], hass, entry)
        or step_tooltip(rules[index], hass, entry)
        or None
    )
