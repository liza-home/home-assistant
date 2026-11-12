"""User-editable YAML store for lizaIP remote configuration.

The integration deliberately keeps per-device files under
``config/lizaip/<device_id>/`` instead of HA ``storage.Store`` so users can
inspect and edit action libraries, page order, and page button YAML by hand.

The persisted shape is also the panel/device contract: action libraries are
lists, page order is a list of 32-bit page ids, and page files hold page
metadata plus button assignments keyed by blueprint button id.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import tempfile
from contextlib import suppress
from copy import deepcopy
from typing import Any, Final

import yaml

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from ..action_controller import (
    OVERRIDABLE_FIXED_BUTTONS,
    SLIDER_VERTICAL_KEY,
    TOGGLE_KEY,
    sanitize_slider_override,
    sanitize_toggle,
)
from ..shared.logs import device_id_logger
from ..shared.assignment import (
    longtouch_steps,
    ASSIGNMENT_DYNAMIC_KEY,
    ASSIGNMENT_TOOLTIP_EDITED_KEY,
    ASSIGNMENT_REPEAT_KEY,
    name_is_user_written,
)
from .const import PAGE_SUBPAGE_KEY, is_subpage
from ..shared.i18n import button_tooltips, translate_ref
from ..shared.tooltips import STATE_TOOLTIP, TRANSLATE_STATE_RE
from ..config.page_templates import async_load_template, template_bindings, load_template
from ..config.page_templates.catalog import (
    TEMPLATE_PAGES_KEY,
    TEMPLATE_VERSION_KEY,
    template_version,
    page_definition,
    page_source,
)
from ..config.page_templates.parts import paginated_placeholder, part_buttons
from .text_style import TEXT_KINDS, normalize_settings

_LOGGER = logging.getLogger(__name__)


class StoreWriteError(HomeAssistantError):
    """Raised when configuration could not be persisted to disk.

    Exists so a failed save reaches the panel as a save failure instead of
    being swallowed into a success the user then trusts.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"Could not write {path}")


YAML_DIR = "lizaip"


#: Template format 1 -> 2 (see ``TEMPLATE_VERSION`` in
#: ``page_templates/catalog.py``). The page each shipped template made
#: before templates named their pages: ``old id -> (id now, page name)``. ``sonos`` is now the three-page Sonos;
#: the one page it used to make is ``sonos-single``'s. Templates bound to
#: nothing stored no ``template:`` and need nothing here.
_UNNAMED_TEMPLATE_PAGES: Final[dict[str, tuple[str, str]]] = {
    "sonos": ("sonos-single", "favourites"),
    "sonos-cover": ("sonos-cover", "cover"),
    "sonos-playlists": ("sonos-playlists", "playlists"),
    "sonos-radio": ("sonos-radio", "radio"),
    "hue": ("hue", "lamps"),
    "android-tv": ("android-tv", "remote"),
    "apple-tv": ("apple-tv", "remote"),
    "fire-tv": ("fire-tv", "remote"),
    "roku": ("roku", "remote"),
    "samsung-tv": ("samsung-tv", "remote"),
    "webos-tv": ("webos-tv", "remote"),
    "demo-live-values": ("demo-live-values", "live-values"),
    "light-studio": ("light-studio", "light-studio"),
    "media-wall": ("media-wall", "media-wall"),
    "sonos-example": ("sonos-example", "sonos"),
}

#: A button's key repeat, as it was stored before it was called that.
_OLD_REPEAT_KEY: Final = "repeat"

#: A page's title, as it was stored before it was called that.
_OLD_TITLE_KEY: Final = "image"

#: A button's tooltip, and the mark that the user typed it, as they were
#: stored before they were called that. A toggle rule's tooltip too.
_OLD_TOOLTIP_KEY: Final = "label"
_OLD_TOOLTIP_EDITED_KEY: Final = "label_edited"

#: A button's picture, and the mark that the user chose it, as they were
#: stored before they were called that.
_OLD_ICON_KEY: Final = "image"
_OLD_ICON_PINNED_KEY: Final = "image_pinned"

#: The name a dynamic binding gave a button's tooltip, in its ``fields`` and on
#: either side of its ``field_map``, before it was called that.
_OLD_BINDING_FIELDS: Final[dict[str, str]] = {
    "label": "tooltip",
}


def _rename_key(holder: dict, old: str, new: str) -> None:
    """Move *old* to *new* on *holder*, unless *new* is already there."""
    if old in holder:
        value = holder.pop(old)
        holder.setdefault(new, value)


#: An icon the panel used to copy onto a library action, before the command's
#: default changed.
_SEEDED_COMMAND_ICONS: Final[dict[str, str]] = {
    "lizaip.goto_page": "mdi:page-next",
}


#: A page file's format. 2: only ``{translate: …}`` is translated, so a
#: ``${_state}`` written before then reads ``{translate: ${_state}}``.
PAGE_FORMAT_KEY: Final = "format"
PAGE_FORMAT: Final = 2

_BARE_STATE_RE: Final = re.compile(r"\$\{\s*_state\s*\}", re.IGNORECASE)


def _explicit_state(text: Any) -> Any:
    """*text* with each bare ``${_state}`` written ``{translate: ${_state}}``.

    Kept as a migration: both spellings read the same now, and the explicit
    one is what the panel writes.
    """
    if not isinstance(text, str) or "${" not in text:
        return text
    parts = TRANSLATE_STATE_RE.split(text)
    return STATE_TOOLTIP.join(_BARE_STATE_RE.sub(STATE_TOOLTIP, p) for p in parts)


def _explicit_wording(text: Any) -> Any:
    """An English preset wording ("Volume Up") as ``{translate: volume_up}``.

    Such a name used to be translated without saying so; now nothing is.
    """
    if not isinstance(text, str):
        return text
    key = button_tooltips.wording_key(text)
    return translate_ref(key) if key else text


def _migrate_tooltip(holder: dict, *, explicit_state: bool) -> None:
    """A stored tooltip, translated the way it was before format 2."""
    tooltip = holder.get("tooltip")
    if explicit_state:
        tooltip = _explicit_state(tooltip)
    if not name_is_user_written(holder):
        tooltip = _explicit_wording(tooltip)
    if tooltip is not None:
        holder["tooltip"] = tooltip


def _migrate_action_library(actions: list) -> None:
    """Bring a library written by an earlier release up to date, in memory.

    - An icon the panel seeded from a command's old default is shed: a stored
      icon outranks the command, so every go-to-page button would keep
      `mdi:page-next` instead of the current default.
    - A preset name is ``{translate: <key>}``, as the button that carries it.
    """
    for action in actions:
        if not isinstance(action, dict):
            continue
        if "name" in action:
            action["name"] = _explicit_wording(action["name"])
        service = action.get("service")
        seeded = _SEEDED_COMMAND_ICONS.get(service) if isinstance(service, str) else None
        if seeded and action.get("icon") == seeded:
            action.pop("icon")


def _migrate_binding(binding: dict) -> None:
    """A dynamic binding's field names, as they are spelt now."""
    fields = binding.get("fields")
    if isinstance(fields, list):
        renamed: list = []
        for field in fields:
            field = _OLD_BINDING_FIELDS.get(field, field) if isinstance(field, str) else field
            if field not in renamed:
                renamed.append(field)
        binding["fields"] = sorted(renamed, key=str)
    field_map = binding.get("field_map")
    if isinstance(field_map, dict):
        renamed_map = {}
        for key, value in field_map.items():
            key = _OLD_BINDING_FIELDS.get(key, key)
            value = _OLD_BINDING_FIELDS.get(value, value) if isinstance(value, str) else value
            # A field read under its own name is not mapped, as `_binding` writes it.
            if value and value != key:
                renamed_map.setdefault(key, value)
        if renamed_map:
            binding["field_map"] = renamed_map
        else:
            binding.pop("field_map")


def _migrate_button(button: dict, *, explicit_state: bool = False) -> None:
    """A stored button's keys, as this release spells them."""
    if _OLD_REPEAT_KEY in button:
        if button.pop(_OLD_REPEAT_KEY) is True:
            button.setdefault(ASSIGNMENT_REPEAT_KEY, True)
    _rename_key(button, _OLD_TOOLTIP_KEY, "tooltip")
    _rename_key(button, _OLD_TOOLTIP_EDITED_KEY, ASSIGNMENT_TOOLTIP_EDITED_KEY)
    _rename_key(button, _OLD_ICON_KEY, "icon")
    _rename_key(button, _OLD_ICON_PINNED_KEY, "icon_pinned")
    _migrate_tooltip(button, explicit_state=explicit_state)
    toggle = button.get(TOGGLE_KEY)
    rules = toggle.get("rules") if isinstance(toggle, dict) else None
    for rule in rules if isinstance(rules, list) else ():
        if isinstance(rule, dict):
            _rename_key(rule, _OLD_TOOLTIP_KEY, "tooltip")
            if explicit_state and "tooltip" in rule:
                rule["tooltip"] = _explicit_state(rule["tooltip"])
    binding = button.get(ASSIGNMENT_DYNAMIC_KEY)
    if isinstance(binding, dict):
        _migrate_binding(binding)
    overrides = button.get("overrides")
    if isinstance(overrides, dict):
        for override in overrides.values():
            if isinstance(override, dict):
                _rename_key(override, _OLD_TOOLTIP_KEY, "tooltip")
                _rename_key(override, _OLD_TOOLTIP_EDITED_KEY, ASSIGNMENT_TOOLTIP_EDITED_KEY)
                _rename_key(override, _OLD_ICON_KEY, "icon")
                _rename_key(override, _OLD_ICON_PINNED_KEY, "icon_pinned")
                _migrate_tooltip(override, explicit_state=explicit_state)


def _migrate_page_file(raw: dict) -> None:
    """Bring a page file written by an earlier release up to date, in memory.

    Nothing is written here; the next save of the page stores the new form.
    Every step is safe to run on a page that is already up to date.

    - ``layout:`` is the old spelling of ``template:``; without the rename
      nothing knows the page's device, so every ``${_device.…}`` reads empty.
    - A page made under template format 1 (it states no ``version``) does not
      say which page of its template it is, so nothing it is bound to could be
      found again: it is given the one its template made then
      (:data:`_UNNAMED_TEMPLATE_PAGES`), and format 2. Dropping format 1 is
      deleting this step.
    - The page's ``image`` is its ``title``; a button's ``label`` is its
      ``tooltip`` and ``label_edited`` its ``tooltip_edited``, a toggle rule's
      ``label`` its ``tooltip``; a dynamic binding's ``label`` field is
      ``tooltip``; a button's ``image`` is its ``icon`` and ``image_pinned``
      its ``icon_pinned``, on a fixed button's override too.
    - ``repeat: true`` on a button is ``key_repeat: true`` now.
    - Before format 2 (:data:`PAGE_FORMAT`) a tooltip's ``${_state}`` and a
      preset's English name were translated without saying so; they are
      written ``{translate: …}`` now, so they read as they did.
    """
    if "template" not in raw and isinstance(raw.get("layout"), dict):
        raw["template"] = raw.pop("layout")

    template = raw.get("template")
    if isinstance(template, dict) and template_version(template) == 1 and not template.get("page"):
        named = _UNNAMED_TEMPLATE_PAGES.get(str(template.get("type") or ""))
        if named is not None:
            template["type"], template["page"] = named
            template[TEMPLATE_VERSION_KEY] = 2

    _rename_key(raw, _OLD_TITLE_KEY, "title")

    explicit_state = raw.pop(PAGE_FORMAT_KEY, 1) != PAGE_FORMAT
    buttons = raw.get("buttons")
    if isinstance(buttons, dict):
        for button in buttons.values():
            if isinstance(button, dict):
                _migrate_button(button, explicit_state=explicit_state)


class LizaRemoteStore:
    """Per-device action library, page order, and page assignments.

    Disk template:
      <ha_config>/lizaip/<device_id>/action_library.yaml
      <ha_config>/lizaip/<device_id>/page_order.yaml   every page, in editor order
      <ha_config>/lizaip/<device_id>/pages/<page_id>.yaml
      <ha_config>/lizaip/<device_id>/settings.yaml     title/tooltip font and size
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._data: dict[str, dict[str, Any]] = {}
        self._loaded: set[str] = set()
        self._settings: dict[str, dict[str, Any]] = {}
        # path → digest of the payload last written there. A page file whose
        # content has not moved is not rewritten; see `_async_write_page`.
        # Keyed by path and only ever populated by a successful write, so an
        # entry also means "this process wrote that file".
        self._written_page_digests: dict[str, str] = {}
        self._device_locks: dict[str, asyncio.Lock] = {}

    def device_lock(self, device_id: str) -> asyncio.Lock:
        """The lock every change to *device_id* is made under.

        A change here is several awaits long -- read, write the page lists,
        write each page file, sweep the folder -- and two of them interleaving
        leaves the folder holding half of each. A restore is the sharpest case:
        it moves the whole folder aside, and a save that resumed afterwards
        would sweep away the pages it just put there using the page ids it read
        before. Public writers take this; readers do not, as a half-written
        page is a question the cache answers from memory.
        """
        lock = self._device_locks.get(device_id)
        if lock is None:
            lock = self._device_locks[device_id] = asyncio.Lock()
        return lock

    def _base_dir(self) -> str:
        return self._hass.config.path(YAML_DIR)

    def _device_dir(self, device_id: str) -> str:
        return os.path.join(self._base_dir(), device_id)

    def _pages_dir(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "pages")

    def _action_library_path(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "action_library.yaml")

    def _settings_path(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "settings.yaml")

    def _page_order_path(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "page_order.yaml")

    async def _async_write_page_order(self, device_id: str, pages: list) -> None:
        """Write ``page_order.yaml``: every page, subpages included.

        It keeps where a subpage sits among the others in the editor, and is
        what tells a subpage's file from an orphan on the next read. Which pages
        are main pages is read from each page's own file.
        """
        listed = [p for p in pages if isinstance(p, dict) and "id" in p]
        order_path = self._page_order_path(device_id)
        if not await self._hass.async_add_executor_job(
            self._write_yaml, order_path, [p["id"] for p in listed],
        ):
            raise StoreWriteError(order_path)


    async def _async_read_id_list(self, path: str) -> list[int] | None:
        """Page ids from *path*, or ``None`` when there is no such file."""
        if not await self._hass.async_add_executor_job(os.path.isfile, path):
            return None
        raw = await self._hass.async_add_executor_job(self._read_yaml, path)
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, int) and item > 0]

    def _page_path(self, device_id: str, page_id: int) -> str:
        return os.path.join(self._pages_dir(device_id), f"{page_id}.yaml")

    def _ensure_dirs(self, device_id: str) -> None:
        os.makedirs(self._pages_dir(device_id), exist_ok=True)

    @staticmethod
    def _read_yaml(path: str) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        except (OSError, yaml.YAMLError) as exc:
            _LOGGER.error("Failed to read YAML %s: %s", path, exc)
            return None

    @staticmethod
    def _write_yaml(path: str, data: Any) -> bool:
        """Write *data* as YAML atomically. Returns whether it reached the disk.

        Written to a sibling temp file and renamed into place: a plain open(w)
        truncates first, so a crash or a full disk mid-dump leaves a valid-looking
        but half-written page behind. ``os.replace`` is atomic on the same
        filesystem, so a reader sees either the old file or the new one.

        Not ``fsync``ed. On the SD card or eMMC most Home Assistant boxes run
        from, one fsync waits for everything else the system has queued for
        the card -- up to half a minute while Home Assistant starts or the
        recorder commits -- and adding a template writes a dozen files in a
        row: the panel sat for minutes. ext4 already writes a file replaced by
        rename before the rename itself, so a power cut leaves the old page or
        the new one, as the rename promises.
        """
        tmp_path: str | None = None
        try:
            directory = os.path.dirname(path)
            os.makedirs(directory, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(
                dir=directory, prefix=f".{os.path.basename(path)}.", suffix=".tmp",
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml.dump(
                    data, f,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                    width=120,
                )
            os.replace(tmp_path, path)
            tmp_path = None
        except OSError as exc:
            _LOGGER.error("Failed to write YAML %s: %s", path, exc)
            if tmp_path is not None:
                with suppress(OSError):
                    os.unlink(tmp_path)
            return False
        return True

    async def _async_write_yaml(self, path: str, data: Any) -> None:
        """Write *data* to *path*, raising when it does not reach the disk.

        The bool from :meth:`_write_yaml` was almost never checked, so a failed
        write surfaced to the user as a successful save. Callers that persist
        on the user's behalf go through here instead, so the panel is told the
        truth.
        """
        if not await self._hass.async_add_executor_job(self._write_yaml, path, data):
            raise StoreWriteError(path)

    @staticmethod
    def _runnable_overrides(table: Any) -> dict:
        """Runnable override entries: known fixed key plus an action to run.

        Absence means inherit. Empty or actionless overrides are not stored,
        because they would displace the page default and then execute nothing.
        This gate also covers template-generated and hand-edited YAML, which do
        not pass through the WebSocket sanitiser.

        This helper takes the override table itself so the store's empty-button
        test and field stripper ask one shared question. That keeps "stored" and
        "runnable" aligned with the executor instead of letting hand-edited
        ``overrides: {button_power: {}}`` preserve an empty button shell.
        """
        if not isinstance(table, dict):
            return {}
        out = {}
        for k, v in table.items():
            if k == SLIDER_VERTICAL_KEY:
                # The slider block is runnable when it names a subject —
                # including the empty-string placeholder a bound slot keeps, so
                # a refresh still has a key to refill. `sanitize_slider_override`
                # is the one gate.
                block = sanitize_slider_override(v)
                if block:
                    out[k] = block
                continue
            if k in OVERRIDABLE_FIXED_BUTTONS and isinstance(v, dict) and v.get("action_id"):
                out[k] = v
                continue
            # A live button override is a bare service name. It needs no
            # action_id because it names no stored action — it is resolved
            # against the selection when the button is pressed.
            if k in OVERRIDABLE_FIXED_BUTTONS and isinstance(v, str) and v.strip():
                out[k] = v
        return out

    @staticmethod
    def _is_empty_button(btn_data: dict) -> bool:
        """Whether a button assignment should be omitted from page YAML.

        "Empty" is stricter than "has no action": sliders, dynamic placeholders,
        and grid contexts with runnable fixed-button overrides all carry state
        the store must preserve even when they look blank in the panel.
        """
        if not isinstance(btn_data, dict):
            return True
        if btn_data.get("action_id"):
            return False
        if btn_data.get("icon"):
            return False
        if btn_data.get("config"):
            return False
        if longtouch_steps(btn_data):
            return False
        if btn_data.get("tooltip"):
            return False
        if btn_data.get("state_icons"):
            return False
        # Sliders configured through the panel have no action_id and default
        # tooltip/icon/config; slider_actions is the only durable behavior.
        if btn_data.get("slider_actions"):
            return False
        # Dynamic placeholders must keep their binding while the source item is
        # missing, otherwise a later refresh has nothing to refill.
        if btn_data.get(ASSIGNMENT_DYNAMIC_KEY):
            return False
        # Grid context overrides affect fixed-button behavior even if the grid
        # button's own action was cleared.
        if LizaRemoteStore._runnable_overrides(btn_data.get("overrides")):
            return False
        # A toggle block is durable behavior in its own right: its rules carry
        # runnable steps that no other field on this button mirrors.
        if sanitize_toggle(btn_data.get(TOGGLE_KEY)):
            return False
        return True

    @staticmethod
    def _strip_empty_fields(btn_data: dict) -> dict:
        """Remove unset fields before writing user-editable YAML.

        Presence is meaningful for several booleans/containers: ``tooltip_edited``
        exists only when true, empty override tables mean inherit, and empty
        dicts/lists should not become visible YAML noise unless another reader
        treats their presence as a distinct state.
        """
        result = {}
        for key, val in btn_data.items():
            if val is None:
                continue
            if key == "icon_pinned" and not val:
                continue
            # Presence means user-edited; false must remain absence.
            if key == ASSIGNMENT_TOOLTIP_EDITED_KEY and not val:
                continue
            if isinstance(val, dict) and not val:
                continue
            if key == "config" and isinstance(val, list):
                cleaned_steps = []
                for step in val:
                    if isinstance(step, dict):
                        cleaned_step = {k: v for k, v in step.items()
                                        if v is not None and not (isinstance(v, dict) and not v)}
                        cleaned_steps.append(cleaned_step)
                    else:
                        cleaned_steps.append(step)
                if cleaned_steps:
                    result[key] = cleaned_steps
                continue
            # Override tables obey the disk invariant too. The WebSocket path
            # already sanitises them, but template-generated and hand-edited YAML
            # reach this last gate directly: only runnable entries survive, and
            # an empty table is absence/inherit.
            # The toggle block takes the same route for the same reason: it is
            # run through its own sanitiser here so hand-written YAML cannot
            # install a block the WebSocket allowlist would have rejected. An
            # empty result is absence.
            if key == TOGGLE_KEY:
                cleaned_toggle = sanitize_toggle(val)
                if cleaned_toggle:
                    result[key] = cleaned_toggle
                continue
            if key == "overrides" and isinstance(val, dict):
                cleaned = {}
                for ov_key, ov_val in LizaRemoteStore._runnable_overrides(val).items():
                    if ov_key == SLIDER_VERTICAL_KEY:
                        # Already the storable form: `_runnable_overrides` ran it
                        # through the one gate, and an empty `entity_id` is a
                        # placeholder rather than an unset field, so the
                        # empty-value rules below must not see it.
                        cleaned[ov_key] = ov_val
                        continue
                    if isinstance(ov_val, str):
                        cleaned[ov_key] = ov_val.strip()
                        continue
                    if not isinstance(ov_val, dict):
                        continue
                    ov_clean = LizaRemoteStore._strip_empty_fields(ov_val)
                    if ov_clean and ov_clean.get("action_id"):
                        cleaned[ov_key] = ov_clean
                if cleaned:
                    result[key] = cleaned
                continue
            result[key] = val
        return result

    # Page YAML contract:
    #   title: <string>
    #   default_color: <hex color>       (optional)
    #   template: {...}                    (optional template provenance)
    #   buttons:
    #     <button_key>: { action_id, config, tooltip, icon, state_icons, ... }
    #       toggle: optional sibling of config, giving one button several
    #               faces. { mode: "cycle", rules: [{icon?, tooltip?, config:
    #               [...]}, ...] }. Each press runs the next rule; config
    #               mirrors rule 1 and is the fallback if the block is inert.

    @classmethod
    def _template_bindings(cls, page_meta: dict) -> dict[str, dict]:
        """What the page's template says each of its bound buttons is bound to.

        Empty for a page with no template provenance, and for one whose template has
        since been removed — both simply keep whatever the file holds.
        """
        template_meta = page_meta.get("template")
        if not isinstance(template_meta, dict):
            return {}
        template_id = str(template_meta.get("type") or "").strip()
        if not template_id:
            return {}
        template = load_template(template_id)
        if not isinstance(template, dict):
            return {}
        template = cls._template_page_def(template, template_meta)
        target = template_meta.get("target")
        target = target if isinstance(target, dict) else {}
        return template_bindings(
            template,
            str(target.get("entity_id") or ""),
            str(target.get("config_entry") or ""),
        )

    @staticmethod
    def _template_page_def(template: dict, template_meta: dict) -> dict:
        """The part of a template that describes *this* page.

        A template names its pages, and the page says which of them it is.
        Everything else in the file -- the placeholders, the selector -- still
        applies to all of them.
        """
        template_id = str(template_meta.get("type") or "")
        page = page_definition(template_id, template, str(template_meta.get("page") or ""))
        if page is None:
            shared = {k: v for k, v in template.items() if k != TEMPLATE_PAGES_KEY}
            return {**shared, "buttons": {}}
        include = str(page.get("template") or "")
        shared, buttons = page_source(
            template_id, template, page, load_template(include) if include else None,
        )
        part = template_meta.get("part")
        # Read as the last part shows it: a binding is only filled in on a
        # button that already holds one, which a `more_parts:` link does not.
        buttons = part_buttons(
            buttons, paginated_placeholder(page), part if isinstance(part, int) else 1,
        )
        return {**shared, "buttons": buttons}

    @classmethod
    def _strip_template_stated_keys(cls, page_meta: dict, buttons: dict) -> None:
        """Drop the binding keys the page's template can state itself.

        Twelve Hue lamps each stored the source they came from, the spec that
        narrowed it, the fields tracked and the slot index — which is ``@lamp[3]``
        in the template, written out longhand twelve times. The template is right
        there in the page's own ``template:`` block, so the file keeps only what a
        refresh actually found: which item landed in the slot, and whether it is
        still there.

        A key is dropped only when the template derives an *equal* value, so the
        round trip is exact and a page the template cannot fully describe — one
        needing the sibling-entity fallback, say — keeps that key on disk rather
        than being handed a wrong one on the next load.

        ``buttons`` is the stripped copy built for writing, not the live
        assignments.
        """
        derived = cls._template_bindings(page_meta)
        if not derived:
            return
        for btn_key, btn in buttons.items():
            binding = btn.get(ASSIGNMENT_DYNAMIC_KEY) if isinstance(btn, dict) else None
            expected = derived.get(btn_key)
            if not isinstance(binding, dict) or not expected:
                continue
            # Rebuilt, not mutated: the stripped button still shares this dict
            # with the live in-memory assignment.
            btn[ASSIGNMENT_DYNAMIC_KEY] = {
                key: value for key, value in binding.items()
                if not (key in expected and expected[key] == value)
            }

    @classmethod
    def _restore_template_stated_keys(cls, page_meta: dict, buttons: dict) -> None:
        """Put the template-stated keys back, before anything reads a binding.

        Only buttons that already carry a binding get one: a hand-made button
        sitting in a generated page's slot has no dynamic binding and must not be
        given the one the template would have put there.
        """
        derived = cls._template_bindings(page_meta)
        if not derived:
            cls._warn_if_unrefreshable(page_meta, buttons)
            return
        for btn_key, btn in buttons.items():
            binding = btn.get(ASSIGNMENT_DYNAMIC_KEY) if isinstance(btn, dict) else None
            expected = derived.get(btn_key)
            if not isinstance(binding, dict) or not expected:
                continue
            for key, value in expected.items():
                binding.setdefault(key, deepcopy(value))

    @staticmethod
    def _warn_if_unrefreshable(page_meta: dict, buttons: dict) -> None:
        """Say so when a page's template is the only thing that knew what it holds.

        A page that was written against a template stores only what the template
        cannot say. If that template later stops resolving, the rest cannot be
        recovered and the page quietly stops refreshing, so name it once here
        rather than leave it to be noticed as buttons going stale.
        """
        template_meta = page_meta.get("template")
        if not isinstance(template_meta, dict):
            return
        orphaned = [
            key
            for key, btn in buttons.items()
            if isinstance(btn, dict)
            and isinstance(btn.get(ASSIGNMENT_DYNAMIC_KEY), dict)
            and not btn[ASSIGNMENT_DYNAMIC_KEY].get("source")
        ]
        if not orphaned:
            return
        _LOGGER.warning(
            "Page %s was generated from template %r, which no longer loads; "
            "%d of its buttons can no longer refresh: %s",
            page_meta.get("id", "?"),
            template_meta.get("type"),
            len(orphaned),
            ", ".join(sorted(orphaned)),
        )

    def _build_page_file_data(self, page_meta: dict, assignments: dict) -> dict:
        clean_buttons = {k: self._strip_empty_fields(v)
                         for k, v in assignments.items()
                         if not self._is_empty_button(v)}
        self._strip_template_stated_keys(page_meta, clean_buttons)
        data: dict[str, Any] = {PAGE_FORMAT_KEY: PAGE_FORMAT}
        template = page_meta.get("template")
        if template and isinstance(template, dict):
            data["template"] = template
        title = page_meta.get("title", "")
        if title:
            data["title"] = title
        default_color = page_meta.get("default_color", "")
        if default_color:
            data["default_color"] = default_color
        if is_subpage(page_meta):
            data[PAGE_SUBPAGE_KEY] = True
        if clean_buttons:
            data["buttons"] = clean_buttons
        return data

    def _parse_page_file_data(self, raw: dict) -> tuple[dict, dict]:
        """Parse one page YAML payload into metadata and button assignments.

        Blocking: consults the page's template. Call via ``async_add_executor_job``.
        """
        title = raw.get("title", "")
        default_color = raw.get("default_color", "")
        template = raw.get("template")
        buttons = raw.get("buttons", {})
        meta: dict[str, Any] = {"title": title}
        if default_color:
            meta["default_color"] = default_color
        if is_subpage(raw):
            meta[PAGE_SUBPAGE_KEY] = True
        if template and isinstance(template, dict):
            meta["template"] = template
        buttons = buttons if isinstance(buttons, dict) else {}
        # Before anything reads a binding: undo how the file spells them.
        self._restore_template_stated_keys(meta, buttons)
        return meta, buttons

    async def _read_device_from_disk(self, device_id: str) -> dict[str, Any] | None:
        """Read the split YAML files for one device into the in-memory shape."""
        device_dir = self._device_dir(device_id)
        if not await self._hass.async_add_executor_job(os.path.isdir, device_dir):
            return None

        data: dict[str, Any] = {}

        lib_path = self._action_library_path(device_id)
        if await self._hass.async_add_executor_job(os.path.isfile, lib_path):
            lib = await self._hass.async_add_executor_job(self._read_yaml, lib_path)
            data["action_library"] = lib if isinstance(lib, list) else []
            _migrate_action_library(data["action_library"])
        else:
            data["action_library"] = []

        # `page_order.yaml` lists every page, subpages included.
        page_order = await self._async_read_id_list(
            self._page_order_path(device_id)
        ) or []

        pages: list[dict] = []
        assignments: dict[int, dict] = {}
        pages_dir = self._pages_dir(device_id)

        if await self._hass.async_add_executor_job(os.path.isdir, pages_dir):
            page_fnames = await self._hass.async_add_executor_job(os.listdir, pages_dir)
            for fname in page_fnames:
                if not fname.endswith(".yaml"):
                    continue
                try:
                    page_id = int(fname[:-5])
                except ValueError:
                    continue
                if page_id <= 0:
                    continue
                page_path = os.path.join(pages_dir, fname)
                parsed = await self._async_read_page_as_stored(page_path)
                if parsed is None:
                    continue
                meta, buttons, on_disk = parsed
                pages.append({"id": page_id, **meta})
                if buttons:
                    assignments[page_id] = buttons
                self._prime_page_digest(page_path, {"id": page_id, **meta}, buttons, on_disk)

        # The page order is the source of truth for which pages exist; orphan
        # page files are ignored until a later write removes them. A subpage
        # missing from it is not an orphan, though: its own file says what it
        # is, and dropping it would lose a page a Go to page button leads to.
        if page_order:
            ordered = []
            page_map = {p["id"]: p for p in pages}
            for pid in page_order:
                if pid in page_map:
                    ordered.append(page_map.pop(pid))
            ordered.extend(
                page_map[pid] for pid in sorted(page_map) if is_subpage(page_map[pid])
            )
            pages = ordered

        data["pages"] = pages
        data["assignments"] = assignments

        return data if (pages or data.get("action_library") or assignments) else None

    async def _write_page_files(self, device_id: str, pages: list, assignments: dict) -> None:
        """Write page YAML files; skip malformed page entries.

        Callers hand over the whole page list because page files carry metadata
        as well as button assignments, and a caller rarely knows
        which of those a change touched. `_async_write_page` decides per page
        whether anything moved, so handing over everything costs one payload
        build per page rather than one disk write per page. One malformed page
        entry must not prevent the other page files from being written.

        Every page is attempted before raising, so one unwritable file does not
        strand the rest — but the caller is still told, because reporting a save
        the disk refused is how a user loses work without knowing.
        """
        unwritten: list[str] = []
        for page_meta in pages:
            if not isinstance(page_meta, dict):
                continue
            page_id = page_meta.get("id")
            if not page_id:
                continue
            page_assigns = assignments.get(page_id, {})
            page_path = self._page_path(device_id, page_id)
            if not await self._async_write_page(page_path, page_meta, page_assigns):
                unwritten.append(page_path)
        if unwritten:
            raise StoreWriteError(", ".join(unwritten))

    async def _async_template_ready(self, source: dict) -> None:
        """Parse the page's template now, so building and parsing can stay on the loop.

        Both consult the template, and both walk the live in-memory assignments —
        which a concurrent refresh mutates in place between its awaits. Running
        them in an executor would make that walk race a mutation and write a file
        matching no point in time. Only the *read* needs to be off the loop, and
        after the first one it is cached, so this is usually free.

        *source* is a page's metadata or its raw file payload; both spell the
        template the same way.
        """
        template_meta = source.get("template")
        if not isinstance(template_meta, dict):
            return
        template_id = str(template_meta.get("type") or "").strip()
        if template_id:
            await async_load_template(self._hass, template_id)

    @staticmethod
    def _page_file_digest(file_data: dict) -> str:
        """Fingerprint of a page's file payload.

        Deliberately not ``yaml.dump``: serialising is the expensive half of a
        write (~24 ms per page on remote-grade hardware), and the whole point
        of the digest is to decide whether that serialisation is needed at all.
        ``repr`` of the built payload is stable — ``_build_page_file_data``
        assembles its keys in a fixed order from plain scalars, lists and
        dicts — and runs in C.
        """
        return hashlib.md5(repr(file_data).encode()).hexdigest()

    def _forget_page_digests(self, pages_dir: str, keep: set[int] | None = None) -> None:
        """Drop remembered digests for page files under *pages_dir*.

        Called after files are deleted behind the cache's back: the digest says
        "this file holds that payload", and once the file is gone the claim is
        false — a recycled page id would otherwise inherit it and skip the
        write that recreates the file. *keep* names the page ids that survived;
        without it every page under the directory is forgotten, which is what
        removing a device wants.
        """
        prefix = os.path.join(pages_dir, "")
        for path in [p for p in self._written_page_digests if p.startswith(prefix)]:
            if keep is not None:
                name = os.path.basename(path)
                try:
                    if int(name[:-5]) in keep:
                        continue
                except ValueError:
                    pass
            self._written_page_digests.pop(path, None)
    async def _async_write_page(self, path: str, page_meta: dict, assignments: dict) -> bool:
        """Build one page's file payload on the loop and write it off it.

        Skipped when the payload matches what we last wrote to *path*. Callers
        hand over the whole page list — a reorder, an added page, a renamed one
        — because page order used to be the only thing they could express, so
        every such call rewrote every page file. Only the two list files carry
        order; the page files do not, so a reorder has nothing to say to any of
        them and now writes none.

        Returns whether the page is on disk as requested.
        """
        await self._async_template_ready(page_meta)
        file_data = self._build_page_file_data(page_meta, assignments)
        digest = self._page_file_digest(file_data)
        if self._written_page_digests.get(path) == digest:
            return True
        written = await self._hass.async_add_executor_job(
            self._write_yaml, path, file_data,
        )
        # Only remember a payload that actually reached the disk: caching a
        # failed write would make every later attempt skip itself.
        if written:
            self._written_page_digests[path] = digest
        return written

    async def _async_read_page(self, path: str) -> tuple[dict, dict] | None:
        """Read one page file off the loop and parse it on it."""
        parsed = await self._async_read_page_as_stored(path)
        return parsed[:2] if parsed is not None else None

    async def _async_read_page_as_stored(self, path: str) -> tuple[dict, dict, dict] | None:
        """:meth:`_async_read_page`, plus the file as read before any migration.

        The third element is for :meth:`_prime_page_digest`.
        """
        raw = await self._hass.async_add_executor_job(self._read_yaml, path)
        if not isinstance(raw, dict):
            return None
        on_disk = deepcopy(raw)
        _migrate_page_file(raw)
        await self._async_template_ready(raw)
        return (*self._parse_page_file_data(raw), on_disk)

    def _prime_page_digest(self, path: str, page_meta: dict, buttons: dict, on_disk: dict) -> None:
        """Remember a loaded page file as written, when it is what a save would write.

        Without this the digest cache starts empty at every start, so the first
        save after it rewrote every page file however little it changed. Only a
        file that matches the payload exactly is primed: one that load migrated
        or normalised still differs, and is rewritten once on the next save.
        """
        built = self._build_page_file_data(page_meta, buttons or {})
        if built == on_disk:
            self._written_page_digests[path] = self._page_file_digest(built)

    @staticmethod
    def _clean_action_library(actions: Any) -> list[dict]:
        """Drop empty fields from each action before it is persisted.

        Shared by the full-device save and the action-library-only save: they
        each had their own copy of this, so a change to the persisted action
        shape could be made in one and missed in the other.
        """
        clean: list[dict] = []
        for action in actions or []:
            if not isinstance(action, dict):
                continue
            clean.append({
                k: v for k, v in action.items()
                if v is not None
                and not (isinstance(v, list) and not v)
                and not (isinstance(v, dict) and not v)
            })
        return clean

    async def _write_device_to_disk(self, device_id: str) -> None:
        data = self._data.get(device_id, {})
        await self._hass.async_add_executor_job(self._ensure_dirs, device_id)

        # Held rather than raised, so one unwritable library file does not cost
        # the caller every page write in the same flush -- the same
        # attempt-everything-then-raise contract the page helpers below keep.
        library_error: Exception | None = None
        lib_path = self._action_library_path(device_id)
        try:
            await self._async_write_yaml(lib_path, self._clean_action_library(data.get("action_library", [])))
        except StoreWriteError as err:
            library_error = err

        pages = data.get("pages", [])
        await self._async_write_page_order(device_id, pages)

        assignments = data.get("assignments", {})
        pages_dir = self._pages_dir(device_id)
        active_page_ids = set(p["id"] for p in pages if isinstance(p, dict))

        await self._write_page_files(device_id, pages, assignments)

        await self._hass.async_add_executor_job(
            self._cleanup_stale_pages, pages_dir, active_page_ids,
        )
        self._forget_page_digests(pages_dir, keep=active_page_ids)

        if library_error is not None:
            raise library_error

    @staticmethod
    def _cleanup_stale_pages(pages_dir: str, active_page_ids: set[int]) -> None:
        if not os.path.isdir(pages_dir):
            return
        for fname in os.listdir(pages_dir):
            if not fname.endswith(".yaml"):
                continue
            try:
                file_page_id = int(fname[:-5])
            except ValueError:
                continue
            if file_page_id not in active_page_ids:
                os.remove(os.path.join(pages_dir, fname))

    async def _ensure_loaded(self, device_id: str) -> None:
        if device_id in self._loaded:
            return
        raw = await self._read_device_from_disk(device_id)
        # Readers load without the device lock: a concurrent load may have
        # finished first and a locked writer changed the data since. This
        # older read must not overwrite it.
        if device_id in self._loaded:
            return
        if raw and isinstance(raw, dict):
            self._data[device_id] = raw
        self._loaded.add(device_id)

    async def async_save_device(self, device_id: str) -> None:
        async with self.device_lock(device_id):
            await self._write_device_to_disk(device_id)

    async def async_ensure_default(self, device_id: str) -> None:
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            if not self._data.get(device_id):
                self._data[device_id] = {
                    "pages": [],
                    "action_library": [],
                    "assignments": {},
                }
                await self._write_device_to_disk(device_id)

    def async_forget_device(self, device_id: str) -> None:
        """Drop everything cached about *device_id*, leaving the files alone.

        What a restore needs: the YAML under the device folder has been replaced
        behind the cache's back, so the next read has to come from disk. The
        page digests matter as much as the data — a digest says "this file holds
        that payload", and a restored file whose payload happens to match the
        last one this process wrote would otherwise never be rewritten.

        Not a coroutine; it only touches dictionaries. The ``async_`` prefix
        marks it as belonging to the loop, like the rest of the store's API.
        """
        self._data.pop(device_id, None)
        self._settings.pop(device_id, None)
        self._loaded.discard(device_id)
        self._forget_page_digests(self._pages_dir(device_id))

    async def async_remove_device(self, device_id: str) -> None:
        async with self.device_lock(device_id):
            self.async_forget_device(device_id)
            device_dir = self._device_dir(device_id)
            if await self._hass.async_add_executor_job(os.path.isdir, device_dir):
                try:
                    await self._hass.async_add_executor_job(shutil.rmtree, device_dir)
                except OSError as exc:
                    device_id_logger(_LOGGER, self._hass, device_id).warning(
                        "Failed to remove %s: %s", device_dir, exc,
                    )

    def _ensure_device(self, device_id: str) -> dict[str, Any]:
        if device_id not in self._data:
            self._data[device_id] = {
                "pages": [],
                "action_library": [],
                "assignments": {},
            }
        return self._data[device_id]

    async def async_get_pages(self, device_id: str) -> list[dict]:
        """The remote's pages, in order.

        A new list of shallow page copies: a caller editing a page or the list
        changes nothing here until it hands the result back to a setter.
        """
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return [dict(p) if isinstance(p, dict) else p for p in data.get("pages", [])]

    async def async_set_page_order(self, device_id: str, pages: list[dict]) -> None:
        """Persist a new page order without rewriting the page files.

        Order lives entirely in ``page_order.yaml``, a flat list of page ids. A
        page's own file carries its metadata and button assignments, none of
        which a reorder touches.

        :meth:`async_set_pages` rewrites every page file because it also has to
        handle edits, additions and deletions; for a pure move that is N file
        writes to persist what is really a list of integers, and the panel
        waits on all of them before the thumbnail visibly lands.
        """
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            entry = self._ensure_device(device_id)
            await self._async_write_page_order(device_id, pages)
            entry["pages"] = pages

    async def async_set_pages(self, device_id: str, pages: list[dict]) -> None:
        async with self.device_lock(device_id):
            await self.async_set_pages_locked(device_id, pages)

    async def async_set_pages_locked(self, device_id: str, pages: list[dict]) -> None:
        """`async_set_pages` for a caller already holding `device_lock`."""
        await self._ensure_loaded(device_id)
        entry = self._ensure_device(device_id)
        old_page_ids = {p["id"] for p in entry.get("pages", []) if isinstance(p, dict) and "id" in p}
        page_ids = [p["id"] for p in pages if isinstance(p, dict) and "id" in p]
        assignments = entry.get("assignments", {})
        # Written before the cache is updated, like the other setters.
        await self._async_write_page_order(device_id, pages)
        await self._write_page_files(device_id, pages, assignments)
        entry["pages"] = pages
        for rid in old_page_ids - set(page_ids):
            assignments.pop(rid, None)
        # Sweep the directory rather than deleting only the ids this call
        # happens to have dropped. The in-memory diff can see a page file
        # only while the page is still listed in memory, and
        # `_async_write_page_order` above has already dropped the removed
        # ids from `page_order.yaml`: if the process stops between those
        # two points the file is left behind and becomes invisible to every
        # later diff, so it can never be deleted. Listing the directory and
        # removing whatever is not an active page is authoritative, costs
        # one executor job instead of two per removal, and heals orphans
        # left by earlier interruptions.
        await self._hass.async_add_executor_job(
            self._cleanup_stale_pages, self._pages_dir(device_id), set(page_ids),
        )
        self._forget_page_digests(self._pages_dir(device_id), keep=set(page_ids))

    async def async_get_action_library(self, device_id: str) -> list[dict]:
        """The remote's action library, as a new list a caller may change."""
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        lib = data.get("action_library")
        return list(lib) if isinstance(lib, list) else []

    async def async_set_action_library(self, device_id: str, actions: list[dict]) -> None:
        async with self.device_lock(device_id):
            await self.async_set_action_library_locked(device_id, actions)

    async def async_set_action_library_locked(self, device_id: str, actions: list[dict]) -> None:
        """`async_set_action_library` for a caller already holding `device_lock`."""
        await self._ensure_loaded(device_id)
        entry = self._ensure_device(device_id)
        path = self._action_library_path(device_id)
        # Written before the cache is updated, like `async_set_settings`:
        # caching a library the disk refused would have the panel read back
        # entries that vanish on the next restart.
        await self._async_write_yaml(path, self._clean_action_library(actions))
        entry["action_library"] = actions

    async def async_merge_actions(self, device_id: str, actions: list[dict]) -> None:
        """Add *actions* to the library, replacing any with the same id."""
        async with self.device_lock(device_id):
            library = await self.async_get_action_library(device_id)
            index = {a["id"]: i for i, a in enumerate(library) if "id" in a}
            for action in actions:
                if action["id"] in index:
                    library[index[action["id"]]] = action
                else:
                    index[action["id"]] = len(library)
                    library.append(action)
            await self.async_set_action_library_locked(device_id, library)

    async def async_get_assignments(self, device_id: str, page_id: int) -> dict[str, dict]:
        """*page_id*'s buttons, as a new dict a caller may change."""
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return dict(data.get("assignments", {}).get(page_id, {}))

    async def async_set_assignments(self, device_id: str, page_id: int, assignments: dict[str, dict]) -> None:
        async with self.device_lock(device_id):
            await self.async_set_assignments_locked(device_id, page_id, assignments)

    async def async_set_assignments_locked(
        self, device_id: str, page_id: int, assignments: dict[str, dict]
    ) -> None:
        """`async_set_assignments` for a caller already holding `device_lock`.

        For a read-modify-write that must not lose a save made in between.
        """
        await self._ensure_loaded(device_id)
        entry = self._ensure_device(device_id)
        pages = entry.get("pages", [])
        page_meta = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)
        if page_meta is None:
            page_meta = {"id": page_id}
        path = self._page_path(device_id, page_id)
        # Written before the cache is updated, like the other setters.
        if not await self._async_write_page(path, page_meta, assignments):
            raise StoreWriteError(path)
        entry.setdefault("assignments", {})[page_id] = assignments

    async def async_update_page(
        self, device_id: str, page_id: int, fields: dict[str, Any],
    ) -> list[dict] | None:
        """Set *fields* on one page; the pages as stored, or None if it is gone.

        Read and written under the device lock, so an edit made meanwhile is
        built on rather than overwritten.
        """
        async with self.device_lock(device_id):
            pages = await self.async_get_pages(device_id)
            page = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), None)
            if page is None:
                return None
            page.update(fields)
            await self.async_set_pages_locked(device_id, pages)
            return await self.async_get_pages(device_id)

    async def async_insert_page(
        self, device_id: str, page: dict, assignments: dict[str, dict], *, after: int,
    ) -> None:
        """Add *page* with its *assignments* directly after the page *after*.

        At the end when *after* is no longer there.
        """
        async with self.device_lock(device_id):
            pages = await self.async_get_pages(device_id)
            at = next(
                (i + 1 for i, p in enumerate(pages) if isinstance(p, dict) and p.get("id") == after),
                len(pages),
            )
            pages.insert(at, page)
            await self.async_set_assignments_locked(device_id, page["id"], assignments)
            await self.async_set_pages_locked(device_id, pages)

    async def async_get_all_assignments(self, device_id: str) -> dict[int, dict[str, dict]]:
        """Every page's buttons by page id, as a new dict a caller may change."""
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return dict(data.get("assignments", {}))

    async def async_get_settings(self, device_id: str) -> dict[str, dict[str, Any]]:
        """The remote's title/tooltip text settings, defaults filled in.

        Read once and kept: every page sync and every live tooltip update asks.
        A copy is returned so a caller cannot change the kept one by accident.
        """
        if device_id not in self._settings:
            path = self._settings_path(device_id)
            raw = None
            if await self._hass.async_add_executor_job(os.path.isfile, path):
                raw = await self._hass.async_add_executor_job(self._read_yaml, path)
            self._settings[device_id] = normalize_settings(raw)
        return deepcopy(self._settings[device_id])

    def cached_settings(self, device_id: str) -> dict[str, dict[str, Any]]:
        """The kept text settings without touching the disk; defaults if unread.

        For synchronous callers such as the live icon-update callback, which
        must not await. Entry setup warms the cache with `async_get_settings`,
        so the defaults only show for a remote whose settings were never read.
        """
        kept = self._settings.get(device_id)
        return deepcopy(kept) if kept is not None else normalize_settings(None)

    async def async_set_settings(self, device_id: str, settings: dict) -> dict[str, dict[str, Any]]:
        """Save the text settings; returns them as stored.

        The text block is left out of the file: it is the theme's, and a copy
        on disk is what used to keep a remote on the font its theme had when
        the file was written.
        """
        clean = normalize_settings(settings)
        on_disk = {k: v for k, v in clean.items() if k not in TEXT_KINDS}
        async with self.device_lock(device_id):
            # Written before the cache is updated: caching settings the disk
            # refused would have the panel read back values that vanish on the
            # next restart.
            await self._async_write_yaml(self._settings_path(device_id), on_disk)
            self._settings[device_id] = clean
        return deepcopy(clean)

    def forget_settings(self) -> None:
        """Drop the kept settings of every remote, so the next read resolves
        the theme again. Called when a theme file has been written: the kept
        copy holds the text that theme supplied, which has just changed."""
        self._settings.clear()
