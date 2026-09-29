"""The catalogue of internal commands and the questions asked of it.

Every consumer — service registration, device sync, the panel, labels — comes
through here rather than importing a command module directly, so a command is
added or withdrawn in one place. What a command *does* stays in its own module;
what leaks in here is the ``target_params`` vocabulary, because
:func:`pinned_page_ids` has to answer for every command at once.
"""
from __future__ import annotations

import logging
from typing import Any

from ...const import substitute_label_tokens
from ...device.protocol import is_valid_page_id
from .base import InternalCommand, InternalCommandError
from .goto_page import GOTO_PAGE, coerce_page_id

_LOGGER = logging.getLogger(__name__)



#: Every declared internal command, keyed by full service name.
INTERNAL_COMMANDS: dict[str, InternalCommand] = {
    cmd.full_service: cmd for cmd in (GOTO_PAGE,)
}


def get_internal_command(service: str | None) -> InternalCommand | None:
    """Return the enabled command *service* names, or ``None``.

    Matching is exact on the full ``lizaip.<command>`` name. A substring match
    would claim any third-party service that happens to contain the word.
    """
    if not service:
        return None
    cmd = INTERNAL_COMMANDS.get(service)
    return cmd if cmd is not None and cmd.enabled else None


def is_internal_command(service: str | None) -> bool:
    """True when *service* is a device-local command rather than an HA call."""
    return get_internal_command(service) is not None


def enabled_commands() -> list[InternalCommand]:
    """Every command that should be registered as a service."""
    return [cmd for cmd in INTERNAL_COMMANDS.values() if cmd.enabled]


def panel_descriptors() -> list[dict]:
    """The registry as the admin panel sees it.

    Commands are assigned through Home Assistant's own action editor, so this
    builds no picker. The panel still needs the registry to *recognise* a
    command in a stored button — to name it after the page it opens and give it
    an icon — which is why every enabled command is listed.
    """
    return [
        {
            "service": cmd.full_service,
            "name": cmd.name,
            "icon": cmd.icon,
            "label_template": cmd.label_template,
            "target_params": [dict(p) for p in cmd.target_params],
        }
        for cmd in enabled_commands()
    ]


def pinned_page_ids(data: Any, service: str | None = None) -> set[int]:
    """Page ids pinned by number, which must not be recycled.

    ``is_available`` cannot catch a recycled id because it exists again and the
    button would open the wrong page. Named targets follow the name and do not
    pin an id.

    A *service* that is not an enabled internal command pins nothing, even if
    its payload happens to carry a ``page_id``: a third-party action's data is
    its own business, and a withdrawn command is treated as unknown everywhere
    else too. Only a caller that names no service at all falls back to asking
    every enabled command, which over-reserves rather than under-reserves.
    """
    if service:
        cmd = get_internal_command(service)
        if cmd is None:
            return set()
        commands = [cmd]
    else:
        commands = enabled_commands()
    payload = data if isinstance(data, dict) else {}
    ids: set[int] = set()
    for command in commands:
        for param in command.target_params:
            if param.get("type") != "page_id":
                continue
            raw = coerce_page_id(payload.get(param["key"]))
            if is_valid_page_id(raw):
                ids.add(raw)
    return ids


def resolve_action(
    service: str | None,
    data: Any,
    context: dict | None = None,
) -> tuple[str, dict] | None:
    """Translate a stored step into protocol action, or disarm safely.

    ``None`` means this is not an internal command. ``("ha_event", {})`` means
    it is internal but invalid or unavailable. Disarming beats guessing: a
    remote jumping to the wrong page is worse than a no-op button.
    """
    cmd = get_internal_command(service)
    if cmd is None:
        return None

    ctx = context or {}
    try:
        params = cmd.build_params(data, ctx)
    except InternalCommandError as err:
        _LOGGER.warning(
            "Disarming button: %s cannot be executed (%s)", cmd.full_service, err
        )
        return "ha_event", {}

    if cmd.is_available is not None and not cmd.is_available(params, ctx):
        _LOGGER.warning(
            "Disarming button: %s target no longer exists (%s)",
            cmd.full_service,
            params,
        )
        return "ha_event", {}

    return cmd.action_type, params


def command_target_name(
    service: str | None,
    data: Any,
    context: dict | None = None,
    fallback: str = "",
) -> str:
    """What a command points at, for auto labels and user ``${NAME}`` labels.

    One resolution path keeps custom and default labels from naming different
    pages. Missing targets echo the stored name or saved fallback so broken
    buttons say what they tried to open. Resolvable targets follow renames.
    """
    cmd = get_internal_command(service)
    if cmd is None or cmd.build_label is None:
        return ""
    ctx = context or {}
    try:
        params = cmd.build_params(data, ctx)
    except InternalCommandError:
        # What the user wrote in the step beats a remembered name: it is the
        # target they asked for, and the two only differ if the step was
        # hand-edited afterwards.
        return _stored_target_name(cmd, data) or fallback
    if cmd.is_available is not None and not cmd.is_available(params, ctx):
        return fallback or cmd.build_label(params, ctx)
    return cmd.build_label(params, ctx)


def command_label(
    service: str | None,
    data: Any,
    context: dict | None = None,
    fallback: str = "",
) -> str:
    """Auto label for a button carrying an internal command, ``""`` if none.

    Reads as the command's ``label_template`` says — "Go to page: Living Room"
    by default. Only a step naming no target at all falls back to the bare
    command name, where the template would just repeat it.
    """
    cmd = get_internal_command(service)
    if cmd is None or cmd.build_label is None:
        return ""
    target = command_target_name(service, data, context, fallback)
    return _prefixed(cmd, target) or cmd.name


def _prefixed(cmd: InternalCommand, target: str) -> str:
    """The command's label template, filled in; ``""`` without a target.

    Wording lives on the registry entry so command-specific labels stay with
    the command. ``${COMMAND}`` means renaming the registry entry renames its
    buttons too.
    """
    if not target:
        return ""
    return substitute_label_tokens(
        cmd.label_template, {"command": cmd.name, "name": target}
    )


def _stored_target_name(cmd: InternalCommand, data: Any) -> str:
    """The target a step names in the user's own words, ``""`` if it has none.

    Any target param whose stored value is text counts, rather than one blessed
    type: this is the fallback used when a payload no longer resolves, and the
    point is to echo back whatever the user actually wrote.
    """
    payload = data if isinstance(data, dict) else {}
    for param in cmd.target_params:
        value = payload.get(param["key"])
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""
