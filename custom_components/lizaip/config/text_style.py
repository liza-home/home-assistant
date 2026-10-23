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
    key_repeat:
      delay_ms: 500
      rate: 30

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

#: Off by default: showing memory use costs the remote two HTTP requests per
#: refresh, which is not worth paying for a screen nobody asked to see.
MEMORY_SECTION: Final = "memory"

#: The feature switches, which share one shape: a section holding only
#: ``enabled``. Listed once so the three places that must agree on the set --
#: defaults, the file reader and the editor's validator -- cannot drift apart.
FEATURE_SECTIONS: Final = (LONGTOUCH_SECTION, TOGGLE_SECTION, MEMORY_SECTION)

#: How a button with key repeat repeats while it is held: the pause
#: after the press before the first repeat, and then how many presses a second.
#: A keyboard's own defaults -- long enough that a tap never repeats, fast
#: enough to run a cursor along a row of tiles.
KEY_REPEAT_SECTION: Final = "key_repeat"
DEFAULT_KEY_REPEAT_DELAY_MS: Final = 500
DEFAULT_KEY_REPEAT_RATE: Final = 30
KEY_REPEAT_DELAY_MIN_MS: Final = 100
KEY_REPEAT_DELAY_MAX_MS: Final = 2000
KEY_REPEAT_RATE_MIN: Final = 1
KEY_REPEAT_RATE_MAX: Final = 50

# Smaller than this is unreadable on the remote's screen.
MIN_FONT_SIZE: Final = 6


def default_settings() -> dict[str, dict[str, Any]]:
    settings: dict[str, dict[str, Any]] = {
        kind: {"font": DEFAULT_FONT_ID, "font_size": SIZE_IDS[kind].font_size}
        for kind in TEXT_KINDS
    }
    settings[LONGTOUCH_SECTION] = {"enabled": False}
    settings[TOGGLE_SECTION] = {"enabled": False}
    settings[MEMORY_SECTION] = {"enabled": False}
    settings[KEY_REPEAT_SECTION] = {
        "delay_ms": DEFAULT_KEY_REPEAT_DELAY_MS, "rate": DEFAULT_KEY_REPEAT_RATE,
    }
    return settings


def _key_repeat_value(key: str, value: Any) -> bool:
    """Whether *value* is a usable ``key_repeat`` *key*: a whole number in range."""
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    if key == "delay_ms":
        return KEY_REPEAT_DELAY_MIN_MS <= value <= KEY_REPEAT_DELAY_MAX_MS
    return KEY_REPEAT_RATE_MIN <= value <= KEY_REPEAT_RATE_MAX


def key_repeat_timing(settings: Any) -> tuple[float, float]:
    """``(initial delay, interval)`` in seconds for a held, repeating button."""
    given = settings.get(KEY_REPEAT_SECTION) if isinstance(settings, dict) else None
    given = given if isinstance(given, dict) else {}
    delay = given.get("delay_ms")
    rate = given.get("rate")
    if not _key_repeat_value("delay_ms", delay):
        delay = DEFAULT_KEY_REPEAT_DELAY_MS
    if not _key_repeat_value("rate", rate):
        rate = DEFAULT_KEY_REPEAT_RATE
    return delay / 1000, 1 / rate


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
    if _feature_enabled(raw, MEMORY_SECTION):
        settings[MEMORY_SECTION]["enabled"] = True
    given = raw.get(KEY_REPEAT_SECTION)
    if isinstance(given, dict):
        for key in ("delay_ms", "rate"):
            if _key_repeat_value(key, given.get(key)):
                settings[KEY_REPEAT_SECTION][key] = given[key]
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
    unknown = set(raw) - set(TEXT_KINDS) - set(FEATURE_SECTIONS) - {KEY_REPEAT_SECTION}
    if unknown:
        raise ValueError(f"unknown setting: {', '.join(sorted(unknown))}")
    settings = default_settings()
    if KEY_REPEAT_SECTION in raw:
        given = raw[KEY_REPEAT_SECTION]
        if not isinstance(given, dict) or set(given) - {"delay_ms", "rate"}:
            raise ValueError(f"{KEY_REPEAT_SECTION} must be a mapping of 'delay_ms' and 'rate'")
        for key, value in given.items():
            if not _key_repeat_value(key, value):
                low, high = (
                    (KEY_REPEAT_DELAY_MIN_MS, KEY_REPEAT_DELAY_MAX_MS) if key == "delay_ms"
                    else (KEY_REPEAT_RATE_MIN, KEY_REPEAT_RATE_MAX)
                )
                raise ValueError(f"{KEY_REPEAT_SECTION}: {key} must be a whole number from {low} to {high}")
            settings[KEY_REPEAT_SECTION][key] = value
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
        if kind in FEATURE_SECTIONS or kind == KEY_REPEAT_SECTION:
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
