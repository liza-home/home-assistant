"""What Home Assistant believes one remote holds, so a sync sends only changes."""
from __future__ import annotations

import asyncio


class PageCache:
    """The remote's pages as last confirmed, plus the lock that guards them.

    Owned by the connection, which resets it whenever the socket drops: after a
    disconnect nothing is known. The page sync (``config/device_sync.py``) and
    the pushes that bypass it read and update it.
    """

    def __init__(self) -> None:
        # Page syncs must not interleave: two of them racing send conflicting
        # `set_main_pages` orders and each diffs against a cache the other is
        # still writing. Also held by the pushes that bypass a full sync -- the
        # order push after `set_pages` and the `clear_all` service.
        self.lock = asyncio.Lock()
        # page_id → the `set_page` payload the device was last given, its hash
        # included. `None` means "unknown, ask the device".
        self.pages: dict[int, dict] | None = None
        # The main-page order the device holds, or `None` when unknown.
        self.main_pages: list[int] | None = None
        # Page ids the device refused to both create and write this session.
        # Firmware reports no page limit, so it can only be learned by hitting
        # it; remembering it saves four doomed round-trips per page and sync.
        self.rejected: set[int] = set()
        # Pages an `add_page` or `set_page` went out for without an answer that
        # settles whether the device holds them. They are not in `pages`, so a
        # page in here that leaves the config still gets a `del_page`.
        self.unsure: set[int] = set()
        # Consecutive failed syncs. Survives `reset` on purpose: a device that
        # drops the socket mid-sync every time is the case the error log is for.
        self.failures = 0

    def forget(self) -> None:
        """The device's pages are unknown: the next sync asks it again."""
        self.pages = None
        self.main_pages = None

    def reset(self) -> None:
        """A new session: forget the pages and retry anything refused before."""
        self.forget()
        self.rejected = set()
        self.unsure = set()
