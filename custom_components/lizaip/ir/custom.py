"""A table of key names and bare IR signals typed or pasted by the user.

One key per line, the name first and the base64 signal after it, separated by
white space, ``:``, ``=``, ``;``, ``,`` or a tab (so a copied spreadsheet or a
``name: code`` list works)::

    power_on   AAAABEEAaIwE...
    power_off  AAAABEEAaIwE...
"""
from __future__ import annotations

import re
from typing import Final

from . import blob as ir_blob

_SPLIT: Final = re.compile(r"[\s:=;,]+")
_NAME_CHARS: Final = re.compile(r"[^a-z0-9]+")


class IrTableError(ValueError):
    """A line of the table could not be read; ``line`` is its 1-based number."""

    def __init__(self, reason: str, line: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.line = line


def slug(name: str) -> str:
    """*name* as a key name: lowercase letters, digits and ``_``."""
    return _NAME_CHARS.sub("_", name.strip().casefold()).strip("_")


def parse_table(text: str) -> dict[str, str]:
    """Key name → base64 signal for every line of *text*; raise :class:`IrTableError`."""
    codes: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p for p in _SPLIT.split(line, maxsplit=1) if p]
        if len(parts) != 2:
            raise IrTableError("line", number)
        name, code = slug(parts[0]), "".join(parts[1].split())
        if not name:
            raise IrTableError("line", number)
        try:
            ir_blob.decode(code)
        except ir_blob.IrBlobError:
            raise IrTableError("code", number) from None
        if name in codes:
            raise IrTableError("duplicate", number)
        codes[name] = code
    if not codes:
        raise IrTableError("empty")
    return codes
