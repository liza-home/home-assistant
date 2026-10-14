"""``${_state}`` / ``${_name}`` placeholders in user-typed button labels."""

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

# The spelling the panel writes into a label it fills in for the user.
STATE_TOKEN: Final = "${_state}"

# The target of a device-local command, named in the user's label. Scoped to
# those commands on purpose: a plain HA action has no "target" distinct from
# its entity, so the token resolves to nothing there and collapses away, the
# same as any name this substituter does not know.
NAME_TOKEN: Final = "${_name}"

def is_token_only_label(text: str) -> bool:
    """True when *text* is nothing but placeholders — no words of its own.

    Such a label is a shape, not a name: ``"${_state}"`` says "print the state
    here" and leaves the button unnamed. The tooltip ladder therefore treats it
    like a short static name (``"Next"``) and puts the entity in front of it,
    rather than like a label the user typed, which is returned verbatim.

    That is what keeps a two-way button's stored label the same shape as its
    neighbours: ``Previous`` / ``${_state}`` / ``Next``, all three of which the
    device renders behind the room name.
    """
    if not text or "${" not in text:
        return False
    # Leftover braces are wreckage, not words: "${_state}}" is still a shape, and
    # counting the stray brace as a name cost the label its entity prefix -- the
    # tooltip read "Off" instead of "Schreibtischlampe Off".
    return not LABEL_TOKEN_RE.sub("", text).replace("{", "").replace("}", "").strip()


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
        # a layout turns the setter into a toggle) is not a value of the
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
DANGLING_SEPARATOR_RE = re.compile(r"^[\s:;,/\-–—]+|[\s:;,/\-–—]+$")
