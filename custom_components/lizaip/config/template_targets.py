"""What a template can be bound to: the devices and config entries that fit it.

The questions the template picker, the add-page validation and the LLM tools
all ask of Home Assistant's registries, answered in one place so they cannot
disagree.
"""
from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr

from .page_templates.catalog import is_unbound


def selector_integrations(selector: dict) -> tuple[str, ...]:
    """The integrations a target selector accepts: one name, or a list of them."""
    value = (selector or {}).get("integration")
    if isinstance(value, str):
        return (value,) if value else ()
    if isinstance(value, (list, tuple)):
        return tuple(v for v in value if isinstance(v, str) and v)
    return ()


def entry_domains(hass: HomeAssistant) -> dict[str, str]:
    """``{config entry id: integration}`` for every config entry, read once.

    Asking ``async_entries(integration)`` again for every device made listing
    the devices for one template take seconds on a house of a few hundred.
    """
    return {e.entry_id: e.domain for e in hass.config_entries.async_entries()}


def device_domains(hass: HomeAssistant) -> dict[str, set[str]]:
    """``{device id: domains of its enabled entities}``, in one pass.

    Asking the registry device by device cost seconds on a house of a few
    hundred devices, and every template listed asked again.
    """
    from homeassistant.helpers import entity_registry as er

    domains: dict[str, set[str]] = {}
    for entry in er.async_get(hass).entities.values():
        if entry.device_id and entry.disabled_by is None:
            domains.setdefault(entry.device_id, set()).add(entry.domain)
    return domains


def device_entry_ids(device: Any) -> set[str]:
    """The config entries *device* belongs to.

    ``config_entry_id`` where Home Assistant has it (2026.8 on): from 2026.10
    every read of the old ``config_entries`` files a deprecation report, which
    inspects the stack -- about 11 ms a device, seconds for a template list on a
    house of a few hundred. An older Home Assistant only has ``config_entries``.
    """
    entry_id = getattr(device, "config_entry_id", None)
    if isinstance(entry_id, str) and entry_id:
        return {entry_id}
    return set(getattr(device, "config_entries", None) or ())


def device_integration(
    hass: HomeAssistant, device: Any, integrations: tuple[str, ...],
    domain_of_entry: dict[str, str] | None = None,
) -> str | None:
    """Which of *integrations* owns *device*, or None if none does."""
    if domain_of_entry is None:
        domain_of_entry = entry_domains(hass)
    owners = {domain_of_entry.get(e) for e in device_entry_ids(device)}
    return next((i for i in integrations if i in owners), None)


def eligible_devices(hass: HomeAssistant, device_sel: dict) -> list[dict]:
    """Devices a device-mode template can bind to, named and sorted for a picker."""
    integrations = selector_integrations(device_sel)
    primary_domain = device_sel.get("primary_domain")
    domain_of_entry = entry_domains(hass) if integrations else {}
    domains_by_device = device_domains(hass)
    # Read only if something actually has an area: most templates resolve
    # without one, and the registry is a real lookup.
    areas = None
    devices = []
    for device in dr.async_get(hass).devices:
        if device.disabled_by is not None:
            continue
        if integrations and device_integration(hass, device, integrations, domain_of_entry) is None:
            continue
        domains = domains_by_device.get(device.id, set())
        if not domains or (primary_domain and primary_domain not in domains):
            continue
        area_name = ""
        if device.area_id:
            if areas is None:
                areas = ar.async_get(hass)
            area = areas.async_get_area(device.area_id)
            area_name = area.name if area else ""
        devices.append({
            "id": device.id,
            "name": device.name_by_user or device.name or device.id,
            "area": area_name,
            "domains": sorted(domains),
        })
    devices.sort(key=lambda d: d["name"].lower())
    return devices


def entity_owners(hass: HomeAssistant, entity_id: str) -> tuple[str, str]:
    """``(device id, config entry id)`` of *entity_id*, empty where unknown."""
    if not entity_id:
        return "", ""
    from homeassistant.helpers import entity_registry as er

    entry = er.async_get(hass).async_get(entity_id)
    if entry is None:
        return "", ""
    return entry.device_id or "", entry.config_entry_id or ""


def entity_selector_match(
    hass: HomeAssistant, entity_id: str,
) -> tuple[frozenset[str], frozenset[str], str] | None:
    """What a selector has to accept to fit *entity_id*, or ``None`` for none.

    The integrations and entity domains of the device it belongs to, and the
    integration of its config entry -- the three things a target selector asks
    about.
    """
    device_id, entry_id = entity_owners(hass, entity_id)
    if not device_id and not entry_id:
        return None
    domain_of_entry = entry_domains(hass)
    device = dr.async_get(hass).async_get(device_id) if device_id else None
    integrations = frozenset(
        domain_of_entry[e] for e in device_entry_ids(device) if e in domain_of_entry
    ) if device else frozenset()
    domains = frozenset(device_domains(hass).get(device_id, ())) if device_id else frozenset()
    return integrations, domains, domain_of_entry.get(entry_id, "")


def template_fits(
    template: dict, owners: tuple[frozenset[str], frozenset[str], str],
) -> bool:
    """Whether the entity behind *owners* answers *template*'s target selector.

    The same question the device picker asks of a whole house, put to one
    device. A template that binds to nothing fits nothing in particular.
    """
    if template.get("unbound") or template.get("action"):
        return False
    selector = template.get("target_selector") or {}
    integrations, domains, entry_integration = owners
    entry_sel = selector.get("config_entry") or {}
    if entry_sel:
        return entry_integration in selector_integrations(entry_sel)
    device_sel = selector.get("device") or {}
    return bool(device_sel) and device_selector_accepts(device_sel, [(integrations, domains)])


def target_index(hass: HomeAssistant) -> list[tuple[frozenset[str], frozenset[str]]]:
    """``(owning integrations, entity domains)`` for every enabled device.

    Read once per request, so every template listed is answered from one pass
    over the registries rather than walking them again for each.
    """
    domain_of_entry = entry_domains(hass)
    domains_by_device = device_domains(hass)
    return [
        (
            frozenset(domain_of_entry[e] for e in device_entry_ids(device) if e in domain_of_entry),
            frozenset(domains_by_device.get(device.id, ())),
        )
        for device in dr.async_get(hass).devices
        if device.disabled_by is None
    ]


def template_has_target(
    hass: HomeAssistant, template: dict,
    index: list[tuple[frozenset[str], frozenset[str]]] | None = None,
) -> bool:
    """Whether Home Assistant has anything *template* could be bound to right now.

    Asks the same thing as the device picker -- a device of one of the
    template's integrations carrying its primary domain -- from *index*
    (``target_index``) when given. An unbound template needs nothing, and
    neither does a card that runs a panel routine instead of writing a page.
    """
    if is_unbound(template) or template.get("action"):
        return True
    selector = template.get("target_selector") or {}
    entry_sel = selector.get("config_entry") or {}
    if entry_sel:
        return any(
            not entry.disabled_by
            for integration in selector_integrations(entry_sel)
            for entry in hass.config_entries.async_entries(integration)
        )
    device_sel = selector.get("device") or {}
    if not device_sel:
        return False
    if index is None:
        return bool(eligible_devices(hass, device_sel))
    return device_selector_accepts(device_sel, index)


def device_selector_accepts(
    device_sel: dict, index: list[tuple[frozenset[str], frozenset[str]]],
) -> bool:
    """Whether a device of *index* -- ``(integrations, domains)`` each -- fits *device_sel*."""
    integrations = set(selector_integrations(device_sel))
    primary_domain = device_sel.get("primary_domain")
    return any(
        (not integrations or owners & integrations)
        and (not primary_domain or primary_domain in domains)
        for owners, domains in index
    )
