"""lizaIP as an LLM API: tools an AI assistant uses to build pages for a remote.

Registered with Home Assistant's LLM API registry (``homeassistant.helpers.llm``),
so any conversation agent set up in Home Assistant -- Anthropic, OpenAI, Google,
Ollama -- can be given it beside Assist, and Home Assistant's MCP Server hands
it to MCP clients such as Claude Desktop or Claude Code. "Make me a page for my
shades" then becomes: find the cover entities, describe the remote, create the
page.

A page an assistant makes is an ordinary page appended to the remote's
configuration -- no template link, nothing to refresh, exactly what a blank
page filled in by hand stores. Only the building is shared with templates: the
buttons are checked and turned into actions and assignments by the same
generator (``config.page_templates.generate``), and the page is written by the
panel's own path (``async_add_template_page`` with an unbound definition, which
stores no ``template:`` key), so the action library, the device sync and the
push triggers behave as for any other page. A tool only ever creates
a page, changes the one button it names, or deletes the one page it names --
and that page's title has to be given too, so a misremembered id deletes
nothing.

Safety follows Home Assistant's own rules for assistants: a change needs an
admin user behind the request, and only entities exposed to that assistant can
be found or put on a button.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import re
from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import llm
from homeassistant.helpers.llm import JsonObjectType
from homeassistant.util.ulid import ulid_now

from .action_controller.sliders import SLIDER_CONTROLS
from .const import DOMAIN
from .shared.assignment import ASSIGNMENT_REPEAT_KEY

_LOGGER = logging.getLogger(__name__)

LLM_API_ID = DOMAIN
LLM_API_NAME = "liza"

#: The twelve grid buttons, four columns by three rows, numbered row by row.
GRID_SLOTS = tuple(f"button_{n}" for n in range(1, 13))
#: The fixed keys around the grid that a page may give an action of its own.
FIXED_SLOTS = (
    "button_power", "button_back", "button_voice",
    "button_volume_up", "button_volume_down",
)
SLOTS = GRID_SLOTS + FIXED_SLOTS

#: Slider controls by id, for a button that steers the vertical slider.
_CONTROLS = {c.id: c for c in SLIDER_CONTROLS}

_FIND_LIMIT = 60

API_PROMPT = """\
lizaIP lets you build pages for a lizaIP remote control (a handheld remote with a \
touch screen). A page shows 12 grid buttons, 4 columns by 3 rows numbered \
button_1..button_4 (top row) to button_9..button_12 (bottom row), plus fixed keys \
(button_power, button_back, button_voice, button_volume_up, button_volume_down) and \
a vertical slider. Each button runs one Home Assistant action when pressed.

When a ready-made template fits the request (a Sonos speaker, a TV, Hue lights), \
use it: call lizaip_list_templates, pick the template and \
the target matching what the user named (match the area for "in the living room"), \
then lizaip_add_template_page. Otherwise build the page button by button: call \
lizaip_find_entities to find the entities the user means, lizaip_describe_remote if \
you need the layout or a page's current buttons, then lizaip_create_page. Use dry_run first when unsure and show the user the plan. \
Give every button a short tooltip and an icon: "mdi:<name>" (Material Design Icons), \
"logo:<brand>" for a brand, or "text:<words>". Prefer toggles for things with an on \
and off state (light.toggle, cover.toggle, switch.toggle, fan.toggle) and \
scene.turn_on / script.turn_on for scenes and scripts. A button can steer the \
vertical slider while it is selected (slider: cover-position for a shade, \
light-brightness for a lamp). Set key_repeat: true for keys meant to be held (volume, \
arrows). A button's tooltip is the text the remote shows for it; its icon is the \
tile picture. To change only a tooltip or icon, call lizaip_update_button with just \
that field; to rearrange, lizaip_move_button swaps two slots; lizaip_update_page \
renames, moves or hides a page. Only change or delete what the user asked for; \
deleting a page needs its page_id and its name.\
"""

_BUTTON_SCHEMA = vol.Schema({
    vol.Required("slot"): vol.In(SLOTS),
    vol.Required("action"): str,
    vol.Optional("entity_id"): str,
    vol.Optional("data"): dict,
    vol.Optional("tooltip"): str,
    vol.Optional("icon"): str,
    vol.Optional("key_repeat"): bool,
    vol.Optional("slider"): vol.In(sorted(_CONTROLS)),
})


class LizaIPToolError(HomeAssistantError):
    """A tool call the assistant has to correct; the message says how."""


_WRITE_LOCK_KEY = f"{DOMAIN}_llm_write_lock"


def _write_lock(hass: HomeAssistant) -> asyncio.Lock:
    data = getattr(hass, "data", None)
    if isinstance(data, dict):
        return data.setdefault(_WRITE_LOCK_KEY, asyncio.Lock())
    lock = getattr(hass, "_lizaip_llm_write_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        setattr(hass, "_lizaip_llm_write_lock", lock)
    return lock


def _serialized(call):
    """Run a changing tool alone.

    Assistants issue tool calls in parallel, and each changing tool reads a
    page's buttons and the action library, awaits, then writes them back
    whole -- so two at once lose one change (eight overview links set at once
    kept two).
    """
    @functools.wraps(call)
    async def wrapper(self, hass, tool_input, llm_context):
        async with _write_lock(hass):
            return await call(self, hass, tool_input, llm_context)
    return wrapper


# ── shared helpers ─────────────────────────────────────────────────────


def _entries(hass: HomeAssistant) -> list:
    from .runtime import _resolve_device_id

    return [
        entry for entry in hass.config_entries.async_entries(DOMAIN)
        if _resolve_device_id(hass, entry.entry_id)
    ]


def _remote(hass: HomeAssistant, wanted: str | None) -> tuple[Any, str]:
    """``(entry, device_id)`` for the remote named by *wanted*, or the only one."""
    from .runtime import _resolve_device_id

    entries = _entries(hass)
    if not entries:
        raise LizaIPToolError("No lizaIP remote is connected")
    if wanted:
        folded = wanted.strip().casefold()
        matches = [
            e for e in entries
            if e.entry_id == wanted or (e.title or "").casefold() == folded
        ]
    else:
        matches = entries if len(entries) == 1 else []
    if len(matches) != 1:
        names = ", ".join(f"{e.title} ({e.entry_id})" for e in entries)
        raise LizaIPToolError(
            f"Name the remote: one of {names}" if not wanted
            else f"No single remote matches {wanted!r}; remotes: {names}"
        )
    entry = matches[0]
    return entry, _resolve_device_id(hass, entry.entry_id)


async def _require_admin(hass: HomeAssistant, llm_context: llm.LLMContext) -> None:
    """Changing a remote is an admin's call, as it is in the panel."""
    context = llm_context.context
    user_id = getattr(context, "user_id", None) if context else None
    if not user_id:
        return
    user = await hass.auth.async_get_user(user_id)
    if user is not None and not user.is_admin:
        raise LizaIPToolError("Only an administrator may change the remote's pages")


def _exposed(hass: HomeAssistant, llm_context: llm.LLMContext, entity_id: str) -> bool:
    assistant = llm_context.assistant
    if not assistant:
        return True
    from homeassistant.components.homeassistant.exposed_entities import (
        async_should_expose,
    )

    return async_should_expose(hass, assistant, entity_id)


def _area_name(hass: HomeAssistant, entity_id: str) -> str:
    ent = er.async_get(hass).async_get(entity_id)
    area_id = ent.area_id if ent else None
    if not area_id and ent and ent.device_id:
        device = dr.async_get(hass).async_get(ent.device_id)
        area_id = device.area_id if device else None
    area = ar.async_get(hass).async_get_area(area_id) if area_id else None
    return area.name if area else ""


def _template_button(
    hass: HomeAssistant, llm_context: llm.LLMContext, spec: dict,
) -> dict:
    """One button of the template a tool writes, after checking what it names."""
    action = spec["action"].strip()
    if not re.fullmatch(r"[a-z0-9_]+\.[a-z0-9_]+", action):
        raise LizaIPToolError(f"{spec['slot']}: {action!r} is not an action (domain.service)")
    domain, service = action.split(".", 1)
    if not hass.services.has_service(domain, service):
        raise LizaIPToolError(f"{spec['slot']}: Home Assistant has no action {action}")

    entity_id = (spec.get("entity_id") or "").strip()
    if entity_id:
        if hass.states.get(entity_id) is None:
            raise LizaIPToolError(f"{spec['slot']}: there is no entity {entity_id}")
        if not _exposed(hass, llm_context, entity_id):
            raise LizaIPToolError(
                f"{spec['slot']}: {entity_id} is not exposed to this assistant"
            )

    step: dict[str, Any] = {"action": action}
    if entity_id:
        step["target"] = {"entity_id": entity_id}
    if spec.get("data"):
        step["data"] = dict(spec["data"])
    button: dict[str, Any] = {"config": [step]}
    if spec.get("tooltip"):
        button["tooltip"] = spec["tooltip"]
    if spec.get("icon"):
        button["icon"] = spec["icon"]
    if spec.get("key_repeat"):
        button[ASSIGNMENT_REPEAT_KEY] = True

    control_id = spec.get("slider")
    if control_id:
        control = _CONTROLS[control_id]
        if not entity_id or entity_id.split(".", 1)[0] != control.domain:
            raise LizaIPToolError(
                f"{spec['slot']}: the {control_id} slider needs a {control.domain} entity"
            )
        if spec["slot"] not in GRID_SLOTS:
            raise LizaIPToolError(f"{spec['slot']}: only a grid button can steer the slider")
        button["overrides"] = {
            "slider_vertical": {"entity_id": entity_id, "control": control_id},
        }
    return button


def _summary(slot: str, assignment: dict) -> dict:
    step = (assignment.get("config") or [{}])[0] if assignment.get("config") else {}
    target = step.get("target") if isinstance(step, dict) else None
    entity = (target or {}).get("entity_id") if isinstance(target, dict) else None
    return {
        "slot": slot,
        "tooltip": assignment.get("tooltip") or "",
        "icon": assignment.get("icon") or "",
        "action": step.get("action", "") if isinstance(step, dict) else "",
        **({"entity_id": entity} if entity else {}),
        **({"data": step["data"]} if isinstance(step, dict) and step.get("data") else {}),
    }


def _patched(assignment: dict, args: dict) -> dict:
    """*assignment* with only its tooltip, picture or repeat changed.

    Marked as the user's own, as the panel marks an edited tooltip and a chosen
    picture, so nothing derived writes over them afterwards.
    """
    patched = dict(assignment)
    if "tooltip" in args:
        patched["tooltip"] = args["tooltip"]
        patched["tooltip_edited"] = True
    if "icon" in args:
        patched["icon"] = args["icon"]
        patched["icon_pinned"] = True
    if "key_repeat" in args:
        if args["key_repeat"]:
            patched[ASSIGNMENT_REPEAT_KEY] = True
        else:
            patched.pop(ASSIGNMENT_REPEAT_KEY, None)
    return patched


def _assigned(assignment: Any) -> bool:
    return isinstance(assignment, dict) and bool(assignment.get("config"))


def _generate(page_key: str, buttons: dict, hass: HomeAssistant):
    """``(actions, assignments)`` for *buttons*, with plain ``ai_…`` action ids.

    The generator names what it makes after a template (``template_<id>_…``);
    these buttons belong to no template, so their library entries say where
    they came from instead.
    """
    from .config.page_templates import generate_assignments

    definition = {"buttons": buttons}
    actions, assignments = generate_assignments(page_key, "", definition, None, hass)
    prefix = f"template_{page_key}_"
    renamed = {
        a["id"]: f"{page_key}_{a['id'][len(prefix):]}"
        for a in actions if str(a.get("id", "")).startswith(prefix)
    }
    for action in actions:
        action["id"] = renamed.get(action["id"], action["id"])
    for assignment in assignments.values():
        if isinstance(assignment, dict) and assignment.get("action_id") in renamed:
            assignment["action_id"] = renamed[assignment["action_id"]]
    return actions, assignments


async def _notify(hass: HomeAssistant, entry_id: str) -> None:
    from .config.events import fire_config_changed
    from .config.websocket.common import refresh_state_listener, schedule_push_rescan

    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    schedule_push_rescan(hass, entry_id)


def _is_picture_part(part: str) -> bool:
    from .imgserv.const import PART_SOURCE_TYPES, is_address

    if is_address(part):
        return True
    m = re.match(r"^([a-z][a-z0-9_]*):", part)
    return bool(m) and m.group(1) not in ("text", "ref") and (
        m.group(1) in PART_SOURCE_TYPES or ":" in part
    )


def _title_parts(title: str) -> tuple[list[str], str]:
    """The words and the first picture of a page's title.

    Variables are left out (they would be read against the wrong page), and so
    are a part's options (``text:demo?percent=47``).
    """
    from .imgserv.const import split_source_parts

    words: list[str] = []
    picture = ""
    for part in split_source_parts(re.sub(r"\$\{[^}]*\}", "", title or "").strip()):
        part = part.split("?", 1)[0].strip()
        if not part or part in ("+", "-"):
            continue
        if part.startswith("text:"):
            words.append(part[len("text:"):].strip())
        elif _is_picture_part(part):
            picture = picture or part
        else:
            words.append(part)
    return [w for w in words if w and w not in ("+", "-")], picture


def _page_name(title: str, page_id: Any = None) -> str:
    """A page's name: the words of its title, else the name of its picture."""
    words, picture = _title_parts(title)
    name = " ".join(words).strip(" +-")
    if not name and picture and ":" in picture and not picture.startswith(("media:", "/", "http")):
        slug = picture.split(":", 1)[1]
        name = " ".join(w[:1].upper() + w[1:] for w in re.split(r"[-_]+", slug) if w)
    return name or (f"Page {page_id}" if page_id is not None else "")


def _page_title(name: str, icon: str | None) -> str:
    words = f"text:{name.strip()}" if name.strip() else ""
    return " ".join(p for p in ((icon or "").strip(), words) if p)


# ── the tools ──────────────────────────────────────────────────────────


class ListRemotesTool(llm.Tool):
    name = "lizaip_list_remotes"
    description = "List the connected lizaIP remotes and the pages each one has."
    parameters = vol.Schema({})

    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .runtime import _get_store

        store = _get_store(hass)
        remotes = []
        for entry in _entries(hass):
            _, device_id = _remote(hass, entry.entry_id)
            pages = await store.async_get_pages(device_id)
            remotes.append({
                "remote": entry.entry_id,
                "name": entry.title,
                "pages": [
                    {
                        "page_id": p["id"],
                        "name": _page_name(str(p.get("title") or ""), p["id"]),
                        "title": p.get("title") or "",
                        "subpage": bool(p.get("subpage")),
                    }
                    for p in pages if isinstance(p, dict) and p.get("id") is not None
                ],
            })
        return {"remotes": remotes}


class DescribeRemoteTool(llm.Tool):
    name = "lizaip_describe_remote"
    description = (
        "Describe a remote's button layout, the picture forms a button takes and the "
        "slider controls; with page_id, also that page's current buttons."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Optional("page_id"): vol.Coerce(int),
    })

    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .runtime import _get_store

        args = tool_input.tool_args
        entry, device_id = _remote(hass, args.get("remote"))
        result: dict[str, Any] = {
            "remote": entry.entry_id,
            "name": entry.title,
            "grid": [list(GRID_SLOTS[r * 4:(r + 1) * 4]) for r in range(3)],
            "fixed_keys": list(FIXED_SLOTS),
            "icons": {
                "mdi:<name>": "a Material Design Icon, e.g. mdi:window-shutter",
                "logo:<brand>": "a bundled brand logo, e.g. logo:sonos",
                "text:<words>": "words drawn as a picture",
                "/local/<file>": "a picture from Home Assistant's www folder",
            },
            "slider_controls": [
                {"id": c.id, "domain": c.domain, "label": c.label} for c in SLIDER_CONTROLS
            ],
        }
        page_id = args.get("page_id")
        if page_id is not None:
            pages = await store_pages(hass, device_id)
            if page_id not in {p.get("id") for p in pages}:
                raise LizaIPToolError(f"The remote has no page {page_id}")
            assignments = await _get_store(hass).async_get_assignments(device_id, page_id) or {}
            result["page"] = {
                "page_id": page_id,
                "buttons": [
                    _summary(slot, assignments[slot])
                    for slot in SLOTS if _assigned(assignments.get(slot))
                ],
            }
        return result


async def store_pages(hass: HomeAssistant, device_id: str) -> list[dict]:
    from .runtime import _get_store

    return [p for p in await _get_store(hass).async_get_pages(device_id) if isinstance(p, dict)]


class FindEntitiesTool(llm.Tool):
    name = "lizaip_find_entities"
    description = (
        "Find Home Assistant entities to put on buttons, by domain (cover, light, "
        "scene, ...), area name and/or words in their name. Only entities exposed to "
        "this assistant are returned."
    )
    parameters = vol.Schema({
        vol.Optional("domain"): str,
        vol.Optional("area"): str,
        vol.Optional("query"): str,
    })

    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        args = tool_input.tool_args
        domain = (args.get("domain") or "").strip().lower()
        area = (args.get("area") or "").strip().casefold()
        query = (args.get("query") or "").strip().casefold()
        states = hass.states.async_all(domain) if domain else hass.states.async_all()
        found = []
        for state in states:
            if not _exposed(hass, llm_context, state.entity_id):
                continue
            area_name = _area_name(hass, state.entity_id)
            if area and area_name.casefold() != area:
                continue
            name = state.name or state.entity_id
            if query and query not in name.casefold() and query not in state.entity_id:
                continue
            found.append({
                "entity_id": state.entity_id,
                "name": name,
                "area": area_name,
                "state": state.state,
                "slider_controls": [
                    c.id for c in SLIDER_CONTROLS if c.domain == state.domain
                ],
            })
            if len(found) >= _FIND_LIMIT:
                break
        return {"entities": found, "truncated": len(found) >= _FIND_LIMIT}


class CreatePageTool(llm.Tool):
    name = "lizaip_create_page"
    description = (
        "Create a new page on a lizaIP remote, headed by its name (and title_icon, if "
        "given). Each button names its slot, the action "
        "it runs, the entity it acts on, a short tooltip and an icon. Set dry_run to see "
        "the result without saving it. Existing pages are never changed."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Required("name"): str,
        vol.Optional("title_icon"): str,
        vol.Required("buttons"): [_BUTTON_SCHEMA],
        vol.Optional("subpage", default=False): bool,
        vol.Optional("dry_run", default=False): bool,
    })

    @_serialized
    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.websocket.templates import TemplatePageError, async_add_template_page

        args = self.parameters(tool_input.tool_args)
        entry, device_id = _remote(hass, args.get("remote"))
        if not args.get("dry_run", False):
            await _require_admin(hass, llm_context)

        slots = [b["slot"] for b in args["buttons"]]
        if len(slots) != len(set(slots)):
            raise LizaIPToolError("Each slot may be given only once")
        if not slots:
            raise LizaIPToolError("A page needs at least one button")
        buttons_def = {
            b["slot"]: _template_button(hass, llm_context, b) for b in args["buttons"]
        }
        title = _page_title(args["name"], args.get("title_icon"))
        page_key = f"ai_{ulid_now()[-8:].lower()}"

        actions, assignments = _generate(page_key, buttons_def, hass)
        skipped = [s for s in slots if not _assigned(assignments.get(s))]
        if skipped:
            raise LizaIPToolError(
                "These buttons could not be built -- the action does not fit the "
                f"entity: {', '.join(skipped)}"
            )
        buttons = [_summary(s, assignments[s]) for s in slots]
        if args.get("dry_run", False):
            return {"dry_run": True, "remote": entry.entry_id, "title": title, "buttons": buttons}

        try:
            # Appended as an ordinary page: unbound, so no `template:` link.
            page_id = await async_add_template_page(
                hass, entry.entry_id, device_id, page_key,
                {"buttons": buttons_def},
                title=title, subpage=args.get("subpage", False),
                generated=(actions, assignments),
            )
        except TemplatePageError as err:
            raise LizaIPToolError(str(err)) from err
        _LOGGER.info(
            "[%s] An assistant created page %s (%r, %d buttons)",
            entry.title, page_id, args["name"], len(buttons),
        )
        return {
            "success": True, "remote": entry.entry_id, "page_id": page_id,
            "title": title, "buttons": buttons,
        }


class UpdateButtonTool(llm.Tool):
    name = "lizaip_update_button"
    description = (
        "Change one button on an existing page. Give only what changes: a tooltip "
        "(the words the remote shows), an icon (its tile picture) or key_repeat on their own "
        "keep the button's action; giving an action rebuilds the button. "
        "delete: true empties it. Every other button stays as it is."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Required("page_id"): vol.Coerce(int),
        vol.Required("slot"): vol.In(SLOTS),
        vol.Optional("delete", default=False): bool,
        vol.Optional("action"): str,
        vol.Optional("entity_id"): str,
        vol.Optional("data"): dict,
        vol.Optional("tooltip"): str,
        vol.Optional("icon"): str,
        vol.Optional("key_repeat"): bool,
        vol.Optional("slider"): vol.In(sorted(_CONTROLS)),
    })

    @_serialized
    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.websocket.common import EMPTY_BUTTON
        from .runtime import _get_store

        args = self.parameters(tool_input.tool_args)
        entry, device_id = _remote(hass, args.get("remote"))
        await _require_admin(hass, llm_context)
        page_id, slot = args["page_id"], args["slot"]
        if page_id not in {p.get("id") for p in await store_pages(hass, device_id)}:
            raise LizaIPToolError(f"The remote has no page {page_id}")

        store = _get_store(hass)
        assignments = dict(await store.async_get_assignments(device_id, page_id) or {})
        if args.get("delete", False):
            assignments[slot] = dict(EMPTY_BUTTON)
            result: dict[str, Any] = {"slot": slot, "deleted": True}
        elif not args.get("action"):
            if args.get("entity_id") or args.get("data") or args.get("slider"):
                raise LizaIPToolError(
                    "entity_id, data and slider come with an action: give the action too"
                )
            if not any(k in args for k in ("tooltip", "icon", "key_repeat")):
                raise LizaIPToolError("Say what changes: tooltip, icon, key_repeat, an action, or delete")
            current = assignments.get(slot)
            if not _assigned(current):
                raise LizaIPToolError(f"{slot} is empty; give it an action first")
            patched = _patched(current, args)
            assignments[slot] = patched
            result = _summary(slot, patched)
        else:
            spec = {k: v for k, v in args.items() if k not in ("remote", "page_id", "delete")}
            buttons_def = {slot: _template_button(hass, llm_context, spec)}
            actions, generated = _generate(f"ai_page_{page_id}", buttons_def, hass)
            if not _assigned(generated.get(slot)):
                raise LizaIPToolError(f"{slot}: the action does not fit the entity")
            library = await store.async_get_action_library(device_id)
            by_id = {a.get("id"): i for i, a in enumerate(library)}
            for action in actions:
                if action["id"] in by_id:
                    library[by_id[action["id"]]] = action
                else:
                    library.append(action)
            await store.async_set_action_library(device_id, library)
            assignments[slot] = generated[slot]
            result = _summary(slot, generated[slot])

        await store.async_set_assignments(device_id, page_id, assignments)
        await store.async_recompute_page_hash(device_id, page_id)
        await _notify(hass, entry.entry_id)
        _LOGGER.info("[%s] An assistant changed %s on page %s", entry.title, slot, page_id)
        return {"success": True, "page_id": page_id, "button": result}


class DeletePageTool(llm.Tool):
    name = "lizaip_delete_page"
    description = (
        "Delete one page from a remote. Give its page_id and its name as listed by "
        "lizaip_list_remotes; nothing is deleted unless both match."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Required("page_id"): vol.Coerce(int),
        vol.Required("name"): str,
    })

    @_serialized
    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.websocket.common import schedule_push_rescan
        from .config.websocket.pages import _push_page_list, async_drop_links_to
        from .runtime import _get_store

        args = self.parameters(tool_input.tool_args)
        entry, device_id = _remote(hass, args.get("remote"))
        await _require_admin(hass, llm_context)
        pages = await store_pages(hass, device_id)
        page = next((p for p in pages if p.get("id") == args["page_id"]), None)
        if page is None:
            raise LizaIPToolError(f"The remote has no page {args['page_id']}")
        name = _page_name(str(page.get("title") or ""), page["id"])
        if name.casefold() != args["name"].strip().casefold():
            raise LizaIPToolError(
                f"Page {page['id']} is named {name!r}, not {args['name']!r}; nothing deleted"
            )
        remaining = [p for p in pages if p.get("id") != page["id"]]
        if not remaining:
            raise LizaIPToolError("The last page of a remote cannot be deleted")

        store = _get_store(hass)
        await store.async_set_pages(device_id, remaining)
        # Links to the deleted page go with it, as when the panel deletes one.
        await async_drop_links_to(hass, entry.entry_id, store, device_id, {page["id"]})
        schedule_push_rescan(hass, entry.entry_id)
        await _push_page_list(hass, entry.entry_id, remaining, False)
        _LOGGER.info("[%s] An assistant deleted page %s (%r)", entry.title, page["id"], name)
        return {"success": True, "deleted": {"page_id": page["id"], "name": name}}


_TARGET_LIMIT = 40


def _template_targets(hass: HomeAssistant, template: dict) -> tuple[str, list[dict]]:
    """``(kind, targets)`` a template can be bound to: devices, hubs, or nothing."""
    from .config.page_templates import is_unbound
    from .config.websocket.templates import _eligible_devices, selector_integrations

    if is_unbound(template):
        return "none", []
    selector = template.get("target_selector") or {}
    if selector.get("config_entry"):
        targets = [
            {"target": e.entry_id, "name": e.title, "integration": e.domain}
            for integration in selector_integrations(selector["config_entry"])
            for e in hass.config_entries.async_entries(integration)
            if not e.disabled_by
        ]
        return "config_entry", targets[:_TARGET_LIMIT]
    if selector.get("device"):
        areas = ar.async_get(hass)
        devices = dr.async_get(hass)
        targets = []
        for found in _eligible_devices(hass, selector["device"]):
            device = devices.async_get(found["id"])
            area = areas.async_get_area(device.area_id) if device and device.area_id else None
            targets.append({
                "target": found["id"], "name": found["name"],
                "area": area.name if area else "",
            })
        return "device", targets[:_TARGET_LIMIT]
    return "none", []


class ListTemplatesTool(llm.Tool):
    name = "lizaip_list_templates"
    description = (
        "List the ready-made page templates (Sonos, TVs, Hue, ...) that can "
        "be added right now, each with the devices or hubs it can be bound to and "
        "their area. Prefer a template when one fits what the user asks for."
    )
    parameters = vol.Schema({})

    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.page_templates import list_templates, load_template
        from .config.websocket.templates import _template_has_target

        result = []
        for meta in await hass.async_add_executor_job(list_templates):
            if not _template_has_target(hass, meta):
                continue
            template = await hass.async_add_executor_job(load_template, meta["id"]) or {}
            kind, targets = _template_targets(hass, template)
            result.append({
                "template_id": meta["id"],
                "name": meta.get("name") or meta["id"],
                "description": meta.get("description") or "",
                "binds_to": kind,
                "targets": targets,
                # More than one: the template adds its page plus subpages
                # reached from it, as one set.
                "pages": meta.get("page_count", 1),
            })
        return {"templates": result}


class AddTemplatePageTool(llm.Tool):
    name = "lizaip_add_template_page"
    description = (
        "Add a page made from a template to a remote, bound to one of the targets "
        "lizaip_list_templates names for it (a device or hub; nothing for templates "
        "that bind to none). The page keeps itself up to date from that device, as "
        "one added in the panel does. A template listed with several pages adds "
        "them all, the first leading to the others; page_ids names every one."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Required("template_id"): str,
        vol.Optional("target"): str,
        vol.Optional("subpage", default=False): bool,
    })

    @_serialized
    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.page_templates import load_template
        from .config.websocket.templates import (
            TemplatePageError,
            async_create_page_from_template,
            template_set_page_ids,
        )

        args = self.parameters(tool_input.tool_args)
        entry, device_id = _remote(hass, args.get("remote"))
        await _require_admin(hass, llm_context)
        template_id = args["template_id"]
        template = await hass.async_add_executor_job(load_template, template_id)
        if not template:
            raise LizaIPToolError(f"There is no template {template_id!r}")
        kind, targets = _template_targets(hass, template)

        target_device = target_entry = ""
        if kind != "none":
            wanted = (args.get("target") or "").strip()
            folded = wanted.casefold()
            matches = [
                t for t in targets
                if wanted and (t["target"] == wanted or t["name"].casefold() == folded)
            ]
            if len(matches) != 1:
                listed = ", ".join(
                    f"{t['name']}{' (' + t['area'] + ')' if t.get('area') else ''} = {t['target']}"
                    for t in targets
                )
                raise LizaIPToolError(
                    f"Name one target for {template_id}: {listed or 'none available'}"
                )
            if kind == "device":
                target_device = matches[0]["target"]
            else:
                target_entry = matches[0]["target"]

        try:
            page_id = await async_create_page_from_template(
                hass, entry.entry_id, device_id, template_id,
                target_device=target_device, target_config_entry=target_entry,
                subpage=args.get("subpage", False),
            )
        except TemplatePageError as err:
            raise LizaIPToolError(str(err)) from err
        _LOGGER.info(
            "[%s] An assistant added page %s from template %s (%s)",
            entry.title, page_id, template_id, target_device or target_entry or "unbound",
        )
        pages = await store_pages(hass, device_id)
        return {
            "success": True, "remote": entry.entry_id, "page_id": page_id,
            "page_ids": template_set_page_ids(pages, page_id),
            "template_id": template_id,
            "target": target_device or target_entry or None,
        }


class MoveButtonTool(llm.Tool):
    name = "lizaip_move_button"
    description = (
        "Move a button to another slot of the same page; whatever is on that slot "
        "moves to the first one (a swap, as Move in the panel's button menu)."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Required("page_id"): vol.Coerce(int),
        vol.Required("from_slot"): vol.In(SLOTS),
        vol.Required("to_slot"): vol.In(SLOTS),
    })

    @_serialized
    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.websocket.common import EMPTY_BUTTON
        from .runtime import _get_store

        args = self.parameters(tool_input.tool_args)
        entry, device_id = _remote(hass, args.get("remote"))
        await _require_admin(hass, llm_context)
        page_id, source, target = args["page_id"], args["from_slot"], args["to_slot"]
        if source == target:
            raise LizaIPToolError("from_slot and to_slot are the same")
        if page_id not in {p.get("id") for p in await store_pages(hass, device_id)}:
            raise LizaIPToolError(f"The remote has no page {page_id}")

        store = _get_store(hass)
        assignments = dict(await store.async_get_assignments(device_id, page_id) or {})
        if not _assigned(assignments.get(source)):
            raise LizaIPToolError(f"{source} is empty; there is nothing to move")
        # Whole records, bindings and per-button overrides included: what a
        # button is travels with it, as it does in the panel.
        moving = assignments[source]
        assignments[source] = assignments.get(target) or dict(EMPTY_BUTTON)
        assignments[target] = moving

        await store.async_set_assignments(device_id, page_id, assignments)
        await store.async_recompute_page_hash(device_id, page_id)
        await _notify(hass, entry.entry_id)
        _LOGGER.info("[%s] An assistant moved %s to %s on page %s",
                     entry.title, source, target, page_id)
        return {
            "success": True, "page_id": page_id,
            "buttons": [_summary(s, assignments[s]) for s in (source, target)
                        if _assigned(assignments.get(s))],
        }


class UpdatePageTool(llm.Tool):
    name = "lizaip_update_page"
    description = (
        "Change a page: its name, its title icon, its position among the pages "
        "(1 = first), or whether it is a subpage (reachable only from a 'go to page' "
        "button, not in the remote's own page list). Give only what changes."
    )
    parameters = vol.Schema({
        vol.Optional("remote"): str,
        vol.Required("page_id"): vol.Coerce(int),
        vol.Optional("name"): str,
        vol.Optional("title_icon"): str,
        vol.Optional("position"): vol.All(vol.Coerce(int), vol.Range(min=1)),
        vol.Optional("subpage"): bool,
    })

    @_serialized
    async def async_call(self, hass, tool_input, llm_context) -> JsonObjectType:
        from .config.const import PAGE_SUBPAGE_KEY
        from .config.events import fire_config_changed
        from .config.websocket.pages import _push_page_list
        from .runtime import _get_store

        args = self.parameters(tool_input.tool_args)
        entry, device_id = _remote(hass, args.get("remote"))
        await _require_admin(hass, llm_context)
        if not any(k in args for k in ("name", "title_icon", "position", "subpage")):
            raise LizaIPToolError("Say what changes: name, title_icon, position or subpage")

        store = _get_store(hass)
        pages = await store_pages(hass, device_id)
        page = next((p for p in pages if p.get("id") == args["page_id"]), None)
        if page is None:
            raise LizaIPToolError(f"The remote has no page {args['page_id']}")

        content_changed = False
        if "name" in args or "title_icon" in args:
            current = str(page.get("title") or "")
            name = args.get("name", _page_name(current, page["id"]))
            icon = args.get("title_icon", _title_parts(current)[1])
            page["title"] = _page_title(name, icon)
            content_changed = True
        if "subpage" in args:
            # Written whether true or false, as the panel does: the store keeps
            # the key only while it is true.
            page[PAGE_SUBPAGE_KEY] = args["subpage"]
            content_changed = True
        moved = False
        if "position" in args:
            index = min(args["position"], len(pages)) - 1
            pages.remove(page)
            pages.insert(index, page)
            moved = True

        await store.async_set_pages(device_id, pages)
        if content_changed:
            await store.async_recompute_page_hash(device_id, page["id"])
        if moved:
            await _push_page_list(hass, entry.entry_id, pages, not content_changed)
        else:
            fire_config_changed(hass, entry.entry_id)
        pages = await store_pages(hass, device_id)
        _LOGGER.info("[%s] An assistant changed page %s", entry.title, page["id"])
        return {
            "success": True, "page_id": page["id"],
            "name": _page_name(str(page.get("title") or ""), page["id"]),
            "title": page.get("title") or "",
            "position": [p.get("id") for p in pages].index(page["id"]) + 1,
            "subpage": bool(page.get(PAGE_SUBPAGE_KEY)),
        }


TOOLS: tuple[type[llm.Tool], ...] = (
    ListRemotesTool, DescribeRemoteTool, FindEntitiesTool,
    ListTemplatesTool, AddTemplatePageTool,
    CreatePageTool, UpdateButtonTool, MoveButtonTool, UpdatePageTool, DeletePageTool,
)


class LizaIPAPI(llm.API):
    """The tools an assistant gets when lizaIP is chosen as one of its LLM APIs."""

    async def async_get_api_instance(self, llm_context: llm.LLMContext) -> llm.APIInstance:
        return llm.APIInstance(
            api=self,
            api_prompt=API_PROMPT,
            llm_context=llm_context,
            tools=[tool() for tool in TOOLS],
        )


def async_register_llm_api(hass: HomeAssistant):
    """Offer the lizaIP API to conversation agents and MCP; return its remover."""
    return llm.async_register_api(hass, LizaIPAPI(hass=hass, id=LLM_API_ID, name=LLM_API_NAME))
