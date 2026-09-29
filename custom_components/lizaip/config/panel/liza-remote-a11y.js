// Keyboard activation for controls the templates promote from <div>, and
// focus across a re-render. Roles and names live in those templates; modal
// dialogs are native <dialog>, so the platform supplies the focus trap.

/** Anything that already takes focus and handles its own keys. */
const NATIVE = "a[href], button, input, select, textarea";

// HA's pickers are listed by tag because their real control sits in a shadow
// root querySelectorAll cannot see -- the page-title editor is built from
// nothing else, so without them that card has no focusable child at all.
const HA_FIELDS =
  "ha-icon-picker, ha-entity-picker, ha-textfield, ha-select, ha-combo-box, ha-picker-field";
const FOCUSABLE = `${NATIVE}, [tabindex="0"], ${HA_FIELDS}`;

// Marks a tabindex this file wrote, so a later pass may correct its own work
// (a control that became disabled) without ever overwriting the templates'.
const TABSTOP_MARK = "data-a11y-tabstop";

// Every `data-*` on the node as an attribute selector, minus any positional
// `data-x-idx` whose node also carries a stable `data-x-id`: reorder the pages
// and an index-built selector finds a different control. Where no identity
// exists the index is still better than nothing and is kept.
const dataAttrs = (node) => {
  const attrs = [...node.attributes].filter((a) => a.name.startsWith("data-")
    // Bookkeeping from _a11yNormalizeTabStops, not part of what this control
    // is: it says who wrote the tabindex. Including it would also make every
    // selector depend on the normaliser having already run on the new node.
    && a.name !== TABSTOP_MARK);
  const names = new Set(attrs.map((a) => a.name));
  return attrs
    .filter((a) => !(a.name.endsWith("-idx")
      && names.has(`${a.name.slice(0, -4)}-id`)))
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
    .join("");
};

// A browser silently refuses focus to a hidden element, so the activeElement
// check below usually catches it -- but not in jsdom, and not before the
// element has been laid out. Asked outright, it is the same answer everywhere.
const isHidden = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden) return true;
    const inline = n.style;
    if (inline && (inline.display === "none" || inline.visibility === "hidden")) return true;
    const view = n.ownerDocument?.defaultView;
    const cs = view?.getComputedStyle?.(n);
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) return true;
  }
  return false;
};

// Focusing a text field from script leaves the caret at character zero, so the
// user types in front of their own text. Only where we move focus ourselves.
const caretToEnd = (el) => {
  if (typeof el?.setSelectionRange !== "function") return;
  const end = typeof el.value === "string" ? el.value.length : 0;
  try { el.setSelectionRange(end, end); } catch { /* a field type with no caret */ }
};

// Selectors that find the same control after a re-render, most specific first.
// Scoped forms come first: a face button or a row chevron is unique only
// within its page or row, and _a11yRestoreFocus will not guess between copies.
const focusCandidates = (el) => {
  if (!el || !el.localName) return [];
  // An id is the best selector when it is stable -- and on this panel many are
  // not. `nameControl` mints one per field from a counter that never resets,
  // because a <label for=...> needs something to point at, so a control comes
  // back from a render wearing a different id. Tried first, then fallen past:
  // returning it alone meant focus left the card on every render of every
  // labelled field.
  const byId = el.id ? [`#${CSS.escape(el.id)}`] : [];

  const data = dataAttrs(el);
  const classes = [...el.classList].map((c) => `.${CSS.escape(c)}`).join("");
  if (!data && !classes) return byId;

  // Full form, then without classes: class lists carry transient state
  // (`active`, `editing`) and the render that just happened usually moved it.
  const self = [`${el.localName}${classes}${data}`];
  if (data && classes) self.push(`${el.localName}${data}`);

  let scope = "";
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.id) { scope = `#${CSS.escape(p.id)} `; break; }
    const d = dataAttrs(p);
    if (d) { scope = `${p.localName}${d} `; break; }
  }
  const rest = scope ? [...self.map((s) => scope + s), ...self] : self;
  return [...byId, ...rest];
};

// Where focus goes when the control that had it is gone. Most meaningful
// first: what the action was about, and named, before any bare container.
// `pad` marks a landing pad: a container, not a control. Focus has to go
// somewhere, but ringing a region that wraps the whole panel says "everything
// is focused", which is noise -- the stylesheet drops the ring for those.
const FALLBACKS = [
  { sel: ".page-thumb.active" },
  { sel: ".action-row.editing" },
  { sel: ".actions-list", pad: true },
  { sel: ".config-layout", pad: true },
  { sel: "ha-card", pad: true },
];

export const A11yMixin = {
  /** Attach the one listener the panel needs. Safe to call more than once. */
  _a11yInit() {
    const sr = this.shadowRoot;
    if (!sr || this._a11yKeydown) return;

    this._a11yKeydown = (e) => {
      try {
        this._a11yOnKeydown(e);
      } catch (err) {
        // A keyboard shortcut must never be the reason the panel stops
        // working: a missed key is recoverable, a thrown listener is not.
        console.error("[LIZA] a11y keydown failed:", err);
      }
    };
    sr.addEventListener("keydown", this._a11yKeydown);
  },

  _a11yStop() {
    if (this._a11yKeydown) {
      this.shadowRoot?.removeEventListener("keydown", this._a11yKeydown);
      this._a11yKeydown = null;
    }
    // Not guarded by the listener above: the observers are attached lazily on
    // the first render, so a panel can hold them without ever having got as
    // far as binding a key handler.
    for (const { obs } of this._a11yTabStopObservers || []) obs.disconnect();
    this._a11yTabStopObservers = [];
    // Dropped with them. The set is what makes _a11yObserveTabStops skip a
    // root it has already seen, so keeping it would leave a re-attached panel
    // watching nothing.
    this._a11yTabStopRoots = null;
  },

  _a11yOnKeydown(e) {
    // Escape first: it is not tied to a promoted control, and the lookup below
    // would drop it whenever focus sat in a plain text field.
    if (e.key === "Escape" && this._a11yEscape(e)) return;

    // `composedPath` rather than `e.target`: a click inside a promoted
    // container (the chevron in an action row, a chip) is retargeted to the
    // host by the time it reaches the shadow root.
    const el = e.composedPath().find(
      (n) => n instanceof Element && (n.getAttribute?.("role") === "button" || n.getAttribute?.("role") === "tab"),
    );
    if (!el) return;

    if (el.getAttribute("role") === "tab") return this._a11yTabKeys(e, el);

    if (e.key !== "Enter" && e.key !== " ") return;
    // Native controls already do this, and doing it twice fires the handler
    // twice — once from the browser's own activation, once from ours.
    if (el.matches(NATIVE)) return;
    // Space scrolls by default, which would drag the view away from the
    // control the user just activated.
    e.preventDefault();
    // Re-dispatched, not called directly: several of these are wired through
    // an ancestor, so a real click keeps keyboard and pointer on one path.
    el.click();
  },

  /** Arrow keys along the tab strip: `role="tab"` without them is a promise
   *  the markup does not keep. */
  _a11yTabKeys(e, tab) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const list = tab.closest('[role="tablist"]');
    if (!list) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    if (i < 0) return;

    e.preventDefault();
    const next = e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    // Activating on arrow, not only on Enter: both panels are already built
    // and switching is instant, so following the selection is the behaviour
    // with the least to explain. `_render` re-establishes focus via the id.
    tabs[next].focus();
    tabs[next].click();
  },

  /** True while an editor is deliberately open -- a button's config card, or
   *  the page title row. The title row is not a button, so it does not show up
   *  in `_selectedButtonIdx`, and every focus rule that asked only about that
   *  quietly skipped the one control sitting next to them on the same face. */
  _a11yEditorOpen() {
    return this._selectedButtonIdx >= 0 || !!this._pageTitleSelected;
  },

  /** The name a person gave this button, or nothing. Never the storage key:
   *  `button_3` is an internal identifier, and the card stopped printing it
   *  for the same reason it should not be announced. Resolved, not stored, so
   *  a placeholder is not read out as "dollar sign, left brace, STATE". */
  _a11yButtonName(key) {
    return String(this._buttonSpokenLabel?.(this._editAssign?.(key)) || "").trim();
  },

  /** An editor just opened or closed. Both callers render first and then say
   *  where focus went and why; keeping the two halves in one place is what
   *  stops the button card and the page title row drifting apart. */
  _a11yEditorToggled(opened, openMsg, closeMsg) {
    if (opened) {
      // Opening reveals the editor, so focus follows in rather than staying on
      // a face shape whose panel just changed underneath it.
      this._a11yFocusConfigView();
      this._a11yAnnounce(openMsg);
    } else {
      // The trigger can be gone -- closing after deleting the page it lived
      // on -- and then focus would be left on nothing at all.
      if (!this._a11yReturnToTrigger()) this._a11yFocusFallback();
      this._a11yAnnounce(closeMsg);
    }
  },

  /** Remember the control that opened the config card, so closing it can hand
   *  focus back instead of leaving the user at the top of the page strip.
   *  Call before the render that replaces it. */
  _a11yRememberTrigger() {
    this._a11yTrigger = this._a11yCaptureFocus();
  },

  /** Hand focus back to it. Returns false when there was no trigger, or it is
   *  gone, so the caller can fall back. */
  _a11yReturnToTrigger() {
    const token = this._a11yTrigger;
    this._a11yTrigger = null;
    return token ? this._a11yRestoreFocus(token) : false;
  },

  /** Escape closes the open config card. Returns true when it acted, so the
   *  caller knows to stop. */
  _a11yEscape(e) {
    // Everything else that owns Escape gets it first. Move mode and the face
    // menu listen on `window`, which is downstream of this shadow-root
    // listener, so without these two checks we would swallow their key.
    if (e.defaultPrevented || this._moveSourceKey || this._faceMenuEl) return false;
    // A native <dialog> has its own Escape, and the platform's beats ours.
    if (this.shadowRoot?.querySelector("dialog[open]")) return false;
    if (!this._a11yEditorOpen()) return false;

    e.preventDefault();
    // Both close by re-activating what opened them, so Escape and a second
    // click cannot drift apart.
    if (this._selectedButtonIdx >= 0) this._selectButton(this._selectedButtonIdx);
    else this._selectFaceKey("slider_horizontal");
    return true;
  },

  /** One polite status region, reused across renders. `_render` replaces the
   *  shadow root's markup, and a region created in the same breath as its text
   *  has no change to report, so the node is kept and re-attached. */
  _a11yLiveRegion() {
    const sr = this.shadowRoot;
    if (!sr) return null;
    if (!this._a11yLive) {
      const el = document.createElement("div");
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.className = "liza-sr-only";
      this._a11yLive = el;
    }
    if (this._a11yLive.parentNode !== sr) sr.appendChild(this._a11yLive);
    return this._a11yLive;
  },

  /** Say what just happened. Moving focus silently is disorienting when the
   *  screen is not what you are reading. */
  _a11yAnnounce(msg) {
    const el = this._a11yLiveRegion();
    if (!el || !msg) return;
    // The same text twice is not a change, and an unchanged region is not
    // announced. Clearing first makes repeating an action audible.
    el.textContent = "";
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => { el.textContent = msg; });
    } else {
      el.textContent = msg;
    }
  },

  /** Remember what has focus for `_render` to hand back. Returns an opaque
   *  token, or null when nothing worth restoring had focus. */
  _a11yCaptureFocus() {
    const active = this.shadowRoot?.activeElement;
    if (!active || active === this.shadowRoot) return null;
    const candidates = focusCandidates(active);
    // A control that disappears *because it worked* -- the tooltip's ✓ is
    // hidden again once there is nothing left to save -- names where focus
    // should go instead. Without it the restore fails and focus falls out to
    // a container, which reads as "you have been moved" for no reason.
    const after = active.getAttribute?.("data-a11y-focus-after") || "";
    if (!candidates.length && !after) return null;
    // Where the caret was, so restoring focus to a field the user is typing in
    // does not send them back to character zero.
    const caret = typeof active.selectionStart === "number"
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
    return { candidates, caret, after };
  },

  /** Restore focus, retrying after the frame. A field inside a freshly built
   *  <ha-card> is not rendered until that card fills its own shadow root a
   *  tick later, and the platform refuses focus until it is -- with `display`
   *  still reading normal, so no visibility test can catch it. */
  _a11yRestoreFocusSoon(token) {
    if (this._a11yRestoreFocus(token)) return;
    const gen = (this._a11yFocusGen = (this._a11yFocusGen || 0) + 1);
    const retry = () => {
      // A newer render, or focus the user has since placed themselves.
      if (gen !== this._a11yFocusGen || this.shadowRoot?.activeElement) return;
      if (!this._a11yRestoreFocus(token)) this._a11yFocusFallback();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(retry);
    else setTimeout(retry, 0);
  },

  /** Put focus back where `_a11yCaptureFocus` found it. Returns false when it
   *  cannot -- the control was destroyed, or stopped being focusable (a
   *  thumbnail is a button only while its page is closed). */
  _a11yRestoreFocus(token) {
    if (!token) return true;   // nothing had focus; nothing to answer for
    const sr = this.shadowRoot;
    if (!sr) return false;
    for (const sel of token.candidates) {
      let found;
      try {
        found = sr.querySelectorAll(sel);
      } catch {
        continue; // a selector we built badly must not take the render down
      }
      // Ambiguous is worse than nothing: focusing the wrong one of five
      // identical rows moves the user somewhere they did not ask to go.
      if (found.length !== 1) continue;
      const el = found[0];
      if (typeof el.focus !== "function" || isHidden(el)) continue;
      el.focus();
      // HA's pickers keep their real control in a shadow root and the host
      // itself does not take focus. Either way the document reports the host
      // as the active element, so the check below still answers for both.
      if (sr.activeElement !== el && el.shadowRoot) {
        const inner = el.shadowRoot.querySelector(NATIVE);
        if (inner && typeof inner.focus === "function") inner.focus();
      }
      // `focus()` on an element that is no longer focusable is a silent no-op,
      // and reporting success there is how focus gets lost while every check
      // still passes. Ask the document, do not assume.
      if (sr.activeElement !== el) continue;
      if (token.caret && typeof el.setSelectionRange === "function") {
        try { el.setSelectionRange(token.caret.start, token.caret.end); } catch { /* not a text field after all */ }
      }
      return true;
    }
    // The control is gone. If it said where to go next, that beats the
    // fallback: the fallback is for focus that has nowhere to be.
    if (token.after) {
      const next = sr.querySelector(token.after);
      if (next && typeof next.focus === "function" && !isHidden(next)) {
        next.focus();
        if (sr.activeElement === next) { caretToEnd(next); return true; }
      }
    }
    return false;
  },

  /** Focus the first usable control in the open button's config card.
   *  Selecting reveals an editor, so focus follows into it. Returns false when
   *  the card has nothing that will take focus. */
  _a11yFocusConfigView() {
    if (this._a11yFocusConfigViewOnce()) return true;
    // HA's own controls are not always upgraded by the time the markup lands,
    // and an un-upgraded component refuses focus. Give the frame a chance.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (!this._a11yEditorOpen()) return;
        // Still nothing that will take focus -- an editor built only from HA
        // components that never upgraded. Focus is on the shape the render
        // destroyed, so it has to go somewhere rather than nowhere.
        if (!this._a11yFocusConfigViewOnce()) this._a11yFocusFallback();
      });
    }
    return false;
  },

  _a11yFocusConfigViewOnce() {
    const sr = this.shadowRoot;
    const card = sr?.querySelector(".config-card");
    if (!card) return false;
    for (const el of card.querySelectorAll(FOCUSABLE)) {
      if (el.disabled || el.getAttribute("aria-hidden") === "true") continue;
      // `preventScroll`: the caller scrolls the editor into view on purpose a
      // frame later, and focus() doing it first makes the two fight.
      el.focus({ preventScroll: true });
      // A control can be present and still refuse focus -- hidden, not yet
      // upgraded, zero-sized. Ask the document rather than assume, and move on.
      if (sr.activeElement === el) { caretToEnd(el); return true; }
    }
    return false;
  },

  /** Focus never evaporates. Without this the browser drops it on <body>,
   *  which means tabbing in from the top of HA again with nothing on screen
   *  to say why. Targets are tabindex="-1", so this adds no tab stop. */
  _a11yFocusFallback() {
    const sr = this.shadowRoot;
    if (!sr) return;
    // With an editor open the config card is where the user is working, so a
    // re-render that cannot restore its exact control should still land there
    // rather than skip out to a container wrapping the whole panel.
    if (this._a11yEditorOpen() && this._a11yFocusConfigViewOnce()) return;
    for (const { sel, pad } of FALLBACKS) {
      const el = sr.querySelector(sel);
      if (!el) continue;
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      if (pad) el.setAttribute("data-a11y-landing", "");
      // A landing pad is where focus ended up, not where the user asked to go;
      // scrolling the page to it would move the view for no reason they gave.
      el.focus({ preventScroll: true });
      if (sr.activeElement === el) {
        // A container does not announce its own name the way a control does:
        // VoiceOver reads a group's label when entering its contents, not when
        // the group itself takes focus, so it would say only "current page".
        //
        // `data-a11y-name` first, and it is what the landing pads carry now: a
        // div with an accessible name but no role is exposed as a *group*, so
        // naming these with `aria-label` is what put "group" back on the end of
        // every announcement after every `role="group"` had been removed. A data
        // attribute carries the words here without naming anything.
        const name = el.getAttribute("data-a11y-name") || el.getAttribute("aria-label");
        if (name) this._a11yAnnounce(name);
        return;
      }
      el.removeAttribute("data-a11y-landing");
    }
  },

  /** Write the tab stop the markup already implies. macOS Safari without
   *  "Full Keyboard Access" drops bare native controls from tab order but
   *  honours an explicit tabindex, and conformance is judged on a browser's
   *  defaults. tabindex="0" means "focusable, in document order", so this is
   *  a no-op in Chrome and Firefox and restores the controls in Safari.
   */
  _a11yNormalizeTabStops(root) {
    const scope = root || this.shadowRoot;
    if (!scope) return;
    const els = [...scope.querySelectorAll(NATIVE)];
    // querySelectorAll looks only at descendants, but a partial repaint hands
    // us the control itself as the added node.
    if (scope.matches?.(NATIVE)) els.unshift(scope);
    for (const el of els) {
      const own = el.getAttribute("tabindex");
      // An author-set tabindex is a decision: the toolbar's two tabs are one
      // roving stop. Only values written here are ours to revise, which is
      // also what makes reaching into HA's own components below safe.
      if (own !== null && !el.hasAttribute(TABSTOP_MARK)) continue;
      // Disabled controls are stated too, rather than left out: browsers
      // disagree about whether a disabled control is focusable, and "-1" says
      // what is meant in a way none of them can read differently.
      const want = el.disabled ? "-1" : "0";
      if (own !== want) el.setAttribute("tabindex", want);
      el.setAttribute(TABSTOP_MARK, "");
    }
    // HA's own controls sit in shadow roots the walk above cannot see, and
    // the toolbar's back button is one of them. Writing the stop on the inner
    // control adds one stop, not two, in Chrome and Firefox (measured).
    for (const host of scope.querySelectorAll("*")) {
      if (host.shadowRoot) {
        this._a11yNormalizeTabStops(host.shadowRoot);
        // A MutationObserver does not cross a shadow boundary, so each root
        // needs its own or HA's next internal repaint drops the stop again.
        this._a11yObserveTabStops(host.shadowRoot);
      }
    }
  },

  /** Keep doing it. Several views repaint themselves without going through
   *  _render -- the action list, the button config panel, the state rows, the
   *  icon menu -- and the modals build their contents after opening. Watching
   *  the tree covers all of them, and anything added later, instead of asking
   *  every future caller to remember. Only childList is observed, so the
   *  attribute writes above cannot feed back into it. */
  _a11yObserveTabStops(root) {
    const scope = root || this.shadowRoot;
    if (!scope) return;
    // Drop the observers whose root has gone before adding another. A full
    // render replaces the whole tree, so the roots watched a moment ago are
    // detached and their observers are watching nothing; without this the
    // list only ever grows, one entry per nested root per repaint, for as
    // long as the panel stays open.
    const kept = [];
    for (const entry of this._a11yTabStopObservers || []) {
      const node = entry.ref.deref();
      if (node && node.isConnected) kept.push(entry);
      else entry.obs.disconnect();
    }
    this._a11yTabStopObservers = kept;
    // One per root, including each HA component's own.
    this._a11yTabStopRoots ||= new WeakSet();
    if (this._a11yTabStopRoots.has(scope)) return;
    this._a11yTabStopRoots.add(scope);
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        // A control switched on after render kept the "-1" written while it
        // was dead, so it could be clicked but never tabbed to. Only
        // `disabled` is watched and only `tabindex` written, so no feedback.
        if (r.type === "attributes") {
          if (r.target.nodeType === 1) this._a11yNormalizeTabStops(r.target);
          continue;
        }
        for (const node of r.addedNodes) {
          if (node.nodeType === 1) this._a11yNormalizeTabStops(node);
        }
      }
    });
    obs.observe(scope, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["disabled"],
    });
    // Retained so _a11yStop can disconnect it: an observer left running on a
    // nested HA shadow root keeps this panel alive for as long as that
    // component exists. Held through a WeakRef, and swept above, because a
    // full render mints a fresh root and observer on every repaint.
    (this._a11yTabStopObservers ||= []).push({ ref: new WeakRef(scope), obs });
  },
};
