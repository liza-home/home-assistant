"""Push the panel's configuration at the physical device.

Three modules share the job:

- :mod:`button_rendering` -- what one button *looks* like;
- :mod:`page_payload` -- what a page *contains* (its ``set_page`` payload);
- this module -- *when* and *how* pages are sent: comparing hashes with the
  device, sending only what changed, retrying, and giving up on a remote that
  stopped answering.

Usage:
    from . import device_sync as _device_sync_mod

    await _device_sync_mod.sync_config_to_device(hass, entry)
"""
from __future__ import annotations

import asyncio
import logging
import time
from functools import partial
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from ..device.protocol import (
    DEFAULT_REQUEST_TIMEOUT,
    ERR_CONFLICT,
    SPEC_ERROR_CODES,
    ProtocolError,
    is_valid_page_id,
)
from ..runtime import entry_connection, entry_device_id
from ..data import lizaip_data
from ..shared.logs import device_logger
from .const import is_subpage
from .default_pages import async_effective_pages
from .events import fire_device_synced
from .page_payload import build_page_payload, build_sync_context, compute_page_hash
from .panel_entry import get_panel_entry

_LOGGER = logging.getLogger(__name__)

#: Deadline for one ``set_page``. The transport's 10 s default is sized for
#: small commands; a page carries up to a dozen image URLs the device fetches
#: before it answers, which is legitimately slower than a `goto_page`.
PAGE_WRITE_TIMEOUT = 30.0

#: Attempts per page operation. A device that stalls under a burst usually
#: answers the second try, which turns a dropped page into a slow one.
PAGE_WRITE_ATTEMPTS = 2

#: Pause before retrying a page operation.
PAGE_RETRY_DELAY = 0.5

#: Page operations in a row that may fail before the rest of that phase of the
#: sync is skipped. A remote that refused three pages running is refusing the
#: next one too; asking anyway turned one bad state into a quarter of an hour
#: of timeouts per sync. The skipped pages are retried by the next sync.
GIVE_UP_AFTER_FAILURES = 3

#: Breather between consecutive page writes, so a 20-page sync reaches the
#: device as a stream rather than one burst.
PAGE_WRITE_PACING = 0.05


async def _send_page_op(
    factory,
    op: str,
    page_id: int | None,
    index: int | None = None,
    total: int | None = None,
    error_sink: list[Exception] | None = None,
    log: Any = None,
) -> bool:
    """Run one page command, with retries, and say whether it landed.

    Each operation is isolated. Previously the whole remove/add/write/order
    sequence sat in a single ``try``, so the first page the device failed to
    acknowledge aborted every page after it *and* the closing
    ``set_main_pages`` — and the log said only ``Page sync failed: …``, naming
    neither the page nor the command. *factory* is a callable rather than a
    coroutine because a coroutine cannot be awaited twice, and a retry needs a
    fresh one. *error_sink* collects the exception a giving-up operation died
    of, so a caller can report what the device actually said rather than a
    generic "it failed". *log* names the remote the pages are going to; it is
    passed in because this helper is given a bound factory, not a connection.
    """
    log = log or _LOGGER
    where = f"page {page_id}" if page_id is not None else "main page order"
    progress = f" ({index}/{total})" if index is not None and total else ""

    for attempt in range(1, PAGE_WRITE_ATTEMPTS + 1):
        try:
            await factory()
        except Exception as err:  # noqa: BLE001 — one page must not stop the rest
            # A retry is for a remote that stalled. One that answered with an
            # error has decided, and says the same again.
            last = attempt == PAGE_WRITE_ATTEMPTS or _is_refusal(err)
            log.log(
                logging.ERROR if last else logging.WARNING,
                "%s failed for %s%s (attempt %d/%d): %s",
                op, where, progress, attempt, PAGE_WRITE_ATTEMPTS, err,
            )
            if last:
                if error_sink is not None:
                    error_sink.append(err)
                return False
            await asyncio.sleep(PAGE_RETRY_DELAY)
        else:
            log.debug("%s ok for %s%s", op, where, progress)
            return True
    return False


def _is_refusal(err: Exception) -> bool:
    """True when the remote answered *err* itself, rather than going quiet."""
    if not isinstance(err, ProtocolError):
        return False
    message = err.message or ""
    return not (
        message.startswith("Timeout waiting for response")
        or message in _DISCONNECT_MESSAGES
    )


class _GiveUp:
    """Counts page operations failing in a row, and says when to stop asking."""

    def __init__(self, entry: ConfigEntry, phase: str) -> None:
        self._log = device_logger(_LOGGER, entry)
        self._phase = phase
        self._in_a_row = 0
        self.skipped: list[int] = []

    @property
    def tripped(self) -> bool:
        return self._in_a_row >= GIVE_UP_AFTER_FAILURES

    def note(self, ok: bool) -> None:
        self._in_a_row = 0 if ok else self._in_a_row + 1

    def skip(self, page_id: int) -> None:
        self.skipped.append(page_id)

    def report(self) -> None:
        if self.skipped:
            self._log.error(
                "Failed %d %s in a row; skipped the remaining %d (pages %s) "
                "for this sync instead of waiting on each",
                GIVE_UP_AFTER_FAILURES, self._phase,
                len(self.skipped), ", ".join(str(p) for p in self.skipped),
            )


async def _add_page_if_missing(conn, page_id: int) -> None:
    """Create *page_id*, tolerating a page the device already holds.

    An interrupted sync can leave a page added but unrecorded, and the device
    answers the second ``add_page`` with ``409``: the page is there, carry on.
    Any other spec code is a real refusal. Older firmware answers both cases
    with the same non-spec ``-4 "data"."page_id"``; only for that is the device
    asked whether the page is there. Raising lets ``_send_page_op`` log and
    count it.
    """
    try:
        await conn.add_page(page_id)
    except Exception as err:
        code = getattr(err, "code", None)
        if code != ERR_CONFLICT:
            if code in SPEC_ERROR_CODES:
                raise
            try:
                existing = {p["page_id"] for p in await conn.get_pages()}
            except Exception:
                raise err from None
            if page_id not in existing:
                raise
        device_logger(_LOGGER, conn).debug(
            "Page %s already on device, keeping it: %s", page_id, err,
        )


def _page_delta(previous: dict | None, desired: dict) -> dict:
    """The smallest ``set_page`` payload taking the device from *previous* to *desired*.

    ``set_page`` merges rather than replaces: omitted fields keep their current
    value, and the ``buttons`` array is merged per button, matched by ``name``
    (PROTOCOL.md §set_page). So a page whose tooltip changed need only carry
    that one button instead of all of them.

    *previous* is what we last successfully sent for this page. Without it — a
    fresh connection, or a page whose write failed and dropped the cache —
    there is nothing to merge against and the whole page goes out.

    ``hash`` always travels, whole-page and partial alike: it describes the
    page the device ends up with, and ``get_pages`` compares it on reconnect.
    """
    if not previous:
        return desired

    prev_buttons = {b["name"]: b for b in previous.get("buttons", [])}
    changed = [
        b for b in desired.get("buttons", [])
        if prev_buttons.get(b["name"]) != b
    ]

    # Nothing is saved by a partial naming every button anyway, and the full
    # payload is the better thing to send when the whole page moved.
    if len(changed) == len(desired.get("buttons", [])):
        return desired

    delta: dict = {"page_id": desired["page_id"], "hash": desired["hash"]}
    if previous.get("img_title") != desired.get("img_title"):
        delta["img_title"] = desired["img_title"]
    if changed:
        delta["buttons"] = changed
    return delta


def is_ready(conn) -> bool:
    """Whether *conn* can take page requests: connected, hello answered.

    A remote mid-handshake rejects `set_page` with -4, or -- short on memory --
    leaves it unanswered until the socket drops. The hello event starts a full
    sync anyway, so anything skipped here goes out then.
    """
    if conn is None or not conn.connected:
        return False
    ready = getattr(conn, "ready", True)
    return ready if isinstance(ready, bool) else True


async def sync_config_to_device(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Sync the panel's page configuration to the device, one sync at a time.

    Three sources push a sync: a panel save, the device's hello on reconnect,
    and a dynamic-source refresh. None of them coordinated, and the sync body
    awaits a device round trip per page, so two of them could interleave their
    ``add_page``/``set_page``/``set_main_pages`` commands at every await and
    leave ``page_cache.pages`` describing a device state that never existed.

    This is the single-flight guard the live icon path already has in
    :class:`~.icon_push.IconPushQueue`: one sync runs, a sync requested while
    that one is in flight sets a flag instead of starting, and the runner loops
    once more when it sees it. A burst of N edits collapses to at most two
    syncs, and the second one sees the final state — so nothing is lost by not
    running the ones in between.
    """
    state = _sync_state(hass, entry)
    if state["running"]:
        state["dirty"] = True
        device_logger(_LOGGER, entry).debug("Sync already running, coalescing")
        return True

    async with state["lock"]:
        state["running"] = True
        try:
            result = await _sync_locked(hass, entry)
            # One repeat only. The flag is cleared before the rerun so an edit
            # arriving *during* the rerun sets it again and is picked up by the
            # next caller, rather than spinning here.
            while state["dirty"]:
                state["dirty"] = False
                result = await _sync_locked(hass, entry)
            return result
        finally:
            state["running"] = False


def _sync_state(hass: HomeAssistant, entry: ConfigEntry) -> dict:
    """Per-entry sync lock and pending flag, created on first use."""
    return lizaip_data(hass).sync_state.setdefault(
        entry.entry_id, {"lock": asyncio.Lock(), "running": False, "dirty": False}
    )


#: Extra seconds of patience per page when asking the device what it holds.
#: The listing is one answer carrying every page, so the time to assemble and
#: send it grows with their number; the flat default was enough for a handful
#: and timed out at a hundred. Measured against the fallout, not the hardware:
#: waiting is cheap, while a timeout costs a whole sync.
_LISTING_TIMEOUT_PER_PAGE = 0.5

#: Ceiling for the same. A device that has not answered in this long is not
#: slow, it is gone, and the sync should fail rather than hold the connection.
_LISTING_TIMEOUT_MAX = 60.0


def _listing_timeout(page_count: int) -> float:
    """How long to wait for `get_pages` with *page_count* pages configured.

    The count comes from the store rather than the device -- the device's
    answer is what is being waited for -- but the two track each other closely
    enough, and over-estimating is the harmless direction.
    """
    return min(
        _LISTING_TIMEOUT_MAX,
        DEFAULT_REQUEST_TIMEOUT + _LISTING_TIMEOUT_PER_PAGE * max(0, page_count),
    )


async def _sync_locked(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """One pass of the page sync. Call through :func:`sync_config_to_device`.

    Two locks, because they exclude different things. The per-entry lock above
    makes the passes themselves single-file and lets a burst coalesce; this one
    is held on the connection, so the out-of-band pushes that do not go through
    a full sync at all -- the order push in ``ws_set_pages`` and the
    ``clear_all`` service -- cannot interleave with a sync either. They are
    always taken in this order, and nothing takes them the other way round.

    Returns True if sync was performed, False if device not available.
    """
    conn = entry_connection(entry)
    if not is_ready(conn):
        device_logger(_LOGGER, entry).debug("Device not connected, skipping sync")
        return False
    async with conn.page_cache.lock:
        return await _sync_config_to_device(hass, entry, conn)


async def _sync_config_to_device(
    hass: HomeAssistant, entry: ConfigEntry, conn: Any,
) -> bool:
    """Sync pages to *conn*, which `sync_config_to_device` holds the lock for.

    Uses the protocol commands: get_pages, clear_all/add_page/set_page/set_main_pages.
    """
    log = device_logger(_LOGGER, entry)
    device_id = entry_device_id(entry)
    if not device_id:
        log.debug("No device_id for this entry")
        return False
    effective = await async_effective_pages(hass, entry)
    pages = effective.pages
    if effective.placeholder:
        log.debug("The remote has no pages of its own; sending the placeholders")

    # Use cached device state if available; otherwise query the device (first sync after connect)
    if conn.page_cache.pages is None:
        listing_timeout = _listing_timeout(len(pages))
        try:
            device_pages = await conn.get_pages(timeout=listing_timeout)
        except Exception as err:
            # Not "the device is empty". That assumption is what made a slow
            # listing catastrophic: every page read as missing, so the sync
            # rewrote all of them -- the most expensive thing it can do, aimed
            # at a device that had just shown it was struggling to answer.
            # Without the hashes there is nothing to sync against, so the pass
            # is abandoned and the cache left unset, which makes the next sync
            # read them again.
            log.error(
                "Failed to get_pages from device: %s — skipping this sync rather "
                "than rewriting all %d page(s) blind", err, len(pages),
            )
            _note_sync_failure(entry, conn, err)
            return False
        device_hash_map: dict[int, int] = {p["page_id"]: p.get("hash", 0) for p in device_pages}

        try:
            device_main_pages = await conn.get_main_pages(timeout=listing_timeout)
        except Exception as err:
            # Survivable where the page listing is not: an unknown order means
            # the order gets pushed again, not that every page does.
            log.debug("Failed to get_main_pages from device: %s", err)
            device_main_pages = []
    else:
        device_hash_map = {pid: p.get("hash") for pid, p in conn.page_cache.pages.items()}
        device_main_pages = conn.page_cache.main_pages or []

    # Build desired state
    build_started = time.monotonic()
    desired_pages = []
    main_page_ids = []
    # Built once: every input here is the same for all pages, and
    # `build_page_context` walks the whole list, so building it per page made
    # this loop O(N²).
    page_ctx = await build_sync_context(
        hass, entry, pages,
        assignments=effective.assignments,
    )
    for page_config in pages:
        # page_id is a 32-bit unsigned integer, 1…4294967295 (PROTOCOL.md §3).
        # Skip anything invalid (e.g. a hand-edited YAML file) rather than letting
        # one bad page abort the whole sync with a protocol error.
        page_id = page_config.get("id", 1)
        if not is_valid_page_id(page_id):
            log.warning(
                "Skipping stored page with invalid page_id %r — must be an integer "
                "in 1…4294967295 (0 is reserved)",
                page_id,
            )
            continue
        page_data = await build_page_payload(
            hass, entry, page_id, page_config, pages, ctx=page_ctx,
        )
        desired_pages.append(page_data)
        # A subpage still gets written to the device — only the main-page list
        # leaves it out, so `goto_page` can still reach it.
        if not is_subpage(page_config):
            main_page_ids.append(page_id)

    # Every page is rebuilt because a page's hash is only known once its
    # payload is resolved. Logged because it is the one part of a sync that
    # grows with the number of pages.
    log.debug(
        "Built %d page payloads in %.0f ms",
        len(desired_pages), (time.monotonic() - build_started) * 1000,
    )

    desired_hash_map = {p["page_id"]: p["hash"] for p in desired_pages}
    desired_page_ids = set(desired_hash_map.keys())
    device_page_ids = set(device_hash_map.keys())

    # Determine diff
    pages_to_add = desired_page_ids - device_page_ids
    pages_to_remove = device_page_ids - desired_page_ids
    pages_to_update = {
        pid for pid in desired_page_ids & device_page_ids
        if desired_hash_map[pid] != device_hash_map.get(pid)
    }
    order_changed = device_main_pages != main_page_ids
    # A page whose write went unanswered may be on the device although it is
    # not in the cache; once it leaves the config it is removed all the same.
    unsure = conn.page_cache.unsure
    unsure.difference_update(device_page_ids)
    stray_pages = sorted(unsure - desired_page_ids)

    if (
        not pages_to_add and not pages_to_remove and not pages_to_update
        and not order_changed and not stray_pages
    ):
        # Populate the cache so subsequent syncs skip the device query. Nothing
        # differed, so what was just built is what the device holds.
        conn.page_cache.pages = {p["page_id"]: p for p in desired_pages}
        conn.page_cache.main_pages = list(main_page_ids)
        _note_sync_success(hass, entry, conn)
        log.debug("Device pages up to date, no sync needed")
        return True

    log.info(
        "Syncing pages: add=%s, remove=%s, update=%s, order_changed=%s",
        pages_to_add, pages_to_remove | set(stray_pages), pages_to_update, order_changed,
    )

    # Sets have no order, and the device applies these in the order they
    # arrive, so walk the stored page order instead: a reproducible sequence is
    # what makes a failure at "page 21" mean the same thing twice running.
    ordered_ids = [p["page_id"] for p in desired_pages]
    add_order = [pid for pid in ordered_ids if pid in pages_to_add]
    remove_order = sorted(pages_to_remove)
    writes = [p for p in desired_pages
              if p["page_id"] in pages_to_add or p["page_id"] in pages_to_update]

    # Progress is recorded per page rather than in one block at the end. A sync
    # that dies halfway used to leave the cache untouched, so the retry rebuilt
    # the identical diff, resent the identical pages in the identical order and
    # stopped at the identical page — the failure never healed. Keeping what
    # landed means a retry only carries what did not.
    if conn.page_cache.pages is None:
        # Seeded from what the device just reported, which is a hash and no
        # payload. A page with no recorded payload is sent whole rather than
        # as a delta -- right, because its content is the device's, not ours.
        conn.page_cache.pages = {
            pid: {"page_id": pid, "hash": h}
            for pid, h in device_hash_map.items()
        }
    known_pages = conn.page_cache.pages

    # Pages the diff did not pick up match the device by hash, so what was just
    # built *is* what the device holds. Recording the payload keeps
    # `_live_button_changes` able to push a single icon instead of falling back
    # to a full page write, and replaces the stub seeded above.
    known_pages.update({
        p["page_id"]: p for p in desired_pages
        if p["page_id"] not in pages_to_add and p["page_id"] not in pages_to_update
    })

    failed: list[int] = []

    # Page IDs the device refused outright earlier in this session. Retrying
    # them costs four round-trips each on every config change and can never
    # succeed, so they are skipped until the next reconnect.
    rejected = conn.page_cache.rejected
    rejected_before = set(rejected)

    # Nothing the device holds survives this sync: a remote just added, whose
    # pages belong to whoever had it before, or a configuration emptied in the
    # panel. `clear_all` says that in one command instead of one per page, and
    # takes the pages that were written without being confirmed with it --
    # there is nothing left for them to collide with. Falls through to the
    # per-page deletes if the device will not take it, since the outcome, not
    # the command, is what matters.
    wipe_all = bool(device_page_ids) and not (desired_page_ids & device_page_ids)
    if wipe_all:
        try:
            await conn.clear_all()
        except Exception as err:  # noqa: BLE001 -- the per-page path still has to run
            log.warning("clear_all was refused (%s); deleting page by page", err)
            wipe_all = False
        else:
            log.info("Removed all %d page(s) the device held", len(device_page_ids))
            known_pages.clear()
            # `clear_all` forgets the page table, and the dict this sync is
            # recording into is that table: hand it back, emptied, so the
            # writes below are remembered instead of going to an orphan.
            conn.page_cache.pages = known_pages
            unsure.clear()
            # Nothing is on the device to refuse any more.
            rejected.clear()
            # The order went with the pages; what the listing said it was no
            # longer describes anything.
            device_main_pages = []
            # Both lists are what the wipe just did, in one command.
            remove_order = []
            stray_pages = []

    for pid in remove_order:
        if await _send_page_op(partial(conn.del_page, pid), "del_page", pid, log=log):
            known_pages.pop(pid, None)
        else:
            failed.append(pid)

    # One try each: the device may never have stored the page, and then it
    # refuses the delete -- which is the outcome wanted anyway.
    for pid in stray_pages:
        unsure.discard(pid)
        try:
            await conn.del_page(pid)
        except Exception as err:  # noqa: BLE001 -- most likely never stored
            log.debug("del_page for page %s, which may never have landed: %s", pid, err)
        else:
            log.info("Removed page %s, which the device held without having confirmed it", pid)

    # A failed `add_page` does not take its `set_page` down with it. Older
    # firmware answers `[-4] "data"."page_id"` both for an ID it will not
    # accept and for one it already holds, so a device that under-reports its
    # pages would leave HA re-adding a page that exists and never writing it.
    # Attempting the write anyway costs one round-trip on a path that was
    # already failing, and tells "cannot store this page" from "already had it".
    add_failed = set()
    adds = _GiveUp(entry, "page adds")
    for pid in add_order:
        if pid in rejected:
            continue
        if adds.tripped:
            adds.skip(pid)
            continue
        ok = await _send_page_op(
            partial(_add_page_if_missing, conn, pid), "add_page", pid, log=log,
        )
        adds.note(ok)
        if not ok:
            add_failed.add(pid)
            unsure.add(pid)
    adds.report()
    # Never asked to create, so not written either -- and not marked as refused,
    # since the remote was never asked about them.
    add_skipped = set(adds.skipped)
    failed.extend(adds.skipped)

    total = len(writes)
    sets = _GiveUp(entry, "page writes")
    for n, page_data in enumerate(writes, 1):
        pid = page_data["page_id"]
        if pid in rejected or pid in add_skipped:
            continue
        if sets.tripped:
            sets.skip(pid)
            known_pages.pop(pid, None)
            failed.append(pid)
            continue
        # A page the device has just been told to create holds nothing yet, and
        # one whose `add_page` was refused is of unknown content — both need
        # the whole payload. Only a page we last wrote ourselves can be sent as
        # a delta, because only then is there a known state to merge against.
        payload = (
            page_data if pid in pages_to_add
            else _page_delta(known_pages.get(pid), page_data)
        )
        ok = await _send_page_op(
            partial(conn.set_page, timeout=PAGE_WRITE_TIMEOUT, **payload),
            "set_page", pid, n, total, log=log,
        )
        sets.note(ok)
        if ok:
            if pid in add_failed:
                log.info(
                    "Page %d was written despite add_page being refused — the "
                    "device already held it but did not report it in get_pages",
                    pid,
                )
            known_pages[pid] = page_data
            unsure.discard(pid)
        else:
            # Forgetting the page keeps the next sync honest: it is in an
            # unknown state, so it has to be rewritten rather than skipped as
            # unchanged. It may still be on the device, so it is remembered as
            # one to delete should it leave the config.
            known_pages.pop(pid, None)
            unsure.add(pid)
            failed.append(pid)
            if pid in add_failed:
                # Refused both ways: the device will not store this page at
                # all. Nothing HA sends changes that, so stop asking.
                rejected.add(pid)
        if n < total:
            # 20-odd back-to-back page writes each kick off a batch of image
            # fetches on the device. A breather between them spreads that burst
            # out instead of handing the device the whole thing at once.
            await asyncio.sleep(PAGE_WRITE_PACING)
    sets.report()

    # Listing only the pages that actually made it, and sent whenever that list
    # or the order moved. Previously a single timed-out page raised straight
    # past this call, so navigation kept the order from before the edit — which
    # is what "the page is there but it never synced" looked like from the
    # sofa. Sending it on *every* sync is the opposite mistake: it made the
    # device rewrite its page setup for nothing after a plain button edit.
    deliverable = [pid for pid in main_page_ids if pid in known_pages]
    order_error: Exception | None = None
    order_errors: list[Exception] = []
    if order_changed or deliverable != device_main_pages:
        if await _send_page_op(
            partial(conn.set_main_pages, deliverable), "set_main_pages", None,
            error_sink=order_errors, log=log,
        ):
            conn.page_cache.main_pages = list(deliverable)
        else:
            conn.page_cache.main_pages = None
            # The pages may all be stored and still be in the wrong order, and
            # order is the whole of what navigation shows. Reporting success
            # here would reset the failure counter and leave nothing to retry.
            order_error = (
                order_errors[0] if order_errors
                else RuntimeError("set_main_pages failed")
            )
    else:
        # Already the order the device reported this pass, so there is nothing
        # to write -- but the cache may not have known that yet.
        conn.page_cache.main_pages = list(deliverable)

    newly_rejected = rejected - rejected_before
    if newly_rejected:
        log.error(
            "The remote refused to store page(s) %s and holds %d page(s); it "
            "reports no page limit, so this may be the one it has. They are "
            "skipped until the remote reconnects. Remove them in the lizaIP "
            "panel or update the firmware.",
            ", ".join(str(p) for p in sorted(newly_rejected)), len(known_pages),
        )

    if failed:
        names = ", ".join(str(p) for p in sorted(set(failed)))
        log.error(
            "Page sync incomplete: %d of %d page writes failed (pages %s). "
            "The pages that did sync are live; the rest are retried on the "
            "next config change or reconnect.",
            len(failed), len(remove_order) + len(add_order) + total, names,
        )
        # Counted like a wholesale failure even though most pages landed: a
        # remote that drops the same page every time is the fault nobody goes
        # looking for, and the per-page log line is the only other trace.
        _note_sync_failure(
            entry, conn,
            RuntimeError(f"{len(failed)} page write(s) failed (pages {names})"),
        )
        return False

    if order_error is not None:
        _note_sync_failure(entry, conn, order_error)
        return False

    _note_sync_success(hass, entry, conn)
    log.info("Page sync complete (%d page(s) written)", total)
    return True


#: Consecutive failed syncs before the user is told. One failure is ordinary --
#: a remote that slept, a socket that closed mid-write -- and the next sync
#: usually puts it right, so reporting it would be noise. Three in a row is a
#: device that is not coming back on its own.
MAX_SYNC_FAILURES = 3


#: What the protocol raises when there is no socket to talk over -- before a
#: request ("Not connected") or because it closed under one ("Connection lost").
_DISCONNECT_MESSAGES = frozenset({"Not connected", "Connection lost"})


def _is_disconnect(conn: Any, err: Exception) -> bool:
    """True when *err* says the remote is gone rather than that it failed."""
    if not getattr(conn, "connected", True):
        return True
    return isinstance(err, ProtocolError) and err.message in _DISCONNECT_MESSAGES


def _note_sync_failure(entry: ConfigEntry, conn: Any, err: Exception) -> None:
    """Count a failed sync and, once they stack up, log it as an error.

    Not raised in Repairs: a remote refusing pages is a firmware problem the
    user can do nothing about, and a notice there only confused. The ERROR
    line, written once when the run of failures reaches the threshold, is
    what support reads.
    """
    if _is_disconnect(conn, err):
        # The remote is away, not refusing pages. The next hello syncs
        # everything anyway, so a remote that was simply asleep or switched
        # off is not counted.
        device_logger(_LOGGER, entry).debug(
            "Sync failure not counted, the remote is not connected: %s", err,
        )
        return
    count = conn.page_cache.failures + 1
    conn.page_cache.failures = count
    if count == MAX_SYNC_FAILURES:
        device_logger(_LOGGER, entry).error(
            "Pages could not be sent: %d syncs in a row failed (last error: "
            "%s). The remote may show outdated pages until a sync succeeds.",
            count, err,
        )


def _note_sync_success(hass: HomeAssistant, entry: ConfigEntry, conn: Any) -> None:
    """Clear the failure count, and tell the panel the device has the change."""
    if conn.page_cache.failures >= MAX_SYNC_FAILURES:
        device_logger(_LOGGER, entry).info("Pages are in sync again")
    conn.page_cache.failures = 0
    # What the panel's memory bars wait for: a transfer is what moves them.
    fire_device_synced(hass, entry.entry_id)


#: The parts of a button an entity variable can move. Anything else differing
#: means the page changed some other way, which is the full sync's job.
_LIVE_BUTTON_FIELDS = ("img_tile", "img_tooltip")


def _live_button_changes(sent: dict, built: dict) -> list[dict] | None:
    """The tile and tooltip changes from *sent* to *built*, or None if more moved.

    The page title is not compared: a variable can move it, and it is pushed
    on its own (see `async_push_variable_pages`).
    """
    before = {b.get("name"): b for b in sent.get("buttons", ())}
    if set(before) != {b.get("name") for b in built.get("buttons", ())}:
        return None
    changes = []
    for button in built.get("buttons", ()):
        old = before[button.get("name")]
        if any(
            button.get(k) != old.get(k)
            for k in set(button) | set(old) if k not in _LIVE_BUTTON_FIELDS
        ):
            return None
        moved = {k: button.get(k, "") for k in _LIVE_BUTTON_FIELDS if button.get(k) != old.get(k)}
        if moved:
            changes.append({"name": button.get("name"), **moved})
    return changes


def patched_page(
    conn, page_id: int, buttons: list[dict], img_title: str | None = None,
) -> dict | None:
    """The known copy of *page_id* with a partial ``set_page`` applied, new hash included.

    The hash is sent with the partial write, so the device's own copy is
    stamped with what it now shows: a variable that moved changes the page's
    hash exactly as a full rebuild would, and the next comparison sees the
    truth. None when the cache does not hold the page (or those buttons).
    """
    cache = getattr(conn, "page_cache", None)
    known = cache.pages if cache is not None else None
    copy = None if known is None else known.get(page_id)
    if copy is None:
        return None
    moved = {
        b.get("name"): {k: b[k] for k in _LIVE_BUTTON_FIELDS if k in b} for b in buttons
    }
    if not moved.keys() <= {b.get("name") for b in copy.get("buttons", ())}:
        return None
    patched = {k: v for k, v in copy.items() if k != "hash"}
    if img_title is not None:
        patched["img_title"] = img_title
    patched["buttons"] = [{**b, **moved.get(b.get("name"), {})} for b in copy["buttons"]]
    patched["hash"] = compute_page_hash(patched)
    return patched


def note_partial_page(
    conn, page_id: int, buttons: list[dict], img_title: str | None = None,
) -> None:
    """Record a partial ``set_page`` the device acknowledged in its known copy.

    Without this, the copy keeps the tile the last full sync drew while the
    device shows the one a live update pushed since -- so the next variable
    push resends it, and the next full sync resends the whole page. A page the
    cache does not hold is left for the full sync to settle.
    """
    patched = patched_page(conn, page_id, buttons, img_title)
    if patched is not None:
        conn.page_cache.pages[page_id] = patched


async def async_send_partial_page(
    conn, page_id: int, buttons: list[dict], img_title: str | None = None,
) -> None:
    """Send one partial ``set_page`` and record it once the device acknowledged it.

    A send that does not reach the device drops the page from the known copy,
    so the next full sync resends it instead of trusting a page it never got.
    """
    if not is_ready(conn):
        forget_page(conn, page_id)
        return
    fields: dict = {"buttons": buttons} if buttons else {}
    if img_title is not None:
        fields["img_title"] = img_title
    # The page's new hash goes with the change, so the device's copy says
    # what it now shows (see `patched_page`).
    patched = patched_page(conn, page_id, buttons, img_title)
    if patched is not None:
        fields["hash"] = patched["hash"]
    try:
        await conn.set_page(page_id, **fields)
    except Exception:
        forget_page(conn, page_id)
        raise
    note_partial_page(conn, page_id, buttons, img_title)


def forget_page(conn, page_id: int) -> None:
    """Drop one page from the device's known copy so the next sync resends it."""
    pages = getattr(getattr(conn, "page_cache", None), "pages", None)
    if pages:
        pages.pop(page_id, None)


async def async_push_variable_pages(
    hass: HomeAssistant, entry: ConfigEntry, page_ids: set[int],
) -> None:
    """Bring the pages whose variables moved up to date, sending only what changed.

    Each page is rebuilt and compared, button by button, with what the device
    was last given; only the tiles and tooltips that came out different go out,
    through the same queue as live light icons, and a title that moved goes with
    them. A page the device's copy of is not known, or that changed more than a
    variable can, falls back to the full sync.
    """
    log = device_logger(_LOGGER, entry)
    conn = entry_connection(entry)
    if not is_ready(conn):
        return
    device_id = entry_device_id(entry)
    panel_entry = get_panel_entry(hass, entry.entry_id)
    queue = panel_entry.icon_push_queue if panel_entry is not None else None
    known = conn.page_cache.pages
    if not device_id or queue is None or not known:
        await sync_config_to_device(hass, entry)
        return

    effective = await async_effective_pages(hass, entry)
    pages = effective.pages
    by_id = {p.get("id", 1): p for p in pages if isinstance(p, dict)}
    ctx = await build_sync_context(
        hass, entry, pages,
        assignments=effective.assignments,
    )
    pushed = False
    for page_id in sorted(page_ids):
        page_config = by_id.get(page_id)
        if page_config is None:
            continue
        # A reconnect drops the whole cache, so a copy that is there is a copy
        # the device is known to hold.
        sent = known.get(page_id)
        if sent is None:
            await sync_config_to_device(hass, entry)
            return
        built = await build_page_payload(hass, entry, page_id, page_config, pages, ctx=ctx)
        changes = _live_button_changes(sent, built)
        if changes is None:
            await sync_config_to_device(hass, entry)
            return
        # Not recorded here: `async_send_partial_page` records the page once
        # the device acknowledged it, and forgets it if the send fails.
        title = built.get("img_title")
        title = title if title != sent.get("img_title") else None
        if changes or title is not None:
            log.debug(
                "Variables moved on page %s: %s%s", page_id,
                [c["name"] for c in changes], " and its title" if title is not None else "",
            )
            queue.submit(page_id, changes, img_title=title)
            pushed = True
    if pushed:
        queue.schedule(
            lambda coro: entry.async_create_background_task(hass, coro, "lizaip_variable_push"),
        )
