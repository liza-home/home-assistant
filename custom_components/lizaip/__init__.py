"""The lizaIP integration.

Single HACS-installed integration that manages:
  - Device WebSocket connections (device/ sub-package)
  - Config panel and device sync (config/ sub-package)
  - Image server loaded as imgserv/ sub-package
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, device_registry as dr
from homeassistant.helpers.device_registry import CONNECTION_NETWORK_MAC
from homeassistant.helpers.network import get_url
from homeassistant.helpers.typing import ConfigType

from .device import (
    LizaIPConnection,
    LizaIPWebSocketView,
    MANUFACTURER,
    MODEL,
    MODEL_ID,
    WS_PATH,
    async_register_services,
)
from . import action_controller
from .const import (
    CONF_DEMO_MODE,
    CONF_DEMO_MODE_DWELL_TIME,
    CONF_DEMO_MODE_SWIPE_TIME,
    DOMAIN,
)
from .config.panel import async_setup_panel, async_setup_config_entry, async_unload_config_entry
from .config.store import LizaRemoteStore
from .imgserv import async_setup_imgserv

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.EVENT,
    Platform.NUMBER,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.UPDATE,
]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type LizaIPConfigEntry = ConfigEntry[LizaIPConnection]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """One-time setup: register WS endpoint, services, panel, and load imgserv."""
    # WebSocket endpoint for devices
    hass.http.register_view(LizaIPWebSocketView())
    async_register_services(hass)
    _LOGGER.info("Registered lizaIP WebSocket endpoint at %s", WS_PATH)

    # Action dispatch — single source of truth for button-press → action execution
    action_controller.setup(hass)

    # Config panel (sidebar + WS commands)
    await async_setup_panel(hass)

    # Image server (MDI/logo/text rendering)
    await async_setup_imgserv(hass)

    return True


async def async_setup_entry(hass: HomeAssistant, entry: LizaIPConfigEntry) -> bool:
    """Set up one lizaIP device from a config entry."""
    mac: str | None = entry.data.get("device_id")  # stored as MAC string, e.g. "AA:BB:CC:DD:EE:FF"

    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.entry_id)},
        # Physical MAC address — enables HA to correlate this with other
        # integrations that discover the same hardware.
        connections={(CONNECTION_NETWORK_MAC, mac)} if mac else set(),
        name=entry.title,
        manufacturer=MANUFACTURER,
        model=MODEL,
        # Hardware product SKU (identifies the exact variant on the ruwido
        # product line; matches the firmware release channel). The device's own
        # answer once a handshake has reported one, and the shipped default
        # until then — the same value the config panel picks a blueprint by, so
        # the registry and the drawn remote cannot disagree.
        model_id=entry.data.get("model_id") or MODEL_ID,
        # Firmware version installed on the device (kept up-to-date via hello).
        sw_version=entry.data.get("sw_version"),
        # Hardware revision is not yet exposed by the device protocol;
        # populated once the device reports it.
        hw_version=entry.data.get("hw_version"),
    )

    # Add a "Visit" link on the device page pointing to the config panel.
    # Must be an absolute URL — HA rejects relative paths.
    try:
        ha_base = get_url(hass, prefer_external=False)
        config_url = f"{ha_base}/liza-remote?entry_id={entry.entry_id}"
        dr.async_get(hass).async_update_device(
            device.id, configuration_url=config_url
        )
    except Exception:
        pass  # non-critical; don't block setup if URL can't be determined

    connection = LizaIPConnection(hass, entry, device.id)
    entry.runtime_data = connection

    # The registry entry created above carries the model this integration last
    # saw. Keeping it current is `_persist_hello_facts`' job rather than a
    # listener's: the device may open the handshake itself, and that path is
    # answered in place without firing the hello event.

    # Initialize per-device store (lazy-loading, no upfront load needed)
    hass.data.setdefault(DOMAIN, {})
    if "_store" not in hass.data[DOMAIN]:
        store = LizaRemoteStore(hass)
        hass.data[DOMAIN]["_store"] = store
    else:
        store = hass.data[DOMAIN]["_store"]

    # Ensure a default storage file exists for this device (with all button slots)
    await store.async_ensure_default(device.id)

    # Set up config-panel listeners (state tracking, device sync)
    await async_setup_config_entry(hass, entry)

    # Re-push the whole page when the options change. `optimistic_updates` is
    # read live and needs nothing, but the language is baked into every label
    # at sync time: without this a user picks Italian, sees nothing happen, and
    # the remote keeps its old words until the next restart or config save.
    #
    # A targeted resync rather than `async_reload`: the labels are the only
    # thing an option can change on the device, and reloading would drop the
    # websocket connection to a remote that is working fine.
    def _optional_float(value: object) -> float | None:
        if value in (None, ""):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    last_demo_mode = bool(entry.options.get(CONF_DEMO_MODE, False))
    last_demo_dwell = _optional_float(entry.options.get(CONF_DEMO_MODE_DWELL_TIME))
    last_demo_swipe = _optional_float(entry.options.get(CONF_DEMO_MODE_SWIPE_TIME))

    async def _options_updated(hass: HomeAssistant, updated: LizaIPConfigEntry) -> None:
        nonlocal last_demo_mode, last_demo_dwell, last_demo_swipe
        from .config.device_sync import sync_config_to_device  # noqa: PLC0415

        demo_mode = bool(updated.options.get(CONF_DEMO_MODE, False))
        demo_dwell = _optional_float(updated.options.get(CONF_DEMO_MODE_DWELL_TIME))
        demo_swipe = _optional_float(updated.options.get(CONF_DEMO_MODE_SWIPE_TIME))
        demo_dwell_cmp = demo_dwell if demo_mode else None
        demo_swipe_cmp = demo_swipe if demo_mode else None

        if (
            demo_mode != last_demo_mode
            or demo_dwell_cmp != (last_demo_dwell if last_demo_mode else None)
            or demo_swipe_cmp != (last_demo_swipe if last_demo_mode else None)
        ):
            try:
                await updated.runtime_data.set_demo_mode(
                    demo_mode,
                    dwell_time=demo_dwell if demo_mode else None,
                    swipe_time=demo_swipe if demo_mode else None,
                )
            except Exception:  # noqa: BLE001
                # Never block options saves when the device is offline.
                # Keep the previous marker so a later save retries automatically.
                _LOGGER.debug(
                    "DemoMode apply failed for %s; will retry on next options save",
                    updated.entry_id,
                    exc_info=True,
                )
            else:
                last_demo_mode = demo_mode
                last_demo_dwell = demo_dwell
                last_demo_swipe = demo_swipe

        try:
            await sync_config_to_device(hass, updated)
        except Exception:  # noqa: BLE001
            # A device that is offline right now simply gets the new wording on
            # its next ordinary sync. Never let it fail the options save.
            _LOGGER.debug(
                "Options resync failed for %s; labels follow on next sync",
                updated.entry_id, exc_info=True,
            )

    entry.async_on_unload(entry.add_update_listener(_options_updated))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: LizaIPConfigEntry) -> bool:
    """Unload a lizaIP config entry."""
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        await async_unload_config_entry(hass, entry)
        await entry.runtime_data.disconnect()
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: LizaIPConfigEntry) -> None:
    """Clean up the WebSocket connection, storage, and caches for a permanently
    removed device.

    HA unloads a config entry before removing it, so `entry.runtime_data`'s
    WebSocket has normally already been closed by `async_unload_entry` and its
    listeners torn down by `async_unload_config_entry`. This runs the same
    teardown again defensively: if unload failed (or was skipped), a stale
    connection would otherwise remain reachable via `_find_connection()` in
    `device/websocket.py` even though the device it belongs to is gone.
    """
    connection = getattr(entry, "runtime_data", None)
    if connection is not None:
        await connection.disconnect()

    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device(identifiers={(DOMAIN, entry.entry_id)})
    device_id = device.id if device else None

    store: LizaRemoteStore | None = hass.data.get(DOMAIN, {}).get("_store")
    if store and device_id:
        await store.async_remove_device(device_id)

    # Compiled action scripts and in-flight slider gestures are otherwise never
    # evicted for a device that no longer exists.
    if device_id:
        action_controller.clear_script_cache_for_device(device_id)
    action_controller.clear_slider_state(entry.entry_id)
