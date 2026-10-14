"""``${sensor.x}`` entity variables and ``${_device}`` in labels, tooltips and icons."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any, Final

from ..variables_calc import (
    _EXPR_ENTITY_RE,
    FUNCTION_TOKEN_RE,
    function_token_value,
    variables_enabled,
)
from .history import versioned_history_image
from .icon_urls import is_media_source
from .i18n import get_ui_language
from .labels import DANGLING_SEPARATOR_RE, LABEL_TOKEN_RE

if TYPE_CHECKING:
    # Type-only: this module stays importable without Home Assistant, which is
    # what keeps it a leaf the rest of the integration can depend on freely.
    from homeassistant.core import HomeAssistant


# ---------------------------------------------------------------------------
# ``${sensor.x}`` entity variables in tooltips and icons
# ---------------------------------------------------------------------------

#: ``${domain.object_id}`` or ``${domain.object_id.attribute}``. Told apart from
#: ``${_state}`` by the dot, so the two never claim the same text.
ENTITY_TOKEN_RE = re.compile(
    r"\$\{\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\s*\}"
)

#: ``${_device}`` in a layout page's title: the device (or hub) the page is
#: bound to, by the name Home Assistant shows for it. ``_device`` is accepted
#: as well.
DEVICE_TOKEN_RE = re.compile(r"\$\{\s*_device\s*\}")

#: ``_device.attribute`` inside a ``${…}``: the page's own entity standing in
#: for its id, so a title reads ``${_device.volume_level}`` -- or a calculation
#: such as ``${_device.volume_level * 100}`` -- without naming ``media_player.…``.
DEVICE_ATTRIBUTE_RE = re.compile(r"(?<![\w.])_device\.([A-Za-z0-9_]+)")
_VARIABLE_BODY_RE = re.compile(r"\$\{([^{}]*)\}")

#: States that say the entity has nothing to report. A variable reading one of
#: them resolves to nothing rather than printing "unavailable" on the remote.
_NO_VALUE_STATES: Final = frozenset({"unavailable", "unknown", ""})


#: A weather entity's state is a condition code ("partlycloudy"), neither a word
#: to print nor an icon name. Icons as the HA frontend draws them; every slug
#: starts with ``weather-`` so ``mdi:weather-${weather.x}`` stays one icon.
WEATHER_CONDITION_ICONS: Final = {
    "clear-night": "weather-night",
    "cloudy": "weather-cloudy",
    "exceptional": "weather-cloudy-alert",
    "fog": "weather-fog",
    "hail": "weather-hail",
    "lightning": "weather-lightning",
    "lightning-rainy": "weather-lightning-rainy",
    "partlycloudy": "weather-partly-cloudy",
    "pouring": "weather-pouring",
    "rainy": "weather-rainy",
    "snowy": "weather-snowy",
    "snowy-rainy": "weather-snowy-rainy",
    "sunny": "weather-sunny",
    "windy": "weather-windy",
    "windy-variant": "weather-windy-variant",
}

#: Home Assistant's English names for the conditions, for when its translation
#: cache has none in the wanted language.
WEATHER_CONDITION_LABELS: Final = {
    "clear-night": "Clear, night",
    "cloudy": "Cloudy",
    "exceptional": "Exceptional",
    "fog": "Fog",
    "hail": "Hail",
    "lightning": "Lightning",
    "lightning-rainy": "Lightning, rainy",
    "partlycloudy": "Partly cloudy",
    "pouring": "Pouring",
    "rainy": "Rainy",
    "snowy": "Snowy",
    "snowy-rainy": "Snowy, rainy",
    "sunny": "Sunny",
    "windy": "Windy",
    "windy-variant": "Windy, cloudy",
}


def _weather_condition_label(hass: HomeAssistant, condition: str) -> str:
    """*condition* as Home Assistant names it in the UI language."""
    try:
        from homeassistant.helpers.translation import async_get_cached_translations
        cached = async_get_cached_translations(
            hass, get_ui_language(hass), "entity_component", "weather",
        )
    except Exception:
        cached = {}
    label = cached.get(f"component.weather.entity_component._.state.{condition}")
    return label if isinstance(label, str) and label else WEATHER_CONDITION_LABELS[condition]


def weather_condition_icon(hass: HomeAssistant, entity_id: str) -> str | None:
    """The icon slug (``weather-sunny``) for a weather entity's condition."""
    if not entity_id.startswith("weather.") or hass is None:
        return None
    state = hass.states.get(entity_id)
    return WEATHER_CONDITION_ICONS.get(getattr(state, "state", None))


def entity_token_entities(text: Any) -> set[str]:
    """Entity ids named by ``${domain.object_id[.attribute]}`` in *text*."""
    if not isinstance(text, str) or "${" not in text:
        return set()
    found = {m.group(1).lower() for m in ENTITY_TOKEN_RE.finditer(text)}
    for m in FUNCTION_TOKEN_RE.finditer(text):
        found.update(e.group(1).lower() for e in _EXPR_ENTITY_RE.finditer(m.group(1)))
    return found


def _display_precision(hass: HomeAssistant, entity_id: str) -> int | None:
    """The number of decimals Home Assistant shows *entity_id* with, if set."""
    try:
        from homeassistant.helpers import entity_registry as er
        entry = er.async_get(hass).async_get(entity_id)
    except Exception:
        return None
    if entry is None:
        return None
    options = (entry.options or {}).get("sensor") or {}
    for key in ("display_precision", "suggested_display_precision"):
        value = options.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None


def _format_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, (list, tuple, set)):
        return ", ".join(_format_value(v) for v in value if v is not None)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def entity_token_value(
    hass: HomeAssistant,
    entity_id: str,
    attribute: str | None = None,
    with_unit: bool = True,
) -> str:
    """What ``${entity_id}`` (or ``${entity_id.attribute}``) reads right now.

    The state comes with its unit ("21.5 °C") and rounded to the precision
    Home Assistant shows it with. A weather condition reads as Home Assistant
    names it ("Partly cloudy"), except in an icon name (*with_unit* False),
    where the raw code is kept. An attribute is printed as stored. Missing,
    unknown or unavailable reads as nothing, so the token collapses away.
    """
    state = hass.states.get(entity_id) if hass is not None else None
    if state is None:
        return ""
    if attribute:
        return _format_value((state.attributes or {}).get(attribute))
    value = state.state
    if not isinstance(value, str) or value in _NO_VALUE_STATES:
        return ""
    if with_unit and entity_id.startswith("weather.") and value in WEATHER_CONDITION_LABELS:
        return _weather_condition_label(hass, value)
    precision = _display_precision(hass, entity_id)
    if precision is not None:
        try:
            value = f"{float(value):.{precision}f}"
        except ValueError:
            pass
    unit = (state.attributes or {}).get("unit_of_measurement")
    return f"{value} {unit}" if with_unit and isinstance(unit, str) and unit else value


def _function_value(hass: HomeAssistant | None, match) -> str:
    return function_token_value(hass.states.get if hass is not None else None, match.group(1))


def substitute_entity_tokens(text: Any, hass: HomeAssistant | None) -> Any:
    """Replace every ``${domain.object_id[.attribute]}`` in *text* with its value.

    Anything other than a string with a token in it is returned unchanged.
    """
    if not isinstance(text, str) or "${" not in text:
        return text
    text = _with_page_device(text, hass)
    if not variables_enabled():
        # Switched off for this remote: a variable is not read, it is gone.
        return ENTITY_TOKEN_RE.sub("", FUNCTION_TOKEN_RE.sub("", text))
    text = FUNCTION_TOKEN_RE.sub(lambda m: _function_value(hass, m), text)
    return ENTITY_TOKEN_RE.sub(
        lambda m: entity_token_value(hass, m.group(1).lower(), m.group(2)), text,
    )


def layout_target_name(hass: HomeAssistant | None, layout: Any) -> str:
    """The name of the device or hub a layout page is bound to, "" if none.

    The name the user gave it first, then the integration's; a hub is named by
    its config entry's title. A target that cannot be found falls back to its
    entity's friendly name, and then to nothing.
    """
    if hass is None or not isinstance(layout, dict):
        return ""
    target = layout.get("target")
    if not isinstance(target, dict):
        return ""
    entry_id = target.get("config_entry")
    if entry_id:
        target_entry = hass.config_entries.async_get_entry(entry_id)
        if target_entry is not None and target_entry.title:
            return target_entry.title
    device_id = target.get("device")
    if device_id:
        from homeassistant.helpers import device_registry as dr
        device = dr.async_get(hass).async_get(device_id)
        name = device and (device.name_by_user or device.name)
        if name:
            return name
    entity_id = target.get("entity_id")
    state = hass.states.get(entity_id) if entity_id else None
    return _format_value((state.attributes or {}).get("friendly_name")) if state else ""


def expand_device_alias(text: Any, layout: Any) -> Any:
    """*text* with ``${_device.attribute}`` spelled out as the page's entity.

    ``${_device.volume_level}`` becomes ``${media_player.tv.volume_level}``, an
    ordinary entity variable from then on -- read, formatted and watched like
    one; inside a calculation (``${_device.volume_level * 100}``) likewise. A
    page with no entity (a hub, or no layout) reads nothing there.
    """
    if not isinstance(text, str) or "${" not in text:
        return text
    target = layout.get("target") if isinstance(layout, dict) else None
    entity_id = target.get("entity_id") if isinstance(target, dict) else ""

    def _expand(match: re.Match) -> str:
        body = match.group(1)
        if not DEVICE_ATTRIBUTE_RE.search(body):
            return match.group(0)
        if not entity_id:
            return ""
        body = DEVICE_ATTRIBUTE_RE.sub(lambda m: f"{entity_id}.{m.group(1)}", body)
        return f"${{{body.strip()}}}"

    return _VARIABLE_BODY_RE.sub(_expand, text)


#: The layout of the page being drawn, for ``${_device…}`` in its tiles and
#: tooltips. ``_NO_PAGE`` outside any :func:`page_scope`: the variable is then
#: left for whoever knows the page (the panel expands it before asking).
_NO_PAGE: Final = object()
_PAGE_LAYOUT: ContextVar[Any] = ContextVar("lizaip_page_layout", default=_NO_PAGE)


@contextmanager
def page_scope(layout: Any) -> Iterator[None]:
    """Read ``${_device…}`` as the page with *layout* has it, inside the block."""
    token = _PAGE_LAYOUT.set(layout if isinstance(layout, dict) else None)
    try:
        yield
    finally:
        _PAGE_LAYOUT.reset(token)


def current_page_layout() -> Any:
    """The layout :func:`page_scope` set, None for a plain page or no scope."""
    layout = _PAGE_LAYOUT.get()
    return None if layout is _NO_PAGE else layout


def _with_page_device(text: Any, hass: HomeAssistant | None) -> Any:
    """*text* with ``${_device…}`` filled in for the page in scope, if any."""
    if not isinstance(text, str) or "_device" not in text:
        return text
    layout = _PAGE_LAYOUT.get()
    if layout is _NO_PAGE:
        return text
    return substitute_device_token(text, hass, layout)


def substitute_device_token(text: Any, hass: HomeAssistant | None, layout: Any) -> Any:
    """*text* with the ``${_device}`` variables of a layout page filled in.

    ``${_device.attribute}`` is left as the entity variable it stands for, for
    the entity pass that follows; ``${_device}`` becomes the device's name.
    """
    text = expand_device_alias(text, layout)
    if not isinstance(text, str) or not DEVICE_TOKEN_RE.search(text):
        return text
    name = layout_target_name(hass, layout)
    return DEVICE_TOKEN_RE.sub(lambda _m: name, text).strip()


def resolve_image_tokens(image: Any, hass: HomeAssistant | None) -> Any:
    """*image* with its entity variables filled in, or None if one has no value.

    ``mdi:weather-${weather.home}`` or ``text:${sensor.outdoor}`` follow the
    entity, and a weather entity alone (``${weather.home}``) or after ``mdi:``
    is drawn as its condition's icon. Used for every picture a button can
    carry -- its image, its per-state icons, its action's icons, a toggle
    rule's icon -- and the page title, so all of them read variables the same
    way. Anything without a variable is returned unchanged.

    Lives here rather than in ``config.button_rendering``, where it grew, so
    that ``action_controller.icons`` can reach it too: a toggle rule's icon
    accepts exactly the same syntax as a button's and had been going to the
    device unresolved. ``config.button_rendering`` imports *from* that module,
    so the shared piece cannot live in either.
    """
    image = versioned_history_image(_with_page_device(image, hass), hass)
    if not entity_token_entities(image):
        return image
    if not variables_enabled():
        return None
    # All or nothing: half an icon name ("mdi:weather-") draws a broken glyph.
    missing = False
    # A unit belongs in drawn text, never in a name: "mdi:battery-80 %" is no
    # icon at all. Text is a ``text:`` image or one with no scheme before the
    # variable, which `resolve_icon_url` draws as text.
    prefix = image.split("${", 1)[0]
    with_unit = prefix.lower().startswith("text:") or ":" not in prefix
    whole = ENTITY_TOKEN_RE.fullmatch(image.strip())

    def _value(match) -> str:
        nonlocal missing
        eid = match.group(1).lower()
        icon = None if match.group(2) else weather_condition_icon(hass, eid)
        if icon:
            # A weather condition is drawn as its icon: alone it is the whole
            # name, after "mdi:" the slug, after "mdi:weather-" the rest of it.
            before = image[:match.start()].lower()
            if whole:
                return f"mdi:{icon}"
            if before.endswith("mdi:weather-"):
                return icon.removeprefix("weather-")
            if before.endswith("mdi:"):
                return icon
        value = entity_token_value(hass, eid, match.group(2), with_unit)
        missing = missing or not value
        return value

    def _function(match) -> str:
        nonlocal missing
        value = _function_value(hass, match)
        missing = missing or not value
        return value

    resolved = ENTITY_TOKEN_RE.sub(_value, FUNCTION_TOKEN_RE.sub(_function, image)).strip()
    return None if missing or not resolved else resolved


def substitute_label_tokens(
    text: str, values: dict[str, str], hass: HomeAssistant | None = None,
) -> str:
    """Replace ``${TOKEN}`` placeholders in *text* from *values*.

    With *hass*, entity variables (``${sensor.x}``) are filled in first.

    Token matching is case-insensitive and tolerates inner whitespace, so
    ``${_state}``, ``${_STATE}`` and ``${ _state }`` are the same token. A token
    with no value — unknown name, or a state the button cannot predict —
    collapses to nothing, and the whitespace it leaves behind is collapsed with
    it so the result never has a doubled or trailing space.
    """
    if not text or "${" not in text:
        return text
    lookup = {k.lower(): v for k, v in values.items()}
    if is_media_source(text):
        # A picture keeps its entity variables for `finish_tooltip`, which
        # reads them by the picture rules (no unit inside an icon name).
        return LABEL_TOKEN_RE.sub(lambda m: lookup.get(m.group(1).lower(), ""), text)
    if hass is not None:
        text = substitute_entity_tokens(text, hass)
    substituted = LABEL_TOKEN_RE.sub(lambda m: lookup.get(m.group(1).lower(), ""), text)
    # A token that collapsed can leave a separator joining nothing — a goto
    # whose page was deleted printed a dangling "Go to page:". Trimmed here
    # rather than in `clean_label_text`, which sees the text *after* this and
    # so cannot tell a resolved-away token from a colon the user typed.
    return clean_label_text(DANGLING_SEPARATOR_RE.sub("", substituted))


# A placeholder the user has damaged while editing: an opening ``${`` that
# LABEL_TOKEN_RE could not match, because the closing brace is missing or there
# is something other than a word between the braces. Measured on the device: a
# stored name of ``Schreibtisch ${STATE`` reached the wire as
# ``imgserv://text:Schreibtisch ${STATE?size=tooltip``, putting a brace in the
# URL — the exact thing the token regex is careful to prevent for ``${}``.
# Bounded to a token-shaped run, not to the next brace: a greedy match would
# eat the rest of the label, turning "Vor ${STATE nach" into "Vor".
_BROKEN_TOKEN_RE = re.compile(r"\$\{\s*[\w.]*\s*\}?")
# A whole variable that was never filled in, calculation included: removed as
# one, or the broken-token pass would strip only "${floor" and print the rest.
_WHOLE_TOKEN_RE = re.compile(r"\$\{[^{}$]*\}")

def clean_label_text(text: str) -> str:
    """Make *text* safe to put in an imgserv URL and tidy to read.

    Drops any placeholder wreckage left over after substitution and collapses
    runs of whitespace. The whitespace part is not only cosmetic: an entity
    whose ``friendly_name`` ends in a space (a real one on the user's system is
    ``"Schreibtisch "``) otherwise reads ``Schreibtisch  On`` on the remote.
    """
    if not text or is_media_source(text):
        # A picture is finished by `finish_tooltip`, not tidied as words.
        return text
    had_token = "${" in text
    if had_token:
        text = _BROKEN_TOKEN_RE.sub("", _WHOLE_TOKEN_RE.sub("", text))
    # Anything still holding a brace cannot be parsed as a URL by the device.
    if "{" in text or "}" in text:
        text = text.replace("{", "").replace("}", "")
    if had_token:
        text = DANGLING_SEPARATOR_RE.sub("", text)
    return " ".join(text.split())


def finish_tooltip(text: str, hass: HomeAssistant | None) -> str:
    """The tooltip as the remote gets it.

    A tooltip that names a picture (``mdi:…``, ``text:…``, ``history:…``, a
    URL) goes through the same steps as a button's image and a page's title
    (:func:`resolve_image_tokens`): its variables are filled in without a unit
    inside an icon name, a weather entity becomes its icon, a graph gets its
    version, and a variable with no value leaves no picture at all. Words are
    tidied by :func:`clean_label_text`.
    """
    if text and is_media_source(text):
        return resolve_image_tokens(text.strip(), hass) or ""
    return clean_label_text(text)
