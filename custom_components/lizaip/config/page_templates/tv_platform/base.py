"""What every TV integration does, unless its own class says otherwise.

Reading a TV's apps and sources in :mod:`..sources` is the same for every TV;
a subclass overrides only what its integration does differently and names the
integration it is for in :attr:`TvPlatform.integration`.
"""
from __future__ import annotations

from typing import Any, ClassVar

from homeassistant.core import HomeAssistant

Rows = list[dict]


class TvPlatform:
    #: The Home Assistant integration (``platform_name``) this class is for.
    integration: ClassVar[str] = ""

    #: The set's own apps are left in rather than filtered out.
    keeps_system_apps: ClassVar[bool] = False

    #: The player reads its sources only when its root is browsed: in standby
    #: it answers for its apps folder with nothing until then.
    reads_sources_on_root_browse: ClassVar[bool] = False

    async def decorate(self, hass: HomeAssistant, rows: Rows) -> None:
        """Add what the browsed app rows lack, in place."""

    async def fallback_apps(self, hass: HomeAssistant, entity: Any) -> Rows:
        """Rows for a TV whose own list came back empty."""
        return []

    def source_artwork(self, entity: Any, source: str) -> str:
        """The picture the player keeps for one of its ``source_list`` entries."""
        return ""

    def source_ids(self, entity: Any, title: str) -> tuple[str, ...]:
        """What a source may be named by in an include or exclude list."""
        return (title,)

    def is_input(self, entity: Any, title: str) -> bool:
        """Whether a source is an input (HDMI and the like) rather than an app.

        A TV that does not say so has its inputs named under ``include``.
        """
        return False

    def source_order(self, entity: Any, titles: list) -> list:
        """Sources in the order the TV keeps them."""
        return titles
