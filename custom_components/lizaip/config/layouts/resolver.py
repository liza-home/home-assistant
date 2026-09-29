"""Layout token resolution against the dynamic source registry.

Token grammar (1-based index, matching how layout authors count buttons)::

    @<source>[N]            whole-button shorthand
    @<source>[N].<field>    per-field substitution

``<source>`` is any registered id, so ``@favorites[1]`` and
``@scenes[3].title`` use the same mechanism. It may also name a *placeholder*
— a layout-level definition pairing a source with the static fields every
button built from it shares — which expands to the same two forms before
anything else runs. Every token-bearing button also gets a ``_dynamic`` sidecar
describing how it was resolved, so stored assignments can be re-resolved later.
"""
from __future__ import annotations

import logging
import re
from copy import deepcopy
from typing import Any, NamedTuple

from homeassistant.core import HomeAssistant

from .sources import (
    DEFAULT_MAX_ITEMS,
    DynamicItem,
    async_resolve_source,
    get_source,
)

_LOGGER = logging.getLogger(__name__)

#: ``@source[N]`` or ``@source[N].field``
TOKEN_RE = re.compile(r"^@([a-z][a-z0-9_]*)\[(\d+)\](?:\.(\w+))?$")

#: Layout-button field → attribute of :class:`DynamicItem`.
FIELD_MAP = {
    "label": "title",
    "icon": "icon",
    "title": "title",
    "thumbnail": "icon",
    "data": "data",
    "action": "action",
}

class BindingResolution(NamedTuple):
    """What one re-resolve of a binding found."""

    item: DynamicItem | None
    error: str | None


#: Layout-button field → where it lands on a stored assignment.
#: ``config`` fields address ``assignment["config"][0][...]``.
ASSIGNMENT_FIELD_MAP = {
    "label": ("label", None),
    "icon": ("image", None),
    "data": ("config", "data"),
    "action": ("config", "action"),
}

#: Marker key on a resolved layout button; consumed by ``generate_assignments``.
DYNAMIC_KEY = "_dynamic"

#: Top-level layout key holding reusable button definitions.
PLACEHOLDERS_KEY = "placeholders"

#: Keys of a placeholder that configure it rather than land on the button.
PLACEHOLDER_META = frozenset({"source", "spec", "overflow"})

#: What the whole-button shorthand maintains, and so what a placeholder binds
#: for every field it does not state statically itself.
BOUND_FIELDS = ["label", "icon", "data", "action"]


def config_step(btn_def: dict) -> dict | None:
    """The single action step of a page-shaped button, if it has one."""
    config = btn_def.get("config")
    if isinstance(config, list) and config and isinstance(config[0], dict):
        return config[0]
    return None


def _page_read(btn_def: Any, field: str) -> tuple[bool, Any]:
    """Whether the button states one runtime field, and what it says.

    :data:`ASSIGNMENT_FIELD_MAP` already says where each runtime field lands on
    a stored assignment, so reading a page-shaped button is that map run
    backwards. One lookup, so "where does this live" has a single answer.

    The runtime spelling is the fallback, and it is load-bearing: bound buttons
    carry it, and every page persists it in ``dynamic.fields`` for
    :mod:`refresh` to read back. Renaming it would be a migration of pages
    already on disk, so only the files changed.
    """
    if not isinstance(btn_def, dict):
        return False, None
    key, sub = ASSIGNMENT_FIELD_MAP.get(field, (field, None))
    if sub is None:
        holder, name = btn_def, key
    else:
        holder, name = config_step(btn_def) or {}, sub
    if name in holder:
        return True, holder[name]
    if field in btn_def:
        return True, btn_def[field]
    return False, None


def page_states(btn_def: Any, field: str) -> bool:
    """Whether the button says *field* at all, in either spelling.

    Presence, not truth: ``action: null`` says the button does nothing, which
    is a statement; an absent key is what a placeholder fills with a token.
    """
    stated, _ = _page_read(btn_def, field)
    return stated


def page_field(btn_def: Any, field: str) -> Any:
    """Read one runtime field off a button written in the page format."""
    _, value = _page_read(btn_def, field)
    return value


def page_target_entity(btn_def: dict) -> Any:
    """The entity a button pins itself to, or ``None`` to derive one.

    A page names the subject in its step's ``target``; a preset writes
    :data:`TARGET_TOKEN` there for "the bound target", which is what deriving
    produces anyway — so the token reads as absence, not as an unmatchable id.
    """
    step = config_step(btn_def)
    target = step.get("target") if step else None
    if isinstance(target, dict):
        declared = target.get("entity_id")
        if isinstance(declared, str):
            declared = declared.strip()
            return None if declared in ("", TARGET_TOKEN) else declared
    return None


def page_slider(btn_def: dict) -> dict:
    """The block a slider's mechanics are declared in.

    A page keeps them under ``slider_actions``; nothing else on the button is
    a slider's to read.
    """
    block = btn_def.get("slider_actions")
    return block if isinstance(block, dict) else {}


def expand_placeholders(layout: dict) -> dict[str, dict]:
    """Rewrite ``@<placeholder>[N]`` buttons into ordinary token entries.

    A placeholder names a source and the static fields every button built from
    it shares, so twelve Hue lamps read as twelve ``@mylight[N]`` lines instead
    of twelve copies of the same three static keys. Whatever the placeholder
    states statically it owns; every remaining field is bound to the source, so
    a static value and a bound one can never contradict each other.

    Expansion happens before scanning/resolution, so ``scan_requirements``, the
    ``_dynamic`` sidecar and ``generate_assignments`` see only ordinary tokens.
    Returns overflow fallbacks keyed by slot.
    """
    buttons = layout.get("buttons")
    placeholders = layout.get(PLACEHOLDERS_KEY)
    if not isinstance(buttons, dict) or not isinstance(placeholders, dict):
        return {}

    overflow_defs: dict[str, dict] = {}
    expanded: dict[str, Any] = {}

    for btn_key, val in buttons.items():
        parsed = parse_token(val)
        spec = placeholders.get(parsed[0]) if parsed else None
        # Only the whole-button form takes a placeholder: a per-field token
        # already says which field it fills, leaving nothing to expand.
        if not parsed or parsed[2] is not None or not isinstance(spec, dict):
            expanded[btn_key] = val
            continue

        source_id = str(spec.get("source") or "").strip()
        if not TOKEN_RE.match(f"@{source_id}[1]"):
            _LOGGER.warning(
                "placeholder %r: %r is not a valid source id; leaving %s as written",
                parsed[0], spec.get("source"), btn_key,
            )
            expanded[btn_key] = val
            continue

        index = parsed[1] + 1
        statics = {k: v for k, v in spec.items() if k not in PLACEHOLDER_META}
        if statics:
            expanded[btn_key] = {
                **statics,
                **{
                    field: f"@{source_id}[{index}].{field}"
                    for field in BOUND_FIELDS
                    if not page_states(statics, field)
                },
            }
        else:
            # Nothing layout-owned to add: the plain shorthand already says it.
            expanded[btn_key] = f"@{source_id}[{index}]"

        overflow = spec.get("overflow")
        if overflow is not None and not isinstance(overflow, dict):
            _LOGGER.warning(
                "placeholder %r: 'overflow' must be a mapping, got %r",
                parsed[0], overflow,
            )
        elif overflow is not None:
            overflow_defs[btn_key] = dict(overflow)

    buttons.clear()
    buttons.update(expanded)
    return overflow_defs


def _apply_overflow(buttons: dict, overflow_defs: dict[str, dict]) -> None:
    """Give past-the-end slots their static fallback, keeping the binding.

    Overflow slots are still bound, only currently empty, so later refreshes can
    fill them when the source grows. Only display fields are replaced.
    """
    for btn_key, overflow in overflow_defs.items():
        button = buttons.get(btn_key)
        if not isinstance(button, dict):
            continue
        binding = button.get(DYNAMIC_KEY)
        if not isinstance(binding, dict) or not binding.get("stale"):
            continue
        # Only placeholders are overflow. Soft source failures keep last-known
        # content; initial unreadable sources still take fallback icons while
        # their bindings survive for later refill.
        if button.get("label") != "" or button.get("action") != "null":
            continue
        for field, value in overflow.items():
            if field != DYNAMIC_KEY:
                button[field] = value


def parse_token(value: Any) -> tuple[str, int, str | None] | None:
    """Return ``(source_id, index, field)`` for a token string, else ``None``.

    ``index`` is returned 0-based; ``field`` is ``None`` for the whole-button
    shorthand.
    """
    if not isinstance(value, str):
        return None
    match = TOKEN_RE.match(value.strip())
    if not match:
        return None
    source_id, raw_index, field = match.groups()
    return source_id, int(raw_index) - 1, field


def button_tokens(btn_def: Any) -> dict[str, tuple[str, int, str | None]]:
    """Map each token-bearing field of a button to its parsed token.

    The whole-button shorthand is reported under the empty-string key so the
    two forms can be handled by one caller.
    """
    if isinstance(btn_def, str):
        parsed = parse_token(btn_def)
        return {"": parsed} if parsed and parsed[2] is None else {}
    if not isinstance(btn_def, dict):
        return {}
    found: dict[str, tuple[str, int, str | None]] = {}
    for field, val in btn_def.items():
        parsed = parse_token(val)
        if parsed and parsed[2] is not None:
            found[field] = parsed
    return found


def scan_requirements(buttons: dict) -> dict[str, int]:
    """Highest 1-based index each source needs across *buttons*.

    One entry per source means one fetch per page, not one browse per button on
    a Sonos favorites page.
    """
    needed: dict[str, int] = {}
    for btn_def in (buttons or {}).values():
        for _field, (source_id, idx, _f) in button_tokens(btn_def).items():
            needed[source_id] = max(needed.get(source_id, 0), idx + 1)
    return needed


def substitute_target(value: Any, target_entity: str) -> Any:
    """Replace ``@target`` throughout *value* (recurses into dicts/lists)."""
    return substitute_tokens(value, {TARGET_TOKEN: target_entity})


#: The entity the page is bound to. Only meaningful for a device-mode layout.
TARGET_TOKEN = "@target"

#: The config entry the page is bound to, for a layout whose ``target_selector``
#: names a ``config_entry`` rather than a device — a Hue *bridge*, say, whose
#: lights the page is filled from. Only valid inside a placeholder's ``spec:``,
#: which is the one place that is resolved with the entry in hand.
TARGET_ENTRY_TOKEN = "@target_entry"


def substitute_tokens(value: Any, replacements: dict[str, str]) -> Any:
    """Replace every token in *replacements* throughout *value*.

    Recurses into dicts and lists. Longer tokens are substituted first, which is
    not a micro-optimisation but the whole reason this takes a mapping at all:
    ``@target`` is a prefix of ``@target_entry``, so replacing it first would
    turn ``@target_entry`` into ``light.kitchen_entry``.
    """
    if isinstance(value, str):
        for token in sorted(replacements, key=len, reverse=True):
            value = value.replace(token, replacements[token])
        return value
    if isinstance(value, dict):
        return {k: substitute_tokens(v, replacements) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute_tokens(v, replacements) for v in value]
    return value


def _placeholder_spec(layout: dict, source_id: str) -> Any:
    """The ``spec:`` declared by the placeholder bound to *source_id*, if any.

    A source is fetched once per page, so two placeholders that narrow the same
    source differently cannot both be honoured — the first is used and the
    disagreement logged, rather than silently fetching one and binding the other.
    """
    found: Any = None
    for name, spec in (layout.get(PLACEHOLDERS_KEY) or {}).items():
        if not isinstance(spec, dict):
            continue
        if str(spec.get("source") or "").strip() != source_id:
            continue
        declared = spec.get("spec")
        if declared is None:
            continue
        if found is None:
            found = declared
        elif declared != found:
            _LOGGER.warning(
                "placeholder %r narrows source %r differently from an earlier "
                "placeholder; keeping %r", name, source_id, found,
            )
    return found


def spec_for_source(
    layout: dict,
    source_id: str,
    target_entity: str,
    domain_entities: dict[str, str] | None = None,
    target_config_entry: str = "",
) -> dict[str, Any]:
    """Build the spec a layout wants for *source_id*.

    A placeholder may narrow its source with ``spec:``; a string value is
    shorthand for ``{entity: ...}``. Missing ``entity`` falls back to the page
    target. ``@target_entry`` is valid only here because config-entry-mode
    layouts name an integration instance, not a target entity.
    """
    raw = _placeholder_spec(layout, source_id)
    if isinstance(raw, str):
        raw = {"entity": raw}
    spec = dict(raw) if isinstance(raw, dict) else {}
    spec = substitute_tokens(
        spec,
        {TARGET_TOKEN: target_entity, TARGET_ENTRY_TOKEN: target_config_entry},
    )

    source = get_source(source_id)
    if source is not None and "entity" in (source.param_schema or {}):
        if not spec.get("entity"):
            # Prefer a sibling of the required domain; a device-mode primary
            # entity may be a non-browsable ``remote.*``.
            sibling = ""
            if source.entity_domain:
                sibling = (domain_entities or {}).get(source.entity_domain, "")
            spec["entity"] = sibling or target_entity
    return spec


def field_value(item: DynamicItem, field: str) -> Any:
    """Value of a layout-button field, or ``None`` if unmapped.

    Initial resolution reads the token suffix; refresh reads ``field_map`` and
    falls back to the key. That keeps cross-mapped tokens stable.
    """
    attr = FIELD_MAP.get(field)
    if attr is None:
        return None
    value = getattr(item, attr, None)
    return dict(value) if isinstance(value, dict) else value


def _binding(
    source_id: str,
    index: int,
    spec: dict[str, Any],
    target_entity: str,
    fields: list[str],
    item: DynamicItem | None,
    *,
    stale: bool,
    error: str | None = None,
    field_map: dict[str, str] | None = None,
) -> dict[str, Any]:
    """The ``dynamic`` block stored beside the resolved snapshot."""
    binding: dict[str, Any] = {
        "source": source_id,
        "spec": dict(spec),
        "index": index + 1,  # stored 1-based, matching the token
        "fields": sorted(fields),
        "target_entity": target_entity,
        "identity": (item.identity or item.title) if item else "",
        "stale": bool(stale),
    }
    # Needed only for cross-mapped tokens such as
    # ``label: "@favorites[1].icon"``; default bindings keep their current shape.
    trimmed = {k: v for k, v in (field_map or {}).items() if v and v != k}
    if trimmed:
        binding["field_map"] = trimmed
    if error:
        binding["error"] = error
    return binding


async def resolve_layout_variables(
    hass: HomeAssistant,
    layout: dict,
    target_entity: str,
    domain_entities: dict[str, str] | None = None,
    target_config_entry: str = "",
) -> dict:
    """Resolve all ``@<source>[N]`` tokens in a layout's buttons.

    Mutates and returns *layout*. Missing items become blank buttons with a
    kept ``_dynamic`` binding so a later refresh can refill them.
    ``target_config_entry`` reaches source specs as ``@target_entry``.
    """
    buttons = layout.get("buttons") or {}
    overflow_defs = expand_placeholders(layout)
    needed = scan_requirements(buttons)
    if not needed:
        return layout

    resolved: dict[str, tuple[list[DynamicItem], str | None]] = {}
    specs: dict[str, dict[str, Any]] = {}

    for source_id, max_index in needed.items():
        spec = spec_for_source(
            layout, source_id, target_entity, domain_entities, target_config_entry,
        )
        specs[source_id] = spec
        result = await async_resolve_source(
            hass, source_id, spec, max_items=max(max_index, DEFAULT_MAX_ITEMS)
        )
        resolved[source_id] = (result.items, result.error)
        _LOGGER.debug(
            "Resolved %d items from %r for %s%s",
            len(result.items), source_id, target_entity,
            f" (error: {result.error})" if result.error else "",
        )

    for btn_key in list(buttons.keys()):
        btn_def = buttons[btn_key]
        tokens = button_tokens(btn_def)
        if not tokens:
            continue

        if "" in tokens:
            source_id, idx, _ = tokens[""]
            items, error = resolved.get(source_id, ([], "unresolved"))
            item = items[idx] if 0 <= idx < len(items) else None
            fields = ["label", "icon", "action", "data"]
            if item is not None:
                buttons[btn_key] = {
                    "label": item.title,
                    "icon": item.icon,
                    "action": item.action,
                    "data": dict(item.data),
                    DYNAMIC_KEY: _binding(
                        source_id, idx, specs.get(source_id, {}), target_entity,
                        fields, item, stale=bool(error), error=error,
                    ),
                }
            else:
                buttons[btn_key] = {
                    "label": "",
                    "action": "null",
                    DYNAMIC_KEY: _binding(
                        source_id, idx, specs.get(source_id, {}), target_entity,
                        fields, None, stale=True,
                        error=error or "index out of range",
                    ),
                }
            continue

        if not isinstance(btn_def, dict):
            continue

        out: dict[str, Any] = {}
        bound_fields: list[str] = []
        bound_item: DynamicItem | None = None
        # A binding names one item, chosen by the first token in author order so
        # adding or renaming fields does not move ownership.
        bound_source, bound_index, _ = next(iter(tokens.values()))
        owned_fields = [
            field
            for field, (source_id, idx, _f) in tokens.items()
            if (source_id, idx) == (bound_source, bound_index)
        ]
        if len(owned_fields) != len(tokens):
            # Mixed-item fields are substituted once but left out of refresh;
            # one bound item must not overwrite fields from another.
            _LOGGER.warning(
                "Layout button %r mixes dynamic items (%s); binding to %s[%d] "
                "and leaving %s static",
                btn_key,
                sorted({f"@{s}[{i + 1}]" for s, i, _f in tokens.values()}),
                bound_source, bound_index + 1,
                sorted(set(tokens) - set(owned_fields)),
            )
        missing = False
        error_text: str | None = None

        for field, val in btn_def.items():
            token = tokens.get(field)
            if token is None:
                out[field] = val
                continue
            source_id, idx, token_field = token
            items, error = resolved.get(source_id, ([], "unresolved"))
            item = items[idx] if 0 <= idx < len(items) else None
            if error:
                error_text = error
            if item is None:
                missing = True
                error_text = error_text or "index out of range"
                continue
            value = field_value(item, token_field or "")
            if value is None:
                missing = True
                error_text = error_text or f"unknown field '{token_field}'"
                continue
            out[field] = value
            if field in owned_fields:
                bound_item = item
                bound_fields.append(field)

        binding = _binding(
            bound_source, bound_index, specs.get(bound_source, {}), target_entity,
            bound_fields or owned_fields, bound_item,
            stale=missing or bool(error_text), error=error_text,
            field_map={
                f: (tokens[f][2] or "")
                for f in (bound_fields or owned_fields)
                if f in tokens
            },
        )

        if missing:
            # Static fields survive missing items so a later refill still has
            # the layout-owned action/slider context.
            statics = {k: v for k, v in btn_def.items() if k not in tokens}
            buttons[btn_key] = {
                **statics,
                "label": "",
                "action": statics.get("action") or "null",
                DYNAMIC_KEY: binding,
            }
        else:
            out[DYNAMIC_KEY] = binding
            buttons[btn_key] = out

    _apply_overflow(buttons, overflow_defs)
    return layout


#: Binding keys a layout already states, and so need not be stored beside each
#: generated button. Everything outside this set — the resolved item, whether it
#: is stale, why — is what a refresh actually found, and only disk knows it.
LAYOUT_STATED_KEYS = ("source", "spec", "index", "fields", "target_entity")


def layout_bindings(
    layout: dict,
    target_entity: str,
    target_config_entry: str = "",
) -> dict[str, dict[str, Any]]:
    """What each bound button's binding would be, read back off the layout.

    A generated page stored its source, spec and tracked-field list beside every
    button, then again at page level once those were hoisted — all of it a
    transcript of what ``@lamp[3]`` in the layout already says. This recovers
    that half from the layout, so a page file can carry only what a refresh
    discovered.

    Derivation is deliberately registry-free, unlike page creation, which can
    fall back to a sibling entity of the target's device. A layout that needs
    that fallback will derive a spec differing from the stored one; the caller
    compares before dropping anything, so such a page simply keeps its spec on
    disk instead of being quietly given the wrong one. No shipped layout does
    this today, which is exactly why it would otherwise go unnoticed.

    *layout* is not mutated.
    """
    layout = deepcopy(layout)
    buttons = layout.get("buttons")
    if not isinstance(buttons, dict):
        return {}
    expand_placeholders(layout)

    specs: dict[str, dict[str, Any]] = {}
    derived: dict[str, dict[str, Any]] = {}

    for btn_key, btn_def in buttons.items():
        tokens = button_tokens(btn_def)
        if not tokens:
            continue
        if "" in tokens:
            source_id, index, _ = tokens[""]
            fields = list(BOUND_FIELDS)
        else:
            # The first token in author order owns the binding, matching how
            # `resolve_layout_variables` picks; fields bound to a *different*
            # item are substituted once and never refreshed, so they are not
            # part of this binding either.
            source_id, index, _ = next(iter(tokens.values()))
            fields = [
                field for field, (src, idx, _f) in tokens.items()
                if (src, idx) == (source_id, index)
            ]
        if source_id not in specs:
            specs[source_id] = spec_for_source(
                layout, source_id, target_entity, None, target_config_entry,
            )
        derived[btn_key] = {
            "source": source_id,
            "spec": deepcopy(specs[source_id]),
            "index": index + 1,  # stored 1-based, matching the token
            "fields": sorted(fields),
            "target_entity": target_entity,
        }
    return derived


async def resolve_binding(
    hass: HomeAssistant,
    binding: dict[str, Any],
) -> BindingResolution:
    """Re-resolve one stored ``dynamic`` binding.

    ``item is None`` means the index no longer exists; ``error`` means the
    source could not be read. Removed favorites should blank buttons;
    unreachable speakers should keep last-known content. Empty source answers
    are successful resolves, not errors.
    """
    source_id = binding.get("source") or ""
    index = int(binding.get("index") or 0) - 1
    spec = binding.get("spec")
    if not isinstance(spec, dict):
        spec = {}
    if not source_id or index < 0:
        return BindingResolution(None, "invalid binding")

    result = await async_resolve_source(
        hass, source_id, spec, max_items=max(index + 1, DEFAULT_MAX_ITEMS)
    )
    item = result.items[index] if index < len(result.items) else None
    return BindingResolution(item, result.error)
