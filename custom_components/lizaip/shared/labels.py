"""``${_state}`` and ``${_name}`` placeholders in button labels."""

from __future__ import annotations

import re
from typing import Any, Final

from .i18n import action_labels
from .services import (
    ATTR_VALUE_ACTION_MAP,
    NEXT_STATE_MAP,
    SERVICE_ACTION_MAP,
    attr_str,
    attribute_cycle_for,
    is_state_toggle_service,
    service_to_attribute,
)

# ---------------------------------------------------------------------------
# ``${_state}`` placeholders in user-typed button labels
# ---------------------------------------------------------------------------

# ``\w*`` and not ``\w+``: an empty or blank token (``${}``, ``${ }``) must also
# be consumed. Anything left behind would reach ``resolve_icon_url("text:…")``
# and put a brace into the imgserv URL.
LABEL_TOKEN_RE = re.compile(r"\$\{\s*(\w*)\s*\}")

#: Characters that only ever join two halves of a label, never name anything
#: by themselves. Decides whether a label is nothing but placeholders, and
#: strips a separator left dangling by one (:data:`DANGLING_SEPARATOR_RE`).
SEPARATOR_CHARS: Final = r"\s:;,/\-–—"

_SEPARATORS_ONLY_RE = re.compile(rf"[{SEPARATOR_CHARS}]+")

# The spelling the panel writes into a label it fills in for the user.
STATE_TOKEN: Final = "${_state}"

# Out of ``LABEL_TOKEN_RE`` because its ``\w`` excludes the dot, and widening
# that would swallow ``${media_player.kitchen.volume_level}``. Named rather
# than a general ``_namespace.key``, which would strip real entity variables.
DOTTED_TOKEN_RE = re.compile(
    r"\$\{\s*((?:_queue|_device)\.[A-Za-z0-9_]+)\s*\}", re.IGNORECASE,
)

# The target of a device-local command, named in the user's label. Scoped to
# those commands on purpose: a plain HA action has no "target" distinct from
# its entity, so the token resolves to nothing there and collapses away, the
# same as any name this substituter does not know.
NAME_TOKEN: Final = "${_name}"

def is_token_only_label(text: str) -> bool:
    """True when *text* is nothing but placeholders — no words of its own.

    Such a label is a shape, not a name: ``"${_state}"`` says "print the state
    here" and names nothing by itself. The live tooltip therefore never hands
    one out as a static fallback (a brace would reach the imgserv URL), and the
    panel offers the derived ``${_state}`` in place of an auto-filled name only
    when it is a shape.

    A separator between two placeholders is part of the shape, not a word:
    ``"${_state} - ${_device.media_title}"`` is as unnamed as ``"${_state}"``,
    and the dash only has something to join once both tokens resolve.

    ``${_queue.next_song}`` and ``${_device.media_title}`` count as placeholders
    too, though their dot keeps them out of :data:`LABEL_TOKEN_RE`.

    This decides tooltips only — :func:`is_token_only_label` is called from the
    label ladders in ``button_rendering.py`` and ``icons.py`` and from nowhere
    else. A page title is never classified, so what ``${_device.x}`` means
    there is untouched.
    """
    if not text or "${" not in text:
        return False
    # Leftover braces are wreckage, not words: "${_state}}" is still a shape.
    stripped = DOTTED_TOKEN_RE.sub("", LABEL_TOKEN_RE.sub("", text))
    remainder = stripped.replace("{", "").replace("}", "")
    return not _SEPARATORS_ONLY_RE.sub("", remainder).strip()


def state_token_label(
    svc: str,
    current_state: str,
    lang: str,
    attributes: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
) -> str:
    """Name the state a button press produces, or "" when it produces none.

    The *service* decides first: pressing a ``turn_on`` button always reads
    "On", even when the entity is already on, because that is what the press
    does. Only genuinely two-way services (``toggle``, ``media_play_pause``)
    have no answer of their own and fall back to the entity's current state.

    Two rungs sit above that, for the services whose direction is *not* in
    their name. ``volume_mute`` is a setter — it writes the
    ``is_volume_muted`` value it is handed — so its answer is either in the
    button's own ``data`` or in the attribute it inverts, never in the service
    name and never in ``state.state`` (a muted speaker is still ``playing``).
    Reading the attribute before ``SERVICE_ACTION_MAP`` is not a breach of the
    action-first rule: that rule exists because ``turn_on`` names its own
    direction, and a setter does not.

    Both rungs are gated on ``ATTR_ACTION_CYCLES`` as an allowlist — see the
    comment there for what the gate keeps out. Everything below them is
    unchanged, so a service the gate rejects, or an entity whose attribute
    cannot be read, still gets the answer it got before.

    *attributes* is the target entity's attribute dict, *data* the first config
    step's service data. Both default to ``None`` so the old three-argument
    call keeps working.
    """
    attribute = service_to_attribute(svc)
    cycle = attribute_cycle_for(svc)
    if cycle:
        # The step names a literal value for the attribute, so the button has
        # one direction regardless of the entity: `is_volume_muted: true` is a
        # mute button. A template (`{{ not is_state_attr(...) }}`, which is how
        # a template turns the setter into a toggle) is not a value of the
        # attribute, so it misses here and falls to the rung below — which is
        # exactly where an inverting button belongs.
        if isinstance(data, dict):
            target = ATTR_VALUE_ACTION_MAP.get(attribute, {}).get(
                attr_str(data.get(attribute, ""))
            )
            if target:
                return action_labels.get(target, lang)
        # Otherwise the entity's current value names the next one, the same way
        # `attribute_icons:` already picks the icon for this button.
        if isinstance(attributes, dict):
            next_key = cycle.get(attr_str(attributes.get(attribute, "")))
            if next_key:
                return action_labels.get(next_key, lang)

    if svc in SERVICE_ACTION_MAP:
        return action_labels.get(SERVICE_ACTION_MAP[svc], lang)
    if is_state_toggle_service(svc) and current_state:
        next_key = NEXT_STATE_MAP.get(current_state)
        if next_key:
            return action_labels.get(next_key, lang)
    return ""


#: Punctuation that only joins two halves of a label ("Go to page: Android").
#: When a placeholder between or beside such a mark resolves to nothing, the
#: mark is left joining nothing — a goto whose page was deleted printed a
#: dangling "Go to page:" on the device. Stripped only on a label that *held* a
#: placeholder, so a name the user genuinely ended in a colon is left alone.
DANGLING_SEPARATOR_RE = re.compile(rf"^[{SEPARATOR_CHARS}]+|[{SEPARATOR_CHARS}]+$")
