"""Android TV, Google TV and what their makers add: the set's own apps.

A set built on Android lists its launcher, store and settings among its
installed packages, and Philips and Sony add menus and promo tiles of their own.
None of it is the owner's, so none of it belongs on an Apps page.
:func:`is_system_app` tells them apart for any integration that browses such
a set; Android TV Remote (:class:`AndroidTvRemote`) needs no such filter.
"""
from __future__ import annotations

import fnmatch
from typing import Final

from .base import TvPlatform

#: What a set lists among its apps although it is the set's own plumbing:
#: Android's launcher, store and settings, and what TP Vision and Sony add on
#: top. An id embeds a package name rather than being one, hence the wildcards.
SYSTEM_APPS: Final = (
    "*org.droidtv.*",                          # Philips' layer: menus, Ambilight, live TV
    "*com.tpv.*",                              # TP Vision's, who build the Philips sets
    "*com.android.vending*",                   # Play Store
    "*com.android.settings*",
    "*com.android.tv.settings*",
    "*com.google.android.tvlauncher*",         # home screen
    "*com.google.android.apps.tv.launcherx*",  # home screen, Google TV
    "*com.google.android.katniss*",            # search and assistant
    "*com.google.android.backdrop*",           # ambient screensaver
    "*com.google.android.gms*",                # Play services
    "*com.google.android.gsf*",                # services framework
    "*com.google.android.play.games*",
    "*com.google.android.tv.remote*",          # remote-control service
    # Sony's own, named one by one: a Bravia id opens with `com.sony.dtv.`
    # whatever the app, so the namespace itself says nothing.
    "*com.sony.dtv.sonyselect*",               # Sony Select promo tile
    "*com.sony.dtv.promos*",                   # My Bravia promos
    "*com.sony.dtv.demo*",                     # demo and shop modes
    "*com.sony.dtv.multiscreendemo*",
    "*com.sony.dtv.smarthelp*",
    "*com.sony.dtv.customersupport*",
    "*com.sony.dtv.imanual*",                  # the on-screen manual
)

#: Exceptions to the above. A Philips set installs what its App Gallery
#: offers under its own namespace, numbered -- nettvapp4546 is MEGOGO,
#: nettvapp4655 Deezer -- so those are the owner's apps, not the set's.
GALLERY_APPS: Final = ("*org.droidtv.nettvapp[0-9]*",)


def _matches(app_id: str, patterns: tuple[str, ...]) -> bool:
    folded = app_id.casefold()
    return any(fnmatch.fnmatchcase(folded, p.casefold()) for p in patterns)


def is_system_app(app_id: str) -> bool:
    """Whether an app id is the set's own plumbing rather than the owner's.

    Read by id alone: a title is in the TV's language, a package name is not.
    """
    return _matches(app_id, SYSTEM_APPS) and not _matches(app_id, GALLERY_APPS)


class AndroidTvRemote(TvPlatform):
    """Android TV Remote lists only the apps the owner picked: none are the set's."""

    integration = "androidtv_remote"
    keeps_system_apps = True
