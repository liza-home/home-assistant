"""How many pages a remote may hold, subpages included.

On by default with 20. Pages already over it stay; only adding more is refused."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Final

from homeassistant.core import HomeAssistant

from ..shared.variables_calc import entry_options

if TYPE_CHECKING:
    from homeassistant.components.websocket_api import ActiveConnection

CONF_MAX_PAGES_ENABLED: Final = "max_pages_enabled"
DEFAULT_MAX_PAGES_ENABLED: Final = True
CONF_MAX_PAGES: Final = "max_pages"
DEFAULT_MAX_PAGES: Final = 20
MAX_PAGES_MIN: Final = 1

PAGE_LIMIT_CODE: Final = "page_limit_reached"


def read_max_pages_enabled(options: object) -> bool:
    """Whether an entry's ``options`` limit its pages. Only a real False turns it off."""
    get = getattr(options, "get", None)
    return get is None or get(CONF_MAX_PAGES_ENABLED) is not False


def read_max_pages(options: object) -> int:
    """The limit an entry's ``options`` hold, the default where they hold none."""
    get = getattr(options, "get", None)
    value = get(CONF_MAX_PAGES) if get is not None else None
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_MAX_PAGES
    return max(value, MAX_PAGES_MIN)


def page_limit(hass: HomeAssistant, entry_id: str) -> int | None:
    """The most pages *entry_id*'s remote may hold, or None for no limit."""
    options = entry_options(hass, entry_id)
    if not read_max_pages_enabled(options):
        return None
    return read_max_pages(options)


def page_room_error(hass: HomeAssistant, entry_id: str, before: int, after: int) -> str | None:
    """Why going from *before* to *after* pages is refused, or None when it fits.

    Only growing past the limit is refused, so a remote already over it stays editable."""
    limit = page_limit(hass, entry_id)
    if limit is not None and after > limit and after > before:
        return f"This remote is limited to {limit} pages"
    return None


def refuse_past_limit(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any], before: int, after: int) -> bool:
    """Answer *msg* with `PAGE_LIMIT_CODE` and return True when *after* pages don't fit."""
    error = page_room_error(hass, msg["entry_id"], before, after)
    if error is not None:
        connection.send_error(msg["id"], PAGE_LIMIT_CODE, error)
    return error is not None
