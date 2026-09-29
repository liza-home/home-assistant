"""The slider capability table, and what a stored slider config means."""
from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant, State

from .helpers import _attr_num, _attrs, _color_modes

_LOGGER = logging.getLogger(__name__)


#: Firmware says ``slider_volume``; stored configs/presets/panel use
#: ``slider_vertical``. Alias only: renaming would break configs on disk.
SLIDER_NAME_ALIASES: dict[str, str] = {
    "slider_volume": "slider_vertical",
}


# Capability descriptors are JSON-shaped because the panel reads this table over
# the websocket. Feature bits are domain-scoped; every row carries its domain.
_MEDIA_VOLUME_SET = 4
_COVER_SET_POSITION = 4
_COVER_SET_TILT_POSITION = 128
_FAN_SET_SPEED = 1
_CLIMATE_TARGET_TEMPERATURE = 1

#: Colour modes that mean "not dimmable".
_UNDIMMABLE_COLOR_MODES = ("onoff", "unknown")


def _matches(descriptor: Mapping[str, Any] | None, state: State | None) -> bool:
    """Evaluate a descriptor; unknown or unreadable descriptors are unsupported."""
    if not descriptor:
        return True

    if "feature" in descriptor:
        features = _attrs(state).get("supported_features")
        # ``True`` is not a feature bitfield.
        if not isinstance(features, int) or isinstance(features, bool):
            return False
        return bool(features & descriptor["feature"])

    if "color_mode" in descriptor:
        return descriptor["color_mode"] in _color_modes(state)

    if descriptor.get("dimmable"):
        return any(m not in _UNDIMMABLE_COLOR_MODES for m in _color_modes(state))

    _LOGGER.debug("Slider: unrecognised capability descriptor %s", descriptor)
    return False


@dataclass(frozen=True)
class SliderControl:
    """A slider capability plus the service mechanics that drive it."""

    id: str
    domain: str
    label: str
    attribute: str
    service: str
    data_key: str
    min: float
    max: float
    icon: str
    #: Declarative support check; ``None`` means every entity in the domain.
    supported: Mapping[str, Any] | None = None
    #: Attribute names for the live min/max range, e.g. ``("min", "max")``.
    range_attrs: tuple[str, str] | None = None


#: Controls in per-domain priority order; the first supported row is the
#: last-touched default. Secondary controls require an explicit picker choice.
SLIDER_CONTROLS: tuple[SliderControl, ...] = (
    SliderControl(
        id="light-brightness", domain="light", label="Brightness",
        attribute="brightness", service="light.turn_on", data_key="brightness",
        min=0, max=255, icon="mdi:brightness-6",
        supported={"dimmable": True},
    ),
    SliderControl(
        id="light-color-temp", domain="light", label="Color temperature",
        attribute="color_temp_kelvin", service="light.turn_on",
        data_key="color_temp_kelvin", min=2000, max=6500, icon="mdi:thermometer",
        supported={"color_mode": "color_temp"},
        range_attrs=("min_color_temp_kelvin", "max_color_temp_kelvin"),
    ),
    SliderControl(
        id="media-volume", domain="media_player", label="Volume",
        attribute="volume_level", service="media_player.volume_set",
        data_key="volume_level", min=0, max=1, icon="mdi:volume-high",
        supported={"feature": _MEDIA_VOLUME_SET},
    ),
    SliderControl(
        id="cover-position", domain="cover", label="Position",
        attribute="current_position", service="cover.set_cover_position",
        data_key="position", min=0, max=100, icon="mdi:arrow-up-down",
        supported={"feature": _COVER_SET_POSITION},
    ),
    SliderControl(
        id="cover-tilt-position", domain="cover", label="Tilt position",
        attribute="current_tilt_position", service="cover.set_cover_tilt_position",
        data_key="tilt_position", min=0, max=100, icon="mdi:angle-acute",
        supported={"feature": _COVER_SET_TILT_POSITION},
    ),
    SliderControl(
        id="fan-speed", domain="fan", label="Speed",
        attribute="percentage", service="fan.set_percentage",
        data_key="percentage", min=0, max=100, icon="mdi:fan",
        supported={"feature": _FAN_SET_SPEED},
    ),
    SliderControl(
        id="number-value", domain="number", label="Value",
        attribute="value", service="number.set_value", data_key="value",
        min=0, max=100, icon="mdi:numeric",
        range_attrs=("min", "max"),
    ),
    SliderControl(
        id="climate-temperature", domain="climate", label="Target temperature",
        attribute="temperature", service="climate.set_temperature",
        data_key="temperature", min=7, max=35, icon="mdi:thermostat",
        supported={"feature": _CLIMATE_TARGET_TEMPERATURE},
        range_attrs=("min_temp", "max_temp"),
    ),
    SliderControl(
        id="humidifier-humidity", domain="humidifier", label="Target humidity",
        attribute="humidity", service="humidifier.set_humidity",
        data_key="humidity", min=0, max=100, icon="mdi:water-percent",
        range_attrs=("min_humidity", "max_humidity"),
    ),
)


def control_range(control: SliderControl, state: State | None) -> tuple[float, float]:
    """Return the live range, falling back per bound to table defaults."""
    if not control.range_attrs:
        return control.min, control.max
    lo_attr, hi_attr = control.range_attrs
    lo = _attr_num(state, lo_attr)
    hi = _attr_num(state, hi_attr)
    return (control.min if lo is None else lo, control.max if hi is None else hi)


def controls_for_entity(entity_id: str, state: State | None) -> list[SliderControl]:
    domain = str(entity_id or "").split(".")[0]
    return [
        c for c in SLIDER_CONTROLS
        if c.domain == domain and _matches(c.supported, state)
    ]


def resolve_control(
    hass: HomeAssistant, entity_id: str, control_id: str | None = None,
) -> dict | None:
    """Resolve *entity_id* to proportional slider mechanics, or None.

    The returned dict is shaped like a stored ``slider_actions`` blob in
    ``mode: "proportional"`` so the executor can reuse the same maths.

    ``control_id`` selects one supported entity control, for example colour
    temperature instead of brightness on a lamp. It is a choice among live
    ``SLIDER_CONTROLS`` rows, never partial mechanics: service, data key,
    attribute and range come from the same row, avoiding mixed Kelvin and
    brightness 0-255 config.

    Unknown or unsupported controls warn and fall back to the derived default;
    an xy-only lamp is not a bad config, just a device without colour temp.
    ``None`` means no state or no supported control, so callers must not start
    the gesture or write to an arbitrary target."""
    if not entity_id or not isinstance(entity_id, str):
        return None

    state = hass.states.get(entity_id)
    if state is None:
        _LOGGER.debug("Slider target: %s has no state — cannot resolve", entity_id)
        return None

    controls = controls_for_entity(entity_id, state)
    if not controls:
        _LOGGER.debug(
            "Slider target: %s supports no slider control (state=%s)",
            entity_id, getattr(state, "state", None),
        )
        return None

    control = controls[0]
    if control_id:
        named = next((c for c in controls if c.id == control_id), None)
        if named is None:
            _LOGGER.warning(
                "Slider target: %s does not support control '%s' — using %s",
                entity_id, control_id, control.id,
            )
        else:
            control = named
    val_min, val_max = control_range(control, state)
    return {
        "mode": "proportional",
        "control": control.id,
        "target_entity": entity_id,
        "attribute": control.attribute,
        "service": control.service,
        "data_key": control.data_key,
        "min": val_min,
        "max": val_max,
    }


#: The only strip whose empty config means "follow selection";
#: ``slider_horizontal`` is Page Settings.
#:
#: Doubles as the key a grid button's ``overrides`` block uses for its slider
#: settings, because that block *is* an override of this slot: ``overrides.py``
#: imports this name rather than respelling it, so the slot and the override of
#: it cannot drift apart.
SLIDER_VERTICAL_KEY = "slider_vertical"

#: Legacy/dialect spelling for "follow the last-touched button only".
SLIDER_TARGET_LAST_TOUCHED = "last_touched"

#: Legacy/dialect spelling for "follow selection, else the page entity".
SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY = "last_touched_or_entity"

#: Hand-written escape hatch for a proportional slider that must not follow.
SLIDER_TARGET_ENTITY = "entity"

#: Targets that resolve from the current selection.
_SELECTION_TARGETS: frozenset[str] = frozenset({
    SLIDER_TARGET_LAST_TOUCHED,
    SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY,
})


def _effective_target(slider_cfg: Any) -> str | None:
    """Return the stored target or the bare-proportional compatibility target.

    This is the single place where an absent ``target`` gets meaning. Absence
    now means following, with ``target_entity`` as the page default when present,
    matching what the panel writes for existing configs.

    The compatibility stays in the reader rather than rewriting stored configs:
    bare proportional layout pages such as ``sonos.yaml`` volume sliders must
    retarget and expose the panel's Slider section without waiting for a save.

    A bare config that names an entity follows selection with that entity as the
    fallback; one that names none has no fallback. ``SLIDER_TARGET_ENTITY`` opts
    back out, and unknown stored values pass through so membership tests reject
    them instead of guessing."""
    if not isinstance(slider_cfg, dict):
        return None
    stored = slider_cfg.get("target")
    if stored:
        return stored
    if slider_cfg.get("mode") != "proportional":
        return None
    return (
        SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY
        if slider_cfg.get("target_entity")
        else SLIDER_TARGET_LAST_TOUCHED
    )


def follows_selection(slider_cfg: Any) -> bool:
    """Whether the effective target comes from the current selection."""
    return _effective_target(slider_cfg) in _SELECTION_TARGETS


def slider_follows(slider_key: Any, assign: Any) -> bool:
    """Whether slider *slider_key* drives whatever the grid last selected.

    Central rule: absent or empty config means "follow selection" only for
    ``SLIDER_VERTICAL_KEY``. The key matters because ``handle_button_action``
    routes every slider name here; without the scope, ``slider_horizontal``
    (Page Settings, with no slider editor) would drive user entities.

    Stored configs answer through ``follows_selection``; missing configs answer
    from the key alone. Empty dicts are deliberately missing too: the panel's
    ``ensureSliderActions`` scaffolds ``{}``, so a mode-less blob is
    unconfigured. Any blob with mechanics, even an unknown ``mode``, is real
    config and is not guessed at here or in ``_effective_target``.

    Mirrored by ``sliderFollows`` in ``liza-remote-buttons-view.js``. Python and
    JS disagree on ``{}`` truthiness, so both sides must use an explicit
    emptiness test (``Object.keys(...).length === 0`` in JS)."""
    slider_cfg = assign.get("slider_actions") if isinstance(assign, dict) else None
    if not isinstance(slider_cfg, dict) or not slider_cfg:
        return slider_key == SLIDER_VERTICAL_KEY
    return follows_selection(slider_cfg)


def follows_selection_only(slider_cfg: Any) -> bool:
    """Whether behaviour is following with no fallback after compatibility rules.

    This is the derived counterpart to literal ``targets_last_touched``: it asks
    how the config behaves, so it reads through ``_effective_target`` and is true
    for a bare proportional slider that names no entity.

    Keep this as its own reader rather than open-coding
    ``follows_selection(cfg) and not cfg.get("target_entity")``; only
    ``_effective_target`` owns what an absent key means."""
    return _effective_target(slider_cfg) == SLIDER_TARGET_LAST_TOUCHED


def targets_last_touched(slider_cfg: Any) -> bool:
    """Whether *slider_cfg* literally stores following-with-no-default.

    This one-key reader keeps the executor, sanitiser and layout writer aligned.
    It must stay literal because layout YAML still uses the target as dialect
    input for ``generate_assignments``, while the sanitiser preserves legacy
    spellings based on what was written, not on inferred behaviour.

    It is strictly the target with no stored mechanics and must not include
    ``SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY``, whose point is keeping them."""
    return (
        isinstance(slider_cfg, dict)
        and slider_cfg.get("target") == SLIDER_TARGET_LAST_TOUCHED
    )


def targets_last_touched_or_entity(slider_cfg: Any) -> bool:
    """Literal legacy/dialect spelling for following with a default entity."""
    return (
        isinstance(slider_cfg, dict)
        and slider_cfg.get("target") == SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY
    )


def targets_entity(slider_cfg: Any) -> bool:
    """Whether the config explicitly opts out of following.

    Recognising this value preserves it through panel saves; dropping it would
    convert the slider to following because absence now follows.
    """
    return (
        isinstance(slider_cfg, dict)
        and slider_cfg.get("target") == SLIDER_TARGET_ENTITY
    )


def last_touched_slider_actions(factor: float) -> dict[str, Any]:
    """Build the stored blob for a slider that drives the last-touched device.

    Shared by the panel save path and layout YAML because the absent keys are the
    contract. Target, entity, attribute, service, data key and range must be
    omitted: the executor reads stored mechanics first, so stale leftovers from a
    previous mode would pin the slider to the wrong entity.

    Omitting ``target`` is deliberate, not an oversight; ``_effective_target``
    reads a bare proportional blob with no entity as last-touched. Legacy configs
    that spell the target are still accepted, but new writes avoid restating it.

    ``mode`` remains ``"proportional"`` because the drag maths are unchanged;
    ``factor`` is the slider's own physical-track mechanic and is already coerced
    by the caller (panel JSON vs layout YAML)."""
    return {
        "mode": "proportional",
        "factor": factor,
    }


def last_touched_or_entity_slider_actions(
    hass: HomeAssistant, entity_id: str, factor: float,
) -> dict[str, Any] | None:
    """Build the stored blob for following the selection, else *entity_id*.

    Unlike ``last_touched_slider_actions``, the fallback must be a complete fixed
    slider because ``_resolve_selection_config`` returns that branch verbatim.
    Entity, attribute, service, data key and range must be derived together via
    ``resolve_control``; a half-written blob would be partial mechanics, and the
    resolver deliberately refuses to merge or repair those.

    Using the same live capability table as the selection path keeps a layout
    that names only an entity from disagreeing with a touch on that entity, and
    avoids YAML traps such as reading brightness 0-255 while writing
    ``brightness_pct``.

    The fallback range is intentionally baked in at page creation, like any fixed
    slider. That is not the stale-entity problem the last-touched path avoids; a
    lamp whose range later changes needs the page re-created.

    Return ``None`` when no state/control can be resolved rather than inventing
    mechanics. ``target`` stays absent because ``target_entity`` is the
    ``_effective_target`` discriminator for following-with-default."""
    resolved = resolve_control(hass, entity_id) if hass is not None else None
    if not resolved:
        return None
    return {
        **resolved,
        "factor": factor,
    }


def serialized_controls() -> list[dict[str, Any]]:
    """The capability table as JSON for the config panel."""
    return [
        {
            "id": c.id,
            "domain": c.domain,
            "label": c.label,
            "attribute": c.attribute,
            "service": c.service,
            "data_key": c.data_key,
            "min": c.min,
            "max": c.max,
            "icon": c.icon,
            "supported": dict(c.supported) if c.supported else None,
            # JSON has no tuples; the panel destructures this positionally.
            "range_attrs": list(c.range_attrs) if c.range_attrs else None,
        }
        for c in SLIDER_CONTROLS
    ]
