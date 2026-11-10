"""The lizaIP integration.

Single installable integration that manages:
  - Device WebSocket connections (device/ sub-package)
  - Config panel and device sync (config/ sub-package)
  - Image server loaded as imgserv/ sub-package
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_CORE_CONFIG_UPDATE, Platform
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import (
    config_validation as cv,
    device_registry as dr,
)
from homeassistant.helpers.device_registry import CONNECTION_NETWORK_MAC
from homeassistant.helpers.network import get_url
from homeassistant.helpers.typing import ConfigType

from .device import (
    LizaIPConnection,
    LizaIPWebSocketView,
    MANUFACTURER,
    MODEL,
    MODEL_ID,
    WS_PATH,
    async_register_services,
)
from . import action_controller
from .const import (
    CONF_DEMO_MODE,
    CONF_DEMO_MODE_DWELL_TIME,
    CONF_DEMO_MODE_SWIPE_TIME,
    DOMAIN,
)
from .config.panel import async_setup_panel, async_setup_config_entry, async_unload_config_entry
from .config.store import LizaRemoteStore
from .config.restore import async_setup_config_restore
from .config.diagnostics_bundle import async_setup_diagnostics_bundle
from .config.entity_rename import async_setup_entity_rename
from .imgserv import async_setup_imgserv
from .shared.logs import device_logger
from .shared.numbers import to_float
from .runtime import find_store, install_store, panel_language, renamed_device
from .shared.i18n import set_default_language

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.EVENT,
    Platform.NUMBER,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.UPDATE,
]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type LizaIPConfigEntry = ConfigEntry[LizaIPConnection]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """One-time setup: register WS endpoint, services, panel, and load imgserv."""
    # WebSocket endpoint for devices
    hass.http.register_view(LizaIPWebSocketView())
    async_register_services(hass)
    _LOGGER.info("Registered lizaIP WebSocket endpoint at %s", WS_PATH)

    # Action dispatch — single source of truth for button-press → action execution
    action_controller.setup(hass)

    # A `{translate: …}` drawn for no remote in particular -- a panel preview --
    # is in the panel's language, or Home Assistant's.
    set_default_language(lambda: panel_language(hass) or hass.config.language)

    # Config panel (sidebar + WS commands)
    await async_setup_panel(hass)

    # Where a built support bundle is collected from by the browser.
    async_setup_diagnostics_bundle(hass)

    # And where a downloaded configuration is posted back to.
    async_setup_config_restore(hass)

    # A renamed entity keeps working: the stored pages follow the new id.
    # The store is made here rather than in the first entry's setup, because
    # the rename has to reach a remote that is disabled and never loaded one.
    install_store(hass, LizaRemoteStore(hass))
    async_setup_entity_rename(hass)

    # And a renamed remote is called the same thing on both of its pages.
    _async_setup_name_sync(hass)

    # Image server (MDI/logo/text rendering)
    await async_setup_imgserv(hass)

    # The user's own templates, beside the remotes' configuration rather than
    # inside the integration, so an update leaves them alone.
    from .config.page_templates import set_user_templates_dir
    from .config.page_templates.generate import preload_templates
    set_user_templates_dir(hass.config.path("lizaip", "templates"))
    await hass.async_add_executor_job(preload_templates)

    # Themes, read the same way and from the same two places fonts are: the
    # ones shipped with the integration and the user's own. Module state,
    # because imgserv resolves a `theme=` while drawing and has no `hass`.
    from .shared.theme import load_themes, set_themes, user_themes_dir
    themes_dir = user_themes_dir(hass)
    set_themes(await hass.async_add_executor_job(load_themes, themes_dir))

    # Tools for AI assistants: offered to conversation agents and, through
    # Home Assistant's MCP Server, to MCP clients. Once per run, like the panel.
    from .llm_api import async_register_llm_api
    try:
        async_register_llm_api(hass)
    except Exception:  # noqa: BLE001 - assistants are optional; the remote is not
        _LOGGER.exception("Could not offer lizaIP's tools to AI assistants")

    return True


async def async_setup_entry(hass: HomeAssistant, entry: LizaIPConfigEntry) -> bool:
    """Set up one lizaIP device from a config entry."""
    mac: str | None = entry.data.get("device_id")  # stored as MAC string, e.g. "AA:BB:CC:DD:EE:FF"

    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.entry_id)},
        # Physical MAC address — enables HA to correlate this with other
        # integrations that discover the same hardware.
        connections={(CONNECTION_NETWORK_MAC, mac)} if mac else set(),
        name=entry.title,
        manufacturer=MANUFACTURER,
        model=MODEL,
        # Hardware product SKU (identifies the exact variant on the ruwido
        # product line; matches the firmware release channel). The device's own
        # answer once a handshake has reported one, and the shipped default
        # until then — the same value the config panel picks a blueprint by, so
        # the registry and the drawn remote cannot disagree.
        model_id=entry.data.get("model_id") or MODEL_ID,
        # Firmware version installed on the device (kept up-to-date via hello).
        sw_version=entry.data.get("sw_version"),
        # Hardware revision is not yet exposed by the device protocol;
        # populated once the device reports it.
        hw_version=entry.data.get("hw_version"),
    )

    # A remote renamed on its device page before this sync existed, or while
    # its entry was unloaded, still has the two names apart. Settle them once.
    _follow_device_name(hass, device, entry)

    # Add a "Visit" link on the device page pointing to the config panel.
    # Must be an absolute URL — HA rejects relative paths.
    #
    # It lands on the panel's default tab, Buttons: HA gives an integration
    # only this one hook on the device page, so the destination has to be the
    # one that suits arriving without a stated intent, and that is the remote's
    # configuration rather than a troubleshooting tool.
    #
    # The entry id is a path segment rather than a query parameter: the panel
    # routes on its path now, so `?entry_id=` would be rewritten into this form
    # the moment it rendered. The query form is still understood.
    #
    # The short device id is preferred because it is the hex the panel shows in
    # its toolbar, so a user reading this link can tell which remote it opens
    # where a 26 character ULID tells them nothing. Either spelling resolves.
    try:
        ha_base = get_url(hass, prefer_external=False)
        slug = entry.unique_id or entry.data.get("device_id") or entry.entry_id
        config_url = f"{ha_base}/lizaip/{slug}"
        dr.async_get(hass).async_update_device(
            device.id, configuration_url=config_url
        )
    except Exception:
        # Non-critical: without it the device page simply has no "Configure"
        # link, and the panel is still reachable from the sidebar. Logged
        # rather than passed over, because an instance with no reachable URL
        # at all is worth knowing about when something else goes wrong later.
        _LOGGER.debug(
            "No configuration URL for %s; the device page will have no link to the panel",
            entry.entry_id, exc_info=True,
        )

    connection = LizaIPConnection(hass, entry, device.id)
    entry.runtime_data = connection

    # The registry entry created above carries the model this integration last
    # saw. Keeping it current is `_persist_hello_facts`' job rather than a
    # listener's: the device may open the handshake itself, and that path is
    # answered in place without firing the hello event.

    # Initialize per-device store (lazy-loading, no upfront load needed)
    store = find_store(hass)
    if store is None:
        store = LizaRemoteStore(hass)
        install_store(hass, store)

    # Ensure a default storage file exists for this device (with all button slots)
    await store.async_ensure_default(device.id)

    # Set up config-panel listeners (state tracking, device sync)
    await async_setup_config_entry(hass, entry)

    # Re-push the whole page when the options change. `optimistic_updates` is
    # read live and needs nothing, but the language is baked into every label
    # at sync time: without this a user picks Italian, sees nothing happen, and
    # the remote keeps its old words until the next restart or config save.
    #
    # A targeted resync rather than `async_reload`: the labels are the only
    # thing an option can change on the device, and reloading would drop the
    # websocket connection to a remote that is working fine.
    entry.async_on_unload(entry.add_update_listener(_options_listener(device.id, entry)))
    _watch_server_language(hass, entry)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _watch_queue_targets(hass, entry)
    return True


def _options_listener(device_id: str, entry: LizaIPConfigEntry):
    """The entry's update listener: apply what changed, and only that.

    Remembers the last options, title and demo settings it acted on, so each
    update is compared with what the remote already has.
    """
    last_demo_mode = bool(entry.options.get(CONF_DEMO_MODE, False))
    last_demo_dwell = to_float(entry.options.get(CONF_DEMO_MODE_DWELL_TIME))
    last_demo_swipe = to_float(entry.options.get(CONF_DEMO_MODE_SWIPE_TIME))
    last_title = entry.title
    last_options = dict(entry.options)

    async def _options_updated(hass: HomeAssistant, updated: LizaIPConfigEntry) -> None:
        nonlocal last_demo_mode, last_demo_dwell, last_demo_swipe, last_title, last_options
        from .config.device_sync import sync_config_to_device  # noqa: PLC0415

        log = device_logger(_LOGGER, updated)

        if updated.title != last_title:
            last_title = updated.title
            _follow_entry_title(hass, device_id, updated.title)
            # A rename alone changes nothing the remote is sent: its own name is
            # on no page, so there is nothing to sync.
            if dict(updated.options) == last_options:
                return
        last_options = dict(updated.options)

        demo_mode = bool(updated.options.get(CONF_DEMO_MODE, False))
        demo_dwell = to_float(updated.options.get(CONF_DEMO_MODE_DWELL_TIME))
        demo_swipe = to_float(updated.options.get(CONF_DEMO_MODE_SWIPE_TIME))
        demo_dwell_cmp = demo_dwell if demo_mode else None
        demo_swipe_cmp = demo_swipe if demo_mode else None

        if (
            demo_mode != last_demo_mode
            or demo_dwell_cmp != (last_demo_dwell if last_demo_mode else None)
            or demo_swipe_cmp != (last_demo_swipe if last_demo_mode else None)
        ):
            try:
                await updated.runtime_data.set_demo_mode(
                    demo_mode,
                    dwell_time=demo_dwell if demo_mode else None,
                    swipe_time=demo_swipe if demo_mode else None,
                )
            except Exception:  # noqa: BLE001
                # Never block options saves when the device is offline.
                # Keep the previous marker so a later save retries automatically.
                log.debug(
                    "DemoMode apply failed; will retry on next options save",
                    exc_info=True,
                )
            else:
                last_demo_mode = demo_mode
                last_demo_dwell = demo_dwell
                last_demo_swipe = demo_swipe

        try:
            await sync_config_to_device(hass, updated)
        except Exception:  # noqa: BLE001
            # A device that is offline right now simply gets the new wording on
            # its next ordinary sync. Never let it fail the options save.
            log.debug(
                "Options resync failed; labels follow on next sync", exc_info=True,
            )

    return _options_updated


def _follow_entry_title(hass: HomeAssistant, device_id: str, title: str) -> None:
    """Carry an entry rename through to the device registry.

    The device is registered under the entry's title, but that happens once,
    at setup. Renaming the entry writes the title alone, so without this the
    device page -- and every entity name Home Assistant resolves from it --
    keeps the old name until the next reload.

    ``name_by_user`` and not ``name``: that is the field the device page
    writes, and the one :func:`_async_setup_name_sync` reads back, so the two
    halves of a rename meet in the same place whichever end started it.
    """
    if not title:
        return
    registry = dr.async_get(hass)
    device = registry.async_get(device_id)
    if device is None or device.name_by_user == title:
        return
    registry.async_update_device(device_id, name_by_user=title)


@callback
def _follow_device_name(hass: HomeAssistant, device, entry: ConfigEntry) -> None:
    """Carry a device rename back to the entry's title.

    ``name_by_user`` is what the device page writes and ``name`` what the
    integration registered, so that order is the name Home Assistant itself
    shows. Nothing is written when the title already says it, which is what
    keeps this and :func:`_follow_entry_title` from chasing each other.
    """
    name = (device.name_by_user or device.name or "").strip()
    if not name or entry.title == name:
        return
    hass.config_entries.async_update_entry(entry, title=name)


@callback
def _async_setup_name_sync(hass: HomeAssistant) -> None:
    """Keep ``entry.title`` saying what the device page says.

    A lizaIP can be renamed in two places that do not know about each other:
    the device page writes ``name_by_user``, the integrations card writes
    ``entry.title``. Reading both everywhere would mean threading a ``hass``
    through every log line and every label. Writing one from the other instead
    leaves a single name, so ``entry.title`` stays the answer it always was.
    """
    @callback
    def _renamed(event) -> None:
        device = renamed_device(hass, event)
        if device is None:
            return
        # `config_entry_id`, not the `config_entries` set: a device belongs to
        # exactly one entry since HA 2026.8 and the set stops working in 2027.10.
        entry = hass.config_entries.async_get_entry(device.config_entry_id)
        if entry is not None and entry.domain == DOMAIN:
            _follow_device_name(hass, device, entry)

    hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, _renamed)


def _watch_queue_targets(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Keep a queue sensor for every speaker the buttons point at.

    After the platforms, not before: the sensor platform is what can add
    them, and nothing can be added until it is set up.
    """
    from .config.const import CONFIG_CHANGED_EVENT
    from .config.media_queue import async_sync_sensors

    async def _sync(_event=None) -> None:
        await async_sync_sensors(hass)

    entry.async_on_unload(hass.bus.async_listen(CONFIG_CHANGED_EVENT, _sync))
    hass.async_create_task(_sync())


def _watch_server_language(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when the server language changes.

    Entity names are resolved on the server, and ``EntityPlatform.async_setup``
    copies the wordings in once, when the platform is set up. Changing the
    language refills Home Assistant's own translation cache, but nothing
    re-reads it into a platform that is already running, so the buttons keep
    the language they were set up in until something reloads them. The
    frontend's own text switches over immediately, which makes the stale names
    look like a fault in the remote rather than a cache.

    Reloading is the supported way to pick the new wordings up: the entry is
    torn down and set up again, and the platform reads the translations
    afresh. The device reconnects as part of that, which is why this reacts to
    the language and nothing else -- the same event carries unrelated core
    settings such as the location, the currency and the unit system, and a
    remote that drops its connection whenever the elevation is corrected would
    be a poor trade.
    """
    setup_language = hass.config.language

    @callback
    def _language_changed(_event: Event) -> None:
        nonlocal setup_language
        if hass.config.language == setup_language:
            return
        device_logger(_LOGGER, entry).debug(
            "Server language changed from %s to %s; reloading so entity "
            "names follow", setup_language, hass.config.language,
        )
        # Updated before the reload is scheduled, so a second event for the
        # same change cannot queue a second reload.
        setup_language = hass.config.language
        hass.config_entries.async_schedule_reload(entry.entry_id)

    # Tied to the entry: a reload sets this up again, and without this the
    # listeners would stack up, one per reload, each scheduling its own.
    entry.async_on_unload(
        hass.bus.async_listen(EVENT_CORE_CONFIG_UPDATE, _language_changed)
    )


async def async_unload_entry(hass: HomeAssistant, entry: LizaIPConfigEntry) -> bool:
    """Unload a lizaIP config entry."""
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        from .config.media_queue import async_sync_sensors
        from .config.media_queue.sensor import async_release

        # The queue sensors this entry added went with its platform; another
        # loaded entry adds them back.
        async_release(hass, entry.entry_id)
        await async_sync_sensors(hass)
        await async_unload_config_entry(hass, entry)
        # Before `disconnect()`: the cache lives on `runtime_data`, and Scripts
        # register themselves in `hass.data` with a strong reference, so nothing
        # reclaims them once the entry stops being reachable.
        await action_controller.async_unload_scripts(hass, entry.entry_id)
        await entry.runtime_data.disconnect()
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: LizaIPConfigEntry) -> None:
    """Clean up the WebSocket connection, storage, and caches for a permanently
    removed device.

    HA unloads a config entry before removing it, so `entry.runtime_data`'s
    WebSocket has normally already been closed by `async_unload_entry` and its
    listeners torn down by `async_unload_config_entry`. This runs the same
    teardown again defensively: if unload failed (or was skipped), a stale
    connection would otherwise remain reachable via `_find_connection()` in
    `device/websocket.py` even though the device it belongs to is gone.
    """
    connection = getattr(entry, "runtime_data", None)
    if connection is not None:
        # Defensive: normally already done by `async_unload_entry`, but a failed
        # or skipped unload would otherwise strand the compiled Scripts.
        await action_controller.async_unload_scripts(hass, entry.entry_id)
        await connection.disconnect()

    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_device_by_identifier(
        (DOMAIN, entry.entry_id), entry.entry_id
    )
    device_id = device.id if device else None

    store: LizaRemoteStore | None = find_store(hass)
    if store and device_id:
        await store.async_remove_device(device_id)

    # Gestures and cycle positions are otherwise never evicted for a device
    # that no longer exists. Compiled scripts went with the connection above.
    action_controller.forget_remote(entry.entry_id)

    # Somebody may have just lost their only remote, and with it their reason
    # to see the panel at all.
    from .config.access import (  # noqa: PLC0415
        async_notify_assignments_changed,
        async_reconcile_sidebar,
    )
    await async_reconcile_sidebar(hass)
    async_notify_assignments_changed(hass)
