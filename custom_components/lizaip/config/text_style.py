"""The per-remote settings: which font and size titles and tooltips use,
whether buttons react to a long touch, and whether they may toggle.

Stored as ``settings.yaml`` in the remote's folder::

    title:
      font: filsonsoft-light
      font_size: 48
    tooltip:
      font: filsonsoft-light
      font_size: 24
    longtouch:
      enabled: false
    toggle:
      enabled: false

A remote without the file, or with a value that makes no sense, gets the
defaults -- the same text the remote showed before the settings existed.
"""
from __future__ import annotations

from typing import Any, Final

from ..imgserv.const import SIZE_IDS
from ..imgserv.fonts import DEFAULT_FONT_ID

TEXT_KINDS: Final = ("title", "tooltip")

#: Off by default: with it on, a button with a long touch holds its click back
#: until the finger lifts, which a remote set up before long touch existed
#: should not start doing on its own.
LONGTOUCH_SECTION: Final = "longtouch"

#: Off by default, for the same reason long touch is: a remote set up before
#: toggles existed should look and behave exactly as it did. Nothing is lost by
#: waiting to be asked -- the section is hidden rather than removed, and a block
#: configured earlier stays on disk and comes back the moment this is on again.
TOGGLE_SECTION: Final = "toggle"

#: The feature switches, which share one shape: a section holding only
#: ``enabled``. Listed once so the three places that must agree on the set --
#: defaults, the file reader and the editor's validator -- cannot drift apart.
FEATURE_SECTIONS: Final = (LONGTOUCH_SECTION, TOGGLE_SECTION)

# Smaller than this is unreadable on the remote's screen.
MIN_FONT_SIZE: Final = 6


def default_settings() -> dict[str, dict[str, Any]]:
    settings: dict[str, dict[str, Any]] = {
        kind: {"font": DEFAULT_FONT_ID, "font_size": SIZE_IDS[kind].font_size}
        for kind in TEXT_KINDS
    }
    settings[LONGTOUCH_SECTION] = {"enabled": False}
    settings[TOGGLE_SECTION] = {"enabled": False}
    return settings


def _feature_enabled(settings: Any, section: str) -> bool:
    given = settings.get(section) if isinstance(settings, dict) else None
    return isinstance(given, dict) and given.get("enabled") is True


def longtouch_enabled(settings: Any) -> bool:
    """Whether *settings* turn long touch on for the remote."""
    return _feature_enabled(settings, LONGTOUCH_SECTION)


def toggle_enabled(settings: Any) -> bool:
    """Whether *settings* let this remote's buttons carry a ``toggle`` block.

    Off makes the feature invisible, not absent: the three producers that read
    a toggle at run time (the page payload, the live repaint and the press) are
    handed the button with the block taken off, so it draws and behaves as the
    plain button its ``config`` describes. Nothing is stripped on the way to or
    from the editor, so the configuration survives being switched off and
    returns intact.
    """
    return _feature_enabled(settings, TOGGLE_SECTION)


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
    if longtouch_enabled(raw):
        settings[LONGTOUCH_SECTION]["enabled"] = True
    if toggle_enabled(raw):
        settings[TOGGLE_SECTION]["enabled"] = True
    return settings


def validate_settings(
    raw: Any, font_ids: set[str], current: Any = None,
) -> dict[str, dict[str, Any]]:
    """Settings sent by the editor, checked strictly; raises ``ValueError``.

    Unlike a file on disk, a save can say what is wrong, so nothing is
    silently replaced. A kind left out keeps its default.

    *current* is what the remote has stored, and it exists for one case: a font
    that was installed when it was chosen and is not any more. ``normalize_settings``
    keeps such a font on the way *in* -- the text falls back to the default
    while the file is missing and comes back when it is restored -- so the
    editor is handed it, and sends it back untouched with every save. Refusing
    it there froze the whole card: the remote's two feature switches, which
    have nothing to do with fonts, could not be changed again until the font
    file came back. An unchanged font is therefore kept, exactly as the file
    reader keeps it, while *picking* one that is not installed is still an
    error.
    """
    if not isinstance(raw, dict):
        raise ValueError("settings must be a mapping")
    unknown = set(raw) - set(TEXT_KINDS) - set(FEATURE_SECTIONS)
    if unknown:
        raise ValueError(f"unknown setting: {', '.join(sorted(unknown))}")
    settings = default_settings()
    for section in FEATURE_SECTIONS:
        if section not in raw:
            continue
        given = raw[section]
        if not isinstance(given, dict) or set(given) - {"enabled"}:
            raise ValueError(f"{section} must be a mapping with only 'enabled'")
        if "enabled" in given:
            if not isinstance(given["enabled"], bool):
                raise ValueError(f"{section}: enabled must be true or false")
            settings[section]["enabled"] = given["enabled"]
    for kind, given in raw.items():
        if kind in FEATURE_SECTIONS:
            continue
        if not isinstance(given, dict):
            raise ValueError(f"{kind} must be a mapping")
        unknown = set(given) - {"font", "font_size"}
        if unknown:
            raise ValueError(f"unknown {kind} setting: {', '.join(sorted(unknown))}")
        if "font" in given:
            font = given["font"]
            if not isinstance(font, str):
                raise ValueError(f"{kind}: font {font!r} is not installed")
            font = font.strip().lower()
            kept = current.get(kind, {}).get("font") if isinstance(current, dict) else None
            if font not in font_ids and font != kept:
                raise ValueError(f"{kind}: font {given['font']!r} is not installed")
            settings[kind]["font"] = font
        if "font_size" in given:
            if not _font_size_ok(kind, given["font_size"]):
                low, high = font_size_limits(kind)
                raise ValueError(f"{kind}: font size must be a whole number from {low} to {high}")
            settings[kind]["font_size"] = given["font_size"]
    return settings
