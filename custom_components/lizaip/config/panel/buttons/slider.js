/**
 * lizaIP Panel — Buttons View: The slider block: its icon, its appearance target and the facts shown about it.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  hasOverride,
  controlsForEntity,
  matchControl,
  sliderSubjectEntity,
  sliderControlOverride,
  shownControl,
  sliderRetarget,
  SLIDER_VERTICAL_KEY,
  sliderFollows,
  pageSliderFollowsIn,
  SLIDER_ICON_HIDDEN_KEY,
  sliderIconFor,
} from "./shared.js";

export const ButtonsSliderMixin = {
  _autoIconForField(selKey) {
    const slider = this._sliderAutoIcon(selKey);
    if (slider || selKey === SLIDER_VERTICAL_KEY) return slider;
    const assign = this._editAssign(selKey) || this._assignments?.[selKey] || {};
    const action = assign.action_id
      ? this._actions.find(a => a.id === assign.action_id) || null
      : null;
    const icon = this._resolveButtonIcon(assign, action, "") || "";
    return this._isImageUrl(icon) ? "" : icon;
  },

  _sliderAutoIcon(selKey) {
    if (selKey !== SLIDER_VERTICAL_KEY) return "";
    const appr = this._sliderAppearanceTarget(selKey);
    if (appr?.scoped) {
      return this._sliderContextState(this._assignments || {})?.control?.icon || "";
    }
    return sliderIconFor(this._sliderControls, this._assignments?.[selKey] || {}) || "";
  },

  // Where an edit under the slider card's Appearance section lands, and under
  // which keys.
  //
  // One owner, because the answer has to be identical in four places — the Icon
  // preview, the Label field, the icon picker's write and the label input's
  // write — and a disagreement between the read and the write is exactly the
  // bug this feature was reported as: type in a field, watch a different record
  // change.
  //
  // The slider's appearance belongs to whoever is holding it. A context button
  // that retargets the slider is holding it, so it stores its own icon and
  // label under `slider_image` / `slider_name` — a fourth axis beside
  // the slider subject, the control name and `slider_factor`, and stored the same
  // way, on the grid button itself rather than in `overrides`. Nobody holding
  // it means the page does, which is the plain `image` / `name` on the slider's
  // own record and the only case that existed before.
  //
  // Null for every non-slider card: a grid button's own icon is not this
  // question and must keep going through `_editAssignEnsure` unchanged.

  _sliderAppearanceTarget(selKey) {
    if (selKey !== SLIDER_VERTICAL_KEY) return null;
    const ctx = this._liveContextKey();
    if (!ctx) return { key: selKey, imageKey: "image", nameKey: "label", hiddenKey: SLIDER_ICON_HIDDEN_KEY, scoped: false };
    // A live context owns the appearance whether or not it retargets. It used
    // to fall back to page scope when it did not, on the grounds that a
    // non-retargeting button leaves the slider showing the page's icon so a
    // per-button icon would store something invisible. True, but it made the
    // Appearance fields silently rewrite the page default while a button was
    // selected -- editing one thing while naming another, which is the exact
    // confusion the context scope exists to remove. Storing a value that only
    // renders once the button names a device is the lesser of the two.
    // The flag keeps its name in both scopes: it sits on a different record, and
    // one spelling means the read path cannot pick the wrong one.
    return { key: ctx, imageKey: "slider_image", nameKey: "slider_name", hiddenKey: SLIDER_ICON_HIDDEN_KEY, scoped: true };
  },

  // Whether the slider's icon is explicitly hidden, in whichever scope the
  // edit would land. One reader, so the picker, the preview and the face cannot
  // disagree -- the last time two of them disagreed about this field it took
  // three rounds of explaining the disagreement before anyone removed it.

  _sliderIconHidden(appr) {
    const rec = appr.scoped ? (this._assignments?.[appr.key] || {}) : (this._editAssign(appr.key) || {});
    return !!rec[appr.hiddenKey];
  },

  // The one place an icon edit is written, because "cleared" has to unset the
  // value *and* set the flag, and any call site that did only half of that
  // would resurrect either the derived glyph or the stale icon.

  _writeSliderIcon(appr, value) {
    const rec = appr.scoped
      ? (this._assignments[appr.key] || (this._assignments[appr.key] = {}))
      : this._editAssignEnsure(appr.key);
    if (value) {
      rec[appr.imageKey] = value;
      delete rec[appr.hiddenKey];
    } else {
      // Deleting rather than blanking: absence is the inherit spelling
      // everywhere else in this file, and the flag is what says otherwise.
      delete rec[appr.imageKey];
      rec[appr.hiddenKey] = true;
    }
    return rec;
  },

  // What the vertical slider does under the current context, or null when no
  // grid button is in context.
  //
  // One owner, because three call sites now need the same answer: the face's
  // icon, its configured/tint state, and `_faceMark`. The slider is the one
  // fixed control whose per-button config is *not* an `overrides` entry —
  // The control name / slider subject belong to the grid button itself —
  // so `_editAssign` cannot answer for it and this does instead.
  //
  // `sliderRetarget` is the predicate, unchanged and still the twin of
  // `_record_selection`'s gate, so the strip and the executor cannot disagree
  // about whether a button takes the slider.

  _sliderContextState(pageAssigns) {
    const ctx = this._liveContextKey();
    if (!ctx) return null;
    // Every slider on the page, not just the vertical one — the same reading the
    // card uses, because the selection is tracked per device rather than per
    // slider. A page that pins its slider cannot be retargeted by anything.
    //
    // Shared with the card rather than restated here. This line used to be its
    // own sweep and was missing the absent-slider term, which made a selected
    // grid button's icon and label edits land on the page record.
    const pageSliderFollows = pageSliderFollowsIn(pageAssigns);
    // Passed as lookups, not as a resolved entity and state: `sliderRetarget`
    // resolves the entity itself, because an explicit slider subject overrides
    // the one the button's action drives.
    return sliderRetarget({
      key: ctx,
      assign: pageAssigns?.[ctx],
      controls: this._sliderControls,
      entityFor: (cfg) => this._getTargetEntityFromConfig(cfg),
      stateFor: (e) => this._hass?.states?.[e],
      pageSliderFollows,
    });
  },

  // Which nesting mark, if any, the face should put on `key`.
  //
  // Since the read-only list came off the grid button's card, this is the *only*
  // thing that says which fixed controls are overridden — so it is the whole
  // affordance rather than half of it, and the reason it still asks
  // `hasOverride` / `sliderRetarget` rather than a rule of its own is that
  // those are what the executor's twins agree with.
  //
  // Returns null when no grid button is in context: without one, "overridden"
  // has nothing to be relative to, and a permanent mark would say the fixed
  // buttons are special even on pages that never nest anything.

  _sliderTipFacts(key, assign) {
    const sa = assign?.slider_actions || {};
    const follows = sliderFollows(key, assign);
    const stored = typeof sa.target_entity === "string" ? sa.target_entity.trim() : "";
    // With no default of its own it takes whatever the selected grid button
    // lends it, so the live context is the only thing that can name a device.
    let entity = stored;
    if (follows && !entity) {
      const ctx = this._liveContextKey?.();
      const ctxAssign = ctx ? (this._assignments?.[ctx] || null) : null;
      entity = ctxAssign ? (sliderSubjectEntity(ctxAssign) || "") : "";
    }
    const control = matchControl(this._sliderControls, sa);
    return { follows, entity, control: control?.label || "" };
  },

  // The other half: which device *this* grid button hands the slider. Through
  // `shownControl`, as the slider card itself does, so a stale stored id
  // resolves to the control a touch would really move.

  _buttonSliderOverride(assign) {
    const entity = sliderSubjectEntity(assign) || "";
    if (!entity) return { entity: "", control: "" };
    const available = controlsForEntity(
      this._sliderControls, entity, this._hass?.states?.[entity],
    );
    const control = shownControl(available, sliderControlOverride(assign));
    return { entity, control: control?.label || "" };
  },

  // Shared by the thumbnail's hover card and its accessible description.
  // Counts rather than a finished sentence, because the two word it
  // differently and neither is a reason for the other to recount the buttons.
};
