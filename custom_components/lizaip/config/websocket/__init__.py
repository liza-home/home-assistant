"""WebSocket API for the config panel: the ``lizaip_config/*`` commands.

One module per area of the panel:

- ``devices``          -- device list, blueprint, goto/clear pages, diagnostics
- ``people``           -- who a remote is assigned to
- ``assignments``      -- the action library and what each button does
- ``pages``            -- the page list: reorder, edit, duplicate
- ``settings``         -- text style, icon options and the editors' lookups
- ``templates``          -- pages generated from a template, and retargeting them
- ``page_device``      -- a device for a page no template made; saving a page as a template
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
from . import (
    assignments, devices, dynamic, page_device, people, templates, pages, settings,
)


def register_commands(hass: HomeAssistant) -> None:
    """Register every ``lizaip_config/*`` command with Home Assistant."""
    for handler in (
        devices.ws_list_devices,
        devices.ws_subscribe_devices,
        devices.ws_get_blueprint,
        devices.ws_get_features,
        devices.ws_goto_page,
        devices.ws_clear_device_pages,
        devices.ws_build_diagnostics_bundle,
        devices.ws_restore_config,
        people.ws_list_persons,
        people.ws_set_device_users,
        people.ws_set_user_devices,
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
        settings.ws_get_themes,
        settings.ws_save_theme,
        settings.ws_delete_theme,
        settings.ws_export_theme,
        settings.ws_import_theme,
        settings.ws_get_button_tooltips,
        settings.ws_get_slider_controls,
        settings.ws_get_internal_commands,
        templates.ws_list_templates,
        templates.ws_options_fit,
        templates.ws_list_template_devices,
        templates.ws_list_template_config_entries,
        templates.ws_add_template_page,
        templates.ws_retarget_template_page,
        page_device.ws_list_all_devices,
        page_device.ws_assign_page_device,
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
