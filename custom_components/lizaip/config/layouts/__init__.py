"""Layouts: the shipped presets, and everything that turns one into a page.

Four modules and the presets they read, under one roof:

* :mod:`.generate` — evaluation. ``generate_assignments`` walks a layout's
  buttons and emits the action-library entries and stored assignments a page is
  made of, plus the file access (``list_layouts``, ``load_layout``) around it.
* :mod:`.resolver` — extension. The ``@source[N].field`` dialect: placeholder
  expansion, token parsing, and ``resolve_layout_variables``, which grows a
  layout past what its file literally lists.
* :mod:`.sources` — supply. Where the items a token resolves to come from:
  the entity registry, a media player's browse tree, a speaker's favourites.
* :mod:`.refresh` — upkeep. Re-running resolution against a page already on
  disk, so a slot refills when the thing behind it changes.

The order is the pipeline: load, resolve, generate, and later refresh.

This module re-exports only what other packages actually reach for, so the
package has one import surface and the split above stays an implementation
detail. Callers that want a module object — ``refresh`` is used that way, for
the services and triggers it registers — import the submodule by name.
"""
from __future__ import annotations

from .generate import (
    async_load_layout,
    generate_assignments,
    list_layouts,
    load_layout,
)
from .resolver import layout_bindings, resolve_layout_variables
from .sources import (
    DEFAULT_MAX_ITEMS,
    DEFAULT_TRACKED_FIELDS,
    SOURCES,
    async_resolve_source,
    get_source,
    validate_spec,
)

__all__ = [
    "DEFAULT_MAX_ITEMS",
    "DEFAULT_TRACKED_FIELDS",
    "SOURCES",
    "async_load_layout",
    "async_resolve_source",
    "generate_assignments",
    "get_source",
    "layout_bindings",
    "list_layouts",
    "load_layout",
    "resolve_layout_variables",
    "validate_spec",
]
