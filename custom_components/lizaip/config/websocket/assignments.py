"""The action library and what each button does.

Also previews ``${…}`` variables for the button editor.
"""
from __future__ import annotations

import logging
from typing import Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ...runtime import get_store, remember_panel_language
from ...shared.history import history_entities
from ...shared.i18n import get_ui_language, language_scope, translate_inline
from ...shared.logs import device_id_logger
from ...shared.tokens import (
    entity_token_entities,
    resolve_image_tokens,
    substitute_entity_tokens,
)
from ..blueprint import async_get_blueprint
from ..const import ASSIGNMENTS_SCHEMA, PAGE_ID_SCHEMA
from ..events import fire_config_changed
from .assignment_entry import build_assignment_entry, drop_own_device_target
from ..listeners import refresh_state_listener, schedule_push_rescan
from .common import requires_device, send_failure
from ..access import require_device_access

_LOGGER = logging.getLogger(__name__)


#: A page holds at most a few hundred texts; the cap only stops a runaway caller.
_MAX_VARIABLE_ITEMS: Final = 500


@websocket_api.websocket_command({
    "type": "lizaip_config/resolve_variables",
    vol.Optional("texts", default=list): [vol.All(str, vol.Length(max=2000))],
    vol.Optional("images", default=list): [vol.All(str, vol.Length(max=2000))],
    vol.Optional("entry_id"): str,
})
@require_device_access
@websocket_api.async_response
async def ws_resolve_variables(hass: HomeAssistant, connection, msg: dict) -> None:
    """What ``${…}`` variables read right now, as the remote will print them.

    The panel shows a preview of tooltips, pictures and titles and must not carry
    a second implementation of the rules, so it asks. *texts* are tooltips and
    titles (:func:`substitute_entity_tokens`), *images* are pictures
    (:func:`resolve_image_tokens`, None when a variable has no value). *entities*
    lists every entity the answers read, so the panel knows when to ask again;
    *depends* says which item read which, so it asks again only for those --
    one countdown in one title must not re-ask every variable on every page.
    """
    _reply_variables(hass, connection, msg)


def _reply_variables(hass: HomeAssistant, connection, msg: dict) -> None:
    texts = msg["texts"][:_MAX_VARIABLE_ITEMS]
    images = msg["images"][:_MAX_VARIABLE_ITEMS]
    entities: set[str] = set()
    depends: dict[str, list[str]] = {}
    for item in (*texts, *images):
        read = entity_token_entities(item) | history_entities(item)
        if read:
            depends[item] = sorted(read)
        entities |= read
    # `{translate: …}` reads as the remote the panel shows prints it.
    language = None
    if any("{translate:" in item for item in (*texts, *images)):
        entry_id = msg.get("entry_id")
        entries = getattr(hass, "config_entries", None)
        entry = entries.async_get_entry(entry_id) if entry_id and entries is not None else None
        language = get_ui_language(hass, entry)
    with language_scope(language):
        answer = {
            "texts": {t: substitute_entity_tokens(translate_inline(t), hass) for t in texts},
            "images": {i: resolve_image_tokens(i, hass) for i in images},
            "entities": sorted(entities),
            "depends": depends,
        }
    connection.send_result(msg["id"], answer)


@websocket_api.websocket_command({
    "type": "lizaip_config/get_actions",
    vol.Required("entry_id"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_get_actions(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    store = get_store(hass)
    connection.send_result(msg["id"], {"actions": await store.async_get_action_library(device_id)})


@websocket_api.websocket_command({
    "type": "lizaip_config/save_actions",
    vol.Required("entry_id"): str,
    vol.Required("actions"): list,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_save_actions(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:

    try:
        store = get_store(hass)
        await store.async_set_action_library(device_id, msg["actions"])

        await refresh_state_listener(hass, msg["entry_id"])
        fire_config_changed(hass, msg["entry_id"])

        connection.send_result(msg["id"], {"success": True})
    except Exception as exc:
        send_failure(
            hass, connection, msg, "save_failed", exc,
            logger=_LOGGER, what="Saving the action library",
        )


@websocket_api.websocket_command({
    "type": "lizaip_config/get_assignments",
    vol.Required("entry_id"): str,
    vol.Optional("page_id", default=1): PAGE_ID_SCHEMA,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_get_assignments(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:

    page_id = msg.get("page_id", 1)
    store = get_store(hass)
    assignments = await store.async_get_assignments(device_id, page_id)
    connection.send_result(msg["id"], {"assignments": assignments, "page_id": page_id})


@websocket_api.websocket_command({
    "type": "lizaip_config/get_all_assignments",
    vol.Required("entry_id"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_get_all_assignments(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Every page's assignments in one answer.

    The panel's usage scan -- which action is still used, and where -- needs
    all of them, and used to ask page by page. That is one round trip per
    page on every config change, so the cost of editing anything grew with
    the number of pages; at a hundred pages it was a hundred round trips for
    a single rename.

    Keys are strings because JSON has no integer keys: the client reads them
    back as the strings it sends elsewhere, so page ids are stringified here
    rather than leaving each caller to guess which form it got.
    """
    store = get_store(hass)
    all_assignments = await store.async_get_all_assignments(device_id)
    connection.send_result(msg["id"], {
        "assignments": {str(pid): assigns for pid, assigns in all_assignments.items()},
    })


@websocket_api.websocket_command({
    "type": "lizaip_config/save_assignments",
    vol.Required("entry_id"): str,
    vol.Optional("page_id", default=1): PAGE_ID_SCHEMA,
    vol.Required("assignments"): ASSIGNMENTS_SCHEMA,
    vol.Optional("language"): str,
})
@require_device_access
@websocket_api.async_response
@requires_device
async def ws_save_assignments(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Save a page's button assignments.

    Request payload:
      {type, entry_id, page_id?, language?, assignments: {button_key: assignment}}
    Response:
      {success: true}
    """
    log = device_id_logger(_LOGGER, hass, device_id)
    if "language" in msg:
        remember_panel_language(hass, msg["language"])


    page_id = msg.get("page_id", 1)
    assignments = msg["assignments"]

    try:
        store = get_store(hass)

        blueprint = await async_get_blueprint(hass, msg["entry_id"])
        all_btn_keys = [btn["key"] for btn in blueprint.get("buttons", [])]

        library = await store.async_get_action_library(device_id)
        lib_by_id = {a["id"]: a for a in library if "id" in a}

        # Existing bindings must survive a panel save. The panel rebuilds each
        # button from scratch and only sends the fields it knows about, so a
        # binding it never learned to round-trip would be destroyed the first
        # time a user touched anything on the page.
        stored = await store.async_get_assignments(device_id, page_id) or {}
        full_assignments: dict[str, dict] = {
            btn_key: build_assignment_entry(
                assignments.get(btn_key) or {}, lib_by_id, btn_key,
                stored.get(btn_key),
            )
            for btn_key in all_btn_keys
        }
        # Cosmetic only: a missing registry (test doubles) just leaves the
        # editor-written target in place.
        registry = getattr(hass, "config_entries", None)
        config_entry = registry.async_get_entry(msg["entry_id"]) if registry else None
        for assign in full_assignments.values():
            drop_own_device_target(hass, config_entry, assign)

        await store.async_set_assignments(device_id, page_id, full_assignments)

        fire_config_changed(hass, msg["entry_id"])
        await refresh_state_listener(hass, msg["entry_id"])
        # Re-scan after whole-page saves so push subscriptions match stored bindings.
        schedule_push_rescan(hass, msg["entry_id"])

        log.info(
            "Saved %d assignments (page=%s)", len(full_assignments), page_id,
        )
        connection.send_result(msg["id"], {"success": True})
    except Exception as exc:
        send_failure(
            hass, connection, msg, "save_failed", exc,
            logger=_LOGGER, what="Saving the assignments",
        )
