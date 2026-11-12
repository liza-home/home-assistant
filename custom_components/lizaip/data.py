"""Where the integration keeps its state: one typed home per scope.

``LizaIPRuntimeData`` is a loaded remote's -- the config entry's
``runtime_data`` -- and lives exactly as long as that entry is set up.
``LizaIPData`` is everything shared by all remotes, under
``hass.data[LIZAIP_DATA]``; it is created by the first use and outlives every
entry, as the store and the panel registration have to.

A leaf module, like ``runtime``: the types it names are imported for checking
only, so any package can import it.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.util.hass_dict import HassKey

from .const import DOMAIN

if TYPE_CHECKING:
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .config.media_queue.sensor import LizaIPQueueSensor
    from .config.panel_entry import PanelEntry
    from .config.store import LizaRemoteStore
    from .device.connection import LizaIPConnection
    from .imgserv.render_custom import CustomIcons


@dataclass
class LizaIPRuntimeData:
    """One loaded remote: its device connection and its config-panel state."""

    connection: LizaIPConnection
    #: Set by the config side's setup (``panel_entry.add_panel_entry``) and
    #: cleared by its unload.
    panel: PanelEntry | None = None


type LizaIPConfigEntry = ConfigEntry[LizaIPRuntimeData]


@dataclass
class LizaIPData:
    """The state every remote shares."""

    #: The shared configuration store, installed by integration setup.
    store: LizaRemoteStore | None = None
    #: The language the config panel last reported.
    ui_language: str | None = None
    #: Stops the one button-press listener (``action_controller.dispatch``).
    button_unsub: Callable[[], None] | None = None
    #: Whether the config panel's views and commands are registered.
    panel_registered: bool = False
    #: Per entry id: the device sync's lock and pending flags.
    sync_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Parsed-but-not-yet-applied restore uploads, by token.
    restore_uploads: dict[str, tuple[float, dict[str, Any]]] = field(default_factory=dict)
    #: Built-but-not-yet-downloaded support bundles, by token.
    bundles: dict[str, tuple[float, str, bytes, str]] = field(default_factory=dict)
    #: Per entry id: serialises dynamic-page refreshes.
    refresh_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    #: Parsed blueprints by blueprint id, least recently used first.
    blueprints: dict[str, dict] = field(default_factory=dict)
    #: The user's uploaded icons, once imgserv has loaded them.
    custom_icons: CustomIcons | None = None
    #: Per entry id: the sensor platform's ``AddEntitiesCallback``.
    queue_adders: dict[str, AddEntitiesCallback] = field(default_factory=dict)
    #: Live queue sensors by speaker entity id.
    queue_sensors: dict[str, LizaIPQueueSensor] = field(default_factory=dict)


LIZAIP_DATA: HassKey[LizaIPData] = HassKey(DOMAIN)


def lizaip_data(hass: HomeAssistant) -> LizaIPData:
    """The shared state, created on first use."""
    data = hass.data.get(LIZAIP_DATA)
    if data is None:
        data = hass.data[LIZAIP_DATA] = LizaIPData()
    return data


def find_lizaip_data(hass: HomeAssistant) -> LizaIPData | None:
    """The shared state, or ``None`` if nothing has created it yet."""
    return hass.data.get(LIZAIP_DATA)
