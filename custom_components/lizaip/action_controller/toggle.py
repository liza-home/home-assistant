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
            tooltip: Stop                  # optional

``config`` keeps its job, and that is the load-bearing decision in the whole
feature. Six separate places read ``config[0]`` as "the step that represents
this button" — `icons._match_state_icon`, `helpers.resolve_step_entity`, the
`state_listener` watch set, `device_sync`'s tooltip ladder,
`buttons._fire_optimistic_update`, and the panel's `_findMatchingAction`. A
design that made ``config[0]`` a ``choose:`` block would run correctly and
silently break every one of them: no icon, no tooltip, no state watching, no
library match. So the rules live in a *sibling* key, exactly as ``before``,
``after`` and ``overrides`` already do, and ``config`` goes on naming the
button's subject, its tooltip and its fallback behaviour.

A rule is spelled ``{config, icon?, tooltip?, action_id?}``. Order is the whole
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

from ..shared.icon_defaults import icon_defaults
from ..shared.tokens import clean_tooltip_text
from ..shared.services import (
    ATTR_PREVIOUS_VALUE,
    attr_str,
    is_attribute_state_service,
    is_two_way_service,
    service_fixed_icon,
    service_name,
    service_to_attribute,
)

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


def representative_steps(assign: Any) -> list[dict]:
    """The first step of *assign*, then the first step of each cycle rule.

    Each names what one face of the button is about. A rule may point at a
    different entity from the assignment it sits on, and its label reads that
    one, so whatever watches a button's entities has to look at all of them.
    """
    steps: list[dict] = []
    config = assign.get("config") if isinstance(assign, dict) else None
    if isinstance(config, list) and config and isinstance(config[0], dict):
        steps.append(config[0])
    steps.extend(rule_steps(rule)[0] for rule in toggle_rules(assign))
    return steps


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


def rule_state_icons(rule: Any) -> dict[str, str]:
    """The per-state glyphs *rule* asks for, keyed as a button's are."""
    if not isinstance(rule, dict):
        return {}
    table = rule.get("state_icons")
    if not isinstance(table, dict):
        return {}
    out: dict[str, str] = {}
    for key, icon in table.items():
        if isinstance(key, str) and isinstance(icon, str) and icon.strip():
            out[key] = icon.strip()
    return out


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
    icons=None,
) -> str | None:
    """A glyph for *rule* derived from the service it calls.

    The fallback that makes rule icons genuinely optional in ``cycle`` mode.
    There, the ordinary ladder cannot help: it resolves from the *subject's
    state*, and a cycle button exists precisely because the subject reports no
    state — so an iconless cycle step kept the button's declared face and the
    glyph never changed as the user pressed. Asking every user to hand-pick an
    icon per step was the workaround; this is the fix.

    Same precedence the rest of the integration uses, so the derived glyph is
    the one a plain button calling that service would already wear: the
    default theme's icons first, then Home Assistant's service registry when
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

    override = service_fixed_icon(entity_domain or svc_domain, svc_name, icons)
    if override:
        return override

    attr_icon = _attribute_step_icon(rule, svc_name, icons)
    if attr_icon:
        return attr_icon

    if service_icons:
        svc_icon = service_icons.get(svc_domain, {}).get(svc_name, {}).get("service")
        if svc_icon:
            return svc_icon

    return (icons or icon_defaults).domain_icons.get(svc_domain)


def _attribute_step_icon(rule: Any, svc_name: str, icons=None) -> str | None:
    """The ``attribute_icons`` glyph for a step that sets an attribute.

    No service-icon table names `volume_mute`, so an iconless mute press used
    to fall through to its domain's glyph. The table the button reads has the
    answer, read under the value this press moves on from.
    """
    attribute = service_to_attribute(svc_name)
    table = (icons or icon_defaults).attribute_icons.get(attribute, {}) if attribute else {}
    if not table:
        return None

    steps = rule_steps(rule)
    data = (steps[0] if steps else {}).get("data") or {}
    value = attr_str(data.get(attribute)) if isinstance(data, dict) else ""
    previous = ATTR_PREVIOUS_VALUE.get(attribute, {}).get(value)
    return table.get(previous) if previous else next(iter(table.values()), None)


def rule_action_id(rule: Any) -> str | None:
    """The library action a rule's step was built from, if the editor said.

    Provenance only — nothing in the executor reads it, and a rule without one
    runs exactly the same. It exists so the Actions view can answer "is this
    action still used?" honestly: that count is what marks an action safe to
    delete, and a rule step is as live a use as a button's own ``config``.
    Under-counting is the dangerous direction, as ``lizaip-data.js`` says
    about the pages it scans.
    """
    if not isinstance(rule, dict):
        return None
    value = rule.get("action_id")
    if not isinstance(value, str):
        return None
    return value.strip() or None


def rule_tooltip(rule: Any) -> str | None:
    """The tooltip text *rule* asks for, or ``None`` to derive one as usual.

    Earns its place for the same reason :func:`rule_icon` does. A cycle step has
    no state to phrase, and its steps are often the ones with no natural name
    at all -- an IR ``send_command`` step is a key code, not a sentence -- so
    the only honest source is the user.

    Whitespace is not a tooltip, matching the panel's Tooltip trimming and the
    ``tooltip``/``tooltip_edited`` rule one level up: a cleared field asks for
    derivation again rather than storing a blank that would paint an empty
    tooltip.
    """
    if not isinstance(rule, dict):
        return None
    tooltip = rule.get("tooltip")
    if not isinstance(tooltip, str):
        return None
    tooltip = tooltip.strip()
    return tooltip or None


def _rule_assign(rule: Any) -> dict:
    """*rule* in assignment shape, so a button's own ladders can read it.

    A press already carries the keys those ladders ask about, so this is a
    view, not a copy. ``_press`` marks it as a cycle face, whose stored value
    is a direction the user chose rather than one a setter's form demands.
    """
    rule = rule if isinstance(rule, dict) else {}
    config = rule.get("config")
    assign = {"config": config if isinstance(config, list) else [], "_press": True}
    if rule.get("action_id"):
        assign["action_id"] = rule["action_id"]
    return assign


def resolve_rule_tooltip(rule: Any, hass, entry=None) -> str:
    """The words a press prints, with its ``${...}`` placeholders filled in.

    Filled by `_fill_tooltip_tokens`, the one every button label goes
    through, asked about this press's own target -- a cycle's steps often
    point at different entities. "" means the caller should fall back.
    """
    text = rule_tooltip(rule) or ""
    if not text:
        return ""

    # Imported here: `button_rendering` imports this module.
    from ..config.button_rendering import _fill_tooltip_tokens

    return clean_tooltip_text(
        _fill_tooltip_tokens(text, _rule_assign(rule), hass, entry)
    )


def step_tooltip(rule: Any, hass, entry=None) -> str:
    """Words for *rule* derived from the step it runs, or "" to fall back.

    The twin of :func:`step_icon`: the button's own ladder asked about this
    press, so a mute cycle reads "Mute" then "Unmute". Gated on the services
    that name a state, since a key code has no words of its own.
    """
    if hass is None:
        return ""
    svc = service_name(rule_service(rule) or "")
    if not (is_two_way_service(svc) or is_attribute_state_service(svc)):
        return ""

    from ..config.button_rendering import _resolve_button_tooltip

    return _resolve_button_tooltip(_rule_assign(rule), hass, entry)


def sanitize_toggle(value: Any) -> dict:
    """The storable form of a ``toggle`` block, or ``{}`` for anything unusable.

    The one gate every writer passes through — the WebSocket handler, the
    store's last-chance stripper and anything a template generates — so "what may
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

    An empty ``state_icons`` table is dropped with them: the panel prunes it
    when the last override goes, and a stored ``{}`` would fold into the config
    hash and resync the device for an edit that changed nothing.

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
        state_icons = rule_state_icons(raw)
        if state_icons:
            rule["state_icons"] = state_icons
        tooltip = rule_tooltip(raw)
        if tooltip:
            rule["tooltip"] = tooltip
        action_id = rule_action_id(raw)
        if action_id:
            rule["action_id"] = action_id
        rules.append(rule)

    if not rules:
        return {}
    return {"mode": mode, "rules": rules}
