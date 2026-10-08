"""A record of the WebSocket traffic between HA and one remote.

Kept to answer two questions about a link that misbehaves: how long the remote
takes to answer, and how much of what is sent never gets an answer at all.

Every frame in either direction goes into a bounded ring, and each request's
round trip is timed from the moment it was written to the moment its answer
arrived. A request that times out is remembered for a while, so an answer that
turns up after HA gave up is recognised as *late* -- the frame was not lost,
only slow -- rather than as an unknown reply.

Always on: one small dict per frame is cheap next to the JSON it describes, and
the trouble this exists for is the kind that has already happened by the time
anyone thinks to switch a recorder on. Writing each frame to the HA log is the
part that costs, and that is opt-in (`log_enabled`).

Pre-release builds only: a stable release leaves this file out, like the
other debug tooling, and `protocol` then records nothing.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from typing import Any

#: The logger frames are written to when `log_enabled` is set. Its own name, so
#: the HA log page can be filtered to it and it can be raised without making
#: the rest of the integration chatty.
TRAFFIC_LOGGER = logging.getLogger(f"{__package__}.traffic")

#: Frames kept for the panel. At a frame a second that is a quarter of an hour.
MAX_FRAMES = 1000
#: Round trips kept for the percentiles.
MAX_RTTS = 500
#: Requests that timed out, kept so a late answer can be matched to them.
MAX_EXPIRED = 200
#: A silence from the remote at least this long is counted as a gap. Shorter
#: than one keepalive interval (29 s), so a remote that skips a ping shows up.
SILENCE_GAP = 15.0


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(pct / 100 * (len(ordered) - 1))))
    return ordered[idx]


class TrafficLog:
    """Frames, round trips and losses for one remote's connection."""

    def __init__(self) -> None:
        self.log_enabled = False
        self.reset()

    def reset(self) -> None:
        self.frames: deque[dict[str, Any]] = deque(maxlen=MAX_FRAMES)
        self.rtts: deque[float] = deque(maxlen=MAX_RTTS)
        self._in_flight: dict[int, tuple[str, float]] = {}
        self._expired: dict[int, tuple[str, float]] = {}
        self._last_rx: float | None = None
        self.since = time.time()
        self.counts = {
            "tx": 0, "rx": 0, "tx_bytes": 0, "rx_bytes": 0,
            "requests": 0, "answered": 0, "errors": 0,
            "timeouts": 0, "late": 0, "unmatched": 0, "dropped": 0,
            "connects": 0, "disconnects": 0, "gaps": 0,
        }
        self.max_gap = 0.0

    # ── recording ─────────────────────────────────────────────────────────

    def _add(self, frame: dict[str, Any]) -> None:
        frame["t"] = time.time()
        self.frames.append(frame)
        if self.log_enabled:
            TRAFFIC_LOGGER.info("%s", self.format_frame(frame))

    def tx(self, msg_type: str, name: str, seq_id: int | None, size: int) -> None:
        now = time.monotonic()
        self.counts["tx"] += 1
        self.counts["tx_bytes"] += size
        if msg_type == "request" and seq_id is not None:
            self.counts["requests"] += 1
            self._in_flight[seq_id] = (name, now)
        self._add({"dir": "tx", "type": msg_type, "name": name, "seq": seq_id, "size": size})

    def rx(self, msg: dict[str, Any] | None, size: int, error: str | None = None) -> None:
        """Record a frame from the remote; *msg* is None if it did not parse.

        *error* says why it did not, shown with the frame in the debug window.
        """
        now = time.monotonic()
        self.counts["rx"] += 1
        self.counts["rx_bytes"] += size
        gap = None if self._last_rx is None else now - self._last_rx
        self._last_rx = now
        if gap is not None:
            self.max_gap = max(self.max_gap, gap)
            if gap >= SILENCE_GAP:
                self.counts["gaps"] += 1
        frame: dict[str, Any] = {"dir": "rx", "size": size}
        if gap is not None and gap >= SILENCE_GAP:
            frame["gap_ms"] = round(gap * 1000)
        if msg is None:
            frame.update(type="invalid", name="")
            if error:
                frame["error"] = error
            self._add(frame)
            return
        msg_type = msg.get("type", "")
        seq_id = msg.get("seq_id")
        frame.update(type=msg_type, name=msg.get("name", ""), seq=seq_id)
        if msg_type == "response":
            if not msg.get("success", True):
                self.counts["errors"] += 1
                frame["error"] = (msg.get("error") or {}).get("code")
            if seq_id in self._in_flight:
                name, sent = self._in_flight.pop(seq_id)
                rtt = now - sent
                self.rtts.append(rtt)
                self.counts["answered"] += 1
                frame.update(name=frame["name"] or name, rtt_ms=round(rtt * 1000))
            elif seq_id in self._expired:
                name, sent = self._expired.pop(seq_id)
                self.counts["late"] += 1
                frame.update(name=frame["name"] or name,
                             rtt_ms=round((now - sent) * 1000), late=True)
            else:
                self.counts["unmatched"] += 1
        self._add(frame)

    def timeout(self, seq_id: int) -> None:
        """A request was given up on; an answer may still arrive later."""
        entry = self._in_flight.pop(seq_id, None)
        if entry is None:
            return
        self.counts["timeouts"] += 1
        self._expired[seq_id] = entry
        while len(self._expired) > MAX_EXPIRED:
            self._expired.pop(next(iter(self._expired)))
        self._add({"dir": "--", "type": "timeout", "name": entry[0], "seq": seq_id,
                   "rtt_ms": round((time.monotonic() - entry[1]) * 1000)})

    def abandoned(self, seq_id: int) -> None:
        """A request ended without an answer for another reason (socket gone)."""
        if self._in_flight.pop(seq_id, None) is not None:
            self.counts["dropped"] += 1

    def connection(self, up: bool) -> None:
        self.counts["connects" if up else "disconnects"] += 1
        self._last_rx = None
        self._add({"dir": "--", "type": "connected" if up else "disconnected", "name": ""})

    # ── reporting ─────────────────────────────────────────────────────────

    @staticmethod
    def format_frame(frame: dict[str, Any]) -> str:
        arrow = {"tx": "HA → remote", "rx": "remote → HA"}.get(frame["dir"], "--")
        parts = [arrow, frame.get("type", ""), frame.get("name") or ""]
        if frame.get("seq") is not None:
            parts.append(f"seq={frame['seq']}")
        if frame.get("size") is not None:
            parts.append(f"{frame['size']} B")
        if frame.get("rtt_ms") is not None:
            parts.append(f"{'late ' if frame.get('late') else ''}after {frame['rtt_ms']} ms")
        if frame.get("error") is not None:
            parts.append(f"error {frame['error']}")
        if frame.get("gap_ms") is not None:
            parts.append(f"after {frame['gap_ms']} ms of silence")
        return " ".join(p for p in parts if p)

    def stats(self) -> dict[str, Any]:
        rtts = [r * 1000 for r in self.rtts]
        requests = self.counts["requests"]
        unanswered = self.counts["timeouts"] + self.counts["dropped"]
        lost = max(0, unanswered - self.counts["late"])
        return {
            **self.counts,
            "since": self.since,
            "in_flight": len(self._in_flight),
            "lost": lost,
            "lost_pct": round(100 * lost / requests, 1) if requests else 0.0,
            "max_gap_ms": round(self.max_gap * 1000),
            "rtt_ms": {
                "n": len(rtts),
                "min": round(min(rtts)) if rtts else None,
                "avg": round(sum(rtts) / len(rtts)) if rtts else None,
                "p50": None if not rtts else round(_percentile(rtts, 50)),
                "p95": None if not rtts else round(_percentile(rtts, 95)),
                "max": round(max(rtts)) if rtts else None,
            },
        }

    def snapshot(self, limit: int = 200) -> dict[str, Any]:
        frames = list(self.frames)[-limit:] if limit > 0 else []
        return {"stats": self.stats(), "frames": frames, "log_enabled": self.log_enabled}
