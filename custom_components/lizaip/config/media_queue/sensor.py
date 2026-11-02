"""``sensor.<speaker>_queue`` -- what plays next, as an ordinary entity.

Once the queue is a sensor, ``${_queue.next_song}`` is an alias for one of its
attributes (see :mod:`.alias`), and from there it is an ordinary variable:
watched by the variable listener, throttled by the remote's own interval,
visible in Developer Tools.

There is one sensor per Sonos speaker a button points at, whichever remote
the button is on, and it goes away when the last button stops pointing at it.
The sensors describe speakers, not remotes, so they are added through any
loaded config entry; when that entry unloads, the next sync re-adds them
through another.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

from ...const import DOMAIN
from .alias import queue_entity_id
from .queue import NEXT_SONG, async_fetch, blank, reads_queue, resolve

_LOGGER = logging.getLogger(__name__)

#: The shortest gap between two fetches of one speaker's queue. Reading a
#: queue is a round trip to the speaker, and a busy player can change state
#: many times a second.
MIN_REFRESH_INTERVAL = 30.0

#: Where the live sensors (speaker -> sensor) and each loaded entry's
#: ``AddEntitiesCallback`` live in ``hass.data[DOMAIN]``. Underscore-prefixed
#: because the other keys there are config entry ids.
SENSORS_KEY = "_queue_sensors"
ADDERS_KEY = "_queue_adders"


class LizaIPQueueSensor(SensorEntity):
    """One speaker's queue, reduced to the tracks either side of the current."""

    _attr_should_poll = False
    _attr_icon = "mdi:playlist-music"
    _attr_has_entity_name = False

    def __init__(self, speaker: str, entry_id: str) -> None:
        self._speaker = speaker
        self.entry_id = entry_id
        self._attr_unique_id = f"{DOMAIN}_queue_{speaker}"
        # Fixed rather than derived from the name, because `${_queue.x}` is
        # rewritten to exactly this id (see `alias.queue_entity_id`).
        self.entity_id = queue_entity_id(speaker)
        self._attr_name = f"{speaker.split('.', 1)[-1].replace('_', ' ').title()} queue"
        self._tracks: list[dict[str, str]] | None = None
        self._held_size: Any = None
        self._values = blank()
        self._fetched_at = float("-inf")
        self._fetching = False
        self._unsubscribe: Any = None
        self._task: asyncio.Task | None = None
        self._removed = False

    @property
    def speaker(self) -> str:
        """The media player this sensor reads."""
        return self._speaker

    @property
    def native_value(self) -> str | None:
        """The next track's title, or None when there is nothing to name.

        None rather than "": an empty string is a value Home Assistant will
        happily keep and show, and "nothing plays next" is an absence.
        """
        return self._values.get(NEXT_SONG) or None

    @property
    def extra_state_attributes(self) -> dict[str, str]:
        return dict(self._values)

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._unsubscribe = async_track_state_change_event(
            self.hass, [self._speaker], self._on_speaker_change,
        )
        self._evaluate(write=False)

    async def async_will_remove_from_hass(self) -> None:
        # Removal is terminal: a fetch waiting out the rate limit would
        # otherwise keep asking a speaker this sensor no longer describes, and
        # keep itself alive doing it.
        self._removed = True
        if self._task is not None:
            self._task.cancel()
            self._task = None
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        await super().async_will_remove_from_hass()

    @callback
    def _on_speaker_change(self, event: Event) -> None:
        self._evaluate()

    @callback
    def _evaluate(self, write: bool = True, fetch: bool = True) -> None:
        """Recompute from the held copy, and ask for a new one if it is stale."""
        values, stale = resolve(self._attributes(), self._tracks, self._held_size)
        if stale and fetch:
            self._schedule_fetch()
        if values != self._values:
            self._values = values
            if write:
                self.async_write_ha_state()

    def _attributes(self) -> dict:
        state = self.hass.states.get(self._speaker)
        return dict(getattr(state, "attributes", None) or {})

    @callback
    def _schedule_fetch(self) -> None:
        """Fetch once, waiting out the rate limit rather than dropping the ask.

        Deferring rather than dropping matters: the state change that spotted
        the stale copy is consumed once, so a queue edited inside the interval
        would otherwise leave the sensor blank until something unrelated
        happened to change the speaker again.
        """
        if self._fetching or self._removed:
            return
        self._fetching = True
        waited = time.monotonic() - self._fetched_at
        try:
            # A background task, not a tracked one: this waits out the rate
            # limit, and bootstrap blocks on tracked tasks -- a cold start
            # spent 30 s on "Setup timed out for bootstrap waiting on".
            self._task = self.hass.async_create_background_task(
                self._async_fetch(max(0.0, MIN_REFRESH_INTERVAL - waited)),
                name=f"lizaip queue {self._speaker}",
            )
        except Exception as err:  # noqa: BLE001 - a tooltip must never raise
            self._fetching = False
            _LOGGER.debug("Queue sensor: cannot schedule a fetch for %s: %s",
                          self._speaker, err)

    async def _async_fetch(self, delay: float) -> None:
        """Read the queue into the held copy, then recompute.

        Failure is a blank sensor, never an error on the user's screen: a
        speaker off the network, a service that is not registered, or a shape
        that is not what was expected all leave the copy empty.
        """
        try:
            if delay:
                await asyncio.sleep(delay)
            if self._removed:
                return
            self._fetched_at = time.monotonic()
            tracks = await async_fetch(self.hass, self._speaker)
        except Exception as err:  # noqa: BLE001 - a tooltip must never raise
            _LOGGER.debug("Queue sensor: cannot read %s: %s", self._speaker, err)
            tracks = None
        finally:
            self._fetching = False
            self._task = None

        self._tracks = tracks
        # The length the speaker reports, not ``len(tracks)``: a queue longer
        # than the cut would otherwise never match and be refetched forever.
        self._held_size = self._attributes().get("queue_size") if tracks is not None else None
        # `fetch=False`: a copy still stale right after a fetch is one this
        # fetch could not mend, and re-arming from here would ask again every
        # interval forever, with no speaker change needed to keep it going.
        self._evaluate(fetch=False)


async def async_sync(hass: HomeAssistant, speakers: set[str]) -> None:
    """Make the live queue sensors match the Sonos speakers in *speakers*."""
    store = hass.data.get(DOMAIN, {})
    adders: dict = store.get(ADDERS_KEY) or {}
    if not adders:
        return
    sensors: dict[str, LizaIPQueueSensor] = store.setdefault(SENSORS_KEY, {})
    wanted = {s for s in speakers if reads_queue(hass, s)}
    for speaker in [s for s in sensors if s not in wanted]:
        await sensors.pop(speaker).async_remove(force_remove=True)
    entry_id, add_entities = next(iter(adders.items()))
    fresh = [LizaIPQueueSensor(s, entry_id) for s in wanted if s not in sensors]
    if fresh:
        sensors.update({sensor.speaker: sensor for sensor in fresh})
        add_entities(fresh)
    _LOGGER.debug("Queue sensors: %d live", len(sensors))


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Let *entry* add queue sensors; they are added once the targets are known."""
    hass.data.setdefault(DOMAIN, {}).setdefault(ADDERS_KEY, {})[entry.entry_id] = async_add_entities


def async_release(hass: HomeAssistant, entry_id: str) -> None:
    """Forget *entry*: its platform unload has just removed the sensors it added."""
    store = hass.data.get(DOMAIN, {})
    (store.get(ADDERS_KEY) or {}).pop(entry_id, None)
    sensors = store.get(SENSORS_KEY) or {}
    for speaker in [s for s, sensor in sensors.items() if sensor.entry_id == entry_id]:
        sensors.pop(speaker)
