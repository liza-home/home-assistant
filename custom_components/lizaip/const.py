"""Integration-wide constants and helpers for lizaIP.

This is the standard Home Assistant ``const.py`` for the integration and the
single source of truth for anything more than one sub-package needs: the
domain, icon resolution and defaults, service classification, and the lookup
that turns an action key into a translated button tooltip.

User-facing *text* is deliberately **not** here. It lives in ``strings.json``
and ``translations/<lang>.json``, per Home Assistant's custom-integration
localization; this module only reads it. See ``get_action_label``.

**This module must stay a leaf** — it imports nothing from the integration.
That is what keeps the dependency graph one-way::

    const.py  ◀── device/  ◀── action_controller.py  ◀── config/  ◀── __init__.py

Panel- and storage-specific constants live in ``config/const.py`` instead.
"""
from __future__ import annotations

import json
import logging
import os
import re
from copy import deepcopy
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import quote, unquote

import yaml

if TYPE_CHECKING:
    # Type-only: this module stays importable without Home Assistant, which is
    # what keeps it a leaf the rest of the integration can depend on freely.
    from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

DOMAIN: Final = "lizaip"

# Config entry option key for optimistic icon updates
CONF_OPTIMISTIC_UPDATES: Final = "optimistic_updates"

# Config entry option key that controls the device-side DemoMode.
CONF_DEMO_MODE: Final = "demo_mode"

# Config entry option keys for optional DemoMode timings.
CONF_DEMO_MODE_DWELL_TIME: Final = "demo_mode_dwell_time"
CONF_DEMO_MODE_SWIPE_TIME: Final = "demo_mode_swipe_time"

# Config entry option key for the language the *device* renders its labels in.
# Per entry rather than global: a household can have a remote in the kitchen
# labelled in Italian and one in the study labelled in English, and the panel's
# own language (the browser's) says nothing about which the remote should use.
CONF_LANGUAGE: Final = "language"

# The languages this integration ships button wordings for, i.e. the files in
# ``translations/`` that carry an ``action_labels`` section. Adding one here
# without adding the file leaves its buttons in English — `test_translations.py`
# fails on that.
SUPPORTED_LANGUAGES: Final[tuple[str, ...]] = ("en", "de", "fr", "it", "es")

# The default: follow whatever Home Assistant / the panel is using, which is
# what every device did before the option existed.
LANGUAGE_AUTO: Final = "auto"

# Fired when a button's icon/tooltip needs to be refreshed on the device
ICON_UPDATE_EVENT: Final = "lizaip_config_icon_update"


# ---------------------------------------------------------------------------
# Icon defaults (single source of truth for all icon mappings)
# ---------------------------------------------------------------------------

def _load_icon_defaults() -> dict:
    """Load icons/icon_defaults.yaml from the integration directory.

    Cached at module level so repeated calls never re-enter a blocking
    ``open()`` inside the event loop.
    """
    if "_ICON_DEFAULTS_CACHE" in globals() and globals()["_ICON_DEFAULTS_CACHE"] is not None:
        return globals()["_ICON_DEFAULTS_CACHE"]

    path = os.path.join(os.path.dirname(__file__), "icons", "icon_defaults.yaml")
    try:
        with open(path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        # Ensure all keys are strings (YAML 1.1 parses on/off/true/false as bool)
        def _key_variants(key) -> tuple[str, ...]:
            if isinstance(key, bool):
                # Support both boolean and state spellings
                return ("true", "on") if key else ("false", "off")
            return (str(key),)

        result: dict = {}
        for section in ("domain_icons", "domain_state_icons", "attribute_icons", "service_icons", "domain_service_icons"):
            raw = data.get(section, {})
            if not isinstance(raw, dict):
                result[section] = {}
                continue

            cleaned: dict = {}
            for k, v in raw.items():
                if isinstance(v, dict):
                    nested: dict = {}
                    for k2, v2 in v.items():
                        icon_val = "" if v2 is None else str(v2)
                        for sk2 in _key_variants(k2):
                            nested[sk2] = icon_val
                    for sk in _key_variants(k):
                        cleaned[sk] = nested
                else:
                    icon_val = "" if v is None else str(v)
                    for sk in _key_variants(k):
                        cleaned[sk] = icon_val
            result[section] = cleaned
        return result
    except Exception:
        _LOGGER.exception("Failed to load icons/icon_defaults.yaml — icon defaults will be empty")
        return {}


_ICON_DEFAULTS_CACHE: dict | None = None
ICON_DEFAULTS: dict = _load_icon_defaults()
_ICON_DEFAULTS_CACHE = ICON_DEFAULTS

# Domain icon defaults (used when no icon set)
DOMAIN_ICONS: dict[str, str] = ICON_DEFAULTS.get("domain_icons", {})

# Per-attribute and per-domain state icons, keyed by the state value
ATTR_ICONS: dict[str, dict[str, str]] = ICON_DEFAULTS.get("attribute_icons", {})
DOMAIN_STATE_ICONS: dict[str, dict[str, str]] = ICON_DEFAULTS.get("domain_state_icons", {})


def get_default_icon(domain: str, attribute: str | None, state_val: str) -> str | None:
    """Return the default icon for a given state value."""
    if attribute:
        icons = ATTR_ICONS.get(attribute, {"true": "mdi:check-circle", "false": "mdi:close-circle"})
    else:
        icons = DOMAIN_STATE_ICONS.get(domain, {"on": "mdi:check-circle", "off": "mdi:close-circle"})
    return icons.get(state_val)


def encode_media_source(url: str) -> str:
    """Build the ``media:<value>`` imgserv source for an image *url*.

    imgserv splits the request path on the first ``:`` and reads its own options
    (``size``, ``fg``, …) from the request query string, so a raw URL carrying its
    own query — ``https://cdn/art.jpg?token=abc`` — would lose everything after the
    ``?`` once ``&size=tile`` is appended.  Percent-encoding the whole URL into a
    single path segment keeps it intact; aiohttp decodes the path once before the
    handler sees it, so no extra unquoting happens server-side.

    Already-encoded values are returned unchanged so the function is idempotent.
    The comparison ignores hex case because ``quote`` emits uppercase escapes while a
    hand-written value may use lowercase ones: ``%2f`` and ``%2F`` are the same octet,
    and treating the former as "not encoded" would double-encode it to ``%252f``,
    which survives aiohttp's single unquote and reaches the handler still escaped.
    Only escape casing can differ here — ``quote`` preserves the case of every
    character it does not escape — so a genuinely unencoded URL is never mistaken for
    an encoded one.  The value is returned with its original casing either way, so
    signed URLs stay byte-exact.
    """
    if quote(unquote(url), safe="").lower() == url.lower():
        return f"media:{url}"
    return f"media:{quote(url, safe='')}"


def _ascii_safe_path(value: str) -> str:
    """Percent-encode non-ASCII so the device's URL encoder cannot mangle it.

    The remote builds its GET line from this URL with a minimal encoder: it
    escapes a space as ``%20`` and passes every other ASCII character through
    untouched -- ``:``, ``-`` and ``+`` all arrive literally. For anything above
    U+007F it emits the low byte of the code point *followed by* the code point
    in hex, so ``Top 50 – Global`` left the device as::

        GET /api/imgserv/text:Top%2050\\xa000a0\\x132013%20Global HTTP/1.1

    which aiohttp rejects outright -- ``InvalidURLError: 400`` before any
    handler runs, so the tooltip simply never appears. That hits any accented
    character, so a German label like "Küche" was equally unrenderable.

    Encoding here keeps the URL pure ASCII, which the device passes through
    verbatim and aiohttp decodes back for us. ASCII input is returned byte for
    byte, so every label that worked before is unchanged -- including the ``?``
    that the caller uses to decide its query separator.

    Why the fix lives here rather than in ``imgserv/``, which is in this same
    integration and would look like the natural home: aiohttp rejects that
    request line while *parsing* it, so routing never happens and the imgserv
    view is never entered. There is no handler code that could be taught to
    decode ``\\xa000a0`` back into U+00A0. Getting underneath HA's own aiohttp
    app is not something an integration can reasonably do.

    The true root cause is the firmware's encoder, which is not in this repo.
    ``resolve_icon_url`` is the one chokepoint every device-bound URL passes
    through, so it is the only reachable place to make the problem impossible.

    One assumption, worth stating because it is not measured: that the firmware
    passes ``%`` through unescaped. It does not escape ``:``, ``-`` or ``+``, so
    it is plainly not a general URL encoder, but this was never confirmed
    against the device. If it is wrong, ``%C2%A0`` would arrive doubled as
    ``%25C2%25A0`` and render as literal text rather than failing.
    """
    if value.isascii():
        return value
    return "".join(c if c.isascii() else quote(c, safe="") for c in value)


def resolve_icon_url(icon: str, size: str = "tile", color: str = "") -> str:
    """Convert an icon value to a fetchable URL.

    - MDI strings (mdi:lightbulb) → imgserv://mdi:lightbulb?size={size}&fg={color|FFFFFF}
    - imgserv source types (logo:hue, text:foo, phu:bar, file:img.png) → imgserv://{icon}?size={size}&mode=dark[&fg={color}]
    - External URLs (http://, https://) → imgserv://media:{encoded}?size={size}&mode=dark
    - imgserv:// / ha:// / local:// / data: → passed through unchanged

    External images are routed through imgserv's ``media:`` proxy rather than handed
    to the device: HA fetches them, resizes to the requested size, and re-encodes to
    PNG, so the device never has to reach a third-party host or decode an arbitrary
    image format.  HA-relative paths keep going out as ``ha://`` — the device already
    has an authenticated, cert-pinned route to HA itself.

    The device display always has a dark background, so mode=dark ensures
    monochrome icons (logo/phu without explicit color) render white.

    The optional `color` param (6-char hex, no #) overrides the default
    foreground color for MDI icons and appends &fg= for source types.
    Icons that already contain an explicit `fg=` in their value are not modified.

    Values are stripped of surrounding whitespace before dispatch: a URL copied out
    of a browser very often arrives with a trailing space or newline, and an
    unnormalised ``startswith`` would miss every branch below and hand the raw
    third-party URL straight to the device.

    URL *schemes* are additionally matched case-insensitively, since they are
    case-insensitive by RFC 3986 and ``HTTPS://`` is a plausible paste.  imgserv
    source types are not: the server dispatches on an exact ``_SOURCES`` lookup,
    so accepting ``LOGO:`` here would only produce a URL it answers with 400.

    `default_source` names the imgserv source type to assume for a value that
    matched no branch above.  It is opt-in because the right fallback differs by
    field.  A *page title* must always end up a PNG (PROTOCOL.md §3: ``img_title``
    is a URL to a 200×60 image), so ``device_sync`` passes ``"text"`` and a bare
    ``My Page`` renders as text — mirroring the panel's own preview
    (``_renderPageIconPreview``).  A *button icon* has no such guarantee, so the
    default keeps the historical passthrough: an unrecognised scheme such as
    ``ftp://host/a.png`` is handed on untouched rather than silently turned into
    a picture of the word "ftp://host/a.png".
    """
    icon = icon.strip() if icon else ""
    if not icon:
        return ""
    # Scheme tests run against a lowercased copy; the returned value always uses the
    # original casing so signed URLs and file names stay byte-exact.
    low = icon.lower()
    if low.startswith(("ha://", "imgserv://", "local://", "data:")):
        # Already addressed at the device, so the value is passed on as-is --
        # but it still travels through the firmware's encoder, so a non-ASCII
        # character in a hand-written `imgserv://text:Küche` would be mangled
        # exactly as it is on any other branch. ASCII is returned byte for
        # byte, so an already percent-encoded URL is untouched.
        return _ascii_safe_path(icon)
    if low.startswith(("http://", "https://")):
        return f"imgserv://{encode_media_source(icon)}?size={size}&mode=dark"
    if icon.startswith("/"):
        return f"ha://{_ascii_safe_path(icon.lstrip('/'))}"
    fg = color.lstrip("#") if color else ""
    if icon.startswith("mdi:"):
        mdi_fg = fg or "FFFFFF"
        return f"imgserv://mdi:{icon[4:]}?size={size}&fg={mdi_fg}"
    if icon.startswith("media:"):
        # The value is a URL in its own right — encode it so its query survives.
        return f"imgserv://{encode_media_source(icon[6:])}?size={size}&mode=dark"
    # imgserv source types: logo:, text:, phu:, file:
    if icon.startswith(("logo:", "text:", "phu:", "file:")):
        sep = "&" if "?" in icon else "?"
        # Tint monochrome sources (text:, phu:); leave logos/photos untouched
        tintable = icon.startswith(("text:", "phu:"))
        color_suffix = f"&fg={fg}" if fg and tintable and "fg=" not in icon else ""
        return f"imgserv://{_ascii_safe_path(icon)}{sep}size={size}&mode=dark{color_suffix}"

    return resolve_icon_url(f"text:{icon}", size, color)


def resolve_tooltip_url(text: str, color: str = "") -> str:
    """The URL for the words printed under a button; ``""`` clears it."""
    return resolve_icon_url(f"text:{text}", size="tooltip", color=color) if text else ""


# ---------------------------------------------------------------------------
# Shared translation data for dynamic tooltips / labels
# ---------------------------------------------------------------------------

# Maps current entity state → action key (what pressing the button will DO)
NEXT_STATE_MAP: dict[str, str] = {
    "on": "off", "off": "on",
    "playing": "pause", "paused": "play", "idle": "play",
    "open": "close", "closed": "open",
    "locked": "unlock", "unlocked": "lock",
}

# Maps current HA state → predicted next HA state (used for optimistic icon lookup).
# Distinct from NEXT_STATE_MAP which maps to *action keys* (e.g. "pause"),
# while icon rules match against *HA states* (e.g. "paused").
PREDICTED_HA_STATE_MAP: dict[str, str] = {
    "on": "off", "off": "on",
    "playing": "paused", "paused": "playing",
    "idle": "playing",
    "open": "closed", "closed": "open",
    "locked": "unlocked", "unlocked": "locked",
}

# Which state's icon covers a live state that has no row of its own.
#
# `_TWO_WAY_STATE_SCOPE` narrows play/pause to two rows, but the speaker still
# reports `idle` when its queue empties and `buffering` on every stream start.
# Those are not extra faces: core's `async_media_play_pause` is binary, so
# anything not playing presses play, and `paused` is already that bucket's icon.
# Without this a user's custom "Paused" icon would vanish the moment the speaker
# went idle. Mirrored by STATE_CATCHALL in liza-remote-states.js.
STATE_CATCHALL: dict[str, dict[str, str]] = {
    "media_player": {"active": "playing", "inactive": "paused"},
}

# Narrower row lists for two-way services. Only play/pause needs one: it has two
# faces however many states its entity reports. The `off` row was actively
# misleading -- its shipped icon is mdi:power, right for a power button, while
# the press calls `async_media_play`. `toggle` is absent on purpose; it really
# can land on any state its entity reports, so it keeps the full list.
_TWO_WAY_STATE_SCOPE: dict[str, tuple[str, ...]] = {
    "media_play_pause": ("playing", "paused"),
}


def icon_varies_with_state(svc: str) -> bool:
    """True when a button's icon must follow the entity rather than stay put.

    Only two-way services (they cannot name their own direction) and
    attribute-backed ones (``volume_mute`` reads ``is_volume_muted``) qualify.
    Everything else does one thing, so its icon is fixed and HA already ships
    one for it.

    Derived rather than enumerated on purpose: a hand-kept list of one-way
    services was always one short of reality. ``search_media`` is neither
    stateless nor a toggle, so it fell into the "has states" branch and drew the
    media_player table's first row -- mdi:pause on a search button. Anything HA
    adds tomorrow would do the same. Reusing ``is_two_way_service`` also keeps
    one definition of "two-way" instead of a second list that can drift.
    """
    if is_two_way_service(svc):
        return True
    if is_stateless_service(svc):
        return False
    attr = service_to_attribute(svc)
    return bool(attr and attr in ATTR_ICONS)


def service_state_scope(svc: str) -> tuple[str, ...] | None:
    """Which states *svc* may wear: a tuple, or None for "no restriction".

    An empty tuple means the icon never varies, so no state row applies. That
    is now derived rather than listed, which is what lets a service nobody
    thought about -- `search_media`, or whatever HA ships next -- get the right
    answer without an entry here.
    """
    if not icon_varies_with_state(svc):
        return ()
    return _TWO_WAY_STATE_SCOPE.get(svc)


def service_fixed_icon(domain: str, svc: str) -> str | None:
    """Our override for a fixed-icon service, or None to defer to HA.

    Two layers, most specific first. ``domain_service_icons`` exists because
    ``service_icons`` is keyed by service name alone, and a few services need a
    different icon per domain: HA gives `media_player` the same mdi:power for
    both `turn_on` and `turn_off`, so an On/Off pair would be indistinguishable,
    while `light.turn_off` wants HA's mdi:lightbulb-off rather than a generic
    power glyph.
    """
    by_domain = ICON_DEFAULTS.get("domain_service_icons", {}).get(domain, {})
    return by_domain.get(svc) or ICON_DEFAULTS.get("service_icons", {}).get(svc)


def scoped_icon_state(svc: str, domain: str, live_state: str) -> str | None:
    """Which state's default icon *svc* should wear, or None when it has none.

    ``None`` means "this button has no state-keyed icon" -- the caller must name
    the service instead of borrowing a row from the state table. That borrowing
    is what put mdi:pause on Play and Search buttons alike.
    """
    allowed = service_state_scope(svc)
    if allowed is None:
        return live_state
    if not allowed:
        return None
    if live_state in allowed:
        return live_state
    return state_catchall(domain, live_state)


def state_catchall(domain: str, live_state: str) -> str | None:
    """Return the state whose icon covers *live_state*, or None."""
    rule = STATE_CATCHALL.get(domain)
    if not rule:
        return None
    return rule["active"] if live_state == rule["active"] else rule["inactive"]


#: Nested containers are never identity themselves — they hold it or describe it.
_PAYLOAD_NON_CONTAINER_KEYS = frozenset({"metadata", "target", "extra"})


def normalise_payload(data) -> dict:
    """Flatten a step's ``data`` into the flat view identity lookups expect.

    ``media_player.play_media`` nests the identifying keys under ``media`` while
    older configs keep them flat; both must resolve to the same identity. Merging
    is for *reading* only — the input is never mutated, and existing top-level
    keys always win.
    """
    if not isinstance(data, dict):
        return {}
    flat = dict(data)
    for key, value in data.items():
        if key in _PAYLOAD_NON_CONTAINER_KEYS or not isinstance(value, dict):
            continue
        for nested_key, nested_value in value.items():
            flat.setdefault(nested_key, nested_value)
    return flat


def split_service(service: str) -> tuple[str, str]:
    """Split ``"domain.service"``; a bare name is assumed to be ``homeassistant``."""
    if "." in service:
        domain, name = service.split(".", 1)
        return domain, name
    return "homeassistant", service


def service_name(service: str) -> str:
    """The service half of ``"domain.service"``, or the string itself if bare."""
    return split_service(service)[1]


def catchall_state_icon(
    state_icons: dict, domain: str, live_state: str, service: str
) -> str | None:
    """Look up a per-button override via the domain's catch-all state.

    Only for a service whose row list was *narrowed* (``media_play_pause``), so
    an override has to stretch to cover the states that lost a row. A service
    showing every row (``toggle``) is excluded: a missing entry there means the
    user chose not to set one, and borrowing another row would override that
    choice. A fixed-icon service is excluded too -- it has no rows at all.

    ``service`` is taken with or without its domain prefix, like
    ``scope_action_states``; it is required, because defaulting it would quietly
    opt a caller into catch-all behaviour for a service that must not have it.
    """
    if not state_icons:
        return None
    svc = service_name(service)
    if not service_state_scope(svc):
        return None
    fallback = state_catchall(domain, live_state)
    if not fallback or fallback == live_state:
        return None
    return state_icons.get(fallback) or None


def scope_action_states(service: str, states: Any) -> list[dict]:
    """Drop stored state rules a narrowed service can never reach.

    `states` is persisted on the action-library entry, so entries written before
    the service was scoped -- and every page built from `layouts.py` before the
    same fix -- still carry `idle` and `off` rows for `media_play_pause`, and a
    full set of rows for one-way services that have no faces at all. Every
    consumer walks that list *before* any fallback runs, so a stale `off` rule
    would keep winning and the button would keep wearing `mdi:power`.

    Filtering on read makes the fix retroactive without a store migration: the
    panel re-persists the trimmed list on its next save.

    Attribute-keyed rules are kept — they match an attribute value, not a domain
    state, so the service's state scope has nothing to say about them.

    An action with no service at all is left alone. There is nothing to reason
    from, and the empty service name reads as "fixed icon", which would strip
    every rule off an entry that never named a service.

    Rows are proven to be dicts on every path, not only the narrowed one. This
    function is the chokepoint the state readers go through -- `icons.py` and
    `buttons.py` walk its result calling `.get` -- so an unscoped service like
    `toggle`, which keeps every row, would otherwise hand them the junk
    untouched. Nothing in the repo writes a malformed `states`: `layouts.py`
    derives a list of dicts and the panel round-trips that. But the value comes
    back from the store over the websocket with no schema in between, so a
    hand-edited entry arrives unchecked, and dropping the bad rows here keeps a
    page sync running instead of taking out every button on the page. Hence the
    signature: `states` is whatever the store held, and `list[dict]` is the
    guarantee this function adds.
    """
    rows = [s for s in states if isinstance(s, dict)] if isinstance(states, list) else []
    svc = service_name(service)
    if not svc:
        return rows
    allowed = service_state_scope(svc)
    if allowed is None:
        return rows
    return [s for s in rows if s.get("attribute") or s.get("state") in allowed]


# Maps HA service name (after domain prefix) → action key
SERVICE_ACTION_MAP: dict[str, str] = {
    "turn_on": "on", "turn_off": "off",
    "open_cover": "open", "close_cover": "close", "stop_cover": "stop",
    "lock": "lock", "unlock": "unlock",
    "media_play": "play", "media_pause": "pause", "media_stop": "stop",
    "media_next_track": "next", "media_previous_track": "previous",
    "volume_mute": "mute",
}

# ---------------------------------------------------------------------------
# Cyclable attributes — the single source of truth
# ---------------------------------------------------------------------------
#
# One row per attribute: the values it cycles through, **in order**, each paired
# with the action key naming *arriving at* that value. The two maps below are
# derived from this.
#
# Also the **allowlist** for both attribute rungs of ``state_token_label``:
# without the gate, every service whose data names an attribute value literally
# (``select_source``, ``set_hvac_mode``, ...) would print raw HA values. Only
# cyclable attributes — where "the next value" has one answer — belong here.
#
# ``swing_mode`` is deliberately absent: ``swing_modes`` is a free-form
# per-device list, so no static cycle is correct for it.
#
# ``repeat``'s order is HA's own (``setMediaPlayerRepeatAction`` in
# ``frontend/src/data/media-player.ts``): off → all → one → off. HA's
# "anything else → off" fallback is deliberately not copied — it would name a
# direction for a value we do not recognise; unknown values degrade instead.
# Do not re-derive the order from ``knownAttrStates`` in
# ``liza-remote-states.js``: that enumerates legal values, it does not order the
# cycle.
#
# Mirrored in ``panel/liza-remote-helpers.js``; ``tests/label_parity_cases.json``
# pins the two together.
ATTR_ACTION_CYCLES: dict[str, tuple[tuple[str, str], ...]] = {
    "is_volume_muted": (("true", "mute"), ("false", "unmute")),
    "shuffle": (("true", "shuffle_on"), ("false", "shuffle_off")),
    "oscillating": (("true", "oscillate_on"), ("false", "oscillate_off")),
    "direction": (("forward", "forward"), ("reverse", "reverse")),
    "repeat": (("off", "repeat_off"), ("all", "repeat_all"), ("one", "repeat_one")),
}

# Maps attribute → the value it would be set to → the action key naming that
# set. ``volume_mute`` with ``is_volume_muted: true`` in its data is a button
# that mutes, whatever the speaker is doing right now. This is the cycle read
# in place: each value named by itself.
ATTR_VALUE_ACTION_MAP: dict[str, dict[str, str]] = {
    attribute: dict(cycle) for attribute, cycle in ATTR_ACTION_CYCLES.items()
}

# Maps attribute → its *current* value → the action key a press produces next:
# the cycle read one step ahead, wrapping at the end. The attribute counterpart
# of ``NEXT_STATE_MAP``, and the same "show the NEXT value" rule
# ``attribute_icons:`` in ``icon_defaults.yaml`` already follows — a muted
# speaker draws ``mdi:volume-high`` because pressing unmutes it.
ATTR_ACTION_MAP: dict[str, dict[str, str]] = {
    attribute: {
        value: cycle[(i + 1) % len(cycle)][1]
        for i, (value, _) in enumerate(cycle)
    }
    for attribute, cycle in ATTR_ACTION_CYCLES.items()
}

# ---------------------------------------------------------------------------
# Action labels — loaded from ``translations/``, not defined here
# ---------------------------------------------------------------------------
#
# Wordings live in ``strings.json`` and ship in ``translations/<lang>.json``
# under ``action_labels``; this module only reads them. That is the rule for
# every user-facing string here: add it to ``strings.json``, then run
# ``python3 scripts/sync_translations.py --fix``. Never inline a translated
# literal — ``tests/test_translations.py`` enforces key parity, and nothing
# enforces a hand-written dict.
#
# Not taken from HA's ``state_translated``/``hass.localize`` because those name
# a *state* ("Playing") and these name the *action* a press performs ("Repeat
# all"); HA has no translation at all for ``unmute``, ``shuffle_on``,
# ``oscillate_*`` or ``repeat_*`` as actions.
#
# Two English wordings diverge from HA on purpose, so do not "correct" them:
# ``oscillate_on``/``oscillate_off`` (HA says yes/no, which is not idiomatic for
# an action) and ``repeat_off`` (HA's bare "Off" reads as powering the device
# down once outside its labelled dropdown). German is this repo's own
# vocabulary — HA's German lives in Lokalise, so there is nothing to defer to.
_TRANSLATIONS_DIR = Path(__file__).parent / "translations"
_FALLBACK_LANG: Final = "en"

# Parsed ``action_labels`` sections, keyed by language. Populated on demand:
# `get_action_label` is called from deep inside the synchronous label ladder, so
# it cannot await HA's translation helper, and re-reading the file per button
# would be a disk hit per tooltip.
_ACTION_LABEL_CACHE: dict[str, dict[str, str]] = {}

#: Set once every shipped file has been read in an executor. From then on the
#: synchronous loader answers a language it has not seen with ``{}`` instead of
#: going to disk: the only files that exist are the ones already cached, so a
#: miss can only be a language we do not ship — and the lookup happens inside
#: the event loop, where opening a file is what Home Assistant flags.
_ACTION_LABELS_PRELOADED = False


def normalize_language(lang: str | None) -> str:
    """Fold a language tag onto the spelling the translation files use.

    ``de-DE``, ``de_DE`` and ``de`` all mean ``de.json``; ``""`` means nothing
    recognisable, which callers read as "no opinion" rather than a language.
    """
    base = str(lang or "").strip().replace("_", "-").split("-")[0].lower()
    return base if base.isalpha() else ""


def _read_action_labels(candidate: str) -> dict[str, str]:
    """Read one language's ``action_labels`` off disk. Blocking; never in the loop."""
    if not candidate:
        return {}
    path = _TRANSLATIONS_DIR / f"{candidate}.json"
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle).get("action_labels") or {}
    except (OSError, ValueError):
        # A missing or malformed translation file must not take a tooltip
        # down: the caller degrades to English, then to the key itself.
        return {}


def load_action_labels(lang: str) -> dict[str, str]:
    """The ``action_labels`` section of ``translations/<lang>.json``.

    An unknown or unshipped language yields ``{}`` rather than raising, and
    ``get_action_label`` then falls back to English — the same behaviour the
    hand-written dict had for e.g. Spanish.

    Answers from the cache once :func:`async_preload_action_labels` has run,
    which is what keeps the synchronous label ladder off the disk while it is
    running inside the event loop.
    """
    # Normalise before the cache, so "de" and "de-DE" share one entry.
    candidate = normalize_language(lang)
    if candidate in _ACTION_LABEL_CACHE:
        return _ACTION_LABEL_CACHE[candidate]

    labels = {} if _ACTION_LABELS_PRELOADED else _read_action_labels(candidate)
    _ACTION_LABEL_CACHE[candidate] = labels
    return labels


def _preload_action_labels() -> None:
    """Read every shipped translation into the cache. Blocking; runs in an executor."""
    global _ACTION_LABELS_PRELOADED

    try:
        shipped = sorted(_TRANSLATIONS_DIR.glob("*.json"))
    except OSError:
        shipped = []

    for path in shipped:
        candidate = normalize_language(path.stem)
        if candidate and candidate not in _ACTION_LABEL_CACHE:
            _ACTION_LABEL_CACHE[candidate] = _read_action_labels(candidate)

    # Only now, so a language read before this point is not answered from an
    # empty cache that the glob was about to fill.
    _ACTION_LABELS_PRELOADED = True


async def async_preload_action_labels(hass: HomeAssistant) -> None:
    """Fill the action-label cache off the event loop.

    Called once during setup. The labels are needed from synchronous code —
    the label ladder building a tooltip, `label_wording_key` matching a preset —
    which cannot await, so the files are read ahead of time rather than on
    first use. Five small JSON files, read once per Home Assistant start.
    """
    if _ACTION_LABELS_PRELOADED:
        return
    await hass.async_add_executor_job(_preload_action_labels)


def get_action_label(action_key: str, lang: str) -> str:
    """Get translated action label, fallback to English, then title-case the key."""
    label = load_action_labels(lang).get(action_key)
    if label:
        return label
    label = load_action_labels(_FALLBACK_LANG).get(action_key)
    if label:
        return label
    return action_key.replace("_", " ").title()


def label_wording_key(name: str) -> str:
    """The ``action_labels`` key a preset's English label stands for, or "".

    "Volume Up" -> volume_up; a brand ("Alexa") or symbol ("CH+") yields "".
    """
    if not name:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_")
    return slug if slug in load_action_labels(_FALLBACK_LANG) else ""


def localize_static_name(name: str, lang: str, user_named: bool = False) -> str:
    """Translate a name the *layout* wrote; leave a user's own words untouched.

    Presets hardcode English button names. ``user_named`` protects a label
    typed into the panel, which is the user's word and not a wording key.
    """
    if not name or user_named:
        return name
    key = label_wording_key(name)
    if not key:
        return name
    translated = get_action_label(key, lang)
    # The layout's own spelling is the English source, so a wording that only
    # respells it ("Play/Pause" against the table's "Play / Pause") must not
    # replace it -- that rewrite reads as a user-typed label further up.
    return name if label_wording_key(translated) == key else translated


def configured_device_language(entry) -> str | None:
    """The language a config entry explicitly pins its device to, or None.

    None means "no opinion" — either the option is unset, or it is
    ``LANGUAGE_AUTO``, or it names a language we do not ship (which would
    otherwise silently label every button in English). Callers then fall back
    to the panel's or Home Assistant's language.

    Split out so the two places that need this question — ``get_ui_language``
    and the panel's ``get_action_labels`` command, which has to let an explicit
    device language outrank the browser's — cannot answer it differently.
    """
    if entry is None:
        return None
    configured = (getattr(entry, "options", None) or {}).get(CONF_LANGUAGE) or ""
    if configured != LANGUAGE_AUTO and configured in SUPPORTED_LANGUAGES:
        return configured
    return None


def get_ui_language(hass, entry=None, fallback: str | None = None) -> str:
    """The language to label *this device's* buttons in.

    A config entry that names a language wins: that is the per-device option,
    and it is the only answer that can be right when two remotes in the same
    house want different words. ``LANGUAGE_AUTO`` (the default) and an unset
    option both fall through to the old behaviour — the panel's language if it
    has told us one, then Home Assistant's, then English.

    *entry* is optional so the pre-existing call sites and the paths that
    genuinely have no entry (the panel serving its own UI) keep working
    unchanged.

    *fallback* is a language the caller was handed (the panel sends the
    browser's), ranked below a pinned device and above the shared slot.
    """
    return (
        configured_device_language(entry)
        or normalize_language(fallback)
        or hass.data.get(DOMAIN, {}).get("_ui_language")
        or hass.config.language
        or "en"
    )




def friendly_svc(svc: str, lang: str) -> str:
    """Derive a friendly translated label from a HA service name."""
    if svc in SERVICE_ACTION_MAP:
        return get_action_label(SERVICE_ACTION_MAP[svc], lang)
    name = svc
    for prefix in ("media_", "set_"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name.replace("_", " ").title()


# ---------------------------------------------------------------------------
# Service classification
# ---------------------------------------------------------------------------

# Services that fire and forget — they leave no state to reflect on the button
STATELESS_SERVICES: frozenset[str] = frozenset({
    "media_next_track", "media_previous_track", "media_seek",
    "play_media", "clear_playlist", "join", "unjoin",
    "volume_up", "volume_down",
    "send_command", "learn_command",
    "select_source",
})

# Services that flip an entity between two states
TOGGLE_SERVICES: frozenset[str] = frozenset({
    "turn_on", "turn_off", "toggle",
    "open_cover", "close_cover", "stop_cover",
    "lock", "unlock",
    "media_play", "media_pause", "media_stop", "media_play_pause",
})

# Services whose attribute name can't be derived from the service name
_ATTR_IRREGULARS: dict[str, str] = {
    "volume_mute": "is_volume_muted",
    "oscillate": "oscillating",
}


def attr_str(value: Any) -> str:
    """Stringify an attribute value for icon-map lookups.

    Home Assistant stores boolean attributes (``is_volume_muted``, ``shuffle``,
    ``oscillating``) as Python bools, but the icon maps in ``icon_defaults.yaml``
    are keyed by the lowercase YAML forms ``"true"`` / ``"false"``. Without this
    normalisation ``str(True)`` yields ``"True"`` and never matches.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def service_to_attribute(svc: str) -> str | None:
    """Map a service name to the attribute it modifies."""
    if svc in _ATTR_IRREGULARS:
        return _ATTR_IRREGULARS[svc]
    m = re.match(r"^set_(.+)$", svc)
    if m:
        return m.group(1)
    m = re.match(r"^(.+)_set$", svc)
    if m:
        return m.group(1)
    m = re.match(r"^select_(.+)$", svc)
    if m:
        return m.group(1)
    return None


def is_stateless_service(svc: str) -> bool:
    """Return True if *svc* leaves no state worth reflecting on the button."""
    if svc in STATELESS_SERVICES:
        return True
    return bool(re.match(r"^(browse|send|clear)_", svc))


def is_state_toggle_service(svc: str) -> bool:
    """Return True if *svc* flips an entity between two states."""
    return svc in TOGGLE_SERVICES


# Key on a stored button assignment holding its dynamic-source binding.
#
# It lives here rather than in ``config/const.py``, where it was defined, because
# both halves of the integration read it now: the config panel writes it, and the
# tooltip ladders ask it who owns a button's name. ``config.const`` re-exports it
# under its original name, which is the spelling the storage layer uses.
ASSIGNMENT_DYNAMIC_KEY: Final = "dynamic"


def name_is_source_owned(assign) -> bool:
    """True when a dynamic source, not the user, wrote this button's name.

    The tooltip ladders treat a stored name as the user's own words and return
    it verbatim — the whole point being that a typed label is never overwritten
    by a derived one. A name a source generated is not that: it names the
    button's *subject* (a lamp, a favorite), not what the button should print.

    Knowing the difference is what lets a bound toggle read "Hall Off" instead
    of a bare "Hall": the label is a subject the state belongs next to, and the
    ladder is allowed to add it.
    """
    if not isinstance(assign, dict):
        return False
    binding = assign.get(ASSIGNMENT_DYNAMIC_KEY)
    if not isinstance(binding, dict):
        return False
    fields = binding.get("fields")
    return isinstance(fields, list) and "label" in fields


# Key on a stored button assignment marking its label as one the user typed.
#
# It lives beside ``ASSIGNMENT_DYNAMIC_KEY``, and for the same reason: the panel
# writes it and the tooltip ladders read it. Stored only when true — absence is
# how "nobody has named this button, keep deriving" is spelled, matching every
# other optional field in the assignment schema.
ASSIGNMENT_LABEL_EDITED_KEY: Final = "label_edited"


# The name a device-local command's target had when the button was saved.
#
# Beside the step, not inside it: the step stores a page *id*, and a second
# target field in the step would have to keep agreeing with that id — a rename
# would then trip `conflicting_page_target` and disarm a working button. Held
# out here it can go stale harmlessly, because it is only ever read once the
# real target no longer resolves, to say "Go to page: Kitchen" instead of the
# id the user never chose and cannot act on.
ASSIGNMENT_INTERNAL_TARGET_NAME_KEY: Final = "internal_target_name"


def name_is_user_written(assign) -> bool:
    """True when the user typed this button's name into the panel's Label field.

    The ladders used to *infer* this by comparing the stored name against its
    action-library entry's: equal meant auto-filled, different meant typed. That
    guess is wrong for every layout button, because ``generate_assignments``
    stores the layout's name and mints the library entry from the same string —
    so an Android TV ``CH+`` looked auto-filled, fell to the static rung and was
    printed as "Wohnzimmer CH+". Deleting the room name in the panel then stored
    what was already stored, and the prefix came straight back.

    A recorded fact replaces the guess. The entity prefix stays the default for
    a button nobody has named, and becomes removable — permanently — for one
    somebody has.
    """
    if not isinstance(assign, dict):
        return False
    return bool(assign.get(ASSIGNMENT_LABEL_EDITED_KEY))


# ---------------------------------------------------------------------------
# ``${STATE}`` placeholders in user-typed button labels
# ---------------------------------------------------------------------------

# ``\w*`` and not ``\w+``: an empty or blank token (``${}``, ``${ }``) must also
# be consumed. Anything left behind would reach ``resolve_icon_url("text:…")``
# and put a brace into the imgserv URL.
LABEL_TOKEN_RE = re.compile(r"\$\{\s*(\w*)\s*\}")

# The spelling the panel writes into a label it fills in for the user.
STATE_TOKEN: Final = "${STATE}"

# The target of a device-local command, named in the user's label. Scoped to
# those commands on purpose: a plain HA action has no "target" distinct from
# its entity, so the token resolves to nothing there and collapses away, the
# same as any name this substituter does not know.
NAME_TOKEN: Final = "${NAME}"


def is_two_way_service(svc: str) -> bool:
    """Return True if *svc* flips an entity and cannot say which way by itself.

    ``toggle`` and ``media_play_pause`` are the whole set: every other service
    in ``TOGGLE_SERVICES`` names its own direction via ``SERVICE_ACTION_MAP``
    (``turn_on`` always means "On"). These are the buttons whose label has to
    move with the entity, so these are the ones the panel labels with a
    ``${STATE}`` template rather than a fixed word.
    """
    return svc in TOGGLE_SERVICES and svc not in SERVICE_ACTION_MAP


def attribute_cycle_for(svc: str) -> dict[str, str] | None:
    """The value→next-action cycle for *svc*, or None if it has no attribute.

    The single gate for everything attribute-driven: ``ATTR_ACTION_CYCLES`` is
    an allowlist, so a service whose attribute is not a cyclable one answers
    None and every caller falls back to what it did before.
    """
    attribute = service_to_attribute(svc)
    return ATTR_ACTION_MAP.get(attribute) if attribute else None


def is_attribute_state_service(svc: str) -> bool:
    """True if what *svc* changes lives in a cyclable attribute, not the state.

    ``volume_mute``, ``shuffle_set``, ``oscillate``, ``set_direction`` and
    ``repeat_set``. A muted speaker is still ``playing``, so these buttons
    cannot be read from ``state.state`` the way a toggle can.
    """
    return attribute_cycle_for(svc) is not None


def is_state_labelled_service(svc: str) -> bool:
    """True when a button's label has to move with the entity.

    The set that gets a ``${STATE}`` template rather than a fixed word, and the
    union of the two ways a button can fail to name its own direction:

    * genuinely two-way services (``toggle``, ``media_play_pause``), whose
      answer is in ``state.state``; and
    * the setters whose answer is in an attribute instead — a ``volume_mute``
      button reads ``Mute`` or ``Unmute`` depending on the speaker, and it was
      being labelled with a frozen ``Mute`` that contradicted its own icon.

    Deliberately *not* ``is_two_way_service``: that predicate also decides the
    ``NEXT_STATE_MAP`` rung of the label ladder, which is keyed by
    ``state.state`` and would start answering for attribute services on states
    that say nothing about them — a ``shuffle_set`` button on an ``on`` entity
    would read ``Off``. This question is only "does the label move?".
    """
    return is_two_way_service(svc) or is_attribute_state_service(svc)


def is_token_only_label(text: str) -> bool:
    """True when *text* is nothing but placeholders — no words of its own.

    Such a label is a shape, not a name: ``"${STATE}"`` says "print the state
    here" and leaves the button unnamed. The tooltip ladder therefore treats it
    like a short static name (``"Next"``) and puts the entity in front of it,
    rather than like a label the user typed, which is returned verbatim.

    That is what keeps a two-way button's stored label the same shape as its
    neighbours: ``Previous`` / ``${STATE}`` / ``Next``, all three of which the
    device renders behind the room name.
    """
    if not text or "${" not in text:
        return False
    # Leftover braces are wreckage, not words: "${STATE}}" is still a shape, and
    # counting the stray brace as a name cost the label its entity prefix -- the
    # tooltip read "Off" instead of "Schreibtischlampe Off".
    return not LABEL_TOKEN_RE.sub("", text).replace("{", "").replace("}", "").strip()


def auto_button_label(entity_name: str, svc: str, action_name: str) -> str:
    """The label the config panel fills in for a button the user has not named.

    Mirrored in ``panel/liza-remote-helpers.js`` (``_computeLabel``); the pair
    is pinned against this one by ``tests/label_auto_cases.json``.

    A two-way service gets the bare ``${STATE}`` *template* — never a resolved
    state, and without the entity name. The panel persists this string into the
    stored name, so resolving it here would freeze whatever the entity happened
    to be doing at the moment the button was configured; and baking the entity
    name in would leave the label out of shape with every other button on the
    page, which stores only its own short name. The device adds the entity in
    front of both.
    """
    if entity_name and is_state_labelled_service(svc):
        return STATE_TOKEN
    if not action_name:
        return entity_name
    return f"{entity_name} {action_name}" if entity_name else action_name


def state_token_label(
    svc: str,
    current_state: str,
    lang: str,
    attributes: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
) -> str:
    """Name the state a button press produces, or "" when it produces none.

    The *service* decides first: pressing a ``turn_on`` button always reads
    "On", even when the entity is already on, because that is what the press
    does. Only genuinely two-way services (``toggle``, ``media_play_pause``)
    have no answer of their own and fall back to the entity's current state.

    Two rungs sit above that, for the services whose direction is *not* in
    their name. ``volume_mute`` is a setter — it writes the
    ``is_volume_muted`` value it is handed — so its answer is either in the
    button's own ``data`` or in the attribute it inverts, never in the service
    name and never in ``state.state`` (a muted speaker is still ``playing``).
    Reading the attribute before ``SERVICE_ACTION_MAP`` is not a breach of the
    action-first rule: that rule exists because ``turn_on`` names its own
    direction, and a setter does not.

    Both rungs are gated on ``ATTR_ACTION_CYCLES`` as an allowlist — see the
    comment there for what the gate keeps out. Everything below them is
    unchanged, so a service the gate rejects, or an entity whose attribute
    cannot be read, still gets the answer it got before.

    *attributes* is the target entity's attribute dict, *data* the first config
    step's service data. Both default to ``None`` so the old three-argument
    call keeps working.
    """
    attribute = service_to_attribute(svc)
    cycle = attribute_cycle_for(svc)
    if cycle:
        # The step names a literal value for the attribute, so the button has
        # one direction regardless of the entity: `is_volume_muted: true` is a
        # mute button. A template (`{{ not is_state_attr(...) }}`, which is how
        # a layout turns the setter into a toggle) is not a value of the
        # attribute, so it misses here and falls to the rung below — which is
        # exactly where an inverting button belongs.
        if isinstance(data, dict):
            target = ATTR_VALUE_ACTION_MAP.get(attribute, {}).get(
                attr_str(data.get(attribute, ""))
            )
            if target:
                return get_action_label(target, lang)
        # Otherwise the entity's current value names the next one, the same way
        # `attribute_icons:` already picks the icon for this button.
        if isinstance(attributes, dict):
            next_key = cycle.get(attr_str(attributes.get(attribute, "")))
            if next_key:
                return get_action_label(next_key, lang)

    if svc in SERVICE_ACTION_MAP:
        return get_action_label(SERVICE_ACTION_MAP[svc], lang)
    if is_state_toggle_service(svc) and current_state:
        next_key = NEXT_STATE_MAP.get(current_state)
        if next_key:
            return get_action_label(next_key, lang)
    return ""


#: Punctuation that only joins two halves of a label ("Go to page: Android").
#: When a placeholder between or beside such a mark resolves to nothing, the
#: mark is left joining nothing — a goto whose page was deleted printed a
#: dangling "Go to page:" on the device. Stripped only on a label that *held* a
#: placeholder, so a name the user genuinely ended in a colon is left alone.
_DANGLING_SEPARATOR_RE = re.compile(r"^[\s:;,/\-–—]+|[\s:;,/\-–—]+$")


def substitute_label_tokens(text: str, values: dict[str, str]) -> str:
    """Replace ``${TOKEN}`` placeholders in *text* from *values*.

    Token matching is case-insensitive and tolerates inner whitespace, so
    ``${STATE}``, ``${state}`` and ``${ State }`` are the same token. A token
    with no value — unknown name, or a state the button cannot predict —
    collapses to nothing, and the whitespace it leaves behind is collapsed with
    it so the result never has a doubled or trailing space.
    """
    if not text or "${" not in text:
        return text
    lookup = {k.lower(): v for k, v in values.items()}
    substituted = LABEL_TOKEN_RE.sub(lambda m: lookup.get(m.group(1).lower(), ""), text)
    # A token that collapsed can leave a separator joining nothing — a goto
    # whose page was deleted printed a dangling "Go to page:". Trimmed here
    # rather than in `clean_label_text`, which sees the text *after* this and
    # so cannot tell a resolved-away token from a colon the user typed.
    return clean_label_text(_DANGLING_SEPARATOR_RE.sub("", substituted))


# A placeholder the user has damaged while editing: an opening ``${`` that
# LABEL_TOKEN_RE could not match, because the closing brace is missing or there
# is something other than a word between the braces. Measured on the device: a
# stored name of ``Schreibtisch ${STATE`` reached the wire as
# ``imgserv://text:Schreibtisch ${STATE?size=tooltip``, putting a brace in the
# URL — the exact thing the token regex is careful to prevent for ``${}``.
# Bounded to a token-shaped run, not to the next brace: a greedy match would
# eat the rest of the label, turning "Vor ${STATE nach" into "Vor".
_BROKEN_TOKEN_RE = re.compile(r"\$\{\s*\w*\s*\}?")

def clean_label_text(text: str) -> str:
    """Make *text* safe to put in an imgserv URL and tidy to read.

    Drops any placeholder wreckage left over after substitution and collapses
    runs of whitespace. The whitespace part is not only cosmetic: an entity
    whose ``friendly_name`` ends in a space (a real one on the user's system is
    ``"Schreibtisch "``) otherwise reads ``Schreibtisch  On`` on the remote.
    """
    if not text:
        return text
    had_token = "${" in text
    if had_token:
        text = _BROKEN_TOKEN_RE.sub("", text)
    # Anything still holding a brace cannot be parsed as a URL by the device.
    if "{" in text or "}" in text:
        text = text.replace("{", "").replace("}", "")
    if had_token:
        text = _DANGLING_SEPARATOR_RE.sub("", text)
    return " ".join(text.split())


# ---------------------------------------------------------------------------
# Wake prelude ("ensure on")
# ---------------------------------------------------------------------------
#
# `action_controller` infers this prelude at press time and is the only caller,
# but the builder lives here because `config` may import `action_controller` and
# never the reverse: anything both sides might need has to sit below both.

# States that mean "not ready yet". Readiness is the *absence* of these rather
# than ``== "on"``: climate reports ``heat``/``cool`` and cover reports ``open``,
# so waiting for a literal "on" would burn the whole timeout on those domains.
NOT_READY_STATES: tuple[str, ...] = ("off", "unavailable", "unknown")

ENSURE_ON_TIMEOUT: Final = "00:00:20"

# Settle time after the wake gate opens. The wait_template only proves the
# target reported *power*: androidtv_remote flips state within a second of the
# POWER keycode, but the box needs roughly ten more before it can service an
# app-link intent. Sized for that worst case — it only runs inside the
# `state == off` branch, so an already-awake device pays nothing.
#
# Deliberately a fixed constant with no per-layout or per-button override. It is
# sized for the slowest known target, and a tunable version failed silently:
# a value set too low looks like it works right up until the one press that
# needed the full ten seconds.
ENSURE_ON_SETTLE: Final = 10.0


def build_ensure_on_prelude(entity_id: str, settle: float) -> list[dict]:
    """Build script steps that wake *entity_id* before a button's own action.

    Guarded on the target being ``off``, so a device that is already awake pays
    no latency at all — the common case is unchanged. ``unavailable`` is
    deliberately *not* a trigger: ``turn_on`` cannot revive an unreachable
    device, and firing anyway would stall every press for the full timeout.

    The wake goes through ``homeassistant.turn_on`` rather than a domain-specific
    ``<domain>.turn_on``. HA's own handler
    (``components/homeassistant/__init__.py::async_handle_turn_service``) groups
    the targeted entities by domain, asks
    ``hass.services.has_service(domain, "turn_on")``, and warns about and skips
    anything unsupported — exactly the check a hand-maintained frozenset of
    turn_on-capable domains used to do, only always current. It also means
    neither caller has to re-derive the target's domain: the press-time inference
    in ``action_controller`` gets the right wake for any entity it is handed
    without parsing the entity_id at all.

    *settle* is a parameter rather than a constant read here because the two
    halves of the prelude have different scopes: the wake gate is universally
    correct, while the settle is specific to targets that report power long
    before they can act on it. Callers pass ``0`` to get the gate alone.
    """
    not_ready = ", ".join(f"'{state}'" for state in NOT_READY_STATES)
    steps: list[dict] = [
        {"action": "homeassistant.turn_on", "target": {"entity_id": entity_id}},
        {
            "wait_template": (
                f"{{{{ states('{entity_id}') not in [{not_ready}] }}}}"
            ),
            "timeout": ENSURE_ON_TIMEOUT,
            # A device that never reports ready still gets its action attempted,
            # rather than the press being swallowed.
            "continue_on_timeout": True,
        },
    ]
    if settle > 0:
        steps.append({"delay": {"seconds": settle}})

    return [{
        "if": [{"condition": "state", "entity_id": entity_id, "state": "off"}],
        "then": steps,
    }]


# ---------------------------------------------------------------------------
# Launch verification (the `after:` half)
# ---------------------------------------------------------------------------
#
# The wake prelude is open-loop: `androidtv_remote`'s app-launch is a bare
# socket write, so failure is invisible at the *service* layer. It is visible at
# the *state* layer, though — the same integration push-publishes the foreground
# app under `app_id`, a documented `media_player` state attribute — so closing
# the loop needs no new plumbing, only that somebody looks.

#: Attribute `androidtv_remote` publishes the foreground app under.
LAUNCH_VERIFY_ATTRIBUTE: Final = "app_id"

#: How long to wait for the launch to show up in state before retrying.
#:
#: Short on purpose. This is the *confirmation* window, not a boot window — the
#: boot has already been waited out by the prelude's settle. A launch that is
#: going to happen is reported within a second or two; anything longer and the
#: retry is the faster path to a working screen.
LAUNCH_VERIFY_TIMEOUT: Final = "00:00:05"

#: Script variable holding the app that was in the foreground when the press
#: reached the target.
#:
#: Namespaced because the sequence it lands in is shared with a hand-written
#: ``before:``/``after:`` from a layout, which may define variables of its own.
LAUNCH_VERIFY_PREVIOUS_VAR: Final = "liza_prev_app_id"


def _app_id_expr(entity_id: str) -> str:
    """Return the bare Jinja expression for *entity_id*'s current app_id."""
    return f"state_attr('{entity_id}', '{LAUNCH_VERIFY_ATTRIBUTE}')"


def build_launch_capture(entity_id: str) -> dict:
    """Build the step that records *entity_id*'s app before the launch.

    Spliced between the wake prelude and the button's own action, so it reads
    the foreground app at the only moment that answers the question the retry
    asks. Capturing in Python before the script runs would read it *before the
    wake*, and the wake changes it: a TV woken from standby lands on its
    launcher, so a launch dropped immediately afterwards would look like the
    app had "changed" and the retry would decline — on exactly the cold-boot
    press this whole feature exists for.

    Keeping the value in a script variable also keeps the emitted sequence
    identical on every press, which is what lets ``_get_script``'s cache
    (it compares the actions list) stay warm. A literal baked in at build time
    differs from press to press and rebuilds the Script nearly every time.
    """
    return {
        "variables": {
            LAUNCH_VERIFY_PREVIOUS_VAR: f"{{{{ {_app_id_expr(entity_id)} }}}}",
        },
    }


def build_launch_verification(
    entity_id: str,
    expected_app_id: str,
    retry_steps: list[dict],
) -> list[dict]:
    """Build script steps that confirm a launch landed, and retry once if not.

    Runs *after* the button's own action, and pairs with the
    ``build_launch_capture`` step that must precede it. Two steps:

    1. Wait up to `LAUNCH_VERIFY_TIMEOUT` for `app_id` to become
       *expected_app_id*. ``continue_on_timeout`` so a device that never
       reports still falls through to the decision rather than erroring.
    2. Re-issue *retry_steps* — **exactly once, never a loop** — but only if
       `app_id` is still exactly what it was when the capture ran.

    That second condition is the whole containment story. "Unchanged" is the
    only signal that means *nothing happened at all*. If `app_id` moved to
    something that is neither the captured value nor the requested one, the user
    launched something else in the meantime, and yanking them back to our app
    would be a far worse bug than the silent drop this is fixing. A plain
    ``!= expected`` test would do exactly that.

    The second half of the condition covers the target already sitting on the
    requested app when the press arrived: "unchanged" is then trivially true
    however the launch went, so without it a button that plainly worked would
    re-issue. It is tested here rather than skipped in Python for the same
    reason the capture is a variable — a press-time decision would make the
    emitted sequence differ per press.

    Comparing against a variable also removes the need to special-case "no app
    reported yet": the variable simply holds ``none``, and ``none == none``
    is true in Jinja, whereas a baked literal would have had to render as an
    ``is none`` test to avoid comparing against the string ``"None"``.
    """
    previous = LAUNCH_VERIFY_PREVIOUS_VAR
    expected = json.dumps(expected_app_id)
    current = _app_id_expr(entity_id)
    return [
        {
            "wait_template": f"{{{{ {current} == {expected} }}}}",
            "timeout": LAUNCH_VERIFY_TIMEOUT,
            "continue_on_timeout": True,
        },
        {
            "if": [{
                "condition": "template",
                "value_template": (
                    f"{{{{ {current} == {previous} "
                    f"and {previous} != {expected} }}}}"
                ),
            }],
            "then": deepcopy(retry_steps),
        },
    ]
