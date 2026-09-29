"""Re-resolve stored dynamic bindings and push changed pages.

The resolver creates assignments carrying ``dynamic`` bindings; this module
asks sources for current items and writes back changes. It only updates the
store and fires the existing config-changed event. Device sync then re-renders,
re-hashes and pushes only pages whose hash moved.

Failure handling has two shapes:

* **The item is gone**: the source answered successfully but the indexed item no
  longer exists. Blank the button and keep the binding so it can refill later.
* **The source could not be read**: speaker offline, browse timeout, etc. Keep
  the last-known item and mark the binding ``stale``.
"""
from __future__ import annotations

import asyncio
import logging
from copy import deepcopy
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback

from ...action_controller import SLIDER_VERTICAL_KEY
from ...const import DOMAIN, name_is_user_written
from ...device.const import LIZAIP_EVENT
from ..const import (
    ASSIGNMENT_BLANKED_KEY,
    ASSIGNMENT_DYNAMIC_KEY,
    ASSIGNMENT_LABEL_EDITED_KEY,
)
from .resolver import ASSIGNMENT_FIELD_MAP, field_value, resolve_binding
from .sources import bound_specs, get_source
from ..snapshot import _fire_config_changed, _resolve_device_id

_LOGGER = logging.getLogger(__name__)

#: Prevent concurrent refreshes from racing store writes for the same device.
_REFRESH_LOCKS_KEY = "_dynamic_refresh_locks"


def _refresh_lock(hass: HomeAssistant, device_id: str) -> asyncio.Lock:
    locks = hass.data.setdefault(DOMAIN, {}).setdefault(_REFRESH_LOCKS_KEY, {})
    lock = locks.get(device_id)
    if lock is None:
        lock = locks[device_id] = asyncio.Lock()
    return lock


def _apply_field(assignment: dict[str, Any], field: str, value: Any) -> bool:
    """Write one resolved field onto *assignment*. Returns True if it changed."""
    dest = ASSIGNMENT_FIELD_MAP.get(field)
    if not dest:
        return False
    # Refill/blanking takes back a user-written label claim from the old item.
    dropped_claim = False
    if field == "label":
        dropped_claim = bool(assignment.pop(ASSIGNMENT_LABEL_EDITED_KEY, False))
    key, sub = dest
    if sub is None:
        if assignment.get(key) == value:
            return dropped_claim
        assignment[key] = value
        return True

    config = assignment.get(key)
    if not isinstance(config, list) or not config:
        config = [{}]
        assignment[key] = config
    step = config[0]
    if not isinstance(step, dict):
        return False
    # An empty dict and an absent key are the same state: `_strip_empty_fields`
    # drops empty step fields on write, so a step that held `{}` in memory comes
    # back from disk with no key at all. Comparing them as unequal would make
    # the first refresh after every load rewrite the page and resync the device.
    if step.get(sub) == value or (not step.get(sub) and _is_empty_dict(value)):
        return False
    step[sub] = value
    return True


def _is_empty_dict(value: Any) -> bool:
    return isinstance(value, dict) and not value


def _payload_without_subject(value: Any, assignment: dict[str, Any]) -> Any:
    """A resolved payload with the subject the target already names removed.

    The source hands an entity item down as ``data: {entity_id: X}`` because
    that is how the subject reaches the generator. Once the step has a target
    holding the same id, storing it again is a second copy nothing reads.

    This has to happen to the incoming value rather than to the stored step, or
    every refresh would write the payload back and then strip it again, and
    report a change each time — rewriting every page on every navigation.

    Steps with no target keep it: ``script``/``scene`` steps drop their target,
    so for them the payload is the only thing naming what to run.
    """
    if not isinstance(value, dict) or "entity_id" not in value:
        return value
    config = assignment.get("config")
    step = config[0] if isinstance(config, list) and config else None
    target = step.get("target") if isinstance(step, dict) else None
    if not isinstance(target, dict) or target.get("entity_id") != value["entity_id"]:
        return value
    return {k: v for k, v in value.items() if k != "entity_id"}


def _retarget_subject(assignment: dict[str, Any], identity: str, source_id: str) -> bool:
    """Point existing target/slider keys at the entity the button now shows.

    For sources whose items *are* entities, ``identity`` is that entity id, so
    the subject no longer has to be carried a second time in the step payload.
    ``identity`` is passed in rather than read back off the binding because the
    caller has the freshly resolved one and the binding still holds the previous.

    Missing keys are not invented: that would change the action's shape.
    """
    source = get_source(source_id)
    if source is None or not source.items_are_entities:
        return False
    if not isinstance(identity, str) or "." not in identity:
        return False

    changed = False
    config = assignment.get("config")
    if isinstance(config, list) and config and isinstance(config[0], dict):
        target = config[0].get("target")
        if isinstance(target, dict) and target.get("entity_id") not in (None, identity):
            target["entity_id"] = identity
            changed = True
    subject = _slider_subject_block(assignment)
    if subject is not None and subject.get("entity_id") != identity:
        subject["entity_id"] = identity
        changed = True
    return changed


def _slider_subject_block(assignment: dict[str, Any]) -> dict[str, Any] | None:
    """The stored slider block, in place and writable, or None if there is none.

    Returned rather than read so the three refresh paths keep rewriting the
    *existing* key instead of inventing one: a slot that never drove a slider
    must not start driving one because it refilled, and that rule is the reason
    the empty-string placeholder exists at all.
    """
    overrides = assignment.get("overrides")
    if not isinstance(overrides, dict):
        return None
    block = overrides.get(SLIDER_VERTICAL_KEY)
    return block if isinstance(block, dict) else None


def _blank_fields(
    assignment: dict[str, Any], fields: list[str], binding: dict[str, Any] | None = None
) -> bool:
    """Blank resolver-owned fields and reversibly disarm a missing item.

    ``action_id`` and the step target are layout-owned and cannot be rebuilt by
    :data:`ASSIGNMENT_FIELD_MAP`, so they are stashed for ``_restore_action``.
    A deleted item must not stay pressable, but a recovered one must work.
    """
    changed = False
    for field in fields:
        if field == "label":
            changed |= _apply_field(assignment, "label", "")
        elif field == "icon":
            changed |= _apply_field(assignment, "icon", "")

    action_id = assignment.get("action_id")
    config = assignment.get("config")
    if binding is not None and (action_id is not None or config):
        # Do not overwrite the good stash with an already-blanked copy.
        if ASSIGNMENT_BLANKED_KEY not in binding:
            binding[ASSIGNMENT_BLANKED_KEY] = deepcopy(
                {"action_id": action_id, "config": config}
            )
            changed = True

    if config:
        assignment["config"] = []
        changed = True
    if action_id is not None:
        assignment["action_id"] = None
        changed = True
    # Empty, do not remove: `_retarget_subject` only rewrites existing keys,
    # so the slot can pick the slider back up when it refills. Leaving the old
    # device name would let a blank positional slot drive another live entity.
    subject = _slider_subject_block(assignment)
    if subject is not None and subject.get("entity_id"):
        subject["entity_id"] = ""
        changed = True
    return changed


def _restore_action(assignment: dict[str, Any], binding: dict[str, Any]) -> bool:
    """Undo disarming before resolved ``action``/``data`` are refilled."""
    stashed = binding.pop(ASSIGNMENT_BLANKED_KEY, None)
    if not isinstance(stashed, dict):
        return False
    # User edits while blanked win over the stash.
    changed = True
    if assignment.get("action_id") is None and stashed.get("action_id") is not None:
        assignment["action_id"] = stashed["action_id"]
    if not assignment.get("config") and stashed.get("config"):
        assignment["config"] = deepcopy(stashed["config"])
    return changed


def _user_armed_an_itemless_button(
    assignment: dict[str, Any], binding: dict[str, Any]
) -> bool:
    """Whether an armed itemless button must be treated as user-owned.

    The resolver only arms buttons from resolved items or ``_restore_action``;
    an armed empty slot was claimed by the user. Deliberately not compared to
    the stashed ``action_id``: that action is a real library entry the user may
    choose, and must not be silently overruled.
    """
    if assignment.get("action_id") is None:
        return False
    return ASSIGNMENT_BLANKED_KEY in binding or not binding.get("identity")


def _give_up_on_the_item(
    assignment: dict[str, Any], binding: dict[str, Any], fields: list[str]
) -> bool:
    """Blank a gone item, unless the user has claimed its empty slot.

    Bindings survive normal disappearance so a re-added favorite refills the
    slot. But an itemless slot with a user action must be detached, matching
    ``_claims_the_button`` in ``websocket.py``.
    """
    if _user_armed_an_itemless_button(assignment, binding):
        # Detach, or a later source refill would overwrite the user's button.
        assignment.pop(ASSIGNMENT_DYNAMIC_KEY, None)
        # Drop only the empty placeholder; a named slider target is user-owned.
        # The whole block goes, control and all: with no subject there is
        # nothing for a control to be a capability *of*, and the writers do not
        # store one alone either.
        overrides = assignment.get("overrides")
        subject = _slider_subject_block(assignment)
        if subject is not None and subject.get("entity_id") == "":
            overrides.pop(SLIDER_VERTICAL_KEY, None)
            if not overrides:
                assignment.pop("overrides", None)
        _LOGGER.debug(
            "Binding %s[%s] released: the slot carries a user-assigned action",
            binding.get("source"), binding.get("index"),
        )
        return True

    changed = _blank_fields(assignment, fields, binding)
    if binding.get("identity"):
        binding["identity"] = ""
        changed = True
    if not binding.get("stale"):
        binding["stale"] = True
        changed = True
    if binding.pop("error", None) is not None:
        changed = True
    return changed


async def _refresh_assignment(
    hass: HomeAssistant,
    assignment: dict[str, Any],
) -> bool:
    """Re-resolve one button. Returns True if the assignment changed."""
    binding = assignment.get(ASSIGNMENT_DYNAMIC_KEY)
    if not isinstance(binding, dict) or not binding.get("source"):
        return False

    resolution = await resolve_binding(hass, binding)
    item, error = resolution
    fields = [f for f in (binding.get("fields") or []) if f]
    raw_map = binding.get("field_map")
    field_map: dict[str, str] = (
        {str(k): str(v) for k, v in raw_map.items() if v}
        if isinstance(raw_map, dict)
        else {}
    )
    changed = False

    if error:
        # Unreadable source: keep content pressable and mark it stale. Empty
        # successful answers fall through to blanking instead.
        if not binding.get("stale"):
            binding["stale"] = True
            changed = True
        if binding.get("error") != error:
            binding["error"] = error
            changed = True
        return changed

    if item is None:
        # Source answered; the item is genuinely gone.
        return _give_up_on_the_item(assignment, binding, fields)

    # Restore first so resolved action/data keep the layout-owned target.
    changed |= _restore_action(assignment, binding)

    # Read old identity before writes so user labels survive same-item refresh.
    identity = item.identity or item.title
    same_item = bool(binding.get("identity")) and binding.get("identity") == identity

    # Re-point before the payload lands, not after: what the target names is
    # what decides whether the payload still has to name the subject too.
    if "data" in fields:
        changed |= _retarget_subject(
            assignment, identity, str(binding.get("source") or "")
        )

    for field in fields:
        # `field_map` preserves cross-mapped token suffixes.
        value = field_value(item, field_map.get(field, field))
        if value is None:
            continue
        if field == "label" and same_item and name_is_user_written(assignment):
            continue
        if field == "data":
            value = _payload_without_subject(value, assignment)
        changed |= _apply_field(assignment, field, value)

    if binding.get("identity") != identity:
        binding["identity"] = identity
        changed = True
    if binding.get("stale"):
        binding["stale"] = False
        changed = True
    if binding.pop("error", None) is not None:
        changed = True
    return changed


async def async_refresh_page(
    hass: HomeAssistant,
    device_id: str,
    page_id: int,
) -> bool:
    """Refresh every dynamic button on one page. Returns True if it changed."""
    store = hass.data.get(DOMAIN, {}).get("_store")
    if store is None:
        return False

    assignments = await store.async_get_assignments(device_id, page_id)
    if not assignments:
        return False
    if not any(
        isinstance(a, dict) and a.get(ASSIGNMENT_DYNAMIC_KEY)
        for a in assignments.values()
    ):
        return False

    changed = False
    for assignment in assignments.values():
        if not isinstance(assignment, dict):
            continue
        try:
            changed |= await _refresh_assignment(hass, assignment)
        except Exception as exc:  # noqa: BLE001 - one bad button must not
            # abort the rest of the page.
            _LOGGER.debug("Dynamic refresh failed for a button: %s", exc)

    if changed:
        await store.async_set_assignments(device_id, page_id, assignments)
        await store.async_recompute_page_hash(device_id, page_id)
    return changed


async def async_refresh_entry(
    hass: HomeAssistant,
    entry_id: str,
    *,
    page_id: int | None = None,
) -> bool:
    """Refresh one page, or every page, of a config entry's device."""
    store = hass.data.get(DOMAIN, {}).get("_store")
    if store is None:
        return False
    device_id = _resolve_device_id(hass, entry_id)
    if not device_id:
        return False

    async with _refresh_lock(hass, entry_id):
        if page_id is not None:
            return await async_refresh_page(hass, device_id, page_id)

        pages = await store.async_get_pages(device_id)
        changed = False
        for page in pages:
            pid = page.get("id")
            if pid is None:
                continue
            changed |= await async_refresh_page(hass, device_id, pid)
        return changed


async def async_refresh_and_sync(
    hass: HomeAssistant,
    entry_id: str,
    *,
    page_id: int | None = None,
) -> bool:
    """Refresh, and push to the device if anything moved."""
    changed = await async_refresh_entry(hass, entry_id, page_id=page_id)
    if changed:
        await _fire_config_changed(hass, entry_id)
    return changed


async def async_refresh_all(hass: HomeAssistant) -> int:
    """Refresh every configured device. Returns the number that changed."""
    count = 0
    for entry in hass.config_entries.async_entries(DOMAIN):
        try:
            if await async_refresh_and_sync(hass, entry.entry_id):
                count += 1
        except Exception as exc:  # noqa: BLE001 - one device must not stop the rest
            _LOGGER.warning(
                "Dynamic refresh failed for %s: %s", entry.entry_id, exc
            )
    return count


# ── triggers ──────────────────────────────────────────────────────────
#
# Refreshes come from navigation, reconnect, source push signals and the manual
# service. Deliberately no timer: shipped sources push real changes, and
# ``refresh_dynamic_sources`` is the explicit re-read escape hatch.

SERVICE_REFRESH_DYNAMIC = "refresh_dynamic_sources"

#: Debounce D-pad page scrolling before refreshing after ``goto_page``.
_GOTO_DEBOUNCE = 2.0

SERVICE_SCHEMA = vol.Schema(
    {
        vol.Optional("entry_id"): vol.Any(str, [str]),
    }
)


@callback
def async_setup_entry_triggers(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    """Register the per-entry triggers. Returns unsubs keyed for teardown."""
    # Lazy import: test stubs do not provide this helper.
    from homeassistant.helpers.event import async_call_later

    unsubs: dict[str, Any] = {}
    entry_id = entry.entry_id

    # --- goto_page ------------------------------------------------------
    #
    debounce_handle: dict[str, Any] = {"cancel": None}

    async def _do_refresh(_now=None) -> None:
        debounce_handle["cancel"] = None
        try:
            changed = await async_refresh_and_sync(hass, entry_id)
            _LOGGER.debug("Dynamic refresh after goto_page: changed=%s", changed)
        except Exception as exc:  # noqa: BLE001 - a trigger must never raise
            _LOGGER.debug("Dynamic refresh after goto_page failed: %s", exc)

    @callback
    def _on_device_event(event: Event) -> None:
        if event.data.get("type") != "goto_page":
            return
        conn = getattr(entry, "runtime_data", None)
        if conn is None:
            _LOGGER.debug(
                "goto_page ignored: entry %s has no runtime_data yet", entry_id
            )
            return
        own_device_id = getattr(conn, "_device_id", None)
        if event.data.get("device_id") != own_device_id:
            _LOGGER.debug(
                "goto_page ignored: device_id %s is not ours (%s)",
                event.data.get("device_id"), own_device_id,
            )
            return
        if debounce_handle["cancel"] is not None:
            debounce_handle["cancel"]()
        debounce_handle["cancel"] = async_call_later(
            hass, _GOTO_DEBOUNCE, _do_refresh
        )

    unsubs["dynamic_goto_unsub"] = hass.bus.async_listen(LIZAIP_EVENT, _on_device_event)

    @callback
    def _cancel_debounce() -> None:
        if debounce_handle["cancel"] is not None:
            debounce_handle["cancel"]()
            debounce_handle["cancel"] = None

    unsubs["dynamic_debounce_unsub"] = _cancel_debounce
    return unsubs


#: Coalesce source change bursts; Sonos may write several speakers per edit.
_PUSH_DEBOUNCE = 3.0

async def _async_read_bound_specs(hass: HomeAssistant, entry_id: str):
    """Bound ``(source_id, spec)`` pairs, or ``None`` if unreadable.

    ``None`` is distinct from ``[]`` during re-scan: an empty list drops
    subscriptions, while unreadable bindings should keep current ones.
    """
    store = hass.data.get(DOMAIN, {}).get("_store")
    device_id = _resolve_device_id(hass, entry_id)
    if store is None or not device_id:
        return None

    try:
        pages = await store.async_get_pages(device_id)
        by_page = {}
        for page in pages or []:
            pid = page.get("id")
            if pid is None:
                continue
            by_page[pid] = await store.async_get_assignments(device_id, pid)
        return bound_specs(by_page)
    except Exception as exc:  # noqa: BLE001 - an optimisation must never break setup
        _LOGGER.debug("Push trigger scan failed for %s: %s", entry_id, exc)
        return None


async def _async_bound_specs(hass: HomeAssistant, entry_id: str):
    """Bound specs, treating an unreadable store as no bindings for setup."""
    specs = await _async_read_bound_specs(hass, entry_id)
    return [] if specs is None else specs


def _specs_by_source(specs) -> dict[str, list]:
    grouped: dict[str, list] = {}
    for source_id, spec in specs:
        grouped.setdefault(source_id, []).append(spec)
    return grouped


def _subscribe_sources(hass: HomeAssistant, specs, on_change) -> list:
    """Call bound source push hooks, isolating failures per source."""
    unsubs = []
    for source_id, source_specs in sorted(_specs_by_source(specs).items()):
        source = get_source(source_id)
        hook = getattr(source, "subscribe", None) if source is not None else None
        if hook is None:
            continue
        try:
            unsub = hook(hass, source_specs, on_change)
        except Exception as exc:  # noqa: BLE001 - one bad hook must not break setup
            _LOGGER.warning(
                "Push subscribe failed for source %s: %s. Bound buttons will "
                "only update when the page is opened, the device reconnects, "
                "or %s.%s is called.",
                source_id, exc, DOMAIN, SERVICE_REFRESH_DYNAMIC,
            )
            continue
        if unsub is None:
            _LOGGER.debug(
                "Source %s did not subscribe; no push signal for its buttons",
                source_id,
            )
            continue
        unsubs.append(unsub)
    return unsubs


def _call_all(unsubs) -> None:
    for unsub in unsubs or ():
        try:
            unsub()
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("Push trigger removal failed: %s", exc)


async def async_setup_push_triggers(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Let each bound source push, with generic triggers as backstops.

    Source hooks live in ``sources``; this function supplies debounce,
    refresh and teardown. Title-derived ``source_list`` signals cannot see
    artwork/content-id edits or offline speakers, so navigation/reconnect still
    re-read eventually. Kept separate because bound-spec reads are async.
    """
    from homeassistant.helpers.event import async_call_later

    unsubs: dict[str, Any] = {}
    entry_id = entry.entry_id

    specs = await _async_bound_specs(hass, entry_id)

    debounce: dict[str, Any] = {"cancel": None}

    async def _do_push_refresh(_now=None) -> None:
        debounce["cancel"] = None
        try:
            changed = await async_refresh_and_sync(hass, entry_id)
            _LOGGER.debug("Dynamic refresh after source signal: changed=%s", changed)
        except Exception as exc:  # noqa: BLE001 - a trigger must never raise
            _LOGGER.debug("Dynamic refresh after source signal failed: %s", exc)

    @callback
    def _schedule_refresh() -> None:
        if debounce["cancel"] is not None:
            debounce["cancel"]()
        debounce["cancel"] = async_call_later(hass, _PUSH_DEBOUNCE, _do_push_refresh)

    source_unsubs = _subscribe_sources(hass, specs, _schedule_refresh)
    if source_unsubs:
        @callback
        def _unsub_sources() -> None:
            _call_all(source_unsubs)

        unsubs["dynamic_push_unsub"] = _unsub_sources

    # Keep the handler even with no specs so later page saves can subscribe.
    @callback
    def _cancel_push_debounce() -> None:
        if debounce["cancel"] is not None:
            debounce["cancel"]()
            debounce["cancel"] = None

    unsubs["dynamic_push_debounce_unsub"] = _cancel_push_debounce
    # Not named "..._unsub": teardown calls those, and this is not a cancel.
    unsubs["dynamic_push_handler"] = _schedule_refresh
    unsubs["dynamic_push_specs"] = list(specs)
    unsubs["dynamic_push_entities"] = {
        str(spec.get("entity") or spec.get("entity_id") or "")
        for _sid, spec in specs
        if (spec.get("entity") or spec.get("entity_id"))
    }

    return unsubs


async def async_rescan_push_triggers(hass: HomeAssistant, entry_id: str) -> None:
    """Re-subscribe after bound specs may have changed.

    Pages added after setup, or bindings re-pointed to another player, need new
    source hooks without restart. Subscribe the new set before dropping old
    listeners so signals cannot fall into the save-time gap.
    """
    entry_data = hass.data.get(DOMAIN, {}).get(entry_id)
    if entry_data is None:
        return

    # Reuse setup's handler so one debounce covers all subscriptions.
    on_changed = entry_data.get("dynamic_push_handler")
    if on_changed is None:
        return

    try:
        wanted = await _async_read_bound_specs(hass, entry_id)
    except Exception as exc:  # noqa: BLE001 - a re-scan must never break a save
        _LOGGER.debug("Push trigger re-scan failed for %s: %s", entry_id, exc)
        return
    if wanted is None:
        # Keep current subscriptions on transient store failure.
        _LOGGER.debug(
            "Push trigger re-scan for %s could not read bindings; "
            "keeping the current subscriptions", entry_id,
        )
        return

    current = entry_data.get("dynamic_push_specs") or []
    if wanted == current:
        return

    old_unsub = entry_data.get("dynamic_push_unsub")
    source_unsubs = _subscribe_sources(hass, wanted, on_changed)
    if source_unsubs:
        @callback
        def _unsub_sources() -> None:
            _call_all(source_unsubs)

        entry_data["dynamic_push_unsub"] = _unsub_sources
    else:
        entry_data.pop("dynamic_push_unsub", None)

    if old_unsub:
        try:
            old_unsub()
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("Push trigger removal failed: %s", exc)

    entry_data["dynamic_push_specs"] = list(wanted)
    entry_data["dynamic_push_entities"] = {
        str(spec.get("entity") or spec.get("entity_id") or "")
        for _sid, spec in wanted
        if (spec.get("entity") or spec.get("entity_id"))
    }
    _LOGGER.debug(
        "Push triggers re-scanned for %s: now %d bound spec(s)", entry_id, len(wanted)
    )


async def async_handle_hello(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Refresh after reconnect; stored snapshots may predate the outage."""
    try:
        await async_refresh_and_sync(hass, entry.entry_id)
    except Exception as exc:  # noqa: BLE001
        _LOGGER.debug("Dynamic refresh on device hello failed: %s", exc)


@callback
def async_register_service(hass: HomeAssistant) -> None:
    """Register ``lizaip.refresh_dynamic_sources`` (idempotent)."""
    if hass.services.has_service(DOMAIN, SERVICE_REFRESH_DYNAMIC):
        return

    async def _handle(call) -> None:
        raw = call.data.get("entry_id")
        if raw:
            entry_ids = [raw] if isinstance(raw, str) else list(raw)
            for entry_id in entry_ids:
                await async_refresh_and_sync(hass, entry_id)
            return
        changed = await async_refresh_all(hass)
        _LOGGER.debug("refresh_dynamic_sources updated %s device(s)", changed)

    hass.services.async_register(
        DOMAIN, SERVICE_REFRESH_DYNAMIC, _handle, schema=SERVICE_SCHEMA
    )


async def async_binding_summary(hass: HomeAssistant, entry_id: str) -> dict[str, Any]:
    """Summarise stored dynamic bindings for diagnostics.

    Stale buttons intentionally look unchanged on the device, so diagnostics
    need to expose stored state. This never resolves sources, keeping it cheap
    and avoiding 15-second browses.
    """
    summary: dict[str, Any] = {
        "total": 0,
        "stale": 0,
        "by_source": {},
        "stale_bindings": [],
        "errors": {},
    }

    store = hass.data.get(DOMAIN, {}).get("_store")
    device_id = _resolve_device_id(hass, entry_id)
    if store is None or not device_id:
        return summary

    try:
        pages = await store.async_get_pages(device_id)
    except Exception as exc:  # noqa: BLE001 - diagnostics must never raise
        _LOGGER.debug("Binding summary unavailable for %s: %s", entry_id, exc)
        return summary

    for page in pages:
        page_id = page.get("id")
        if page_id is None:
            continue
        try:
            assignments = await store.async_get_assignments(device_id, page_id)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.debug("Binding summary skipped page %s: %s", page_id, exc)
            continue

        for button_key, assign in (assignments or {}).items():
            if not isinstance(assign, dict):
                continue
            binding = assign.get(ASSIGNMENT_DYNAMIC_KEY)
            if not isinstance(binding, dict) or not binding.get("source"):
                continue

            source = str(binding.get("source"))
            summary["total"] += 1
            summary["by_source"][source] = summary["by_source"].get(source, 0) + 1

            if not binding.get("stale"):
                continue
            summary["stale"] += 1
            error = str(binding.get("error") or "")
            if error:
                summary["errors"][error] = summary["errors"].get(error, 0) + 1
            summary["stale_bindings"].append({
                "page": page_id,
                "button": button_key,
                "source": source,
                "index": binding.get("index"),
                # Do not expose spec entities in diagnostics.
                "error": error,
            })

    return summary
