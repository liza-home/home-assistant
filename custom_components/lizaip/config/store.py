"""User-editable YAML store for lizaIP remote configuration.

The integration deliberately keeps per-device files under
``config/lizaip/<device_id>/`` instead of HA ``storage.Store`` so users can
inspect and edit action libraries, page order, and page button YAML by hand.

The persisted shape is also the panel/device contract: action libraries are
lists, page order is a list of 32-bit page ids, and page files hold page
metadata plus button assignments keyed by blueprint button id.
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
from copy import deepcopy
from typing import Any

import yaml

from homeassistant.core import HomeAssistant

from ..action_controller import (
    OVERRIDABLE_FIXED_BUTTONS,
    SLIDER_VERTICAL_KEY,
    sanitize_slider_override,
)
from .const import ASSIGNMENT_DYNAMIC_KEY, ASSIGNMENT_LABEL_EDITED_KEY
from .layouts import async_load_layout, layout_bindings, load_layout

_LOGGER = logging.getLogger(__name__)

YAML_DIR = "lizaip"


class LizaRemoteStore:
    """Per-device action library, page order, and page assignments.

    Disk layout:
      <ha_config>/lizaip/<device_id>/action_library.yaml
      <ha_config>/lizaip/<device_id>/main_pages.yaml
      <ha_config>/lizaip/<device_id>/pages/<page_id>.yaml
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._data: dict[str, dict[str, Any]] = {}
        self._loaded: set[str] = set()

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
    def _write_yaml(path: str, data: Any) -> None:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                yaml.dump(
                    data, f,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                    width=120,
                )
        except OSError as exc:
            _LOGGER.error("Failed to write YAML %s: %s", path, exc)

    @staticmethod
    def _runnable_overrides(table: Any) -> dict:
        """Runnable override entries: known fixed key plus an action to run.

        Absence means inherit. Empty or actionless overrides are not stored,
        because they would displace the page default and then execute nothing.
        This gate also covers layout-generated and hand-edited YAML, which do
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
                # is the one gate; a bare string here is a legacy spelling the
                # read migration has already folded away.
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
            # already sanitises them, but layout-generated and hand-edited YAML
            # reach this last gate directly: only runnable entries survive, and
            # an empty table is absence/inherit.
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
    #   layout: {...}                    (optional layout provenance)
    #   dynamic: {...}                   (legacy; read, never written — see
    #                                     _merge_shared_binding)
    #   buttons:
    #     <button_key>: { action_id, config, label, image, state_icons, ... }

    #: Page-level key an older writer used to hold the part of a dynamic binding
    #: every bound button shared. Still read so pages already on disk keep
    #: working; :meth:`_strip_layout_stated_keys` supersedes it.
    SHARED_BINDING_KEY = "dynamic"

    @staticmethod
    def _layout_bindings(page_meta: dict) -> dict[str, dict]:
        """What the page's layout says each of its bound buttons is bound to.

        Empty for a page with no layout provenance, and for one whose layout has
        since been removed — both simply keep whatever the file holds.
        """
        layout_meta = page_meta.get("layout")
        if not isinstance(layout_meta, dict):
            return {}
        layout_id = str(layout_meta.get("type") or "").strip()
        if not layout_id:
            return {}
        layout = load_layout(layout_id)
        if not isinstance(layout, dict):
            return {}
        target = layout_meta.get("target")
        target = target if isinstance(target, dict) else {}
        return layout_bindings(
            layout,
            str(target.get("entity_id") or ""),
            str(target.get("config_entry") or ""),
        )

    @classmethod
    def _strip_layout_stated_keys(cls, page_meta: dict, buttons: dict) -> None:
        """Drop the binding keys the page's layout can state itself.

        Twelve Hue lamps each stored the source they came from, the spec that
        narrowed it, the fields tracked and the slot index — which is ``@lamp[3]``
        in the layout, written out longhand twelve times. The layout is right
        there in the page's own ``layout:`` block, so the file keeps only what a
        refresh actually found: which item landed in the slot, and whether it is
        still there.

        A key is dropped only when the layout derives an *equal* value, so the
        round trip is exact and a page the layout cannot fully describe — one
        needing the sibling-entity fallback, say — keeps that key on disk rather
        than being handed a wrong one on the next load.

        ``buttons`` is the stripped copy built for writing, not the live
        assignments.
        """
        derived = cls._layout_bindings(page_meta)
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
    def _restore_layout_stated_keys(cls, page_meta: dict, buttons: dict) -> None:
        """Put the layout-stated keys back, before anything reads a binding.

        Only buttons that already carry a binding get one: a hand-made button
        sitting in a generated page's slot has no dynamic binding and must not be
        given the one the layout would have put there.
        """
        derived = cls._layout_bindings(page_meta)
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
        """Say so when a page's layout is the only thing that knew what it holds.

        A page that was written against a layout stores only what the layout
        cannot say. If that layout later stops resolving, the rest cannot be
        recovered and the page quietly stops refreshing, so name it once here
        rather than leave it to be noticed as buttons going stale.
        """
        layout_meta = page_meta.get("layout")
        if not isinstance(layout_meta, dict):
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
            "Page %s was generated from layout %r, which no longer loads; "
            "%d of its buttons can no longer refresh: %s",
            page_meta.get("id", "?"),
            layout_meta.get("type"),
            len(orphaned),
            ", ".join(sorted(orphaned)),
        )

    @classmethod
    def _merge_shared_binding(cls, raw: dict, buttons: dict) -> None:
        """Put back keys an older writer hoisted to a page-level ``dynamic:``.

        Nothing writes that block any more — the layout states those keys, and
        :meth:`_restore_layout_stated_keys` reads them from there. This stays for
        pages already on disk, which shed the block the next time they are saved.

        Only buttons that already carry a binding get one: a hand-made button on
        a generated page has no dynamic slot and must not be given one.
        """
        shared = raw.get(cls.SHARED_BINDING_KEY)
        if not isinstance(shared, dict) or not shared:
            return
        for btn in buttons.values():
            binding = btn.get(ASSIGNMENT_DYNAMIC_KEY) if isinstance(btn, dict) else None
            if isinstance(binding, dict):
                for key, value in shared.items():
                    binding.setdefault(key, deepcopy(value))

    def _build_page_file_data(self, page_meta: dict, assignments: dict) -> dict:
        clean_buttons = {k: self._strip_empty_fields(v)
                         for k, v in assignments.items()
                         if not self._is_empty_button(v)}
        self._strip_layout_stated_keys(page_meta, clean_buttons)
        data: dict[str, Any] = {}
        layout = page_meta.get("layout")
        if layout and isinstance(layout, dict):
            data["layout"] = layout
        img_title = page_meta.get("image", "")
        if img_title:
            data["image"] = img_title
        default_color = page_meta.get("default_color", "")
        if default_color:
            data["default_color"] = default_color
        page_hash = page_meta.get("hash", 0)
        if page_hash:
            data["hash"] = page_hash
        if clean_buttons:
            data["buttons"] = clean_buttons
        return data

    def _parse_page_file_data(self, raw: dict) -> tuple[dict, dict]:
        """Parse one page YAML payload into metadata and button assignments.

        Blocking: consults the page's layout. Call via ``async_add_executor_job``.
        """
        img_title = raw.get("image", "")
        page_hash = raw.get("hash", 0)
        default_color = raw.get("default_color", "")
        layout = raw.get("layout")
        buttons = raw.get("buttons", {})
        # Back-compat: old page files kept buttons at top level.
        if not buttons and any(k.startswith("button_") or k.startswith("slider_") for k in raw):
            buttons = {k: v for k, v in raw.items()
                       if k not in ("image", "hash", "buttons", "layout",
                                    "default_color", self.SHARED_BINDING_KEY)}
        meta: dict[str, Any] = {"image": img_title, "hash": page_hash}
        if default_color:
            meta["default_color"] = default_color
        if layout and isinstance(layout, dict):
            meta["layout"] = layout
        buttons = buttons if isinstance(buttons, dict) else {}
        # Before anything reads a binding: undo how the file spells them. The
        # legacy page-level block comes first so a page carrying both keeps what
        # it was written with over what the layout now says.
        self._merge_shared_binding(raw, buttons)
        self._restore_layout_stated_keys(meta, buttons)
        for assign in buttons.values():
            self._migrate_slider_control(assign)
            self._drop_unread_binding_keys(assign)
        return meta, buttons

    #: Binding keys written by an older resolver that nothing has ever read.
    #: Dropped on load so a page sheds them the next time it is saved, rather
    #: than every reader having to know they are noise.
    UNREAD_BINDING_KEYS = frozenset({
        # A creation timestamp. Refresh never updated it, so it recorded when a
        # page was first generated and was consulted by nothing.
        "resolved_at",
    })

    @classmethod
    def _drop_unread_binding_keys(cls, assign: Any) -> None:
        if not isinstance(assign, dict):
            return
        binding = assign.get(ASSIGNMENT_DYNAMIC_KEY)
        if not isinstance(binding, dict):
            return
        for key in cls.UNREAD_BINDING_KEYS:
            binding.pop(key, None)

    @staticmethod
    def _migrate_slider_control(assign: Any) -> None:
        """Fold the two legacy flat spellings into the slider override block.

        Three spellings reached disk before a grid button's slider settings
        shared one block, and pages written then are still on disk:

        * ``slider_control``, from before every control a grid button drives
          shared the ``overrides`` table at all;
        * ``overrides.slider_vertical`` as a bare **string** control id, paired
          with
        * a top-level ``slider_entity`` naming the subject.

        All three become ``overrides.slider_vertical = {entity_id, control}``.
        Migrating on read rather than keeping a second reader means only one
        place ever has to know the old names, and the next save drops them.

        Order matters and is the oldest-first rule: ``slider_control`` fills the
        string spelling only if that is absent, and the string becomes
        ``control`` only if the block does not already say. A page carrying both
        was written by a newer panel, and the newer spelling wins.

        The subject moves whether or not anything names a control — a button may
        point the slider at a device and let :func:`resolve_control` derive the
        rest — so the block is created for a lone ``slider_entity`` too. Its
        empty string is carried across rather than dropped: it is the
        bound-empty placeholder ``_retarget_subject`` refills.

        This function only decides *which* old key supplies *which* field. The
        resulting block goes through :func:`sanitize_slider_override` like every
        other write, so a migrated page and a freshly saved one are shaped by
        the same code and cannot drift apart.
        """
        if not isinstance(assign, dict):
            return
        legacy_control = assign.pop("slider_control", None)
        legacy_entity = assign.pop("slider_entity", None)
        overrides = assign.get("overrides")
        if not isinstance(overrides, dict):
            overrides = None

        stored = overrides.get(SLIDER_VERTICAL_KEY) if overrides else None
        if isinstance(stored, str):
            control = stored.strip() or None
        elif isinstance(stored, dict):
            control = None
        else:
            control = None
            stored = None
        if control is None and isinstance(legacy_control, str) and legacy_control.strip():
            control = legacy_control.strip()

        # Nothing to fold: a block already in the new shape, and no flat key
        # left beside it. Leaving early keeps a modern page byte-identical.
        if isinstance(stored, dict) and legacy_entity is None and control is None:
            return
        if stored is None and control is None and legacy_entity is None:
            return

        candidate = dict(stored) if isinstance(stored, dict) else {}
        if control is not None:
            candidate.setdefault("control", control)
        if isinstance(legacy_entity, str) and "entity_id" not in candidate:
            candidate["entity_id"] = legacy_entity
        # What a valid block looks like is not this function's question. A
        # control with no subject is a setting for a retarget that never
        # happens -- the old pair spelled the opt-in with `slider_entity`, so a
        # page that lost it is not opted in -- and that is exactly the case
        # `sanitize_slider_override` answers with `{}`, so ask it rather than
        # keep a second copy of the rule here where it can drift.
        block = sanitize_slider_override(candidate)
        if not block:
            return
        if overrides is None:
            overrides = {}
            assign["overrides"] = overrides
        overrides[SLIDER_VERTICAL_KEY] = block

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

        main_path = self._main_pages_path(device_id)
        page_order: list[int] = []
        if await self._hass.async_add_executor_job(os.path.isfile, main_path):
            raw_order = await self._hass.async_add_executor_job(self._read_yaml, main_path)
            if isinstance(raw_order, list):
                for item in raw_order:
                    if isinstance(item, int) and item > 0:
                        page_order.append(item)

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
                parsed = await self._async_read_page(page_path)
                if parsed is None:
                    continue
                meta, buttons = parsed
                pages.append({"id": page_id, **meta})
                if buttons:
                    assignments[page_id] = buttons

        # main_pages.yaml is the source of truth for visible page order; orphan
        # page files are ignored until a later write removes them.
        if page_order:
            ordered = []
            page_map = {p["id"]: p for p in pages}
            for pid in page_order:
                if pid in page_map:
                    ordered.append(page_map.pop(pid))
            pages = ordered

        data["pages"] = pages
        data["assignments"] = assignments

        return data if (pages or data.get("action_library") or assignments) else None

    async def _write_page_files(self, device_id: str, pages: list, assignments: dict) -> None:
        """Rewrite page YAML files; skip malformed page entries.

        Callers rebuild every page because page files carry metadata and hashes
        as well as button assignments. One malformed page entry must not prevent
        the other page files from being written.
        """
        for page_meta in pages:
            if not isinstance(page_meta, dict):
                continue
            page_id = page_meta.get("id")
            if not page_id:
                continue
            page_assigns = assignments.get(page_id, {})
            page_path = self._page_path(device_id, page_id)
            await self._async_write_page(page_path, page_meta, page_assigns)

    async def _async_layout_ready(self, source: dict) -> None:
        """Parse the page's layout now, so building and parsing can stay on the loop.

        Both consult the layout, and both walk the live in-memory assignments —
        which a concurrent refresh mutates in place between its awaits. Running
        them in an executor would make that walk race a mutation and write a file
        matching no point in time. Only the *read* needs to be off the loop, and
        after the first one it is cached, so this is usually free.

        *source* is a page's metadata or its raw file payload; both spell the
        layout the same way.
        """
        layout_meta = source.get("layout")
        if not isinstance(layout_meta, dict):
            return
        layout_id = str(layout_meta.get("type") or "").strip()
        if layout_id:
            await async_load_layout(self._hass, layout_id)

    async def _async_write_page(self, path: str, page_meta: dict, assignments: dict) -> None:
        """Build one page's file payload on the loop and write it off it."""
        await self._async_layout_ready(page_meta)
        file_data = self._build_page_file_data(page_meta, assignments)
        await self._hass.async_add_executor_job(self._write_yaml, path, file_data)

    async def _async_read_page(self, path: str) -> tuple[dict, dict] | None:
        """Read one page file off the loop and parse it on it."""
        raw = await self._hass.async_add_executor_job(self._read_yaml, path)
        if not isinstance(raw, dict):
            return None
        await self._async_layout_ready(raw)
        return self._parse_page_file_data(raw)

    async def _write_device_to_disk(self, device_id: str) -> None:
        data = self._data.get(device_id, {})
        await self._hass.async_add_executor_job(self._ensure_dirs, device_id)

        lib = data.get("action_library", [])
        clean_lib = []
        for a in lib:
            if isinstance(a, dict):
                cleaned = {k: v for k, v in a.items()
                           if v is not None and not (isinstance(v, list) and not v) and not (isinstance(v, dict) and not v)}
                clean_lib.append(cleaned)
        lib_path = self._action_library_path(device_id)
        await self._hass.async_add_executor_job(self._write_yaml, lib_path, clean_lib)

        # main_pages.yaml stores the ordered list of 32-bit page IDs.
        pages = data.get("pages", [])
        page_ids = [p["id"] for p in pages if isinstance(p, dict) and "id" in p]
        main_path = self._main_pages_path(device_id)
        await self._hass.async_add_executor_job(self._write_yaml, main_path, page_ids)

        assignments = data.get("assignments", {})
        pages_dir = self._pages_dir(device_id)
        active_page_ids = set(p["id"] for p in pages if isinstance(p, dict))

        await self._write_page_files(device_id, pages, assignments)

        await self._hass.async_add_executor_job(
            self._cleanup_stale_pages, pages_dir, active_page_ids,
        )

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
        await self._write_device_to_disk(device_id)

    async def async_ensure_default(self, device_id: str) -> None:
        await self._ensure_loaded(device_id)
        if not self._data.get(device_id):
            self._data[device_id] = {
                "pages": [],
                "action_library": [],
                "assignments": {},
            }
            await self.async_save_device(device_id)

    async def async_remove_device(self, device_id: str) -> None:
        self._data.pop(device_id, None)
        self._loaded.discard(device_id)
        device_dir = self._device_dir(device_id)
        if await self._hass.async_add_executor_job(os.path.isdir, device_dir):
            try:
                await self._hass.async_add_executor_job(shutil.rmtree, device_dir)
            except OSError as exc:
                _LOGGER.warning("Failed to remove %s: %s", device_dir, exc)

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

    async def async_set_pages(self, device_id: str, pages: list[dict]) -> None:
        await self._ensure_loaded(device_id)
        entry = self._ensure_device(device_id)
        old_page_ids = {p["id"] for p in entry.get("pages", []) if isinstance(p, dict) and "id" in p}
        entry["pages"] = pages
        page_ids = [p["id"] for p in pages if isinstance(p, dict) and "id" in p]
        path = self._main_pages_path(device_id)
        await self._hass.async_add_executor_job(self._write_yaml, path, page_ids)
        removed_ids = old_page_ids - set(page_ids)
        assignments = entry.get("assignments", {})
        for rid in removed_ids:
            page_path = self._page_path(device_id, rid)
            if await self._hass.async_add_executor_job(os.path.isfile, page_path):
                await self._hass.async_add_executor_job(os.remove, page_path)
            assignments.pop(rid, None)
        await self._write_page_files(device_id, pages, assignments)

    @staticmethod
    def compute_page_hash(image: str, assignments: dict[str, dict]) -> int:
        """Digest of fields the device renders for cache validation.

        PROTOCOL.md describes page hashes as "for cache validation" and says a
        reconnect "re-syncs only changed pages", so only page title, image
        fields, and top-level state icons are hashed. Overrides are deliberately
        excluded: PROTOCOL.md §12 fixes physical fixed-button glyphs in
        firmware, and ``device_sync`` builds the device's ``buttons[]`` from the
        top-level assignment only. Override edits change behavior, not pixels.
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
        raw = "\n".join(parts)
        digest = hashlib.md5(raw.encode()).hexdigest()
        return int(digest[:8], 16)

    async def async_recompute_page_hash(self, device_id: str, page_id: int) -> int:
        await self._ensure_loaded(device_id)
        pages = await self.async_get_pages(device_id)
        assignments = await self.async_get_assignments(device_id, page_id)
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
        await self._ensure_loaded(device_id)
        entry = self._ensure_device(device_id)
        entry["action_library"] = actions
        clean_actions = []
        for a in actions:
            cleaned = {k: v for k, v in a.items()
                       if v is not None and not (isinstance(v, list) and not v) and not (isinstance(v, dict) and not v)}
            clean_actions.append(cleaned)
        path = self._action_library_path(device_id)
        await self._hass.async_add_executor_job(self._write_yaml, path, clean_actions)

    async def async_get_assignments(self, device_id: str, page_id: int) -> dict[str, dict]:
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return data.get("assignments", {}).get(page_id, {})

    async def async_set_assignments(self, device_id: str, page_id: int, assignments: dict[str, dict]) -> None:
        await self._ensure_loaded(device_id)
        entry = self._ensure_device(device_id)
        entry.setdefault("assignments", {})[page_id] = assignments
        pages = entry.get("pages", [])
        page_meta = next((p for p in pages if isinstance(p, dict) and p.get("id") == page_id), {"id": page_id})
        path = self._page_path(device_id, page_id)
        await self._async_write_page(path, page_meta, assignments)

    async def async_get_all_assignments(self, device_id: str) -> dict[int, dict[str, dict]]:
        await self._ensure_loaded(device_id)
        data = self._data.get(device_id, {})
        return data.get("assignments", {})
