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

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..const import CONF_ASSIGNED_USERS, DOMAIN
from .access import can_access_entry
from .log_tail import LOG_NEEDLE, filter_lines, read_raw_tail, supervisor_log
from .store import YAML_DIR
from ..device import report as device_report
from ..diagnostics import (
    _entities,
    async_get_config_entry_diagnostics,
    async_settings_snapshot,
)
from ..runtime import debug_available, entry_connection, find_store, resolve_device_id
from ..data import lizaip_data
from ..shared.logs import device_logger
from ..shared.theme import USER_THEMES_SUBDIR, user_themes_dir

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
        self, hass: HomeAssistant, entry: ConfigEntry, scope: str = SCOPE_STANDARD,
        *, whole_system: bool = True,
    ) -> None:
        self.hass = hass
        self.entry = entry
        self._log = device_logger(_LOGGER, entry)
        #: Which build this is: the support bundle, or a copy of the stored
        #: configuration. Sections read it rather than being written twice.
        self.scope = scope
        #: Whether the three sections that are not about one remote may be
        #: collected whole. False for somebody holding a single remote: the
        #: rest of the bundle is already theirs alone, these three are not.
        self.whole_system = whole_system
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
            self._log.debug("Diagnostics bundle: %s failed", name, exc_info=True)
            self.skip(name, f"{err.__class__.__name__}: {err}")
            return None


def _without_assignments(options: dict[str, Any], whole_system: bool) -> dict[str, Any]:
    """Drop who a remote is assigned to from a bundle narrowed to one remote.

    The entry's options go in whole everywhere else, deliberately, so an option
    added later cannot go missing from diagnostics. This is the one exception:
    `websocket/devices.py` withholds the assignment list from somebody who is
    not an administrator, and a bundle they build must not hand back what the
    panel refused them. An administrator's bundle still carries it.
    """
    if whole_system:
        return options
    return {k: v for k, v in options.items() if k != CONF_ASSIGNED_USERS}


def _narrowed_payload(payload: dict[str, Any], whole_system: bool) -> dict[str, Any]:
    """The device page's JSON with its installation-wide parts taken out.

    Neither log is about one remote: `log` is every lizaIP line Home Assistant
    wrote, `system_log` every fault it holds for the integration. The summary
    counts them, so those counts go too.
    """
    if whole_system:
        return payload
    payload = {k: v for k, v in payload.items() if k not in ("log", "system_log")}
    summary = payload.get("summary")
    if isinstance(summary, dict):
        payload["summary"] = {
            k: v for k, v in summary.items()
            if k not in ("ha_log_lines", "ha_log_source", "errors_held")
        }
    return payload


async def _add_diagnostics(collector: _Collector) -> None:
    """The same JSON the device page's button produces.

    Runs after the remote's steps and is handed what they read, so the one file
    here that would otherwise repeat all nine requests makes none.
    """
    async def build() -> None:
        payload = await async_get_config_entry_diagnostics(
            collector.hass,
            collector.entry,
            probe=collector.device_probe,
            prefetched=collector.device_sections or None,
        )
        entry_facts = payload["entry"]
        entry_facts["options"] = _without_assignments(
            entry_facts["options"], collector.whole_system
        )
        collector.add(
            "homeassistant/device_page.json",
            _dumps(_narrowed_payload(payload, collector.whole_system)),
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
        store = find_store(hass)
        device_id = resolve_device_id(hass, entry.entry_id)
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

    Scratch siblings a restore can leave behind (``<device_id>.conflict.*``)
    are outside ``base`` and so are never walked: they are a copy of the same
    thing, and a bundle is about the configuration that is live.
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
                "options": _without_assignments(
                    dict(entry.options), collector.whole_system
                ),
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
        device_id = resolve_device_id(hass, entry.entry_id)
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
        for name, raw in (
            await hass.async_add_executor_job(_read_user_themes, hass, limit)
        ).items():
            collector.add(f"{where}{USER_THEMES_SUBDIR[-1]}/{name}", raw)

    await collector.section(label, build)


def _read_user_themes(hass: HomeAssistant, limit: int | None) -> dict[str, bytes]:
    """The user's own theme files, by name. Blocking.

    They sit beside the device folders rather than inside one, so a download
    that left them out would restore a remote onto a theme that is not there.
    """
    return _read_yaml_tree(user_themes_dir(hass), limit)


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
    conn = entry_connection(collector.entry)
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
        conn = entry_connection(collector.entry)
        protocol = getattr(conn, "protocol", None)
        traffic = getattr(protocol, "traffic", None)
        snapshot = traffic.snapshot(_MESSAGES_KEPT, bodies=True) if traffic is not None else None
        if snapshot is None:
            collector.skip(LOG_MESSAGES, "This build ships without the traffic recorder")
            return
        collector.add(LOG_MESSAGES, _dumps({**snapshot, "connected": bool(conn.connected)}))

    await collector.section(LOG_MESSAGES, build)


async def _add_ha_log(collector: _Collector) -> None:
    """Home Assistant's own log, from wherever it lives.

    The rotated file is included because a restart rotates the log, and the
    restart is frequently the event being asked about — the lines leading up to
    it would otherwise be the ones missing.

    Filtered to our own lines: the rest of the log is other integrations and
    the household, and none of it is ours to carry.

    Left out entirely for somebody who holds one remote. The only handle on a
    line is the ``[name]`` prefix, and a name is neither unique nor stable --
    narrowing on it would hand over another remote's lines.
    """
    async def build() -> None:
        hass = collector.hass
        if not collector.whole_system:
            collector.skip(
                LOG_HA,
                "Every lizaIP remote's lines, not this one's — there is no "
                "reliable way to tell them apart, so an administrator's "
                "bundle carries them",
            )
            return
        raw_chunks: list[tuple[str, str]] = []
        # Oldest first, so the result reads forwards.
        for name in ("home-assistant.log.1", "home-assistant.log"):
            path = hass.config.path(name)
            if not await hass.async_add_executor_job(os.path.isfile, path):
                continue
            raw_chunks.append(
                (name, await hass.async_add_executor_job(read_raw_tail, path))
            )

        if not raw_chunks:
            journal = await supervisor_log(hass)
            if journal is None:
                collector.skip(
                    LOG_HA,
                    "No log file, and no supervisor to ask — Home Assistant is "
                    "running without one",
                )
                return
            raw_chunks.append(("supervisor core log", journal))

        needle = LOG_NEEDLE
        collector.add(LOG_HA, "\n".join(
            f"===== {name} =====\n{filter_lines(text, needle)}"
            for name, text in raw_chunks
        ))

    await collector.section(LOG_HA, build)


async def _add_system_log(collector: _Collector) -> None:
    """Every error and warning Home Assistant is currently holding.

    Not filtered to this integration: an error raised in a template or another
    integration is often what a button press actually ran into, and the count of
    how often it repeated is in here and nowhere else.

    Which is also why it is left out of a bundle built by somebody who holds
    one remote: there is no per-remote version of it to give them.
    """
    async def build() -> None:
        if not collector.whole_system:
            collector.skip(
                LOG_ERRORS,
                "Every integration's errors, not this remote's — an "
                "administrator's bundle carries them",
            )
            return
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
            from ..device import debug as device_debug
        except ImportError:
            collector.skip("debug/port.json", "This build ships without the debug tooling")
            return

        conn = entry_connection(collector.entry)
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
    """The installed version, read from the integration's manifest."""
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "manifest.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle).get("version")
    except (OSError, ValueError):
        return None


def _environment_facts() -> tuple[str | None, str]:
    """The two facts about this machine that cost a disk read.

    `platform.platform()` is not the cheap string it looks like: to name the
    libc it opens the Python binary and reads its headers, which Home
    Assistant's loop watchdog reports as a blocking call. It is gathered here
    beside the manifest so that one executor hop pays for both.
    """
    return _integration_version(), platform.platform()


async def _add_environment(collector: _Collector) -> None:
    """Which versions of what produced this bundle.

    The first question asked of any report, and the one a screenshot never
    answers: Home Assistant's version, the integration's, and the Python it runs
    on — plus which other custom integrations are installed and how long our own
    setup took, both of which Home Assistant's own download carries.

    Those last three describe the installation rather than the remote, so a
    bundle built by somebody who holds one remote carries only the versions.
    """
    async def build() -> None:
        hass = collector.hass
        version, platform_name = await hass.async_add_executor_job(_environment_facts)
        facts = {
            "integration_version": version,
            "home_assistant_version": HA_VERSION,
            "python_version": sys.version,
            "platform": platform_name,
            "time_zone": str(hass.config.time_zone),
            "debug_tooling": debug_available(),
        }
        if collector.whole_system:
            facts |= {
                "config_dir": hass.config.path(),
                "custom_integrations": await _custom_integrations(hass),
                "setup_times": _setup_times(hass),
            }
        collector.add("homeassistant/environment.json", _dumps(facts))

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
                                    "model's blueprint and available templates."),
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
    privacy = _PRIVACY_FULL if collector.whole_system else _PRIVACY_ONE_REMOTE
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


#: The same warning for a bundle built by somebody who holds this one remote:
#: the installation-wide sections were narrowed or left out, and anybody
#: reading the ZIP should know that before drawing conclusions from it.
_PRIVACY_ONE_REMOTE = """\
configuration/ names the entities your buttons act on -- the lights, media
players and scripts in your home, by their entity ids. That is what makes a
misbehaving button diagnosable, and it is the one part of this bundle that says
anything about your household. log_messages.json carries the messages exchanged
with the remote, which name the same entities.

This bundle was built by somebody who holds this remote rather than the whole
installation, so it is narrowed to it: the Home Assistant log and the error log
are both left out -- neither can be split per remote -- the environment report
carries the versions without the rest of the installation, and who else this
remote is assigned to is not listed. An administrator's bundle carries all of
it.\
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
    whole_system: bool = True,
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

    ``whole_system`` is False when the caller holds this one remote rather than
    the installation. Every other section is already scoped to ``entry``; the
    three that are not are narrowed or left out, and the manifest says which.
    """
    if scope not in _ALL:
        raise ValueError(f"Unknown diagnostics scope {scope!r}")

    collector = _Collector(hass, entry, scope, whole_system=whole_system)
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
    whole_system: bool = True,
    progress: Any = None,
    should_stop: Any = None,
) -> tuple[str, bytes]:
    """Build the bundle and return ``(filename, zip bytes)``.

    The compression runs on an executor thread. It is CPU-bound over a few
    hundred kilobytes, and the event loop has a remote to answer in the meantime.
    """
    files = await async_build_bundle(
        hass, entry, scope=scope, whole_system=whole_system,
        progress=progress, should_stop=should_stop,
    )
    # The clock the user reads, not UTC: a file named two hours before the
    # download that made it looks like the wrong one. `created` inside the
    # bundle stays UTC, where the offset is written out and nothing is lost.
    stamp = dt_util.now().strftime("%Y%m%d-%H%M%S")
    name = f"{_ZIP_PREFIX[scope]}-{_slug(entry.title)}-{stamp}"
    # A configuration download unpacks into the device id, which is the name
    # the folder has to carry to be dropped back into `<config>/lizaip/`. The
    # ZIP itself still says whose it is and when, so copies do not collide.
    root = name
    if scope == SCOPE_CONFIG:
        root = resolve_device_id(hass, entry.entry_id) or name
    data = await hass.async_add_executor_job(_zip_bytes, files, root)
    return f"{name}.zip", data


def _bundles(hass: HomeAssistant) -> dict[str, tuple[float, str, bytes, str]]:
    """The built-but-not-yet-downloaded bundles, by token.

    Each is `(expires, filename, data, entry_id)` -- the remote it describes
    travels with it, because the view has only the token to decide by.
    """
    return lizaip_data(hass).bundles


def async_store_bundle(
    hass: HomeAssistant, filename: str, data: bytes, entry_id: str,
) -> str:
    """Park a built bundle and return the token the browser fetches it with.

    Expired bundles are dropped here rather than on a timer: a build is the only
    moment at which one more can appear, so it is also the only moment at which
    the set can be left holding something nobody will come for. A user who
    closes the tab instead of saving the file costs a few megabytes until the
    next build, not until the next restart.
    """
    now = time.monotonic()
    bundles = _bundles(hass)
    for token in [t for t, parked in bundles.items() if parked[0] <= now]:
        del bundles[token]

    token = secrets.token_urlsafe(32)
    # The remote it describes travels with it: the view has only the token to
    # decide by, and the bundle is this remote's rather than the panel's.
    bundles[token] = (now + BUNDLE_TTL, filename, data, entry_id)
    return token


class LizaIPDiagnosticsView(HomeAssistantView):
    """Hand one built bundle to the browser, once.

    Single-use, and served only to somebody the remote it describes is assigned
    to. The token is unguessable and short-lived, but neither of those is the
    protection — the access check is, and the token exists so that a URL which
    has already served its file cannot serve it again to whatever the browser's
    history syncs to.

    ``requires_auth`` only means somebody is logged in, which is why the check
    below is the same one the command that built the bundle made.
    """

    url = BUNDLE_URL_BASE + "/{token}"
    name = "lizaip:diagnostics"
    requires_auth = True

    async def get(self, request: web.Request, token: str) -> web.StreamResponse:
        """Return the bundle named by *token*, or 404 once it is gone."""
        hass = request.app["hass"]
        parked = _bundles(hass).pop(token, None)
        if parked is None:
            return web.Response(status=404)

        expires, filename, data, entry_id = parked
        if expires <= time.monotonic():
            return web.Response(status=404)

        user = request["hass_user"]
        # Taken out of the table above either way: a bundle somebody else's
        # token reached is not one to leave sitting there for a retry.
        if not can_access_entry(hass, user, entry_id):
            return web.Response(status=401)

        return web.Response(
            body=data,
            content_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


def async_setup_diagnostics_bundle(hass: HomeAssistant) -> None:
    """Register the download view. Called once, from the integration's setup."""
    hass.http.register_view(LizaIPDiagnosticsView)
