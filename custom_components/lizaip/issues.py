"""Repair issues a remote raises in Home Assistant's Repairs dashboard.

Each issue is per config entry, so two remotes with the same problem show up
as two entries a user can work through one by one. Raising an issue that is
already open only refreshes its placeholders; clearing one that is not open
is a no-op.
"""
from __future__ import annotations

from typing import Final

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import DOMAIN

#: The remote refused Home Assistant's new address (HTTP 409): it only takes
#: a different hostname after a factory reset.
ADDRESS_LOCKED: Final = "address_locked"
#: The remote is connected, but the ``.local`` name it holds now resolves
#: elsewhere; it will not find Home Assistant after its next restart.
ADDRESS_STALE: Final = "address_stale"
#: The remote speaks a different protocol version than Home Assistant.
PROTOCOL_MISMATCH: Final = "protocol_mismatch"


def _issue_id(issue: str, entry: ConfigEntry) -> str:
    return f"{issue}_{entry.entry_id}"


def async_raise(
    hass: HomeAssistant, entry: ConfigEntry, issue: str, **placeholders: str
) -> None:
    """Open (or refresh) *issue* for *entry*."""
    ir.async_create_issue(
        hass,
        DOMAIN,
        _issue_id(issue, entry),
        is_fixable=False,
        severity=ir.IssueSeverity.ERROR if issue == ADDRESS_LOCKED else ir.IssueSeverity.WARNING,
        translation_key=issue,
        translation_placeholders={"name": entry.title or "lizaIP", **placeholders},
    )


def async_clear(hass: HomeAssistant, entry: ConfigEntry, *issues: str) -> None:
    """Close each of *issues* for *entry* that is open."""
    for issue in issues:
        ir.async_delete_issue(hass, DOMAIN, _issue_id(issue, entry))
