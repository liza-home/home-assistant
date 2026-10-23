"""Languages and the translated action labels shown on button tooltips.

Wordings live in ``strings.json`` and ship in ``translations/<lang>.json``
under ``action_labels``. To add one, edit ``strings.json`` and run
``python3 scripts/sync_translations.py --fix``; never inline a translated
literal (``tests/test_translations.py`` checks key parity).

These name the *action* a press performs ("Repeat all"), not a state, which is
why Home Assistant's own state translations are not used. ``oscillate_on``/
``oscillate_off`` and ``repeat_off`` deliberately differ from HA's wording.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Final

from ..const import CONF_LANGUAGE, LANGUAGE_AUTO, SUPPORTED_LANGUAGES
from ..runtime import panel_language
from .services import SERVICE_ACTION_MAP

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

TRANSLATIONS_DIR = Path(__file__).parent.parent / "translations"
FALLBACK_LANGUAGE: Final = "en"


def normalize_language(lang: str | None) -> str:
    """Fold ``de-DE``/``de_DE``/``de`` onto ``de``; ``""`` if unrecognisable."""
    base = str(lang or "").strip().replace("_", "-").split("-")[0].lower()
    return base if base.isalpha() else ""


def configured_device_language(entry) -> str | None:
    """The language a config entry pins its device to, or None for "auto".

    A language we do not ship also counts as None, so the caller falls back to
    the panel's or Home Assistant's language instead of English.
    """
    if entry is None:
        return None
    configured = (getattr(entry, "options", None) or {}).get(CONF_LANGUAGE) or ""
    if configured != LANGUAGE_AUTO and configured in SUPPORTED_LANGUAGES:
        return configured
    return None


def get_ui_language(hass, entry=None, fallback: str | None = None) -> str:
    """The language to label this device's buttons in.

    Order: the device's own language option, then *fallback* (the browser's
    language the panel sent), then the panel's last language, then Home
    Assistant's, then English.
    """
    return (
        configured_device_language(entry)
        or normalize_language(fallback)
        or panel_language(hass)
        or hass.config.language
        or "en"
    )


class ActionLabels:
    """The ``action_labels`` of every translation file, cached per language.

    The label code is synchronous and runs inside the event loop, where reading
    a file is not allowed. So :meth:`async_preload` reads all files once in an
    executor at setup; after that a language we do not ship answers ``{}``
    instead of going to disk.
    """

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.cache: dict[str, dict[str, str]] = {}
        self.preloaded = False

    def _read(self, language: str) -> dict[str, str]:
        """Read one language file. Blocking; a missing/broken file yields {}."""
        if not language:
            return {}
        try:
            with (self.directory / f"{language}.json").open(encoding="utf-8") as handle:
                return json.load(handle).get("action_labels") or {}
        except (OSError, ValueError):
            return {}

    def load(self, lang: str) -> dict[str, str]:
        """All labels of one language (``{}`` for one we do not ship)."""
        language = normalize_language(lang)
        if language not in self.cache:
            self.cache[language] = {} if self.preloaded else self._read(language)
        return self.cache[language]

    def _preload(self) -> None:
        """Read every shipped file into the cache. Blocking; runs in an executor."""
        try:
            shipped = sorted(self.directory.glob("*.json"))
        except OSError:
            shipped = []
        for path in shipped:
            language = normalize_language(path.stem)
            if language and language not in self.cache:
                self.cache[language] = self._read(language)
        self.preloaded = True

    async def async_preload(self, hass: HomeAssistant) -> None:
        """Fill the cache off the event loop. Called once during setup."""
        if not self.preloaded:
            await hass.async_add_executor_job(self._preload)

    def get(self, action_key: str, lang: str) -> str:
        """The label in *lang*, else English, else the key in title case."""
        return (
            self.load(lang).get(action_key)
            or self.load(FALLBACK_LANGUAGE).get(action_key)
            or action_key.replace("_", " ").title()
        )

    def wording_key(self, name: str) -> str:
        """The label key an English name stands for ("Volume Up" -> volume_up), or ""."""
        if not name:
            return ""
        slug = re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_")
        return slug if slug in self.load(FALLBACK_LANGUAGE) else ""

    def localize(self, name: str, lang: str, user_named: bool = False) -> str:
        """Translate an English name a template wrote; a user's own name stays as is."""
        if not name or user_named:
            return name
        key = self.wording_key(name)
        if not key:
            return name
        translated = self.get(key, lang)
        # A wording that only respells the template's English ("Play/Pause" vs
        # "Play / Pause") must not replace it.
        return name if self.wording_key(translated) == key else translated

    def for_service(self, svc: str, lang: str) -> str:
        """A readable label for a service name such as ``media_play_pause``."""
        if svc in SERVICE_ACTION_MAP:
            return self.get(SERVICE_ACTION_MAP[svc], lang)
        name = svc
        for prefix in ("media_", "set_"):
            if name.startswith(prefix):
                name = name[len(prefix):]
                break
        return name.replace("_", " ").title()


action_labels = ActionLabels(TRANSLATIONS_DIR)
