"""Who a remote belongs to: the people list and the assignment itself.

Both are administrators only. Assigning a remote is the act that grants
somebody access to it, so it can never be done by the people it would grant
access to.

The dialog asks for *persons* and stores *user ids*. Persons are what a
household recognises -- a name and a face, the same ones the rest of Home
Assistant shows -- while authorization has only ``connection.user.id`` to match
on. A person with no user account behind them therefore cannot be assigned, and
is reported as such rather than quietly left out of the list.
"""
from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ...const import CONF_ASSIGNED_USERS, DOMAIN
from ..access import (
    assigned_user_ids,
    async_assignable_user_ids,
    async_notify_assignments_changed,
    async_reconcile_sidebar,
    is_assignable_user,
)

_LOGGER = logging.getLogger(__name__)

#: Why a person cannot be given a remote. The panel turns these into a short
#: line under the name; an unknown one degrades to no line rather than to a key.
REASON_NO_USER = "no_user"
REASON_INACTIVE = "inactive"


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_persons",
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_list_persons(hass: HomeAssistant, connection, msg: dict) -> None:
    """Everyone in the household, and whether they can hold a remote.

    Read from the ``person`` entities rather than from the auth provider, so the
    dialog shows the names and faces the rest of Home Assistant does. The user
    behind each one is looked up to say whether they are an administrator --
    who already has every remote -- and whether the account still works.
    """
    users = {user.id: user for user in await hass.auth.async_get_users()}
    persons = []
    for state in hass.states.async_all("person"):
        user_id = state.attributes.get("user_id")
        user = users.get(user_id) if user_id else None
        if is_assignable_user(user):
            reason = None
        elif user is None or user.system_generated:
            reason = REASON_NO_USER
        else:
            reason = REASON_INACTIVE
        persons.append({
            "entity_id": state.entity_id,
            "name": state.attributes.get("friendly_name") or state.entity_id,
            "user_id": user_id if reason is None else None,
            "is_admin": bool(user and user.is_admin),
            "assignable": reason is None,
            "reason": reason,
        })

    persons.sort(key=lambda person: person["name"].casefold())
    connection.send_result(msg["id"], {"persons": persons})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/set_device_users",
    vol.Required("entry_id"): str,
    vol.Required("user_ids"): [str],
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_device_users(hass: HomeAssistant, connection, msg: dict) -> None:
    """Replace the list of people a remote is assigned to.

    Every id is checked against the auth provider and anything that no longer
    resolves is dropped rather than refused: a user deleted since the dialog
    opened is not a reason to lose the rest of the change, and a stale id would
    match nobody anyway.

    The answer carries the list that was actually written, so a panel that sent
    an id which did not survive shows what is true rather than what it asked
    for.
    """
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return

    known = await async_assignable_user_ids(hass)
    user_ids = sorted({uid for uid in msg["user_ids"] if uid in known})

    if user_ids != sorted(assigned_user_ids(entry)):
        _write_assigned(hass, entry, user_ids)
        await _async_assignments_changed(hass)
        _LOGGER.info(
            "Remote %s is now assigned to %d user(s)", entry.entry_id, len(user_ids),
        )

    connection.send_result(msg["id"], {"user_ids": user_ids})


def _write_assigned(hass: HomeAssistant, entry, user_ids: list[str]) -> None:
    """Store *user_ids* as the people *entry* is assigned to.

    Merged rather than replacing, for the same reason the options flow merges:
    `async_update_entry` writes the options wholesale.
    """
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_ASSIGNED_USERS: user_ids},
    )


async def _async_assignments_changed(hass: HomeAssistant) -> None:
    """Bring the sidebar and every open panel in line with the assignments."""
    await async_reconcile_sidebar(hass)
    async_notify_assignments_changed(hass)
