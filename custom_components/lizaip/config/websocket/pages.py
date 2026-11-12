"""The page list: reading it, reordering, adding, editing and duplicating pages.

A page-list change is stored first, then pushed to the remote: the order alone
when that is all that changed, otherwise through the full sync.
"""
from __future__ import annotations

import copy
import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ...runtime import get_store, entry_connection
from ...shared.logs import device_id_logger
from ..blueprint import async_get_blueprint
from ..const import (
    EMPTY_BUTTON,
    PAGE_ID_SCHEMA,
    PAGE_SUBPAGE_KEY,
    PAGES_SCHEMA,
    generate_page_id,
)
from ..device_sync import is_ready
from ..events import fire_config_changed
from ..listeners import refresh_state_listener, schedule_push_rescan
from ..page_list import (
    async_drop_links_to,
    device_holds_every_page,
    deliverable_main_pages,
    push_page_list,
    reserved_page_ids,
    send_main_pages,
)
from .common import requires_device, send_failure
from ..access import require_device_access

_LOGGER = logging.getLogger(__name__)


async def _empty_page_assignments(
    hass: HomeAssistant, entry_id: str | None = None,
) -> dict[str, dict]:
    bp = await async_get_blueprint(hass, entry_id)
    return {btn["key"]: dict(EMPTY_BUTTON) for btn in bp.get("buttons", [])}


@websocket_api.websocket_command({
    "type": "lizaip_config/get_pages",
    vol.Required("entry_id"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_get_pages(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    store = get_store(hass)
    connection.send_result(msg["id"], {"pages": await store.async_get_pages(device_id)})


def _reordered_pages(stored: list, incoming: list) -> list | None:
    """*incoming* as a pure reorder of *stored*, or ``None`` if it is not one.

    A reorder keeps every page and every field; only the sequence moves. Any
    page added, removed or edited means the caller has to take the full path,
    which rewrites the page files. The stored dicts are returned rather than
    the client's, so nothing the panel omitted can be dropped.
    """
    if len(stored) != len(incoming):
        return None

    by_id: dict = {}
    for page in stored:
        if not isinstance(page, dict) or not page.get("id"):
            return None
        by_id[page["id"]] = page

    out = []
    seen = set()
    for page in incoming:
        if not isinstance(page, dict):
            return None
        base = by_id.get(page.get("id"))
        if base is None or page["id"] in seen:
            return None
        # The panel echoes back the page it was given, so a field that differs
        # is an edit riding along with the move and has to take the slow path.
        merged = dict(base)
        merged.update(page)
        if merged != base:
            return None
        seen.add(page["id"])
        out.append(base)

    return out


async def _reorder_pages_fast(
    hass: HomeAssistant, connection, msg: dict, device_id: str, store, pages: list
) -> None:
    """Persist and push a page reorder, answering the panel before touching the device.

    Order is one list of ids on disk (``page_order.yaml``) and one
    ``set_main_pages`` on the wire — PROTOCOL.md §"display order is defined
    solely by `set_main_pages`" — and page order is not part of a page's
    payload, so no page payload changes and none needs resending.

    The reply goes out first. Everything after it is bookkeeping the panel does
    not have to wait on, and used to add a device round trip plus a full
    config-payload rebuild to the time a dragged thumbnail took to land.
    """
    await store.async_set_page_order(device_id, pages)
    connection.send_result(msg["id"], {"success": True, "pages": pages})

    conn = entry_connection(hass.config_entries.async_get_entry(msg["entry_id"]))
    order_only = False
    deliverable = (
        deliverable_main_pages(conn, pages)
        if is_ready(conn)
        else None
    )
    if deliverable is not None and deliverable == conn.page_cache.main_pages:
        # Already the order the device holds. `set_main_pages` makes it rewrite
        # its whole page setup, so sending it again is work with no effect.
        deliverable = None
        order_only = device_holds_every_page(conn, pages)
    if deliverable is not None:
        if await send_main_pages(
            conn, deliverable, device_id_logger(_LOGGER, hass, device_id),
            "set_main_pages after reorder failed: %s",
        ):
            order_only = device_holds_every_page(conn, pages)

    # Other open panels still learn about the move from this. It no longer sits
    # between the drop and the reply, which is the part that was felt, and when
    # the device is already in step it skips rebuilding every page payload --
    # measured at 124 ms on a 22-page remote, growing with the page count.
    fire_config_changed(hass, msg["entry_id"], order_only=order_only)


@websocket_api.websocket_command({
    "type": "lizaip_config/set_pages",
    vol.Required("entry_id"): str,
    vol.Required("pages"): PAGES_SCHEMA,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_set_pages(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Replace the ordered page list.

    Request payload:
      {type, entry_id, pages: [{id?, title, hash, ...}]}
    Response:
      {success: true, pages}
    """

    pages = msg["pages"]

    store = get_store(hass)

    stored_pages = await store.async_get_pages(device_id)
    reordered = _reordered_pages(stored_pages, pages)
    if reordered is not None:
        await _reorder_pages_fast(hass, connection, msg, device_id, store, reordered)
        return

    reserved_ids = await reserved_page_ids(
        store, device_id, {p["id"] for p in pages if p.get("id")}
    )
    # New pages must not inherit stored fields from a recycled id.
    is_new = [not p.get("id") for p in pages]
    minted_ids: set[int] = set()
    for p in pages:
        if not p.get("id"):
            new_id = generate_page_id(reserved_ids)
            p["id"] = new_id
            reserved_ids.add(new_id)
            minted_ids.add(new_id)

    # Preserve page fields the client did not send (template/default_color/etc.):
    # async_set_pages is handed the whole list, so a field missing here would
    # be read as removed. The store writes only the files whose content moved,
    # so a pure reorder touches none of them. Reuses the read the reorder check
    # already did rather than paying for a second one.
    stored_by_id = {
        p["id"]: p for p in stored_pages
        if isinstance(p, dict) and p.get("id")
    }
    merged = []
    for p, fresh in zip(pages, is_new):
        base = {} if fresh else dict(stored_by_id.get(p["id"], {}))
        base.update(p)
        page = {"id": base["id"], "title": base.get("title", "")}
        page.update({k: v for k, v in base.items() if k not in page})
        merged.append(page)
    pages = merged

    # A template may bring pages behind its own. When the panel deletes the
    # page the user sees, the ones it brought go with it; they are reachable
    # only from it.
    kept_ids = {p["id"] for p in pages}
    orphaned = {
        p["id"] for p in stored_pages
        if isinstance(p, dict) and isinstance(p.get("template"), dict)
        and p["template"].get("instance") not in (None, p["id"])
        and p["template"]["instance"] not in kept_ids
    }
    if orphaned:
        pages = [p for p in pages if p["id"] not in orphaned]

    # A pure reorder: the same pages with the same content in new positions.
    # Decided here, while the store still holds the previous list -- once
    # async_set_pages runs, the old content is gone.
    order_only = set(stored_by_id) == {p["id"] for p in pages} and all(
        p == stored_by_id[p["id"]] for p in pages
    )

    existing_assignments = await store.async_get_all_assignments(device_id)
    empty = await _empty_page_assignments(hass, msg["entry_id"])
    for p in pages:
        # A freshly minted page is blanked even when the store already holds
        # assignments under its id. Ids are recycled once nothing points at them
        # any more, and the page that previously held this one is very often
        # deleted by this same call — its buttons are still in
        # `existing_assignments`, which is read before `async_set_pages` prunes
        # them. Seeding only on "id not present" therefore handed the new page
        # the dead page's buttons, fully configured and invisible in the panel
        # until the user opened it.
        if p["id"] in minted_ids or p["id"] not in existing_assignments:
            # A copy each: the store keeps what it is given, and pages sharing
            # one dict would change together.
            await store.async_set_assignments(device_id, p["id"], copy.deepcopy(empty))

    await store.async_set_pages(device_id, pages)
    # A page that is gone takes the links to it along: a page link left behind
    # does nothing on the remote. The panel re-reads the pages named here.
    cleaned = await async_drop_links_to(
        hass, msg["entry_id"], store, device_id, set(stored_by_id) - {p["id"] for p in pages},
    )

    # The list is on disk, which is all the panel asked about. Answered now,
    # before the device is touched: `set_main_pages` waits for the page-sync
    # lock -- held for the whole of any running sync -- and then for a remote
    # that may be asleep, and a deleted page used to sit on screen for all of
    # that. The same split `_reorder_pages_fast` makes.
    connection.send_result(msg["id"], {"success": True, "pages": pages, "cleaned": cleaned})
    # Deleted pages can remove the last binding for a push subscription. Only
    # scheduled, so it stays here rather than behind the device round trip.
    schedule_push_rescan(hass, msg["entry_id"])
    try:
        await push_page_list(hass, msg["entry_id"], pages, order_only)
    except Exception:  # noqa: BLE001 - the reply has gone; a raise would send a second one
        device_id_logger(_LOGGER, hass, device_id).exception(
            "Pushing the page list after set_pages failed",
        )


@websocket_api.websocket_command({
    "type": "lizaip_config/update_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
    vol.Optional("title"): str,
    vol.Optional("default_color"): str,
    vol.Optional(PAGE_SUBPAGE_KEY): bool,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_update_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Update page metadata while preserving other stored page fields.

    Request payload:
      {type, entry_id, page_id, title?, default_color?}
    Response:
      {success: true, pages}
    """

    page_id = msg["page_id"]

    store = get_store(hass)
    # Written whether true or false: the store only keeps the subpage key when
    # it is true, so clearing it is how a page becomes a main page again.
    fields = {key: msg[key] for key in ("title", "default_color", PAGE_SUBPAGE_KEY) if key in msg}
    try:
        pages = await store.async_update_page(device_id, page_id, fields)
    except Exception as err:  # noqa: BLE001
        send_failure(hass, connection, msg, "save_failed", err, logger=_LOGGER, what="Saving the page")
        return
    if pages is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {page_id} not found")
        return
    fire_config_changed(hass, msg["entry_id"])

    page = next(p for p in pages if p["id"] == page_id)
    device_id_logger(_LOGGER, hass, device_id).debug(
        "Updated page %s: title=%s, default_color=%s",
        page_id, page.get("title", ""), page.get("default_color", ""),
    )
    connection.send_result(msg["id"], {"success": True, "pages": pages})


@websocket_api.websocket_command({
    "type": "lizaip_config/duplicate_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_duplicate_page(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Copy a page under a new id, directly after the original.

    The copy keeps every stored page field -- including whether it is a
    subpage -- and gets its own deep copy of the button assignments, so editing
    one page never changes the other.

    Response:
      {success: true, page_id, pages}
    """
    entry_id = msg["entry_id"]
    source_id = msg["page_id"]

    store = get_store(hass)
    pages = await store.async_get_pages(device_id)
    source_idx = next(
        (i for i, p in enumerate(pages) if isinstance(p, dict) and p.get("id") == source_id),
        None,
    )
    if source_idx is None:
        connection.send_error(msg["id"], "page_not_found", f"Page {source_id} not found")
        return

    new_page_id = generate_page_id(
        await reserved_page_ids(
            store, device_id, {p["id"] for p in pages if isinstance(p, dict)}
        )
    )
    new_page = copy.deepcopy(pages[source_idx])
    new_page["id"] = new_page_id
    # The copy is its own page: it stays a template page, but it does not
    # belong to the set the original came from, so deleting that set leaves
    # the copy alone.
    if isinstance(new_page.get("template"), dict):
        new_page["template"].pop("instance", None)
    assignments = copy.deepcopy(await store.async_get_assignments(device_id, source_id))
    try:
        await store.async_insert_page(device_id, new_page, assignments, after=source_id)
    except Exception as err:  # noqa: BLE001
        send_failure(
            hass, connection, msg, "save_failed", err, logger=_LOGGER, what="Duplicating the page",
        )
        return

    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    # The copy carries the same dynamic bindings, which need push subscriptions.
    schedule_push_rescan(hass, entry_id)

    pages = await store.async_get_pages(device_id)
    device_id_logger(_LOGGER, hass, device_id).info(
        "Duplicated page %s as %s", source_id, new_page_id,
    )
    connection.send_result(msg["id"], {
        "success": True,
        "page_id": new_page_id,
        "pages": pages,
    })
