"""Keys and small helpers for a stored button assignment."""

from __future__ import annotations

from typing import Final

# Key on a stored button assignment holding its dynamic-source binding. It is a
# *sibling* of ``config``, not a field inside it: the panel truncates a button's
# ``config`` list to its first step on every edit, so anything stored in there
# that the panel does not know about would be lost.
ASSIGNMENT_DYNAMIC_KEY: Final = "dynamic"


def name_is_source_owned(assign) -> bool:
    """True when a dynamic source, not the user, wrote this button's name.

    The tooltip ladders treat a stored name as the user's own words and return
    it verbatim — the whole point being that a typed label is never overwritten
    by a derived one. A name a source generated is not that: it names the
    button's *subject* (a lamp, a favorite), not what the button should print.

    Knowing the difference is what lets a bound toggle read "Hall Off" instead
    of a bare "Hall": the label is a subject the state belongs next to, and the
    ladder is allowed to add it.
    """
    if not isinstance(assign, dict):
        return False
    binding = assign.get(ASSIGNMENT_DYNAMIC_KEY)
    if not isinstance(binding, dict):
        return False
    fields = binding.get("fields")
    return isinstance(fields, list) and "label" in fields


# Key on a stored button assignment marking its label as one the user typed.
#
# It lives beside ``ASSIGNMENT_DYNAMIC_KEY``, and for the same reason: the panel
# writes it and the tooltip ladders read it. Stored only when true — absence is
# how "nobody has named this button, keep deriving" is spelled, matching every
# other optional field in the assignment schema.
ASSIGNMENT_LABEL_EDITED_KEY: Final = "label_edited"


# The name a device-local command's target had when the button was saved.
#
# Beside the step, not inside it: the step stores a page *id*, and a second
# target field in the step would have to keep agreeing with that id — a rename
# would then trip `conflicting_page_target` and disarm a working button. Held
# out here it can go stale harmlessly, because it is only ever read once the
# real target no longer resolves, to say "Go to page: Kitchen" instead of the
# id the user never chose and cannot act on.
ASSIGNMENT_INTERNAL_TARGET_NAME_KEY: Final = "internal_target_name"


# The steps a button runs when the finger stays on it for
# ``LONGTOUCH_SECONDS``. Same shape as ``config`` (a list holding one step),
# beside it rather than inside it because the panel keeps only ``config[0]``.
# Absent or empty: the button has no long touch, and its click runs on press.
ASSIGNMENT_LONGTOUCH_KEY: Final = "longtouch"

#: How long a finger must rest on a button before its long touch runs.
LONGTOUCH_SECONDS: Final = 2.0


def longtouch_steps(assign) -> list:
    """The long-touch steps of a stored button, or ``[]`` when it has none."""
    steps = assign.get(ASSIGNMENT_LONGTOUCH_KEY) if isinstance(assign, dict) else None
    return steps if isinstance(steps, list) and steps else []


def name_is_user_written(assign) -> bool:
    """True when the user typed this button's name into the panel's Label field.

    The ladders used to *infer* this by comparing the stored name against its
    action-library entry's: equal meant auto-filled, different meant typed. That
    guess is wrong for every layout button, because ``generate_assignments``
    stores the layout's name and mints the library entry from the same string —
    so an Android TV ``CH+`` looked auto-filled, fell to the static rung and was
    printed as "Wohnzimmer CH+". Deleting the room name in the panel then stored
    what was already stored, and the prefix came straight back.

    A recorded fact replaces the guess. The entity prefix stays the default for
    a button nobody has named, and becomes removable — permanently — for one
    somebody has.
    """
    if not isinstance(assign, dict):
        return False
    return bool(assign.get(ASSIGNMENT_LABEL_EDITED_KEY))
