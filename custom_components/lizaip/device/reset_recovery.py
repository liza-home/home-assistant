"""Re-provision a remote that was factory-reset while HA still had it configured.

A reset remote re-announces the mDNS records HA already has cached, so HA's
discovery starts no flow. Its announcements still reach us, so we listen here.
"""
from __future__ import annotations

import logging

from homeassistant.components import zeroconf
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from zeroconf import IPVersion, RecordUpdate, RecordUpdateListener, Zeroconf
from zeroconf.asyncio import AsyncServiceInfo

from .. import provisioning
from ..config_flow import discovered_device_id
from ..const import DOMAIN
from ..shared.logs import device_logger

_LOGGER = logging.getLogger(__name__)

SERVICE_TYPE = "_lizaip._tcp.local."
#: Announcements come in bursts; once a remote is settled, skip the rest.
COOLDOWN = 60.0


async def async_setup_reset_recovery(hass: HomeAssistant) -> None:
    """Check every known remote that announces itself on the network."""
    aiozc = await zeroconf.async_get_async_instance(hass)
    aiozc.zeroconf.async_add_listener(
        _AnnouncementListener(hass, aiozc.zeroconf), None
    )


class _AnnouncementListener(RecordUpdateListener):
    def __init__(self, hass: HomeAssistant, zc: Zeroconf) -> None:
        self._hass = hass
        self._zc = zc
        self._pending: set[str] = set()
        self._checking: set[str] = set()
        self._settled: dict[str, float] = {}

    def async_update_records(
        self, zc: Zeroconf, now: float, records: list[RecordUpdate]
    ) -> None:
        for update in records:
            name = update.new.name
            if name.lower().endswith("." + SERVICE_TYPE):
                self._pending.add(name)

    def async_update_records_complete(self) -> None:
        names, self._pending = self._pending, set()
        for name in names:
            self._check(name)

    def _check(self, name: str) -> None:
        info = AsyncServiceInfo(SERVICE_TYPE, name)
        if not info.load_from_cache(self._zc):
            return
        unique_id = discovered_device_id(name, info.decoded_properties)
        entry = self._hass.config_entries.async_entry_for_domain_unique_id(
            DOMAIN, unique_id
        )
        ips = info.parsed_addresses(IPVersion.V4Only)
        if entry is None or not ips or self._hass.is_stopping:
            return
        loop_time = self._hass.loop.time()
        if entry.entry_id in self._checking or (
            loop_time - self._settled.get(entry.entry_id, -COOLDOWN) < COOLDOWN
        ):
            return
        self._checking.add(entry.entry_id)
        self._hass.async_create_background_task(
            self._async_recover(entry, ips, info.port),
            name=f"lizaip_reset_recovery_{entry.entry_id}",
        )

    async def _async_recover(
        self, entry: ConfigEntry, ips: list[str], port: int
    ) -> None:
        try:
            cfg = await provisioning.async_read_ha_config(self._hass, ips, port)
            if cfg is None:
                return
            if not str(cfg.get("ha_hostname") or "").strip():
                device_logger(_LOGGER, entry).info(
                    "Announced itself without a Home Assistant address (factory "
                    "reset?) — re-provisioning",
                )
                outcome = await provisioning.async_provision(self._hass, ips, port)
                # A still-booting remote may drop it; the next announcement retries.
                if outcome is provisioning.ProvisionOutcome.FAILED:
                    return
            self._settled[entry.entry_id] = self._hass.loop.time()
        finally:
            self._checking.discard(entry.entry_id)
