"""Reading numbers that arrive as text from a form or the stored options."""
from __future__ import annotations

import math


def to_float(value: object, default: float | None = None) -> float | None:
    """*value* as a finite float, or *default* when it is empty or not a number.

    Form fields arrive as strings, and an emptied one as ``""``, which
    ``float()`` rejects. "inf" and "nan" fall back too: ``float()`` accepts
    them, but the store's JSON cannot hold either.
    """
    if value is None or value == "":
        return default
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return num if math.isfinite(num) else default
