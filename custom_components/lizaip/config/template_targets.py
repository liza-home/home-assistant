"""What a template can be bound to: the devices and config entries that fit it.

The questions the template picker, the add-page validation and the LLM tools
all ask of Home Assistant's registries, answered in one place so they cannot
disagree.
"""
from __future__ import annotations

import html
from collections.abc import Iterator
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr

from .page_templates.catalog import TEMPLATE_PAGES_KEY, is_unbound


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


def entity_capabilities(hass: HomeAssistant, entity_id: str) -> set[str]:
    """``key:value`` for every capability *entity_id* declares.

    A lamp says it can do colour through ``supported_color_modes``, which the
    entity registry holds; an entity registered without any is asked of its
    live state instead.
    """
    from homeassistant.helpers import entity_registry as er

    entry = er.async_get(hass).async_get(entity_id)
    caps = getattr(entry, "capabilities", None)
    if not isinstance(caps, dict):
        caps = getattr(hass.states.get(entity_id), "attributes", None)
    return _capability_values(caps) if isinstance(caps, dict) else set()


def _capability_values(caps: dict) -> set[str]:
    """``key:value`` for each capability, one entry per value of a list."""
    flat: set[str] = set()
    for key, value in caps.items():
        values = value if isinstance(value, (list, tuple, set, frozenset)) else (value,)
        flat.update(f"{key}:{v}" for v in values if isinstance(v, (str, int)))
    return flat


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


def eligible_devices(
    hass: HomeAssistant, device_sel: dict, *, services: bool = True,
) -> list[dict]:
    """Devices a device-mode template can bind to, named and sorted for a picker.

    ``services=False`` leaves out service devices (add-ons, integrations).
    """
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
        if not services and getattr(device, "entry_type", None) == dr.DeviceEntryType.SERVICE:
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
            # UPnP-discovered names may carry HTML entities ("43&quot; QLED");
            # a name the user typed is kept as written.
            "name": device.name_by_user or html.unescape(device.name or "") or device.id,
            "area": area_name,
            "manufacturer": getattr(device, "manufacturer", None) or "",
            "model": getattr(device, "model", None) or "",
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


def _requires(button: Any) -> dict:
    asked = button.get("requires") if isinstance(button, dict) else None
    return asked if isinstance(asked, dict) else {}


def _usable(button: Any, caps: set[str] | None, empty: set[str]) -> bool:
    """Whether *button* asks for nothing *caps* (``None``: unknown) and *empty* deny."""
    asked = _requires(button)
    wanted = asked.get("capabilities")
    if caps is not None and isinstance(wanted, dict):
        values = _capability_values(wanted)
        if values and not values & caps:
            return False
    return asked.get("items") not in empty


def _choices(slot: Any) -> list:
    """A slot's alternatives, best first; a single tile is a list of one."""
    return slot if isinstance(slot, list) else [slot]


def _tiles(pages: dict) -> Iterator[Any]:
    """Every tile on *pages*, alternatives included."""
    for page in pages.values():
        for slot in ((page or {}).get("buttons") or {}).values():
            yield from _choices(slot)


def _links(pages: dict) -> set[str]:
    found: set[str] = set()
    for btn in _tiles(pages):
        goto = btn.get("goto_page") if isinstance(btn, dict) else None
        found.update(goto if isinstance(goto, list) else [goto] if goto else [])
    return found


async def async_empty_placeholders(
    hass: HomeAssistant, template: dict, target_entity: str,
    domain_entities: dict[str, str] | None = None, target_config_entry: str = "",
) -> set[str]:
    """The placeholders a ``requires: {items: ...}`` names that list nothing.

    A source that cannot be read counts as not empty: a tile hidden for good
    because a speaker was asleep once would be worse than one leading nowhere.
    """
    from .page_templates.resolver import PLACEHOLDERS_KEY, normalize_spec
    from .page_templates.sources import async_resolve_source

    declared = template.get(PLACEHOLDERS_KEY) or {}
    asked = {_requires(btn).get("items") for btn in _tiles(template.get(TEMPLATE_PAGES_KEY) or {})}
    empty: set[str] = set()
    for name in asked:
        placeholder = declared.get(name) if isinstance(name, str) else None
        if not isinstance(placeholder, dict):
            continue
        source = str(placeholder.get("source") or "")
        spec = normalize_spec(
            placeholder.get("spec"), source, target_entity, domain_entities, target_config_entry,
        )
        result = await async_resolve_source(hass, source, spec, max_items=1)
        if not result.items and not result.error:
            empty.add(name)
    return empty


def prune_unusable_buttons(
    hass: HomeAssistant, template: dict, target_entity: str, empty: set[str] | None = None,
) -> dict:
    """*template* with each slot set to the first tile *target_entity* can use.

    The entity the tiles act on, not its device: a ceiling lamp's white main
    light gets no colour tiles because its ambient light has colour.

    A slot may list alternatives; a tile's ``requires:`` asks for *any* of the
    capabilities it lists, and ``items: <placeholder>`` for one that lists
    something. A slot nothing fits stays empty, and a page whose last link went
    with it is dropped.
    """
    pages = template.get(TEMPLATE_PAGES_KEY)
    if not isinstance(pages, dict):
        return template
    pending = {
        name: page["buttons"] for name, page in pages.items()
        if isinstance(page, dict) and isinstance(page.get("buttons"), dict)
        and any(isinstance(s, list) or _requires(s) for s in page["buttons"].values())
    }
    if not pending:
        return template
    caps = entity_capabilities(hass, target_entity) if target_entity else None
    empty = empty or set()
    kept = {}
    for name, buttons in pending.items():
        usable = {}
        for key, slot in buttons.items():
            tile = next((b for b in _choices(slot) if _usable(b, caps, empty)), None)
            if tile is not None:
                usable[key] = tile
        if usable.keys() != buttons.keys() or any(usable[k] is not buttons[k] for k in usable):
            kept[name] = {**pages[name], "buttons": usable}
    if not kept:
        return template
    pruned = {**pages, **kept}
    first = next(iter(pages))
    for name in _links(pages) - _links(pruned) - {first}:
        pruned.pop(name, None)
    return {**template, TEMPLATE_PAGES_KEY: pruned}
