"""The diagnostics bundle — everything a bug report needs, in one ZIP.

A report about a remote used to be assembled by hand out of four places: the
JSON behind the device page's *Download diagnostics*, a copy of the debug tab's
device report, whatever the reporter could find in `home-assistant.log`, and
the device's own log, which only a pre-release build could reach at all. Most
reports arrived with two of the four, and the follow-up asking for the rest cost
a day each time.

This builds all of it at once, as a ZIP a user can attach to a mail without
reading it first. Nothing here raises: the bundle is what someone reaches for
when the integration is already broken, so a section that fails is recorded in
`manifest.json` as having failed and the rest is still produced. A bundle that
says "the device did not answer" is a useful bundle — that is often the report.

What it contains is deliberately wider than the device page's JSON. That one
withholds the stored configuration because entity ids are the one genuinely
private thing in the store; this one carries it, because the user is choosing to
send it and a binding that points somewhere unexpected cannot be diagnosed from
a count. The panel says so before the download starts, and so does `README.txt`
inside the bundle.

Delivery is a two-step: a WebSocket command builds the ZIP and parks it under a
single-use token, and :class:`LizaIPDiagnosticsView` hands it to the browser.
Nothing is written to disk — a support bundle left lying in the config directory
is one nobody remembers deleting.
"""
from __future__ import annotations

import io
import json
import logging
import os
import platform
import re
import secrets
import sys
import textwrap
import time
import zipfile
from datetime import datetime, timezone
from typing import Any

from aiohttp import ClientTimeout, web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN
from .config.store import YAML_DIR
from .device import report as device_report
from .diagnostics import (
    _entities,
    async_get_config_entry_diagnostics,
    async_settings_snapshot,
)
from .runtime import _resolve_device_id

_LOGGER = logging.getLogger(__name__)

#: Bumped when the layout of the ZIP changes, so a bundle read months later can
#: be told apart from one built by a different version of this code.
BUNDLE_VERSION = 2

#: What a build may be asked for.
#:
#: ``config`` is a copy of the stored YAML and nothing else; ``standard`` is
#: the support bundle.
SCOPE_CONFIG = "config"
SCOPE_STANDARD = "standard"
SCOPES = (SCOPE_CONFIG, SCOPE_STANDARD)

#: The scope that collects more than the configuration, named once so a section
#: does not have to spell it out.
_SUPPORT = frozenset({SCOPE_STANDARD})
_ALL = frozenset(SCOPES)

#: Where the browser fetches a built bundle from.
BUNDLE_URL_BASE = "/api/lizaip/diagnostics"

#: How long a built bundle waits to be collected. Long enough for a slow
#: download to start, short enough that a user who closed the tab instead is not
#: holding a few megabytes in memory for the rest of the day.
BUNDLE_TTL = 600.0

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
_LOG_NEEDLE = DOMAIN

#: How many journal lines the supervisor is asked for. Everything but our own
#: lines is dropped immediately afterwards, so this is a bound on what is
#: transferred, not on what is kept: a busy installation needs a wide net to
#: yield the same couple of thousand lizaip lines a file tail would.
_SUPERVISOR_LOG_LINES = 100_000

#: Anything that is not a safe filename character. Endpoint paths become file
#: names inside the ZIP, and they arrive from a constant in `device.report`, but
#: a name is still built rather than pasted.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug(text: str) -> str:
    """A filename-safe fragment, or ``device`` when nothing survives."""
    return _UNSAFE.sub("_", (text or "").strip()).strip("_").lower() or "device"


def _dumps(payload: Any) -> bytes:
    """JSON a human will read in a text editor, not a parser.

    ``default=str`` rather than a custom encoder: the material here is whatever
    the device, the store and the registries happen to hold, and a bundle that
    failed to build because one value was a ``datetime`` would be worse than one
    carrying that value as its string.
    """
    return json.dumps(payload, indent=2, sort_keys=True, default=str).encode("utf-8")


class _Collector:
    """Gathers the bundle's files, remembering what would not come.

    A class rather than a pile of functions because every section needs the same
    two things — somewhere to put a file, and somewhere to record that it could
    not be built — and threading both through a dozen calls obscured which
    sections there are.
    """

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, scope: str = SCOPE_STANDARD
    ) -> None:
        self.hass = hass
        self.entry = entry
        #: Which build this is: the support bundle, or a copy of the stored
        #: configuration. Sections read it rather than being written twice.
        self.scope = scope
        self.files: dict[str, bytes] = {}
        self.skipped: list[dict[str, str]] = []
        #: What the remote's steps hand each other. The probe decides whether
        #: the endpoints are worth asking for, each endpoint leaves its answer
        #: here, and the report step writes the lot out as one file.
        self.device_conn: Any = None
        self.device_ready = False
        self.device_reason = "unreachable"
        self.device_probe: dict[str, Any] | None = None
        self.device_sections: dict[str, Any] = {}

    def add(self, name: str, data: bytes | str) -> None:
        self.files[name] = data.encode("utf-8") if isinstance(data, str) else data

    def skip(self, name: str, reason: str) -> None:
        self.skipped.append({"file": name, "reason": reason})

    async def section(self, name: str, factory) -> Any:
        """Run one section, and turn its failure into a line in the manifest.

        ``BLE001`` is the whole point: a section may fail in any way at all —
        a device half-way through a reboot, a store mid-migration, a registry
        entry that went away between two awaits — and none of those may cost the
        reporter the rest of the bundle.
        """
        try:
            return await factory()
        except Exception as err:  # noqa: BLE001 — diagnostics must never raise
            _LOGGER.debug("Diagnostics bundle: %s failed", name, exc_info=True)
            self.skip(name, f"{err.__class__.__name__}: {err}")
            return None


def _connection(entry: ConfigEntry):
    """The entry's live connection, or ``None`` if it has none yet."""
    return getattr(entry, "runtime_data", None)


async def _add_diagnostics(collector: _Collector) -> None:
    """The same JSON the device page's button produces.

    Runs after the remote's steps and is handed what they read, so the one file
    here that would otherwise repeat all nine requests makes none.
    """
    async def build() -> None:
        collector.add(
            "homeassistant/device_page.json",
            _dumps(await async_get_config_entry_diagnostics(
                collector.hass,
                collector.entry,
                probe=collector.device_probe,
                prefetched=collector.device_sections or None,
            )),
        )

    await collector.section("homeassistant/device_page.json", build)


async def _add_config_store(collector: _Collector) -> None:
    """The stored configuration, whole: pages, what is on them, the action library.

    Unredacted, unlike `diagnostics.json`. "The button does nothing" and "the
    wrong light comes on" are both questions about which entity a binding names,
    and a count of bindings answers neither.
    """
    async def build() -> None:
        hass, entry = collector.hass, collector.entry
        store = hass.data.get(DOMAIN, {}).get("_store")
        device_id = _resolve_device_id(hass, entry.entry_id)
        if store is None or not device_id:
            collector.skip("configuration/store.json", "No store or device id for this entry")
            return

        pages = await store.async_get_pages(device_id)
        assignments = await store.async_get_all_assignments(device_id)
        collector.add("configuration/store.json", _dumps({
            "device_id": device_id,
            "pages": pages,
            # Keys are page ids, which JSON cannot hold as integers.
            "assignments": {str(page_id): value for page_id, value in (assignments or {}).items()},
            "action_library": await store.async_get_action_library(device_id),
            "settings": await store.async_get_settings(device_id),
        }))

    await collector.section("configuration/store.json", build)


#: A single YAML file in a *diagnostics* bundle. Pages are a few kilobytes each;
#: the cap is there so a corrupted or hand-edited file cannot make the bundle
#: unmailable. The configuration download reads without one -- a truncated page
#: file does not parse, and that download exists to be copied back.
_MAX_YAML_BYTES = 1 * 1024 * 1024


def _read_yaml_tree(base: str, limit: int | None = _MAX_YAML_BYTES) -> dict[str, bytes]:
    """Read ``<config>/lizaip/<device_id>/`` into ``relative path -> bytes``.

    Bytes rather than text, and ``limit=None`` for a copy that has to be usable:
    decoding and truncating are both fine in a report and both fatal in a file
    somebody will put back.

    Backup siblings (``<device_id>.bak.*``) are outside ``base`` and so are
    never walked: they are previous copies of the same thing, and multiplying
    the bundle's size by the number of times someone pressed save adds nothing.
    """
    out: dict[str, bytes] = {}
    for root, dirs, names in os.walk(base):
        dirs.sort()
        for name in sorted(names):
            if not name.endswith((".yaml", ".yml")):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, base).replace(os.sep, "/")
            with open(path, "rb") as handle:
                raw = handle.read() if limit is None else handle.read(limit + 1)
            if limit is not None and len(raw) > limit:
                raw = raw[:limit] + b"\n... truncated ...\n"
            out[rel] = raw
    return out


async def _add_settings(collector: _Collector) -> None:
    """Everything configurable that is not a page: entry, fonts, icons, model.

    The device page reports the entry's data with anything secret-looking
    replaced; here it goes in whole, along with the options. The bundle exists
    because something is unexplained, and a redaction that hides the key which
    explains it defeats the point -- the file never leaves the mail the user
    sends us, where the device page's JSON is pasted into public issues.

    The rest comes from `diagnostics.async_settings_snapshot`, shared with the
    device page so the two cannot drift apart.
    """
    async def build() -> None:
        hass, entry = collector.hass, collector.entry
        settings: dict[str, Any] = {
            "entry": {
                "entry_id": entry.entry_id,
                "title": entry.title,
                "data": dict(entry.data),
                "options": dict(entry.options),
            },
            **await async_settings_snapshot(hass, entry),
        }
        collector.add("configuration/settings.json", _dumps(settings))

    await collector.section("configuration/settings.json", build)


async def _add_config_files(collector: _Collector) -> None:
    """The YAML the integration actually reads, copied as it sits on disk.

    In a diagnostics bundle this sits under `configuration/yaml/` beside
    `config_store.json`, the store's interpretation of the same files -- and if
    the bug is in the parsing, the interpretation is the one thing that cannot
    show it.

    A configuration download is only this, verbatim and at the root, so the
    folder it unpacks into can be copied back over the stored configuration.
    """
    where = "" if collector.scope == SCOPE_CONFIG else "configuration/yaml/"
    label = where or "yaml/"

    async def build() -> None:
        hass, entry = collector.hass, collector.entry
        device_id = _resolve_device_id(hass, entry.entry_id)
        if not device_id:
            collector.skip(label, "No device id for this entry")
            return

        base = hass.config.path(YAML_DIR, device_id)
        if not await hass.async_add_executor_job(os.path.isdir, base):
            collector.skip(label, f"No stored configuration at {base}")
            return

        limit = None if collector.scope == SCOPE_CONFIG else _MAX_YAML_BYTES
        files = await hass.async_add_executor_job(_read_yaml_tree, base, limit)
        if not files:
            collector.skip(label, "The stored configuration directory is empty")
            return
        for rel, raw in files.items():
            collector.add(f"{where}{rel}", raw)

    await collector.section(label, build)


def _endpoint_filename(endpoint: str) -> str:
    """``/api/config/ha`` → ``api_config_ha.txt``."""
    return f"{_slug(endpoint.strip('/').replace('/', '_'))}.txt"


#: The device log does not live with the other endpoints: it is one of the four
#: files a report is opened for, so it sits at the root beside the other three.
LOG_DEVICE = "log_device.txt"
LOG_HA = "log_homeassistant.txt"
LOG_MESSAGES = "log_messages.json"
LOG_ERRORS = "log_errors.json"


def _endpoint_path(endpoint: str) -> str:
    """Where one endpoint's body goes: the root for the log, `remote/` for the rest."""
    if endpoint == device_report.DEVICE_LOG_ENDPOINT:
        return LOG_DEVICE
    return f"remote/{_endpoint_filename(endpoint)}"


#: The step key each endpoint is announced under, so the progress window names
#: what is being fetched rather than standing on one row for eight requests.
#: Written out rather than derived from the path, because these are words a
#: user reads while they wait.
_ENDPOINT_STEPS = {
    "/api/info": "remote_info",
    "/api/config/ha": "remote_config_ha",
    "/api/config/wifi": "remote_wifi",
    "/Device/Status": "remote_status",
    "/Device/DeviceMetrics": "remote_metrics",
    "/Device/DeviceNvmMetrics": "remote_nvm",
    "/Device/LoggingSetup": "remote_logging",
    "/Device/DeviceLogs": "remote_logs",
}


def _endpoint_step(endpoint: str) -> str:
    """The step key for one endpoint, named if we have named it."""
    return _ENDPOINT_STEPS.get(endpoint, f"remote_{_slug(endpoint.strip('/'))}")


async def _add_reachability(collector: _Collector) -> None:
    """Whether the remote answers at all, and how quickly.

    First of the remote's steps, and the one that decides whether the rest are
    worth attempting: a remote that is not answering fails every one of the
    eight endpoints by timeout, at ten seconds each. Asking once and skipping
    the rest is the difference between five seconds and a minute and a half.
    """
    conn = _connection(collector.entry)
    collector.device_conn = conn
    if conn is None:
        collector.device_reason = "the entry has no connection object"
        collector.skip("remote/reachability.json", "The entry has no connection object")
        return

    probe = await collector.section(
        "remote/reachability.json",
        lambda: device_report.async_probe_reachability(conn, keep_body=True),
    )
    if probe is None:
        probe = {"reachable": False, "reason": "probe_failed"}
    # The body is the report's business; reachability is about whether and how
    # fast, and repeating a kilobyte of JSON under a second key helps nobody.
    body = probe.pop("body", None)
    collector.add("remote/reachability.json", _dumps(probe))
    collector.device_probe = probe

    collector.device_ready = bool(probe.get("reachable"))
    collector.device_reason = str(probe.get("reason", "unreachable"))
    if collector.device_ready and body:
        # The probe read `/api/info` to time it. Reading it again a moment
        # later measures nothing new and costs the user another request.
        collector.device_sections[device_report.INFO_ENDPOINT] = {
            "status": probe.get("status"), "body": body,
        }


def _add_endpoint(endpoint: str):
    """One step that fetches one of the remote's endpoints.

    One step each rather than one for all eight: this is nearly the whole wait,
    and a progress window that stands on "Device report" for ten seconds is
    indistinguishable from one that has hung.
    """
    path = _endpoint_path(endpoint)

    async def step(collector: _Collector) -> None:
        if not collector.device_ready:
            collector.skip(path, f"The remote did not answer its HTTP API ({collector.device_reason})")
            return
        if endpoint not in collector.device_sections:
            section = await collector.section(
                path,
                lambda: device_report.async_fetch_section(collector.device_conn, endpoint),
            )
            if section is None:
                return
            collector.device_sections[endpoint] = section
        text = collector.device_sections[endpoint].get("body")
        if isinstance(text, str) and text:
            collector.add(path, text)

    return step


async def _add_device_report(collector: _Collector) -> None:
    """The endpoints gathered into one file, plus the logging setup read out of it.

    Nothing is fetched here: the steps above did that. This is the summary a
    reader opens first -- every endpoint, its status and its body in one place
    -- and `remote/logging.json` is the one answer worth parsing rather than
    leaving as the device's own JSON.
    """
    if not collector.device_ready:
        for name in ("remote/report.json", "remote/logging.json"):
            collector.skip(name, f"The remote did not answer its HTTP API ({collector.device_reason})")
        return

    conn = collector.device_conn
    collector.add("remote/report.json", _dumps({
        "available": True,
        "peer_ip": getattr(conn, "peer_ip", None),
        "sections": collector.device_sections,
    }))

    section = collector.device_sections.get(device_report.LOGGING_ENDPOINT)
    if section is None:
        collector.skip("remote/logging.json", "The report did not reach the logging endpoint")
        return
    await collector.section("remote/logging.json", lambda: _add_logging(collector, section))


async def _add_logging(collector: _Collector, section: dict[str, Any]) -> None:
    """The device's logging setup, parsed. Separate so a bad body is one skip."""
    collector.add(
        "remote/logging.json",
        _dumps(device_report.logging_setup_from_section(section)),
    )


#: How much of the conversation with the remote a bundle keeps: everything the
#: recorder still has. The caps are the recorder's own -- a thousand frames and
#: the body of the last two hundred -- and a fault that takes twenty minutes to
#: reproduce leaves its cause outside any shorter window.
_MESSAGES_KEPT = 10_000


async def _add_traffic(collector: _Collector) -> None:
    """The WebSocket conversation with the remote: counters, frames and bodies.

    `bodies=True` is the point of this section. The counters say a request went
    unanswered; the frame says which one; only the body says what was in it —
    which page, which button, which entity, and what the remote objected to.

    Shipped builds carry the recorder now. It used to be stripped with the
    debug tab, which meant a bundle from a customer's build was silent about
    the one conversation most reports are about.
    """
    async def build() -> None:
        conn = _connection(collector.entry)
        protocol = getattr(conn, "_protocol", None)
        traffic = getattr(protocol, "traffic", None)
        snapshot = traffic.snapshot(_MESSAGES_KEPT, bodies=True) if traffic is not None else None
        if snapshot is None:
            collector.skip(LOG_MESSAGES, "This build ships without the traffic recorder")
            return
        collector.add(LOG_MESSAGES, _dumps({**snapshot, "connected": bool(conn.connected)}))

    await collector.section(LOG_MESSAGES, build)


def _filter_lines(text: str) -> str:
    """Keep only the lines that mention us.

    The rest of the log belongs to other integrations and to the household —
    tokens in URLs, addresses, names of people — and none of it answers a
    question about a remote.
    """
    needle = _LOG_NEEDLE
    kept = "".join(
        line for line in text.splitlines(keepends=True) if needle in line.lower()
    )
    return kept[-_LOG_KEEP_BYTES:] if len(kept) > _LOG_KEEP_BYTES else kept


def _read_raw_tail(path: str) -> str:
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


def _read_log_tail(path: str) -> str:
    """The end of one log file, filtered to the lines that mention us."""
    return _filter_lines(_read_raw_tail(path))


async def _supervisor_log(hass: HomeAssistant) -> str | None:
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


async def _add_ha_log(collector: _Collector) -> None:
    """Home Assistant's own log, from wherever it lives.

    The rotated file is included because a restart rotates the log, and the
    restart is frequently the event being asked about — the lines leading up to
    it would otherwise be the ones missing.

    Filtered to our own lines: the rest of the log is other integrations and
    the household, and none of it is ours to carry.
    """
    async def build() -> None:
        hass = collector.hass
        raw_chunks: list[tuple[str, str]] = []
        # Oldest first, so the result reads forwards.
        for name in ("home-assistant.log.1", "home-assistant.log"):
            path = hass.config.path(name)
            if not await hass.async_add_executor_job(os.path.isfile, path):
                continue
            raw_chunks.append(
                (name, await hass.async_add_executor_job(_read_raw_tail, path))
            )

        if not raw_chunks:
            journal = await _supervisor_log(hass)
            if journal is None:
                collector.skip(
                    LOG_HA,
                    "No log file, and no supervisor to ask — Home Assistant is "
                    "running without one",
                )
                return
            raw_chunks.append(("supervisor core log", journal))

        collector.add(LOG_HA, "\n".join(
            f"===== {name} =====\n{_filter_lines(text)}" for name, text in raw_chunks
        ))

    await collector.section(LOG_HA, build)


async def _add_system_log(collector: _Collector) -> None:
    """Every error and warning Home Assistant is currently holding.

    Not filtered to this integration: an error raised in a template or another
    integration is often what a button press actually ran into, and the count of
    how often it repeated is in here and nowhere else.
    """
    async def build() -> None:
        handler = collector.hass.data.get("system_log")
        records = getattr(handler, "records", None)
        if records is None:
            collector.skip(LOG_ERRORS, "The system_log integration is not loaded")
            return
        collector.add(LOG_ERRORS, _dumps(records.to_list()))

    await collector.section(LOG_ERRORS, build)


async def _add_debug_dumps(collector: _Collector) -> None:
    """What the debug tab can reach and a shipped build cannot.

    Only a build carrying the debug tooling has any of it, so the import is
    local and its absence is a skip rather than a failure to load this module.

    The device's debug port is the whole of it. Everything else the tab shows is
    already in a standard bundle: the report sections are in `remote/`, the log
    levels in `remote/logging.json`, the traffic in `log_messages.json`. The
    port's state is not, and it is the one that explains why a tab that normally
    answers was silent.
    """
    async def build() -> None:
        try:
            from .device import debug as device_debug
        except ImportError:
            collector.skip("debug/port.json", "This build ships without the debug tooling")
            return

        conn = _connection(collector.entry)
        if conn is None:
            collector.skip("debug/port.json", "The entry has no connection object")
            return

        collector.add("debug/port.json", _dumps(await device_debug.async_get_debug_port(conn)))

    await collector.section("debug/port.json", build)


async def _add_entities(collector: _Collector) -> None:
    """This entry's entities, with the state each is actually in."""
    async def build() -> None:
        collector.add("homeassistant/entities.json", _dumps(_entities(collector.hass, collector.entry)))

    await collector.section("homeassistant/entities.json", build)


def _integration_version() -> str | None:
    """The installed version, read from the manifest next to this file."""
    path = os.path.join(os.path.dirname(__file__), "manifest.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle).get("version")
    except (OSError, ValueError):
        return None


async def _add_environment(collector: _Collector) -> None:
    """Which versions of what produced this bundle.

    The first question asked of any report, and the one a screenshot never
    answers: Home Assistant's version, the integration's, and the Python it runs
    on — plus which other custom integrations are installed and how long our own
    setup took, both of which Home Assistant's own download carries.
    """
    async def build() -> None:
        hass = collector.hass
        version = await hass.async_add_executor_job(_integration_version)
        collector.add("homeassistant/environment.json", _dumps({
            "integration_version": version,
            "home_assistant_version": HA_VERSION,
            "python_version": sys.version,
            "platform": platform.platform(),
            "config_dir": hass.config.path(),
            "time_zone": str(hass.config.time_zone),
            "debug_tooling": _debug_tooling_present(),
            "custom_integrations": await _custom_integrations(hass),
            "setup_times": _setup_times(hass),
        }))

    await collector.section("homeassistant/environment.json", build)


async def _custom_integrations(hass: HomeAssistant) -> dict[str, Any]:
    """Which other custom integrations are installed, and in which version.

    Home Assistant's own diagnostics download carries this; it is the first
    thing to look at when a report works on one installation and not another.
    """
    # Imported here rather than at the top: neither lookup is worth a bundle
    # that fails to import on a Home Assistant that moved them.
    try:
        from homeassistant.loader import async_get_custom_components

        found = await async_get_custom_components(hass)
    except Exception as err:  # pragma: no cover - loader failures are not ours
        return {"error": str(err)}
    return {
        domain: {"version": str(obj.version), "requirements": obj.requirements}
        for domain, obj in sorted(found.items())
    }


def _setup_times(hass: HomeAssistant) -> dict[str, Any]:
    """How long this integration took to set up, phase by phase.

    Keys are stringified: the outer one is ``None`` for the integration itself,
    and ``sort_keys`` cannot order ``None`` against a config entry id.
    """
    try:
        from homeassistant.setup import async_get_domain_setup_times

        timings = async_get_domain_setup_times(hass, DOMAIN)
    except Exception as err:  # pragma: no cover - setup bookkeeping is not ours
        return {"error": str(err)}
    return {
        str(entry_id): {str(phase): seconds for phase, seconds in phases.items()}
        for entry_id, phases in timings.items()
    }


def _debug_tooling_present() -> bool:
    """Whether this build carries the pre-release debug tools.

    Asked by import rather than by version, for the same reason
    `config.websocket.debug_available` does: a tree we rsync to a test instance
    has the tools whatever its version string says.
    """
    import importlib.util

    return importlib.util.find_spec(f"{__package__}.config.debug_websocket") is not None


#: What each file in the bundle is, in reading order. A table rather than a
#: paragraph so the README can be filtered to the files actually collected. A
#: name ending in ``/`` stands for the group rather than any one file.
_INVENTORY: tuple[tuple[str, str], ...] = (
    ("summary.txt", "One page: what the remote is, whether it was answering, "
                    "and what is missing from this bundle. Read this first."),
    ("manifest.json", "What this bundle is, and anything that could not be "
                      "collected, with the reason."),
    (LOG_HA, "Lines from Home Assistant's log that mention lizaip. Lines "
             "belonging to other integrations are left out. On Home Assistant "
             "OS, which keeps no log file, this comes from the supervisor."),
    (LOG_DEVICE, "The remote's own log, as it reports it."),
    (LOG_MESSAGES, "Messages between Home Assistant and the remote, including "
                   "the content of the most recent ones."),
    (LOG_ERRORS, "The errors and warnings Home Assistant is holding."),
    ("remote/report.json", "The remote's read-only endpoints, with the HTTP "
                           "status of each."),
    ("remote/", "The body of each of those endpoints on its own."),
    ("remote/logging.json", "Which of the remote's modules log, and at what "
                            "level."),
    ("remote/reachability.json", "Whether its HTTP API answered, and how fast."),
    ("configuration/store.json", "The configuration of this remote in full: "
                                 "its pages, what each button is bound to, and "
                                 "the action library."),
    ("configuration/settings.json", "Everything configurable that is not a "
                                    "page: the config entry's data and options "
                                    "in full, installed fonts, icon rendering "
                                    "settings, the custom icon sets in use, the "
                                    "model's blueprint and available layouts."),
    ("configuration/yaml/", "The same configuration as it sits on disk, copied "
                            "verbatim, including the page files."),
    ("homeassistant/entities.json", "This remote's entities and their current "
                                    "state."),
    ("homeassistant/environment.json", "Versions: Home Assistant, this "
                                       "integration, Python, every other custom "
                                       "integration, and our setup times."),
    ("homeassistant/device_page.json", "The same report the device page's "
                                       '"Download diagnostics" button produces.'),
    ("debug/port.json", "Whether the remote's debug port is open."),
)

#: Where the description column starts. Wide enough for every path above and no
#: wider, so the text block stays readable in a plain editor.
_INVENTORY_COLUMN = 34


def _inventory(collector: _Collector) -> str:
    """The "what is in here" block, filtered to the files that were collected."""
    lines: list[str] = []
    for name, description in _INVENTORY:
        if name.endswith("/"):
            present = any(
                file.startswith(name) and file not in dict(_INVENTORY)
                for file in collector.files
            )
            label = f"{name}*"
        else:
            present = name in collector.files
            label = name
        if not present:
            continue

        body = textwrap.wrap(description, 78 - _INVENTORY_COLUMN)
        pad = " " * _INVENTORY_COLUMN
        head = f"  {label}".ljust(_INVENTORY_COLUMN)
        if len(head) > _INVENTORY_COLUMN:
            lines.append(f"  {label}")
            head = pad
        lines.append(f"{head}{body[0]}")
        lines.extend(f"{pad}{line}" for line in body[1:])
    return "\n".join(lines)


def _readme(collector: _Collector, created: str) -> str:
    """The README, with its inventory built from what is actually in the ZIP."""
    privacy = _PRIVACY_FULL
    return _README.format(
        created=created,
        title=collector.entry.title,
        scope=collector.scope,
        inventory=_inventory(collector),
        privacy=privacy,
    )


_PRIVACY_FULL = """\
configuration/ names the entities your buttons act on -- the lights, media
players and scripts in your home, by their entity ids. That is what makes a
misbehaving button diagnosable, and it is the one part of this bundle that says
anything about your household. log_messages.json carries the messages exchanged
with the remote, which name the same entities. The Home Assistant log here is
filtered to lines mentioning lizaip, so other integrations' messages are not
included.\
"""


_README = """\
lizaIP diagnostics bundle
=========================

Created: {created}
Device:  {title}
Scope:   {scope}

This was produced in one step by the lizaIP panel so it can be sent to support.
It describes one remote and the Home Assistant it is attached to.

What is in here
---------------

{inventory}

Please read before sending
--------------------------

{privacy}
"""


_SUMMARY = """\
lizaIP diagnostics -- summary
=============================

Created:   {created}
Device:    {title}
Entry:     {entry_id}
Scope:     {scope}

Remote
------
{remote}

Home Assistant
--------------
{environment}

Configuration
-------------
{configuration}

Not collected
-------------
{skipped}

The rest of this bundle is described in README.txt.
"""


def _summary_lines(collector: _Collector) -> dict[str, str]:
    """A page of prose over what the sections produced.

    Everything here is already somewhere in the bundle. It is repeated because
    the first question about any report is "what am I looking at, and was the
    remote even answering" — and answering it currently means opening four JSON
    files and knowing which keys to look for.

    Read back out of the collected files rather than kept alongside as the
    sections run: a summary built from a parallel set of variables is a summary
    that can disagree with the bundle it describes.
    """
    def load(name: str) -> Any:
        raw = collector.files.get(name)
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    out: list[str] = []
    probe = load("remote/reachability.json")
    if probe is None:
        out.append("  (not collected -- this bundle covers the configuration only)")
    elif probe.get("reachable"):
        out.append(f"  HTTP API:      answering ({probe.get('elapsed_ms', '?')} ms)")
    else:
        out.append(f"  HTTP API:      no answer ({probe.get('reason', 'unknown')})")

    traffic = load(LOG_MESSAGES) or {}
    if "connected" in traffic:
        out.append(f"  Connection:    {'connected' if traffic['connected'] else 'not connected'}")
    frames = traffic.get("frames")
    if isinstance(frames, list):
        out.append(f"  Messages kept: {len(frames)}")

    report = load("remote/report.json") or {}
    sections = report.get("sections") or {}
    if sections:
        bad = [ep for ep, sec in sections.items() if sec.get("status") != 200]
        out.append(f"  Endpoints:     {len(sections) - len(bad)}/{len(sections)} answered 200")
        for endpoint in bad:
            out.append(f"                 {endpoint}: {sections[endpoint].get('status') or sections[endpoint].get('error')}")

    environment = load("homeassistant/environment.json") or {}
    env_lines = [f"  {key}: {value}" for key, value in sorted(environment.items())] or ["  (not collected)"]

    config: list[str] = []
    store = load("configuration/store.json") or {}
    pages = store.get("pages")
    if isinstance(pages, list):
        config.append(f"  Pages:         {len(pages)}")
    assignments = store.get("assignments")
    if isinstance(assignments, dict):
        config.append(f"  Bound buttons: {sum(len(v or {}) for v in assignments.values())}")
    library = store.get("action_library")
    if isinstance(library, list):
        config.append(f"  Actions:       {len(library)}")
    yaml_files = [name for name in collector.files if name.startswith("configuration/yaml/")]
    config.append(f"  YAML files:    {len(yaml_files)}")
    entities = load("homeassistant/entities.json")
    if isinstance(entities, list):
        config.append(f"  Entities:      {len(entities)}")

    skipped = [f"  {item['file']}: {item['reason']}" for item in collector.skipped] or ["  (nothing)"]

    return {
        "remote": "\n".join(out),
        "environment": "\n".join(env_lines),
        "configuration": "\n".join(config),
        "skipped": "\n".join(skipped),
    }


#: The sections, in the order they run: the key the panel translates into a line
#: of text, the function, and the scopes it belongs to. Declared rather than
#: inferred from the call sequence, so the panel can show the whole list before
#: the first one finishes and tick them off as they go.
BUNDLE_STEPS: tuple[tuple[str, Any, frozenset[str]], ...] = ()  # filled in below


def steps_for_scope(scope: str) -> tuple[tuple[str, Any], ...]:
    """The sections one scope runs, in order.

    The panel asks for this list too, through the websocket, so the steps it
    draws are the steps that will run rather than a copy of the table kept in
    JavaScript.
    """
    return tuple((key, section) for key, section, scopes in BUNDLE_STEPS if scope in scopes)


class BundleAbandoned(Exception):
    """Raised when the caller that asked for a bundle has gone away."""


async def async_build_bundle(
    hass: HomeAssistant,
    entry: ConfigEntry,
    *,
    scope: str = SCOPE_STANDARD,
    progress: Any = None,
    should_stop: Any = None,
) -> dict[str, bytes]:
    """Collect every file the bundle holds, for one config entry.

    Sections run one after another rather than together: several of them talk to
    the same small embedded device over HTTP, and the point of this is to report
    on the remote, not to load-test it.

    ``progress`` is called with ``(step_key, index, total)`` before each section
    starts. The build takes the better part of ten seconds, nearly all of it
    waiting on the remote, and a button that simply stops responding for that
    long reads as a broken button.

    ``should_stop`` is asked the same question between sections. Nobody will
    ever see a bundle whose browser has closed, and the remote has better uses
    for the next eight requests.
    """
    if scope not in _ALL:
        raise ValueError(f"Unknown diagnostics scope {scope!r}")

    collector = _Collector(hass, entry, scope)
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")

    steps = steps_for_scope(scope)
    total = len(steps)
    for index, (key, section) in enumerate(steps):
        if should_stop is not None and should_stop():
            raise BundleAbandoned(f"Nobody is waiting for this bundle any more (at {key})")
        if progress is not None:
            progress(key, index, total)
        await section(collector)

    if progress is not None:
        progress("packing", total, total)

    # A configuration download is the stored files and nothing besides. A
    # README and a manifest would make it a report about a configuration
    # rather than a copy of one, and the folder has to be copyable back.
    if scope == SCOPE_CONFIG:
        return collector.files

    collector.add("README.txt", _readme(collector, created))
    # Last, so they can describe what the sections actually produced.
    collector.add("summary.txt", _SUMMARY.format(
        created=created,
        title=entry.title,
        entry_id=entry.entry_id,
        scope=scope,
        **_summary_lines(collector),
    ))
    collector.add("manifest.json", _dumps({
        "bundle_version": BUNDLE_VERSION,
        "scope": scope,
        "created": created,
        "entry_id": entry.entry_id,
        "entry_title": entry.title,
        "files": sorted(collector.files),
        "skipped": collector.skipped,
    }))
    return collector.files


BUNDLE_STEPS = (
    ("config", _add_config_store, _SUPPORT),
    ("settings", _add_settings, _SUPPORT),
    ("config_files", _add_config_files, _ALL),
    ("reachability", _add_reachability, _SUPPORT),
    *((_endpoint_step(endpoint), _add_endpoint(endpoint), _SUPPORT)
      for endpoint in device_report.REPORT_ENDPOINTS),
    ("device", _add_device_report, _SUPPORT),
    ("diagnostics", _add_diagnostics, _SUPPORT),
    ("entities", _add_entities, _SUPPORT),
    ("environment", _add_environment, _SUPPORT),
    ("ha_log", _add_ha_log, _SUPPORT),
    ("system_log", _add_system_log, _SUPPORT),
    ("traffic", _add_traffic, _SUPPORT),
    ("debug", _add_debug_dumps, _SUPPORT),
)


def _zip_bytes(files: dict[str, bytes], root: str) -> bytes:
    """Pack the files into a ZIP, under a single top-level directory.

    A directory rather than loose files: a bundle that unpacks into eleven
    entries in whichever folder the reader happened to be in is a bundle they
    will not open twice.

    Deflate throughout — the device log is terminal output and compresses to a
    fraction of itself, which is the difference between an attachment that sends
    and one that bounces.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            archive.writestr(f"{root}/{name}", files[name])
    return buffer.getvalue()


#: What a bundle of each scope is called. The name is the first thing anyone
#: sees of it -- in a mail client, months later -- so it says which of the three
#: it is rather than leaving that to be read out of the manifest.
_ZIP_PREFIX = {
    SCOPE_CONFIG: "lizaip-config",
    SCOPE_STANDARD: "lizaip-diagnostics",
}


async def async_build_zip(
    hass: HomeAssistant,
    entry: ConfigEntry,
    *,
    scope: str = SCOPE_STANDARD,
    progress: Any = None,
    should_stop: Any = None,
) -> tuple[str, bytes]:
    """Build the bundle and return ``(filename, zip bytes)``.

    The compression runs on an executor thread. It is CPU-bound over a few
    hundred kilobytes, and the event loop has a remote to answer in the meantime.
    """
    files = await async_build_bundle(
        hass, entry, scope=scope, progress=progress, should_stop=should_stop,
    )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"{_ZIP_PREFIX[scope]}-{_slug(entry.title)}-{stamp}"
    # A configuration download unpacks into the device id, which is the name
    # the folder has to carry to be dropped back into `<config>/lizaip/`. The
    # ZIP itself still says whose it is and when, so copies do not collide.
    root = name
    if scope == SCOPE_CONFIG:
        root = _resolve_device_id(hass, entry.entry_id) or name
    data = await hass.async_add_executor_job(_zip_bytes, files, root)
    return f"{name}.zip", data


def _bundles(hass: HomeAssistant) -> dict[str, tuple[float, str, bytes]]:
    """The built-but-not-yet-downloaded bundles, by token."""
    return hass.data.setdefault(DOMAIN, {}).setdefault("_bundles", {})


def async_store_bundle(hass: HomeAssistant, filename: str, data: bytes) -> str:
    """Park a built bundle and return the token the browser fetches it with.

    Expired bundles are dropped here rather than on a timer: a build is the only
    moment at which one more can appear, so it is also the only moment at which
    the set can be left holding something nobody will come for. A user who
    closes the tab instead of saving the file costs a few megabytes until the
    next build, not until the next restart.
    """
    now = time.monotonic()
    bundles = _bundles(hass)
    for token in [t for t, (expires, _, _) in bundles.items() if expires <= now]:
        del bundles[token]

    token = secrets.token_urlsafe(32)
    bundles[token] = (now + BUNDLE_TTL, filename, data)
    return token


class LizaIPDiagnosticsView(HomeAssistantView):
    """Hand one built bundle to the browser, once.

    Admin-only and single-use. The token is unguessable and short-lived, but
    neither of those is the protection — the authenticated admin check is, and
    the token exists so that a URL which has already served its file cannot
    serve it again to whatever the browser's history syncs to.
    """

    url = BUNDLE_URL_BASE + "/{token}"
    name = "lizaip:diagnostics"
    requires_auth = True

    async def get(self, request: web.Request, token: str) -> web.StreamResponse:
        """Return the bundle named by *token*, or 404 once it is gone."""
        if not request["hass_user"].is_admin:
            return web.Response(status=401)

        hass = request.app["hass"]
        entry = _bundles(hass).pop(token, None)
        if entry is None:
            return web.Response(status=404)

        expires, filename, data = entry
        if expires <= time.monotonic():
            return web.Response(status=404)

        return web.Response(
            body=data,
            content_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


def async_setup_diagnostics_bundle(hass: HomeAssistant) -> None:
    """Register the download view. Called once, from the integration's setup."""
    hass.http.register_view(LizaIPDiagnosticsView)
