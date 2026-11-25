"""Adding an IR device as a config subentry, on one page: a brand and a name.

A brand's first code set that has a key the remote knows is the one used.
Devices from typed-in or dropped code tables are added by lizaIP devel."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

# HA types its schemas as probatio; the tests stub voluptuous, which stays the runtime import.
if TYPE_CHECKING:
    import probatio as vol
else:
    import voluptuous as vol

from homeassistant.config_entries import ConfigSubentryFlow, SubentryFlowResult
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

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
    CONF_CODE_SET,
    CONF_KEYS,
    CONF_TYPE,
    TYPE_TELEVISION,
)
from .keys import KEYS

CONF_NAME = "name"

Entries = list[IrEntry] | tuple[IrEntry, ...]


def _pick(entries: Entries, value: str) -> IrEntry | None:
    """The entry chosen from the list, or the one whose name was typed in full."""
    typed = value.strip().casefold()
    return next((e for e in entries if e.id == value), None) or next(
        (e for e in entries if e.name.casefold() == typed), None,
    )


def _known_keys(code_set: IrCodeSet) -> list[str]:
    return [name for name in KEYS if name in code_set.signals]


class IrDeviceSubentryFlow(ConfigSubentryFlow):
    """One page: a brand from the Ruwido catalogue, and a name."""

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        """Every catalogue device is a television."""
        try:
            brands = await async_brands(self.hass, TYPE_TELEVISION)
        except IrCatalogError:
            return self.async_abort(reason="ir_catalog_unavailable")
        errors: dict[str, str] = {}
        defaults = user_input or {}
        if user_input is not None:
            brand_text = (user_input.get(CONF_BRAND) or "").strip()
            brand = _pick(brands, brand_text) if brand_text else None
            if brand is None:
                errors[CONF_BRAND] = "ir_unknown_brand" if brand_text else "ir_no_brand"
            else:
                try:
                    data = await self._brand_data(brand)
                except IrCatalogError:
                    return self.async_abort(reason="ir_catalog_unavailable")
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

    async def _brand_data(self, brand: IrEntry) -> dict[str, Any] | None:
        """The entry data for *brand*, or ``None`` when no code set can send a key."""
        sets = await async_code_sets(self.hass, TYPE_TELEVISION, brand.id)
        chosen = next((s for s in sets if _known_keys(s)), None)
        if chosen is None:
            return None
        return {
            CONF_TYPE: TYPE_TELEVISION,
            CONF_BRAND: brand.id,
            CONF_BRAND_NAME: brand.name,
            CONF_CODE_SET: chosen.id,
            CONF_BLOB: chosen.blob,
            CONF_KEYS: _known_keys(chosen),
        }

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None,
    ) -> SubentryFlowResult:
        """Show the device's name and its key names; nothing here is editable."""
        sub = self._get_reconfigure_subentry()
        if user_input is not None:
            return self.async_abort(reason="reconfigure_successful")
        names = [key.name for key in IrDevice(sub).keys]
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema({}),
            description_placeholders={
                "name": sub.title,
                "keys": str(len(names)),
                "table": ", ".join(names),
            },
        )
