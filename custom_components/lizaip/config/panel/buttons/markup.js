/**
 * lizaIP Panel — Buttons View: Markup for the Buttons tab: the page strip, the page-settings panel and the per-button config card.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  capitalize,
  isGridBtn,
  isSliderBtn,
  TITLE_PREVIEW_H,
  TITLE_PREVIEW_W,
  TOOLTIP_PREVIEW_H,
  PRESS_GLYPH_SHAPE,
  OVERRIDABLE_FIXED_BUTTONS,
  num,
  entityIcon,
  FACTOR_MIN,
  FACTOR_MAX,
  domainOf,
  controlSupported,
  controlsForEntity,
  configFieldHtml,
  sliderControlFieldHtml,
  matchControl,
  controlRange,
  sliderSubjectEntity,
  sliderControlOverride,
  shownControl,
  sliderRetarget,
  SLIDER_VERTICAL_KEY,
  followsSelection,
  sliderFollows,
  pageSliderFollowsIn,
  SLIDER_ICON_HIDDEN_KEY,
  resolveSliderIcon,
  sliderIconFor,
  storesConfig,
} from "./shared.js";

export const ButtonsMarkupMixin = {
  _htmlButtonsView(bp) {

    // Pages thumbnails
    const pagesHtml = this._pages.map((page, i) => {
      const isActive = i === this._currentPageIdx;
      // `_pageLabel`, not `page.image`: `image` is a title-*image* spec, so a
      // reader announced the raw scheme -- "delete page mdi:sofa". The helper
      // strips it and falls back to a name rather than to the bare id.
      const displayName = this._pageLabel(page);
      const delIcon = `<span class="page-thumb-del" role="button" tabindex="0" data-page-idx="${i}" data-page-id="${this._esc(String(page.id))}" title="${this._esc(this._t("delete_page"))}" aria-label="${this._esc(this._t("a11y_delete_page", { name: displayName }))}"><ha-icon icon="mdi:close-circle" style="--mdc-icon-size:16px" aria-hidden="true"></ha-icon></span>`;
      const currentPageId = this._pages[this._currentPageIdx]?.id;
      const pageAssigns = (page.id === currentPageId)
        ? this._assignments
        : (this._pageCache[page.id] || {});
      const allBtnKeys = bp.buttons.map(b => b.key);
      // The same gate the button face uses, so the count and the drawing never
      // disagree about what this page has on it. A page whose vertical slider is
      // merely following the selection stores nothing and reads as blank, which
      // is what it is.
      const filledCount = allBtnKeys.filter(k => storesConfig(pageAssigns[k])).length;

      // A subpage's only sighted cue is a darker tint and a lower position
      // (.page-thumb.subpage) -- neither reaches a screen reader, which would
      // otherwise have no way to tell one from a main page at all. Folded
      // into the name itself, not the fill description, because it answers
      // "which page is this", not "what is on it".
      const subpageNote = page.subpage ? `, ${this._t("a11y_subpage")}` : '';
      const spokenName = this._t("page_name_pos", {
        name: displayName, n: i + 1, m: this._pages.length,
      }) + subpageNote;
      const fillDesc = this._t("page_fill_desc", {
        filled: filledCount, total: allBtnKeys.length,
      });
      const descId = `pg-desc-${this._esc(String(page.id))}`;
      // A reader joins the name and the description with a bare space, so
      // "page 2 of 4" ran straight into "15 of 19" and was heard as
      // "page 2 of 4 15 of 19". The full stop is not spoken; it is what makes
      // the reader pause between the two, so only the name that actually has
      // a description after it gets one.
      const openLabel = `${this._t("a11y_open_page", { name: spokenName })}.`;
      // A group only where there is something to group: the open page holds the
      // delete button and the whole interactive face. A closed one is a single
      // control, and wrapping that in a named group made a reader cross a
      // boundary and say the page twice -- "Kitchen, group", then "Open Kitchen".
      // The fill count moves onto the button rather than being dropped: it is
      // what a sighted user reads off the drawn face.
      // `data-a11y-name`, not `aria-label`, and no `title` either: a div with an
      // accessible name but no role is exposed as a group, so both of those put
      // "Hue -- 4 of 19 buttons assigned, page 3 of 4, group" after the button
      // that had just said the same words. The open thumb is still a
      // programmatic focus target and _a11yFocusFallback still announces it.
      const groupAttrs = isActive
        ? ` data-a11y-name="${this._esc(spokenName)}" tabindex="-1"`
        : '';
      // No `title`: the browser's own tooltip would be a second answer to the
      // same hover, in a second style, overlapping the card -- which is why
      // the open face lost its `<title>` too.
      const pictureAttrs = isActive
        ? ''
        : ` role="button" tabindex="0" aria-label="${this._esc(openLabel)}" aria-describedby="${descId}"`;
      // tabindex="-1" makes the open page a programmatic focus target (see
      // _a11yFocusFallback) without adding a tab stop. `data-page-idx` is a
      // position and pages are draggable, so focus restoration keys on the
      // stable `data-page-id` instead (see dataAttrs in lizaip-a11y.js).
      // The delete button is rendered only on the open page: elsewhere it was
      // invisible yet focusable (2.4.7) and still hit-tested. Placed before
      // the container so the tab order reads page, delete, buttons.
      return `
        <div class="page-thumb ${isActive ? 'active' : ''} ${page.subpage ? 'subpage' : ''}" data-page-idx="${i}" data-page-id="${this._esc(String(page.id))}" draggable="true"${groupAttrs}>
          ${isActive ? delIcon : ''}<span id="${descId}" class="liza-sr-only">${this._esc(fillDesc)}</span>
          <div class="pg-svg-container" data-page-idx="${i}" data-page-id="${this._esc(String(page.id))}"${pictureAttrs}></div>
        </div>`;
    }).join("");

    // Config panel (right side)
    let configHtml = '';
    if (this._selectedButtonIdx >= 0) {
      const selBtn = bp.buttons[this._selectedButtonIdx];
      configHtml = this._htmlButtonConfigPanel(bp, selBtn);
    } else {
      // No button selected — show page settings by default
      configHtml = this._htmlPageSettingsPanel(bp);
    }

    // The goto-link overlay below is deliberately the strip's *first* child.
    // Last is taken: _reorderPageDom moves every thumb in front of
    // .page-add-btn on the understanding that the add button is the final
    // node, so a sibling after it would be dragged out of place by the first
    // reorder. Painting order is settled by the layer's z-index instead of by
    // where it sits here.
    //
    // Inside the strip rather than over the card because the strip is the
    // scroll container: an absolutely positioned child scrolls with its
    // content, so the link's two endpoints and the overlay all move together
    // and the drawn coordinates stay true without anything having to listen
    // for scrolling.
    return `
      <div class="config-layout">
        <ha-card outlined class="pages-card">
          <div class="pages-list" style="flex-wrap:nowrap;overflow-x:auto;min-height:350px;">
            <svg class="goto-link-layer" aria-hidden="true" focusable="false"></svg>
${pagesHtml}
            <div class="page-add-btn" role="button" tabindex="0"
                 aria-label="${this._esc(this._t("add_new_page"))}"
                 title="${this._esc(this._t("add_new_page"))}">
              <ha-icon aria-hidden="true" icon="mdi:plus" style="--mdc-icon-size:22px;color:color-mix(in srgb, var(--primary-text-color) 60%, transparent);"></ha-icon>
            </div>
          </div>
        </ha-card>
        ${configHtml}
      </div>`;
  },

  _htmlPageSettingsPanel(bp) {
    if (!this._pages.length) return '';
    const page = this._pages[this._currentPageIdx];
    const pageImgTitle = page.image || "";
    const pageDefaultColor = page.default_color || "";
    const pageCount = this._pages.length;
    const canMoveUp = this._currentPageIdx > 0;
    const canMoveDown = this._currentPageIdx < pageCount - 1;

    const allBtns = bp.buttons.filter(b => b.key !== "slider_horizontal");
    const assignedCount = allBtns.filter(b => this._isButtonAssigned(b.key)).length;

    // Icon-tint swatches, served by lizaip_config/get_palette rather than
    // hardcoded: the hex a user clicks is stored as default_color and handed
    // back to imgserv as `?fg=`, and the list is the remote's theme's.
    const presets = this._palette || [];
    // Only used to seed the native picker, which needs some opening colour.
    // Looked up by name instead of by position so reordering PALETTE_NAMES cannot
    // silently change it.
    const defaultHex = presets.find(p => p.name === "white")?.hex || "FFFFFF";
    const isCustomColor = pageDefaultColor && !presets.some(p => p.hex === pageDefaultColor);
    // An unset page follows the theme rather than being tinted, so showing White
    // as active would claim a choice that was never made. White stays a real
    // option and is cleared like any other.
    const swatchesHtml = presets.map(p => {
      const isActive = pageDefaultColor === p.hex;
      const label = p.name.charAt(0).toUpperCase() + p.name.slice(1);
      return `<button class="ps-color-dot ${isActive ? 'active' : ''}" data-color="${p.hex}" title="${this._esc(label)}" aria-label="${this._esc(label)}" aria-pressed="${isActive ? 'true' : 'false'}" style="background:#${p.hex};"></button>`;
    }).join("")
      + (isCustomColor ? `<button class="ps-color-dot active" data-color="${pageDefaultColor}" title="${this._esc(this._t("custom"))}" aria-label="${this._esc(this._t("custom"))}" aria-pressed="true" style="background:#${pageDefaultColor};"></button>` : '');

    // The title's editor, shown once the title itself has been clicked on the
    // face. Selecting a page is how this card is usually reached, and the
    // page's picture is not what that selection was about — the colour below
    // is. `ps-page-meta` carries the "which page, of how many" line either way.
    //
    // Rendered as nothing rather than hidden with `display:none`, so there is
    // one answer to "is the title open" (this flag) instead of two that can
    // disagree. `_wirePageSettingsPanel` already guards every node it wires.
    //
    // It is the *same* field as a button's Image, down to the class names: the
    // title is a button like any other, and editing it used to be a different
    // gesture entirely — a display row with a pencil, a raw text box that took
    // `mdi:`/`text:`/`logo:` prefixes by hand, and a ✓/✕ pair to commit. Now
    // it is the shared media field the button's Image and Tooltip use: one
    // copy-pasteable text box taking every imgserv source, saving on Enter or
    // blur, with `mdi:`/`phu:` suggestions. What it does not have is the
    // Tooltip field: the title bar prints its own picture and has no second
    // line to caption.
    //
    // Previewed through `_configImagePreviewHtml`, the button card's own, so
    // the two fields agree about tint and what an empty slot looks like. What
    // they do not share is the shape: a button is square, the title is the
    // device's 4:1 strip, so it asks for `size=title` — the very request the
    // device makes — and gets a box of the same proportion to show it in. Asked
    // as a square, a brand that ships a wide mark would answer with its square
    // one and the preview would contradict the device.
    // It used to draw its own: a 20px preview and, with nothing stored, a
    // document glyph — which named a picture the title does not have. There is
    // nothing to derive for a title, so the empty arm is the one that shows.
    // "3 of 5" and the two arrows either side of it are about the *page* -- which
    // one this is, and where it sits in the run. With the title open the card is
    // about one item on that page, and both would answer a question nobody
    // asked: the arrows in particular are two clicks from reordering pages while
    // the user is editing a picture, and their target is not even on screen.
    //
    // The whole banner goes, not just its contents. An empty one is a band of
    // padding above the field, which reads as the card having lost something.
    const pageTitleText = this._pageTitle(this._pages[this._currentPageIdx]);
    const bannerHtml = this._pageTitleSelected ? '' : `
        <div class="ps-title-banner">
          <div class="ps-page-meta">
            <div class="ps-page-meta-text">
              <span class="ps-title-subtitle">${this._esc(this._pagePosition(this._pages[this._currentPageIdx]))}</span>
              ${pageTitleText ? `<span class="ps-page-name">${this._esc(pageTitleText)}</span>` : ''}
            </div>
          </div>
          <div class="ps-title-reorder">
            <ha-icon-button class="ps-reorder-btn ps-move-up" ${canMoveUp ? '' : 'disabled'} label="${this._esc(this._t("move_left"))}">
              <ha-icon icon="mdi:arrow-left" aria-hidden="true"></ha-icon>
            </ha-icon-button>
            <ha-icon-button class="ps-reorder-btn ps-move-down" ${canMoveDown ? '' : 'disabled'} label="${this._esc(this._t("move_right"))}">
              <ha-icon icon="mdi:arrow-right" aria-hidden="true"></ha-icon>
            </ha-icon-button>
          </div>
        </div>`;
    // Below the banner rather than inside it, exactly as the button card puts
    // its Image field below its own header. The banner is a flex row holding
    // the page counter and the reorder arrows; a field wrapped into it pushed
    // those arrows onto a third line.
    const titleEditorHtml = this._pageTitleSelected ? `
          <div class="ps-title-editor" id="pageTitleEditor">
            <span class="title-icon-field">${this._htmlIconField({
              label: this._t("image"),
              // Previewed as the remote draws it, `${_device}` included; the
              // field itself keeps what the user typed.
              value: this._pageTitleImage(page),
              inputValue: pageImgTitle,
              hint: this._pageTitleHint(page, pageImgTitle),
              color: pageDefaultColor,
              shape: { size: "title", box: { w: TITLE_PREVIEW_W, h: TITLE_PREVIEW_H } },
              previewClass: "icon-preview-title",
              slotId: "ps-icon-picker-slot",
            })}
          </div>` : '';

    // The colour is the page's, not the title's: it tints every icon on the
    // page and the title is one item among them. So it is offered while the
    // card is *about* the page, and stands down while the title row is open —
    // a swatch grid sitting under an open rename box reads as the colour of
    // the thing being renamed, which is the one thing it is not.
    //
    // Absent rather than disabled: there is nothing to grey out here, the
    // question simply is not being asked. Every colour handler in
    // `_wirePageSettingsPanel` is already null-guarded, and the swatches are
    // wired through `querySelectorAll`, which yields nothing on an empty list.
    // Temporarily disabled: the per-page icon colour section.
    const colorSectionHtml = '';
    /*
    const colorSectionHtml = this._pageTitleSelected ? '' : `
          <div class="ps-section" style="margin-top:0;padding-top:0;border-top:none;">
            <h2 class="ps-section-title" title="${this._esc(this._t("tints_icons"))}">
              <ha-icon icon="mdi:palette" style="--mdc-icon-size:16px;"></ha-icon> ${this._t("icon_color")}
            </h2>
            <div class="ps-color-presets">${swatchesHtml}</div>
            <div class="ps-color-row">
              <input type="color" class="ps-color-native" id="psColorNative" value="${pageDefaultColor ? '#' + pageDefaultColor : '#' + defaultHex}" aria-label="${this._esc(this._t("pick_custom_color"))}" title="${this._esc(this._t("pick_custom_color"))}" />
              <ha-input appearance="outlined" class="ps-color-input" id="psColorInput" value="${pageDefaultColor ? '#' + pageDefaultColor : ''}" accessible-label="${this._esc(this._t("color_hex"))}" placeholder="#hex" autocomplete="off"></ha-input>
              ${pageDefaultColor ? `<ha-icon-button class="ps-color-clear" id="psColorClear" label="${this._esc(this._t("clear_color"))}"><ha-icon icon="mdi:close" aria-hidden="true"></ha-icon></ha-icon-button>` : ''}
            </div>
          </div>`;
    */

    // A page made from a template drives one device (or hub); naming it here, as
    // the button that changes it, answers "what does this page control" without
    // a trip through the page strip's context menu.
    const templateTargetHtml = this._pageTitleSelected || !(page.template?.type || page.template?.target?.device) ? '' : (() => {
      const hub = !!page.template.target?.config_entry;
      const name = this._templateTargetName(page);
      const changeLabel = this._t(hub ? "change_hub" : "change_device");
      return `
          <div class="ps-section ps-template-target" style="margin-top:0;padding-top:0;border-top:none;">
            <h2 class="ps-section-title">
              <ha-icon icon="${hub ? "mdi:hub" : "mdi:devices"}" style="--mdc-icon-size:16px;" aria-hidden="true"></ha-icon> ${this._t(hub ? "template_hub" : "template_device")}
            </h2>
            <ha-button appearance="outlined" class="ps-template-target-btn" id="psTemplateTarget" title="${this._esc(changeLabel)}">
              <span class="liza-sr-only">${this._esc(changeLabel)}</span>
              <span class="ps-template-target-name">${this._esc(name)}</span>
              <ha-icon slot="end" icon="mdi:pencil" aria-hidden="true"></ha-icon>
            </ha-button>
          </div>`;
    })();

    // The banner can be the whole card: with no title open, no template target
    // and the colour section stood down, an empty body is padding and a rule
    // under a row that has nothing below it.
    const bodyHtml = `${titleEditorHtml}${templateTargetHtml}${colorSectionHtml}`;
    return `
      <ha-card outlined class="config-card">
        <h2 class="liza-sr-only">${this._esc(this._t("a11y_page_region"))}</h2>
        ${bannerHtml}
        ${bodyHtml.trim() ? `<div class="config-card-body ps-body">${bodyHtml}</div>` : ''}
      </ha-card>`;
  },

  // The button card's header, which is also its Appearance editor.
  //
  // Image and Tooltip used to sit at the bottom of the card body, below the
  // action editor and the state-icon list -- the two fields describing what the
  // button *looks like*, placed furthest from the picture of it. They are
  // edited here instead, where the thing they change is on screen while it
  // changes.
  //
  // Always open, and with no icon or name above them. Both were the disclosure
  // control's doing: the section needed a banner to click, and the banner
  // needed something to show. But the card is only ever reached by clicking the
  // button on the face -- which is right beside it, drawn larger, and already
  // carries the selection highlight -- so the banner repeated the picture the
  // user had just clicked and the name printed under it, in order to offer a
  // fold nobody wanted. Two fields is not a section to hide.
  //
  // Grid buttons only. The slider's icon and tooltip are scoped -- they follow
  // whichever button is holding the slider, see `_sliderAppearanceTarget` --
  // and its Icon field carries four different hints depending on what is
  // chosen. That belongs beside the mechanics explaining it, not in a banner
  // shared with a card that has no such scope.
  //
  // `subtitleHtml` is deliberately outside the editor: it carries the
  // `Page default` button, and a button nested inside the fields region would
  // be hard to reach past them.
  //
  // Image before label. The picture is what the button *is* on the face — it is
  // what the user is looking at when they open this — and the name is what that
  // picture is called. What the order decides is which question the open card
  // asks first, and that is "what does it look like".

  _htmlConfigCardHeader(o) {
    const fields = `${o.appearanceHostHtml || ''}${o.labelFieldHtml || ''}`;
    const cycling = !!o.pressRowOneHeadHtml;
    // With a cycle on the button, the two fields above are press 1's and
    // belong in the list with the rest. The row *wraps* the hosts rather than
    // inlining what is in them: the appearance host is rebuilt by assigning
    // innerHTML and the Tooltip is deliberately not in a host at all (see
    // ENTITY_SECTION_HOST), so flattening them into the row would either lose
    // a host or put a half-typed name where a rebuild could throw it away.
    // Wrapping costs nothing and keeps both guarantees.
    //
    // `#config-card-presses` is `display: contents`, so presses 2..N land as
    // siblings of this row and the list's spacing and rail treat every press
    // the same.
    //
    // Emitted even when there is no cycle, and neutralised with `press-plain`
    // -- which is `display: contents` the whole way down, so a button with one
    // action lays out exactly as it did when these elements did not exist.
    // The alternative was to emit the wrapper only when cycling, and then
    // adding a second action would be a change of *structure*;
    // `_refreshButtonEntitySections` patches hosts and cannot build a wrapper
    // around them, and the only other way to get one is a full re-render,
    // which tears down the action editor the user is typing in. A class is
    // something a patch can flip.
    return `
      <div class="config-card-header cch">
        ${o.subtitleHtml || ''}
        <div class="cch-editor" id="configCardEditor">
          <div class="cch-editor-inner">
            <div class="press-appearance-section${cycling ? "" : " press-plain"}" id="config-card-press-section">
              <div id="config-card-press-head">${o.pressSectionLabelHtml || ''}</div>
              <div class="press-appearance-list"${cycling
                ? ` role="group" aria-labelledby="liza-press-appearance-label" aria-describedby="liza-press-appearance-hint"`
                : ''}>
                <details class="press-appearance-row" data-press-idx="0" ${cycling ? (o.pressRowOneOpen ? "open" : "") : "open"}>
                  ${o.pressRowOneHeadHtml || `<summary class="press-appearance-head"></summary>`}
                  ${fields}
                </details>
                ${o.pressListHtml || ''}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  },

  // The icon the device will draw for a button that stores no image of its own.
  //
  // The one place that answers it, because the field's first render and the
  // URL input's live preview both need it and a second copy of the expression
  // is how those two drift apart. Asked with `image`/`image_pinned` blanked
  // rather than reading `_resolveButtonIcon` straight: a stored image would
  // otherwise win and the answer would be "what it shows now", which is not the
  // question.
  //
  // `""` as the fallback, not `mdi:radiobox-blank`: a placeholder is exactly
  // what must not be offered as the button's own icon, and the caller draws the
  // empty slot itself.

  _derivedButtonImageIcon(selKey) {
    const assign = this._editAssign(selKey) || {};
    const action = assign.action_id
      ? this._actions.find(a => a.id === assign.action_id) || null
      : null;
    return this._resolveButtonIcon(
      { ...assign, image: "", image_pinned: false }, action, "") || "";
  },

  _htmlButtonConfigPanel(bp, selBtn) {
    // Read through the edit slot, never `this._assignments[key]` directly: under
    // a context this card is the override's editor, and reading the page
    // default here would render one config while writing another.
    const selAssign = this._editAssign(selBtn.key) || {};
    // Names the card for assistive technology. The button's own name, never
    // its storage key -- `button_3` is an internal identifier, and the header
    // stopped printing it for exactly the reason it should not be announced.
    const regionLabel = this._tNamed("a11y_config_region", this._buttonSpokenLabel(selAssign));
    const selAction = selAssign.action_id ? this._actions.find(a => a.id === selAssign.action_id) : null;
    // Gate the ✕ on the *assignment*, not on the library entry: a deleted or
    // missing action leaves action_id dangling, and hiding ✕ then made the
    // button impossible to clear. Asked of the record being edited, so that
    // under a context the ✕ appears exactly when there is an override to clear
    // — and not because the page default happens to be configured. An icon on
    // its own counts, because that too is something ✕ now clears.
    const editingOverride = this._editingOverride(selBtn.key);
    // A label the device could never show. Fixed buttons carry a firmware glyph
    // (PROTOCOL.md §12) — but that is equally true of the page default's card,
    // which has always offered the field, so the *page* card is left exactly as
    // it is and only the write is guarded. `labelIsDead` is kept as a name so
    // there is one place to say "never offer it" if that decision is ever taken.
    const labelIsDead = false;
    // Under a context the field is offered but inert until the override has an
    // action of its own: a label-only override is dropped by the writers, so
    // accepting one would be a field that takes a value and loses it.
    const labelNeedsAction = editingOverride && !this._isAssignedRecord(this._editAssign(selBtn.key) || {});
    // Only where the remote has long touch on, and not in a context: the
    // remote holds a click back for the long touch of the button itself, not
    // of an override the selection swaps in.
    const showLongtouch = !!this._longtouchEnabled?.() && !editingOverride;
    const selAssigned = this._isAssignedRecord(selAssign);
    const selEntity = selAssign.config ? this._getTargetEntityFromConfig(selAssign.config) : null;
    // A proportional slider has no action_id and no library entry, so the shared
    // resolver cannot name it — its icon comes from the control it drives. An
    // explicit image still wins, matching _resolveButtonIcon's own precedence.
    const selIcon = (selAssign.image ? "" : sliderIconFor(this._sliderControls, selAssign))
      || this._resolveButtonIcon(selAssign, selAction, "mdi:radiobox-blank");
    const selDefault = capitalize(selBtn.key.replace(/_/g, " "));
    const showImage = isGridBtn(selBtn.key);

    // The subtitle line, which is where the card says *which pair* it is. Under
    // a context it is the main defence against the accidental-override risk:
    // with a context set, clicking a fixed button edits the override rather
    // than the default, and a user who has forgotten the context is set would
    // otherwise have nothing on screen telling them so.
    //
    // The `Page default` toggle beside it keeps today's behaviour reachable
    // without deselecting the grid button — it drops the context and leaves the
    // same button selected, so the card switches from the override to the
    // default in place.
    const contextName = this._liveContextKey()
      ? (this._assignments[this._liveContextKey()]?.label
         || capitalize(this._liveContextKey().replace(/_/g, " ")))
      : "";
    // The slider is not in OVERRIDABLE_FIXED_BUTTONS — its per-button config is
    // a `{entity_id, control}` block in `overrides` on the grid button, not a
    // frozen entry — so `_editingOverride` is false for it and it used to get the plain
    // key row. It needs this row for the same reasons the fixed buttons do, and
    // now for a third: `Page default` is the only signposted way back to the
    // slider's own Entity, Sensitivity, icon and label, which the card no longer
    // renders while a button is selected. Deselecting on the face works too, but
    // nothing announces it.
    const showContextKeyRow = editingOverride
      || (selBtn.key === SLIDER_VERTICAL_KEY && !!this._liveContextKey());
    // Nothing when there is no context to announce. The row used to fall back to
    // `button_5  Wohnzimmer`, which named the card after an internal storage key
    // and the page whose tab is already highlighted two inches above it: a line
    // that could not be acted on, under the one line that can. The subtitle now
    // appears exactly when it has something to say — that this card is editing an
    // override rather than the default, which is the case where saying nothing is
    // how an override gets written by accident.
    const cardKeyHtml = showContextKeyRow
      ? `<div class="config-card-key context-key">
           <span>${selBtn.key} · ${this._t("context_when_selected", {
             // Escaped here, then wrapped: `_t` substitutes raw, so the value
             // has to arrive inert. The <b> travels with the placeholder
             // because the name does not sit in the same position in every
             // language.
             name: `<b>${this._esc(contextName)}</b>`,
           })}</span>
           <ha-button appearance="outlined" size="s" class="ctx-page-default" title="${this._esc(this._t("edit_page_default_title"))}">${this._t("page_default")}</ha-button>
         </div>`
      : '';

    // Shared by both slider cards, hoisted so they cannot drift: sliders get
    // the same icon control as grid buttons. Left empty, the icon implied by
    // the mode is used — HA's tile features carry their own icon rather than
    // borrowing one from tap_action.
    //
    // `hasEntity` because there is nothing to imply an icon *from* until the
    // slider names a device: with none, the field used to preview
    // `mdi:tune-vertical` and promise it as the default, which reads as a
    // choice already made on a card where nothing has been chosen. Empty shows
    // the same "no icon" placeholder the grid buttons use.
    // `ctx` is the retargeting context, or null. Passed rather than closed over
    // because the last-touched card calls this too and has no context to speak
    // of. When it is set, every value below is the *button's*: what it stores,
    // what it falls back to, and where an edit lands. When it is null they are
    // the page's, exactly as before.
    const sliderIconFieldHtml = (hasEntity, ctx = null) => {
      const storedIcon = ctx ? ctx.image : (selAssign.image || "");
      const iconHidden = ctx ? ctx.iconHidden : !!selAssign[SLIDER_ICON_HIDDEN_KEY];
      // The sentinel is a stored choice, not a value to display: "no icon" and
      // "not set" both draw as an empty field, which is exactly right. They are
      // different to the *card* — one derives a glyph and one does not — but the
      // difference is not the user's to see, and a control explaining it would
      // be UI no other icon field on this panel has.
      // The icon the mechanics imply, which exists only when they name a control
      // to borrow one from. `sliderIconFor` no longer invents `mdi:tune-vertical`
      // for a slider that names no control, so this is empty exactly when there
      // is nothing to promise.
      //
      // Gated on the entity as well, because the mechanics can match a preset on
      // service and attribute alone: with no device chosen that would offer an
      // icon derived from a control nothing is pointed at.
      const autoIcon = ctx ? ctx.autoIcon : (hasEntity ? sliderIconFor(this._sliderControls, selAssign) : "");
      // Under a context the field is the button's own, so it has one answer and
      // it is about the control that button drives. The page's four-way split
      // below does not apply: there is always a control here, because a button
      // only holds the appearance axis while it is actually retargeting.
      //
      // This field used to be the page's in both scopes, which is what the
      // "page default" tag was apologising for. The tag is gone because the
      // apology is: an edit here now lands on the button named in the header,
      // like every other field on the card under a context.
      const isNone = iconHidden;
      const ctxHint = this._t("ctx_icon_own", { name: this._esc(contextName) })
        + (isNone
            ? this._t("ctx_icon_none")
            : (autoIcon
                ? this._t("ctx_icon_clear")
                : this._t("ctx_icon_empty")));
      // Four states, because there are four. The three empty ones differ in what
      // the user can do about it: with no device chosen the way to get a default
      // is to choose one, a slider that follows the selection has no fixed
      // control at all and never will, and under a context the field is not
      // about the selected button in the first place.
      //
      // That last one used to fall through to "Nothing is chosen", directly
      // under an Entity field showing a chosen device — a flat contradiction.
      // The two are answering about different scopes: this field is the page's
      // icon, gated on the page's own entity, while the face beside it draws the
      // live control the *selected button* points the slider at. Say which is
      // which rather than let one deny the other.
      const iconHint = ctx ? ctxHint : (isNone
        ? this._t("icon_showing_none")
        : autoIcon
        ? this._t("icon_clear_to_hide")
        : (hasEntity
            ? this._t("icon_leave_empty")
            : this._t("icon_nothing_chosen")));
      // Resolved before the field sees it, because "hidden" is a stored choice
      // rather than a value: `_htmlIconField` would otherwise let the derived
      // glyph stand in for it and draw the very icon the user turned off.
      return this._htmlIconField({
        label: this._t("icon"),
        value: resolveSliderIcon(storedIcon, autoIcon, iconHidden),
        slotId: "config-icon-picker-slot",
        hint: iconHint,
      });
    };

    // --- Slider ---
    // One card for every proportional slider, because there is only one kind.
    //
    // There used to be two, chosen by a "Target" row: pinned to an entity, or
    // following the last-touched device. That row is gone. Following is
    // something *buttons* do to a slider — each button declares which device it
    // points the slider at (the block's `entity_id`) and which control it picks
    // (`overrides.slider_vertical`)
    // — so "pinned" was never a kind of slider, only the state of not having
    // been retargeted yet. Offering it as a slider-level choice put one axis
    // inside another's field, which is the same mistake `mode: "follow"` made
    // and the same one a third target chip made after it.
    //
    // So this card says what the slider drives *by default*, and the grid does
    // the rest. The entity field's emptiness carries the meaning, exactly as
    // the icon field's does: filled, the slider works the moment the page
    // opens; empty, it does nothing until you touch something, which stays the
    // honest answer on a page of peer devices where no default is right.
    // A slider with no stored mechanics is shown as the proportional slider it
    // becomes on first edit — ensureSliderActions writes exactly this mode — so
    // every read below (matchControl, the num() defaults) sees the shape it
    // would have after one keystroke.
    //
    // It is not what decides whether this slider *follows*, though. That
    // substitution only repairs a missing blob, and `ensureSliderActions`
    // scaffolds a bare `{}`, which is truthy in JS and so survives it — read
    // through `followsSelection` it came back *pinned*, telling a brand-new
    // slider that no button can retarget it. `sliderFollows` owns that question
    // for both languages and is asked with the key and the raw assignment.
    // Read-only: the handlers mutate this._assignments through ensureSliderActions,
    // never this local, so nothing is written by merely opening the card.
    const sliderActions = selAssign.slider_actions || { mode: "proportional" };
    // --- What the context button does to the slider ---
    //
    // Above the slider branch because the slider branch is the only place it
    // is used. It used to sit below, among the ordinary button card, guarded
    // by `selBtn.key === SLIDER_VERTICAL_KEY` -- a test that cannot pass
    // there, because the slider returns its own card a hundred lines earlier.
    // The whole block was dead, so the settings this file claims were moved
    // onto the slider card rendered nowhere at all.

    //
    // Two independent questions, kept as two fields for the same reason the
    // backend keeps them as two keys: whether touching the context button
    // retargets the slider at all, and — given that it does — which of its
    // entity's controls it drives. The second is meaningless when the first is
    // off, so it is hidden then rather than shown greyed out.
    //
    // The whole section is hidden when the choice it offers could not do
    // anything, which is two separate conditions:
    //
    //  * this page's slider does not follow the selection — it is pinned.
    //    Nothing any button does can retarget it, so a checkbox promising
    //    otherwise is a lie.
    //  * the context button has no entity, or one with nothing a slider can
    //    drive.
    //
    // Hiding is *presentational only*: a stored slider subject stays exactly
    // where it is, because the page's slider may be switched to follow later
    // and the button's target must still be there when it is.
    const verticalAssign = (this._assignments || {})[SLIDER_VERTICAL_KEY];
    // An unconfigured vertical slider follows the selection — including one
    // with no assignment at all, which is how a template that declares no slider
    // arrives here. `sliderFollows` owns that rule for both languages.
    const verticalFollows = sliderFollows(SLIDER_VERTICAL_KEY, verticalAssign);
    const pageSliderFollows = pageSliderFollowsIn(this._assignments);

    // Which grid button's slider settings this card edits, and null on every
    // card that edits none.
    //
    // They are the *slider's* card now, not the grid button's. They were on the
    // grid button and the user asked twice to take them off it, and the second
    // ask named the reason: the settings say what the slider does, so the
    // gesture that reaches them should be selecting the slider. Select a grid
    // button, then the slider, and the card says which entity it will drive.
    //
    // The settings still *belong* to the grid button — the control name is a
    // capability of the entity behind it, and the slider stores nothing, which
    // is the rule the whole feature rests on. So the card is the slider's and
    // the record is the context's, and that split is why this key exists rather
    // than the code just reading `selBtn`.
    const sliderCtxKey = (selBtn.key === SLIDER_VERTICAL_KEY && this._liveContextKey())
      ? this._liveContextKey() : null;
    // The page slot, deliberately, not the edit slot. The control name and
    // the slider block are not fixed-button overrides — they are the grid button's own
    // itself — so routing them through `_editAssign` would bury them in
    // `overrides` where nothing reads them.
    const sliderCtxAssign = sliderCtxKey ? (this._assignments[sliderCtxKey] || {}) : {};
    const sliderCtxState = sliderRetarget({
      key: sliderCtxKey || "",
      assign: sliderCtxAssign,
      entityFor: (cfg) => this._getTargetEntityFromConfig(cfg),
      controls: this._sliderControls,
      stateFor: (e) => this._hass?.states?.[e],
      pageSliderFollows,
    });
    // The effective entity, explicit or derived — read from the predicate rather
    // than recomputed, so the card cannot describe one entity while the face
    // marks another.
    const sliderCtxEntity = sliderCtxState.entity || null;

    // Everything the card needs to know about the selected grid button — and
    // nothing about how any of it looks.
    //
    // The slider card below renders ONE body. The same fields, in the same
    // order, at the same widths, from the same code, whether a grid button is
    // selected or not. What a selection changes is which *values* the fields
    // show, which hints they carry, and where an edit lands. That is what "per
    // button" means, and it is all it should ever have meant.
    //
    // This used to be three fragments building their own markup beside the page
    // card's, and they drifted the moment they existed: the labels diverged
    // (`Control` against `Controls`), the copy grew a section heading the page
    // card has none of, and it referenced a variable that lived only in the
    // original's scope -- `factor is not defined`, which took the whole card
    // down for every button that retargets. There is no second card now, so
    // there is nothing left to drift from.
    const sliderCtx = (() => {
      if (!sliderCtxKey) return null;
      const label = this._assignments[sliderCtxKey]?.label
        || capitalize(sliderCtxKey.replace(/_/g, " "));
      // The device the button's own action already names. Offered, never
      // preselected: an untouched button must read as untouched, so the field
      // shows what the user chose and the derived answer is a link in the prose.
      const derived = sliderCtxAssign.config
        ? (this._getTargetEntityFromConfig(sliderCtxAssign.config) || "") : "";
      const derivedState = derived ? this._hass?.states?.[derived] : null;
      const derivedControls = derived
        ? controlsForEntity(this._sliderControls, derived, derivedState) : [];
      const derivedDrivable = derivedControls.length > 0;
      // The entity's own icon, not the icon of the control a touch would drive.
      // This showed `mdi:brightness-6` for every lamp -- the `light-brightness`
      // preset's icon -- on the argument that it said what the slider would
      // *do*. Beside a device name it does not read that way: it reads as that
      // device's icon, and it was the wrong one. What a touch will drive is the
      // Control field's job, and the Control field appears the moment this chip
      // is used.
      const derivedIcon = derivedDrivable ? entityIcon(derived, derivedState) : "";
      const derivedName = derived
        ? (derivedState?.attributes?.friendly_name || derived) : "";
      // Presence *is* the switch. A named device means this button retargets the
      // slider; an empty field means it leaves the slider alone. There was a
      // separate toggle beside this once, and the pair asked one question twice
      // -- the switch could be on with nothing to point at, which looked
      // configured and did nothing.
      const explicit = sliderSubjectEntity(sliderCtxAssign) || "";
      // The effective target, explicit or derived, read from the same predicate
      // the face reads, so the card cannot describe one entity while the face
      // marks another — but only once the button actually retargets. The
      // predicate reports the derived entity whether or not the button is opted
      // in, and Control describes what a touch will drive: naming one for a
      // button that leaves the slider alone would be the card claiming a
      // behaviour the remote does not have.
      const entity = sliderCtxState.retargets ? (sliderCtxState.entity || "") : "";
      // Two states, plus one that sits above them both: a page whose slider is
      // pinned cannot be retargeted by anything, so a field promising otherwise
      // is a lie.
      //
      // There used to be a third, which is why this was once a three-way
      // question — a button could retarget while this field was empty, deriving
      // a device from its own action. Naming the device is the whole opt-in now,
      // so "empty" and "leaves the slider alone" are the same state and the card
      // can say so without disagreeing with the remote.
      //
      // The way in is no longer spelled here: the shortcut is a button under the
      // picker, so the sentence stops trying to be a control and just says what
      // is true.
      // The field owns the whole axis: which device, with empty meaning "this
      // button says nothing, so the page's slider config stands". There is no
      // toggle beside it because there is no second question -- a fixed-button
      // override is opted into by existing, and this is the same thing. So the
      // empty branch has to say that emptiness is the off state, or the field
      // reads as merely unfilled.
      // The empty branch used to name the button in full and then spell out the
      // fallback -- "Empty, so <long device name> Toggle leaves this slider
      // alone and the slider keeps doing whatever Page default says" -- which
      // was the third time that name appeared in a row three lines tall. The
      // card's header already says which button this is.
      const hint = !pageSliderFollows
        ? this._t("slider_pinned_hint", { page_default: this._esc(this._t("page_default")) })
        : (entity
            ? this._t("slider_points_here", { name: this._esc(label) })
            : this._t("slider_empty_hint", { page_default: this._esc(this._t("page_default")) }));

      // Which of the entity's controls the touch drives. A stored id the entity
      // no longer supports is not honoured by the backend either --
      // `resolve_control` warns and falls back to the derived control -- so
      // showing it selected would make the field claim something a touch will
      // not do. It shows the truth, says why, and picking any entry clears the
      // stale id.
      const entityState = entity ? this._hass?.states?.[entity] : null;
      const available = controlsForEntity(this._sliderControls, entity, entityState);
      const chosenId = sliderControlOverride(sliderCtxAssign);
      const shown = available.length ? shownControl(available, chosenId) : null;
      const stale = !!chosenId && !!shown && shown.id !== chosenId;
      const [staleLo, staleHi] = shown ? controlRange(shown, entityState) : [0, 0];

      // Sensitivity is the one page field that can honestly follow a selection:
      // the executor carries `factor` across a retarget untouched, because it
      // describes the length of the track under the finger and not a property of
      // the device. Its neighbours cannot -- the Advanced mechanics are
      // re-derived from the live entity on every gesture and a stored per-button
      // copy is silently discarded, and Icon and Label are baked into the face
      // the device is sent per *page*, which nothing re-renders on a selection.
      const pageFactor = (() => {
        const raw = this._assignments[SLIDER_VERTICAL_KEY]?.slider_actions?.factor;
        return typeof raw === "number" && isFinite(raw) ? raw : 1.0;
      })();
      const own = sliderCtxAssign.slider_factor;
      const factorOverridden = typeof own === "number" && isFinite(own);

      return {
        label, explicit, entity, derived, derivedName, derivedDrivable, derivedIcon,
        retargets: sliderCtxState.retargets,
        entityHint: hint,
        available, shown, chosenId,
        // Only the stale case says anything. The field already names the control,
        // and the Entity field above already says a touch retargets the slider,
        // so a hint in the ordinary case can only repeat one of them -- or quote
        // the raw span, which is Kelvin and 0-255, not units anyone reads.
        controlHint: stale
          ? this._t("control_stale", {
              stored: this._esc(chosenId), control: this._esc(shown.label),
              min: staleLo, max: staleHi,
            })
          : "",
        // What the face shows while this button holds the context, and what an
        // edit under Appearance now lands on. A fourth axis alongside entity,
        // control and sensitivity, stored the same way: a non-empty value or
        // nothing at all, where nothing means "use the control's own icon".
        //
        // The default is the live control glyph rather than the page's icon,
        // because the page's icon describes the page's entity and this button
        // has pointed the slider somewhere else. So the field starts by showing
        // the truth and only stores something once the user disagrees with it.
        image: typeof sliderCtxAssign.slider_image === "string" ? sliderCtxAssign.slider_image : "",
        iconHidden: !!sliderCtxAssign[SLIDER_ICON_HIDDEN_KEY],
        label: typeof sliderCtxAssign.slider_name === "string" ? sliderCtxAssign.slider_name : "",
        autoIcon: shown?.icon || "",
        autoLabel: shown?.label || label,
        pageFactor,
        factorOverridden,
        factor: factorOverridden ? own : pageFactor,
        factorHint: factorOverridden
          ? this._t("factor_own_hint", { name: this._esc(label), page: pageFactor })
          : this._t("factor_inherited_hint", { name: this._esc(label) }),
      };
    })();

    // Appearance is the button's whenever the button is actually holding the
    // slider, and the page's otherwise. Those are the only two honest readings:
    // a context button that does not retarget leaves the slider showing the
    // page's icon, so a per-button icon there would store something that never
    // appears.
    //
    // Hoisted above the card body because the header reads it too — a header
    // showing the page's icon and name above fields holding the button's would
    // be the same split this change removes, moved forty lines up.
    // Appearance is the selected button's whenever a button is selected. Not
    // gated on `retargets`: a selection has to edit the selection's record, or
    // the fields quietly rewrite the page default -- see
    // `_sliderAppearanceTarget`, which this must agree with exactly.
    const apprCtx = sliderCtx;

    // --- The slider card ---
    // Every `slider_` button gets it, configured or not. Gating on
    // `slider_actions.mode === "proportional"` would leave a fresh slider
    // stranded in an ordinary action picker it could never become a slider from.
    //
    // Rendering the editor does not claim the button is configured: isConfigured,
    // _isButtonAssigned, store._is_empty_button and the WS _sanitize_slider_actions
    // all still require a mode, and none of them consults this. The mode is
    // written by ensureSliderActions on the first real edit, so an untouched
    // card saves nothing — which is why the old warning about a half-built {}
    // being rendered as configured does not apply here.
    if (isSliderBtn(selBtn.key)) {
      // One scope for the whole card. Under a selection these read the grid
      // button's fields; with nothing selected they read the page's. Every field
      // below is written once against these names, so the two cases cannot grow
      // apart.
      //
      // No fallback to the button's own entity in the page case. An empty
      // default is a real, meaningful state — "do nothing until you touch a
      // device" — so showing something else in its place would make it
      // unreachable on screen.
      const targetEntity = sliderCtx ? sliderCtx.entity : (sliderActions.target_entity || "");
      // Whose name and glyph the header wears. The same answer the Appearance
      // fields give, because the header is a preview of them: with a button
      // holding the slider it shows that button's stored pair, falling back to
      // the live control the way the fields' placeholders do.
      const displayName = apprCtx
        ? (apprCtx.label || apprCtx.autoLabel || selDefault)
        : (selAssign.label || selDefault);
      const headerIcon = apprCtx
        ? (apprCtx.image || apprCtx.autoIcon || "mdi:radiobox-blank")
        : selIcon;
      const factor = sliderCtx ? sliderCtx.factor : num(sliderActions.factor, 1.0);
      const attribute = sliderActions.attribute || "volume_level";
      const service = sliderActions.service || "media_player.volume_set";
      const dataKey = sliderActions.data_key || attribute;
      const valMin = num(sliderActions.min, 0);
      const valMax = num(sliderActions.max, 1);

      // --- Control (capability) derivation, HA tile-feature style ---
      const targetState = this._hass?.states?.[targetEntity];
      // The two scopes answer "which control" from different places and there is
      // no honest way to merge that: the page stores the mechanics and the
      // control is whichever preset they spell, while a grid button stores an id
      // and the mechanics are re-derived live from whatever entity it points at.
      // So the *answer* is computed per scope and everything downstream — the
      // options, the field, the warnings — is written once.
      const activeControl = sliderCtx
        ? sliderCtx.shown
        : matchControl(this._sliderControls, sliderActions);
      const available = sliderCtx
        ? sliderCtx.available
        : controlsForEntity(this._sliderControls, targetEntity, targetState);
      // A control the config names but the entity can't do (or that belongs to
      // another domain) still belongs in the list — otherwise the dropdown
      // would silently show something the user never chose.
      const options = activeControl && !available.includes(activeControl)
        ? [activeControl, ...available]
        : available;
      // No "Custom…" entry: it is not a capability, and selecting it could only
      // ever be a no-op. Advanced below is the escape hatch. But a hand-edited
      // config matches no preset, and a select with nothing selected reads as
      // blank or as its first option -- silently claiming e.g. "Brightness". A
      // placeholder states the truth without offering a choice: picking it is
      // ignored, as an empty value always is.
      const controlOptions = [
        ...(activeControl ? [] : [{ value: "", label: this._t("set_under_advanced"), disabled: true }]),
        ...options.map(c => ({ value: c.id, label: c.label })),
      ];
      // Most domains expose exactly one control — media_player, fan, number,
      // climate and humidifier all have a single entry in the table. A
      // <select> whose only option is the one already chosen looks operable and
      // is not, so show the choice as a fact instead. The select returns as soon
      // as there is genuinely something to choose between.
      const controlFieldHtml = sliderControlFieldHtml({
        useSelect: !(options.length === 1 && activeControl),
        selectAttrs: this._haSelectAttrs(controlOptions, activeControl ? activeControl.id : ""),
        activeLabel: activeControl ? this._esc(activeControl.label) : "",
        selectClass: "slider-control-select",
        iconHtml: activeControl ? this._renderIconHtml(activeControl.icon, 20) : "",
      });
      const controlHint = sliderCtx
        ? sliderCtx.controlHint
        : (!targetEntity
            ? this._t("pick_target_first")
            : (options.length === 0
                ? this._t("no_presets_for_domain", { domain: this._esc(domainOf(targetEntity)) })
                // Happy path: state what the slider will actually write, so the
                // mechanics are visible without opening Advanced to find them.
                : (activeControl
                    ? `Writes <code>${this._esc(dataKey)}</code> between ${valMin} and ${valMax}.`
                    : "")));

      // --- Inline validation ---
      const entityKnown = !targetEntity || !!targetState;
      const warnings = [];
      if (!entityKnown) warnings.push(this._t("unknown_entity", { entity: this._esc(targetEntity) }));
      // The silent-failure case: the config names a real capability the entity
      // does not have (e.g. colour temperature on an xy-only lamp). The device
      // sends events, the executor can't read the attribute, and nothing
      // happens — with no feedback anywhere. Say so.
      if (activeControl && targetState && !controlSupported(activeControl, targetState)) {
        const friendly = targetState.attributes?.friendly_name || targetEntity;
        warnings.push(this._t("control_unsupported", {
          name: this._esc(friendly),
          control: this._esc(activeControl.label.toLowerCase()),
        }));
      }
      // Min and Max are page mechanics, and Advanced now shows them whichever
      // button is selected, so their disagreement is worth saying whichever
      // button is selected too. The executor re-derives the range from the live
      // entity on a retarget, which is why this is a page problem and not a
      // per-button one — not a reason to keep quiet about it.
      if (Number(valMax) <= Number(valMin)) {
        warnings.push(this._t("max_must_exceed_min"));
      }
      const rangeWarning = warnings.length
        ? `<div class="slider-warning">${warnings.join(" ")}</div>` : '';

      // Answered from the page in both scopes, because Advanced edits the page
      // in both scopes. Reading the selected button's entity here would put a
      // "customised" tag on the page's mechanics for drift that is not theirs,
      // offer a reset computed from the wrong device, and list another device's
      // attributes. With no context these are the same values as above.
      const pageEntity = sliderActions.target_entity || "";
      const pageState = pageEntity ? this._hass?.states?.[pageEntity] : null;
      const pageControl = matchControl(this._sliderControls, sliderActions);
      const pageAvailable = controlsForEntity(this._sliderControls, pageEntity, pageState);

      // HA's attribute selector is a dropdown over the entity's real
      // attributes, never free text. Fall back to text only when we can't see
      // the entity (unknown or not yet picked).
      const liveAttrs = pageState?.attributes;
      const attributeFieldHtml = liveAttrs
        ? `<ha-select class="slider-attribute-input"${this._haSelectAttrs(
            [...new Set([...Object.keys(liveAttrs), attribute].filter(Boolean))].sort()
              .map(k => ({ value: k, label: k })),
            attribute)}></ha-select>`
        : `<ha-input appearance="outlined" class="slider-attribute-input" value="${this._esc(attribute)}" placeholder="volume_level" autocomplete="off"></ha-input>`;

      // Hand-editing any of the plumbing below makes matchControl return null,
      // which drops Control to the disabled placeholder with no route back
      // short of retyping the preset from memory. Say so on the summary, so a
      // drifted config announces itself while still collapsed, and offer the
      // way back.
      const advDrifted = !!pageEntity && !pageControl;
      const resetTarget = advDrifted && pageAvailable.length ? pageAvailable[0] : null;

      // The card under a selection is the card with nothing selected. Not a
      // variant of it, not a nested thing: the same fields, in the same order,
      // written to the grid button instead of the page.
      //
      // That falls out of spelling the opt-in the way the fixed-button
      // overrides already spell theirs. `button_power` under a context needs no
      // switch and no mode, because absence *is* "no override, the page's
      // config stands" and adding an action is the whole of turning it on. A
      // slider target is the same question with a different noun, so it gets
      // the same answer: an empty picker means this button leaves the slider
      // alone, and naming a device is the opt-in.
      //
      // A `Retarget` toggle sat here briefly and was wrong for the reason its
      // ancestor was wrong -- two controls asking one question, so an empty
      // picker meant two different things depending on state the card never
      // showed. Presence is the axis. There is no second axis.
      //
      // What it costs, said plainly: the slider no longer re-derives the device
      // from the button's action on every touch, so re-pointing a grid button
      // leaves its slider target behind. The fixed-button overrides have always
      // behaved exactly that way, and unlike an invisible derive, a stale
      // target is sitting in the picker where it can be seen and changed.
      const entityControlHtml = (() => {
        const picker = `<div class="slider-entity-picker-container"></div>`;
        // The one-click way in, and the reason the empty state is not a chore:
        // the device this button already drives is nearly always the answer, so
        // the card offers it rather than sending the user to a list of
        // everything in the house. Offered only when there is something to
        // offer -- beside a chosen device it would propose a no-op, and for a
        // device with nothing a slider can move it is a dead end.
        if (!sliderCtx || sliderCtx.entity || !sliderCtx.derivedDrivable) return picker;
        // One name, said once. This was a caption naming the *button* and
        // ending in the bare word `controls` -- a sentence cut in half, and a
        // word this card already uses two fields below for a different thing --
        // beside a chip repeating a near-identical *device* name, so the same
        // long string sat on screen twice and wrapped the row. The caption
        // carries the name now, with the device's icon beside it, because that
        // pair is what identifies a device.
        //
        // The button says what pressing it does, not `Use it`: `it` was the
        // device, which is the one thing the sentence to its left had just
        // finished saying, so the button named its object twice over and said
        // nothing about the field it fills.
        return `${picker}
          <div class="slider-ctx-suggest">
            <span class="slider-ctx-suggest-label">${this._t("this_button_controls")}
              ${sliderCtx.derivedIcon ? this._renderIconHtml(sliderCtx.derivedIcon, 18) : ""}
              <span>${this._esc(sliderCtx.derivedName)}</span>
            </span>
            <ha-button appearance="outlined" size="s" class="slider-ctx-use-default" data-entity="${this._esc(sliderCtx.derived)}">${this._t("use_for_slider")}</ha-button>
          </div>`;
      })();

      // Control and Advanced describe the entity above, so with no entity they
      // describe nothing: a range nobody will read, and a Control select over
      // an empty list. Editing settings that cannot take effect is the same
      // invisible dead state this card exists to remove.
      //
      // The two gates differ because the two scopes do. Control is about
      // whatever the *card's* scope drives, so it follows `targetEntity`;
      // Advanced edits the page's mechanics whichever button is selected, so it
      // follows the page's own entity. With no context the two are the same
      // value and this is the single gate it has always been.
      const proportionalHtml = !targetEntity ? "" : `
        ${configFieldHtml({ label: this._t("control"), control: controlFieldHtml, hint: controlHint })}
        ${rangeWarning}`;
      const advancedHtml = !pageEntity ? "" : `
        <details class="slider-advanced" ${advDrifted ? "open" : ""}>
          <summary>${this._t("advanced")}${advDrifted ? ` <span class="slider-advanced-tag">${this._t("customised")}</span>` : ""}</summary>
          <div class="slider-advanced-body">
          ${sliderCtx ? `<span class="config-field-hint">${this._t("slider_page_mechanics_hint", {
            name: this._esc(sliderCtx.label),
            page_default: this._esc(this._t("page_default")),
          })}</span>` : ""}
          <div class="config-field slider-range-row">
            <ha-input type="number" appearance="outlined" id="liza-slider-min" class="slider-min-input"
              label="${this._esc(this._t("range_min"))}" value="${valMin}" step="0.01" inputmode="decimal"></ha-input>
            <ha-input type="number" appearance="outlined" id="liza-slider-max" class="slider-max-input"
              label="${this._esc(this._t("range_max"))}" value="${valMax}" step="0.01" inputmode="decimal"></ha-input>
          </div>
          <span class="config-field-hint">${this._t("slider_range_hint")}</span>
          <div class="config-section-divider"></div>
          ${configFieldHtml({ label: this._t("attribute"), control: attributeFieldHtml })}
          ${configFieldHtml({
            label: this._t("service"),
            control: `<ha-input appearance="outlined" class="slider-service-input" value="${this._esc(service)}" placeholder="media_player.volume_set" autocomplete="off"></ha-input>`,
          })}
          ${configFieldHtml({
            label: this._t("data_key"),
            control: `<ha-input appearance="outlined" class="slider-datakey-input" value="${this._esc(dataKey)}" placeholder="volume_level" autocomplete="off"></ha-input>`,
          })}
          <span class="config-field-hint">${this._t("slider_plumbing_hint")}</span>
          ${resetTarget ? `<ha-button appearance="outlined" class="slider-reset-control" data-control="${resetTarget.id}">
            <ha-icon slot="start" icon="mdi:restore" aria-hidden="true"></ha-icon>
            ${this._esc(this._t("reset_control_defaults", { control: resetTarget.label }))}
          </ha-button>` : ""}
          </div>
        </details>`;

      // --- What the rest of the page does to this slider ---
      // Nothing here writes; it is a statement of what will happen, in the same
      // spirit as removing `Automatic` — the page behaviour was inferable only
      // by opening every button card in turn.
      //
      // This used to also list the buttons that retarget the slider
      // ("Retargeted by: Lamp (Brightness), ..."). That roster is gone: it grew
      // with the page, restated what every one of those buttons already says on
      // its own card, and answered a question nobody was asking from here. What
      // is left is the one fact this card cannot otherwise tell you — that the
      // slider is pinned in YAML, so nothing on the page can retarget it and
      // the fields below are the whole story.
      const summaryHtml = sliderFollows(selBtn.key, selAssign)
        ? ""
        : `<div class="slider-page-summary">${this._t("pinned_in_yaml")}</div>`;

      // Sliders get the same icon control as grid buttons — see
      // `sliderIconFieldHtml` above, shared with the last-touched card. Which
      // record it writes depends on who is holding the slider: the page when
      // nothing is, the context button when one is.
      // Appearance is the button's whenever the button is actually holding the
      // slider — see `apprCtx` above, hoisted so the header shares this answer.
      const iconFieldHtml = sliderIconFieldHtml(!!sliderActions.target_entity, apprCtx);

      return `
        <ha-card outlined class="config-card">
          <div class="config-card-header">
            <div class="config-card-icon">${this._renderIconHtml(headerIcon, 22, this._currentPageColor())}</div>
            <div class="config-card-title-wrap">
              <h2 class="config-card-name">${this._esc(displayName)}</h2>
              ${cardKeyHtml}
            </div>
          </div>
          <div class="config-card-body">
            <!-- ONE body, one field list, both cases. Every field is here
                 whether a grid button is selected or not: same order, same
                 widths, same markup, same code. A selection changes where the
                 values come from and where an edit lands, which is the only
                 thing "per button" ever meant.

                 One of them belongs to the page whatever is selected: the
                 Advanced mechanics, which the remote re-derives from the live
                 entity on every gesture, so there is nothing per-button to
                 store. It was dropped under a selection first, and then greyed
                 out with the reason beside it, on the argument that a page
                 field on a per-button card is a lie. But the card never claimed
                 to be per-button: it says which button it is nested under in
                 its own key row, and a field that cannot be typed into teaches
                 nothing that the sentence next to it was not already saying. So
                 it renders and it works, and an edit goes to the page default
                 from here exactly as it would from there. The note stays,
                 because which record is being written is worth knowing.

                 Icon and Label used to be in that list and are not any more:
                 they follow whoever is holding the slider. See Appearance.

                 What a selection adds, and all it adds: the suggestion chip
                 under Entity, and hints that speak about the selected button.

                 No backticks in this comment: it sits inside a template literal,
                 where a backtick closes the literal even from within an HTML
                 comment. Same trap as lizaip-styles.js. -->
            ${configFieldHtml({
              // Empty on purpose: ha-entity-picker renders its own name and
              // `for` cannot reach the control inside it, so a second label
              // here would be visible duplication naming nothing.
              label: "",
              control: entityControlHtml,
              hint: sliderCtx
                ? sliderCtx.entityHint
                : this._t("slider_entity_hint"),
            })}
            ${summaryHtml}
            ${proportionalHtml}
            ${advancedHtml}
            ${configFieldHtml({
              label: this._t("sensitivity"),
              control: `<ha-input type="number" appearance="outlined" class="slider-factor-input" value="${factor}" step="0.1" min="${FACTOR_MIN}" max="${FACTOR_MAX}" inputmode="decimal"></ha-input>`,
              action: sliderCtx?.factorOverridden
                ? `<ha-icon-button class="slider-factor-reset" label="${this._esc(this._t("slider_use_page_factor", { value: sliderCtx.pageFactor }))}"><ha-icon icon="mdi:restore" aria-hidden="true"></ha-icon></ha-icon-button>`
                : "",
              hint: sliderCtx
                ? sliderCtx.factorHint
                : this._t("slider_factor_hint"),
            })}
            <!-- Appearance is the one section whose scope follows the slider
                 rather than the card. With a grid button selected, both fields
                 below write that button's record; the page keeps them only when
                 nothing is selected.

                 It was the page's in both scopes until a user changed the icon
                 with a button selected and watched the page default move. That
                 was answered first with a paragraph, then with a "page default"
                 tag on this heading, then by scoping only the buttons that
                 retarget the slider — each of them explaining a scope split
                 rather than removing it, and the last still moved the page
                 default for any button that did not retarget. No split now:
                 under a context this section behaves like every other field on
                 the card. -->
            <h3 class="config-section-title">${this._t("appearance")}</h3>
            ${iconFieldHtml}
            ${(() => {
              const sliderLabel = apprCtx ? apprCtx.label : (selAssign.label || selDefault);
              return this._htmlIconField({
                label: this._t("label"),
                value: sliderLabel || apprCtx?.autoLabel || "",
                inputValue: sliderLabel,
                inputClass: "config-label-input",
                placeholder: apprCtx ? apprCtx.autoLabel : "",
                color: this._currentPageColor(),
                shape: { size: "tooltip", box: { w: TITLE_PREVIEW_W, h: TOOLTIP_PREVIEW_H } },
                previewClass: "icon-preview-title",
                slotId: "config-label-slot",
                hint: apprCtx
                  ? this._t("label_own_hint", {
                      name: this._esc(contextName),
                      auto: this._esc(apprCtx.autoLabel),
                    })
                  : "",
              });
            })()}
          </div>
        </ha-card>`;
    }
    // --- End slider special case ---
    // Everything below is the ordinary button card. A `slider_` key never
    // reaches it now: the branch above returns for every one of them, so the
    // scaffold that used to offer the Behavior row here has no state left to
    // describe. `slider_horizontal` never reached it either — it is filtered
    // out of the button list upstream.

    // `_labelEdited` is a session-only flag — `_saveAssignments` strips it before
    // persisting — so keying the input off it meant that after a reload the panel
    // forgot a label was stored and offered a freshly derived one instead. Saving
    // then overwrote the stored label with that derivation, which is how an
    // Android TV `Home` button (stored "Home") could turn into "Send Command"
    // on the remote. The input holds the stored text verbatim; `_resolveLabel`
    // says what the remote makes of it.
    const currentLabel = selAssign.label || "";
    const autoLabel = this._computeLabel(selAction, selEntity, selAssign.config);
    // A stored name that merely repeats the action library's name is only
    // discarded by the remote when the state rung outranks it -- for a static
    // name like "Power" the remote still uses the stored text. So fall to the
    // derived template only when that template is a state placeholder, or
    // every Android TV button reads "Send Command" again.
    const storedIsPlaceholder = this._labelIsAutoFilled(currentLabel, selAction, autoLabel, selAssign);
    // Not `|| selDefault`: "Button 5" is a panel-only stand-in, and the remote
    // prints nothing at all for an unassigned button. Holding it as a *value*
    // made it look like a name that was already set, and one keystroke away
    // from being stored as one. It is the field's placeholder instead.
    const labelFieldValue = (storedIsPlaceholder ? autoLabel : currentLabel) || autoLabel || "";
    // The hint under the field explains a placeholder, so it is only shown when
    // the field actually holds one that resolves. "Home" is a plain name and
    // has nothing to explain.
    const labelShowsState =
      this._labelHasStateToken(labelFieldValue) &&
      !!this._displayLabel("${_state}", selAction, selEntity, selAssign.config);
    // `${_name}` is only a token on a device-local command, so the hint is
    // gated on the button carrying one *and* on that command naming a target
    // -- a goto pointed at a page that no longer exists resolves to nothing,
    // and promising a replacement that never comes is worse than staying quiet.
    const labelShowsName =
      this._labelHasNameToken(labelFieldValue) &&
      !!this._displayLabel("${_name}", selAction, selEntity, selAssign.config);
    // What the remote prints for this button *right now*.
    //
    // The field cannot show it. It holds the stored text verbatim, tokens and
    // all, because committing the resolved words would freeze them: a mute
    // button reading "Mute" would keep saying "Mute" after the speaker was
    // muted, which is the contradiction `${_state}` exists to avoid.
    //
    // But "${_state}" is not a tooltip anyone recognises, and the
    // hint only said the token "is replaced by what pressing the button does"
    // -- true, and no help at all in telling whether it is working. Naming the
    // current answer is the difference between a field that looks broken and
    // one that is visibly live.
    const labelShowsVariable = this._hasEntityToken(labelFieldValue);
    // Discovery, not only explanation: the track tokens are worth a sentence
    // wherever they *could* be used, not just where they already are. On a
    // lamp the same sentence would be noise, so the target decides.
    const labelHasMedia = this._labelHasMediaToken(labelFieldValue);
    const labelShowsMedia = labelHasMedia
      || (labelShowsState && this._targetsMediaPlayer(selAssign.config));
    const labelResolved = (labelShowsState || labelShowsName || labelShowsVariable || labelShowsMedia)
      ? this._resolveLabel(selAction, selEntity, selAssign.config, currentLabel, selAssign)
      : "";
    // A device-local command whose target the device cannot resolve is sent
    // disarmed. Surfaced here because the label deliberately still names the
    // target the user asked for, so it cannot also carry the bad news.
    const internalProblem = this._internalCommandProblem(selAssign.config, selAction?.service);

    const imageVal = selAssign.image || "";

    const stateIcons = selAssign.state_icons || {};
    const iconDomain = selEntity ? selEntity.split(".")[0] : (selAction?.service || "").split(".")[0];
    let actionStates = this._actionStates(selAction, selEntity);
    // Grandfather any state the user has already overridden but that the list
    // above no longer offers — a service whose rows were narrowed, or an action
    // re-pointed at a different entity.
    //
    // `state_icons` lives on the assignment and is keyed by state string, so it
    // outlives whatever the editor happens to render: `device_sync.py` still
    // matches it when pushing an icon and `store.py` still folds it into the
    // config hash. A row that vanishes from the card therefore does not become
    // inert, it becomes *invisible and live* — an icon the user cannot see,
    // explain or clear. Showing the row keeps the ✕ reachable.
    //
    // Attribute-keyed overrides ("attr:value", per `_resolve_button_icon`) are
    // left alone; they are not states and have no row to belong to.
    if (selAction) {
      const shown = new Set(actionStates.map(s => s.state));
      const defaults = this._getDefaultIcons(iconDomain, null);
      for (const key of Object.keys(stateIcons)) {
        if (!stateIcons[key] || key.includes(":") || shown.has(key)) continue;
        actionStates = actionStates.concat({ state: key, icon: defaults[key] || "" });
      }
    }

    let stateIconsHtml = '';
    const hasStateIcons = showImage && selAction && actionStates.length > 0;
    if (hasStateIcons) {
      // One field per state, built the same way as the Image field above it,
      // because it is the same question asked once per state. The row used to be
      // a display line with a ✎ that revealed an editor, a ✕ that reset it and a
      // badge naming the default — three controls around a picker that answers
      // all three: it shows what is stored, clearing it restores the default,
      // and the preview beside it says what the device will draw either way.
      const rows = actionStates.map(s => {
        const override = stateIcons[s.state] || "";
        return this._htmlIconField({
          label: this._localizeState(
            s.state,
            selEntity || ((selAction.service || "").split(".")[0] + ".x"),
            s.attribute),
          value: override,
          // The action's own icon for this state stands in when nothing is
          // overridden — the same stored-then-derived order every other field
          // here uses, so an untouched row previews what the device draws.
          autoIcon: s.icon || "",
          color: this._currentPageColor(),
          slotAttrs: `data-state="${this._esc(s.state)}"`,
        });
      }).join("");
      stateIconsHtml = `
        <div class="config-field state-icons-section">
          <label id="liza-btn-icons-label">${this._t("button_icons")}</label>
          <div class="state-icons-list" role="group" aria-labelledby="liza-btn-icons-label">${rows}</div>
        </div>`;
    }

    // Image and state icons remain mutually exclusive -- when an action carries
    // states, those rows *are* the button's images and a single image above them
    // would be a fourth answer to a question the list has already answered three
    // times. They now live in different regions of the card, so the exclusion is
    // stated once here and both regions read it.
    const showImageEditor = showImage && !hasStateIcons;
    // The icon the device derives when nothing is stored, which is what the
    // preview stands in with.
    const autoImageIcon = showImageEditor
      ? this._derivedButtonImageIcon(selBtn.key)
      : "";
    const imageFieldHtml = showImageEditor ? this._htmlIconField({
      label: this._t("image"),
      value: imageVal,
      autoIcon: autoImageIcon,
      color: this._currentPageColor(),
      slotId: "config-icon-picker-slot",
    }) : '';

    // How each of the *later* presses looks. Press 1 is the button, so the
    // Image and Tooltip fields above already answer for it; presses 2..N have
    // no fields of their own anywhere else, because the action editor draws
    // them as Home Assistant action cards and an action card has nowhere to
    // put an icon.
    //
    // Here rather than under the editor on purpose: this section is already
    // the card's answer to "what does this button look like", and for a cycle
    // the honest answer is "it depends which press". Mechanics under Click,
    // looks under Appearance.
    //
    // Each press is drawn with the *same* two fields as press 1, at the same
    // width and in the same order -- the row is a second copy of the pair
    // above it, numbered. It previously used a cramped half-width picker and a
    // bare input, so the same two questions were asked twice in two shapes and
    // the later presses read as an afterthought rather than as peers.
    //
    // Including the variable hint and the resolved readout. That used to be the
    // one honest difference: `${sensor.x}` worked for press 1 and quietly did
    // nothing here, so the hint was withheld rather than advertise a feature
    // the backend did not implement. All three missing pieces are now in place
    // -- the repaint resolves the tooltip and the icon
    // (`action_controller/buttons.py`, `icons.toggle_icon`), and
    // `config/variables.py` collects `toggle.rules[].label`/`.icon` so a
    // change to the named entity resyncs the page instead of leaving the value
    // frozen at whatever it read when the press ran.
    const pressRules = this._toggleRules(selBtn.key);
    const pressTitles = this._pressHeadings(pressRules);
    // Whether the presses are shown as a list at all. Below two there is no
    // cycle, so there is nothing to number and the button's Image and Tooltip
    // stay the plain pair of fields they have always been.
    const showPressList = isGridBtn(selBtn.key) && this._toggleFeatureEnabled?.()
      && pressRules.length > 1;
    const pressAppearanceHtml = showPressList
      ? `${pressRules.slice(1).map((rule, i) => {
            const idx = i + 1;
            // Each press is a labelled group, not a bare box. Every row holds
            // a field called "image" and a field called "Tooltip", so down a
            // list of three presses a screen reader announces "image" three
            // times with nothing to tell them apart -- the ordinal and the
            // action name that separate them for a sighted user sit beside
            // the fields, not attached to them. The group name carries both,
            // built from strings that are already translated, so this needs
            // no key of its own.
            // The action while it still tells the presses apart, the user's
            // own wording when it does not -- see `_pressHeadings`. Naming
            // every row from the label would print one long string twice,
            // stacked on the Tooltip field that writes it; naming every row
            // from the action gave three steps of one service three identical
            // headings.
            const actionName = pressTitles[idx];
            // Shut unless the user opened it, or `_applyCycle` opened it
            // because they just added this press. Read from the panel rather
            // than left to the DOM: these rows are rebuilt on every keystroke
            // elsewhere in the card, so a row remembering its own state would
            // forget it immediately.
            const open = this._openPresses?.has(`${selBtn.key}:${idx}`);
            // What the device falls back to when this press stores nothing of
            // its own -- the glyph the backend derives from the step's service
            // (`toggle.step_icon`) and the caption the heading above already
            // asks for. Computed once per row because both the preview and the
            // input now need them, and two copies of the expression is how
            // the box and the field it labels drift apart.
            const derivedIcon = this._getServiceIcon(rule.config?.[0]?.action || "", selEntity);
            const derivedLabel = this._pressDefaultLabel(
              rule,
              this._toggleRuleName(rule),
            );
            // The subject this press speaks about, which is its *own* target
            // and not the button's. A cycle exists because its steps differ,
            // often in what they point at, so reading every press's `${_state}`
            // off the button's declared action would phrase press 3 in terms
            // of press 1. `resolve_rule_label` in `toggle.py` answers the same
            // question the same way, and a synthetic action carrying the step's
            // service is what keeps them agreeing: a press has no action-library
            // entry the backend can see, so the step's service is the only
            // service both sides can read.
            const pressService = rule.config?.[0]?.action || "";
            const pressAction = { service: pressService };
            const pressEntity = this._getTargetEntityFromConfig(rule.config || []) || selEntity;
            // What the remote prints for this press right now, tokens read.
            const pressResolved = this._displayLabel(
              rule.label || "", pressAction, pressEntity, rule.config, rule,
            );
            // The same three lessons press 1's Tooltip offers, on the same
            // conditions. They used to be withheld here on the grounds that a
            // cycle step has no state to phrase -- but a step most certainly
            // does: `light.turn_on` produces "On" whatever the lamp is doing.
            // The tokens collapsed only because both backend producers passed
            // an empty value map, which is now fixed, so withholding the hint
            // would be hiding a feature that works.
            const pressShowsState = this._labelHasStateToken(rule.label || "")
              && !!this._displayLabel("${_state}", pressAction, pressEntity, rule.config);
            const pressShowsName = this._labelHasNameToken(rule.label || "")
              && !!this._displayLabel("${_name}", pressAction, pressEntity, rule.config);
            const pressShowsVariable = this._hasEntityToken(rule.label || "");
            // Same discovery rule as the Label field: the two track tokens are
            // only meaningful on a media player, so the press's own target
            // decides whether naming them is help or noise.
            const pressHasMedia = this._labelHasMediaToken(rule.label || "");
            const pressShowsMedia = pressHasMedia
              || (pressShowsState && this._targetsMediaPlayer(rule.config));
            const pressNowReads = (pressShowsState || pressShowsName || pressShowsVariable || pressShowsMedia)
              ? pressResolved
              : "";
            // <details> rather than a div with a click handler, and native
            // rather than `ha-expansion-panel`: it is the pattern the debug
            // view already uses here, it is keyboard- and screen-reader-
            // operable without a line of code, and a closed <details> keeps
            // its contents in the DOM -- which the icon picker needs, because
            // it is mounted into a slot inside a row that may be shut.
            return `
            <details class="press-appearance-row" data-press-idx="${idx}" ${open ? "open" : ""}>
              ${this._pressRowHeadHtml({
                idx,
                name: actionName,
                glyphHtml: this._configImagePreviewHtml(
                  this._resolveImageVariables(rule.icon || "") || "",
                  derivedIcon,
                  this._currentPageColor(),
                  PRESS_GLYPH_SHAPE,
                ),
              })}
              ${this._htmlIconField({
                // "Image", the same word press 1's field uses, and now said
                // only once -- `_htmlIconField` hands it to the picker, which
                // floats it inside the box, instead of also printing it above.
                label: this._t("image"),
                value: rule.icon || "",
                // What the device draws when the press names no icon of its
                // own: the backend derives the same glyph from the step's
                // service (`toggle.step_icon`). Left blank, the preview showed
                // the broken-image fallback, which reads as "no icon" when the
                // press in fact has a perfectly good one.
                autoIcon: derivedIcon,
                // Prefilled with the derived glyph when the press stores no
                // icon, which is what press 1's Image field has always done
                // (see the note at `_mountIconPicker` for the button's own
                // picker). It was left blank here, so the one field that was
                // meant to be press 1's twin was the one field that did not
                // behave like it: press 1 read `mdi:lightbulb-on` while an
                // untouched press read nothing, and the difference looked like
                // a press that had lost its icon rather than one inheriting.
                // Display only -- `_wireMediaInput` commits nothing until the
                // text differs from what the field was opened with -- so a
                // press that shows the derived glyph still stores no icon and
                // still follows the action if it is changed.
                inputValue: rule.icon || derivedIcon,
                color: this._currentPageColor(),
                slotAttrs: `data-toggle-idx="${idx}"`,
              })}
              ${this._htmlIconField({
                label: this._t("tooltip"),
                // The same field press 1's Tooltip is, down to the preview:
                // a tooltip takes any media source now, not just words, so a
                // press that wants a glyph for its caption can have one. It
                // was a bare text input left over from when a tooltip was
                // only text -- which meant no suggestions, no commit on
                // Enter, and no sight of what the remote would actually draw.
                //
                // The preview reads the tokens; the input keeps what was
                // typed. Resolved through the twin of the backend's
                // `clean_label_text(substitute_label_tokens(...))`, so the
                // preview and the device agree.
                // Falls back to the derived caption for the same reason the
                // Image field falls back to the derived glyph: blank, the
                // preview drew `mdi:image-off-outline` -- "nothing here" --
                // beside a field promising a name, while the device prints the
                // derived caption perfectly well.
                value: pressResolved || derivedLabel,
                inputValue: rule.label || derivedLabel,
                inputClass: "toggle-press-label",
                // What the device draws when this press names no tooltip:
                // the subject the step points at, read the same way press 1's
                // field reads it, with the service's name when there is no
                // subject to name. The heading above asks the same question
                // of the same helper, so an untouched press reads the same in
                // both places.
                // Still set, for the one case the prefill does not cover:
                // a user who clears the field is shown what clearing it buys
                // them rather than an empty box.
                placeholder: derivedLabel,
                color: this._currentPageColor(),
                shape: { size: "tooltip", box: { w: TITLE_PREVIEW_W, h: TOOLTIP_PREVIEW_H } },
                previewClass: "icon-preview-title",
                slotAttrs: `data-toggle-label-idx="${idx}"`,
                // Press 1's three lessons, chosen by the same ladder and in
                // the same order, so the two fields teach one syntax rather
                // than two dialects of it.
                hint: this._tokenHint(pressNowReads, {
                  state: pressShowsState,
                  name: pressShowsName,
                  variable: pressShowsVariable,
                  media: pressShowsMedia,
                }),
              })}
            </details>`;
          }).join("")}`
      : '';

    // The Label field, built here and handed to the header. It renders under a
    // context, on the same code path and at the same width, because a card that
    // is the same card should not grow and shrink depending on what is selected
    // elsewhere. What changes is whether it can be typed into, and only while
    // the override has no action of its own.
    //
    // That guard is not tidiness. A label written through the edit slot lands in
    // the override table, which makes the entry non-empty, which makes it win
    // over the page default, which then runs nothing because it has no action:
    // three clicks used to turn a fixed button off and label the face
    // "overridden" for it. The writers drop action-less overrides now, so the
    // damage is bounded — but the label would be dropped with them, silently,
    // which is a field that accepts a value and loses it. So it says what it
    // needs first.
    // Press 1's row heading, from the same pair the field below it is given:
    // the stored tooltip resolved, and the default it offers when blank. A
    // glyph caption is skipped -- it is drawn as the glyph, and a heading
    // reading `mdi:battery-50` is a filename read as a sentence.
    // What the remote prints, tokens read. A value that reads as nothing is
    // nothing -- not the field's raw `${…}` text drawn as a picture of words;
    // only a picture value (`mdi:…`) stands for itself.
    const labelPreview = labelFieldValue
      ? (this._resolveLabel(selAction, selEntity, selAssign.config, currentLabel, selAssign)
        || (this._isMediaSource?.(labelFieldValue) ? labelFieldValue : ""))
      : "";
    const pressOneTitle = (
      (labelFieldValue && !this._isMediaSource?.(labelFieldValue) ? labelPreview : "")
      || selDefault || pressTitles[0] || ""
    );
    const labelFieldHtml = labelIsDead ? '' : this._htmlIconField({
      label: this._t("tooltip"),
      // The preview draws what the remote prints, tokens read; the field
      // holds the stored text, tokens and all.
      value: labelPreview,
      inputValue: labelFieldValue,
      inputClass: "config-label-input",
      placeholder: selDefault,
      disabled: labelNeedsAction,
      color: this._currentPageColor(),
      shape: { size: "tooltip", box: { w: TITLE_PREVIEW_W, h: TOOLTIP_PREVIEW_H } },
      previewClass: "icon-preview-title",
      slotId: "config-label-slot",
      action: (!labelNeedsAction && currentLabel && currentLabel !== autoLabel)
        ? `<ha-icon-button class="config-label-reset" data-a11y-focus-after=".config-label-input" label="${this._esc(this._t("reset_tooltip"))}"><ha-icon icon="mdi:restore" aria-hidden="true"></ha-icon></ha-icon-button>`
        : '',
      hint: labelNeedsAction
        ? this._t("tooltip_needs_action")
        : this._tokenHint(labelResolved, {
          state: labelShowsState,
          name: labelShowsName,
          variable: labelShowsVariable,
          media: labelShowsMedia,
        }),
    });

    return `
      <ha-card outlined class="config-card">
        <h2 class="liza-sr-only">${this._esc(regionLabel)}</h2>
        ${this._htmlConfigCardHeader({
          subtitleHtml: cardKeyHtml,
          // One host, one question -- "what does this button look like?" -- with
          // two mutually exclusive answers. `showImageEditor` is defined as
          // `showImage && !hasStateIcons`, so exactly one of these is ever
          // non-empty and concatenating them cannot show both.
          //
          // Emitted unconditionally even when both are empty:
          // `_refreshButtonEntitySections` rebuilds it by assigning innerHTML,
          // which can empty a host that is there and cannot create one that is
          // not. Make this conditional and the field stops following the entity,
          // silently.
          appearanceHostHtml:
            `<div id="config-card-appearance">${imageFieldHtml}${stateIconsHtml}</div>`,
          labelFieldHtml,
          // A second host, after the Tooltip rather than inside the first.
          //
          // The press rows have to follow press 1's *pair* of fields, not sit
          // between them: a list of later presses wedged between the Image and
          // the Tooltip it comes after reads as though the Tooltip belongs to
          // the last press in the list. The Tooltip cannot simply move up into
          // the appearance host either -- see ENTITY_SECTION_HOST, it is a
          // sibling precisely so an entity change cannot discard a name typed
          // but not yet confirmed. So the list moves out instead.
          //
          // Still a refreshable host of its own, because each row's derived
          // glyph is resolved against the button's entity domain and that
          // entity is chosen inside the action editor. The press labels are
          // safe here where the Tooltip was not: they commit on `change`, so
          // they hold no pending state for a rebuild to throw away.
          //
          // Emitted unconditionally for the same reason as the other host: a
          // rebuild can empty a host that exists and cannot create one that
          // does not.
          pressListHtml: `<div id="config-card-presses">${pressAppearanceHtml}</div>`,
          // Press 1 as a row of the same list, numbered and collapsible like
          // the rest. It used to be a loose pair of fields above a list of
          // "later presses", which made the first step look like the button's
          // real appearance and the others like overrides of it. They are not:
          // each press is one step of a cycle, and after a reorder any of them
          // can be first. Equal rows say that; a heading saying "later" said
          // the opposite.
          //
          // Only the *heading* is passed. The fields stay where they are --
          // see the two hosts above -- and the header wraps them rather than
          // inlining them, so neither loses its identity or its refresh rules.
          pressSectionLabelHtml: showPressList
            ? `<label id="liza-press-appearance-label">${this._esc(this._t("toggle_press_appearance"))}</label>
               <span class="config-field-hint" id="liza-press-appearance-hint">${this._esc(this._t("toggle_press_appearance_hint"))}</span>`
            : "",
          pressRowOneHeadHtml: showPressList
            ? this._pressRowHeadHtml({
                idx: 0,
                // Press 1 cannot go through `_pressHeadings`: its tooltip is
                // stored on the assignment, not on its rule, so the rule it
                // would be read from is blank. Taken from the two values its
                // own Tooltip field is handed instead -- the resolved text,
                // then the placeholder -- which is what agreement between a
                // heading and the field under it actually means.
                name: pressOneTitle,
                glyphHtml: this._configImagePreviewHtml(
                  this._resolveImageVariables(imageVal) || "",
                  autoImageIcon,
                  this._currentPageColor(),
                  PRESS_GLYPH_SHAPE,
                ),
              })
            : "",
          pressRowOneOpen: !!this._openPresses?.has(`${selBtn.key}:0`),
        })}
        <div class="config-card-body">
          ${showLongtouch ? `<h3 class="action-editor-heading">${this._esc(this._t("click_action"))}</h3>` : ''}
          <div class="config-field action-field">
            <!-- The one thing the editor below cannot say about itself. Its
                 list normally means "do all of these"; on a grid button with
                 toggles on it means "do the next one each press". Said before
                 the list rather than after, because a user who adds a second
                 action expecting both to run has already been surprised by the
                 time they reach a line underneath. Only once there is an
                 action to add a second one to: on a blank button the sentence
                 describes nothing the user can see. -->
            ${isGridBtn(selBtn.key) && this._toggleFeatureEnabled?.() && selAssign.config?.length
              ? `<span class="config-field-hint">${this._esc(this._t("toggle_click_hint"))}${
                  // The nudge, only while there is nothing to cycle through.
                  // The sentence above describes the list at any length; this
                  // one is advice, and advice that stays on screen after it
                  // has been taken is how the line came to tell a button with
                  // three presses to add a second one.
                  pressRules.length > 1 ? "" : ` ${this._esc(this._t("toggle_click_hint_add"))}`
                }</span>` : ''}
            <div id="button-editor-container"></div>
          </div>
          ${this._htmlRepeatSwitch(selBtn, selAssign, editingOverride)}
          ${showLongtouch ? `
          <h3 class="action-editor-heading">${this._esc(this._t("longtouch_action"))}</h3>
          <div class="config-field action-field">
            <div id="button-longtouch-editor-container"></div>
          </div>` : ''}
          <!-- A device-local command whose target the device cannot resolve is
               sent disarmed. It belongs to the action, not to the button's
               appearance, so it stays in the body beside the action editor
               rather than following the Tooltip into the header editor. -->
          ${internalProblem ? `<div class="slider-warning">${this._esc(internalProblem)}</div>` : ''}
        </div>
      </ha-card>`;
  },


  // The icon the slider would show if nothing were stored — the same answer the
  // preview and the face give, so the picker cannot sit blank beside a glyph.
  //
  // Empty still means "derive it" on disk; this only decides what the *field*
  // displays, exactly as the state-icon pickers already preselect an action's
  // own state icon. Both scopes answer from their own control, which is what
  // makes the context card behave like the page card rather than like a
  // special case.
  /**
   * The icon a button's image field should *offer* when it stores none.
   *
   * Display only. The tile already draws this glyph via `_resolveButtonIcon`,
   * so showing it here just stops the field from claiming the button has no
   * icon. Nothing is written unless the user changes it — the media field
   * commits only a value that differs from the one it was opened with.
   *
   * A payload thumbnail is skipped: it is a URL, and this control is in icon
   * mode, so handing it over would blank the picker anyway.
   */
};
