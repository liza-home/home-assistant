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

import asyncio
import hashlib
import json
import logging
import time
from functools import partial
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from ..const import (
    DOMAIN,
    longtouch_steps,
    resolve_icon_url,
    resolve_title_url,
    resolve_tooltip_url,
)
from .const import (
    is_subpage,
    is_valid_page_id,
    step_service,
)
from .button_rendering import (
    _get_service_icons,
    _resolve_button_icon,
    _resolve_button_tooltip,
    with_resolved_image,
)
from ..device.protocol import DEFAULT_REQUEST_TIMEOUT
from ..device.services import _selected_entry_ids
from ..action_controller.toggle import runtime_assign
from .text_style import longtouch_enabled, toggle_enabled
from .internal_commands import (
    build_page_context,
    resolve_action as resolve_internal_action,
)
from ..state_icon import (
    IconStyle,
    IconStyleOptions,
    icon_style_for,
    read_icon_style_options,
)

_LOGGER = logging.getLogger(__name__)

#: Deadline for one ``set_page``. The transport's 10 s default is sized for
#: small commands; a page carries up to a dozen image URLs the device fetches
#: before it answers, which is legitimately slower than a `goto_page`.
PAGE_WRITE_TIMEOUT = 30.0

#: Attempts per page operation. A device that stalls under a burst usually
#: answers the second try, which turns a dropped page into a slow one.
PAGE_WRITE_ATTEMPTS = 2

#: Pause before retrying a page operation.
PAGE_RETRY_DELAY = 0.5

#: Breather between consecutive page writes, so a 20-page sync reaches the
#: device as a stream rather than one burst.
PAGE_WRITE_PACING = 0.05


async def _send_page_op(
    factory,
    op: str,
    page_id: int | None,
    index: int | None = None,
    total: int | None = None,
    error_sink: list[Exception] | None = None,
) -> bool:
    """Run one page command, with retries, and say whether it landed.

    Each operation is isolated. Previously the whole remove/add/write/order
    sequence sat in a single ``try``, so the first page the device failed to
    acknowledge aborted every page after it *and* the closing
    ``set_main_pages`` — and the log said only ``Page sync failed: …``, naming
    neither the page nor the command. *factory* is a callable rather than a
    coroutine because a coroutine cannot be awaited twice, and a retry needs a
    fresh one. *error_sink* collects the exception a giving-up operation died
    of, so a caller can report what the device actually said rather than a
    generic "it failed".
    """
    where = f"page {page_id}" if page_id is not None else "main page order"
    progress = f" ({index}/{total})" if index is not None and total else ""

    for attempt in range(1, PAGE_WRITE_ATTEMPTS + 1):
        try:
            await factory()
        except Exception as err:  # noqa: BLE001 — one page must not stop the rest
            last = attempt == PAGE_WRITE_ATTEMPTS
            _LOGGER.log(
                logging.ERROR if last else logging.WARNING,
                "%s failed for %s%s (attempt %d/%d): %s",
                op, where, progress, attempt, PAGE_WRITE_ATTEMPTS, err,
            )
            if last:
                if error_sink is not None:
                    error_sink.append(err)
                return False
            await asyncio.sleep(PAGE_RETRY_DELAY)
        else:
            _LOGGER.debug("%s ok for %s%s", op, where, progress)
            return True
    return False


async def _add_page_if_missing(conn, page_id: int) -> None:
    """Create *page_id*, tolerating a page the device already holds.

    An interrupted sync can leave a page added but unrecorded, and firmware
    answers the second ``add_page`` with an error (``409`` per PROTOCOL.md, but
    at least one version sends ``-4 "data"."page_id"``). The code alone cannot
    be trusted to mean "already exists" — it is also what a device out of room
    returns — so ask the device and only swallow the error when the page really
    is there. Raising otherwise lets ``_send_page_op`` log and count it.
    """
    try:
        await conn.add_page(page_id)
    except Exception as err:
        try:
            existing = {p["page_id"] for p in await conn.get_pages()}
        except Exception:
            raise err from None
        if page_id not in existing:
            raise
        _LOGGER.debug("Page %s already on device, keeping it: %s", page_id, err)


def _page_delta(previous: dict | None, desired: dict) -> dict:
    """The smallest ``set_page`` payload taking the device from *previous* to *desired*.

    ``set_page`` merges rather than replaces: omitted fields keep their current
    value, and the ``buttons`` array is merged per button, matched by ``name``
    (PROTOCOL.md §set_page). So a page whose tooltip changed need only carry
    that one button instead of all of them.

    *previous* is what we last successfully sent for this page. Without it — a
    fresh connection, or a page whose write failed and dropped the cache —
    there is nothing to merge against and the whole page goes out.

    ``hash`` always travels, whole-page and partial alike: it describes the
    page the device ends up with, and ``get_pages`` compares it on reconnect.
    """
    if not previous:
        return desired

    prev_buttons = {b["name"]: b for b in previous.get("buttons", [])}
    changed = [
        b for b in desired.get("buttons", [])
        if prev_buttons.get(b["name"]) != b
    ]

    # Nothing is saved by a partial naming every button anyway, and the full
    # payload is the better thing to send when the whole page moved.
    if len(changed) == len(desired.get("buttons", [])):
        return desired

    delta: dict = {"page_id": desired["page_id"], "hash": desired["hash"]}
    if previous.get("img_title") != desired.get("img_title"):
        delta["img_title"] = desired["img_title"]
    if changed:
        delta["buttons"] = changed
    return delta


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


async def build_sync_context(
    hass: HomeAssistant,
    entry: ConfigEntry,
    all_pages: list[dict] | None = None,
) -> dict:
    """Everything a page payload needs that is the same for every page.

    `_build_page_payload` used to fetch all of this itself, once per page, even
    though only the per-page assignments actually differ. The action library,
    the text settings and the icon style options are per *device*; the service
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
    store = hass.data[DOMAIN]["_store"]
    device_id = entry.runtime_data._device_id if hasattr(entry, "runtime_data") else None

    library = await store.async_get_action_library(device_id)
    text_settings = await store.async_get_settings(device_id)
    return {
        "library": library,
        "lib_by_id": {a["id"]: a for a in library if isinstance(a, dict) and "id" in a},
        "text_settings": text_settings,
        "tooltip_style": text_settings["tooltip"],
        "longtouch": longtouch_enabled(text_settings),
        "toggles": toggle_enabled(text_settings),
        "internal_context": build_page_context(all_pages),
        "style_options": read_icon_style_options(getattr(entry, "options", None)),
        "service_icons": await _get_service_icons(hass),
    }


async def _build_page_payload(
    hass: HomeAssistant,
    entry: ConfigEntry,
    page_id: int,
    page_config: dict,
    all_pages: list[dict] | None = None,
    *,
    ctx: dict | None = None,
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
    store = hass.data[DOMAIN]["_store"]
    device_id = entry.runtime_data._device_id if hasattr(entry, "runtime_data") else None
    if not device_id:
        return {"page_id": page_id, "img_title": "", "buttons": [], "hash": 0}

    if ctx is None:
        ctx = await build_sync_context(hass, entry, all_pages)

    library = ctx["library"]
    text_settings = ctx["text_settings"]
    tooltip_style = ctx["tooltip_style"]
    longtouch = ctx["longtouch"]
    toggles = ctx["toggles"]
    lib_by_id = ctx["lib_by_id"]

    page_store_id = page_config.get("id", 1)
    assignments = await store.async_get_assignments(device_id, page_store_id)

    internal_context = ctx["internal_context"]

    # Page-level default icon color (6-char hex, no #)
    page_color = page_config.get("default_color", "")

    # Resolved once per page, not per button: they cannot change mid-payload,
    # and the live listener reads the same options so the two producers agree.
    style_options = ctx["style_options"]

    # Fetch HA service icons for stateless action fallback
    service_icons = ctx["service_icons"]

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
        action_id = assign.get("action_id")
        if not action_id:
            # No action — still resolve per-button image and tooltip if configured
            assign_image = with_resolved_image(assign, hass).get("image")
            img_tile = resolve_icon_url(assign_image, color=page_color) if assign_image else ""
            buttons.append({
                "name": button_name,
                "img_tile": img_tile,
                "img_tooltip": resolve_tooltip_url(
                    _resolve_button_tooltip({}, assign, hass, entry, internal_context),
                    page_color,
                    tooltip_style,
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
            action_def, assign, hass, service_icons, internal_context,
            button_ref=button_ref,
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
        tile_style = _button_icon_style(hass, assign, page_color, style_options)
        img_tile = resolve_icon_url(
            resolved_icon,
            color=tile_style.color,
            percent=tile_style.percent,
        )

        # Tooltip: dynamic next-state label
        tooltip_text = _resolve_button_tooltip(
            action_def, assign, hass, entry, internal_context, button_ref,
        )
        img_tooltip = resolve_tooltip_url(tooltip_text, page_color, tooltip_style)

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
    page_img_title = with_resolved_image(
        {"image": page_config.get("image", "")}, hass,
    ).get("image") or ""
    img_title = resolve_title_url(page_img_title, page_color, text_settings["title"])

    page_data = {
        "page_id": page_id,
        "img_title": img_title,
        "buttons": buttons,
    }
    page_data["hash"] = _compute_page_hash(page_data)

    return page_data


async def sync_config_to_device(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Sync the panel's page configuration to the device, one sync at a time.

    Three sources push a sync: a panel save, the device's hello on reconnect,
    and a dynamic-source refresh. None of them coordinated, and the sync body
    awaits a device round trip per page, so two of them could interleave their
    ``add_page``/``set_page``/``set_main_pages`` commands at every await and
    leave ``_known_pages`` describing a device state that never existed.

    This is the single-flight guard the live icon path already has in
    :class:`~.icon_push.IconPushQueue`: one sync runs, a sync requested while
    that one is in flight sets a flag instead of starting, and the runner loops
    once more when it sees it. A burst of N edits collapses to at most two
    syncs, and the second one sees the final state — so nothing is lost by not
    running the ones in between.
    """
    state = _sync_state(hass, entry)
    if state["running"]:
        state["dirty"] = True
        _LOGGER.debug("Sync already running for %s, coalescing", entry.title)
        return True

    async with state["lock"]:
        state["running"] = True
        try:
            result = await _sync_locked(hass, entry)
            # One repeat only. The flag is cleared before the rerun so an edit
            # arriving *during* the rerun sets it again and is picked up by the
            # next caller, rather than spinning here.
            while state["dirty"]:
                state["dirty"] = False
                result = await _sync_locked(hass, entry)
            return result
        finally:
            state["running"] = False


def _sync_state(hass: HomeAssistant, entry: ConfigEntry) -> dict:
    """Per-entry sync lock and pending flag, created on first use."""
    store = hass.data.setdefault(DOMAIN, {}).setdefault("_sync_state", {})
    return store.setdefault(
        entry.entry_id, {"lock": asyncio.Lock(), "running": False, "dirty": False}
    )


#: Extra seconds of patience per page when asking the device what it holds.
#: The listing is one answer carrying every page, so the time to assemble and
#: send it grows with their number; the flat default was enough for a handful
#: and timed out at a hundred. Measured against the fallout, not the hardware:
#: waiting is cheap, while a timeout costs a whole sync.
_LISTING_TIMEOUT_PER_PAGE = 0.5

#: Ceiling for the same. A device that has not answered in this long is not
#: slow, it is gone, and the sync should fail rather than hold the connection.
_LISTING_TIMEOUT_MAX = 60.0


def _listing_timeout(page_count: int) -> float:
    """How long to wait for `get_pages` with *page_count* pages configured.

    The count comes from the store rather than the device -- the device's
    answer is what is being waited for -- but the two track each other closely
    enough, and over-estimating is the harmless direction.
    """
    return min(
        _LISTING_TIMEOUT_MAX,
        DEFAULT_REQUEST_TIMEOUT + _LISTING_TIMEOUT_PER_PAGE * max(0, page_count),
    )


async def _sync_locked(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """One pass of the page sync. Call through :func:`sync_config_to_device`.

    Two locks, because they exclude different things. The per-entry lock above
    makes the passes themselves single-file and lets a burst coalesce; this one
    is held on the connection, so the out-of-band pushes that do not go through
    a full sync at all -- the order push in ``ws_set_pages`` and the
    ``clear_all`` service -- cannot interleave with a sync either. They are
    always taken in this order, and nothing takes them the other way round.

    Returns True if sync was performed, False if device not available.
    """
    conn = _get_device_connection(hass, entry)
    if conn is None or not conn.connected:
        _LOGGER.debug("Device not connected, skipping sync for %s", entry.title)
        return False
    async with conn._page_sync_lock:
        return await _sync_config_to_device(hass, entry, conn)


async def _sync_config_to_device(
    hass: HomeAssistant, entry: ConfigEntry, conn: Any,
) -> bool:
    """Sync pages to *conn*, which `sync_config_to_device` holds the lock for.

    Uses the protocol commands: get_pages, clear_all/add_page/set_page/set_main_pages.
    """
    # Load pages from store
    device_id = entry.runtime_data._device_id if hasattr(entry, "runtime_data") else None
    if not device_id:
        _LOGGER.debug("No device_id for entry %s", entry.entry_id)
        return False
    store = hass.data[DOMAIN]["_store"]
    pages = await store.async_get_pages(device_id)

    # Use cached device state if available; otherwise query the device (first sync after connect)
    if conn._known_pages is None:
        listing_timeout = _listing_timeout(len(pages))
        try:
            device_pages = await conn.get_pages(timeout=listing_timeout)
        except Exception as err:
            # Not "the device is empty". That assumption is what made a slow
            # listing catastrophic: every page read as missing, so the sync
            # rewrote all of them -- the most expensive thing it can do, aimed
            # at a device that had just shown it was struggling to answer.
            # Without the hashes there is nothing to sync against, so the pass
            # is abandoned and the cache left unset, which makes the next sync
            # read them again.
            _LOGGER.error(
                "Failed to get_pages from device: %s — skipping this sync rather "
                "than rewriting all %d page(s) blind", err, len(pages),
            )
            _note_sync_failure(hass, entry, conn, err)
            return False
        device_hash_map: dict[int, int] = {p["page_id"]: p.get("hash", 0) for p in device_pages}

        try:
            device_main_pages = await conn.get_main_pages(timeout=listing_timeout)
        except Exception as err:
            # Survivable where the page listing is not: an unknown order means
            # the order gets pushed again, not that every page does.
            _LOGGER.debug("Failed to get_main_pages from device: %s", err)
            device_main_pages = []
    else:
        device_hash_map = {pid: p.get("hash") for pid, p in conn._known_pages.items()}
        device_main_pages = conn._known_main_pages or []

    # Build desired state
    build_started = time.monotonic()
    desired_pages = []
    main_page_ids = []
    # Built once: every input here is the same for all pages, and
    # `build_page_context` walks the whole list, so building it per page made
    # this loop O(N²).
    page_ctx = await build_sync_context(hass, entry, pages)
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
        page_data = await _build_page_payload(
            hass, entry, page_id, page_config, pages, ctx=page_ctx,
        )
        desired_pages.append(page_data)
        # A subpage still gets written to the device — only the main-page list
        # leaves it out, so `goto_page` can still reach it.
        if not is_subpage(page_config):
            main_page_ids.append(page_id)

    # Every page is rebuilt because a page's hash is only known once its
    # payload is resolved. Logged because it is the one part of a sync that
    # grows with the number of pages.
    _LOGGER.debug(
        "Built %d page payloads in %.0f ms",
        len(desired_pages), (time.monotonic() - build_started) * 1000,
    )

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
        # Populate the cache so subsequent syncs skip the device query. Nothing
        # differed, so what was just built is what the device holds.
        conn._known_pages = {p["page_id"]: p for p in desired_pages}
        conn._known_main_pages = list(main_page_ids)
        _note_sync_success(hass, entry, conn)
        _LOGGER.debug("Device pages up to date, no sync needed")
        return True

    _LOGGER.info(
        "Syncing pages: add=%s, remove=%s, update=%s, order_changed=%s",
        pages_to_add, pages_to_remove, pages_to_update, order_changed,
    )

    # Sets have no order, and the device applies these in the order they
    # arrive, so walk the stored page order instead: a reproducible sequence is
    # what makes a failure at "page 21" mean the same thing twice running.
    ordered_ids = [p["page_id"] for p in desired_pages]
    add_order = [pid for pid in ordered_ids if pid in pages_to_add]
    remove_order = sorted(pages_to_remove)
    writes = [p for p in desired_pages
              if p["page_id"] in pages_to_add or p["page_id"] in pages_to_update]

    # Progress is recorded per page rather than in one block at the end. A sync
    # that dies halfway used to leave the cache untouched, so the retry rebuilt
    # the identical diff, resent the identical pages in the identical order and
    # stopped at the identical page — the failure never healed. Keeping what
    # landed means a retry only carries what did not.
    if conn._known_pages is None:
        # Seeded from what the device just reported, which is a hash and no
        # payload. A page with no recorded payload is sent whole rather than
        # as a delta -- right, because its content is the device's, not ours.
        conn._known_pages = {
            pid: {"page_id": pid, "hash": h}
            for pid, h in device_hash_map.items()
        }
    known_pages = conn._known_pages

    # Pages the diff did not pick up match the device by hash, so what was just
    # built *is* what the device holds. Recording the payload keeps
    # `_live_button_changes` able to push a single icon instead of falling back
    # to a full page write, and replaces the stub seeded above.
    known_pages.update({
        p["page_id"]: p for p in desired_pages
        if p["page_id"] not in pages_to_add and p["page_id"] not in pages_to_update
    })

    failed: list[int] = []

    # Page IDs the device refused outright earlier in this session. Retrying
    # them costs four round-trips each on every config change and can never
    # succeed, so they are skipped until the next reconnect.
    rejected = getattr(conn, "_rejected_pages", None)
    if rejected is None:
        rejected = set()
        conn._rejected_pages = rejected

    for pid in remove_order:
        if await _send_page_op(partial(conn.del_page, pid), "del_page", pid):
            known_pages.pop(pid, None)
        else:
            failed.append(pid)

    # A failed `add_page` no longer takes its `set_page` down with it. The
    # device answers `[-4] "data"."page_id"` both for an ID it will not accept
    # and for one it already holds, and `get_pages` is the only thing telling
    # us which — so a device that under-reports its pages would leave HA
    # re-adding a page that exists and never writing it. Attempting the write
    # anyway costs one round-trip on a path that was already failing, and is
    # what distinguishes "cannot store this page" from "already had it".
    add_failed = set()
    for pid in add_order:
        if pid in rejected:
            continue
        if not await _send_page_op(
            partial(_add_page_if_missing, conn, pid), "add_page", pid,
        ):
            add_failed.add(pid)

    total = len(writes)
    for n, page_data in enumerate(writes, 1):
        pid = page_data["page_id"]
        if pid in rejected:
            continue
        # A page the device has just been told to create holds nothing yet, and
        # one whose `add_page` was refused is of unknown content — both need
        # the whole payload. Only a page we last wrote ourselves can be sent as
        # a delta, because only then is there a known state to merge against.
        payload = (
            page_data if pid in pages_to_add
            else _page_delta(known_pages.get(pid), page_data)
        )
        ok = await _send_page_op(
            partial(conn.set_page, timeout=PAGE_WRITE_TIMEOUT, **payload),
            "set_page", pid, n, total,
        )
        if ok:
            if pid in add_failed:
                _LOGGER.info(
                    "Page %d was written despite add_page being refused — the "
                    "device already held it but did not report it in get_pages",
                    pid,
                )
            known_pages[pid] = page_data
        else:
            # Forgetting the page keeps the next sync honest: it is in an
            # unknown state, so it has to be rewritten rather than skipped as
            # unchanged.
            known_pages.pop(pid, None)
            failed.append(pid)
            if pid in add_failed:
                # Refused both ways: the device will not store this page at
                # all. Nothing HA sends changes that, so stop asking.
                rejected.add(pid)
        if n < total:
            # 20-odd back-to-back page writes each kick off a batch of image
            # fetches on the device. A breather between them spreads that burst
            # out instead of handing the device the whole thing at once.
            await asyncio.sleep(PAGE_WRITE_PACING)

    # Listing only the pages that actually made it, and sent whenever that list
    # or the order moved. Previously a single timed-out page raised straight
    # past this call, so navigation kept the order from before the edit — which
    # is what "the page is there but it never synced" looked like from the
    # sofa. Sending it on *every* sync is the opposite mistake: it made the
    # device rewrite its page setup for nothing after a plain button edit.
    deliverable = [pid for pid in main_page_ids if pid in known_pages]
    order_error: Exception | None = None
    order_errors: list[Exception] = []
    if order_changed or deliverable != device_main_pages:
        if await _send_page_op(
            partial(conn.set_main_pages, deliverable), "set_main_pages", None,
            error_sink=order_errors,
        ):
            conn._known_main_pages = list(deliverable)
        else:
            conn._known_main_pages = None
            # The pages may all be stored and still be in the wrong order, and
            # order is the whole of what navigation shows. Reporting success
            # here would reset the failure counter and leave nothing to retry.
            order_error = (
                order_errors[0] if order_errors
                else RuntimeError("set_main_pages failed")
            )
    else:
        # Already the order the device reported this pass, so there is nothing
        # to write -- but the cache may not have known that yet.
        conn._known_main_pages = list(deliverable)

    if rejected:
        ir.async_create_issue(
            hass,
            DOMAIN,
            f"pages_rejected_{entry.entry_id}",
            is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key="pages_rejected",
            translation_placeholders={
                "device": entry.title,
                "pages": ", ".join(str(p) for p in sorted(rejected)),
                "stored": str(len(known_pages)),
            },
        )
    else:
        ir.async_delete_issue(hass, DOMAIN, f"pages_rejected_{entry.entry_id}")

    if failed:
        names = ", ".join(str(p) for p in sorted(set(failed)))
        _LOGGER.error(
            "Page sync incomplete: %d of %d page writes failed (pages %s). "
            "The pages that did sync are live; the rest are retried on the "
            "next config change or reconnect.",
            len(failed), len(remove_order) + len(add_order) + total, names,
        )
        # Counted like a wholesale failure even though most pages landed: a
        # remote that drops the same page every time is the fault nobody goes
        # looking for, and the per-page log line is the only other trace.
        _note_sync_failure(
            hass, entry, conn,
            RuntimeError(f"{len(failed)} page write(s) failed (pages {names})"),
        )
        return False

    if order_error is not None:
        _note_sync_failure(hass, entry, conn, order_error)
        return False

    _note_sync_success(hass, entry, conn)
    _LOGGER.info("Page sync complete (%d page(s) written)", total)
    return True


#: Consecutive failed syncs before the user is told. One failure is ordinary --
#: a remote that slept, a socket that closed mid-write -- and the next sync
#: usually puts it right, so reporting it would be noise. Three in a row is a
#: device that is not coming back on its own.
MAX_SYNC_FAILURES = 3


def _sync_issue_id(entry: ConfigEntry) -> str:
    """One issue per device, so two failing remotes do not overwrite each other."""
    return f"page_sync_failed_{entry.entry_id}"


def _note_sync_failure(
    hass: HomeAssistant, entry: ConfigEntry, conn: Any, err: Exception,
) -> None:
    """Count a failed sync and, once they stack up, say so in the UI.

    Until this existed the only trace was an ERROR line in the log. A remote
    whose pages silently stopped matching the panel is exactly the kind of
    fault nobody goes looking for, so it has to come to the user instead.
    """
    count = getattr(conn, "_page_sync_failures", 0) + 1
    conn._page_sync_failures = count
    if count < MAX_SYNC_FAILURES:
        return
    ir.async_create_issue(
        hass,
        DOMAIN,
        _sync_issue_id(entry),
        is_fixable=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key="page_sync_failed",
        translation_placeholders={
            "device": entry.title,
            "count": str(count),
            "error": str(err),
        },
    )


def _note_sync_success(hass: HomeAssistant, entry: ConfigEntry, conn: Any) -> None:
    """Clear the count and take the issue down.

    Unconditional on purpose: deleting an issue that was never raised is a
    no-op, and tracking whether we raised one is a second piece of state that
    could disagree with the registry.
    """
    conn._page_sync_failures = 0
    ir.async_delete_issue(hass, DOMAIN, _sync_issue_id(entry))


def _page_delta(previous: dict | None, desired: dict) -> dict:
    """The smallest `set_page` payload that takes the device from *previous* to *desired*.

    `set_page` merges: fields left out keep their current value, and a partial
    `buttons` array is merged per button rather than replacing the array
    (PROTOCOL.md §set_page). So a page whose tooltip changed need only carry
    that one button instead of all seventeen.

    *previous* is what we last successfully sent for this page. Without it --
    a fresh connection, or a sync that failed and dropped the cache -- there is
    nothing to merge against and the whole page goes out.

    `hash` always travels, whole-page and partial alike: it describes the page
    the device ends up with, and `get_pages` compares it on the next connect.
    """
    if not previous:
        return desired

    prev_buttons = {b["name"]: b for b in previous.get("buttons", [])}
    changed = [
        b for b in desired.get("buttons", [])
        if prev_buttons.get(b["name"]) != b
    ]

    # Nothing saved by a partial that names every button anyway, and the full
    # payload is the better thing to send when the whole page moved.
    if len(changed) == len(desired.get("buttons", [])):
        return desired

    delta: dict = {"page_id": desired["page_id"], "hash": desired["hash"]}
    if previous.get("img_title") != desired.get("img_title"):
        delta["img_title"] = desired["img_title"]
    if changed:
        delta["buttons"] = changed
    return delta


async def _add_page_if_missing(conn: Any, page_id: int) -> None:
    """Add *page_id* to the device, tolerating a page that is already there.

    An interrupted sync can leave a page added but unrecorded, and firmware
    answers the second `add_page` with an error (``409`` per PROTOCOL.md, but
    at least one version sends ``-4 "data"."page_id"``). The code alone cannot
    be trusted to mean "already exists" -- it is also what a genuinely invalid
    id returns -- so ask the device and only swallow the error when the page
    really is present.
    """
    try:
        await conn.add_page(page_id)
    except Exception as err:
        try:
            existing = {p["page_id"] for p in await conn.get_pages()}
        except Exception:
            raise err from None
        if page_id not in existing:
            raise
        _LOGGER.debug("Page %s already on device, keeping it: %s", page_id, err)



#: The parts of a button an entity variable can move. Anything else differing
#: means the page changed some other way, which is the full sync's job.
_LIVE_BUTTON_FIELDS = ("img_tile", "img_tooltip")


def _live_button_changes(sent: dict, built: dict) -> list[dict] | None:
    """The tile and tooltip changes from *sent* to *built*, or None if more moved."""
    if sent.get("img_title") != built.get("img_title"):
        return None
    before = {b.get("name"): b for b in sent.get("buttons", ())}
    if set(before) != {b.get("name") for b in built.get("buttons", ())}:
        return None
    changes = []
    for button in built.get("buttons", ()):
        old = before[button.get("name")]
        if any(
            button.get(k) != old.get(k)
            for k in set(button) | set(old) if k not in _LIVE_BUTTON_FIELDS
        ):
            return None
        moved = {k: button.get(k, "") for k in _LIVE_BUTTON_FIELDS if button.get(k) != old.get(k)}
        if moved:
            changes.append({"name": button.get("name"), **moved})
    return changes


def note_partial_page(conn, page_id: int, buttons: list[dict]) -> None:
    """Record a partial ``set_page`` the device acknowledged in its known copy.

    Without this, the copy keeps the tile the last full sync drew while the
    device shows the one a live update pushed since -- so the next variable
    push resends it, and the next full sync resends the whole page. A page the
    cache does not hold is left for the full sync to settle.
    """
    known = getattr(conn, "_known_pages", None)
    copy = None if known is None else known.get(page_id)
    if copy is None:
        return
    moved = {
        b.get("name"): {k: b[k] for k in _LIVE_BUTTON_FIELDS if k in b} for b in buttons
    }
    if not moved.keys() <= {b.get("name") for b in copy.get("buttons", ())}:
        return
    patched = {k: v for k, v in copy.items() if k != "hash"}
    patched["buttons"] = [{**b, **moved.get(b.get("name"), {})} for b in copy["buttons"]]
    patched["hash"] = _compute_page_hash(patched)
    known[page_id] = patched


async def async_push_variable_pages(
    hass: HomeAssistant, entry: ConfigEntry, page_ids: set[int],
) -> None:
    """Bring the pages whose variables moved up to date, sending only what changed.

    Each page is rebuilt and compared, button by button, with what the device
    was last given; only the tiles and tooltips that came out different go out,
    through the same queue as live light icons. A page the device's copy of is
    not known, or that changed more than a variable can (its title included),
    falls back to the full sync.
    """
    conn = _get_device_connection(hass, entry)
    if conn is None or not conn.connected:
        return
    device_id = entry.runtime_data._device_id if hasattr(entry, "runtime_data") else None
    queue = hass.data.get(DOMAIN, {}).get(entry.entry_id, {}).get("icon_push_queue")
    known = conn._known_pages
    if not device_id or queue is None or not known:
        await sync_config_to_device(hass, entry)
        return

    pages = await hass.data[DOMAIN]["_store"].async_get_pages(device_id)
    by_id = {p.get("id", 1): p for p in pages if isinstance(p, dict)}
    pushed = False
    for page_id in sorted(page_ids):
        page_config = by_id.get(page_id)
        if page_config is None:
            continue
        # A reconnect drops the whole cache, so a copy that is there is a copy
        # the device is known to hold.
        sent = known.get(page_id)
        if sent is None:
            await sync_config_to_device(hass, entry)
            return
        built = await _build_page_payload(hass, entry, page_id, page_config, pages)
        changes = _live_button_changes(sent, built)
        if changes is None:
            await sync_config_to_device(hass, entry)
            return
        known[page_id] = built
        if changes:
            _LOGGER.debug("Variables moved on page %s: %s", page_id, [c["name"] for c in changes])
            queue.submit(page_id, changes)
            pushed = True
    if pushed:
        queue.schedule(
            lambda coro: entry.async_create_background_task(hass, coro, "lizaip_variable_push"),
        )
