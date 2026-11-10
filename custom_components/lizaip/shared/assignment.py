"""Keys and small helpers for a stored button assignment."""

from __future__ import annotations

from typing import Final

# Key on a stored button assignment holding its dynamic-source binding. It is a
# *sibling* of ``config``, not a field inside it: the panel truncates a button's
# ``config`` list to its first step on every edit, so anything stored in there
# that the panel does not know about would be lost.
ASSIGNMENT_DYNAMIC_KEY: Final = "dynamic"


# Key on a stored button assignment marking its label as one the user typed.
#
# It lives beside ``ASSIGNMENT_DYNAMIC_KEY``, and for the same reason: the panel
# writes it and the tooltip ladders read it. Stored only when true — absence is
# how "nobody has named this button, keep deriving" is spelled, matching every
# other optional field in the assignment schema.
ASSIGNMENT_TOOLTIP_EDITED_KEY: Final = "tooltip_edited"


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


# ``key_repeat: true`` on a stored button: holding it runs its action again and
# again (key repeat), at the delay and rate the remote's settings name,
# like a TV remote's cursor keys. Absent or anything else: a held button runs
# once.
ASSIGNMENT_REPEAT_KEY: Final = "key_repeat"


def key_repeats(assign) -> bool:
    """Whether a stored button runs again while it is held."""
    return isinstance(assign, dict) and assign.get(ASSIGNMENT_REPEAT_KEY) is True


def longtouch_steps(assign) -> list:
    """The long-touch steps of a stored button, or ``[]`` when it has none."""
    steps = assign.get(ASSIGNMENT_LONGTOUCH_KEY) if isinstance(assign, dict) else None
    return steps if isinstance(steps, list) and steps else []


def name_is_user_written(assign) -> bool:
    """True when the user typed this button's name into the panel's Label field.

    The ladders used to *infer* this by comparing the stored name against its
    action-library entry's: equal meant auto-filled, different meant typed. That
    guess is wrong for every template button, because ``generate_assignments``
    stores the template's name and mints the library entry from the same string —
    so a template's ``Mute`` button looked auto-filled and announced its next
    action ("Unmute") even when the user had typed "Mute" on purpose.

    A recorded fact replaces the guess: a typed name is printed as it reads,
    and the ladders derive a label only for a button nobody has named.
    """
    if not isinstance(assign, dict):
        return False
    return bool(assign.get(ASSIGNMENT_TOOLTIP_EDITED_KEY))
