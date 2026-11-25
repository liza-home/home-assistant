"""Lookups into the integration's live runtime state.

A leaf module on purpose: both ``action_controller`` and ``config`` need these,
and defining them here is what keeps the dependency between those two packages
one-directional.

The state itself is typed in ``data``: these are its readers.
"""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN, IR_ENTRY_ID
from .data import LIZAIP_DATA, LizaIPIrData, LizaIPRuntimeData, find_lizaip_data, lizaip_data

if TYPE_CHECKING:
    from .config.panel_entry import PanelEntry
    from .config.store import LizaRemoteStore
    from .device.connection import LizaIPConnection


def renamed_device(
    hass: HomeAssistant, event: Event[Any],
) -> dr.DeviceEntry | dr.ChildDeviceEntry | None:
    """The device a device-registry event renamed, or ``None``.

    The registry fires on every device touch -- a new connection, a via
    device, a config entry added -- and only a change of name matters here.
    """
    data = event.data
    if data.get("action") != "update":
        return None
    if not {"name", "name_by_user"} & set(data.get("changes") or ()):
        return None
    return dr.async_get(hass).async_get(data.get("device_id") or "")


def install_store(hass: HomeAssistant, store: LizaRemoteStore) -> None:
    """Make *store* the shared store. Called once, by integration setup."""
    lizaip_data(hass).store = store


def get_store(hass: HomeAssistant) -> LizaRemoteStore:
    """The shared store. Only call it once setup has installed one."""
    store = hass.data[LIZAIP_DATA].store
    if store is None:
        raise KeyError("lizaIP store not installed")
    return store


def find_store(hass: HomeAssistant) -> LizaRemoteStore | None:
    """The shared store, or ``None`` before setup or after teardown."""
    data = find_lizaip_data(hass)
    return data.store if data is not None else None


def panel_language(hass: HomeAssistant) -> str | None:
    """The language the config panel last reported, if any."""
    data = find_lizaip_data(hass)
    return data.ui_language if data is not None else None


def remember_panel_language(hass: HomeAssistant, language: str) -> None:
    """Keep the panel's language as a fallback for device labels."""
    lizaip_data(hass).ui_language = language


def is_ir_entry(entry: ConfigEntry) -> bool:
    """Whether *entry* is the one holding the IR devices rather than a remote."""
    return entry.unique_id == IR_ENTRY_ID


def remote_entries(hass: HomeAssistant) -> list[ConfigEntry]:
    """Every lizaIP remote's entry, loaded or not."""
    return [e for e in hass.config_entries.async_entries(DOMAIN) if not is_ir_entry(e)]


def entry_runtime(entry: ConfigEntry | None) -> LizaIPRuntimeData | None:
    """The loaded remote's runtime data, or ``None`` before setup made it."""
    data = getattr(entry, "runtime_data", None) or None
    return None if isinstance(data, LizaIPIrData) else data


def entry_connection(entry: ConfigEntry | None) -> LizaIPConnection | None:
    """The remote's connection for *entry*, or ``None`` before setup made one.

    It may be disconnected: callers that send check ``conn.connected`` (or
    ``device_sync.is_ready``) themselves.
    """
    data = entry_runtime(entry)
    return data.connection if data is not None else None


def entry_panel(entry: ConfigEntry | None) -> PanelEntry | None:
    """The remote's config-panel state, or ``None`` while it is not set up."""
    data = entry_runtime(entry)
    return data.panel if data is not None else None


def entry_device_id(entry: ConfigEntry | None) -> str | None:
    """The remote's device id for *entry*, or ``None`` while it is unknown."""
    conn = entry_connection(entry)
    return conn.device_id if conn is not None else None


def resolve_device_id(hass: HomeAssistant, entry_id: str) -> str | None:
    """Resolve entry_id to device_id."""
    return entry_device_id(hass.config_entries.async_get_entry(entry_id))


async def get_assignments(
    hass: HomeAssistant, device_id: str, page_id: int,
) -> list[tuple[str, dict[str, Any]]]:
    """Return (button_key, assignment_dict) pairs for every button on *page_id*."""
    assignments = await get_store(hass).async_get_assignments(device_id, page_id)
    return [
        (key, assign) for key, assign in assignments.items()
        if isinstance(assign, dict)
    ]
