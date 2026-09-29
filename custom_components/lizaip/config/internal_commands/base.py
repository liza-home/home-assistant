"""The framework every internal command is described in.

The command *declarations* live next door, one module each; this file holds
only what they have in common, so adding a command means adding a file rather
than editing a shared one.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ...const import DOMAIN


class InternalCommandError(ValueError):
    """Payload validation failed, with a translation key for service errors."""

    def __init__(
        self,
        message: str,
        translation_key: str,
        placeholders: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.translation_key = translation_key
        self.translation_placeholders = placeholders or {}


@dataclass(frozen=True)
class InternalCommand:
    """One device-local command, described once for every consumer.

    Attributes:
        service: Bare service name; the full name is ``lizaip.<service>``.
        action_type: The protocol ``action.type`` the firmware understands.
        icon: Default icon for a button carrying this command.
        name: English label, mirrored by ``strings.json``.
        build_params: ``(data, context) -> params`` — validates a stored step's
            payload into protocol parameters, or raises
            :class:`InternalCommandError`. *context* (see
            :func:`build_page_context`) is how a symbolic target such as a page
            name becomes a number.
        run: ``(connection, params)`` — performs the command on a connected
            device.
        schema: Voluptuous schema for the HA service call. Deliberately
            permissive: range and shape checks belong to ``build_params``, which
            reports them translated rather than as a raw ``vol.Invalid``.
        build_label: ``(params, context) -> str`` — names the command's *target*
            so an entity-less command still reads as something. Returns the
            target alone; ``label_template`` decides the wording.
        label_template: Token string auto-labelling a button carrying this
            command. ``${NAME}`` is what ``build_label`` returned, ``${COMMAND}``
            is this entry's ``name``, so renaming the command renames its
            buttons. Declared here so the wording belongs to the command.
            ``${NAME}`` is offered in the user's own label field too, and only
            for commands that have a ``build_label`` to fill it.
        is_available: ``(params, context) -> bool`` — False when the target no
            longer exists, disarming the button instead of sending the remote
            somewhere wrong. Unset for commands with no referenced target.
        target_params: Which payload keys name the target, as ``{key, type}``
            entries. The panel reads them to tell whether a stored button still
            points at something that exists, whatever the generic action editor
            wrote.
        enabled: A disabled entry stays declared but is treated as unknown, so a
            command can be withdrawn without deleting its history."""

    service: str
    action_type: str
    icon: str
    name: str
    build_params: Callable[[Any, dict], dict]
    run: Callable[[Any, dict], Awaitable[Any]]
    schema: Any
    build_label: Callable[[dict, dict], str] | None = None
    label_template: str = "${COMMAND}: ${NAME}"
    is_available: Callable[[dict, dict], bool] | None = None
    target_params: tuple[dict, ...] = ()
    enabled: bool = True

    @property
    def full_service(self) -> str:
        """The service name as it is stored in a button's step."""
        return f"{DOMAIN}.{self.service}"
