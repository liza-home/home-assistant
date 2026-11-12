"""The pages a remote shows while it has none of its own.

A remote that has never been configured, and one whose last page the user just
deleted, would be left with an empty page list and a blank face. Rather than
leave it at that, the pages of the ``_default-pages`` template stand in until
there is something real to show: a welcome page whose title strip greets the
user in the device's language, and a page about the remote itself, which
reports the remote's battery, its own address, the Home Assistant it talks to,
and its firmware.

They are **placeholders, not pages**. Nothing here writes: no page file, no
assignments, no action-library entry. The panel reads the store and so still
shows an empty page list and the **+** tile, exactly as if this module did not
exist; only the paths that talk to the device — the sync, the remote's own page
pull, and the live variable push — ask for the effective set and get these
instead of nothing. The user's first real page replaces them, and deleting the
last one brings them back.

The template names no ``target_selector``, so neither page needs a target to resolve against,
and neither carries a command: the remote page's tiles are labels and images,
so a placeholder button is as inert as the stored page would be.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import yaml
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from ..device.protocol import MIN_PAGE_ID
from ..runtime import get_store, entry_device_id
from ..shared.logs import device_logger
from .page_templates import async_compose_pages, template_pages
from .page_templates.catalog import TEMPLATES_DIR

_LOGGER = logging.getLogger(__name__)

#: The template that stands in. A `_`-prefixed file is never offered as a
#: template, so it cannot be added as a page by hand.
_TEMPLATE_ID = "_default-pages"
_DEFAULT_PAGES_FILE = os.path.join(TEMPLATES_DIR, f"{_TEMPLATE_ID}.yaml")

#: The parsed file. It ships with the integration and so changes only with it.
_CACHE: dict[str, Any] | None = None


@dataclass(frozen=True)
class EffectivePages:
    """The pages a remote should be holding, stored or stood in for."""

    pages: list[dict]
    #: Button assignments by page id, or None when the pages are the store's
    #: and their buttons are to be read from it as usual.
    assignments: dict[int, dict] | None = None

    @property
    def placeholder(self) -> bool:
        """Whether these are placeholders rather than the user's own pages."""
        return self.assignments is not None


async def async_effective_pages(
    hass: HomeAssistant, entry: ConfigEntry,
) -> EffectivePages:
    """The page set to send *entry*'s remote: its own, or the placeholders.

    Never raises. A placeholder that cannot be resolved leaves the remote with
    the empty list it would have had anyway, which is worse than a welcome
    screen and better than a failed sync.
    """
    device_id = entry_device_id(entry)
    if not device_id:
        return EffectivePages([])

    pages = await get_store(hass).async_get_pages(device_id)
    if pages:
        return EffectivePages(pages)

    try:
        return await _async_placeholder_pages(hass, entry)
    except Exception:  # noqa: BLE001 - a stand-in page is never worth a failed sync
        device_logger(_LOGGER, entry).warning(
            "Could not build the placeholder pages for a remote with none",
            exc_info=True,
        )
        return EffectivePages([])


def _load_default_template() -> dict[str, Any]:
    """Parse the template. Blocking -- call via ``async_add_executor_job``."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE

    try:
        with open(_DEFAULT_PAGES_FILE, "r", encoding="utf-8") as fh:
            doc = yaml.safe_load(fh) or {}
    except (OSError, yaml.YAMLError) as exc:
        _LOGGER.warning("Failed to read %s: %s", _DEFAULT_PAGES_FILE, exc)
        doc = {}

    _CACHE = doc if isinstance(doc, dict) else {}
    return _CACHE


async def _async_placeholder_pages(
    hass: HomeAssistant, entry: ConfigEntry,
) -> EffectivePages:
    """Resolve the template into pages that exist only in memory."""
    template = await hass.async_add_executor_job(_load_default_template)
    if not template:
        return EffectivePages([])

    # The lowest ids there are, which is what `generate_page_id` hands the
    # user's first real page: the sync then turns a placeholder into it with
    # one `set_page` instead of an add and a delete.
    page_ids = [
        MIN_PAGE_ID + i
        for i in range(len(template_pages(_TEMPLATE_ID, template)))
    ]
    composed = await async_compose_pages(
        hass, _TEMPLATE_ID, template, page_ids,
        remote_entry=entry.entry_id,
        entry=entry,
    )
    if not composed:
        return EffectivePages([])
    return EffectivePages(
        [{"id": c.page_id, "title": c.title} for c in composed],
        {c.page_id: c.assignments for c in composed},
    )
