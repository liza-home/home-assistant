"""How a button's icon is drawn, derived from the bound entity's state.

The tint (:mod:`state_color`) and the fill level (:mod:`state_brightness`) are
two facets of one question -- "what does this entity's state say about its
tile?" -- and they travel together: every caller wants both, for the same
target, in the same ``resolve_icon_url`` call. This module resolves them in a
single pass, so a target is walked once rather than once per facet.

Resolving them together is also what keeps the two consistent. Read separately,
each facet took the first entity that offered *it*, and on a multi-entity target
those can be different entities -- a dimmable white bulb supplying the fill
while a second, coloured lamp supplied the tint, drawing a tile neither lamp is
showing. Here the first entity that offers any styling supplies both, which is
what the panel has always done via ``_getTargetEntityFromConfig``.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from homeassistant.core import HomeAssistant, State

from . import optimistic as _optimistic
from .state_brightness import (
    entity_brightness_percent,
    has_brightness,
    read_fill_enabled,
    read_fill_step,
)
from .shared.services import shows_state_color
from .state_color import (
    entity_icon_color,
    entity_state_color,
    is_tintable,
    read_color_enabled,
)


@dataclass(frozen=True)
class IconStyle:
    """The state-derived half of a tile's appearance: its tint and its fill."""

    color: str = ""
    percent: int | None = None
    state: str = ""

    def __bool__(self) -> bool:
        """Whether the entity said anything about *how to draw* the tile.

        The state colour is deliberately not counted: every bound entity has
        one, and a target is walked for the member that offers a tint or a
        fill. Counting it would stop that walk at the first member every time.
        """
        return bool(self.color) or self.percent is not None

    def on_page(self, page_color: str) -> IconStyle:
        """This style resolved against *page_color*, lowest priority last.

        A lit lamp's own colour beats the page's, and the page's beats the
        theme's colour for what the entity is doing. A button bound to nothing
        keeps ``""`` and so takes the theme's ``default`` colour.
        """
        return IconStyle(
            self.color or page_color or self.state, self.percent, self.state,
        )


def is_styleable(entity_id: str) -> bool:
    """Whether *entity_id* could ever style a tile, in either facet.

    "Could this ever be styled", not "is it styled now": an off lamp yields
    nothing, and that is exactly when its button must drop what it is wearing.
    """
    return is_tintable(entity_id) or has_brightness(entity_id)


@dataclass(frozen=True)
class IconStyleOptions:
    """What an entry's options say about how its tiles are styled."""

    step: int
    fill: bool
    tint: bool


def read_icon_style_options(options: object) -> IconStyleOptions:
    """Read all three styling options from an entry's ``options`` at once.

    One call per producer rather than three, so a new producer cannot pick up
    two of the three and draw a tile the others do not.
    """
    return IconStyleOptions(
        step=read_fill_step(options),
        fill=read_fill_enabled(options),
        tint=read_color_enabled(options),
    )


def entity_icon_style(
    state: State | None,
    assume_state: str | None = None,
    *,
    step: int | None = None,
    fill: bool = True,
    tint: bool = True,
) -> IconStyle:
    """Both facets of *state*, with no page fallback applied.

    *assume_state* overrides the on/off test in both, so a press predicted to
    turn a lamp off does not draw the off icon in the style it is about to lose.

    *step* is the configured fill quantum. It is threaded from the call site
    rather than read here because every producer of a tile URL has to agree on
    it: a full page sync and the live listener drawing the same button at
    different steps would restyle a freshly-pushed tile on the next state
    change. ``None`` means the default.

    *fill* and *tint* switch the two facets off independently. A switched-off
    facet yields what an entity with nothing to say yields, so a disabled
    feature leaves no trace rather than taking its own path through the renderer.

    Both default to on here because this is a pure function of its arguments;
    the entry's default-off lives with the options that carry it. Neither
    switches the state colour off: that is the theme's, not a feature.
    """
    return IconStyle(
        color=entity_icon_color(state, assume_state) if tint else "",
        percent=(
            entity_brightness_percent(state, assume_state, step=step)
            if fill else None
        ),
        state=entity_state_color(state, assume_state),
    )


def _target_state_color(hass: HomeAssistant, entity_ids: list[str]) -> str:
    """The theme's state colour for *entity_ids* read as one.

    The group's state rather than the first member's, so a room whose single
    lit lamp is listed last still draws as on -- the same rule the label and
    the icon already follow.
    """
    # Inline: action_controller -> buttons -> this module, so a top-level
    # import re-enters a half-built package.
    from .action_controller import resolve_group_state

    state = resolve_group_state(entity_ids, hass)
    if state is None:
        return ""
    return entity_state_color(_optimistic.apply(state, state.entity_id))


def icon_style_for_entities(
    hass: HomeAssistant | None,
    entity_ids: list[str],
    page_color: str = "",
    *,
    step: int | None = None,
    fill: bool = True,
    tint: bool = True,
    service: str = "",
) -> IconStyle:
    """Style for an already-resolved target: the first member that offers one.

    A multi-entity target is judged as a whole -- picking the entity that
    happened to change lets an off lamp wipe a lit one's styling.

    The state colour is resolved whatever the two options say, because it is
    the theme speaking rather than a feature: a remote with both switched off
    still draws its buttons in the theme's colour for what they are doing.
    A *service* the state says nothing about (next track, play) keeps the
    theme's "anything else" colour instead.
    """
    if hass is None:
        return IconStyle(page_color)
    state_color = (
        _target_state_color(hass, entity_ids) if shows_state_color(service) else ""
    )
    if fill or tint:
        for entity_id in entity_ids:
            # Through the prediction layer, so a tile being dragged is drawn
            # from the value we just commanded instead of the one the lamp has
            # got round to reporting. A no-op unless a prediction is live.
            state = _optimistic.apply(hass.states.get(entity_id), entity_id)
            style = entity_icon_style(state, step=step, fill=fill, tint=tint)
            if style:
                return replace(style, state=state_color).on_page(page_color)
    return IconStyle(state=state_color).on_page(page_color)


def icon_style_for(
    hass: HomeAssistant | None,
    step: dict | None,
    page_color: str = "",
    *,
    fill_step: int | None = None,
    fill: bool = True,
    tint: bool = True,
) -> IconStyle:
    """Style for the button whose first config *step* is given.

    Falls back to *page_color* with no fill when the step targets nothing,
    targets a non-light, or the light is off.
    """
    if hass is None or not isinstance(step, dict):
        return IconStyle(page_color)

    # Inline: action_controller -> buttons -> this module, so a top-level import
    # re-enters a half-built package.
    from .action_controller import resolve_target_entities

    return icon_style_for_entities(
        hass, resolve_target_entities(step, hass), page_color,
        step=fill_step, fill=fill, tint=tint,
        service=step.get("action") or step.get("service") or "",
    )
