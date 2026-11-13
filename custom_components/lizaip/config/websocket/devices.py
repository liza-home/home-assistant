"""Commands about a remote as a whole.

The device list, its blueprint, the build's optional features, navigating and
wiping its pages, the diagnostics bundle, and putting a downloaded
configuration back.
"""
from __future__ import annotations

import io
import json
import logging
import zipfile
from contextlib import nullcontext
from datetime import timedelta
from typing import Final

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.http.auth import async_sign_path
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from ..restore import (
    archive_carries_themes,
    async_restore_files,
    async_take_upload,
)
from ...const import DOMAIN
from ...device.const import LIZAIP_AVAILABILITY_EVENT
from ..diagnostics_bundle import (
    BUNDLE_URL_BASE,
    BundleAbandoned,
    SCOPE_STANDARD,
    SCOPES,
    async_build_zip,
    async_store_bundle,
    steps_for_scope,
)
from ...runtime import (
    resolve_device_id,
    debug_available,
    entry_connection,
    find_store,
    remember_panel_language,
    renamed_device,
)
from ...shared.logs import device_id_logger, device_logger
from ..access import (
    SIGNAL_ASSIGNMENTS_CHANGED,
    accessible_entry_ids,
    assigned_user_ids,
    holds_any_entry,
    is_admin_user,
    require_any_device_access,
    require_device_access,
)
from ..blueprint import async_get_blueprint
from ..const import PAGE_ID_SCHEMA
from ..device_sync import sync_config_to_device
from ..events import fire_config_changed
from ..listeners import refresh_state_listener
from .common import live_connection, send_failure
from .settings import async_reload_themes

_LOGGER = logging.getLogger(__name__)


@websocket_api.websocket_command({vol.Required("type"): "lizaip_config/get_features"})
@require_any_device_access
@websocket_api.async_response
async def ws_get_features(hass: HomeAssistant, connection, msg: dict) -> None:
    """Report which optional features this build carries.

    The panel cannot infer this: its own files are served from disk regardless,
    so it has to be told whether the backing commands exist before it offers a
    tab that would only produce "unknown command".
    """
    connection.send_result(msg["id"], {"debug_tools": debug_available()})


#: How long the signed download URL stays valid. It is followed by the click
#: that produced it, so this only has to survive the hop from the answer to the
#: browser; the bundle behind it expires on its own and is gone once fetched.
_DOWNLOAD_SIGNATURE_SECONDS: Final = 120


#: Which builds are running, as ``(entry id, kind)``. A configuration bundle
#: reads files and the store; every other scope spends its time on the remote's
#: endpoints. So the two may run side by side, but never two of a kind: a second
#: pass over the same endpoints would halve the speed of both and tell us
#: nothing the first one does not already carry.
_BUILDS_IN_FLIGHT: Final[set[tuple[str, str]]] = set()


@websocket_api.websocket_command({
    vol.Required("type"): "lizaip_config/build_diagnostics_bundle",
    vol.Required("entry_id"): str,
    vol.Optional("scope", default=SCOPE_STANDARD): vol.In(SCOPES),
})
@require_device_access
@websocket_api.async_response
async def ws_build_diagnostics_bundle(hass: HomeAssistant, connection, msg: dict) -> None:
    """Assemble the support bundle and say where the browser can fetch it.

    A subscription rather than a single answer: the build takes the better part
    of ten seconds, almost all of it waiting on the remote's eight HTTP
    endpoints, and the panel has nothing to show in the meantime but a spinner
    that could equally mean the button is broken. Each section announces itself
    as it starts, and the final message carries the download.

    The ZIP is not sent over this socket. It carries the device's log and the
    whole stored configuration, which is megabytes of base64 through a channel
    that also drives the panel's live updates — so it is parked under a one-shot
    token and downloaded over HTTP like any other file.

    `skipped` travels with the answer rather than only inside the bundle: a user
    whose remote was offline should be told that at the moment they press the
    button, not when support opens the ZIP.

    `scope` chooses between the three builds. The step list is answered per
    scope rather than as one fixed list, because the panel draws its progress
    rows from it and a config bundle that showed eight rows and ran four would
    look stuck at the fifth.
    """
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return

    scope = msg.get("scope", SCOPE_STANDARD)
    # Refused rather than queued. The panel already keeps one build of each kind
    # on screen, so a second request is a second tab or a stale one -- and the
    # honest answer to it is that the first is still running.
    lane = (entry.entry_id, scope)
    if lane in _BUILDS_IN_FLIGHT:
        connection.send_error(msg["id"], "busy", "A bundle of this kind is already being built")
        return

    # Accepted before the work starts, so the panel can show its progress list
    # at once. Unsubscribing is what a reloaded or closed panel does, and the
    # build stops at the next section: nobody will ever see a bundle whose
    # browser has gone, and the remote has better uses for the rest of it.
    abandoned = False

    def _abandon() -> None:
        nonlocal abandoned
        abandoned = True

    connection.subscriptions[msg["id"]] = _abandon
    steps = [key for key, _ in steps_for_scope(scope)]
    connection.send_result(msg["id"], {"scope": scope, "steps": steps})
    # And again as an event: a subscription's result is consumed by the
    # frontend as its acknowledgement and never reaches the caller, and the
    # panel needs the step table to draw a row per step.
    connection.send_message({
        "id": msg["id"],
        "type": "event",
        "event": {"event": "steps", "scope": scope, "steps": steps},
    })

    def progress(step: str, index: int, total: int) -> None:
        connection.send_message({
            "id": msg["id"],
            "type": "event",
            "event": {"event": "progress", "step": step, "index": index, "total": total},
        })

    log = device_logger(_LOGGER, entry)
    _BUILDS_IN_FLIGHT.add(lane)
    try:
        filename, data = await async_build_zip(
            hass, entry, scope=scope,
            whole_system=is_admin_user(connection.user),
            progress=progress, should_stop=lambda: abandoned,
        )
    except BundleAbandoned:
        log.debug("Stopped building a diagnostics bundle: nobody is waiting")
        return
    except Exception as err:  # noqa: BLE001 — the panel is waiting on an event
        log.exception("Building a diagnostics bundle failed")
        connection.send_message({
            "id": msg["id"],
            "type": "event",
            "event": {"event": "error", "message": f"{err.__class__.__name__}: {err}"},
        })
        return
    finally:
        _BUILDS_IN_FLIGHT.discard(lane)

    token = async_store_bundle(hass, filename, data, entry.entry_id)
    skipped = _bundle_skipped(data, filename)

    # Signed here rather than by the panel's own `auth/sign_path` call: a
    # browser following a link sends no Authorization header, so an unsigned
    # URL would be refused. The signature outlives only the click.
    url = async_sign_path(
        hass, f"{BUNDLE_URL_BASE}/{token}", timedelta(seconds=_DOWNLOAD_SIGNATURE_SECONDS),
    )

    log.info(
        "Built a %s diagnostics bundle: %s (%d bytes, %d section(s) skipped)",
        scope, filename, len(data), len(skipped),
    )
    connection.send_message({
        "id": msg["id"],
        "type": "event",
        "event": {
            "event": "done",
            "scope": scope,
            "url": url,
            "filename": filename,
            "size": len(data),
            "skipped": skipped,
        },
    })


def _bundle_skipped(data: bytes, filename: str) -> list[dict[str, str]]:
    """Read the manifest back out of the ZIP that was just built.

    Read rather than returned alongside: the manifest inside the bundle is what
    support will go by, so the panel showing anything else would be a second
    answer that can disagree with the first. Unreadable is reported as nothing
    skipped — the bundle itself is already built, and a warning that the warning
    list could not be read helps nobody.
    """
    root = filename.removesuffix(".zip")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            manifest = json.loads(archive.read(f"{root}/manifest.json"))
        return list(manifest.get("skipped") or [])
    except (KeyError, OSError, ValueError, zipfile.BadZipFile):
        return []


def _battery_entity(hass: HomeAssistant, entry_id: str) -> str | None:
    """The remote's own battery sensor, by translation key rather than id.

    The entity id is derived from the device name and so changes when the
    device is renamed; ``translation_key`` is what the platform writes and
    never moves. The panel is handed the id rather than a reading because it
    already receives every state change with ``hass`` -- a number sent here
    would be the value at list time and stay that way for as long as the panel
    is open.
    """
    ent_reg = er.async_get(hass)
    for entity in er.async_entries_for_config_entry(ent_reg, entry_id):
        if entity.domain == "sensor" and entity.translation_key == "battery":
            return entity.entity_id
    return None


def device_list(hass: HomeAssistant, user) -> list[dict]:
    """The remotes this user may configure, as the panel's list rows.

    Scoped rather than complete: an administrator sees every remote, anyone
    else only the ones assigned to them, and a user with none gets an empty
    list and the panel's own empty state. The assignment itself travels with
    the row for administrators, so their device list can say who holds a
    remote without a second round-trip; nobody else is told who else is on it.
    """
    dev_reg = dr.async_get(hass)
    allowed = accessible_entry_ids(hass, user)
    devices = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is not ConfigEntryState.LOADED:
            continue
        if entry.entry_id not in allowed:
            continue
        entry_devices = dr.async_entries_for_config_entry(dev_reg, entry.entry_id)
        if not entry_devices:
            continue
        conn = entry_connection(entry)
        available = bool(conn and conn.connected)
        dev = entry_devices[0]
        device_name = (dev.name_by_user or dev.name or "").strip()
        device_id = conn.device_id if available else (entry.unique_id or entry.data.get("device_id"))
        title = device_name or (entry.title or "").strip() or device_id or entry.entry_id or "lizaIP"
        row = {
            "entry_id": entry.entry_id,
            "title": title,
            "available": available,
            "device_id": device_id,
            # The remote's own short id -- the hex in its title -- stable and
            # readable whether it is connected or not. `device_id` above is
            # neither: it flips between registry id and short id.
            #
            # `__init__.py` writes the same value into `configuration_url`.
            "slug": entry.unique_id or entry.data.get("device_id") or entry.entry_id,
            "sw_version": entry.data.get("sw_version"),
            # The pill doubles as a battery gauge; the panel reads the level
            # from `hass.states` so it stays live. None where the sensor has
            # not been created yet, and the pill is then just a pill.
            "battery_entity": _battery_entity(hass, entry.entry_id),
        }
        if is_admin_user(user):
            row["assigned_users"] = sorted(assigned_user_ids(entry))
        devices.append(row)
    return devices


def _remember_language(hass: HomeAssistant, connection, msg: dict) -> None:
    """Keep the panel's language, if the caller may set it.

    The list answers everybody, so a stranger sees an empty panel rather than
    an error -- but the remembered language is the installation's, so only
    somebody who holds a remote may set it.
    """
    if "language" in msg and holds_any_entry(hass, connection.user):
        remember_panel_language(hass, msg["language"])


@websocket_api.websocket_command({
    "type": "lizaip_config/list_devices",
    vol.Optional("language"): str,
})
@websocket_api.async_response
async def ws_list_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """The caller's own remotes, once.

    No longer administrators only: the list is what scopes the panel, and it
    answers an assigned user with their remotes and everyone else with nothing.
    """
    _remember_language(hass, connection, msg)
    connection.send_result(msg["id"], device_list(hass, connection.user))


@websocket_api.websocket_command({
    "type": "lizaip_config/subscribe_devices",
    vol.Optional("language"): str,
})
@websocket_api.async_response
async def ws_subscribe_devices(hass: HomeAssistant, connection, msg: dict) -> None:
    """The same list, and again whenever the assignments move.

    A subscription rather than a second poll because the list is the caller's
    scope: a remote taken away from someone has to leave their open panel at
    once, not at the next reload, and one newly given to them has to appear
    without one.

    Availability rides along for the same reason. Home Assistant only lets an
    administrator subscribe to a custom event, so without this an assigned
    user's Online badge would be whatever it was when the panel opened.

    So does a rename: the row's title is the device's name, and a remote
    renamed from the device page or the integrations card has to say so in the
    open panel rather than at the next reload.
    """
    _remember_language(hass, connection, msg)

    @callback
    def _send(_event=None) -> None:
        connection.send_message({
            "id": msg["id"],
            "type": "event",
            "event": {"devices": device_list(hass, connection.user)},
        })

    @callback
    def _renamed(event) -> None:
        """Re-send only for a lizaIP device whose name actually moved: the
        list is a per-user scope walk, not something to rebuild on every
        registry touch."""
        device = renamed_device(hass, event)
        if device is not None and any(i[0] == DOMAIN for i in device.identifiers):
            _send()

    unsubscribe = (
        async_dispatcher_connect(hass, SIGNAL_ASSIGNMENTS_CHANGED, _send),
        hass.bus.async_listen(LIZAIP_AVAILABILITY_EVENT, _send),
        hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, _renamed),
    )

    @callback
    def _stop() -> None:
        for unsub in unsubscribe:
            unsub()

    connection.subscriptions[msg["id"]] = _stop
    connection.send_result(msg["id"])
    _send()


@websocket_api.websocket_command({
    "type": "lizaip_config/get_blueprint",
    vol.Optional("entry_id"): str,
})
@require_device_access
@websocket_api.async_response
async def ws_get_blueprint(hass: HomeAssistant, connection, msg: dict) -> None:
    """The face of one remote, or the default when the panel has not picked one.

    ``entry_id`` is optional rather than required because the panel loads the
    blueprint in the same opening round-trip as the device list -- it has
    nothing to name yet -- and asks again once a device is selected. Requiring
    it would mean an empty panel until the second request landed.
    """
    result = await async_get_blueprint(hass, msg.get("entry_id"))
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({
    "type": "lizaip_config/goto_page",
    vol.Required("entry_id"): str,
    vol.Required("page_id"): PAGE_ID_SCHEMA,
})
@require_device_access
@websocket_api.async_response
async def ws_goto_page(hass: HomeAssistant, connection, msg: dict) -> None:
    """Send a 32-bit page id to the device without changing stored page order."""
    conn = live_connection(hass, connection, msg)
    if conn is None:
        return
    try:
        await conn.goto_page(msg["page_id"])
    except Exception as err:  # noqa: BLE001
        send_failure(hass, connection, msg, "failed", err, logger=_LOGGER, what="Opening the page")
        return
    connection.send_result(msg["id"], {"success": True})


async def _wipe_pages(conn) -> None:
    """Empty the remote under the sync lock, ready to be rebuilt from scratch.

    `clear_all` only forgets the page list; the pages the device refused
    before (for lack of room) are retried too, because a remote with nothing on
    it has no reason to refuse them.
    """
    async with conn.page_cache.lock:
        await conn.clear_all()
        conn.page_cache.reset()


@websocket_api.websocket_command({
    "type": "lizaip_config/clear_device_pages",
    vol.Required("entry_id"): str,
})
@require_device_access
@websocket_api.async_response
async def ws_clear_device_pages(hass: HomeAssistant, connection, msg: dict) -> None:
    """Wipe every page off the device, then rebuild it from the store.

    This is the protocol's full re-sync (PROTOCOL.md §clear_all) and the way
    back from a device whose page table no longer matches what it reports --
    stale pages, a half-written setup, a firmware that has run out of room.
    Nothing is lost: the store is the source of truth and the rebuild follows
    immediately.

    Held under the same lock as an ordinary sync, so a scheduled one cannot
    land between the wipe and the rebuild and write pages into a device that is
    halfway through being emptied.
    """
    conn = live_connection(hass, connection, msg)
    if conn is None:
        return
    try:
        await _wipe_pages(conn)
    except Exception as err:  # noqa: BLE001
        send_failure(
            hass, connection, msg, "failed", err, logger=_LOGGER, what="Clearing the device's pages",
        )
        return

    # Outside the lock: `sync_config_to_device` takes it itself.
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    rebuilt = await sync_config_to_device(hass, entry)
    connection.send_result(msg["id"], {"success": True, "rebuilt": rebuilt})


@websocket_api.websocket_command({
    "type": "lizaip_config/restore_config",
    vol.Required("entry_id"): str,
    vol.Required("token"): str,
})
@require_device_access
@websocket_api.async_response
async def ws_restore_config(hass: HomeAssistant, connection, msg: dict) -> None:
    """Put a previously downloaded configuration back, and re-sync the remote.

    The archive arrived over HTTP and was parsed and parked there; `token` is
    what the panel got back, and reaching this command means the user has seen
    what the archive holds and said yes. The upload is single-use: a confirmed
    restore cannot be replayed by a stale tab.

    The order matters. Files first, because they are the configuration and
    everything else is a consequence of them. Then the store's caches, which
    still describe what was on disk a moment ago. Then the announcement, so the
    panel and the variable listener reread. The remote comes last, and a remote
    that cannot be reached does not fail the restore -- the configuration *is*
    restored at that point, and the user is told the device will catch up rather
    than that nothing happened.
    """
    device_id = resolve_device_id(hass, msg["entry_id"])
    if not device_id:
        connection.send_error(msg["id"], "not_found", "Device not found")
        return

    parsed = async_take_upload(hass, msg["token"])
    if parsed is None:
        connection.send_error(
            msg["id"], "expired", "That upload has expired; choose the file again"
        )
        return

    # The upload view refuses these too; this is the gate that counts, because
    # a theme lands in the library every remote draws from.
    if not is_admin_user(connection.user) and archive_carries_themes(parsed["files"]):
        connection.send_error(
            msg["id"], "unauthorized",
            "This archive carries a theme, which every remote shares. "
            "Ask an administrator to restore it.",
        )
        return

    await _apply_restore(hass, connection, msg, device_id, parsed)


async def _apply_restore(
    hass: HomeAssistant, connection, msg: dict, device_id: str, parsed: dict
) -> None:
    """Write a checked configuration, answer the panel, and rebuild the remote.

    Split out from the command so the parsing and the confirmation stay there
    and everything after "these are the files" reads as one sequence.
    """
    log = device_id_logger(_LOGGER, hass, device_id)
    store = find_store(hass)
    # The swap and the forgetting are one change: a save that slipped between
    # them would write the configuration this is replacing back out, or sweep
    # away the pages it just put there using the page ids it read before.
    lock = store.device_lock(device_id) if store is not None else nullcontext()
    try:
        async with lock:
            await async_restore_files(hass, device_id, parsed["files"])
            if store is not None:
                store.async_forget_device(device_id)
                # The archive's own stamps are not evidence of anything; a
                # non-admin restoring it is the author of every step in it.
                user = getattr(connection, "user", None)
                if user is not None and not user.is_admin:
                    await store.async_stamp_restored(device_id, user)
    except OSError as err:
        log.exception("Restoring the configuration failed")
        connection.send_error(msg["id"], "failed", str(err))
        return
    # The archive may have brought a theme with it, and a page resolving a
    # theme the registry has not read yet draws the default look instead.
    await async_reload_themes(hass)
    # The sync this would otherwise start would race the wipe below, which is
    # the one thing an event-driven sync cannot do for itself.
    fire_config_changed(hass, msg["entry_id"], sync_handled=True)
    # The buttons point at different entities now, and the listener's watch
    # list was read when the panel loaded.
    await refresh_state_listener(hass, msg["entry_id"])

    log.info("Restored %d configuration file(s)", parsed["file_count"])

    # A full re-sync, because the page set changed wholesale -- started rather
    # than awaited, as it costs a device round trip per page and the panel needs
    # none of it. A failure out here is logged; the next hello re-syncs anyway.
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    conn = entry_connection(entry)
    # A remote that is away is not told anything: the files are on disk and
    # the next hello syncs them, which is the same outcome by a slower road.
    if conn is not None and conn.connected:
        async def _resync() -> None:
            try:
                await _wipe_pages(conn)
                await sync_config_to_device(hass, entry)
            except Exception as err:  # noqa: BLE001 — the files are already restored
                log.warning("Re-syncing after a restore failed: %s", err)

        entry.async_create_background_task(hass, _resync(), f"lizaip restore re-sync {device_id}")

    connection.send_result(msg["id"], {
        "success": True,
        "device_id": device_id,
        "source_device_id": parsed.get("device_id"),
        "pages": parsed["pages"],
        "files": parsed["file_count"],
    })
