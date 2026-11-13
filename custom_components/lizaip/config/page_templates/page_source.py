"""The ``pages`` source: a remote's own pages, as tiles that lead to them."""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from homeassistant.core import HomeAssistant, callback

from .items import DynamicItem, SourceUnavailable


_LOGGER = logging.getLogger(__name__)


# ── pages ─────────────────────────────────────────────────────────────

#: What a page tile says when its page's title has no picture: short enough to
#: stay legible on a 50×52 tile.
_SHORT_TEXT = 10

_TOKEN_RE = re.compile(r"\$\{[^}]*\}")


def _is_graphic_part(part: str) -> bool:
    """Whether *part* of a title is a picture rather than words."""
    from ...imgserv.source_parse import PART_SOURCE_TYPES, is_address
    from ...shared.icon_urls import custom_icon_scheme

    if is_address(part) or custom_icon_scheme(part):
        return True
    m = re.match(r"^([a-z][a-z0-9_]*):", part)
    return bool(m) and m.group(1) in PART_SOURCE_TYPES and m.group(1) not in ("text", "ref")


def _short_text(name: str) -> str:
    """*name*, short enough for a tile: whole, else its first word, else cut."""
    if len(name) <= _SHORT_TEXT:
        return name
    first = name.split()[0] if name.split() else name
    return first if len(first) <= _SHORT_TEXT + 2 else name[:_SHORT_TEXT]


def title_parts(title: str) -> tuple[list[str], str]:
    """The words and the first picture of a page's title.

    Variables are left out -- they would be read against the overview, not the
    page -- and so are a part's options (``text:demo?percent=47``).
    """
    from ...imgserv.source_parse import split_source_parts

    words: list[str] = []
    picture = ""
    for part in split_source_parts(_TOKEN_RE.sub("", title or "").strip()):
        part = part.split("?", 1)[0].strip()
        if not part or part in ("+", "-"):
            continue
        if part.startswith("text:"):
            words.append(part[len("text:"):].strip())
        elif _is_graphic_part(part):
            picture = picture or part
        else:
            words.append(part)
    return [w for w in words if w and w not in ("+", "-")], picture


def page_name(title: str, page_id: Any = None) -> str:
    """A page's name, read off its title: its words, else its first picture.

    The plumbing of schemes is left out, as :func:`title_parts` leaves out
    variables and options. ``logo:sonos + ${_device}`` is "Sonos".
    """
    words, picture = title_parts(title)
    name = " ".join(words).strip(" +-")
    if not name and picture and not picture.startswith(("media:", "/", "http")):
        slug = picture.split(":", 1)[1]
        name = " ".join(w[:1].upper() + w[1:] for w in re.split(r"[-_]+", slug) if w)
    return name or (f"Page {page_id}" if page_id is not None else "")


def page_tile(title: str, name: str) -> str:
    """The tile for a button that opens a page whose title is *title*.

    The first picture in the title -- a logo, an icon, a cover -- or, for a
    title of words alone, a short text of the page's name. A part holding a
    variable is passed over: it would be read against the page the tile is on,
    not the page it opens.
    """
    from ...imgserv.source_parse import split_source_parts

    for part in split_source_parts((title or "").strip()):
        if "${" not in part and _is_graphic_part(part):
            return part
    return f"text:{_short_text(name)}" if name else ""


def _listed_pages(pages: list, exclude: str, overviews: set | frozenset = frozenset()) -> list[dict]:
    """The main pages an overview lists: no subpages, no overview pages.

    An overview is recognised by what it does -- *overviews* are the pages with
    a button bound to this source -- because a page made from an unbound
    template is stored without a ``template:`` key to recognise it by.
    """
    from ..const import is_subpage

    listed = []
    for page in pages or []:
        if not isinstance(page, dict) or is_subpage(page) or page.get("id") is None:
            continue
        if page["id"] in overviews:
            continue
        template = page.get("template")
        if isinstance(template, dict) and template.get("type") == exclude:
            continue
        listed.append(page)
    return listed


async def _remote_pages(hass: HomeAssistant, entry_id: str) -> tuple[list, set]:
    """The remote's pages, and the ids of those that are overviews themselves."""
    from ...runtime import resolve_device_id, find_store
    from ...shared.assignment import ASSIGNMENT_DYNAMIC_KEY

    store = find_store(hass)
    device_id = resolve_device_id(hass, entry_id)
    if store is None or not device_id:
        raise SourceUnavailable(f"remote {entry_id} is not loaded")
    pages = await store.async_get_pages(device_id)
    overviews: set = set()
    for page in pages:
        if not isinstance(page, dict) or page.get("id") is None:
            continue
        assignments = await store.async_get_assignments(device_id, page["id"]) or {}
        if any(
            isinstance(a, dict)
            and isinstance(a.get(ASSIGNMENT_DYNAMIC_KEY), dict)
            and a[ASSIGNMENT_DYNAMIC_KEY].get("source") == "pages"
            for a in assignments.values()
        ):
            overviews.add(page["id"])
    return pages, overviews


def _exclude(spec: dict[str, Any]) -> str:
    return str(spec.get("exclude_template") or "toc")


async def resolve_pages(
    hass: HomeAssistant, spec: dict[str, Any], max_items: int,
) -> list[DynamicItem]:
    """The remote's main pages, in page order, each as a "go to page" item.

    ``spec["remote"]`` is the remote's config entry (``@remote_entry`` in a
    template). Subpages are not main pages, and a page made from the template
    named by ``exclude_template`` (``toc`` by default) is the table of contents
    itself, which must not link to itself or to another overview.
    """
    entry_id = str(spec.get("remote") or "").strip()
    if not entry_id or entry_id.startswith("@"):
        raise SourceUnavailable("no remote to list the pages of")

    pages, overviews = await _remote_pages(hass, entry_id)
    items: list[DynamicItem] = []
    for page in _listed_pages(pages, _exclude(spec), overviews):
        page_id = page["id"]
        name = page_name(str(page.get("title") or ""), page_id)
        items.append(DynamicItem(
            title=name,
            thumbnail=page_tile(str(page.get("title") or ""), name),
            action="lizaip.goto_page",
            data={"page_id": page_id},
            identity=f"page:{page_id}",
        ))
        if len(items) >= max_items:
            break
    return items


def pages_fingerprint(
    pages: list, exclude: str = "toc", overviews: set | frozenset = frozenset(),
) -> frozenset:
    """What an overview depends on: which main pages there are, and their titles.

    Order is deliberately not part of it -- moving pages around does not call
    for a refresh, and neither does any edit to a page's buttons.
    """
    return frozenset(
        (page["id"], str(page.get("title") or ""))
        for page in _listed_pages(pages, exclude, overviews)
    )


#: The page list each watched remote was last seen with, by ``(entry, exclude)``.
#: Kept across subscriptions on purpose: deleting a page that has bound buttons
#: of its own re-subscribes every hook, and a hook that took its starting point
#: from the list *after* that deletion would see nothing to refresh for.
_PAGES_SEEN: dict[tuple[str, str], frozenset] = {}


def subscribe_pages(hass: HomeAssistant, specs, on_change) -> Any | None:
    """Fire when a listed remote gains or loses a main page, or one is retitled.

    Every saved change to a remote announces itself with ``CONFIG_CHANGED_EVENT``,
    but most of them -- a button edited, pages reordered, the overview's own
    refresh -- leave the page list as it was. Each announcement is compared
    against a fingerprint of the page list (:func:`pages_fingerprint`) and only
    a different one schedules a refresh.
    """
    from ..const import CONFIG_CHANGED_EVENT

    watched: dict[str, str] = {}
    for spec in specs:
        if isinstance(spec, dict) and spec.get("remote"):
            watched.setdefault(str(spec["remote"]), _exclude(spec))
    if not watched:
        return None
    # What the returned unsubscribe stops: a check still reading the store
    # when the page goes away must not schedule a refresh after it.
    closed = False
    tasks: set[asyncio.Task] = set()

    async def _check(entry_id: str, prime: bool = False) -> None:
        key = (entry_id, watched[entry_id])
        if prime and key in _PAGES_SEEN:
            return
        try:
            pages, overviews = await _remote_pages(hass, entry_id)
        except SourceUnavailable:
            return
        if closed:
            return
        fingerprint = pages_fingerprint(pages, watched[entry_id], overviews)
        before = _PAGES_SEEN.get(key)
        _PAGES_SEEN[key] = fingerprint
        if not prime and fingerprint != before:
            _LOGGER.debug("Pages of %s changed; refreshing its overview", entry_id)
            on_change()

    def _start(entry_id: str, prime: bool = False) -> None:
        task = hass.async_create_task(_check(entry_id, prime))
        if task is not None:
            tasks.add(task)
            task.add_done_callback(tasks.discard)

    for entry_id in watched:
        _start(entry_id, prime=True)

    # On the loop: HA runs a listener not marked as a callback in a worker
    # thread, where scheduling the check is not allowed.
    @callback
    def _on_config_changed(event: Any) -> None:
        entry_id = (getattr(event, "data", None) or {}).get("entry_id")
        if entry_id in watched and not closed:
            _start(entry_id)

    unlisten = hass.bus.async_listen(CONFIG_CHANGED_EVENT, _on_config_changed)

    def _unsubscribe() -> None:
        nonlocal closed
        closed = True
        unlisten()
        for task in list(tasks):
            task.cancel()
        tasks.clear()

    return _unsubscribe
