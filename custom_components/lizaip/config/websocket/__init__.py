"""WebSocket API for the config panel: the ``lizaip_config/*`` commands.

One module per area of the panel:

- ``devices``          -- device list, blueprint, goto/clear pages, diagnostics
- ``assignments``      -- the action library and what each button does
- ``pages``            -- the page list: reorder, edit, duplicate
- ``settings``         -- text style, icon options and the editors' lookups
- ``layouts``          -- pages generated from a layout, and retargeting them
- ``dynamic``          -- buttons filled from a dynamic source
- ``assignment_entry`` -- validating a button assignment the panel sent
- ``common``           -- helpers the handler modules share

The voluptuous schema on each handler is the wire contract with
``panel/*.js``; responses keep the JSON shapes those views consume.
"""
from __future__ import annotations

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ...runtime import debug_available
from . import assignments, devices, dynamic, layouts, pages, settings


def register_commands(hass: HomeAssistant) -> None:
    """Register every ``lizaip_config/*`` command with Home Assistant."""
    for handler in (
        devices.ws_list_devices,
        devices.ws_get_blueprint,
        devices.ws_get_features,
        devices.ws_goto_page,
        devices.ws_clear_device_pages,
        devices.ws_build_diagnostics_bundle,
        devices.ws_restore_config,
        assignments.ws_get_actions,
        assignments.ws_save_actions,
        assignments.ws_get_assignments,
        assignments.ws_get_all_assignments,
        assignments.ws_save_assignments,
        assignments.ws_resolve_variables,
        pages.ws_get_pages,
        pages.ws_set_pages,
        pages.ws_update_page,
        pages.ws_duplicate_page,
        settings.ws_get_settings,
        settings.ws_set_settings,
        settings.ws_image_urls,
        settings.ws_get_icon_options,
        settings.ws_set_icon_options,
        settings.ws_get_icon_defaults,
        settings.ws_get_palette,
        settings.ws_get_action_labels,
        settings.ws_get_slider_controls,
        settings.ws_get_internal_commands,
        layouts.ws_list_layouts,
        layouts.ws_list_layout_devices,
        layouts.ws_list_layout_config_entries,
        layouts.ws_add_layout_page,
        layouts.ws_retarget_layout_page,
        dynamic.ws_browse_media,
        dynamic.ws_list_dynamic_sources,
        dynamic.ws_preview_dynamic_source,
        dynamic.ws_refresh_dynamic,
        dynamic.ws_set_dynamic_binding,
    ):
        websocket_api.async_register_command(hass, handler)

    # The debug tools are not part of a stable release -- the build strips
    # their files out -- so their absence is normal and must not be an error.
    # Presence of the module is the switch; `ws_get_features` tells the panel
    # the same thing so it can leave the tab out.
    if debug_available():
        from ..debug_websocket import register_debug_commands

        register_debug_commands(hass)
