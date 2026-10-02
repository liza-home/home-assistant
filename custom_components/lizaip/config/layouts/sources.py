"""Dynamic source registry for ``@<source>[N]`` layout tokens.

A source turns a declarative ``spec`` into an ordered list of
:class:`DynamicItem` objects. ``layouts.py`` asks for item N of source X with
spec S; the source owns how to get it.

Item shape is normalized across sources:

    title      — display label, becomes the button's ``name``
    thumbnail  — artwork URL or an ``mdi:`` icon (``""`` when absent)
    action     — HA service to call, e.g. ``media_player.play_media``
    data       — service payload
    identity   — stable id recorded on the assignment for future refreshes
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from homeassistant.core import HomeAssistant

from ..const import ASSIGNMENT_DYNAMIC_KEY

_LOGGER = logging.getLogger(__name__)

MEDIA_PLAYER_DOMAIN = "media_player"

#: How many items a source is asked for when nothing narrower is requested.
#: Deliberately not part of the cache key: pages whose highest tokens differ
#: must still share one browse result.
DEFAULT_MAX_ITEMS = 24

#: Fields a new binding tracks unless its source opts into more.
#:
#: ``action`` is excluded here and added back per source: most sources use one
#: service for every item, while entity-backed sources may vary by domain.
DEFAULT_TRACKED_FIELDS = ("label", "icon", "data")

_WARNED_EMPTY: set[str] = set()


def _squash(title: str) -> str:
    """A title reduced to its letters and digits, for table lookups.

    Integrations spell the same input half a dozen ways — ``Line-in``,
    ``Line In``, ``LINE_IN`` — and which one arrives depends on the speaker's
    firmware, so matching on the literal would work on one device and not the
    next.
    """
    return "".join(ch for ch in title.lower() if ch.isalnum())


#: Sources that are a socket rather than a recording, keyed by squashed title.
#:
#: These never have artwork and never will: browsing a line-in returns nothing
#: to illustrate, so without this the button sits among the album covers as a
#: text tile forever. An icon is the honest answer, not a placeholder.
_TITLE_ICONS: dict[str, str] = {
    "linein": "mdi:audio-input-stereo-minijack",
    "analogin": "mdi:audio-input-stereo-minijack",
}


@dataclass
class DynamicItem:
    title: str = ""
    thumbnail: str = ""
    action: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    identity: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "thumbnail": self.thumbnail,
            "action": self.action,
            "data": dict(self.data),
            "identity": self.identity or self.title,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> DynamicItem:
        data = raw.get("data")
        return cls(
            title=str(raw.get("title") or ""),
            thumbnail=str(raw.get("thumbnail") or ""),
            action=str(raw.get("action") or ""),
            data=dict(data) if isinstance(data, dict) else {},
            identity=str(raw.get("identity") or raw.get("title") or ""),
        )

    @property
    def icon(self) -> str:
        """Button-icon form of the thumbnail.

        Artwork URLs are wrapped in ``media:`` so imgserv can resize them.
        ``mdi:`` names are already device icons; wrapping them would produce
        ``media:mdi:palette`` and a 404. Missing artwork falls back to a known
        icon for the handful of sources that can never have any, and otherwise
        to a text tile so the button is not blank.
        """
        thumb = self.thumbnail
        if thumb and not thumb.startswith("media:"):
            return f"media:{thumb}" if thumb.startswith(("http", "/")) else thumb
        if thumb:
            return thumb
        if not self.title:
            return ""
        return _TITLE_ICONS.get(_squash(self.title)) or f"text:{self.title}"


@dataclass
class ResolveResult:
    items: list[DynamicItem] = field(default_factory=list)
    error: str | None = None
    succeeded_at: float = 0.0

    def age(self) -> float:
        return max(0.0, time.time() - self.succeeded_at) if self.succeeded_at else 0.0

#: Content types integrations expose favorites under, tried in order.
FAVORITE_TYPES = [
    ("favorites", ""),
    ("sonos_favorites", ""),
    ("library/favorites", ""),
]

#: Favourites narrowed to one kind, by the Sonos favourites folder that holds
#: it. Sonos files each favourite under its DIDL class and browses one class
#: at a time as ``("favorites_folder", <class>)``, so the folder *is* the
#: filter; titles or media classes would have to be guessed at.
FAVORITE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "radio": ("object.item.audioItem.audioBroadcast",),
    "playlists": ("object.container.playlistContainer",),
}


# ── entity lookup ─────────────────────────────────────────────────────


async def find_media_entity(hass: HomeAssistant, entity_id: str):
    """Find a media_player entity object using multiple lookup strategies.

    ``browse_media`` lives on the entity object, not in the state machine, and
    there is no single supported way to reach it from a custom component — hence
    four fallbacks.
    """
    entity = None

    try:
        component = hass.data.get("media_player")
        if component and hasattr(component, "get_entity"):
            entity = component.get_entity(entity_id)
            if entity:
                _LOGGER.debug("find_media_entity: found via component.get_entity")
                return entity
    except Exception:
        pass

    try:
        from homeassistant.helpers.entity_component import EntityComponent
        for data_key in ("media_player", "entity_components"):
            comp = hass.data.get(data_key)
            if isinstance(comp, EntityComponent):
                entity = comp.get_entity(entity_id)
                if entity:
                    _LOGGER.debug("find_media_entity: found via EntityComponent(%s)", data_key)
                    return entity
    except Exception:
        pass

    try:
        from homeassistant.helpers.entity_platform import async_get_platforms
        platforms = async_get_platforms(hass, "media_player")
        for platform in platforms:
            for ent in platform.entities.values():
                if ent.entity_id == entity_id:
                    _LOGGER.debug("find_media_entity: found via platform search")
                    return ent
    except Exception:
        pass

    try:
        for key, val in hass.data.items():
            if not isinstance(key, str):
                continue
            if "media_player" in str(key) and hasattr(val, "get_entity"):
                entity = val.get_entity(entity_id)
                if entity:
                    _LOGGER.debug("find_media_entity: found via hass.data[%s]", key)
                    return entity
    except Exception:
        pass

    _LOGGER.debug("find_media_entity: could not find entity %s", entity_id)
    return None


def bound_specs(
    assignments_by_page: dict[Any, dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Every ``(source_id, spec)`` this device's dynamic bindings resolve with.

    Push triggers need to know which *source* asked for what, not just which
    entities are involved: ``scenes`` and ``scripts`` bind by area and label and
    name no entity at all, so an entity-only view is blind to three of the four
    sources. Duplicates are kept out by structural identity, since eight
    favourite buttons on one page all carry the same spec.
    """
    seen: set[str] = set()
    specs: list[tuple[str, dict[str, Any]]] = []
    for assignments in (assignments_by_page or {}).values():
        for assign in (assignments or {}).values():
            if not isinstance(assign, dict):
                continue
            binding = assign.get(ASSIGNMENT_DYNAMIC_KEY)
            if not isinstance(binding, dict):
                continue
            source_id = str(binding.get("source") or "")
            if not source_id:
                continue
            spec = binding.get("spec")
            spec = dict(spec) if isinstance(spec, dict) else {}
            # The resolver falls back to target_entity when the spec names no
            # entity, so the watched set has to make the same substitution or it
            # would miss exactly the device-mode bindings bound_entities covers.
            if not (spec.get("entity") or spec.get("entity_id")):
                target = str(binding.get("target_entity") or "")
                if target:
                    spec["entity"] = target
            key = spec_key(source_id, spec)
            if key in seen:
                continue
            seen.add(key)
            specs.append((source_id, spec))
    return specs


def bound_entities(assignments_by_page: dict[Any, dict[str, Any]]) -> set[str]:
    """Every entity a page's dynamic bindings resolve against.

    Read from the bindings rather than from the page's target entity: in device
    mode the page's primary entity can be a ``remote.*`` that cannot be browsed,
    and the binding already records the media player we actually resolved with.
    """
    entities: set[str] = set()
    for _source_id, spec in bound_specs(assignments_by_page):
        entity_id = str(spec.get("entity") or spec.get("entity_id") or "")
        if entity_id:
            entities.add(entity_id)
    return entities


# ── browse helpers ────────────────────────────────────────────────────


def _extract_playable_items(result, max_items: int) -> list[dict]:
    items: list[dict] = []
    if not hasattr(result, "children") or not result.children:
        return items
    for child in result.children:
        if getattr(child, "can_play", False):
            items.append({
                "title": child.title or "",
                "thumbnail": child.thumbnail or "",
                "media_content_id": child.media_content_id or "",
                "media_content_type": child.media_content_type or "",
            })
            if len(items) >= max_items:
                break
    return items


async def _browse(entity, content_type, content_id, timeout: int):
    return await asyncio.wait_for(
        entity.async_browse_media(content_type, content_id), timeout=timeout,
    )


async def try_browse_media(entity, entity_id: str, max_items: int) -> list[dict]:
    """Try favorite browse folders first, then root browse as fallback.

    Known favorite content types are fast and preserve thumbnails; root browse
    is slower but catches integrations that expose favorites as categories.
    """
    for content_type, content_id in FAVORITE_TYPES:
        try:
            result = await _browse(entity, content_type, content_id, 15)
            if result and hasattr(result, "children") and result.children:
                items = _extract_playable_items(result, max_items)
                if items:
                    _LOGGER.debug(
                        "browse_media(%s) returned %d items for %s",
                        content_type, len(items), entity_id,
                    )
                    return items
                # Favorites may sit inside non-playable folders.
                for child in result.children:
                    if getattr(child, "can_expand", False):
                        try:
                            sub = await _browse(
                                entity, child.media_content_type, child.media_content_id, 15,
                            )
                            items.extend(_extract_playable_items(sub, max_items - len(items)))
                            if len(items) >= max_items:
                                break
                        except Exception:
                            continue
                if items:
                    _LOGGER.debug(
                        "browse_media(%s) returned %d items (expanded) for %s",
                        content_type, len(items), entity_id,
                    )
                    return items
        except Exception as exc:
            _LOGGER.debug("browse_media(%s) failed for %s: %s", content_type, entity_id, exc)
            continue

    try:
        result = await _browse(entity, None, None, 20)
    except asyncio.TimeoutError:
        _LOGGER.warning("browse_media(None,None) timed out for %s", entity_id)
        return []
    except Exception as exc:
        _LOGGER.warning("browse_media(None,None) failed for %s: %s", entity_id, exc)
        return []

    if not result or not hasattr(result, "children") or not result.children:
        _LOGGER.debug("browse_media returned empty root for %s", entity_id)
        return []

    items: list[dict] = _extract_playable_items(result, max_items)

    # Expand one level of favorites/playlists folders.
    if len(items) < max_items:
        for child in result.children:
            if getattr(child, "can_expand", False) and not getattr(child, "can_play", False):
                try:
                    sub = await _browse(
                        entity, child.media_content_type, child.media_content_id, 10,
                    )
                    items.extend(_extract_playable_items(sub, max_items - len(items)))
                    if len(items) >= max_items:
                        break
                except asyncio.TimeoutError:
                    _LOGGER.debug("browse_media expand timed out for %s/%s", entity_id, child.title)
                    continue
                except Exception:
                    continue

    if items:
        _LOGGER.debug("browse_media returned %d items for %s", len(items), entity_id)
    return items


async def browse_favorite_category(
    entity, entity_id: str, category: str, max_items: int,
) -> list[dict]:
    """The favourites of one :data:`FAVORITE_CATEGORIES` kind, in Sonos order.

    A failed browse raises :class:`SourceUnavailable` rather than answering
    ``[]``: an empty answer blanks bound buttons, and a speaker that could not
    be asked has not said it has no radio stations.
    """
    items: list[dict] = []
    for class_id in FAVORITE_CATEGORIES[category]:
        try:
            result = await _browse(entity, "favorites_folder", class_id, 15)
        except Exception as exc:
            raise SourceUnavailable(
                f"browsing {category} favourites of {entity_id} failed: {exc}"
            ) from exc
        items.extend(_extract_playable_items(result, max_items - len(items)))
        if len(items) >= max_items:
            break
    return items


async def get_browse_thumbnails(entity, entity_id: str) -> dict[str, str]:
    thumbnails: dict[str, str] = {}
    try:
        result = await _browse(entity, None, None, 20)
        if not result or not hasattr(result, "children") or not result.children:
            return thumbnails

        for child in result.children:
            if child.title and child.thumbnail:
                thumbnails[child.title] = child.thumbnail

        for child in result.children:
            if getattr(child, "can_expand", False):
                try:
                    sub = await _browse(
                        entity, child.media_content_type, child.media_content_id, 10,
                    )
                    if hasattr(sub, "children") and sub.children:
                        for gc in sub.children:
                            if gc.title and gc.thumbnail:
                                thumbnails[gc.title] = gc.thumbnail
                except Exception:
                    continue

    except Exception as exc:
        _LOGGER.debug("get_browse_thumbnails failed for %s: %s", entity_id, exc)

    if thumbnails:
        _LOGGER.debug("Got %d thumbnails from browse_media for %s", len(thumbnails), entity_id)
    return thumbnails


async def read_source_list(
    hass: HomeAssistant, entity_id: str, max_items: int, entity=None,
) -> list[DynamicItem]:
    """Build items from a media_player's ``source_list`` attribute.

    These are *not* playable media ids — selecting one goes through
    ``media_player.select_source``. Losing that distinction turns every button
    on a source-list device into a play_media call that the integration
    silently ignores, so it is preserved explicitly here.
    """
    state = hass.states.get(entity_id)
    if not state:
        _LOGGER.debug("read_source_list: entity %s has no state", entity_id)
        return []

    source_list = state.attributes.get("source_list") or []
    if not source_list:
        _LOGGER.debug("read_source_list: no source_list for %s", entity_id)
        return []

    thumbnails: dict[str, str] = {}
    if entity is not None and hasattr(entity, "async_browse_media"):
        thumbnails = await get_browse_thumbnails(entity, entity_id)

    return [
        DynamicItem(
            title=source,
            thumbnail=thumbnails.get(source, ""),
            action="media_player.select_source",
            data={"source": source},
            identity=f"source:{source}",
        )
        for source in source_list[:max_items]
    ]


def _items_from_browse(raw: list[dict]) -> list[DynamicItem]:
    return [
        DynamicItem(
            title=entry.get("title", ""),
            thumbnail=entry.get("thumbnail", ""),
            action="media_player.play_media",
            data={
                "media_content_id": entry.get("media_content_id", ""),
                "media_content_type": entry.get("media_content_type", ""),
                # Preserve title/artwork; some players expose opaque ids such
                # as Sonos ``FV:2/12`` slots.
                **(
                    {"metadata": {
                        "title": entry.get("title", ""),
                        **(
                            {"thumbnail": entry["thumbnail"]}
                            if entry.get("thumbnail") else {}
                        ),
                    }}
                    if entry.get("title") else {}
                ),
            },
            identity=entry.get("media_content_id") or entry.get("title", ""),
        )
        for entry in raw
    ]


# ── sources ───────────────────────────────────────────────────────────


_ENTITY_PARAM = {
    "entity": {
        "type": "entity",
        "domain": "media_player",
        "required": True,
        "description": "Media player to read from",
    },
    "category": {
        "type": "string",
        "required": False,
        "description": (
            "Only favourites of this kind: "
            + ", ".join(sorted(FAVORITE_CATEGORIES))
            + " (Sonos)"
        ),
    },
}


class SourceUnavailable(RuntimeError):
    """The source could not be read, as opposed to having nothing to give.

    Resolution treats this as a hard error, keeps last-known button content and
    marks it stale instead of blanking it as an empty source.

    ``refused`` carries whatever degraded answer was rejected — an offline
    speaker's restored ``source_list``, for instance. It must never reach a
    button, but a preview is allowed to show it: somebody configuring a layout
    against a speaker that is currently asleep still needs to see which
    favourites they are binding to.
    """

    def __init__(self, message: str, refused: list | None = None) -> None:
        super().__init__(message)
        self.refused = refused or []


#: Unreachable states, kept literal so test-stubbed HA modules can import this.
_UNREACHABLE_STATES = {"unavailable", "unknown", "none"}


def _ensure_reachable(
    hass: HomeAssistant, entity_id: str, refused: list | None = None
) -> None:
    state = hass.states.get(entity_id)
    if state is None:
        raise SourceUnavailable(
            f"{entity_id} has no state (not loaded yet?)", refused
        )
    value = getattr(state, "state", None)
    if isinstance(value, str) and value.lower() in _UNREACHABLE_STATES:
        raise SourceUnavailable(f"{entity_id} is {value}", refused)


async def resolve_favorites(
    hass: HomeAssistant,
    spec: dict[str, Any],
    max_items: int = DEFAULT_MAX_ITEMS,
) -> list[DynamicItem]:
    """A media player's favorites, however that player exposes them.

    Browses real favorites first and falls back to ``source_list``. Raises
    :class:`SourceUnavailable` when the player cannot be read, because ``[]``
    means the reachable source is empty and will blank bound buttons. Offline,
    rebooting or still-loading speakers must keep last-known content instead —
    and so must a speaker whose restored ``source_list`` would otherwise answer
    for it with titles it can no longer illustrate.
    """
    entity_id = spec.get("entity") or spec.get("entity_id") or ""
    if not entity_id:
        raise ValueError("favorites source requires an 'entity'")
    category = str(spec.get("category") or "").strip()
    if category and category not in FAVORITE_CATEGORIES:
        raise ValueError(
            f"unknown favorites category {category!r}; "
            f"expected one of {', '.join(sorted(FAVORITE_CATEGORIES))}"
        )

    entity = await find_media_entity(hass, entity_id)

    if category:
        # No fallback: `source_list` and the unfiltered browse mix every kind
        # of favourite, which is exactly what a category is there to exclude.
        if entity is None or not hasattr(entity, "async_browse_media"):
            _ensure_reachable(hass, entity_id)
            raise SourceUnavailable(f"{entity_id} cannot be browsed")
        raw = await browse_favorite_category(entity, entity_id, category, max_items)
        if not raw:
            _ensure_reachable(hass, entity_id)
        return _items_from_browse(raw)

    if entity is not None and hasattr(entity, "async_browse_media"):
        raw = await try_browse_media(entity, entity_id, max_items)
        if raw:
            return _items_from_browse(raw)

    items = await read_source_list(hass, entity_id, max_items, entity)

    # An offline speaker keeps its `source_list`: the attribute is restored with
    # the state, so it still answers with every favourite's *name* and with
    # nothing else. Artwork lives on the entity object, which a player that
    # never came up this session does not have, so taking this answer would
    # swap each album cover for a text tile and store that as the button's icon
    # — where it stays, because nothing re-derives an icon that already looks
    # resolved. Judged on reachability rather than on the missing thumbnails:
    # a player that *is* up and simply cannot browse has genuinely told us it
    # has no artwork, and must keep the titles it gave.
    if entity is None or not items:
        # "Nothing" is credible only if the player is currently reachable. The
        # titles travel with the refusal so a preview can still list them.
        _ensure_reachable(hass, entity_id, items)

    if items:
        return items

    return []


# ── registry-backed entities source ───────────────────────────────────
#
# One parameterised source covers scenes, scripts and filtered entity lists.


_ENTITIES_PARAMS: dict[str, dict[str, Any]] = {
    "domain": {
        "type": "string",
        "required": False,
        "description": "Entity domain to include, e.g. scene, script or light",
    },
    "area": {
        "type": "string",
        "required": False,
        "description": "Area id or name to restrict to",
    },
    "label": {
        "type": "string",
        "required": False,
        "description": "Label id or name to restrict to",
    },
    "config_entry": {
        "type": "string",
        "required": False,
        "description": (
            "Config entry id to restrict to, e.g. one Hue bridge's entry"
        ),
    },
}

_AREA_LABEL_PARAMS: dict[str, dict[str, Any]] = {
    key: _ENTITIES_PARAMS[key] for key in ("area", "label")
}

#: Service a domain's items are activated with. Anything not listed falls back
#: to ``homeassistant.turn_on``.
#:
#: ``homeassistant.turn_on`` skips domains without their own ``turn_on``
#: service, so cover/button/valve need explicit services. Domains left to the
#: fallback do register ``turn_on`` with the intended meaning: light, switch,
#: input_boolean, fan, vacuum, climate, siren, humidifier and water_heater.
#:
#: ``lock`` is deliberately absent: choosing lock vs unlock on a physical
#: remote is a security decision for the user.
_DOMAIN_ACTIONS = {
    "automation": "automation.trigger",
    "button": "button.press",
    "cover": "cover.open_cover",
    "scene": "scene.turn_on",
    "script": "script.turn_on",
    "valve": "valve.open_valve",
}

#: Icon used when neither the registry nor state carries one; blank icons look
#: like broken bindings.
#:
#: Literal table on purpose: ``async_get_icons`` is async, while ``_entity_item``
#: is sync and loops over the registry.
_DOMAIN_ICONS = {
    "automation": "mdi:robot",
    "button": "mdi:gesture-tap-button",
    "climate": "mdi:thermostat",
    "cover": "mdi:window-shutter",
    "fan": "mdi:fan",
    "humidifier": "mdi:air-humidifier",
    "input_boolean": "mdi:toggle-switch-outline",
    "light": "mdi:lightbulb",
    "lock": "mdi:lock",
    "media_player": "mdi:speaker",
    "scene": "mdi:palette",
    "script": "mdi:script-text",
    "siren": "mdi:bullhorn",
    "switch": "mdi:toggle-switch",
    "vacuum": "mdi:robot-vacuum",
    "valve": "mdi:valve",
    "water_heater": "mdi:water-boiler",
}
_DEFAULT_ICON = "mdi:shape"


def _domain_of(entity_id: str) -> str:
    return entity_id.split(".", 1)[0] if "." in entity_id else ""


def _wanted_domains(spec: dict[str, Any]) -> set[str]:
    raw = spec.get("domain") or spec.get("domains") or ""
    if isinstance(raw, str):
        raw = [raw]
    return {str(item).strip() for item in raw if str(item).strip()}


def _registries(hass: HomeAssistant) -> tuple[Any, Any, Any, Any]:
    """The four registries this source reads, imported lazily.

    The helpers are heavy and absent from unit-test stubs, so module-scope
    imports would break collection.
    """
    from homeassistant.helpers import area_registry as ar
    from homeassistant.helpers import device_registry as dr
    from homeassistant.helpers import entity_registry as er

    try:
        from homeassistant.helpers import label_registry as lr
    except ImportError:  # pragma: no cover - HA older than labels
        lr = None

    def _get(module):
        if module is None:
            return None
        try:
            return module.async_get(hass)
        except Exception:  # pragma: no cover - registry not loaded
            return None

    return _get(er), _get(ar), _get(dr), _get(lr)


def _reg_mapping(registry, attr: str) -> dict:
    """A registry's id→entry mapping as a real dict."""
    raw = getattr(registry, attr, None) if registry is not None else None
    if isinstance(raw, dict):
        return raw
    try:
        return dict(raw)
    except Exception:
        return {}


def _match_area_ids(area_reg, wanted: str) -> set[str]:
    """Area ids matching *wanted*, which may be an id or a display name."""
    if not wanted or area_reg is None:
        return set()
    needle = wanted.strip().casefold()
    matched = {
        area.id
        for area in _reg_mapping(area_reg, "areas").values()
        if str(getattr(area, "id", "")).casefold() == needle
        or str(getattr(area, "name", "")).casefold() == needle
    }
    # Unknown names must not silently widen to "everything".
    return matched or {wanted.strip()}


def _match_label_ids(label_reg, wanted: str) -> set[str]:
    if not wanted:
        return set()
    needle = wanted.strip().casefold()
    matched = {
        label.label_id
        for label in _reg_mapping(label_reg, "labels").values()
        if str(getattr(label, "label_id", "")).casefold() == needle
        or str(getattr(label, "name", "")).casefold() == needle
    }
    return matched or {wanted.strip()}


def _entry_area_id(entry, device_reg) -> str:
    area_id = getattr(entry, "area_id", None)
    if area_id:
        return str(area_id)
    device_id = getattr(entry, "device_id", None)
    if device_id and device_reg is not None:
        device = _reg_mapping(device_reg, "devices").get(device_id)
        if device is not None and getattr(device, "area_id", None):
            return str(device.area_id)
    return ""


def _entity_item(hass: HomeAssistant, entity_id: str, entry) -> DynamicItem:
    domain = _domain_of(entity_id)
    try:
        state = hass.states.get(entity_id)
    except Exception:  # pragma: no cover - state machine unavailable
        state = None
    raw_attrs = getattr(state, "attributes", None) if state is not None else None
    attrs = raw_attrs if isinstance(raw_attrs, dict) else {}

    title = (
        (getattr(entry, "name", None) if entry is not None else None)
        or (getattr(entry, "original_name", None) if entry is not None else None)
        or attrs.get("friendly_name")
        or entity_id
    )
    icon = (
        (getattr(entry, "icon", None) if entry is not None else None)
        or (getattr(entry, "original_icon", None) if entry is not None else None)
        or attrs.get("icon")
        or _DOMAIN_ICONS.get(domain, _DEFAULT_ICON)
    )

    return DynamicItem(
        title=str(title),
        thumbnail=str(icon),
        action=_DOMAIN_ACTIONS.get(domain, "homeassistant.turn_on"),
        data={"entity_id": entity_id},
        identity=entity_id,
    )


async def resolve_entities(
    hass: HomeAssistant,
    spec: dict[str, Any],
    max_items: int = DEFAULT_MAX_ITEMS,
) -> list[DynamicItem]:
    """Entities from the registries, filtered by domain, area and/or label.

    ``config_entry`` narrows to one integration instance — for example one Hue
    bridge — which makes it usable as a layout target before a page exists.
    Results are sorted by friendly name then entity id because bindings are by
    position, not identity.
    """
    spec = dict(spec or {})
    domains = _wanted_domains(spec)
    area = str(spec.get("area") or "").strip()
    label = str(spec.get("label") or "").strip()
    config_entry = str(spec.get("config_entry") or "").strip()

    entity_reg, area_reg, device_reg, label_reg = _registries(hass)

    area_ids = _match_area_ids(area_reg, area) if area else set()
    label_ids = _match_label_ids(label_reg, label) if label else set()

    found: dict[str, DynamicItem] = {}

    entries = _reg_mapping(entity_reg, "entities")
    for entity_id, entry in entries.items():
        entity_id = str(entity_id)
        if domains and _domain_of(entity_id) not in domains:
            continue
        if getattr(entry, "disabled_by", None) or getattr(entry, "hidden_by", None):
            continue
        if config_entry and str(getattr(entry, "config_entry_id", "") or "") != config_entry:
            continue
        if area_ids and _entry_area_id(entry, device_reg) not in area_ids:
            continue
        if label_ids and not (set(getattr(entry, "labels", None) or ()) & label_ids):
            continue
        found[entity_id] = _entity_item(hass, entity_id, entry)

    # YAML scenes/scripts live only in states. Widen only when no registry-only
    # filter (area, label, config entry) is active.
    if not area_ids and not label_ids and not config_entry:
        for state in _all_states(hass):
            entity_id = str(getattr(state, "entity_id", "") or "")
            if not entity_id or entity_id in found:
                continue
            if domains and _domain_of(entity_id) not in domains:
                continue
            found[entity_id] = _entity_item(hass, entity_id, None)

    items = sorted(found.values(), key=lambda it: (it.title.casefold(), it.identity))
    return items[:max_items]


def _all_states(hass: HomeAssistant) -> list[Any]:
    try:
        return list(hass.states.async_all() or [])
    except Exception:  # pragma: no cover - state machine unavailable
        return []


def _fixed_domain_resolver(domain: str):
    async def _resolve(
        hass: HomeAssistant,
        spec: dict[str, Any],
        max_items: int = DEFAULT_MAX_ITEMS,
    ) -> list[DynamicItem]:
        merged = dict(spec or {})
        merged["domain"] = domain
        return await resolve_entities(hass, merged, max_items)

    _resolve.__name__ = f"resolve_{domain}s"
    return _resolve


resolve_scenes = _fixed_domain_resolver("scene")
resolve_scripts = _fixed_domain_resolver("script")


# ── push subscriptions ────────────────────────────────────────────────
#
# Hooks fire for source-specific data changes; refresh owns debounce, re-resolve
# and teardown so media details stay in this module.


#: HA exposes a player's favorites cache through ``source_list``. Watching only
#: this attribute avoids refreshing on volume, track and position changes.
SOURCE_LIST_ATTR = "source_list"


def subscribe_favorites(hass: HomeAssistant, specs, on_change) -> Any | None:
    """Watch bound players' ``source_list`` only.

    Media players emit frequent playback state changes; each false refresh can
    start a 15-20 second browse.
    """
    from homeassistant.helpers.event import async_track_state_change_event

    entities = sorted(
        {
            str(spec.get("entity") or spec.get("entity_id") or "")
            for spec in specs
            if (spec.get("entity") or spec.get("entity_id"))
        }
    )
    if not entities:
        return None

    def _on_state(event: Any) -> None:
        data = getattr(event, "data", None) or {}
        new_state = data.get("new_state")
        if new_state is None:
            return
        old_list = (getattr(data.get("old_state"), "attributes", None) or {}).get(
            SOURCE_LIST_ATTR
        )
        new_list = (getattr(new_state, "attributes", None) or {}).get(SOURCE_LIST_ATTR)
        if old_list == new_list:
            return
        _LOGGER.debug(
            "Source list changed for %s; scheduling dynamic refresh",
            data.get("entity_id"),
        )
        on_change()

    _LOGGER.debug("Watching %s for source list changes", entities)
    return async_track_state_change_event(hass, entities, _on_state)


def _spec_wants_entity(hass: HomeAssistant, spec: dict[str, Any], entity_id: str) -> bool:
    """Whether *entity_id* could appear in *spec*'s result set.

    Conservative both ways: a false positive costs one resolve, while a false
    negative leaves a stale button until the next generic trigger. Domain is
    checked before registry-backed filters.
    """
    domains = _wanted_domains(spec)
    if domains and _domain_of(entity_id) not in domains:
        return False

    area = str(spec.get("area") or "").strip()
    label = str(spec.get("label") or "").strip()
    config_entry = str(spec.get("config_entry") or "").strip()
    if not area and not label and not config_entry:
        return True

    try:
        entity_reg, area_reg, device_reg, label_reg = _registries(hass)
        entry = _reg_mapping(entity_reg, "entities").get(entity_id)
    except Exception:  # noqa: BLE001 - a filter must never break the event loop
        return True

    # Removed or state-only entries may still matter.
    if entry is None:
        return True

    if config_entry and str(getattr(entry, "config_entry_id", "") or "") != config_entry:
        return False
    if area:
        if _entry_area_id(entry, device_reg) not in _match_area_ids(area_reg, area):
            return False
    if label:
        wanted = _match_label_ids(label_reg, label)
        if not (set(getattr(entry, "labels", None) or ()) & wanted):
            return False
    return True


def registry_subscriber(pinned_domain: str = ""):
    """A registry hook for a source whose resolver pins the domain.

    ``scenes`` and ``scripts`` store no ``domain`` key, so filtering must add
    the same pin the resolver adds or every entity would look relevant.
    """

    def _subscribe(hass: HomeAssistant, specs, on_change) -> Any | None:
        pinned = []
        for spec in specs:
            spec = dict(spec)
            spec["domain"] = pinned_domain
            pinned.append(spec)
        return subscribe_entity_registry(hass, pinned, on_change)

    _subscribe.__name__ = f"subscribe_{pinned_domain}_registry"
    return _subscribe


def subscribe_entity_registry(hass: HomeAssistant, specs, on_change) -> Any | None:
    """Fire when a registry change could alter a listed item.

    Registry events are filtered before debounce because every integration's
    entities may fire on restart. YAML scenes/scripts never enter the registry,
    so edits to them still rely on navigation/reconnect triggers.
    """
    from homeassistant.helpers.entity_registry import EVENT_ENTITY_REGISTRY_UPDATED

    specs = list(specs)
    if not specs:
        return None

    def _on_registry_event(event: Any) -> None:
        data = getattr(event, "data", None) or {}
        entity_id = str(data.get("entity_id") or "")
        if not entity_id:
            return
        # "update" carries the changed keys; a move that touched neither the
        # name, the icon nor the area cannot change what we render.
        if data.get("action") == "update":
            changed = data.get("changes") or {}
            if isinstance(changed, dict) and changed and not (
                changed.keys() & {"name", "original_name", "icon", "original_icon",
                                  "area_id", "labels", "entity_id", "disabled_by",
                                  "hidden_by"}
            ):
                return
        if not any(_spec_wants_entity(hass, spec, entity_id) for spec in specs):
            return
        _LOGGER.debug(
            "Entity registry change for %s matches a binding; scheduling refresh",
            entity_id,
        )
        on_change()

    _LOGGER.debug("Watching the entity registry for %d bound spec(s)", len(specs))
    return hass.bus.async_listen(EVENT_ENTITY_REGISTRY_UPDATED, _on_registry_event)


# ── the source table ──────────────────────────────────────────────────
#
# Adding a source is one table entry plus its resolver.


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    param_schema: dict[str, dict[str, Any]]
    resolve: Callable[..., Awaitable[list[DynamicItem]]]

    #: Domain the source's ``entity`` must belong to, or ``""`` for any.
    #: Device-mode pages can target a ``remote.*`` sibling, but media sources
    #: need the media_player sibling recorded in the binding.
    entity_domain: str = ""

    #: Whether this source's items can carry differing ``action`` values.
    #:
    #: Favorites always use ``media_player.play_media``; ``entities`` may move
    #: between e.g. ``scene.turn_on`` and ``homeassistant.turn_on``. This only
    #: sets defaults; authored bindings follow their tokens and panel overrides.
    item_actions_vary: bool = False

    #: Whether an item's ``identity`` is the entity id of the thing the button
    #: acts on, rather than an opaque handle.
    #:
    #: This is what lets a refresh re-point a button without the entity id also
    #: being stored in the step payload. Favorites are the counter-example and
    #: the reason this is not simply assumed: their identity is a media id, and
    #: one containing a dot would otherwise be mistaken for an entity and
    #: overwrite the speaker the button actually plays to.
    items_are_entities: bool = False

    #: Optional source-specific push hook. It receives all specs bound to this
    #: source, owns filtering, and calls debounced ``on_change`` when relevant.
    #: ``None`` means the source relies on navigation/reconnect triggers.
    subscribe: Callable[..., Any] | None = None

    @property
    def default_fields(self) -> list[str]:
        """Fields a new binding on this source should track by default."""
        fields = list(DEFAULT_TRACKED_FIELDS)
        if self.item_actions_vary:
            fields.append("action")
        return fields

    def describe(self) -> dict[str, Any]:
        """Metadata for ``lizaip_config/list_dynamic_sources``."""
        return {
            "id": self.id,
            "name": self.name,
            "params": self.param_schema,
            "default_fields": self.default_fields,
            "item_actions_vary": self.item_actions_vary,
        }


SOURCES: dict[str, Source] = {
    "favorites": Source(
        id="favorites",
        name="Media favorites",
        param_schema=_ENTITY_PARAM,
        resolve=resolve_favorites,
        # Favorites expand into media_player services, so they need media_player.
        entity_domain=MEDIA_PLAYER_DOMAIN,
        subscribe=subscribe_favorites,
    ),
    "entities": Source(
        id="entities",
        name="Entities",
        param_schema=_ENTITIES_PARAMS,
        resolve=resolve_entities,
        # Entity items span domains, so re-pointing can change the service.
        item_actions_vary=True,
        items_are_entities=True,
        subscribe=subscribe_entity_registry,
    ),
    "scenes": Source(
        id="scenes",
        name="Scenes",
        param_schema=_AREA_LABEL_PARAMS,
        resolve=resolve_scenes,
        items_are_entities=True,
        subscribe=registry_subscriber("scene"),
    ),
    "scripts": Source(
        id="scripts",
        name="Scripts",
        param_schema=_AREA_LABEL_PARAMS,
        resolve=resolve_scripts,
        items_are_entities=True,
        subscribe=registry_subscriber("script"),
    ),
}


def get_source(source_id: str) -> Source | None:
    """Look up a source, or ``None``."""
    return SOURCES.get(source_id)


async def async_resolve_source(
    hass: HomeAssistant,
    source_id: str,
    spec: dict[str, Any] | None,
    *,
    max_items: int = DEFAULT_MAX_ITEMS,
    best_effort: bool = False,
) -> ResolveResult:
    """Resolve one source and classify success, emptiness and failure.

    ``best_effort`` is for callers that only *display* the answer. A source
    that refuses to be read may still have handed back what it refused, and a
    preview showing a greyed-out list beats a preview showing nothing. The
    error is reported either way, so a caller that writes buttons — which
    passes ``best_effort=False`` — never sees the degraded items at all.
    """
    source = get_source(source_id)
    if source is None:
        return ResolveResult(error=f"Unknown dynamic source '{source_id}'")

    key = spec_key(source_id, spec)
    now = time.time()
    try:
        items = await source.resolve(hass, dict(spec or {}), max_items)
    except asyncio.CancelledError:
        raise
    except SourceUnavailable as exc:
        _WARNED_EMPTY.discard(key)
        _LOGGER.warning(
            "Dynamic source %r failed for spec %s: %s", source_id, spec, exc
        )
        refused = getattr(exc, "refused", None) if best_effort else None
        clean = [item for item in (refused or []) if isinstance(item, DynamicItem)]
        return ResolveResult(items=clean, error=str(exc) or exc.__class__.__name__)
    except Exception as exc:  # noqa: BLE001 - a source must never crash a refresh
        _WARNED_EMPTY.discard(key)
        _LOGGER.warning(
            "Dynamic source %r failed for spec %s: %s", source_id, spec, exc
        )
        return ResolveResult(error=str(exc) or exc.__class__.__name__)

    clean_items = [item for item in (items or []) if isinstance(item, DynamicItem)]
    if not clean_items:
        # Empty is a successful answer; unreadable sources raise and preserve
        # last-known button content.
        if key not in _WARNED_EMPTY:
            _WARNED_EMPTY.add(key)
            _LOGGER.warning(
                "Dynamic source %r returned no items for spec %s; the source is "
                "reachable, so anything bound to it will be blanked",
                source_id,
                spec,
            )
        else:
            _LOGGER.debug(
                "Dynamic source %r still returned no items for spec %s",
                source_id,
                spec,
            )
        return ResolveResult(items=[], succeeded_at=now)
    _WARNED_EMPTY.discard(key)
    return ResolveResult(items=clean_items, succeeded_at=now)


def spec_key(source_id: str, spec: dict[str, Any] | None) -> str:
    """Stable identity key for ``(source_id, spec)``.

    Sorted JSON collapses structurally identical specs, e.g. eight favorite
    buttons bound to the same ``{entity: ...}``. Watched-spec dedupe and empty
    warning rate limits both use this identity.
    """
    try:
        raw = json.dumps(spec or {}, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        raw = repr(sorted((spec or {}).items()))
    digest = hashlib.md5(f"{source_id}|{raw}".encode()).hexdigest()
    return f"{source_id}:{digest[:12]}"


def validate_spec(source_id: str, spec: dict[str, Any] | None) -> str | None:
    """Return an error string when *spec* is unusable for *source_id*.

    Only presence of required params is checked. A source's own ``resolve``
    stays responsible for anything it cannot know up front (entity missing,
    integration offline) — those are runtime staleness, not config errors.
    """
    source = get_source(source_id)
    if source is None:
        return f"Unknown dynamic source '{source_id}'"
    if spec is None:
        spec = {}
    if not isinstance(spec, dict):
        return "spec must be a mapping"
    missing = [
        key
        for key, meta in (source.param_schema or {}).items()
        if meta.get("required") and not spec.get(key)
    ]
    if missing:
        return f"Source '{source_id}' requires: {', '.join(sorted(missing))}"
    return None
