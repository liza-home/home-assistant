"""``@ir:<key>`` in a template, filled with that key's code when the page is added."""
from __future__ import annotations

import re
from copy import deepcopy
from typing import Any, Final

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr

from ..const import DOMAIN
from ..shared.assignment import ASSIGNMENT_IR_KEY
from .device import SUBENTRY_TYPE, IrDevice

IR_TOKEN_RE: Final = re.compile(r"^@ir:([a-z0-9_]+)$")
_SEND_IR: Final = f"{DOMAIN}.send_ir"


def _keys(value: Any) -> set[str]:
    if isinstance(value, str):
        match = IR_TOKEN_RE.match(value)
        return {match.group(1)} if match else set()
    if isinstance(value, dict):
        return set().union(*map(_keys, value.values()))
    if isinstance(value, list):
        return set().union(*map(_keys, value))
    return set()


def _fill(value: Any, key_names: set[str], device_id: str) -> Any:
    """Replace each token by the key's name; a ``send_ir`` of a key also names its IR device."""
    if isinstance(value, str):
        match = IR_TOKEN_RE.match(value)
        return match.group(1) if match else value
    if isinstance(value, dict):
        filled = {k: _fill(v, key_names, device_id) for k, v in value.items()}
        if filled.get("action") == _SEND_IR and "key" in (filled.get("data") or {}):
            filled["data"] = {**filled["data"], "device_id": device_id}
        return filled
    if isinstance(value, list):
        return [_fill(v, key_names, device_id) for v in value]
    return value


def _button_maps(template: dict[str, Any]) -> list[dict[str, Any]]:
    pages = template.get("pages")
    maps = [page.get("buttons") for page in pages.values()] if isinstance(pages, dict) else []
    maps.append(template.get("buttons"))
    return [m for m in maps if isinstance(m, dict)]


def ir_device_of(hass: HomeAssistant, device_id: str) -> IrDevice | None:
    """The IR device registered as *device_id*, if it is one and loaded."""
    device = dr.async_get(hass).async_get(device_id) if device_id else None
    if device is None or not device.config_subentry_id:
        return None
    entry = hass.config_entries.async_get_entry(device.config_entry_id)
    if entry is None or entry.domain != DOMAIN or entry.state is not ConfigEntryState.LOADED:
        return None
    subentry = entry.subentries.get(device.config_subentry_id)
    if subentry is None or subentry.subentry_type != SUBENTRY_TYPE:
        return None
    return IrDevice(subentry)


async def async_fill_ir_codes(
    hass: HomeAssistant, template: dict[str, Any], target_device: str, remote_entry: str | None = None,
) -> dict[str, Any]:
    """*template* with every ``@ir:<key>`` replaced by the code of IR device *target_device*.

    A ``send_ir`` step then passes the key and the IR device, not the code; the
    lizaIP that sends it is the one the button sits on.
    """
    if not _keys(template):
        return template
    device = ir_device_of(hass, target_device)
    if device is None:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="ir_not_an_ir_device",
            translation_placeholders={"device": target_device},
        )
    have = {key.name for key in device.keys}
    codes = _keys(template) & have

    filled = deepcopy(template)
    for buttons in _button_maps(filled):
        for slot, tiles in list(buttons.items()):
            if isinstance(tiles, list):
                kept = [t for t in tiles if _keys(t) <= codes]
                if kept:
                    buttons[slot] = kept
                else:
                    del buttons[slot]
            elif not _keys(tiles) <= codes:
                del buttons[slot]
        for tiles in buttons.values():
            for tile in tiles if isinstance(tiles, list) else [tiles]:
                if isinstance(tile, dict) and len(keys := _keys(tile)) == 1:
                    tile[ASSIGNMENT_IR_KEY] = next(iter(keys))
    page: dict[str, Any] = _fill(filled, codes, target_device)
    return page


def _with_device(value: Any, blob: str, device_id: str) -> Any:
    if isinstance(value, list):
        return [_with_device(v, blob, device_id) for v in value]
    if not isinstance(value, dict):
        return value
    swapped = {k: _with_device(v, blob, device_id) for k, v in value.items()}
    data = swapped.get("data")
    if swapped.get("action") == _SEND_IR and isinstance(data, dict):
        if "ir_blob" in data:
            swapped["data"] = {**data, "ir_blob": blob}
        elif "key" in data:
            swapped["data"] = {**data, "device_id": device_id}
    return swapped


async def async_swap_ir_codes(
    hass: HomeAssistant, pages: dict[Any, dict[str, Any]], target_device: str,
) -> dict[Any, dict[str, Any]]:
    """*pages*' assignments with each ``ir_key`` button sending *target_device*'s code.

    A button whose key that device lacks is dropped. Not an IR device: unchanged.
    """
    wanted = {
        a[ASSIGNMENT_IR_KEY] for assignments in pages.values() for a in assignments.values()
        if isinstance(a, dict) and isinstance(a.get(ASSIGNMENT_IR_KEY), str)
    }
    device = ir_device_of(hass, target_device) if wanted else None
    if device is None:
        return pages
    have = {key.name for key in device.keys}
    codes = {name: device.code(name) for name in wanted & have}

    swapped: dict[Any, dict[str, Any]] = {}
    for page_id, assignments in pages.items():
        swapped[page_id] = {}
        for slot, assign in assignments.items():
            key = assign.get(ASSIGNMENT_IR_KEY) if isinstance(assign, dict) else None
            if not isinstance(key, str):
                swapped[page_id][slot] = assign
            elif key in codes:
                swapped[page_id][slot] = _with_device(assign, codes[key], target_device)
    return swapped
