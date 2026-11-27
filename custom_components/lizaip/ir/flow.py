"""Adding an IR device as a config subentry, on one page: a brand and a name.

A brand's first code set that has a key the remote knows is the one used; if
the TV ignores it, reconfiguring the device switches to another of the brand's sets.
Devices from typed-in or dropped code tables are added by lizaIP devel."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

# HA types its schemas as probatio; the tests stub voluptuous, which stays the runtime import.
if TYPE_CHECKING:
    import probatio as vol
    from homeassistant.config_entries import ConfigSubentry
else:
    import voluptuous as vol

from homeassistant.config_entries import ConfigSubentryFlow, SubentryFlowResult
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from ..device.const import MODEL_ID
from . import blob as ir_blob
from .client import (
    IrCatalogError,
    IrCodeSet,
    IrEntry,
    async_brands,
    async_code_sets,
)
from .device import (
    IrDevice,
    CONF_BLOB,
    CONF_BRAND,
    CONF_BRAND_NAME,
    CONF_KEYS,
    CONF_TYPE,
    TYPE_TELEVISION,
)
from .keys import KEYS

CONF_NAME = "name"
#: The reconfigure form's pick; a set is named by its blob's checksum, not stored.
CONF_CODE_SET = "code_set_id"

Entries = list[IrEntry] | tuple[IrEntry, ...]


def _pick(entries: Entries, value: str) -> IrEntry | None:
    """The entry chosen from the list, or the one whose name was typed in full."""
    typed = value.strip().casefold()
    return next((e for e in entries if e.id == value), None) or next(
        (e for e in entries if e.name.casefold() == typed), None,
    )


def _current_set(sub: ConfigSubentry) -> str | None:
    """The id of the code set *sub* sends with, from the blob it stores."""
    blob = sub.data.get(CONF_BLOB)
    try:
        return ir_blob.checksum(blob) if blob else None
    except ir_blob.IrBlobError:
        return None


def _known_keys(code_set: IrCodeSet) -> list[str]:
    return [name for name, key in KEYS.items() if key.key_id in code_set.key_ids]


class IrDeviceSubentryFlow(ConfigSubentryFlow):
    """One page: a brand from the Ruwido catalogue, and a name."""

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        """Every catalogue device is a television."""
        model_id = MODEL_ID
        try:
            brands = await async_brands(self.hass, model_id, TYPE_TELEVISION)
        except IrCatalogError as err:
            return self._catalog_abort(err)
        errors: dict[str, str] = {}
        defaults = user_input or {}
        if user_input is not None:
            brand_text = (user_input.get(CONF_BRAND) or "").strip()
            brand = _pick(brands, brand_text) if brand_text else None
            if brand is None:
                errors[CONF_BRAND] = "ir_unknown_brand" if brand_text else "ir_no_brand"
            else:
                try:
                    data = await self._brand_data(model_id, brand)
                except IrCatalogError as err:
                    return self._catalog_abort(err)
                if data is None:
                    return self.async_abort(reason="ir_no_keys")
                name = (user_input.get(CONF_NAME) or "").strip()
                return self.async_create_entry(title=name or brand.name, data=data)
        names = sorted({b.name for b in brands}, key=str.casefold)
        schema: dict[Any, Any] = {
            vol.Optional(CONF_NAME, description={"suggested_value": defaults.get(CONF_NAME)}): str,
            vol.Required(CONF_BRAND, description={"suggested_value": defaults.get(CONF_BRAND)}): SelectSelector(
                SelectSelectorConfig(options=names, mode=SelectSelectorMode.DROPDOWN),
            ),
        }
        return self.async_show_form(
            step_id="user", data_schema=vol.Schema(schema), errors=errors,
        )

    def _catalog_abort(self, err: IrCatalogError) -> SubentryFlowResult:
        if err.translation_key == "ir_catalog_no_key":
            return self.async_abort(reason="ir_catalog_no_key")
        return self.async_abort(reason="ir_catalog_unavailable")

    async def _brand_data(self, model_id: str | None, brand: IrEntry) -> dict[str, Any] | None:
        """The entry data for *brand*, or ``None`` when no code set can send a key."""
        sets = await async_code_sets(self.hass, model_id, TYPE_TELEVISION, brand.id)
        chosen = next((s for s in sets if _known_keys(s)), None)
        if chosen is None:
            return None
        return {
            CONF_TYPE: TYPE_TELEVISION,
            CONF_BRAND: brand.id,
            CONF_BRAND_NAME: brand.name,
            CONF_BLOB: chosen.blob,
            CONF_KEYS: _known_keys(chosen),
        }

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None,
    ) -> SubentryFlowResult:
        """Show the device's keys; a catalogue device can switch to another code set of its brand."""
        sub = self._get_reconfigure_subentry()
        try:
            sets = await self._sendable_sets(sub)
        except IrCatalogError as err:
            return self._catalog_abort(err)
        current = _current_set(sub)
        if user_input is not None:
            chosen = next((s for s in sets if s.id == user_input.get(CONF_CODE_SET)), None)
            if chosen is None or chosen.id == current:
                return self.async_abort(reason="reconfigure_successful")
            return self.async_update_and_abort(
                self._get_entry(), sub, data_updates={
                    CONF_BLOB: chosen.blob, CONF_KEYS: _known_keys(chosen),
                },
            )
        schema: dict[Any, Any] = {}
        if len(sets) > 1:
            options = [
                SelectOptionDict(value=s.id, label=f"CodeSet {i}")
                for i, s in enumerate(sets, 1)
            ]
            schema[vol.Required(CONF_CODE_SET, default=current)] = SelectSelector(
                SelectSelectorConfig(options=options, mode=SelectSelectorMode.DROPDOWN),
            )
        names = [key.name for key in IrDevice(sub).keys]
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema(schema),
            description_placeholders={
                "name": sub.title,
                # Beside a list of code sets the key names are only noise.
                "table": "" if len(sets) > 1 else ", ".join(names),
            },
        )

    async def _sendable_sets(self, sub: ConfigSubentry) -> list[IrCodeSet]:
        """The brand's code sets with a key the remote knows; none for a device not from the catalogue."""
        brand = sub.data.get(CONF_BRAND)
        if sub.data.get(CONF_TYPE) != TYPE_TELEVISION or not brand:
            return []
        return [s for s in await async_code_sets(self.hass, MODEL_ID, TYPE_TELEVISION, brand) if _known_keys(s)]
