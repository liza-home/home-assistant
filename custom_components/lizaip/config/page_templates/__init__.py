"""Templates: the shipped presets, and everything that turns one into a page.

Four modules and the presets they read, under one roof:

* :mod:`.generate` — evaluation. ``generate_assignments`` walks a template's
  buttons and emits the action-library entries and stored assignments a page is
  made of, plus the file access (``list_templates``, ``load_template``) around it.
  A subdirectory of ``presets`` is a *folder* of templates, at any depth: its
  templates are offered behind one card when adding a page, named by an
  optional ``_group.yaml``. Folders are the only grouping there is — a folder
  directly under ``presets`` is a button on the add-page dialog's first screen
  rather than a card inside the picker, which is all ``debug`` and
  ``showcases`` are. Grouping is a directory layout only — an id
  stays the bare file stem, because a page keeps the id it was created from,
  which makes stems unique across the whole tree.
* :mod:`.resolver` — extension. The ``@source[N].field`` dialect: placeholder
  expansion, token parsing, and ``resolve_template_variables``, which grows a
  template past what its file literally lists.
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
    TEMPLATE_VERSION,
    TEMPLATE_VERSION_KEY,
    async_load_template,
    forget_template,
    generate_assignments,
    is_unbound,
    list_templates,
    load_template,
    page_definition,
    set_user_templates_dir,
    template_pages,
    user_templates_dir,
)
from .compose import (
    ComposedPage,
    async_compose_pages,
)
from .resolver import template_bindings, resolve_template_variables
from .sources import (
    DEFAULT_MAX_ITEMS,
    DEFAULT_TRACKED_FIELDS,
    SOURCES,
    async_resolve_source,
    get_source,
    validate_spec,
)

__all__ = [
    "TEMPLATE_VERSION",
    "TEMPLATE_VERSION_KEY",
    "ComposedPage",
    "DEFAULT_MAX_ITEMS",
    "DEFAULT_TRACKED_FIELDS",
    "SOURCES",
    "async_compose_pages",
    "async_load_template",
    "async_resolve_source",
    "forget_template",
    "generate_assignments",
    "get_source",
    "template_bindings",
    "template_pages",
    "is_unbound",
    "list_templates",
    "load_template",
    "page_definition",
    "resolve_template_variables",
    "set_user_templates_dir",
    "user_templates_dir",
    "validate_spec",
]
