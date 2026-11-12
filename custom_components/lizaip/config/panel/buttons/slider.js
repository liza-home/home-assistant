/**
 * lizaIP Panel — Buttons View: The slider block: its icon and its appearance target.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  sliderRetarget,
  SLIDER_VERTICAL_KEY,
  pageSliderFollowsIn,
  SLIDER_ICON_HIDDEN_KEY,
  sliderIconFor,
  autoSliderSubject,
  sliderSubjectEntity,
  setSliderSubject,
} from "./shared.js";

export const ButtonsSliderMixin = {
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

  // The icon the slider would show if nothing were stored — the same answer the
  // preview and the face give, so the picker cannot sit blank beside a glyph.
  //
  // Empty still means "derive it" on disk; this only decides what the *field*
  // displays, exactly as the state-icon pickers already preselect an action's
  // own state icon. Both scopes answer from their own control, which is what
  // makes the context card behave like the page card rather than like a
  // special case.
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
  // it means the page does, which is the plain `icon` / `tooltip` on the slider's
  // own record and the only case that existed before.
  //
  // Null for every non-slider card: a grid button's own icon is not this
  // question and must keep going through `_editAssignEnsure` unchanged.

  _sliderAppearanceTarget(selKey) {
    if (selKey !== SLIDER_VERTICAL_KEY) return null;
    const ctx = this._liveContextKey();
    if (!ctx) return { key: selKey, iconKey: "icon", nameKey: "tooltip", hiddenKey: SLIDER_ICON_HIDDEN_KEY, scoped: false };
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
    return { key: ctx, iconKey: "slider_image", nameKey: "slider_name", hiddenKey: SLIDER_ICON_HIDDEN_KEY, scoped: true };
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
      rec[appr.iconKey] = value;
      delete rec[appr.hiddenKey];
    } else {
      // Deleting rather than blanking: absence is the inherit spelling
      // everywhere else in this file, and the flag is what says otherwise.
      delete rec[appr.iconKey];
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

  /** The grid button whose slider settings the card for *key* edits: the live
   * context when *key* is the vertical slider, else null. */
  _sliderCtxKey(key) {
    return (key === SLIDER_VERTICAL_KEY && this._liveContextKey()) || null;
  },

  /**
   * Opt a grid button into the page slider when its click action is a toggle
   * the slider can drive -- see `autoSliderSubject` for when, and why only then.
   * *prevConfig* is the button's click action before this edit.
   */
  _applyAutoSliderSubject(key, assign, prevConfig) {
    const service = this._stepService(assign.config || []);
    const entity = this._getTargetEntityFromConfig(assign.config || []) || "";
    const next = autoSliderSubject({
      key,
      assign,
      prevService: prevConfig ? this._stepService(prevConfig) : "",
      prevEntity: prevConfig ? (this._getTargetEntityFromConfig(prevConfig) || "") : "",
      service,
      entity,
      controls: this._sliderControls,
      stateObj: entity ? this._hass?.states?.[entity] : null,
      pageSliderFollows: pageSliderFollowsIn(this._assignments),
    });
    if (next === undefined) return;
    // A new device starts from its own first control: the old one's id is a
    // capability of the lamp it replaced.
    if (next !== sliderSubjectEntity(assign)) setSliderSubject(assign, undefined);
    if (next !== null) setSliderSubject(assign, next);
  },

  /** The page slider's stored sensitivity, 1.0 when it has none. */
  _pageSliderFactor() {
    const raw = this._assignments[SLIDER_VERTICAL_KEY]?.slider_actions?.factor;
    return typeof raw === "number" && isFinite(raw) ? raw : 1.0;
  },
};
