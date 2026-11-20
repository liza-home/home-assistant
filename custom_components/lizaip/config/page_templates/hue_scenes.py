"""Hue scenes pictured as the Hue app pictures them.

The scenes source lists a Hue scene with no icon of its own; this reads the
bridge's scene resource behind the entity for the glyph and colours to draw.
"""
from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from ...imgserv.source_parse import custom_icon_prefixes

#: The Hue app's scene pictures by the bridge's image id, which is the same on
#: every bridge: a white hass-hue-icons glyph on a fade, top to bottom.
_SCENES = {
    "a1f7da49-d181-4328-abea-68c9dc4b5416": ("scene-relax", "FBE3A0", "F2B14C"),
    "28bbfeff-1a0c-444e-bb4b-0b74b88e0c95": ("scene-nightlight", "E8763A", "9C2E16"),
    "8c74b9ba-6e89-4083-a2a7-b10a1e566fed": ("scene-dimmed", "C9A04A", "7E5A1C"),
    "7fd2ccc5-5749-4142-b7a5-66405a676f03": ("scene-energize", "B9E6F5", "4FA9D6"),
    "e101a77f-9984-4f61-aac8-15741983c656": ("scene-read", "FCEFB8", "F5CC5E"),
    "dbccef2b-096e-49df-93c2-726665e80b26": ("scene-bright", "D6EEFA", "8CC8EC"),
    "732ff1d9-76a7-4630-aad0-c8acc499bb0b": ("scene-bright", "FDF0CF", "F1C578"),
    "11a09ad5-8d65-4e90-959b-f05981a9ab1b": ("scene-rest", "F0A75A", "B8602A"),
    "b90c8900-a6b7-422c-a5d3-e170187dbf8c": ("scene-concentrate", "CFF1F8", "7FCBE2"),
    "eb014820-a902-4652-8ca7-6e29c03b87a1": ("scene-natural-light", "BFE3F7", "F6C760"),
}


def _colour(feature: Any) -> str | None:
    """A Hue colour or white feature (``.color.xy`` / ``.color_temperature.mirek``) as hex."""
    from homeassistant.util import color as color_util

    xy = getattr(getattr(feature, "color", None), "xy", None)
    mirek = getattr(getattr(feature, "color_temperature", None), "mirek", None)
    if xy is not None:
        rgb = color_util.color_xy_to_RGB(xy.x, xy.y)
    elif mirek:
        rgb = color_util.color_temperature_to_rgb(1_000_000 / mirek)
    else:
        return None
    return "".join(f"{round(c):02X}" for c in rgb)


def hue_scene_icon(hass: HomeAssistant, entity_id: str) -> str | None:
    """A Hue scene as the Hue app draws it.

    A gallery scene has a photo there, which the bridge does not hand out, so
    its own colours fade behind a palette instead.
    """
    component = getattr(hass, "data", {}).get("scene")
    scene = getattr(component.get_entity(entity_id) if component else None, "resource", None)
    if scene is None:
        return None
    rid = getattr(getattr(getattr(scene, "metadata", None), "image", None), "rid", None)
    if str(rid) in _SCENES:
        if "hue" not in custom_icon_prefixes():
            return None
        glyph, top, bottom = _SCENES[str(rid)]
        return f"hue:{glyph}?fg=FFFFFF&bg=linear_gradient({top},{bottom})"
    palette = getattr(scene, "palette", None)
    features = [
        *(getattr(palette, "color", None) or []),
        *(getattr(palette, "color_temperature", None) or []),
        *(getattr(a, "action", None) for a in getattr(scene, "actions", None) or []),
    ]
    colours = list(dict.fromkeys(c for c in map(_colour, features) if c))
    if not colours:
        return None
    return f"mdi:palette?fg=FFFFFF&bg=linear_gradient({colours[0]},{(colours * 2)[1]})"
