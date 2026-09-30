"""WebSocket connection manager for a single lizaIP device.

Handles:
  - Accepting the inbound WebSocket from the device
  - Protocol handshake (hello)
  - Dispatching device events to HA entity callbacks
  - Providing a command API (set_page, set_brightness, …)

Liveness is tracked via aiohttp's own WebSocket heartbeat (configured on the
WebSocketResponse in websocket.py), not an application-level ping loop.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import aiohttp
from aiohttp import ClientTimeout, WSCloseCode, web

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    DOMAIN,
    LIZAIP_AVAILABILITY_EVENT,
    LIZAIP_EVENT,
    LIZAIP_HELLO_EVENT,
)
from .protocol import (
    ERR_INTERNAL,
    PROTOCOL_VERSION,
    LizaIPProtocol,
    ProtocolError,
    fire_and_forget,
    validate_page_id,
)

_LOGGER = logging.getLogger(__name__)

if TYPE_CHECKING:
    from homeassistant.helpers.script import Script

# Consecutive disconnects before a repair issue is raised.
MAX_FAILURES = 3

BRIGHTNESS_MIN = 1
BRIGHTNESS_MAX = 255
BRIGHTNESS_AUTO_VALUES = (0, -1)
DEFAULT_BRIGHTNESS = 128.0


class LizaIPConnection:
    """Manages an inbound WebSocket connection from a lizaIP device."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        device_id: str | None = None,
    ) -> None:
        self._hass = hass
        self._entry = entry
        self._device_id = device_id
        self._ws: web.WebSocketResponse | None = None
        self._protocol = LizaIPProtocol()

        # Compiled action Scripts for this entry, keyed on (page_id, button_key).
        # Scripts register themselves in `hass.data` with a strong reference, so
        # they outlive garbage collection and must be unloaded explicitly. Tying
        # the cache to the connection bounds their lifetime to the config entry
        # instead of the module, so a reload cannot strand the previous set.
        self.script_cache: dict[tuple[int, str], tuple[list, Script]] = {}

        # Entity-platform callbacks
        self._button_callbacks: dict[str, Callable[[str, dict[str, Any]], None]] = {}
        self._sensor_callbacks: dict[str, Callable[[float], None]] = {}
        self._discovery_callbacks: list[Callable[[dict[str, Any]], None]] = []
        self._availability_callbacks: list[Callable[[bool], None]] = []
        self._brightness_callbacks: list[Callable[[float, bool], None]] = []

        # Brightness state mirrored for HA entities. Automatic mode is the
        # device's own default, so assume it until the first `get_brightness`
        # answer arrives — starting at False would briefly present a manual
        # brightness slider the device is not actually honouring.
        self._brightness_value: float = DEFAULT_BRIGHTNESS
        self._brightness_automatic: bool = True

        # Seed discovery from capabilities stored in entry.data (from GET /api/info
        # during the config flow).  This lets entity platforms create entities
        # immediately at setup, before the device connects over WebSocket.
        # Capabilities are only available via /api/info (provisioning); the hello
        # handshake does NOT carry them.
        self._last_discovery = self._build_discovery(entry.data.get("capabilities"))

        # Device metadata (populated after hello)
        self._device_protocol_version: int | None = entry.data.get("protocol_version")
        self._device_version: str | None = entry.data.get("sw_version")
        # The hardware variant, as the device reports it. Seeded from the entry
        # so the config panel can draw the right face before the remote has
        # connected; `None` until some firmware that reports it has said so.
        self._device_model_id: str | None = entry.data.get("model_id")
        self._device_mac: str | None = entry.data.get("device_id")

        # Failure tracking for repair issues
        self._consecutive_failures: int = 0
        # Peer IP of the connected device — set in accept(), used for the HTTP management API
        self._peer_ip: str | None = None
        # Background tasks belonging to this connection, cancelled when it goes
        # away. Kept generic on purpose: this module should not have to know
        # what an optional feature started, only that it must not outlive the
        # connection it was started for.
        self._aux_tasks: list[asyncio.Task] = []
        # The port the device's HTTP management API listens on. Seeded from
        # the mDNS SRV record stored in entry.data at provisioning time;
        # confirmed/updated by _probe_device() after every hello.
        self._device_http_port: int | None = entry.data.get("device_port")

        # Cached device page state — populated after first sync, reset on disconnect.
        # None means "unknown, must query device". After sync it holds what was last sent.
        self._known_page_hashes: dict[int, int] | None = None  # page_id → hash
        self._known_main_pages: list[int] | None = None  # ordered page IDs

        # Wire up protocol event/request handlers
        self._protocol.on_event("button", self._on_button_event)
        self._protocol.on_event("slider", self._on_slider_event)
        self._protocol.on_event("goto_page", self._on_goto_page_event)
        # The protocol spec says ``goto_page``, but some firmware versions send
        # ``gotopage`` (no underscore). Accept both so the event is never lost.
        self._protocol.on_event("gotopage", self._on_goto_page_event)
        self._protocol.on_event("diag", self._on_diag_event)
        self._protocol.on_request("hello", self._on_hello_request)

    # ── Properties ────────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    @property
    def protocol(self) -> LizaIPProtocol:
        return self._protocol

    @property
    def device_protocol_version(self) -> int | None:
        return self._device_protocol_version

    @property
    def device_version(self) -> str | None:
        return self._device_version

    @property
    def device_model_id(self) -> str | None:
        """The product SKU the handshake reported, or the one already known.

        Seeded from ``entry.data`` so it answers with the last known SKU while
        the device is unplugged, which is also what the config panel draws by.
        """
        return self._device_model_id

    @property
    def device_mac(self) -> str | None:
        return self._device_mac

    @property
    def hass(self) -> HomeAssistant:
        """The Home Assistant instance this connection belongs to.

        Exposed so optional feature modules can schedule work without reaching
        into this class's private state.
        """
        return self._hass

    @property
    def peer_ip(self) -> str | None:
        """The address the device last connected from, or ``None``.

        Read off the socket rather than configured: the remote is the client
        here, so this is the only place its address is ever known. It is not
        persisted, so it answers ``None`` between a Home Assistant restart and
        the device's next connection, and it goes stale rather than wrong when
        DHCP moves the device while it is unplugged.
        """
        return self._peer_ip

    @property
    def device_http_port(self) -> int | None:
        """The port the device's HTTP API answers on, once one is known."""
        return self._device_http_port

    @property
    def last_discovery(self) -> dict[str, Any] | None:
        return self._last_discovery

    @property
    def brightness_value(self) -> float:
        return self._brightness_value

    @property
    def brightness_automatic(self) -> bool:
        return self._brightness_automatic

    # ── Callback registration ─────────────────────────────────────────────

    def register_availability(self, cb: Callable[[bool], None]) -> None:
        self._availability_callbacks.append(cb)

    def unregister_availability(self, cb: Callable[[bool], None]) -> None:
        try:
            self._availability_callbacks.remove(cb)
        except ValueError:
            pass

    def register_discovery(self, cb: Callable[[dict[str, Any]], None]) -> None:
        self._discovery_callbacks.append(cb)
        if self._last_discovery is not None:
            cb(self._last_discovery)

    def register_button(self, button_id: str, cb: Callable[[str, dict[str, Any]], None]) -> None:
        self._button_callbacks[button_id] = cb

    def unregister_button(self, button_id: str) -> None:
        self._button_callbacks.pop(button_id, None)

    def register_sensor(self, key: str, cb: Callable[[float], None]) -> None:
        self._sensor_callbacks[key] = cb

    def unregister_sensor(self, key: str) -> None:
        self._sensor_callbacks.pop(key, None)

    def register_brightness(self, cb: Callable[[float, bool], None]) -> None:
        self._brightness_callbacks.append(cb)
        cb(self._brightness_value, self._brightness_automatic)

    def unregister_brightness(self, cb: Callable[[float, bool], None]) -> None:
        try:
            self._brightness_callbacks.remove(cb)
        except ValueError:
            pass

    # ── WebSocket lifecycle ───────────────────────────────────────────────

    async def accept(self, ws: web.WebSocketResponse, peer_ip: str | None = None) -> None:
        """Accept a device WebSocket and run until it disconnects.

        If a connection for this device is already alive (e.g. the device rebooted
        and reconnected before HA's heartbeat noticed the old socket was dead), the
        stale connection is evicted in favor of the new one instead of rejecting it.
        The identity check (``self._ws is ws``) in the ``finally`` block below is what
        makes this race-safe: once the old connection's own ``accept()`` call notices
        its socket closed, it must not clobber ``self._ws`` if a newer connection has
        already taken over.
        """
        self._peer_ip = peer_ip
        old_ws = self._ws
        if old_ws is not None and not old_ws.closed:
            _LOGGER.warning(
                "New connection for %s arrived while the previous one was still alive — "
                "closing the old connection",
                self._entry.title,
            )
            await old_ws.close(code=WSCloseCode.POLICY_VIOLATION, message=b"replaced by new connection")

        self._ws = ws
        self._protocol.set_ws(ws)
        self._notify_availability(True)
        _LOGGER.info("Device connected: %s", self._entry.title)

        read_task = asyncio.create_task(self._read_loop(ws))
        try:
            await self._send_hello()
            self._consecutive_failures = 0  # successful hello — clear failure count
            ir.async_delete_issue(self._hass, DOMAIN, "repeated_connection_failure")
            await read_task
        except asyncio.CancelledError:
            read_task.cancel()
            raise
        finally:
            read_task.cancel()
            # Only tear down state that still belongs to *this* socket. If a newer
            # connection has already replaced self._ws, leave it alone.
            if self._ws is ws:
                self._ws = None
                self._protocol.set_ws(None)
                # Unknown device state after disconnect — must re-query on next connect
                self._known_page_hashes = None
                self._known_main_pages = None
                _LOGGER.warning(
                    "Device %s is unavailable (WebSocket disconnected)",
                    self._entry.title,
                )
                self._consecutive_failures += 1
                if self._consecutive_failures >= MAX_FAILURES:
                    ir.async_create_issue(
                        self._hass,
                        DOMAIN,
                        "repeated_connection_failure",
                        is_fixable=False,
                        severity=ir.IssueSeverity.WARNING,
                        translation_key="repeated_connection_failure",
                        translation_placeholders={
                            "device": self._entry.title,
                            "count": str(self._consecutive_failures),
                        },
                    )
                self._notify_availability(False)
            else:
                _LOGGER.debug(
                    "Old connection for %s finished tearing down after being replaced",
                    self._entry.title,
                )

    async def disconnect(self) -> None:
        """Close the connection gracefully."""
        # Before the socket: an auxiliary reader keyed to this device has
        # nothing left to say once the connection is going away, and one still
        # running would keep logging about a device that is gone.
        await self.async_cancel_aux_tasks()
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()

    def register_aux_task(self, task: asyncio.Task) -> None:
        """Tie a background task's lifetime to this connection."""
        self._aux_tasks = [t for t in self._aux_tasks if not t.done()]
        self._aux_tasks.append(task)

    async def async_cancel_aux_tasks(self) -> None:
        """Cancel every registered auxiliary task and wait for it to finish.

        Awaited rather than fired and forgotten so an entry unload does not race
        a reader that is midway through a write.
        """
        tasks, self._aux_tasks = self._aux_tasks, []
        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                # One task that will not die must not block the others, and a
                # failure here cannot be acted on: the connection is closing.
                pass

    async def async_device_control(self, payload: dict[str, Any]) -> tuple[int, str]:
        """Send a ``Device.Control`` payload and check the device accepted it.

        Public because optional feature modules need it and must not reach into
        this class's private helpers to get it.
        """
        status, text = await self._control_request(
            "POST",
            json={"Device": {"Control": payload}},
            timeout=ClientTimeout(total=10),
        )
        if status not in (200, 202, 204):
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="control_rejected",
                translation_placeholders={"status": str(status), "error": text[:200]},
            )
        return status, text

    # ── Command API (HA → Device) ─────────────────────────────────────────
    #
    # page_id is validated locally before transmission: the device would reject an
    # out-of-range value with error 400 anyway (PROTOCOL.md §5), so failing here
    # gives a clearer traceback and avoids a pointless round-trip.

    async def add_page(self, page_id: int) -> dict[str, Any]:
        return await self._protocol.send_request(
            "add_page", {"page_id": validate_page_id(page_id)}
        )

    async def del_page(self, page_id: int) -> dict[str, Any]:
        return await self._protocol.send_request(
            "del_page", {"page_id": validate_page_id(page_id)}
        )

    async def set_page(self, page_id: int, **kwargs: Any) -> dict[str, Any]:
        return await self._protocol.send_request(
            "set_page", {"page_id": validate_page_id(page_id), **kwargs}
        )

    async def goto_page(self, page_id: int) -> dict[str, Any]:
        return await self._protocol.send_request(
            "goto_page", {"page_id": validate_page_id(page_id)}
        )

    async def get_pages(self) -> list[dict[str, Any]]:
        result = await self._protocol.send_request("get_pages")
        return result.get("pages", [])

    async def set_main_pages(self, pages: list[int]) -> dict[str, Any]:
        """Set the swipe-navigation page order.

        *pages* is a list of ``page_id`` integers; the wire payload wraps each
        one in an object (``{"pages": [{"page_id": 1}, …]}``) so the entry
        shape matches every other page command in the protocol.
        """
        return await self._protocol.send_request(
            "set_main_pages",
            {"pages": [{"page_id": validate_page_id(p)} for p in pages]},
        )

    async def get_main_pages(self) -> list[int]:
        result = await self._protocol.send_request("get_main_pages")
        return result.get("pages", [])

    async def set_brightness(self, value: float) -> dict[str, Any]:
        """Set display brightness.

        Manual values are 1..255. 0 and -1 both enable automatic mode.
        """
        try:
            parsed = int(round(float(value)))
        except (TypeError, ValueError) as err:
            raise ValueError("brightness must be a number") from err

        if parsed not in BRIGHTNESS_AUTO_VALUES and not (BRIGHTNESS_MIN <= parsed <= BRIGHTNESS_MAX):
            raise ValueError("brightness must be 1..255, or 0/-1 for automatic mode")

        result = await self._protocol.send_request("set_brightness", {"value": parsed})

        if parsed in BRIGHTNESS_AUTO_VALUES:
            self._brightness_automatic = True
        else:
            self._brightness_automatic = False
            self._brightness_value = float(parsed)

        self._notify_brightness()
        return result

    async def get_brightness(self) -> tuple[float, bool]:
        """Read the current brightness back from the device.

        Returns ``(value, automatic)`` and refreshes the mirrored state so all
        registered entities update. The device answers with ``value``
        (0/-1 = automatic mode, 1..255 = manual level); newer firmware may
        additionally report ``automatic`` explicitly.
        """
        result = await self._protocol.send_request("get_brightness")

        raw = result.get("value", result.get("brightness"))
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise ProtocolError(
                ERR_INTERNAL, f"get_brightness returned no usable value: {result!r}"
            ) from None

        automatic = result.get("automatic", result.get("auto"))
        if automatic is None:
            automatic = int(round(value)) in BRIGHTNESS_AUTO_VALUES

        self._brightness_automatic = bool(automatic)
        if int(round(value)) not in BRIGHTNESS_AUTO_VALUES:
            self._brightness_value = max(BRIGHTNESS_MIN, min(BRIGHTNESS_MAX, value))

        self._notify_brightness()
        return self._brightness_value, self._brightness_automatic

    async def async_refresh_brightness(self) -> None:
        """Best-effort brightness read; never raises.

        Firmware without ``get_brightness`` answers with an error, which must
        not break the connection, so the mirrored state is simply kept.
        """
        try:
            value, automatic = await self.get_brightness()
        except ProtocolError as err:
            _LOGGER.debug("get_brightness unavailable on %s: %s", self._entry.title, err)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("get_brightness failed for %s: %s", self._entry.title, err)
        else:
            _LOGGER.debug(
                "Brightness read from %s: value=%s automatic=%s",
                self._entry.title, value, automatic,
            )

    # ── HTTP management API (OTA) ─────────────────────────────────────────

    async def _device_http_request(
        self, endpoint: str, unreachable_key: str, method: str, **kwargs: Any
    ) -> tuple[int, str]:
        """Call one of the device's HTTP management endpoints; returns ``(status, body)``.

        The two endpoints differ only in their path and in the translation key
        used when the device cannot be reached, so they share everything else —
        including the guards, which is the point: the OTA copy of this code
        previously formatted the error as a bare ``str(err)`` and so rendered an
        empty ``{error}`` for ``asyncio.TimeoutError``, whose ``str()`` is "".

        The port comes from the mDNS SRV record stored at provisioning time and
        confirmed by ``_probe_device()`` after every hello handshake.
        """
        if not self._peer_ip:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="device_ip_unknown",
            )
        if not self._device_http_port:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="device_port_unknown",
            )

        session = async_get_clientsession(self._hass)
        url = f"http://{self._peer_ip}:{self._device_http_port}{endpoint}"
        try:
            async with session.request(method, url, **kwargs) as resp:
                return resp.status, await resp.text()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            # A bare `str(err)` is empty for a timeout, which leaves the message
            # ending in a colon with nothing after it.
            err_msg = f"{err.__class__.__name__}: {err}" if str(err) else err.__class__.__name__
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key=unreachable_key,
                translation_placeholders={"url": url, "error": err_msg},
            ) from err

    async def _control_request(self, method: str, **kwargs: Any) -> tuple[int, str]:
        """Call the device's ``/Device/Control`` endpoint; returns ``(status, body)``."""
        return await self._device_http_request(
            "/Device/Control", "control_unreachable", method, **kwargs
        )

    async def set_demo_mode(
        self,
        enabled: bool,
        dwell_time: float | None = None,
        swipe_time: float | None = None,
    ) -> None:
        """Set ``Device.Control`` demo settings on the device management API."""
        control_payload: dict[str, Any] = {"DemoMode": bool(enabled)}
        if dwell_time is not None:
            control_payload["DemoModePageDelayMsec"] = dwell_time
        if swipe_time is not None:
            control_payload["DemoModeSwipeMsec"] = swipe_time

        _LOGGER.debug(
            "DemoMode request for %s (%s): %s",
            self._entry.title,
            self._peer_ip,
            control_payload,
        )

        status, text = await self._control_request(
            "POST",
            json={"Device": {"Control": control_payload}},
            timeout=ClientTimeout(total=10),
        )
        _LOGGER.debug(
            "DemoMode response for %s (%s): HTTP %s body=%r",
            self._entry.title,
            self._peer_ip,
            status,
            text[:300],
        )
        if status not in (200, 202, 204):
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="control_rejected",
                translation_placeholders={"status": str(status), "error": text[:200]},
            )

    async def _ota_request(self, method: str, **kwargs: Any) -> tuple[int, str]:
        """Call the device's ``/Device/OTA`` endpoint; returns (status, body text)."""
        return await self._device_http_request(
            "/Device/OTA", "ota_unreachable", method, **kwargs
        )

    async def update_firmware(self, url: str) -> None:
        """Trigger an OTA firmware update via the device's HTTP management API.

        ``POST /Device/OTA`` with body ``{"Device": {"OTA": {"URL": "<url>"}}}``.
        The device downloads, verifies, and applies the firmware, then reboots — so
        the WebSocket connection closes shortly after this returns.
        """
        _LOGGER.info(
            "Sending OTA request to %s (%s): %s", self._entry.title, self._peer_ip, url
        )
        status, text = await self._ota_request(
            "POST",
            json={"Device": {"OTA": {"URL": url}}},
            timeout=ClientTimeout(total=15),
        )
        if status not in (200, 202, 204):
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="ota_rejected",
                translation_placeholders={"status": str(status), "error": text[:200]},
            )

    async def get_ota_status(self) -> str:
        """Poll ``GET /Device/OTA`` and return the raw status text.

        e.g. ``"Image commit successful"``. Raises :exc:`HomeAssistantError` when
        the device cannot be reached.
        """
        status, _ = await self.get_ota_progress()
        return status

    async def get_ota_progress(self) -> tuple[str, float | None]:
        """Poll ``GET /Device/OTA`` and return ``(status_text, percent)``.

        The endpoint is content-negotiated: with ``Accept: application/json`` a
        device that supports it answers with ``{"status": ..., "progress": 0-100}``.
        Firmware that predates that (and the physical device today) still replies
        with plain text, in which case ``percent`` is ``None`` and the caller can
        fall back to deriving a rough percentage from the status string.
        """
        _, text = await self._ota_request(
            "GET",
            timeout=ClientTimeout(total=10),
            headers={"Accept": "application/json"},
        )
        text = text.strip()

        try:
            payload = json.loads(text)
        except ValueError:
            return text, None  # plain-text firmware
        if not isinstance(payload, dict):
            return text, None

        status = str(payload.get("status", "")).strip() or text
        raw_percent = payload.get("progress")
        try:
            percent = None if raw_percent is None else float(raw_percent)
        except (TypeError, ValueError):
            percent = None
        if percent is not None:
            percent = max(0.0, min(100.0, percent))
        return status, percent

    # ── Internal helpers ──────────────────────────────────────────────────

    @staticmethod
    def _build_discovery(caps: dict[str, Any] | None) -> dict[str, Any] | None:
        """Build a discovery payload from a capabilities dict.

        Used both for initial seeding from entry.data (GET /api/info at config
        flow time) and for refresh from the hello response at connect time.
        """
        if not caps:
            return None
        numbered = [f"button_{i}" for i in range(1, caps.get("buttons_per_page", 0) + 1)]
        return {
            "buttons": numbered + caps.get("static_buttons", []),
            "sliders": caps.get("sliders", []),
            "capabilities": caps,
        }

    def _notify_availability(self, available: bool) -> None:
        for cb in self._availability_callbacks:
            cb(available)
        # The entities above are pushed by their callbacks; anything that is not
        # an entity -- the config panel's online badge -- has no such hook and
        # would otherwise keep showing whatever it read when it opened. Fired on
        # both edges, and only from here, because this is the one place both
        # transitions pass through.
        self._hass.bus.async_fire(
            LIZAIP_AVAILABILITY_EVENT,
            {"entry_id": self._entry.entry_id, "connected": available},
        )

    def _notify_brightness(self) -> None:
        for cb in self._brightness_callbacks:
            cb(self._brightness_value, self._brightness_automatic)

    async def _read_loop(self, ws: web.WebSocketResponse) -> None:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                self._protocol.handle_raw(msg.data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                _LOGGER.warning("WebSocket error from %s: %s", self._entry.title, ws.exception())
                break

    async def _send_hello(self) -> None:
        try:
            result = await self._protocol.send_request("hello", {
                "protocol_version": PROTOCOL_VERSION,
            })
            self._device_protocol_version = result.get("protocol_version")
            self._device_mac = result.get("device_id")
            self._device_version = result.get("version")
            # `or` rather than a plain assignment: firmware that does not
            # report a model must not erase one an earlier build told us.
            self._device_model_id = result.get("model_id") or self._device_model_id
            self._persist_hello_facts()
            _LOGGER.info(
                "Hello: id=%s ver=%s proto=%s",
                self._device_mac, self._device_version, self._device_protocol_version,
            )
            # Repair issue: protocol version mismatch
            if (
                self._device_protocol_version is not None
                and self._device_protocol_version != PROTOCOL_VERSION
            ):
                ir.async_create_issue(
                    self._hass,
                    DOMAIN,
                    "protocol_version_mismatch",
                    is_fixable=False,
                    severity=ir.IssueSeverity.WARNING,
                    translation_key="protocol_version_mismatch",
                    translation_placeholders={
                        "device": self._entry.title,
                        "device_version": str(self._device_protocol_version),
                        "ha_version": str(PROTOCOL_VERSION),
                    },
                )
            else:
                ir.async_delete_issue(self._hass, DOMAIN, "protocol_version_mismatch")
            # Notify listeners (e.g. config/panel.py) that hello completed — triggers page sync
            self._hass.bus.async_fire(LIZAIP_HELLO_EVENT, {"entry_id": self._entry.entry_id})
            fire_and_forget(self.async_refresh_brightness())
            if self._peer_ip:
                fire_and_forget(self._probe_device(self._peer_ip))
        except ProtocolError as err:
            _LOGGER.error("Hello handshake failed: %s", err)

    async def _probe_device(self, peer_ip: str) -> None:
        """Query the device's HTTP management API after hello.

        Uses the port from ``entry.data["device_port"]`` (set at provisioning
        from the mDNS SRV record). When no port is stored — e.g. for entries
        created via the WebSocket discovery path — the probe is skipped; the
        capability payload will arrive in the hello handshake instead.
        """
        if not self._device_http_port:
            _LOGGER.debug("No device HTTP port stored — skipping probe")
            return

        session = async_get_clientsession(self._hass)
        url = f"http://{peer_ip}:{self._device_http_port}/api/info"
        info: dict[str, Any] | None = None
        try:
            async with session.get(url, timeout=ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    info = await resp.json(content_type=None)
                    _LOGGER.debug("Device HTTP port %d confirmed", self._device_http_port)
                else:
                    _LOGGER.debug("GET %s returned %s", url, resp.status)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("GET %s failed: %s", url, err)

        if info is None:
            return

        caps = info.get("capabilities")
        if self._last_discovery is not None or not caps:
            return

        # Persist capabilities and any device metadata into entry.data so they survive restarts.
        # hw_version is included when the device exposes it (not all firmware versions do).
        self._hass.config_entries.async_update_entry(
            self._entry,
            data={
                **self._entry.data,
                "capabilities": caps,
                **{
                    k: info[k]
                    for k in ("device_id", "protocol_version", "hw_version")
                    if info.get(k)
                },
            },
        )
        _LOGGER.info(
            "Capabilities fetched from %s and stored for %s", peer_ip, self._entry.title
        )

        # Fire discovery callbacks so entities get created
        self._last_discovery = self._build_discovery(caps)
        for cb in self._discovery_callbacks:
            cb(self._last_discovery)

    # ── Device event handlers ─────────────────────────────────────────────

    def _persist_hello_facts(self) -> None:
        """Store what the handshake said about the hardware in entry.data.

        Two things outlive the connection. The firmware version lets the
        `update` entity report what is installed straight after a HA restart,
        before the device has reconnected. The model id picks the blueprint the
        config panel draws, and the panel is reachable with the remote
        unplugged -- neither can wait for a live socket.

        Both are written in one `async_update_entry` because each call reloads
        listeners; a handshake reporting both should not cost two reloads. An
        absent field is left alone rather than cleared: older firmware reports
        no model id at all, and forgetting the one we already learned would
        send the panel back to the default face on every reconnect.

        The device registry is a separate store and is updated alongside, from
        here rather than from a listener on the hello event: the device may
        open the handshake itself, and that path answers in place without
        firing the event. Written only when a value actually changed, so the
        common reconnect -- same firmware, same model -- touches neither store.
        """
        updates = {}
        if self._device_version and self._entry.data.get("sw_version") != self._device_version:
            updates["sw_version"] = self._device_version
        if self._device_model_id and self._entry.data.get("model_id") != self._device_model_id:
            updates["model_id"] = self._device_model_id
        if not updates:
            return
        self._hass.config_entries.async_update_entry(
            self._entry,
            data={**self._entry.data, **updates},
        )
        try:
            dr.async_get(self._hass).async_update_device(self._device_id, **updates)
        except Exception as err:  # noqa: BLE001
            # The device page is cosmetic next to the connection itself; a
            # registry entry that has gone away must not break the handshake.
            _LOGGER.debug("Device registry update after hello failed: %s", err)

    def _on_hello_request(self, seq_id: int, data: dict) -> None:
        self._device_protocol_version = data.get("protocol_version")
        self._device_mac = data.get("device_id")
        self._device_version = data.get("version")
        self._device_model_id = data.get("model_id") or self._device_model_id
        self._persist_hello_facts()
        fire_and_forget(
            self._protocol.send_response("hello", seq_id, {"protocol_version": PROTOCOL_VERSION})
        )

    def _on_button_event(self, data: dict) -> None:
        _LOGGER.debug(
            "Button event from device: name=%s interaction=%s page_id=%s",
            data.get("name"), data.get("interaction"), data.get("page_id"),
        )
        self._hass.bus.async_fire(LIZAIP_EVENT, {
            "device_id": self._device_id,
            "type": "button",
            "page_id": data.get("page_id"),
            "button_name": data.get("name", ""),
            "interaction": data.get("interaction", "click"),
        })
        if cb := self._button_callbacks.get(data.get("name", "")):
            cb(data.get("interaction", "click"), data)

    def _on_slider_event(self, data: dict) -> None:
        self._hass.bus.async_fire(LIZAIP_EVENT, {
            "device_id": self._device_id,
            "type": "slider",
            "page_id": data.get("page_id"),
            "slider_name": data.get("name", ""),
            "interaction": data.get("interaction", "click"),
            # No default: an absent position must stay absent. Defaulting to 0
            # would be indistinguishable from a real drag to the bottom of the
            # track, and the slider executor would commit that as a move to the
            # minimum (see ``_normalize_position`` in action_controller).
            "position": data.get("position"),
        })
        if cb := self._button_callbacks.get(data.get("name", "")):
            cb(data.get("interaction", "click"), data)

        if data.get("name") == "slider_brightness":
            position = data.get("position")
            try:
                pos = float(position)
            except (TypeError, ValueError):
                return

            if pos in BRIGHTNESS_AUTO_VALUES:
                self._brightness_automatic = True
            else:
                self._brightness_automatic = False
                self._brightness_value = max(BRIGHTNESS_MIN, min(BRIGHTNESS_MAX, pos))
            self._notify_brightness()

    def _on_goto_page_event(self, data: dict) -> None:
        self._hass.bus.async_fire(LIZAIP_EVENT, {
            "device_id": self._device_id,
            "type": "goto_page",
            "page_id": data.get("page_id"),
        })

    def _on_diag_event(self, data: dict) -> None:
        diag_type = data.get("diag", "")
        self._hass.bus.async_fire(LIZAIP_EVENT, {
            "device_id": self._device_id,
            "type": "diag",
            "diag": diag_type,
            "value": data.get("value"),
        })
        if cb := self._sensor_callbacks.get(diag_type):
            cb(data.get("value"))
