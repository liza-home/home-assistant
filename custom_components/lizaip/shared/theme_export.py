"""One theme's own file, handed to the panel to be downloaded.

The file is handed over as it sits, not dumped from a parsed theme: a theme
that sets only colours would come back from the parser with every other
field filled in, saying far more than its author did.
"""
from __future__ import annotations

import os

from .theme import BUNDLED_THEMES_DIR, THEME_EXTENSIONS, is_theme_id


def theme_path(user_dir: str, theme_id: str) -> str | None:
    """The file *theme_id* is read from, or ``None``. Blocking.

    The user's folder is tried first: a file there stands in for a shipped
    theme of the same id, so it is the one being drawn with.

    The id is checked rather than trusted: it arrives from the panel, and
    anything but a theme id would join into a path of the caller's choosing.
    """
    if not is_theme_id(theme_id):
        return None
    for directory in (user_dir, BUNDLED_THEMES_DIR):
        for extension in THEME_EXTENSIONS:
            path = os.path.join(directory or "", f"{theme_id}{extension}")
            if os.path.isfile(path):
                return path
    return None


def export_text(user_dir: str, theme_id: str) -> tuple[str, str]:
    """``(filename, text)`` for one theme. Blocking."""
    path = theme_path(user_dir, theme_id)
    if not path:
        raise ValueError(f"no theme called {theme_id!r}")
    with open(path, encoding="utf-8") as handle:
        return os.path.basename(path), handle.read()
