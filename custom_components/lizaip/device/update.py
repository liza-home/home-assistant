"""Firmware update entity for lizaIP devices."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

import aiohttp
from yarl import URL

from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .connection import LizaIPConnection
from ..const import DOMAIN
from ..shared.logs import device_logger
from .const import LIZAIP_HELLO_EVENT, MODEL_ID
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

_TITLE = "lizaIP Firmware"
# Longest device status shown in the update dialog's heading.
_OTA_STATUS_MAX_LEN = 80

# OTA polling: ask the device every second (a request answered late just
# delays the next one), for up to 5 minutes.
_OTA_POLL_INTERVAL = 1
_OTA_POLL_TIMEOUT = 300
#: Consecutive unanswered status polls before polling gives up. A busy device
#: skips the odd reply, but a run this long means it has stopped talking, and
#: polling on in silence tells the user nothing.
_OTA_POLL_MAX_ERRORS = 15

# After the image is committed the device reboots. Keep the update card in
# "installing" state until it is back, so the reported version is the new one.
_OTA_REBOOT_TIMEOUT = 120


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


def _firmware_asset_url(release: dict) -> str | None:
    """The OTA image of a release: its .bin asset, or else its .tar one."""
    fallback: str | None = None
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        url = asset.get("browser_download_url") or asset.get("url")
        if name.endswith(".bin"):
            return url
        if name.endswith(".tar") and not fallback:
            fallback = url
    return fallback


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up lizaIP firmware update entity."""
    connection: LizaIPConnection = entry.runtime_data.connection
    async_add_entities([LizaIPFirmwareUpdate(entry, connection)])


class LizaIPFirmwareUpdate(LizaIPEntity, UpdateEntity):
    """Tracks and installs lizaIP device firmware.

    Installed version:  read from the hello handshake (device reports its version).
    Latest version:     fetched from the firmware release server at HA update-check intervals.
    Release notes:      the release's Markdown `body`: the CHANGELOG sections of every
                        release since the installed version (`?since=`).
    Install:            POSTs to the device's HTTP management API (/Device/OTA);
                        the device downloads, verifies, and applies the update then reboots.
    Specific version:   `update.install` with a `version` asks the server for that
                        release (`?version=`), which is how a device is rolled back.
    """

    _attr_translation_key = "firmware"
    _attr_entity_category = EntityCategory.CONFIG
    # PROGRESS only so the entity owns `in_progress` (HA refuses a second
    # install while it is set); no `update_percentage` is ever published.
    _attr_supported_features = (
        UpdateEntityFeature.INSTALL
        | UpdateEntityFeature.PROGRESS
        | UpdateEntityFeature.RELEASE_NOTES
        | UpdateEntityFeature.SPECIFIC_VERSION
    )
    _attr_should_poll = True

    def __init__(
        self,
        entry: ConfigEntry,
        connection: LizaIPConnection,
    ) -> None:
        super().__init__(connection, entry)
        self._logger = device_logger(_LOGGER, entry)
        self._attr_unique_id = f"{entry.entry_id}_firmware"
        self._entry_id = entry.entry_id
        self._latest_version: str | None = None
        self._release_url: str | None = None
        self._release_notes: str | None = None
        # What GET /Device/OTA last said during an install; None otherwise.
        self._ota_status: str | None = None
        self._firmware_url: str | None = None
        self._attr_in_progress: bool = False
        self._first_check_task: asyncio.Task | None = None

    async def async_added_to_hass(self) -> None:
        """Register availability + trigger first firmware check."""
        await super().async_added_to_hass()
        # HA won't poll until SCAN_INTERVAL expires; force an immediate check.
        # A *background* task is cancelled automatically at shutdown — a plain
        # async_create_task would linger and delay HA's stop sequence.
        self._first_check_task = self.hass.async_create_background_task(
            self._first_check(),
            name=f"lizaip_first_fw_check_{self.unique_id}",
        )

    async def async_will_remove_from_hass(self) -> None:
        """Cancel the pending first check so it cannot outlive this entity.

        Without this a reload leaves the old entity's sleeping task behind; it
        wakes up afterwards and writes state for an entity HA has already
        dropped, while the replacement entity schedules a check of its own.
        """
        task = self._first_check_task
        self._first_check_task = None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await super().async_will_remove_from_hass()

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
    def title(self) -> str:
        """Heading of the update dialog, with the device's status while installing.

        It is the only text the dialog refreshes during an install (with
        release notes supported it does not show `release_summary`).
        """
        return f"{_TITLE}: {self._ota_status}" if self._ota_status else _TITLE

    @property
    def release_url(self) -> str | None:
        return self._release_url

    async def async_release_notes(self) -> str | None:
        """Markdown notes of the latest release (the server's `body`)."""
        return self._release_notes


    # ── Polling ───────────────────────────────────────────────────────────

    def _release_check_url(self) -> URL:
        """The release API, asking for the notes of every release since ours.

        `since` makes the server's `body` cover all releases after the
        installed one, not just the newest; servers that do not know it
        ignore it. Left out while the installed version is unknown.
        """
        url = URL(FIRMWARE_RELEASE_API)
        installed = self.installed_version
        return url.update_query(since=installed) if installed else url

    async def _fetch_json(self, url: URL) -> Any | None:
        """GET *url* as JSON, or None when the server cannot be reached."""
        try:
            session = async_get_clientsession(self.hass)
            async with session.get(
                url,
                timeout=aiohttp.ClientTimeout(total=10),
                headers={"Accept": "application/json"},
            ) as resp:
                if resp.status != 200:
                    self._logger.debug(
                        "Firmware release check returned HTTP %s — skipping",
                        resp.status,
                    )
                    return None
                return await resp.json()
        except Exception as err:
            self._logger.warning("Failed to fetch firmware release info from %s: %s", url, err)
            return None

    async def async_update(self) -> None:
        """Fetch the latest release from the release server."""
        release = await self._fetch_json(self._release_check_url())
        if not isinstance(release, dict):
            return

        tag = str(release.get("tag_name", "")).strip()
        if tag:
            self._latest_version = tag
        self._release_url = release.get("html_url")
        body = release.get("body")
        self._release_notes = (body.strip() or None) if isinstance(body, str) else None

        self._firmware_url = _firmware_asset_url(release)

        self._logger.debug(
            "Firmware update check: installed=%s latest=%s url=%s",
            self.installed_version,
            self._latest_version,
            self._firmware_url,
        )

    # ── Install ───────────────────────────────────────────────────────────

    async def _install_url(self, version: str | None) -> str:
        """The firmware image to install: a named version, or the latest release.

        A named version is asked of the server (`?version=`), so an older one
        can be installed to roll the device back.
        """
        if version is None:
            if not self._firmware_url:
                raise ServiceValidationError(
                    translation_domain=DOMAIN,
                    translation_key="no_firmware_url",
                )
            return self._firmware_url

        release = await self._fetch_json(
            URL(FIRMWARE_RELEASE_API).update_query(version=_normalize_version(version) or "")
        )
        url = _firmware_asset_url(release) if isinstance(release, dict) else None
        if not url:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="unknown_firmware_version",
                translation_placeholders={"version": version},
            )
        return url

    async def async_install(
        self, version: str | None, backup: bool, **kwargs: Any
    ) -> None:
        """Trigger OTA by POSTing the firmware URL to the device's HTTP API."""
        if not self._connection.connected:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="not_connected",
            )
        url = await self._install_url(version)
        self._logger.info("Triggering firmware update → %s", url)
        version_before = self._connection.device_version

        # The device reports stages, not a percentage: the card shows an
        # indeterminate bar, and the dialog heading the stage (see `title`).
        self._set_installing()

        # The device repeats the previous update's final report until this one
        # starts; remember it so it is not taken for this update's completion.
        try:
            previous = (await self._connection.get_ota_reply()).raw
        except Exception:  # noqa: BLE001 - only a hint; the install goes on
            previous = None

        try:
            await self._connection.update_firmware(url)
        except HomeAssistantError as err:
            self._attr_in_progress = False
            self.async_write_ha_state()
            # Log the underlying cause: the UI only shows the translated message,
            # which loses the exception chain.
            self._logger.error(
                "Firmware update failed (url=%s): %s", url, err, exc_info=True,
            )
            # A failed OTA request is a runtime/transport failure, not bad user
            # input, so this must be HomeAssistantError — ServiceValidationError
            # makes the UI prefix it with a misleading "Validation error:".
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="firmware_update_failed",
                translation_placeholders={"error": str(err)},
            ) from err

        # Stay inside async_install until the device is back: HA clears
        # in_progress the moment it returns, which made the card drop the
        # "installing" state between the request and the first poll.
        try:
            await self._poll_ota_completion(previous, version_before)
        finally:
            # Unconditional: a cancellation (reload, HA stop) or an unexpected
            # failure during polling must not leave the card stuck on
            # "installing" forever. HA writes the state right after
            # async_install returns or raises.
            self._ota_status = None
            self._attr_in_progress = False

    async def _poll_ota_completion(
        self, previous: str | None = None, version_before: str | None = None,
    ) -> None:
        """Poll OTA status until commit, disconnect or timeout.

        Each new status goes into the dialog heading. *previous* is the reply
        from before the update; while the device still answers with it, it is
        not this update's report. *version_before* is the firmware version the
        device ran before it (default: the one it reports now).
        """
        if version_before is None:
            version_before = self._connection.device_version
        self._logger.debug("Starting OTA status polling")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _OTA_POLL_TIMEOUT
        attempt = 0
        consecutive_errors = 0
        while loop.time() < deadline:
            attempt += 1
            await asyncio.sleep(_OTA_POLL_INTERVAL)

            if not self._connection.connected:
                # The device only reboots once the image is committed.
                self._logger.debug(
                    "OTA poll: device disconnected (rebooting?), stopping poll",
                )
                break

            # A busy device often misses the timeout; keep polling.
            try:
                reply = await self._connection.get_ota_reply()
            except Exception as err:  # noqa: BLE001 - keep polling
                consecutive_errors += 1
                self._logger.debug("OTA poll attempt %d error: %s", attempt, err)
                if consecutive_errors >= _OTA_POLL_MAX_ERRORS:
                    # Polling on in silence until the outer timeout leaves the
                    # user watching an "installing" card for minutes with no
                    # idea the device stopped answering.
                    self._logger.warning(
                        "Device stopped answering OTA status %d times in a row; "
                        "giving up on polling. The update may still be running — "
                        "check the device.",
                        consecutive_errors,
                    )
                    break
                continue
            consecutive_errors = 0
            self._logger.debug("OTA poll attempt %d: %r", attempt, reply.raw)
            if previous is not None and reply.raw == previous:
                continue

            status = reply.status
            shown = status if len(status) <= _OTA_STATUS_MAX_LEN else (
                status[: _OTA_STATUS_MAX_LEN - 1].rstrip() + "…"
            )
            if shown != self._ota_status:
                self._ota_status = shown
                self.async_write_ha_state()

            normalized = status.lower()
            if "commit success" in normalized or "image commit" in normalized:
                self._logger.info("OTA completed: %s", status)
                break

        # The device reboots into the new image. Stay "in progress" until it is
        # back and has reported its new version via hello — otherwise the card
        # briefly flips back to "Update available" (old version vs. new tag)
        # before settling, and the more-info dialog closes on stale data.
        await self._await_reconnect(version_before)

        self._ota_status = None
        self._attr_in_progress = False
        self.async_write_ha_state()

    async def _await_reconnect(self, version_before: str | None) -> None:
        """Wait for the device to say hello again after the post-OTA reboot.

        The socket coming back is not enough: availability fires before the
        hello that reports the new version, and when polling ends the device
        has often not even dropped yet. Returns once a hello arrives (or the
        new version is already known), or after ``_OTA_REBOOT_TIMEOUT``
        seconds so a device that fails to return never leaves the entity
        stuck "installing".
        """
        if self._connection.device_version != version_before:
            return

        self._logger.debug("Waiting for the device to reboot after OTA")
        back = asyncio.Event()

        @callback
        def _on_hello(event: Event) -> None:
            if event.data.get("entry_id") == self._entry_id:
                back.set()

        unsubscribe = self.hass.bus.async_listen(LIZAIP_HELLO_EVENT, _on_hello)
        try:
            await asyncio.wait_for(back.wait(), _OTA_REBOOT_TIMEOUT)
        except TimeoutError:
            self._logger.warning(
                "Did not reconnect within %ss after the firmware update",
                _OTA_REBOOT_TIMEOUT,
            )
            return
        finally:
            unsubscribe()
        self._logger.info(
            "Reconnected after OTA (version %s)", self._connection.device_version,
        )

    def _set_installing(self) -> None:
        """Show the update card as installing."""
        self._attr_in_progress = True
        self.async_write_ha_state()
