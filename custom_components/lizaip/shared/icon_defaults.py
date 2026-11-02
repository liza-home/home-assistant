"""Default icons per domain, state, attribute and service.

The table is the ``icons:`` block of the default theme
(``assets/themes/default.yaml``), the one file the default look is written in.
"""

from __future__ import annotations

from ..imgserv.const import load_default_theme_file


def _key_variants(key) -> tuple[str, ...]:
    """YAML reads on/off/true/false keys as bools; answer to both spellings."""
    if isinstance(key, bool):
        return ("true", "on") if key else ("false", "off")
    return (str(key),)


def clean_section(section) -> dict:
    """String keys and string icons, one nesting level deep."""
    if not isinstance(section, dict):
        return {}
    cleaned: dict = {}
    for key, value in section.items():
        value = clean_section(value) if isinstance(value, dict) else ("" if value is None else str(value))
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

    def __init__(self, sections: dict) -> None:
        #: Every section; also sent to the panel as is.
        self.all: dict = sections
        self.domain_icons: dict[str, str] = self.all.get("domain_icons", {})
        self.domain_state_icons: dict[str, dict[str, str]] = self.all.get("domain_state_icons", {})
        self.attribute_icons: dict[str, dict[str, str]] = self.all.get("attribute_icons", {})
        self.service_icons: dict[str, str] = self.all.get("service_icons", {})
        self.domain_service_icons: dict[str, dict[str, str]] = self.all.get("domain_service_icons", {})

    @classmethod
    def from_mapping(cls, data) -> IconDefaults:
        """The tables from a theme's ``icons:`` block, cleaned."""
        data = data if isinstance(data, dict) else {}
        return cls({section: clean_section(data.get(section, {})) for section in cls.SECTIONS})

    def merged(self, overrides: dict | None) -> IconDefaults:
        """A new table with *overrides* laid over this one, section by section.

        A copy, never a change in place: two remotes on different themes read
        the same shipped table and must not see each other's entries.
        """
        if not overrides:
            return self
        sections: dict = {}
        for section in self.SECTIONS:
            base = self.all.get(section, {})
            given = overrides.get(section)
            if not isinstance(given, dict) or not given:
                sections[section] = base
                continue
            merged = dict(base)
            for key, value in given.items():
                if isinstance(value, dict) and isinstance(merged.get(key), dict):
                    merged[key] = {**merged[key], **value}
                else:
                    merged[key] = value
            sections[section] = merged
        return IconDefaults(sections)

    def for_state(self, domain: str, attribute: str | None, state: str) -> str | None:
        """The default icon for an entity (or one of its attributes) in *state*."""
        if attribute:
            icons = self.attribute_icons.get(attribute, {"true": "mdi:check-circle", "false": "mdi:close-circle"})
        else:
            icons = self.domain_state_icons.get(domain, {"on": "mdi:check-circle", "off": "mdi:close-circle"})
        return icons.get(state)


icon_defaults = IconDefaults.from_mapping(load_default_theme_file().get("icons"))
