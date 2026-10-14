"""Default icons per domain, state, attribute and service (``icons/icon_defaults.yaml``)."""

from __future__ import annotations

import logging
from pathlib import Path

import yaml

_LOGGER = logging.getLogger(__name__)

ICON_DEFAULTS_FILE = Path(__file__).parent.parent / "icons" / "icon_defaults.yaml"


def _key_variants(key) -> tuple[str, ...]:
    """YAML reads on/off/true/false keys as bools; answer to both spellings."""
    if isinstance(key, bool):
        return ("true", "on") if key else ("false", "off")
    return (str(key),)


def _clean(section) -> dict:
    """String keys and string icons, one nesting level deep."""
    if not isinstance(section, dict):
        return {}
    cleaned: dict = {}
    for key, value in section.items():
        value = _clean(value) if isinstance(value, dict) else ("" if value is None else str(value))
        for variant in _key_variants(key):
            cleaned[variant] = value
    return cleaned


class IconDefaults:
    """The icon tables, read once when the integration is imported."""

    SECTIONS = (
        "domain_icons",
        "domain_state_icons",
        "attribute_icons",
        "service_icons",
        "domain_service_icons",
    )

    def __init__(self, path: Path) -> None:
        #: Every section; also sent to the panel as is.
        self.all: dict = self._load(path)
        self.domain_icons: dict[str, str] = self.all.get("domain_icons", {})
        self.domain_state_icons: dict[str, dict[str, str]] = self.all.get("domain_state_icons", {})
        self.attribute_icons: dict[str, dict[str, str]] = self.all.get("attribute_icons", {})
        self.service_icons: dict[str, str] = self.all.get("service_icons", {})
        self.domain_service_icons: dict[str, dict[str, str]] = self.all.get("domain_service_icons", {})

    def _load(self, path: Path) -> dict:
        try:
            with path.open(encoding="utf-8") as handle:
                data = yaml.safe_load(handle) or {}
        except Exception:
            _LOGGER.exception("Failed to load %s; icon defaults will be empty", path.name)
            return {}
        return {section: _clean(data.get(section, {})) for section in self.SECTIONS}

    def for_state(self, domain: str, attribute: str | None, state: str) -> str | None:
        """The default icon for an entity (or one of its attributes) in *state*."""
        if attribute:
            icons = self.attribute_icons.get(attribute, {"true": "mdi:check-circle", "false": "mdi:close-circle"})
        else:
            icons = self.domain_state_icons.get(domain, {"on": "mdi:check-circle", "off": "mdi:close-circle"})
        return icons.get(state)


icon_defaults = IconDefaults(ICON_DEFAULTS_FILE)
