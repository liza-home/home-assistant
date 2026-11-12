"""Template files: where they are, what the add-page dialog lists, and reading one.

Discovery walks the shipped ``assets/templates`` tree, ``assets/options`` and
the user's own ``<config>/lizaip/templates`` (and ``options`` beside it); a
subdirectory is a *folder* of templates, described by an optional
``_group.yaml``. ``list_templates`` builds every template's card and keeps the
answer until a file changes; ``load_template`` parses one file and caches it.

The shape of a parsed file -- its format version and the pages it names
(``template_pages``, ``page_source``) -- lives here too, because the listing
counts a template's pages and everything else reads them off a loaded file.
"""
from __future__ import annotations

import logging
import os
import re
from copy import deepcopy
from typing import Any

import yaml

from homeassistant.core import HomeAssistant

from ...shared.i18n import translate_fallback, translate_key

__all__ = [
    "OPTIONS_DIR",
    "OPTIONS_PREFIX",
    "SUPPORTED_TEMPLATE_VERSIONS",
    "TEMPLATES_DIR",
    "TEMPLATE_PAGES_KEY",
    "TEMPLATE_VERSION",
    "TEMPLATE_VERSION_KEY",
    "async_load_template",
    "favorites_kind",
    "is_unbound",
    "list_templates",
    "load_template",
    "page_definition",
    "page_source",
    "preload_templates",
    "set_user_templates_dir",
    "template_id_of",
    "template_pages",
    "template_version",
]

_LOGGER = logging.getLogger(__name__)


#: The format a template file is written in, stated as ``version:`` at its top.
#: 1 is the original one -- buttons at the top of the file, ``unbound``,
#: ``name_key`` -- and is what a file that states none is; 2 names its pages
#: under ``pages:``, a page's ``title`` and a button's ``icon`` and
#: ``tooltip``. A page made from a template
#: records the version it was made under, so a stored page of an old format
#: can be brought up to date (``config/store.py``) until that format is
#: dropped from here.
TEMPLATE_VERSION_KEY = "version"
TEMPLATE_VERSION = 2
#: The template file formats that are read. A file in any other is reported
#: and skipped, rather than read as something it is not.
SUPPORTED_TEMPLATE_VERSIONS: frozenset[int] = frozenset({TEMPLATE_VERSION})


def template_version(template: Any) -> int:
    """The format version a template states; 1 for one that states none."""
    value = template.get(TEMPLATE_VERSION_KEY) if isinstance(template, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else 1


def _readable(template_id: str, template: Any, path: str) -> bool:
    """Whether a parsed template file is in a format this release reads."""
    version = template_version(template)
    if version in SUPPORTED_TEMPLATE_VERSIONS:
        return True
    _LOGGER.warning(
        "Template %s (%s) is written in template format %d, which this release "
        "does not read (it reads %s); skipping it",
        template_id, path, version,
        ", ".join(str(v) for v in sorted(SUPPORTED_TEMPLATE_VERSIONS)),
    )
    return False


#: Where a template names its pages: every page it makes, keyed by a name used
#: inside the file and remembered by each page made from it.
TEMPLATE_PAGES_KEY = "pages"

#: What a page under ``pages:`` may say, and what a template must not say
#: beside them: the rest of the file -- its selector, its placeholders, its
#: card -- belongs to the template, and a page's title to that page.
_PAGE_KEYS = frozenset({"template", "title", "subpage", "buttons", "paginate", "max_parts"})


def _text_entry(entry: dict[str, Any], data: dict[str, Any], field: str, default: str) -> None:
    """Put a template's or folder's *field* into its listing entry.

    A translated one travels as ``<field>_key``, which the panel looks up; the
    plain field then holds *default*, what a reader without the table sees.
    """
    value = data.get(field)
    key = translate_key(value)
    if key:
        entry[field] = translate_fallback(value, default)
        entry[f"{field}_key"] = key
    else:
        entry[field] = str(value or default) if not isinstance(value, dict) else default


def is_unbound(template: dict[str, Any]) -> bool:
    """Whether a template is bound to nothing: it names no ``target_selector``.

    Such a page is added without asking for a device, and is stored as an
    ordinary page with nothing to refresh from or move to another device.
    """
    return not template.get("target_selector")


def template_pages(
    template_id: str, template: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    """``(name, page definition)`` for every page a template describes.

    Every template with something on its pages names them under ``pages:``, a
    single one included, in file order, the first being the page the remote
    lands on. A template without ``pages:`` makes one empty page with no title
    -- the blank page -- so it need not spell out that it has nothing.
    """
    for key in sorted(set(template) & _PAGE_KEYS):
        _LOGGER.warning(
            "Template %s states %r beside its pages, where it belongs to no "
            "page; ignoring it",
            template_id, key,
        )

    pages_def = template.get(TEMPLATE_PAGES_KEY)
    if pages_def is None:
        # One page with nothing on it and no title; it needs no name.
        return [("", {"title": ""})]
    if not isinstance(pages_def, dict) or not pages_def:
        _LOGGER.warning(
            "Template %s has a '%s' that names no pages; it makes no page",
            template_id, TEMPLATE_PAGES_KEY,
        )
        return []

    pages: list[tuple[str, dict[str, Any]]] = []
    for name, page in pages_def.items():
        name = str(name)
        if not name:
            _LOGGER.warning("Template %s has an unnamed page; ignoring it", template_id)
            continue
        if not isinstance(page, dict):
            _LOGGER.warning(
                "Template %s page %r is not a mapping; ignoring it", template_id, name,
            )
            continue
        for key in sorted(set(page) - _PAGE_KEYS):
            _LOGGER.warning(
                "Template %s page %r has no key %r; ignoring it", template_id, name, key,
            )
        pages.append((name, page))
    return pages


def page_definition(
    template_id: str, template: dict[str, Any], name: str,
) -> dict[str, Any] | None:
    """The page called *name* in a template, or ``None`` if it has none of that name."""
    return next(
        (page for page_name, page in template_pages(template_id, template) if page_name == name),
        None,
    )


def page_source(
    template_id: str,
    template: dict[str, Any],
    page: dict[str, Any],
    included: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(shared, buttons)``: what one page of a template is made of.

    *shared* is the template it resolves under -- the file minus its page list,
    its selector and placeholders. A page may name another template instead of
    spelling its buttons out, and is then that template's first page, under
    that template's placeholders: one page stays described in one place,
    however many templates put it on a remote. Buttons written beside the name
    are laid over it. *included* is that template, loaded by the caller (``None``
    when it does not load), so this stays free of file access. Its first page
    is the one meant, picture and all; a first page that itself names a third
    template is not followed -- one level keeps a page described in one place.
    """
    shared = {k: v for k, v in template.items() if k != TEMPLATE_PAGES_KEY}
    buttons = page.get("buttons") or {}
    include = str(page.get("template") or "")
    if not include:
        return shared, buttons
    if not isinstance(included, dict):
        _LOGGER.warning(
            "Template %s includes page template %r, which does not exist",
            template_id, include,
        )
        return shared, {}

    shared = {k: v for k, v in included.items() if k != TEMPLATE_PAGES_KEY}
    pages = template_pages(include, included)
    first = pages[0][1] if pages else {}
    if first.get("template"):
        _LOGGER.warning(
            "Template %s is named as a page, but its own first page names "
            "template %r; a page names one template, not a chain of them",
            include, first["template"],
        )
    if "title" in first:
        shared["title"] = first["title"]
    first_buttons = first.get("buttons")
    return shared, {**(first_buttons if isinstance(first_buttons, dict) else {}), **buttons}


#: The shipped YAML presets live with other packaged assets, apart from the
#: configuration code that loads them.
TEMPLATES_DIR = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "assets", "templates"
    )
)
#: A button's options subpages: templates of their own, offered only under
#: **Add options…**. Their ids are their own too -- ``options:<stem>`` -- so
#: ``options/sonos.yaml`` and the Sonos page template never clash.
OPTIONS_DIR = os.path.abspath(os.path.join(TEMPLATES_DIR, "..", "options"))
OPTIONS_PREFIX = "options:"
OPTION_FOLDER_PREFIX = "options/"
#: Folder metadata, not a template. The leading underscore is the rule: a
#: ``_``-prefixed file is never offered as a page.
_GROUP_FILE = "_group.yaml"
#: Everything ``_group.yaml`` may say. Anything else is a typo worth a warning:
#: a misspelt ``name`` is silently the folder name otherwise, which reads as
#: "the file was ignored" and is tedious to chase down.
_GROUP_KEYS = frozenset({"name", "icon", "description", "primary"})
#: The user's own templates: ``<config>/lizaip/templates``, set at setup.
#: Outside the integration, so an update does not wipe them. Read after
#: ``assets/templates/`` as one more folder, :data:`USER_TEMPLATES_GROUP`, with
#: their own options templates from ``<config>/lizaip/options`` beside them.
_USER_TEMPLATES_DIR: str | None = None
#: The folder path the user's templates are offered under.
USER_TEMPLATES_GROUP = ("my-templates",)


def _user_options_dir() -> str | None:
    """The user's own options templates: ``options`` beside their templates."""
    if not _USER_TEMPLATES_DIR:
        return None
    return os.path.join(os.path.dirname(_USER_TEMPLATES_DIR), "options")


def set_user_templates_dir(path: str | None) -> None:
    """Read the user's own templates from *path* (``None``: none)."""
    global _USER_TEMPLATES_DIR
    _USER_TEMPLATES_DIR = path
    _TEMPLATE_CACHE.clear()


#: How far down ``assets/templates/`` is read. Nesting is deliberate and
#: unbounded in spirit, but a bounded walk cannot be talked into a long one by
#: a mistake.
_MAX_DEPTH = 8


def _template_dirs() -> list[tuple[str, tuple[str, ...]]]:
    """``(directory, folder path)`` for every directory templates are read from.

    The path is the chain of directory names from ``assets/templates/`` down,
    so ``assets/templates/media/sonos`` is ``("media", "sonos")`` and
    ``assets/templates/`` itself is ``()``. It is the folder's identity: a
    *path*, never a name, so two folders may share a leaf name under different
    parents.

    A directory whose name starts with ``.`` or ``_`` is not a folder of
    templates, and neither is a symlink -- a link can point at its own parent,
    and a walk that followed one would not come back.
    """
    dirs: list[tuple[str, tuple[str, ...]]] = []

    def walk(directory: str, path: tuple[str, ...], prefix: str = "") -> None:
        if not os.path.isdir(directory):
            return
        dirs.append((directory, path))
        if len(path) >= _MAX_DEPTH:
            _LOGGER.warning(
                "Template folder %s is nested deeper than %d; not reading below it",
                os.path.join(*path) if path else TEMPLATES_DIR,
                _MAX_DEPTH,
            )
            return
        for name in sorted(os.listdir(directory)):
            child = os.path.join(directory, name)
            if name.startswith((".", "_")) or not os.path.isdir(child):
                continue
            if os.path.islink(child):
                _LOGGER.warning("Template folder %s is a symlink; skipping it", child)
                continue
            walk(child, (*path, prefix + name))

    walk(TEMPLATES_DIR, ())
    # Loose at the top level like the templates; a folder of its own is
    # `options/<name>`, so it never merges with a template folder of that name.
    walk(OPTIONS_DIR, (), OPTION_FOLDER_PREFIX)
    if _USER_TEMPLATES_DIR:
        walk(_USER_TEMPLATES_DIR, USER_TEMPLATES_GROUP)
        walk(_user_options_dir(), USER_TEMPLATES_GROUP, OPTION_FOLDER_PREFIX)
    return dirs


def _group_meta(directory: str, path: tuple[str, ...]) -> dict[str, Any]:
    """One folder's card: what it is called, what it looks like, where it sits.

    ``_group.yaml`` is optional: a folder without one still groups, it just
    falls back to its own name title-cased and a generic icon. A folder is a
    deliberate act, so the fallback has to be usable rather than a reason to
    refuse.

    ``name`` and ``description`` may be ``{translate: <key>}``, an entry in
    the panel's translation table instead of words spelt here, which is how a
    shipped folder keeps the translations it already had.
    """
    meta: dict[str, Any] = {}
    file_path = os.path.join(directory, _GROUP_FILE)
    if os.path.isfile(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as fh:
                meta = yaml.safe_load(fh) or {}
        except (OSError, yaml.YAMLError) as exc:
            _LOGGER.warning("Failed to read group metadata %s: %s", file_path, exc)
            meta = {}
        if not isinstance(meta, dict):
            _LOGGER.warning("Group metadata %s is not a mapping; ignoring it", file_path)
            meta = {}
        for key in sorted(set(meta) - _GROUP_KEYS):
            _LOGGER.warning("Group metadata %s has no key %r; ignoring it", file_path, key)

    # The first screen offers the top level, so that is the only place an
    # option can be drawn; everything nested is an ordinary card.
    scope = "option" if len(path) == 1 else "grid"

    group: dict[str, str] = {"id": "/".join(path)}
    leaf = path[-1].removeprefix(OPTION_FOLDER_PREFIX)
    _text_entry(group, meta, "name", leaf.replace("-", " ").title())
    group["icon"] = str(meta.get("icon") or "mdi:folder-outline")
    _text_entry(group, meta, "description", "")
    group["scope"] = scope
    # The first screen leads with what most pages start from and names the
    # rest as a second group. Only an option is on that screen, so only an
    # option can ask to lead it.
    if scope == "option" and meta.get("primary") is True:
        group["primary"] = True
    return group


#: The last :func:`list_templates` answer and the files it was read from.
_LISTED: tuple[tuple, list[dict[str, Any]]] | None = None


def _files_signature(dirs: list[tuple[str, tuple[str, ...]]]) -> tuple:
    """Every file in *dirs* with its size and change time: what a listing depends on."""
    return tuple(
        (directory, tuple(sorted(
            (e.name, e.stat().st_mtime_ns, e.stat().st_size)
            for e in os.scandir(directory) if e.is_file()
        )))
        for directory, _ in dirs
    )


def list_templates() -> list[dict[str, Any]]:
    """Every template's card. Blocking — call via the executor.

    Parsing every file costs most of a second on a small host, and the add
    dialog asks each time it opens; the answer is kept until a file in one of
    the folders is added, removed or changed, which a directory scan notices.
    """
    global _LISTED
    dirs = _template_dirs()
    signature = _files_signature(dirs)
    if _LISTED is None or _LISTED[0] != signature:
        # The user's own templates can change without a restart: whatever
        # changed the listing may have changed a parsed file too.
        _TEMPLATE_CACHE.clear()
        parsed: dict[str, dict[str, Any]] = {}
        _LISTED = (signature, _read_template_list(dirs, parsed))
        # The files were just parsed: `load_template` need not find and read
        # them again.
        _TEMPLATE_CACHE.update(parsed)
    return deepcopy(_LISTED[1])


def favorites_kind(template: dict[str, Any]) -> str:
    """The one kind of favourite a template's pages list, or ``""``.

    Read off its placeholders: every ``favorites`` one asks for the same
    ``category``, and nothing else is bound.
    """
    placeholders = template.get("placeholders")
    if not isinstance(placeholders, dict) or not placeholders:
        return ""
    kinds = {
        str(((p.get("spec") or {}).get("category") or "")) if p.get("source") == "favorites" else ""
        for p in placeholders.values() if isinstance(p, dict)
    }
    return kinds.pop() if len(kinds) == 1 else ""


def _read_template_list(
    dirs: list[tuple[str, tuple[str, ...]]],
    parsed: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Every template's card; *parsed* is given each template as `load_template` reads it."""
    # Every folder's card, read once. A template carries its whole ancestry, so
    # a parent's metadata is needed while reading its grandchildren too.
    # The first directory to claim a folder names it: the user's options
    # share **My Templates** with their templates and must not rename it.
    meta_by_path: dict[tuple[str, ...], dict[str, Any]] = {}
    for directory, path in dirs:
        if path and path not in meta_by_path:
            meta_by_path[path] = _group_meta(directory, path)
    seen: dict[str, str] = {}
    # The file `_read_template` would pick for an id: the first one there is.
    first: dict[str, str] = {}
    templates: list[dict[str, Any]] = []
    for directory, group_path in dirs:
        for fname in sorted(os.listdir(directory)):
            # `_group.yaml` describes the folder, it is not a page to add.
            if not fname.endswith(".yaml") or fname.startswith("_"):
                continue
            template_id = template_id_of(fname, directory)
            path = os.path.join(directory, fname)
            if parsed is not None and template_id not in first and os.path.isfile(path):
                first[template_id] = path
            # A stored page keeps the bare id it was created from, so one stem
            # can only ever mean one file however deep the tree goes.
            if template_id in seen:
                _LOGGER.warning(
                    "Template id %r is used by both %s and %s; ignoring the second",
                    template_id,
                    seen[template_id],
                    path,
                )
                continue
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = yaml.safe_load(fh) or {}
            except (OSError, yaml.YAMLError) as exc:
                _LOGGER.warning("Failed to read template %s: %s", fname, exc)
                continue
            if not _readable(template_id, data, path):
                continue
            seen[template_id] = path
            if (
                parsed is not None and first.get(template_id) == path
                and _valid_template_id(template_id)
            ):
                parsed[template_id] = deepcopy(data)

            # The file name orders its card among the others in its folder.
            entry: dict[str, Any] = {"id": template_id, "file": fname}
            _text_entry(entry, data, "name", template_id)
            entry["icon"] = data.get("icon", "mdi:remote")
            _text_entry(entry, data, "description", "")
            entry["target_selector"] = data.get("target_selector", {})
            # A template that brings subpages says how many pages adding it
            # makes, so the picker and the assistant tools can say so first.
            if not data.get("action"):
                page_count = len(template_pages(template_id, data))
                if page_count > 1:
                    entry["page_count"] = page_count
            # Added without asking for a device: the page is bound to none.
            if is_unbound(data) and not data.get("action"):
                entry["unbound"] = True
            # Its pages hold one kind of favourite only, and so are no use on a
            # speaker without any of that kind.
            if kind := favorites_kind(data):
                entry["favorites"] = kind
            # Only ever a button's options subpage: the plain Add page walk
            # leaves it out, since it makes no sense on its own.
            if template_id.startswith(OPTIONS_PREFIX):
                entry["options"] = True
            # A card that runs a panel routine instead of writing a page. The
            # panel maps the name to a handler and hides the card without one.
            if data.get("action"):
                entry["action"] = str(data["action"])
            # The folders it sits in, outermost first. The id stays the bare
            # file stem: folders are a directory layout, never part of an id,
            # so moving a template between them cannot orphan the pages
            # already made from it.
            if group_path:
                entry["groups"] = [
                    meta_by_path[group_path[:n]] for n in range(1, len(group_path) + 1)
                ]
            templates.append(entry)

    return templates


#: Parsed template files, keyed by id. A shipped template changes only with the
#: integration, which needs a restart anyway; the user's own are re-read once
#: :func:`list_templates` sees their folder change. ``None`` is cached too (the
#: store looks templates up on the event loop), and a file added later changes
#: the folder, which drops it.
_TEMPLATE_CACHE: dict[str, dict[str, Any] | None] = {}


def load_template(template_id: str) -> dict[str, Any] | None:
    """Parse one template file. Blocking — call via ``async_add_executor_job``.

    Callers mutate what they get back: resolving a page rewrites the template's
    buttons in place. Each call therefore hands out its own copy, so the cache
    saves the read without letting one caller's resolution leak into the next.
    """
    if template_id in _TEMPLATE_CACHE:
        cached = _TEMPLATE_CACHE[template_id]
        return deepcopy(cached) if cached is not None else None

    parsed = _read_template(template_id)
    _TEMPLATE_CACHE[template_id] = parsed
    return deepcopy(parsed) if parsed is not None else None


def preload_templates() -> None:
    """Read every template into the cache. Blocking — call via the executor.

    Reading stored pages looks up the template each came from, on the event
    loop; with every template already read, that lookup never touches disk.
    """
    for entry in list_templates():
        load_template(entry["id"])


async def async_load_template(hass: HomeAssistant, template_id: str) -> dict[str, Any] | None:
    """Parse a template without blocking the event loop.

    The first call for an id reads the file in an executor; later ones are served
    from the cache and do no I/O, so callers that only need the template *available*
    can await this and then work on the loop.
    """
    if template_id in _TEMPLATE_CACHE:
        return load_template(template_id)
    return await hass.async_add_executor_job(load_template, template_id)


#: A file name's leading ``01_``: where its card goes among the others in its
#: folder -- names are read in order and digits come before letters -- and no
#: part of its id, so the place can change without orphaning a page.
_ORDER_PREFIX_RE = re.compile(r"^\d+_(?=.)")


def _is_options_dir(directory: str) -> bool:
    """Whether *directory* holds options templates, shipped or the user's."""
    return any(
        root and (directory == root or directory.startswith(root + os.sep))
        for root in (OPTIONS_DIR, _user_options_dir())
    )


def template_id_of(fname: str, directory: str = "") -> str:
    """The template id a file name stands for: its stem without ``NN_``.

    A file in :data:`OPTIONS_DIR` has its id in the options space.
    """
    stem = fname[:-5] if fname.endswith(".yaml") else fname
    prefix = OPTIONS_PREFIX if _is_options_dir(directory) else ""
    return prefix + _ORDER_PREFIX_RE.sub("", stem, count=1)


def _valid_template_id(template_id: str) -> bool:
    stem = template_id.removeprefix(OPTIONS_PREFIX) if template_id else ""
    return not (
        not stem
        or stem.startswith((".", "_"))
        or os.path.basename(stem) != stem
        or os.path.isabs(stem)
    )


def _read_template(template_id: str) -> dict[str, Any] | None:
    # The id arrives from the panel and is about to become a filename. A bare
    # stem is the whole contract -- folders are a directory layout, never part
    # of an id -- so anything that could step out of the templates tree, or name
    # the `_group.yaml` metadata, is not a template id at all.
    if not _valid_template_id(template_id):
        _LOGGER.error("Invalid template id: %r", template_id)
        return None

    # `_template_dirs` walks the tree outermost first and sorted, and each
    # folder is read sorted, as `list_templates` reads it, so a duplicate id
    # resolves to the same file it offered rather than to whichever the
    # filesystem happened to answer with.
    matches = []
    for d, _ in _template_dirs():
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        matches += [
            p for name in names
            if name.endswith(".yaml") and not name.startswith("_")
            and template_id_of(name, d) == template_id
            and os.path.isfile(p := os.path.join(d, name))
        ]
    if len(matches) > 1:
        _LOGGER.warning(
            "Template id %r names several files (%s); reading the first",
            template_id,
            ", ".join(matches),
        )
    path = matches[0] if matches else None
    if path is None:
        _LOGGER.error("Template not found: %s", template_id)
        return None

    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
    except (OSError, yaml.YAMLError) as exc:
        _LOGGER.error("Failed to load template %s: %s", template_id, exc)
        return None
    return data if _readable(template_id, data, path) else None
