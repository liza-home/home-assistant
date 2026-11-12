"""Reading the tail of Home Assistant's log, our lines only.

Shared by the diagnostics bundle and the config entry diagnostics, so the two
cannot drift apart -- including the supervisor fallback, which is the normal
case rather than the exception: Home Assistant OS keeps no log file at all.
"""
from __future__ import annotations

import os

from aiohttp import ClientTimeout
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from ..const import DOMAIN

#: How much of `home-assistant.log` is read before filtering. The whole file can
#: be hundreds of megabytes on an installation that never rotates it, and the
#: lines that matter are at the end.
_LOG_TAIL_BYTES = 8 * 1024 * 1024

#: How much of the filtered result is kept. A remote in a reconnect loop writes
#: a great many lines that all say the same thing; the newest are the ones worth
#: carrying.
_LOG_KEEP_BYTES = 2 * 1024 * 1024

#: What makes a log line ours. The integration's loggers all live under the
#: domain, so the module name alone catches them -- and a line from elsewhere
#: that names the integration is usually about it.
LOG_NEEDLE = DOMAIN

#: How many journal lines the supervisor is asked for. Everything but our own
#: lines is dropped immediately afterwards, so this is a bound on what is
#: transferred, not on what is kept: a busy installation needs a wide net to
#: yield the same couple of thousand lizaip lines a file tail would.
_SUPERVISOR_LOG_LINES = 100_000


def filter_lines(text: str, needle: str = LOG_NEEDLE) -> str:
    """Keep only the lines that mention *needle*.

    The rest of the log belongs to other integrations and to the household —
    tokens in URLs, addresses, names of people — and none of it answers a
    question about a remote.

    The needle is the domain for an administrator and ``[this remote]`` for
    anybody else, which is why :mod:`..shared.logs` puts the name there.
    """
    needle = needle.lower()
    kept = "".join(
        line for line in text.splitlines(keepends=True) if needle in line.lower()
    )
    return kept[-_LOG_KEEP_BYTES:] if len(kept) > _LOG_KEEP_BYTES else kept


def read_raw_tail(path: str) -> str:
    """The end of one log file, unfiltered.

    Runs on an executor thread: the file is read, and on an installation that
    never rotates it that read is measured in megabytes.
    """
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        if size > _LOG_TAIL_BYTES:
            handle.seek(size - _LOG_TAIL_BYTES)
            # The seek lands mid-line; drop the remainder of it rather than
            # carry half a message.
            handle.readline()
        raw = handle.read()
    return raw.decode("utf-8", errors="replace")


def read_log_tail(path: str) -> str:
    """The end of one log file, filtered to the lines that mention us."""
    return filter_lines(read_raw_tail(path))


async def supervisor_log(hass: HomeAssistant) -> str | None:
    """The core log from the supervisor, for installations that keep no file.

    This is not a rare fallback — it is the normal case. Home Assistant OS and
    supervised installations log to the journal, and `/config/home-assistant.log`
    simply does not exist there (verified on our own test instance, which had
    only an empty `.fault` file). The file-only version of this section
    therefore reported "no log file" to exactly the users most likely to be
    asking for help.

    ``SUPERVISOR_TOKEN`` is in the core container's environment; its absence is
    how a Core or container installation identifies itself, and those are the
    ones that do have the file.
    """
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None

    session = async_get_clientsession(hass)
    async with session.get(
        "http://supervisor/core/logs",
        params={"lines": str(_SUPERVISOR_LOG_LINES)},
        headers={"Authorization": f"Bearer {token}"},
        timeout=ClientTimeout(total=30),
    ) as resp:
        if resp.status != 200:
            raise RuntimeError(f"supervisor answered HTTP {resp.status}")
        return await resp.text()
