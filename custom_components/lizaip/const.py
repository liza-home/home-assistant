"""Integration-wide constants: the domain, option keys, event and signal names.

Only plain values live here. Shared *helpers* live in the ``shared`` package:

- ``shared.icon_urls``  -- icon/tooltip/title URLs
- ``shared.icon_defaults`` -- default icons per domain, state and service
- ``shared.services``   -- what Home Assistant services do (state maps, scopes)
- ``shared.i18n``       -- languages and translated button tooltips
- ``shared.assignment`` -- keys and helpers for a stored button assignment
- ``shared.tooltips``   -- ``${_state}`` / ``${_name}`` tooltip placeholders
- ``shared.tokens``     -- ``${sensor.x}`` / ``${_device}`` variables
- ``shared.preludes``   -- wake prelude and launch verification steps

Panel- and storage-specific constants live in ``config/const.py``.
"""
from __future__ import annotations

from typing import Final

DOMAIN: Final = "lizaip"

#: Pages are 1-based; a page dict missing "id" is treated as the first page.
DEFAULT_PAGE_ID: Final = 1

# Config entry option key for optimistic icon updates
CONF_OPTIMISTIC_UPDATES: Final = "optimistic_updates"

# Config entry option key that controls the device-side DemoMode.
CONF_DEMO_MODE: Final = "demo_mode"

# Config entry option keys for optional DemoMode timings.
CONF_DEMO_MODE_DWELL_TIME: Final = "demo_mode_dwell_time"
CONF_DEMO_MODE_SWIPE_TIME: Final = "demo_mode_swipe_time"

# The sidebar path the config panel is registered under. Declared here as well
# as in ``config/panel.py`` because ``config/access.py`` hides the item per user
# and importing the panel would close an import cycle; a test pins the two equal.
PANEL_URL_PATH: Final = "lizaip"

# Config entry option key holding the Home Assistant user ids this remote is
# assigned to. Anyone listed here configures it in the panel without being an
# administrator; see ``config/access.py``.
CONF_ASSIGNED_USERS: Final = "assigned_users"

# Config entry option key for the language the *device* renders its labels in.
# Per entry rather than global: a household can have a remote in the kitchen
# labelled in Italian and one in the study labelled in English, and the panel's
# own language (the browser's) says nothing about which the remote should use.
CONF_LANGUAGE: Final = "language"

# The languages this integration ships button wordings for, i.e. the files in
# ``translations/`` that carry an ``button_tooltips`` section. Adding one here
# without adding the file leaves its buttons in English — `test_translations.py`
# fails on that.
SUPPORTED_LANGUAGES: Final[tuple[str, ...]] = ("en", "de", "fr", "it", "es")

# The default: follow whatever Home Assistant / the panel is using, which is
# what every device did before the option existed.
LANGUAGE_AUTO: Final = "auto"

# In-process dispatcher signals (never on the event bus, so never recorded).
#: ``SIGNAL_ICON_UPDATE.format(device_id)``; sent with a list of button updates
#: (``page_id``, ``button_key``, ``icon``, ``tooltip``, ``page_color``).
SIGNAL_ICON_UPDATE: Final = "lizaip_icon_update_{}"
#: Sent with an ``entity_id`` when a commanded value is drawn before the entity
#: confirms it; the predicted value itself lives in :mod:`optimistic`.
SIGNAL_PREDICTED_UPDATE: Final = "lizaip_predicted_update"
