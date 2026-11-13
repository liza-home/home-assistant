"""Dynamic source registry for ``@<source>[N]`` template tokens.

A source turns a declarative ``spec`` into an ordered list of
:class:`DynamicItem` objects. ``templates.py`` asks for item N of source X with
spec S; the source owns how to get it.

Item shape is normalized across sources:

    title      — display name, becomes the button's ``tooltip``
    thumbnail  — artwork URL or an ``mdi:`` icon (``""`` when absent)
    action     — HA service to call, e.g. ``media_player.play_media``
    data       — service payload
    identity   — stable id recorded on the assignment for future refreshes
"""
from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import html
import json
import logging
import unicodedata
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, fields
from typing import Any, Final

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_state_change_event

from ...shared.assignment import ASSIGNMENT_DYNAMIC_KEY
from .entity_source import (
    _AREA_LABEL_PARAMS,
    _ENTITIES_PARAMS,
    registry_subscriber,
    resolve_entities,
    resolve_scenes,
    resolve_scripts,
    subscribe_entity_registry,
)
from .items import (  # noqa: F401 - re-exported
    DEFAULT_MAX_ITEMS,
    DEFAULT_TRACKED_FIELDS,
    DynamicItem,
    ResolveResult,
    SourceUnavailable,
)
from .page_source import resolve_pages, subscribe_pages
from .tv_platform import platform_of
from .tv_platform.android_tv import is_system_app

_LOGGER = logging.getLogger(__name__)

MEDIA_PLAYER_DOMAIN = "media_player"

_WARNED_EMPTY: set[str] = set()


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
    "albums": ("object.container.album.musicAlbum",),
    "tracks": ("object.item.audioItem.musicTrack",),
    "podcasts": ("object.container.podcast",),
    "audiobooks": ("object.item.audioItem.audioBook",),
}

#: The category asking for a TV's or player's apps rather than its favourites.
APPS_CATEGORY: Final = "apps"

#: The category asking for a TV's inputs (HDMI and the like) rather than apps.
INPUTS_CATEGORY: Final = "inputs"

#: What integrations call the browse folder holding their apps.
_APP_FOLDERS: Final = ("apps", "app_list", "applications")

#: ``MediaPlayerEntityFeature.SELECT_SOURCE``, named rather than imported so
#: that this module keeps to Home Assistant's core.
_SELECT_SOURCE: Final = 2048

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


# ── browse helpers ────────────────────────────────────────────────────


def _display_title(raw: Any) -> str:
    """A browse child's title as its owner means it to read.

    A set is free to hand its labels out XML-escaped, and a Bravia does, so
    an app named "Timer & Uhr" can arrive as "Timer &amp; Uhr" and would
    otherwise reach the button, its tooltip and its drawn icon that way.
    """
    return html.unescape(str(raw or ""))


def _extract_playable_items(result, max_items: int) -> list[dict]:
    items: list[dict] = []
    if not hasattr(result, "children") or not result.children:
        return items
    for child in result.children:
        if getattr(child, "can_play", False):
            items.append({
                "title": _display_title(child.title),
                "thumbnail": child.thumbnail or "",
                "media_content_id": child.media_content_id or "",
                "media_content_type": str(child.media_content_type or ""),
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


async def favorite_kinds(hass: HomeAssistant, entity_id: str) -> set[str] | None:
    """The :data:`FAVORITE_CATEGORIES` kinds *entity_id* has favourites of.

    Sonos lists a favourites folder only for a kind it has one of. ``None``
    when the player cannot be asked.
    """
    entity = await find_media_entity(hass, entity_id)
    if entity is None:
        _LOGGER.debug("favorite_kinds: %s not found", entity_id)
        return None
    try:
        result = await _browse(entity, "favorites", "", 10)
    except Exception as exc:  # noqa: BLE001 - an unreachable speaker
        _LOGGER.debug("favorite_kinds: %s cannot be browsed: %s", entity_id, exc)
        return None
    folders = {str(c.media_content_id) for c in (getattr(result, "children", None) or [])}
    kinds = {kind for kind, ids in FAVORITE_CATEGORIES.items() if folders & set(ids)}
    _LOGGER.debug("favorite_kinds: %s has %s", entity_id, sorted(kinds))
    return kinds


async def _browse_app_folders(entity, entity_id: str) -> tuple[Any, bool]:
    """The first of :data:`_APP_FOLDERS` the player answers, and whether it browses.

    ``NotImplementedError`` is how a media player says it does not browse at
    all -- Home Assistant's own browse command reads it the same way -- as
    against answering with nothing to show.
    """
    result, browses = None, False
    for folder in _APP_FOLDERS:
        try:
            result = await _browse(entity, "apps", folder, 15)
        except NotImplementedError:
            continue
        except Exception as exc:  # noqa: BLE001 - another folder name may answer
            _LOGGER.debug("browse_media(apps, %s) failed for %s: %s", folder, entity_id, exc)
            browses = True
            continue
        browses = True
        if getattr(result, "children", None):
            break
    return result, browses


def _app_rows(result, max_items: int) -> list[dict]:
    """The apps among a browse result's children, each of them once.

    Android TV Remote marks its apps unplayable, so an app is taken by its
    type rather than by ``can_play``.

    A set may hand one app out twice, and a Bravia does. The first of each
    name stands.
    """
    rows: dict[str, dict] = {}
    for child in (getattr(result, "children", None) or []):
        if not (child.media_content_type == "app" or getattr(child, "can_play", False)):
            continue
        title = _display_title(child.title)
        app_id = str(child.media_content_id or "")
        # A repeat can carry a second launch id, so apps are told apart by
        # name, read as written -- an unnamed one by the id it launches.
        key = title.casefold() or app_id
        if key in rows:
            continue
        rows[key] = {
            "title": title,
            "thumbnail": child.thumbnail or "",
            "media_content_id": app_id,
            "media_content_type": str(child.media_content_type or ""),
        }
        if len(rows) >= max_items:
            break
    return list(rows.values())


def _sources_unread(entity) -> bool:
    """Whether a player that has sources has yet to read them.

    A player which says it can select a source but names none has not read
    them yet; one that does not offer the feature at all -- Chromecast, the
    Android TV Remote -- simply has none and is not asked again.
    """
    try:
        if not int(getattr(entity, "supported_features", 0) or 0) & _SELECT_SOURCE:
            return False
        return not getattr(entity, "source_list", None)
    except Exception:  # noqa: BLE001 - a property that reads the device
        return False


async def _browse_apps(entity, entity_id: str, max_items: int) -> tuple[list[dict], bool]:
    """The apps a player browses, and whether it browses them at all.

    Apple TV, Roku, Sony Bravia and Android TV Remote answer
    ``("apps", "apps")``; the Hisense TV integration calls its folder
    ``app_list``. Each has one entry per app, which ``play_media`` opens.

    A Sony Bravia in standby has never read its sources -- it reads them when
    it is on, or when its *root* is browsed -- and answers for its apps folder
    with nothing. Browsing the root once makes it read them, and is asked for
    only when the player has sources it has yet to read.
    """
    if entity is None or not hasattr(entity, "async_browse_media"):
        return [], False
    result, browses = await _browse_app_folders(entity, entity_id)
    rows = _app_rows(result, max_items)
    if rows or not platform_of(entity).reads_sources_on_root_browse or not _sources_unread(entity):
        return rows, browses
    try:
        await _browse(entity, None, None, 15)
    except Exception as exc:  # noqa: BLE001 - a player that cannot be read
        _LOGGER.debug("browse_media(root) failed for %s: %s", entity_id, exc)
        return rows, browses
    result, browses = await _browse_app_folders(entity, entity_id)
    return _app_rows(result, max_items), browses


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


def _excluded(names: tuple[str, ...], patterns: Sequence[str]) -> bool:
    """Whether any of *names* matches one of *patterns* (``*`` wildcards, any case)."""
    return any(
        fnmatch.fnmatchcase(name.casefold(), pattern.casefold())
        for name in names for pattern in patterns
    )


def _system_app(row: dict) -> bool:
    """Whether a browsed app belongs to the set itself rather than to its owner."""
    return is_system_app(row.get("media_content_id", ""))


def _owners_apps(rows: list[dict], entity_id: str) -> list[dict]:
    """*rows* without the set's own plumbing, naming what went for the log.

    A set lists its apps by package name but shows them by title, so the log
    is the only place the two can be told apart when a page looks wrong.
    """
    kept, own = [], []
    for row in rows:
        (own if _system_app(row) else kept).append(row)
    if own:
        _LOGGER.debug(
            "%s: %d of %d apps are the set's own and stay off its page: %s",
            entity_id, len(own), len(rows),
            ", ".join(sorted(r.get("media_content_id", "") for r in own)),
        )
    return kept


def _alphabetical(title: str) -> tuple[str, str]:
    """A name's place in an alphabetical list, ignoring case and accents:
    "ARTE" after "Amazon", "Ö3" among the O's."""
    plain = unicodedata.normalize("NFKD", title)
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return (plain.casefold(), title)


def _patterns(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    return [str(v).strip() for v in (value or []) if str(v).strip()]


async def read_source_list(
    hass: HomeAssistant, entity_id: str, max_items: int, entity=None,
    *, keep: Callable[[str], bool] | None = None,
    sort_key: Callable[[str], Any] | None = None,
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
    if keep is not None:
        source_list = [title for title in source_list if keep(title)]
    if sort_key is not None:
        source_list = sorted(source_list, key=sort_key)

    tv = platform_of(entity)
    thumbnails: dict[str, str] = {}
    if entity is not None and hasattr(entity, "async_browse_media"):
        thumbnails = await get_browse_thumbnails(entity, entity_id)

    return [
        DynamicItem(
            title=source,
            thumbnail=thumbnails.get(source) or tv.source_artwork(entity, source),
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
    "exclude": {
        "type": "list",
        "required": False,
        "description": (
            "Apps or inputs to leave out, by name or app id; * matches anything"
        ),
    },
    "include": {
        "type": "list",
        "required": False,
        "description": (
            "inputs: which sources are inputs, by name; * matches anything."
            " For a TV that does not say so itself (only LG webOS does)"
        ),
    },
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
            + " (Sonos), apps: the apps a TV or player can open, or inputs: its"
            + " inputs (HDMI and the like)"
        ),
    },
}


#: Unreachable states, kept literal so test-stubbed HA modules can import this.
_UNREACHABLE_STATES = {"unavailable", "unknown", "none"}


def _ensure_reachable(hass: HomeAssistant, entity_id: str) -> None:
    state = hass.states.get(entity_id)
    if state is None:
        raise SourceUnavailable(f"{entity_id} has no state (not loaded yet?)")
    value = getattr(state, "state", None)
    if isinstance(value, str) and value.lower() in _UNREACHABLE_STATES:
        raise SourceUnavailable(f"{entity_id} is {value}")


async def _read_tv_sources(
    hass: HomeAssistant, entity, entity_id: str, spec: dict[str, Any],
    exclude: list, max_items: int, *, inputs: bool,
) -> list[DynamicItem]:
    """A TV's apps or its inputs, from its ``source_list``.

    Not browsable: TVs such as webOS, Fire TV and Samsung list their apps (and
    inputs) as sources instead. Apps alphabetically; inputs in the order the
    TV keeps them. Only webOS says which source is an input; for another TV
    the template names them under `include`.
    """
    include = _patterns(spec.get("include")) if inputs else []
    tv = platform_of(entity)

    def wanted_input(title: str) -> bool:
        if include:
            return _excluded(tv.source_ids(entity, title), include)
        return tv.is_input(entity, title)

    items = await read_source_list(
        hass, entity_id, max_items, entity,
        keep=lambda title: wanted_input(title) == inputs
        and not _excluded(tv.source_ids(entity, title), exclude),
        sort_key=None if inputs else _alphabetical,
    )
    if inputs and items:
        order = tv.source_order(entity, [i.title for i in items])
        items.sort(key=lambda i: order.index(i.title))
    return items


async def _resolve_apps(
    hass: HomeAssistant, entity, entity_id: str, spec: dict[str, Any], max_items: int,
) -> list[DynamicItem]:
    """A TV's apps: browsed, else from its sources, else the ones it listed last.

    A TV that is off lists none -- or cannot be read at all -- and its Apps
    page would empty with it; the list it gave last stands in (see
    :mod:`.app_cache`).

    Only a TV that browses no apps at all lists them as sources instead; one
    that keeps them in a browse folder has none to show rather than its own
    HDMI sockets, and sockets kept from before are dropped.

    A set's own plumbing -- Android's launcher, store and settings, and what
    its maker adds on top -- is left out wherever the TV hands out its
    installed packages unasked; a hand-written list is taken as it stands.
    """
    from .app_cache import async_get, async_put, cache_key

    exclude = _patterns(spec.get("exclude"))
    key = cache_key(entity_id, exclude)
    every = DEFAULT_MAX_ITEMS * 4
    raw, browses = await _browse_apps(entity, entity_id, every)
    platform = platform_of(entity)
    raw = [r for r in raw if not _excluded((r.get("title", ""), r.get("media_content_id", "")), exclude)]
    if not platform.keeps_system_apps:
        raw = _owners_apps(raw, entity_id)
    if raw:
        await platform.decorate(hass, raw)
    else:
        raw = [
            r for r in await platform.fallback_apps(hass, entity)
            if not _excluded((r["title"], r["media_content_id"]), exclude)
        ]
    if raw:
        items = _items_from_browse(sorted(raw, key=lambda r: _alphabetical(r.get("title", ""))))
    elif browses:
        items = []
    else:
        items = await _read_tv_sources(hass, entity, entity_id, spec, exclude, every, inputs=False)
    if items:
        await async_put(hass, key, [asdict(i) for i in items])
        return items[:max_items]
    known = {f.name for f in fields(DynamicItem)}
    kept = [
        DynamicItem(**{k: v for k, v in d.items() if k in known})
        for d in await async_get(hass, key)
        if not (browses and d.get("action") == "media_player.select_source")
    ]
    if kept:
        return kept[:max_items]
    _ensure_reachable(hass, entity_id)
    return []


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
    known = (*FAVORITE_CATEGORIES, APPS_CATEGORY, INPUTS_CATEGORY)
    if category and category not in known:
        raise ValueError(
            f"unknown favorites category {category!r}; expected one of "
            f"{', '.join(sorted(known))}"
        )

    entity = await find_media_entity(hass, entity_id)

    if category == APPS_CATEGORY:
        return await _resolve_apps(hass, entity, entity_id, spec, max_items)

    if category == INPUTS_CATEGORY:
        exclude = _patterns(spec.get("exclude"))
        items = await _read_tv_sources(hass, entity, entity_id, spec, exclude, max_items, inputs=True)
        if not items:
            _ensure_reachable(hass, entity_id)
        return items

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
        # "Nothing" is credible only if the player is currently reachable.
        _ensure_reachable(hass, entity_id)

    if items:
        return items

    return []


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
    "pages": Source(
        id="pages",
        name="Pages of this remote",
        param_schema={
            "remote": {
                "type": "string",
                "required": True,
                "description": "Config entry of the remote whose pages are listed (@remote_entry)",
            },
            "exclude_template": {
                "type": "string",
                "required": False,
                "description": "Pages made from this template are left out (default: toc)",
            },
        },
        resolve=resolve_pages,
        subscribe=subscribe_pages,
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
) -> ResolveResult:
    """Resolve one source and classify success, emptiness and failure."""
    source = get_source(source_id)
    if source is None:
        return ResolveResult(error=f"Unknown dynamic source '{source_id}'")

    key = spec_key(source_id, spec)
    now = time.time()
    try:
        items = await source.resolve(hass, dict(spec or {}), max_items)
    except asyncio.CancelledError:
        raise
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
