"""What differs between the integrations that list a TV's apps and inputs.

One module per integration, each with a :class:`.base.TvPlatform` subclass
overriding only what that integration does differently. :func:`platform_of`
looks a player's integration up; one absent from :data:`PLATFORMS` gets the
base class's defaults. A new TV integration is one module and one entry here,
and no edit to :mod:`..sources`.
"""
from __future__ import annotations

from typing import Any, Final

from .android_tv import AndroidTvRemote
from .apple_tv import AppleTv
from .base import TvPlatform
from .bravia_tv import BraviaTv
from .samsung_tv import SamsungTv
from .webos_tv import WebOsTv

PLATFORMS: Final[dict[str, TvPlatform]] = {
    cls.integration: cls()
    for cls in (AndroidTvRemote, AppleTv, BraviaTv, SamsungTv, WebOsTv)
}

DEFAULT_PLATFORM: Final = TvPlatform()


def platform_of(entity: Any) -> TvPlatform:
    """What *entity*'s integration does differently; the defaults for any other."""
    name = getattr(getattr(entity, "platform", None), "platform_name", "") or ""
    return PLATFORMS.get(name, DEFAULT_PLATFORM)


__all__ = ["DEFAULT_PLATFORM", "PLATFORMS", "TvPlatform", "platform_of"]
