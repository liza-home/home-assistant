"""A remote's page list: its order on the device, links between pages, free ids.

Shared by the panel's websocket handlers and the LLM tools, which both edit the
page list and have to leave the device and the other panels in step with it.
"""
from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any

from homeassistant.core import HomeAssistant

from ..action_controller.toggle import TOGGLE_KEY
from ..runtime import entry_connection
from ..shared.assignment import ASSIGNMENT_DYNAMIC_KEY, ASSIGNMENT_LONGTOUCH_KEY
from ..shared.authorship import as_system
from ..shared.logs import entry_id_logger
from .const import EMPTY_BUTTON, is_subpage, step_service
from .events import fire_config_changed
from .internal_commands import pinned_page_ids
from .listeners import schedule_push_rescan

_LOGGER = logging.getLogger(__name__)


def deliverable_main_pages(conn, pages: list) -> list[int] | None:
    """The main-page order to push straight from the panel, or ``None``.

    `set_main_pages` is all-or-nothing -- naming one page the device does not
    hold makes it reject the whole order -- and a rejection arrives without a
    `seq_id`, costing the caller a ten-second timeout. So this shortcut is
    taken only when the device holds every main page and nothing has to be
    added first.

    Returning ``None`` costs nothing: the full sync that follows filters the
    order down to the pages that actually landed and sends it from there,
    which is what lets a remote with one unstorable page still be reordered.
    """
    if not pages:
        # The user deleted their last page, so the placeholders are about to
        # take its place. Pushing an empty order first would blank the remote
        # for as long as the sync behind this takes.
        return None
    if not device_holds_every_page(conn, pages):
        return None
    return [p["id"] for p in pages if not is_subpage(p)]


def device_holds_every_page(conn, pages: list) -> bool:
    """Whether the device holds every main page, so a sync has nothing to add.

    Narrowing a `config_changed` event to "order only" lets the sync skip
    rebuilding page payloads, which is only safe once there is nothing else
    for it to do. While one page is missing it still has to retry adding it.
    """
    known = conn.page_cache.pages
    return known is not None and all(
        p["id"] in known for p in pages if not is_subpage(p)
    )


async def send_main_pages(conn, page_ids: list, log, failure: str) -> bool:
    """Push a page order under the page-sync lock; True once the device took it.

    Every order push goes through here so none can interleave with a full sync.
    """
    async with conn.page_cache.lock:
        try:
            await conn.set_main_pages(page_ids)
        except Exception as err:  # noqa: BLE001
            log.warning(failure, err)
            # Forgetting the order is what makes the next sync notice it is
            # wrong and resend it; remembering a value we failed to write
            # would make the device's real order invisible. The page contents
            # go with it: a half-remembered device state is what made the next
            # sync diff against pages it no longer knew the device held.
            conn.page_cache.pages = None
            conn.page_cache.main_pages = None
            return False
        conn.page_cache.main_pages = list(page_ids)
        return True


#: The command a page link runs.
_GOTO_PAGE = "lizaip.goto_page"


def _opens_removed(steps: Any, removed: set[int]) -> bool:
    """Whether *steps* is a page link to one of the *removed* pages."""
    if not isinstance(steps, list) or not steps or not isinstance(steps[0], dict):
        return False
    step = steps[0]
    if (step.get("action") or step.get("service")) != _GOTO_PAGE:
        return False
    raw = (step.get("data") or {}).get("page_id")
    try:
        return int(raw) in removed
    except (TypeError, ValueError):
        return False


def drop_links_to(assign: dict, removed: set[int]) -> dict | None:
    """*assign* without its links to *removed* pages, or None if it had none.

    A long touch, a fixed control's override or a toggle step that opens a
    removed page goes; a click that opens one empties the button, keeping a
    long touch that still leads somewhere. A button filled by a dynamic source
    (a Table of contents tile) is left to that source's own refresh.
    """
    if not isinstance(assign, dict) or isinstance(assign.get(ASSIGNMENT_DYNAMIC_KEY), dict):
        return None
    result = deepcopy(assign)
    changed = False
    if _opens_removed(result.get(ASSIGNMENT_LONGTOUCH_KEY), removed):
        result.pop(ASSIGNMENT_LONGTOUCH_KEY)
        changed = True
    overrides = result.get("overrides")
    if isinstance(overrides, dict):
        for key in [k for k, o in overrides.items()
                    if isinstance(o, dict) and _opens_removed(o.get("config"), removed)]:
            overrides.pop(key)
            changed = True
        if not overrides:
            result.pop("overrides")
    toggle = result.get(TOGGLE_KEY)
    rules = toggle.get("rules") if isinstance(toggle, dict) else None
    if isinstance(rules, list):
        kept = [r for r in rules if not (isinstance(r, dict) and _opens_removed(r.get("config"), removed))]
        if len(kept) != len(rules):
            changed = True
            if kept:
                toggle["rules"] = kept
            else:
                result.pop(TOGGLE_KEY)
    if _opens_removed(result.get("config"), removed):
        longtouch = result.get(ASSIGNMENT_LONGTOUCH_KEY)
        result = dict(EMPTY_BUTTON)
        if longtouch:
            result[ASSIGNMENT_LONGTOUCH_KEY] = longtouch
        changed = True
    return result if changed else None


async def async_drop_links_to(
    hass: HomeAssistant, entry_id: str, store, device_id: str, removed: set[int],
) -> list[int]:
    """Remove every link to the *removed* pages from the pages left; return those changed.

    A link to a page that is gone does nothing on the remote, and in the editor
    it kept an options page's long touch "in use" after the page was deleted.
    """
    if not removed:
        return []
    changed_pages: list[int] = []
    everything = await store.async_get_all_assignments(device_id) or {}
    for page in await store.async_get_pages(device_id):
        page_id = page.get("id") if isinstance(page, dict) else None
        if page_id is None or page_id in removed:
            continue
        assignments = everything.get(page_id) or {}
        cleaned = {}
        for key, assign in assignments.items():
            fixed = drop_links_to(assign, removed)
            if fixed is not None:
                cleaned[key] = fixed
        if cleaned:
            # Only links went: whoever asked did not write the steps that stay.
            with as_system():
                await store.async_set_assignments(device_id, page_id, {**assignments, **cleaned})
            changed_pages.append(page_id)
    if changed_pages:
        # A dropped link can be a button's last dynamic binding.
        schedule_push_rescan(hass, entry_id)
    return changed_pages


async def push_page_list(
    hass: HomeAssistant, entry_id: str, pages: list, order_only: bool
) -> None:
    """Tell the device and the other panels about a page list already stored."""
    log = entry_id_logger(_LOGGER, hass, entry_id)
    conn = entry_connection(hass.config_entries.async_get_entry(entry_id))
    order_pushed = False
    page_ids = None
    if conn is not None and conn.connected:
        # PROTOCOL.md §set_main_pages: every id must already exist on the
        # device, and the call is all-or-nothing -- naming one page it does not
        # hold makes it reject the whole order, which is how reordering pages
        # 1-20 silently failed while a refused page sat in the list. So the
        # order carries only the pages the device actually holds, and goes out
        # under the lock the full sync holds so the two never interleave.
        page_ids = deliverable_main_pages(conn, pages)
        if page_ids == conn.page_cache.main_pages:
            # Unchanged: `set_main_pages` makes the device rewrite its whole
            # page setup, so it goes out only when the list actually moved --
            # not on every edit.
            page_ids = None
            order_pushed = device_holds_every_page(conn, pages)
    if page_ids is None:
        log.debug(
            "Leaving the page order to the full sync: the device does not "
            "hold every page yet",
        )
    else:
        if await send_main_pages(
            conn, page_ids, log, "set_main_pages after set_pages failed: %s",
        ):
            order_pushed = device_holds_every_page(conn, pages)

    fire_config_changed(
        hass, entry_id, order_only=order_only and order_pushed
    )


async def reserved_page_ids(store, device_id: str, in_use: set[int]) -> set[int]:
    """Page ids unavailable to newly created pages.

    Ids are reserved while any stored goto button still points at them; otherwise
    a deleted page id could be recycled and a stale goto would open the wrong
    page. Page ids are 32-bit, so reserving a few is harmless.

    The reservation is not only the current page list: buttons can pin page ids
    inside their stored action payloads, and those stale references must stay
    harmless until the user repoints or deletes them.
    """
    reserved = set(in_use)
    for page_assigns in (await store.async_get_all_assignments(device_id)).values():
        for assign in (page_assigns or {}).values():
            if not isinstance(assign, dict):
                continue
            config = assign.get("config", [])
            step = (
                config[0]
                if isinstance(config, list) and config and isinstance(config[0], dict)
                else {}
            )
            reserved |= pinned_page_ids(step.get("data"), step_service(config))
    return reserved
