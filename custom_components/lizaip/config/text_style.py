"""The per-remote text settings: which font and size titles and tooltips use.

Stored as ``settings.yaml`` in the remote's folder::

    title:
      font: filsonsoft-light
      font_size: 48
    tooltip:
      font: filsonsoft-light
      font_size: 24

A remote without the file, or with a value that makes no sense, gets the
defaults -- the same text the remote showed before the settings existed.
"""
from __future__ import annotations

from typing import Any, Final

from ..imgserv.const import SIZE_IDS
from ..imgserv.fonts import DEFAULT_FONT_ID

TEXT_KINDS: Final = ("title", "tooltip")

# Smaller than this is unreadable on the remote's screen.
MIN_FONT_SIZE: Final = 6


def default_settings() -> dict[str, dict[str, Any]]:
    return {
        kind: {"font": DEFAULT_FONT_ID, "font_size": SIZE_IDS[kind].font_size}
        for kind in TEXT_KINDS
    }


def font_size_limits(kind: str) -> tuple[int, int]:
    """The sizes a kind accepts. Larger than its strip would cut the text off."""
    return MIN_FONT_SIZE, SIZE_IDS[kind].height


def _font_size_ok(kind: str, value: Any) -> bool:
    low, high = font_size_limits(kind)
    return isinstance(value, int) and low <= value <= high


def normalize_settings(raw: Any) -> dict[str, dict[str, Any]]:
    """Settings read from disk, with every missing or unusable value defaulted.

    A font that is not installed is kept: the text falls back to the default
    font while it is missing, and comes back once the file is put back.
    """
    settings = default_settings()
    if not isinstance(raw, dict):
        return settings
    for kind in TEXT_KINDS:
        given = raw.get(kind)
        if not isinstance(given, dict):
            continue
        font = given.get("font")
        if isinstance(font, str) and font.strip():
            settings[kind]["font"] = font.strip().lower()
        if _font_size_ok(kind, given.get("font_size")):
            settings[kind]["font_size"] = given["font_size"]
    return settings


def validate_settings(raw: Any, font_ids: set[str]) -> dict[str, dict[str, Any]]:
    """Settings sent by the editor, checked strictly; raises ``ValueError``.

    Unlike a file on disk, a save can say what is wrong, so nothing is
    silently replaced. A kind left out keeps its default.
    """
    if not isinstance(raw, dict):
        raise ValueError("settings must be a mapping")
    unknown = set(raw) - set(TEXT_KINDS)
    if unknown:
        raise ValueError(f"unknown setting: {', '.join(sorted(unknown))}")
    settings = default_settings()
    for kind, given in raw.items():
        if not isinstance(given, dict):
            raise ValueError(f"{kind} must be a mapping")
        unknown = set(given) - {"font", "font_size"}
        if unknown:
            raise ValueError(f"unknown {kind} setting: {', '.join(sorted(unknown))}")
        if "font" in given:
            font = given["font"]
            if not isinstance(font, str) or font.strip().lower() not in font_ids:
                raise ValueError(f"{kind}: font {font!r} is not installed")
            settings[kind]["font"] = font.strip().lower()
        if "font_size" in given:
            if not _font_size_ok(kind, given["font_size"]):
                low, high = font_size_limits(kind)
                raise ValueError(f"{kind}: font size must be a whole number from {low} to {high}")
            settings[kind]["font_size"] = given["font_size"]
    return settings
