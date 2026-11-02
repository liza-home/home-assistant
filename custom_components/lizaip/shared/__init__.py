"""Helpers used by more than one part of the integration.

Every module here is a leaf: it imports nothing from configuration or device
packages, so any
sub-package can depend on it without creating an import cycle.
"""
