"""lizaIP WebSocket protocol implementation.

Implements the unified message envelope per PROTOCOL.md:
  - type: "request" | "response" | "event"
  - name: command/event name
  - seq_id: 32-bit correlation ID (request/response only)
  - data: payload object
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Coroutine
from typing import Any

from aiohttp import web

_LOGGER = logging.getLogger(__name__)

# Protocol constants
PROTOCOL_VERSION = 1
PING_INTERVAL = 29

# Message types
TYPE_REQUEST = "request"
TYPE_RESPONSE = "response"
TYPE_EVENT = "event"

# Error codes
ERR_BAD_REQUEST = 400
ERR_NOT_FOUND = 404
ERR_CONFLICT = 409
ERR_TOO_LARGE = 413
ERR_RATE_LIMITED = 429
ERR_INTERNAL = 500

# `page_id` bounds — see PROTOCOL.md §3 "Rules". A page_id is a 32-bit UNSIGNED
# integer; 0 is reserved to mean "no page" and is never a valid identifier.
MIN_PAGE_ID = 1
MAX_PAGE_ID = 0xFFFFFFFF

# Background tasks are kept referenced here so they are not garbage-collected
# mid-flight; each task removes itself once it completes.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def fire_and_forget(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """Run a coroutine in the background, holding a strong reference until it finishes."""
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return task


class ProtocolError(Exception):
    """Raised when a protocol-level error occurs."""

    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


def is_valid_page_id(value: Any) -> bool:
    """Return True if *value* is a usable ``page_id``.

    Per PROTOCOL.md §3 "Rules", a ``page_id`` is a 32-bit **unsigned** integer in
    ``1 … 4294967295``. ``0`` is reserved to mean "no page", so it is rejected
    along with negative, fractional, and out-of-range values.

    ``bool`` is excluded explicitly: it subclasses ``int`` in Python, so
    ``True`` would otherwise sneak through as page 1.
    """
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and MIN_PAGE_ID <= value <= MAX_PAGE_ID
    )


def validate_page_id(value: Any) -> int:
    """Return *value* unchanged if it is a valid ``page_id``.

    Raises :exc:`ProtocolError` with code 400 otherwise, matching the error the
    device is required to return for the same input (PROTOCOL.md §9).
    """
    if not is_valid_page_id(value):
        raise ProtocolError(
            ERR_BAD_REQUEST,
            f"Invalid page_id {value!r} — must be an integer in "
            f"{MIN_PAGE_ID}…{MAX_PAGE_ID} (0 is reserved)",
        )
    return value


def _encode(**fields: Any) -> str:
    """Serialise a message envelope to compact JSON."""
    return json.dumps(fields, separators=(",", ":"))


def build_request(name: str, seq_id: int, data: dict | None = None) -> str:
    """Build a JSON request message string."""
    return _encode(type=TYPE_REQUEST, name=name, seq_id=seq_id, data=data or {})


def build_response(name: str, seq_id: int, data: dict | None = None) -> str:
    """Build a successful JSON response message string."""
    return _encode(
        type=TYPE_RESPONSE, name=name, seq_id=seq_id, success=True, data=data or {}
    )


def build_error_response(name: str, seq_id: int, code: int, message: str) -> str:
    """Build an error JSON response message string."""
    return _encode(
        type=TYPE_RESPONSE,
        name=name,
        seq_id=seq_id,
        success=False,
        error={"code": code, "message": message},
    )


def build_event(name: str, data: dict) -> str:
    """Build a JSON event message string (fire-and-forget, no seq_id)."""
    return _encode(type=TYPE_EVENT, name=name, data=data)


def parse_message(raw: str) -> dict:
    """Parse and validate a raw JSON message. Raises ValueError on invalid input."""
    msg = json.loads(raw)
    if not isinstance(msg, dict):
        raise ValueError("Message must be a JSON object")

    msg_type = msg.get("type")
    if msg_type not in (TYPE_REQUEST, TYPE_RESPONSE, TYPE_EVENT):
        raise ValueError(f"Invalid message type: {msg_type}")
    if msg_type in (TYPE_REQUEST, TYPE_EVENT) and "name" not in msg:
        raise ValueError("Missing 'name' field")
    if msg_type in (TYPE_REQUEST, TYPE_RESPONSE) and "seq_id" not in msg:
        raise ValueError("Missing 'seq_id' field")
    if "data" in msg and not isinstance(msg["data"], dict):
        raise ValueError("'data' field must be an object")
    return msg


def resolve_image_url(url: str, ha_hostname: str, ha_port: int) -> str:
    """Resolve image URL schemes.

    - ha://path        → https://<ha_hostname>:<ha_port>/path
      e.g. ha://api/imgserv/mdi:home?size=tile → https://ha.local:8123/api/imgserv/mdi:home?size=tile
    - imgserv://path   → https://<ha_hostname>:<ha_port>/api/imgserv/path
      e.g. imgserv://mdi:home?size=tile → https://ha.local:8123/api/imgserv/mdi:home?size=tile
    - local://path     → unchanged (device resolves locally)
    - http:// / https:// → unchanged
    """
    base = f"https://{ha_hostname}:{ha_port}"
    if url.startswith("ha://"):
        return f"{base}/{url.removeprefix('ha://')}"
    if url.startswith("imgserv://"):
        return f"{base}/api/imgserv/{url.removeprefix('imgserv://')}"
    return url


class SeqIdGenerator:
    """Monotonically increasing 32-bit sequence ID generator.

    Only ever advanced from the HA event loop, so no locking is required.
    """

    def __init__(self) -> None:
        self._counter: int = 0

    async def next(self) -> int:
        self._counter = (self._counter + 1) & 0xFFFFFFFF
        return self._counter



class LizaIPProtocol:
    """Protocol handler for a single lizaIP WebSocket connection.

    Manages seq_id tracking, request/response correlation, and event dispatch.
    Used by LizaIPConnection to communicate with the device.
    """

    def __init__(self) -> None:
        self._seq = SeqIdGenerator()
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._event_handlers: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._request_handlers: dict[str, Callable[[int, dict[str, Any]], Any]] = {}
        self._ws: web.WebSocketResponse | None = None

    def set_ws(self, ws: web.WebSocketResponse | None) -> None:
        """Attach the WebSocket transport."""
        self._ws = ws

    def on_event(self, name: str, handler: Callable[[dict], None]) -> None:
        """Register a handler for device events."""
        self._event_handlers[name] = handler

    def on_request(self, name: str, handler: Callable[[int, dict], Any]) -> None:
        """Register a handler for device-initiated requests (e.g. hello)."""
        self._request_handlers[name] = handler

    # ── Sending ───────────────────────────────────────────────────────────

    async def _send(self, msg: str) -> bool:
        """Write a pre-encoded message; returns False if the transport is gone."""
        if self._ws is None or self._ws.closed:
            return False
        _LOGGER.debug("TX: %s", msg)
        await self._ws.send_str(msg)
        return True

    async def send_request(
        self, name: str, data: dict | None = None, timeout: float = 10.0
    ) -> dict:
        """Send a request and await the correlated response. Returns response data."""
        if self._ws is None or self._ws.closed:
            raise ProtocolError(ERR_INTERNAL, "Not connected")

        seq_id = await self._seq.next()
        future: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        self._pending[seq_id] = future
        try:
            await self._send(build_request(name, seq_id, data))
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise ProtocolError(
                ERR_INTERNAL, f"Timeout waiting for response to '{name}' seq_id={seq_id}"
            ) from None
        finally:
            self._pending.pop(seq_id, None)

    async def send_response(self, name: str, seq_id: int, data: dict | None = None) -> None:
        """Send a successful response."""
        await self._send(build_response(name, seq_id, data))

    async def send_error(self, name: str, seq_id: int, code: int, message: str) -> None:
        """Send an error response."""
        await self._send(build_error_response(name, seq_id, code, message))

    async def send_event(self, name: str, data: dict) -> None:
        """Send a fire-and-forget event."""
        await self._send(build_event(name, data))

    # ── Receiving ─────────────────────────────────────────────────────────

    def handle_raw(self, raw: str) -> None:
        """Process an incoming raw message. Dispatches to appropriate handler."""
        _LOGGER.debug("RX: %s", raw)
        try:
            msg = parse_message(raw)
        except (json.JSONDecodeError, ValueError) as err:
            _LOGGER.warning("Invalid message: %s — %s", raw[:200], err)
            return

        msg_type = msg["type"]

        if msg_type == TYPE_RESPONSE:
            self._handle_response(msg)
        elif msg_type == TYPE_EVENT:
            self._handle_event(msg)
        elif msg_type == TYPE_REQUEST:
            self._handle_request(msg)

    def _handle_response(self, msg: dict) -> None:
        """Match response to pending request."""
        seq_id = msg.get("seq_id")
        future = self._pending.get(seq_id)
        if future is None:
            _LOGGER.warning("Response with unknown seq_id=%s", seq_id)
            return
        if future.done():
            return
        if msg.get("success"):
            future.set_result(msg.get("data", {}))
        else:
            error = msg.get("error", {})
            future.set_exception(
                ProtocolError(
                    error.get("code", ERR_INTERNAL),
                    error.get("message", "Unknown error"),
                )
            )

    def _handle_event(self, msg: dict) -> None:
        """Dispatch event to registered handler."""
        name = msg.get("name", "")
        if handler := self._event_handlers.get(name):
            handler(msg.get("data", {}))
        else:
            _LOGGER.warning("Unhandled device event: %s (data=%s)", name, msg.get("data", {}))

    def _handle_request(self, msg: dict) -> None:
        """Dispatch device-initiated request to registered handler."""
        name = msg.get("name", "")
        seq_id = msg.get("seq_id", 0)
        if handler := self._request_handlers.get(name):
            handler(seq_id, msg.get("data", {}))
        else:
            _LOGGER.warning("Unhandled device request: %s (seq_id=%s, data=%s)", name, seq_id, msg.get("data", {}))
            # Send error for unrecognized commands
            fire_and_forget(
                self.send_error(name, seq_id, ERR_BAD_REQUEST, f"Unknown command: {name}")
            )

