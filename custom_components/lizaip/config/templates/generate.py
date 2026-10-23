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
from ...shared.icon_defaults import icon_defaults
from ..const import ASSIGNMENT_BLANKED_KEY, drop_redundant_subject, payload_identity
from ...shared.assignment import ASSIGNMENT_DYNAMIC_KEY
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
    "list_templates",
    "load_template",
    "resolve_template_variables",
]

_LOGGER = logging.getLogger(__name__)


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
        "label": btn_def.get("label"),
        "image": page_field(btn_def, "icon"),
        "state_icons": {},
        "slider_actions": slider_actions,
    }


#: The shipped preset files. A sibling directory of this module rather than a
#: sibling of the package, so the code that reads templates and the templates it
#: reads live under one roof — ``presets`` is what a template *is* here, and the
#: package around it is already called ``templates``.
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "presets")
#: Folder metadata, not a template. The leading underscore is the rule: a
#: ``_``-prefixed file is never offered as a page.
_GROUP_FILE = "_group.yaml"
#: Where a folder's card is drawn. ``grid`` is a card inside the template
#: picker; ``option`` is a button on the add-page dialog's first screen. Only a
#: folder directly under ``presets/`` can be one -- it is the only surface.
_GROUP_SCOPES = frozenset({"grid", "option"})
_DEFAULT_SCOPE = "grid"
#: Everything ``_group.yaml`` may say. Anything else is a typo worth a warning:
#: a misspelt ``name`` is silently the folder name otherwise, which reads as
#: "the file was ignored" and is tedious to chase down.
_GROUP_KEYS = frozenset(
    {"name", "name_key", "icon", "description", "description_key", "scope"}
)
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

    def walk(directory: str, path: tuple[str, ...]) -> None:
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
            walk(child, (*path, name))

    walk(TEMPLATES_DIR, ())
    return dirs


def _group_meta(directory: str, path: tuple[str, ...]) -> dict[str, str]:
    """One folder's card: what it is called, what it looks like, where it sits.

    ``_group.yaml`` is optional: a folder without one still groups, it just
    falls back to its own name title-cased and a generic icon. A folder is a
    deliberate act, so the fallback has to be usable rather than a reason to
    refuse.

    ``name_key`` and ``description_key`` name an entry in the panel's
    translation table instead of spelling the words here, which is how a
    shipped folder keeps the translations it already had. The literal wins when
    both are given, since it is the more specific statement.
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

    scope = str(meta.get("scope") or _DEFAULT_SCOPE)
    if scope not in _GROUP_SCOPES:
        _LOGGER.warning(
            "Group metadata %s has scope %r; reading it as %r",
            file_path,
            scope,
            _DEFAULT_SCOPE,
        )
        scope = _DEFAULT_SCOPE
    # An option is a button on the first screen, and the first screen offers
    # the top level. A nested folder asking to be one has nowhere to be drawn,
    # so it stays an ordinary card rather than disappearing.
    if scope == "option" and len(path) != 1:
        _LOGGER.warning(
            "Group metadata %s asks for scope 'option' but is nested; reading it as %r",
            file_path,
            _DEFAULT_SCOPE,
        )
        scope = _DEFAULT_SCOPE

    group: dict[str, str] = {
        "id": "/".join(path),
        "name": str(meta.get("name") or path[-1].replace("-", " ").title()),
        "icon": str(meta.get("icon") or "mdi:folder-outline"),
        "description": str(meta.get("description") or ""),
        "scope": scope,
    }
    if not meta.get("name") and meta.get("name_key"):
        group["name_key"] = str(meta["name_key"])
    if not meta.get("description") and meta.get("description_key"):
        group["description_key"] = str(meta["description_key"])
    return group


# Generic service domains do not require a same-domain sibling on the bound
# device. Data-addressed domains either carry the subject in data
# (``notify.mobile_app_x``) or accept any target entity.
_DATA_ADDRESSED_DOMAINS = frozenset({
    "homeassistant", "notify", "persistent_notification", "tts",
    "logbook", "system_log",
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
_INTEGRATION_SERVICE_DOMAINS = {"webostv": "media_player"}


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




def list_templates() -> list[dict[str, Any]]:
    dirs = _template_dirs()
    # Every folder's card, read once. A template carries its whole ancestry, so
    # a parent's metadata is needed while reading its grandchildren too.
    meta_by_path = {
        path: _group_meta(directory, path) for directory, path in dirs if path
    }
    seen: dict[str, str] = {}
    templates: list[dict[str, Any]] = []
    for directory, group_path in dirs:
        for fname in sorted(os.listdir(directory)):
            # `_group.yaml` describes the folder, it is not a page to add.
            if not fname.endswith(".yaml") or fname.startswith("_"):
                continue
            template_id = fname[:-5]
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
            seen[template_id] = path

            entry = {
                "id": template_id,
                "name": data.get("name", template_id),
                "icon": data.get("icon", "mdi:remote"),
                "description": data.get("description", ""),
                "target_selector": data.get("target_selector", {}),
            }
            if data.get("page_image"):
                entry["page_image"] = data["page_image"]
            # Added without asking for a device: the page is bound to none.
            if data.get("unbound"):
                entry["unbound"] = True
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


#: Parsed template files, keyed by id. Templates ship inside the integration and are
#: never written at runtime — changing one means editing `custom_components/`,
#: which needs a restart anyway — so the file is worth reading only once.
#: ``None`` is cached too: a missing template stays missing for the same reason.
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


async def async_load_template(hass: HomeAssistant, template_id: str) -> dict[str, Any] | None:
    """Parse a template without blocking the event loop.

    The first call for an id reads the file in an executor; later ones are served
    from the cache and do no I/O, so callers that only need the template *available*
    can await this and then work on the loop.
    """
    if template_id in _TEMPLATE_CACHE:
        return load_template(template_id)
    return await hass.async_add_executor_job(load_template, template_id)


def _read_template(template_id: str) -> dict[str, Any] | None:
    # The id arrives from the panel and is about to become a filename. A bare
    # stem is the whole contract -- folders are a directory layout, never part
    # of an id -- so anything that could step out of the presets tree, or name
    # the `_group.yaml` metadata, is not a template id at all.
    if (
        not template_id
        or template_id.startswith((".", "_"))
        or os.path.basename(template_id) != template_id
        or os.path.isabs(template_id)
    ):
        _LOGGER.error("Invalid template id: %r", template_id)
        return None

    # `_template_dirs` walks the tree outermost first and sorted, so a
    # duplicate stem always resolves to the same file as `list_templates`
    # offered rather than to whichever the filesystem happened to answer with.
    matches = [
        p for d, _ in _template_dirs()
        if os.path.isfile(p := os.path.join(d, f"{template_id}.yaml"))
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
            return yaml.safe_load(fh) or {}
    except (OSError, yaml.YAMLError) as exc:
        _LOGGER.error("Failed to load template %s: %s", template_id, exc)
        return None


def _unassigned(btn_def: dict, binding: dict | None = None) -> dict:
    """Empty slot assignment; dynamic bindings stay so later refresh can fill it.

    The label/artwork still render, and the shape matches ``EMPTY_BUTTON`` in
    ``websocket/common.py`` including fields the panel and device sync read.
    """
    assignment = {
        "action_id": None,
        "config": [],
        "label": btn_def.get("label"),
        "image": page_field(btn_def, "icon"),
        "image_pinned": False,
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

    ``action_name`` names the library entry when the label cannot: a label built
    out of placeholders (``"${_state} - ${_device.media_title}"``) is a shape to
    fill in, and reading it back as the action's name would put raw token text in
    the Action Library. The key is generation-time only — it never reaches the
    stored page.
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

    # A label with placeholders is a shape, not a name: the Action Library
    # would show raw token text, and every button bound like it would read as
    # carrying the library's name. The service names it instead.
    label = btn_def.get("label")
    if isinstance(label, str) and "${" in label:
        label = svc_name.replace("_", " ").capitalize() if svc_name else None
    actions.append({
        "id": action_id,
        "name": (
            btn_def.get("action_name")
            or (
                label or fallback_name
                if fallback_name is not None
                else label or button_key
            )
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
        "label": btn_def.get("label"),
        "image": page_field(btn_def, "icon") or "",
        "state_icons": {},
    }
    # A template that wants a key to repeat while held says so per button.
    if btn_def.get("repeat") is True:
        assignment["repeat"] = True
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

        # Substitute through the whole button; @target may appear in label, icon,
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
            btn_def, button_key, target_entity, hass, template_id,
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
