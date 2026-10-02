"""Constants for the lizaIP config panel.

Scope: panel- and storage-specific values only. Anything the wider
integration needs (domain, icons, action labels, i18n) lives in the
integration-level ``const.py`` at the package root.

Storage scheme (v3 — Action Library):
  Actions are defined once in a shared library. Buttons reference
  actions by ID. Each action has: id, name, icon, action config.

Key format:
  action_library           → JSON: [{id, name, icon, action: [...]}, ...]
  assign_{page_id}_{btn}   → JSON: {action_id: "..."}
  pages                    → JSON: [{id, name}, ...]
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import unquote

import voluptuous as vol

from ..device.protocol import MAX_PAGE_ID, MIN_PAGE_ID, is_valid_page_id  # noqa: F401
# Re-exported: key on a stored button assignment holding its dynamic-source
# binding. It is a *sibling* of `config`, not a field inside it -- the admin
# panel truncates a button's `config` list to its first step on every edit, so
# anything stored in there that the panel does not know about is destroyed the
# first time a user touches the button. `before` already lives outside `config`
# for exactly this reason. It is defined at the package root because the
# tooltip ladders in `action_controller` read it too, and one spelling for a
# stored key is the point of having a constant.
from ..const import normalise_payload  # noqa: F401
from ..const import service_name
from ..const import ASSIGNMENT_DYNAMIC_KEY  # noqa: F401

# Re-exported alongside it: the key marking a button's label as one the user
# typed into the panel, which the tooltip ladders in `action_controller` read.
from ..const import ASSIGNMENT_LABEL_EDITED_KEY  # noqa: F401
# And the key holding the name a device-local command's target had when the
# button was saved, which `device_sync` reads to label a target since deleted.
from ..const import ASSIGNMENT_INTERNAL_TARGET_NAME_KEY  # noqa: F401
from ..device.const import MODEL_ID

CONFIG_CHANGED_EVENT = "lizaip_config_config_changed"

# The blueprint used when nothing better is known: the face of the only
# hardware variant that exists today. Blueprints are named by product SKU
# (``3029-000.yaml`` / ``.png``) rather than by product name, because the SKU
# is what identifies a *face* — a second variant with a different button set
# gets a second pair of files and nothing else has to change.
#
# Deliberately the same string as ``device.const.MODEL_ID``, imported rather
# than repeated so the fallback cannot drift away from the model the device
# registry claims this hardware is.
DEFAULT_BLUEPRINT_ID = MODEL_ID

# Where a blanked button's disarmed action is parked, *inside* the binding (so
# it inherits the same protection from the panel's `config` truncation).
# Blanking clears `action_id` and the whole `config` step, but the resolver only
# knows how to write `name`/`icon`/`action`/`data` back — never `action_id` or
# the step's `target`. Without this stash a button whose source recovered came
# back looking correct and was permanently unpressable.
ASSIGNMENT_BLANKED_KEY = "blanked_action"

# `page_id` is a 32-bit unsigned integer; 0 is reserved to mean "no page".
# See PROTOCOL.md §3 "Rules". Bounds are imported from device.protocol so the
# panel API and the device protocol can never drift apart.
PAGE_ID_SCHEMA = vol.All(int, vol.Range(min=MIN_PAGE_ID, max=MAX_PAGE_ID))


def generate_page_id(existing_ids: set[int] | None = None) -> int:
    """Generate the next sequential page ID (max existing + 1).

    Avoids collisions with *existing_ids* if provided. Only the lower bound is
    enforced — 0 is reserved by the protocol (see PROTOCOL.md §3 "Rules") — so
    the result exceeds ``MAX_PAGE_ID`` when *existing_ids* already holds it.
    That is reachable only through a hand-edited page file; ``is_valid_page_id``
    is the gate that catches it during sync.
    """
    if not existing_ids:
        return MIN_PAGE_ID
    return max(max(existing_ids) + 1, MIN_PAGE_ID)


# A page the remote keeps but does not show in its swipeable main-page list.
# Reachable only through a `goto_page` action, so the page still has to exist on
# the device. It is left out of `main_pages.yaml` and of `set_main_pages`;
# `page_order.yaml` keeps it, and is what decides its file is not an orphan.
PAGE_SUBPAGE_KEY = "subpage"


def is_subpage(page: Any) -> bool:
    """True when *page* is marked as a subpage.

    Anything that is not a mapping is not a subpage rather than an error: sync
    and the panel API both walk page lists that a hand-edited YAML file can put
    junk into, and a malformed entry already has its own handling there.
    """
    return bool(page.get(PAGE_SUBPAGE_KEY)) if isinstance(page, dict) else False


def parse_json_option(value) -> dict | list | None:
    """Parse a config-entry option that may be stored as a JSON string or native type.

    Returns the parsed value, or None on error / empty input.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return None

# ---------------------------------------------------------------------------
# Payload identity
# ---------------------------------------------------------------------------
# A button that plays a specific media item or selects a specific source carries
# its identity in its own action payload. The action library is keyed by service
# name, so every ``play_media`` button shares one library entry — reading the
# label/icon from there shows whichever media item happened to create it.

_MEDIA_EXT_RE = re.compile(r"\.[a-zA-Z0-9]{2,4}$")


def _is_opaque_id(text: str) -> bool:
    """Return True when *text* looks like a machine identifier, not a title."""
    if " " in text:
        return False
    if len(text) >= 16:
        return True
    return bool(re.fullmatch(r"[0-9a-fA-F]{8,}", text))


def media_id_title(media_content_id) -> str:
    """Humanise a ``media_content_id`` into a readable title.

    Uses the last meaningful path segment; returns ``""`` for opaque ids.

    A pathless web address is refused: its last segment is the host, which
    names a site rather than the media, and the extension stripper below would
    take the TLD for a file extension.
    """
    if not media_content_id or not isinstance(media_content_id, str):
        return ""
    val = unquote(media_content_id.split("?")[0]).rstrip("/")
    if re.fullmatch(r"https?://[^/]+", val, re.IGNORECASE):
        return ""
    # URIs nest their identifier behind both separators (spotify:track:<id>)
    seg = re.split(r"[/:]", val)[-1]
    if not seg:
        return ""
    cleaned = _MEDIA_EXT_RE.sub("", seg)
    cleaned = re.sub(r"[\s_+-]+", " ", cleaned).strip()
    if not cleaned or len(cleaned) > 60 or _is_opaque_id(cleaned):
        return ""
    return cleaned


#: Payload keys that carry a button's own identity (what it plays/selects/sends).
PAYLOAD_IDENTITY_KEYS = ("media_content_id", "source", "command", "ir_code")


def drop_redundant_subject(step: Any) -> bool:
    """Remove ``data.entity_id`` when ``target`` already names the same entity.

    A step says who it acts on once, in ``target``. The generated grids used to
    say it twice because the resolver hands an entity item down as a payload and
    the target was filled from that payload, leaving both halves holding the
    same string. Nothing reads the copy: ``get_entity_from_step`` asks ``target``
    first, and every other payload reader wants a non-target key
    (``media_content_id``, ``config_entry_id``, a literal attribute value).

    Only the exact duplicate goes. A payload naming a *different* entity is a
    deliberate override and is left alone, as is one on a step with no target —
    ``script``/``scene`` steps drop their target and the payload is all they have.
    """
    if not isinstance(step, dict):
        return False
    data = step.get("data")
    target = step.get("target")
    if not isinstance(data, dict) or not isinstance(target, dict):
        return False
    if "entity_id" not in data or data["entity_id"] != target.get("entity_id"):
        return False
    del data["entity_id"]
    return True


def payload_identity(data) -> str:
    """Stable identity string for a payload, ``""`` when it carries none.

    Used to tell two buttons of the same service apart, so they never collapse
    onto a single action-library entry.
    """
    flat = normalise_payload(data)
    parts = [str(flat.get(key) or "") for key in PAYLOAD_IDENTITY_KEYS]
    return "|".join(parts) if any(parts) else ""


#: Services whose identity lives in the payload, not in the service name. Their
#: action-library entry is behaviour-only — its icon/name belong to whichever
#: button happened to create it, so no other button may borrow them.
PAYLOAD_SERVICES = frozenset(
    {"play_media", "select_source", "select_sound_mode", "send_command"}
)

#: Shown when we genuinely do not know what a button does — never a real default.
UNCONFIGURED_ICON = "mdi:help-circle-outline"

#: Shown when we know exactly what a button meant to do and it cannot be done:
#: a device-local command whose target was never chosen, or has since gone.
#:
#: Distinct from :data:`UNCONFIGURED_ICON` because the two say different things.
#: A question mark reads as "not set up yet", which is a fair description of a
#: half-finished button and a misleading one for a button that *was* set up and
#: is now broken — it invites the user to finish something they already
#: finished. An exclamation mark says something is wrong, which is the actual
#: state and the one that prompts the repair.
BROKEN_TARGET_ICON = "mdi:alert-circle-outline"


def is_payload_service(service: str) -> bool:
    """True when the service carries its identity in its payload."""
    if not service:
        return False
    svc_name = service_name(service)
    return svc_name in PAYLOAD_SERVICES


def step_service(config) -> str:
    """Return the service of a button's first step, ``""`` when it has none."""
    if not isinstance(config, list) or not config:
        return ""
    step = config[0] if isinstance(config[0], dict) else {}
    return step.get("action") or step.get("service") or ""


def is_unconfigured_step(config, fallback_service: str = "") -> bool:
    """True when we cannot tell what a button does at all.

    "At all" is deliberate and narrow: no step *and* no resolvable service, from
    either the button's own config or the action-library entry it points at. That
    is the dangling-reference case — the button claims an action nobody can name.

    Everything less than that keeps an honest icon:

    * A service with no target is still a known *action*. A service icon says
      "this plays media"; it never claims to know *which player*, so it is not a
      lie. Targetless steps also occur in real configs (Home Assistant's media
      browser writes ``play_media`` steps whose target is filled in later).
    * A payload service with an empty payload is likewise a known action —
      ``media_player.play_media`` is a media play whatever it ends up playing.

    What must never happen is borrowing another button's *item* identity; that is
    :func:`is_borrowed_identity_icon`'s job, not this one's.
    """
    return not (step_service(config) or fallback_service)


def is_borrowed_identity_icon(icon) -> bool:
    """True when *icon* is artwork identifying one specific media item.

    Action-library entries are keyed by service, so a ``media:``/``http`` icon on
    one is the cover art of whichever button created it. Reusing that for another
    button makes an app-launch button show an unrelated track's artwork. A plain
    ``mdi:`` icon carries no item identity and is safe to share.
    """
    if not isinstance(icon, str) or not icon:
        return False
    return icon.startswith(("media:", "http://", "https://", "/"))


def payload_display(assign: dict) -> tuple[str, str]:
    """Derive ``(title, thumbnail)`` from a button's own action payload.

    HA's media selector writes ``data.metadata.{title,thumbnail}``; that is the
    primary source. Returns ``("", "")`` when the payload has no identity of its
    own (plain ``turn_on``, ``volume_up``, …).

    ``command`` is deliberately not a title source: it is a protocol token
    (``DPAD_UP``), so it identifies a button without describing it. Callers fall
    back to the button's own name, which reads better than the raw command.
    """
    if not isinstance(assign, dict):
        return "", ""
    config = assign.get("config", [])
    if not isinstance(config, list) or not config:
        return "", ""
    step = config[0] if isinstance(config[0], dict) else {}
    data = normalise_payload(step.get("data"))
    if not data:
        return "", ""

    meta = data.get("metadata")
    meta = meta if isinstance(meta, dict) else {}

    title = (
        meta.get("title")
        or data.get("source")
        or media_id_title(data.get("media_content_id"))
        or ""
    )

    thumb = meta.get("thumbnail") or ""
    if thumb and not thumb.startswith("media:"):
        thumb = f"media:{thumb}" if thumb.startswith(("http", "/")) else ""

    return str(title), str(thumb)
