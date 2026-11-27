"""Comparing remote firmware versions, for templates that depend on one.

A template may say ``min_firmware: 11.4.4`` (the remote must run that or
newer) and/or ``max_firmware: 11.4.4`` (the remote must run something older,
the bound itself excluded). The remote reports its version zero-padded
(``1.0006.00005``) and the release API as a tag (``v1.6.5``); both parse to the
same tuple here.
"""
from __future__ import annotations

import re
from typing import Any

__all__ = ["firmware_allows", "parse_firmware"]

_NUMBER = re.compile(r"\d+")


def parse_firmware(version: Any) -> tuple[int, ...] | None:
    """``(11, 4, 4)`` for ``"v11.4.4"``; ``None`` for anything without a number.

    A suffix such as ``-rc1`` is ignored: a release candidate compares as the
    release it leads up to.
    """
    if not isinstance(version, str):
        return None
    parts: list[int] = []
    for segment in version.strip().lstrip("vV").split("."):
        found = _NUMBER.match(segment)
        if not found:
            break
        parts.append(int(found.group()))
    return tuple(parts) or None


def _pad(a: tuple[int, ...], b: tuple[int, ...]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    size = max(len(a), len(b))
    return a + (0,) * (size - len(a)), b + (0,) * (size - len(b))


def firmware_allows(version: Any, minimum: Any = None, maximum: Any = None) -> bool:
    """Whether firmware *version* is ``>= minimum`` and ``< maximum``.

    A bound that is not given is not checked. With a bound but no known
    version the answer is no: a template that depends on the firmware is not
    offered where the firmware is not known.
    """
    low, high = parse_firmware(minimum), parse_firmware(maximum)
    if low is None and high is None:
        return True
    current = parse_firmware(version)
    if current is None:
        return False
    if low is not None:
        a, b = _pad(current, low)
        if a < b:
            return False
    if high is not None:
        a, b = _pad(current, high)
        if a >= b:
            return False
    return True
