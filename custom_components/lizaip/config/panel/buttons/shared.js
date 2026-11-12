/**
 * lizaIP Panel — Buttons View: shared values and pure helpers.
 *
 * Everything the view's mixins need that does not touch `this`. Exported
 * wholesale so the mixin slices can reach it; the barrel one directory up
 * re-exports only the handful the rest of the panel uses.
 */

export const capitalize = (s) => s.replace(/\b\w/g, c => c.toUpperCase());

// The only mode a `toggle` block has. Written explicitly rather than left out:
// `sanitize_toggle` refuses a block whose mode it does not recognise, which is
// what makes a block saved by the revision that also had a state mode go inert
// instead of being silently reread as a cycle.
export const MODE_CYCLE = "cycle";

export const isGridBtn = (key) => /^button_\d+$/.test(key);
export const isSliderBtn = (key) => /^slider_/.test(key);

// The page title's preview, in CSS pixels. Its 4:1 proportion is imgserv's
// named `title` size (200x50), not the 200x60 strip the device face draws:
// what the field previews is the *image*, and the band of empty pixels the
// device pads it with on either side is not part of it.
export const TITLE_PREVIEW_H = 28;
export const TITLE_PREVIEW_W = TITLE_PREVIEW_H * 4;
// The tooltip's, at the same width: imgserv's `tooltip` size is 200x40.
export const TOOLTIP_PREVIEW_H = Math.round(TITLE_PREVIEW_W * 40 / 200);

// The thumbnail in a press row's heading. Explicit because the preview helper
// defaults to the 28px box a *field* gets, and that box is written inline --
// as `width`/`height` on an <img> and `--mdc-icon-size` on an <ha-icon> -- so
// a stylesheet cannot cut it down to heading size afterwards. Left to the
// default, a row drawing an icon and a row drawing a picture ended up
// different heights, which tilted the heading off the line the number and the
// chevron sit on and pushed one row's words up against its glyph.
export const PRESS_GLYPH_SHAPE = { size: 20, box: { w: 20, h: 20 } };

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
export const DEFAULT_BUTTON_ICONS = {
  button_power: 'mdi:power',
  button_back: 'mdi:keyboard-backspace',
  button_voice: 'mdi:microphone',
  button_volume_up: 'mdi:plus',
  button_volume_down: 'mdi:minus',
};

// Slider mechanics are numbers, coerced on both the read (render) and write
// (input) paths — the renderer interpolates them straight into markup, so a
// hand-edited template YAML or older stored value must not reach the DOM as an
// arbitrary string.
//
// Two traps this threads between:
//   - `parseFloat(v) || fallback` silently turns a legitimate 0 into the
//     fallback, which made "max: 0" impossible to type.
//   - `Number("")` is 0, not NaN, so a plain `Number.isFinite` check quietly
//     turns an emptied field into 0 instead of using the fallback — and a
//     factor of 0 is exactly the dead-slider case the backend clamps against.
// So: blank-ish inputs take the fallback, everything else must parse finite.
export const num = (value, fallback) => {
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
export const entityIcon = (entityId, stateObj) => {
  const own = stateObj?.attributes?.icon;
  if (typeof own === "string" && own.trim()) return own.trim();
  return ENTITY_DOMAIN_ICONS[domainOf(entityId)] || "mdi:cog";
};

// Sensitivity bounds for the `<input type="number">`. These mirror
// `action_controller.SLIDER_FACTOR_MIN` / `_MAX`, which is where they are
// actually enforced — the attributes only feed the form-validity API and do not
// block a `change` event. Named here so both slider cards advertise the same
// range, rather than each carrying its own literal.
export const FACTOR_MIN = 0.1;
export const FACTOR_MAX = 5;

// The domains a slider can drive at all, derived rather than restated so a new
// entry in the table is offered by the entity picker automatically. An empty
// table (the fetch failed) yields null rather than [], because an empty
// includeDomains offers the user nothing at all — better an unfiltered picker
// than a dead one.
export const sliderDomains = (controls) =>
  controls?.length ? [...new Set(controls.map(c => c.domain))] : null;

export const domainOf = (entityId) => String(entityId || "").split(".")[0];

// Does this specific entity actually support the control? Domain alone is not
// enough: an xy-only lamp is a `light` but has no colour temperature, and
// writing `color_temp_kelvin` to it does nothing at all. HA gates each tile
// feature the same way (`supportsLightColorTempCardFeature` et al) so the
// picker can never offer something the device will silently ignore.
//
// `stateObj` optional: without it we cannot test capability, so fall back to
// the domain list rather than hiding everything (e.g. hass not ready yet).
export const controlSupported = (control, stateObj) =>
  !stateObj || descriptorMatches(control.supported, stateObj);

export const controlsForEntity = (controls, entityId, stateObj) => (controls || [])
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
//
// HA's own fields are named differently: a <label for> cannot reach into their
// shadow root, so the caption goes on the field as its label attribute and is
// drawn by HA inside the outline, the way every HA form shows it. Nor do they
// forward aria-describedby, so the hint stays the visible line below them.
let fieldUid = 0;
const FIRST_CONTROL = /^([\s\S]*?<(select|textarea|input|ha-input-search|ha-input|ha-select)\b)([^>]*)(>[\s\S]*)$/;
export const nameControl = (control, describedBy, label = "") => {
  const m = FIRST_CONTROL.exec(control || "");
  if (!m) return { control, id: "" };
  const [, head, tag, attrs, tail] = m;
  if (tag.startsWith("ha-")) {
    const named = /\s(?:accessible-)?label="/.test(attrs) || !label
      ? "" : ` label="${String(label).replace(/"/g, "&quot;")}"`;
    return { control: `${head}${named}${attrs}${tail}`, id: "", ha: true };
  }
  // A control that already names itself keeps that name: the label still has
  // to point somewhere, and a second `id` would be invalid.
  const own = /\sid="([^"]*)"/.exec(attrs);
  const id = own ? own[1] : `liza-cf-${++fieldUid}`;
  const extra = (own ? "" : ` id="${id}"`)
    + (describedBy ? ` aria-describedby="${describedBy}"` : "");
  return { control: `${head}${extra}${attrs}${tail}`, id };
};

export const configFieldHtml = ({ label, control, hint = "", action = "" }) => {
  // A hint is not decoration: "0.1 to 10" and "this field is ignored while a
  // page default applies" both change what a correct answer looks like, and
  // sighted users get them for free by looking down.
  const hintId = hint ? `liza-cf-hint-${++fieldUid}` : "";
  const named = nameControl(control, hintId, label);
  return `
        <div class="config-field">
          ${label && !named.ha ? `<label${named.id ? ` for="${named.id}"` : ""}>${label}</label>` : ""}
          ${action ? `<div class="config-tooltip-row">${named.control}${action}</div>` : named.control}
          ${hint ? `<span class="config-field-hint" id="${hintId}">${hint}</span>` : ""}
        </div>`;
};

// A control is chosen from a list, or stated when the list has one entry. Both
// arms need that rule and both used to spell it out: a <select> whose only
// option is the one already selected looks operable and is not, and hiding it
// instead leaves nothing on the card to say a media player's slider means
// Volume. So the choice is between a select and a readout, never between a
// select and nothing.
export const sliderControlFieldHtml = ({ useSelect, selectAttrs, activeLabel, selectClass, iconHtml }) =>
  useSelect
    ? `<ha-select class="${selectClass}"${selectAttrs}></ha-select>`
    : `<div class="slider-control-static">
             ${iconHtml}
             <span>${activeLabel}</span>
           </div>`;

// Which control (if any) the stored config currently expresses. Anything that
// doesn't line up exactly is "Custom" — the user hand-edited the advanced
// fields and we must not silently snap their values back to a preset.
export const matchControl = (controls, sa) => (controls || []).find(c =>
  c.attribute === sa.attribute && c.service === sa.service && c.data_key === sa.data_key
) || null;

// The real range for this entity. HA reads these off the entity too
// (min_color_temp_kelvin, min_temp…) instead of assuming a global range — a
// lamp that only reaches 2200–4000 K would otherwise be sent values it clamps
// or rejects. `range_attrs` arrives as data for the same reason `supported`
// does: a function could not have crossed the wire.
export const controlRange = (control, stateObj) => {
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

export const sliderSubjectEntity = assign => {
  const entity = sliderBlock(assign)?.entity_id;
  return typeof entity === "string" ? entity.trim() : null;
};

export const sliderControlOverride = assign => {
  const control = sliderBlock(assign)?.control;
  return typeof control === "string" ? control.trim() : "";
};

// Writing the subject writes the whole block, because the control cannot
// outlive the device it is a capability of: dropping the subject drops the
// block entire, which is what stops a cleared button from keeping a control id
// for a retarget that no longer happens.
export const setSliderSubject = (assign, entityId) => {
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
export const setSliderControl = (assign, control) => {
  const block = sliderBlock(assign);
  if (!block) return;
  if (control) block.control = control;
  else delete block.control;
};

// Is a press a toggle? The click actions a slider naturally belongs to: "toggle
// the lamp" on the tile, its brightness on the strip beside it. `turn_on` with
// a fixed brightness or a scene already says what level it wants.
const isToggleService = service => typeof service === "string" && /\.toggle$/.test(service);

// What choosing an action should do to a grid button's slider subject, when
// the user has not said: `undefined` leaves it, a string names the device, and
// `null` drops the block.
//
// The Hue template opts every lamp tile in by hand; this does the same for a
// tile built in the panel. Only on a *change* of the click action -- the
// autosave commits the same sequence again and again, and a subject the user
// just cleared must stay cleared. A block the user pointed somewhere else is
// theirs and is never touched; one that merely mirrored the old action follows
// it to the new one, or goes with it.
export const autoSliderSubject = ({
  key, assign, prevService, prevEntity, service, entity, controls, stateObj, pageSliderFollows,
}) => {
  if (!isGridBtn(key) || !pageSliderFollows) return undefined;
  if (prevService === service && prevEntity === entity) return undefined;
  const current = sliderSubjectEntity(assign);
  const mirrored = current === null || (!!prevEntity && current === prevEntity);
  if (!mirrored) return undefined;
  const drivable = isToggleService(service) && !!entity
    && controlsForEntity(controls, entity, stateObj).length > 0;
  if (drivable) return entity;
  return current === null ? undefined : null;
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
export const shownControl = (available, storedId) =>
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
// is declared, and a template that wants it says so in YAML.
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
export const sliderRetarget = (
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
  // whole axis. A stored `slider_select` says nothing here: it is the template
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

export const applyControl = (sa, control, stateObj) => {
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
export const SLIDER_VERTICAL_KEY = "slider_vertical";

// A slider's target is a separate question from its mechanic: `mode` says how a
// drag behaves, `target` says what it lands on. These name the derived targets,
// mirroring the backend's `SLIDER_TARGET_*` so the two cannot drift; neither is
// ever stored. "Lands on whatever was last touched"…
export const SLIDER_TARGET_LAST_TOUCHED = "last_touched";
// …and the same with an entity to drive until something is touched, differing
// only by whether the "Default entity" field is filled.
export const SLIDER_TARGET_LAST_TOUCHED_OR_ENTITY = "last_touched_or_entity";
// The one target that does *not* follow. Unspellable from this panel by design
// — there is no Target row to write it — but honoured everywhere, so a
// hand-written page YAML can still pin a slider that must never move.
export const SLIDER_TARGET_ENTITY = "entity";
// What a stored config targets, mirroring the backend's `_effective_target`:
// with no `target` key, following, with the stored entity as the default when
// there is one. `entity` is the only stored target; anything else targets
// nothing.
export const effectiveTarget = (sa) => {
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
export const followsSelection = (sa) => {
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
// spelling every template preset uses, `retargets` came back false, so the icon
// and label edited under a selected grid button silently landed on the page's
// own slider record instead of the button's.
//
// The `Object.entries` sweep cannot see a key that is not there, so the first
// term is not a shortcut for it. Absence is the spelling of "follows" for the
// vertical slider, and a sweep over stored entries is structurally unable to
// observe an absence. Any rewrite that drops the first line reintroduces the
// bug in full.
export const pageSliderFollowsIn = (assigns) => {
  const all = assigns || {};
  // An unconfigured vertical slider follows the selection — including one with
  // no assignment at all, which is how a template that declares no slider gets
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
// Storing the third *in* `icon` was tried and was a real bug --
// `isConfigured` reads `icon`, so clearing the icon on an untouched slider
// made it paint as configured, which is the regression 44a7bc6 fixed. The
// argument for safety was that a derived icon implies `slider_actions.mode`,
// which `isConfigured` already accepts; true, but clearing is offered on
// sliders with no mode, so the precondition did not hold where it mattered.
//
// The general rule, which this file has now paid for twice: never dress a
// statement about a field up as a value of that field. `icon` is read by
// `isConfigured`, by `device_sync`'s `resolve_icon_url`, and by the face; a
// magic string there is a string every one of them must be taught.
export const SLIDER_ICON_HIDDEN_KEY = "slider_hide_icon";

// The icon a slider actually shows, given what is stored and what it would
// derive. One owner, because the card's preview, the card's picker and the face
// must not answer it differently — the last time two of them disagreed, the
// answer was three rounds of explaining the disagreement instead of removing it.
export const resolveSliderIcon = (stored, auto, hidden = false) => {
  if (hidden) return "";
  if (typeof stored === "string" && stored.trim()) return stored;
  return auto || "";
};

export const sliderIconFor = (controls, assign) => {
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
// following slider stores nothing. The remote face asks a narrower question;
// see `storesConfig` below.
export const isConfigured = (assign) => !!(assign?.action_id || assign?.slider_actions?.mode || assign?.icon
  || assign?.longtouch?.length);

// `isConfigured` minus the one shape that stores the *absence* of a
// configuration: a bare proportional blob with no target is how the save path
// spells "follow the selection" (`last_touched_slider_actions`).
//
// Kept separate because `isConfigured` is parity-bound — `_mayBeContext`
// mirrors the backend's `may_be_context`, which asks only for a mode. This one
// answers "has the user set something up here", which is what the face paints.
export const storesConfig = (assign) => {
  const sa = assign?.slider_actions;
  if (sa?.mode && targetsLastTouched(sa)) {
    return !!(assign.action_id || assign.icon || assign.longtouch?.length);
  }
  return isConfigured(assign);
};

// The face paints from `storesConfig`, i.e. from what a control *stores*, and
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
export function gotoLinkPath(x1, y1, x2, y2, trim = 0) {
  const r = (n) => Math.round(n * 10) / 10;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!len) return `M${r(x1)},${r(y1)}`;
  const bow = Math.min(44, len * 0.2);
  const cx = (x1 + x2) / 2 + (-dy / len) * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * bow;
  // *trim* pulls the end back along the end tangent (control point -> end),
  // so the line stops inside the arrowhead whose tip marks the true end.
  let ex = x2;
  let ey = y2;
  const tx = x2 - cx;
  const ty = y2 - cy;
  const tlen = Math.hypot(tx, ty);
  if (trim > 0 && tlen > trim) {
    ex = x2 - (tx / tlen) * trim;
    ey = y2 - (ty / tlen) * trim;
  }
  return `M${r(x1)},${r(y1)} Q${r(cx)},${r(cy)} ${r(ex)},${r(ey)}`;
}
