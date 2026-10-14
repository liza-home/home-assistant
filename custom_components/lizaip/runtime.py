"""Lookups into the integration's live runtime state.

A leaf module on purpose: both ``action_controller`` and ``config`` need these,
and defining them here is what keeps the dependency between those two packages
one-directional.
"""
from __future__ import annotations

import importlib.util
from typing import TYPE_CHECKING

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN

if TYPE_CHECKING:
    from .config.store import LizaRemoteStore
    from .device.connection import LizaIPConnection


def debug_available() -> bool:
    """Whether this build has the pre-release debug tools.

    They are stripped from a stable release by `scripts/public_repo.sh`, so a
    missing module is the expected state there rather than a broken install.
    Checked by import rather than by version so that a build we deploy
    ourselves -- which rsyncs the working tree, suffix or not -- always has the
    tools it shipped.
    """
    return importlib.util.find_spec(f"{__package__}.config.debug_websocket") is not None


#: Integration-wide keys in ``hass.data[DOMAIN]``, next to the config entry ids.
#: Only this module spells them out; everything else uses the functions below.
_STORE_KEY = "_store"
_PANEL_LANGUAGE_KEY = "_ui_language"


def install_store(hass: HomeAssistant, store: LizaRemoteStore) -> None:
    """Make *store* the shared store. Called once, by integration setup."""
    hass.data.setdefault(DOMAIN, {})[_STORE_KEY] = store


def _get_store(hass: HomeAssistant) -> LizaRemoteStore:
    """The shared store. Only call it once setup has installed one."""
    return hass.data[DOMAIN][_STORE_KEY]


def find_store(hass: HomeAssistant) -> LizaRemoteStore | None:
    """The shared store, or ``None`` before setup or after teardown."""
    return hass.data.get(DOMAIN, {}).get(_STORE_KEY)


def panel_language(hass: HomeAssistant) -> str | None:
    """The language the config panel last reported, if any."""
    return hass.data.get(DOMAIN, {}).get(_PANEL_LANGUAGE_KEY)


def remember_panel_language(hass: HomeAssistant, language: str) -> None:
    """Keep the panel's language as a fallback for device labels."""
    hass.data.setdefault(DOMAIN, {})[_PANEL_LANGUAGE_KEY] = language


def entry_connection(entry: ConfigEntry | None) -> LizaIPConnection | None:
    """The remote's connection for *entry*, or ``None`` before setup made one.

    It may be disconnected: callers that send check ``conn.connected`` (or
    ``device_sync.is_ready``) themselves.
    """
    return getattr(entry, "runtime_data", None) or None


def entry_device_id(entry: ConfigEntry | None) -> str | None:
    """The remote's device id for *entry*, or ``None`` while it is unknown.

    The ``getattr`` matters: a connection that has not finished setting up has
    no ``_device_id`` yet, and that must read as "no device" rather than raise.
    """
    return getattr(entry_connection(entry), "_device_id", None)


def _resolve_device_id(hass: HomeAssistant, entry_id: str) -> str | None:
    """Resolve entry_id to device_id."""
    return entry_device_id(hass.config_entries.async_get_entry(entry_id))
