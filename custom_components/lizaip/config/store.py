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
import shutil
import tempfile
from contextlib import suppress
from copy import deepcopy
from typing import Any

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
    ASSIGNMENT_LABEL_EDITED_KEY,
)
from .const import PAGE_SUBPAGE_KEY, is_subpage
from ..config.page_templates import async_load_template, template_bindings, load_template
from .text_style import normalize_settings

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


def _migrate_page_file(raw: dict) -> None:
    """Read a page file written before templates were called templates.

    Such a file spells its template as ``layout:``, and without the rename
    nothing knows the page's device, so every ``${_device.…}`` on it reads
    empty. The next write stores the new spelling.
    """
    if "template" not in raw and isinstance(raw.get("layout"), dict):
        raw["template"] = raw.pop("layout")


class LizaRemoteStore:
    """Per-device action library, page order, and page assignments.

    Disk template:
      <ha_config>/lizaip/<device_id>/action_library.yaml
      <ha_config>/lizaip/<device_id>/main_pages.yaml   main pages, in order
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

    def _main_pages_path(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "main_pages.yaml")

    def _settings_path(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "settings.yaml")

    def _page_order_path(self, device_id: str) -> str:
        return os.path.join(self._device_dir(device_id), "page_order.yaml")

    async def _async_write_page_lists(self, device_id: str, pages: list) -> None:
        """Write ``main_pages.yaml`` (main pages only) and ``page_order.yaml``.

        A subpage is not a main page, so it has no place in ``main_pages.yaml``;
        ``page_order.yaml`` keeps where it sits among the others in the editor,
        and is what tells a subpage's file from an orphan on the next read.
        """
        listed = [p for p in pages if isinstance(p, dict) and "id" in p]
        main_path = self._main_pages_path(device_id)
        order_path = self._page_order_path(device_id)
        wrote_main = await self._hass.async_add_executor_job(
            self._write_yaml, main_path,
            [p["id"] for p in listed if not is_subpage(p)],
        )
        wrote_order = await self._hass.async_add_executor_job(
            self._write_yaml, order_path, [p["id"] for p in listed],
        )
        # Both are attempted before raising: the order file is what the remote
        # pages off, so a failure on the main list must not skip writing it.
        unwritten = [p for p, ok in ((main_path, wrote_main), (order_path, wrote_order)) if not ok]
        if unwritten:
            raise StoreWriteError(", ".join(unwritten))


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
                f.flush()
                os.fsync(f.fileno())
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
        if btn_data.get("image"):
            return False
        if btn_data.get("config"):
            return False
        if longtouch_steps(btn_data):
            return False
        if btn_data.get("label"):
            return False
        if btn_data.get("state_icons"):
            return False
        # Sliders configured through the panel have no action_id and default
        # label/image/config; slider_actions is the only durable behavior.
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

        Presence is meaningful for several booleans/containers: ``label_edited``
        exists only when true, empty override tables mean inherit, and empty
        dicts/lists should not become visible YAML noise unless another reader
        treats their presence as a distinct state.
        """
        result = {}
        for key, val in btn_data.items():
            if val is None:
                continue
            if key == "image_pinned" and not val:
                continue
            # Presence means user-edited; false must remain absence.
            if key == ASSIGNMENT_LABEL_EDITED_KEY and not val:
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
    #   image: <string>
    #   hash: <int>
    #   default_color: <hex color>       (optional)
    #   template: {...}                    (optional template provenance)
    #   buttons:
    #     <button_key>: { action_id, config, label, image, state_icons, ... }
    #       toggle: optional sibling of config, giving one button several
    #               faces. { mode: "cycle", rules: [{icon?, label?, config:
    #               [...]}, ...] }. Each press runs the next rule; config
    #               mirrors rule 1 and is the fallback if the block is inert.

    @staticmethod
    def _template_bindings(page_meta: dict) -> dict[str, dict]:
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
        target = template_meta.get("target")
        target = target if isinstance(target, dict) else {}
        return template_bindings(
            template,
            str(target.get("entity_id") or ""),
            str(target.get("config_entry") or ""),
        )

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
        data: dict[str, Any] = {}
        template = page_meta.get("template")
        if template and isinstance(template, dict):
            data["template"] = template
        img_title = page_meta.get("image", "")
        if img_title:
            data["image"] = img_title
        default_color = page_meta.get("default_color", "")
        if default_color:
            data["default_color"] = default_color
        page_hash = page_meta.get("hash", 0)
        if page_hash:
            data["hash"] = page_hash
        if is_subpage(page_meta):
            data[PAGE_SUBPAGE_KEY] = True
        if clean_buttons:
            data["buttons"] = clean_buttons
        return data

    def _parse_page_file_data(self, raw: dict) -> tuple[dict, dict]:
        """Parse one page YAML payload into metadata and button assignments.

        Blocking: consults the page's template. Call via ``async_add_executor_job``.
        """
        img_title = raw.get("image", "")
        page_hash = raw.get("hash", 0)
        default_color = raw.get("default_color", "")
        template = raw.get("template")
        buttons = raw.get("buttons", {})
        meta: dict[str, Any] = {"image": img_title, "hash": page_hash}
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
        and hashes as well as button assignments, and a caller rarely knows
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
        await self._async_write_page_lists(device_id, pages)

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
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return data.get("pages", [])

    async def async_set_page_order(self, device_id: str, pages: list[dict]) -> None:
        """Persist a new page order without rewriting the page files.

        Order lives entirely in ``main_pages.yaml`` and ``page_order.yaml``,
        both of which are flat lists of page ids. A page's own file carries its
        metadata and button assignments, none of which a reorder touches.

        :meth:`async_set_pages` rewrites every page file because it also has to
        handle edits, additions and deletions; for a pure move that is N file
        writes to persist what is really two lists of integers, and the panel
        waits on all of them before the thumbnail visibly lands.
        """
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            entry = self._ensure_device(device_id)
            entry["pages"] = pages
            await self._async_write_page_lists(device_id, pages)

    async def async_set_pages(self, device_id: str, pages: list[dict]) -> None:
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            entry = self._ensure_device(device_id)
            old_page_ids = {p["id"] for p in entry.get("pages", []) if isinstance(p, dict) and "id" in p}
            entry["pages"] = pages
            page_ids = [p["id"] for p in pages if isinstance(p, dict) and "id" in p]
            await self._async_write_page_lists(device_id, pages)
            assignments = entry.get("assignments", {})
            for rid in old_page_ids - set(page_ids):
                assignments.pop(rid, None)
            await self._write_page_files(device_id, pages, assignments)
            # Sweep the directory rather than deleting only the ids this call
            # happens to have dropped. The in-memory diff can see a page file
            # only while the page is still listed in memory, and
            # `_async_write_page_lists` above has already dropped the removed
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

    @staticmethod
    def compute_page_hash(image: str, assignments: dict[str, dict]) -> int:
        """Digest of fields the device renders for cache validation.

        PROTOCOL.md describes page hashes as "for cache validation" and says a
        reconnect "writes only what differs", so only page title, image
        fields, and top-level state icons are hashed. Overrides are deliberately
        excluded: PROTOCOL.md §12 fixes physical fixed-button glyphs in
        firmware, and ``device_sync`` builds the device's ``buttons[]`` from the
        top-level assignment only. Override edits change behavior, not pixels.

        Toggle rule icons are the exception that proves the rule: unlike
        overrides they are glyphs this page can display, so editing one has to
        invalidate the device's cached copy. Rule order is part of the digest
        because it decides which glyph comes next.
        """
        parts = [image or ""]
        for btn_key in sorted(assignments.keys()):
            assign = assignments[btn_key]
            if not isinstance(assign, dict):
                continue
            for field in sorted(assign.keys()):
                if field.startswith("img_") or field == "image":
                    parts.append(f"{btn_key}.{field}={assign[field] or ''}")
            state_icons = assign.get("state_icons")
            if isinstance(state_icons, dict) and state_icons:
                for state_key in sorted(state_icons.keys()):
                    parts.append(f"{btn_key}.si.{state_key}={state_icons[state_key] or ''}")
            toggle = assign.get(TOGGLE_KEY)
            if isinstance(toggle, dict) and toggle:
                rules = toggle.get("rules")
                rules = rules if isinstance(rules, list) else []
                for pos, rule in enumerate(rules):
                    if not isinstance(rule, dict):
                        continue
                    # Position and icon only: a step's position is what selects
                    # it, and its icon is what the device draws. Its action,
                    # label and tooltip are resolved on press and on render, so
                    # changing them must not resync every page that has a
                    # toggle.
                    parts.append(f"{btn_key}.tg.{pos}={rule.get('icon') or ''}")
        raw = "\n".join(parts)
        digest = hashlib.md5(raw.encode()).hexdigest()
        return int(digest[:8], 16)

    async def async_recompute_page_hash(self, device_id: str, page_id: int) -> int:
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            data = self._data.get(device_id, {})
            pages = data.get("pages", [])
            assignments = data.get("assignments", {}).get(page_id, {})
            page = next((p for p in pages if p.get("id") == page_id), None)
            if not page:
                return 0
            new_hash = self.compute_page_hash(page.get("image", ""), assignments)
            if page.get("hash") != new_hash:
                page["hash"] = new_hash
                page_path = self._page_path(device_id, page_id)
                await self._async_write_page(page_path, page, assignments)
            return new_hash

    async def async_get_action_library(self, device_id: str) -> list[dict]:
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        lib = data.get("action_library")
        return lib if isinstance(lib, list) else []

    async def async_set_action_library(self, device_id: str, actions: list[dict]) -> None:
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            entry = self._ensure_device(device_id)
            path = self._action_library_path(device_id)
            # Written before the cache is updated, like `async_set_settings`:
            # caching a library the disk refused would have the panel read back
            # entries that vanish on the next restart.
            await self._async_write_yaml(path, self._clean_action_library(actions))
            entry["action_library"] = actions

    async def async_get_assignments(self, device_id: str, page_id: int) -> dict[str, dict]:
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return data.get("assignments", {}).get(page_id, {})

    async def async_set_assignments(self, device_id: str, page_id: int, assignments: dict[str, dict]) -> None:
        async with self.device_lock(device_id):
            await self._ensure_loaded(device_id)
            entry = self._ensure_device(device_id)
            entry.setdefault("assignments", {})[page_id] = assignments
            pages = entry.get("pages", [])
            page_meta = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), {"id": page_id})
            path = self._page_path(device_id, page_id)
            if not await self._async_write_page(path, page_meta, assignments):
                raise StoreWriteError(path)

    async def async_get_all_assignments(self, device_id: str) -> dict[int, dict[str, dict]]:
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return data.get("assignments", {})

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
        """Save the text settings; returns them as stored."""
        clean = normalize_settings(settings)
        async with self.device_lock(device_id):
            # Written before the cache is updated: caching settings the disk
            # refused would have the panel read back values that vanish on the
            # next restart.
            await self._async_write_yaml(self._settings_path(device_id), clean)
            self._settings[device_id] = clean
        return deepcopy(clean)
