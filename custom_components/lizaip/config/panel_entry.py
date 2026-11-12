"""What the config side keeps for one remote while its config entry is loaded."""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant

from ..runtime import entry_runtime

if TYPE_CHECKING:
    from ..data import LizaIPRuntimeData
    from .icon_push import IconPushQueue
    from ..config.page_templates.refresh import PushTriggers

_LOGGER = logging.getLogger(__name__)


class PanelEntry:
    """The listeners, icon push queue and push triggers of one remote.

    Everything here lives exactly as long as the config entry, and
    :meth:`close` releases all of it, so an unload cannot forget a listener.
    """

    def __init__(self) -> None:
        self.icon_push_queue: IconPushQueue | None = None
        self.push_triggers: PushTriggers | None = None
        self._state_listener_stop: Callable[[], None] | None = None
        self._stops: list[Callable[[], None]] = []

    def on_close(self, stop: Callable[[], None]) -> None:
        """Call *stop* (an unsubscribe or a cancel) when the entry unloads."""
        self._stops.append(stop)

    def replace_state_listener(self, stop: Callable[[], None]) -> None:
        """Use a rebuilt state listener, stopping the one it replaces.

        Kept apart from :meth:`on_close` because it is the one listener that is
        rebuilt while the entry stays loaded (after every config save).
        """
        old, self._state_listener_stop = self._state_listener_stop, stop
        if old is not None:
            old()

    def close(self) -> None:
        """Stop everything this remote's config side started."""
        # The queue first, so a drain cannot start a fresh round-trip against a
        # connection the unload is about to drop. This also discards the
        # pending set, which a reload would otherwise re-send as stale state.
        if self.icon_push_queue is not None:
            self.icon_push_queue.close()
        stops = [self._state_listener_stop, *self._stops]
        if self.push_triggers is not None:
            stops.append(self.push_triggers.close)
        for stop in stops:
            if stop is None:
                continue
            try:
                stop()
            except Exception as err:  # noqa: BLE001 - teardown must not raise
                _LOGGER.debug("Listener teardown failed: %s", err)
        self._state_listener_stop = None
        self._stops.clear()


def _runtime(hass: HomeAssistant, entry_id: str) -> LizaIPRuntimeData | None:
    entries = getattr(hass, "config_entries", None)
    entry = entries.async_get_entry(entry_id) if entries is not None else None
    return entry_runtime(entry)


def add_panel_entry(hass: HomeAssistant, entry_id: str) -> PanelEntry:
    """Create the state for a remote whose config entry is being set up.

    It is kept on the entry's ``runtime_data``, which the device setup has
    made by now. A setup that failed part-way left its state behind (Home
    Assistant does not unload an entry that never loaded), so the retry
    closes it first.
    """
    runtime = _runtime(hass, entry_id)
    if runtime is None:
        raise RuntimeError(f"Config entry {entry_id} has no runtime data to keep panel state on")
    panel_entry = PanelEntry()
    previous = runtime.panel
    if isinstance(previous, PanelEntry):
        previous.close()
    runtime.panel = panel_entry
    return panel_entry


def get_panel_entry(hass: HomeAssistant, entry_id: str) -> PanelEntry | None:
    """The loaded remote's state, or ``None`` if its entry is not set up."""
    runtime = _runtime(hass, entry_id)
    found = runtime.panel if runtime is not None else None
    return found if isinstance(found, PanelEntry) else None


def pop_panel_entry(hass: HomeAssistant, entry_id: str) -> PanelEntry | None:
    """Remove and return the remote's state, for the unload to close."""
    runtime = _runtime(hass, entry_id)
    if runtime is None:
        return None
    found, runtime.panel = runtime.panel, None
    return found if isinstance(found, PanelEntry) else None
