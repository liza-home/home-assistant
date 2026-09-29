"""Push the panel's configuration at the physical device.

Turns the stored pages, assignments and action library into protocol-compliant
``set_page`` payloads and sends them through ha_integration_device's
``LizaIPConnection``. What each button *looks* like is decided in
:mod:`button_rendering`; this module decides what a page *contains*, whether it
changed since last time (``_compute_page_hash``), and when to ship it.

Usage:
    from . import device_sync as _device_sync_mod

    await _device_sync_mod.sync_config_to_device(hass, entry)
"""
from __future__ import annotations

import hashlib
import json
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from ..const import (
    DOMAIN,
    resolve_icon_url,
    resolve_tooltip_url,
)
from .const import (
    is_valid_page_id,
    step_service,
)
from .button_rendering import (
    _get_service_icons,
    _resolve_button_icon,
    _resolve_button_tooltip,
)
from ..device.services import _selected_entry_ids
from .internal_commands import (
    build_page_context,
    resolve_action as resolve_internal_action,
)

_LOGGER = logging.getLogger(__name__)


def _get_device_connection(hass: HomeAssistant, entry: ConfigEntry):
    """Get the device connection for this config entry."""
    if hasattr(entry, "runtime_data") and entry.runtime_data:
        conn = entry.runtime_data
        if hasattr(conn, "connected"):
            return conn
    return None


def _compute_page_hash(page_data: dict) -> int:
    """Compute a 32-bit hash for a page's content."""
    raw = json.dumps(page_data, sort_keys=True, separators=(",", ":"))
    digest = hashlib.md5(raw.encode()).hexdigest()
    return int(digest[:8], 16)  # 32-bit integer


def step_targets_entry(hass: HomeAssistant, entry: ConfigEntry, config) -> bool:
    """Whether a stored step's target names the remote whose page this is.

    A button lives on one remote, and a device-local action is executed by that
    remote alone — it never reaches Home Assistant, so there is nothing left to
    route it. A step naming a *different* device therefore cannot be run
    locally without navigating the wrong remote, and one naming no device at
    all means "wherever this runs", which here is this remote.

    The target is read through the same resolver the service handler uses, so
    the two cannot form different opinions about what a target names.
    """
    step = config[0] if isinstance(config, list) and config and isinstance(config[0], dict) else {}

    payload: dict = {}
    target = step.get("target")
    if isinstance(target, dict):
        payload.update(target)
    data = step.get("data")
    if isinstance(data, dict) and data.get("config_entry_id"):
        payload["config_entry_id"] = data["config_entry_id"]

    if not payload:
        return True

    selected = _selected_entry_ids(hass, payload)
    return selected is None or entry.entry_id in selected


async def _build_page_payload(
    hass: HomeAssistant,
    entry: ConfigEntry,
    page_id: int,
    page_config: dict,
    all_pages: list[dict] | None = None,
) -> dict:
    """Build a set_page data payload from the store.

    Returns a dict matching the protocol's set_page.data shape:
      {page_id, hash, img_title, buttons: [{name, img_tile, img_tooltip, action}]}

    *all_pages* is every stored page of this device. It is what lets an internal
    command notice that its target is gone; without it such a command is only
    validated, never cross-checked.
    """
    store = hass.data[DOMAIN]["_store"]
    device_id = entry.runtime_data._device_id if hasattr(entry, "runtime_data") else None
    if not device_id:
        return {"page_id": page_id, "img_title": "", "buttons": [], "hash": 0}

    library = await store.async_get_action_library(device_id)
    lib_by_id = {a["id"]: a for a in library if isinstance(a, dict) and "id" in a}

    page_store_id = page_config.get("id", 1)
    assignments = await store.async_get_assignments(device_id, page_store_id)

    internal_context = build_page_context(all_pages)

    # Page-level default icon color (6-char hex, no #)
    page_color = page_config.get("default_color", "")

    # Fetch HA service icons for stateless action fallback
    service_icons = await _get_service_icons(hass)

    # Build buttons array — exclude sliders (they are NOT buttons per the
    # protocol; slider_horizontal / slider_vertical have their own event type).
    buttons = []
    for button_name, assign in assignments.items():
        if not isinstance(assign, dict):
            continue
        if button_name.startswith("slider_"):
            continue

        action_id = assign.get("action_id")
        if not action_id:
            # No action — still resolve per-button image and tooltip if configured
            assign_image = assign.get("image")
            img_tile = resolve_icon_url(assign_image, color=page_color) if assign_image else ""
            buttons.append({
                "name": button_name,
                "img_tile": img_tile,
                "img_tooltip": resolve_tooltip_url(
                    _resolve_button_tooltip({}, assign, hass, entry, internal_context),
                    page_color,
                ),
                "action": {"type": "ha_event", "params": {}},
            })
            continue

        action_def = lib_by_id.get(action_id, {})

        # Resolve images — a button's own stored image is what the panel shows
        # for it (`_resolveButtonIcon` returns `a.image` before deriving
        # anything), so honouring it here is what keeps the two surfaces
        # showing the same glyph.
        #
        # Only a service whose icon genuinely follows the entity may override
        # it, and then only because it has something better to say: the *current*
        # state. This used to ask `is_stateless_service` instead, which is a
        # narrower set -- `media_player.turn_off` is one-way, not stateless, so
        # the device threw the stored image away and re-derived a generic power
        # glyph while the panel kept showing the chosen one.
        #
        # Exception: when the button carries its own payload identity (play_media /
        # select_source), a pinned image that came from a layout may belong to a
        # different media item, so the payload thumbnail wins.
        resolved_icon = _resolve_button_icon(
            action_def, assign, hass, service_icons, internal_context
        )

        # Still needed below, to decide whether the remote runs the command
        # itself or hands it to Home Assistant as a button event.
        svc_full = action_def.get("service", "")
        config = assign.get("config", [])
        internal_service = step_service(config) or svc_full
        step_data = (
            config[0].get("data")
            if isinstance(config, list) and config and isinstance(config[0], dict)
            else None
        )
        _LOGGER.debug(
            "Button %s: action_id=%s, action_def.icon=%s, service=%s, resolved=%s",
            button_name, action_id, action_def.get("icon"), action_def.get("service"), resolved_icon,
        )
        img_tile = resolve_icon_url(resolved_icon, color=page_color)

        # Tooltip: dynamic next-state label
        tooltip_text = _resolve_button_tooltip(
            action_def, assign, hass, entry, internal_context
        )
        img_tooltip = resolve_tooltip_url(tooltip_text, page_color)

        # Determine action type. A device-local ("internal") command is executed
        # by the remote itself; everything else travels to HA as a button event.
        action_type = "ha_event"  # Default — HA handles via automations
        action_params = {}

        internal = resolve_internal_action(
            internal_service, step_data, internal_context
        )
        if internal is not None and not step_targets_entry(hass, entry, config):
            # The command is valid, it just is not this remote's to run. Left
            # as a button event, Home Assistant receives it and calls the
            # service with the target the step actually names.
            internal = ("ha_event", {})
        if internal is not None:
            action_type, action_params = internal

        buttons.append({
            "name": button_name,
            "img_tile": img_tile,
            "img_tooltip": img_tooltip,
            "action": {"type": action_type, "params": action_params},
        })

    # Ensure ALL non-slider button names are present in the payload.
    # The store strips empty buttons from the page file to keep YAMLs lean,
    # but the device uses merge semantics ("incoming fields override, omitted
    # fields keep their current value").  If we omit an empty button the
    # device keeps its previous/default icon for that position.
    ALL_BUTTON_NAMES = (
        ["button_power"]
        + [f"button_{i}" for i in range(1, 13)]
        + ["button_back", "button_voice", "button_volume_up", "button_volume_down"]
    )
    sent_names = {b["name"] for b in buttons}
    for btn_name in ALL_BUTTON_NAMES:
        if btn_name not in sent_names:
            buttons.append({
                "name": btn_name,
                "img_tile": "",
                "img_tooltip": "",
                "action": {"type": "ha_event", "params": {}},
            })

    # Page-level properties — img_title is always a URL to a PNG image
    page_img_title = page_config.get("image", "")
    img_title = resolve_icon_url(page_img_title, size="title", color=page_color) if page_img_title else ""

    page_data = {
        "page_id": page_id,
        "img_title": img_title,
        "buttons": buttons,
    }
    page_data["hash"] = _compute_page_hash(page_data)

    return page_data


async def sync_config_to_device(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Sync the config panel's page configuration to the physical device.

    Uses the protocol commands: get_pages, clear_all/add_page/set_page/set_main_pages.
    Returns True if sync was performed, False if device not available.
    """
    conn = _get_device_connection(hass, entry)
    if conn is None or not conn.connected:
        _LOGGER.debug("Device not connected, skipping sync for %s", entry.title)
        return False

    # Load pages from store
    device_id = entry.runtime_data._device_id if hasattr(entry, "runtime_data") else None
    if not device_id:
        _LOGGER.debug("No device_id for entry %s", entry.entry_id)
        return False
    store = hass.data[DOMAIN]["_store"]
    pages = await store.async_get_pages(device_id)

    # Use cached device state if available; otherwise query the device (first sync after connect)
    if conn._known_page_hashes is None:
        try:
            device_pages = await conn.get_pages()
        except Exception as err:
            _LOGGER.error("Failed to get_pages from device: %s", err)
            device_pages = []
        device_hash_map: dict[int, int] = {p["page_id"]: p.get("hash", 0) for p in device_pages}

        try:
            device_main_pages = await conn.get_main_pages()
        except Exception as err:
            _LOGGER.debug("Failed to get_main_pages from device: %s", err)
            device_main_pages = []
    else:
        device_hash_map = conn._known_page_hashes
        device_main_pages = conn._known_main_pages or []

    # Build desired state
    desired_pages = []
    main_page_ids = []
    for page_config in pages:
        # page_id is a 32-bit unsigned integer, 1…4294967295 (PROTOCOL.md §3).
        # Skip anything invalid (e.g. a hand-edited YAML file) rather than letting
        # one bad page abort the whole sync with a protocol error.
        page_id = page_config.get("id", 1)
        if not is_valid_page_id(page_id):
            _LOGGER.warning(
                "Skipping stored page with invalid page_id %r — must be an integer "
                "in 1…4294967295 (0 is reserved)",
                page_id,
            )
            continue
        page_data = await _build_page_payload(hass, entry, page_id, page_config, pages)
        desired_pages.append(page_data)
        main_page_ids.append(page_id)

    desired_hash_map = {p["page_id"]: p["hash"] for p in desired_pages}
    desired_page_ids = set(desired_hash_map.keys())
    device_page_ids = set(device_hash_map.keys())

    # Determine diff
    pages_to_add = desired_page_ids - device_page_ids
    pages_to_remove = device_page_ids - desired_page_ids
    pages_to_update = {
        pid for pid in desired_page_ids & device_page_ids
        if desired_hash_map[pid] != device_hash_map.get(pid)
    }
    order_changed = device_main_pages != main_page_ids

    if not pages_to_add and not pages_to_remove and not pages_to_update and not order_changed:
        # Populate cache so subsequent syncs skip the device query
        if conn._known_page_hashes is None:
            conn._known_page_hashes = {p["page_id"]: p["hash"] for p in desired_pages}
            conn._known_main_pages = list(main_page_ids)
        _LOGGER.debug("Device pages up to date, no sync needed")
        return True

    _LOGGER.info(
        "Syncing pages: add=%s, remove=%s, update=%s, order_changed=%s",
        pages_to_add, pages_to_remove, pages_to_update, order_changed,
    )

    try:
        # Remove obsolete pages
        for pid in pages_to_remove:
            await conn.del_page(pid)

        # Add new pages
        for pid in pages_to_add:
            await conn.add_page(pid)

        # Update changed pages
        for page_data in desired_pages:
            pid = page_data["page_id"]
            if pid in pages_to_add or pid in pages_to_update:
                await conn.set_page(**page_data)

        # Always send main pages order (covers reorder-only changes too)
        await conn.set_main_pages(main_page_ids)

        # Update cache so subsequent syncs skip the device query
        conn._known_page_hashes = {p["page_id"]: p["hash"] for p in desired_pages}
        for pid in pages_to_remove:
            conn._known_page_hashes.pop(pid, None)
        conn._known_main_pages = list(main_page_ids)

        _LOGGER.info("Page sync complete")
        return True

    except Exception as err:
        _LOGGER.error("Page sync failed: %s", err)
        return False

