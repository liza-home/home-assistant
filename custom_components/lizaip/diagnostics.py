"""Diagnostics support for the lizaIP integration.

What belongs here is whatever a bug report cannot be answered without, and
nothing that only repeats what the reporter already told us. Three things
decide that:

* **The device's own account of itself** — connected or not, from which
  address, on which firmware and protocol, and what it says it can do. None of
  this is configured anywhere, so none of it can be read off a screenshot.
* **The settings behind a behaviour complaint** — "the slider lags", "the
  labels are in the wrong language" and "it keeps cycling by itself" are each
  one option away from being explained.
* **The shape of the configuration, not its contents** — how many pages, how
  many buttons carry something, how many of those bindings have gone stale.
  A stale binding looks identical to a working one on the remote, which is why
  counting them is worth the lines.

Deliberately absent: what any button actually does. The entity ids a household
points its remote at are the one genuinely private thing in the store, they are
long, and no support question so far has needed them — ``stale_bindings``
already withholds them for the same reason.

Also here, and the reason this file is no longer only a summary: **the device's
own report** — its reachability, its per-module log levels and each of its
read-only endpoints. That half of a bug report cannot be reconstructed from
Home Assistant's side at all, because the remote is on the household's LAN and
we are not. It is shortened on the way in (see ``_MAX_SECTION_CHARS``); the ZIP
offered by the panel's *Download diagnostics* button carries the same sections
whole, alongside the Home Assistant log, and is what to ask a reporter for when
this file is not enough.
"""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable, Mapping
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .config.templates import refresh as template_refresh
from .const import DOMAIN
from .device import report as device_report
from .device.const import MODEL_ID
from .device.connection import LizaIPConnection
from .runtime import find_store, _resolve_device_id
from .shared.logs import device_logger

_LOGGER = logging.getLogger(__name__)

#: How much of one device section is carried here. The device's own log alone
#: is a quarter of a megabyte, and this file is read in a browser's JSON
#: viewer. The ZIP from the panel carries every section whole; this keeps
#: enough to recognise *which* report is worth asking for.
_MAX_SECTION_CHARS = 20_000


def _truncate(section: dict[str, Any]) -> dict[str, Any]:
    """One fetched section, shortened to what is worth reading inline."""
    body = section.get("body")
    if not isinstance(body, str) or len(body) <= _MAX_SECTION_CHARS:
        return section
    return {
        **section,
        "body": body[-_MAX_SECTION_CHARS:],
        "truncated": True,
        "length": len(body),
    }


async def _async_device_report(
    hass: HomeAssistant,
    connection: LizaIPConnection,
    *,
    probe: dict[str, Any] | None = None,
    prefetched: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The device's own answers: reachability, log levels and every endpoint.

    This is the half of a support bundle that cannot be reconstructed from the
    outside — the remote is on the household's LAN and we are not. It is
    fetched over HTTP from the device, so it is also the slowest thing here and
    the only part that can fail; every failure is reported as data, because an
    endpoint that timed out is itself an answer.

    ``probe`` and ``prefetched`` let a caller that has already talked to the
    remote hand over what it got. The ZIP does: without this it would ask the
    same nine questions twice and take about twice as long.
    """
    log = device_logger(_LOGGER, connection)
    out: dict[str, Any] = {}
    if probe is not None:
        probe = dict(probe)
    else:
        try:
            probe = await device_report.async_probe_reachability(connection, keep_body=True)
        except Exception as err:  # noqa: BLE001 — diagnostics must never raise
            probe = {"reachable": False, "error": f"{err.__class__.__name__}: {err}"}
    # The body belongs to the report below; reachability is about whether and
    # how fast, and repeating a kilobyte of JSON under a second key helps
    # nobody.
    body = probe.pop("body", None)
    out["reachability"] = probe

    if not probe.get("reachable"):
        # Every one of the eight endpoints would now fail by timeout, at ten
        # seconds each, to establish what the probe already has.
        reason = probe.get("reason", "unreachable")
        skipped = {"skipped": f"the remote did not answer its HTTP API ({reason})"}
        out["report"] = out["logging"] = skipped
        return out

    try:
        # ``/api/info`` was just read to time the probe; reading it again a
        # moment later measures nothing new and costs another second and a half.
        known = dict(prefetched or {})
        if body and device_report.INFO_ENDPOINT not in known:
            known[device_report.INFO_ENDPOINT] = {
                "status": probe.get("status"), "body": body,
            }
        out["report"] = await device_report.async_fetch_report(
            connection, prefetched=known or None
        )
    except Exception as err:  # noqa: BLE001 — diagnostics must never raise
        log.debug("Diagnostics could not collect the device report: %s", err)
        out["report"] = {"error": f"{err.__class__.__name__}: {err}"}

    sections = (out.get("report") or {}).get("sections")
    if isinstance(sections, dict):
        out["report"]["sections"] = {
            endpoint: _truncate(section) if isinstance(section, dict) else section
            for endpoint, section in sections.items()
        }
        # The report has already fetched the logging endpoint; parsing what it
        # brought back is free, where asking for it again is a second request.
        section = sections.get(device_report.LOGGING_ENDPOINT)
        out["logging"] = (
            device_report.logging_setup_from_section(section)
            if isinstance(section, dict)
            else {"skipped": "the report did not reach the logging endpoint"}
        )
    else:
        out.setdefault("logging", {"skipped": "the report returned no sections"})
    return out


def _traffic_snapshot(connection: LizaIPConnection) -> dict[str, Any] | None:
    """Counters and recent frames from the WebSocket link, where recorded.

    A stable build ships without the recorder and its stand-in answers with
    ``None``, which is passed on as-is: an empty snapshot would read as a
    remote that said nothing, which is a different and much worse fault.
    """
    log = device_logger(_LOGGER, connection)
    protocol = getattr(connection, "_protocol", None)
    traffic = getattr(protocol, "traffic", None)
    if traffic is None:
        return None
    try:
        return traffic.snapshot(50)
    except Exception as err:  # noqa: BLE001 — diagnostics must never raise
        log.debug("Diagnostics could not read the traffic snapshot: %s", err)
        return None

#: Entry data keys whose value is replaced by ``"**redacted**"``.
#:
#: Everything else in ``data`` is reported. Naming what must *not* be shown
#: fails the safe way round: the allow-list this replaced silently dropped
#: every setting added after it was written.
_SECRET_HINTS = ("password", "token", "secret", "api_key", "psk", "credential")

#: How many lines of the Home Assistant log are carried here. The ZIP from the
#: panel carries the whole filtered log; this is the tail, which is where the
#: fault that prompted the report is.
_MAX_LOG_LINES = 200


def _is_secret(key: str) -> bool:
    """Whether a configuration key names something that must not be shown."""
    lowered = key.lower()
    return any(hint in lowered for hint in _SECRET_HINTS)


def _redact(mapping: Mapping[str, Any]) -> dict[str, Any]:
    """One mapping, reported whole except for anything that looks like a secret."""
    return {
        key: "**redacted**" if _is_secret(str(key)) else value
        for key, value in mapping.items()
    }


def _entity_id_mask(hass: HomeAssistant) -> Callable[[str], str]:
    """A function that blanks out entity ids in free text.

    The log lines and system log entries below are the only parts of this file
    that can carry what a household actually points its remote at -- a binding
    failure names the entity it failed on. That is the one genuinely private
    thing in the store, and this file is pasted into public issue trackers, so
    it goes out as ``light.***``.

    The domain survives because it is the half that answers questions: "it only
    breaks for ``media_player``" is a diagnosis, while "it only breaks for
    ``***``" is not.

    Only domains this installation actually has are masked, so dotted names
    that are not entity ids -- ``custom_components.lizaip.device`` and every
    version number -- are left alone.
    """
    try:
        domains = {state.domain for state in hass.states.async_all()}
    except Exception:  # noqa: BLE001 — diagnostics must never raise
        domains = set()
    if not domains:
        return lambda text: text

    pattern = re.compile(
        r"(?<![\w.])(" + "|".join(sorted(map(re.escape, domains))) + r")\.[a-z0-9_]+(?![\w.])"
    )
    return lambda text: pattern.sub(r"\1.***", text)


async def _async_log_lines(hass: HomeAssistant) -> dict[str, Any]:
    """The tail of Home Assistant's log, our lines only, entity ids masked.

    Shares the bundle's readers rather than growing a second pair that could
    drift from them -- including the supervisor fallback, which is the normal
    case rather than the exception: Home Assistant OS keeps no log file at all.

    Imported inside the function because the bundle imports this module; at
    module level the two would be a cycle.
    """
    from .diagnostics_bundle import _filter_lines, _read_log_tail, _supervisor_log

    mask = _entity_id_mask(hass)
    try:
        path = hass.config.path("home-assistant.log")
        if await hass.async_add_executor_job(os.path.isfile, path):
            text = await hass.async_add_executor_job(_read_log_tail, path)
            source = "home-assistant.log"
        else:
            journal = await _supervisor_log(hass)
            if journal is None:
                return {"available": False, "reason": "no log file and no supervisor"}
            text, source = _filter_lines(journal), "supervisor"
    except Exception as err:  # noqa: BLE001 — diagnostics must never raise
        return {"available": False, "error": f"{err.__class__.__name__}: {err}"}

    lines = text.splitlines()[-_MAX_LOG_LINES:]
    return {
        "available": True,
        "source": source,
        "truncated_to": _MAX_LOG_LINES,
        "lines": [mask(line) for line in lines],
    }


def _system_log(hass: HomeAssistant) -> dict[str, Any]:
    """The errors and warnings Home Assistant is holding that are about us.

    The bundle takes the whole list; here it is filtered, because the rest of
    it belongs to other integrations and to the household. What is kept is the
    count and the first and last time each fault happened -- "it has done that
    four hundred times since Tuesday" is a different report from "it did that
    once".
    """
    handler = hass.data.get("system_log")
    records = getattr(handler, "records", None)
    if records is None:
        return {"available": False, "reason": "the system_log integration is not loaded"}

    mask = _entity_id_mask(hass)
    try:
        entries = [
            {
                "name": item.get("name"),
                "level": item.get("level"),
                "count": item.get("count"),
                "first_occurred": item.get("first_occurred"),
                "timestamp": item.get("timestamp"),
                "source": item.get("source"),
                "message": [mask(str(line)) for line in (item.get("message") or ())],
            }
            for item in records.to_list()
            if DOMAIN in f"{item.get('name', '')}{item.get('source', '')}".lower()
        ]
    except Exception as err:  # noqa: BLE001 — diagnostics must never raise
        return {"available": False, "error": f"{err.__class__.__name__}: {err}"}

    return {"available": True, "entries": entries}


async def async_settings_snapshot(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Everything configurable that is not a page: fonts, icons, blueprint, templates.

    Each of these is a thing the installation *has* and the integration reads,
    and none of it is in the config entry. "The label is blank" and "the icon
    is a box" are answered by whether the font or the icon set is actually
    present -- never by the configuration that names it.

    Nothing here is personal, which is why the device page carries it whole and
    the bundle reuses this same function rather than collecting it twice.
    """
    from .config.blueprint import async_get_blueprint, entry_blueprint_id
    from .config.websocket.settings import (  # Local: the panel imports us back.
        async_list_fonts,
        icon_options_for_entry,
    )
    from .imgserv.render_custom import get_custom_icons

    settings: dict[str, Any] = {}

    try:
        settings["fonts"] = await async_list_fonts(hass)
    except Exception as err:  # noqa: BLE001 — one missing part, not the section
        settings["fonts"] = {"error": str(err)}

    try:
        settings["icon_options"] = icon_options_for_entry(hass, entry.entry_id)
    except Exception as err:  # noqa: BLE001
        settings["icon_options"] = {"error": str(err)}

    icons = get_custom_icons(hass)
    if icons is None:
        settings["custom_icons"] = {"available": False}
    else:
        # Names, not shapes: the stored SVG path of every icon would be most of
        # a megabyte, and "which icons exist" is the question.
        settings["custom_icons"] = {
            "available": True,
            "stored": sorted(icons.icons),
            "missing": sorted(icons.missing),
            "file_sets": sorted(getattr(icons.files, "sets", ()) or ()),
        }

    try:
        blueprint = await async_get_blueprint(hass, entry.entry_id)
        settings["blueprint"] = {
            "id": entry_blueprint_id(hass, entry.entry_id),
            # The template itself is large and is the same for everyone with this
            # model; what varies, and what matters, is which one, and how many
            # buttons it claims the remote has.
            "name": blueprint.get("name"),
            "view_box": blueprint.get("viewBox"),
            "buttons": [btn.get("key") for btn in (blueprint.get("buttons") or ())],
        }
    except Exception as err:  # noqa: BLE001
        settings["blueprint"] = {"error": str(err)}

    try:
        from .config.templates import list_templates

        settings["templates"] = await hass.async_add_executor_job(list_templates)
    except Exception as err:  # noqa: BLE001
        settings["templates"] = {"error": str(err)}

    return settings


def _page_summary(page: dict[str, Any], assignments: dict[str, Any]) -> dict[str, Any]:
    """One page, counted rather than transcribed.

    Grid and fixed buttons are counted apart because they fail differently: an
    empty grid button is a blank tile the user can see, while a fixed control
    with nothing on it silently falls through to the page default.
    """
    grid = 0
    fixed: list[str] = []
    overrides = 0
    dynamic = 0

    for key, assign in (assignments or {}).items():
        if not isinstance(assign, dict):
            continue
        if not (assign.get("action_id") or assign.get("config") or assign.get("slider_actions")):
            continue
        if str(key).startswith("button_"):
            grid += 1
        else:
            fixed.append(str(key))
        overrides += len(assign.get("overrides") or {})
        if isinstance(assign.get("dynamic"), dict):
            dynamic += 1

    return {
        "id": page.get("id"),
        "buttons": grid,
        "fixed_controls": sorted(fixed),
        "overrides": overrides,
        "dynamic_buttons": dynamic,
        # The page's title glyph and its icon tint. Present or not is the whole
        # question — a page that lost its colour is a report we have had.
        "has_image": bool(page.get("image")),
        "has_default_color": bool(page.get("default_color")),
    }


async def _async_config_summary(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    """The shape of what the panel has stored for this remote.

    Never raises and never resolves anything: diagnostics is what someone
    reaches for when the integration is already broken, so a store that is not
    there yet has to come back as an empty summary rather than an exception.
    """
    summary: dict[str, Any] = {
        "page_count": 0,
        "pages": [],
        "actions": {"total": 0, "unused": 0},
    }

    store = find_store(hass)
    device_id = _resolve_device_id(hass, entry.entry_id)
    if store is None or not device_id:
        return summary

    try:
        pages = await store.async_get_pages(device_id)
    except Exception:  # noqa: BLE001 — diagnostics must never raise
        return summary

    used_actions: set[str] = set()
    for page in pages or []:
        if not isinstance(page, dict) or page.get("id") is None:
            continue
        try:
            assignments = await store.async_get_assignments(device_id, page["id"])
        except Exception:  # noqa: BLE001
            continue
        for assign in (assignments or {}).values():
            if isinstance(assign, dict) and assign.get("action_id"):
                used_actions.add(str(assign["action_id"]))
        summary["pages"].append(_page_summary(page, assignments))

    summary["page_count"] = len(summary["pages"])

    try:
        library = await store.async_get_action_library(device_id)
    except Exception:  # noqa: BLE001
        library = []
    # An unused action is not a fault on its own, but a library that is mostly
    # unused is the fingerprint of assignments that went missing.
    ids = {str(a.get("id")) for a in library or [] if isinstance(a, dict) and a.get("id")}
    summary["actions"] = {"total": len(library or []), "unused": len(ids - used_actions)}

    return summary


def _entities(hass: HomeAssistant, entry: ConfigEntry) -> list[dict[str, Any]]:
    """This integration's own entities, with the state they are actually in.

    Ours alone, so nothing private is here — and "the battery sensor is
    missing" is answered by whether it is disabled, unavailable or absent,
    which are three different bugs that look the same from the outside.
    """
    entities = [
        {
            "entity_id": reg_entry.entity_id,
            "disabled_by": str(reg_entry.disabled_by) if reg_entry.disabled_by else None,
            "state": state.state if (state := hass.states.get(reg_entry.entity_id)) else None,
        }
        for reg_entry in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    ]
    return sorted(entities, key=lambda item: item["entity_id"])


def _overview(
    connection: LizaIPConnection,
    device_report_data: dict[str, Any],
    traffic: dict[str, Any] | None,
    log: dict[str, Any],
    system_log: dict[str, Any],
) -> dict[str, Any]:
    """The headline over the sections below, read back out of them.

    Three questions, in the order they are asked: is the remote there, did the
    collection work, and is any of what follows shortened. The last one earns
    its place -- this file caps the log at 200 lines and each fetched endpoint
    at 20 000 characters, and a reader who does not know that reads "that is
    all there was" into what is really "that is all we put here". The ZIP from
    the panel has no such caps, and `full_bundle` says where to get it.
    """
    reachability = device_report_data.get("reachability") or {}
    sections = (device_report_data.get("report") or {}).get("sections")
    shortened = sorted(
        endpoint
        for endpoint, section in (sections or {}).items()
        if isinstance(section, dict) and section.get("truncated")
    ) if isinstance(sections, dict) else []

    lines = log.get("lines") or []
    system_entries = system_log.get("entries") or []
    return {
        "websocket_connected": connection.connected,
        "http_reachable": bool(reachability.get("reachable")),
        "http_error": reachability.get("error") or reachability.get("reason"),
        "endpoints_collected": len(sections) if isinstance(sections, dict) else 0,
        # A recorder-less stable build reports `null` rather than zero: it did
        # not see nothing, it was not watching.
        "frames_recorded": None if traffic is None else len(traffic.get("frames") or []),
        "ha_log_lines": len(lines) if log.get("available") else 0,
        "ha_log_source": log.get("source"),
        "errors_held": len(system_entries) if system_log.get("available") else 0,
        "truncated": {
            "ha_log_lines_kept": _MAX_LOG_LINES,
            "section_chars_kept": _MAX_SECTION_CHARS,
            "sections_shortened": shortened,
        },
        "full_bundle": (
            "This page is capped so it stays readable in a browser. The complete, "
            "uncapped collection is the ZIP behind Download diagnostics in the "
            "lizaIP panel."
        ),
        # The other half of why this file is capped, and the half a reporter
        # cannot work out for themselves. Without it they either hold this back
        # or post the ZIP, which names their entities.
        "safe_to_share": (
            "This file leaves out the entity ids your buttons act on, blanks them "
            "out of the log lines, and carries no message contents -- so it can be "
            "attached to a public issue. The full ZIP cannot: send that by mail."
        ),
    }


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: ConfigEntry,
    *,
    probe: dict[str, Any] | None = None,
    prefetched: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return diagnostics for a config entry.

    ``probe`` and ``prefetched`` are what the ZIP already read off the remote;
    passing them spares the device a second round of the same requests.
    """
    connection: LizaIPConnection = entry.runtime_data

    device_report = await _async_device_report(
        hass, connection, probe=probe, prefetched=prefetched
    )
    traffic = _traffic_snapshot(connection)
    log = await _async_log_lines(hass)
    system_log = _system_log(hass)

    return {
        # The headline, first: what am I looking at, was the remote answering,
        # and is any of this shortened. The same answers the ZIP puts in
        # summary.txt, read back out of the sections so the two cannot differ.
        "summary": _overview(connection, device_report, traffic, log, system_log),
        "entry": {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "unique_id": entry.unique_id,
            "version": entry.version,
            # How this entry came to exist, and where its setup got to. A report
            # that opens "it stopped working after an update" is usually
            # answered by one of these two.
            "source": entry.source,
            "state": str(entry.state),
            "data": _redact(entry.data),
            # Reported whole rather than key by key: an option added later would
            # otherwise be missing from diagnostics until someone remembered to
            # list it here, and these are the settings behind most behaviour
            # reports.
            "options": dict(entry.options),
        },
        "device": {
            "connected": connection.connected,
            "protocol_version": connection.device_protocol_version,
            "device_mac": connection.device_mac,
            # The hardware identity, reported exactly as the device registry
            # resolves it, so a report cannot disagree with the device page a
            # user is looking at while writing it.
            #
            # `null` is an answer in its own right here and means the firmware
            # has never reported the field -- not all builds expose hw_version,
            # and model_id only arrives once a handshake has carried it.
            "sw_version": connection.device_version,
            "hw_version": entry.data.get("hw_version"),
            # `or MODEL_ID` because that is the fallback the registry applies:
            # reporting a bare `null` while the device page shows the shipped
            # default would send someone looking for a fault that is not there.
            "model_id": connection.device_model_id or MODEL_ID,
            # The remote dials Home Assistant, so its address is not configured
            # anywhere and appears in no UI — it is read off the socket and kept
            # only in memory. That makes this the one place a report can say
            # which box on the LAN it is about. `null` here is ordinary: it means
            # the device has not connected since the last restart, which is
            # itself worth knowing when the complaint is that it is offline.
            "peer_ip": connection.peer_ip,
            "http_port": connection.device_http_port,
        },
        # The capabilities the device reported, and only those.
        #
        # This used to be the whole discovery payload, which wraps them
        # alongside the button and slider lists the integration derives from
        # them -- so a reader saw `capabilities` inside `capabilities`, the
        # static buttons both on their own and folded into `buttons`, and the
        # sliders twice. None of that duplication carried information: the
        # derived lists are a pure function of what is here, and which entities
        # actually exist is answered by `entities` below.
        "capabilities": (connection.last_discovery or {}).get("capabilities"),
        "config": await _async_config_summary(hass, entry),
        # Fonts, icons, blueprint and templates: what the installation has, as
        # opposed to what it is configured to want. Nothing personal is in
        # here, which is why it is carried whole rather than counted.
        "settings": await async_settings_snapshot(hass, entry),
        "entities": _entities(hass, entry),
        # What the remote itself answers, fetched now. Slow and fallible by
        # nature, which is why it comes last of the collected things and why
        # every failure inside it is data rather than an exception.
        "device_report": device_report,
        "traffic": traffic,
        # A stale binding is invisible on the remote, so this is the one place
        # the count is actually legible.
        "dynamic": await template_refresh.async_binding_summary(hass, entry.entry_id),
        # The two places a fault leaves a trace in Home Assistant itself. Both
        # pass through the entity-id mask on the way out, because a binding
        # error names the entity it failed on and this file is pasted into
        # public issues.
        "log": log,
        "system_log": system_log,
    }
