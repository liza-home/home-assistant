"""Languages and the translated wordings this integration writes by itself.

Wordings live in ``strings.json`` and ship in ``translations/<lang>.json``,
each reader taking one section of them: ``button_tooltips`` for the labels shown
on button tooltips, ``page_titles`` for the titles of the pages a remote with
nothing configured is given. To add one, edit ``strings.json`` and run
``python3 scripts/sync_translations.py --fix``; never inline a translated
literal (``tests/test_translations.py`` checks key parity).

Action labels name the *action* a press performs ("Repeat all"), not a state,
which is why Home Assistant's own state translations are not used.
``oscillate_on``/``oscillate_off`` and ``repeat_off`` deliberately differ from
HA's wording.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

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


def wording_slug(text: Any) -> str:
    """The key words fold to: lower case, anything else an underscore.

    ``Volume Up``, ``volume up`` and ``volume_up`` are all ``volume_up`` -- how a
    stored wording finds its translation, and how ``{translate: …}`` does.
    """
    return re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")


class TranslationSection:
    """One named section of every translation file, cached per language.

    The readers are synchronous and run inside the event loop, where reading a
    file is not allowed. So :meth:`async_preload` reads all files once in an
    executor at setup; after that a language we do not ship answers ``{}``
    instead of going to disk.
    """

    def __init__(self, directory: Path, section: str) -> None:
        self.directory = directory
        self.section = section
        self.cache: dict[str, dict[str, str]] = {}
        self.preloaded = False

    def _read(self, language: str) -> dict[str, str]:
        """Read one language file. Blocking; a missing/broken file yields {}."""
        if not language:
            return {}
        try:
            with (self.directory / f"{language}.json").open(encoding="utf-8") as handle:
                return json.load(handle).get(self.section) or {}
        except (OSError, ValueError):
            return {}

    def load(self, lang: str) -> dict[str, str]:
        """Every string of one language (``{}`` for one we do not ship)."""
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

    def get(self, key: str, lang: str) -> str:
        """The string in *lang*, else English, else ``""``."""
        return self.load(lang).get(key) or self.load(FALLBACK_LANGUAGE).get(key) or ""


class ButtonTooltips(TranslationSection):
    """The ``button_tooltips`` section, with the wording rules for a button."""

    def __init__(self, directory: Path) -> None:
        super().__init__(directory, "button_tooltips")

    def get(self, action_key: str, lang: str) -> str:
        """The label in *lang*, else English, else the key in title case."""
        return super().get(action_key, lang) or action_key.replace("_", " ").title()

    def wording_key(self, name: str) -> str:
        """The label key an English name stands for ("Volume Up" -> volume_up), or ""."""
        slug = wording_slug(name)
        return slug if slug and slug in self.load(FALLBACK_LANGUAGE) else ""

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


button_tooltips = ButtonTooltips(TRANSLATIONS_DIR)

#: Page-level wordings this integration writes onto a remote by itself, such as
#: the title of the welcome page a remote with no pages is given.
page_titles = TranslationSection(TRANSLATIONS_DIR, "page_titles")


#: ``{translate: <key>}`` in place of a text in a template: the words come
#: from a translation table, in the reader's language. ``name`` and
#: ``description`` (of a template or a folder) are looked up in the panel's
#: table (``lizaip-i18n.js``); a page's ``title`` in ``page_titles``, and
#: a button's ``tooltip`` in ``button_tooltips``, both drawn in the remote's
#: language. The key may be the English words themselves.
TRANSLATE_KEY: Final = "translate"


def translate_text(value: Any) -> str:
    """What a ``{translate: …}`` value says, as written; ``""`` for any other value."""
    if isinstance(value, dict) and set(value) == {TRANSLATE_KEY}:
        text = value[TRANSLATE_KEY]
        if isinstance(text, str) and text.strip():
            return text.strip()
    return ""


def translate_key(value: Any) -> str:
    """The table key of a ``{translate: …}`` value, or ``""`` for any other value."""
    return wording_slug(translate_text(value))


def translate_fallback(value: Any, default: str) -> str:
    """What a ``{translate: …}`` value reads as without a table entry.

    The words as written, when they are words; *default* for a bare key.
    """
    text = translate_text(value)
    return text if text and text != translate_key(value) else default


#: ``{translate: <key>}`` inside a text -- ``text:{translate: volume}`` -- the
#: words of that key in the remote's language. Looked up among the button
#: wordings (``button_tooltips``) first, then the page titles (``page_titles``);
#: the key may be the English words themselves (``{translate: Volume Up}``).
#: Filled in each time the text is drawn, so a change of language follows.
INLINE_TRANSLATE_RE = re.compile(r"\{translate:\s*([^{}]+?)\s*\}")

#: The language the text being drawn is for: the remote's, while its pages
#: are drawn (:func:`language_scope`). Outside one, *default_language*.
_LANGUAGE: ContextVar[str | None] = ContextVar("lizaip_language", default=None)

#: What a text drawn outside any remote's scope is translated into: the
#: panel's or Home Assistant's language, registered at setup.
_default_language: Callable[[], str] | None = None


def set_default_language(getter: Callable[[], str] | None) -> None:
    """Register what :func:`current_language` answers outside a remote's scope."""
    global _default_language  # noqa: PLW0603 - one registry for the process
    _default_language = getter


@contextmanager
def language_scope(language: str | None) -> Iterator[None]:
    """Draw everything inside in *language* -- the remote's own."""
    token = _LANGUAGE.set(language or None)
    try:
        yield
    finally:
        _LANGUAGE.reset(token)


def current_language() -> str:
    """The language a text is drawn in right now; English if nothing says."""
    language = _LANGUAGE.get()
    if not language and _default_language is not None:
        try:
            language = _default_language()
        except Exception:  # noqa: BLE001 - a broken lookup must not stop a draw
            language = None
    return normalize_language(language) or FALLBACK_LANGUAGE


def translate_inline(text: Any, language: str | None = None) -> Any:
    """*text* with every ``{translate: <key>}`` written out in *language*.

    *language* defaults to :func:`current_language`. A key neither table knows
    reads as written. Anything that is not a string is returned unchanged.
    """
    if not isinstance(text, str) or "{translate:" not in text:
        return text
    lang = language or current_language()

    def _words(match: re.Match) -> str:
        written = match.group(1).strip()
        key = wording_slug(written)
        return (
            TranslationSection.get(button_tooltips, key, lang)
            or page_titles.get(key, lang)
            or written
        )

    return INLINE_TRANSLATE_RE.sub(_words, text)
