"""Helpers used by more than one part of the integration.

Not leaves, though close to it: modules here import ``const``, ``runtime``,
``imgserv`` and -- in ``tokens`` -- the pure ``config.media_queue.alias`` (how
``${_queue.*}`` is spelled). A few of those use other ``shared`` modules in
turn (``imgserv``'s HTTP view reads ``shared.theme``, the ``media_queue``
package ``shared.logs``), which is safe only while no ``shared`` module
imports something that imports it back.
"""
