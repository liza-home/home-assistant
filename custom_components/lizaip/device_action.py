"""Device actions of an IR device: one per key, sent through a chosen lizaIP."""
from __future__ import annotations

from typing import Any, Final

import voluptuous as vol

from homeassistant.const import CONF_DEVICE_ID, CONF_DOMAIN, CONF_TYPE
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.selector import DeviceSelector, DeviceSelectorConfig
from homeassistant.helpers.typing import ConfigType, TemplateVarsType

from .const import DOMAIN
from .device.const import MODEL
from .ir.page_codes import ir_device_of

CONF_VIA: Final = "via"

ACTION_SCHEMA: Final = cv.DEVICE_ACTION_BASE_SCHEMA.extend({
    vol.Required(CONF_TYPE): cv.string,
    vol.Required(CONF_VIA): cv.string,
})


async def async_get_actions(hass: HomeAssistant, device_id: str) -> list[dict[str, Any]]:
    """A send action for every key the IR device *device_id* has."""
    device = ir_device_of(hass, device_id)
    if device is None:
        return []
    return [
        {CONF_DEVICE_ID: device_id, CONF_DOMAIN: DOMAIN, CONF_TYPE: key.name}
        for key in device.keys
    ]


async def async_get_action_capabilities(
    hass: HomeAssistant, config: ConfigType,
) -> dict[str, vol.Schema]:
    """The lizaIP that sends the key, which every action has to name."""
    return {"extra_fields": vol.Schema({
        vol.Required(CONF_VIA): DeviceSelector(
            DeviceSelectorConfig(integration=DOMAIN, model=MODEL),
        ),
    })}


async def async_call_action_from_config(
    hass: HomeAssistant, config: ConfigType, variables: TemplateVarsType,
    context: Context | None,
) -> None:
    await hass.services.async_call(
        DOMAIN, "send_ir",
        {"device_id": config[CONF_DEVICE_ID], "key": config[CONF_TYPE], "via": config[CONF_VIA]},
        blocking=True, context=context,
    )
