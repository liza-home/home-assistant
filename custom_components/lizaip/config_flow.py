"""Config flow for the lizaIP integration.

Handles Zeroconf discovery and WebSocket-based device onboarding.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Final

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult, section
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    CONF_DEMO_MODE,
    CONF_DEMO_MODE_DWELL_TIME,
    CONF_DEMO_MODE_SWIPE_TIME,
    CONF_LANGUAGE,
    CONF_OPTIMISTIC_UPDATES,
    LANGUAGE_AUTO,
    SUPPORTED_LANGUAGES,
)
from .slider_throttle import (
    CONF_SLIDER_MIN_INTERVAL_MS,
    DEFAULT_SLIDER_MIN_INTERVAL_MS,
    SLIDER_MIN_INTERVAL_MS_MAX,
)
from . import provisioning
from .device.const import MODEL

_LOGGER = logging.getLogger(__name__)

DOMAIN = "lizaip"


def _optional_float(value: Any) -> float | None:
    """Normalize an options value to float or None for form defaults."""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class LizaIPConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle discovery and onboarding for lizaIP devices."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> LizaIPOptionsFlowHandler:
        """Return the options flow handler."""
        return LizaIPOptionsFlowHandler()

    # The management HTTP API (GET /api/info, POST /api/config/ha) always listens
    # on port 80 on physical hardware, regardless of what the mDNS SRV record
    # advertises (which is the WSS port, typically 443).
    _DEVICE_HTTP_PORT = 80

    # Fallback device info when GET /api/info is unreachable.
    _FALLBACK_DEVICE_INFO: dict[str, Any] = {
        "device_id": "1c:63:49:9a:7c:fd",
        "device_name": "myDevName",
        "version": "0.0.0",
        "protocol_version": 1,
        "capabilities": {
            "buttons_per_page": 12,
            "static_buttons": [
                "button_power",
                "button_volume_up",
                "button_volume_down",
                "button_back",
                "button_voice",
            ],
            "sliders": ["slider_page", "slider_volume"],
            "max_image_size": 32768,
        },
    }

    def __init__(self) -> None:
        super().__init__()
        self.discovered_ip = None
        self.discovered_ips: list[str] = []
        self.discovered_port: int | None = None
        self.device_name = MODEL
        self.sw_version = None
        self.device_info: dict[str, Any] | None = None


    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> FlowResult:
        ipv4 = [str(ip) for ip in discovery_info.ip_addresses if ip.version == 4]
        self.discovered_ip = ipv4[0] if ipv4 else None
        self.discovered_ips = ipv4
        self.discovered_port = discovery_info.port or None

        properties = discovery_info.properties or {}
        firmware_name = properties.get("name")
        self.sw_version = properties.get("version")

        unique_id = discovery_info.name.split(".")[0]
        await self.async_set_unique_id(unique_id)

        if any(e.unique_id == unique_id for e in self._async_current_entries()):
            # Update device info on re-discovery (Gold: discovery-update-info)
            if self.sw_version:
                for existing in self._async_current_entries():
                    if existing.unique_id == unique_id:
                        self.hass.config_entries.async_update_entry(
                            existing, data={**existing.data, "sw_version": self.sw_version}
                        )
                        dev_reg = dr.async_get(self.hass)
                        device = dev_reg.async_get_device_by_identifier(
                            (DOMAIN, existing.entry_id), existing.entry_id
                        )
                        if device:
                            dev_reg.async_update_device(
                                device.id, sw_version=self.sw_version
                            )
                        break
            if self.discovered_ips:
                cfg = await self._async_read_ha_config(self.discovered_ips)
                stored_host = (
                    str(cfg.get("ha_hostname") or "").strip() if cfg else ""
                )
                if cfg is None:
                    # Not rounded down to "fine". A device we could not ask is
                    # exactly the one that may be sitting there unprovisioned,
                    # and saying nothing is how it stays that way.
                    _LOGGER.warning(
                        "Could not read the Home Assistant address from known "
                        "device %s at %s — leaving it alone rather than "
                        "re-provisioning a device that may not need it",
                        unique_id, self.discovered_ips,
                    )
                elif not stored_host:
                    _LOGGER.info(
                        "Known device %s has no Home Assistant address "
                        "(factory reset?) — re-provisioning",
                        unique_id,
                    )
                    self.hass.async_create_task(self._try_reprovision(self.discovered_ips))
                elif await self._async_address_is_stale(cfg, unique_id):
                    self.hass.async_create_task(self._try_reprovision(self.discovered_ips))
                else:
                    _LOGGER.debug(
                        "Re-discovery of known device %s, already provisioned "
                        "— skipping re-provision",
                        unique_id,
                    )
            return self.async_abort(reason="already_configured")

        self._abort_if_unique_id_configured(updates={"sw_version": self.sw_version})

        # Fetch full device info (capabilities, version) per PROTOCOL.md section 2
        self.device_info = await self._fetch_device_info(self.discovered_ips)

        self.device_name = f"{MODEL} ({firmware_name})" if firmware_name else f"{MODEL} {self.discovered_ip}"
        self.context["title_placeholders"] = {"name": self.device_name}
        return await self.async_step_confirm()

    async def _fetch_device_info(self, device_ips: list[str]) -> dict[str, Any] | None:
        """Call GET /api/info on the device's HTTP management port (80).

        Falls back to a hardcoded default if the device is unreachable.
        """
        session = async_get_clientsession(self.hass, verify_ssl=False)
        for device_ip in device_ips:
            url = f"http://{device_ip}:{self._DEVICE_HTTP_PORT}/api/info"
            try:
                async with session.get(url, timeout=provisioning.PROVISION_TIMEOUT) as resp:
                    if resp.status == 200:
                        info = await resp.json(content_type=None)
                        _LOGGER.info(
                            "Device info from %s:%d: id=%s version=%s",
                            device_ip, self._DEVICE_HTTP_PORT,
                            info.get("device_id"), info.get("version"),
                        )
                        return info
            except Exception as err:
                _LOGGER.debug("GET %s failed: %s", url, err)
        _LOGGER.error(
            "Could not reach GET /api/info on any IP %s (port %d) — using fallback capabilities",
            device_ips, self._DEVICE_HTTP_PORT,
        )
        return dict(self._FALLBACK_DEVICE_INFO)

    async def _async_read_ha_config(self, device_ips: list[str]) -> dict | None:
        """What Home Assistant the device is currently set to reach.

        See :func:`provisioning.async_read_ha_config`; this flow asks over the
        addresses mDNS advertised for the device.
        """
        return await provisioning.async_read_ha_config(
            self.hass, device_ips, self._DEVICE_HTTP_PORT
        )

    # ------------------------------------------------------------------
    # HA address resolution — what we send to the device
    # ------------------------------------------------------------------

    def _supervisor_hostname(self) -> str | None:
        return provisioning.supervisor_hostname(self.hass)

    def _server_port(self) -> int:
        return provisioning.server_port(self.hass)

    def _url_address(self, **kwargs: Any) -> tuple[str | None, int | None]:
        return provisioning.url_address(self.hass, **kwargs)

    def _external_address(self) -> tuple[str | None, int | None]:
        return provisioning.external_address(self.hass)

    def _ha_address(self) -> tuple[str, int]:
        return provisioning.ha_address(self.hass)

    async def _async_ha_address(self) -> tuple[str, int]:
        return await provisioning.async_ha_address(self.hass)

    async def _async_address_is_stale(self, cfg: dict, unique_id: str) -> bool:
        """Whether the device is aimed somewhere we would no longer send it.

        A stored address that no longer matches is not by itself a reason to
        act. The device builds its connection as
        ``wss://<ha_hostname>:<ha_port>/api/lizaip/ws``, so a device that *is*
        connected has proved the values it holds -- whatever we would compute
        now, those work, and re-provisioning would take away a working
        connection to try a theory. A changed external URL is the everyday way
        that happens.

        The case worth repairing is the opposite one: the values are wrong, the
        device cannot get through, and nothing notices because ``ha_hostname``
        is merely non-empty. That device is not connected, and that is the
        signal this reads.

        A connection state that cannot be read counts as connected. Discovery
        can run before the entry has loaded, and re-provisioning a device on
        the strength of not having looked yet is the failure this guard exists
        to avoid.
        """
        stored_host = str(cfg.get("ha_hostname") or "").strip()
        wanted_host, wanted_port = await self._async_ha_address()

        # DNS names are case-insensitive, and a trailing dot is the same name.
        same_host = (
            stored_host.rstrip(".").casefold() == wanted_host.rstrip(".").casefold()
        )

        # A port that is absent or unreadable cannot establish a mismatch: the
        # firmware simply may not report one, and inventing a disagreement out
        # of a missing value would re-provision on every discovery.
        try:
            stored_port: int | None = int(cfg["ha_port"])
        except (KeyError, TypeError, ValueError):
            stored_port = None
        same_port = stored_port is None or stored_port == wanted_port

        if same_host and same_port:
            return False

        connection = None
        for entry in self._async_current_entries():
            if entry.unique_id == unique_id:
                connection = getattr(entry, "runtime_data", None)
                break

        stored = f"{stored_host}:{stored_port if stored_port is not None else '?'}"
        wanted = f"{wanted_host}:{wanted_port}"

        if getattr(connection, "connected", True):
            _LOGGER.debug(
                "Device %s is aimed at %s and we would send %s, but it is "
                "connected — leaving the working address alone",
                unique_id, stored, wanted,
            )
            return False

        _LOGGER.info(
            "Device %s is aimed at %s, which is not where this Home Assistant "
            "is (%s), and it is not connected — re-provisioning",
            unique_id, stored, wanted,
        )
        return True

    # ------------------------------------------------------------------
    # Provisioning — POST /api/config/ha on the device
    # ------------------------------------------------------------------

    async def _try_reprovision(self, device_ips: list[str]) -> None:
        """Push HA's address to the device so it can open its WebSocket.

        Needs a port from the mDNS SRV record: without one there is no evidence
        the device even has its HTTP management API up, and the device's own
        announcement is the only thing that can say so here.
        """
        if not self.discovered_port:
            _LOGGER.debug("No device port known — skipping provisioning")
            return

        await provisioning.async_provision(
            self.hass, device_ips, self._DEVICE_HTTP_PORT
        )

    # ------------------------------------------------------------------
    # Other config flow steps
    # ------------------------------------------------------------------

    async def async_step_websocket(self, discovery_info: dict) -> FlowResult:
        device_id = discovery_info.get("device_id", "")
        if not device_id:
            return self.async_abort(reason="no_device_id")

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured()

        self.device_name = f"{MODEL} ({device_id})"
        self.context["title_placeholders"] = {"name": self.device_name}
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input=None) -> FlowResult:
        if user_input is not None:
            if self.discovered_ips:
                self.hass.async_create_task(self._try_reprovision(self.discovered_ips))

            # Build entry data with device info from GET /api/info
            data: dict[str, Any] = {"sw_version": self.sw_version}
            if self.discovered_port:
                data["device_port"] = self.discovered_port
            if self.device_info:
                data["capabilities"] = self.device_info.get("capabilities")
                data["device_id"] = self.device_info.get("device_id")
                data["protocol_version"] = self.device_info.get("protocol_version")
                if self.device_info.get("version"):
                    data["sw_version"] = self.device_info["version"]

            return self.async_create_entry(
                title=(self.device_name or "").strip() or "lizaIP",
                 data=data,
             )

        return self.async_show_form(
            step_id="confirm",
            description_placeholders={"name": self.device_name},
        )

    async def async_step_user(self, user_input=None) -> FlowResult:
        return self.async_abort(reason="discovery_only")

    async def async_step_reconfigure(self, user_input=None) -> FlowResult:
        """Allow reconfiguring the device name."""
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])
        if user_input is not None:
            new_title = (user_input.get("name") or "").strip() or (entry.title or "").strip() or "lizaIP"
            # Deliberately the non-reloading variant: this step only renames the
            # entry, and `_options_updated` already pushes changes to the device.
            # Reloading here would be a second, redundant reload source, which
            # HA rejects outright from 2026.12 when an update listener exists.
            return self.async_update_and_abort(
                entry,
                title=new_title,
            )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema({
                vol.Required("name", default=entry.title): str,
            }),
        )


#: Collapsible groups on the options form. The keys name the section in the
#: schema *and* in ``strings.json`` (``options.step.init.sections.<key>``), and
#: they must not collide with a field name — ``demo_mode`` is already a boolean
#: on the form, so its section is ``demo``.
SECTION_DEMO: Final = "demo"
SECTION_SLIDERS: Final = "sliders"


class LizaIPOptionsFlowHandler(config_entries.OptionsFlow):
    """Handle lizaIP options.

    One page. The settings people actually change — optimistic updates, the
    remote's language — are at the top, and the two groups that are set once
    and then left alone sit below them in collapsed sections, each behind a
    disclosure arrow.

    Sections rather than subpages: Home Assistant will happily render a menu of
    links (``async_show_menu``), but a menu is a page of its own and cannot
    carry fields, so the everyday settings would move a click away. A section
    gives the same "expand to see more" affordance while keeping one form and
    one save — and it removes the navigation field that previously had to be
    stripped out of the answers by hand.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None,
    ) -> FlowResult:
        """Show and save the whole options form."""
        if user_input is not None:
            # Sections come back nested, one dict per section, while the
            # options are flat — and stay flat, because everything that reads
            # them (`entry.options.get(CONF_DEMO_MODE)`, the slider throttle)
            # predates the sections and has no reason to know about them.
            flat = {k: v for k, v in user_input.items() if k not in _SECTIONS}
            for name in _SECTIONS:
                flat.update(user_input.get(name) or {})

            # Merged rather than replacing: `async_update_entry` writes the
            # options wholesale, so a key absent from this form — one added by
            # a later version, or dropped from the schema — would be erased
            # rather than left alone.
            self.hass.config_entries.async_update_entry(
                self.config_entry,
                options={**self.config_entry.options, **flat},
            )
            # `async_create_entry` would leave the dialog on an extra "Success"
            # page the user has to dismiss.
            return self.async_abort(reason="options_saved")

        options = self.config_entry.options
        current = options.get(CONF_OPTIMISTIC_UPDATES, True)
        # `auto` and not the user's own language: this is the language the
        # *remote* prints, and the default has to be what every device did
        # before the option existed — follow Home Assistant.
        current_lang = options.get(CONF_LANGUAGE, LANGUAGE_AUTO)
        if current_lang not in (LANGUAGE_AUTO, *SUPPORTED_LANGUAGES):
            # A language dropped from SUPPORTED_LANGUAGES would otherwise make
            # the form refuse to open on a value it cannot render.
            current_lang = LANGUAGE_AUTO

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Optional(
                    CONF_OPTIMISTIC_UPDATES,
                    default=current,
                ): bool,
                vol.Optional(
                    CONF_LANGUAGE,
                    default=current_lang,
                ): SelectSelector(
                    SelectSelectorConfig(
                        options=[
                            SelectOptionDict(value=value, label=value)
                            for value in (LANGUAGE_AUTO, *SUPPORTED_LANGUAGES)
                        ],
                        mode=SelectSelectorMode.DROPDOWN,
                        # The option names are translated from
                        # `options.step.init.selector.language.options` in
                        # strings.json rather than spelled out here.
                        translation_key=CONF_LANGUAGE,
                    )
                ),
                vol.Required(SECTION_DEMO): section(
                    self._demo_schema(options),
                    # Collapsed: demo mode is a showroom feature, so on almost
                    # every install this section is noise.
                    {"collapsed": True},
                ),
                vol.Required(SECTION_SLIDERS): section(
                    self._slider_schema(options),
                    {"collapsed": True},
                ),
            }),
        )

    @staticmethod
    def _demo_schema(options: Mapping[str, Any]) -> vol.Schema:
        """Demo mode and its timings, pushed to the device on save."""
        return vol.Schema({
            vol.Optional(
                CONF_DEMO_MODE,
                default=options.get(CONF_DEMO_MODE, False),
            ): bool,
            # None rather than a number, so saving without touching them leaves
            # the device's own timings alone.
            vol.Optional(
                CONF_DEMO_MODE_DWELL_TIME,
                default=_optional_float(options.get(CONF_DEMO_MODE_DWELL_TIME)),
            ): vol.Any(None, vol.Coerce(float)),
            vol.Optional(
                CONF_DEMO_MODE_SWIPE_TIME,
                default=_optional_float(options.get(CONF_DEMO_MODE_SWIPE_TIME)),
            ): vol.Any(None, vol.Coerce(float)),
        })

    @staticmethod
    def _slider_schema(options: Mapping[str, Any]) -> vol.Schema:
        """How much of a slider's event stream is acted on.

        A slider reports continuously while touched and the protocol has no way
        to ask the device for less, so this limit thins the stream host-side.
        """
        return vol.Schema({
            # A slider rather than a box: the setting is judged by how the drag
            # feels, and has no value worth typing exactly.
            vol.Optional(
                CONF_SLIDER_MIN_INTERVAL_MS,
                default=options.get(
                    CONF_SLIDER_MIN_INTERVAL_MS, DEFAULT_SLIDER_MIN_INTERVAL_MS,
                ),
            ): NumberSelector(
                NumberSelectorConfig(
                    min=0,
                    max=SLIDER_MIN_INTERVAL_MS_MAX,
                    step=50,
                    unit_of_measurement="ms",
                    mode=NumberSelectorMode.SLIDER,
                )
            ),
        })


_SECTIONS: Final = (SECTION_DEMO, SECTION_SLIDERS)
