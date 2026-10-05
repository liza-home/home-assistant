"""Serialised, coalescing delivery of icon updates to one device.

The device acknowledges a ``set_page``; it does not pipeline well. Measured on
real hardware over a dimmer ramp, a single request is answered in 51-111 ms,
but the integration used to start a fresh request on a timer regardless of
whether the previous one had come back. 22.5% of the time two or more were
outstanding, peaking at four deep, and the queue showed up directly in the
round-trip: p90 408 ms, p99 993 ms, worst case 1567 ms. Those are not the
device being slow, they are requests waiting behind other requests.

Pushing on a timer is open-loop: it assumes a service rate instead of
observing one. This module closes the loop. One request is in flight per
device at a time, and everything that arrives meanwhile is merged into a
pending set rather than queued behind it, so the next request carries the
*newest* state instead of replaying a backlog of positions the lamp has
already left. The device's own acknowledgement becomes the clock, which means
the push rate tracks whatever the hardware can actually absorb -- faster than
a fixed timer when it is idle, and automatically slower when it is not,
instead of making a bad moment worse.

Dropping superseded frames is the point, not a concession. A brightness ramp's
intermediate values are stale the moment a newer one exists, and the final
value is never dropped: entries are removed from the pending set immediately
before being sent, so anything submitted during a flight is still waiting
afterwards.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable

_LOGGER = logging.getLogger(__name__)

#: One page's worth of buttons: button name -> the fields to send for it.
_PageButtons = dict[str, dict]


class IconPushQueue:
    """Pushes button icons to one device, one request at a time.

    *send* is awaited as ``send(page_id, buttons)``. *current_page* is
    consulted for the page the user is actually looking at, and may return
    ``None`` when that is not known -- after a restart or reconnect, before the
    device has reported where it is.
    """

    def __init__(
        self,
        send: Callable[[int, list[dict]], Awaitable[object]],
        current_page: Callable[[], int | None] | None = None,
    ) -> None:
        self._send = send
        self._current_page = current_page
        self._pending: dict[int, _PageButtons] = {}
        self._task: asyncio.Task | None = None
        # Whether a drain is running, tracked separately from the task handle.
        # Home Assistant starts background tasks eagerly, so `create_task` runs
        # the drain synchronously up to its first suspension -- a drain with
        # nothing to send can therefore finish *before* the handle is returned,
        # and assigning that spent handle afterwards would make every later
        # `schedule` see "already draining" and wedge the pump for good.
        self._draining = False
        self._closed = False

    @property
    def pending_pages(self) -> int:
        """How many pages are waiting. Diagnostics and tests only."""
        return len(self._pending)

    def submit(self, page_id: int, buttons: Iterable[dict]) -> None:
        """Merge *buttons* into the pending set for *page_id*.

        Merged per button rather than replaced wholesale. A newer update for a
        button usually carries only ``img_tile`` -- the state listener omits a
        tooltip that has not changed, to save the device a second image fetch --
        so replacing would discard a tooltip that was submitted but not yet
        sent, and the listener, which already recorded it as sent, would never
        offer it again.
        """
        if self._closed:
            return
        page = self._pending.setdefault(page_id, {})
        for btn in buttons:
            name = btn.get("name")
            if not name:
                continue
            previous = page.get(name)
            page[name] = {**previous, **btn} if previous else dict(btn)

    def schedule(self, create_task: Callable[[Awaitable], asyncio.Task]) -> None:
        """Start draining if nothing is draining already.

        Separate from `submit` so a batch is merged completely before any of it
        goes out, and so the caller supplies its own task factory -- Home
        Assistant wants its tasks tracked against the config entry.
        """
        if self._closed or self._draining or not self._pending:
            return
        self._draining = True
        try:
            task = create_task(self._drain())
        except Exception:
            self._draining = False
            raise
        # Only keep the handle if that drain is still running; see `_draining`.
        if self._draining:
            self._task = task

    def _next_page(self) -> int:
        """The page to send next: the one on screen, if it is waiting.

        The device displays a single page, but one lamp can own a button on
        several. Sending in arbitrary order means the tile the user is watching
        can sit behind a full round-trip spent updating a page nobody can see --
        and these are sequential, so with the measured p50 that is an extra
        ~111 ms of lag per page ahead of it, for no visible benefit.
        """
        if self._current_page is not None:
            try:
                visible = self._current_page()
            except Exception:  # noqa: BLE001 - a hint, never a hard dependency
                visible = None
            if visible in self._pending:
                return visible
        # Otherwise insertion order, which is the order the updates arrived in.
        return next(iter(self._pending))

    async def _drain(self) -> None:
        """Send pending pages until none are left, one round-trip at a time."""
        try:
            while self._pending and not self._closed:
                page_id = self._next_page()
                # Popped *before* the await, so anything that arrives during
                # the flight is recorded as still-pending and goes out in the
                # next pass rather than being lost.
                buttons = self._pending.pop(page_id)
                try:
                    await self._send(page_id, list(buttons.values()))
                except asyncio.CancelledError:
                    raise
                except Exception as err:  # noqa: BLE001
                    # One bad page must not stop the pump; the tile stays as it
                    # was until its entity next changes. Already popped, so a
                    # persistently failing page cannot spin the loop either.
                    _LOGGER.warning(
                        "set_page (partial) failed for page %s: %s", page_id, err,
                    )
        finally:
            # Nothing can have been submitted between the loop test and here:
            # the event loop is single-threaded and this stretch does not await,
            # so a submission either arrived earlier and was picked up by the
            # loop test, or arrives later and starts a fresh drain.
            self._draining = False
            self._task = None

    def close(self) -> None:
        """Drop pending work and stop draining. Safe to call twice."""
        self._closed = True
        self._pending.clear()
        self._draining = False
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
