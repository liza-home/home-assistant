"""Writing a theme the panel composed back out to ``<config>/lizaip/themes``.

Kept apart from :mod:`theme`, which stays a pure reader: everything there is
asked a question on every image request, while this module runs only when
somebody presses Save. The split also means a malformed write cannot reach
the render path -- a file that fails to validate here never lands on disk,
and one that lands is read back by the same tolerant parser as a hand-written
one, so the panel and a text editor stay interchangeable.
"""
from __future__ import annotations

import os
import re
from typing import Any

import yaml

from ..imgserv.const import MIN_FONT_SIZE, SIZE_IDS
from .icon_defaults import IconDefaults, clean_section
from .theme import (
    BUNDLED_THEMES_DIR,
    DEFAULT_THEME_ID,
    EMOJI_NONE,
    STATE_COLOR_NAMES,
    state_colors_given,
    TEXT_KINDS,
    THEME_EXTENSIONS,
    is_theme_id,
    parse_hex,
    theme_id_from_path,
)

#: Prepended to every file this module writes, because ``safe_dump`` drops
#: comments and a user opening the folder deserves to know where it came from.
_HEADER = (
    "# lizaIP -- written by the config panel's theme editor.\n"
    "# Hand edits are kept: the file is read by the same parser as a bundled\n"
    "# theme. Delete it to remove the theme from the picker.\n"
)

_NAME_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    """The id a display name goes by. Empty when nothing usable is left."""
    return _NAME_RE.sub("-", str(name or "").strip().lower()).strip("-")


def bundled_ids() -> set[str]:
    """The ids that name a shipped theme, ``default`` included.

    The panel neither creates, edits nor deletes a theme under any of them:
    a shipped theme is only read or copied. ``default`` is listed even if its
    file were missing, because it always exists: the built-in constants stand
    behind it.
    """
    if not os.path.isdir(BUNDLED_THEMES_DIR):
        return {DEFAULT_THEME_ID}
    return {DEFAULT_THEME_ID} | {
        theme_id_from_path(f)
        for f in os.listdir(BUNDLED_THEMES_DIR)
        if f.lower().endswith(THEME_EXTENSIONS)
    }


def _hex(value: Any, label: str) -> str:
    """The colour *value* spells, as ``RRGGBB``, or ``RRGGBBAA`` when it is
    not opaque: a hand-written theme's alpha must survive a panel save."""
    rgba = parse_hex(value)
    if rgba is None:
        raise ValueError(f"{label} is not a colour: {value!r}")
    parts = rgba[:3] if rgba[3] == 255 else rgba
    return "".join(f"{part:02X}" for part in parts)


def _colors(raw: Any) -> dict:
    """The ``colors:`` block, every hex checked and re-spelled uppercase."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    palette = []
    seen: set[str] = set()
    for entry in raw.get("palette") or []:
        if not isinstance(entry, dict):
            continue
        name = slugify(entry.get("name"))
        if not name:
            raise ValueError(f"a swatch has no usable name: {entry!r}")
        # The reader keys the palette by name, so a repeat would not survive
        # the round trip: refusing here says so instead of losing a swatch.
        if name in seen:
            raise ValueError(f"two swatches are both called {name!r}")
        seen.add(name)
        palette.append({"name": name, "hex": _hex(entry.get("hex"), f"swatch {name}")})
    if palette:
        out["palette"] = palette
    given = state_colors_given(raw)
    states = {state: _hex(given[state], state) for state in STATE_COLOR_NAMES if state in given}
    if states:
        out["states"] = states
    return out


def _text(raw: Any, font_ids: set[str]) -> dict:
    """The ``text:`` block. A size past its strip's height would be cut off."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for kind in TEXT_KINDS:
        given = raw.get(kind)
        if not isinstance(given, dict):
            continue
        font = str(given.get("font") or "")
        if font and font_ids and font not in font_ids:
            raise ValueError(f"{kind} names a font that is not installed: {font}")
        size = given.get("font_size")
        ceiling = SIZE_IDS[kind].height
        if not isinstance(size, int) or isinstance(size, bool):
            raise ValueError(f"{kind} font size must be a whole number")
        if not MIN_FONT_SIZE <= size <= ceiling:
            raise ValueError(
                f"{kind} font size must be between {MIN_FONT_SIZE} and {ceiling}")
        out[kind] = {"font": font, "font_size": size} if font else {"font_size": size}
    emoji = raw.get("emoji")
    font = str((emoji or {}).get("font") or "").strip().lower() if isinstance(emoji, dict) else ""
    if font:
        if font != EMOJI_NONE and font_ids and font not in font_ids:
            raise ValueError(f"the emoji font is not installed: {font}")
        out["emoji"] = {"font": font}
    return out


def _icons(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {}
    out = {
        section: cleaned
        for section in IconDefaults.SECTIONS
        if (cleaned := clean_section(raw.get(section)))
    }
    return out


def build_document(raw: Any, font_ids: set[str] | None = None) -> tuple[str, dict]:
    """``(theme_id, mapping)`` for *raw*, or ``ValueError`` saying what is wrong.

    The id comes from an explicit ``id`` when the panel is editing a theme it
    already saved, and from the display name otherwise, so creating one is a
    single field rather than two.
    """
    if not isinstance(raw, dict):
        raise ValueError("a theme must be a mapping")
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("a theme needs a name")
    theme_id = slugify(raw.get("id") or name)
    if not is_theme_id(theme_id):
        raise ValueError(f"{name!r} does not make a usable file name")
    document: dict[str, Any] = {"name": name}
    for key, value in (
        ("colors", _colors(raw.get("colors"))),
        ("text", _text(raw.get("text"), font_ids or set())),
        ("icons", _icons(raw.get("icons"))),
    ):
        if value:
            document[key] = value
    return theme_id, document


def _path(user_dir: str, theme_id: str) -> str:
    return os.path.join(user_dir, f"{theme_id}.yaml")


def _existing_path(user_dir: str, theme_id: str) -> str | None:
    """The file *theme_id* already has, under either extension, or ``None``."""
    for extension in THEME_EXTENSIONS:
        path = os.path.join(user_dir, f"{theme_id}{extension}")
        if os.path.isfile(path):
            return path
    return None


def save_user_theme(user_dir: str, raw: Any, font_ids: set[str] | None = None) -> str:
    """Write *raw* to the user theme folder and return its id. Blocking.

    Creating one refuses an id that is already taken, by a user file or by a
    shipped theme: two themes sharing a name shared a file, so saving the
    second quietly replaced the first. Editing passes the id back and
    overwrites its own file. A shipped theme is never written: it can only be
    copied into a theme of the user's own.
    """
    theme_id, document = build_document(raw, font_ids)
    creating = not str(raw.get("id") or "").strip()
    if theme_id in bundled_ids():
        if creating:
            raise ValueError(f"a theme called {document['name']!r} already exists")
        raise ValueError(f"{theme_id!r} ships with the integration and cannot be changed")
    if creating and _existing_path(user_dir, theme_id):
        raise ValueError(f"a theme called {document['name']!r} already exists")
    os.makedirs(user_dir, exist_ok=True)
    body = yaml.safe_dump(document, sort_keys=False, allow_unicode=True)
    # The file it already has, so an edit to a hand-written `.yml` is written
    # back to that file: a second `.yaml` beside it would be read first and
    # then shadowed by the original, losing the edit for good.
    path = _existing_path(user_dir, theme_id) or _path(user_dir, theme_id)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(_HEADER + body)
    return theme_id


def _free_name(user_dir: str, name: str, taken: set[str]) -> str:
    """*name*, or ``"Name 2"``, ``"Name 3"``... until its id is free: neither a
    loaded theme, a shipped one, nor a file already in *user_dir*."""
    busy = taken | bundled_ids()
    for n in range(1, 1000):
        candidate = name if n == 1 else f"{name} {n}"
        theme_id = slugify(candidate)
        if theme_id not in busy and not _existing_path(user_dir, theme_id):
            return candidate
    raise ValueError(f"too many themes are already called {name!r}")


def import_user_theme(
    user_dir: str,
    text: Any,
    font_ids: set[str] | None = None,
    taken: set[str] | None = None,
) -> str:
    """Save a theme file's *text* as a new theme of the user's own. Blocking.

    It is always a new file: an ``id`` in the text is ignored, and a name whose
    id is in use is taken up a number, so a shipped theme or one of the user's
    own is never written over. A font not installed here is dropped so the
    rest of the theme still arrives. Anything that is not a theme raises
    ``ValueError`` saying why.
    """
    body = str(text or "")
    if not body.strip():
        raise ValueError("the file is empty")
    try:
        raw = yaml.safe_load(body)
    except yaml.YAMLError as err:
        raise ValueError(f"this is not valid YAML: {err}") from err
    if not isinstance(raw, dict):
        raise ValueError("this file is not a theme")
    document = {k: v for k, v in raw.items() if k != "id"}
    name = str(document.get("name") or "").strip()
    if not name:
        raise ValueError("a theme needs a name")
    installed = font_ids or set()
    if isinstance(document.get("text"), dict) and installed:
        document["text"] = {
            kind: ({k: v for k, v in given.items() if k != "font"}
                   if isinstance(given, dict) and given.get("font")
                   and given["font"] not in installed
                   and given["font"] != EMOJI_NONE else given)
            for kind, given in document["text"].items()
        }
    document["name"] = _free_name(user_dir, name, taken or set())
    return save_user_theme(user_dir, document, installed)


def delete_user_theme(user_dir: str, theme_id: Any) -> bool:
    """Drop one user theme file. ``False`` when there was nothing to remove.

    Only a theme of the user's own: a shipped theme, ``default`` included, is
    refused.

    Both extensions are tried: a hand-written ``.yml`` is as valid as the
    ``.yaml`` this module writes, and the picker offers them alike.
    """
    wanted = slugify(theme_id)
    if not is_theme_id(wanted) or wanted in bundled_ids():
        raise ValueError(f"{theme_id!r} is not a theme that may be deleted")
    removed = False
    for extension in THEME_EXTENSIONS:
        path = os.path.join(user_dir, f"{wanted}{extension}")
        if os.path.isfile(path):
            os.remove(path)
            removed = True
    return removed
