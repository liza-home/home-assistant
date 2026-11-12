/**
 * lizaIP Panel — context menus.
 *
 * The one menu every surface opens -- the tile and page menus on the Buttons
 * tab, the diagnostics ⋮ in the toolbar and on the Settings tab -- and the
 * code that puts it away again and hands focus back.
 *
 * Assigned onto the panel's prototype like every other mixin, so these methods
 * run with `this` bound to the panel element.
 */

export const MenuMixin = {
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

    if (globalThis.customElements?.get?.("ha-dropdown") && customElements.get("ha-dropdown-item")) {
      this._openHaMenu(ev, items, { keepCase, anchor });
      return;
    }

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
    // Anything else the user does puts it away. Kept so `_closeFaceMenu` can
    // take them off again: a menu closed by an item or Escape used to leave
    // them behind, and the leftover click then closed the *next* menu.
    //
    // The click listener waits a tick. Added while the click that opened the
    // menu is still being dispatched, it would hear that same click bubble up
    // to the root and close the menu it had just opened.
    this._faceMenuDismiss = { root, fn: dismiss };
    this._faceMenuClickTimer = setTimeout(() => {
      this._faceMenuClickTimer = null;
      if (this._faceMenuEl === menu) root.addEventListener("click", dismiss, { once: true });
    }, 0);
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

  /** The menu as Home Assistant draws one: `ha-dropdown`, which brings the
   *  look, the arrow keys, Escape and the click outside that closes it. It
   *  opens where it was asked for -- at the pointer, or under the ⋮ that
   *  asked -- by hanging off an empty element placed there. */
  _openHaMenu(ev, items, { keepCase = false, anchor = null } = {}) {
    const root = this.shadowRoot;
    const lang = this._lang?.() || undefined;
    const spot = document.createElement("span");
    spot.className = "face-menu-anchor";
    const rect = anchor?.getBoundingClientRect?.();
    const x = rect ? rect.right : Number(ev?.clientX) || 0;
    const y = rect ? rect.bottom : Number(ev?.clientY) || 0;
    spot.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;`;

    const menu = document.createElement("ha-dropdown");
    menu.className = "face-menu";
    menu.setAttribute("placement", rect ? "bottom-end" : "bottom-start");
    menu.innerHTML = items.map(it => it.separator
      ? "<wa-divider></wa-divider>"
      // `cls` is the item's value: what the choice below is looked up by, and
      // the hook the tests and the stylesheet use.
      : `<ha-dropdown-item class="face-menu-item ${it.cls}" value="${it.cls}"`
        + `${it.danger ? ' variant="danger"' : ""}${it.disabled ? " disabled" : ""}>`
        + (it.icon ? `<ha-icon slot="icon" icon="${it.icon}" aria-hidden="true"></ha-icon>` : "")
        + `${keepCase ? String(it.label) : String(it.label).toLocaleLowerCase(lang)}</ha-dropdown-item>`).join("");
    root.appendChild(spot);
    root.appendChild(menu);
    menu._lizaAnchor = spot;
    this._faceMenuEl = menu;

    menu.addEventListener("wa-select", (e) => {
      const it = items.find(i => i.cls === e.detail?.item?.value);
      this._closeFaceMenu();
      if (it && !it.disabled) it.run();
    });
    // Escape, a click outside, a choice: every way it closes ends here.
    menu.addEventListener("wa-after-hide", () => {
      if (this._faceMenuEl === menu) this._closeFaceMenu();
    });
    // Opened from the keyboard (the menu key, Shift+F10) the first item takes
    // the focus, as a menu's does.
    menu.addEventListener("wa-after-show", () => {
      menu.querySelector("ha-dropdown-item:not([disabled])")?.focus?.();
    }, { once: true });
    Promise.resolve(menu.updateComplete).then(() => {
      if (this._faceMenuEl !== menu) return;
      menu.anchorElement = spot;
      menu.open = true;
    });
  },

  /** Put the tile menu away, if one is open. Safe to call when none is. */

  _closeFaceMenu() {
    if (this._faceMenuClickTimer != null) {
      clearTimeout(this._faceMenuClickTimer);
      this._faceMenuClickTimer = null;
    }
    if (this._faceMenuDismiss) {
      const { root, fn } = this._faceMenuDismiss;
      root.removeEventListener?.("click", fn);
      window.removeEventListener?.("resize", fn);
      this._faceMenuDismiss = null;
    }
    if (this._faceMenuKey) {
      window.removeEventListener?.("keydown", this._faceMenuKey);
      this._faceMenuKey = null;
    }
    const el = this._faceMenuEl;
    this._faceMenuEl = null;
    el?._lizaAnchor?.remove?.();
    if (el?.parentNode) el.parentNode.removeChild(el);
    // Focus was moved into the menu when it opened, so removing the node
    // leaves activeElement on <body> -- the user's next Tab starts from the
    // top of the Home Assistant frontend, with nothing on screen saying why.
    // Only when a menu was really open: _showFaceMenu calls this first thing,
    // and that call must not move focus.
    const token = this._faceMenuReturn;
    this._faceMenuReturn = null;
    if (el && token && !this._a11yRestoreFocus?.(token)) this._a11yFocusFallback?.();
  },
};
