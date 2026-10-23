"""What the config side keeps for one remote while its config entry is loaded."""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant

from ..const import DOMAIN

if TYPE_CHECKING:
    from .icon_push import IconPushQueue
    from .templates.refresh import PushTriggers

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


def add_panel_entry(hass: HomeAssistant, entry_id: str) -> PanelEntry:
    """Create the state for a remote whose config entry is being set up."""
    panel_entry = PanelEntry()
    hass.data.setdefault(DOMAIN, {})[entry_id] = panel_entry
    return panel_entry


def get_panel_entry(hass: HomeAssistant, entry_id: str) -> PanelEntry | None:
    """The loaded remote's state, or ``None`` if its entry is not set up."""
    found = hass.data.get(DOMAIN, {}).get(entry_id)
    return found if isinstance(found, PanelEntry) else None


def pop_panel_entry(hass: HomeAssistant, entry_id: str) -> PanelEntry | None:
    """Remove and return the remote's state, for the unload to close."""
    found = hass.data.get(DOMAIN, {}).pop(entry_id, None)
    return found if isinstance(found, PanelEntry) else None
