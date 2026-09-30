"""Config flow for the lizaIP integration.

Handles Zeroconf discovery and WebSocket-based device onboarding.
"""
from __future__ import annotations

import ipaddress
import importlib
import logging
import socket
from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import urlparse

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult, section
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.network import get_url
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
from .device.const import MODEL
from .device.cert import get_ha_certificate_pem

_LOGGER = logging.getLogger(__name__)

DOMAIN = "lizaip"

_PROVISION_TIMEOUT = aiohttp.ClientTimeout(total=5)

# Last-resort name when HA's own hostname cannot be determined. Not unique —
# only correct on a single-HA network — so it is used strictly as a fallback.
_FALLBACK_HA_HOSTNAME = "homeassistant.local"
_FALLBACK_HA_PORT = 8123

# HAOS/Supervisor advertises the host over mDNS as "<hostname>.local".
_MDNS_DOMAIN = ".local"

# Nabu Casa remote UI. A public relay requiring cloud auth — never routable for
# a device on the LAN, so it must never be handed out as ha_hostname.
_CLOUD_DOMAIN = ".ui.nabu.casa"


def _optional_float(value: Any) -> float | None:
    """Normalize an options value to float or None for form defaults."""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_ip(hostname: str) -> bool:
    """True when *hostname* is a bare IPv4/IPv6 literal."""
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return True


def _local_ip() -> str | None:
    """This HA host's LAN address, as seen from the local network."""
    for family, probe in ((socket.AF_INET, "10.255.255.255"), (socket.AF_INET6, "fe80::1")):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                sock.settimeout(0)
                sock.connect((probe, 1))
                addr = sock.getsockname()[0]
        except OSError:
            continue
        if addr and not ipaddress.ip_address(addr).is_loopback:
            return addr
    return None


def _resolve_all(hostname: str) -> set[str]:
    """Every address *hostname* currently resolves to, or an empty set."""
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return set()
    return {info[4][0] for info in infos}


def _supervisor_api() -> tuple[Any, Any]:
    """Resolve ``(is_hassio, get_host_info)`` across HA versions."""
    is_hassio = get_host_info = None
    for module in ("homeassistant.helpers.hassio", "homeassistant.components.hassio"):
        try:
            mod = importlib.import_module(module)
        except ImportError:
            continue
        is_hassio = is_hassio or getattr(mod, "is_hassio", None)
        get_host_info = get_host_info or getattr(mod, "get_host_info", None)

    if not (is_hassio and get_host_info):
        _LOGGER.debug(
            "Supervisor API unavailable (is_hassio=%s, get_host_info=%s)",
            bool(is_hassio), bool(get_host_info),
        )
    return is_hassio, get_host_info


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
                        device = dev_reg.async_get_device(
                            identifiers={(DOMAIN, existing.entry_id)}
                        )
                        if device:
                            dev_reg.async_update_device(
                                device.id, sw_version=self.sw_version
                            )
                        break
            if self.discovered_ips:
                provisioned = await self._async_is_provisioned(self.discovered_ips)
                if provisioned is False:
                    _LOGGER.info(
                        "Known device %s has no Home Assistant address "
                        "(factory reset?) — re-provisioning",
                        unique_id,
                    )
                    self.hass.async_create_task(self._try_reprovision(self.discovered_ips))
                elif provisioned is None:
                    # Not rounded down to "fine". A device we could not ask is
                    # exactly the one that may be sitting there unprovisioned,
                    # and saying nothing is how it stays that way.
                    _LOGGER.warning(
                        "Could not read the Home Assistant address from known "
                        "device %s at %s — leaving it alone rather than "
                        "re-provisioning a device that may not need it",
                        unique_id, self.discovered_ips,
                    )
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
                async with session.get(url, timeout=_PROVISION_TIMEOUT) as resp:
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

    async def _async_is_provisioned(self, device_ips: list[str]) -> bool | None:
        """Whether the device already knows which Home Assistant to reach.

        Decided by reading the value that decides it -- ``ha_hostname`` from
        ``GET /api/config/ha`` -- rather than by a ``status`` field.

        This used to ask ``GET /api/info`` for ``status == "unconfigured"``.
        ``Document/PROTOCOL.md`` described such a field, but its own example
        response did not contain one, and firmware 11.2.7 does not send one
        either (measured: ``device_id``, ``device_name``, ``version``,
        ``protocol_version``, ``capabilities``). So the check read ``None``
        every time, never matched, and a remote that had lost its
        configuration was never repaired. The simulator implemented the
        sentence rather than the example, which is why it went unnoticed.

        Returns ``True`` when an address is stored, ``False`` when the field is
        there but empty, and ``None`` when no IP could answer -- three
        outcomes, because "we could not ask" is not the same answer as "it is
        fine", and treating it as one is what left this broken.
        """
        session = async_get_clientsession(self.hass, verify_ssl=False)
        for device_ip in device_ips:
            url = f"http://{device_ip}:{self._DEVICE_HTTP_PORT}/api/config/ha"
            try:
                async with session.get(url, timeout=_PROVISION_TIMEOUT) as resp:
                    if resp.status != 200:
                        _LOGGER.debug("GET %s returned %s", url, resp.status)
                        continue
                    # `content_type=None` because the parse is the check: this
                    # firmware answers an unknown path with its Wi-Fi setup
                    # page under HTTP 200, so a body that is not JSON means the
                    # endpoint is absent, not that the device is unprovisioned.
                    cfg = await resp.json(content_type=None)
            except Exception as err:
                _LOGGER.debug("GET %s failed: %s", url, err)
                continue
            if not isinstance(cfg, dict):
                _LOGGER.debug("GET %s did not return an object", url)
                continue
            hostname = str(cfg.get("ha_hostname") or "").strip()
            _LOGGER.debug("Device %s reports ha_hostname=%r", device_ip, hostname)
            return bool(hostname)
        return None

    # ------------------------------------------------------------------
    # HA address resolution — what we send to the device
    # ------------------------------------------------------------------

    def _supervisor_hostname(self) -> str | None:
        """HA's OS hostname from the Supervisor, qualified as ``<name>.local``."""
        try:
            is_hassio, get_host_info = _supervisor_api()
            if not (is_hassio and get_host_info) or not is_hassio(self.hass):
                return None
            hostname = ((get_host_info(self.hass) or {}).get("hostname") or "").strip()
        except Exception as err:
            _LOGGER.debug("Supervisor host info unavailable: %s", err)
            return None
        if not hostname:
            return None
        return hostname if hostname.endswith(_MDNS_DOMAIN) else f"{hostname}{_MDNS_DOMAIN}"

    def _url_address(self, **kwargs: Any) -> tuple[str | None, int | None]:
        """``(hostname, port)`` from one of HA's configured URLs.

        Returns ``(None, None)`` when the URL is unset, unparseable, or points
        at Nabu Casa's remote-UI relay.
        """
        try:
            parsed = urlparse(get_url(self.hass, allow_cloud=False, **kwargs))
        except Exception as err:
            _LOGGER.debug("get_url(%s) failed: %s", kwargs, err)
            return None, None

        hostname = parsed.hostname
        if not hostname or hostname.lower().endswith(_CLOUD_DOMAIN):
            return None, None
        port = parsed.port or (443 if parsed.scheme == "https" else _FALLBACK_HA_PORT)
        return hostname.rstrip("."), port

    def _external_address(self) -> tuple[str | None, int | None]:
        """``(hostname, port)`` from HA's external URL, or ``(None, None)``.

        Bare IPs, Nabu Casa relays, and ``.local`` names are excluded — the
        point of this source is a hostname that resolves via normal DNS, so the
        device can reconnect without mDNS.
        """
        host, port = self._url_address(allow_internal=False)
        if not host or _is_ip(host) or host.lower().endswith(_MDNS_DOMAIN):
            return None, None
        return host, port

    def _ha_address(self) -> tuple[str, int]:
        """Return the ``(ha_hostname, ha_port)`` to send to the device.

        Priority:

        1. **External URL hostname** — a real DNS name the device can resolve
           without mDNS, and unambiguous on a multi-HA network.
        2. **Supervisor OS hostname** (``<name>.local``) — unique per host,
           published over mDNS.
        3. **Internal URL hostname**, when it is a name (not an IP).
        4. ``homeassistant.local`` — last resort.

        The port always travels with the hostname it came from.
        """
        ext_host, ext_port = self._external_address()
        if ext_host:
            return ext_host, ext_port or _FALLBACK_HA_PORT

        _, internal_port = self._url_address(allow_external=False)
        port = internal_port or _FALLBACK_HA_PORT

        if hostname := self._supervisor_hostname():
            return hostname, port

        internal_host, _ = self._url_address(allow_external=False)
        if internal_host and not _is_ip(internal_host):
            return internal_host, port

        return _FALLBACK_HA_HOSTNAME, port

    async def _async_ha_address(self) -> tuple[str, int]:
        """``_ha_address()`` with the mDNS name verified to point back at *us*.

        A ``.local`` candidate is resolved and checked against this host's own
        LAN address. If it points elsewhere, the IP is sent instead.
        """
        hostname, port = self._ha_address()

        if _is_ip(hostname) or not hostname.lower().endswith(_MDNS_DOMAIN):
            return hostname, port

        own_ip = await self.hass.async_add_executor_job(_local_ip)
        if not own_ip:
            return hostname, port

        resolved = await self.hass.async_add_executor_job(_resolve_all, hostname)
        if own_ip in resolved:
            return hostname, port

        _LOGGER.warning(
            "%s resolves to %s, not to this Home Assistant (%s) — provisioning "
            "with the IP instead",
            hostname, ", ".join(sorted(resolved)) or "nothing", own_ip,
        )
        return own_ip, port

    # ------------------------------------------------------------------
    # Provisioning — POST /api/config/ha on the device
    # ------------------------------------------------------------------

    async def _try_reprovision(self, device_ips: list[str]) -> None:
        """Push HA's address to the device so it can open its WebSocket."""
        if not self.discovered_port:
            _LOGGER.debug("No device port known — skipping provisioning")
            return

        session = async_get_clientsession(self.hass, verify_ssl=False)
        ha_hostname, ha_port = await self._async_ha_address()

        # HA's stable instance UUID — lets the device verify it is reconnecting
        # to the same HA, not a neighbour with an identical hostname.
        try:
            from homeassistant.helpers.instance_id import async_get as _async_get_instance_id
            ha_uuid = await _async_get_instance_id(self.hass)
        except Exception:
            ha_uuid = None

        payload: dict[str, object] = {
            "ha_hostname": ha_hostname,
            "ha_port": ha_port,
        }
        if ha_uuid:
            payload["ha_uuid"] = ha_uuid

        # Include HA's TLS certificate for WSS certificate pinning.
        wss_cert = await self.hass.async_add_executor_job(get_ha_certificate_pem, self.hass)
        if wss_cert:
            payload["wss_cert"] = wss_cert

        port = self._DEVICE_HTTP_PORT
        for device_ip in device_ips:
            url = f"http://{device_ip}:{port}/api/config/ha"
            try:
                async with session.post(
                    url, json=payload, timeout=_PROVISION_TIMEOUT
                ) as resp:
                    if resp.status == 200:
                        _LOGGER.info(
                            "Provisioned device at %s:%d -> %s:%s",
                            device_ip, port, ha_hostname, ha_port,
                        )
                        return
                    _LOGGER.debug("POST %s returned %s", url, resp.status)
            except Exception as err:
                _LOGGER.debug("POST %s failed: %s", url, err)

        _LOGGER.warning(
            "Provisioning failed for all IPs %s (port %d)",
            device_ips, port,
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
