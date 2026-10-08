"""Browser icon sets read straight from their files, with no browser involved.

A set such as custom-brand-icons (``phu:``) or hass-hue-icons (``hue:``) is a
JavaScript file under ``<config>/www`` that registers itself with
``window.customIcons["phu"] = {getIcon, ...}`` and carries its shapes as a
literal table::

    var icons = {
      "zwift":[0,0,24,24,"M5.69 3.33C3.65 ..."],
      ...
    };

Reading that table here means imgserv can draw any icon of the set -- also a
name a variable makes up at runtime, ``phu:${sensor.x}`` -- without waiting
for the panel to be opened and upload it. A file whose shapes are not such a
table is left to the panel's upload, as before.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Final

_LOGGER = logging.getLogger(__name__)

#: Big enough for custom-brand-icons (~5 MB), small enough to skip a stray dump.
MAX_FILE_BYTES: Final = 30_000_000
#: How deep below ``www`` a set may live (``www/community/<set>/<file>.js``).
MAX_DEPTH: Final = 3

_REGISTER_RE: Final = re.compile(
    rb"""customIcon(?:s|sets)\s*\[\s*["']([a-z0-9_-]{1,40})["']\s*\]\s*="""
)
_ENTRY_RE: Final = re.compile(
    r'"([A-Za-z0-9_.+-]{1,100})"\s*:\s*\[\s*'
    r"(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*"
    r'"([^"]+)"(?:\s*,\s*"([^"]*)")?'
)

#: A file's shapes: name -> entry (``path``, ``view_box``, ``secondary_path``).
IconTable = dict[str, dict]


def parse_icon_set(text: str) -> IconTable:
    """The ``"name":[x,y,w,h,"path"(,"path2")]`` table of a set file."""
    table: IconTable = {}
    for m in _ENTRY_RE.finditer(text):
        try:
            box = [float(m.group(i)) for i in range(2, 6)]
        except ValueError:
            continue
        entry = {"path": m.group(6), "view_box": box}
        if m.group(7):
            entry["secondary_path"] = m.group(7)
        table[m.group(1)] = entry
    return table


def registered_prefixes(data: bytes) -> set[str]:
    """The sets a file registers with ``window.customIcons[...] =``."""
    return {m.group(1).decode() for m in _REGISTER_RE.finditer(data)}


class IconSetFiles:
    """Every icon set found under ``www``, re-read only when its file changes."""

    def __init__(self, www_dir: str) -> None:
        self._www = www_dir
        #: path -> (mtime, size, {prefix: table})
        self._files: dict[str, tuple[float, int, dict[str, IconTable]]] = {}
        self.sets: dict[str, IconTable] = {}

    def _candidates(self) -> list[str]:
        found = []
        if not os.path.isdir(self._www):
            return found
        base_depth = self._www.rstrip(os.sep).count(os.sep)
        for root, dirs, files in os.walk(self._www):
            if root.count(os.sep) - base_depth >= MAX_DEPTH:
                dirs[:] = []
            found.extend(os.path.join(root, f) for f in files if f.endswith(".js"))
        return found

    def scan(self) -> bool:
        """Re-read new or changed files; ``True`` when the sets changed. Blocking."""
        seen: dict[str, tuple[float, int, dict[str, IconTable]]] = {}
        changed = False
        for path in self._candidates():
            try:
                st = os.stat(path)
            except OSError:
                continue
            old = self._files.get(path)
            if old and old[0] == st.st_mtime and old[1] == st.st_size:
                seen[path] = old
                continue
            changed = True
            seen[path] = (st.st_mtime, st.st_size, self._read(path, st.st_size))
        changed = changed or set(seen) != set(self._files)
        self._files = seen
        if changed:
            sets: dict[str, IconTable] = {}
            for _, _, tables in seen.values():
                for prefix, table in tables.items():
                    sets.setdefault(prefix, {}).update(table)
            self.sets = sets
            _LOGGER.debug("Icon set files: %s", {p: len(t) for p, t in sets.items()})
        return changed

    @staticmethod
    def _read(path: str, size: int) -> dict[str, IconTable]:
        if size > MAX_FILE_BYTES:
            return {}
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            return {}
        prefixes = registered_prefixes(data)
        # One set per file: with two, which shape belongs to which is a guess.
        if len(prefixes) != 1:
            return {}
        table = parse_icon_set(data.decode("utf-8", "replace"))
        return {prefixes.pop(): table} if table else {}

    def get(self, prefix: str, name: str) -> dict | None:
        return self.sets.get(prefix, {}).get(name)
