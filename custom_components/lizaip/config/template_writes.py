"""Writing a template's composed pages to a remote.

Kept apart from ``template_pages`` because the dynamic refresh writes through
it too (a paginated page growing parts, ``page_templates.paginate``), and
``template_pages`` schedules that refresh: one module for both would make the
two depend on each other.
"""
from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from ..runtime import get_store
from ..shared.i18n import translate_ref
from .blueprint import async_get_blueprint
from .const import EMPTY_BUTTON, PAGE_SUBPAGE_KEY
from .events import fire_config_changed
from .listeners import refresh_state_listener, schedule_push_rescan
from .page_limit import PAGE_LIMIT_CODE, page_room_error
from .page_templates import (
    ComposedPage,
    TEMPLATE_VERSION,
    TEMPLATE_VERSION_KEY,
    is_unbound,
    template_pages,
)
from .page_templates.compose import TEMPLATE_VARIABLES_KEY
from .page_templates.parts import paginated_placeholder


class TemplatePageError(Exception):
    """A template that cannot become a page; ``code`` is the websocket error code."""

    def __init__(self, message: str, code: str = "template_error") -> None:
        super().__init__(message)
        self.code = code


def ensure_room(hass: HomeAssistant, entry_id: str, stored: list[Any], adding: int) -> None:
    """Refuse *adding* pages the remote's page limit has no room for."""
    if error := page_room_error(hass, entry_id, len(stored), len(stored) + adding):
        raise TemplatePageError(error, PAGE_LIMIT_CODE)


async def async_store_template_pages(
    hass: HomeAssistant,
    entry_id: str,
    device_id: str,
    template_id: str,
    template: dict[str, Any],
    composed: list[ComposedPage],
    *,
    target_entity: str = "",
    target_device: str = "",
    target_config_entry: str = "",
    subpage: bool = False,
    instance: int | None = None,
    insert_after: int | None = None,
    back_to_page: int | None = None,
    variables: bool = True,
) -> int:
    """Write a template's composed pages to a remote; return the first page's id.

    *instance* and *insert_after* add pages to a set already on the remote --
    the parts a paginated page grows -- after the page *insert_after*, which
    also seats a page made beside the one that asked for it.
    *back_to_page* gives the first page a hardware Back that leads there --
    what **Add options…** makes for a button. A set made without *variables*
    says so, and the parts it grows later are made without them too.

    All of them land in one pass: the action library, the pages themselves,
    and every button the template leaves alone written empty. Then the remote,
    the state listener and the push triggers are told, once.
    """
    store = get_store(hass)
    pages = await store.async_get_pages(device_id)
    # Checked again on the pages it adds to: others may have come while it was composed.
    ensure_room(hass, entry_id, pages, len(composed))
    existing_ids = {p["id"] for p in pages if isinstance(p, dict) and "id" in p}
    main_page_id = composed[0].page_id
    bound = not is_unbound(template)
    # An unbound template leaves an ordinary page: no device to change it to,
    # nothing to refresh from. One that brings pages behind it still says
    # which set they are, or deleting the page the user sees would strand them.
    # A page that repeats over its items gets parts later, which join its set.
    set_of_pages = len(composed) > 1 or any(
        paginated_placeholder(page) for _, page in template_pages(template_id, template)
    )
    for page in composed:
        new_page: dict[str, Any] = {
            "id": page.page_id,
            "title": page.title,
        }
        if page.subpage or (subpage and page.page_id == main_page_id):
            new_page[PAGE_SUBPAGE_KEY] = True
        if bound or set_of_pages:
            new_page["template"] = {
                "type": template_id,
                # The format it was made under: what a later release reads to
                # bring an older page up to date.
                TEMPLATE_VERSION_KEY: TEMPLATE_VERSION,
                # Which page of the template this is, and which set it belongs
                # to, so retargeting and deleting can treat the set as one.
                **({"page": page.name} if page.name else {}),
                **({"part": page.part} if page.part > 1 else {}),
                **({"instance": instance or main_page_id} if set_of_pages else {}),
                **({TEMPLATE_VARIABLES_KEY: False} if not variables else {}),
                **({"target": {
                    "entity_id": target_entity,
                    **({"device": target_device} if target_device else {}),
                    **(
                        {"config_entry": target_config_entry}
                        if target_config_entry else {}
                    ),
                }} if bound else {}),
            }
        at = next(
            (i + 1 for i, p in enumerate(pages)
             if isinstance(p, dict) and p.get("id") == insert_after),
            len(pages),
        )
        pages.insert(at, new_page)
        if insert_after is not None:
            insert_after = page.page_id
    await store.async_set_pages(device_id, pages)
    await store.async_merge_actions(
        device_id, [action for page in composed for action in page.actions],
    )

    bp = await async_get_blueprint(hass, entry_id)
    all_keys = [btn["key"] for btn in bp.get("buttons", [])]
    for page in composed:
        assignments = dict(page.assignments)
        # After generation, so a template that carries a Back of its own --
        # the TV remotes do -- gives way to the one that leads out of this
        # subpage.
        if (page.page_id == main_page_id and back_to_page is not None
                and back_to_page in existing_ids):
            assignments["button_back"] = {
                **dict(EMPTY_BUTTON),
                # Page format 2 translates only `{translate: ...}`.
                "tooltip": translate_ref("back"),
                "icon": "mdi:keyboard-backspace",
                "config": [{"action": "lizaip.goto_page", "data": {"page_id": back_to_page}}],
            }
        for key in all_keys:
            if key not in assignments:
                assignments[key] = dict(EMPTY_BUTTON)
        await store.async_set_assignments(device_id, page.page_id, assignments)

    await refresh_state_listener(hass, entry_id)
    fire_config_changed(hass, entry_id)
    # Re-scan after writes so new dynamic bindings get push subscriptions; the
    # scanner re-reads stored pages.
    schedule_push_rescan(hass, entry_id)
    return main_page_id
