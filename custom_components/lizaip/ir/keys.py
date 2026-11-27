"""Which key a catalogue signal is.

Ruwido's name-to-id pairing is the same across the whole catalogue, so it is
kept here once.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class IrKey:
    """One catalogue key: its name and its id in the code set blob."""

    name: str
    key_id: int


_KEYS: Final[tuple[IrKey, ...]] = (
    IrKey("power", 1),
    IrKey("number_1", 4),
    IrKey("number_2", 5),
    IrKey("number_3", 6),
    IrKey("number_4", 7),
    IrKey("number_5", 8),
    IrKey("number_6", 9),
    IrKey("number_7", 10),
    IrKey("number_8", 11),
    IrKey("number_9", 12),
    IrKey("number_0", 13),
    IrKey("input", 14),
    IrKey("epg", 16),
    IrKey("info", 18),
    IrKey("subtitle", 19),
    IrKey("cursor_up", 20),
    IrKey("cursor_down", 21),
    IrKey("cursor_left", 22),
    IrKey("cursor_right", 23),
    IrKey("ok", 24),
    IrKey("menu", 25),
    IrKey("exit", 26),
    IrKey("volume_up", 27),
    IrKey("volume_down", 28),
    IrKey("channel_up", 29),
    IrKey("channel_down", 30),
    IrKey("mute", 32),
    IrKey("red", 35),
    IrKey("green", 36),
    IrKey("yellow", 37),
    IrKey("blue", 38),
    IrKey("play", 43),
    IrKey("pause", 44),
    IrKey("stop", 45),
    IrKey("fast_rewind", 46),
    IrKey("fast_forward", 47),
    IrKey("skip_back", 48),
    IrKey("skip_forward", 49),
    IrKey("home", 101),
    IrKey("back", 105),
    IrKey("play_pause", 294),
)

KEYS: Final[dict[str, IrKey]] = {key.name: key for key in _KEYS}
