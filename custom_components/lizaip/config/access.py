"""Who may configure which remote.

An administrator configures every remote, as before. Anyone else configures
only the remotes an administrator has assigned to them, and sees nothing else:
the ``lizaip_config/*`` commands below the panel refuse them, the device list
is filtered to what they hold, and the sidebar item stays hidden while they
hold none.

Two layers, because they answer different questions. ``require_device_access``
is the boundary — it is what makes a crafted websocket message fail. The
sidebar pass is only the surface: Home Assistant filters sidebar panels by
``is_admin`` and offers no per-user hook, so lizaIP maintains each non-admin
user's own ``hiddenPanels`` preference instead. A user who un-hides the item
themselves reaches a panel with no remotes in it, never someone else's.

Scoping is panel-level, not entity-level: an assigned user configuring a button
can still target any entity they may already call services on. Home Assistant's
own entity permissions are unchanged.
"""
from __future__ import annotations

import logging
from functools import wraps
from inspect import iscoroutinefunction
from typing import Any, Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send

from ..const import CONF_ASSIGNED_USERS, DOMAIN, PANEL_URL_PATH

_LOGGER = logging.getLogger(__name__)

#: Sent when any remote's list of assigned people changes, so an open panel's
#: device subscription can re-send the caller's own scoped list. A revoked
#: remote has to leave the panel at once rather than at the next reload.
SIGNAL_ASSIGNMENTS_CHANGED = "lizaip_assignments_changed"

#: The frontend's own sidebar preferences, as ``{panelOrder, hiddenPanels}``
#: under the user data key ``sidebar``. Written here on the user's behalf,
#: which is unusual, and read back live: the sidebar subscribes to its own data.
SIDEBAR_USER_DATA_KEY = "sidebar"
HIDDEN_PANELS_FIELD = "hiddenPanels"

_UNAUTHORIZED = "You do not have access to this remote"


def is_assignable_user(user: Any) -> bool:
    """Whether an account can be given a remote at all.

    One definition for the whole integration: the people dialog's list, both
    assignment writes and the sidebar pass all ask this same question, and a
    rule written four times is a rule that drifts. System accounts and disabled
    ones are out; administrators are not, because the dialog shows them as
    already holding everything rather than hiding them.
    """
    return bool(
        user is not None and not user.system_generated and user.is_active
    )


async def async_assignable_user_ids(hass: HomeAssistant) -> set[str]:
    """Every account that may hold a remote, by id."""
    return {user.id for user in await hass.auth.async_get_users()
            if is_assignable_user(user)}


def assigned_user_ids(entry: ConfigEntry) -> frozenset[str]:
    """The Home Assistant user ids a remote is assigned to.

    Stored in the entry's options rather than in the per-device YAML, so that a
    diagnostics bundle does not carry the household's user ids around and a
    configuration restore cannot hand a remote to whoever held it when the
    archive was made.
    """
    raw = entry.options.get(CONF_ASSIGNED_USERS) or ()
    if isinstance(raw, str):
        return frozenset()
    return frozenset(item for item in raw if isinstance(item, str) and item)


def is_admin_user(user: Any) -> bool:
    """Whether *user* is an administrator; ``None`` is not."""
    return bool(getattr(user, "is_admin", False))


def can_access_entry(hass: HomeAssistant, user: Any, entry_id: str | None) -> bool:
    """Whether this user may configure this remote."""
    if user is None or not entry_id:
        return False
    if is_admin_user(user):
        return True
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != DOMAIN:
        return False
    return getattr(user, "id", None) in assigned_user_ids(entry)


def accessible_entry_ids(hass: HomeAssistant, user: Any) -> set[str]:
    """Every lizaIP entry this user may configure."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if is_admin_user(user):
        return {entry.entry_id for entry in entries}
    user_id = getattr(user, "id", None)
    if not user_id:
        return set()
    return {
        entry.entry_id for entry in entries if user_id in assigned_user_ids(entry)
    }


def _guarded(func: Callable, allowed: Callable) -> Callable:
    """*func*, refused with ``unauthorized`` when *allowed* says no.

    Answers rather than raising, so the panel receives the same shaped error it
    does from every other refusal.
    """
    def refused(hass: HomeAssistant, connection, msg: dict) -> bool:
        if allowed(hass, connection, msg):
            return False
        connection.send_error(msg["id"], "unauthorized", _UNAUTHORIZED)
        return True

    if iscoroutinefunction(func):
        @wraps(func)
        async def async_guard(hass: HomeAssistant, connection, msg: dict) -> None:
            if not refused(hass, connection, msg):
                await func(hass, connection, msg)

        return async_guard

    @wraps(func)
    def guard(hass: HomeAssistant, connection, msg: dict) -> None:
        if not refused(hass, connection, msg):
            func(hass, connection, msg)

    return guard


def holds_any_entry(hass: HomeAssistant, user: Any) -> bool:
    """Whether this user has been given a remote at all.

    The floor under every panel command and both HTTP views. Somebody holding
    none has no business in the panel, and several of these replies are the
    device registry's -- the household's devices, areas and config entries.
    """
    return is_admin_user(user) or bool(accessible_entry_ids(hass, user))


def _holds_any(hass: HomeAssistant, connection) -> bool:
    """`holds_any_entry` for a websocket connection."""
    return holds_any_entry(hass, getattr(connection, "user", None))


def require_device_access(func: Callable) -> Callable:
    """Refuse a per-remote command from someone that remote is not assigned to.

    Takes the place of ``@websocket_api.require_admin`` on everything scoped to
    one remote, and sits in the same position: directly under
    ``websocket_command`` and above ``async_response``, so the check runs before
    the handler is scheduled.

    Several of these take ``entry_id`` optionally and answer with a default --
    the blueprint's stock face, the untinted palette. A message naming no
    remote therefore falls back to the floor rather than being let through:
    the answer gives nothing away about one remote, but it is still the
    panel's, and a stranger holding none is refused.
    """
    def allowed(hass: HomeAssistant, connection, msg: dict) -> bool:
        entry_id = msg.get("entry_id")
        if not entry_id:
            return _holds_any(hass, connection)
        return can_access_entry(hass, getattr(connection, "user", None), entry_id)

    return _guarded(func, allowed)


def require_any_device_access(func: Callable) -> Callable:
    """Refuse a command that names no remote from somebody holding none.

    For the catalogues -- the template library, the media sources, the list of
    internal commands -- which belong to no single remote, so there is no entry
    to check against and the floor is the whole check.
    """
    return _guarded(func, lambda hass, connection, msg: _holds_any(hass, connection))


def async_notify_assignments_changed(hass: HomeAssistant) -> None:
    """Tell every open panel that the assignments moved."""
    async_dispatcher_send(hass, SIGNAL_ASSIGNMENTS_CHANGED)


async def async_reconcile_sidebar(hass: HomeAssistant) -> None:
    """Hide or show the sidebar item for every non-admin user.

    Administrators are left alone: the item is theirs either way, and a pass
    that un-hid it for them would undo an administrator who deliberately put it
    away. The cost is that someone promoted to administrator while holding no
    remote keeps the entry lizaIP wrote for them and restores the item once
    through Home Assistant's own sidebar editor.
    """
    assigned: set[str] = set()
    for entry in hass.config_entries.async_entries(DOMAIN):
        assigned |= assigned_user_ids(entry)

    try:
        users = await hass.auth.async_get_users()
    except Exception:  # noqa: BLE001 — a cosmetic pass must never fail its caller
        _LOGGER.exception("Could not read the user list to update the sidebar")
        return

    for user in users:
        if user.is_admin or not is_assignable_user(user):
            continue
        try:
            await _async_set_panel_hidden(hass, user.id, hidden=user.id not in assigned)
        except Exception:  # noqa: BLE001 — one unreadable store is not the rest
            _LOGGER.exception("Could not update the sidebar for a user")


async def _async_set_panel_hidden(
    hass: HomeAssistant, user_id: str, *, hidden: bool
) -> None:
    """Add or remove the panel from one user's hidden sidebar items."""
    # Deferred: `frontend.storage` is not part of the integration's declared
    # dependencies' import surface at module load.
    from homeassistant.components.frontend import storage as frontend_storage  # noqa: PLC0415

    store = await frontend_storage.async_user_store(hass, user_id)
    current = store.data.get(SIDEBAR_USER_DATA_KEY) or {}
    panels = [item for item in (current.get(HIDDEN_PANELS_FIELD) or []) if item]
    if hidden == (PANEL_URL_PATH in panels):
        return

    if hidden:
        panels.append(PANEL_URL_PATH)
    else:
        panels = [item for item in panels if item != PANEL_URL_PATH]

    # Read-modify-write: the same value carries `panelOrder`, the user's own
    # arrangement. An emptied list is dropped rather than stored, because the
    # frontend falls back to the browser's legacy list only while it is absent.
    value = {k: v for k, v in current.items() if k != HIDDEN_PANELS_FIELD}
    if panels:
        value[HIDDEN_PANELS_FIELD] = panels
    await store.async_set_item(SIDEBAR_USER_DATA_KEY, value)
