"""Parts of a paginated template page, as the template file spells them.

A page that says ``paginate: <placeholder>`` repeats while that placeholder has
more items than one page shows; each repeat is a *part*. These helpers read a
page definition: which placeholder it repeats over, how many items one part
shows, and the buttons a given part ends up with. Counting the items and
adding or removing parts on a remote is :mod:`.paginate`'s job.
"""
from __future__ import annotations

import re
from typing import Any

__all__ = [
    "DEFAULT_MAX_PARTS",
    "MAX_PARTS_KEY",
    "MORE_PARTS_KEY",
    "NEXT_PART",
    "PAGINATE_KEY",
    "PART_LINKS",
    "PLACEHOLDER_KEY",
    "PREVIOUS_PART",
    "has_more_parts",
    "page_max_parts",
    "page_span",
    "paginated_placeholder",
    "part_buttons",
    "part_items",
    "part_view",
]

#: A page that repeats while its placeholder has more items than it has slots:
#: ``paginate: <placeholder>``. Each repeat -- a *part* -- shows the next run
#: of items, and ``max_parts`` caps how many there may be.
PAGINATE_KEY = "paginate"
MAX_PARTS_KEY = "max_parts"
DEFAULT_MAX_PARTS = 4

#: Link names that point at a paginated page's neighbouring parts. A link to
#: a part that does not exist leaves its button empty; a list of names takes
#: the first that exists (``[previous, remote]``: back a part, else home).
NEXT_PART = "next"
PREVIOUS_PART = "previous"
PART_LINKS = frozenset({NEXT_PART, PREVIOUS_PART})

#: A button that differs on the last part of a paginated page::
#:
#:     button_12:
#:       placeholder: "@app[12]"     # on the last part
#:       more_parts: {goto_page: next, icon: …}   # while another follows
#:
#: Its item shows on the last part only, so twelve items fit one page.
PLACEHOLDER_KEY = "placeholder"
MORE_PARTS_KEY = "more_parts"

_PLACEHOLDER_TOKEN_RE = re.compile(r"@([a-z][a-z0-9_]*)\[(\d+)\]")


def paginated_placeholder(page: dict[str, Any]) -> str:
    """The placeholder a page repeats over, or ``""``."""
    value = page.get(PAGINATE_KEY) if isinstance(page, dict) else None
    return str(value).strip() if isinstance(value, str) else ""


def page_max_parts(page: dict[str, Any]) -> int:
    value = page.get(MAX_PARTS_KEY) if isinstance(page, dict) else None
    return value if isinstance(value, int) and value >= 1 else DEFAULT_MAX_PARTS


def page_span(buttons: dict[str, Any], placeholder: str) -> int:
    """How many items of *placeholder* one part shows: its highest index."""
    span = 0
    for value in _strings_in(buttons):
        for name, index in _PLACEHOLDER_TOKEN_RE.findall(value):
            if name == placeholder:
                span = max(span, int(index))
    return span


def has_more_parts(value: Any) -> bool:
    """Whether a button is one thing on the last part and another before it."""
    return isinstance(value, dict) and MORE_PARTS_KEY in value


def part_view(buttons: dict[str, Any], more_parts: bool) -> dict[str, Any]:
    """*buttons* as one part shows them: a button's ``more_parts:`` while
    another part follows (*more_parts*), its ``placeholder:`` otherwise --
    nothing where it names none."""
    out: dict[str, Any] = {}
    for key, value in buttons.items():
        if isinstance(value, dict) and (MORE_PARTS_KEY in value or PLACEHOLDER_KEY in value):
            use = MORE_PARTS_KEY if more_parts and MORE_PARTS_KEY in value else PLACEHOLDER_KEY
            value = value.get(use, {})
        out[key] = value
    return out


def part_items(buttons: dict[str, Any], placeholder: str) -> tuple[int, int]:
    """``(span, extra)``: the items every part shows, and how many more the
    last one shows on its buttons with ``more_parts:``."""
    every = part_view({k: v for k, v in buttons.items() if not has_more_parts(v)}, False)
    last = {k: v.get(PLACEHOLDER_KEY) for k, v in buttons.items() if has_more_parts(v)}
    span = page_span(every, placeholder)
    return span, max(0, page_span(last, placeholder) - span)


def part_buttons(
    buttons: dict[str, Any], placeholder: str, part: int = 1, *, last: bool = True,
) -> dict[str, Any]:
    """*buttons* as part *part* shows them, the *last* part or one before it.

    A button's ``more_parts:`` or ``placeholder:`` is picked, and each
    ``@placeholder[N]`` moved on by the items the parts before it show.
    """
    span = part_items(buttons, placeholder)[0] if placeholder else 0
    buttons = part_view(buttons, not last)
    if part <= 1 or not placeholder:
        return buttons
    offset = (part - 1) * span

    def shift(value: Any) -> Any:
        if isinstance(value, str):
            return _PLACEHOLDER_TOKEN_RE.sub(
                lambda m: (
                    f"@{m[1]}[{int(m[2]) + offset}]" if m[1] == placeholder else m[0]
                ),
                value,
            )
        if isinstance(value, dict):
            return {k: shift(v) for k, v in value.items()}
        if isinstance(value, list):
            return [shift(v) for v in value]
        return value

    return shift(buttons)


def _strings_in(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings_in(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings_in(v)
