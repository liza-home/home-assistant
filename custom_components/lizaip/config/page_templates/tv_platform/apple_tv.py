"""Apple TV: its apps' icons from the App Store, as it gives them none.

An Apple TV lists its apps by bundle id and name only -- the Companion
protocol has nothing more to give -- so an Apps page would be text. Most tvOS
apps share their bundle id with the iPhone app, and Apple's public lookup
service answers a bundle id with that app's App Store icon. A few of Apple's
own tvOS apps are listed under their iPhone twin's id (:data:`_STORE_TWINS`);
the rest are not in the store at all. The App Store and Arcade get the logo
Apple's own web pages show (:data:`_HOSTED_ICONS`) as long as it is still
there; Computers, Settings and Search -- and those two when their logo is
gone -- a lookalike of their own (:data:`BUILT_IN_ICONS`).

One request carries every bundle id still unknown, asked first in the
storefront of the country Home Assistant is set to -- regional apps are listed
only there -- then in the US one. Answers are kept for as long as Home
Assistant runs, misses included, so a page refresh asks again only about apps
it has not seen.
"""
from __future__ import annotations

import logging
from typing import Any, Final

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .base import TvPlatform

_LOGGER = logging.getLogger(__name__)

LOOKUP_URL: Final = "https://itunes.apple.com/lookup"
#: Best first; every listing has the 100 px one.
_ARTWORK_KEYS: Final = ("artworkUrl512", "artworkUrl100")
_TIMEOUT_S: Final = 10

#: Apple's tvOS apps the store lists only under the iPhone app's bundle id.
_STORE_TWINS: Final = {
    "com.apple.TVMusic": "com.apple.Music",
    "com.apple.TVWatchList": "com.apple.tv",
    "com.apple.TVPhotos": "com.apple.mobileslideshow",
}

def _tile(glyph: str, bg: str) -> str:
    return f"imgserv://{glyph}?size=tile&fg=white&bg={bg}&crop=0"


#: tvOS apps the store does not list, linked where Apple's web pages serve
#: their logo. Apple's artwork is not ours to ship. The toolbox file name
#: carries a build hash, so a link may die: :func:`_hosted_ok` checks it.
_HOSTED_ICONS: Final = {
    "com.apple.TVAppStore": "https://apps.apple.com/assets/app-store.png",
    "com.apple.Arcade":
        "https://toolbox.marketingtools.apple.com/_next/static/media/arcade.3e59a8e1.png",
}

#: tvOS apps the store does not list, drawn as on the Apple TV's home screen:
#: their glyph in white on their colour.
BUILT_IN_ICONS: Final = {
    "com.apple.TVAppStore": _tile("mdi:alpha-a", "1E9BF0"),
    "com.apple.Arcade": _tile("mdi:controller-classic", "E8333A"),
    "com.apple.TVSearch": _tile("mdi:magnify", "8E8E93"),
    "com.apple.TVHomeSharing": _tile("mdi:laptop", "FF9500"),
    "com.apple.TVSettings": _tile("mdi:cog", "8E8E93"),
}

#: bundle id -> icon URL, or "" for one the store does not list.
_cache: dict[str, str] = {}
#: hosted logo URL -> whether it still answers with an image.
_hosted_cache: dict[str, bool] = {}


async def _hosted_ok(hass: HomeAssistant, url: str) -> bool | None:
    """Whether *url* serves an image, or ``None`` when it could not be asked."""
    try:
        async with async_get_clientsession(hass).head(
            url, timeout=_TIMEOUT_S, allow_redirects=True,
        ) as resp:
            # apps.apple.com answers a missing file with a 200 HTML page.
            return resp.status == 200 and resp.content_type.startswith("image/")
    except Exception as exc:  # noqa: BLE001 - the lookalike stands in
        _LOGGER.debug("Hosted icon %s not reachable: %s", url, exc)
        return None


async def _hosted_icons(hass: HomeAssistant, bundle_ids: list[str]) -> dict[str, str]:
    icons: dict[str, str] = {}
    for bundle_id in bundle_ids:
        url = _HOSTED_ICONS.get(bundle_id)
        if not url:
            continue
        if url not in _hosted_cache:
            ok = await _hosted_ok(hass, url)
            if ok is None:
                continue
            _hosted_cache[url] = ok
        if _hosted_cache[url]:
            icons[bundle_id] = url
    return icons


def _looks_like_bundle_id(value: str) -> bool:
    return "." in value and " " not in value and "/" not in value


async def _lookup(
    hass: HomeAssistant, bundle_ids: list[str], country: str | None,
) -> dict[str, str] | None:
    """The icons one storefront lists, or ``None`` when it could not be asked."""
    params: dict[str, Any] = {"bundleId": ",".join(bundle_ids)}
    if country:
        params["country"] = country.lower()
    try:
        async with async_get_clientsession(hass).get(
            LOOKUP_URL, params=params, timeout=_TIMEOUT_S,
        ) as resp:
            resp.raise_for_status()
            # The service answers `text/javascript`.
            data = await resp.json(content_type=None)
    except Exception as exc:  # noqa: BLE001 - no icon is a text button, not an error
        _LOGGER.debug("App Store lookup (%s) failed: %s", country or "us", exc)
        return None
    found: dict[str, str] = {}
    for result in (data or {}).get("results") or []:
        bundle_id = result.get("bundleId")
        art = next((result[k] for k in _ARTWORK_KEYS if result.get(k)), "")
        if isinstance(bundle_id, str) and isinstance(art, str) and art.startswith("https://"):
            found[bundle_id] = art
    return found


async def app_store_icons(hass: HomeAssistant, bundle_ids: list[str]) -> dict[str, str]:
    """``{bundle id: icon URL}`` for those of *bundle_ids* the App Store lists."""
    asked = [b for b in dict.fromkeys(bundle_ids) if b and _looks_like_bundle_id(b)]
    twin = {b: _STORE_TWINS.get(b, b) for b in asked}
    wanted = list(dict.fromkeys(twin.values()))
    missing = [b for b in wanted if b not in _cache]
    if missing:
        country = getattr(hass.config, "country", None)
        found: dict[str, str] = {}
        answered = True
        for storefront in dict.fromkeys((country, None)):
            still = [b for b in missing if b not in found]
            if not still:
                break
            got = await _lookup(hass, still, storefront)
            if got is None:
                answered = False
                continue
            found.update(got)
        for bundle_id in missing:
            # A miss is kept only once the store has said so: a failed request
            # is asked again on the next refresh.
            if bundle_id in found or answered:
                _cache[bundle_id] = found.get(bundle_id, "")
    found = {b: _cache[twin[b]] for b in asked if _cache.get(twin[b])}
    return {
        **{b: BUILT_IN_ICONS[b] for b in asked if b in BUILT_IN_ICONS},
        **await _hosted_icons(hass, asked),
        **found,
    }


async def add_app_icons(hass: HomeAssistant, raw: list[dict]) -> None:
    """Give each app of *raw* without a picture its App Store icon, by bundle id."""
    bare = [r["media_content_id"] for r in raw if not r.get("thumbnail") and r.get("media_content_id")]
    if not bare:
        return
    icons = await app_store_icons(hass, bare)
    for r in raw:
        if not r.get("thumbnail") and (icon := icons.get(r.get("media_content_id", ""))):
            r["thumbnail"] = icon


class AppleTv(TvPlatform):
    integration = "apple_tv"

    async def decorate(self, hass: HomeAssistant, rows: list[dict]) -> None:
        await add_app_icons(hass, rows)
