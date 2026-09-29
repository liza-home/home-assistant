"""Which entity stands for a HA device, per domain.

One helper, kept on its own because everything else in this package either
reaches for a config entry or renders a button, and this does neither: it
answers a registry question about a *device*. The websocket API calls it while
listing targets; nothing else should need it.

It is a leaf — it imports nothing from this package — so it can be imported
from anywhere without risk of a cycle.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant


def _resolve_device_domain_entities(
    hass: HomeAssistant, device_id: str, integration: str | None = None, ent_reg=None
) -> dict[str, str]:
    """Map a HA device's entities by domain.

    Returns ``{domain: entity_id}``. A device can carry entities from several
    integrations in the same domain — an Android TV box also hosts this
    integration's own ``remote.*`` entity, for example. When ``integration`` is
    given, entities from that platform win their domain outright; anything else
    only fills a domain nothing else claimed.

    Args:
        ent_reg: Pre-fetched entity registry. Callers that resolve many devices
            in one pass should fetch it once and pass it in.
    """
    from homeassistant.helpers import entity_registry as er

    if ent_reg is None:
        ent_reg = er.async_get(hass)
    result: dict[str, str] = {}
    claimed: set[str] = set()
    for entry in er.async_entries_for_device(ent_reg, device_id, include_disabled_entities=False):
        if integration and entry.platform == integration:
            if entry.domain not in claimed:
                result[entry.domain] = entry.entity_id
                claimed.add(entry.domain)
        else:
            result.setdefault(entry.domain, entry.entity_id)
    return result
