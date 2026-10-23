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
)
from .history import versioned_history_image
from .icon_urls import is_media_source
from .i18n import get_ui_language
from ..media_queue.alias import device_attribute, expand_queue_alias
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

#: ``${_device}`` in a template page's title: the device (or hub) the page is
#: bound to, by the name Home Assistant shows for it. ``_device`` is accepted
#: as well.
DEVICE_TOKEN_RE = re.compile(r"\$\{\s*_device\s*\}")

#: ``_device.attribute`` inside a ``${…}``: the page's own entity standing in
#: for its id, so a title reads ``${_device.volume_level}`` -- or a calculation
#: such as ``${_device.volume_level * 100}`` -- without naming ``media_player.…``.
#: A page bound to a hub rather than a device has no page entity and so can
#: answer no attribute; the facts below are what it can answer.
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
    text = FUNCTION_TOKEN_RE.sub(lambda m: _function_value(hass, m), text)
    return ENTITY_TOKEN_RE.sub(
        lambda m: entity_token_value(hass, m.group(1).lower(), m.group(2)), text,
    )


def _template_target(template: Any) -> dict:
    """What a template page is bound to, {} for anything that is not a page."""
    target = template.get("target") if isinstance(template, dict) else None
    return target if isinstance(target, dict) else {}


def template_target_entity(template: Any) -> str:
    """The entity a template page is bound to, "" when it is bound to a hub."""
    return _template_target(template).get("entity_id") or ""


def _entry_title(hass: HomeAssistant | None, template: Any) -> str:
    """The title of the config entry a hub page is bound to, "" if none."""
    entry_id = _template_target(template).get("config_entry")
    if hass is None or not entry_id:
        return ""
    entry = hass.config_entries.async_get_entry(entry_id)
    return entry.title if entry is not None and entry.title else ""


def _entity_name(hass: HomeAssistant | None, template: Any) -> str:
    """The friendly name of the entity a page is bound to, "" if none."""
    entity_id = template_target_entity(template)
    state = hass.states.get(entity_id) if hass is not None and entity_id else None
    return _format_value((state.attributes or {}).get("friendly_name")) if state else ""


def template_target_name(hass: HomeAssistant | None, template: Any) -> str:
    """What ``${_device}`` says: the name of the page's device, "" if none.

    The name the user gave it first, then the integration's -- the device's
    own name either way, because that is what Home Assistant shows for it
    everywhere else. A hub whose bridge cannot be found falls back to its
    config entry's title, a label over the integration that tends to carry a
    serial with it; past that, the entity's own name -- which is all a page
    bound to an entity with no device, as a KNX light set up in YAML has none,
    leaves to ask.

    ``${_device.friendly_name}`` says the same thing. To name the entity
    rather than the device, spell the entity out in full.
    """
    device = template_target_device(hass, template)
    return (
        (device and (device.name_by_user or device.name))
        or _entry_title(hass, template)
        or _entity_name(hass, template)
    )


def expand_device_alias(text: Any, template: Any) -> Any:
    """*text* with ``${_device.attribute}`` spelled out as the page's entity.

    ``${_device.volume_level}`` becomes ``${media_player.tv.volume_level}``, an
    ordinary entity variable from then on (``${_device.media_title_prev}`` and
    its three siblings read the player's queue sensor instead, see
    ``media_queue.alias``) -- read, formatted and watched like
    one; inside a calculation (``${_device.volume_level * 100}``) likewise.

    A page bound to a hub has no entity of its own: a bridge is a config entry,
    not a thing with a state, and can answer no attribute, so these read as
    nothing there. What it can still answer are the facts about the device
    itself, read before this by :func:`_device_fact_token`.
    """
    if not isinstance(text, str) or "${" not in text:
        return text
    entity_id = _template_target(template).get("entity_id")

    def _expand(match: re.Match) -> str:
        body = match.group(1)
        if not DEVICE_ATTRIBUTE_RE.search(body):
            return match.group(0)
        if not entity_id:
            return ""
        body = DEVICE_ATTRIBUTE_RE.sub(lambda m: device_attribute(entity_id, m.group(1)), body)
        return f"${{{body.strip()}}}"

    return _VARIABLE_BODY_RE.sub(_expand, text)


#: The template of the page being drawn, for ``${_device…}`` in its tiles and
#: tooltips. ``_NO_PAGE`` outside any :func:`page_scope`: the variable is then
#: left for whoever knows the page (the panel expands it before asking).
_NO_PAGE: Final = object()
_PAGE_TEMPLATE: ContextVar[Any] = ContextVar("lizaip_page_template", default=_NO_PAGE)


@contextmanager
def page_scope(template: Any) -> Iterator[None]:
    """Read ``${_device…}`` as the page with *template* has it, inside the block."""
    token = _PAGE_TEMPLATE.set(template if isinstance(template, dict) else None)
    try:
        yield
    finally:
        _PAGE_TEMPLATE.reset(token)


def current_page_template() -> Any:
    """The template :func:`page_scope` set, None for a plain page or no scope."""
    template = _PAGE_TEMPLATE.get()
    return None if template is _NO_PAGE else template


#: What ``${_device.…}`` can ask about the device rather than about its state.
#: Offered on every page, because every page is bound to a device or to a hub;
#: everything else a ``${_device.…}`` names is an attribute of the entity.
#:
#: Kept in alphabetical order: this is the order the editor offers them in, and
#: a table with an order of its own leaves every addition arguing about where
#: it goes.
#:
#: ``friendly_name`` says what ``${_device}`` says. Both are offered: the long
#: spelling is the one that reads plainly beside its neighbours, and it must
#: stay a fact either way -- a spelling that is no longer one falls to the
#: alias expansion, which turns it back into the entity's name and leaves a
#: hub page blank.
DEVICE_FACTS: Final = (
    "area_name", "friendly_name", "label_names",
    "manufacturer", "model", "sw_version",
)

#: Any fact as the whole variable. Only the whole variable: in a calculation a
#: model name is not a number.
DEVICE_FACT_TOKEN_RE: Final = re.compile(
    r"\$\{\s*_device\.(" + "|".join(DEVICE_FACTS) + r")\s*\}",
)


def template_target_device(hass: HomeAssistant | None, template: Any) -> Any:
    """The device registry entry a template page is bound to, None if none.

    A page bound to a device names it outright. A page bound to a hub names a
    config entry, which is a bridge and everything behind it: the bridge is
    the device of that entry that sits behind nothing else, so that is the one
    taken -- a Hue page is about the bridge, not its thirty lamps.

    An entry can register several such devices (a cloud account with four
    thermostats), and then none of them is the entry. One the others sit
    behind is still a bridge; past that the entry is answered by none, and
    the name falls back to its title, which speaks for the whole of it.
    """
    target = _template_target(template)
    if hass is None or not target:
        return None
    from homeassistant.helpers import device_registry as dr
    registry = dr.async_get(hass)
    device_id = target.get("device")
    if device_id:
        return registry.async_get(device_id)
    entry_id = target.get("config_entry")
    if not entry_id:
        return None
    entries = dr.async_entries_for_config_entry(registry, entry_id)
    roots = [device for device in entries if device.via_device_id is None]
    if len(roots) == 1:
        return roots[0]
    behind = {device.via_device_id for device in entries}
    hubs = [device for device in roots if device.id in behind]
    return hubs[0] if len(hubs) == 1 else None


#: Told apart from "looked for it and there is none", which is also None.
_UNRESOLVED: Final = object()


class _FactContext:
    """What every ``${_device.fact}`` reader is handed, worked out once.

    A text can name several facts, and they share their groundwork: the room
    and the labels both begin at the page entity's registry entry. The
    context does each walk the first time it is asked for and remembers it,
    so the cost is per text rather than per fact.
    """

    __slots__ = ("hass", "template", "device", "entity", "_name", "_area", "_entry")

    def __init__(self, hass: HomeAssistant | None, template: Any) -> None:
        self.hass = hass
        self.template = template
        self.device = template_target_device(hass, template)
        self.entity = template_target_entity(template)
        self._name: str | None = None
        self._area: Any = _UNRESOLVED
        self._entry: Any = _UNRESOLVED

    @property
    def name(self) -> str:
        """What ``${_device}`` says, the device's own name."""
        if self._name is None:
            self._name = template_target_name(self.hass, self.template)
        return self._name

    @property
    def entry(self) -> Any:
        """The registry entry of the page's entity, None when it has none.

        Both the room and the labels begin here, because the entity's own win
        over its device's; kept so that a page naming them both walks the
        entity registry once rather than once per fact.
        """
        if self._entry is _UNRESOLVED:
            self._entry = None
            if self.hass is not None and self.entity:
                from homeassistant.helpers import entity_registry as er
                self._entry = er.async_get(self.hass).async_get(self.entity)
        return self._entry

    @property
    def area(self) -> Any:
        """The area registry entry the page's subject sits in, None if none."""
        if self._area is _UNRESOLVED:
            self._area = _template_area(self)
        return self._area


def _template_area(ctx: _FactContext) -> Any:
    """The area registry entry the page's subject sits in, None when none.

    The entity's own area first, then its device's -- Home Assistant's rule,
    and the only one that answers for an entity configured in YAML, which has
    an area but no device at all.

    The entry rather than its name, so that everything filed under the room --
    its name today, the floor it is on should that ever be asked for -- comes
    off one walk of the registries.
    """
    if ctx.hass is None:
        return None
    from homeassistant.helpers import area_registry as ar
    area_id = (
        getattr(ctx.entry, "area_id", None)
        or getattr(ctx.device, "area_id", None)
    )
    if not area_id:
        return None
    return ar.async_get(ctx.hass).async_get_area(area_id)


def _label_names(ctx: _FactContext) -> str:
    """The labels stuck on the page's subject, "" when it has none.

    Plural, and named apart from Home Assistant's ``label_name``: that one
    takes a label's id and answers with the one name, where this takes the
    thing and answers with every name on it.

    The entity's own labels first, then its device's -- the rule the room
    already follows, so there is one rule to learn rather than two.

    Labels are a set, and a set has no order: left as it came, the same page
    could say "Attic, Test" today and "Test, Attic" after a restart. Sorted,
    so that what is drawn depends on what is labelled and nothing else.
    """
    hass = ctx.hass
    if hass is None:
        return ""
    from homeassistant.helpers import label_registry as lr
    label_ids = getattr(ctx.entry, "labels", None)
    if not label_ids:
        label_ids = getattr(ctx.device, "labels", None)
    if not label_ids:
        return ""
    registry = lr.async_get(hass)
    names = []
    for label_id in label_ids:
        label = registry.async_get_label(label_id)
        name = (label and (label.name or "")) or ""
        if name:
            names.append(name)
    return ", ".join(sorted(names))


#: The facts worked out rather than read off the device entry, by the reader
#: that works each one out. Everything else is a field of the device and is
#: read straight off it.
#:
#: What is in here is what :mod:`..config.variables` must *not* watch the
#: device registry for, and it derives that from this mapping rather than
#: keeping a list of its own -- a second list is a second place to forget,
#: and forgetting it is silent: the page simply stops repainting.
COMPUTED_FACTS: Final = {
    "friendly_name": lambda ctx: ctx.name,
    "area_name": lambda ctx: (ctx.area and (ctx.area.name or "")) or "",
    "label_names": _label_names,
}


def _device_fact(fact: str, ctx: _FactContext) -> str:
    """What the page's device says *fact* is, "" when it never said so."""
    reader = COMPUTED_FACTS.get(fact)
    if reader is not None:
        return reader(ctx)
    if ctx.device is None:
        return ""
    return _format_value(getattr(ctx.device, fact, None))


def _device_fact_token(text: Any, hass: HomeAssistant | None, template: Any) -> Any:
    """*text* with every ``${_device.fact}`` read from the page's device.

    A fact is about the thing the page is bound to, so it says the same on
    every page: a hub has no entity, but it does have a bridge behind its
    config entry, and ``${_device.model}`` reads there as on a Sonos page.
    ``${_device.friendly_name}`` is the device's name too, so that it cannot
    mean one thing here and another there; an entity that has drifted from
    its device is still named in full, ``${media_player.tv.friendly_name}``.
    A fact the integration never filled in draws nothing, as any valueless
    variable does.

    Read before :func:`expand_device_alias`, so the alias expansion never
    sees a fact and mistakes it for an attribute of the entity.
    """
    if not isinstance(text, str) or "_device" not in text:
        return text
    if not _template_target(template):
        return text
    if not DEVICE_FACT_TOKEN_RE.search(text):
        return text
    ctx = _FactContext(hass, template)
    return DEVICE_FACT_TOKEN_RE.sub(lambda m: _device_fact(m.group(1), ctx), text)


def _with_page_device(text: Any, hass: HomeAssistant | None) -> Any:
    """*text* with ``${_device…}`` filled in for the page in scope, if any."""
    if not isinstance(text, str) or "_device" not in text:
        return text
    template = _PAGE_TEMPLATE.get()
    if template is _NO_PAGE:
        return text
    return substitute_device_token(text, hass, template)


def substitute_device_token(text: Any, hass: HomeAssistant | None, template: Any) -> Any:
    """*text* with the ``${_device}`` variables of a template page filled in.

    The facts come first, because they are attributes of nothing and would be
    mistaken for the entity's. ``${_device}`` then becomes the device's name;
    every remaining ``${_device.attribute}`` is left as the entity variable it
    stands for, for the entity pass that follows.
    """
    text = _device_fact_token(text, hass, template)
    text = expand_device_alias(text, template)
    if not isinstance(text, str) or not DEVICE_TOKEN_RE.search(text):
        return text
    name = template_target_name(hass, template)
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
    # All or nothing: half an icon name ("mdi:weather-") draws a broken glyph.
    missing = False

    def _function(match) -> str:
        nonlocal missing
        value = _function_value(hass, match)
        missing = missing or not value
        return value

    # Calculations first, so what follows reads -- and counts positions in --
    # the text the entity variables actually sit in.
    text = FUNCTION_TOKEN_RE.sub(_function, image)
    whole = ENTITY_TOKEN_RE.fullmatch(text.strip())

    def _with_unit(index: int) -> bool:
        # Same as a tooltip, except inside a name: "mdi:battery-80 %" is no icon.
        word = text[:index].split()[-1] if text[:index][-1:].strip() else ""
        return ":" not in word or word.lower().startswith("text:")

    def _value(match) -> str:
        nonlocal missing
        eid = match.group(1).lower()
        icon = None if match.group(2) else weather_condition_icon(hass, eid)
        if icon:
            # A weather condition is drawn as its icon: alone it is the whole
            # name, after "mdi:" the slug, after "mdi:weather-" the rest of it.
            before = text[:match.start()].lower()
            if whole:
                return f"mdi:{icon}"
            if before.endswith("mdi:weather-"):
                return icon.removeprefix("weather-")
            if before.endswith("mdi:"):
                return icon
        value = entity_token_value(hass, eid, match.group(2), _with_unit(match.start()))
        missing = missing or not value
        return value

    resolved = ENTITY_TOKEN_RE.sub(_value, text).strip()
    return None if missing or not resolved else resolved


def substitute_label_tokens(
    text: str, values: dict[str, str], hass: HomeAssistant | None = None,
    subject: str | None = None,
) -> str:
    """Replace ``${TOKEN}`` placeholders in *text* from *values*.

    With *hass*, entity variables (``${sensor.x}``) are filled in first.

    Token matching is case-insensitive and tolerates inner whitespace, so
    ``${_state}``, ``${_STATE}`` and ``${ _state }`` are the same token. A token
    with no value — unknown name, or a state the button cannot predict —
    collapses to nothing, and the whitespace it leaves behind is collapsed with
    it so the result never has a doubled or trailing space.

    *subject* is the entity the button points at, which turns
    ``${_queue.next_song}`` and its three siblings into variables on that
    entity's queue sensor. Expanded before anything else reads the text,
    because the picture branch below returns early and would otherwise hand an
    unexpanded alias to ``finish_tooltip``.
    """
    if not text or "${" not in text:
        return text
    text = expand_queue_alias(text, subject)
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
    # Words followed by a graph ("Battery 85 % + history:sensor.x"): the graph
    # gets its version all the same, or the remote keeps the picture it cached.
    return versioned_history_image(clean_label_text(text), hass)
