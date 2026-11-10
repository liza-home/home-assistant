"""Load template YAML and turn it into action-library entries/assignments.

A preset spells a button the way a stored page does, and is read through the
``page_*`` helpers in :mod:`.resolver`, which also accept the flatter runtime
shape ``resolve_template_variables`` hands over for a bound button.

``@<source>[N]`` variables are resolved by ``resolver`` at page creation
and refreshed later through the stored ``dynamic`` binding. Missing items stay
empty but keep that binding so they can fill in when the source grows.
"""
from __future__ import annotations

import logging
import math
import os
import re
from copy import deepcopy
from typing import Any

import yaml

from homeassistant.core import HomeAssistant

from ...action_controller import (
    OVERRIDABLE_FIXED_KEYS,
    SLIDER_VERTICAL_KEY,
    SLIDER_TARGET_ENTITY,
    last_touched_or_entity_slider_actions,
    last_touched_slider_actions,
    targets_entity,
)
from ...shared.services import (
    service_name,
    split_service,
    is_state_toggle_service,
    icon_varies_with_state,
    scope_action_states,
    service_to_attribute,
)
from ...const import DOMAIN
from ...shared.icon_defaults import icon_defaults
from ...config.const import ASSIGNMENT_BLANKED_KEY, drop_redundant_subject, payload_identity
from ...shared.assignment import ASSIGNMENT_DYNAMIC_KEY, ASSIGNMENT_REPEAT_KEY
from ...shared.i18n import (
    FALLBACK_LANGUAGE,
    button_tooltips,
    translate_fallback,
    translate_key,
)
from .resolver import (
    DYNAMIC_KEY,
    config_step,
    page_field,
    page_slider,
    page_target_entity,
    resolve_template_variables,
    substitute_target,
)

__all__ = [
    "async_load_template",
    "generate_assignments",
    "is_unbound",
    "list_templates",
    "load_template",
    "page_definition",
    "page_source",
    "resolve_template_variables",
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

#: A button's shorthand for "send the remote to this template's page *name*".
PAGE_LINK_KEY = "goto_page"

#: What a page under ``pages:`` may say, and what a template must not say
#: beside them: the rest of the file -- its selector, its placeholders, its
#: card -- belongs to the template, and a page's title to that page.
_PAGE_KEYS = frozenset({"template", "title", "subpage", "buttons", "paginate", "max_parts"})

#: A page that repeats while its placeholder has more items than it has slots:
#: ``paginate: <placeholder>``. Each repeat -- a *part* -- shows the next run
#: of items, and ``max_parts`` caps how many there may be.
PAGINATE_KEY = "paginate"
MAX_PARTS_KEY = "max_parts"
DEFAULT_MAX_PARTS = 4

#: Link names that point at a paginated page's neighbouring parts. A link to
#: a part that does not exist leaves its button empty; a list of names takes
#: the first that exists (``[previous, remote]``: back a part, else home).
NEXT_PART = "next"
PREVIOUS_PART = "previous"
_PART_LINKS = frozenset({NEXT_PART, PREVIOUS_PART})

#: A button that differs on the last part of a paginated page::
#:
#:     button_12:
#:       placeholder: "@app[12]"     # on the last part
#:       more_parts: {goto_page: next, icon: …}   # while another follows
#:
#: Its item shows on the last part only, so twelve items fit one page.
PLACEHOLDER_KEY = "placeholder"
MORE_PARTS_KEY = "more_parts"

_PLACEHOLDER_TOKEN_RE = re.compile(r"@([a-z][a-z0-9_]*)\[(\d+)\]")


def paginated_placeholder(page: dict[str, Any]) -> str:
    """The placeholder a page repeats over, or ``""``."""
    value = page.get(PAGINATE_KEY) if isinstance(page, dict) else None
    return str(value).strip() if isinstance(value, str) else ""


def page_max_parts(page: dict[str, Any]) -> int:
    value = page.get(MAX_PARTS_KEY) if isinstance(page, dict) else None
    return value if isinstance(value, int) and value >= 1 else DEFAULT_MAX_PARTS


def page_span(buttons: dict[str, Any], placeholder: str) -> int:
    """How many items of *placeholder* one part shows: its highest index."""
    span = 0
    for value in _strings_in(buttons):
        for name, index in _PLACEHOLDER_TOKEN_RE.findall(value):
            if name == placeholder:
                span = max(span, int(index))
    return span


def has_more_parts(value: Any) -> bool:
    """Whether a button is one thing on the last part and another before it."""
    return isinstance(value, dict) and MORE_PARTS_KEY in value


def part_view(buttons: dict[str, Any], more_parts: bool) -> dict[str, Any]:
    """*buttons* as one part shows them: a button's ``more_parts:`` while
    another part follows (*more_parts*), its ``placeholder:`` otherwise --
    nothing where it names none."""
    out: dict[str, Any] = {}
    for key, value in buttons.items():
        if isinstance(value, dict) and (MORE_PARTS_KEY in value or PLACEHOLDER_KEY in value):
            use = MORE_PARTS_KEY if more_parts and MORE_PARTS_KEY in value else PLACEHOLDER_KEY
            value = value.get(use, {})
        out[key] = value
    return out


def part_items(buttons: dict[str, Any], placeholder: str) -> tuple[int, int]:
    """``(span, extra)``: the items every part shows, and how many more the
    last one shows on its buttons with ``more_parts:``."""
    every = part_view({k: v for k, v in buttons.items() if not has_more_parts(v)}, False)
    last = {k: v.get(PLACEHOLDER_KEY) for k, v in buttons.items() if has_more_parts(v)}
    span = page_span(every, placeholder)
    return span, max(0, page_span(last, placeholder) - span)


def part_buttons(
    buttons: dict[str, Any], placeholder: str, part: int = 1, *, last: bool = True,
) -> dict[str, Any]:
    """*buttons* as part *part* shows them, the *last* part or one before it.

    A button's ``more_parts:`` or ``placeholder:`` is picked, and each
    ``@placeholder[N]`` moved on by the items the parts before it show.
    """
    span = part_items(buttons, placeholder)[0] if placeholder else 0
    buttons = part_view(buttons, not last)
    if part <= 1 or not placeholder:
        return buttons
    offset = (part - 1) * span

    def shift(value: Any) -> Any:
        if isinstance(value, str):
            return _PLACEHOLDER_TOKEN_RE.sub(
                lambda m: (
                    f"@{m[1]}[{int(m[2]) + offset}]" if m[1] == placeholder else m[0]
                ),
                value,
            )
        if isinstance(value, dict):
            return {k: shift(v) for k, v in value.items()}
        if isinstance(value, list):
            return [shift(v) for v in value]
        return value

    return shift(buttons)


def _strings_in(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings_in(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings_in(v)


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


def page_buttons(
    buttons: dict[str, Any], page_ids: dict[str, int],
    *, template_id: str = "", page_name: str = "",
) -> dict[str, Any]:
    """One page's buttons, links made commands and translated words written out.

    A ``goto_page:`` link is written by name because the ids only exist once
    the pages are being made; it becomes the ``goto_page`` command the remote
    understands, pointing at whichever id that page was given.

    A ``{translate: <key>}`` tooltip or action name becomes the English wording
    of that ``button_tooltips`` entry, which is what a button stores: the remote
    draws a stored wording in its own language.
    """
    if not isinstance(buttons, dict):
        return {}

    resolved: dict[str, Any] = {}
    for key, btn_def in buttons.items():
        if isinstance(btn_def, dict):
            btn_def = _translated_wordings(btn_def, template_id, page_name, key)
        if not isinstance(btn_def, dict) or PAGE_LINK_KEY not in btn_def:
            resolved[key] = btn_def
            continue
        btn_def = dict(btn_def)
        named = btn_def.pop(PAGE_LINK_KEY)
        names = [str(n or "") for n in (named if isinstance(named, list) else [named])]
        target = next((n for n in names if n in page_ids), "")
        if not target and names and all(n in _PART_LINKS for n in names):
            # The neighbouring part does not exist (yet): an empty slot, not
            # a button that goes nowhere. A refresh that adds it fills it in.
            resolved[key] = {}
            continue
        if not target:
            target = names[-1] if names else ""
        if target not in page_ids:
            _LOGGER.warning(
                "Template %s page %r button %s links to page %r, which the "
                "template does not describe; leaving the button unassigned",
                template_id, page_name, key, target,
            )
            resolved[key] = btn_def
            continue
        btn_def["action"] = f"{DOMAIN}.goto_page"
        btn_def["data"] = {**(btn_def.get("data") or {}), "page_id": page_ids[target]}
        resolved[key] = btn_def
    return resolved


def _translated_wordings(
    btn_def: dict[str, Any], template_id: str, page_name: str, button_key: str,
) -> dict[str, Any]:
    """*btn_def* with a ``{translate: <key>}`` tooltip in English.

    A number written as an icon (``icon: 1``) is that number drawn as text,
    and one written as a tooltip is its text: YAML reads ``1`` as a number,
    where a button stores a picture and words.
    """
    out = btn_def
    for field in ("icon", "tooltip"):
        value = btn_def.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if out is btn_def:
                out = dict(btn_def)
            out[field] = f"text:{value}" if field == "icon" else str(value)
    btn_def = out
    for field in ("tooltip",):
        value = btn_def.get(field)
        key = translate_key(value)
        if not key:
            if isinstance(value, dict):
                # `{translate: off}` unquoted is YAML's False: say so rather
                # than store a mapping where a word belongs.
                _LOGGER.warning(
                    "Template %s page %r button %s: %s %r is no text and no "
                    "{translate: <key>}; quote the key",
                    template_id, page_name, button_key, field, value,
                )
                if out is btn_def:
                    out = dict(btn_def)
                out[field] = ""
            continue
        wording = button_tooltips.load(FALLBACK_LANGUAGE).get(key, "")
        if not wording:
            _LOGGER.warning(
                "Template %s page %r button %s: %s names no button tooltip %r",
                template_id, page_name, button_key, field, key,
            )
        if out is btn_def:
            out = dict(btn_def)
        out[field] = wording or translate_fallback(
            btn_def[field], key.replace("_", " ").capitalize(),
        )
    return out


def _template_num(raw, default: float, button_key: str, field: str) -> float:
    """Coerce user-editable template YAML numbers before they reach storage.

    ``.inf``/``.nan`` parse as floats but the executor rejects them, so template
    import rejects them too instead of storing a value every drag will warn on.
    """
    try:
        val = float(raw)
    except (TypeError, ValueError):
        val = None

    if val is None or not math.isfinite(val):
        _LOGGER.warning(
            "Template button %r: %r is not a valid number for '%s' — using %s",
            button_key, raw, field, default,
        )
        return default

    return val


#: Slider mechanics keys. ``target_entity`` is excluded: it names the default
#: device, not the control, and the ``last_touched_or_entity`` branch resolves
#: mechanics from that entity's live state.
_SLIDER_MECHANIC_KEYS = ("attribute", "service", "data_key")


def _slider_entity(btn_def: dict) -> Any:
    """The entity a slider declares as its own, in either spelling."""
    declared = page_slider(btn_def).get("target_entity")
    if isinstance(declared, str) and declared.strip():
        return declared
    return page_target_entity(btn_def)


def _declares_slider_mechanics(btn_def: dict) -> bool:
    """Whether this template spells out slider mechanics.

    Empty YAML scalars such as ``service:`` do not count. Without that guard, a
    present-but-empty key would turn a following slider into a fixed one and
    complete the missing mechanics from defaults the author did not ask for.
    """
    cfg = page_slider(btn_def)
    return any(str(cfg.get(key) or "").strip() for key in _SLIDER_MECHANIC_KEYS)


def _wants_derived_default(btn_def: dict) -> bool:
    """Whether a following slider names an entity to derive defaults from.

    This mirrors the stored-shape test in ``_effective_target``: proportional,
    no explicit ``target``, entity present, and no mechanics of its own.
    """
    cfg = page_slider(btn_def)
    return (
        cfg.get("mode") == "proportional"
        and not cfg.get("target")
        and bool(str(_slider_entity(btn_def) or "").strip())
        and not _declares_slider_mechanics(btn_def)
    )


def _slider_assignment(btn_def: dict, slider_actions: dict) -> dict:
    """Stored slider assignment; empty ``config`` routes events to slider handling.

    Both slider modes share this assignment shape. They differ only in the
    ``slider_actions`` mechanics blob, never by carrying a normal action.
    """
    return {
        "action_id": None,
        "config": [],
        "tooltip": btn_def.get("tooltip"),
        "icon": page_field(btn_def, "icon"),
        "state_icons": {},
        "slider_actions": slider_actions,
    }


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
#: ``presets/`` as one more folder, :data:`USER_TEMPLATES_GROUP`, with their
#: own options templates from ``<config>/lizaip/options`` beside them.
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


def user_templates_dir() -> str | None:
    """Where the user's own templates live, if set up."""
    return _USER_TEMPLATES_DIR


def forget_template(template_id: str) -> None:
    """Drop *template_id* from the cache; a template saved at runtime is read again."""
    _TEMPLATE_CACHE.pop(template_id, None)


#: How far down ``presets/`` is read. Nesting is deliberate and unbounded in
#: spirit, but a bounded walk cannot be talked into a long one by a mistake.
_MAX_DEPTH = 8


def _template_dirs() -> list[tuple[str, tuple[str, ...]]]:
    """``(directory, folder path)`` for every directory templates are read from.

    The path is the chain of directory names from ``presets/`` down, so
    ``presets/media/sonos`` is ``("media", "sonos")`` and ``presets/`` itself is
    ``()``. It is the folder's identity: a *path*, never a name, so two folders
    may share a leaf name under different parents.

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


# Generic service domains do not require a same-domain sibling on the bound
# device. Data-addressed domains either carry the subject in data
# (``notify.mobile_app_x``) or accept any target entity.
_DATA_ADDRESSED_DOMAINS = frozenset({
    "homeassistant", "notify", "persistent_notification", "tts",
    "logbook", "system_log",
    # `mqtt.publish` names its topic in the payload: how a TV that is only
    # reachable over MQTT (Hisense/Vidaa) has its keys pressed.
    "mqtt",
})

# script/scene/automation targets name the thing to run, not the bound device.
# They are exempt from sibling lookup, but automatic target injection is
# withheld; a template using one must name its own subject in ``target`` or data.
_ENTITY_ADDRESSED_DOMAINS = frozenset({"script", "scene", "automation"})

_GENERIC_SERVICE_DOMAINS = _DATA_ADDRESSED_DOMAINS | _ENTITY_ADDRESSED_DOMAINS

#: Integration service domains that are no entity domain, and the entity domain
#: they act on. ``webostv.button`` presses a key on an LG TV whose only entity
#: is its ``media_player``: without this the D-pad would look for a
#: ``webostv.*`` sibling, find none and leave every slot unassigned.
#: ``sonos.set_sleep_timer`` reaches a speaker the same way.
_INTEGRATION_SERVICE_DOMAINS = {"webostv": "media_player", "sonos": "media_player"}


def _payload_entity(btn_def: dict) -> str:
    """Single entity named by ``data``; multi-entity payloads cannot drive sliders.

    The action target and selected slider target need one answer. A payload
    aimed at several entities cannot provide that answer safely.
    """
    data = page_field(btn_def, "data")
    if not isinstance(data, dict):
        return ""
    entity = data.get("entity_id")
    if isinstance(entity, str) and "." in entity:
        return entity
    return ""


def _declared_entity(btn_def: dict, action: Any) -> Any:
    """The entity a button pins itself to, if its target names one.

    A script/scene/automation step's ``target`` names the object to run, not
    the device the page is bound to, so it says nothing about which entity the
    button drives — :func:`_action_step_for` is its only reader. Those domains
    are generic enough to accept anything, so reading the target here would
    silently make the script itself the button's entity, and in turn the
    slider's retarget subject.
    """
    if isinstance(action, str) and split_service(action)[0] in _ENTITY_ADDRESSED_DOMAINS:
        return None
    return page_target_entity(btn_def)


def _slider_target(
    btn_def: dict, target_entity: str, domain_entities: dict[str, str] | None,
) -> str:
    """The entity a slider moves unless it names one: the bound entity, or the
    device's entity of the domain its ``service`` acts on -- as a button binds
    by its action. A TV bound by its ``remote`` sets the volume on its
    ``media_player``."""
    service = page_slider(btn_def).get("service")
    domain = service.split(".")[0] if isinstance(service, str) and "." in service else ""
    primary = target_entity.split(".")[0] if "." in target_entity else ""
    if domain and domain != primary:
        return (domain_entities or {}).get(domain) or target_entity
    return target_entity


def _button_entity(
    btn_def: dict, target_entity: str, domain_entities: dict[str, str] | None,
) -> tuple[str, str | None]:
    """Return ``(entity_id, unresolved_domain)`` for a template button.

    The action's service domain chooses the bound device's primary or sibling
    entity. A step's own ``target`` and data ``entity_id`` may override it, but
    only when they can service the action. ``unresolved_domain`` tells
    callers to leave the slot unassigned instead of firing at the wrong domain.

    The service domain is not separately declared: a separate field would only
    restate the action and could contradict it. Device-mode templates derive only
    the primary entity or a sibling of the same device; per-button payload
    entities cover generated grids where each button drives a different device.
    """
    action = page_field(btn_def, "action")
    declared = _declared_entity(btn_def, action)
    # Resolve before returning; otherwise @target can substitute into itself.
    declared = substitute_target(declared, target_entity)
    if not isinstance(action, str) or "." not in action:
        if isinstance(declared, str) and declared:
            return declared, None
        return target_entity, None

    # The integration's own commands (`lizaip.goto_page`) run on the remote
    # itself and address no entity -- an unbound template has none to give.
    if action.split(".")[0] == DOMAIN:
        return "", None

    # The entity domain the service acts on: its own, or the one an
    # integration's service domain addresses.
    domain = action.split(".")[0]
    domain = _INTEGRATION_SERVICE_DOMAINS.get(domain, domain)

    if isinstance(declared, str) and declared:
        declared_domain = declared.split(".")[0] if "." in declared else ""
        if declared_domain == domain or domain in _GENERIC_SERVICE_DOMAINS:
            return declared, None
        _LOGGER.warning(
            "Template button target %r cannot service a '%s' action; "
            "falling back to the derived entity",
            declared, domain,
        )

    # Dynamic-source buttons are self-targeting through their resolved payload;
    # config-entry pages have no primary entity to derive from.
    payload = _payload_entity(btn_def)
    if payload:
        payload_domain = payload.split(".")[0] if "." in payload else ""
        if payload_domain == domain or domain in _GENERIC_SERVICE_DOMAINS:
            return payload, None

    primary_domain = target_entity.split(".")[0] if "." in target_entity else ""

    if domain == primary_domain or domain in _GENERIC_SERVICE_DOMAINS:
        return target_entity, None

    sibling = (domain_entities or {}).get(domain)
    if sibling:
        return sibling, None

    # Leave unassigned; firing at the wrong domain would fail later.
    return target_entity, domain


# Button config stays a single action step: the panel, payload display, and
# device sync all treat config[0] as the button action. Preparatory script steps
# live in sibling ``before``/``after`` keys so panel edits preserve them.


def _button_prelude(btn_def: dict, button_key: str) -> list[dict] | None:
    """Return ``before`` steps, preserving ``None`` vs ``[]``.

    Absence lets the executor infer wake steps; ``before: []`` explicitly
    suppresses that inference. ``@target`` has already been substituted through
    nested lists and dicts before this runs.

    A malformed ``before`` is not a suppression request. Returning ``None`` lets
    the executor infer normally instead of silently disabling wake behavior.
    """
    custom = btn_def.get("before")

    if custom is None:
        return None

    if not isinstance(custom, list):
        _LOGGER.warning(
            "Template button %r has a 'before' that is not a list of script "
            "steps (%s); ignoring it", button_key, type(custom).__name__,
        )
        # Invalid before is not an explicit wake-suppression request.
        return None

    return list(custom)




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
        _LISTED = (signature, _read_template_list(dirs))
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


def _read_template_list(dirs: list[tuple[str, tuple[str, ...]]]) -> list[dict[str, Any]]:
    # Every folder's card, read once. A template carries its whole ancestry, so
    # a parent's metadata is needed while reading its grandchildren too.
    # The first directory to claim a folder names it: the user's options
    # share **My Templates** with their templates and must not rename it.
    meta_by_path: dict[tuple[str, ...], dict[str, Any]] = {}
    for directory, path in dirs:
        if path and path not in meta_by_path:
            meta_by_path[path] = _group_meta(directory, path)
    seen: dict[str, str] = {}
    templates: list[dict[str, Any]] = []
    for directory, group_path in dirs:
        for fname in sorted(os.listdir(directory)):
            # `_group.yaml` describes the folder, it is not a page to add.
            if not fname.endswith(".yaml") or fname.startswith("_"):
                continue
            template_id = template_id_of(fname, directory)
            path = os.path.join(directory, fname)
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
#: integration, which needs a restart anyway, so the file is worth reading only
#: once. ``None`` is cached too. A template saved into the user's folder at
#: runtime is dropped from here by :func:`forget_template`.
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


def _read_template(template_id: str) -> dict[str, Any] | None:
    # The id arrives from the panel and is about to become a filename. A bare
    # stem is the whole contract -- folders are a directory layout, never part
    # of an id -- so anything that could step out of the presets tree, or name
    # the `_group.yaml` metadata, is not a template id at all.
    stem = template_id.removeprefix(OPTIONS_PREFIX) if template_id else ""
    if (
        not stem
        or stem.startswith((".", "_"))
        or os.path.basename(stem) != stem
        or os.path.isabs(stem)
    ):
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


def _unassigned(btn_def: dict, binding: dict | None = None) -> dict:
    """Empty slot assignment; dynamic bindings stay so later refresh can fill it.

    The tooltip/artwork still render, and the shape matches ``EMPTY_BUTTON`` in
    ``websocket/common.py`` including fields the panel and device sync read.
    """
    assignment = {
        "action_id": None,
        "config": [],
        "tooltip": btn_def.get("tooltip"),
        "icon": page_field(btn_def, "icon"),
        "icon_pinned": False,
        "state_icons": {},
    }
    if binding:
        assignment[ASSIGNMENT_DYNAMIC_KEY] = binding
    return assignment


def _register_action(
    actions: list[dict],
    seen_actions: dict[str, str],
    template_id: str,
    button_key: str,
    btn_def: dict,
    action_str: str,
    data: dict,
    fallback_name: str | None = None,
) -> str:
    """Return/deduplicate the template action id, mutating the shared library.

    Payload identity is normalised before deduping so nested payloads such as
    ``data.media.media_content_id`` do not collapse onto one shared action.
    Dormant dynamic slots use the service as fallback name until an item exists.

    One action library is built across the template. Unnamed hand-written buttons
    keep their button key as the action-list label; dormant generated slots use
    the service because ``button_9`` says nothing about the future item.

    A tooltip built out of placeholders (``"${_state} - ${_device.media_title}"``)
    is a shape to fill in, not a name: the entry is named after the service the
    way the panel names a new action (``_deriveActionName``), in English.
    """
    dedup_key = f"{action_str}|{payload_identity(data)}"
    if dedup_key in seen_actions:
        return seen_actions[dedup_key]

    action_id = f"template_{template_id}_{button_key}"
    seen_actions[dedup_key] = action_id

    svc_name = service_name(action_str)
    svc_domain = action_str.split(".")[0] if "." in action_str else ""

    # Match device_sync/panel: only services with state-varying icons get states[].
    derived_states: list[dict] = []
    if icon_varies_with_state(svc_name):
        attr = service_to_attribute(svc_name)
        if attr:
            attr_icons = icon_defaults.attribute_icons.get(attr, {})
            derived_states = [
                {"state": s, "icon": i, "attribute": attr}
                for s, i in attr_icons.items() if i
            ]
        elif is_state_toggle_service(svc_name):
            domain_icons = icon_defaults.domain_state_icons.get(svc_domain, {})
            derived_states = scope_action_states(
                svc_name,
                [{"state": s, "icon": i} for s, i in domain_icons.items() if i],
            )

    # A tooltip with placeholders is a shape, not a name: the Action Library
    # would show raw token text, and every button bound like it would read as
    # carrying the library's name. The service names it instead, as the panel
    # names a new action.
    tooltip = btn_def.get("tooltip")
    if isinstance(tooltip, str) and "${" in tooltip:
        tooltip = button_tooltips.for_service(svc_name, FALLBACK_LANGUAGE) if svc_name else None
    actions.append({
        "id": action_id,
        "name": (
            tooltip or fallback_name
            if fallback_name is not None
            else tooltip or button_key
        ),
        "icon": page_field(btn_def, "icon") or "",
        "service": action_str,
        "states": derived_states,
    })
    return action_id


def _stash_dormant_action(
    assignment: dict,
    btn_def: dict,
    binding: dict,
    actions: list[dict],
    seen_actions: dict[str, str],
    template_id: str,
    button_key: str,
) -> None:
    """Stash the action a bound-empty slot should regain when an item appears.

    Refresh can later restore only fields kept under the dynamic binding. An
    empty ``target`` and an empty slider subject are intentional placeholders
    for ``_retarget_subject``; absence would mean the slot never drives a
    slider.

    This reuses the same stash/restore path as a dynamic item that became
    temporarily blank, so a slot born empty does not need a second recovery path.
    """
    action_str = page_field(btn_def, "action")
    if not isinstance(action_str, str) or "." not in action_str:
        return

    data = page_field(btn_def, "data")
    data = dict(data) if isinstance(data, dict) else {}
    action_id = _register_action(
        actions, seen_actions, template_id, button_key, btn_def, action_str, data,
        fallback_name=action_str,
    )
    binding[ASSIGNMENT_BLANKED_KEY] = {
        "action_id": action_id,
        "config": [{
            "action": action_str,
            "target": {"entity_id": ""},
            "data": data,
        }],
    }
    overrides = _stored_overrides(btn_def, "")
    if overrides:
        assignment["overrides"] = overrides


def _template_overrides(btn_def: dict) -> dict:
    """The fixed controls this button drives while it is the selection.

    One key per control, naming a service (a fixed button) or a capability (the
    slider). The slider's entry is the stored ``{entity_id, control}`` block,
    but only the control id is read here: the subject is not a template's to
    state — it is the button's own resolved entity, which :func:`_stored_overrides`
    fills in.

    Every value names a capability or service rather than a frozen
    sub-assignment, so it follows the button's entity when a refresh replaces
    it; see :data:`OVERRIDABLE_FIXED_KEYS`.
    """
    declared = btn_def.get("overrides")
    if not isinstance(declared, dict):
        return {}
    out = {}
    for key, value in declared.items():
        if key not in OVERRIDABLE_FIXED_KEYS:
            continue
        if key == SLIDER_VERTICAL_KEY:
            if not isinstance(value, dict):
                _LOGGER.warning(
                    "Template override %s: %r is not a {entity_id, control} block",
                    key, value,
                )
                continue
            value = value.get("control")
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    return out


def _stored_overrides(btn_def: dict, btn_entity: str) -> dict:
    """The template's override table in the shape the store keeps.

    One conversion, shared by the two callers that write a generated button's
    overrides, because a preset and the stored contract differ in exactly one
    key and a second copy of that rule is a second chance to forget it.

    The slider's control id becomes ``{entity_id, control}``. Naming the
    axis in the template is the retarget opt-in, and *this* is where the subject
    it implies gets a value: the button's own resolved entity, not the page
    target, because buttons may drive same-device siblings — the preset's
    ``@target`` stand-in for it is overwritten here. An empty *btn_entity*
    still writes the block — that is the bound-empty placeholder
    ``_retarget_subject`` refills when the source item appears.

    There is no spelling for "name the axis but derive the control", so
    the id a template wrote is always stored. It is a preset author's explicit
    choice, and the one thing the derived default cannot be trusted to match.
    """
    overrides = _template_overrides(btn_def)
    control = overrides.pop(SLIDER_VERTICAL_KEY, None)
    if control is None:
        return overrides
    overrides[SLIDER_VERTICAL_KEY] = {
        "entity_id": btn_entity if isinstance(btn_entity, str) else "",
        "control": control,
    }
    return overrides


def _action_step_for(btn_def: dict, action_str: str, btn_entity: str, data: dict) -> dict:
    # Copied: the same payload dict is handed to `_register_action`, and the
    # step is about to drop a key from it.
    step = {"action": action_str, "target": {"entity_id": btn_entity}, "data": dict(data)}
    if split_service(action_str)[0] in (DOMAIN, "mqtt"):
        # A device-local command, or an MQTT message: its payload is the whole
        # of what it needs, and `mqtt.publish` refuses a target.
        step.pop("target")

    # script/scene/automation targets name the runnable object, not bound device.
    if split_service(action_str)[0] in _ENTITY_ADDRESSED_DOMAINS:
        declared = (config_step(btn_def) or {}).get("target")
        if isinstance(declared, dict) and declared:
            step["target"] = declared
        else:
            step.pop("target")
    # After the target is final: a payload entity that became the target has
    # said its piece, and the target is the half every reader asks first.
    drop_redundant_subject(step)
    return step


def _action_button_assignment(
    btn_def: dict,
    button_key: str,
    btn_entity: str,
    action_str: str,
    binding: dict | None,
    actions: list[dict],
    seen_actions: dict[str, str],
    template_id: str,
) -> dict:
    """Build a non-slider assignment and register its deduplicated action.

    The config payload is the single service step the panel and device sync
    expect. Extra preparatory steps stay in sibling keys, not inside config.
    """
    data = page_field(btn_def, "data")
    if not isinstance(data, dict):
        data = {}

    assignment = {
        "action_id": _register_action(
            actions, seen_actions, template_id, button_key, btn_def, action_str, data,
        ),
        "config": [_action_step_for(btn_def, action_str, btn_entity, data)],
        "tooltip": btn_def.get("tooltip"),
        "icon": page_field(btn_def, "icon") or "",
        "state_icons": {},
    }
    # A template that wants a key to repeat while held says so per button.
    if btn_def.get(ASSIGNMENT_REPEAT_KEY) is True:
        assignment[ASSIGNMENT_REPEAT_KEY] = True
    # Store [] too: before's absence is what allows wake inference.
    prelude = _button_prelude(btn_def, button_key)
    if prelude is not None:
        assignment["before"] = prelude

    if binding:
        assignment[ASSIGNMENT_DYNAMIC_KEY] = binding

    _apply_slider_display_hints(assignment, btn_def, btn_entity)
    return assignment


def _slider_actions_for(
    btn_def: dict,
    button_key: str,
    target_entity: str,
    hass: HomeAssistant | None,
    template_id: str,
) -> dict | None:
    """Return declared proportional slider mechanics, or ``None`` for a button.

    Priority: following with a derived default entity, then a fully spelled
    proportional block. Discrete up/down stepping belongs on the
    normal volume buttons, not in ``slider_actions``.
    """
    cfg = page_slider(btn_def)

    def factor() -> float:
        return _template_num(cfg.get("factor", 1.0), 1.0, button_key, "factor")

    if _wants_derived_default(btn_def):
        # Entity-only sliders derive mechanics from that entity's live state.
        default_entity = _slider_entity(btn_def) or target_entity
        actions = last_touched_or_entity_slider_actions(hass, default_entity, factor())
        if actions is None:
            # Do not store an unresolved partial default; fall back to following.
            _LOGGER.warning(
                "Template %s slider %s: cannot resolve slider mechanics for the "
                "default entity '%s' -- the slider will follow the last-touched "
                "device with no default",
                template_id, button_key, default_entity,
            )
            actions = last_touched_slider_actions(factor())
        return actions

    if cfg.get("mode") != "proportional":
        return None

    if not _declares_slider_mechanics(btn_def):
        # No mechanics means follow the selected button.
        return last_touched_slider_actions(factor())

    # Defaults only complete a mechanic set the template started; template YAML is
    # user-editable and bypasses the panel's slider sanitiser.
    attribute = cfg.get("attribute", "volume_level")
    actions = {
        "mode": "proportional",
        "target_entity": _slider_entity(btn_def) or target_entity,
        "attribute": attribute,
        "service": cfg.get("service", "media_player.volume_set"),
        "data_key": cfg.get("data_key", attribute),
        "factor": factor(),
        "min": _template_num(cfg.get("min", 0.0), 0.0, button_key, "min"),
        "max": _template_num(cfg.get("max", 1.0), 1.0, button_key, "max"),
    }
    # Only explicit opt-out pins the slider to this entity.
    if targets_entity(cfg):
        actions["target"] = SLIDER_TARGET_ENTITY
    return actions


def _apply_slider_display_hints(assignment: dict, btn_def: dict, btn_entity: str) -> None:
    """Copy explicit slider display/retarget hints; absence means derive.

    ``overrides`` is the template's one block for every fixed control. Naming
    ``slider_vertical`` is the retarget opt-in, and :func:`_stored_overrides`
    fills in the block's ``entity_id`` — the subject, known only once the
    target device is.
    """
    overrides = _stored_overrides(btn_def, btn_entity)
    if overrides:
        assignment["overrides"] = overrides

    for key in ("slider_image", "slider_name"):
        value = btn_def.get(key)
        if isinstance(value, str) and value.strip():
            assignment[key] = value.strip()

    if btn_def.get("slider_hide_icon"):
        assignment["slider_hide_icon"] = True


def generate_assignments(
    template_id: str,
    target_entity: str,
    resolved_template: dict | None = None,
    domain_entities: dict[str, str] | None = None,
    hass: HomeAssistant | None = None,
) -> tuple[list[dict], dict[str, dict]]:
    """Generate ``(action_library_entries, assignments)`` from a template.

    ``domain_entities`` lets device-mode templates bind sibling domains of the
    same device. ``hass`` is needed only for sliders that derive default
    mechanics from live state during page creation.

    ``resolved_template`` should already have dynamic variables expanded. If it is
    omitted, the raw file is loaded and unresolved placeholder buttons — bare
    token strings, not mappings — are skipped rather than turned into
    assignments.
    """
    template = resolved_template or load_template(template_id)
    if not template:
        return [], {}

    buttons = template.get("buttons", {})
    actions: list[dict] = []
    assignments: dict[str, dict] = {}
    seen_actions: dict[str, str] = {}

    for button_key, btn_def in buttons.items():
        if not isinstance(btn_def, dict):
            continue
        # Already done when the page was composed; repeated for a caller that
        # hands in a page straight from the file.
        btn_def = _translated_wordings(btn_def, template_id, "", button_key)

        # Target resolution must precede @target substitution and action building:
        # a button may bind a sibling entity, not the template's primary one.
        btn_entity, unresolved_domain = _button_entity(
            btn_def, target_entity, domain_entities,
        )
        if unresolved_domain:
            _LOGGER.warning(
                "Template %s button %s needs a '%s' entity but the target device "
                "has none; leaving button unassigned",
                template_id, button_key, unresolved_domain,
            )

        # Substitute through the whole button; @target may appear in tooltip, icon,
        # target, before/after, or data.
        btn_def = substitute_target(btn_def, btn_entity)

        # Dynamic sidecar metadata must not enter service payloads or dedup keys.
        binding = btn_def.pop(DYNAMIC_KEY, None)
        if not isinstance(binding, dict):
            binding = None

        if unresolved_domain:
            assignment = _unassigned(btn_def, binding)
            if binding is not None:
                _stash_dormant_action(
                    assignment, btn_def, binding,
                    actions, seen_actions, template_id, button_key,
                )
            assignments[button_key] = assignment
            continue

        slider_actions = _slider_actions_for(
            btn_def, button_key, _slider_target(btn_def, target_entity, domain_entities),
            hass, template_id,
        )
        if slider_actions is not None:
            assignments[button_key] = _slider_assignment(btn_def, slider_actions)
            continue

        action_str = page_field(btn_def, "action")
        if not action_str or action_str == "null":
            assignments[button_key] = _unassigned(btn_def, binding)
            continue

        assignments[button_key] = _action_button_assignment(
            btn_def, button_key, btn_entity, action_str, binding,
            actions, seen_actions, template_id,
        )

    return actions, assignments
