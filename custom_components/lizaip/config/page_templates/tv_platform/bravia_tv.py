"""Sony Bravia (the ``braviatv`` integration).

A Bravia in standby has never read its sources: it reads them when it is on,
or when its *root* is browsed, and answers for its apps folder with nothing
until then.
"""
from __future__ import annotations

from .base import TvPlatform


class BraviaTv(TvPlatform):
    integration = "braviatv"
    reads_sources_on_root_browse = True
