"""The ``goto_page`` command: send the remote to one of its own pages.

Everything page-shaped lives here — reading a name out of a page's image spec,
the context other modules build from a page list, and the command itself —
because they are one subject and only this command has it. The registry reaches
in for :data:`GOTO_PAGE` and the page-id coercion its ``target_params`` imply,
and for nothing else.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote

import voluptuous as vol

from homeassistant.helpers import config_validation as cv

from ...device.protocol import is_valid_page_id
from .base import InternalCommand, InternalCommandError



# ---------------------------------------------------------------------------
# Page identity
# ---------------------------------------------------------------------------


#: ``image`` is an image spec first and a page name second.
_TITLE_SCHEMES = (
    "text:", "mdi:", "logo:", "phu:", "file:", "media:",
    "imgserv://", "http://", "https://", "data:",
)

#: Catalogue slugs needing humanising, e.g. ``logo:sonos`` names "Sonos".
_SLUG_SCHEMES = ("mdi:", "logo:", "phu:")

#: File extension on the tail of a path, not part of the page name.
_EXT_RE = re.compile(r"\.[a-z0-9]{2,4}$", re.IGNORECASE)


def _humanise_slug(value: str) -> str:
    """Turn an icon or logo slug into words."""
    words = re.sub(r"[-_+]+", " ", value).strip()
    return " ".join(w[:1].upper() + w[1:] for w in words.split())


def _looks_opaque(text: str) -> bool:
    """True when *text* is a machine identifier rather than a name."""
    if " " in text:
        return False
    return len(text) >= 16 or bool(re.fullmatch(r"[0-9a-fA-F]{8,}", text))


def page_title(page: dict) -> str:
    """A readable page name from ``image``, or ``""`` if none.

    Schemes, imgserv query strings and percent-encoding are plumbing; ``+`` is
    left literal because imgserv reads the URL path. Icon/logo/file/URL specs
    may still name a page after humanising. Data blobs and opaque ids do not;
    :func:`page_label` supplies "Page N" for those.
    """
    raw = page.get("image") or ""
    if not isinstance(raw, str):
        return ""
    raw = raw.strip()
    if not raw:
        return ""

    scheme = next((s for s in _TITLE_SCHEMES if raw.lower().startswith(s)), "")
    value = raw[len(scheme):]
    # imgserv:// wraps another whole spec; read the inner scheme.
    if scheme == "imgserv://":
        return page_title({"image": value})

    if scheme == "data:":
        return ""

    # Everything after "?" configures the rendering, not the page.
    value = unquote(value.split("?", 1)[0]).strip()
    if not value:
        return ""

    if scheme in _SLUG_SCHEMES:
        return _humanise_slug(value)

    if scheme == "text:":
        # User text is exact; "/" may be part of a name.
        return value

    # A schemeless value is a name too, unless it is plainly a path: the panel
    # prefixes "text:" when it saves one, so these come from layouts and older
    # configs.
    if not scheme and not value.startswith("/") and not _EXT_RE.search(value):
        return value

    # file:, media:, URLs and bare paths: the last path segment is the only
    # part that was ever meant to be read.
    segment = re.split(r"[/:]", value.rstrip("/"))[-1]
    segment = _humanise_slug(_EXT_RE.sub("", segment))
    return "" if not segment or _looks_opaque(segment) else segment


def page_label(page: dict) -> str:
    """A page name for both the dropdown and name resolution, never empty."""
    return page_title(page) or f"Page {page.get('id')}"


def _normalise_name(raw: Any) -> str:
    """Fold a page name to the form names are compared in.

    Users type a page name from memory, and "living room " is the same page as
    "Living Room". Case and surrounding whitespace therefore must not decide
    whether a button works.
    """
    return str(raw).strip().casefold() if isinstance(raw, str) else ""


def build_page_context(pages: list[dict] | None) -> dict:
    """Page ids, titles and name lookup for internal commands.

    Names are not unique, so the lookup maps to lists and ambiguity can be
    reported instead of picking the first page. ``None`` means the caller has no
    page list, which consumers read as unknown rather than missing.
    """
    if pages is None:
        return {}
    valid = [p for p in pages if isinstance(p, dict)]
    by_name: dict[str, list] = {}
    for page in valid:
        key = _normalise_name(page_label(page))
        if key:
            by_name.setdefault(key, []).append(page.get("id"))
    return {
        "page_ids": {p.get("id") for p in valid},
        "page_titles": {p.get("id"): page_label(p) for p in valid},
        "pages_by_name": by_name,
    }


# ---------------------------------------------------------------------------
# goto_page
# ---------------------------------------------------------------------------


def coerce_page_id(raw: Any) -> Any:
    """Turn a page id that survived a UI round trip back into an int.

    HTML ``<select>`` values and hand-written YAML both hand us ``"3"``, which
    :func:`is_valid_page_id` rejects on purpose — the protocol field is a
    32-bit integer. Coercing here keeps that strictness where it belongs
    (device.protocol) instead of loosening it for everyone.
    """
    if isinstance(raw, str):
        text = raw.strip()
        if text.isdigit():
            return int(text)
    return raw


def _pages_named(name: str, context: dict) -> list:
    """Every page id going by *name*, or raise when there is none.

    Raising when the caller has no page list at all is deliberate: the
    alternative is emitting a payload whose target was never checked.
    """
    by_name = context.get("pages_by_name")
    matches = (by_name or {}).get(_normalise_name(name)) or []
    if not matches:
        raise InternalCommandError(
            f"no page named {name!r}", "unknown_page_name", {"page": name}
        )
    return matches


def _goto_page_params(data: Any, context: dict) -> dict:
    """Validate a ``goto_page`` payload into ``{"page_id": <int>}``.

    The panel stores ids because names can be duplicated or renamed; hand-written
    automations may use readable names. If both are present, they must agree or
    the remote could jump somewhere the config does not say.
    """
    payload = data if isinstance(data, dict) else {}
    name = payload.get("page")
    raw_id = coerce_page_id(payload.get("page_id"))
    has_name = isinstance(name, str) and name.strip() != ""
    has_id = raw_id is not None and raw_id != ""

    if not has_name and not has_id:
        raise InternalCommandError("no target given", "no_page_target")

    if has_id and not is_valid_page_id(raw_id):
        raise InternalCommandError(
            f"invalid page_id {raw_id!r}",
            "invalid_page_id",
            {"page_id": str(raw_id)},
        )

    if not has_name:
        # A bare id still has to exist; is_available checks that against the
        # same context the name lookup uses.
        return {"page_id": raw_id}

    matches = _pages_named(name, context)
    if has_id:
        # An id alongside a name is how a name two pages share is made
        # unambiguous, so an id that is one of them settles it. An id that is
        # none of them means the two fields describe different pages.
        if raw_id in matches:
            return {"page_id": raw_id}
        raise InternalCommandError(
            f"page {name!r} is not page {raw_id}",
            "conflicting_page_target",
            {
                "page": name,
                "resolved": ", ".join(str(m) for m in matches),
                "page_id": str(raw_id),
            },
        )
    if len(matches) > 1:
        raise InternalCommandError(
            f"page name {name!r} is ambiguous",
            "ambiguous_page_name",
            {"page": name, "count": str(len(matches))},
        )
    return {"page_id": matches[0]}


def _goto_page_label(params: dict, context: dict) -> str:
    """Name the page a ``goto_page`` button opens.

    A device-local command has no entity to borrow a name from, so without this
    the button would be labelled by its service name ("Goto page lizaip"),
    which tells the user nothing about where it goes. What is *done* to the
    page is ``label_prefix``'s job, not this one's.
    """
    page_id = params.get("page_id")
    title = (context.get("page_titles") or {}).get(page_id) or ""
    return title or f"Page {page_id}"


def _goto_page_available(params: dict, context: dict) -> bool:
    """False once the target page is gone.

    ``page_ids`` is absent when the caller has no page list at hand; that is
    "unknown", not "missing", so the button stays armed.
    """
    page_ids = context.get("page_ids")
    if page_ids is None:
        return True
    return params.get("page_id") in page_ids


async def _goto_page_run(connection: Any, params: dict) -> Any:
    return await connection.goto_page(params["page_id"])


GOTO_PAGE = InternalCommand(
    service="goto_page",
    action_type="goto_page",
    icon="mdi:page-next",
    name="Go to page",
    build_params=_goto_page_params,
    run=_goto_page_run,
    # Cross-field existence/range checks live in build_params for translations.
    schema=vol.Schema({
        vol.Optional("page"): str,
        vol.Optional("page_id"): vol.Any(int, str),
        vol.Optional("config_entry_id"): str,
        # Non-entity services receive raw target keys in call.data.
        **cv.TARGET_SERVICE_FIELDS,
    }),
    build_label=_goto_page_label,
    is_available=_goto_page_available,
    target_params=(
        {"key": "page", "type": "page_name"},
        {"key": "page_id", "type": "page_id"},
    ),
)
