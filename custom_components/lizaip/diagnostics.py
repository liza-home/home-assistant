"""Diagnostics support for the lizaIP integration.

What belongs here is whatever a bug report cannot be answered without, and
nothing that only repeats what the reporter already told us. Three things
decide that:

* **The device's own account of itself** — connected or not, from which
  address, on which firmware and protocol, and what it says it can do. None of
  this is configured anywhere, so none of it can be read off a screenshot.
* **The settings behind a behaviour complaint** — "the slider lags", "the
  labels are in the wrong language" and "it keeps cycling by itself" are each
  one option away from being explained.
* **The shape of the configuration, not its contents** — how many pages, how
  many buttons carry something, how many of those bindings have gone stale.
  A stale binding looks identical to a working one on the remote, which is why
  counting them is worth the lines.

Deliberately absent: what any button actually does. The entity ids a household
points its remote at are the one genuinely private thing in the store, they are
long, and no support question so far has needed them — ``stale_bindings``
already withholds them for the same reason.
"""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .config.layouts import refresh as layout_refresh
from .const import DOMAIN
from .device.const import MODEL_ID
from .device.connection import LizaIPConnection
from .runtime import _resolve_device_id

#: Entry data worth reporting. ``device_id`` is left out because ``unique_id``
#: already carries it; everything else in ``data`` is internal bookkeeping.
#:
#: The hardware identity -- ``sw_version``, ``hw_version``, ``model_id`` -- is
#: deliberately not here. It was reported twice, once as stored and once as
#: live, and a reader had no way to tell which of the two the device registry
#: actually shows. It now appears once, under ``device``.
_ENTRY_DATA_KEYS = ("protocol_version", "device_port")


def _page_summary(page: dict[str, Any], assignments: dict[str, Any]) -> dict[str, Any]:
    """One page, counted rather than transcribed.

    Grid and fixed buttons are counted apart because they fail differently: an
    empty grid button is a blank tile the user can see, while a fixed control
    with nothing on it silently falls through to the page default.
    """
    grid = 0
    fixed: list[str] = []
    overrides = 0
    dynamic = 0

    for key, assign in (assignments or {}).items():
        if not isinstance(assign, dict):
            continue
        if not (assign.get("action_id") or assign.get("config") or assign.get("slider_actions")):
            continue
        if str(key).startswith("button_"):
            grid += 1
        else:
            fixed.append(str(key))
        overrides += len(assign.get("overrides") or {})
        if isinstance(assign.get("dynamic"), dict):
            dynamic += 1

    return {
        "id": page.get("id"),
        "buttons": grid,
        "fixed_controls": sorted(fixed),
        "overrides": overrides,
        "dynamic_buttons": dynamic,
        # The page's title glyph and its icon tint. Present or not is the whole
        # question — a page that lost its colour is a report we have had.
        "has_image": bool(page.get("image")),
        "has_default_color": bool(page.get("default_color")),
    }


async def _async_config_summary(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    """The shape of what the panel has stored for this remote.

    Never raises and never resolves anything: diagnostics is what someone
    reaches for when the integration is already broken, so a store that is not
    there yet has to come back as an empty summary rather than an exception.
    """
    summary: dict[str, Any] = {
        "page_count": 0,
        "pages": [],
        "actions": {"total": 0, "unused": 0},
    }

    store = hass.data.get(DOMAIN, {}).get("_store")
    device_id = _resolve_device_id(hass, entry.entry_id)
    if store is None or not device_id:
        return summary

    try:
        pages = await store.async_get_pages(device_id)
    except Exception:  # noqa: BLE001 — diagnostics must never raise
        return summary

    used_actions: set[str] = set()
    for page in pages or []:
        if not isinstance(page, dict) or page.get("id") is None:
            continue
        try:
            assignments = await store.async_get_assignments(device_id, page["id"])
        except Exception:  # noqa: BLE001
            continue
        for assign in (assignments or {}).values():
            if isinstance(assign, dict) and assign.get("action_id"):
                used_actions.add(str(assign["action_id"]))
        summary["pages"].append(_page_summary(page, assignments))

    summary["page_count"] = len(summary["pages"])

    try:
        library = await store.async_get_action_library(device_id)
    except Exception:  # noqa: BLE001
        library = []
    # An unused action is not a fault on its own, but a library that is mostly
    # unused is the fingerprint of assignments that went missing.
    ids = {str(a.get("id")) for a in library or [] if isinstance(a, dict) and a.get("id")}
    summary["actions"] = {"total": len(library or []), "unused": len(ids - used_actions)}

    return summary


def _entities(hass: HomeAssistant, entry: ConfigEntry) -> list[dict[str, Any]]:
    """This integration's own entities, with the state they are actually in.

    Ours alone, so nothing private is here — and "the battery sensor is
    missing" is answered by whether it is disabled, unavailable or absent,
    which are three different bugs that look the same from the outside.
    """
    entities = [
        {
            "entity_id": reg_entry.entity_id,
            "disabled_by": str(reg_entry.disabled_by) if reg_entry.disabled_by else None,
            "state": state.state if (state := hass.states.get(reg_entry.entity_id)) else None,
        }
        for reg_entry in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    ]
    return sorted(entities, key=lambda item: item["entity_id"])


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: ConfigEntry,
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    connection: LizaIPConnection = entry.runtime_data

    return {
        "entry": {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "unique_id": entry.unique_id,
            "version": entry.version,
            # How this entry came to exist, and where its setup got to. A report
            # that opens "it stopped working after an update" is usually
            # answered by one of these two.
            "source": entry.source,
            "state": str(entry.state),
            "data": {key: entry.data.get(key) for key in _ENTRY_DATA_KEYS},
            # Reported whole rather than key by key: an option added later would
            # otherwise be missing from diagnostics until someone remembered to
            # list it here, and these are the settings behind most behaviour
            # reports.
            "options": dict(entry.options),
        },
        "device": {
            "connected": connection.connected,
            "protocol_version": connection.device_protocol_version,
            "device_mac": connection.device_mac,
            # The hardware identity, reported exactly as the device registry
            # resolves it, so a report cannot disagree with the device page a
            # user is looking at while writing it.
            #
            # `null` is an answer in its own right here and means the firmware
            # has never reported the field -- not all builds expose hw_version,
            # and model_id only arrives once a handshake has carried it.
            "sw_version": connection.device_version,
            "hw_version": entry.data.get("hw_version"),
            # `or MODEL_ID` because that is the fallback the registry applies:
            # reporting a bare `null` while the device page shows the shipped
            # default would send someone looking for a fault that is not there.
            "model_id": connection.device_model_id or MODEL_ID,
            # The remote dials Home Assistant, so its address is not configured
            # anywhere and appears in no UI — it is read off the socket and kept
            # only in memory. That makes this the one place a report can say
            # which box on the LAN it is about. `null` here is ordinary: it means
            # the device has not connected since the last restart, which is
            # itself worth knowing when the complaint is that it is offline.
            "peer_ip": connection.peer_ip,
            "http_port": connection.device_http_port,
        },
        # The capabilities the device reported, and only those.
        #
        # This used to be the whole discovery payload, which wraps them
        # alongside the button and slider lists the integration derives from
        # them -- so a reader saw `capabilities` inside `capabilities`, the
        # static buttons both on their own and folded into `buttons`, and the
        # sliders twice. None of that duplication carried information: the
        # derived lists are a pure function of what is here, and which entities
        # actually exist is answered by `entities` below.
        "capabilities": (connection.last_discovery or {}).get("capabilities"),
        "config": await _async_config_summary(hass, entry),
        "entities": _entities(hass, entry),
        # A stale binding is invisible on the remote, so this is the one place
        # the count is actually legible.
        "dynamic": await layout_refresh.async_binding_summary(hass, entry.entry_id),
    }
