"""Mutable runtime state shared by the action controller.

Dicts are mutated in place so importers may hold references. Keeping them in
one leaf module prevents executor, dispatcher and recorder state from drifting.
"""
from __future__ import annotations

import logging
import time

_LOGGER = logging.getLogger(__name__)


#: Pages are 1-based; a page dict missing "id" is treated as the first page.
_DEFAULT_PAGE_ID = 1

#: Coalesce bursty state/attribute changes into one icon update.
_STATE_DEBOUNCE_SECONDS = 0.5

#: Fixed-button context per config entry: entry_id → grid button key.
#: Grid keys only; fixed buttons never become their own context. The slider
#: selection has different clearing rules, so this stays separate.
_selected_button: dict[str, str] = {}


#: Only ``touch`` and ``click`` select; ``release`` trails click and ``repeat`` floods.
_SELECTING_INTERACTIONS: frozenset[str] = frozenset({"touch", "click"})

#: Selected slider target per config entry: entry_id → entity_id.
#: Deliberately not timestamped; it changes only on selection or page exit.
_selected_entity: dict[str, str] = {}

#: Selected control choice per config entry: entry_id → control id.
#: Stores the choice, never mechanics; ranges resolve from live state at gesture time.
_selected_control: dict[str, str] = {}

#: Selected sensitivity per config entry: entry_id → factor.
#: Safe to freeze: it describes the physical track, not entity mechanics.
_selected_factor: dict[str, float] = {}

#: Last known page per config entry: entry_id → page_id.
#: Used to infer unannounced page changes and as ``_coerce_page_id``'s fallback.
_current_page: dict[str, int] = {}


def get_current_page(entry_id: str) -> int | None:
    return _current_page.get(entry_id)


def _page_changed(entry_id: str, page_id: int | None) -> bool:
    """Whether *page_id* differs from the last known page for *entry_id*.

    Only a difference from a known previous page counts. The first event after
    restart, reconnect or clear establishes the page instead of reporting a
    change, so a first touch cannot clear the selection it just created.

    ``None`` and ``0`` are unset values from ``_coerce_page_id`` and cannot be a
    page change. This function is pure: callers may need to clear state before
    recording, because ``clear_slider_state`` also drops the tracked page."""
    if not page_id:
        return False
    previous = _current_page.get(entry_id)
    return previous is not None and previous != page_id


def _note_page(entry_id: str, page_id: int | None) -> None:
    """Record a usable page, leaving the fallback untouched for unset values."""
    if page_id:
        _current_page[entry_id] = page_id


def _clear_selected_device(entry_id: str) -> None:
    """Clear the selected entity, control and factor together.

    They are written together by ``_record_selection`` and must be cleared
    together everywhere. A control id must not outlive its entity (for example,
    colour temperature applied to a speaker), and a per-button factor must not
    survive into the next selection with no visible reason.

    Used both for page/unload clearing via ``clear_slider_state`` and for a blank
    grid-button press in ``_record_selection``."""
    if _selected_entity.pop(entry_id, None) is not None:
        _LOGGER.debug("Cleared device selection for %s", entry_id)
    # Unconditionally, not only when the entity was set: neither the control id
    # nor the factor may outlive the entity they were chosen for.
    _selected_control.pop(entry_id, None)
    _selected_factor.pop(entry_id, None)


def get_selected_control(entry_id: str) -> str | None:
    return _selected_control.get(entry_id)


def get_selected_factor(entry_id: str) -> float | None:
    return _selected_factor.get(entry_id)


def get_selected_entity(entry_id: str) -> str | None:
    return _selected_entity.get(entry_id)


def get_selected_button(entry_id: str) -> str | None:
    return _selected_button.get(entry_id)


# Key: (entry_id, slider_key) → {base_value, zero_pos, last_pos, ts, resolved}
_slider_touch_state: dict[tuple[str, str], dict] = {}

# Stale gestures are abandoned so the next touch cannot use an old zero-point.
SLIDER_GESTURE_TIMEOUT = 5.0


def _live_touch(state_key: tuple[str, str], *, pop: bool = False) -> dict | None:
    """Return the live gesture, dropping stale state on the way out."""
    touch = _slider_touch_state.get(state_key)
    if not touch:
        return None
    if time.monotonic() - touch.get("ts", 0.0) > SLIDER_GESTURE_TIMEOUT:
        _LOGGER.debug("Slider gesture %s expired — treating next touch as fresh", state_key)
        _slider_touch_state.pop(state_key, None)
        return None
    if pop:
        _slider_touch_state.pop(state_key, None)
    return touch


def _slider_gesture_active(state_key: tuple[str, str]) -> bool:
    return _live_touch(state_key) is not None


def clear_slider_state(entry_id: str) -> None:
    """Clear in-flight slider gestures, selection and fixed-button context.

    Called when gestures can no longer be trusted: page changes announced by
    ``_on_device_event``, inferred by ``_page_changed``, commanded via
    ``LizaIPConnection.goto_page``, or config-entry unload in ``config/panel.py``.
    Dropped devices have no hook here; ``SLIDER_GESTURE_TIMEOUT`` is the backstop.

    Slider selection and fixed-button context are invalid for the same reason:
    after page change those buttons are off-screen, and after unload no device
    remains to have selected anything."""
    for key in [k for k in _slider_touch_state if k[0] == entry_id]:
        _slider_touch_state.pop(key, None)
        _LOGGER.debug("Cleared slider gesture state for %s", key)
    _clear_selected_device(entry_id)
    # Page changes reset fixed-button overrides; resolve_fixed_action also
    # re-checks that the context button is still present.
    if _selected_button.pop(entry_id, None) is not None:
        _LOGGER.debug("Cleared fixed-button context for %s", entry_id)
    # Re-learn the page from the device after navigation/unload.
    _current_page.pop(entry_id, None)

