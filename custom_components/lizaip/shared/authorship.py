"""Who wrote a button's steps, and whose permissions a press runs with.

A remote can be configured by people who are not administrators (see
``config/access.py``). Home Assistant enforces its own limits -- admin-only
actions, entity permissions -- only for calls that carry a ``user_id`` in their
``Context``. A press used to run with an empty one, which Home Assistant treats
as the system, so a button a non-admin wrote could do what that person could
not.

Each stored button therefore carries ``AUTHOR_KEY``: the id of the non-admin who
last changed what it runs. A press runs with that user's context; a button
without one runs as before. The stamp is the server's to write. Whatever a
caller sends under the key is discarded, and the stamp is worked out again on
every write:

- a non-admin who changes what a button runs becomes its author;
- an administrator who changes it removes the stamp, vouching for it;
- a write with no user behind it (a rename, a template refresh) and any
  button whose steps did not change keep the stamp they had. Steps that only
  moved to another key keep it too.

A write with no user is the server's own: its buttons come from the store, so
a stamp they carry is kept as well -- that is how a duplicated page keeps its
authors. Changes a request makes only as a side effect (links dropped with a
deleted page, a page copied) run under ``as_system`` for that reason, so an
administrator deleting a page does not vouch for steps nobody looked at.
"""
from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Final

from homeassistant.core import Context, HomeAssistant

#: Stored on a button; never shown or accepted from the panel.
AUTHOR_KEY: Final = "_author"

#: What a button runs. Everything else on it is how it looks.
#: ``dynamic`` is the binding a template refresh rewrites ``config`` from, so
#: changing it changes what the button will run.
_RUNNABLE_KEYS: Final = (
    "config", "before", "after", "toggle", "longtouch", "slider_actions", "overrides",
    "dynamic",
)

#: The user behind the request being handled, or ``None`` for the system.
current_user: ContextVar[Any] = ContextVar("lizaip_current_user", default=None)


@contextmanager
def as_system() -> Iterator[None]:
    """Write as the server: keep stamps rather than set or clear them."""
    token = current_user.set(None)
    try:
        yield
    finally:
        current_user.reset(token)


def _runnable(assign: Mapping) -> str:
    """A comparable digest of what *assign* runs."""
    picked = {k: assign[k] for k in _RUNNABLE_KEYS if k in assign}
    return json.dumps(_without_stamps(picked), sort_keys=True, default=str)


def _without_stamps(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _without_stamps(v) for k, v in value.items() if k != AUTHOR_KEY}
    if isinstance(value, list):
        return [_without_stamps(v) for v in value]
    return value


def _stamped(assign: Mapping, author: str | None) -> dict:
    """*assign* with *author* as its only stamp, nested overrides included."""
    clean = _without_stamps(assign)
    if author:
        clean[AUTHOR_KEY] = author
    return clean


def stamp_page(old: Mapping | None, new: Mapping) -> dict:
    """*new*'s buttons, stamped against *old* by ``current_user``."""
    old = old if isinstance(old, Mapping) else {}
    user = current_user.get()
    # Steps moved or copied from another button keep that button's standing;
    # when the same steps exist with and without a stamp, the stamp wins.
    by_content: dict[str, str | None] = {}
    for prev in old.values():
        if isinstance(prev, Mapping):
            digest = _runnable(prev)
            if prev.get(AUTHOR_KEY) or digest not in by_content:
                by_content[digest] = prev.get(AUTHOR_KEY) or by_content.get(digest)

    stamped: dict = {}
    for key, assign in new.items():
        if not isinstance(assign, Mapping):
            stamped[key] = assign
            continue
        digest = _runnable(assign)
        prev = old.get(key)
        # Only the server's own writes may bring a stamp along.
        brought = assign.get(AUTHOR_KEY) if user is None else None
        unchanged = isinstance(prev, Mapping) and _runnable(prev) == digest
        if unchanged:
            author = prev.get(AUTHOR_KEY) or brought
        elif digest in by_content:
            author = by_content[digest] or brought
        elif user is None:
            author = brought or (prev.get(AUTHOR_KEY) if isinstance(prev, Mapping) else None)
        elif user.is_admin:
            author = None
        else:
            author = user.id
        stamped[key] = _stamped(assign, author)
    return stamped


def stamp_all(page: Mapping, user: Any, *, bound_only: bool = False) -> dict:
    """Every button on *page* as written by *user* (a restore, a retarget).

    *bound_only* limits it to buttons with a ``dynamic`` binding: retargeting a
    page changes what those will be refreshed to, and nothing else.
    """
    author = None if user is None or user.is_admin else user.id
    return {
        key: _stamped(assign, author)
        if isinstance(assign, Mapping) and (not bound_only or assign.get("dynamic"))
        else assign
        for key, assign in page.items()
    }


def author_of(*assigns: Any) -> str | None:
    """The first stamp among *assigns*."""
    for assign in assigns:
        if isinstance(assign, Mapping) and assign.get(AUTHOR_KEY):
            return str(assign[AUTHOR_KEY])
    return None


async def async_press_context(hass: HomeAssistant, author: str | None) -> Context | None:
    """The context a press by *author*'s button runs with; ``None``: do not run.

    A button whose author no longer exists or was disabled does not run: falling
    back to the system would hand it more than its author ever had.
    """
    if not author:
        return Context()
    user = await hass.auth.async_get_user(author)
    if user is None or not user.is_active:
        return None
    return Context(user_id=user.id)
