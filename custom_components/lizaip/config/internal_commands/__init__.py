"""Device-local ("internal") lizaIP commands.

PROTOCOL.md §5 lets a button declare an ``action.type`` that firmware executes
locally, with no network round trip. These are modelled as real Home Assistant
services because the store, action library, layout YAML, automations and action
editor already speak service calls.

One declaration feeds service registration, device-sync translation, panel
shortcuts and labels/icons. Device-local actions normally emit no ``button``
event, so they do not double-execute through :mod:`.action_controller` — which
is why this lives under ``config`` and not there: a ``goto_page`` step is
configuration written into the layout the device is given, never an event the
host dispatches.

The package is split by subject rather than by layer: :mod:`.base` is the shape
a command is declared in, :mod:`.registry` is the catalogue and the questions
asked of it, and each remaining module *is* one command, owning the payload
rules and vocabulary only that command has. The names below are the public
surface; which file a name lives in is this package's business.
"""
from __future__ import annotations

from .base import InternalCommand, InternalCommandError
from .goto_page import GOTO_PAGE, build_page_context, page_label, page_title
from .registry import (
    INTERNAL_COMMANDS,
    command_label,
    command_target_name,
    enabled_commands,
    get_internal_command,
    is_internal_command,
    panel_descriptors,
    pinned_page_ids,
    resolve_action,
)

__all__ = [
    "GOTO_PAGE",
    "INTERNAL_COMMANDS",
    "InternalCommand",
    "InternalCommandError",
    "build_page_context",
    "command_label",
    "command_target_name",
    "enabled_commands",
    "get_internal_command",
    "is_internal_command",
    "page_label",
    "page_title",
    "panel_descriptors",
    "pinned_page_ids",
    "resolve_action",
]
