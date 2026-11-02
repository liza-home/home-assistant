"""What a page contains: turning a stored page into a ``set_page`` payload.

Reads the page's assignments, the action library and the remote's settings,
and builds the protocol's ``set_page`` data (PROTOCOL.md §set_page). What a
single button *looks* like is decided in :mod:`button_rendering`; when and how
the payload is sent is :mod:`device_sync`'s job.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from ..action_controller.toggle import runtime_assign
from ..device.services import _selected_entry_ids
from ..runtime import _get_store, entry_device_id
from ..shared.assignment import longtouch_steps
from ..shared.icon_urls import resolve_icon_url, resolve_title_url, resolve_tooltip_url
from ..shared.logs import device_logger
from ..shared.tokens import page_scope, substitute_device_token
from ..state_icon import (
    IconStyle,
    IconStyleOptions,
    icon_style_for,
    read_icon_style_options,
)
from .button_rendering import (
    _get_service_icons,
    _resolve_button_icon,
    _resolve_button_tooltip,
    library_names,
    with_resolved_image,
)
from .const import step_service
from .internal_commands import build_page_context
from .internal_commands import resolve_action as resolve_internal_action
from .text_style import longtouch_enabled, settings_theme, toggle_enabled

_LOGGER = logging.getLogger(__name__)


def _button_icon_style(
    hass: HomeAssistant | None,
    assign: dict,
    page_color: str,
    style_options: IconStyleOptions | None = None,
) -> IconStyle:
    """Tint and fill for a button's tile, from the light it is bound to.

    The listener resolves its live push through the same ``icon_style_for``, so
    the two agree by construction -- otherwise the first state change after a
    sync would restyle a freshly-pushed tile. *style_options* is part of that
    agreement: the step and both switches are read from the same entry options
    on both paths.
    """
    config = assign.get("config", [])
    step = config[0] if isinstance(config, list) and config else {}
    opts = style_options or read_icon_style_options(None)
    return icon_style_for(
        hass, step, page_color,
        fill_step=opts.step, fill=opts.fill, tint=opts.tint,
    )


def compute_page_hash(page_data: dict) -> int:
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


@dataclass(frozen=True)
class SyncContext:
    """What every page of one remote shares during a sync.

    Built once per sync by :func:`build_sync_context` and passed to each
    :func:`build_page_payload` call.
    """

    text_settings: dict
    internal_context: Any
    style_options: IconStyleOptions
    service_icons: dict
    #: The action library's names by id, so a label that is only its button's
    #: library name can still be told from one somebody chose.
    library_names: dict = field(default_factory=dict)

    @property
    def theme(self):
        """The remote's theme, the default one when it has picked none."""
        return settings_theme(self.text_settings)

    @property
    def theme_id(self) -> str:
        return self.theme.theme_id

    @property
    def icons(self):
        """The icon table this remote reads: the shipped one under its theme."""
        return self.theme.icons

    @property
    def tooltip_style(self) -> dict:
        return self.text_settings["tooltip"]

    @property
    def longtouch(self) -> bool:
        return longtouch_enabled(self.text_settings)

    @property
    def toggles(self) -> bool:
        return toggle_enabled(self.text_settings)


async def build_sync_context(
    hass: HomeAssistant,
    entry: ConfigEntry,
    all_pages: list[dict] | None = None,
) -> SyncContext:
    """Everything a page payload needs that is the same for every page.

    `build_page_payload` used to fetch all of this itself, once per page, even
    though only the per-page assignments actually differ. The text settings and
    the icon style options are per *device*; the service
    icon registry is per *installation*; and `build_page_context` walks the
    whole page list, so calling it inside the page loop made the sync O(N²) —
    20 pages cost 400 passes over the list, 100 pages cost 10,000.

    `_get_service_icons` is deliberately uncached at module level
    (see `button_rendering._get_service_icons`) because `async_get_icons`
    answers for the integrations loaded *so far*, and pinning a partial registry
    for the lifetime of the process would leave late-loading integrations with
    fallback icons until a reload. Holding it for the duration of one sync keeps
    that property: the next sync reads the registry again.
    """
    store = _get_store(hass)
    device_id = entry_device_id(entry)

    return SyncContext(
        text_settings=await store.async_get_settings(device_id),
        internal_context=build_page_context(all_pages),
        style_options=read_icon_style_options(getattr(entry, "options", None)),
        service_icons=await _get_service_icons(hass),
        library_names=library_names(await store.async_get_action_library(device_id)),
    )


async def build_page_payload(
    hass: HomeAssistant,
    entry: ConfigEntry,
    page_id: int,
    page_config: dict,
    all_pages: list[dict] | None = None,
    *,
    ctx: SyncContext | None = None,
) -> dict:
    """Build a set_page data payload, its tiles reading ``${_device}`` as the page has it."""
    template = page_config.get("template") if isinstance(page_config, dict) else None
    with page_scope(template):
        return await _build_page_payload_in_scope(
            hass, entry, page_id, page_config, all_pages, ctx=ctx,
        )


async def _build_page_payload_in_scope(
    hass: HomeAssistant,
    entry: ConfigEntry,
    page_id: int,
    page_config: dict,
    all_pages: list[dict] | None = None,
    *,
    ctx: SyncContext | None = None,
) -> dict:
    """Build a set_page data payload from the store.

    Returns a dict matching the protocol's set_page.data shape:
      {page_id, hash, img_title, buttons: [{name, img_tile, img_tooltip, action}]}

    *all_pages* is every stored page of this device. It is what lets an internal
    command notice that its target is gone; without it such a command is only
    validated, never cross-checked.

    *ctx* is the shared, per-device half of the inputs, from
    :func:`build_sync_context`. A caller building several pages in a row should
    build it once and pass it in; left out, it is built here, which is what the
    single-page callers want.
    """
    store = _get_store(hass)
    device_id = entry_device_id(entry)
    if not device_id:
        return {"page_id": page_id, "img_title": "", "buttons": [], "hash": 0}

    if ctx is None:
        ctx = await build_sync_context(hass, entry, all_pages)

    text_settings = ctx.text_settings
    theme_id = ctx.theme_id
    tooltip_style = ctx.tooltip_style
    longtouch = ctx.longtouch
    toggles = ctx.toggles

    page_store_id = page_config.get("id", 1)
    assignments = await store.async_get_assignments(device_id, page_store_id)

    internal_context = ctx.internal_context

    # Page-level default icon color (6-char hex, no #)
    page_color = page_config.get("default_color", "")

    # Resolved once per page, not per button: they cannot change mid-payload,
    # and the live listener reads the same options so the two producers agree.
    style_options = ctx.style_options

    # Fetch HA service icons for stateless action fallback
    service_icons = ctx.service_icons

    # Build buttons array — exclude sliders (they are NOT buttons per the
    # protocol; slider_horizontal / slider_vertical have their own event type).
    buttons = []
    for button_name, assign in assignments.items():
        if not isinstance(assign, dict):
            continue
        if button_name.startswith("slider_"):
            continue

        # Applied once, here: everything below derives the button's face, words
        # and long-touch steps from `assign`, so taking the block off at the top
        # of the loop is what makes the switch govern all of them at once.
        assign = runtime_assign(assign, toggles)
        config = assign.get("config", [])
        if not config:
            # Nothing to run — still resolve per-button image and tooltip if
            # configured. These are the sliders and the decorative image/label
            # tiles; a button only acts once it carries a command step.
            assign_image = with_resolved_image(assign, hass).get("image")
            img_tile = (
                resolve_icon_url(assign_image, color=page_color, theme=theme_id)
                if assign_image else ""
            )
            buttons.append({
                "name": button_name,
                "img_tile": img_tile,
                "img_tooltip": resolve_tooltip_url(
                    _resolve_button_tooltip(
                        assign, hass, entry, internal_context,
                        library_name=ctx.library_names.get(assign.get("action_id")),
                    ),
                    page_color,
                    tooltip_style,
                    theme_id,
                ),
                "action": {"type": "ha_event", "params": {}},
            })
            continue

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
        # select_source), a pinned image that came from a template may belong to a
        # different media item, so the payload thumbnail wins.
        # Lets a cycle toggle paint the step that is actually next rather than
        # restarting at step one every time the page is resynced. Read
        # defensively because this payload is also built for stand-in entries
        # that carry no id; `toggle_icon` declines rather than guessing when the
        # button cannot be identified.
        sync_entry_id = getattr(entry, "entry_id", None)
        button_ref = (
            (sync_entry_id, page_store_id, button_name) if sync_entry_id else None
        )
        resolved_icon = _resolve_button_icon(
            assign, hass, service_icons, internal_context,
            button_ref=button_ref, icons=ctx.icons,
        )

        # Still needed below, to decide whether the remote runs the command
        # itself or hands it to Home Assistant as a button event.
        internal_service = step_service(config)
        step_data = (
            config[0].get("data")
            if isinstance(config, list) and config and isinstance(config[0], dict)
            else None
        )
        device_logger(_LOGGER, entry).debug(
            "Button %s: service=%s, resolved=%s",
            button_name, internal_service, resolved_icon,
        )
        tile_style = _button_icon_style(hass, assign, page_color, style_options)
        img_tile = resolve_icon_url(
            resolved_icon,
            color=tile_style.color,
            percent=tile_style.percent,
            theme=theme_id,
        )

        # Tooltip: dynamic next-state label
        tooltip_text = _resolve_button_tooltip(
            assign, hass, entry, internal_context, button_ref,
            library_name=ctx.library_names.get(assign.get("action_id")),
        )
        img_tooltip = resolve_tooltip_url(tooltip_text, page_color, tooltip_style, theme_id)

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
        if internal is not None and longtouch and longtouch_steps(assign):
            # A long touch holds the click back until the finger lifts, which
            # only Home Assistant can do: run by the remote, the command would
            # fire on press, before anyone knows the touch will be long.
            internal = None
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
    # Entity variables resolve as they do on a button; one with no value leaves
    # the title strip blank rather than drawing half a name.
    # `${_device}` first: what it names can itself hold no variable.
    page_img_title = with_resolved_image(
        {"image": substitute_device_token(
            page_config.get("image", ""), hass, page_config.get("template"),
        )}, hass,
    ).get("image") or ""
    img_title = resolve_title_url(
        page_img_title, page_color, text_settings["title"], theme_id,
    )

    page_data = {
        "page_id": page_id,
        "img_title": img_title,
        "buttons": buttons,
    }
    page_data["hash"] = compute_page_hash(page_data)

    return page_data
