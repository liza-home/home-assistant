"""What a config entry's stored configuration currently looks like.

``build_full_config_payload`` dumps every page, button, label and icon a config
entry holds; ``_fire_config_changed`` puts that dump on the event bus so the
panel and any listening automation see the same picture. Both are pure readers
of the store — neither touches a websocket ``connection``. They lived in
:mod:`websocket` only because that is where the first caller happened to be.

Keeping them here is what makes the package's import graph acyclic. The
websocket module imports ``layouts.refresh`` (to serve the refresh command),
and ``layouts.refresh`` needs to fire the event; routing that through this leaf
module removes the back-edge that used to require importing ``websocket`` as a
bare module object so its attributes resolved late.

:mod:`..runtime`'s ``_get_store`` and ``_resolve_device_id`` are re-exported
here because callers of the snapshot invariably want them too, and because
:mod:`websocket` re-exports this module's whole surface onward.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant

from ..const import resolve_icon_url
from ..runtime import _get_store, _resolve_device_id  # noqa: F401
from .const import CONFIG_CHANGED_EVENT


async def build_full_config_payload(hass: HomeAssistant, entry_id: str) -> dict:
    """Build a full config dump for the ``lizaip_config_config_changed`` event."""
    device_id = _resolve_device_id(hass, entry_id)
    if not device_id:
        return {}

    store = _get_store(hass)
    pages = await store.async_get_pages(device_id)
    library = await store.async_get_action_library(device_id)
    lib_by_id = {a["id"]: a for a in library if "id" in a}

    pages_out: dict[int, dict] = {}
    for page in pages:
        page_id = page.get("id", 1)
        assignments = await store.async_get_assignments(device_id, page_id)
        buttons = []

        for button_key, assign in assignments.items():
            action_id = assign.get("action_id")
            if not action_id:
                continue
            action_def = lib_by_id.get(action_id, {})
            icon = action_def.get("icon", "")
            if icon:
                icon = resolve_icon_url(icon)
            buttons.append({
                "key": button_key,
                "label": assign.get("label") or action_def.get("name", button_key),
                "action_id": action_id,
                "icon": icon,
            })

        pages_out[page_id] = {"image": page.get("image", ""), "hash": page.get("hash", 0), "buttons": buttons}

    return {
        "device_id": device_id,
        "entry_id": entry_id,
        "pages": pages_out,
    }


async def _fire_config_changed(hass: HomeAssistant, entry_id: str) -> None:
    """Fire a config_changed event with the full payload."""
    payload = await build_full_config_payload(hass, entry_id)
    hass.bus.async_fire(CONFIG_CHANGED_EVENT, payload)
