"""Templates: the shipped template files, and everything that turns one into a page.

The modules, in pipeline order:

* :mod:`.catalog` — files. Finding template files (``list_templates``),
  reading one (``load_template``, cached) and the shape of a parsed file: its
  format version and the pages it names (``template_pages``,
  ``page_source``). A subdirectory of ``assets/templates`` is a *folder* of
  templates, at any depth: its templates are offered behind one card when
  adding a page, named by an optional ``_group.yaml``. Folders are the only
  grouping there is — a folder directly under ``assets/templates`` is a button
  on the add-page dialog's first screen rather than a card inside the picker,
  which is all ``debug`` and ``showcases`` are. Grouping is a directory layout
  only — an id stays the bare file stem, because a page keeps the id it was
  created from, which makes stems unique across the whole tree.
* :mod:`.resolver` — extension. The ``@source[N].field`` dialect: placeholder
  expansion, token parsing, and ``resolve_template_variables``, which grows a
  template past what its file literally lists.
* :mod:`.sources` — supply. Where the items a token resolves to come from:
  the source table, a media player's browse tree, a speaker's favourites, a
  TV's apps and inputs. :mod:`.items` is the :class:`DynamicItem` every source
  returns; :mod:`.entity_source` lists entities from the registries and
  :mod:`.page_source` a remote's own pages. What differs between TV
  integrations is in :mod:`.tv_platform`: one module per integration, each a
  ``TvPlatform`` subclass (``webos_tv``, ``samsung_tv``, ``apple_tv``,
  ``bravia_tv``, ``android_tv``).
* :mod:`.generate` — evaluation. ``generate_assignments`` walks a page's
  buttons and emits the action-library entries and stored assignments it is
  made of; ``page_buttons`` turns ``goto_page:`` links into commands.
* :mod:`.parts` — the parts of a ``paginate:`` page as its definition spells
  them; :mod:`.paginate` adds and removes those parts on a remote.
* :mod:`.compose` — one template made into the pages it describes, without
  writing anything.
* :mod:`.refresh` — upkeep. Re-running resolution against a page already on
  disk, so a slot refills when the thing behind it changes.

The order is the pipeline: load, resolve, generate, and later refresh.

This module re-exports only what other packages actually reach for, so the
package has one import surface and the split above stays an implementation
detail. Callers that want a module object — ``refresh`` is used that way, for
the services and triggers it registers — import the submodule by name.
"""
from __future__ import annotations

from .catalog import (
    TEMPLATE_VERSION,
    TEMPLATE_VERSION_KEY,
    async_load_template,
    is_unbound,
    list_templates,
    load_template,
    page_definition,
    set_user_templates_dir,
    template_pages,
)
from .generate import generate_assignments
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
]
