"""The virtual toggle button: one button, several actions.

A Liza button is one action. A device whose transport is three separate
one-way commands — `play`, `stop`, `return` — therefore costs three of the
twelve grid buttons, and a user who wants one button has nowhere to put the
other two meanings.

This module is the one that decides *which* of them a press runs. It owns the
``toggle`` block's shape, and nothing else reads that block directly.

One mode: ``cycle`` -- the next action is the next one in the user's list,
wrapping at the end. It asks nothing of the target, which is the point: the
devices worth spending a button like this on are the ones that publish nothing
to read back, the IR / ``remote.send_command`` case this feature exists for.

There was briefly a second mode, ``state``, which picked the step whose
condition matched the subject entity. It was removed rather than kept as an
option, because Home Assistant already answers that question better than this
module can: ``light.toggle``, ``switch.toggle``, ``fan.toggle``,
``cover.toggle`` and ``media_player.media_play_pause`` are state-aware
services, and ``state_icons`` already makes the button's *face* follow the
state. On a two-state device the mode re-implemented a built-in with more
configuration and more ways to be wrong; on a stateful device the right
spelling is one action, not a rule list. What it uniquely bought -- three or
more states with no built-in, and per-state tooltips -- did not pay for a
second concept in the editor, where every user met the choice before they
understood either half of it.

The shape, on a stored button::

    button_9:
      action_id: <lib id>
      config:                              # unchanged: primary *and* fallback
        - action: remote.send_command
          target: {entity_id: remote.hifi}
          data: {command: play}
      toggle:
        mode: cycle
        rules:
          - config: [{action: remote.send_command, ...}]
            icon: mdi:stop                 # optional
            label: Stop                    # optional

``config`` keeps its job, and that is the load-bearing decision in the whole
feature. Six separate places read ``config[0]`` as "the step that represents
this button" — `icons._match_state_icon`, `helpers.resolve_step_entity`, the
`state_listener` watch set, `device_sync`'s label ladder,
`buttons._fire_optimistic_update`, and the panel's `_findMatchingAction`. A
design that made ``config[0]`` a ``choose:`` block would run correctly and
silently break every one of them: no icon, no tooltip, no state watching, no
library match. So the rules live in a *sibling* key, exactly as ``before``,
``after`` and ``overrides`` already do, and ``config`` goes on naming the
button's subject, its label and its fallback behaviour.

A rule is spelled ``{config, icon?, label?, action_id?}``. Order is the whole
condition: there is nothing to match against, so position *is* the rule, which
is why every reader preserves it and why the editor offers both arrows and a
drag handle.

Absence is the default everywhere: no ``toggle`` key means a button behaves
exactly as it does today. That is the same invariant ``overrides`` and
``before``/``after`` keep, and it is what makes the feature free for every
button that does not use it.
"""
from __future__ import annotations

import logging
from typing import Any

from ..const import (
    DOMAIN_ICONS,
    clean_label_text,
    get_ui_language,
    service_fixed_icon,
    service_name,
    state_token_label,
    substitute_label_tokens,
)
from .helpers import subject_for_assign

_LOGGER = logging.getLogger(__name__)

#: The sibling key on a button assignment holding the rule list.
TOGGLE_KEY = "toggle"

#: Pick the next action from a remembered position in the list.
#: The only mode the executor can run. A block naming anything else is inert
#: rather than guessed at: a button that quietly ran the wrong one of three
#: commands would be worse than one that falls back to its primary action.
#:
#: There was briefly a second, a ``state`` mode that picked the step whose
#: condition matched the subject entity. It was removed because Home Assistant
#: already answers that question: `light.toggle`, `switch.toggle`, `fan.toggle`,
#: `cover.toggle` and `media_player.media_play_pause` are state-aware services,
#: and `state_icons` already makes the *face* follow the state -- so on a
#: two-state device the mode re-implemented a built-in, and the one-action
#: spelling is both shorter and more reliable. Keeping the key, and keeping an
#: unknown mode inert, is what makes a block left over from that version fall
#: back to its primary action instead of being silently reinterpreted as a
#: cycle -- which would turn "do the right thing for this state" into "advance
#: one step", a different button.
MODE_CYCLE = "cycle"


def runtime_assign(assign: Any, enabled: bool) -> Any:
    """*assign* as the run time should read it, with the feature switch applied.

    Off hands back the same button with the ``toggle`` key taken off, which is
    what makes one switch govern every reader at once: the glyph, the tooltip,
    the steps a press runs and the cycle repaint all ask ``toggle_mode`` first,
    and all four answer "ordinary button" for a button that has no block. The
    alternative -- a flag threaded through the icon ladder, the tooltip ladder
    and the executor -- is the same decision spelled four times, and the next
    reader added would silently keep toggling.

    A *copy* is returned, and only to the three run-time producers. Nothing on
    the editor's path is filtered, so switching the feature off hides the
    configuration rather than destroying it: a panel save still round-trips the
    block it never saw, and switching back on finds the steps where they were.
    """
    if enabled or not isinstance(assign, dict) or TOGGLE_KEY not in assign:
        return assign
    return {k: v for k, v in assign.items() if k != TOGGLE_KEY}


def toggle_block(assign: Any) -> dict:
    """The ``toggle`` block *assign* declares, as a plain dict.

    Absence, a non-dict and an empty table all mean "this is an ordinary
    button". The writers guarantee an empty block never reaches disk (see
    :func:`sanitize_toggle`), so that case is defensive against hand-edited
    YAML — which reaches the readers without passing any writer.
    """
    block = assign.get(TOGGLE_KEY) if isinstance(assign, dict) else None
    return block if isinstance(block, dict) else {}


def toggle_mode(assign: Any) -> str | None:
    """Which mode *assign* runs in, or ``None`` for an ordinary button.

    ``None`` is also the answer for a block naming an unknown mode, and for one
    carrying no runnable rules. Both are "nothing to pick from", and the caller
    has exactly one thing to do about either: run ``config``.

    The rule check is here rather than left to the caller because a block with
    a mode and no rules is the shape a half-finished panel edit produces, and
    treating it as a live toggle would mean a button whose press resolves to no
    step at all.
    """
    block = toggle_block(assign)
    mode = block.get("mode")
    if mode != MODE_CYCLE:
        return None
    return mode if toggle_rules(assign) else None


def toggle_rules(assign: Any) -> list[dict]:
    """The runnable rules *assign* declares, in order.

    "Runnable" is a non-empty ``config`` list: a rule with no action would take
    its turn in the cycle and then do nothing, costing the user a press and
    leaving the button looking broken. Dropping it here is the reader's half of
    the same rule :func:`sanitize_toggle` enforces on the way to disk.

    Order is preserved and load-bearing: the cycle is nothing but the order.
    """
    raw = toggle_block(assign).get("rules")
    if not isinstance(raw, list):
        return []
    return [
        rule for rule in raw
        if isinstance(rule, dict) and rule_steps(rule)
    ]


def rule_steps(rule: Any) -> list[dict]:
    """The script steps *rule* runs, or ``[]`` when it has none.

    Same shape as a button's own ``config``, because it ends up in the same
    place: :func:`buttons.execute_action` swaps it in as ``own_actions``, and
    everything downstream — the wake prelude, the launch verification, the
    compiled-Script cache — then treats it exactly as it treats a normal
    button's steps. That is deliberate: a rule should not be a second kind of
    action with its own rules about what may appear in it.
    """
    steps = rule.get("config") if isinstance(rule, dict) else None
    if not isinstance(steps, list):
        return []
    return [step for step in steps if isinstance(step, dict)]


def rule_icon(rule: Any) -> str | None:
    """The glyph *rule* asks for, or ``None`` to derive one as usual.

    Optional on purpose: :func:`step_icon` derives a perfectly good glyph from
    the step's own service, so picking one is a choice rather than a repair.
    It is offered at all because a cycle has no state to read a face from --
    the ordinary ladder answers from the subject's state, and a cycle button
    exists because the subject reports none.
    """
    if not isinstance(rule, dict):
        return None
    icon = rule.get("icon")
    if not isinstance(icon, str):
        return None
    return icon.strip() or None


def rule_service(rule: Any) -> str | None:
    """The service a rule's first step calls, or ``None``.

    The step is the rule's identity for anything that has to *describe* it
    rather than run it — an icon, a tooltip. First step only, for the reason
    ``config[0]`` is the button's own identity: a multi-step rule is a sequence,
    and the thing that opens it is the thing it is named after.
    """
    steps = rule_steps(rule)
    if not steps:
        return None
    action = steps[0].get("action") or steps[0].get("service")
    return action if isinstance(action, str) and action else None


def step_icon(
    rule: Any,
    entity_domain: str = "",
    service_icons: dict | None = None,
) -> str | None:
    """A glyph for *rule* derived from the service it calls.

    The fallback that makes rule icons genuinely optional in ``cycle`` mode.
    There, the ordinary ladder cannot help: it resolves from the *subject's
    state*, and a cycle button exists precisely because the subject reports no
    state — so an iconless cycle step kept the button's declared face and the
    glyph never changed as the user pressed. Asking every user to hand-pick an
    icon per step was the workaround; this is the fix.

    Same precedence the rest of the integration uses, so the derived glyph is
    the one a plain button calling that service would already wear: our own
    ``icon_defaults.yaml`` first, then Home Assistant's service registry when
    the caller has it, then the domain's icon.

    Keyed on the *entity's* domain for the yaml lookup and the *service's* for
    the registry, exactly as :func:`button_rendering._icon_from_service` splits
    them, because our table is about what the button controls while HA's is
    keyed by the domain that defines the service.
    """
    service = rule_service(rule)
    if not service:
        return None
    svc_domain, _, svc_name = service.partition(".")
    if not svc_name:
        return None

    override = service_fixed_icon(entity_domain or svc_domain, svc_name)
    if override:
        return override

    if service_icons:
        svc_icon = service_icons.get(svc_domain, {}).get(svc_name, {}).get("service")
        if svc_icon:
            return svc_icon

    return DOMAIN_ICONS.get(svc_domain)


def rule_action_id(rule: Any) -> str | None:
    """The library action a rule's step was built from, if the editor said.

    Provenance only — nothing in the executor reads it, and a rule without one
    runs exactly the same. It exists so the Actions view can answer "is this
    action still used?" honestly: that count is what marks an action safe to
    delete, and a rule step is as live a use as a button's own ``config``.
    Under-counting is the dangerous direction, as ``liza-remote-data.js`` says
    about the pages it scans.
    """
    if not isinstance(rule, dict):
        return None
    value = rule.get("action_id")
    if not isinstance(value, str):
        return None
    return value.strip() or None


def rule_label(rule: Any) -> str | None:
    """The tooltip text *rule* asks for, or ``None`` to derive one as usual.

    Earns its place for the same reason :func:`rule_icon` does. A cycle step has
    no state to phrase, and its steps are often the ones with no natural name
    at all -- an IR ``send_command`` step is a key code, not a sentence -- so
    the only honest source is the user.

    Whitespace is not a label, matching the panel's Label trimming and the
    ``label``/``label_edited`` rule one level up: a cleared field asks for
    derivation again rather than storing a blank that would paint an empty
    tooltip.
    """
    if not isinstance(rule, dict):
        return None
    label = rule.get("label")
    if not isinstance(label, str):
        return None
    label = label.strip()
    return label or None


def resolve_rule_label(rule: Any, hass, entry=None) -> str:
    """The words a press prints, with its ``${...}`` placeholders filled in.

    A press's Tooltip field offers the same syntax press 1's does, so it has to
    mean the same thing. It did not: the two producers of a cycle tooltip
    handed this text to ``substitute_label_tokens`` with an *empty* value map
    (``buttons.py``) or did not substitute at all (:func:`toggle_tooltip`), so
    ``${_state}`` and ``${_name}`` collapsed to nothing on a press while reading
    "Schreibtisch Off" on the button above it -- one field, one syntax, two
    behaviours, and the one that silently printed less was the one the panel
    offered no warning about.

    The subject is the *press's own* target, not the button's. A cycle exists
    precisely because its steps do different things, and often to different
    entities; reading every press's ``${_state}`` off the button's declared
    action would phrase step three in terms of step one. ``state_token_label``
    is then asked about this press's service, which is what makes a
    ``turn_on`` press read "On" and the ``turn_off`` press under it "Off"
    rather than both reading the lamp's current state.

    Returns "" when the press stores no label, which is the caller's signal to
    fall back -- same as :func:`rule_label` returning ``None``.
    """
    text = rule_label(rule) or ""
    if not text:
        return ""

    config = rule.get("config") if isinstance(rule, dict) else None
    if not isinstance(config, list):
        config = []
    step = config[0] if config and isinstance(config[0], dict) else {}
    svc = service_name(step.get("action") or step.get("service") or "")

    # Built from the press's config alone. `subject_for_assign` asks only for
    # `config`, so a rule is already assignment-shaped for this purpose and
    # there is nothing to keep in step with the real assignment.
    _name, state_obj = subject_for_assign({"config": config}, hass)
    attrs = dict(state_obj.attributes or {}) if state_obj else None

    values = {
        "_state": state_token_label(
            svc,
            state_obj.state if state_obj else "",
            get_ui_language(hass, entry) if hass else "en",
            attrs,
            step.get("data") or {},
        ),
    }
    return clean_label_text(substitute_label_tokens(text, values, hass))


def sanitize_toggle(value: Any) -> dict:
    """The storable form of a ``toggle`` block, or ``{}`` for anything unusable.

    The one gate every writer passes through — the WebSocket handler, the
    store's last-chance stripper and anything a layout generates — so "what may
    reach disk" is answered once rather than three times in three dialects.
    :func:`overrides.sanitize_slider_override` is the model, and the reasoning
    is the same: the panel tests presence with ``Object.hasOwn`` and must never
    have to interpret an empty table, whose truthiness differs between the two
    languages this config crosses.

    Three things are dropped, each because keeping it would store a setting
    nothing acts on:

    * an unknown ``mode``, because the executor will not run it;
    * a rule with no runnable ``config``, for the reason :func:`toggle_rules`
      gives;
    * the whole block once it has no rules left, because a mode with nothing to
      pick from is an ordinary button with a key on it.

    ``state`` and ``attribute`` are dropped wherever they appear. A cycle rule
    carries no condition by definition, and storing one would be a field the
    user can fill in and watch do nothing -- which is also what keeps a block
    written by the version that had a ``state`` mode from arriving here with
    conditions still attached.
    """
    if not isinstance(value, dict):
        return {}
    mode = value.get("mode")
    if mode != MODE_CYCLE:
        return {}

    rules: list[dict] = []
    for raw in value.get("rules") or []:
        steps = rule_steps(raw)
        if not steps:
            continue
        rule: dict[str, Any] = {"config": steps}
        icon = rule_icon(raw)
        if icon:
            rule["icon"] = icon
        label = rule_label(raw)
        if label:
            rule["label"] = label
        action_id = rule_action_id(raw)
        if action_id:
            rule["action_id"] = action_id
        rules.append(rule)

    if not rules:
        return {}
    return {"mode": mode, "rules": rules}
