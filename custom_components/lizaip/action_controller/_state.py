"""What the action controller remembers about each remote between events.

One :class:`RemoteState` per config entry. Kept in one leaf module so the
executor, dispatcher and recorder cannot drift apart.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

_LOGGER = logging.getLogger(__name__)


#: Pages are 1-based; a page dict missing "id" is treated as the first page.
_DEFAULT_PAGE_ID = 1

#: Coalesce bursty state/attribute changes into one icon update.
_STATE_DEBOUNCE_SECONDS = 0.2

#: The longest a change may sit unsent while changes keep arriving.
#:
#: The debounce above is a *trailing* one: every new event cancels the pending
#: flush and starts the wait again. That is right for a burst with an end --
#: one logical transition reported as several attribute writes -- but a dimmer
#: being held has no end, so the deadline was pushed out on every frame and the
#: icon froze at whatever it showed when the ramp started, only catching up once
#: the user let go. Capping the wait turns that into a steady ~5 updates/sec.
#:
#: Measured, so please do not "optimise" this downwards without re-measuring.
#: Once icon pushes were serialised (see `config/icon_push.py`) the obvious next
#: move looked like halving this to push twice as often. The hardware says no:
#: over a 168-step ramp the device answered a `set_page` in 280 ms on average,
#: a ceiling of ~3.6 round-trips/sec, while this cap already permits ~10/sec
#: (~5 flushes, and a lamp commonly owns a button on two pages). Demand already
#: exceeds the device by roughly 3x, so the limiter is the device, not this
#: number. Halving it would ask for ~20/sec against the same ceiling: the
#: surplus is coalesced away, buying no freshness and burning CPU in a hot path.
_STATE_MAX_WAIT_SECONDS = 0.2

#: Only ``touch`` and ``click`` select; ``release`` trails click and ``repeat`` floods.
_SELECTING_INTERACTIONS: frozenset[str] = frozenset({"touch", "click"})

# Stale gestures are abandoned so the next touch cannot use an old zero-point.
SLIDER_GESTURE_TIMEOUT = 5.0


@dataclass
class RemoteState:
    """What the action controller remembers about one remote between events.

    Created on the remote's first event and dropped by :func:`forget_remote`
    when its config entry unloads. Leaving a page (:meth:`leave_page`) resets
    everything that only makes sense on the page that was showing.
    """

    #: Last known page. Used to infer unannounced page changes and as
    #: ``_coerce_page_id``'s fallback.
    current_page: int | None = None
    #: Fixed-button context: the grid button key the fixed buttons act on.
    #: Grid keys only; fixed buttons never become their own context.
    selected_button: str | None = None
    #: The slider's target, its chosen control and its sensitivity. Always
    #: set and cleared together (see :meth:`clear_selection`). The control is a
    #: choice, never mechanics: ranges resolve from live state at gesture time.
    selected_entity: str | None = None
    selected_control: str | None = None
    selected_factor: float | None = None
    #: In-flight slider gestures: slider key → ``{base_value, zero_pos,
    #: last_pos, ts, resolved}``.
    slider_touches: dict[str, dict] = field(default_factory=dict)
    #: Touches being timed on buttons with a long touch: button key →
    #: ``longtouch._Gesture``.
    button_gestures: dict[str, Any] = field(default_factory=dict)
    #: Cycle position per cycling button: ``(page_id, button_key)`` → index.
    #:
    #: The index of the step the **next** press will run, not the one the last
    #: press ran. Stated that way because it is the value the device tile draws:
    #: a cycling button has no state to read back, so the only honest thing it
    #: can show is what pressing it will do.
    #:
    #: Runtime-only, and that is a decision rather than an omission. Nothing can
    #: be read back from an IR target to resync a persisted position, so a
    #: position restored from disk would be a confident claim about a device
    #: that may have been used with its own remote in the meantime. It also
    #: keeps ``toggle`` purely declarative on disk, so the page hash never
    #: moves because somebody pressed a button.
    #:
    #: Keyed by page as well as button because two pages built from one layout
    #: share button keys. Kept across page changes on purpose: navigating away
    #: from a transport page and back should not put the button back on *play*.
    cycle_positions: dict[tuple[int, str], int] = field(default_factory=dict)

    def clear_selection(self) -> None:
        """Clear the selected entity, control and factor together.

        A control id must not outlive its entity (for example, colour
        temperature applied to a speaker), and a per-button factor must not
        survive into the next selection with no visible reason.
        """
        self.selected_entity = None
        self.selected_control = None
        self.selected_factor = None

    def leave_page(self) -> None:
        """Forget everything that belonged to the page that was showing.

        Called when gestures can no longer be trusted: page changes announced
        by ``_on_device_event``, inferred by ``_page_changed``, commanded via
        ``LizaIPConnection.goto_page``, and unload. Dropped devices have no
        hook here; ``SLIDER_GESTURE_TIMEOUT`` is the backstop.
        """
        self.slider_touches.clear()
        self.clear_selection()
        # A touch on a button no longer on screen will not be released there.
        for gesture in self.button_gestures.values():
            gesture.cancel()
        self.button_gestures.clear()
        # Page changes reset fixed-button overrides; resolve_fixed_action also
        # re-checks that the context button is still present.
        self.selected_button = None
        # Re-learn the page from the device after navigation/unload.
        self.current_page = None


_remotes: dict[str, RemoteState] = {}


def remote_state(entry_id: str) -> RemoteState:
    """The state of *entry_id*'s remote, created on first use."""
    return _remotes.setdefault(entry_id, RemoteState())


def forget_remote(entry_id: str) -> None:
    """Drop everything remembered about a remote whose entry unloads.

    Cycle positions go too: a reload must not resume a conversation with a
    device that is no longer configured.
    """
    state = _remotes.pop(entry_id, None)
    if state is not None:
        state.leave_page()
        _LOGGER.debug("Forgot the runtime state of %s", entry_id)


def cycle_index(entry_id: str, page_id: int, button_key: str, length: int) -> int:
    """The index *this* press should run, wrapped into a list of *length*.

    Pure: it advances nothing. The reader for the device tile and the reader
    for the press itself ask the same question, and only one of them is allowed
    to have a side effect — otherwise merely repainting an icon would skip a
    step.

    Wrapping happens on read rather than on write so that shortening the rule
    list in the panel cannot leave a stored index pointing past its end.
    """
    if length <= 0:
        return 0
    return remote_state(entry_id).cycle_positions.get((page_id, button_key), 0) % length


def advance_cycle(entry_id: str, page_id: int, button_key: str, length: int) -> int:
    """Move *button_key* on to the next step and return the new index.

    Called once per press, after the step to run has been read. The returned
    value is what the tile should now draw — the next press's step.
    """
    if length <= 0:
        return 0
    positions = remote_state(entry_id).cycle_positions
    key = (page_id, button_key)
    nxt = (positions.get(key, 0) + 1) % length
    positions[key] = nxt
    _LOGGER.debug("Cycle %s/%s now at step %s of %s", entry_id, key, nxt, length)
    return nxt


def get_current_page(entry_id: str) -> int | None:
    return remote_state(entry_id).current_page


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
    previous = remote_state(entry_id).current_page
    return previous is not None and previous != page_id


def _note_page(entry_id: str, page_id: int | None) -> None:
    """Record a usable page, leaving the fallback untouched for unset values."""
    if page_id:
        remote_state(entry_id).current_page = page_id


def get_selected_control(entry_id: str) -> str | None:
    return remote_state(entry_id).selected_control


def get_selected_factor(entry_id: str) -> float | None:
    return remote_state(entry_id).selected_factor


def get_selected_entity(entry_id: str) -> str | None:
    return remote_state(entry_id).selected_entity


def get_selected_button(entry_id: str) -> str | None:
    return remote_state(entry_id).selected_button


def _live_touch(state_key: tuple[str, str], *, pop: bool = False) -> dict | None:
    """Return the live gesture, dropping stale state on the way out."""
    entry_id, slider_key = state_key
    touches = remote_state(entry_id).slider_touches
    touch = touches.get(slider_key)
    if not touch:
        return None
    if time.monotonic() - touch.get("ts", 0.0) > SLIDER_GESTURE_TIMEOUT:
        _LOGGER.debug("Slider gesture %s expired — treating next touch as fresh", state_key)
        touches.pop(slider_key, None)
        return None
    if pop:
        touches.pop(slider_key, None)
    return touch


def _drop_touch(state_key: tuple[str, str]) -> None:
    """End the slider gesture *state_key*, live or not."""
    entry_id, slider_key = state_key
    remote_state(entry_id).slider_touches.pop(slider_key, None)


def _slider_gesture_active(state_key: tuple[str, str]) -> bool:
    return _live_touch(state_key) is not None


def clear_slider_state(entry_id: str) -> None:
    """The remote left its page: drop gestures, selection and fixed-button context."""
    state = _remotes.get(entry_id)
    if state is not None:
        state.leave_page()
        _LOGGER.debug("Cleared page state for %s", entry_id)
