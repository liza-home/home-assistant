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
from typing import TYPE_CHECKING, Any, NamedTuple

import aiohttp
from aiohttp import ClientTimeout, WSCloseCode, web
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr

from .. import issues, provisioning
from .http import device_session, device_url, error_detail


class OtaReply(NamedTuple):
    """One answer of ``GET /Device/OTA``."""

    status: str
    # The reply as received. The device keeps the last update's final status
    # ("Image commit succesful") until a new one starts; only its "Time"
    # changes, so the raw text tells a fresh report from a stale one.
    raw: str


def _parse_ota_reply(text: str) -> str:
    """Status text of a ``GET /Device/OTA`` reply.

    The device answers ``{"Device": {"OTA": {"Status": ..., "Time": ...}}}``;
    a flat ``{"status": ...}`` and plain text are accepted too. Keys are
    matched case-insensitively.
    """
    try:
        payload = json.loads(text)
    except ValueError:
        return text
    if not isinstance(payload, dict):
        return text
    node: Any = payload
    for key in ("device", "ota"):
        inner = next((v for k, v in node.items() if str(k).lower() == key), None)
        if not isinstance(inner, dict):
            break
        node = inner
    status = next((v for k, v in node.items() if str(k).lower() == "status"), None)
    return str(status or "").strip() or text
from ..const import DOMAIN
from ..imgserv.media_refs import with_references
from ..shared.logs import device_logger
from .const import LIZAIP_AVAILABILITY_EVENT, LIZAIP_EVENT, LIZAIP_HELLO_EVENT
from .page_cache import PageCache
from .protocol import (
    DEFAULT_REQUEST_TIMEOUT,
    ERR_CONFLICT,
    ERR_INTERNAL,
    ERR_NOT_FOUND,
    PROTOCOL_VERSION,
    LizaIPProtocol,
    ProtocolError,
    fire_and_forget,
    normalise_mac,
    validate_page_id,
)

_LOGGER = logging.getLogger(__name__)

if TYPE_CHECKING:
    from homeassistant.helpers.script import Script

# Consecutive disconnects before a repair issue is raised.
MAX_FAILURES = 3

#: How long a replacement connection waits for the connection it evicted to
#: finish unwinding before giving up and proceeding anyway. Short on purpose:
#: the device is already waiting, and a reader that will not die must not hold
#: the reconnect hostage.
REPLACED_SESSION_DRAIN = 5.0

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
        self._logger = device_logger(_LOGGER, entry)
        self._device_id = device_id
        self._ws: web.WebSocketResponse | None = None
        # The socket whose hello was answered; `ready` compares it with `_ws`.
        self._hello_ws: web.WebSocketResponse | None = None
        self._protocol = LizaIPProtocol(entry)

        # Compiled action Scripts for this entry, keyed on (page_id, button_key).
        # Scripts register themselves in `hass.data` with a strong reference, so
        # they outlive garbage collection and must be unloaded explicitly. Tying
        # the cache to the connection bounds their lifetime to the config entry
        # instead of the module, so a reload cannot strand the previous set.
        self.script_cache: dict[tuple[int, str], tuple[str, Script]] = {}

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
        # Set when the currently-running accept() has finished tearing its
        # session down. A replacement connection waits on it so the old read
        # loop is definitely gone before the new one starts talking.
        self._session_done: asyncio.Event | None = None
        # The port the device's HTTP management API listens on. Seeded from
        # the mDNS SRV record stored in entry.data at provisioning time;
        # confirmed/updated by _probe_device() after every hello.
        self._device_http_port: int | None = entry.data.get("device_port")

        # What the device is known to hold, and the lock the page sync uses.
        self.page_cache = PageCache()

        # Wire up protocol event/request handlers
        self._protocol.on_event("button", self._on_button_event)
        self._protocol.on_event("slider", self._on_slider_event)
        self._protocol.on_event("goto_page", self._on_goto_page_event)
        # The protocol spec says ``goto_page``, but some firmware versions send
        # ``gotopage`` (no underscore). Accept both so the event is never lost.
        self._protocol.on_event("gotopage", self._on_goto_page_event)
        self._protocol.on_event("diag", self._on_diag_event)
        self._protocol.on_request("hello", self._on_hello_request)
        # The remote may also pull what it should show, rather than waiting to
        # be pushed (PROTOCOL.md §8).
        self._protocol.on_request("get_pages", self._on_get_pages_request)
        self._protocol.on_request("get_page", self._on_get_page_request)

    # ── Properties ────────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    @property
    def ready(self) -> bool:
        """Connected *and* this socket's hello has been answered.

        Until then the remote is still setting itself up and rejects page
        requests with -4 ("No handler for packet request:set_page") -- or, short
        on memory, never answers them, holding the line until it drops.
        """
        return self.connected and self._hello_ws is self._ws

    @property
    def protocol(self) -> LizaIPProtocol:
        return self._protocol

    @property
    def device_id(self) -> str | None:
        """The remote's device id, or ``None`` until one is known."""
        return self._device_id

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

    # Each `register_*` returns the call that undoes it, for an entity's
    # `async_on_remove` or an entry's `async_on_unload`.

    def register_availability(self, cb: Callable[[bool], None]) -> Callable[[], None]:
        self._availability_callbacks.append(cb)
        return lambda: self.unregister_availability(cb)

    def unregister_availability(self, cb: Callable[[bool], None]) -> None:
        try:
            self._availability_callbacks.remove(cb)
        except ValueError:
            pass

    def register_discovery(self, cb: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._discovery_callbacks.append(cb)
        if self._last_discovery is not None:
            cb(self._last_discovery)
        return lambda: self.unregister_discovery(cb)

    def unregister_discovery(self, cb: Callable[[dict[str, Any]], None]) -> None:
        try:
            self._discovery_callbacks.remove(cb)
        except ValueError:
            pass

    def register_button(
        self, button_id: str, cb: Callable[[str, dict[str, Any]], None],
    ) -> Callable[[], None]:
        self._button_callbacks[button_id] = cb
        return lambda: self.unregister_button(button_id)

    def unregister_button(self, button_id: str) -> None:
        self._button_callbacks.pop(button_id, None)

    def register_sensor(self, key: str, cb: Callable[[float], None]) -> Callable[[], None]:
        self._sensor_callbacks[key] = cb
        return lambda: self.unregister_sensor(key)

    def unregister_sensor(self, key: str) -> None:
        self._sensor_callbacks.pop(key, None)

    def register_brightness(self, cb: Callable[[float, bool], None]) -> Callable[[], None]:
        self._brightness_callbacks.append(cb)
        cb(self._brightness_value, self._brightness_automatic)
        return lambda: self.unregister_brightness(cb)

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
        old_done = self._session_done
        if old_ws is not None and not old_ws.closed:
            self._logger.warning(
                "New connection arrived while the previous one was still alive — "
                "closing the old connection",
            )
            await old_ws.close(code=WSCloseCode.POLICY_VIOLATION, message=b"replaced by new connection")

        session_done = asyncio.Event()
        self._ws = ws
        self._session_done = session_done
        self._hello_ws = None
        self._protocol.set_ws(ws)

        # The old session's teardown is now a no-op (its identity check fails),
        # but its read loop may still be mid-frame. Wait for it to finish before
        # this connection starts talking, so two readers never share _protocol.
        if old_done is not None and not old_done.is_set():
            try:
                async with asyncio.timeout(REPLACED_SESSION_DRAIN):
                    await old_done.wait()
            except TimeoutError:
                self._logger.warning(
                    "Previous connection did not finish tearing down within %.0fs; "
                    "continuing with the new one",
                    REPLACED_SESSION_DRAIN,
                )

        self._notify_availability(True)
        self._logger.info("Device connected")

        read_task = asyncio.create_task(self._read_loop(ws))
        try:
            if await self._send_hello():
                self._consecutive_failures = 0
                await read_task
            else:
                # Close rather than idle on a socket nothing will be sent over:
                # the remote reconnects at once instead of waiting out its own
                # hello timeout, and the failure counts towards MAX_FAILURES.
                await ws.close(
                    code=WSCloseCode.POLICY_VIOLATION, message=b"hello failed",
                )
        finally:
            # Cancelled *and* awaited: a bare cancel() returns before the loop
            # has unwound, which can leave a half-finished write behind and
            # hides anything the reader raised on the way out.
            read_task.cancel()
            await asyncio.gather(read_task, return_exceptions=True)
            # Only tear down state that still belongs to *this* socket. If a newer
            # connection has already replaced self._ws, leave it alone.
            if self._ws is ws:
                self._ws = None
                self._session_done = None
                self._protocol.set_ws(None)
                # Unknown device state after disconnect — must re-query on next connect
                self.page_cache.reset()
                self._logger.warning("Device is unavailable (WebSocket disconnected)")
                self._consecutive_failures += 1
                if self._consecutive_failures == MAX_FAILURES:
                    self._logger.error(
                        "Disconnected %d times in a row without completing "
                        "the handshake. Check its Wi-Fi signal and power.",
                        self._consecutive_failures,
                    )
                self._notify_availability(False)
            else:
                self._logger.debug(
                    "Old connection finished tearing down after being replaced",
                )
            session_done.set()

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
        # return_exceptions keeps one task that will not die from blocking the
        # others, and a failure here cannot be acted on: the connection is
        # closing either way.
        await asyncio.gather(*tasks, return_exceptions=True)

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

    async def add_page(
        self, page_id: int, *, timeout: float = DEFAULT_REQUEST_TIMEOUT
    ) -> dict[str, Any]:
        return await self._protocol.send_request(
            "add_page", {"page_id": validate_page_id(page_id)}, timeout=timeout
        )

    async def del_page(
        self, page_id: int, *, timeout: float = DEFAULT_REQUEST_TIMEOUT
    ) -> dict[str, Any]:
        return await self._protocol.send_request(
            "del_page", {"page_id": validate_page_id(page_id)}, timeout=timeout
        )

    async def set_page(
        self, page_id: int, *, timeout: float = DEFAULT_REQUEST_TIMEOUT, **kwargs: Any
    ) -> dict[str, Any]:
        """Write a page.

        *timeout* is keyword-only and never reaches the wire: a page payload is
        splatted in as ``**page_data``, and the device has no ``timeout`` field,
        so keeping it out of ``kwargs`` is what lets the caller pick a deadline
        without the value being mistaken for page content.

        Image URLs travel as ``imgserv://ref:<djb2>`` (see ``media_refs``).
        """
        return await self._protocol.send_request(
            "set_page",
            {"page_id": validate_page_id(page_id), **with_references(kwargs)},
            timeout=timeout,
        )

    async def clear_all(self) -> dict[str, Any]:
        """Remove every page from the device.

        The page cache is dropped first, not after: it describes pages that are
        about to stop existing, and a failure part way through would otherwise
        leave it claiming a device state nobody can rely on. Forgetting it means
        the next sync re-reads `get_pages` and rebuilds from what is really there.
        """
        self.page_cache.forget()
        return await self._protocol.send_request("clear_all")

    async def goto_page(self, page_id: int) -> dict[str, Any]:
        return await self._protocol.send_request(
            "goto_page", {"page_id": validate_page_id(page_id)}
        )

    async def send_ir(self, ir_blob: str) -> dict[str, Any]:
        """Have the remote transmit an IR code, given as a base64 blob."""
        return await self._protocol.send_request("send_ir", {"ir_blob": ir_blob})

    async def get_pages(self, *, timeout: float = DEFAULT_REQUEST_TIMEOUT) -> list[dict[str, Any]]:
        """Every page the device holds, with its content hash.

        *timeout* is settable because this one answer grows with the number of
        pages: a remote carrying a hundred of them needs noticeably longer to
        assemble and send the listing than the default allows, and a timeout
        here is expensive -- the caller cannot tell a slow device from an empty
        one without it.
        """
        result = await self._protocol.send_request("get_pages", timeout=timeout)
        return result.get("pages", [])

    async def set_main_pages(
        self, pages: list[int], *, timeout: float = DEFAULT_REQUEST_TIMEOUT
    ) -> dict[str, Any]:
        """Set the swipe-navigation page order.

        *pages* is a list of ``page_id`` integers; the wire payload wraps each
        one in an object (``{"pages": [{"page_id": 1}, …]}``) so the entry
        shape matches every other page command in the protocol.
        """
        return await self._protocol.send_request(
            "set_main_pages",
            {"pages": [{"page_id": validate_page_id(p)} for p in pages]},
            timeout=timeout,
        )

    async def get_main_pages(self, *, timeout: float = DEFAULT_REQUEST_TIMEOUT) -> list[int]:
        result = await self._protocol.send_request("get_main_pages", timeout=timeout)
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
            self._logger.debug("get_brightness unavailable: %s", err)
        except Exception as err:  # noqa: BLE001
            self._logger.debug("get_brightness failed: %s", err)
        else:
            self._logger.debug(
                "Brightness read: value=%s automatic=%s", value, automatic,
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

        session = device_session(self._hass)
        url = device_url(self._peer_ip, self._device_http_port, endpoint)
        try:
            async with session.request(method, url, **kwargs) as resp:
                return resp.status, await resp.text()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            err_msg = error_detail(err)
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

        self._logger.debug(
            "DemoMode request (%s): %s",
            self._peer_ip,
            control_payload,
        )

        status, text = await self.async_device_control(control_payload)
        self._logger.debug(
            "DemoMode response (%s): HTTP %s body=%r",
            self._peer_ip,
            status,
            text[:300],
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
        self._logger.info("Sending OTA request (%s): %s", self._peer_ip, url)
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

    async def get_ota_reply(self) -> OtaReply:
        """Poll ``GET /Device/OTA``: the status text and the raw reply.

        See :func:`_parse_ota_reply` for the accepted formats. The device
        reports stages only, no percentage.
        """
        _, text = await self._ota_request(
            "GET",
            timeout=ClientTimeout(total=10),
            headers={"Accept": "application/json"},
        )
        text = text.strip()
        return OtaReply(_parse_ota_reply(text), text)

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
                self._logger.warning("WebSocket error: %s", ws.exception())
                break

    def _mac_matches(self, reported: Any) -> bool:
        """Whether the MAC a hello names is the one this socket was admitted as.

        The socket is admitted on the ``device_id`` query parameter (12 hex
        digits); the hello answer carries the same MAC, which some firmware
        writes with colons. A remote that cannot read its MAC sends nothing
        usable, which is not taken as a mismatch.
        """
        expected = self._entry.unique_id
        if not isinstance(reported, str) or not reported or not isinstance(expected, str):
            return True
        if normalise_mac(reported) == normalise_mac(expected):
            return True
        self._logger.error(
            "Hello names device %s, but the connection was opened as %s; "
            "closing it",
            reported, expected,
        )
        return False

    async def _send_hello(self) -> bool:
        """Run the handshake; return whether the connection may be used."""
        try:
            # The remote has just opened this socket, so it is awake: a hello
            # that goes unanswered is a failure, not a doze.
            result = await self._protocol.send_request("hello", {
                "protocol_version": PROTOCOL_VERSION,
            }, wait_while_silent=False)
            if not self._mac_matches(result.get("device_id")):
                return False
            self._hello_ws = self._ws
            self._device_protocol_version = result.get("protocol_version")
            self._device_mac = result.get("device_id")
            self._device_version = result.get("version")
            # `or` rather than a plain assignment: firmware that does not
            # report a model must not erase one an earlier build told us.
            self._device_model_id = result.get("model_id") or self._device_model_id
            self._persist_hello_facts()
            self._logger.info(
                "Hello: id=%s ver=%s proto=%s",
                self._device_mac, self._device_version, self._device_protocol_version,
            )
            if (
                self._device_protocol_version is not None
                and self._device_protocol_version != PROTOCOL_VERSION
            ):
                self._logger.error(
                    "Speaks protocol version %s, Home Assistant speaks %s. "
                    "Some features may not work until the firmware and the "
                    "integration are updated to match.",
                    self._device_protocol_version, PROTOCOL_VERSION,
                )
                issues.async_raise(
                    self._hass, self._entry, issues.PROTOCOL_MISMATCH,
                    device=str(self._device_protocol_version),
                    ha=str(PROTOCOL_VERSION),
                )
            else:
                issues.async_clear(self._hass, self._entry, issues.PROTOCOL_MISMATCH)
            # Notify listeners (e.g. config/panel.py) that hello completed — triggers page sync
            self._hass.bus.async_fire(LIZAIP_HELLO_EVENT, {"entry_id": self._entry.entry_id})
            fire_and_forget(self.async_refresh_brightness())
            if self._peer_ip:
                fire_and_forget(self._probe_device(self._peer_ip))
                fire_and_forget(self._repair_ha_address(self._peer_ip))
        except ProtocolError as err:
            self._logger.error("Hello handshake failed: %s", err)
            return False
        return True

    async def _repair_ha_address(self, peer_ip: str) -> None:
        """Write our address to a device that is not holding one.

        Provisioning is an HTTP request from Home Assistant *to* the remote, so
        it can only happen while the remote is reachable -- and discovery, where
        it used to happen exclusively, is the worst moment to try. A
        battery-powered remote is asleep most of the time and answers nothing,
        and an mDNS record can outlive the address in it, which sends the
        request to a host that is no longer there. Measured on a live install:
        three provisioning attempts in ten minutes, all to an address that had
        stopped answering, while the remote itself was fine.

        Hello is the opposite moment. The remote is demonstrably awake, it chose
        to talk to us, and the socket tells us the address it is really at --
        no mDNS in between. ``_probe_device`` already proves HTTP works there.

        Only an *absent* address is repaired. A remote that holds some other
        value has proved that value works, because it used it to get here; one
        that holds nothing reached us by mDNS and would be stranded the moment
        mDNS stopped working across its network. That is the device this is for,
        and it cannot report the problem itself.
        """
        if not self._device_http_port:
            self._logger.debug("No device HTTP port stored — skipping address repair")
            return

        cfg = await provisioning.async_read_ha_config(
            self._hass, [peer_ip], self._device_http_port
        )
        if cfg is None:
            # Not rounded down to "fine": a device we could not ask is exactly
            # the one that may be sitting there unprovisioned.
            self._logger.debug(
                "Could not read the Home Assistant address at %s", peer_ip,
            )
            return

        # It got here, so whatever it holds works today.
        issues.async_clear(self._hass, self._entry, issues.ADDRESS_LOCKED)

        held = str(cfg.get("ha_hostname") or "").strip()
        if held:
            await self._check_held_address(held)
            return

        self._logger.info(
            "Holds no Home Assistant address — writing ours over its own "
            "connection from %s",
            peer_ip,
        )
        await provisioning.async_provision(
            self._hass, [peer_ip], self._device_http_port
        )

    async def _check_held_address(self, held: str) -> None:
        """Warn when the ``.local`` name the remote holds no longer leads here.

        A connected remote has proved its address -- but for an mDNS name it
        may be living on a cached IP. If the name now resolves somewhere else
        (Home Assistant's host was renamed, another host took the name), the
        remote loses Home Assistant at its next restart, and the firmware only
        takes a different hostname after a factory reset. Saying so while it
        still works is the only warning the user will get.

        Only a name that resolves *elsewhere* counts: one that does not resolve
        from here at all says more about this host's mDNS (a container
        without it, say) than about the remote. DNS names and IPs are left
        alone; a reverse proxy can make either legitimately point elsewhere.
        """
        name = held.rstrip(".")
        if provisioning.is_ip(name) or not name.lower().endswith(provisioning.MDNS_DOMAIN):
            issues.async_clear(self._hass, self._entry, issues.ADDRESS_STALE)
            return
        own_ip = await self._hass.async_add_executor_job(provisioning.local_ip)
        resolved = await self._hass.async_add_executor_job(provisioning.resolve_all, name)
        if not own_ip or not resolved or own_ip in resolved:
            issues.async_clear(self._hass, self._entry, issues.ADDRESS_STALE)
            return
        self._logger.warning(
            "Holds %s, which now resolves to %s, not to this Home Assistant "
            "(%s); it will not find Home Assistant after its next restart",
            held, ", ".join(sorted(resolved)), own_ip,
        )
        issues.async_raise(
            self._hass, self._entry, issues.ADDRESS_STALE,
            held=held, resolved=", ".join(sorted(resolved)), own=own_ip,
        )

    async def _probe_device(self, peer_ip: str) -> None:
        """Query the device's HTTP management API after hello.

        Uses the port from ``entry.data["device_port"]`` (set at provisioning
        from the mDNS SRV record). When no port is stored — e.g. for entries
        created via the WebSocket discovery path — the probe is skipped; the
        capability payload will arrive in the hello handshake instead.
        """
        if not self._device_http_port:
            self._logger.debug("No device HTTP port stored — skipping probe")
            return

        session = device_session(self._hass)
        url = device_url(peer_ip, self._device_http_port, "/api/info")
        info: dict[str, Any] | None = None
        try:
            async with session.get(url, timeout=ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    info = await resp.json(content_type=None)
                    self._logger.debug("Device HTTP port %d confirmed", self._device_http_port)
                else:
                    self._logger.debug("GET %s returned %s", url, resp.status)
        except Exception as err:  # noqa: BLE001
            self._logger.debug("GET %s failed: %s", url, err)

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
        self._logger.info("Capabilities fetched from %s and stored", peer_ip)

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
            self._logger.debug("Device registry update after hello failed: %s", err)

    def _on_hello_request(self, seq_id: int, data: dict) -> None:
        if not self._mac_matches(data.get("device_id")):
            fire_and_forget(self._refuse_hello(seq_id))
            return
        self._device_protocol_version = data.get("protocol_version")
        self._device_mac = data.get("device_id")
        self._device_version = data.get("version")
        self._device_model_id = data.get("model_id") or self._device_model_id
        self._persist_hello_facts()
        fire_and_forget(
            self._protocol.send_response("hello", seq_id, {"protocol_version": PROTOCOL_VERSION})
        )

    async def _refuse_hello(self, seq_id: int) -> None:
        ws = self._ws
        await self._protocol.send_error(
            "hello", seq_id, ERR_CONFLICT, "device_id does not match this connection",
        )
        if ws is not None:
            await ws.close(code=WSCloseCode.POLICY_VIOLATION, message=b"hello failed")

    def _on_get_pages_request(self, seq_id: int, data: dict) -> None:
        """Answer the remote's own ``get_pages`` with an id/hash listing."""
        fire_and_forget(self._answer_page_request("get_pages", seq_id, None))

    def _on_get_page_request(self, seq_id: int, data: dict) -> None:
        """Answer the remote's own ``get_page`` with the page it named."""
        fire_and_forget(self._answer_page_request("get_page", seq_id, data.get("page_id")))

    async def _answer_page_request(
        self, name: str, seq_id: int, page_id: Any
    ) -> None:
        """Build and send the answer to a page query from the remote.

        Each query answers the way it does when HA is the one asking:
        ``get_pages`` lists ``page_id`` and ``hash`` so the remote can see what
        it is missing, ``get_page`` returns the page a sync would have pushed,
        references and all (``media_refs``), so a pulled page costs the remote
        no more heap than a pushed one. A failure is answered rather than
        dropped: the remote is waiting on this ``seq_id`` and would otherwise
        sit out its timeout.
        """
        from ..config.page_requests import async_page_listing, async_page_payloads

        try:
            if name == "get_pages":
                listing = await async_page_listing(self._hass, self._entry)
                await self._protocol.send_response(name, seq_id, {"pages": listing})
                return
            wanted = validate_page_id(page_id)
            pages = await async_page_payloads(self._hass, self._entry, wanted)
        except ProtocolError as err:
            await self._protocol.send_error(name, seq_id, err.code, err.message)
            return
        except Exception as err:
            self._logger.exception("Failed to answer '%s' from the device", name)
            await self._protocol.send_error(name, seq_id, ERR_INTERNAL, str(err))
            return

        if not pages:
            await self._protocol.send_error(
                name, seq_id, ERR_NOT_FOUND, f"Unknown page_id {page_id}",
            )
            return
        await self._protocol.send_response(name, seq_id, with_references(pages[0]))

    def _on_button_event(self, data: dict) -> None:
        self._logger.debug(
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
