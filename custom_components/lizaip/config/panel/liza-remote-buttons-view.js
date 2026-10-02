/**
 * lizaIP Panel — Buttons View
 * HTML generation and wiring for the Buttons tab (pages, SVG, button config).
 */

import { drawSVG, getPathBounds } from "./liza-remote-svg.js";
import { badNumber } from "./liza-remote-helpers.js";

const capitalize = (s) => s.replace(/\b\w/g, c => c.toUpperCase());

export const isGridBtn = (key) => /^button_\d+$/.test(key);
const isSliderBtn = (key) => /^slider_/.test(key);

// The page title's preview, in CSS pixels. Its 4:1 proportion is imgserv's
// named `title` size (200x50), not the 200x60 strip the device face draws:
// what the field previews is the *image*, and the band of empty pixels the
// device pads it with on either side is not part of it.
const TITLE_PREVIEW_H = 28;
const TITLE_PREVIEW_W = TITLE_PREVIEW_H * 4;

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

// A grid button's `overrides` block names every fixed control it drives while
// it is the selection, the slider included. A string value names a capability
// or a service, resolved live against whatever the button points at; a dict is
// a frozen sub-assignment, which only the buttons may carry. These two own the
// string half so no caller has to remember which shape a key takes.
//
// The setter deletes an emptied block rather than leaving `{}` behind: presence
// is tested with `Object.hasOwn`, and an empty table would read as "overrides
// something" on both sides of the wire.
const liveOverride = (assign, key) => {
  const value = assign?.overrides?.[key];
  return typeof value === "string" ? value.trim() : "";
};

const setLiveOverride = (assign, key, value) => {
  if (!assign) return;
  if (value) {
    if (!assign.overrides) assign.overrides = {};
    assign.overrides[key] = value;
    return;
  }
  if (!assign.overrides) return;
  delete assign.overrides[key];
  if (!Object.keys(assign.overrides).length) delete assign.overrides;
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
// drag behaves, `target` says what it lands on. This is the spelling for "lands
// on whatever was last touched", mirroring the backend's `SLIDER_TARGET_*` so
// the two cannot drift.
//
// Read, never written. Nothing here emits either following value any more —
// see `effectiveTarget` — but both are on disk on live boxes and in shipped
// layout YAML, so the names stay and every reader below goes through them.
const SLIDER_TARGET_LAST_TOUCHED = "last_touched";
// …and the one that additionally names an entity to drive until something is
// touched. Two stored values, one thing as far as the card is concerned: the
// same targeting with and without a default, differing only by whether the
// "Default entity" field is filled.
const SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY = "last_touched_or_entity";
// The one target that does *not* follow. Unspellable from this panel by design
// — there is no Target row to write it — but honoured everywhere, so a
// hand-written page YAML can still pin a slider that must never move.
const SLIDER_TARGET_ENTITY = "entity";
// What "no `target` key" means, mirroring the backend's `_effective_target`:
// following, with the stored entity as the default when there is one. The two
// following spellings differ only by whether `target_entity` is set, so the
// panel writes neither — but both are still read, forever, because they are on
// disk on live boxes and in shipped layout YAML.
const effectiveTarget = (sa) => {
  if (!sa || typeof sa !== "object") return null;
  if (sa.target) return sa.target;
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
export const isConfigured = (assign) => !!(assign?.action_id || assign?.slider_actions?.mode || assign?.image);

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

      const emptyClass = filledCount === 0 ? 'pg-empty' : '';
      // The tooltip keeps every fact in one string -- a hover tooltip cannot
      // offer to skip half of itself. The announcement splits: the name is
      // which page and where it sits, and the fill count becomes a
      // description a reader announces separately and a user can skip.
      const label = this._pageFillLabel(page, i, bp);
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
      // The hover tooltip rides on the control, where an explicit aria-label
      // already wins the name, so `title` stays a tooltip instead of becoming
      // a second announcement. The open page's tooltip is on the face itself.
      const pictureAttrs = isActive
        ? ''
        : ` role="button" tabindex="0" title="${this._esc(label)}" aria-label="${this._esc(openLabel)}" aria-describedby="${descId}"`;
      // tabindex="-1" makes the open page a programmatic focus target (see
      // _a11yFocusFallback) without adding a tab stop. `data-page-idx` is a
      // position and pages are draggable, so focus restoration keys on the
      // stable `data-page-id` instead (see dataAttrs in liza-remote-a11y.js).
      // The delete button is rendered only on the open page: elsewhere it was
      // invisible yet focusable (2.4.7) and still hit-tested. Placed before
      // the container so the tab order reads page, delete, buttons.
      return `
        <div class="page-thumb ${isActive ? 'active' : ''} ${emptyClass} ${page.subpage ? 'subpage' : ''}" data-page-idx="${i}" data-page-id="${this._esc(String(page.id))}" draggable="true"${groupAttrs}>
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

    return `
      <div class="config-layout">
        <ha-card outlined class="pages-card">
          <div class="pages-list" style="flex-wrap:nowrap;overflow-x:auto;min-height:350px;">${pagesHtml}
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
    // `mdi:`/`text:`/`logo:` prefixes by hand, and a ✓/✕ pair to commit. The
    // button card has an icon picker, a preview and a mode toggle, and commits
    // as you go. So does this now. What it does not have is the Tooltip field:
    // the title bar prints its own picture and has no second line to caption.
    //
    // One control, not two. There used to be an Icon/URL toggle here and on the
    // button card, each revealing one of a pair of inputs — but `ha-icon-picker`
    // takes a custom value, so a URL, a `logo:` or a bare label can simply be
    // typed into it. The second input was a mode switch guarding a box that was
    // never needed.
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
    const bannerHtml = this._pageTitleSelected ? '' : `
        <div class="ps-title-banner">
          <div class="ps-page-meta">
            <span class="ps-title-subtitle">${this._t("page_n_of_m", { n: this._currentPageIdx + 1, m: pageCount })}</span>
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
            ${this._htmlIconField({
              label: this._t("image"),
              value: pageImgTitle,
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

    return `
      <ha-card outlined class="config-card">
        <h2 class="liza-sr-only">${this._esc(this._t("a11y_page_region"))}</h2>
        ${bannerHtml}
        <div class="config-card-body ps-body">
          ${titleEditorHtml}
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
    return `
      <div class="config-card-header cch">
        ${o.subtitleHtml || ''}
        <div class="cch-editor" id="configCardEditor">
          <div class="cch-editor-inner">
            ${o.appearanceHostHtml || ''}
            ${o.labelFieldHtml || ''}
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
            ${configFieldHtml({
              label: this._t("label"),
              control: `<input type="text" class="config-label-input" value="${this._esc(apprCtx ? apprCtx.label : (selAssign.label || selDefault))}" ${apprCtx ? `placeholder="${this._esc(apprCtx.autoLabel)}"` : ""} />`,
              hint: apprCtx
                ? this._t("label_own_hint", {
                    name: this._esc(contextName),
                    auto: this._esc(apprCtx.autoLabel),
                  })
                : "",
            })}
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
      !!this._displayLabel("${STATE}", selAction, selEntity, selAssign.config);
    // `${NAME}` is only a token on a device-local command, so the hint is
    // gated on the button carrying one *and* on that command naming a target
    // -- a goto pointed at a page that no longer exists resolves to nothing,
    // and promising a replacement that never comes is worse than staying quiet.
    const labelShowsName =
      this._labelHasNameToken(labelFieldValue) &&
      !!this._displayLabel("${NAME}", selAction, selEntity, selAssign.config);
    // What the remote prints for this button *right now*.
    //
    // The field cannot show it. It holds the stored text verbatim, tokens and
    // all, because committing the resolved words would freeze them: a mute
    // button reading "Mute" would keep saying "Mute" after the speaker was
    // muted, which is the contradiction `${STATE}` exists to avoid.
    //
    // But "Unnamed Room ${STATE}" is not a tooltip anyone recognises, and the
    // hint only said the token "is replaced by what pressing the button does"
    // -- true, and no help at all in telling whether it is working. Naming the
    // current answer is the difference between a field that looks broken and
    // one that is visibly live.
    const labelResolved = (labelShowsState || labelShowsName)
      ? this._resolveLabel(selAction, selEntity, selAssign.config, rawLabel, selAssign)
      : "";
    // A device-local command whose target the device cannot resolve is sent
    // disarmed. Surfaced here because the label deliberately still names the
    // target the user asked for, so it cannot also carry the bad news.
    const internalProblem = this._internalCommandProblem(selAssign.config, selAction?.service);

    const imageVal = selAssign.image || "";

    const stateIcons = selAssign.state_icons || {};
    const iconDomain = selEntity ? selEntity.split(".")[0] : (selAction?.service || "").split(".")[0];
    let actionStates = selAction?.states || [];
    if (actionStates.length === 0 && selAction) {
      const { attribute, states: derivedStates } = this._getStatesForAction(selAction, selEntity);
      const defaults = this._getDefaultIcons(iconDomain, attribute);
      actionStates = derivedStates.map(s => ({
        state: s,
        icon: defaults[s] || "",
        attribute: attribute || undefined,
      }));
    }
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
          <div class="state-icons-list">${rows}</div>
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
    const labelFieldHtml = labelIsDead ? '' : configFieldHtml({
      label: this._t("tooltip"),
      control: `<input type="text" class="config-label-input" value="${this._esc(labelFieldValue)}" placeholder="${this._esc(selDefault)}" ${labelNeedsAction ? "disabled" : ""} />`,
      action: labelNeedsAction ? '' : `${
        (currentLabel && currentLabel !== autoLabel)
          ? `<button class="config-label-reset" data-a11y-focus-after=".config-label-input" title="${this._esc(this._t("reset_tooltip"))}" aria-label="${this._esc(this._t("reset_tooltip"))}"><span aria-hidden="true">↺</span></button>` : ''
      }<button class="config-label-cancel" data-a11y-focus-after=".config-label-input" title="${this._esc(this._t("discard_change"))}" aria-label="${this._esc(this._t("discard_change"))}" style="display:none"><ha-icon icon="mdi:close" style="--mdc-icon-size:18px;" aria-hidden="true"></ha-icon></button><button class="config-label-save" data-a11y-focus-after=".config-label-input" title="${this._esc(this._t("save_tooltip"))}" aria-label="${this._esc(this._t("save_tooltip"))}" style="display:none"><ha-icon icon="mdi:check" style="--mdc-icon-size:18px;" aria-hidden="true"></ha-icon></button>`,
      hint: labelNeedsAction
        ? this._t("tooltip_needs_action")
        : labelShowsState
          ? `${labelResolved ? this._t("label_now_reads", { text: this._esc(labelResolved) }) : ''}${this._t("label_state_hint")}`
          : labelShowsName
            ? `${labelResolved ? this._t("label_now_reads", { text: this._esc(labelResolved) }) : ''}${this._t("label_name_hint")}`
            : "",
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
        })}
        <div class="config-card-body">
          <div class="config-field">
            <div id="button-editor-container"></div>
          </div>
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
   * icon. Nothing is written unless the user picks something — `value-changed`
   * fires on input, not on assignment.
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
  _tileImg(pageIdx, key, src) {
    const cache = (this._tileImgCache ||= new Map());
    const id = `${pageIdx}:${key}`;
    const hit = cache.get(id);
    if (hit && hit.getAttribute("src") === src) {
      // Carried over from the container it was just detached from, which may
      // have styled it for a different role.
      hit.removeAttribute("style");
      return hit;
    }
    const el = document.createElement("img");
    el.setAttribute("src", src);
    // Decoration: the shape underneath already names it, and these are
    // `pointer-events: none`. Unnamed, a reader would announce the imgserv
    // src once per button.
    el.setAttribute("alt", "");
    el.setAttribute("data-key", key);
    cache.set(id, el);
    return el;
  },

  // Shared by the thumbnail template and the face tooltip in _refreshSVG.
  // It used to be built in the template and read back out of the DOM with
  // `closest()`, which tied a label to a node the caller might not have.
  // Position included: nothing else told a reader how many pages there are or
  // where this one sits, and the visible "3 of 9" is static text Tab skips.
  _pageFillLabel(page, i, bp) {
    const currentPageId = this._pages[this._currentPageIdx]?.id;
    const pageAssigns = (page.id === currentPageId)
      ? this._assignments
      : (this._pageCache[page.id] || {});
    const allBtnKeys = bp.buttons.map(b => b.key);
    return this._t("page_fill", {
      name: this._pageLabel(page),
      filled: allBtnKeys.filter(k => isConfigured(pageAssigns[k])).length,
      total: allBtnKeys.length,
      n: i + 1, m: this._pages.length,
    });
  },

  _refreshSVG() {
    const bp = this._blueprint;
    if (!bp) return;

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
      const rawTitle = String(page.image || "").trim();
      const mode = this._getThemeMode();
      const pgColor = page.default_color || "";
      // Only tint monochrome sources; logos/photos keep their natural colors, and
      // a title carrying its own fg= has already said what it wants.
      const tintable = /^(mdi:|phu:|text:)/.test(rawTitle);
      const fgSlider = pgColor && tintable && !rawTitle.includes("fg=") ? `&fg=${pgColor}` : "";
      let sliderImageUrl = null;
      if (!rawTitle) {
        sliderImageUrl = null;
      } else if (rawTitle.startsWith("text:")) {
        const sep = rawTitle.includes("?") ? "&" : "?";
        sliderImageUrl = `/api/imgserv/${rawTitle}${sep}size=title&mode=${mode}${fgSlider}&alpha=1`
          + this._titleTextStyle(rawTitle);
      } else if (rawTitle.startsWith("mdi:")) {
        sliderImageUrl = `/api/imgserv/${rawTitle}?size=title&mode=${mode}${fgSlider}&alpha=1`;
      } else if (rawTitle.startsWith("phu:")) {
        const sep = rawTitle.includes("?") ? "&" : "?";
        sliderImageUrl = `/api/imgserv/${rawTitle}${sep}size=title&mode=${mode}${fgSlider}&alpha=1`;
      } else if (rawTitle.startsWith("logo:")) {
        const sep = rawTitle.includes("?") ? "&" : "?";
        sliderImageUrl = `/api/imgserv/${rawTitle}${sep}size=title&mode=${mode}&alpha=1`;
      } else if (rawTitle.startsWith("media:")) {
        sliderImageUrl = this._imgservUrl(rawTitle, "title", mode);
      } else if (rawTitle.startsWith("imgserv://")) {
        const inner = rawTitle.slice(10);
        const sep = inner.includes("?") ? "&" : "?";
        sliderImageUrl = `/api/imgserv/${inner}${sep}size=title&mode=${mode}&alpha=1`;
      } else if (this._isExternalUrl(rawTitle)) {
        sliderImageUrl = this._imgservUrl(this._mediaSource(rawTitle), "title", mode);
      } else {
        const sep = rawTitle.includes("?") ? "&" : "?";
        sliderImageUrl = `/api/imgserv/text:${encodeURIComponent(rawTitle)}${sep}size=title&mode=${mode}${fgSlider}&alpha=1`
          + this._titleTextStyle(rawTitle);
      }

      // Draw clickable button shapes only — icon/title images are HTML overlays
      // below. `markFor` rides along because the nesting mark styles the SVG
      // shape, which is not part of what moved to the overlays.
      drawSVG(container, bp, selectedIdx, hasAction, onSelect, {
        // Only the open page exposes its forty shapes as controls. See drawSVG.
        interactive: isActive,
        // The open page's hover tooltip, taken from the thumbnail that used to
        // carry it on its own wrapper. Only the open page has one: a closed
        // thumbnail's tooltip sits on its button.
        faceTitle: isActive ? this._pageFillLabel(page, pageIdx, bp) : "",
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
      });

      // Crop to the main button area
      const svg = container.querySelector("svg");
      if (svg) {
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.setAttributeNS(null, "viewBox", "32 33 108 295");
        svg.setAttributeNS(null, "width", "108");
        svg.setAttributeNS(null, "height", "295");
      }

      // --- HTML <img> overlays: actual imgserv PNGs positioned over the SVG shapes ---
      // Coordinates expressed as % of the cropped region (x=32,y=33,w=108,h=295) so
      // they scale correctly at any container pixel size.
      const CROP_X = 32, CROP_Y = 33, CROP_W = 108, CROP_H = 295;
      const pX = (cx, sz) => ((cx - sz / 2 - CROP_X) / CROP_W * 100).toFixed(1) + '%';
      const pY = (cy, sz) => ((cy - sz / 2 - CROP_Y) / CROP_H * 100).toFixed(1) + '%';
      const pW = (sz) => (sz / CROP_W * 100).toFixed(1) + '%';
      const pH = (sz) => (sz / CROP_H * 100).toFixed(1) + '%';

      // Title PNG (slider_horizontal area)
      //
      // Sized from the PNG's own pixels, not from the bar's bounds. The bar is
      // drawn as 104x26 user units (4:1) while the device's title area is
      // TITLE_W x TITLE_H px (10:3), so handing the element the raw bounds and
      // letting `object-fit: contain` do the work scaled every title up until
      // it filled the bar: a cropped four-letter label came out exactly as
      // large as a full-width logo, which is the one thing the preview must not
      // say.
      //
      // `s` converts device pixels to user units, uniformly, so the whole title
      // area maps inside the bar with its proportions intact. Multiplying the
      // image's natural size by it reproduces what the hardware does - draw the
      // PNG at the size it actually is. render_text now autocrops to the glyph
      // bounding box, so that size is the real measure of the text, and short
      // labels stay small.
      //
      // A title too long for the title area is *meant* to overflow, so nothing
      // shrinks it back to fit: at `s` it simply runs past the bar and is cut
      // off, which is the honest preview of a label that will not fit on the
      // device either. The wrapper exists only to bound where that cut happens
      // - without it the overflow would be painted across the button grid
      // below, which is a rendering artefact rather than the device's
      // behaviour.
      //
      // The natural size is only known once the image has loaded, hence the
      // `load` listener; the first call runs with the full title area as a
      // placeholder so the element is still positioned if the load never fires.
      //
      // That placeholder is why the title used to flicker on every page switch.
      // `_render()` rewrites the shadow root, so each switch builds a *new*
      // `img` whose `naturalWidth` is 0 until it loads -- even when the bytes
      // are already in the HTTP cache, `load` is a task, so one frame is
      // painted at the full title area and the next at the real size. A short
      // label visibly snapped in from bar-width.
      //
      // So natural sizes are remembered per URL for the life of the panel. The
      // same title drawn a second time is sized correctly in its first frame
      // and never moves. The cache is keyed by the URL, which already carries
      // the text, the colour and the size -- change any of them and it is a
      // different key, so a stale entry cannot be applied to a new picture.
      if (sliderImageUrl) {
        const sliderBtn = bp.buttons.find(b => b.key === 'slider_horizontal');
        if (sliderBtn) {
          const b = getPathBounds(sliderBtn.d);
          if (b) {
            const TITLE_W = 200, TITLE_H = 60;   // device title area, px
            const s = Math.min(b.w / TITLE_W, b.h / TITLE_H);

            const clip = document.createElement('div');
            clip.className = 'pg-title-clip';
            clip.style.cssText = `left:${pX(b.cx, b.w)};top:${pY(b.cy, b.h)};width:${pW(b.w)};height:${pH(b.h)};`;

            const el = this._tileImg(pageIdx, 'slider_horizontal', sliderImageUrl);
            el.className = 'pg-btn-img pg-title-img';
            const natural = (this._titleNaturalByUrl ||= new Map());
            const applySize = () => {
              if (el.naturalWidth) {
                natural.set(sliderImageUrl, { w: el.naturalWidth, h: el.naturalHeight });
              }
              const known = natural.get(sliderImageUrl);
              const w = (el.naturalWidth || known?.w || TITLE_W) * s;
              const h = (el.naturalHeight || known?.h || TITLE_H) * s;
              // Percentages of the clip box, so an oversized title yields a
              // negative offset and overflows evenly on both sides.
              el.style.left = ((b.w - w) / 2 / b.w * 100).toFixed(2) + '%';
              el.style.top = ((b.h - h) / 2 / b.h * 100).toFixed(2) + '%';
              el.style.width = (w / b.w * 100).toFixed(2) + '%';
              el.style.height = (h / b.h * 100).toFixed(2) + '%';
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
        const src = this._buildTileImgUrl(icon, mode, pgColor, isConfigured(overlayAssign));
        if (!src) return;
        const el = this._tileImg(pageIdx, btn.key, src);
        el.className = 'pg-btn-img';
        el.style.cssText = `left:${pX(b.cx,sz)};top:${pY(b.cy,sz)};width:${pW(sz)};height:${pH(sz)};pointer-events:none;`;
        if (DEFAULT_BUTTON_ICONS[btn.key] && !overlayAssign?.action_id) {
          el.style.opacity = '0.3';
        }
        container.appendChild(el);
      });
    });
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
        const action = this._actions.find(a => a.id === assign.action_id);
        if (!action) return;
        const newIcon = this._resolveButtonIcon(assign, action);
        if (!newIcon) return;
        const newSrc = this._buildTileImgUrl(newIcon, mode, pageColor, true);
        if (img.getAttribute('src') !== newSrc) img.setAttribute('src', newSrc);
      });
    });
  },

  /** Build an imgserv tile URL for a button icon. */
  _buildTileImgUrl(icon, mode, pageColor, isTinted) {
    icon = String(icon ?? '').trim();
    if (!icon) return '';
    if (this._isExternalUrl(icon) || icon.startsWith('media:')) {
      const target = this._isExternalUrl(icon) ? icon : icon.slice(6);
      return this._imgservUrl(this._mediaSource(target), 'tile', mode);
    }
    if (icon.startsWith('/') || icon.startsWith('data:')) return icon;
    const tintable = icon.startsWith('mdi:') || icon.startsWith('text:') || icon.startsWith('phu:') || !icon.includes(':');
    const fgParam = pageColor && isTinted && tintable && !icon.includes('fg=') ? `&fg=${pageColor}` : '';
    if (icon.startsWith('mdi:') || icon.startsWith('logo:') || icon.startsWith('phu:') || icon.startsWith('text:') || icon.startsWith('file:')) {
      const sep = icon.includes('?') ? '&' : '?';
      return `/api/imgserv/${icon}${sep}size=tile&mode=${mode}${fgParam}&alpha=1`;
    }
    return `/api/imgserv/mdi:${icon}?size=tile&mode=${mode}${fgParam}&alpha=1`;
  },

  _refreshButtonIcons() {
    const rows = this.shadowRoot?.querySelectorAll(".button-row");
    if (!rows || !this._blueprint) return;
    const buttons = this._blueprint.buttons;
    rows.forEach((row) => {
      const idx = parseInt(row.dataset.idx);
      const btn = buttons[idx];
      if (!btn) return;
      // Routed through the edit slot with the other three, though nothing
      // currently renders `.button-row` — the list view it belonged to is gone,
      // so the loop above never runs. Left consistent rather than left behind:
      // a row list that comes back reading the page default would reintroduce
      // exactly the mismatch this change removes from the face.
      const assign = this._editAssign(btn.key);
      if (!assign?.action_id) return;
      const action = this._actions.find(a => a.id === assign.action_id);
      if (!action) return;
      const newIcon = this._resolveButtonIcon(assign, action);
      const wrap = row.querySelector(".btn-icon-wrap");
      if (!wrap) return;
      const currentIcon = wrap.querySelector("ha-icon");
      const currentImg = wrap.querySelector("img");
      if (this._isImageUrl(newIcon)) {
        // Compare against the src that would actually be rendered — external URLs are
        // proxied through imgserv, so matching the raw config value never hits and the
        // wrapper would be rebuilt on every refresh.
        if (currentImg?.getAttribute("src") === this._iconImgSrc(newIcon, 20)) return;
        wrap.innerHTML = this._renderIconHtml(newIcon, 20);
      } else {
        if (currentIcon && currentIcon.getAttribute("icon") === newIcon) return;
        wrap.innerHTML = this._renderIconHtml(newIcon, 20);
      }
    });
  },

  _updateActiveGridCell() {
    this._refreshSVG();
  },

  // --- Wiring ---
  _wireButtonsView(bp) {
    // Page thumbnails
    this.shadowRoot.querySelectorAll(".page-thumb").forEach(el => {
      el.addEventListener("click", (e) => {
        // A long-press fires the menu and then, on most touch stacks, a click.
        // Without this the page would change out from under the open menu.
        if (el._lizaSuppressClick) { el._lizaSuppressClick = false; return; }
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
        const touch = e.touches && e.touches[0];
        const x = touch ? touch.clientX : 0;
        const y = touch ? touch.clientY : 0;
        timer = setTimeout(() => {
          timer = null;
          // The click handler above switches pages; without this the menu
          // would open on a page the user is no longer looking at.
          el._lizaSuppressClick = true;
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

    // Drag-and-drop reorder (drag from anywhere on the page thumb)
    {
      let dragIdx = null;
      this.shadowRoot.querySelectorAll(".page-thumb[draggable]").forEach(el => {
        el.addEventListener("dragstart", (e) => {
          dragIdx = parseInt(el.dataset.pageIdx);
          el.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("dragging");
          dragIdx = null;
          this.shadowRoot.querySelectorAll(".page-thumb").forEach(t => t.classList.remove("drag-over"));
        });
        el.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          el.classList.add("drag-over");
        });
        el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
        el.addEventListener("drop", (e) => {
          e.preventDefault();
          el.classList.remove("drag-over");
          const dropIdx = parseInt(el.dataset.pageIdx);
          if (dragIdx !== null && dragIdx !== dropIdx) {
            this._reorderPage(dragIdx, dropIdx);
          }
        });
      });
    }

    this._refreshSVG();

    // Config panel wiring
    if (this._selectedButtonIdx >= 0) {
      const selBtn = bp.buttons[this._selectedButtonIdx];
      this._wireButtonConfigPanel(bp, selBtn);
    } else {
      this._wirePageSettingsPanel(bp);
    }
  },

  _wirePageSettingsPanel(bp) {
    // --- Title image wiring ---
    //
    // The same three controls the button card's Image field has, wired the same
    // way: a mode toggle that only swaps what is visible, an icon picker that
    // commits on pick, and a raw box that commits on change. There is no ✓/✕
    // pair any more — the button card has never had one, and a title that saves
    // when you leave the box is the same promise every other field makes.
    // A bare word is a label, so it is stored as one. Kept from the old editor:
    // it is what lets "Kitchen" be typed instead of "text:Kitchen".
    const normalizeTitle = (raw) => {
      const value = (raw || "").trim();
      if (!value) return "";
      return /^(mdi:|text:|logo:|phu:|file:|imgserv:\/\/|https?:\/\/|data:)/.test(value)
        ? value : `text:${value}`;
    };

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

    // The stored title verbatim, whatever shape it has. The picker takes a
    // custom value, so a `text:` label or a URL sits in it as readily as an
    // `mdi:` name — which is what let the separate raw box go.
    this._mountIconPicker(
      this.shadowRoot.querySelector("#ps-icon-picker-slot"),
      this._pages[this._currentPageIdx]?.image || "",
      (picked) => saveTitle(picked),
    );

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

    this._mountEditor("button-editor-container");

    // Tooltip input
    const labelInput = this.shadowRoot.querySelector(".config-label-input");
    if (labelInput) {
      // Re-derived here, not inherited: these are locals of the *render*
      // method, and the blur handler that used to live here referenced them
      // anyway. Nothing invoked it in a test, so the ReferenceError it threw on
      // every blur of this field went unnoticed.
      const selAssign = this._editAssign(selBtn.key) || {};
      const selAction = selAssign.action_id
        ? this._actions.find(a => a.id === selAssign.action_id) : null;
      const selEntity = selAssign.config
        ? this._getTargetEntityFromConfig(selAssign.config) : null;

      // A tooltip edit is *not* auto-saved. Every other field on this card
      // commits on a debounce, but a half-typed name would then be pushed to
      // the remote and drawn on the device between keystrokes. The edit is
      // held here until it is confirmed, and ✕ puts the field back.
      const saveBtn = this.shadowRoot.querySelector(".config-label-save");
      const cancelBtn = this.shadowRoot.querySelector(".config-label-cancel");
      const resetBtn = this.shadowRoot.querySelector(".config-label-reset");
      // The input was just rendered with the field's full text, so its own
      // value is the pristine mark -- no need to re-derive it here and risk
      // drifting from what was drawn.
      const pristine = labelInput.value;
      // No banner preview and no pending dot to keep in step any more: the
      // header showed the button's name only because it doubled as a
      // disclosure control, and an uncommitted edit could be hidden behind that
      // fold. The field is always on screen now, with ✓ and ✕ beside it, so the
      // edit says what it is where it is being made.

      const syncDirty = () => {
        const dirty = labelInput.value !== pristine;
        if (saveBtn) saveBtn.style.display = dirty ? "" : "none";
        if (cancelBtn) cancelBtn.style.display = dirty ? "" : "none";
        // The reset button would commit a different tooltip in one click, which
        // is not something to offer while an unconfirmed edit is pending.
        if (resetBtn) resetBtn.style.display = dirty ? "none" : "";
      };

      const commit = () => {
        const appr = this._sliderAppearanceTarget(selBtn.key);
        if (appr?.scoped) {
          const rec = this._assignments[appr.key] || (this._assignments[appr.key] = {});
          // Empty is the inherit spelling, as with every other slider axis on a
          // grid button: storing "" would pin a blank label over the control's
          // own name. Trimmed for the same reason the button label below is.
          const scopedName = labelInput.value.trim();
          if (scopedName) rec[appr.nameKey] = scopedName;
          else delete rec[appr.nameKey];
          this._scheduleAutoSave();
          this._refreshSVG();
          this._render();
          return;
        }
        const assign = this._editAssignEnsure(selBtn.key);
        // Trimmed, because the box's surrounding whitespace is not part of any
        // name: storing it left the field re-rendering as the derived label
        // with the stray spaces still on the end, and committing *that* would
        // have frozen the derived name in as if it had been typed.
        const typed = labelInput.value.trim();
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

      labelInput.addEventListener("input", syncDirty);
      labelInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (labelInput.value !== pristine) commit(); }
        else if (e.key === "Escape") { e.preventDefault(); labelInput.value = pristine; syncDirty(); }
      });
      saveBtn?.addEventListener("click", commit);
      cancelBtn?.addEventListener("click", () => { labelInput.value = pristine; syncDirty(); });
      // Set the initial state from the same function that maintains it, rather
      // than trusting the inline style in the markup to agree with it.
      syncDirty();
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
          //
          // The delete is not optional: `sa` may have arrived from disk with a
          // legacy spelling, and leaving `last_touched_or_entity` on a blob
          // whose entity was just stripped would send the executor down the
          // default branch with no mechanics to find there.
          if (pinned) sa.target = SLIDER_TARGET_ENTITY;
          else delete sa.target;
          return;
        }
        sa.target_entity = id;
        applyControl(sa, control, st);
        // Same rule with the entity present, which is the only thing that
        // distinguished the two following spellings in the first place.
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
      this._sequence = assign?.config ? [...assign.config] : [];
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
  _mountEntityPicker(container, value, onChange) {
    // The field's name. A label outside a shadow root cannot name the control
    // inside it, so it goes on the picker, which renders it itself.
    const entityLabel = this._t("entity");
    if (this._hass) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      // Only domains a slider can actually drive. Unfiltered, the picker
      // offered sensor.*, automation.* and friends — none of which have a
      // readable attribute plus a matching *_set service — and choosing one
      // landed on "No presets for sensor", a dead end dressed as guidance.
      // Filtering makes that state unreachable instead of merely explained.
      const sliderDoms = sliderDomains(this._sliderControls);
      if (sliderDoms) picker.includeDomains = sliderDoms;
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
  _showFaceMenu(btn, ev) {
    this._closeFaceMenu();
    // `slider_horizontal` is the page's title bar, not a button — there is no
    // assignment on it, and Page Settings is where its picture is changed.
    if (!btn || btn.key === "slider_horizontal") return;
    if (!this._isAssignedRecord(this._editAssign(btn.key) || {})) return;
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
            name: this._pageLabel(page),
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
      if (result?.pages) this._toast(this._t("page_duplicated", { name: this._pageLabel(page) }));
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
   */
  _openMenu(ev, items) {
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
      : `<button type="button" role="menuitem" class="face-menu-item ${it.cls}">`
        + `${String(it.label).toLocaleLowerCase(lang)}</button>`).join("");
    const x = Number(ev?.clientX) || 0;
    const y = Number(ev?.clientY) || 0;
    // `position: fixed`, so viewport coordinates go straight on. Nudged back
    // inside when the tile is near the right or bottom edge — the face sits in
    // a scrolling column, and a menu opened on the last row would otherwise
    // extend the page rather than appear.
    const vw = Number(window?.innerWidth) || 0;
    const vh = Number(window?.innerHeight) || 0;
    menu.style.left = `${vw ? Math.min(x, vw - 180) : x}px`;
    // About 40px an item, 9 a separator, plus the frame; a fixed allowance
    // only ever fitted the two-item tile menu, and the page menu is longer.
    const seps = items.filter(it => it.separator).length;
    const height = (items.length - seps) * 40 + seps * 9 + 10;
    menu.style.top = `${vh ? Math.min(y, vh - height) : y}px`;

    const dismiss = () => this._closeFaceMenu();
    for (const it of items) {
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
      const items = Array.from(menu.querySelectorAll(".face-menu-item"));
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

    root.appendChild(menu);
    this._faceMenuEl = menu;
    menu.querySelector(".face-menu-item")?.focus?.();
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
    if (this._moveSourceKey) {
      if (key === this._moveSourceKey || key === "slider_horizontal") {
        this._cancelMove();
      } else {
        this._moveButtonTo(key);
      }
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
    this._wireButtonEntitySections(bp, selBtn);
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
    );

    // State icon pickers
    this._wireStateIconPickers(selBtn);
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
      });
    });
  },
};

