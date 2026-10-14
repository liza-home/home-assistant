"""Helpers used by more than one part of the integration.

Every module here is a leaf: it imports nothing from the rest of the
integration except ``const`` and ``imgserv``/``variables_calc``, so any
sub-package can depend on it without creating an import cycle.
"""
