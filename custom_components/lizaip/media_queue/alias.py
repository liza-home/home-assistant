"""``${_queue.next_song}`` -- a shorthand, not a token.

The four queue values live on a sensor (see :mod:`.sensor`), so they are
already readable as ``${sensor.kitchen_queue.next_song}``. That spelling is
correct and nobody would type it, so ``${_queue.x}`` is rewritten to it before
anything else looks at the text, exactly as ``${_device.x}`` is. From there it
is an ordinary variable: the variable listener subscribes to it and the
remote's Variables switch silences it. A speaker without a queue sensor names
an entity that does not exist, which reads as nothing like any other variable.
"""

from __future__ import annotations

import re
from typing import Final

from .queue import QUEUE_KEYS

#: ``${_queue.next_song}`` and its three siblings, nothing else. Spelt out
#: rather than ``\w+`` so a typo stays visible instead of silently blanking.
QUEUE_ALIAS_RE: Final = re.compile(
    rf"\$\{{\s*_queue\.({'|'.join(QUEUE_KEYS)})\s*\}}",
    re.IGNORECASE,
)


#: ``${_device.media_title_prev}`` and friends: the page's player's queue, read
#: as if the neighbouring tracks were attributes of the player itself.
DEVICE_QUEUE_ATTRIBUTES: Final = {
    "media_title_prev": "prev_song",
    "media_title_next": "next_song",
    "media_artist_prev": "prev_artist",
    "media_artist_next": "next_artist",
}


def device_attribute(entity_id: str, attribute: str) -> str:
    """``entity.attribute`` -- or, for a queue name above, its queue sensor's."""
    mapped = DEVICE_QUEUE_ATTRIBUTES.get(attribute.lower())
    return f"{queue_entity_id(entity_id)}.{mapped}" if mapped else f"{entity_id}.{attribute}"


def queue_entity_id(speaker: str) -> str:
    """*speaker*'s queue sensor: ``media_player.kitchen`` -> ``sensor.kitchen_queue``."""
    return f"sensor.{speaker.split('.', 1)[-1]}_queue" if speaker else ""


def expand_queue_alias(text, speaker: str | None):
    """Rewrite ``${_queue.x}`` to *speaker*'s queue sensor; blank with no speaker."""
    if not isinstance(text, str) or "${" not in text or not QUEUE_ALIAS_RE.search(text):
        return text
    entity_id = queue_entity_id(speaker or "")
    if not entity_id:
        return QUEUE_ALIAS_RE.sub("", text)
    return QUEUE_ALIAS_RE.sub(lambda m: f"${{{entity_id}.{m.group(1).lower()}}}", text)
