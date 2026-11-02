"""Per-remote settings and the lookups the panel needs to draw its editors.

Text style, icon options, the colour palette, translated action labels,
slider controls and internal commands.
"""
from __future__ import annotations

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from ...action_controller import serialized_controls
from ...const import DOMAIN
from ...imgserv.fonts import list_fonts, user_fonts_dir
from ...runtime import _get_store, _resolve_device_id
from ...shared.i18n import action_labels, get_ui_language
from ...shared.icon_defaults import icon_defaults
from ...shared.icon_urls import resolve_icon_url, resolve_title_url, resolve_tooltip_url
from ...shared.theme import (
    DEFAULT_THEME,
    get_theme,
    list_themes,
    load_themes,
    set_themes,
    user_themes_dir,
)
from ...shared.theme_file import delete_user_theme, import_user_theme, save_user_theme
from ...shared.theme_export import export_text
from ...state_brightness import (
    CONF_ICON_FILL_ENABLED,
    CONF_ICON_FILL_STEP,
    DEFAULT_ICON_FILL_ENABLED,
    DEFAULT_ICON_FILL_STEP,
    ICON_FILL_STEP_MAX,
    ICON_FILL_STEP_MIN,
    read_fill_enabled,
    read_fill_step,
)
from ...state_color import (
    CONF_ICON_COLOR_ENABLED,
    DEFAULT_ICON_COLOR_ENABLED,
    read_color_enabled,
)
from ...shared.variables_calc import (
    CONF_VARIABLES_INTERVAL,
    DEFAULT_VARIABLES_INTERVAL,
    VARIABLES_INTERVAL_MAX,
    VARIABLES_INTERVAL_MIN,
    VARIABLES_INTERVAL_STEP,
    read_variables_interval,
)
from ..events import fire_config_changed
from ..internal_commands import panel_descriptors
from ..text_style import (
    KEY_REPEAT_DELAY_MAX_MS,
    KEY_REPEAT_DELAY_MIN_MS,
    KEY_REPEAT_RATE_MAX,
    KEY_REPEAT_RATE_MIN,
    KEY_REPEAT_SECTION,
    TEXT_KINDS,
    default_settings,
    font_size_limits,
    settings_theme,
    theme_facets,
    validate_settings,
)
from .common import requires_device


def icon_options_for_entry(hass: HomeAssistant, entry_id: str) -> dict:
    """The icon-rendering settings for one entry, as the panel receives them.

    Kept out of the handler so it can be exercised without Home Assistant's
    websocket decorators, which replace the handler with a task-scheduling
    wrapper.

    Always answers: an unknown entry, or one whose options cannot be read,
    yields the default rather than an error, because the default is the right
    value for every entry that has not changed the setting and a panel left
    without a reply renders no preview at all.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    return _icon_options_reply(getattr(entry, "options", None))


def _icon_options_reply(options: object) -> dict:
    """The values plus what the gear tab needs to edit them."""
    return {
        "icon_fill_step": read_fill_step(options),
        "icon_fill_enabled": read_fill_enabled(options),
        "icon_color_enabled": read_color_enabled(options),
        "variables_interval_ms": read_variables_interval(options),
        "defaults": {
            "icon_fill_step": DEFAULT_ICON_FILL_STEP,
            "icon_fill_enabled": DEFAULT_ICON_FILL_ENABLED,
            "icon_color_enabled": DEFAULT_ICON_COLOR_ENABLED,
            "variables_interval_ms": DEFAULT_VARIABLES_INTERVAL,
        },
        "limits": {
            "icon_fill_step": {"min": ICON_FILL_STEP_MIN, "max": ICON_FILL_STEP_MAX},
            "variables_interval_ms": {
                "min": VARIABLES_INTERVAL_MIN,
                "max": VARIABLES_INTERVAL_MAX,
                "step": VARIABLES_INTERVAL_STEP,
            },
        },
    }


def set_icon_options_for_entry(hass: HomeAssistant, entry_id: str, changes: dict) -> dict:
    """Save the icon options named in *changes*; returns the new reply.

    Stored in ``entry.options`` as before the gear tab took it over, so every
    reader keeps working and no migration is needed. The options update fires
    the entry's update listener, which resyncs the remote with the new values.

    A partial update, so one field can be changed without the caller sending
    back the two it is not touching and clobbering a concurrent change.

    Raises ``KeyError`` for an unknown entry and ``ValueError`` for a bad step
    or a non-boolean switch -- strictly, unlike `read_fill_step`, because a
    typo should be refused, not silently clamped.
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None:
        raise KeyError(entry_id)

    updates: dict = {}
    if CONF_ICON_FILL_STEP in changes:
        fill_step = changes[CONF_ICON_FILL_STEP]
        # bool is an int subclass; JSON `true` must not pass as 1.
        if (
            isinstance(fill_step, bool)
            or not isinstance(fill_step, int)
            or not ICON_FILL_STEP_MIN <= fill_step <= ICON_FILL_STEP_MAX
        ):
            raise ValueError(
                f"icon_fill_step must be a whole number from "
                f"{ICON_FILL_STEP_MIN} to {ICON_FILL_STEP_MAX}"
            )
        updates[CONF_ICON_FILL_STEP] = fill_step

    if CONF_VARIABLES_INTERVAL in changes:
        interval = changes[CONF_VARIABLES_INTERVAL]
        if (
            isinstance(interval, bool)
            or not isinstance(interval, int)
            or not VARIABLES_INTERVAL_MIN <= interval <= VARIABLES_INTERVAL_MAX
        ):
            raise ValueError(
                f"{CONF_VARIABLES_INTERVAL} must be a whole number of ms from "
                f"{VARIABLES_INTERVAL_MIN} to {VARIABLES_INTERVAL_MAX}"
            )
        updates[CONF_VARIABLES_INTERVAL] = interval

    for key in (CONF_ICON_FILL_ENABLED, CONF_ICON_COLOR_ENABLED):
        if key in changes:
            value = changes[key]
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be true or false")
            updates[key] = value

    if updates:
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, **updates},
        )
    return _icon_options_reply({**entry.options, **updates})


@websocket_api.websocket_command({
    "type": "lizaip_config/get_icon_options",
    "entry_id": str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_get_icon_options(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report the icon-rendering settings the panel has to mirror.

    The panel draws its own preview of every button rather than fetching the
    device's images, so anything that changes how a tile is rendered has to
    reach it as a value. The brightness fill step is configurable per entry,
    and a panel still assuming the default would quietly disagree with the
    hardware it is supposed to be showing.

    Entry-scoped, unlike `get_features`: that answers what this *build*
    contains, which is the same for every entry, whereas this is a setting one
    entry can hold differently from the next.
    """
    connection.send_result(msg["id"], icon_options_for_entry(hass, msg["entry_id"]))


@websocket_api.websocket_command({
    "type": "lizaip_config/set_icon_options",
    "entry_id": str,
    vol.Optional("icon_fill_step"): object,
    vol.Optional("icon_fill_enabled"): object,
    vol.Optional("icon_color_enabled"): object,
    vol.Optional("variables_interval_ms"): object,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_icon_options(hass: HomeAssistant, connection, msg: dict) -> None:
    """Save the icon-rendering settings edited in the gear tab."""
    changes = {
        key: msg[key]
        for key in ("icon_fill_step", "icon_fill_enabled", "icon_color_enabled",
                    "variables_interval_ms")
        if key in msg
    }
    try:
        reply = set_icon_options_for_entry(hass, msg["entry_id"], changes)
    except KeyError:
        connection.send_error(msg["id"], "not_found", "Config entry not found")
        return
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    connection.send_result(msg["id"], reply)


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/get_icon_defaults",
    vol.Optional("entry_id"): str,
    vol.Optional("shipped"): bool,
})
@websocket_api.async_response
async def ws_get_icon_defaults(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return icon default mappings loaded from the default theme's icons: block.

    With an ``entry_id`` the remote's theme is laid over them first, so the
    editor offers the glyphs that remote will actually draw.

    ``shipped`` asks for the file untouched by any theme, which is what tells a
    chosen icon from one the panel seeded. It is not the same as naming no
    remote: the default theme is editable, so that answers with the user's
    default rather than with the shipped table.
    """
    if msg.get("shipped"):
        connection.send_result(msg["id"], icon_defaults.all)
        return
    theme = await _entry_theme(hass, msg.get("entry_id"))
    connection.send_result(msg["id"], theme.icons.all)


async def async_list_fonts(hass: HomeAssistant) -> list[dict[str, str]]:
    return await hass.async_add_executor_job(list_fonts, user_fonts_dir(hass))


async def _entry_theme(hass: HomeAssistant, entry_id: str | None):
    """The theme the remote *entry_id* draws with, or the default one.

    A caller that names no remote -- or names one that is gone -- asks a
    question about no device in particular, and gets today's constants.
    """
    device_id = _resolve_device_id(hass, entry_id) if entry_id else None
    if not device_id:
        return DEFAULT_THEME
    return settings_theme(await _get_store(hass).async_get_settings(device_id))


def _settings_reply(settings: dict, fonts: list[dict[str, str]]) -> dict:
    # Resolved here rather than in the panel: the editor's preview and the
    # device must read one object, or they drift.
    theme = settings_theme(settings)
    return {
        "settings": settings,
        "defaults": default_settings(theme),
        "fonts": fonts,
        "themes": list_themes(),
        "theme": theme.as_payload(),
        "limits": {
            **{
                kind: dict(zip(("min", "max"), font_size_limits(kind)))
                for kind in TEXT_KINDS
            },
            KEY_REPEAT_SECTION: {
                "delay_ms": {"min": KEY_REPEAT_DELAY_MIN_MS, "max": KEY_REPEAT_DELAY_MAX_MS},
                "rate": {"min": KEY_REPEAT_RATE_MIN, "max": KEY_REPEAT_RATE_MAX},
            },
        },
    }


@websocket_api.websocket_command({
    "type": "lizaip_config/get_settings",
    "entry_id": str,
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_get_settings(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """The remote's text settings, with what the editor needs to change them.

    ``fonts`` is re-read on every call, so a font dropped into the font folder
    shows up the next time the settings tab opens.
    """
    settings = await _get_store(hass).async_get_settings(device_id)
    fonts = await async_list_fonts(hass)
    connection.send_result(msg["id"], _settings_reply(settings, fonts))


#: How many pictures one ``image_urls`` call may ask for: a full face is 40
#: tiles and their tooltips, plus the title and the open editor's fields.
_MAX_IMAGE_URLS = 400


@websocket_api.websocket_command({
    "type": "lizaip_config/image_urls",
    "entry_id": str,
    vol.Required("items"): vol.All(
        [{
            vol.Required("value"): str,
            vol.Required("kind"): vol.In(("tile", "title", "tooltip")),
            vol.Optional("color", default=""): vol.Any(None, str),
            vol.Optional("percent"): vol.Any(None, vol.All(int, vol.Range(min=0, max=100))),
            vol.Optional("theme"): vol.Any(None, str),
        }],
        vol.Length(max=_MAX_IMAGE_URLS),
    ),
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_image_urls(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """The URL the remote is sent for each picture, built by the code that builds it.

    The panel draws its previews from these, so a preview and the remote
    can only differ in what the panel adds for the browser -- never in how a
    value, a colour or a text style becomes a URL. Values come with their
    ``${…}`` variables already read: the panel reads them live, and this
    stays a pure translation.

    An item may name a ``theme`` of its own, which is how the theme picker
    shows a combination before it is saved. That item is drawn entirely in
    the named theme, text style included, because what it is previewing is
    the theme rather than this remote's settings.
    """
    settings = await _get_store(hass).async_get_settings(device_id)
    # The *resolved* id, as the sync uses: a theme whose file is gone draws the
    # default, and the preview must ask for the same picture the device does.
    resolved = settings_theme(settings)
    thm = resolved.theme_id
    urls = []
    for item in msg["items"]:
        value, color = item["value"], item.get("color") or ""
        asked = item.get("theme")
        theme = get_theme(asked) if asked else resolved
        tid = theme.theme_id if asked else thm
        if item["kind"] in TEXT_KINDS:
            kind = item["kind"]
            style = theme.text_style(kind) if asked else settings[kind]
            resolve = resolve_title_url if kind == "title" else resolve_tooltip_url
            urls.append(resolve(value, color, style, theme=tid))
        else:
            urls.append(
                resolve_icon_url(
                    value, color=color, percent=item.get("percent"), theme=tid,
                )
                if value.strip() else ""
            )
    connection.send_result(msg["id"], {"urls": urls})


@websocket_api.websocket_command({
    "type": "lizaip_config/set_settings",
    "entry_id": str,
    vol.Required("settings"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
@requires_device
async def ws_set_settings(hass: HomeAssistant, connection, msg: dict, device_id: str) -> None:
    """Save the text settings and redraw the remote's pages with them."""
    fonts = await async_list_fonts(hass)
    store = _get_store(hass)
    # What the remote has now, so a font that went missing since it was chosen
    # is carried through rather than refusing the save -- see validate_settings.
    stored = await store.async_get_settings(device_id)
    try:
        settings = validate_settings(msg["settings"], {f["id"] for f in fonts}, stored)
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    stored = await store.async_set_settings(device_id, settings)
    fire_config_changed(hass, msg["entry_id"])
    connection.send_result(msg["id"], _settings_reply(stored, fonts))


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/get_palette",
    vol.Optional("entry_id"): str,
})
@websocket_api.async_response
async def ws_get_palette(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return icon-tint swatches from imgserv's renderable color palette.

    The panel stores the selected hex as ``default_color`` and sends it back as
    ``?fg=`` on icon URLs, so the choices must be colors imgserv can render.
    With an ``entry_id`` the swatches are the remote's theme's.
    """
    theme = await _entry_theme(hass, msg.get("entry_id"))
    connection.send_result(msg["id"], {"colors": theme.palette()})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_themes"})
@websocket_api.async_response
async def ws_get_themes(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Every theme the picker may offer, bundled and user-authored alike."""
    connection.send_result(msg["id"], {"themes": list_themes()})


async def async_reload_themes(hass: HomeAssistant) -> None:
    """Re-read both theme folders, so a saved file is pickable at once."""
    themes_dir = user_themes_dir(hass)
    set_themes(await hass.async_add_executor_job(load_themes, themes_dir))


async def _redraw_theme_users(hass: HomeAssistant, theme_id: str) -> None:
    """Redraw every remote that draws with *theme_id*, facets included.

    Writing the file changes what a page looks like but not what it says, so
    without this nothing asks the device for the new pictures and the old
    ones stay on the screen.
    """
    wanted = str(theme_id or "").strip().lower()
    if not wanted:
        return
    store = _get_store(hass)
    for entry in hass.config_entries.async_entries(DOMAIN):
        device_id = _resolve_device_id(hass, entry.entry_id)
        if not device_id:
            continue
        settings = await store.async_get_settings(device_id)
        if wanted in theme_facets(settings):
            fire_config_changed(hass, entry.entry_id)


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/save_theme",
    vol.Required("theme"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_theme(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Write one theme and answer with the picker's new contents.

    Editing a saved theme reuses its id, so a remote already drawing with it
    follows the edit rather than being left on a file that no longer exists.
    A shipped theme is refused: it can only be copied.
    """
    fonts = await async_list_fonts(hass)
    themes_dir = user_themes_dir(hass)
    try:
        theme_id = await hass.async_add_executor_job(
            save_user_theme, themes_dir, msg["theme"], {f["id"] for f in fonts})
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    except OSError as exc:
        connection.send_error(msg["id"], "write_failed", str(exc))
        return
    await async_reload_themes(hass)
    await _redraw_theme_users(hass, theme_id)
    connection.send_result(msg["id"], {"id": theme_id, "themes": list_themes()})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/delete_theme",
    vol.Required("theme_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_theme(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Delete a theme of the user's own. A shipped theme is refused.

    A remote still naming a deleted theme keeps the name in its settings and
    falls back to the default look, which is what a missing theme has always
    meant -- so putting the file back restores it.
    """
    themes_dir = user_themes_dir(hass)
    try:
        removed = await hass.async_add_executor_job(
            delete_user_theme, themes_dir, msg["theme_id"])
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    except OSError as exc:
        connection.send_error(msg["id"], "write_failed", str(exc))
        return
    await async_reload_themes(hass)
    if removed:
        await _redraw_theme_users(hass, msg["theme_id"])
    connection.send_result(msg["id"], {"removed": removed, "themes": list_themes()})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/export_theme",
    vol.Required("theme_id"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_export_theme(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """One theme's own file, for the panel to download."""
    themes_dir = user_themes_dir(hass)
    try:
        filename, text = await hass.async_add_executor_job(
            export_text, themes_dir, msg["theme_id"])
    except ValueError as exc:
        connection.send_error(msg["id"], "not_found", str(exc))
        return
    except OSError as exc:
        connection.send_error(msg["id"], "read_failed", str(exc))
        return
    connection.send_result(msg["id"], {"filename": filename, "text": text})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/import_theme",
    vol.Required("text"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_import_theme(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Add a dropped theme file as a new theme of the user's own.

    Always a new file under a free name, so nothing already there -- shipped
    or the user's own -- is written over.
    """
    fonts = await async_list_fonts(hass)
    taken = {theme["id"] for theme in list_themes()}
    try:
        theme_id = await hass.async_add_executor_job(
            import_user_theme, user_themes_dir(hass), msg["text"],
            {f["id"] for f in fonts}, taken)
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_format", str(exc))
        return
    except OSError as exc:
        connection.send_error(msg["id"], "write_failed", str(exc))
        return
    await async_reload_themes(hass)
    connection.send_result(msg["id"], {"id": theme_id, "themes": list_themes()})


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/get_action_labels",
    vol.Optional("entry_id"): str,
    vol.Optional("language"): str,
})
@websocket_api.async_response
async def ws_get_action_labels(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return translated action labels for the device language, with English fallback.

    The panel and device share ``translations/<lang>.json`` so labels cannot
    drift; an entry-pinned language outranks the browser language.

    Response payload:
      {language, labels}
    """
    entry = (
        hass.config_entries.async_get_entry(msg["entry_id"])
        if msg.get("entry_id") else None
    )
    # Precedence lives in `get_ui_language`, so it cannot drift per call site.
    lang = get_ui_language(hass, entry, fallback=msg.get("language"))
    # A no-op once setup has run, which is always the case by the time a panel
    # can send this — kept so the command does not depend on that ordering to
    # stay off the disk.
    await action_labels.async_preload(hass)
    labels = {**action_labels.load("en"), **action_labels.load(lang)}
    connection.send_result(msg["id"], {"language": lang, "labels": labels})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_slider_controls"})
@websocket_api.async_response
async def ws_get_slider_controls(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return static slider capabilities; authenticated but not admin-gated.

    The table is public domain capability data, not user home data, matching the
    non-admin ``get_icon_defaults`` command.
    """
    connection.send_result(msg["id"], {"controls": serialized_controls()})


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_internal_commands"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_get_internal_commands(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return device-local command descriptors consumed by the panel.

    Serving the registry keeps internal command labels/icons out of JavaScript;
    future device-local commands should be backend-only additions.
    """
    connection.send_result(msg["id"], {"commands": panel_descriptors()})
