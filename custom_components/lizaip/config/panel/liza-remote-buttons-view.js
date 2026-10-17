/**
 * lizaIP Panel — Buttons View
 * HTML generation and wiring for the Buttons tab (pages, SVG, button config).
 */

import {
  drawSVG, getPathBounds, cropFace, overlayStyle, titleFit, armSuppress, suppressedNow,
} from "./liza-remote-svg.js";
import { badNumber, isMovableSlot, NON_BUTTON_KEYS } from "./liza-remote-helpers.js";

const capitalize = (s) => s.replace(/\b\w/g, c => c.toUpperCase());

// The only mode a `toggle` block has. Written explicitly rather than left out:
// `sanitize_toggle` refuses a block whose mode it does not recognise, which is
// what makes a block saved by the revision that also had a state mode go inert
// instead of being silently reread as a cycle.
const MODE_CYCLE = "cycle";

export const isGridBtn = (key) => /^button_\d+$/.test(key);
const isSliderBtn = (key) => /^slider_/.test(key);

// The page title's preview, in CSS pixels. Its 4:1 proportion is imgserv's
// named `title` size (200x50), not the 200x60 strip the device face draws:
// what the field previews is the *image*, and the band of empty pixels the
// device pads it with on either side is not part of it.
const TITLE_PREVIEW_H = 28;
const TITLE_PREVIEW_W = TITLE_PREVIEW_H * 4;
// The tooltip's, at the same width: imgserv's `tooltip` size is 200x40.
const TOOLTIP_PREVIEW_H = Math.round(TITLE_PREVIEW_W * 40 / 200);

// The thumbnail in a press row's heading. Explicit because the preview helper
// defaults to the 28px box a *field* gets, and that box is written inline --
// as `width`/`height` on an <img> and `--mdc-icon-size` on an <ha-icon> -- so
// a stylesheet cannot cut it down to heading size afterwards. Left to the
// default, a row drawing an icon and a row drawing a picture ended up
// different heights, which tilted the heading off the line the number and the
// chevron sit on and pushed one row's words up against its glyph.
const PRESS_GLYPH_SHAPE = { size: 20, box: { w: 20, h: 20 } };

// The fixed *buttons* whose press a grid button may override, mirroring
// `OVERRIDABLE_FIXED_BUTTONS` in action_controller/overrides.py. A Set rather
// than an array because every use of it is a membership test.
//
// Buttons, not controls: this is the set whose cards edit their whole record
// *nested inside* the grid button's `overrides` table, which is what
// `_editContainer` and `_editingOverride` are asking about.
//
// `slider_vertical` is therefore not here, on either side, even though it may
// appear in that table. Its own record — mode, factor, icon — stays on the
// page; what nests is a single string naming a *capability*, whose mechanics
// are resolved live from the touched entity because a stored blob would freeze
// them. Python spells that wider set `OVERRIDABLE_FIXED_KEYS`; the panel has no
// use for it, because no card routes on it.
export const OVERRIDABLE_FIXED_BUTTONS = new Set([
  "button_power",
  "button_volume_up",
  "button_volume_down",
  "button_back",
  "button_voice",
]);

// The six controls the face lights up and the card lists, in the order the card
// lists them: the three standalone buttons, then the rocker's three zones in
// the order they are physically stacked (+ / slide / −), so the list reads like
// the hardware looks.
//
// `slider_vertical` is the sixth. It is overridden through a different
// mechanism — a string, not a sub-assignment — but it is the same idea to a
// user, so it belongs in the same list. Spelled literally rather than through
// `SLIDER_VERTICAL_KEY`, which is declared further down this module and would
// still be in its temporal dead zone here.
//
// `slider_horizontal` stays out: it is the Page Settings card and has never
// been a button.
export const FIXED_CONTROL_KEYS = [
  "button_power",
  "button_back",
  "button_voice",
  "button_volume_up",
  "slider_vertical",
  "button_volume_down",
];

// Does *contextKey*'s button declare an override for *key*?
//
// **A presence test, and nothing else.** That is affordable only because the
// writers guarantee an empty override entry never reaches disk
// (`_sanitize_overrides`, `_strip_empty_fields`), so there is no `{}` for this
// to have an opinion about. Every previous attempt to keep the two languages
// agreeing on emptiness has cost a bug, because `{}` is falsy in Python and
// truthy in JS; the fix was to delete the question rather than answer it twice.
export const hasOverride = (assign, key) =>
  Object.hasOwn(assign?.overrides ?? {}, key);

// The glyphs the firmware prints on the fixed buttons. Panel-side only: they
// are what the face and the card list fall back to for a button carrying no
// icon of its own, and per PROTOCOL.md §12 they are also the only thing those
// buttons will ever show — an override changes what one does, never how it
// looks. Hoisted to module scope so the SVG refresh and the card list read one
// table rather than each carrying its own copy.
const DEFAULT_BUTTON_ICONS = {
  button_power: 'mdi:power',
  button_back: 'mdi:keyboard-backspace',
  button_voice: 'mdi:microphone',
  button_volume_up: 'mdi:plus',
  button_volume_down: 'mdi:minus',
};

// Slider mechanics are numbers, coerced on both the read (render) and write
// (input) paths — the renderer interpolates them straight into markup, so a
// hand-edited layout YAML or older stored value must not reach the DOM as an
// arbitrary string.
//
// Two traps this threads between:
//   - `parseFloat(v) || fallback` silently turns a legitimate 0 into the
//     fallback, which made "max: 0" impossible to type.
//   - `Number("")` is 0, not NaN, so a plain `Number.isFinite` check quietly
//     turns an emptied field into 0 instead of using the fallback — and a
//     factor of 0 is exactly the dead-slider case the backend clamps against.
// So: blank-ish inputs take the fallback, everything else must parse finite.
const num = (value, fallback) => {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// What a slider can control, modelled on Home Assistant's tile-card *features*
// (`light-brightness`, `fan-speed`, `cover-position`…). HA's own answer to
// "a slider that changes brightness" is `- type: light-brightness` — one key,
// no attribute/service/min/max, because those are implementation details the
// integration knows. We do the same: the user picks a capability, the table
// supplies the mechanics.
//
// The table itself is **not** declared here: it lives in `action_controller.py`
// (which explains why) and is fetched into `this._sliderControls`. Every helper
// below therefore takes the table as its first argument.

// A numeric attribute that is present and finite, else null.
const attrNum = (st, key) => {
  const v = Number(st?.attributes?.[key]);
  return Number.isFinite(v) ? v : null;
};

// Colour modes that mean "this lamp cannot be dimmed"; HA's own
// `supportsBrightness` is the negation of this set.
const UNDIMMABLE_COLOR_MODES = ["onoff", "unknown"];
const colorModes = (st) => st?.attributes?.supported_color_modes || [];

// Evaluate a capability descriptor — the JSON form of what used to be a
// predicate here. Mirrors `_matches` in action_controller.py: a null descriptor
// means the domain alone is enough, and anything unrecognised means *not*
// supported, since a wrong yes offers the user a control that does nothing.
const descriptorMatches = (descriptor, st) => {
  if (!descriptor) return true;
  if ("feature" in descriptor) {
    const features = st?.attributes?.supported_features;
    // Integer, not merely finite: `&` would coerce 4.5 to 4 and report a
    // capability the server then refuses to resolve (its `_matches` requires an
    // int). A picker offering a control the slider can't drive is the exact
    // drift this shared table exists to prevent.
    if (!Number.isInteger(features)) return false;
    return (features & descriptor.feature) !== 0;
  }
  if ("color_mode" in descriptor) return colorModes(st).includes(descriptor.color_mode);
  if (descriptor.dimmable) return colorModes(st).some(m => !UNDIMMABLE_COLOR_MODES.includes(m));
  return false;
};

// How an entity draws itself when it sets no icon of its own.
//
// A near-copy of the domain table `_getServiceIcon` reads from the yaml, and deliberately not shared
// with it. Panel modules are imported by plain relative path, and only the
// entry module carries the `?v=` cache-buster — which `panel.py` computes once
// behind a `_panel_registered` guard, so re-registration does not change it.
// A browser therefore routinely runs a fresh copy of one module against a
// cached copy of another, and a helper that has moved between them takes the
// whole config card down with `is not a function`. That is not hypothetical: it
// is what this very change did on its first deploy.
//
// So a module answers questions it can answer alone. The two tables also answer
// different questions — "what does calling this service look like" against
// "what does this device look like" — and are free to diverge.
const ENTITY_DOMAIN_ICONS = {
  light: "mdi:lightbulb", switch: "mdi:toggle-switch", cover: "mdi:window-shutter",
  lock: "mdi:lock", fan: "mdi:fan", media_player: "mdi:cast",
  climate: "mdi:thermostat", scene: "mdi:palette", script: "mdi:script",
  automation: "mdi:robot", remote: "mdi:remote", vacuum: "mdi:robot-vacuum",
  button: "mdi:gesture-tap-button",
};

// The entity's own icon, else its domain's default.
//
// No state-dependent icon (on/off variants): naming a device is a question
// about which device, not about what it is doing this second, and a chip that
// changed picture when a lamp switched off would look like it had changed
// meaning.
const entityIcon = (entityId, stateObj) => {
  const own = stateObj?.attributes?.icon;
  if (typeof own === "string" && own.trim()) return own.trim();
  return ENTITY_DOMAIN_ICONS[domainOf(entityId)] || "mdi:cog";
};

// Sensitivity bounds for the `<input type="number">`. These mirror
// `action_controller.SLIDER_FACTOR_MIN` / `_MAX`, which is where they are
// actually enforced — the attributes only feed the form-validity API and do not
// block a `change` event. Named here so both slider cards advertise the same
// range, rather than each carrying its own literal.
const FACTOR_MIN = 0.1;
const FACTOR_MAX = 5;

// The domains a slider can drive at all, derived rather than restated so a new
// entry in the table is offered by the entity picker automatically. An empty
// table (the fetch failed) yields null rather than [], because an empty
// includeDomains offers the user nothing at all — better an unfiltered picker
// than a dead one.
const sliderDomains = (controls) =>
  controls?.length ? [...new Set(controls.map(c => c.domain))] : null;

const domainOf = (entityId) => String(entityId || "").split(".")[0];

// Does this specific entity actually support the control? Domain alone is not
// enough: an xy-only lamp is a `light` but has no colour temperature, and
// writing `color_temp_kelvin` to it does nothing at all. HA gates each tile
// feature the same way (`supportsLightColorTempCardFeature` et al) so the
// picker can never offer something the device will silently ignore.
//
// `stateObj` optional: without it we cannot test capability, so fall back to
// the domain list rather than hiding everything (e.g. hass not ready yet).
const controlSupported = (control, stateObj) =>
  !stateObj || descriptorMatches(control.supported, stateObj);

const controlsForEntity = (controls, entityId, stateObj) => (controls || [])
  .filter(c => c.domain === domainOf(entityId) && controlSupported(c, stateObj));

// One field, one definition. The slider card renders the same three fields --
// Entity, Control, Sensitivity -- twice: once for the page, once for whichever
// grid button is selected. They differ only in where the value comes from and
// where an edit goes, never in what a field *is*.
//
// Writing the markup out twice is what let the two drift apart in the first
// place: the labels diverged (`Control` against `Controls`), the context copy
// grew a section heading the page had none of, and the copy referenced a
// variable that existed only in the original's scope -- `factor is not
// defined`, which took the whole card down for every button that retargets.
// Every one of those is a bug that cannot be written against a single builder
// taking finished strings.
//
// Finished strings, deliberately: no `this`, nothing to escape, nothing derived
// in here. Callers own their own data and this owns the shape.
// `control` arrives as a finished HTML string from one of several builders, so
// a `for` attribute cannot be written until we know what the control is called.
// Rather than thread an id through every builder, the first form control in the
// string is named here.
//
// Deterministic: every one of these strings is built in this file and opens
// with a plain tag. A picker slot or static text matches nothing and is left
// alone, correctly -- HA's pickers carry their label as a property.
let fieldUid = 0;
const FIRST_CONTROL = /^([\s\S]*?<(?:select|textarea|input)\b)([^>]*)(>[\s\S]*)$/;
const nameControl = (control, describedBy) => {
  const m = FIRST_CONTROL.exec(control || "");
  if (!m) return { control, id: "" };
  const [, head, attrs, tail] = m;
  // A control that already names itself keeps that name: the label still has
  // to point somewhere, and a second `id` would be invalid.
  const own = /\sid="([^"]*)"/.exec(attrs);
  const id = own ? own[1] : `liza-cf-${++fieldUid}`;
  const extra = (own ? "" : ` id="${id}"`)
    + (describedBy ? ` aria-describedby="${describedBy}"` : "");
  return { control: `${head}${extra}${attrs}${tail}`, id };
};

const configFieldHtml = ({ label, control, hint = "", action = "" }) => {
  // A hint is not decoration: "0.1 to 10" and "this field is ignored while a
  // page default applies" both change what a correct answer looks like, and
  // sighted users get them for free by looking down.
  const hintId = hint ? `liza-cf-hint-${++fieldUid}` : "";
  const named = nameControl(control, hintId);
  return `
        <div class="config-field">
          ${label ? `<label${named.id ? ` for="${named.id}"` : ""}>${label}</label>` : ""}
          ${action ? `<div class="config-label-row">${named.control}${action}</div>` : named.control}
          ${hint ? `<span class="config-field-hint" id="${hintId}">${hint}</span>` : ""}
        </div>`;
};

// A control is chosen from a list, or stated when the list has one entry. Both
// arms need that rule and both used to spell it out: a <select> whose only
// option is the one already selected looks operable and is not, and hiding it
// instead leaves nothing on the card to say a media player's slider means
// Volume. So the choice is between a select and a readout, never between a
// select and nothing.
const sliderControlFieldHtml = ({ useSelect, optionsHtml, activeLabel, selectClass, iconHtml }) =>
  useSelect
    ? `<select class="${selectClass}">${optionsHtml}</select>`
    : `<div class="slider-control-static">
             ${iconHtml}
             <span>${activeLabel}</span>
           </div>`;

// Which control (if any) the stored config currently expresses. Anything that
// doesn't line up exactly is "Custom" — the user hand-edited the advanced
// fields and we must not silently snap their values back to a preset.
const matchControl = (controls, sa) => (controls || []).find(c =>
  c.attribute === sa.attribute && c.service === sa.service && c.data_key === sa.data_key
) || null;

// The real range for this entity. HA reads these off the entity too
// (min_color_temp_kelvin, min_temp…) instead of assuming a global range — a
// lamp that only reaches 2200–4000 K would otherwise be sent values it clamps
// or rejects. `range_attrs` arrives as data for the same reason `supported`
// does: a function could not have crossed the wire.
const controlRange = (control, stateObj) => {
  const [loAttr, hiAttr] = control.range_attrs || [];
  const lo = loAttr ? attrNum(stateObj, loAttr) : null;
  const hi = hiAttr ? attrNum(stateObj, hiAttr) : null;
  return [lo ?? control.min, hi ?? control.max];
};

// The slider's own key does not hold a string. It holds a block — `{entity_id,
// control}` — because retargeting is two answers that have to travel together:
// *which device* this button hands the slider, and *which of that device's
// controls* it drives. They were two fields once, one of them top-level, and
// the pair kept coming apart: a save that kept one dropped the other, and the
// ✕ that cleared the device left an orphan control behind.
//
// `entity_id` is the opt-in and the only required half; `""` is a placeholder a
// dynamic refill re-points, and absence of the block means "leave the slider
// alone". `control` is optional, and **its absence is the spelling of "derive
// the first available one"**, which is why it is deleted rather than blanked.
//
// The key is spelled out rather than taken from `SLIDER_VERTICAL_KEY`: that
// constant is declared further down this module, and the temporal dead zone
// would make these throw for anything that runs during definition.
const sliderBlock = assign => {
  const value = assign?.overrides?.slider_vertical;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
};

const sliderSubjectEntity = assign => {
  const entity = sliderBlock(assign)?.entity_id;
  return typeof entity === "string" ? entity.trim() : null;
};

const sliderControlOverride = assign => {
  const control = sliderBlock(assign)?.control;
  return typeof control === "string" ? control.trim() : "";
};

// Writing the subject writes the whole block, because the control cannot
// outlive the device it is a capability of: dropping the subject drops the
// block entire, which is what stops a cleared button from keeping a control id
// for a retarget that no longer happens.
const setSliderSubject = (assign, entityId) => {
  if (!assign) return;
  if (typeof entityId === "string") {
    if (!assign.overrides) assign.overrides = {};
    const block = sliderBlock(assign) || {};
    block.entity_id = entityId;
    assign.overrides.slider_vertical = block;
    return;
  }
  if (!assign.overrides) return;
  delete assign.overrides.slider_vertical;
  if (!Object.keys(assign.overrides).length) delete assign.overrides;
};

// The control half alone. It is a no-op on a button that names no device, so a
// dropdown left over from a stale render cannot conjure a block back into life.
const setSliderControl = (assign, control) => {
  const block = sliderBlock(assign);
  if (!block) return;
  if (control) block.control = control;
  else delete block.control;
};

// The control a button will actually drive when it retargets the slider: the
// stored `overrides.slider_vertical` when the entity still supports it, else the
// derived first entry. Named rather than inlined because several places need
// the same answer — the button's own select and the dead-slider warning among
// them — and copies of a fallback rule are chances to disagree about what a
// touch does.
//
// The stale-id fallback is not a nicety here. `resolve_control` warns and falls
// back to `controls[0]` for an id the entity cannot do, so anything that showed
// the stored id instead would report a control the device will never be sent.
const shownControl = (available, storedId) =>
  available.find(c => c.id === storedId) || available[0] || null;

// There used to be a `retargeters` walker here: it swept the page's buttons and
// returned the roster that drives this slider, so the card could print
// "Retargeted by: Lamp (Brightness), Fan (Speed)". The roster is gone — it grew
// with the page, restated what each of those buttons already says on its own
// card, and answered a question nobody asks from the slider's card — and with
// its only caller went the walk itself. What survives is `sliderRetarget`
// below, the single predicate it delegated to, which the button cards and the
// face highlight still ask one button at a time.

// Which entity a button retargets the slider to, and whether it said so itself.
//
// Two spellings, one answer. The slider block's `entity_id` names a device
// outright; absence falls back to whatever the button's own action drives,
// which is the ordinary case and stays spelled by saying nothing at all.
//
// The distinction is returned rather than collapsed because the two are not
// filtered alike: a derived entity has to prove it can drive something, an
// explicit one does not. See `sliderRetarget`.
const effectiveSliderEntity = (assign, entityFor) => {
  const explicit = sliderSubjectEntity(assign) || "";
  if (explicit) return { entity: explicit, explicit: true };
  const derived = assign?.config ? (entityFor(assign.config) || "") : "";
  return { entity: derived || "", explicit: false };
};

// Does this button retarget the page's slider, and to what?
//
// **The one predicate, used by the slider card's own settings and by the face
// highlight**, so there is no second copy to drift — the mistake that has cost
// this branch three bugs. `retargeters` used to walk the assignments with its
// own inline copy of these three tests; it calls this now, which is what the
// paragraph above always claimed.
//
// It is emphatically *not* "does the button name a control", even now
// that retargeting is opt-in and the two are usually written together. That key
// answers *which* control, and **its absence is the spelling of "derive the
// first available one"** -- so reading it as the opt-in would give one field two
// axes, and choosing the derived entry in the dropdown (which deletes the key)
// would silently switch retargeting off. One axis per field, and there is only
// one axis left: the block's `entity_id`, "which device", absent by default. There was
// briefly a second, a `slider_select` flag meaning "retarget at all"; two fields
// for one question is what made an empty picker mean two different things, so
// naming the device is now the whole opt-in.
//
// Naming one is opt-*in*: absence means the button leaves the slider alone. It
// used to mean the opposite, and the inversion was asked for on exactly the
// grounds this file keeps arguing from -- a slider that silently re-pointed
// itself at whatever you last touched was invisible until it surprised you.
// Made explicit, the entity picker on the slider's card is where the behaviour
// is declared, and a layout that wants it says so in YAML.
//
// `applies` is the visibility question -- may this card offer the switch at all
// -- and it deliberately no longer asks whether the button's device can drive
// anything. It used to, and that was the dead end: a button whose action targets
// a `switch` derived no slider-capable entity, so the card rendered an empty
// body and there was no way on screen to say "use that lamp instead". Offering
// the switch and the entity picker is the way out, so visibility cannot depend
// on the answer the picker exists to change.
//
// `retargets` stays narrow, and mirrors `_record_selection` line for line: an
// explicit entity is honoured whether or not it can drive anything, a derived
// one has to earn it. Widening it to match `applies` would mark the face for
// buttons the executor ignores -- lesson 3, in its usual costume.
const sliderRetarget = (
  { key, assign, entityFor, controls, stateFor, pageSliderFollows },
) => {
  const applies = !!pageSliderFollows && !isSliderBtn(key);
  const { entity, explicit } = effectiveSliderEntity(assign, entityFor);
  const stateObj = entity ? stateFor(entity) : null;
  const available = (applies && entity)
    ? controlsForEntity(controls, entity, stateObj) : [];
  // The Python twin of `_record_selection`'s gate. Naming a device is the
  // opt-in -- a grid button's slider config is an override of the page's, the
  // same shape its fixed-button overrides already have, so presence is the
  // whole axis. A stored `slider_select` says nothing here: it is the layout
  // dialect's spelling and `generate_assignments` resolves it into the
  // block's `entity_id` before anything stores it.
  //
  // Deliberately just these two terms. This used to also test `!!entity` and
  // `available.length > 0`, from when a derived entity could qualify; both are
  // now dead -- `effectiveSliderEntity` only reports `explicit` for a non-empty
  // trimmed string, so `explicit` implies an entity, and the derived disjunct
  // can never decide anything. Left in, they read as if a button with no
  // slider subject might still retarget, which is the one thing this predicate
  // exists to deny. `available` is still computed above, for the control picker.
  const retargets = applies && explicit;
  return {
    applies,
    available,
    entity,
    explicit,
    retargets,
    // What a touch will actually drive: the stored id when the entity supports
    // it, else the derived first control — the same answer `resolve_control`
    // gives a stale id, and the same one the card shows 20px below.
    control: retargets ? shownControl(available, sliderControlOverride(assign)) : null,
  };
};

const applyControl = (sa, control, stateObj) => {
  const [lo, hi] = controlRange(control, stateObj);
  sa.attribute = control.attribute;
  sa.service = control.service;
  sa.data_key = control.data_key;
  sa.min = lo;
  sa.max = hi;
};

// The strip that only ever slides, mirroring the backend's
// `SLIDER_VERTICAL_KEY`: an unconfigured one follows the selection rather than
// doing nothing. `slider_horizontal` gets no such reading.
const SLIDER_VERTICAL_KEY = "slider_vertical";

// A slider's target is a separate question from its mechanic: `mode` says how a
// drag behaves, `target` says what it lands on. These name the derived targets,
// mirroring the backend's `SLIDER_TARGET_*` so the two cannot drift; neither is
// ever stored. "Lands on whatever was last touched"…
const SLIDER_TARGET_LAST_TOUCHED = "last_touched";
// …and the same with an entity to drive until something is touched, differing
// only by whether the "Default entity" field is filled.
const SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY = "last_touched_or_entity";
// The one target that does *not* follow. Unspellable from this panel by design
// — there is no Target row to write it — but honoured everywhere, so a
// hand-written page YAML can still pin a slider that must never move.
const SLIDER_TARGET_ENTITY = "entity";
// What a stored config targets, mirroring the backend's `_effective_target`:
// with no `target` key, following, with the stored entity as the default when
// there is one. `entity` is the only stored target; anything else targets
// nothing.
const effectiveTarget = (sa) => {
  if (!sa || typeof sa !== "object") return null;
  if (sa.target) return sa.target === SLIDER_TARGET_ENTITY ? SLIDER_TARGET_ENTITY : null;
  if (sa.mode !== "proportional") return null;
  return sa.target_entity ? SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY : SLIDER_TARGET_LAST_TOUCHED;
};
// Does this slider land on whatever was last touched, with nothing to fall back
// to? Derived rather than a `sa.target ===` test, so it stays true of the bare
// blob the panel now writes for it.
const targetsLastTouched = (sa) => effectiveTarget(sa) === SLIDER_TARGET_LAST_TOUCHED;
// Does this slider follow what you touch? Both following targets qualify, and
// so does anything `effectiveTarget` resolves to one of them — the panel's copy
// of the backend's `follows_selection`.
const followsSelection = (sa) => {
  const target = effectiveTarget(sa);
  return target === SLIDER_TARGET_LAST_TOUCHED
    || target === SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY;
};
// Does the strip *key* drive whatever the grid last selected? The panel's copy
// of the backend's `slider_follows`, and the single owner of this branch's
// central rule: an absent or empty vertical-slider config means "follow the
// selection". Both halves are needed — absence has no config to inspect, so the
// answer comes from which strip is asking — and both readers below go through
// here rather than restating it, because a second copy of this rule is what
// shipped the last two bugs.
//
// Scoped to `slider_vertical` deliberately, matching the backend: the executor
// routes every slider name with no key filter, so an unscoped reading would
// give `slider_horizontal` (Page Settings) a live grip on the selection.
//
// **Emptiness, not truthiness.** The backend's test is `not slider_cfg`, and an
// empty dict is falsy in Python but *truthy* in JS. Transliterating it as `!sa`
// would read `{}` — exactly what `ensureSliderActions` scaffolds before any
// field is set — as *not* following while the executor follows it, which is the
// split this predicate exists to close. Anything with keys is a real config and
// is read as one, including an unknown `mode`: dead on both sides, which is what
// `followsSelection` then says.
// Exported solely so `tests/js/parity.test.mjs` can run it against the same
// case table as its Python twin. Nothing else imports it; the rule is still
// owned here.
export const sliderFollows = (key, assign) => {
  const sa = assign?.slider_actions;
  if (!sa || typeof sa !== "object" || Object.keys(sa).length === 0) {
    return key === SLIDER_VERTICAL_KEY;
  }
  return followsSelection(sa);
};

// Does *any* slider on this page follow the selection, so that a grid button's
// choice can mean anything at all?
//
// **One owner.** This was written twice, and the two copies disagreed for the
// whole life of the branch: the card's copy carried the `slider_vertical` term
// below, `_sliderContextState`'s copy did not. The consequence was invisible
// and exactly backwards — on a page whose slider is *absent*, which is the
// spelling every layout preset uses, `retargets` came back false, so the icon
// and label edited under a selected grid button silently landed on the page's
// own slider record instead of the button's.
//
// The `Object.entries` sweep cannot see a key that is not there, so the first
// term is not a shortcut for it. Absence is the spelling of "follows" for the
// vertical slider, and a sweep over stored entries is structurally unable to
// observe an absence. Any rewrite that drops the first line reintroduces the
// bug in full.
const pageSliderFollowsIn = (assigns) => {
  const all = assigns || {};
  // An unconfigured vertical slider follows the selection — including one with
  // no assignment at all, which is how a layout that declares no slider gets
  // here. `sliderFollows` owns that rule for both languages.
  if (sliderFollows(SLIDER_VERTICAL_KEY, all[SLIDER_VERTICAL_KEY])) return true;
  // Every other slider on the page, because the selection is tracked per device
  // rather than per slider, so any following slider makes the button's choice
  // meaningful. `slider_horizontal` is not configurable in this panel, but it
  // is still a real key in storage.
  return Object.entries(all).some(
    ([key, assign]) => isSliderBtn(key) && sliderFollows(key, assign),
  );
};
// A slider in proportional mode has no `action_id` by design, so every
// action_id-keyed code path (icon lookup, configured state, tint) used to treat
// a fully-configured slider as empty — it rendered blank on the remote face.
// Its identity comes from the *control* it drives, exactly as an HA tile
// feature carries its own icon rather than borrowing one from `tap_action`.
// "No icon at all", as opposed to "nothing stored, so derive one".
//
// Three states need three spellings. Absence means derive — the idiom every
// slider axis on a grid button uses — which left no way to say the slider
// should show *nothing* when a control was there to derive from: clearing the
// field deleted the key, the derived glyph came straight back, and the icon was
// undeletable. That is only visible once the field preselects the derived value,
// which is why it went unnoticed while the field sat blank and lying.
//
// A separate flag rather than a sentinel value, because the three values are
// not all the same kind of thing: two are icons and one is a statement about
// icons.
//
// Note what the field can actually *reach*, which is not the same as what it
// can hold. The picker has two gestures -- pick and clear -- and they reach
// "this icon" and "no icon". The derived glyph is the starting state, not a
// third destination: nothing returns to it once either gesture has been used.
// That is deliberate and matches every other icon field here, where getting an
// icon back means picking one. A control for it was tried and removed, so if
// this reads like a missing feature, see `a slider icon does not return to the
// derived glyph` in tests/js/context-config.test.mjs before adding one.
//
// Storing the third *in* `image` was tried and was a real bug --
// `isConfigured` reads `image`, so clearing the icon on an untouched slider
// made it paint as configured, which is the regression 44a7bc6 fixed. The
// argument for safety was that a derived icon implies `slider_actions.mode`,
// which `isConfigured` already accepts; true, but clearing is offered on
// sliders with no mode, so the precondition did not hold where it mattered.
//
// The general rule, which this file has now paid for twice: never dress a
// statement about a field up as a value of that field. `image` is read by
// `isConfigured`, by `device_sync`'s `resolve_icon_url`, and by the face; a
// magic string there is a string every one of them must be taught.
const SLIDER_ICON_HIDDEN_KEY = "slider_hide_icon";

// The icon a slider actually shows, given what is stored and what it would
// derive. One owner, because the card's preview, the card's picker and the face
// must not answer it differently — the last time two of them disagreed, the
// answer was three rounds of explaining the disagreement instead of removing it.
const resolveSliderIcon = (stored, auto, hidden = false) => {
  if (hidden) return "";
  if (typeof stored === "string" && stored.trim()) return stored;
  return auto || "";
};

const sliderIconFor = (controls, assign) => {
  const sa = assign?.slider_actions;
  if (!sa || typeof sa !== "object") return "";
  if (sa.mode !== "proportional") return "";
  // A last-touched slider has no fixed control to borrow an icon from — what it
  // drives is decided on the device, at the moment of the touch. So it draws
  // *nothing*.
  //
  // There used to be a generic "tune" glyph here, on the reasoning that it was
  // the honest answer for an unknowable target. It was the wrong kind of honest:
  // a user who has cleared every icon on the page still saw one, on the one
  // control they never gave an icon to, with no field anywhere that would turn
  // it off. An empty strip says "nothing is set here", which is true and is what
  // every other unconfigured control on this face already says.
  //
  // A slider with a page default does have a control, and its icon is shown
  // below — that is derived config, not a fallback. It cannot track the
  // selection either — the panel has no idea what the device currently has
  // selected — and it could not show it on the remote if it did: the protocol's
  // `set_page` carries only `page_id`, `hash`, `img_title` and `buttons[]`, and
  // `device_sync` drops every `slider_*` key from that array because sliders
  // are not buttons. Every slider icon here is panel decoration.
  if (targetsLastTouched(sa)) return "";
  return matchControl(controls, sa)?.icon || "";
};

// "Configured" for a slider means stored mechanics. `slider_actions` is checked
// through `.mode` because the editor scaffolds a bare {} before any field is
// set, and an empty object is truthy in JS — every other gate
// (store._is_empty_button, _isButtonAssigned, the WS sanitiser) requires a
// mode, so this one has to agree or a half-built slider renders as configured
// and then vanishes on save.
//
// An unconfigured `slider_vertical` still drives: it follows the selection.
// That is not this gate's business — it reports what the strip stores, and a
// following slider stores nothing. The remote face asks this same question, for
// the reasons below.
export const isConfigured = (assign) => !!(assign?.action_id || assign?.slider_actions?.mode || assign?.image
  || assign?.longtouch?.length);

// The face paints from `isConfigured`, i.e. from what a control *stores*, and
// every control on it is read the same way. This is worth a note because it was
// briefly otherwise.
//
// There used to be an `isDriving = isConfigured || sliderFollows` here, wired
// into the SVG's `hasAction`, so the face asked "does this strip *do*
// something?" instead. The motivation was real — a following slider stores
// nothing while genuinely dimming a lamp — but `sliderFollows` is true only for
// `slider_vertical`, so the practical effect was that one control, and only
// that one, took the `[configured]` fill on an otherwise blank page. It read as
// "already set up" and was the loudest thing on the face while being the least
// configured.
//
// The reason it can go back is that `[empty]` never meant "dead". It means
// "nothing stored here, so the device does its own thing": `button_back` with no
// assignment is painted empty and still goes back, the volume caps are painted
// empty and still change volume. A slider that follows the selection is the
// same category, and saying so in the same visual language is what makes the
// face legible. The behaviour it has instead of an assignment is spelled out in
// words on the slider's own config card, which is where it can be read.
//
// So one gate now, shared with `filledCount` below, with `_isButtonAssigned`,
// `store._is_empty_button` and the WS sanitiser. `sliderFollows` keeps
// answering what the strip *does*, for the places that need that.

// There is no "is this strip a slider?" row, and the vertical slider is always
// a slider. It briefly offered two behaviours — drag a value, or fire one
// action per press — which the hardware makes incoherent: `slider_vertical` is
// a pill spanning y=238..309 in the blueprint, and `button_volume_up` /
// `button_volume_down` are circles centred on its two ends, drawn AFTER it so
// they take the taps there. The three are one physical rocker: ends press,
// middle slides. "Fire one action per press" therefore gave the middle of a
// rocker a third, unrelated tap behaviour while its own caps kept theirs.
//
// This is the argument that already retired "step" mode, one step further:
// a step slider duplicated the dedicated +/- buttons, and a single-action
// slider duplicates those same two buttons — which are not merely nearby but
// are that slider's own end caps. `slider_horizontal` is filtered out of the
// button list entirely (it is Page Settings), so the row only ever rendered
// for `slider_vertical`: the one strip where it could not make sense.

/**
 * Where a link drawn from `fromX,fromY` should stop on `rect`: the point on the
 * rectangle's border that faces the source.
 *
 * Aimed at the border rather than the centre so the arrowhead lands *on* the
 * page card instead of in the middle of its drawn face, where it would sit on
 * top of the very thumbnail it is pointing out. Every coordinate here is in the
 * overlay's own space; the caller converts.
 *
 * The scale is the smaller of "how far until the x offset reaches the half
 * width" and the same for y, which is the side the ray leaves through — the
 * standard ray/axis-aligned-box intersection, written out because the two
 * degenerate cases need naming: a source level with the centre has `dy === 0`
 * and must not divide by it, and a source *at* the centre (a page linking to
 * itself, with the button over the card's middle) has no direction at all.
 */
export function gotoLinkEnd(rect, fromX, fromY) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = cx - fromX;
  const dy = cy - fromY;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? (rect.width / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (rect.height / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx - dx * s, y: cy - dy * s };
}

/**
 * The `d` of the link itself: a single quadratic arc from source to target.
 *
 * Bowed rather than straight because the two ends are usually on the same
 * horizontal line — the strip is one row — and a straight line between them
 * would run along the row's axis and through whatever thumbnails sit between.
 * The arc lifts it clear of them and makes which end is which readable at a
 * glance.
 *
 * The bow is always to the same side of the travel direction (the left normal),
 * so two links drawn from neighbouring buttons stay parallel instead of
 * crossing. It grows with the distance but caps, because a link spanning the
 * whole strip does not need a proportionally huge detour — past a point the
 * curve would leave the card entirely, which `overflow: hidden` would then cut.
 *
 * Rounded to a tenth of a pixel: these strings are compared against what is
 * already on screen to decide whether to touch the DOM, and raw float noise
 * from `getBoundingClientRect` would make every comparison differ.
 */
export function gotoLinkPath(x1, y1, x2, y2) {
  const r = (n) => Math.round(n * 10) / 10;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!len) return `M${r(x1)},${r(y1)}`;
  const bow = Math.min(44, len * 0.2);
  const cx = (x1 + x2) / 2 + (-dy / len) * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * bow;
  return `M${r(x1)},${r(y1)} Q${r(cx)},${r(cy)} ${r(x2)},${r(y2)}`;
}

export const ButtonsViewMixin = {
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
      const filledCount = allBtnKeys.filter(k => isConfigured(pageAssigns[k])).length;

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
      // stable `data-page-id` instead (see dataAttrs in liza-remote-a11y.js).
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

    // Icon-tint swatches, served from imgserv's COLOR_NAMES (lizaip_config/get_palette)
    // rather than hardcoded here: the hex a user clicks is stored as the page's
    // default_color and handed straight back to imgserv as `?fg=`, so the two lists
    // drifting apart would mean the panel offering colours the renderer never uses.
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
            <button class="ps-reorder-btn ps-move-up" ${canMoveUp ? '' : 'disabled'} title="${this._esc(this._t("move_left"))}" aria-label="${this._esc(this._t("move_left"))}">
              <ha-icon icon="mdi:arrow-left" style="--mdc-icon-size:18px;" aria-hidden="true"></ha-icon>
            </button>
            <button class="ps-reorder-btn ps-move-down" ${canMoveDown ? '' : 'disabled'} title="${this._esc(this._t("move_right"))}" aria-label="${this._esc(this._t("move_right"))}">
              <ha-icon icon="mdi:arrow-right" style="--mdc-icon-size:18px;" aria-hidden="true"></ha-icon>
            </button>
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
    const colorSectionHtml = this._pageTitleSelected ? '' : `
          <div class="ps-section" style="margin-top:0;padding-top:0;border-top:none;">
            <h2 class="ps-section-title" title="${this._esc(this._t("tints_icons"))}">
              <ha-icon icon="mdi:palette" style="--mdc-icon-size:16px;"></ha-icon> ${this._t("icon_color")}
            </h2>
            <div class="ps-color-presets">${swatchesHtml}</div>
            <div class="ps-color-row">
              <input type="color" class="ps-color-native" id="psColorNative" value="${pageDefaultColor ? '#' + pageDefaultColor : '#' + defaultHex}" aria-label="${this._esc(this._t("pick_custom_color"))}" title="${this._esc(this._t("pick_custom_color"))}" />
              <input type="text" class="ps-color-input" id="psColorInput" value="${pageDefaultColor ? '#' + pageDefaultColor : ''}" aria-label="${this._esc(this._t("color_hex"))}" placeholder="#hex" />
              ${pageDefaultColor ? `<button class="ps-color-clear" id="psColorClear" title="${this._esc(this._t("clear_color"))}" aria-label="${this._esc(this._t("clear_color"))}"><ha-icon icon="mdi:close" style="--mdc-icon-size:14px" aria-hidden="true"></ha-icon></button>` : ''}
            </div>
          </div>`;

    // A page made from a layout drives one device (or hub); naming it here, as
    // the button that changes it, answers "what does this page control" without
    // a trip through the page strip's context menu.
    const layoutTargetHtml = this._pageTitleSelected || !page.layout?.type ? '' : (() => {
      const hub = !!page.layout.target?.config_entry;
      const name = this._layoutTargetName(page);
      const changeLabel = this._t(hub ? "change_hub" : "change_device");
      return `
          <div class="ps-section ps-layout-target" style="margin-top:0;padding-top:0;border-top:none;">
            <h2 class="ps-section-title">
              <ha-icon icon="${hub ? "mdi:hub" : "mdi:devices"}" style="--mdc-icon-size:16px;" aria-hidden="true"></ha-icon> ${this._t(hub ? "layout_hub" : "layout_device")}
            </h2>
            <button class="ps-layout-target-btn" id="psLayoutTarget" title="${this._esc(changeLabel)}" aria-label="${this._esc(`${changeLabel} ${name}`)}">
              <span class="ps-layout-target-name">${this._esc(name)}</span>
              <ha-icon icon="mdi:pencil" style="--mdc-icon-size:16px;" aria-hidden="true"></ha-icon>
            </button>
          </div>`;
    })();

    return `
      <ha-card outlined class="config-card">
        <h2 class="liza-sr-only">${this._esc(this._t("a11y_page_region"))}</h2>
        ${bannerHtml}
        <div class="config-card-body ps-body">
          ${titleEditorHtml}
          ${layoutTargetHtml}
          ${colorSectionHtml}

          </div>
        </div>
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
           <button class="ctx-page-default" title="${this._esc(this._t("edit_page_default_title"))}">${this._t("page_default")}</button>
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
    // with no assignment at all, which is how a layout that declares no slider
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
      // config matches no preset, and a <select> with nothing selected shows
      // its first option — silently claiming e.g. "Brightness". A disabled
      // placeholder states the truth without offering a dead choice.
      const controlOptionsHtml = [
        activeControl ? "" : `<option value="" disabled selected>${this._t("set_under_advanced")}</option>`,
        ...options.map(c =>
          `<option value="${c.id}" ${activeControl === c ? "selected" : ""}>${this._esc(c.label)}</option>`),
      ].join("");
      // Most domains expose exactly one control — media_player, fan, number,
      // climate and humidifier all have a single entry in the table. A
      // <select> whose only option is the one already chosen looks operable and
      // is not, so show the choice as a fact instead. The select returns as soon
      // as there is genuinely something to choose between.
      const controlFieldHtml = sliderControlFieldHtml({
        useSelect: !(options.length === 1 && activeControl),
        optionsHtml: controlOptionsHtml,
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
        ? `<select class="slider-attribute-input">
             ${[...new Set([...Object.keys(liveAttrs), attribute].filter(Boolean))].sort()
               .map(k => `<option value="${this._esc(k)}" ${k === attribute ? "selected" : ""}>${this._esc(k)}</option>`)
               .join("")}
           </select>`
        : `<input type="text" class="slider-attribute-input" value="${this._esc(attribute)}" placeholder="volume_level" />`;

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
            <button class="slider-ctx-use-default" data-entity="${this._esc(sliderCtx.derived)}">${this._t("use_for_slider")}</button>
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
            <div>
              <label for="liza-slider-min">${this._t("range_min")}</label>
              <input type="number" id="liza-slider-min" class="slider-min-input" value="${valMin}" step="0.01" />
            </div>
            <div>
              <label for="liza-slider-max">${this._t("range_max")}</label>
              <input type="number" id="liza-slider-max" class="slider-max-input" value="${valMax}" step="0.01" />
            </div>
          </div>
          <span class="config-field-hint">${this._t("slider_range_hint")}</span>
          <div class="config-section-divider"></div>
          ${configFieldHtml({ label: this._t("attribute"), control: attributeFieldHtml })}
          ${configFieldHtml({
            label: this._t("service"),
            control: `<input type="text" class="slider-service-input" value="${this._esc(service)}" placeholder="media_player.volume_set" />`,
          })}
          ${configFieldHtml({
            label: this._t("data_key"),
            control: `<input type="text" class="slider-datakey-input" value="${this._esc(dataKey)}" placeholder="volume_level" />`,
          })}
          <span class="config-field-hint">${this._t("slider_plumbing_hint")}</span>
          ${resetTarget ? `<button class="btn-test-config slider-reset-control" data-control="${resetTarget.id}">${this._esc(this._t("reset_control_defaults", { control: resetTarget.label }))}</button>` : ""}
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
                 comment. Same trap as liza-remote-styles.js. -->
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
              control: `<input type="number" class="slider-factor-input" value="${factor}" step="0.1" min="${FACTOR_MIN}" max="${FACTOR_MAX}" />`,
              action: sliderCtx?.factorOverridden
                ? `<button class="slider-factor-reset" title="${this._esc(this._t("slider_use_page_factor", { value: sliderCtx.pageFactor }))}" aria-label="${this._esc(this._t("slider_use_page_factor", { value: sliderCtx.pageFactor }))}"><span aria-hidden="true">↺</span></button>`
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
    // Android TV `Home` button (stored "Home", printed "Wohnzimmer Home") could
    // turn into "Wohnzimmer Send Command" on the remote. The input holds the
    // stored text verbatim; `_resolveLabel` says what the remote makes of it.
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
    const rawLabel = (storedIsPlaceholder ? autoLabel : currentLabel) || autoLabel || "";
    // What the remote adds in front of the field's text. Joined into the field
    // below rather than stored, so the field reads exactly as the remote does
    // while `assign.label` stays short and keeps re-deriving from the entity.
    // The write below only fires on a keystroke, so a field the user never
    // touches never freezes the prefix into storage.
    const labelPrefix = this._labelPrefix(selAction, selEntity, selAssign.config, rawLabel, selAssign);
    const labelFieldValue = [labelPrefix, rawLabel].filter(Boolean).join(" ");
    // The hint under the field explains a placeholder, so it is only shown when
    // the field actually holds one that resolves. "Wohnzimmer Home" is a plain
    // name and has nothing to explain.
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
    // But "Unnamed Room ${_state}" is not a tooltip anyone recognises, and the
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
      ? this._resolveLabel(selAction, selEntity, selAssign.config, rawLabel, selAssign)
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
      ? (this._resolveLabel(selAction, selEntity, selAssign.config, rawLabel, selAssign)
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
        ? `<button class="config-label-reset" data-a11y-focus-after=".config-label-input" title="${this._esc(this._t("reset_tooltip"))}" aria-label="${this._esc(this._t("reset_tooltip"))}"><span aria-hidden="true">↺</span></button>`
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
  _faceMark(key, pageAssigns) {
    // An armed move outranks the nesting marks, and is the one mark that shows
    // with nothing in context. It answers a question the user is holding right
    // now — "which button am I moving?" — while the nesting marks describe a
    // standing arrangement, and the two cannot both be read off one tile.
    if (this._moveSourceKey) return key === this._moveSourceKey ? "moving" : null;
    // The *live* context, not the stored one: a button whose action has been
    // cleared is no longer selectable, so marking the fixed controls relative to
    // it would light up the face for a nesting the executor will never perform.
    const ctx = this._liveContextKey();
    if (!ctx) return null;
    if (key === ctx) return "context";
    if (!FIXED_CONTROL_KEYS.includes(key)) return null;
    const ctxAssign = pageAssigns?.[ctx];
    if (key === SLIDER_VERTICAL_KEY) {
      // The slider's mark reads a live predicate, not the presence of a stored
      // id. A pinned page slider, an opted-out
      // button and an entity with no controls all leave it inheriting, and all
      // three would look overridden under a presence test.
      //
      // Through `_sliderContextState`, which is the same answer the face's icon
      // and tint read — the mark and the glyph beside it must not be able to
      // disagree about whether this button takes the slider.
      return this._sliderContextState(pageAssigns)?.retargets
        ? "overridden" : "inheritable";
    }
    return hasOverride(ctxAssign, key) ? "overridden" : "inheritable";
  },

  // --- SVG refresh methods ---
  /**
   * The `img` for one tile on one page thumbnail, reused across renders.
   *
   * `_render()` rewrites the shadow root wholesale, so every overlay image on
   * every page was a brand new element on every page switch -- and a new
   * element decodes asynchronously even when the bytes are already in the HTTP
   * cache. The face therefore painted one frame with holes where its pictures
   * go. Moving the *same*, already-decoded node into the new container paints
   * it immediately instead.
   *
   * Keyed by page and button, not by URL: every page thumbnail is in the DOM at
   * once, and two pages may well carry the same picture. One node cannot be in
   * two containers, so a URL-keyed cache would have the second page steal the
   * first page's image. A mismatched `src` drops the entry -- the picture has
   * genuinely changed and there is nothing to reuse.
   */
  _tileImg(pageIdx, key, img) {
    const { src, key: devKey } = typeof img === "string" ? { src: img, key: "" } : img;
    const cache = (this._tileImgCache ||= new Map());
    const id = `${pageIdx}:${key}`;
    const hit = cache.get(id);
    if (hit && src && (hit.getAttribute("data-img-src") ?? hit.getAttribute("src")) === src) {
      // Carried over from the container it was just detached from, which may
      // have styled it for a different role.
      hit.removeAttribute("style");
      this._retryBrokenImg(hit);
      return hit;
    }
    const el = document.createElement("img");
    if (src) {
      el.setAttribute("src", src);
      // The URL the retry goes back to, kept apart from `src` because a retry
      // appends a nonce to it -- compared above so a reused tile is still
      // recognised as carrying the picture the caller asked for.
      el.setAttribute("data-img-src", src);
    }
    // Not known yet: `_applyDeviceUrls` sets `src` once the URL arrives.
    if (devKey) el.setAttribute("data-dev-key", devKey);
    // Decoration: the shape underneath already names it, and these are
    // `pointer-events: none`. Unnamed, a reader would announce the imgserv
    // src once per button.
    el.setAttribute("alt", "");
    el.setAttribute("data-key", key);
    cache.set(id, el);
    return el;
  },

  /**
   * Ask again for an image whose load never produced pixels.
   *
   * `drawSVG` empties every container to redraw, which detaches these overlays.
   * A browser aborts a load that was still in flight when that happened --
   * Safari reliably, which is where this showed -- and because the same node is
   * reused with the same `src` it never starts the request again: the tile sits
   * as the browser's broken-image glyph until the page is reloaded. The icons
   * hit hardest were the ones imgserv had to render for the first time, being
   * the slowest to arrive and so the likeliest to still be in flight.
   *
   * A *complete* image with no intrinsic width is exactly that case (and also a
   * genuine 404). The nonce is what makes it a request the browser has not
   * made -- an unchanged `src` would repaint the failure it already has, the
   * same trick `_repaintCustomIcon` plays -- and imgserv ignores options it
   * does not know. Capped, so a picture that really is missing is asked for
   * twice and then left alone.
   */
  _retryBrokenImg(el) {
    // `complete` is undefined outside a browser, so the harness never retries.
    if (!el?.complete || el.naturalWidth) return;
    const tries = Number(el.getAttribute?.("data-img-retry") || 0);
    if (tries >= 2) return;
    const base = el.getAttribute("data-img-src") || el.getAttribute("src") || "";
    if (!base) return;
    // Recorded for a preview, which arrives as markup and so carries no base of
    // its own: without it a second retry would append its nonce to the first
    // one's URL rather than replace it.
    el.setAttribute("data-img-src", base);
    el.setAttribute("data-img-retry", String(tries + 1));
    el.setAttribute("src", `${base}${base.includes("?") ? "&" : "?"}_retry=${tries + 1}`);
  },

  /**
   * Look over everything imgserv drew, once the faces have had time to load.
   *
   * `_tileImg` only sees a broken tile if something draws the face again, so a
   * load aborted by the *last* redraw would stay broken forever. This sweep is
   * the backstop, and it reaches the previews in the editor card too -- they
   * are rebuilt from markup rather than cached, but a detached preview loses
   * its load the same way.
   *
   * Debounced because a burst of redraws is normal (a page switch, then the
   * state updates that follow it) and only the last one is worth checking.
   */
  _scheduleBrokenImgSweep() {
    clearTimeout(this._brokenImgTimer);
    this._brokenImgTimer = setTimeout(() => {
      this.shadowRoot?.querySelectorAll?.('img[src*="/api/imgserv/"]')
        .forEach((img) => this._retryBrokenImg(img));
    }, 1500);
  },

  // What the hover card says about a slider, answered here because
  // `sliderFollows` and `matchControl` are module-local. `entity` is the
  // fallback for a following slider and the only device for a pinned one.
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
  _pageFillCounts(page, bp) {
    const currentPageId = this._pages[this._currentPageIdx]?.id;
    const pageAssigns = (page.id === currentPageId)
      ? this._assignments
      : (this._pageCache[page.id] || {});
    const allBtnKeys = bp.buttons.map(b => b.key);
    return {
      filled: allBtnKeys.filter(k => isConfigured(pageAssigns[k])).length,
      total: allBtnKeys.length,
    };
  },

  /**
   * Move the page thumbnails into `this._pages` order without re-rendering.
   *
   * A reorder changes where pages sit and nothing about what is on them, but
   * `_render()` rewrites the shadow root wholesale: every thumb is rebuilt from
   * a string, every `.pg-svg-container` is a new empty node, and `_refreshSVG()`
   * then redraws every page face and re-attaches every image. Paying that to
   * move one card is what made a drop lag behind the drag.
   *
   * Moving the existing nodes keeps their drawn faces, their cached `<img>`
   * elements and their already-wired listeners. Only the attributes that encode
   * a *position* have to be rewritten, which `_relabelPageThumbs` does.
   *
   * Returns false if the DOM is not in the state this can safely patch, in
   * which case the caller should fall back to a full render.
   */
  _reorderPageDom() {
    const strip = this.shadowRoot?.querySelector(".pages-list");
    if (!strip || !this._blueprint) return false;

    const byId = new Map();
    strip.querySelectorAll(".page-thumb").forEach(el => byId.set(el.dataset.pageId, el));
    if (byId.size !== this._pages.length) return false;

    const thumbs = this._pages.map(p => byId.get(String(p.id)));
    if (thumbs.some(el => !el)) return false;

    // The add button is the strip's last child and has to stay there, so every
    // thumb is moved in front of it in turn; after the last one the row reads
    // in `_pages` order. Re-inserting a node that is already in place is a
    // no-op move, so the common "dragged one card" case touches few nodes.
    const anchor = strip.querySelector(".page-add-btn");
    for (const el of thumbs) {
      if (anchor) strip.insertBefore(el, anchor);
      else strip.appendChild(el);
    }

    this._relabelPageThumbs();
    // This path exists to skip the render that would otherwise redraw the link,
    // and a reorder moves the very thumbnails it points at.
    this._drawGotoLink();
    return true;
  },

  /**
   * Rewrite the position-derived bits of each thumb after a move.
   *
   * `data-page-idx` is an index into `_pages`, and the spoken name carries
   * "page n of m", so both go stale the moment a page moves. Everything else on
   * a thumb describes the page itself and survives untouched.
   */
  _relabelPageThumbs() {
    this._pages.forEach((page, i) => {
      const el = this.shadowRoot?.querySelector(
        `.page-thumb[data-page-id="${CSS.escape(String(page.id))}"]`
      );
      if (!el) return;

      el.dataset.pageIdx = String(i);
      el.querySelectorAll("[data-page-idx]").forEach(n => { n.dataset.pageIdx = String(i); });

      const isActive = i === this._currentPageIdx;
      const subpageNote = page.subpage ? `, ${this._t("a11y_subpage")}` : "";
      const spokenName = this._t("page_name_pos", {
        name: this._pageLabel(page), n: i + 1, m: this._pages.length,
      }) + subpageNote;

      // The open page is named by `data-a11y-name` and a closed one by the
      // container's `aria-label` — the same split `_render()` makes, so a
      // relabelled thumb is indistinguishable from a re-rendered one.
      if (isActive) el.dataset.a11yName = spokenName;
      const picture = el.querySelector(".pg-svg-container");
      if (picture && !isActive) {
        picture.setAttribute("aria-label", `${this._t("a11y_open_page", { name: spokenName })}.`);
      }
    });
  },

  // --- Goto links ------------------------------------------------------------
  //
  // A button that opens another page is the one assignment whose *target* is
  // also on screen, and nothing said so: the card named the page in words, but
  // finding it in a strip of lookalike thumbnails was still a reading exercise.
  // The link draws the relation the user already configured.
  //
  // It is drawn from both ends, because the two questions a user asks about
  // navigation are opposites of each other. Hovering a button, the question is
  // "where does this go", and one link answers it. Hovering a page, the
  // question becomes "how is this page reached", which only the whole set of
  // buttons pointing at it can answer. A page nothing points at draws nothing,
  // which is the honest and useful answer: that page is unreachable from the
  // remote.
  //
  // Hover and nothing else. Selection does not draw links: a selected button
  // keeps its card open while the user works elsewhere, and a link left
  // standing for that long reads as part of the layout rather than as an
  // answer to a question just asked.

  /**
   * The page an assignment opens, or null when it opens none.
   *
   * `_internalTargetPage` is the single owner of "which page does this name",
   * and it answers null for everything that is not a resolvable page: a plain
   * HA service call, a command targeting something else, a deleted page, a name
   * two pages share. Each of those is a case where there is no one page to
   * point at, so each correctly draws nothing.
   */
  _gotoPageOf(assign) {
    if (!assign?.action_id) return null;
    const action = (this._actions || []).find(a => a.id === assign.action_id);
    return this._internalTargetPage(assign.config, action?.service) || null;
  },

  /**
   * The page a long touch on this button opens, or null.
   *
   * `longtouch` is a bare step list with no `action_id` beside it -- a long
   * touch is always configured inline -- so the step names its own service and
   * there is no fallback to pass.
   *
   * Silent while the feature is switched off, matching `longtouch_assignment`
   * in `buttons.py`: the steps stay stored but the remote does not run them,
   * and a line drawn to a page that no long touch currently opens would be a
   * navigation path the user cannot take.
   */
  _gotoLongPageOf(assign) {
    const steps = assign?.longtouch;
    if (!Array.isArray(steps) || !steps.length) return null;
    if (!this._longtouchEnabled?.()) return null;
    return this._internalTargetPage(steps) || null;
  },

  /**
   * Every page one button can open, click and long touch together.
   *
   * De-duplicated by page: a button whose two gestures lead to the same place
   * would otherwise draw one line exactly on top of another, darkening it for
   * no reason a viewer could name.
   */
  _gotoPagesOf(assign) {
    const pages = [];
    for (const page of [this._gotoPageOf(assign), this._gotoLongPageOf(assign)]) {
      if (page && !pages.some(p => p.id === page.id)) pages.push(page);
    }
    return pages;
  },

  /**
   * The pages a control on the open page opens -- none, one, or one per gesture.
   *
   * Read through the edit slot, exactly as the face's own tiles are, so the
   * link describes the same configuration the drawn button describes. Under a
   * context that is the override being edited rather than the page default --
   * a link pointing at the page the *stored* record names would contradict the
   * button it starts from.
   */
  _gotoLinkPages(key) {
    if (!key) return [];
    return this._gotoPagesOf(this._editAssign?.(key));
  },

  /**
   * Whose outgoing link is on screen: the button the pointer is over, and
   * nothing else.
   *
   * Selection deliberately does not count. A link drawn for the selected
   * button stays on screen for as long as that button is being configured,
   * which is most of the time the editor is open -- so the one relation the
   * overlay exists to point out became permanent furniture, and a line that is
   * always there says nothing. Tying it to the pointer makes it an answer to a
   * question just asked, and makes every face readable again the moment the
   * pointer leaves.
   *
   * The two face shapes that are not buttons are refused. `slider_horizontal`
   * is the page's title bar and `slider_vertical` the page slider; both are
   * dragged, never pressed, so neither can open anything -- yet both hold a
   * record whose stored steps may name `goto_page`, which would otherwise be
   * read as a route that no gesture can take.
   */
  _gotoLinkKey() {
    const key = this._gotoHoverKey;
    return key && !NON_BUTTON_KEYS.has(key) ? key : null;
  },

  /**
   * The page whose incoming links are on screen: the one under the pointer.
   *
   * Matched by id rather than kept as an index, because the strip reorders
   * under drag and an index remembered across a reorder names a different
   * page. The id arrives from a DOM attribute and is therefore a string, while
   * page ids are numbers, so both sides are compared as text.
   */
  _gotoHoverPage() {
    if (this._gotoHoverPageId == null) return null;
    const wanted = String(this._gotoHoverPageId);
    return (this._pages || []).find((p) => String(p.id) === wanted) || null;
  },

  // Where the switch on the gear tab remembers itself. A browser-local key,
  // not a device setting: it changes what this editor draws and nothing the
  // remote does, so it has no business being saved per remote on the backend.
  PAGE_LINKS_PREF: "liza.remote.pageLinks",

  /**
   * Whether links are drawn at all. Off until switched on.
   *
   * Defaulting to off keeps the editor quiet: the overlay paints over the
   * page strip on every hover, which is noise for the many sessions that are
   * not tracing where a button leads. Whoever wants it turns it on once and
   * the browser remembers. Read once and kept, because this is asked on
   * every pointer move.
   *
   * Storage is wrapped: a browser with site data blocked throws on access
   * rather than returning null, and an unreadable preference is not a reason
   * for the page strip to stop rendering.
   */
  _pageLinksEnabled() {
    if (this._pageLinksOn === undefined) {
      let stored = null;
      try { stored = window.localStorage?.getItem(this.PAGE_LINKS_PREF); } catch (e) { stored = null; }
      this._pageLinksOn = stored === "1";
    }
    return this._pageLinksOn;
  },

  _setPageLinksEnabled(on) {
    this._pageLinksOn = !!on;
    try {
      window.localStorage?.setItem(this.PAGE_LINKS_PREF, this._pageLinksOn ? "1" : "0");
    } catch (e) { /* Blocked storage: the switch still works for this session. */ }
    // A no-op while the gear tab is the one showing -- there is no overlay in
    // the DOM to clear. Called anyway so that the one place that changes the
    // preference is also the place that makes the change take effect.
    this._drawGotoLink();
  },

  /**
   * The links to draw, as pairs of live elements, in the order they are drawn.
   *
   * Split out from the painting because it is the whole of the *rule* -- which
   * links exist and why -- while everything in `_drawGotoLink` is geometry.
   *
   * An outgoing link starts only on the open page. A closed thumbnail is a
   * picture of another page drawn at a fifth of the size with its controls
   * deliberately non-interactive (see `drawSVG`'s `interactive`), so there is
   * nothing there to hover. Incoming links do start on closed thumbnails,
   * because that is where the buttons that reach a page almost always are -- a
   * page is usually opened from somewhere else.
   *
   * Both halves are hover-driven and nothing else is: a button under the
   * pointer shows where it goes, a thumbnail under the pointer shows what
   * reaches it, and an idle pointer draws no lines at all.
   */
  _gotoLinkSpecs(list) {
    if (!list || !this._pageLinksEnabled()) return [];
    const thumbFor = (id) =>
      list.querySelector(`.page-thumb[data-page-id="${CSS.escape(String(id))}"]`);

    const key = this._gotoLinkKey();
    if (key) {
      const shape = list.querySelector(
        `.page-thumb.active .button[data-key="${CSS.escape(key)}"]`,
      );
      if (!shape) return [];
      // One per gesture that opens a page: a button whose click opens one page
      // and whose long touch opens another describes two routes, and drawing
      // only the first would say the second does not exist.
      return this._gotoLinkPages(key)
        .map((page) => ({ shape, thumb: thumbFor(page.id) }))
        .filter((spec) => spec.thumb);
    }

    // No button under the pointer: if a page is, show what reaches that page.
    // The hovered page rather than the open one, so the question can be asked
    // of any page in the strip without opening it first -- and so that the
    // answer, like the outgoing half, lasts exactly as long as the pointer
    // stays put.
    const target = this._gotoHoverPage();
    const thumb = target ? thumbFor(target.id) : null;
    if (!thumb) return [];

    const specs = [];
    const openId = this._pages?.[this._currentPageIdx]?.id;
    for (const page of this._pages) {
      const source = thumbFor(page.id);
      if (!source) continue;
      // Read exactly the way the face is drawn, so a line never starts on a
      // shape that is showing something else.
      //
      // The open page goes through the edit slot. That is what carries unsaved
      // edits, and -- with a grid button in context -- what resolves a fixed
      // control to that button's override, which is the assignment its shape is
      // currently drawn from. Walking the page map instead made the overlay
      // disagree with itself: hovering the override's own button drew the link
      // (its outgoing half asks `_editAssign`), while hovering the page it
      // opens did not, so the same relation existed or not depending on which
      // end you looked from. The keys come from the blueprint rather than from
      // the records, because an override exists for a key the page map does not
      // mention at all. A fixed control with no override resolves to nothing
      // and contributes no link, which is the face's own answer: under a
      // context, that shape is drawn as unset.
      //
      // Every other page goes through `_pageCache`, which is what its closed
      // thumbnail draws -- no context reaches it, and its unsaved edits are not
      // in `_assignments`, which belongs to the open page alone. A page missing
      // from the cache has genuinely not been read yet rather than being empty;
      // it contributes nothing until it is, exactly as its thumbnail does.
      const entries = page.id === openId
        ? (this._blueprint?.buttons || []).map((b) => [b.key, this._editAssign?.(b.key)])
        : Object.entries(this._pageCache?.[page.id] || {});
      for (const [btnKey, assign] of entries) {
        // Same two non-buttons as in `_gotoLinkKey`, refused for the same
        // reason: their records can hold steps, but no press runs them.
        if (NON_BUTTON_KEYS.has(btnKey)) continue;
        if (!this._gotoPagesOf(assign).some((p) => p.id === target.id)) continue;
        const shape = source.querySelector(`.button[data-key="${CSS.escape(btnKey)}"]`);
        if (shape) specs.push({ shape, thumb });
      }
    }
    return specs;
  },

  /**
   * Paint the current links, or clear the overlay when there are none.
   *
   * Everything is measured rather than derived from the blueprint: the face is
   * scaled to its container, thumbnails are shifted by drags and by the subpage
   * offset, and the strip scrolls. `getBoundingClientRect` is the only answer
   * that survives all of that, and the overlay is measured the same way so the
   * readings share one coordinate space.
   */
  /**
   * Drop the link outlines from whatever currently carries them.
   *
   * Found by selector rather than kept in a list: the shapes a previous draw
   * marked are routinely destroyed and rebuilt by `_refreshSVG` between two
   * draws, so a remembered element can be one that is no longer in the
   * document while its replacement sits there still outlined.
   */
  _clearGotoMarks() {
    this.shadowRoot?.querySelectorAll(".pages-list [goto-link]")
      .forEach((el) => el.removeAttribute("goto-link"));
  },

  _drawGotoLink() {
    const layer = this.shadowRoot?.querySelector(".goto-link-layer");
    if (!layer) return;
    const list = this.shadowRoot?.querySelector(".pages-list");
    const specs = this._gotoLinkSpecs(list);
    if (!specs.length) {
      this._clearGotoMarks();
      // Emptied rather than hidden: a stale path left in the DOM would flash
      // back at its old coordinates the moment anything made the layer visible
      // again, and there is nothing here worth keeping to redraw.
      if (layer.innerHTML) layer.innerHTML = "";
      // Cleared alongside it, or the cache below would recognise the paths that
      // are no longer drawn and decline to draw them again.
      delete layer.dataset.linkPath;
      return;
    }

    // Sized to the scrollable content, not to the visible box: a target may be
    // scrolled out of view, and a layer cut to the viewport would clip the link
    // exactly when it is most needed -- pointing off-screen is how the user is
    // told to scroll. `clientWidth` is the floor for the case where nothing
    // overflows and `scrollWidth` is the smaller of the two.
    const w = Math.max(list.scrollWidth, list.clientWidth);
    const h = Math.max(list.scrollHeight, list.clientHeight);
    layer.setAttribute("viewBox", `0 0 ${w} ${h}`);
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;

    // Measured after the resize above, so the overlay is already the size the
    // coordinates below are expressed in.
    const base = layer.getBoundingClientRect();
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
    };

    let marks = "";
    const paths = [];
    const ends = [];
    for (const { shape, thumb } of specs) {
      const box = rel(shape);
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      // Aimed from the button's centre, then pulled back to its own border, so
      // the line leaves the outline rather than starting under it.
      const end = gotoLinkEnd(rel(thumb), cx, cy);
      const start = gotoLinkEnd(box, end.x, end.y);
      const d = gotoLinkPath(start.x, start.y, end.x, end.y);
      paths.push(d);
      ends.push(shape, thumb);
      marks += `<path class="goto-link-path" d="${d}" marker-end="url(#goto-link-head)"/>`;
    }

    // Outline both ends, before the cache check below rather than after: a
    // rebuilt face carries no attributes, and its shapes land at the very
    // coordinates they had, so the paths match and the draw is skipped while
    // the outlines are gone. Re-marking costs an attribute write per link.
    this._clearGotoMarks();
    for (const el of ends) el.setAttribute("goto-link", "");

    // Nothing moved: rewriting identical markup would restart the draw-in
    // animation on every pointer twitch and every unrelated render.
    const signature = paths.join("|");
    if (layer.dataset.linkPath === signature) return;
    layer.dataset.linkPath = signature;
    // The arrowhead is a marker so it stays on each curve's own end tangent
    // without the angle being computed here, and so that any number of links
    // share one definition. `markerUnits="strokeWidth"` ties its size to the
    // line's, so the two cannot drift apart.
    layer.innerHTML = `
      <defs>
        <marker id="goto-link-head" markerWidth="5" markerHeight="5" refX="4.4" refY="2.5"
                orient="auto" markerUnits="strokeWidth">
          <path class="goto-link-head" d="M0,0 L5,2.5 L0,5 Z"/>
        </marker>
      </defs>${marks}`;
  },

  /**
   * Listen for the pointer crossing the open page's controls.
   *
   * Delegated to the strip rather than bound per shape: `_refreshSVG` rebuilds
   * every face from scratch whenever anything about a page changes, so listeners
   * on the shapes themselves would be dropped by the next repaint while the
   * strip itself survives until the whole view is re-rendered.
   *
   * `mouseover` alone, with no `mouseout` to match: it fires for the background
   * the pointer lands on when it leaves a button, which resolves to no key and
   * clears the link. The one gap that leaves is the pointer leaving the strip
   * entirely without crossing anything else, which `mouseleave` closes.
   *
   * Two readings are taken from the same event because the overlay asks two
   * questions of the pointer -- which button it is on, and which page -- and a
   * second listener would see the same crossings and answer half of each.
   */
  _wireGotoLinks() {
    const list = this.shadowRoot?.querySelector(".pages-list");
    if (!list) return;
    // What the pointer is over is deliberately *not* reset here, though the
    // markup it named has just been replaced. Both readings are a key and an
    // id, never an element: `_gotoLinkSpecs` looks the shape and the thumbnail
    // up by selector on every draw, so they survive a rebuild that destroys
    // everything they refer to. Forgetting them instead made the link flicker
    // out and stay out -- Home Assistant pushes `hass` on every state change in
    // the house, each one re-renders this view, and no mouse event fires again
    // until the pointer moves, so a link only lasted until the next unrelated
    // entity changed. A key whose shape is genuinely gone resolves to no spec
    // and draws nothing, which is the same thing forgetting it would have done.

    list.addEventListener("mouseover", (e) => {
      const shape = e.target?.closest?.(".page-thumb.active .button[data-key]");
      const key = shape?.getAttribute?.("data-key") || null;
      // Read even with a button in hand, so that leaving the button for the
      // page around it needs no further event to fall back to.
      const pageId = e.target?.closest?.(".page-thumb[data-page-id]")
        ?.getAttribute?.("data-page-id") ?? null;
      if (key === this._gotoHoverKey && pageId === this._gotoHoverPageId) return;
      this._gotoHoverKey = key;
      this._gotoHoverPageId = pageId;
      this._drawGotoLink();
    });
    list.addEventListener("mouseleave", () => {
      if (!this._gotoHoverKey && this._gotoHoverPageId == null) return;
      this._gotoHoverKey = null;
      this._gotoHoverPageId = null;
      this._drawGotoLink();
    });

    // Window-level and registered once for the life of the element, in the same
    // shape as `_pageDeleteKey`: the strip is rebuilt by every render and a
    // listener re-added per render would accumulate. Removed in
    // `disconnectedCallback`.
    if (!this._gotoLinkResize) {
      this._gotoLinkResize = () => this._drawGotoLink();
      window.addEventListener?.("resize", this._gotoLinkResize);
    }

    this._drawGotoLink();
    // Again after layout settles. `_render` restores the strip's scroll offset
    // in a frame of its own and the faces are sized by CSS, so the first pass
    // above can measure a row that is still moving.
    requestAnimationFrame(() => this._drawGotoLink());
  },

  _refreshSVG() {
    const bp = this._blueprint;
    if (!bp) return;
    // The shape the card describes is one of the ones about to be discarded.
    this._hideButtonTip?.();
    // The tiles below are about to be rebuilt, so what the icon pass learned
    // from the previous ones no longer describes anything on screen.
    this._invalidateFaceCaches();

    this.shadowRoot.querySelectorAll(".pg-svg-container").forEach(container => {
      const pageIdx = parseInt(container.dataset.pageIdx);
      const isActive = pageIdx === this._currentPageIdx;
      const page = this._pages[pageIdx];
      if (!page) return;

      const currentPageId = this._pages[this._currentPageIdx]?.id;
      const pageAssigns = (page.id === currentPageId)
        ? this._assignments
        : (this._pageCache[page.id] || {});

      const selectedIdx = this._faceSelectedIdx(bp, isActive);
      // Every tile below reads the *edit slot*, not `pageAssigns[key]`.
      //
      // With a grid button in context the face becomes a view of *that button's
      // configuration*, which is the same thing the card shows — so a fixed
      // control shows the override, and shows nothing when there is no
      // override. Reading the page default here is what made the face contradict
      // the card: it drew the power glyph for a slot the card was offering as
      // empty, and the user had no way to tell which fixed controls the selected
      // button actually configures.
      //
      // Deliberately *not* "what would a press do". A control with no override
      // does still run the page default — that is what `_faceMark` says with
      // `inheritable`, and the mark is the right place for it, because the face
      // is a config surface and its tiles answer "what is set here".
      //
      // `_editAssign` is the one owner of that question and is read-only, so
      // drawing a card can never create an override. An inactive thumbnail has
      // no context and no edit slot, so it reads its cached page map.
      const assignFor = isActive
        ? (key) => this._editAssign(key)
        : (key) => pageAssigns[key];
      // The slider's half of the same question. It is not an `overrides` entry,
      // so `_editAssign` returns the page slider for it whatever the context is
      // — which left the strip showing the page's config while every button
      // beside it had switched to the selection's. Computed once per face rather
      // than per tile: the three reads below and `markFor` all want this answer.
      const sliderCtx = isActive ? this._sliderContextState(pageAssigns) : null;
      // Under a context the strip shows what the selected button points it at,
      // and shows nothing when that button points it nowhere — the slider's
      // spelling of the blank tile the fixed buttons get. No fallback glyph when
      // the retargeted entity yields no control either, for the same reason
      // `sliderIconFor` no longer has one.
      //
      // The button's own `slider_image` wins when it has one, and shows whether
      // or not the button retargets: the card offers Appearance to any selected
      // button, so a stored icon the face refused to draw was a field that took
      // a value and appeared to lose it. Only the *derived* glyph needs the
      // retarget, because deriving is what needs a control to derive from.
      // Read from the page slot rather than the edit slot for the same reason
      // the card does — it is a field on the grid button, not an `overrides`
      // entry.
      const sliderCtxIcon = () => {
        const rec = pageAssigns?.[this._liveContextKey()] || {};
        return resolveSliderIcon(
          rec.slider_image,
          sliderCtx.retargets ? (sliderCtx.control?.icon || "") : "",
          !!rec[SLIDER_ICON_HIDDEN_KEY],
        );
      };
      const isSliderCtx = (key) => !!sliderCtx && key === SLIDER_VERTICAL_KEY;
      // `isConfigured`, not the `isDriving` that used to be here. That predicate
      // was `isConfigured || sliderFollows`, and `sliderFollows` is true only for
      // `slider_vertical` — so on a page with nothing set up, the one control
      // nobody had configured was the only one painted as configured. The slider
      // does still drive without storing anything, but that is what the branch
      // above says, and it says it only while a button is actually in context.
      const hasAction = (key) => (isSliderCtx(key)
        ? sliderCtx.retargets
        : isConfigured(assignFor(key)));
      // An inactive page's controls were wired to nothing at all, and the path
      // handler stops every click on itself — so clicking a button on another
      // page did not even switch to it, let alone open it. The click had to
      // miss every control and land on the face background before the
      // thumbnail's own handler could see it. Both faces answer the same
      // gesture now; the far one just has a page to cross first.
      const onSelect = isActive
        ? (idx) => this._selectFaceKey(bp.buttons[idx]?.key)
        : (idx) => this._switchPageTo(pageIdx, bp.buttons[idx]?.key);
      const getIcon = (key) => {
        if (isSliderCtx(key)) return sliderCtxIcon();
        const assign = assignFor(key);
        const fallbackIcon = DEFAULT_BUTTON_ICONS[key] || "";
        if (!assign) return fallbackIcon;
        // An explicit "no icon" on the page slider, which is a stored choice
        // rather than an absence and so must beat the derived glyph below.
        if (key === SLIDER_VERTICAL_KEY && assign[SLIDER_ICON_HIDDEN_KEY]) return "";
        // Slider mechanics carry their own icon (see sliderIconFor) — checked
        // before the action_id branch because proportional sliders have none.
        if (!assign.image) {
          const sIcon = sliderIconFor(this._sliderControls, assign);
          if (sIcon) return sIcon;
        }
        if (!assign.action_id) {
          return this._resolveButtonIcon(assign, null, fallbackIcon) || fallbackIcon;
        }
        const action = this._actions.find(a => a.id === assign.action_id);
        return this._resolveButtonIcon(assign, action, fallbackIcon) || fallbackIcon;
      };
      // Normalise once, like resolve_icon_url's icon.strip(), so every startsWith
      // branch below matches a title pasted with surrounding whitespace.
      // An unset title renders nothing — the device shows a blank title bar, so the
      // preview must too. Never substitute the page id as a stand-in label.
      const rawTitle = this._pageTitleImage(page);
      const mode = this._getThemeMode();
      const pgColor = page.default_color || "";
      // The colour is sent as soon as one part can spend it; imgserv decides
      // which do. A title carrying its own fg= has already said what it wants.
      // The title strip the remote is sent, colour and text style included.
      const sliderImage = rawTitle ? this._deviceImg(rawTitle, "title", pgColor) : null;
      const sliderImageUrl = sliderImage && sliderImage.src !== "" ? sliderImage : null;

      // Draw clickable button shapes only — icon/title images are HTML overlays
      // below. `markFor` rides along because the nesting mark styles the SVG
      // shape, which is not part of what moved to the overlays.
      drawSVG(container, bp, selectedIdx, hasAction, onSelect, {
        // Only the open page exposes its forty shapes as controls. See drawSVG.
        interactive: isActive,
        // The face says "configured" with colour, which a screen reader cannot
        // report, so the state joins the name instead.
        nameFor: (btn, { configured }) => {
          // The title strip is drawn by the same loop as the shapes but is the
          // Page Settings control, not a button: the file says so in four
          // other places and this callback was the one that missed it, so a
          // reader heard the storage key -- "slider horizontal, empty".
          if (btn.key === "slider_horizontal") return this._t("a11y_page_title");
          // Same trap one key over: the slider is not a button, and the
          // fallback would call it "Button Slider vertical".
          const sliderFallback = isSliderBtn(btn.key) ? this._t("a11y_slider") : null;
          // The words the remote prints on the button, not the stored text: a
          // label holding a placeholder was read out as "dollar sign, left
          // brace, STATE", and a layout name lost the entity in front of it.
          const assign = assignFor(btn.key);
          const name = this._buttonSpokenLabel(assign) || sliderFallback
            || this._t("a11y_btn_fallback", { name: this._humaniseButtonKey(btn.key) });
          return this._t(configured ? "a11y_btn_configured" : "a11y_btn_empty", { name });
        },
        // Only the active page carries the nesting marks. An inactive thumbnail
        // has no selection to be in context of — `selectedIdx` is already -1
        // there for the same reason — and marking one would claim a context on
        // a page the user is not editing.
        markFor: isActive ? (key) => this._faceMark(key, pageAssigns) : () => null,
        // Same rule as `onSelect`: an inactive thumbnail is a picture of another
        // page, and clearing a button on a page the user is not editing is not
        // a gesture anyone reaches for by accident.
        onContext: isActive ? (idx, ev) => this._showFaceMenu(bp.buttons[idx], ev) : null,
        // Only the open page, like `onContext`: the card reads the edit slot,
        // so a thumbnail would describe its shapes with another page's config.
        onHover: isActive ? (key, el, on) => this._onButtonHover(key, el, on) : null,
        // Only the open page, for the reason `onContext` is: a move reads the
        // open page's assignments, and a thumbnail is a picture of another.
        canDrag: isActive ? (key) => this._canMoveButton(key) : null,
        canDrop: isActive ? (key, fromKey) => this._canDropButtonOn(fromKey, key) : null,
        onDrop: isActive ? (from, to) => this._dropButtonOn(from, to) : null,
      });

      cropFace(container.querySelector("svg"));

      // Title PNG (slider_horizontal area). `titleFit` draws it at the size
      // the device does; the clip bounds a title too long for the bar, which
      // would otherwise be painted across the grid below it.
      //
      // Natural sizes are remembered per URL because `_render()` builds a new
      // `img` on every page switch, whose `naturalWidth` is 0 until `load`
      // fires even from cache -- without the cache a short label snapped in
      // from bar-width on every switch.
      if (sliderImageUrl) {
        const sliderBtn = bp.buttons.find(b => b.key === 'slider_horizontal');
        if (sliderBtn) {
          const b = getPathBounds(sliderBtn.d);
          if (b) {
            const clip = document.createElement('div');
            clip.className = 'pg-title-clip';
            clip.style.cssText = overlayStyle(b, b.w, b.h);

            const el = this._tileImg(pageIdx, 'slider_horizontal', sliderImageUrl);
            el.className = 'pg-btn-img pg-title-img';
            const natural = (this._titleNaturalByUrl ||= new Map());
            const applySize = () => {
              if (el.naturalWidth) {
                natural.set(sliderImageUrl.key, { w: el.naturalWidth, h: el.naturalHeight });
              }
              const known = natural.get(sliderImageUrl.key);
              Object.assign(el.style, titleFit(
                b, el.naturalWidth || known?.w, el.naturalHeight || known?.h,
              ));
            };
            // One listener per element, however many times it is reused: it
            // calls whatever `applySize` the latest pass installed, so a stale
            // closure cannot outlive the geometry it was built from.
            el._lizaApplySize = applySize;
            if (!el._lizaSizeBound) {
              el._lizaSizeBound = true;
              el.addEventListener('load', () => el._lizaApplySize?.());
            }
            applySize();

            clip.appendChild(el);
            container.appendChild(clip);
          }
        }
      }

      // Button icon PNGs
      bp.buttons.forEach(btn => {
        // `slider_horizontal` is the title bar and gets its own image above.
        // `slider_vertical` is *not* skipped: its glyph is a stored — and under
        // a context, an overridden — choice that `getIcon` already answers for,
        // so skipping it would leave the one control this branch is about with
        // no icon on the face.
        if (btn.key === 'slider_horizontal') return;
        const icon = String(getIcon(btn.key) ?? '').trim();
        if (!icon) return;
        const b = getPathBounds(btn.d);
        if (!b) return;
        const sz = Math.min(b.w, b.h) * 0.5;
        // Through `assignFor`, like `getIcon` above, rather than the raw page
        // map. The icon this overlay carries is already the context's, so
        // reading the page default for the tint and the dim would style it as
        // unassigned — the fixed control the page leaves blank but the context
        // drives would come out greyed under the icon just drawn for it.
        const overlayAssign = assignFor(btn.key);
        // The bound light's own colour and level, so the preview matches the
        // tile the device is drawing. Falls back to the page colour like
        // everything else.
        const tileStyle = this._buttonIconStyle(overlayAssign, pgColor);
        const tile = this._buildTileImgUrl(
          icon, mode, tileStyle.color, isConfigured(overlayAssign), tileStyle.percent,
        );
        // "" is nothing to draw; null is a URL still being asked for.
        if (tile.src === "") return;
        const el = this._tileImg(pageIdx, btn.key, tile);
        el.className = 'pg-btn-img';
        el.style.cssText = overlayStyle(b, sz) + 'pointer-events:none;';
        if (DEFAULT_BUTTON_ICONS[btn.key] && !overlayAssign?.action_id) {
          el.style.opacity = '0.3';
        }
        container.appendChild(el);
      });
    });

    // Last word on the tiles just drawn: whatever this redraw interrupted has
    // no other chance to notice.
    this._scheduleBrokenImgSweep();
  },

  // Which shape on the face carries the selection highlight.
  //
  // A grid button when one is selected. Otherwise `slider_horizontal`, but only
  // while the page's title row is open — that strip *is* the title, and the
  // highlight says which control the card is currently showing. Landing on Page
  // Settings by selecting a page highlights nothing: the card is showing the
  // page's colour, which is not any one shape on the face.
  //
  // It used to light up whenever nothing was selected, from when reaching Page
  // Settings and opening the title were the same gesture. Kept that way it would
  // now mark the strip while the row it opens is closed.
  //
  // Only the highlight moves, never `_selectedButtonIdx`. The rest of the panel
  // reads -1 as "no button is being edited", which stays true -- a page is not
  // a button.
  //
  // Inactive page thumbnails get nothing: there is no selection to show on a
  // page that is not being edited.
  _faceSelectedIdx(bp, isActive) {
    if (!isActive) return -1;
    if (this._selectedButtonIdx >= 0) return this._selectedButtonIdx;
    if (!this._pageTitleSelected) return -1;
    // findIndex gives -1 for a blueprint without the strip, which is the same
    // "highlight nothing" the caller already handles. Not optional-chained:
    // `_refreshSVG` has already returned if there is no blueprint, and drawSVG
    // walks `bp.buttons` unguarded a few lines later, so a guard here would
    // relocate that crash rather than prevent it.
    return bp.buttons.findIndex(b => b.key === "slider_horizontal");
  },

  _refreshSVGIcons() {
    // Incremental update: refresh only state-driven icon <img src> values
    // without a full redraw (avoids re-fetching images that haven't changed).
    if (!this._blueprint) return;
    const mode = this._getThemeMode();

    // Home Assistant assigns `hass` on every state change anywhere in the
    // house, and this walk is O(pages x buttons x actions) -- on a full remote
    // that is thousands of operations, nearly always to conclude that nothing
    // moved. So the walk records which entities it actually read, and a later
    // tick that touched none of them returns here instead.
    //
    // HA replaces a state object rather than mutating it, so identity is a
    // sufficient and very cheap test. The face epoch covers everything else:
    // any edit that could change *which* entities matter redraws the face,
    // and a redraw invalidates the set rather than trusting it.
    if (this._svgIconDeps
        && this._svgIconEpoch === this._faceEpoch
        && this._svgIconMode === mode
        && this._svgIconDepsUnchanged()) {
      return;
    }
    const deps = new Map();

    this.shadowRoot.querySelectorAll(".pg-svg-container").forEach(container => {
      const pageIdx = parseInt(container.dataset.pageIdx);
      const page = this._pages[pageIdx];
      if (!page) return;
      const pageColor = page.default_color || "";
      const currentPageId = this._pages[this._currentPageIdx]?.id;
      const isActive = page.id === currentPageId;
      const pageAssigns = isActive
        ? this._assignments
        : (this._pageCache[page.id] || {});

      container.querySelectorAll("img.pg-btn-img[data-key]").forEach(img => {
        const key = img.getAttribute("data-key");
        if (key === 'slider_horizontal') return;
        // Through the edit slot, like `_refreshSVG`'s `getIcon`. This runs on
        // every entity state change, so reading the page default here would
        // repaint it over the context's own tile a second after that tile was
        // drawn — which reads as an intermittent bug rather than a missing
        // feature.
        const assign = isActive ? this._editAssign(key) : pageAssigns[key];
        if (!assign?.action_id) return;
        // Recorded before the early returns below, because an entity that
        // currently resolves to no icon still has to be watched: it is exactly
        // the one whose next state change should bring the tile back.
        for (const eid of this._getTargetEntitiesFromConfig(assign.config) || []) {
          if (!deps.has(eid)) deps.set(eid, this._hass?.states?.[eid]);
        }
        const action = this._actions.find(a => a.id === assign.action_id);
        if (!action) return;
        const newIcon = this._resolveButtonIcon(assign, action);
        if (!newIcon) return;
        const tileStyle = this._buttonIconStyle(assign, pageColor);
        const tile = this._buildTileImgUrl(
          newIcon, mode, tileStyle.color, true, tileStyle.percent,
        );
        if (tile.src === null) {
          // Asked for; `_applyDeviceUrls` fills it in when the answer comes.
          if (img.getAttribute('data-dev-key') !== tile.key) {
            img.removeAttribute('src');
            img.removeAttribute('data-img-src');
            img.setAttribute('data-dev-key', tile.key);
          }
          return;
        }
        if (!tile.src) return;
        // `data-img-src` alongside it: it is what `_tileImg` compares a
        // reused tile against and what a retry goes back to, so a state-driven
        // icon change has to move both or the next draw builds a new element.
        if ((img.getAttribute('data-img-src') ?? img.getAttribute('src')) !== tile.src) {
          img.setAttribute('src', tile.src);
          img.setAttribute('data-img-src', tile.src);
          img.setAttribute('data-dev-key', tile.key);
          img.removeAttribute('data-img-retry');
        }
      });
    });

    this._svgIconDeps = deps;
    this._svgIconEpoch = this._faceEpoch;
    this._svgIconMode = mode;
  },

  /**
   * Whether every entity the last icon pass read still holds the same state.
   *
   * An entity that has since disappeared from `hass` compares equal to the
   * `undefined` recorded for one that was already missing, so a button bound
   * to a removed entity does not spin the walk on every tick.
   */
  _svgIconDepsUnchanged() {
    const states = this._hass?.states;
    for (const [eid, recorded] of this._svgIconDeps) {
      if (states?.[eid] !== recorded) return false;
    }
    return true;
  },

  /**
   * Drop what the icon pass remembered, because the face it described is gone.
   *
   * Called wherever the face is rebuilt: the set of entities on screen is a
   * product of that markup, so it cannot outlive it.
   */
  _invalidateFaceCaches() {
    this._faceEpoch = (this._faceEpoch || 0) + 1;
    this._svgIconDeps = null;
  },

  /**
   * `{src, key}` for a button face: the tile the remote is sent (`_deviceImg`).
   * An untinted tile -- a default the page leaves unassigned -- is asked for
   * without the colour.
   */
  _buildTileImgUrl(icon, mode, color, isTinted, percent = null) {
    return this._deviceImg(icon, "tile", isTinted ? color : "", percent);
  },

  // --- Wiring ---
  _wireButtonsView(bp) {
    // Page thumbnails
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      el.addEventListener("click", (e) => {
        // A long-press fires the menu and then, on most touch stacks, a click.
        // Without this the page would change out from under the open menu.
        if (suppressedNow(el)) return;
        const idx = parseInt(el.dataset.pageIdx);
        // On the current page, a button's own handler owns a click on it.
        // Anywhere else on that page -- the face background or the frame
        // around it -- selects the page itself: a selected button or the open
        // title row is put away and Page Settings shows. Otherwise the only
        // way out is re-clicking the exact control you started from.
        if (idx === this._currentPageIdx) {
          if (e.target?.closest?.(".button")) return;
          const wasTitle = this._selectedButtonIdx === -1 && !!this._pageTitleSelected;
          if (this._selectedButtonIdx === -1 && !this._contextKey && !wasTitle) return;
          this._flushAutoSave();
          this._selectedButtonIdx = -1;
          this._contextKey = null;
          this._pageTitleSelected = false;
          this._editorEl = null;
          this._sequence = [];
          this._render();
          if (wasTitle) {
            this._a11yEditorToggled?.(false, this._t("a11y_editing_title"), this._t("a11y_title_closed"));
          }
          return;
        }
        // Only the face *background* and the frame around it get here from
        // another page: every button path stops the click on itself and hands
        // it to `onSelect`, which crosses to the page with that button already
        // named. This is the click that names nothing, so it just crosses.
        if (idx !== this._currentPageIdx) {
          this._switchPageTo(idx);
        }
      });
    });

    // The strip's hover card. On the thumb rather than the picture inside it,
    // because the thumbs are small and a card that only answers over the drawn
    // pixels is one the user has to aim for. Focus too, for the keyboard.
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      const idx = parseInt(el.dataset.pageIdx);
      el.addEventListener("mouseenter", () => this._onPageHover(idx, el, true));
      el.addEventListener("mouseleave", () => this._onPageHover(idx, el, false));
      el.addEventListener("focusin", () => this._onPageHover(idx, el, true, true));
      el.addEventListener("focusout", () => this._onPageHover(idx, el, false));
    });

    // Right-click, and the long-press that stands in for it on touch. Same
    // gesture and same 500 ms as the button faces, so the strip does not teach
    // a second way to ask for a menu. Movement cancels it: dragging across the
    // strip is how it is scrolled, and how pages are reordered.
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      const idx = parseInt(el.dataset.pageIdx);
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault?.();
        e.stopPropagation?.();
        this._showPageMenu(idx, e);
      });
      // Without this the whole thing is pointer-only, and the README's claim
      // that the panel can be driven from the keyboard stops being true. Same
      // keys as the button faces. A thumb is a tab stop only while its page is
      // not the open one, so the page you are on is marked by stepping to
      // another page first -- every page is still reachable.
      el.addEventListener("keydown", (e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        const r = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
        this._showPageMenu(idx, {
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        });
      });
      let timer = null;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      el.addEventListener("touchstart", (e) => {
        cancel();
        // A new gesture starts: anything the last one left behind is stale.
        armSuppress(el, false);
        const touch = e.touches && e.touches[0];
        const x = touch ? touch.clientX : 0;
        const y = touch ? touch.clientY : 0;
        timer = setTimeout(() => {
          timer = null;
          // The click handler above switches pages; without this the menu
          // would open on a page the user is no longer looking at.
          armSuppress(el, true);
          this._showPageMenu(idx, { clientX: x, clientY: y });
        }, 500);
      }, { passive: true });
      for (const type of ["touchend", "touchmove", "touchcancel"]) {
        el.addEventListener(type, cancel, { passive: true });
      }
    });

    this.shadowRoot.querySelector(".page-add-btn")?.addEventListener("click", () => this._addPage());

    this.shadowRoot.querySelectorAll(".page-thumb-del").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._deletePage(parseInt(el.dataset.pageIdx));
      });
    });

    this._wirePageReorder();

    this._refreshSVG();

    // After the faces exist: the link starts at a shape `_refreshSVG` draws.
    this._wireGotoLinks();

    // Config panel wiring
    if (this._selectedButtonIdx >= 0) {
      const selBtn = bp.buttons[this._selectedButtonIdx];
      this._wireButtonConfigPanel(bp, selBtn);
    } else {
      this._wirePageSettingsPanel(bp);
    }
  },

  /**
   * Where a dragged page would land, as an index into the reordered list.
   *
   * Measured against the thumbs' midpoints rather than asking which thumb is
   * under the pointer. "Which thumb" cannot answer the only question a reorder
   * asks -- before it or after it -- which is why the old blue tint on the
   * hovered thumb told the user nothing they could act on.
   *
   * Reading rects instead of elements is also what makes the slot *after the
   * last page* addressable. There is no element there to hover, so the old
   * handler could only ever drop onto the final thumb and let splice decide.
   *
   * `rects` is in page order and excludes the add button, which shares the
   * strip but is not a page. Returns an index in the list as it will be once
   * the move is applied, which is what `_reorderPage` takes.
   */
  _pageDropIndex(clientX, rects, dragIdx) {
    let before = 0;
    while (before < rects.length) {
      const r = rects[before];
      if (clientX < r.left + r.width / 2) break;
      before++;
    }
    // `before` counts the thumbs the pointer has passed, the dragged one
    // included. It is still occupying a slot it is about to vacate, so once
    // the pointer is past it every count is one too high.
    return before > dragIdx ? before - 1 : before;
  },

  /**
   * How far one thumb slides to open the gap, in px.
   *
   * Taking an item out at `dragIdx` and putting it back at `dropIdx` displaces
   * everything in between by exactly the dragged item's own outer width --
   * whatever the others happen to measure. So one `shift`, read once at
   * dragstart, drives the whole strip, and nothing has to be re-measured while
   * the pointer moves.
   *
   * The two directions are not symmetric: dragging right, the passed-over
   * thumbs close up behind it; dragging left, they open ahead of it. Hence the
   * half-open ranges -- `dropIdx` itself moves in one case and not the other.
   *
   * The dragged thumb travels too, across the slots it passes. A native drag
   * leaves the source element in place at reduced opacity, so without this the
   * strip shows two holes -- one where the thumb still sits and one where it is
   * going -- and neither reads as the answer. Moved, there is one picture: the
   * row in its prospective order, with the thumb ghosted on its landing slot.
   * This is the one step that assumes the thumbs are equal width, which
   * `.page-thumb`'s fixed 180px makes true; the displaced thumbs above do not.
   */
  _pageDragShift(idx, dragIdx, dropIdx, shift) {
    if (idx === dragIdx) return (dropIdx - dragIdx) * shift;
    if (idx > dragIdx && idx <= dropIdx) return -shift;
    if (idx < dragIdx && idx >= dropIdx) return shift;
    return 0;
  },

  /**
   * Drag-to-reorder for the pages strip, with the landing slot shown as a gap.
   *
   * The strip, not each thumb, listens for `dragover` and `drop`: a gap at the
   * end of the row has no thumb over it, and per-thumb handlers also left the
   * padding between thumbs dead.
   *
   * The offset is written as a custom property rather than an inline
   * `transform`, which would outrank -- and so silently discard --
   * `.page-thumb.subpage`'s own `translateY(7%)` and the hover scale. See the
   * `--pg-shift` rules in the stylesheet.
   */
  _wirePageReorder() {
    const strip = this.shadowRoot.querySelector(".pages-list");
    if (!strip) return;
    const thumbs = () => Array.from(strip.querySelectorAll(".page-thumb[draggable]"));

    let dragIdx = null;
    let shift = 0;
    let dropIdx = null;
    // The thumbs' slots, measured once while the row is still untransformed,
    // and the scroll offset that measurement was taken at.
    //
    // Re-reading them per dragover would feed this its own output: the gap is
    // drawn with transforms, and a transformed element reports the moved box.
    // The slots the pointer is being compared against are the ones the row
    // will settle into, which do not change during a drag -- only the scroll
    // does, and that is one subtraction.
    let slots = [];
    let scrollAt = 0;
    // The pending dragover frame, and the pointer position it will read. Held
    // outside the handler so `clear()` can cancel a frame that would otherwise
    // paint a drag that has already ended.
    let rafId = null;
    let lastX = 0;

    const paint = (to) => {
      if (dragIdx === null || to === dropIdx) return;
      dropIdx = to;
      thumbs().forEach((t, i) => {
        const dx = this._pageDragShift(i, dragIdx, to, shift);
        t.style.setProperty("--pg-shift", `${dx}px`);
      });
    };
    const clear = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      thumbs().forEach(t => t.style.removeProperty("--pg-shift"));
      dragIdx = null;
      dropIdx = null;
      slots = [];
    };

    thumbs().forEach(el => {
      el.addEventListener("dragstart", (e) => {
        dragIdx = parseInt(el.dataset.pageIdx);
        dropIdx = dragIdx;
        slots = thumbs().map(t => {
          const b = t.getBoundingClientRect();
          return { left: b.left, width: b.width };
        });
        scrollAt = strip.scrollLeft;
        // The gap between thumbs travels with them, so the slot a thumb
        // vacates is its own width plus one gap.
        shift = slots[dragIdx].width + this._stripGap(strip);
        el.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        clear();
      });
    });

    strip.addEventListener("dragover", (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      // dragover fires far faster than the strip can be repainted, and each one
      // used to re-query every thumb and rescan the slots. The pointer is read
      // here, where the event is still live, and the work is folded into the
      // next frame -- so a burst of events costs one pass, not one each.
      lastX = e.clientX;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (dragIdx === null) return;
        this._autoScrollStrip(strip, lastX);
        // Back into the frame the slots were measured in: scrolling the strip
        // right by d moves its content left by d, so a fixed slot's clientX
        // falls by d and has to be given back.
        const x = lastX + (strip.scrollLeft - scrollAt);
        paint(this._pageDropIndex(x, slots, dragIdx));
      });
    });

    strip.addEventListener("drop", (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      const from = dragIdx;
      const to = dropIdx;
      // The row is frozen for the length of the swap. `.page-thumb` transitions
      // its transform, so dropping the offsets starts a 150ms slide back to
      // the arrangement the drag began with -- which plays out *after* the DOM
      // has already been reordered, so the card the user just placed visibly
      // travels back to where it came from and settles again. Nothing here is
      // an animation worth keeping: the move is instant and correct, and the
      // transition only had the old positions to animate from.
      strip.classList.add("reordering");
      // Transforms are dropped before the move, not after: the re-render
      // replaces these elements, and a shifted thumb left behind for a frame
      // is the flicker the gap exists to avoid.
      strip.querySelectorAll(".page-thumb").forEach(t => t.classList.remove("dragging"));
      clear();
      if (to !== null && from !== to) this._reorderPage(from, to);
      // Commit the reordered, unshifted row while transitions are still off,
      // then let them back in for ordinary hovers. Reading a layout property
      // is what forces that commit; without it the class could go away in the
      // same frame it was added and change nothing.
      void strip.offsetWidth;
      requestAnimationFrame(() => strip.classList.remove("reordering"));
    });
  },

  /** The strip's own `gap`, in px, falling back to the stylesheet's 12. */
  _stripGap(strip) {
    const raw = getComputedStyle?.(strip)?.columnGap || "";
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 12;
  },

  /**
   * Scroll the strip when a drag nears either edge.
   *
   * The strip is `overflow-x: auto` with fixed-width thumbs, so past about five
   * pages the target is off-screen -- and a native drag does not scroll its
   * container on its own in every browser, which made those pages unreachable
   * by drag at all.
   */
  _autoScrollStrip(strip, clientX) {
    const r = strip.getBoundingClientRect?.();
    if (!r || strip.scrollWidth <= strip.clientWidth) return;
    const EDGE = 40;
    const STEP = 18;
    if (clientX < r.left + EDGE) strip.scrollLeft -= STEP;
    else if (clientX > r.right - EDGE) strip.scrollLeft += STEP;
  },

  _wirePageSettingsPanel(bp) {
    // --- Title image wiring ---
    //
    // The same media field as the button image and the tooltip: one text box
    // that saves on Enter or blur. The value is stored as typed — "Kitchen"
    // stays "Kitchen", because the device draws anything that is not a media
    // source as text, and a `text:` the user never typed must not appear in
    // the box the next time it opens.
    const normalizeTitle = (raw) => (raw || "").trim();

    const saveTitle = async (raw) => {
      const page = this._pages[this._currentPageIdx];
      if (!page) return;
      const newImgTitle = normalizeTitle(raw);
      if (newImgTitle === (page.image || "")) return;
      const updateMsg = {
        type: "lizaip_config/update_page", entry_id: this._currentEntry,
        page_id: page.id, image: newImgTitle,
      };
      try {
        const result = await this._hass.callWS(updateMsg);
        if (result?.pages) this._pages = result.pages;
      } catch (e) {
        page.image = newImgTitle;
      }
      this._render();
    };

    // The stored title verbatim, whatever shape it has, so it can be copied
    // out and pasted into another field as is.
    const titlePage = this._pages[this._currentPageIdx];
    this._mountIconPicker(
      this.shadowRoot.querySelector("#ps-icon-picker-slot"),
      titlePage?.image || "",
      (picked) => saveTitle(picked),
      this._pageDeviceOption(titlePage),
    );

    this.shadowRoot.querySelector("#psLayoutTarget")?.addEventListener("click", () => {
      const page = this._pages[this._currentPageIdx];
      if (page?.layout?.type) this._changeLayoutTarget(page);
    });

    // --- Color picker wiring ---
    const colorInput = this.shadowRoot.querySelector("#psColorInput");
    const colorClear = this.shadowRoot.querySelector("#psColorClear");

    const saveColor = async (hexVal) => {
      const page = this._pages[this._currentPageIdx];
      // Strip # and normalize to uppercase 6-char hex
      const clean = (hexVal || "").replace(/^#/, "").toUpperCase().slice(0, 6);
      const changed = clean !== (page.default_color || "");
      if (!changed) return;
      const updateMsg = { type: "lizaip_config/update_page", entry_id: this._currentEntry, page_id: page.id, default_color: clean };
      try {
        const result = await this._hass.callWS(updateMsg);
        if (result?.pages) this._pages = result.pages;
      } catch (e) {
        page.default_color = clean;
      }
      this._render();
    };

    this.shadowRoot.querySelectorAll(".ps-color-dot").forEach(dot => {
      dot.addEventListener("click", () => {
        const page = this._pages[this._currentPageIdx];
        const clicked = (dot.dataset.color || "").replace(/^#/, "").toUpperCase();
        const selected = (page?.default_color || "").replace(/^#/, "").toUpperCase();
        // Clicking the active swatch toggles back to "follow theme" (default).
        saveColor(clicked && clicked === selected ? "" : clicked);
      });
    });
    const colorNative = this.shadowRoot.querySelector("#psColorNative");
    if (colorNative) {
      colorNative.addEventListener("input", () => saveColor(colorNative.value));
    }
    if (colorInput) {
      colorInput.addEventListener("change", () => {
        let val = colorInput.value.trim();
        if (val && !val.startsWith("#")) val = "#" + val;
        const hex = val.replace(/^#/, "");
        // Empty is not an error: it is how the page goes back to following the
        // theme, and the clear button does exactly the same thing.
        if (!hex) { this._clearFieldError(colorInput); saveColor(""); return; }
        if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
          // The text stays in the field. Re-rendering it away would destroy
          // the evidence along with the mistake, and a correction is usually
          // one character.
          this._setFieldError(colorInput, this._t("invalid_hex"));
          return;
        }
        this._clearFieldError(colorInput);
        saveColor(val);
      });
    }
    if (colorClear) {
      colorClear.addEventListener("click", () => saveColor(""));
    }

    this.shadowRoot.querySelector(".ps-move-up")?.addEventListener("click", () => {
      this._reorderPage(this._currentPageIdx, this._currentPageIdx - 1);
    });
    this.shadowRoot.querySelector(".ps-move-down")?.addEventListener("click", () => {
      this._reorderPage(this._currentPageIdx, this._currentPageIdx + 1);
    });

    this.shadowRoot.querySelector(".ps-unassign-all")?.addEventListener("click", () => {
      if (!confirm(this._t("unassign_all_confirm"))) return;
      const allBtns = bp.buttons.filter(b => b.key !== "slider_horizontal");
      for (const b of allBtns) delete this._assignments[b.key];
      // The context button was among those just deleted, so the selection it
      // named no longer exists. Nested overrides went with their grid buttons,
      // which is what "unassign all" means here.
      this._revalidateContext();
      this._scheduleAutoSave();
      this._editorEl = null;
      this._sequence = [];
      this._render();
    });

    this.shadowRoot.querySelector(".ps-delete-page")?.addEventListener("click", () => this._deletePage(this._currentPageIdx));
  },

  _wireButtonConfigPanel(bp, selBtn) {
    // Seed the change test with what this card was *just built from*. Without
    // this it would carry the previously selected button's entity, and the
    // sections would silently fail to appear whenever the new button ended up
    // pointing at that same entity — the card was rendered while it was still
    // empty, so "unchanged" would be true of the entity and false of the DOM.
    this._lastSectionsEntity = this._entityOfSelectedButton();

    Promise.resolve(this._mountEditor("button-editor-container"))
      .then(() => this._mountLongtouchEditor?.("button-longtouch-editor-container"));

    // Tooltip input -- the same field as the Image above it, committed the
    // same way: on Enter or on leaving the field, never per keystroke, so a
    // half-typed name is not drawn on the remote. Escape puts it back.
    const labelInput = this.shadowRoot.querySelector(".config-label-input");
    if (labelInput && !labelInput.disabled) {
      const commit = (typed) => {
        const appr = this._sliderAppearanceTarget(selBtn.key);
        if (appr?.scoped) {
          const rec = this._assignments[appr.key] || (this._assignments[appr.key] = {});
          // Empty is the inherit spelling, as with every other slider axis on a
          // grid button: storing "" would pin a blank label over the control's
          // own name.
          if (typed) rec[appr.nameKey] = typed;
          else delete rec[appr.nameKey];
          this._scheduleAutoSave();
          this._refreshSVG();
          this._render();
          return;
        }
        const assign = this._editAssignEnsure(selBtn.key);
        // `typed` arrives trimmed: the box's surrounding whitespace is not part
        // of any name, and storing it left the field re-rendering as the
        // derived label with the stray spaces still on the end.
        assign.label = typed;
        // The field is drawn as `prefix + stored`, so its value is exactly what
        // the remote should print — room name included if it was left in, gone
        // for good if it was deleted. `label_edited` is what makes the ladders
        // print it verbatim; `_labelEdited` is the session-only twin the render
        // path uses and `_saveAssignments` strips.
        //
        // Emptying the field is the exception: it names nothing, so it asks for
        // the derived label back rather than claiming a blank one, and releases
        // the claim the way ↺ does.
        if (typed) assign.label_edited = true;
        else delete assign.label_edited;
        assign._labelEdited = true;
        this._scheduleAutoSave();
        this._render();
      };
      this._wireMediaInput(
        labelInput,
        labelInput.parentElement?.querySelector?.(".liza-media-suggest") || null,
        commit,
        {
          ...this._pageDeviceOption(),
          ...this._labelTokenOptions(
            this._editAssign(selBtn.key)?.config,
            this._actions.find(a => a.id === this._editAssign(selBtn.key)?.action_id)?.service || "",
          ),
        },
      );
    }
    this.shadowRoot.querySelector(".config-label-reset")?.addEventListener("click", () => {
      const assign = this._editAssign(selBtn.key);
      if (!assign) return;
      const action = assign.action_id ? this._actions.find(a => a.id === assign.action_id) : null;
      const entity = assign.config ? this._getTargetEntityFromConfig(assign.config) : null;
      assign.label = this._computeLabel(action, entity, assign.config) || "";
      delete assign._labelEdited;
      // Reset hands the label back to the ladders, which is the way back to a
      // live, entity-prefixed label after an edit froze one. Leaving the flag
      // set would pin the derived text as if it had been typed.
      delete assign.label_edited;
      this._scheduleAutoSave();
      this._render();
    });

    // --- Slider config UI event handlers ---
    // Gated on the same predicate that renders the card, so the two cannot
    // drift. It was gated on the presence of the Behavior chip row, which was
    // load-bearing by accident: removing that row would have silently unwired
    // every handler below it — entity picker, control select, sensitivity, icon
    // and label — leaving a card that renders correctly and responds to nothing.
    if (isSliderBtn(selBtn.key)) {
      // Which record this card's fields belong to. The card renders one body, so
      // the wiring branches once, here, instead of every handler asking.
      //
      // The page slot deliberately, not the edit slot: the slider subject,
      // The control name and `slider_factor` belong to the grid button
      // itself, not overrides, so routing them through `_editAssign` would bury
      // them in `overrides` where nothing reads them.
      const ctxKey = (selBtn.key === SLIDER_VERTICAL_KEY && this._liveContextKey())
        ? this._liveContextKey() : null;
      const ctxAssign = () => ctxKey
        ? (this._assignments[ctxKey] || (this._assignments[ctxKey] = {}))
        : null;
      const pageFactor = (() => {
        const raw = this._assignments[SLIDER_VERTICAL_KEY]?.slider_actions?.factor;
        return typeof raw === "number" && isFinite(raw) ? raw : 1.0;
      })();

      // Creates the mechanics blob on the first real edit, and stamps the mode
      // that the Behavior row used to stamp. Without it a fresh slider would be
      // written with fields but no `mode`, and every gate that requires one
      // (isConfigured, _isButtonAssigned, store._is_empty_button, the WS
      // _sanitize_slider_actions) would drop it on save — the card would accept
      // an entity and lose it. `factor` is defaulted here for the same reason:
      // the Sensitivity field renders 1.0 whether or not it is stored, so
      // leaving it unset would show a value the config does not contain.
      const ensureSliderActions = () => {
        const assign = this._editAssignEnsure(selBtn.key);
        if (!assign.slider_actions) assign.slider_actions = {};
        const sa = assign.slider_actions;
        if (sa.mode !== "proportional") sa.mode = "proportional";
        if (sa.factor == null) sa.factor = 1.0;
        return sa;
      };

      // A last-touched slider resolves its mechanics from the touched device at
      // gesture time, so the stored ones are not merely unused — leaving them
      // would let the backend read a stale target_entity and pin the slider to
      // it forever. The save path drops them too; dropping them here as well
      // keeps the in-memory config honest about what runs.
      const stripSliderMechanics = (sa) => {
        delete sa.target_entity;
        delete sa.attribute;
        delete sa.service;
        delete sa.data_key;
        delete sa.min;
        delete sa.max;
      };

      // The one writer for the Entity field, so the target and the field can
      // never disagree about whether a default exists.
      //
      // Every path through it writes a *whole* control set or none at all: the
      // old mechanics are stripped first and the new ones derived together from
      // the entity's live state. Updating them in place would let a lamp's
      // 0-255 range survive onto a speaker — the bug `_resolve_selection_config`
      // is written to make unreachable, which the panel must not reintroduce by
      // handing storage a half-written blob in the first place.
      const setSliderDefault = (sa, entityId) => {
        const id = (entityId || "").trim();
        const st = id ? this._hass?.states?.[id] : null;
        const available = id ? controlsForEntity(this._sliderControls, id, st) : [];
        // Keep the control the slider already expressed if the new entity still
        // supports it: a hand-picked colour temperature must not snap back to
        // brightness just because the lamp changed. Read before the strip.
        const previous = matchControl(this._sliderControls, sa);
        const control = previous && available.includes(previous) ? previous : available[0];

        // An explicit pin is hand-written and unspellable here, so re-picking
        // its entity must not quietly convert it to a following slider — that
        // would make the escape hatch destroyable by the one edit its own card
        // still offers.
        const pinned = sa.target === SLIDER_TARGET_ENTITY;

        stripSliderMechanics(sa);
        if (!control) {
          // Empty field, or an entity with nothing a slider can drive. Either
          // way there is no default — and no half of one.
          if (pinned) sa.target = SLIDER_TARGET_ENTITY;
          else delete sa.target;
          return;
        }
        sa.target_entity = id;
        applyControl(sa, control, st);
        // Following is the absence of `target`; only a pin is ever stored.
        if (!pinned) delete sa.target;
      };


      // One entity field, one writer. It had a second: the pinned card wrote
      // `target_entity` directly and re-derived the mechanics *only when the
      // domain changed*, on the theory that within a domain the user's choices
      // should survive. That is a field-by-field author — it leaves the old
      // range in place beside a new entity — and it is the whole-set bug
      // waiting for a lamp and a lamp of a different range. `setSliderDefault`
      // derives the set together or writes none of it, which makes the
      // preserve-the-user's-control intent explicit instead of accidental.
      // Choosing a device is what opts a grid button in, so one writer owns the
      // whole slider block -- subject and control together. Named, because the
      // "use <device>" shortcut in the hint writes exactly the same thing and
      // the two must not drift.
      const applyCtxEntity = (raw) => {
        const assign = ctxAssign();
        if (!assign) return;
        const chosen = typeof raw === "string" ? raw.trim() : "";
        // The whole axis, in one writer. Naming a device opts the button in;
        // clearing the field opts it out.
        // A control is a capability of the entity, so it cannot outlive a
        // change of device -- kept, it would ask a speaker for colour
        // temperature. Dropping the subject drops the block entire, so the
        // control goes with it either way.
        setSliderSubject(assign, chosen || null);
        setSliderControl(assign, "");
        this._scheduleAutoSave();
        this._render();
      };

      const entityContainer = this.shadowRoot.querySelector(".slider-entity-picker-container");
      if (entityContainer) {
        if (ctxKey) {
          // What the user chose, and nothing else. Falling back to the device
          // derived from the button's own action filled the field on a page
          // nobody had configured -- opening the card looked like reading back a
          // setting that had never been made. The derived device is offered as a
          // link in the hint instead: one click, but it has to be asked for.
          const cur = sliderSubjectEntity(ctxAssign()) || "";
          this._mountEntityPicker(entityContainer, cur, applyCtxEntity);
        } else {
          const sa0 = this._editAssign(selBtn.key)?.slider_actions || {};
          this._mountEntityPicker(entityContainer, sa0.target_entity || "", (next) => {
            setSliderDefault(ensureSliderActions(), next);
            this._scheduleAutoSave();
            this._render();
          });
        }
      }

      // The suggestion fills the field in rather than being a second way to say
      // the same thing, so it goes through the picker's writer. A handler of its
      // own here is how the two would come to disagree about what "chosen"
      // writes.
      const sliderCtxUseDefault = this.shadowRoot.querySelector(".slider-ctx-use-default");
      if (sliderCtxUseDefault) {
        sliderCtxUseDefault.addEventListener("click", () => {
          applyCtxEntity(sliderCtxUseDefault.dataset.entity || "");
        });
      }

      // Picking a control writes all five mechanics at once, the way HA's
      // `light-brightness` feature does internally.
      const applyControlById = (id) => {
        const c = (this._sliderControls || []).find(x => x.id === id);
        // The only non-control option is the disabled placeholder, which
        // cannot be selected — so there is no other branch to handle.
        if (!c) return;
        const sa = ensureSliderActions();
        applyControl(sa, c, this._hass?.states?.[sa.target_entity]);
        this._scheduleAutoSave();
        this._render();
      };
      const sliderControlSelect = this.shadowRoot.querySelector(".slider-control-select");
      if (sliderControlSelect) {
        sliderControlSelect.addEventListener("change", () => {
          if (!ctxKey) return applyControlById(sliderControlSelect.value);
          // A control *id* on the grid button, never mechanics — there is
          // nothing here that could be written down by halves, which is what
          // keeps the whole-set rule out of this field entirely. The first
          // option is the derived choice, so choosing it DELETES the key rather
          // than storing the id it happens to show; read off the select's own
          // first option, so the rule cannot disagree with what is on screen.
          const assign = ctxAssign();
          if (!assign) return;
          const id = sliderControlSelect.value;
          const derivedId = sliderControlSelect.options[0]?.value;
          setSliderControl(assign, id && id !== derivedId ? id : "");
          this._scheduleAutoSave();
          this._render();
        });
      }

      // The way back from a hand-edit. Without it, one typo in Service made
      // matchControl fail permanently: Control fell to the disabled placeholder
      // and the only recovery was retyping the preset's five values from
      // memory. Same code path as picking the control, so they cannot drift.
      const sliderResetControl = this.shadowRoot.querySelector(".slider-reset-control");
      if (sliderResetControl) {
        sliderResetControl.addEventListener("click", () => applyControlById(sliderResetControl.dataset.control));
      }

      // The Advanced mechanics fields all do the same thing: read the input,
      // write one key, save. Table-driven so they cannot drift apart — as six
      // hand-written copies they already had, on whether they re-render.
      //
      // `render` is deliberately not uniform. attribute/service/data_key feed
      // matchControl, so editing one changes the Control field above them;
      // min/max feed the hint and the range warning. Sensitivity affects
      // nothing currently on screen, so re-rendering would only fight the
      // caret for no visible gain.
      // Every parse falls back to the *current stored value*, so no field can be
      // emptied into a hole. That is not merely tidy. Clearing Min/Max would
      // otherwise rewrite a 0-255 brightness range to the media_player-shaped
      // 0-1 and collapse the drag — and clearing Service was worse: the key was
      // dropped on save (the sanitiser omits empty strings on purpose, so that
      // `data_key` can default to `attribute`), and the executor's own fallback
      // is a hard-coded `media_player.volume_set`, which it then fired at a
      // lamp with `brightness: 255`. Clearing Attribute killed the slider
      // outright, silently.
      //
      // These are the mechanics the whole-set rule governs: they only mean
      // anything together, and the fallback branch of `_resolve_selection_config`
      // hands this blob back verbatim as a *complete* control. A field that can
      // be blanked is a way to author the partial that rule exists to prevent,
      // so the way to clear one is to pick a different Control, which rewrites
      // them as a set.
      const SLIDER_FIELDS = [
        [".slider-attribute-input", "attribute", (v, cur) => v.trim() || cur, true],
        [".slider-service-input",   "service",   (v, cur) => v.trim() || cur, true],
        [".slider-datakey-input",   "data_key",  (v, cur) => v.trim() || cur, true],
        [".slider-factor-input",    "factor",    (v, cur) => num(v, num(cur, 1.0)), false],
        [".slider-min-input",       "min",       (v, cur) => num(v, num(cur, 0)),   true],
        [".slider-max-input",       "max",       (v, cur) => num(v, num(cur, 1)),   true],
      ];
      SLIDER_FIELDS.forEach(([sel, key, parse, render]) => {
        const el = this.shadowRoot.querySelector(sel);
        if (!el) return;
        el.addEventListener("change", () => {
          // Sensitivity is the one field of this set that can belong to a
          // selected button: the executor carries `factor` across a retarget
          // untouched, so a per-button value is something it can act on. The
          // rest are re-derived from the live entity on every gesture, which is
          // why they are not on the card at all under a selection.
          if (ctxKey && key === "factor") {
            const assign = ctxAssign();
            if (!assign) return;
            const next = parseFloat(el.value);
            // Not clamped -- that would save a number nobody typed -- but no
            // longer silent either: the value used to be re-rendered away.
            if (!isFinite(next)) {
              this._setFieldError(el, this._t("invalid_number"));
              return;
            }
            if (next < FACTOR_MIN || next > FACTOR_MAX) {
              this._setFieldError(el, this._t("invalid_range", { min: FACTOR_MIN, max: FACTOR_MAX }));
              return;
            }
            this._clearFieldError(el);
            // Written only when it differs from the page's. The field is
            // pre-filled with the inherited value, so "no change" is by far the
            // commonest way to leave it, and tabbing through must not
            // manufacture an override.
            if (next === pageFactor) delete assign.slider_factor;
            else assign.slider_factor = next;
            this._scheduleAutoSave();
            this._render();
            return;
          }
          const sa = ensureSliderActions();
          // A browser blanks `.value` when a number field holds text it cannot
          // parse, so the rejected text has to be detected through validity.
          if (badNumber(el)) {
            this._setFieldError(el, this._t("invalid_number"));
            return;
          }
          const raw = el.value.trim();
          if (key === "factor" && raw) {
            const n = Number(raw);
            if (n < FACTOR_MIN || n > FACTOR_MAX) {
              this._setFieldError(el, this._t("invalid_range", { min: FACTOR_MIN, max: FACTOR_MAX }));
              return;
            }
          }
          // An inverted range is the one error here that needs both fields to
          // spot, and it is silently destructive: a slider whose maximum sits
          // below its minimum has no usable travel at all.
          if (key === "min" || key === "max") {
            const minEl = this.shadowRoot.querySelector(".slider-min-input");
            const maxEl = this.shadowRoot.querySelector(".slider-max-input");
            // Judged as a pair, so unparsable text in a sibling is dangerous:
            // the browser blanks `.value`, `num(...)` substitutes the stored
            // number, and the clears below then withdraw an error whose text
            // is still wrong. 3.3.1 wants it reported until it is fixed.
            const stillBad = badNumber(minEl) ? minEl : badNumber(maxEl) ? maxEl : null;
            if (stillBad) {
              this._setFieldError(stillBad, this._t("invalid_number"));
              return;
            }
            const lo = num(minEl?.value, num(sa.min, 0));
            const hi = num(maxEl?.value, num(sa.max, 1));
            if (Number.isFinite(lo) && Number.isFinite(hi) && hi <= lo) {
              this._setFieldError(el, this._t("invalid_min_max"));
              return;
            }
            this._clearFieldError(minEl);
            this._clearFieldError(maxEl);
          }
          this._clearFieldError(el);
          sa[key] = parse(el.value, sa[key]);
          this._scheduleAutoSave();
          if (render) this._render();
        });
      });

      const sliderFactorReset = this.shadowRoot.querySelector(".slider-factor-reset");
      if (sliderFactorReset) {
        sliderFactorReset.addEventListener("click", () => {
          const assign = ctxAssign();
          if (!assign) return;
          delete assign.slider_factor;
          this._scheduleAutoSave();
          this._render();
        });
      }
    }


    this._wireButtonEntitySections(bp, selBtn);

    // "Page default": drop the context but keep the same button selected, so
    // the card switches from the override to the default in place. Today's
    // behaviour stays reachable without deselecting the grid button, which is
    // the other half of the accidental-override mitigation.
    this.shadowRoot.querySelector(".ctx-page-default")?.addEventListener("click", () => {
      this._flushAutoSave();
      this._contextKey = null;
      const assign = this._editAssign(selBtn.key);
      this._sequence = this._cycleSequence(assign, selBtn.key);
      this._editorEl = null;
      this._render();
    });
  },

  // The button's entity lives inside the action editor, so it changes without
  // anything on the card being touched. `_onSequenceChanged` cannot answer that
  // with `_render()`: `_renderDeviceConfig` replaces the whole shadow root and
  // `_mountEditor` then clears its container and constructs a *new*
  // `ha-automation-action` — asynchronously, behind `_loadHaComponents()`. The
  // editor would collapse and lose focus on every change event, which is why
  // the original only refreshed the SVG and why the entity-derived sections
  // never appeared until the button was reselected.
  //
  // So rebuild only that subtree. The HTML comes from `_htmlButtonConfigPanel`
  // itself rather than a second builder: every gate those sections have —
  // `pageSliderFollows`, `isSliderBtn`, an empty `available`, `showImage`,
  // `actionStates.length` — is therefore evaluated by the same code that
  // evaluates it on a full render, and cannot drift into resurrecting a section
  // that should stay hidden. The rest of the produced markup is discarded; it
  // is string building, and the editor in it is never mounted.
  // A mixin method, not a closure. It was a `const` inside
  // `_wireButtonConfigPanel`, which was fine while the page-level Entity field
  // was its only caller -- and a blank panel the moment the context card
  // wanted one too, because `_wireButtonEntitySections` is a different method
  // and the name simply was not in scope there. A ReferenceError during wiring
  // takes the whole view down, so this is promoted rather than copied: two
  // pickers that drift on domain filtering or the hass-not-ready fallback
  // would be the same bug in slow motion.
  // HA's native entity picker (search, icons, state, area) — same pattern
  // as the layout dialog. Free text made it trivial to type a typo that
  // only surfaced at runtime.
  //
  // Kept as a named unit rather than inlined into its one caller: it owns
  // the domain filtering and the hass-not-ready degradation, neither of
  // which is about the field it happens to be mounted in.
  _mountEntityPicker(container, value, onChange, opts = {}) {
    // The field's name. A label outside a shadow root cannot name the control
    // inside it, so it goes on the picker, which renders it itself.
    const entityLabel = opts.label || this._t("entity");
    if (this._hass) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      // Only domains a slider can actually drive. Unfiltered, the picker
      // offered sensor.*, automation.* and friends — none of which have a
      // readable attribute plus a matching *_set service — and choosing one
      // landed on "No presets for sensor", a dead end dressed as guidance.
      // Filtering makes that state unreachable instead of merely explained.
      // Callers that drive something other than a slider say so; the slider
      // filter is this helper's default, not a fact about every entity field.
      const doms = opts.includeDomains !== undefined
        ? opts.includeDomains : sliderDomains(this._sliderControls);
      if (doms) picker.includeDomains = doms;
      picker.label = entityLabel;
      picker.allowCustomEntity = true;
      picker.value = value;
      container.appendChild(picker);
      picker.addEventListener("value-changed", (ev) => onChange(ev.detail.value || ""));
      return;
    }
    // hass not ready yet — degrade to text rather than an empty box.
    // Distinct class: reusing .slider-service-input would collide with the
    // Service field below, and since this container renders first,
    // querySelector would bind the Service handler to this input. The card no
    // longer draws a label for this field -- the picker names itself -- so the
    // fallback has to carry the name too, or it is an unlabelled text box.
    container.innerHTML =
      `<input type="text" class="slider-entity-fallback" aria-label="${this._esc(entityLabel)}" value="${this._esc(value)}" placeholder="light.living_room" />`;
    container.querySelector("input")
      .addEventListener("change", (ev) => onChange(ev.target.value.trim()));
  },

  /**
   * The tile's own menu: move this button's configuration elsewhere, or clear
   * it. Opened by right-click, or by long-press on a touch screen.
   *
   * Until now the only route to either was the card — the ✕ in its header, an
   * anonymous glyph on a card the user has to open first, which meant clearing
   * a button was discoverable only by having already found it. This puts both
   * actions on the thing they act on, with words on them rather than symbols.
   *
   * It does neither itself. Clear selects the button and runs
   * `_unassignButton`, which is what the ✕ used to run — so the override
   * rules, which depend on what is in context at the moment of the clear,
   * apply here unchanged. Move only *arms* the move; the second gesture picks
   * the destination, and `_moveButtonTo` owns what that means.
   *
   * Offered only where there is something to act on: an empty tile gets no
   * menu at all rather than a menu with two dead items in it.
   */
  /**
   * Is there a configuration here a move could pick up? The one predicate
   * behind both routes to a move, so the menu item and the drag cannot
   * disagree. The title bar is not a button and has no assignment.
   */
  _canMoveButton(key) {
    if (!isMovableSlot(key)) return false;
    return this._isAssignedRecord(this._editAssign(key) || {});
  },

  /**
   * Could a move from `fromKey` land on `toKey`? The drag asks this per slot
   * to keep the ring honest: `_moveButtonTo` refuses ends that resolve to
   * different containers, and a ring that promised otherwise would lie.
   */
  _canDropButtonOn(fromKey, toKey) {
    if (!isMovableSlot(toKey)) return false;
    // Mirrors `_editContainer`'s branching without its `create`, so merely
    // hovering a fixed button cannot leave an override table behind.
    const contextKey = this._liveContextKey();
    if (!contextKey) return true;
    const scoped = OVERRIDABLE_FIXED_BUTTONS.has(toKey);
    if (scoped !== OVERRIDABLE_FIXED_BUTTONS.has(fromKey)) return false;
    return !scoped || !!this._assignments?.[contextKey];
  },

  _showFaceMenu(btn, ev) {
    this._closeFaceMenu();
    if (!this._canMoveButton(btn?.key)) return;
    const root = this.shadowRoot;
    if (!root) return;
    // Where focus came from, so closing can put it back. Captured after the
    // _closeFaceMenu() above, which clears any stale token, and before the
    // menu takes focus below. Null when nothing focusable was active -- a
    // pointer user who never focused the tile -- and restoring null is a
    // no-op, which is the right answer for them.
    // The ellipsis is doing work: this item finishes nothing, it asks for a
    // second gesture, and an item that looks like it acts on click is how a
    // user ends up clicking it twice.
    this._openMenu(ev, [
      {
        cls: "face-menu-move",
        label: `${this._commonLabel("move", "Move")}…`,
        run: () => this._beginMove(btn.key),
      },
      {
        cls: "face-menu-clear",
        label: this._commonLabel("clear", "Clear"),
        run: () => {
          // `_selectButton` toggles: called on the button that is already open
          // it *deselects*, and the clear that follows would then find nothing
          // selected and do nothing at all. That is the common case, because
          // the tile you long-press is usually the one you just tapped.
          const idx = this._faceIdxFor(btn.key);
          if (idx >= 0 && this._selectedButtonIdx !== idx) this._selectButton(idx);
          this._unassignButton();
        },
      },
    ]);
  },

  /** The page strip's context menu: turn a page into a subpage, or back.
   *
   * A subpage is still a page -- it keeps its buttons, it is still reachable
   * from a Go to page action -- it just stops being offered in the remote's own
   * list of pages. That list is what the user pages through on the device, and
   * a page that only ever makes sense as the destination of a button does not
   * belong in it.
   *
   * It stays in this strip either way, tinted, because this is the editor: a
   * subpage that vanished from here could never be turned back.
   */
  _showPageMenu(idx, ev) {
    const page = this._pages?.[idx];
    if (!page) return;
    const isSub = !!page.subpage;
    // Most used first, the destructive one last and set apart. An ellipsis
    // only where the item asks for a choice before acting; a confirmation
    // does not count.
    this._openMenu(ev, [{
      cls: "face-menu-duplicate",
      label: this._t("duplicate_page"),
      run: () => this._duplicatePage(page),
    },
    // Only a page made from a layout has a device to change; a blank page's
    // buttons each name their own.
    ...(page.layout?.type ? [{
      cls: "face-menu-retarget",
      label: this._t(page.layout.target?.config_entry ? "change_hub" : "change_device"),
      run: () => this._changeLayoutTarget(page),
    }] : []), {
      cls: "face-menu-subpage",
      label: isSub ? this._t("make_mainpage") : this._t("make_subpage"),
      run: () => this._setPageSubpage(page, !isSub),
    }, { separator: true }, {
      cls: "face-menu-delete-page",
      label: this._t("delete_page"),
      // Looked up when chosen, not when opened: the list can be replaced in
      // between, and a stale index would delete a neighbour.
      run: () => {
        const at = this._pages.findIndex(p => p.id === page.id);
        if (at >= 0) this._deletePage(at);
      },
    }]);
  },

  /**
   * The hint under a page's title field. A layout page learns about
   * `${_device}`; what any variable reads now is said as on every picture field.
   */
  _pageTitleHint(page, raw) {
    const usesDevice = /\$\{[^{}]*(?<![\w.])_device\b/.test(raw || "");
    const parts = [];
    if (usesDevice || this._hasEntityToken(raw)) {
      const now = this._pageTitleImage(page);
      if (now) parts.push(this._t("label_now_reads", { text: this._esc(now) }));
    }
    if (page?.layout?.type) parts.push(this._t("title_device_hint"));
    // `${_device.attr}` reads like an entity variable but is explained above.
    if (this._hasEntityToken((raw || "").replace(/\$\{\s*_device\.\w+\s*\}/g, ""))) {
      parts.push(this._t("variable_hint"));
    }
    return parts.join(" ");
  },

  /** What a layout page's device or hub is called, for the page card.
   *
   * A device is named from `hass.devices` the way HA names it (the user's
   * rename first); a hub is a config entry, whose title the frontend does not
   * carry, so it is asked for once and the card redrawn when it arrives.
   */
  _layoutTargetName(page) {
    const target = page?.layout?.target || {};
    const name = this._layoutDeviceName(page);
    if (name) return name;
    if (target.config_entry && this._layoutEntryTitles?.[target.config_entry] === null) return "…";
    return target.entity_id || this._t("layout_target_missing");
  },

  /** Ask for the new device of a layout page and move the page to it.
   *
   * The same dialog that picked the device when the page was added, so the
   * same devices are on offer and the same ones are refused.
   */
  async _changeLayoutTarget(page) {
    const layoutId = page.layout.type;
    const meta = (await this._loadLayouts()).find(l => l.id === layoutId);
    if (!meta) {
      this._toast(this._t("layout_gone", { name: layoutId }));
      return;
    }
    const hub = !!meta.target_selector?.config_entry;
    const confirmLabel = this._t(hub ? "change_hub_confirm" : "change_device_confirm");
    try {
      await this._showLayoutEntityPicker(layoutId, meta, {
        confirmLabel,
        busyLabel: this._t("changing"),
        onConfirm: async (target, kind) => {
          const result = await this._retargetLayoutPage(page, target, kind);
          return this._t(hub ? "hub_changed" : "device_changed", {
            name: this._pageDisplayLine(page),
            n: result?.buttons_changed ?? 0,
          });
        },
      });
    } catch (e) {
      console.warn("[LIZA] Change device failed:", e);
      this._toast(this._t("layout_picker_failed"));
    }
  },

  /** Copy a page, buttons and all, and open the copy.
   *
   * The backend places it directly after the original and keeps its kind: a
   * subpage's copy is a subpage, so it does not suddenly join the remote's page
   * list. Going through `_createPage` flushes a pending edit first -- the copy
   * is of what the user sees, not of what was last saved.
   */
  async _duplicatePage(page) {
    try {
      const result = await this._createPage(() => this._hass.callWS({
        type: "lizaip_config/duplicate_page",
        entry_id: this._currentEntry,
        page_id: page.id,
      }));
      // The copy looks exactly like the page it came from; without a word the
      // only sign anything happened is one more thumbnail.
      if (result?.pages) this._toast(this._t("page_duplicated", { name: this._pageDisplayLine(page) }));
    } catch (e) {
      console.error("[LIZA] duplicate page failed:", e);
      this._toast(this._t("duplicate_page_failed", { error: e?.message || e }));
    }
  },

  /** Flip a page between main and subpage, and tell the remote.
   *
   * Written through `update_page` like the picture and the colour are, so the
   * same push to the device carries it -- there is no separate "page kind"
   * message to keep in step.
   */
  async _setPageSubpage(page, makeSub) {
    const msg = {
      type: "lizaip_config/update_page", entry_id: this._currentEntry,
      page_id: page.id, subpage: !!makeSub,
    };
    try {
      const result = await this._hass.callWS(msg);
      if (result?.pages) this._pages = result.pages;
      else page.subpage = !!makeSub;
    } catch (e) {
      // Same stance as the title and colour writes: keep what the user asked
      // for on screen rather than silently snapping back, and let the next
      // load reconcile.
      page.subpage = !!makeSub;
    }
    this._render();
  },

  /** Build, place and wire a context menu. Shared by the tile and page menus.
   *
   * The menu itself is the fiddly part -- it has to put focus back where it
   * found it, answer the arrow keys its `role="menu"` promises, and get out of
   * the way on the next click, resize or Escape. None of that differs between
   * the things a menu can be opened on, and a second copy of it is the kind of
   * code that drifts until only one of them restores focus.
   *
   * @param ev     The event that asked for the menu; supplies the position.
   * @param items  `{cls, label, run}` -- `cls` also names the hook the tests
   *               and the stylesheet use, so it is not decoration.
   * @param opts   `keepCase` leaves the labels as written. The tile and page
   *               menus borrow Home Assistant's lower-case verbs ("move",
   *               "clear"); the diagnostics menu names files in whole
   *               sentences, and lower-casing those reads as a typo.
   */
  _openMenu(ev, items, { keepCase = false, anchor = null } = {}) {
    this._closeFaceMenu();
    const root = this.shadowRoot;
    if (!root || !items?.length) return;
    // Where focus came from, so closing can put it back. Captured after the
    // _closeFaceMenu() above, which clears any stale token, and before the
    // menu takes focus below. Null when nothing focusable was active -- a
    // pointer user who never focused the tile -- and restoring null is a
    // no-op, which is the right answer for them.
    this._faceMenuReturn = this._a11yCaptureFocus?.() || null;

    const menu = document.createElement("div");
    menu.className = "face-menu";
    menu.setAttribute("role", "menu");
    // Lower-cased here rather than in the strings: "Move" and "Clear" are Home
    // Assistant's own translations, and the strings are reused outside menus.
    const lang = this._lang?.() || undefined;
    menu.innerHTML = items.map(it => it.separator
      ? `<div role="separator" class="face-menu-sep"></div>`
      // `cls` stays the one class the click wiring below looks the item up by;
      // how an item looks, and whether it can be pressed at all, rides on a
      // flag -- `danger`, `disabled` -- rather than on a second class name.
      : `<button type="button" role="menuitem" class="face-menu-item ${it.cls}`
        + `${it.danger ? " face-menu-item-danger" : ""}"${it.disabled ? " disabled" : ""}>`
        + (it.icon ? `<ha-icon icon="${it.icon}" aria-hidden="true"></ha-icon>` : "")
        + `<span>${keepCase ? String(it.label) : String(it.label).toLocaleLowerCase(lang)}</span></button>`).join("");
    // Measured rather than guessed. A fixed width allowance has to be wrong
    // in one direction or the other, and when it is too wide the menu opens a
    // hand's width from the button that asked for it.
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";
    root.appendChild(menu);
    const seps = items.filter(it => it.separator).length;
    // About 40px an item, 9 a separator, plus the frame -- the fallback for an
    // environment that reports no layout at all.
    const width = Number(menu.offsetWidth) || (keepCase ? 280 : 180);
    const height = Number(menu.offsetHeight) || ((items.length - seps) * 40 + seps * 9 + 10);

    // `position: fixed`, so viewport coordinates go straight on. An anchored
    // menu hangs off its button's right edge, which is where a ⋮ in a toolbar
    // puts it; everything else opens at the pointer.
    const rect = anchor?.getBoundingClientRect?.();
    const vw = Number(window?.innerWidth) || 0;
    const vh = Number(window?.innerHeight) || 0;
    const y = rect ? rect.bottom + 4 : Number(ev?.clientY) || 0;
    if (rect) {
      // Pinned rather than placed at the measured width: the icons are custom
      // elements and may still be empty here, so a menu grows after the
      // measurement and the toolbar's ⋮ pushed its labels off the window.
      menu.style.left = "auto";
      menu.style.right = `${Math.max(4, vw ? vw - rect.right : 0)}px`;
    } else {
      // Nudged back inside near an edge: the face sits in a scrolling column,
      // and a menu opened on the last row would otherwise extend the page.
      const x = Number(ev?.clientX) || 0;
      menu.style.right = "auto";
      menu.style.left = `${Math.max(4, vw ? Math.min(x, vw - width - 4) : x)}px`;
    }
    menu.style.top = `${Math.max(4, vh ? Math.min(y, vh - height - 4) : y)}px`;
    menu.style.visibility = "";

    const dismiss = () => this._closeFaceMenu();
    for (const it of items) {
      if (it.disabled) continue;
      menu.querySelector(`.${it.cls}`)?.addEventListener("click", () => {
        this._closeFaceMenu();
        it.run();
      });
    }
    // Anything else the user does puts it away. `once` on each, because the
    // menu is gone after the first of them and the listeners go with it.
    root.addEventListener("click", dismiss, { once: true });
    window.addEventListener?.("resize", dismiss, { once: true });
    window.addEventListener?.("keydown", this._faceMenuKey = (e) => {
      if (e.key === "Escape") { dismiss(); return; }
      // role="menu" advertises a keyboard contract -- arrows move between
      // items, Home/End jump to the ends -- and a screen reader in menu mode
      // hands those keys to the menu rather than the page. Without this the
      // roles promised navigation the markup did not implement; Tab worked
      // only because these are native buttons.
      const items = Array.from(menu.querySelectorAll(".face-menu-item:not([disabled])"));
      if (!items.length) return;
      const cur = items.indexOf(root.activeElement);
      let next;
      if (e.key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % items.length;
      else if (e.key === "ArrowUp") next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else return;
      e.preventDefault?.();
      items[next].focus?.();
    });

    this._faceMenuEl = menu;
    menu.querySelector(".face-menu-item:not([disabled])")?.focus?.();
  },

  /** Put the tile menu away, if one is open. Safe to call when none is. */
  _closeFaceMenu() {
    if (this._faceMenuKey) {
      window.removeEventListener?.("keydown", this._faceMenuKey);
      this._faceMenuKey = null;
    }
    const el = this._faceMenuEl;
    this._faceMenuEl = null;
    if (el?.parentNode) el.parentNode.removeChild(el);
    else if (el && this.shadowRoot) this.shadowRoot.removeChild?.(el);
    // Focus was moved into the menu when it opened, so removing the node
    // leaves activeElement on <body> -- the user's next Tab starts from the
    // top of the Home Assistant frontend, with nothing on screen saying why.
    // Only when a menu was really open: _showFaceMenu calls this first thing,
    // and that call must not move focus.
    const token = this._faceMenuReturn;
    this._faceMenuReturn = null;
    if (el && token && !this._a11yRestoreFocus?.(token)) this._a11yFocusFallback?.();
  },

  /** A verb from Home Assistant's own vocabulary, in the user's language.
   *
   * `ui.common.*` is part of the core translation bundle, loaded before any
   * panel is, so borrowing from it costs nothing and makes these items read
   * the way every other menu in the frontend does — including in the four
   * languages this integration ships but whose panel has only spoken English.
   * The fallback is for a `hass` that has not arrived yet, not for a missing
   * key.
   */
  _commonLabel(key, fallback) {
    const translated = this._hass?.localize?.(`ui.common.${key}`);
    return typeof translated === "string" && translated ? translated : fallback;
  },

  /**
   * What clicking a control on the face means, wherever the click came from.
   *
   * `slider_horizontal` is Page Settings, not a button: clicking it always
   * lands on the page card, so it deselects rather than selecting. It also
   * drops the context, because Page Settings is not a nested state and a face
   * still marked under it would be claiming otherwise.
   *
   * It is additionally the one control that *is* the page's title, so it is
   * what opens the title row on that card. Selecting a page thumbnail leaves
   * the row closed; this strip toggles it, which is the same "click the thing
   * again to put it away" every other control has.
   *
   * Everything else hands to `_selectButton`, including the click that
   * deselects. That delegation is the fix for a real bug: this used to clear
   * `_selectedButtonIdx` itself and return, which skipped `_selectButton`'s
   * context handling entirely — so deselecting a grid button on the face left
   * `_contextKey` set and the highlight stuck on with nothing selected. Two
   * implementations of "what deselect means", one of which forgot half the
   * state. One owner now — and that owner is why a click on an *inactive*
   * page's face can land on the button it hit rather than only on the page:
   * `_switchPageTo` replays the very same gesture once the page is current.
   *
   * @returns {boolean} Whether the key named a control — and so whether this
   *   rendered. A caller that has changed something else first (the page, in
   *   `_switchPageTo`'s case) has to draw that change itself when the answer is
   *   no, or a key naming nothing would leave the new page unpainted.
   */
  _selectFaceKey(key) {
    if (!key) return false;
    // A move is armed: this click is the second half of it, whatever it lands
    // on. Intercepted here rather than in each caller because this is the one
    // owner of "what clicking a control on the face means", and a move that
    // only completed on some routes would be a move that sometimes selected
    // instead. Clicking the armed button itself calls it off — the same "click
    // it again to put it away" every other control has.
    //
    // Everything else goes to `_moveButtonTo`, which already turns down every
    // slot that cannot hold a button record and says why. Naming one of them
    // here too was a second copy of that rule, and the two had drifted.
    if (this._moveSourceKey) {
      if (key === this._moveSourceKey) this._cancelMove();
      else this._moveButtonTo(key);
      return true;
    }
    if (key === "slider_horizontal") {
      // Toggled against the state it is actually in, not against a plain
      // `true`: arriving here from a selected grid button must *open* the row,
      // and that state has `_selectedButtonIdx >= 0` with the flag already
      // false.
      const wasOpen = this._selectedButtonIdx < 0 && this._pageTitleSelected;
      // Captured before the render that replaces it. The title row is an
      // editor like any config card, so it opens and closes the same way.
      if (!wasOpen) this._a11yRememberTrigger();
      this._selectedButtonIdx = -1;
      this._contextKey = null;
      this._pageTitleSelected = !wasOpen;
      this._render();
      this._a11yEditorToggled(
        this._pageTitleSelected,
        this._t("a11y_editing_title"),
        this._t("a11y_title_closed"),
      );
      return true;
    }
    const idx = this._faceIdxFor(key);
    if (idx < 0) return false;
    this._selectButton(idx);
    return true;
  },

  /**
   * The blueprint index of a button key — what `_selectButton` speaks in.
   * Read off the live blueprint rather than carried through the menu, because
   * the menu outlives the render that opened it only by microseconds but the
   * key is the stable thing either way.
   */
  _faceIdxFor(key) {
    const buttons = this._blueprint?.buttons || [];
    return buttons.findIndex(b => b.key === key);
  },

  // The host `_refreshButtonEntitySections` rebuilds: everything on the button
  // card derived from the button's *entity*, which is chosen inside the action
  // editor. That editor reports changes through value-changed, but a full
  // _render() would tear it down mid-edit (`_mountEditor` clears its container
  // and builds a new ha-automation-action), so this subtree is rebuilt on its
  // own instead. A stable id, not a class, because the refresh has to find
  // exactly one of them.
  //
  // The Button image and the per-state icon list share this one host. They are
  // alternatives to each other, and while they briefly lived in separate
  // regions with a host each, refreshing one without the other could show both
  // at once. One host makes that unstateable rather than merely handled.
  //
  // The Label input is deliberately *not* in the host. It is a sibling, so an
  // entity change cannot discard a name that has been typed but not yet
  // confirmed.
  ENTITY_SECTION_HOST: "#config-card-appearance",

  // The press list's host. A second one, not a second region of the first: the
  // rows render after the Tooltip and the Tooltip is deliberately not inside a
  // host at all (see above), so the only way for the list to follow it is to
  // have a host of its own. Refreshed alongside the first because each row's
  // derived glyph is resolved against the button's entity domain.
  PRESS_SECTION_HOST: "#config-card-presses",

  _refreshButtonEntitySections() {
    const host = this.shadowRoot?.querySelector(this.ENTITY_SECTION_HOST);
    if (!host) return;
    const bp = this._blueprint;
    const selBtn = bp?.buttons?.[this._selectedButtonIdx];
    if (!bp || !selBtn) return;

    const scratch = document.createElement("div");
    scratch.innerHTML = this._htmlButtonConfigPanel(bp, selBtn);
    const fresh = scratch.querySelector(this.ENTITY_SECTION_HOST);
    // Empty rather than bail: a button that has just lost its entity must lose
    // these sections too, and leaving the old markup would be the same
    // stale-card bug pointing the other way.
    //
    // The `: ""` arm is defensive only and is currently unreachable — verified,
    // not assumed. The container is emitted unconditionally by the grid-button
    // branch (it wraps sections that are individually optional, which is the
    // point), and it is the *only* branch that emits one, so `host` existing
    // already implies `fresh` does. What actually makes the entity-loss case
    // work is therefore that unconditional wrapper, not this ternary; move the
    // wrapper inside a conditional and the bug returns with this line looking
    // innocent.
    host.innerHTML = fresh ? fresh.innerHTML : "";

    // The press rows, from the same scratch render. Same contract as above,
    // and the same reason for the `: ""` arm.
    const pressHost = this.shadowRoot.querySelector(this.PRESS_SECTION_HOST);
    if (pressHost) {
      const freshPresses = scratch.querySelector(this.PRESS_SECTION_HOST);
      pressHost.innerHTML = freshPresses ? freshPresses.innerHTML : "";
    }

    // Everything about the press list that is *not* inside either host: the
    // section's name, press 1's heading, and whether the list is a list at all.
    //
    // These sit outside because the list has to contain press 1's two fields,
    // and those fields are the two hosts. So the wrapper cannot be a host
    // itself, and the pieces of it that depend on the entity have to be synced
    // by hand. Attributes and whole elements rather than innerHTML on a
    // container: nothing here holds text the user is part-way through typing
    // -- the Tooltip that does is inside the row and is not touched.
    this._syncPressSection(this.shadowRoot, scratch);

    this._wireButtonEntitySections(bp, selBtn);
  },

  /**
   * Carry the press list's own markup across from a fresh render.
   *
   * Its own, meaning the parts that are not inside either host: the section's
   * name, press 1's heading, and whether the list is a list at all. They sit
   * outside because the list has to *contain* press 1's two fields, and those
   * fields are the two hosts -- so the wrapper cannot be a host itself.
   *
   * Separate from the caller so the one transition that cannot be reasoned
   * about from the markup -- a button crossing between one action and two,
   * where the row has to appear or disappear without a re-render -- can be
   * driven directly by a test.
   */
  _syncPressSection(live, scratch) {
    const section = live?.querySelector("#config-card-press-section");
    const freshSection = scratch?.querySelector("#config-card-press-section");
    if (section && freshSection) {
      // Gaining or losing a cycle. The structure is already there either way;
      // this is the one bit of state that says which it is.
      section.className = freshSection.className;
      const head = section.querySelector("#config-card-press-head");
      const freshHead = freshSection.querySelector("#config-card-press-head");
      if (head && freshHead) head.innerHTML = freshHead.innerHTML;
      // The summary carries the ordinal, the name and the glyph, all three
      // derived from the entity. Replaced whole; the `toggle` listener and the
      // open state both belong to the <details> around it, so neither is lost.
      const rowHead = section.querySelector('.press-appearance-row[data-press-idx="0"] > summary');
      const freshRowHead = freshSection.querySelector('.press-appearance-row[data-press-idx="0"] > summary');
      if (rowHead && freshRowHead) rowHead.replaceWith(freshRowHead);
      // Losing the cycle has to force the row open. `press-plain` hides the
      // summary, so a row the user had collapsed would stay collapsed with
      // nothing left to click -- and since the row holds the button's Image
      // and Tooltip, deleting an action made both fields vanish.
      //
      // Only in that direction. Gaining a cycle leaves the row as the user
      // had it, which is open, because until this moment it was not a row and
      // its fields were simply the card's.
      const row = section.querySelector('.press-appearance-row[data-press-idx="0"]');
      const freshRow = freshSection.querySelector('.press-appearance-row[data-press-idx="0"]');
      if (row && freshRow?.hasAttribute("open")) row.setAttribute("open", "");
      const list = section.querySelector(".press-appearance-list");
      const freshList = freshSection.querySelector(".press-appearance-list");
      if (list && freshList) {
        // `role="group"` names itself from the section label, which only
        // exists while cycling. Carried over rather than left stale, so the
        // list never advertises a name that is no longer on the page.
        ["role", "aria-labelledby", "aria-describedby"].forEach(a => {
          const v = freshList.getAttribute(a);
          if (v === null) list.removeAttribute(a); else list.setAttribute(a, v);
        });
      }
    }
  },

  // Everything on the button card derived from the button's *entity*: the
  // Button icons / Button image group and the Slider group. Split out of
  // `_wireButtonConfigPanel` so it can be re-run on its own after those
  // sections are rebuilt in place — see `_refreshButtonEntitySections`.
  //
  // Factored rather than duplicated on purpose. The slider switch's
  // delete-vs-write rule is a storage contract, and a second copy of it would
  // be a second chance to disagree about what absence means.
  _wireButtonEntitySections(bp, selBtn) {
    // The slider's context wiring is not here. Its fields render on the
    // slider's own card, from one body shared with the page case, so they are
    // wired beside that body -- one place that decides whether an edit lands
    // on the page or on the selected grid button. A second copy here is what
    // let the two disagree in the first place.


    // Icon picker. The only control in the Image field: the Icon/URL toggle and
    // the box it revealed are gone, because this picker takes a custom value and
    // a URL can simply be typed into it.
    const assign = this._editAssign(selBtn.key) || {};
    const apprRead = this._sliderAppearanceTarget(selBtn.key);
    const pickedFrom = apprRead?.scoped
      ? (this._assignments[apprRead.key]?.[apprRead.imageKey] || "")
      : (assign.image || "");
    // Stored icon first, then the derived one — the pattern every icon field
    // here uses. Without the fallback this field sat empty next to a preview
    // showing the glyph and a face drawing it, which read as the icon having
    // failed to save.
    //
    // "No icon" and "not set yet" both show as empty, which is deliberate:
    // they differ to the card, which derives a glyph for one and not the
    // other, but that difference is not the user's to see and a control
    // explaining it would be UI no other icon field here has.
    // A URL used to be blanked here, because the box beside the picker was
    // where URLs lived. That box is gone — the picker takes a custom value —
    // so a stored URL is shown in the control that holds it, like any other.
    this._mountIconPicker(
      this.shadowRoot.querySelector("#config-icon-picker-slot"),
      apprRead && this._sliderIconHidden(apprRead)
        ? ""
        : (pickedFrom || this._autoIconForField(selBtn.key)),
      (picked) => {
        const appr = this._sliderAppearanceTarget(selBtn.key);
        // Clearing a slider's icon means "show nothing", not "derive one". It
        // used to delete the key, which is the *inherit* spelling -- so the
        // derived glyph came straight back and the icon could not be deleted at
        // all. There is deliberately no way back to the derived glyph; see the
        // note on SLIDER_ICON_HIDDEN_KEY.
        const isSlider = selBtn.key === SLIDER_VERTICAL_KEY;
        if (isSlider && appr) {
          // No `image_pinned` in the scoped case: that flag ranks an explicit
          // icon above a payload thumbnail on the *button's tile*, and this is
          // the slider's glyph. Setting it would change what the device is sent
          // for a tile the user was not editing.
          const rec = this._writeSliderIcon(appr, picked);
          if (!appr.scoped) {
            if (picked) rec.image_pinned = true;
            else delete rec.image_pinned;
          }
        } else {
          const target = this._editAssignEnsure(selBtn.key);
          target.image = picked;
          // An explicitly picked icon outranks the payload thumbnail.
          if (picked) target.image_pinned = true;
          else delete target.image_pinned;
        }
        this._scheduleAutoSave();
        this._render();
      },
      this._pageDeviceOption(),
    );

    // State icon fields
    this._wireStateIconPickers(selBtn);

    // Toggle rules
    this._wireToggleSection(selBtn);
  },

  /**
   * The per-state icon fields under Button icons.
   *
   * One picker per row and nothing else. The ✎ that revealed an editor, the ✕
   * that reset it and the Icon/URL toggle inside it are all gone: the picker is
   * always visible, takes a custom value, and clearing it *is* the reset.
   *
   * The stored value is what the picker shows, not the derived one. That is the
   * opposite of the Image field above and deliberate: here an empty picker has
   * to mean "this row inherits the action's icon", and preselecting that icon
   * would leave no way to say so — every row would read as overridden and the
   * preview beside it already shows what the device will draw.
   */
  // ── Virtual toggle button ─────────────────────────────────────────────
  //
  // One button, several steps. The block is a sibling of `config`, never a
  // replacement for it: `config[0]` stays the step that names the button, owns
  // the subject entity and runs when no rule matches. Six readers across the
  // backend derive meaning from `config[0]`, so the editor must never let a
  // toggle empty it.
  //
  // Two modes, one shape. `state` picks the rule whose `state` matches what the
  // subject entity reports; `cycle` ignores state and runs the next rule in
  // order, which is the only thing that works for a device that reports nothing
  // back (IR blasters, one-way RF).

  // The rules currently stored, always an array so callers can map over it.
  // Defensive rather than trusting: the block round-trips through YAML that a
  // user may edit by hand.
  _toggleBlock(selKey) {
    const assign = this._editAssign(selKey) || {};
    const block = assign.toggle;
    return (block && typeof block === "object" && !Array.isArray(block)) ? block : null;
  },

  _toggleRules(selKey) {
    const block = this._toggleBlock(selKey);
    return Array.isArray(block?.rules) ? block.rules : [];
  },

    /**
   * Mutate the stored block through one helper so every writer prunes the same
   * way. An empty `toggle` must never reach disk: `store.py` treats presence as
   * "this button toggles", and `{}` would claim that while doing nothing.
   *
   * Only the per-press *appearance* writes through here now -- an icon, a
   * tooltip. The presses themselves are the action editor's list, and
   * `_applyCycle` writes those, so nothing here adds or removes a rule.
   *
   * It does not touch `config`. The rules → `config` direction used to live
   * here and also refilled `_sequence` from step 1, which under a cycle would
   * truncate the editor's list to its first press on every icon change.
   */
  _toggleUpdate(selKey, fn) {
    const target = this._editAssignEnsure(selKey);
    const block = (target.toggle && typeof target.toggle === "object" && !Array.isArray(target.toggle))
      ? target.toggle : { mode: MODE_CYCLE, rules: [] };
    if (!Array.isArray(block.rules)) block.rules = [];
    const keep = fn(block);
    if (keep === false || block.rules.length < 2) {
      // Fewer than two presses is not a cycle -- it is the button's own action,
      // which `config` already holds. Dropping the block here keeps the card
      // and the store telling the same story.
      delete target.toggle;
    } else {
      block.mode = MODE_CYCLE;
      target.toggle = block;
    }
    this._scheduleAutoSave();
    this._refreshSVG();
    this._render();
  },

  /**
   * Keep the toggle's first step equal to the button's own action.
   *
   * The `config` → rules direction, for edits made in the action editor. The
   * executor runs `rules[position]`, so a step 1 that no longer matches the
   * action the card displays would run something the user cannot see -- the
   * exact failure the merged section exists to rule out.
   *
   * Only ever touches `rules[0]`: the later steps are the user's own.
   */
  _syncToggleFirstStep(target) {
    const rules = target?.toggle?.rules;
    if (!Array.isArray(rules) || !rules.length) return;
    if (!Array.isArray(target.config) || !target.config.length) return;
    const first = rules[0] || (rules[0] = {});
    first.config = JSON.parse(JSON.stringify(target.config));
    if (target.action_id) first.action_id = target.action_id;
    else delete first.action_id;
  },


  // What a press is called when nothing else can name it: whatever Home
  // Assistant calls the service, then the library's name, then the bare
  // service. Never blank -- a summary with a hole in it is harder to read than
  // one that says "pick an action".
  //
  // The user's own wording is deliberately *not* consulted here. Both callers
  // reach this only after the label has already been tried and found empty
  // (see `_pressHeadings` and `_pressDefaultLabel`), so reading it again would
  // be a branch that cannot be taken.
  //
  // Home Assistant's name outranks the library's on purpose. The action cards
  // directly above this summary are drawn by HA and titled in HA's words, so
  // taking the library name first meant the same two presses were called
  // "Apagado -> On" here and "Turn off light" / "Turn on light" six lines up --
  // two vocabularies for one pair of steps, with nothing on the card to say
  // they were the same thing.
  //
  // The library still wins for anything HA has never heard of, which is the
  // case that matters for it: an IR or RF command is not in the service
  // registry, and its library entry is the only name it has.
  /**
   * What to call each press on its row, one name per rule.
   *
   * A shut row is a preview of the button on that press, and it has exactly
   * two things to preview: the picture and the words. The glyph beside the
   * heading is already the Image field; the heading is the Tooltip field, so
   * what a row shows and what the remote draws are the same thing said twice
   * rather than two different facts the user has to reconcile.
   *
   * It did name the action instead, on the reasoning that a heading sitting
   * directly above the Tooltip field should not print that field's text a
   * second time. True while every row is open -- but rows are shut most of
   * the time, and shut is when the heading is the only thing there is. The
   * cost showed up as soon as two presses differed only in their tooltip:
   * one row read "Apagado" and the next "On", the first a caption and the
   * second a service, with nothing to say why.
   *
   * Blank falls through to the same default the field offers, so an untouched
   * press is headed by what it will draw rather than by nothing. Resolved the
   * way the device resolves it -- `_substituteLabelTokens` is the twin of the
   * backend's `substitute_label_tokens` -- so the heading says the words the
   * remote will actually print.
   */
  _pressHeadings(rules) {
    return (rules || []).map(rule => {
      // Only when the tooltip is *words*. A tooltip takes any media source
      // now, so a press captioned with a glyph would put `mdi:battery-50` up
      // as its heading -- a filename read as a sentence. That caption is
      // already drawn, as the glyph; the heading falls through instead.
      const raw = rule?.label || "";
      // Through the same resolver the field below the heading uses, against
      // the press's own target. An empty value map was passed here, which
      // *stripped* a stored `${_state}` instead of reading it -- so a press
      // captioned "Schreibtisch ${_state}" was headed by the bare word
      // "Schreibtisch" while the field under it, and the remote, said
      // "Schreibtisch On".
      const tip = this._isMediaSource?.(raw)
        ? ""
        : this._displayLabel(
            raw,
            { service: rule?.config?.[0]?.action || "" },
            this._getTargetEntityFromConfig(rule?.config || []),
            rule?.config,
            rule,
          );
      return tip || this._pressDefaultLabel(rule, this._toggleRuleName(rule));
    });
  },

  /**
   * What a press's Tooltip field offers when it is left blank.
   *
   * The same question press 1's field answers, so it has to be answered the
   * same way. Press 1 shows `_computeLabel`, which reads the subject the step
   * points at; a press row showed `_toggleRuleName`, which is the service's
   * name and nothing else. Two rows apart, the same empty field promised
   * "Turn on" in one place and "Desk lamp" in the other, and only one of them
   * was what the remote would draw.
   *
   * Falls back to the row's heading, which is what it used to show outright.
   *
   * `_computeLabel` returns a *template* for a two-way service -- a bare
   * `${_state}`, which the caller persists and the device resolves per press.
   * Correct to store, unreadable to show: a press duplicated from a
   * `light.toggle` was headed `${_state}` and offered it as its placeholder,
   * next to a sibling reading "Schreibtisch Apagado".
   *
   * So the template is resolved the way the device resolves it, through the
   * same two helpers press 1's field uses. Not `_resolveLabel` on its own,
   * which re-derives the whole ladder from the *entity's* state and so heads
   * every press of a media button "TV Pause" whatever its own service is;
   * `_displayLabel` fills the token against this press's service and target,
   * and `_labelPrefix` contributes the entity name the device draws in front.
   */
  _pressDefaultLabel(rule, fallback = "") {
    const action = rule?.action_id
      ? (this._actions || []).find(a => a.id === rule.action_id) || null
      : null;
    const entity = this._getTargetEntityFromConfig?.(rule?.config) || "";
    const derived = this._computeLabel(action, entity, rule?.config);
    if (!derived) return fallback;
    const body = this._displayLabel(derived, action, entity, rule?.config);
    const prefix = this._labelPrefix(action, entity, rule?.config, derived, rule);
    return [prefix, body].filter(Boolean).join(" ") || fallback;
  },

  /**
   * The heading of one press row, for every press including the first.
   *
   * One function because the rows are meant to be indistinguishable: press 1
   * is a step of the cycle like any other, and a heading built separately for
   * it is how the two drift into looking like different kinds of thing.
   */
  _pressRowHeadHtml({ idx, name, glyphHtml }) {
    return `
              <summary class="press-appearance-head" role="group" aria-label="${this._esc(`${idx + 1}. ${name}`)}">
                <span class="press-appearance-num" aria-hidden="true">${idx + 1}</span>
                ${/* A shut row still has to say which press it is about, and
                      the two fields that would answer are the ones it just
                      hid. The glyph the press will wear rides on the heading,
                      drawn by the same resolver the field below uses. */""}
                <span class="press-appearance-glyph" aria-hidden="true">${glyphHtml}</span>
                <span class="press-appearance-title">${this._esc(name)}</span>
              </summary>`;
  },

  // The hint under a Tooltip field: at most one lesson, about the token the
  // field actually holds, prefixed by what the remote prints for it right now.
  //
  // One ladder for press 1 and for presses 2..N. They were written separately
  // and drifted -- same three rungs, same order, two copies to keep in step --
  // which is the whole reason the two fields once explained themselves
  // differently.
  _tokenHint(resolved, { state, name, variable, media } = {}) {
    // Media first: in "${_state} - ${_device.media_title}", `${_state}` is
    // pre-written by auto-labelling, so it is the half the user already has.
    // The track is the half worth a sentence, whether or not it is there yet.
    const lesson = media ? "label_media_hint"
      : state ? "label_state_hint" : name ? "label_name_hint" : variable ? "variable_hint" : "";
    if (!lesson) return "";
    const reads = resolved ? this._t("label_now_reads", { text: this._esc(resolved) }) : "";
    return `${reads}${this._t(lesson)}`;
  },

  _toggleRuleName(rule) {
    const svcPath = rule?.config?.[0]?.action || "";
    const [svcDomain, svc] = svcPath.split(".");
    const haName = (svcDomain && svc)
      ? this._hass?.services?.[svcDomain]?.[svc]?.name
      : "";
    if (haName) return haName;
    const act = (this._actions || []).find(a => a.id === rule?.action_id);
    if (act?.name) return act.name;
    return svc ? svc.replace(/_/g, " ") : this._t("toggle_pick_action");
  },

  /**
   * Wire the per-press appearance rows.
   *
   * All that is left of the toggle's own wiring. The presses themselves are
   * the action editor's list -- Home Assistant adds, reorders and deletes them
   * through its own controls, and `_applyCycle` writes what comes back -- so
   * the only thing bound here is how each press *looks*.
   */
  _wireToggleSection(selBtn) {
    // Mirrors the render condition exactly. Rows that were never drawn have
    // nothing to wire, and asking for their slots anyway means a slider's
    // panel can bind the grid editor's picker -- the two live in one shadow
    // root, so a stale id is not a null lookup but someone else's node.
    if (!isGridBtn(selBtn.key) || !this._toggleFeatureEnabled?.()) return;
    const root = this.shadowRoot;
    const key = selBtn.key;

    // Wired as the media input it now is, not on `change`: that gives a press
    // the suggestion list, commit-on-Enter and commit-on-blur that press 1's
    // Tooltip has, from the one helper that defines what those mean.
    root.querySelectorAll(".icon-picker-slot[data-toggle-label-idx]").forEach(slot => {
      const idx = Number(slot.dataset.toggleLabelIdx);
      const input = slot.querySelector(".toggle-press-label");
      if (!input) return;
      this._wireMediaInput(
        input,
        slot.querySelector(".liza-media-suggest"),
        (typed) => {
          const text = String(typed || "").trim();
          this._toggleUpdate(key, (block) => {
            const rule = block.rules[idx];
            if (!rule) return;
            if (text) rule.label = text; else delete rule.label;
          });
        },
        {
          ...this._pageDeviceOption(),
          // The press's own config decides, exactly as `pressShowsMedia` above
          // decides whether to explain these tokens: a cycle step pointed at a
          // speaker gets the track tokens, one pointed at a lamp does not.
          ...this._labelTokenOptions((this._toggleRules(key)[idx] || {}).config),
        },
      );
    });

    const entity = this._editAssign(key)?.config
      ? this._getTargetEntityFromConfig(this._editAssign(key).config)
      : null;
    root.querySelectorAll(".icon-picker-slot[data-toggle-idx]").forEach(slot => {
      const idx = Number(slot.dataset.toggleIdx);
      const rule = this._toggleRules(key)[idx] || {};
      // The derived glyph when the press stores none, matching what the render
      // put in the markup. `_mountIconPicker` assigns `input.value`, so
      // leaving the fallback out here would blank the prefill a moment after
      // it was drawn -- and it is what press 1's picker is mounted with.
      this._mountIconPicker(
        slot,
        rule.icon || this._getServiceIcon(rule.config?.[0]?.action || "", entity),
        (picked) => {
        this._toggleUpdate(key, (block) => {
          const row = block.rules[idx];
          if (!row) return;
          if (picked) row.icon = picked; else delete row.icon;
          });
        },
        this._pageDeviceOption(),
      );
    });

    // Per element, not delegated: `toggle` does not bubble, so a listener on
    // the list would never hear it. The debug view binds its <details> the
    // same way and for the same reason.
    root.querySelectorAll("details.press-appearance-row").forEach(row => {
      // Press 1's row survives `_refreshButtonEntitySections` -- it is the
      // wrapper the rebuilt hosts live in, not something the rebuild replaces
      // -- so without a guard it would collect another listener every time the
      // button's entity changed.
      if (row.dataset.pressBound) return;
      row.dataset.pressBound = "1";
      const id = `${key}:${Number(row.dataset.pressIdx)}`;
      row.addEventListener("toggle", () => {
        if (row.open) this._openPresses?.add(id); else this._openPresses?.delete(id);
      });
    });

    this._wirePressHighlight(key);
  },

  /**
   * Point at the action card a press row is about.
   *
   * The appearance rows and the action cards are two lists of the same presses
   * in the same order, and the only thing tying row 3 to card 3 used to be
   * counting. `ha-automation-action` publishes `highlightedActions` -- the same
   * property Home Assistant uses to flash a row it has just scrolled to -- so
   * touching a press row can ask HA to mark its own card, in HA's own styling,
   * with no reaching into the editor's internals.
   *
   * Matched by identity, not by index: `_cycleSequence` hands the editor the
   * very step objects the rules hold, so `includes` on the editor's side finds
   * the same object and nothing has to agree about numbering.
   *
   * Entirely cosmetic, so every step is optional-chained. An older frontend
   * without the property simply drops the assignment and the rows still edit.
   */
  _wirePressHighlight(key) {
    const root = this.shadowRoot;
    const rows = root.querySelectorAll("[data-press-idx]");
    if (!rows.length) return;

    const mark = (idx) => {
      const editor = this._editorEl;
      if (!editor) return;
      const step = idx === null ? null : this._toggleRules(key)[idx]?.config?.[0];
      // `[]` rather than undefined to clear: the property is read with
      // `?.includes(...)`, and handing it a non-array would make every row
      // match nothing in a way that depends on HA's implementation.
      editor.highlightedActions = step ? [step] : [];
    };

    rows.forEach(row => {
      const idx = Number(row.dataset.pressIdx);
      row.addEventListener("focusin", () => mark(idx));
      row.addEventListener("mouseenter", () => mark(idx));
      row.addEventListener("mouseleave", () => mark(null));
      row.addEventListener("focusout", () => {
        // Only when focus has actually left the row: moving between the
        // picker and the tooltip input inside one row fires focusout first,
        // and clearing there would strobe the highlight off and on again.
        if (!row.contains(root.activeElement)) mark(null);
      });
    });
  },

  /**
   * The states an action can be in, as `{state, icon, attribute}` rows.
   *
   * The action's own declared list wins; otherwise it is derived from the
   * target entity's domain. Shared by the state-icon rows and the toggle rules
   * so both offer the same vocabulary — a state the user can give an icon to
   * but cannot write a rule for would be an arbitrary difference.
   */
  _actionStates(action, entity) {
    if (!action) return [];
    if (action.states?.length) return action.states;
    const domain = entity ? entity.split(".")[0] : (action.service || "").split(".")[0];
    const { attribute, states } = this._getStatesForAction(action, entity);
    const defaults = this._getDefaultIcons(domain, attribute);
    return states.map(s => ({
      state: s,
      icon: defaults[s] || "",
      attribute: attribute || undefined,
    }));
  },

  _wireStateIconPickers(selBtn) {
    this.shadowRoot.querySelectorAll(".icon-picker-slot[data-state]").forEach(slot => {
      const state = slot.dataset.state;
      const assign = this._editAssign(selBtn.key) || {};
      this._mountIconPicker(slot, (assign.state_icons || {})[state] || "", (picked) => {
        const target = this._editAssignEnsure(selBtn.key);
        if (!target.state_icons) target.state_icons = {};
        if (picked) {
          target.state_icons[state] = picked;
        } else {
          delete target.state_icons[state];
        }
        // Prune the table when the last override goes. Only the old ✕ did this,
        // so clearing through the picker left `{}` behind — and `store.py` folds
        // `state_icons` into the config hash, which made an edit that changed
        // nothing look like a change and resynced the device for it.
        if (Object.keys(target.state_icons).length === 0) delete target.state_icons;
        this._scheduleAutoSave();
        this._refreshSVG();
        this._render();
      }, this._pageDeviceOption());
    });
  },
};

