"""``${_state}`` and ``${_name}`` placeholders in button tooltips."""

from __future__ import annotations

import re
from typing import Any, Final

from .i18n import button_tooltips, state_words
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
TOOLTIP_TOKEN_RE = re.compile(r"\$\{\s*(\w*)\s*\}")

#: Characters that only ever join two halves of a label, never name anything
#: by themselves. Decides whether a label is nothing but placeholders, and
#: strips a separator left dangling by one (:data:`DANGLING_SEPARATOR_RE`).
SEPARATOR_CHARS: Final = r"\s:;,/\-–—"

_SEPARATORS_ONLY_RE = re.compile(rf"[{SEPARATOR_CHARS}]+")
_TRANSLATE_OPEN_RE = re.compile(r"\{\s*translate\s*:", re.IGNORECASE)

# The spelling the panel writes into a label it fills in for the user: the
# state, in the remote's language. A bare ``${_state}`` reads the same.
STATE_TOOLTIP: Final = "{translate: ${_state}}"

#: ``{translate: ${_state}}`` in any spelling.
TRANSLATE_STATE_RE = re.compile(
    r"\{\s*translate\s*:\s*\$\{\s*_state\s*\}\s*\}", re.IGNORECASE,
)

#: The state placeholder in either spelling, ``{translate: ${_state}}`` or a
#: bare ``${_state}``. See :func:`translate_state`.
STATE_PLACEHOLDER_RE = re.compile(
    TRANSLATE_STATE_RE.pattern + r"|\$\{\s*_state\s*\}", re.IGNORECASE,
)
_LEADING_SEPARATORS_RE = re.compile(rf"[{SEPARATOR_CHARS}]*")

# Out of ``TOOLTIP_TOKEN_RE`` because its ``\w`` excludes the dot, and widening
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

def is_token_only_tooltip(text: str) -> bool:
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
    too, though their dot keeps them out of :data:`TOOLTIP_TOKEN_RE`.

    This decides tooltips only — :func:`is_token_only_tooltip` is called from the
    label ladders in ``button_rendering.py`` and ``icons.py`` and from nowhere
    else. A page title is never classified, so what ``${_device.x}`` means
    there is untouched.
    """
    if not text or "${" not in text:
        return False
    # Leftover braces are wreckage, not words: "${_state}}" is still a shape,
    # and so is "{translate: ${_state}}".
    stripped = DOTTED_TOKEN_RE.sub("", TOOLTIP_TOKEN_RE.sub("", text))
    remainder = _TRANSLATE_OPEN_RE.sub("", stripped).replace("{", "").replace("}", "")
    return not _SEPARATORS_ONLY_RE.sub("", remainder).strip()


def state_word(action_key: str, lang: str) -> str:
    """The word for the state a press produces, as it reads in a sentence.

    Lowercase ("off", "mute"), unless the language's ``state_words`` spells it
    otherwise -- German nouns stay capitalised ("Pause").
    """
    return state_words.load(lang).get(action_key) or button_tooltips.get(action_key, lang).lower()


def state_label(action_key: str, lang: str, opens_label: bool) -> str:
    """The state's word where it stands: capitalised as a label when it opens
    one ("Aus", "Off — Lamp"), the sentence word inside one ("Lampe aus")."""
    return button_tooltips.get(action_key, lang) if opens_label else state_word(action_key, lang)


def translate_state(text: str, key: str, lang: str) -> str:
    """*text* with each state placeholder replaced by the word for *key*.

    Both spellings, ``${_state}`` and ``{translate: ${_state}}``, read the same.
    """
    if "${" not in text:
        return text

    def _word(match: re.Match) -> str:
        if not key:
            # Left for the token pass, which also drops the separator it joined.
            return "${_state}"
        opens = _LEADING_SEPARATORS_RE.fullmatch(text[: match.start()].lstrip().removeprefix("text:")) is not None
        return state_label(key, lang, opens)

    return STATE_PLACEHOLDER_RE.sub(_word, text)


def state_token_tooltip(
    svc: str,
    current_state: str,
    lang: str,
    attributes: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
) -> str:
    """The word a label made of the state placeholder prints for this press, or ""."""
    key = state_token_key(svc, current_state, attributes, data)
    return state_label(key, lang, True) if key else ""


def state_token_key(
    svc: str,
    current_state: str,
    attributes: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
) -> str:
    """The key of the state a button press produces ("off"), or "" when none.

    The state placeholder prints its word (:func:`state_label`).

    The *service* decides first: pressing a ``turn_on`` button always reads
    "On", even when the entity is already on, because that is what the press
    does. Only genuinely two-way services (``toggle``, ``media_play_pause``)
    have no answer of their own and fall back to the entity's current state.

    Two rungs sit above that, for the services whose direction is *not* in
    their name. ``volume_mute`` is a setter — it writes the
    ``is_volume_muted`` value it is handed — so its answer is either in the
    step's own ``data`` or in the attribute it inverts, never in the service
    name and never in ``state.state`` (a muted speaker is still ``playing``).
    Reading the attribute before ``SERVICE_ACTION_MAP`` is not a breach of the
    action-first rule: that rule exists because ``turn_on`` names its own
    direction, and a setter does not.

    Both rungs are gated on ``ATTR_ACTION_CYCLES`` as an allowlist — see the
    comment there for what the gate keeps out. Everything below them is
    unchanged, so a service the gate rejects, or an entity whose attribute
    cannot be read, still gets the answer it got before.

    *attributes* is the target entity's attribute dict. *data* is the step's
    service data and is passed **only for a cycle press**, which is the one
    place a stored direction is the user's choice rather than the value the
    setter's form demands; a button's own action toggles instead.
    """
    attribute = service_to_attribute(svc)
    cycle = attribute_cycle_for(svc)
    if cycle:
        # The step names a literal value, so this face has one direction
        # whatever the entity is doing: `is_volume_muted: true` is the mute
        # press. `data` is only passed when the stored value is what runs.
        if isinstance(data, dict):
            target = ATTR_VALUE_ACTION_MAP.get(attribute, {}).get(
                attr_str(data.get(attribute, ""))
            )
            if target:
                return target
        # Otherwise the entity's current value names the next one, the same way
        # `attribute_icons:` already picks the icon for this button.
        if isinstance(attributes, dict):
            next_key = cycle.get(attr_str(attributes.get(attribute, "")))
            if next_key:
                return next_key

    if svc in SERVICE_ACTION_MAP:
        return SERVICE_ACTION_MAP[svc]
    if is_state_toggle_service(svc) and current_state:
        next_key = NEXT_STATE_MAP.get(current_state)
        if next_key:
            return next_key
    return ""


#: Punctuation that only joins two halves of a label ("Go to page: Android").
#: When a placeholder between or beside such a mark resolves to nothing, the
#: mark is left joining nothing — a goto whose page was deleted printed a
#: dangling "Go to page:" on the device. Stripped only on a label that *held* a
#: placeholder, so a name the user genuinely ended in a colon is left alone.
DANGLING_SEPARATOR_RE = re.compile(rf"^[{SEPARATOR_CHARS}]+|[{SEPARATOR_CHARS}]+$")
