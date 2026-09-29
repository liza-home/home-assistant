"""Service handlers for the lizaIP integration."""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.target import (
    TargetSelection,
    async_extract_referenced_entity_ids,
)

from .const import DOMAIN
from ..config.internal_commands import (
    InternalCommand,
    InternalCommandError,
    build_page_context,
    enabled_commands,
)

_LOGGER = logging.getLogger(__name__)


def async_register_services(hass: HomeAssistant) -> None:
    """Register all lizaIP device services.

    Each service guards itself rather than sharing one "did we register
    anything?" check, so calling this again still fills in whatever is missing.
    """

    async def _handle_firmware_update(call: ServiceCall) -> None:
        """Push a firmware URL to one or all connected lizaIP devices."""
        url: str = call.data["url"]

        for entry in _target_entries(hass, call.data):
            _LOGGER.info(
                "lizaip.firmware_update: sending update request to %s: %s",
                entry.title,
                url,
            )
            await entry.runtime_data.update_firmware(url)

    if not hass.services.has_service(DOMAIN, "firmware_update"):
        hass.services.async_register(
            DOMAIN,
            "firmware_update",
            _handle_firmware_update,
            schema=vol.Schema({
                vol.Required("url"): cv.url,
                vol.Optional("config_entry_id"): cv.string,
            }),
        )

    for command in enabled_commands():
        if not hass.services.has_service(DOMAIN, command.service):
            _register_internal_command(hass, command)

    _LOGGER.debug("Registered lizaIP services")


def _entry_ids_from_devices(hass: HomeAssistant, device_ids) -> set[str]:
    """Config entry ids of the given devices.

    A device may carry several entries when more than one integration
    contributes to it, so the whole set is taken and the caller narrows it.
    """
    if not device_ids:
        return set()

    dev_reg = dr.async_get(hass)
    entry_ids: set[str] = set()
    for device_id in device_ids:
        device = dev_reg.async_get(device_id)
        if device is not None:
            entry_ids |= set(device.config_entries or ())
    return entry_ids


def _entry_ids_from_entities(hass: HomeAssistant, entity_ids) -> set[str]:
    """Config entry ids of the given entities."""
    if not entity_ids:
        return set()

    registry = er.async_get(hass)
    entry_ids: set[str] = set()
    for entity_id in entity_ids:
        entity = registry.async_get(entity_id)
        if entity is not None and entity.config_entry_id:
            entry_ids.add(entity.config_entry_id)
    return entry_ids


def _selected_entry_ids(hass: HomeAssistant, data) -> set[str] | None:
    """Config entry ids a call names, or ``None`` when it names none.

    ``None`` and ``set()`` are deliberately different answers. A call with no
    target at all addresses every connected device, which is the documented
    behaviour of these services; a call that *did* name a target which resolves
    to nothing must not quietly widen into that same "all devices". Navigating
    every remote in the house because an area no longer holds a lizaIP device
    is the one outcome worse than an error message.

    The target kinds are not walked here: HA's own helper expands floor to area
    to device and follows labels. ``config_entry_id`` is handled separately, as
    it is this integration's own addition to the target. Entry ids from other
    integrations can come back and are dropped by the caller.
    """
    payload = data if isinstance(data, dict) else {}

    entry_id = payload.get("config_entry_id")
    entry_ids = {entry_id} if entry_id else set()
    selection = TargetSelection(payload)

    if not selection.has_any_target and not entry_ids:
        return None

    selected = async_extract_referenced_entity_ids(hass, selection)

    entry_ids |= _entry_ids_from_devices(hass, selected.referenced_devices)
    entry_ids |= _entry_ids_from_entities(
        hass, selected.referenced | selected.indirectly_referenced
    )

    return entry_ids


def _target_entries(hass: HomeAssistant, data) -> list:
    """Connected config entries a service call addresses.

    Takes the whole call data rather than one id because a target can be
    written five ways — device, area, floor, label, entity — on top of the
    ``config_entry_id`` field, and a handler that reads only the field it knows
    about would treat the other four as "no target given".

    Raises rather than returning an empty list: "nothing happened" is
    indistinguishable from success in a service call, so the user has to be
    told which of the two reasons applies.
    """
    entries = hass.config_entries.async_entries(DOMAIN)
    selected = _selected_entry_ids(hass, data)
    if selected is not None:
        entries = [e for e in entries if e.entry_id in selected]

    if not entries:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="no_devices",
        )

    connected = [
        e for e in entries
        if getattr(e, "runtime_data", None) is not None and e.runtime_data.connected
    ]
    if not connected:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="not_connected",
        )
    return connected


async def _page_context(hass: HomeAssistant, entry) -> dict:
    """The pages of *entry*'s device, as an internal command sees them.

    An empty context would read as "no page list at hand" and make every name
    unresolvable, so a device whose pages cannot be read reports that rather
    than silently rejecting names it has no opinion about.
    """
    store = hass.data.get(DOMAIN, {}).get("_store")
    device_id = getattr(getattr(entry, "runtime_data", None), "_device_id", None)
    if store is None or not device_id:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="no_pages",
        )
    return build_page_context(await store.async_get_pages(device_id))


def _validated_params(command: InternalCommand, data, context: dict) -> dict:
    """Build *command*'s params, reporting a bad payload the way HA expects.

    Kept as a function rather than a ``try`` around the call site because the
    call site moves: resolution used to happen once before the target loop and
    now happens per entry inside it, and on the way it briefly escaped the
    guard — the raw error then left the service handler and the REST API
    answered a mistyped page name with a 500 instead of a validation message.
    Going through here means a future call site cannot forget the conversion.
    """
    try:
        return command.build_params(data, context)
    except InternalCommandError as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key=err.translation_key,
            translation_placeholders=err.translation_placeholders,
        ) from err


def _register_internal_command(hass: HomeAssistant, command: InternalCommand) -> None:
    """Expose one device-local command as an ordinary HA service.

    Device-local commands are executed by the remote itself when they sit on a
    button, but they are registered here as real services so they also work
    from automations, scripts and the generic action editor — and so a button
    step can be written as a plain ``action: lizaip.<command>``.
    """

    async def _handle(call: ServiceCall) -> None:
        for entry in _target_entries(hass, call.data):
            # Per entry, not once: a target named "Living Room" is a different
            # page on every device, so the payload has to be resolved against
            # the pages of the device it is about to be sent to.
            context = await _page_context(hass, entry)
            params = _validated_params(command, dict(call.data), context)

            _LOGGER.debug(
                "%s: sending %s to %s",
                command.full_service, params, entry.title,
            )
            await command.run(entry.runtime_data, params)

    hass.services.async_register(
        DOMAIN,
        command.service,
        _handle,
        schema=command.schema,
    )
