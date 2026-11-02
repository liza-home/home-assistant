"""Dynamic sources: buttons filled from favorites, scenes, scripts and the like."""
from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ...runtime import _get_store
from ...shared.assignment import ASSIGNMENT_DYNAMIC_KEY
from ..const import PAGE_ID_SCHEMA
from ..events import fire_config_changed
from ...config.page_templates import (
    DEFAULT_MAX_ITEMS,
    DEFAULT_TRACKED_FIELDS,
    SOURCES,
    async_resolve_source,
    get_source,
    validate_spec,
    refresh as template_refresh,
)
from .common import (
    EMPTY_BUTTON,
    requires_device,
    schedule_push_rescan,
    send_failure,
)

_LOGGER = logging.getLogger(__name__)


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/browse_media",
    vol.Required("entity_id"): str,
    vol.Optional("media_content_type", default=""): str,
    vol.Optional("media_content_id", default=""): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_browse_media(hass: HomeAssistant, connection, msg: dict) -> None:
    """Browse media and return plain JSON for button assignments."""
    entity_id = msg["entity_id"]
    media_content_type = msg.get("media_content_type", "")
    media_content_id = msg.get("media_content_id", "")

    try:
        from homeassistant.components.media_player import (
            BrowseMedia,
        )
        from homeassistant.components.media_player import (
            async_browse_media as mp_browse,
        )
    except ImportError:
        try:
            from homeassistant.components.media_player import BrowseMedia
            mp_browse = None
        except ImportError:
            connection.send_error(msg["id"], "not_supported", "media_player component not available")
            return

    try:
        if mp_browse:
            result: BrowseMedia = await mp_browse(
                hass, entity_id, media_content_type or None, media_content_id or None,
            )
        else:
            state = hass.states.get(entity_id)
            if not state:
                connection.send_error(msg["id"], "not_found", f"Entity {entity_id} not found")
                return
            component = hass.data.get("media_player")
            if not component:
                connection.send_error(msg["id"], "not_supported", "media_player not loaded")
                return
            entity = component.get_entity(entity_id)
            if not entity or not hasattr(entity, "async_browse_media"):
                connection.send_error(msg["id"], "not_supported", f"{entity_id} doesn't support browse_media")
                return
            result = await entity.async_browse_media(media_content_type or None, media_content_id or None)
    except Exception as exc:
        send_failure(
            hass, connection, msg, "browse_failed", exc,
            logger=_LOGGER, what=f"Browsing media on {entity_id}",
        )
        return

    def _serialize_item(item) -> dict:
        out = {
            "title": item.title or "",
            "media_content_type": item.media_content_type or "",
            "media_content_id": item.media_content_id or "",
            "can_play": getattr(item, "can_play", False),
            "can_expand": getattr(item, "can_expand", False),
            "thumbnail": item.thumbnail or "",
        }
        return out

    items = []
    if hasattr(result, "children") and result.children:
        for child in result.children:
            items.append(_serialize_item(child))

    connection.send_result(msg["id"], {
        "title": result.title or "",
        "media_content_type": result.media_content_type or "",
        "media_content_id": result.media_content_id or "",
        "can_play": getattr(result, "can_play", False),
        "can_expand": getattr(result, "can_expand", False),
        "thumbnail": result.thumbnail or "",
        "children": items,
    })


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/list_dynamic_sources",
})
@websocket_api.require_admin
@websocket_api.callback
def ws_list_dynamic_sources(hass: HomeAssistant, connection, msg: dict) -> None:
    connection.send_result(msg["id"], {
        "sources": [SOURCES[key].describe() for key in sorted(SOURCES)],
        "default_max_items": DEFAULT_MAX_ITEMS,
    })


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/preview_dynamic_source",
    vol.Required("source"): str,
    vol.Optional("spec", default=dict): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_preview_dynamic_source(hass: HomeAssistant, connection, msg: dict) -> None:
    """Preview dynamic-source items without storing a binding."""
    source_id = msg["source"]
    spec = msg.get("spec") or {}

    error = validate_spec(source_id, spec)
    if error:
        connection.send_error(msg["id"], "invalid_spec", error)
        return

    entry = await async_resolve_source(hass, source_id, spec, best_effort=True)
    connection.send_result(msg["id"], {
        "source": source_id,
        "items": [item.as_dict() for item in entry.items],
        "error": entry.error or "",
        "age": int(entry.age()),
    })


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/refresh_dynamic",
    vol.Required("entry_id"): str,
    vol.Optional("page_id"): PAGE_ID_SCHEMA,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_refresh_dynamic(hass: HomeAssistant, connection, msg: dict) -> None:
    try:
        changed = await template_refresh.async_refresh_and_sync(
            hass,
            msg["entry_id"],
            page_id=msg.get("page_id"),
        )
    except Exception as exc:  # noqa: BLE001
        send_failure(
            hass, connection, msg, "refresh_failed", exc,
            logger=_LOGGER, what="Refreshing the dynamic pages",
        )
        return

    connection.send_result(msg["id"], {"success": True, "changed": changed})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/set_dynamic_binding",
    vol.Required("entry_id"): str,
    vol.Optional("page_id", default=1): PAGE_ID_SCHEMA,
    vol.Required("button"): str,
    vol.Required("binding"): vol.Any(dict, None),
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_set_dynamic_binding(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Set one button's dynamic binding; ``binding: null`` detaches without blanking."""

    page_id = msg.get("page_id", 1)
    button = msg["button"]
    binding = msg["binding"]

    if binding is not None:
        source_id = binding.get("source") or ""
        error = validate_spec(source_id, binding.get("spec") or {})
        if error:
            connection.send_error(msg["id"], "invalid_spec", error)
            return
        try:
            index = int(binding.get("index") or 0)
        except (TypeError, ValueError):
            index = 0
        if index < 1:
            connection.send_error(msg["id"], "invalid_spec", "index must be >= 1")
            return

    try:
        store = _get_store(hass)
        assignments = dict(await store.async_get_assignments(device_id, page_id) or {})
        assign = dict(assignments.get(button) or dict(EMPTY_BUTTON))

        if binding is None:
            assign.pop(ASSIGNMENT_DYNAMIC_KEY, None)
        else:
            source = get_source(binding.get("source") or "")
            assign[ASSIGNMENT_DYNAMIC_KEY] = {
                "source": binding.get("source"),
                "spec": binding.get("spec") or {},
                "index": index,
                # Track action only for sources whose items can change service.
                "fields": binding.get("fields") or (
                    source.default_fields if source else list(DEFAULT_TRACKED_FIELDS)
                ),
                "target_entity": binding.get("target_entity") or "",
                "identity": binding.get("identity") or "",
                "stale": False,
            }
        assignments[button] = assign

        await store.async_set_assignments(device_id, page_id, assignments)
        await store.async_recompute_page_hash(device_id, page_id)
    except Exception as exc:  # noqa: BLE001
        send_failure(
            hass, connection, msg, "save_failed", exc,
            logger=_LOGGER, what="Saving the dynamic binding",
        )
        return

    schedule_push_rescan(hass, msg["entry_id"])

    changed = await template_refresh.async_refresh_and_sync(
        hass, msg["entry_id"], page_id=page_id,
    )
    if not changed:
        fire_config_changed(hass, msg["entry_id"])

    connection.send_result(msg["id"], {"success": True})
