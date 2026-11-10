/**
 * lizaIP Panel — Buttons View: The press list and the toggle block inside one button's config card.
 *
 * One slice of `ButtonsViewMixin`. The barrel one directory up spreads the
 * slices into a single object, so these methods still run with `this` bound
 * to the panel element and may call any other method on it.
 */
import {
  MODE_CYCLE,
  isGridBtn,
  num,
  SLIDER_VERTICAL_KEY,
  SLIDER_ICON_HIDDEN_KEY,
} from "./shared.js";

export const ButtonsPressesMixin = {
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
      ? (this._assignments[apprRead.key]?.[apprRead.iconKey] || "")
      : (assign.icon || "");
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
          // No `icon_pinned` in the scoped case: that flag ranks an explicit
          // icon above a payload thumbnail on the *button's tile*, and this is
          // the slider's glyph. Setting it would change what the device is sent
          // for a tile the user was not editing.
          const rec = this._writeSliderIcon(appr, picked);
          if (!appr.scoped) {
            if (picked) rec.icon_pinned = true;
            else delete rec.icon_pinned;
          }
        } else {
          const target = this._editAssignEnsure(selBtn.key);
          target.icon = picked;
          // An explicitly picked icon outranks the payload thumbnail.
          if (picked) target.icon_pinned = true;
          else delete target.icon_pinned;
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
  // (see `_pressHeadings` and `_pressDefaultTooltip`), so reading it again would
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
   * way the device resolves it -- `_substituteTooltipTokens` is the twin of the
   * backend's `substitute_tooltip_tokens` -- so the heading says the words the
   * remote will actually print.
   */

  _pressHeadings(rules) {
    return (rules || []).map(rule => {
      // Only when the tooltip is *words*. A tooltip takes any media source
      // now, so a press captioned with a glyph would put `mdi:battery-50` up
      // as its heading -- a filename read as a sentence. That caption is
      // already drawn, as the glyph; the heading falls through instead.
      const raw = rule?.tooltip || "";
      // Through the same resolver the field below the heading uses, against
      // the press's own target. An empty value map was passed here, which
      // *stripped* a stored `${_state}` instead of reading it -- so a press
      // captioned "Schreibtisch ${_state}" was headed by the bare word
      // "Schreibtisch" while the field under it, and the remote, said
      // "Schreibtisch On".
      const tip = this._isMediaSource?.(raw)
        ? ""
        : this._displayTooltip(
            raw,
            { service: rule?.config?.[0]?.action || "" },
            this._getTargetEntityFromConfig(rule?.config || []),
            rule?.config,
            rule,
          );
      return tip || this._pressDefaultTooltip(rule, this._toggleRuleName(rule));
    });
  },

  /**
   * What a press's Tooltip field offers when it is left blank.
   *
   * The same question press 1's field answers, so it has to be answered the
   * same way. Press 1 shows `_computeTooltip`, which reads the subject the step
   * points at; a press row showed `_toggleRuleName`, which is the service's
   * name and nothing else. Two rows apart, the same empty field promised
   * "Turn on" in one place and "Desk lamp" in the other, and only one of them
   * was what the remote would draw.
   *
   * Falls back to the row's heading, which is what it used to show outright.
   *
   * `_computeTooltip` returns a *template* for a two-way service -- a bare
   * `${_state}`, which the caller persists and the device resolves per press.
   * Correct to store, unreadable to show: a press duplicated from a
   * `light.toggle` was headed `${_state}` and offered it as its placeholder,
   * next to a sibling reading "Apagado".
   *
   * So the template is resolved the way the device resolves it. Not
   * `_resolveTooltip`, which re-derives the whole ladder from the *entity's*
   * state and so heads every press of a media button "Pause" whatever its own
   * service is; `_displayTooltip` fills the token against this press's service
   * and target.
   */

  _pressDefaultTooltip(rule, fallback = "") {
    const action = rule?.action_id
      ? (this._actions || []).find(a => a.id === rule.action_id) || null
      : null;
    const entity = this._getTargetEntityFromConfig?.(rule?.config) || "";
    const derived = this._computeTooltip(action, entity, rule?.config);
    if (!derived) return fallback;
    return this._displayTooltip(derived, action, entity, rule?.config) || fallback;
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
    root.querySelectorAll(".icon-picker-slot[data-toggle-tooltip-idx]").forEach(slot => {
      const idx = Number(slot.dataset.toggleTooltipIdx);
      const input = slot.querySelector(".toggle-press-tooltip");
      if (!input) return;
      this._wireMediaInput(
        input,
        slot.querySelector(".liza-media-suggest"),
        (typed) => {
          const text = String(typed || "").trim();
          this._toggleUpdate(key, (block) => {
            const rule = block.rules[idx];
            if (!rule) return;
            if (text) rule.tooltip = text; else delete rule.tooltip;
          });
        },
        {
          ...this._pageDeviceOption(),
          // The press's own config decides, exactly as `pressShowsMedia` above
          // decides whether to explain these tokens: a cycle step pointed at a
          // speaker gets the track tokens, one pointed at a lamp does not.
          ...this._tooltipTokenOptions((this._toggleRules(key)[idx] || {}).config),
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
