"""A theme: one named set of the defaults a remote draws with.

The look of what a remote shows used to live in four unrelated places -- the
icon-tint palette and the state colours in ``imgserv/const.py``, the title and
tooltip font in the remote's ``settings.yaml``, the default on/off glyphs in
a YAML file of their own. None of them could be moved to another remote,
and three of them were constants in code. A theme is the object that names one
coherent set of those values and can be picked per remote.

A theme sits *below* everything a user has configured::

    built-in defaults -> theme -> settings.yaml -> page default_color
      -> per-button config -> live entity state

so picking one never overrides a choice that was already made; it only replaces
what would otherwise be a constant. The ``default`` theme is where those
values are written: ``assets/themes/default.yaml`` holds the palette, the state
colours, the fonts and the whole icon table, and ``imgserv.const`` and
``icon_defaults`` read them from it. It is what a remote that has picked
nothing gets.

Themes come from two places, the way fonts do (:mod:`imgserv.fonts`): the ones
shipped in ``assets/themes/`` beside the integration, and the ones a user drops into
``<ha_config>/lizaip/themes``. A theme's id is its file name without the
extension, lowercased, and a user file wins an id collision: that is how a
shipped theme is edited, by standing in for it rather than being overwritten.

The registry at the bottom is module state, set once during setup, because
``imgserv`` resolves a ``theme=`` query parameter while drawing and has no
``hass`` to look a theme up with -- the same reason
``const.set_custom_icon_prefixes`` exists.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field, replace
from functools import cached_property
from pathlib import Path
from typing import Any, Final

import yaml

from ..imgserv.const import (
    COLOR_NAMES,
    LEGACY_COLOR_ALIASES,
    PALETTE_NAMES,
    SIZE_IDS,
    TRANSPARENT,
    load_default_theme_file,
)
from ..imgserv.fonts import DEFAULT_FONT_ID
from .icon_defaults import IconDefaults, clean_section, icon_defaults

_LOGGER = logging.getLogger(__name__)

#: The theme a remote that has picked none resolves to. It must reproduce the
#: built-in defaults exactly: a remote set up before themes existed may not
#: change how it looks because the feature arrived.
DEFAULT_THEME_ID: Final = "default"

#: The three independent axes a remote picks separately. A theme file still
#: describes all three, but a remote may take each from a different one.
FACET_NAMES: Final = ("colors", "text", "icons")

#: What joins three ids into the one a URL and a registry lookup carry.
#: A dot cannot appear in a theme id, so splitting is unambiguous.
FACET_SEPARATOR: Final = "."

THEME_EXTENSIONS: Final = (".yaml", ".yml")

#: Shipped with the integration, beside the bundled page templates.
BUNDLED_THEMES_DIR: Final = str(
    Path(__file__).parent.parent / "assets" / "themes"
)

#: Below HA's config directory, next to the per-remote folders and the fonts.
USER_THEMES_SUBDIR: Final = ("lizaip", "themes")

TEXT_KINDS: Final = ("title", "tooltip")

#: The emoji font a theme names under ``text: emoji: font:`` -- a font id, or
#: this for none at all, emoji then drawn in the text font as far as it has
#: them. A theme that names none leaves imgserv to find one, as it always has.
EMOJI_NONE: Final = "none"

#: The colours named for a state rather than a hue, as the Colours tab lists
#: them. ``default`` is what a button whose state says nothing is drawn in. A
#: theme may re-point them; ``?fg=off`` keeps working either way.
STATE_COLOR_NAMES: Final = ("on", "off", "unavailable", "default")

#: State keys a theme file written before the rename may still carry.
LEGACY_STATE_KEYS: Final = LEGACY_COLOR_ALIASES


def state_colors_given(raw: dict) -> dict:
    """A ``colors:`` block's state colours under today's names.

    Older files say ``enabled``/``disabled`` and keep the default colour in a
    ``default_fg`` beside ``states:``; a new name wins over its old spelling.
    """
    given = raw.get("states") if isinstance(raw.get("states"), dict) else {}
    # YAML 1.1 reads an unquoted `on:`/`off:` key as a boolean.
    given = {({True: "on", False: "off"}.get(k, k) if isinstance(k, bool) else k): v
             for k, v in given.items()}
    out = {LEGACY_STATE_KEYS.get(k, k): v for k, v in given.items() if k in LEGACY_STATE_KEYS}
    out.update({k: v for k, v in given.items() if k not in LEGACY_STATE_KEYS})
    if "default" not in out and raw.get("default_fg"):
        out["default"] = raw["default_fg"]
    return {k: v for k, v in out.items() if k in STATE_COLOR_NAMES}

#: The built-in swatches, in display order, as a theme starts out holding them.
DEFAULT_PALETTE: Final = {name: COLOR_NAMES[name] for name in PALETTE_NAMES}

_THEME_ID_RE: Final = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_HEX_RE: Final = re.compile(r"^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")


def is_theme_id(value: Any) -> bool:
    """Whether *value* is a usable theme id, and so a usable file name."""
    return isinstance(value, str) and bool(_THEME_ID_RE.match(value))



def parse_hex(value: Any) -> tuple[int, int, int, int] | None:
    """``RRGGBB`` or ``RRGGBBAA`` as RGBA, or ``None`` when it is neither."""
    if not isinstance(value, str):
        return None
    raw = value.strip().lstrip("#")
    if not _HEX_RE.match(raw):
        return None
    r, g, b = int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)
    a = int(raw[6:8], 16) if len(raw) == 8 else 255
    return (r, g, b, a)


def color_to_hex(rgba: tuple[int, int, int, int]) -> str:
    """The ``RRGGBB`` the panel and ``?fg=`` spell a colour with."""
    return f"{rgba[0]:02X}{rgba[1]:02X}{rgba[2]:02X}"


def theme_id_from_path(path: str) -> str:
    """The id a theme file goes by: its name without the extension, lowercased."""
    return os.path.splitext(os.path.basename(path))[0].lower()


@dataclass(frozen=True)
class Theme:
    """One resolved set of drawing defaults, ready to be read by a renderer."""

    theme_id: str = DEFAULT_THEME_ID
    name: str = "Default"
    source: str = "bundled"
    #: Whether a hand-written user file is standing in for the shipped theme
    #: of this id. The source stays ``bundled``: it is still that theme, read
    #: but never written by the panel.
    modified: bool = False
    #: Every name ``?fg=`` accepts. A theme re-points the ones named for a
    #: state and may add its own; the built-in hues stay literal unless the
    #: whole theme is a ``tint:``, which shades every name at once.
    colors: dict[str, tuple[int, int, int, int]] = field(
        default_factory=lambda: dict(COLOR_NAMES),
    )
    #: The swatches the panel offers, in display order. Held apart from
    #: :attr:`colors` so recolouring what the picker shows cannot quietly
    #: change what a colour name already written into a page resolves to.
    palette_colors: dict[str, tuple[int, int, int, int]] = field(
        default_factory=lambda: dict(DEFAULT_PALETTE),
    )
    text: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {
            kind: {"font": DEFAULT_FONT_ID, "font_size": SIZE_IDS[kind].font_size}
            for kind in TEXT_KINDS
        },
    )
    #: The emoji font (``text: emoji: font:``): a font id, :data:`EMOJI_NONE`,
    #: or ``""`` for imgserv's own choice.
    emoji_font: str = ""
    #: Whether the picker offers this theme as a whole look. A file that
    #: supplies one facet only says ``preset: false``, so picking it never
    #: silently resets the other two.
    preset: bool = True
    #: The theme's own icon overrides, as read from the file. Kept so the panel
    #: can be told what a theme changes; :attr:`icons` is what a renderer reads.
    icon_overrides: dict[str, dict] = field(default_factory=dict)

    @property
    def is_default(self) -> bool:
        return self.theme_id == DEFAULT_THEME_ID

    @cached_property
    def icons(self) -> IconDefaults:
        """The shipped icon table with this theme's overrides laid over it."""
        return icon_defaults.merged(self.icon_overrides)

    @cached_property
    def revision(self) -> str:
        """A short digest of everything this theme draws with.

        The remote and the browser both cache a picture by its address, and
        editing a theme keeps its id: without this in the URL the old pixels
        stay on the screen until the cache gives up on its own.
        """
        material = json.dumps(
            [
                sorted((name, list(rgba)) for name, rgba in self.colors.items()),
                [(name, list(rgba)) for name, rgba in self.palette_colors.items()],
                self.text,
                self.icon_overrides,
                # Only when set: a theme naming none keeps the revision it had.
                *([self.emoji_font] if self.emoji_font else []),
            ],
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(material.encode()).hexdigest()[:8]

    def color(self, name: str) -> tuple[int, int, int, int] | None:
        return self.colors.get(name.lower()) if isinstance(name, str) else None

    def palette(self) -> list[dict[str, str]]:
        """``[{"name", "hex"}]`` -- the swatches the panel offers."""
        return [
            {"name": name, "hex": color_to_hex(rgba)}
            for name, rgba in self.palette_colors.items()
        ]

    def text_style(self, kind: str) -> dict[str, Any]:
        return dict(self.text.get(kind, {}))

    def icon_changes(self) -> list[dict[str, str]]:
        """Every glyph this theme re-points, with the one it replaces.

        Only what the file names, not the merged table: the point is to show
        what picking this theme would change, and the full table is some fifty
        rows the theme has nothing to say about.
        """
        rows: list[dict[str, str]] = []
        for section in IconDefaults.SECTIONS:
            given = self.icon_overrides.get(section)
            if not isinstance(given, dict):
                continue
            shipped = getattr(icon_defaults, section, {})
            for key, value in given.items():
                if isinstance(value, dict):
                    for state, icon in value.items():
                        rows.append({
                            "section": section,
                            "key": f"{key}.{state}",
                            "icon": icon,
                            "was": (shipped.get(key) or {}).get(state, ""),
                        })
                else:
                    rows.append({
                        "section": section,
                        "key": str(key),
                        "icon": value,
                        "was": shipped.get(key, ""),
                    })
        return rows

    def differences(self) -> dict[str, bool]:
        """Which of the three axes this theme actually moves off the default.

        So the panel can say "colours: unchanged" rather than redrawing the
        built-in swatches and leaving the user to spot that nothing moved.
        """
        return {
            "colors": (
                self.colors != DEFAULT_THEME.colors
                or self.palette_colors != DEFAULT_THEME.palette_colors
            ),
            "text": (
                self.text != DEFAULT_THEME.text
                or self.emoji_font != DEFAULT_THEME.emoji_font
            ),
            "icons": bool(self.icon_overrides),
        }

    def as_payload(self) -> dict[str, Any]:
        """What the panel is told about a theme, so its preview matches.

        Without the merged icon table: the panel already asks for that
        separately, and ``get_icon_defaults`` answers it with this theme laid
        over. ``icons`` here is only what the theme itself re-points.
        """
        return {
            "id": self.theme_id,
            "name": self.name,
            "source": self.source,
            "preset": self.preset,
            "colors": {
                "palette": self.palette(),
                "states": {
                    name: color_to_hex(self.colors[name])
                    for name in STATE_COLOR_NAMES
                    if name in self.colors
                },
                "names": {
                    name: color_to_hex(rgba) for name, rgba in self.colors.items()
                },
            },
            "text": {
                **{kind: self.text_style(kind) for kind in TEXT_KINDS},
                "emoji": {"font": self.emoji_font},
            },
            "icons": self.icon_changes(),
            # The same changes as the file holds them, so an editor that only
            # offers some of them can write the rest back untouched.
            "icon_table": copy.deepcopy(self.icon_overrides),
            "changes": self.differences(),
            "facets": dict(zip(FACET_NAMES, split_id(self.theme_id), strict=True)),
        }


def _hex(value: Any, theme_id: str, label: str) -> tuple[int, int, int, int] | None:
    """`parse_hex`, but it says so when a value was given and could not be read.

    Almost always an unquoted hex: YAML reads ``859900`` as a number and
    ``001122`` as octal, so the digits never reach `parse_hex` as written.
    Silently keeping the built-in colour is the one outcome an author cannot
    debug from the panel, which is why this is a warning and not a shrug.
    """
    rgba = parse_hex(value)
    if rgba is None and value is not None:
        _LOGGER.warning(
            "Theme %s: %s is not a hex colour (%r) — quote it, as \"RRGGBB\". "
            "The built-in colour is kept.", theme_id, label, value,
        )
    return rgba


def _shade(rgba: tuple[int, int, int, int], toward_black: float) -> tuple[int, int, int, int]:
    """*rgba* mixed that far toward black, keeping its hue and its alpha."""
    keep = 1.0 - toward_black
    return (
        round(rgba[0] * keep), round(rgba[1] * keep), round(rgba[2] * keep), rgba[3],
    )


#: How far toward black each name sits when a theme names a `tint:`. Names
#: meaning "no colour was asked for" are the tint exactly; the rest descend
#: evenly, and `unavailable` sits lowest so a dead tile is still the dimmest.
TINT_SHADES: Final = {
    "white": 0.0,
    "on": 0.0,
    "default": 0.0,
    "yellow": 0.13,
    "red": 0.25,
    "blue": 0.37,
    "green": 0.49,
    "inactive": 0.64,
    "off": 0.64,
    "unavailable": 0.78,
}


def _apply_tint(
    value: Any, colors: dict, palette: dict, theme_id: str,
) -> tuple[int, int, int, int] | None:
    """Re-point every colour name at a shade of one colour.

    Mixing toward black rather than moving a lightness keeps the hue exactly
    and cannot invert the ramp, so any tint that is visible at all yields a
    readable set. `black` and `transparent` are left alone: neither is a hue.
    Written before the file's own `palette:`/`states:`/`names:` are read, so
    an author can name a tint and still pin one colour by hand.
    """
    rgba = _hex(value, theme_id, "tint")
    if rgba is None:
        return None
    for name, toward_black in TINT_SHADES.items():
        shade = _shade(rgba, toward_black)
        colors[name] = shade
        if name in palette:
            palette[name] = shade
    return rgba


def _parse_colors(
    raw: Any, colors: dict, palette: dict, theme_id: str = "?",
) -> tuple | None:
    """Apply a theme's ``colors:`` block to *colors* and *palette*."""
    if not isinstance(raw, dict):
        return
    given = raw.get("palette")
    if isinstance(given, list):
        ordered: dict[str, tuple] = {}
        for entry in given:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            name = name.strip().lower()
            rgba = _hex(entry.get("hex"), theme_id, f"palette colour {name!r}")
            if rgba is None:
                rgba = palette.get(name)
            if rgba is None:
                continue
            ordered[name] = rgba
            # A slot of the theme's own invention is a name nothing else
            # claims, so ``?fg=`` may have it; a built-in hue it must not.
            # Only ``tint:`` moves those, and it moves all of them at once.
            if name not in COLOR_NAMES:
                colors[name] = rgba
        if ordered:
            palette.clear()
            palette.update(ordered)
    for name, value in state_colors_given(raw).items():
        rgba = _hex(value, theme_id, f"state colour {name!r}")
        if rgba is not None:
            colors[name] = rgba
    extra = raw.get("names")
    if isinstance(extra, dict):
        for name, value in extra.items():
            if not isinstance(name, str) or not name.strip():
                continue
            key = name.strip().lower()
            # A built-in hue is what a page already written asked for by that
            # word, so a theme may add names but not redefine those.
            if key in COLOR_NAMES and key not in STATE_COLOR_NAMES:
                _LOGGER.warning(
                    "theme %s: colour name %r is built in and was not changed",
                    theme_id, key,
                )
                continue
            rgba = _hex(value, theme_id, f"colour name {name!r}")
            if rgba is not None:
                colors[key] = rgba


def _parse_emoji(raw: Any) -> str:
    """The emoji font a ``text:`` block names, ``""`` when it names none."""
    given = raw.get("emoji") if isinstance(raw, dict) else None
    font = given.get("font") if isinstance(given, dict) else None
    return font.strip().lower() if isinstance(font, str) else ""


def _parse_text(raw: Any, text: dict) -> None:
    if not isinstance(raw, dict):
        return
    for kind in TEXT_KINDS:
        given = raw.get(kind)
        if not isinstance(given, dict):
            continue
        font = given.get("font")
        if isinstance(font, str) and font.strip():
            text[kind]["font"] = font.strip().lower()
        size = given.get("font_size")
        if isinstance(size, int) and not isinstance(size, bool) and size > 0:
            text[kind]["font_size"] = size


def _icon_overrides(icons: Any) -> dict[str, dict]:
    """The entries of an ``icons:`` block that differ from the shipped table.

    A row equal to the shipped one changes nothing, so it is dropped: the
    shipped default writes the whole table out and so overrides nothing, and
    its revision -- and with it every default picture address -- stays the one
    it had before the table moved into it.
    """
    if not isinstance(icons, dict):
        return {}
    overrides: dict[str, dict] = {}
    for section in IconDefaults.SECTIONS:
        given = icons.get(section)
        if not isinstance(given, dict):
            continue
        shipped = getattr(icon_defaults, section, {})
        changed: dict = {}
        for key, value in clean_section(given).items():
            base = shipped.get(key)
            if isinstance(value, dict):
                rows = {
                    state: icon for state, icon in value.items()
                    if not isinstance(base, dict) or base.get(state) != icon
                }
                if rows:
                    changed[key] = rows
            elif value != base:
                changed[key] = value
        if changed:
            overrides[section] = changed
    return overrides


def parse_theme(
    theme_id: str, raw: Any, source: str = "user", modified: bool = False,
) -> Theme:
    """A theme file's contents as a :class:`Theme`; anything unusable defaults.

    Tolerant on purpose, the way the settings file reader is: a theme with one
    bad colour draws the rest of itself rather than leaving the remote blank.
    """
    colors = dict(COLOR_NAMES)
    palette = dict(DEFAULT_PALETTE)
    text = {
        kind: {"font": DEFAULT_FONT_ID, "font_size": SIZE_IDS[kind].font_size}
        for kind in TEXT_KINDS
    }
    name = theme_id
    preset = True
    icon_overrides: dict[str, dict] = {}
    emoji_font = ""

    if isinstance(raw, dict):
        given_name = raw.get("name")
        if isinstance(given_name, str) and given_name.strip():
            name = given_name.strip()
        preset = raw.get("preset") is not False
        _apply_tint(raw.get("tint"), colors, palette, theme_id)
        _parse_colors(raw.get("colors"), colors, palette, theme_id)
        _parse_text(raw.get("text"), text)
        emoji_font = _parse_emoji(raw.get("text"))
        icon_overrides = _icon_overrides(raw.get("icons"))

    # `transparent` is not a colour a theme may take away: a part asked for in
    # it renders nothing, and imgserv's own empty canvas is spelled with it.
    colors["transparent"] = TRANSPARENT
    return Theme(
        theme_id=theme_id,
        name=name,
        source=source,
        modified=modified,
        preset=preset,
        colors=colors,
        palette_colors=palette,
        text=text,
        emoji_font=emoji_font,
        icon_overrides=icon_overrides,
    )


#: The default as shipped: ``assets/themes/default.yaml``, the file every
#: built-in value is read from, parsed like any other theme.
DEFAULT_THEME: Final = parse_theme(
    DEFAULT_THEME_ID, load_default_theme_file(), "bundled")


def user_themes_dir(hass) -> str:
    """Where the user's own themes go: ``<ha_config>/lizaip/themes``."""
    return hass.config.path(*USER_THEMES_SUBDIR)


def _theme_files(directory: str | None) -> list[str]:
    if not directory or not os.path.isdir(directory):
        return []
    return sorted(
        os.path.join(directory, f)
        for f in os.listdir(directory)
        if f.lower().endswith(THEME_EXTENSIONS)
        and not f.startswith(".")
        and _THEME_ID_RE.match(theme_id_from_path(f))
    )


def load_themes(user_dir: str | None = None) -> dict[str, Theme]:
    """Every theme that can be picked, by id. Blocking: reads the two folders.

    A hand-written user file wins over a shipped theme of the same id: the
    file in the integration folder is never written, because an update would
    overwrite it. Such a theme keeps its ``bundled`` source and is marked
    :attr:`Theme.modified`; the panel shows it read-only like any shipped
    theme, and deleting the file by hand puts the shipped version back.

    ``default`` is the shipped ``default.yaml``, and a user file may stand in
    for it like any other. The shipped file is the floor every theme is
    parsed onto, so an edited default changes what "no pick" looks like
    without changing what every other theme is layered on.
    """
    themes: dict[str, Theme] = {DEFAULT_THEME_ID: DEFAULT_THEME}
    for source, directory in (("bundled", BUNDLED_THEMES_DIR), ("user", user_dir)):
        for path in _theme_files(directory):
            tid = theme_id_from_path(path)
            shadows = source == "user" and tid in themes
            try:
                with open(path, encoding="utf-8") as handle:
                    raw = yaml.safe_load(handle) or {}
            except Exception:  # noqa: BLE001 - one bad file must not hide the rest
                _LOGGER.exception("Theme %s cannot be read; it is not offered", path)
                continue
            themes[tid] = parse_theme(
                tid, raw, "bundled" if shadows else source, modified=shadows)
    return themes


_themes: dict[str, Theme] = {DEFAULT_THEME_ID: DEFAULT_THEME}

#: Composed themes, by the id they were built from. A composition is pure, so
#: it is built once rather than on every image request; `set_themes` empties
#: this because the parts it holds may have changed on disk.
_composed: dict[str, Theme] = {}


def set_themes(themes: dict[str, Theme]) -> None:
    """Replace the registry. ``default`` is always present.

    A loaded ``default`` wins: it is the user's file standing in for the
    shipped one, exactly as a user file stands in for a shipped theme. The
    shipped default is the floor, used only when no file supplied one.
    """
    _themes.clear()
    _themes[DEFAULT_THEME_ID] = DEFAULT_THEME
    _themes.update({
        tid: t for tid, t in (themes or {}).items() if isinstance(t, Theme)
    })
    _composed.clear()


def split_id(value: Any) -> tuple[str, str, str]:
    """The three facet ids *value* names, as ``(colors, text, icons)``.

    A plain id means all three come from that one theme, which is what every
    remote set up before facets existed says and must keep meaning.
    """
    if not isinstance(value, str) or not value.strip():
        return (DEFAULT_THEME_ID,) * 3
    parts = [p.strip() for p in value.strip().lower().split(FACET_SEPARATOR)]
    if len(parts) == 1:
        return (parts[0] or DEFAULT_THEME_ID,) * 3
    parts = (parts + [DEFAULT_THEME_ID] * 3)[:3]
    return (parts[0] or DEFAULT_THEME_ID, parts[1] or DEFAULT_THEME_ID,
            parts[2] or DEFAULT_THEME_ID)


def compose_id(colors: str, text: str, icons: str) -> str:
    """The one id those three facets go by, collapsed when they agree.

    Collapsing matters beyond tidiness: the id ends up in every image URL, so
    naming the same pixels under both ``monochrome`` and its spelled-out form
    would halve the device's cache for nothing.
    """
    if colors == text == icons:
        return colors
    return FACET_SEPARATOR.join((colors, text, icons))


def compose(colors: str, text: str, icons: str) -> Theme:
    """One theme taking its colours, its text and its icons from three others.

    A facet naming a theme that is not installed falls back to the default
    one, exactly as a whole theme does: the name stays in ``settings.yaml``
    and the look returns the moment the file is put back.
    """
    key = compose_id(colors, text, icons)
    if colors == text == icons:
        return _themes.get(colors, DEFAULT_THEME)
    cached = _composed.get(key)
    if cached is not None:
        return cached
    base = _themes.get(colors, DEFAULT_THEME)
    built = replace(
        base,
        theme_id=key,
        source="composed",
        text=_themes.get(text, DEFAULT_THEME).text,
        emoji_font=_themes.get(text, DEFAULT_THEME).emoji_font,
        icon_overrides=_themes.get(icons, DEFAULT_THEME).icon_overrides,
    )
    # Only a composition of themes that exist is kept: the id reaches here
    # from a `theme=` query, so caching whatever was asked for would let a
    # stream of invented names grow this without bound.
    if all(facet in _themes for facet in (colors, text, icons)):
        _composed[key] = built
    return built


def get_theme(theme_id: Any) -> Theme:
    """The theme *theme_id* names, composing it when it names three."""
    if not isinstance(theme_id, str) or not theme_id.strip():
        return _themes[DEFAULT_THEME_ID]
    wanted = theme_id.strip().lower()
    if FACET_SEPARATOR in wanted:
        return compose(*split_id(wanted))
    return _themes.get(wanted, _themes[DEFAULT_THEME_ID])


def theme_ids() -> set[str]:
    """The ids a remote may be set to."""
    return set(_themes)


def list_themes() -> list[dict[str, Any]]:
    """Every theme the picker offers, each as :meth:`Theme.as_payload`.

    ``default`` first, then the rest by display name. It is pinned because it
    is the look a remote takes when it asks for nothing, rather than a preset
    that happens to sort early.

    Carries each theme's colours, text style and icon changes, not just its
    name, so the panel can show what picking one would do without asking again
    per theme. A handful of themes is a few kilobytes.
    """
    rest = sorted(
        (t for tid, t in _themes.items() if tid != DEFAULT_THEME_ID),
        key=lambda t: (t.name.lower(), t.theme_id),
    )
    return [t.as_payload() for t in (_themes[DEFAULT_THEME_ID], *rest)]
