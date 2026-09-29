"""Config sub-package — admin panel, WebSocket API, device sync, persistence.

Kept import-free on purpose. Submodules are imported directly
(``from .config.panel import ...``) rather than re-exported here, so that
importing any one of them doesn't pull in the whole sub-package — several are
only needed on specific code paths, and eager re-exports would make the reload
service's per-module ``importlib.reload`` calls less predictable.
"""
