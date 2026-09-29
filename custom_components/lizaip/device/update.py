"""Firmware update entity for lizaIP devices."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

import aiohttp

from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .connection import LizaIPConnection
from .const import DOMAIN, MODEL_ID
from .entity import LizaIPEntity

_LOGGER = logging.getLogger(__name__)

PARALLEL_UPDATES = 1

# Check for firmware updates every 4 hours.
SCAN_INTERVAL = timedelta(hours=4)

# Firmware release API — channel is derived from MODEL_ID so the URL automatically
# tracks the correct product variant.
# Override with LIZAIP_FIRMWARE_RELEASE_API env var to point to a self-hosted server:
#   export LIZAIP_FIRMWARE_RELEASE_API=http://192.168.1.50:8090/api/release/latest
import os as _os

FIRMWARE_RELEASE_API = _os.environ.get(
    "LIZAIP_FIRMWARE_RELEASE_API",
    f"http://firmware.api.ruwido.com/{MODEL_ID}/?latest=true",
)

# OTA polling: check every 5 s for up to 5 minutes (60 attempts).
_OTA_POLL_INTERVAL = 5
_OTA_MAX_ATTEMPTS = 60

# After the image is committed the device reboots. Keep the update card in
# "installing" state until it is back, so the reported version is the new one.
_OTA_REBOOT_POLL_INTERVAL = 2
_OTA_REBOOT_TIMEOUT = 120

# Fallback progress for firmware that reports only a status string (no numeric
# percentage). Matched as a substring against the lower-cased status, longest
# first, so "download complete" wins over "download".
_OTA_STATUS_PROGRESS: dict[str, float] = {
    "download started": 10,
    "download complete": 30,
    "image verification": 45,
    "image flashing": 70,
    "image commit": 100,
    "commit success": 100,
}


def _progress_from_status(status: str) -> float | None:
    """Map a textual OTA status onto a rough completion percentage.

    Used only when the device does not report a numeric ``progress`` value, so
    the HA progress bar still advances through the update stages.
    """
    normalized = status.lower()
    for text in sorted(_OTA_STATUS_PROGRESS, key=len, reverse=True):
        if text in normalized:
            return _OTA_STATUS_PROGRESS[text]
    return None


def _normalize_version(version: str | None) -> str | None:
    """Normalize a firmware version so device and server strings compare equal.

    The device reports the version encoded in the OTA asset filename, which is
    zero-padded (``HR-CV-MINI_v1.0006.00005.tar`` → ``1.0006.00005``), while the
    release API reports a semantic tag (``v1.6.5``).  Both denote the same build.

    Normalization strips a leading ``v``/``V`` and removes leading zeros from each
    dot-separated numeric segment::

        "v1.6.5"        → "1.6.5"
        "1.0006.00005"  → "1.6.5"

    Non-numeric segments are passed through unchanged so pre-release/build
    suffixes (e.g. ``1.6.5-rc1``) still round-trip.
    """
    if not version:
        return None
    cleaned = version.strip().lstrip("vV")
    segments = []
    for segment in cleaned.split("."):
        # int() would drop suffixes like "5-rc1", so only strip zeros on pure digits.
        segments.append(str(int(segment)) if segment.isdigit() else segment)
    return ".".join(segments)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up lizaIP firmware update entity."""
    connection: LizaIPConnection = entry.runtime_data
    async_add_entities([LizaIPFirmwareUpdate(entry, connection)])


class LizaIPFirmwareUpdate(LizaIPEntity, UpdateEntity):
    """Tracks and installs lizaIP device firmware.

    Installed version:  read from the hello handshake (device reports its version).
    Latest version:     fetched from the firmware release server at HA update-check intervals.
    Install:            POSTs to the device's HTTP management API (/Device/OTA);
                        the device downloads, verifies, and applies the update then reboots.
    """

    _attr_translation_key = "firmware"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_supported_features = (
        UpdateEntityFeature.INSTALL
        | UpdateEntityFeature.PROGRESS
    )
    _attr_should_poll = True
    _attr_title = "lizaIP Firmware"

    def __init__(
        self,
        entry: ConfigEntry,
        connection: LizaIPConnection,
    ) -> None:
        super().__init__(connection, entry)
        self._entry_title = entry.title
        self._attr_unique_id = f"{entry.entry_id}_firmware"
        self._latest_version: str | None = None
        self._release_url: str | None = None
        self._firmware_url: str | None = None
        self._attr_in_progress: bool = False
        self._attr_update_percentage: float | None = None

    async def async_added_to_hass(self) -> None:
        """Register availability + trigger first firmware check."""
        await super().async_added_to_hass()
        # HA won't poll until SCAN_INTERVAL expires; force an immediate check.
        # A *background* task is cancelled automatically at shutdown — a plain
        # async_create_task would linger and delay HA's stop sequence.
        self.hass.async_create_background_task(
            self._first_check(),
            name=f"lizaip_first_fw_check_{self.unique_id}",
        )

    async def _first_check(self) -> None:
        await asyncio.sleep(10)
        await self.async_update()
        self.async_write_ha_state()


    # ── UpdateEntity interface ────────────────────────────────────────────

    @property
    def available(self) -> bool:
        """Always available — version checking queries the release server, not the device."""
        return True

    @property
    def installed_version(self) -> str | None:
        """Firmware version currently running on the device (normalized)."""
        return _normalize_version(self._connection.device_version)

    @property
    def latest_version(self) -> str | None:
        """Newest firmware version available from the release server (normalized).

        Normalized so it compares equal to `installed_version` — HA marks the
        entity "Update available" purely on string inequality.
        """
        return _normalize_version(self._latest_version)

    @property
    def release_url(self) -> str | None:
        return self._release_url


    # ── Polling ───────────────────────────────────────────────────────────

    async def async_update(self) -> None:
        """Fetch the latest firmware version from the release server."""
        try:
            session = async_get_clientsession(self.hass)
            async with session.get(
                FIRMWARE_RELEASE_API,
                timeout=aiohttp.ClientTimeout(total=10),
                headers={"Accept": "application/json"},
            ) as resp:
                if resp.status != 200:
                    _LOGGER.debug(
                        "Firmware release check returned HTTP %s — skipping",
                        resp.status,
                    )
                    return
                release = await resp.json()
        except Exception as err:
            _LOGGER.warning("Failed to fetch firmware release info from %s: %s", FIRMWARE_RELEASE_API, err)
            return

        tag = str(release.get("tag_name", "")).strip()
        if tag:
            self._latest_version = tag
        self._release_url = release.get("html_url")

        # Find the OTA firmware asset: prefer .bin, fall back to .tar.
        self._firmware_url = None
        fallback_url: str | None = None
        for asset in release.get("assets", []):
            name = asset.get("name", "")
            url = asset.get("browser_download_url") or asset.get("url")
            if name.endswith(".bin"):
                self._firmware_url = url
                break
            if name.endswith(".tar") and not fallback_url:
                fallback_url = url
        if not self._firmware_url:
            self._firmware_url = fallback_url

        _LOGGER.debug(
            "Firmware update check: installed=%s latest=%s url=%s",
            self.installed_version,
            self._latest_version,
            self._firmware_url,
        )

    # ── Install ───────────────────────────────────────────────────────────

    async def async_install(
        self, version: str | None, backup: bool, **kwargs: Any
    ) -> None:
        """Trigger OTA by POSTing the firmware URL to the device's HTTP API."""
        if not self._connection.connected:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="not_connected",
            )
        url = self._firmware_url
        if not url:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="no_firmware_url",
            )
        _LOGGER.info(
            "Triggering firmware update on %s → %s",
            self._entry_title,
            url,
        )

        # Show the bar at 0 % immediately; _poll_ota_completion advances it.
        self._set_progress(0)

        try:
            await self._connection.update_firmware(url)
        except HomeAssistantError as err:
            self._attr_in_progress = False
            self._attr_update_percentage = None
            self.async_write_ha_state()
            # Log the underlying cause: the UI only shows the translated message,
            # which loses the exception chain.
            _LOGGER.error(
                "Firmware update failed for %s (url=%s): %s",
                self._entry_title, url, err, exc_info=True,
            )
            # A failed OTA request is a runtime/transport failure, not bad user
            # input, so this must be HomeAssistantError — ServiceValidationError
            # makes the UI prefix it with a misleading "Validation error:".
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="firmware_update_failed",
                translation_placeholders={"error": str(err)},
            ) from err

        # Poll OTA status in the background — the WebSocket will disconnect when
        # the device starts flashing, so don't block the install call.
        self.hass.async_create_background_task(
            self._poll_ota_completion(),
            name=f"lizaip_ota_poll_{self.unique_id}",
        )

    async def _poll_ota_completion(self) -> None:
        """Background task: poll OTA status until commit or timeout.

        Publishes `update_percentage` on every poll so the HA update card renders
        a live progress bar.
        """
        _LOGGER.debug("Starting OTA status polling for %s", self._entry_title)
        for attempt in range(_OTA_MAX_ATTEMPTS):
            await asyncio.sleep(_OTA_POLL_INTERVAL)

            if not self._connection.connected:
                _LOGGER.debug(
                    "OTA poll [%s]: device disconnected (rebooting?), stopping poll",
                    self._entry_title,
                )
                # The device only reboots once the image is committed, so treat a
                # drop mid-update as "nearly done" rather than leaving a stale bar.
                self._set_progress(100)
                break

            try:
                status, percent = await self._connection.get_ota_progress()
            except Exception as err:
                _LOGGER.debug(
                    "OTA poll [%s] attempt %d error: %s",
                    self._entry_title, attempt + 1, err,
                )
                continue

            # Firmware that answers in plain text reports no percentage — derive a
            # coarse one from the status string so the bar still advances.
            if percent is None:
                percent = _progress_from_status(status)
            self._set_progress(percent)

            _LOGGER.debug(
                "OTA poll [%s] attempt %d: %r (%s%%)",
                self._entry_title, attempt + 1, status, percent,
            )

            normalized = status.lower()
            if "commit success" in normalized or "image commit" in normalized:
                _LOGGER.info(
                    "OTA completed on %s: %s", self._entry_title, status
                )
                self._set_progress(100)
                break

        # The device reboots into the new image. Stay "in progress" until it is
        # back and has reported its new version via hello — otherwise the card
        # briefly flips back to "Update available" (old version vs. new tag)
        # before settling, and the more-info dialog closes on stale data.
        await self._await_reconnect()

        self._attr_in_progress = False
        self._attr_update_percentage = None
        self.async_write_ha_state()

    async def _await_reconnect(self) -> None:
        """Wait for the device to come back after the post-OTA reboot.

        Returns as soon as the WebSocket is up again, or after
        ``_OTA_REBOOT_TIMEOUT`` seconds so a device that fails to return never
        leaves the entity stuck showing a progress bar.
        """
        if self._connection.connected:
            return

        _LOGGER.debug("Waiting for %s to reboot after OTA", self._entry_title)
        deadline = _OTA_REBOOT_TIMEOUT
        waited = 0
        while waited < deadline:
            await asyncio.sleep(_OTA_REBOOT_POLL_INTERVAL)
            waited += _OTA_REBOOT_POLL_INTERVAL
            if self._connection.connected:
                _LOGGER.info(
                    "%s reconnected after OTA (version %s)",
                    self._entry_title, self._connection.device_version,
                )
                return

        _LOGGER.warning(
            "%s did not reconnect within %ss after the firmware update",
            self._entry_title, deadline,
        )

    def _set_progress(self, percent: float | None) -> None:
        """Publish OTA progress to the update card."""
        self._attr_in_progress = True
        self._attr_update_percentage = percent
        self.async_write_ha_state()