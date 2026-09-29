"""WSS certificate helper for lizaIP device provisioning.

Reads the HA instance's TLS certificate (PEM) so it can be passed to lizaIP
devices for certificate pinning (see PROTOCOL.md § Provisioning).
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)


def get_ha_certificate_pem(hass: HomeAssistant) -> str | None:
    """Return HA's TLS certificate as a PEM string, or None if not using HTTPS.

    The ``http`` integration's runtime config lives on ``hass.http`` (a
    ``HomeAssistantHTTP`` instance set during its ``async_setup``), not
    ``hass.data["http"]`` — ``ssl_certificate`` is an attribute there.
    The device pins this certificate so it can verify it is connecting to the
    correct HA instance over WSS.

    Only returns a certificate when HA itself terminates TLS with a locally
    configured file. If HA sits behind a reverse proxy, Nabu Casa Cloud, or a
    Docker/ingress layer that terminates TLS in front of it, ``hass.http.ssl_certificate``
    is ``None`` even though the deployment is "HTTPS" from the outside — pinning
    simply doesn't apply there and the device connects over plain ``ws://`` instead.
    """
    try:
        http = getattr(hass, "http", None)
        ssl_certificate: str | None = getattr(http, "ssl_certificate", None)

        if ssl_certificate is None:
            _LOGGER.debug("HA is not using HTTPS — no certificate to pin")
            return None

        cert_path = Path(ssl_certificate)
        if not cert_path.is_absolute():
            cert_path = Path(hass.config.config_dir) / cert_path

        if not cert_path.exists():
            _LOGGER.warning("SSL certificate file not found: %s", cert_path)
            return None

        pem = cert_path.read_text(encoding="utf-8")
        _LOGGER.debug("Read HA TLS certificate from %s (%d bytes)", cert_path, len(pem))
        return pem

    except Exception:
        _LOGGER.debug("Could not read HA TLS certificate", exc_info=True)
        return None
