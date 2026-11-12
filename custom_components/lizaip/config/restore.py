"""Putting a downloaded configuration back.

The panel's *Download configuration* hands out a ZIP of
``<config>/lizaip/<device_id>/**.yaml`` — the pages, the buttons, the action
library, the page order and the text style, which is everything a user built by
hand. Until now that was a one-way street: a remote whose configuration was lost
to a failed migration, a wiped device or a mistaken *Clear pages* could only be
rebuilt click by click, or repaired by copying a folder into the config
directory over SSH and restarting Home Assistant.

This is the way back, and it is the download in reverse:

* :class:`LizaIPConfigRestoreView` takes the uploaded ZIP over HTTP — not the
  WebSocket, for the same reason the download does not use it: a support bundle
  carries logs and runs to megabytes, and that channel also drives the panel's
  live updates. The archive is parsed and validated on arrival and parked under
  a single-use token, exactly as a built bundle is.
* ``lizaip_config/restore_config`` then applies the parked upload. The split is
  what lets the panel show the user what they are about to overwrite — which
  remote the archive came from, how many pages it holds — and get a yes before
  anything on disk moves.

Validation is deliberately unforgiving. A restore is reached for when things are
already wrong, and the one outcome worse than refusing a good archive is
accepting a bad one on top of the last working configuration. Nothing is written
until every file in the archive has been read and parsed, and the live folder is
replaced by a rename rather than a write, so a failure leaves it as it was.

What a restore replaces is not kept. A configuration that was worth going back
to was worth downloading, and the archive the user restored *from* is still in
their downloads; a copy left beside the device folder would only be a second
configuration nobody reads, aging in the config directory.

What a restore does *not* carry: the config entry's own options — the remote's
host, its icon options, uploaded fonts — none of which live in the YAML. Those
only appear in a support bundle's ``configuration/settings.json``, and putting
them back is a different operation with different risks.
"""
from __future__ import annotations

import io
import logging
import os
import posixpath
import secrets
import shutil
import time
import zipfile
from typing import Any

import yaml
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from ..data import lizaip_data
from .access import holds_any_entry, is_admin_user
from .store import YAML_DIR
from ..shared.theme import USER_THEMES_SUBDIR

_LOGGER = logging.getLogger(__name__)

#: Where the browser posts an archive.
RESTORE_URL = "/api/lizaip/restore"

#: How long a parsed upload waits for the confirmation that applies it. Long
#: enough to read a dialog and think about it, short enough that an archive
#: abandoned at that dialog is not held in memory for the rest of the day.
UPLOAD_TTL = 900.0

#: The largest archive accepted, compressed. A configuration is tens of
#: kilobytes; a support bundle with a device log and a month of
#: `home-assistant.log` is a few megabytes. Sixty-four leaves room for an
#: unusually large one and still refuses anything that is not a bundle.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

#: How much of the body is taken per read. Only a buffer size: the upload is
#: read to its end in a loop, because one `read` returns what has arrived
#: rather than what was asked for.
_UPLOAD_CHUNK = 256 * 1024

#: The largest total the archive may expand to, and the most members it may
#: hold. Both are the zip-bomb guard: `ZipInfo` is read before anything is
#: extracted, so a 400-byte archive claiming forty gigabytes is refused without
#: ever being decompressed.
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_MEMBERS = 10_000

#: The largest single YAML file taken from an archive. A page file is a few
#: kilobytes; anything approaching this is not one.
MAX_FILE_BYTES = 8 * 1024 * 1024

#: How many pages the preview names. Far more than a remote ever holds, and
#: short enough that a hand-built archive cannot turn the window into a wall.
MAX_PREVIEW_PAGES = 120

#: Where a support bundle keeps the same files. `_add_config_files` writes them
#: there when the scope is not a configuration download.
BUNDLE_YAML_PREFIX = "configuration/yaml/"

#: What makes the result a lizaip configuration rather than an arbitrary pile of
#: YAML. Any one of them is enough: a device whose pages were never saved still
#: has an action library, and one restored from a hand-trimmed archive may have
#: only its pages.
_MARKERS = ("page_order.yaml", "main_pages.yaml", "action_library.yaml")


class RestoreError(Exception):
    """An archive that will not be restored, with the reason a user reads.

    `code` is for the panel, which has a translated sentence per reason;
    the message is the detail that sentence cannot know, and is what ends up in
    the log and in an untranslated fallback.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _is_yaml(name: str) -> bool:
    return name.endswith((".yaml", ".yml"))


def _safe_relative(path: str) -> str | None:
    """*path* as a clean relative path, or ``None`` when it escapes the root.

    Absolute paths, drive letters, `..` segments and the backslashes a ZIP
    written on Windows may carry are all rejected here rather than normalised:
    an archive whose members need rewriting to be safe is not one of ours.

    A bare colon is not a drive letter, and may not be treated as one: a device
    folder is named after the remote's MAC, so every path in a configuration
    download starts with ``AA:BB:CC:DD:EE:FF/``. Only the second character
    being a colon makes it ``C:`` — and that is what is refused.
    """
    if not path or path.endswith("/"):
        return None
    if "\\" in path or path.startswith("/") or path[1:2] == ":":
        return None
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return posixpath.join(*parts)


def _strip_root(paths: list[str]) -> dict[str, str]:
    """Map each archive member to its path relative to the device folder.

    Two shapes arrive here. A configuration download unpacks into one folder
    named after the device id, so the first segment comes off. A support bundle
    keeps the same files under ``<root>/configuration/yaml/``, so that prefix
    comes off instead. A folder someone zipped up themselves, with the YAML at
    the top, is taken as-is.

    Members outside the chosen root are dropped rather than refused: a support
    bundle is mostly logs, and refusing one for containing them would mean
    telling a user their own support bundle is invalid.
    """
    bundle = {p: p for p in paths if BUNDLE_YAML_PREFIX in p}
    if bundle:
        return {
            p: p.split(BUNDLE_YAML_PREFIX, 1)[1]
            for p in bundle
            if p.split(BUNDLE_YAML_PREFIX, 1)[1]
        }

    roots = {p.split("/", 1)[0] for p in paths if "/" in p}
    top_level = [p for p in paths if "/" not in p]
    if len(roots) == 1 and not top_level:
        return {p: p.split("/", 1)[1] for p in paths}

    return {p: p for p in paths}


def _archive_device_id(paths: list[str]) -> str | None:
    """Which device the archive was taken from, when it says.

    A configuration download names its root folder after the device id, which is
    the only place that id survives — the YAML inside never mentions it. A
    support bundle's root is the bundle name, so there is nothing to read.
    """
    if any(BUNDLE_YAML_PREFIX in p for p in paths):
        return None
    roots = {p.split("/", 1)[0] for p in paths if "/" in p}
    if len(roots) != 1 or any("/" not in p for p in paths):
        return None
    root = next(iter(roots))
    # A download's root is the device id; a bundle's is `lizaip-...-<stamp>`.
    return None if root.startswith("lizaip-") else root


def parse_archive(data: bytes) -> dict[str, Any]:
    """Read an uploaded ZIP into the files a restore would write.

    Runs on an executor thread: it decompresses and parses YAML, both of which
    are the event loop's business to stay out of.

    Returns the files keyed by their path under the device folder, along with
    what the panel needs to describe the archive before it is applied. Raises
    :class:`RestoreError` for anything it will not take.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as err:
        raise RestoreError("not_a_zip", f"Not a readable ZIP file: {err}") from err

    with archive:
        infos = [i for i in archive.infolist() if not i.is_dir()]
        if len(infos) > MAX_MEMBERS:
            raise RestoreError(
                "too_many_files", f"The archive holds {len(infos)} files"
            )
        expanded = sum(i.file_size for i in infos)
        if expanded > MAX_EXPANDED_BYTES:
            raise RestoreError(
                "too_large", f"The archive expands to {expanded} bytes"
            )

        names: list[str] = []
        for info in infos:
            rel = _safe_relative(info.filename)
            if rel is None:
                raise RestoreError(
                    "unsafe_path", f"The archive holds an unsafe path: {info.filename!r}"
                )
            names.append(rel)

        device_id = _archive_device_id(names)
        mapping = _strip_root(names)

        files: dict[str, bytes] = {}
        for original, info in zip(names, infos):
            rel = mapping.get(original)
            # Everything that is not YAML is ignored, which is what lets a whole
            # support bundle through: its logs and reports are no business of a
            # restore, but their presence must not disqualify the archive.
            if not rel or not _is_yaml(rel):
                continue
            if info.file_size > MAX_FILE_BYTES:
                raise RestoreError(
                    "file_too_large", f"{rel} is {info.file_size} bytes"
                )
            raw = archive.read(info)
            try:
                yaml.safe_load(raw.decode("utf-8"))
            except (UnicodeDecodeError, yaml.YAMLError) as err:
                raise RestoreError(
                    "bad_yaml", f"{rel} is not readable YAML: {err}"
                ) from err
            files[rel] = raw

    return {**_described(files), "device_id": device_id}


_PAGES_PREFIX = "pages/"

#: Where a theme sits in an archive. Themes are shared by every remote, so they
#: live one level up from the device folder and travel under their own prefix.
_THEMES_PREFIX = f"{USER_THEMES_SUBDIR[-1]}/"

#: Flat lists of page ids. The store reads only ``page_order.yaml``;
#: ``main_pages.yaml`` is found in archives from releases that still wrote it.
_ID_LISTS = ("page_order.yaml", "main_pages.yaml")


def _page_id(rel: str) -> int | None:
    """The page a file name stands for, read the way the store reads it.

    ``pages/12.yaml`` and nothing else: the store turns the stem into an int and
    skips the file when that fails, so a name it cannot read is a page that
    would silently not come back.
    """
    if not rel.startswith(_PAGES_PREFIX):
        return None
    name = rel[len(_PAGES_PREFIX):]
    if "/" in name or not name.endswith(".yaml"):
        return None
    try:
        page_id = int(name[:-5])
    except ValueError:
        return None
    return page_id if page_id > 0 else None


def _loadable_pages(files: dict[str, bytes]) -> list[dict[str, Any]]:
    """The pages the store would load, refusing anything it would skip.

    Readable YAML is not a usable configuration. The store ignores a page file
    whose document is not a mapping and a page file it cannot name, so an
    archive holding those would pass as "one page", replace the working
    configuration and leave the remote without it. Refusing here is the only
    place that can still say no.

    Each page is returned as its id, its title -- the only name a
    page has, which the panel turns into the title it shows everywhere -- how
    many of its buttons are configured, and the icon each of those buttons
    carries, which is what the panel draws the page's face from.
    """
    pages: list[dict[str, Any]] = []
    order: list[Any] | None = None
    library = _icons_by_action(files.get("action_library.yaml"))
    for rel, raw in sorted(files.items()):
        try:
            doc = yaml.safe_load(raw.decode("utf-8"))
        except (UnicodeDecodeError, yaml.YAMLError) as err:
            raise RestoreError("bad_yaml", f"{rel} is not readable YAML: {err}") from err
        if rel.startswith(_PAGES_PREFIX):
            page_id = _page_id(rel)
            if page_id is None:
                raise RestoreError("bad_page", f"{rel} is not a page file")
            if not isinstance(doc, dict):
                raise RestoreError("bad_page", f"{rel} does not hold a page")
            # An archive from before the title was called that names it `image`.
            title = doc.get("title", doc.get("image"))
            buttons = doc.get("buttons")
            pages.append({
                "id": page_id,
                "title": title if isinstance(title, str) else "",
                # What the preview says about a page beyond its name: a page
                # with nothing on it looks exactly like a full one in a list.
                "buttons": sum(
                    1 for value in buttons.values() if isinstance(value, dict) and value
                ) if isinstance(buttons, dict) else 0,
                "icons": _page_icons(buttons, library),
            })
        elif rel in _ID_LISTS and doc is not None and not isinstance(doc, list):
            raise RestoreError("bad_page", f"{rel} is not a list of page ids")
        elif rel == "page_order.yaml" and isinstance(doc, list):
            order = doc
    return _in_page_order(pages, order)


def _icons_by_action(raw: bytes | None) -> dict[Any, str]:
    """The archive's own action library, as action id -> icon.

    A button usually carries no icon of its own: it names an action, and the
    icon is the library's. The archive's library is the one that matters -- the
    live one belongs to the configuration about to be replaced.
    """
    if not raw:
        return {}
    try:
        doc = yaml.safe_load(raw.decode("utf-8"))
    except (UnicodeDecodeError, yaml.YAMLError):
        return {}
    if not isinstance(doc, list):
        return {}
    icons: dict[Any, str] = {}
    for entry in doc:
        if not isinstance(entry, dict):
            continue
        icon = entry.get("icon")
        if isinstance(icon, str) and icon.strip():
            icons[entry.get("id")] = icon.strip()
    return icons


def _page_icons(buttons: Any, library: dict[Any, str]) -> dict[str, str]:
    """What each configured button on a page shows, where it can be drawn.

    Every configured button is named, so the preview can draw its shape as a
    taken one; the icon beside it is sent only when the image server can draw
    it from the archive alone. A template resolves against states, and an
    uploaded picture against files that are still inside the ZIP, so both are
    named with no icon at all.
    """
    if not isinstance(buttons, dict):
        return {}
    icons: dict[str, str] = {}
    for key, value in buttons.items():
        if not isinstance(value, dict) or not value:
            continue
        image = value.get("icon", value.get("image"))
        icon = image if isinstance(image, str) and image.strip() else library.get(
            value.get("action_id"), ""
        )
        icon = str(icon or "").strip()
        icons[str(key)] = "" if _undrawable(icon) else icon
    return icons


#: Icon sources the preview cannot draw: a template needs states, and the rest
#: name a picture that lives outside the archive.
_UNDRAWABLE_PREFIXES = ("file:", "media:", "http://", "https://", "/", "data:")


def _undrawable(icon: str) -> bool:
    """Whether *icon* names something the preview cannot show."""
    return "${" in icon or icon.startswith(_UNDRAWABLE_PREFIXES)


def _in_page_order(
    pages: list[dict[str, Any]], order: list[Any] | None
) -> list[dict[str, Any]]:
    """*pages* in the order the remote shows them, by id where it cannot say.

    `page_order.yaml` is the run the user scrolls through, so a preview listed
    by file name would be in an order they have never seen. Ids the order does
    not mention keep their place at the end rather than being dropped.
    """
    if not order:
        return sorted(pages, key=lambda p: p["id"])
    rank = {}
    for i, raw in enumerate(order):
        try:
            rank.setdefault(int(raw), i)
        except (TypeError, ValueError):
            continue
    end = len(rank)
    return sorted(pages, key=lambda p: (rank.get(p["id"], end), p["id"]))


def _described(files: dict[str, bytes]) -> dict[str, Any]:
    """What a restore needs to know about a set of files, or why it will not take them.

    Separate from the parsing so that the checks a configuration has to pass are
    in one place rather than repeated by every caller that reads one.
    """
    if not files:
        raise RestoreError("no_config", "There is no YAML configuration in it")
    if not any(marker in files for marker in _MARKERS):
        raise RestoreError(
            "not_lizaip", "That does not look like a lizaIP configuration"
        )
    page_list = _loadable_pages(files)
    return {
        "files": files,
        "pages": len(page_list),
        "page_list": page_list,
        "file_count": len(files),
    }


def _write_tree(base: str, files: dict[str, bytes]) -> None:
    """Write *files* under *base*, creating the folders they need."""
    for rel, raw in files.items():
        path = os.path.join(base, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(raw)


def _split_themes(files: dict[str, bytes]) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """*files* as ``(the device's own, the themes beside it)``.

    A theme is shared by every remote, so it cannot travel inside the folder
    that gets replaced: it is named ``themes/<id>.yaml`` in the archive and
    written one level up.
    """
    own: dict[str, bytes] = {}
    themes: dict[str, bytes] = {}
    for rel, raw in files.items():
        name = rel[len(_THEMES_PREFIX):] if rel.startswith(_THEMES_PREFIX) else ""
        if name and "/" not in name:
            themes[name] = raw
        else:
            own[rel] = raw
    return own, themes


def _add_themes(base_dir: str, themes: dict[str, bytes]) -> None:
    """Write the archive's themes beside the device folders, adding only.

    One the user already has is left alone: the file is shared, and a restore
    of one remote may not change what the others draw with.
    """
    if not themes:
        return
    themes_dir = os.path.join(base_dir, USER_THEMES_SUBDIR[-1])
    os.makedirs(themes_dir, exist_ok=True)
    for name, raw in themes.items():
        path = os.path.join(themes_dir, name)
        if os.path.exists(path):
            continue
        with open(path, "wb") as handle:
            handle.write(raw)


def archive_carries_themes(files: dict[str, bytes]) -> bool:
    """Whether *files* would add to the shared theme library.

    A theme is installation-wide: it is written beside the device folders, and
    one named ``default.yaml`` stands in for the shipped default everywhere —
    outside the one remote an assigned user was given.
    """
    return bool(_split_themes(files)[1])


def _apply(base_dir: str, device_id: str, files: dict[str, bytes]) -> None:
    """Replace the device folder with *files*.

    Staged, then swapped. The new configuration is written into a scratch folder
    beside the live one and only then moved into place, so the window in which
    the device folder does not hold a complete configuration is two renames
    wide rather than as long as the write takes.

    The folder being replaced is renamed aside rather than deleted outright, and
    removed only once the new one is in place. If the second rename fails -- a
    permission that changed under us, a folder somebody has open -- it goes back
    where it was. A restore that did not happen is recoverable; half a
    configuration is not.

    The archive's themes are not part of that swap: they are shared, so they
    are added beside the device folders and never removed.
    """
    files, themes = _split_themes(files)
    device_dir = os.path.join(base_dir, device_id)
    token = secrets.token_hex(4)
    staged = os.path.join(base_dir, f"{device_id}.restore.{token}")
    replaced = os.path.join(base_dir, f"{device_id}.replaced.{token}")

    os.makedirs(base_dir, exist_ok=True)
    _add_themes(base_dir, themes)
    if os.path.exists(staged):
        shutil.rmtree(staged)
    os.makedirs(staged)
    try:
        _write_tree(staged, files)
    except OSError:
        shutil.rmtree(staged, ignore_errors=True)
        raise

    had_existing = os.path.isdir(device_dir)
    if had_existing:
        os.rename(device_dir, replaced)
    try:
        os.rename(staged, device_dir)
    except OSError:
        # Something wrote the live folder back into existence between the two
        # renames -- a save from a second browser tab. Its work is moved aside
        # rather than deleted, and the restore the user is waiting on wins.
        intruder = f"{device_dir}.conflict.{secrets.token_hex(4)}"
        if os.path.isdir(device_dir):
            try:
                os.rename(device_dir, intruder)
                os.rename(staged, device_dir)
                _LOGGER.warning(
                    "A write during the restore of %s was kept as %s",
                    device_id, os.path.basename(intruder),
                )
                shutil.rmtree(replaced, ignore_errors=True)
                return
            except OSError:
                pass
        if had_existing and not os.path.exists(device_dir):
            os.rename(replaced, device_dir)
        shutil.rmtree(staged, ignore_errors=True)
        raise

    shutil.rmtree(replaced, ignore_errors=True)


async def async_restore_files(
    hass: HomeAssistant, device_id: str, files: dict[str, bytes]
) -> None:
    """Put *files* in place as *device_id*'s configuration.

    The caller is responsible for the rest of a restore: dropping the store's
    caches, announcing the change and re-syncing the remote. This is only the
    disk half, so a test can exercise it without a device.
    """
    base_dir = hass.config.path(YAML_DIR)
    await hass.async_add_executor_job(_apply, base_dir, device_id, files)


def _uploads(hass: HomeAssistant) -> dict[str, tuple[float, dict[str, Any]]]:
    """The parsed-but-not-yet-applied uploads, by token."""
    return lizaip_data(hass).restore_uploads


def async_store_upload(hass: HomeAssistant, parsed: dict[str, Any]) -> str:
    """Park a parsed archive and return the token that applies it.

    Expired uploads are dropped here, as the download's own token table does:
    an upload is the only moment at which one more can appear, so it is also the
    only moment at which the set can be left holding something nobody will come
    back for.
    """
    now = time.monotonic()
    uploads = _uploads(hass)
    for token in [t for t, (expires, _) in uploads.items() if expires <= now]:
        del uploads[token]

    token = secrets.token_urlsafe(32)
    uploads[token] = (now + UPLOAD_TTL, parsed)
    return token


def async_take_upload(hass: HomeAssistant, token: str) -> dict[str, Any] | None:
    """The archive parked under *token*, removed. ``None`` once it is gone."""
    entry = _uploads(hass).pop(token, None)
    if entry is None:
        return None
    expires, parsed = entry
    return None if expires <= time.monotonic() else parsed


class LizaIPConfigRestoreView(HomeAssistantView):
    """Take an uploaded configuration archive and say what is in it.

    Nothing is written here: the view parses and parks, and the WebSocket
    command the panel sends after the user confirms is what touches the
    configuration. So this asks only for the floor -- that the caller holds a
    remote at all -- and ``ws_restore_config`` makes the real check against the
    remote the user picked to restore onto.
    """

    url = RESTORE_URL
    name = "lizaip:restore"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        """Parse the posted ZIP and answer with its summary and a token."""
        hass = request.app["hass"]
        user = request["hass_user"]
        if not holds_any_entry(hass, user):
            return web.Response(status=401)

        # Chunked, because aiohttp's `read(n)` returns what has arrived rather
        # than n bytes, and a ZIP cut short reads as "not a ZIP". The cap is
        # measured here, not taken from the uploader's Content-Length.
        buffer = bytearray()
        while True:
            chunk = await request.content.read(_UPLOAD_CHUNK)
            if not chunk:
                break
            buffer.extend(chunk)
            if len(buffer) > MAX_UPLOAD_BYTES:
                return self.json(
                    {"code": "too_large", "message": "The archive is too large"},
                    status_code=413,
                )
        data = bytes(buffer)
        if not data:
            return self.json(
                {"code": "empty", "message": "No archive was uploaded"}, status_code=400
            )

        try:
            parsed = await hass.async_add_executor_job(parse_archive, data)
        except RestoreError as err:
            _LOGGER.warning("Refused an uploaded configuration archive: %s", err)
            return self.json({"code": err.code, "message": str(err)}, status_code=400)
        except Exception as err:  # noqa: BLE001 — the panel is waiting on an answer
            _LOGGER.exception("Failed to read an uploaded configuration archive")
            return self.json(
                {"code": "unreadable", "message": f"{err.__class__.__name__}: {err}"},
                status_code=400,
            )

        if not is_admin_user(user) and archive_carries_themes(parsed["files"]):
            return self.json(
                {
                    "code": "themes_admin_only",
                    "message": (
                        "This archive carries a theme, which every remote "
                        "shares. Ask an administrator to restore it."
                    ),
                },
                status_code=403,
            )

        token = async_store_upload(hass, parsed)
        return self.json({
            "token": token,
            "device_id": parsed["device_id"],
            "pages": parsed["pages"],
            # The preview, not the configuration: `pages` is the real count,
            # and a grid of ten thousand tiles is a window nobody can read.
            "page_list": parsed["page_list"][:MAX_PREVIEW_PAGES],
            "files": parsed["file_count"],
        })


def async_setup_config_restore(hass: HomeAssistant) -> None:
    """Register the upload view. Called once, from the integration's setup."""
    hass.http.register_view(LizaIPConfigRestoreView)
