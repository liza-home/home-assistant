"""Steps added around a button action: the wake prelude and launch verification."""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Final

# ---------------------------------------------------------------------------
# Wake prelude ("ensure on")
# ---------------------------------------------------------------------------
#
# `action_controller` infers this prelude at press time and is the only caller,
# but the builder lives here because `config` may import `action_controller` and
# never the reverse: anything both sides might need has to sit below both.

# States that mean "not ready yet". Readiness is the *absence* of these rather
# than ``== "on"``: climate reports ``heat``/``cool`` and cover reports ``open``,
# so waiting for a literal "on" would burn the whole timeout on those domains.
NOT_READY_STATES: tuple[str, ...] = ("off", "unavailable", "unknown")

ENSURE_ON_TIMEOUT: Final = "00:00:20"

# Settle time after the wake gate opens. The wait_template only proves the
# target reported *power*: androidtv_remote flips state within a second of the
# POWER keycode, but the box needs roughly ten more before it can service an
# app-link intent. Sized for that worst case — it only runs inside the
# `state == off` branch, so an already-awake device pays nothing.
#
# Deliberately a fixed constant with no per-template or per-button override. It is
# sized for the slowest known target, and a tunable version failed silently:
# a value set too low looks like it works right up until the one press that
# needed the full ten seconds.
ENSURE_ON_SETTLE: Final = 10.0


def build_ensure_on_prelude(entity_id: str, settle: float) -> list[dict]:
    """Build script steps that wake *entity_id* before a button's own action.

    Guarded on the target being ``off``, so a device that is already awake pays
    no latency at all — the common case is unchanged. ``unavailable`` is
    deliberately *not* a trigger: ``turn_on`` cannot revive an unreachable
    device, and firing anyway would stall every press for the full timeout.

    The wake goes through ``homeassistant.turn_on`` rather than a domain-specific
    ``<domain>.turn_on``. HA's own handler
    (``components/homeassistant/__init__.py::async_handle_turn_service``) groups
    the targeted entities by domain, asks
    ``hass.services.has_service(domain, "turn_on")``, and warns about and skips
    anything unsupported — exactly the check a hand-maintained frozenset of
    turn_on-capable domains used to do, only always current. It also means
    neither caller has to re-derive the target's domain: the press-time inference
    in ``action_controller`` gets the right wake for any entity it is handed
    without parsing the entity_id at all.

    *settle* is a parameter rather than a constant read here because the two
    halves of the prelude have different scopes: the wake gate is universally
    correct, while the settle is specific to targets that report power long
    before they can act on it. Callers pass ``0`` to get the gate alone.
    """
    not_ready = ", ".join(f"'{state}'" for state in NOT_READY_STATES)
    steps: list[dict] = [
        {"action": "homeassistant.turn_on", "target": {"entity_id": entity_id}},
        {
            "wait_template": (
                f"{{{{ states('{entity_id}') not in [{not_ready}] }}}}"
            ),
            "timeout": ENSURE_ON_TIMEOUT,
            # A device that never reports ready still gets its action attempted,
            # rather than the press being swallowed.
            "continue_on_timeout": True,
        },
    ]
    if settle > 0:
        steps.append({"delay": {"seconds": settle}})

    return [{
        "if": [{"condition": "state", "entity_id": entity_id, "state": "off"}],
        "then": steps,
    }]


# ---------------------------------------------------------------------------
# Launch verification (the `after:` half)
# ---------------------------------------------------------------------------
#
# The wake prelude is open-loop: `androidtv_remote`'s app-launch is a bare
# socket write, so failure is invisible at the *service* layer. It is visible at
# the *state* layer, though — the same integration push-publishes the foreground
# app under `app_id`, a documented `media_player` state attribute — so closing
# the loop needs no new plumbing, only that somebody looks.

#: Attribute `androidtv_remote` publishes the foreground app under.
LAUNCH_VERIFY_ATTRIBUTE: Final = "app_id"

#: How long to wait for the launch to show up in state before retrying.
#:
#: Short on purpose. This is the *confirmation* window, not a boot window — the
#: boot has already been waited out by the prelude's settle. A launch that is
#: going to happen is reported within a second or two; anything longer and the
#: retry is the faster path to a working screen.
LAUNCH_VERIFY_TIMEOUT: Final = "00:00:05"

#: Script variable holding the app that was in the foreground when the press
#: reached the target.
#:
#: Namespaced because the sequence it lands in is shared with a hand-written
#: ``before:``/``after:`` from a template, which may define variables of its own.
LAUNCH_VERIFY_PREVIOUS_VAR: Final = "liza_prev_app_id"


def _app_id_expr(entity_id: str) -> str:
    """Return the bare Jinja expression for *entity_id*'s current app_id."""
    return f"state_attr('{entity_id}', '{LAUNCH_VERIFY_ATTRIBUTE}')"


def build_launch_capture(entity_id: str) -> dict:
    """Build the step that records *entity_id*'s app before the launch.

    Spliced between the wake prelude and the button's own action, so it reads
    the foreground app at the only moment that answers the question the retry
    asks. Capturing in Python before the script runs would read it *before the
    wake*, and the wake changes it: a TV woken from standby lands on its
    launcher, so a launch dropped immediately afterwards would look like the
    app had "changed" and the retry would decline — on exactly the cold-boot
    press this whole feature exists for.

    Keeping the value in a script variable also keeps the emitted sequence
    identical on every press, which is what lets ``_get_script``'s cache
    (it compares the actions list) stay warm. A literal baked in at build time
    differs from press to press and rebuilds the Script nearly every time.
    """
    return {
        "variables": {
            LAUNCH_VERIFY_PREVIOUS_VAR: f"{{{{ {_app_id_expr(entity_id)} }}}}",
        },
    }


def build_launch_verification(
    entity_id: str,
    expected_app_id: str,
    retry_steps: list[dict],
) -> list[dict]:
    """Build script steps that confirm a launch landed, and retry once if not.

    Runs *after* the button's own action, and pairs with the
    ``build_launch_capture`` step that must precede it. Two steps:

    1. Wait up to `LAUNCH_VERIFY_TIMEOUT` for `app_id` to become
       *expected_app_id*. ``continue_on_timeout`` so a device that never
       reports still falls through to the decision rather than erroring.
    2. Re-issue *retry_steps* — **exactly once, never a loop** — but only if
       `app_id` is still exactly what it was when the capture ran.

    That second condition is the whole containment story. "Unchanged" is the
    only signal that means *nothing happened at all*. If `app_id` moved to
    something that is neither the captured value nor the requested one, the user
    launched something else in the meantime, and yanking them back to our app
    would be a far worse bug than the silent drop this is fixing. A plain
    ``!= expected`` test would do exactly that.

    The second half of the condition covers the target already sitting on the
    requested app when the press arrived: "unchanged" is then trivially true
    however the launch went, so without it a button that plainly worked would
    re-issue. It is tested here rather than skipped in Python for the same
    reason the capture is a variable — a press-time decision would make the
    emitted sequence differ per press.

    Comparing against a variable also removes the need to special-case "no app
    reported yet": the variable simply holds ``none``, and ``none == none``
    is true in Jinja, whereas a baked literal would have had to render as an
    ``is none`` test to avoid comparing against the string ``"None"``.
    """
    previous = LAUNCH_VERIFY_PREVIOUS_VAR
    expected = json.dumps(expected_app_id)
    current = _app_id_expr(entity_id)
    return [
        {
            "wait_template": f"{{{{ {current} == {expected} }}}}",
            "timeout": LAUNCH_VERIFY_TIMEOUT,
            "continue_on_timeout": True,
        },
        {
            "if": [{
                "condition": "template",
                "value_template": (
                    f"{{{{ {current} == {previous} "
                    f"and {previous} != {expected} }}}}"
                ),
            }],
            "then": deepcopy(retry_steps),
        },
    ]
