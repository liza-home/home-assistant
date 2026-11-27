"""The IR devices entry: one per installation, holding every IR device.

It belongs to no remote, so any remote can send an IR device's keys."""
from __future__ import annotations

from types import MappingProxyType

from homeassistant.config_entries import SOURCE_SYSTEM, ConfigEntry, ConfigSubentry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from ..const import DOMAIN, IR_ENTRY_ID
from ..data import LizaIPIrData
from .custom import parse_table
from .device import CONF_CODES, CONF_KEYS, CONF_TYPE, SUBENTRY_TYPE, TYPE_CUSTOM, IrDevice, ir_subentries


@callback
def async_ensure_ir_entry(hass: HomeAssistant) -> None:
    """Create the IR devices entry unless there is one."""
    if hass.config_entries.async_entry_for_domain_unique_id(DOMAIN, IR_ENTRY_ID) is None:
        hass.async_create_task(hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_SYSTEM},
        ))


async def async_setup_ir_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    entry.runtime_data = LizaIPIrData()
    # A device added or renamed: the registry is brought up to date.
    entry.async_on_unload(entry.add_update_listener(_reload))
    registry = dr.async_get(hass)
    for subentry in ir_subentries(entry):
        registry.async_get_or_create(
            config_entry_id=entry.entry_id,
            config_subentry_id=subentry.subentry_id,
            **IrDevice(subentry).device_info,
        )
    # Earlier versions listed every key as a text entity; buttons replace them.
    entities = er.async_get(hass)
    for stale in er.async_entries_for_config_entry(entities, entry.entry_id):
        if stale.domain == "text":
            entities.async_remove(stale.entity_id)
    await hass.config_entries.async_forward_entry_setups(entry, [Platform.REMOTE, Platform.BUTTON])
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    hass.config_entries.async_schedule_reload(entry.entry_id)


def async_add_custom_device(hass: HomeAssistant, name: str, table: str) -> ConfigSubentry:
    """Add an IR device from a table of key names and codes (see ``custom``).

    Raises :class:`~.custom.IrTableError` for a bad table and
    ``HomeAssistantError`` when the IR devices entry does not exist yet.
    """
    codes = parse_table(table)
    entry = hass.config_entries.async_entry_for_domain_unique_id(DOMAIN, IR_ENTRY_ID)
    if entry is None:
        raise HomeAssistantError(translation_domain=DOMAIN, translation_key="ir_entry_missing")
    subentry = ConfigSubentry(
        data=MappingProxyType({CONF_TYPE: TYPE_CUSTOM, CONF_CODES: codes, CONF_KEYS: list(codes)}),
        subentry_type=SUBENTRY_TYPE,
        title=name.strip() or "Other device",
        unique_id=None,
    )
    hass.config_entries.async_add_subentry(entry, subentry)
    return subentry
