/**
 * lizaIP Panel — User Guide
 *
 * The guide the repository ships as `config/docs/USER_GUIDE.md`, shown inside Home
 * Assistant so a user setting up a remote does not have to leave the page they
 * are setting it up on.
 *
 * It docks, rather than covering the panel. The whole reason to put a manual
 * in the product is "read the step, do the step", and a modal is the one shape
 * that forbids exactly that: everything behind `showModal()` is inert, so the
 * guide could only be read *instead of* configuring. Docked, the panel's own
 * columns give up the width -- nothing is hidden, and both halves stay live.
 *
 * Below `DOCK_MIN` there is no width to give up, so the modal is still here
 * and is what a phone or a 400%-zoomed window gets.
 *
 * The text is not parsed here. `scripts/build_user_guide.py` turns the
 * Markdown into `lizaip-guide-content.js` at build time, and this module
 * injects what it finds there: no parser to ship, and no sanitiser question,
 * because the content is ours and arrives reviewed.
 *
 * That module is ~57 kB of HTML, which is more than the rest of the panel's
 * text put together, so it is imported on the first open rather than at load.
 * Most sessions never open the guide, and the ones that do are a click that
 * can afford a fetch.
 */

/** The guide content, once. `null` until the first open, then the module. */
let _content = null;

/**
 * Where the screenshots are served from, resolved against this module's URL.
 *
 * It has to be absolute. The HTML is injected into the panel's shadow root,
 * and a relative `src` there resolves against the *document* (`/lizaip`),
 * not against the module that supplied it. `import.meta.url` already carries
 * the asset version the panel was registered at, so the pictures bust out of
 * the browser cache with the code that refers to them.
 */
const IMG_BASE = new URL("./guide", import.meta.url).href;

/** Narrowest the guide may be dragged: below this its own screenshots and
 *  code blocks start scrolling sideways and it stops being readable. */
const WIDTH_MIN = 320;

/**
 * Shortest search that highlights words in the text.
 *
 * One letter is in every section of a forty-page guide, so a single
 * keystroke would paint the article solid before the reader has typed
 * anything they meant. Below this the box still narrows the contents by
 * heading, which is cheap and never looks broken.
 */
const MIN_QUERY = 2;
/**
 * What the guide opens at when nothing has been dragged yet.
 *
 * Derived from the thing it is for rather than picked: the prose is capped
 * at a 76ch measure (see --liza-guide-measure), and 480 is a 64ch measure
 * plus the column's padding and the drag edge. So the text opens a little
 * short of its cap -- comfortably inside the readable 45-75ch range, with
 * the guide asking less of the configuration beside it -- and widening it
 * fills the measure rather than overrunning it. 420 was the old guess and
 * it was narrower than this, which left every screenshot shrunk and the
 * reader dragging on the first open.
 *
 * Still only a wish -- `clampWidth` cuts it to what the window can spare, so
 * a 1100px window opens narrower rather than eating the configuration.
 */
const WIDTH_DEFAULT = 480;

/**
 * What the configuration keeps, however wide the guide is dragged.
 *
 * Also the width at which the panel reflows into its compact layout -- tabs
 * on their own full-width row, the ⋮ riding along with them. One number, not
 * two: the panel is never squeezed below the width it reflows at, so there
 * is no in-between where the wide toolbar is asked to fit somewhere it does
 * not. The panel watches its own box against this and sets `.panel-narrow`;
 * see `_narrowWatch` in lizaip-panel.js for why that is measured rather
 * than asked of a media query.
 *
 * 600 is the measured figure: across the four translations the narrowest
 * lossless single row is 560px (Spanish, 200% text).
 */
export const PANEL_MIN = 600;

/**
 * Narrowest viewport that can dock at all, which is simply both minimums.
 *
 * Derived rather than chosen, so the two can never drift into a window that
 * is wide enough to dock in but too narrow to hold the result.
 */
const DOCK_MIN = PANEL_MIN + WIDTH_MIN;

/** Remembered between visits: a reference pane the user keeps open is one
 *  they expect to find open, at the width they dragged it to. */
const LS_OPEN = "liza-guide-open";
const LS_WIDTH = "liza-guide-width";
const LS_RAIL = "liza-guide-rail";

/** localStorage is absent in some embeddings and throws in private modes. */
const store = {
  get(key) {
    try { return window.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage?.setItem(key, value); } catch { /* not worth a toast */ }
  },
};

/**
 * The widest anything in the guide gets: every screenshot is 1200px, and the
 * prose is at its measure long before that. Plus the chrome around the
 * column -- the contents rail, the gap, the article's gutter and the panel's
 * padding -- so the cap is the width at which the column is exactly full.
 */
const COLUMN_MAX = 1200;
const GUIDE_CHROME = 260 + 16 + 8 + 24 + 6;
const WIDTH_CEILING = COLUMN_MAX + GUIDE_CHROME;

/**
 * The widest the guide may be right now.
 *
 * Two limits, whichever bites first. The panel keeps PANEL_MIN, because a
 * toolbar narrower than that reflows into a stack. And the guide stops at the
 * width where its own content is as big as it will ever be: past that the
 * pictures have stopped growing and dragging further only opens empty gutter,
 * which is not a width anyone meant to choose.
 */
const widthMax = () =>
  Math.max(WIDTH_MIN, Math.min(WIDTH_CEILING, (window.innerWidth || 0) - PANEL_MIN));

const clampWidth = (n) => Math.min(widthMax(), Math.max(WIDTH_MIN, Math.round(n)));

export const GuideViewMixin = {
  /**
   * The ⋮ menu's entry point: open the guide, or put it away again.
   *
   * A toggle rather than an "open", because docked it is a thing that is
   * either there or not -- the menu row reports which, as a checkbox would.
   */
  async _toggleGuide() {
    if (this._guideDocks()) {
      if (this._guideDrawerEl()) { this._closeGuideDrawer(); return; }
      await this._openGuideDrawer();
      return;
    }
    await this._openGuideModal();
  },

  /**
   * The toolbar's help button.
   *
   * Out of the ⋮ menu and onto the toolbar, because the ⋮ is where a user
   * looks for things to *do to this device* -- diagnostics, restore, the
   * destructive ones -- and help is neither per-device nor an action. A help
   * affordance also has to be visible to be reached for at the moment of
   * confusion; two clicks behind an unlabelled glyph is not.
   *
   * `aria-pressed` rather than `aria-expanded`: docked it is a toggle that
   * puts a region on screen, not a control that reveals the thing it owns.
   */
  _htmlGuideButton(cls = "") {
    const label = this._esc(this._t("user_guide"));
    return `<ha-icon-button class="guide-btn ${cls}"
                    aria-pressed="${this._guideOpen() ? "true" : "false"}"
                    label="${label}">
              <ha-icon icon="mdi:help-circle-outline" aria-hidden="true"></ha-icon>
            </ha-icon-button>`;
  },

  /** Wire every help button in the current render. */
  _wireGuideButton() {
    this.shadowRoot?.querySelectorAll(".guide-btn").forEach((el) => {
      // Wired once per element, however many times this is called. More than
      // one path ends in a wiring pass over the current render -- a view that
      // renders again while it is being wired leaves the outer pass walking
      // markup the inner pass already handled -- and a second listener on a
      // *toggle* is a toggle that does nothing: it opens and shuts in one
      // click, and the button looks stuck open.
      if (el.dataset.guideWired === "1") return;
      el.dataset.guideWired = "1";
      el.addEventListener("click", () => this._toggleGuide());
    });
  },

  /** Keep the button's state honest without a full re-render -- the drawer
   *  opens and closes far more often than the panel redraws. */
  _guideSyncButton() {
    const on = this._guideOpen() ? "true" : "false";
    this.shadowRoot?.querySelectorAll(".guide-btn")
      .forEach((el) => el.setAttribute("aria-pressed", on));
  },

  /** Is there room to dock? */
  _guideDocks() {
    return (window.innerWidth || 0) >= DOCK_MIN;
  },

  /** Is the guide on screen in either shape? Read by the menu for its state. */
  _guideOpen() {
    return Boolean(this._guideDrawerEl() || this._guideDialog);
  },

  /**
   * The drawer that is actually on screen, which is not always the one the
   * field remembers.
   *
   * The node outlives renders on purpose -- `_render` detaches and re-appends
   * it so its listeners survive -- but the field is panel state, and a panel
   * that is torn down and rebuilt around a surviving node would otherwise
   * believe the guide is shut while the user is reading it. Asked of the DOM
   * instead, and the field re-adopted, so one more click cannot stack a
   * second drawer on top of the first.
   */
  _guideDrawerEl() {
    const live = this._guideDrawer?.isConnected
      ? this._guideDrawer
      : this.shadowRoot?.querySelector("aside.guide-drawer") || null;
    this._guideDrawer = live;
    return live;
  },

  /** The content module, imported on first use. `null` if it is not there. */
  async _guideModule() {
    try {
      _content ||= await import("./lizaip-guide-content.js");
    } catch {
      // The one module the panel can do without. A tree missing it -- a
      // half-finished checkout, a build that never ran `make guide` -- should
      // say so in a toast rather than leave the menu item doing nothing.
      this._toast?.(this._t("guide_unavailable"));
      return null;
    }
    // Substituted once and kept: the HTML is 70 kB and the token appears
    // once per screenshot, so doing this on every open would be a sweep of
    // the whole manual for a result that cannot change.
    this._guideHtml ||= _content.GUIDE_HTML.replaceAll("{{GUIDE_IMG_BASE}}", IMG_BASE);
    return _content;
  },

  /** The width the drawer should have: what was dragged last, or the default. */
  _guideWidth() {
    const stored = Number(store.get(LS_WIDTH));
    return clampWidth(Number.isFinite(stored) && stored > 0 ? stored : WIDTH_DEFAULT);
  },

  /**
   * Give the drawer a width and take the same width off the panel.
   *
   * One custom property does both: the drawer's own width and the host's
   * right padding read it, so the panel's content box ends exactly where the
   * guide begins and nothing is ever painted over. The drawer itself is
   * positioned against the viewport, so it sits in the gap the padding opens
   * rather than being pushed in by it.
   */
  _guideSetWidth(px, { persist = true } = {}) {
    const width = clampWidth(px);
    this.style.setProperty("--liza-guide-width", `${width}px`);
    const handle = this._guideDrawer?.querySelector(".guide-resize");
    handle?.setAttribute("aria-valuenow", String(width));
    // The ceiling moves with the window, so it is reported each time rather
    // than written once: a reader asked for the range must get today's.
    handle?.setAttribute("aria-valuemax", String(widthMax()));
    if (persist) store.set(LS_WIDTH, String(width));
    // The link drawn from a button to the page it opens is an SVG overlay
    // sized from the strip's scroll box, and a narrower column changes it.
    // Nothing else re-measures: the face is a viewBox and scales by itself.
    this._drawGotoLink?.();
    return width;
  },

  /** Markup shared by the drawer and the modal. */
  _htmlGuideBody(mod) {
    const title = mod.GUIDE_TITLE || this._t("user_guide");
    return `
      <div class="guide-head">
        <h2 class="add-page-dialog-title" id="liza-dlg-title">${this._esc(title)}</h2>
        <div class="guide-head-actions">
          <a class="guide-ext" href="${this._esc(mod.GUIDE_URL)}" target="_blank" rel="noopener noreferrer"
             title="${this._esc(this._t("guide_open_github"))}"
             aria-label="${this._esc(this._t("guide_open_github"))}">
            <ha-icon icon="mdi:open-in-new" aria-hidden="true"></ha-icon>
          </a>
          <ha-icon-button class="guide-close" label="${this._esc(this._t("close"))}">
            <ha-icon icon="mdi:close" aria-hidden="true"></ha-icon>
          </ha-icon-button>
        </div>
      </div>
      <div class="guide-body">
        <div class="guide-nav">
          <div class="guide-rail-head">
            <span class="guide-rail-title">${this._esc(this._t("guide_contents"))}</span>
            <ha-icon-button class="guide-rail-toggle" aria-expanded="true"
                    aria-controls="liza-guide-toc"
                    label="${this._esc(this._t("guide_rail_hide"))}">
              <ha-icon icon="mdi:chevron-double-left" aria-hidden="true"></ha-icon>
            </ha-icon-button>
          </div>
          <ha-button appearance="outlined" class="guide-toc-toggle" aria-expanded="false"
                  aria-controls="liza-guide-toc">
            <ha-icon slot="start" icon="mdi:format-list-bulleted" aria-hidden="true"></ha-icon>
            <span class="liza-sr-only">${this._esc(this._t("guide_contents"))}</span>
            <span class="guide-toc-current"></span>
            <ha-icon slot="end" class="guide-toc-caret" icon="mdi:chevron-down" aria-hidden="true"></ha-icon>
          </ha-button>
          <nav class="guide-toc" id="liza-guide-toc"
               aria-label="${this._esc(this._t("guide_contents"))}" hidden>
            <div class="guide-filter">
              <ha-input-search appearance="outlined" class="guide-filter-input" autocomplete="off"
                     placeholder="${this._esc(this._t("guide_filter"))}"
                     accessible-label="${this._esc(this._t("guide_filter"))}"></ha-input-search>
              <!-- The counter and its arrows appear only while there is
                   something to count: empty, they are three dead controls
                   taking a third of a narrow row. aria-live so a reader who
                   keeps typing hears the count change without leaving the
                   box. -->
              <span class="guide-hits" hidden>
                <output class="guide-hits-count" aria-live="polite"></output>
                <ha-icon-button class="guide-hit-step" data-step="-1"
                        label="${this._esc(this._t("guide_hit_prev"))}">
                  <ha-icon icon="mdi:chevron-up" aria-hidden="true"></ha-icon>
                </ha-icon-button>
                <ha-icon-button class="guide-hit-step" data-step="1"
                        label="${this._esc(this._t("guide_hit_next"))}">
                  <ha-icon icon="mdi:chevron-down" aria-hidden="true"></ha-icon>
                </ha-icon-button>
              </span>
            </div>
            <!-- A toolbar, which is what twenty buttons navigated with the
                 arrow keys are: it is the role that licenses a roving
                 tabindex, and without one Tab from the search box walks
                 every section in the guide before it reaches the text. -->
            <div class="guide-toc-list" role="toolbar" aria-orientation="vertical"
                 aria-label="${this._esc(this._t("guide_contents"))}">
              ${mod.GUIDE_TOC.map((e, i) => `
                <button type="button" class="guide-toc-item guide-toc-l${e.level}"
                        tabindex="${i === 0 ? "0" : "-1"}"
                        data-target="${this._esc(e.id)}"><span class="guide-toc-text">${this._esc(e.text)}</span><span class="guide-toc-count" hidden></span></button>`).join("")}
              <p class="guide-toc-none" hidden>${this._esc(this._t("guide_filter_none"))}</p>
            </div>
          </nav>
        </div>
        <article class="guide-content" id="liza-guide-content" tabindex="0"><div class="guide-measure">${this._guideHtml}</div></article>
      </div>`;
  },

  // ── Docked ────────────────────────────────────────────────────────

  async _openGuideDrawer() {
    // Two guards for two different races. The first is the ordinary one; the
    // second is the import below, which is the only await here and so the
    // only place a second click can arrive and find nothing open yet.
    if (this._guideDrawerEl() || this._guideOpening) return;
    this._guideOpening = true;
    let mod;
    try { mod = await this._guideModule(); } finally { this._guideOpening = false; }
    if (!mod || this._guideDrawerEl()) return;
    // Both shapes carry `id="liza-guide-content"`, and two of them in one tree
    // would make the modal's `aria-describedby` point at whichever came first.
    this._guideCloseModal?.();

    const aside = document.createElement("aside");
    aside.className = "guide-drawer";
    aside.setAttribute("role", "complementary");
    aside.setAttribute("aria-label", mod.GUIDE_TITLE || this._t("user_guide"));
    const width = this._guideWidth();
    aside.innerHTML = `
      <div class="guide-resize" role="separator" aria-orientation="vertical"
           tabindex="0" aria-label="${this._esc(this._t("guide_resize"))}"
           aria-valuemin="${WIDTH_MIN}" aria-valuemax="${widthMax()}" aria-valuenow="${width}"></div>
      <div class="guide-panel">${this._htmlGuideBody(mod)}</div>`;
    this.shadowRoot.appendChild(aside);
    this._guideDrawer = aside;
    this.classList.add("guide-open");
    this._guideSetWidth(width, { persist: false });
    store.set(LS_OPEN, "1");
    this._guideSyncButton();

    aside.querySelector(".guide-close")
      ?.addEventListener("click", () => this._closeGuideDrawer());
    // Escape. A non-modal element gets no `cancel` event -- that is the
    // platform's dialog machinery, which is exactly what is not in use here.
    aside.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      this._closeGuideDrawer();
    });
    this._wireGuideResize(aside);
    this._wireGuide(aside);

    // Focus moves in, and goes back to the ⋮ button on the way out. The guide
    // is asked for in order to be read, and Page Down has to work without
    // tabbing past the whole configuration to reach it.
    aside.querySelector(".guide-content")?.focus?.();

    // A window dragged narrow has nowhere to put a 420px column.
    if (!this._guideViewportWatch) {
      this._guideViewportWatch = () => {
        if (!this._guideDrawer) return;
        if (!this._guideDocks()) { this._closeGuideDrawer({ remember: true }); return; }
        // A window dragged narrower moves the ceiling down with it, and a
        // guide left wider than the new one would bury the configuration.
        // Not persisted: widen the window again and the old width returns.
        this._guideSetWidth(this._guideWidth(), { persist: false });
      };
      window.addEventListener?.("resize", this._guideViewportWatch);
    }
  },

  _closeGuideDrawer({ remember = false } = {}) {
    const aside = this._guideDrawer;
    if (!aside) return;
    this._guideDrawer = null;
    aside.remove();
    this.classList.remove("guide-open", "guide-resizing");
    // `remember` is for the viewport getting too narrow: the user did not ask
    // for it to close, so it should come back when the window does.
    if (!remember) store.set(LS_OPEN, "0");
    this._drawGotoLink?.();
    this._guideSyncButton();
    this._guideFocusOpener();
  },

  /** Put focus back where the toggle was pressed, if it is still there. */
  _guideFocusOpener() {
    this.shadowRoot?.querySelector(".guide-btn")?.focus?.();
  },

  /** The drag handle on the drawer's inner edge, by pointer and by keyboard. */
  _wireGuideResize(aside) {
    const handle = aside.querySelector(".guide-resize");
    if (!handle) return;

    const move = (ev) => {
      // Measured from the right edge of the window, which is where the drawer
      // is pinned; the pointer's x is all that is needed.
      this._guideSetWidth(window.innerWidth - ev.clientX, { persist: false });
    };
    const stop = (ev) => {
      this.classList.remove("guide-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      handle.releasePointerCapture?.(ev?.pointerId);
      store.set(LS_WIDTH, String(
        parseInt(this.style.getPropertyValue("--liza-guide-width"), 10) || WIDTH_DEFAULT,
      ));
    };
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      // Suspends the width transition: with it on, the drawer chases the
      // pointer a fifth of a second behind and the drag feels broken.
      this.classList.add("guide-resizing");
      handle.setPointerCapture?.(ev.pointerId);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    });

    // 2.1.1: a pointer-only resize is not operable. The separator takes the
    // arrow keys, which is the pattern readers already announce for one.
    // Left widens because the drawer grows leftward, into the panel.
    handle.addEventListener("keydown", (ev) => {
      const step = ev.shiftKey ? 64 : 16;
      const current = parseInt(this.style.getPropertyValue("--liza-guide-width"), 10)
        || WIDTH_DEFAULT;
      if (ev.key === "ArrowLeft") this._guideSetWidth(current + step);
      else if (ev.key === "ArrowRight") this._guideSetWidth(current - step);
      else if (ev.key === "Home") this._guideSetWidth(widthMax());
      else if (ev.key === "End") this._guideSetWidth(WIDTH_MIN);
      else return;
      ev.preventDefault();
    });
  },

  /**
   * Re-open the drawer the user left open, once the panel has painted.
   *
   * Called from `_render`, which is also what rebuilds the shadow tree, so the
   * guard is on the drawer existing rather than on a "first render" flag:
   * every later render re-appends the node it already has.
   */
  _guideRestore() {
    if (this._guideDrawer || !this._guideDocks()) return;
    if (store.get(LS_OPEN) !== "1") return;
    // Not awaited: a 57 kB import must not stand between the panel and its
    // first paint. The drawer appears when it arrives.
    this._openGuideDrawer();
  },

  // ── The narrow fallback ───────────────────────────────────────────

  async _openGuideModal() {
    if (this._guideDialog) return;
    const mod = await this._guideModule();
    if (!mod) return;

    const { dlg, close } = this._openModal(`
      <div class="add-page-dialog guide-dialog" role="document">
        ${this._htmlGuideBody(mod)}
      </div>
    `, {
      labelledBy: "liza-dlg-title",
      describedBy: "liza-guide-content",
      onClose: () => {
        this._guideDialog = null;
        this._guideCloseModal = null;
        this._guideSyncButton();
      },
    });
    this._guideDialog = dlg;
    this._guideCloseModal = close;
    this._guideSyncButton();

    dlg.querySelector(".guide-close")?.addEventListener("click", close);
    this._wireGuide(dlg);
    dlg.querySelector(".guide-content")?.focus?.();
  },

  // ── Reading it, in either shape ───────────────────────────────────

  /**
   * Show one screenshot at its own size, over everything.
   *
   * The guide is read in a column a few hundred pixels wide and the
   * screenshots were taken at 1200: the picture that is meant to show which
   * checkbox to tick is the one element the drawer cannot do justice to.
   * A plain lightbox -- no pan, no zoom controls, no gallery stepping -- is
   * all the gap needs, and the browser's own zoom handles the rest.
   */
  _guideZoom(root, img) {
    // Hung off the shadow root, not off the drawer and never off
    // .guide-panel. .guide-panel carries container-type, which makes it a
    // containing block for position: fixed and would shut the lightbox back
    // inside the column it is escaping; .guide-drawer has z-index 9 and so
    // is a stacking context of its own, which puts the whole viewer under
    // the sticky toolbar's z-index 10.
    const host = this.shadowRoot ?? root;
    host.querySelector(".guide-lightbox")?.remove();
    const content = root.querySelector(".guide-content");

    // Every screenshot in the guide, in reading order. A reader comparing two
    // steps should not have to shut the picture, scroll, and open the next
    // one -- the arrow keys walk them the way every other viewer does.
    const figures = Array.from(content?.querySelectorAll("img") || []);
    let at = Math.max(0, figures.indexOf(img));
    const many = figures.length > 1;

    const box = document.createElement("div");
    box.className = "guide-lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.tabIndex = -1;
    box.innerHTML = `
      <div class="guide-lightbox-bar">
        <output class="guide-lightbox-count" aria-live="polite"></output>
        <button type="button" class="guide-lightbox-close"
                aria-label="${this._esc(this._t("close"))}"
                title="${this._esc(this._t("close"))}">
          <ha-icon icon="mdi:close" aria-hidden="true"></ha-icon>
        </button>
      </div>
      <button type="button" class="guide-lightbox-step" data-step="-1" ${many ? "" : "hidden"}
              aria-label="${this._esc(this._t("guide_image_prev"))}"
              title="${this._esc(this._t("guide_image_prev"))}">
        <ha-icon icon="mdi:chevron-left" aria-hidden="true"></ha-icon>
      </button>
      <figure class="guide-lightbox-figure">
        <img alt="">
        <figcaption></figcaption>
      </figure>
      <button type="button" class="guide-lightbox-step" data-step="1" ${many ? "" : "hidden"}
              aria-label="${this._esc(this._t("guide_image_next"))}"
              title="${this._esc(this._t("guide_image_next"))}">
        <ha-icon icon="mdi:chevron-right" aria-hidden="true"></ha-icon>
      </button>`;

    const shown = box.querySelector(".guide-lightbox-figure img");
    const caption = box.querySelector("figcaption");
    const counter = box.querySelector(".guide-lightbox-count");
    const figure = box.querySelector(".guide-lightbox-figure");

    /**
     * How much bigger than "fitted" the picture is being shown.
     *
     * Not a fit/actual-size toggle, which is what this was and which did
     * nothing at all on a wide monitor: the screenshots are 1200px and the
     * guide is read on a 2000px screen, so the fitted picture was already at
     * its own pixels and "actual size" was the size it was already. Real
     * magnification is what someone clicking a screenshot of a settings
     * dialog is asking for, so the steps go past 100%.
     */
    const STEPS = [1, 2, 3];
    let step = 0;
    const setZoom = (i) => {
      step = (i + STEPS.length) % STEPS.length;
      const scale = STEPS[step];
      box.classList.toggle("zoomed", scale > 1);
      shown.setAttribute("aria-pressed", scale > 1 ? "true" : "false");
      if (scale > 1) {
        // Sized off the fitted width rather than the natural one: the fitted
        // width is what the reader is looking at, so 200% means twice what
        // is on screen, which is what 200% is taken to mean.
        shown.style.width = `${Math.round(fitted() * scale)}px`;
      } else {
        shown.style.width = "";
      }
      zoomLabel();
    };
    /** The width the picture settles at with no zoom applied. */
    const fitted = () => {
      if (!baseWidth) {
        baseWidth = shown.getBoundingClientRect?.().width
          || shown.naturalWidth || 0;
      }
      return baseWidth;
    };
    let baseWidth = 0;

    const show = (i) => {
      at = (i + figures.length) % figures.length;
      const next = figures[at];
      const alt = next.getAttribute("alt") || "";
      shown.src = next.currentSrc || next.src || next.getAttribute("src") || "";
      shown.alt = alt;
      caption.textContent = alt;
      caption.hidden = !alt;
      box.setAttribute("aria-label", alt || this._t("user_guide"));
      // A new picture starts fitted: carrying the zoom over lands the reader
      // somewhere in the middle of an image they have not seen yet.
      baseWidth = 0;
      setZoom(0);
      figure.scrollTop = 0;
      figure.scrollLeft = 0;
    };

    /** "Screenshot 3 of 11 · 200%" -- both facts belong in the same line. */
    const zoomLabel = () => {
      const where = many
        ? this._t("guide_image_count", { n: at + 1, total: figures.length })
        : "";
      const scale = STEPS[step];
      counter.textContent = scale > 1
        ? [where, `${scale * 100}%`].filter(Boolean).join(" · ")
        : where;
    };

    const close = () => {
      box.remove();
      // Back to the figure that was opened, not to whatever had focus: the
      // reader's place in the guide is the picture they clicked, and it is
      // also what they will scroll on from.
      try { figures[at]?.focus?.(); } catch { /* gone with the render */ }
    };

    box.addEventListener("click", (ev) => {
      // Named for the button, not "step": a local step here shadows the zoom
      // level, and setZoom(step + 1) then reads an element instead of a
      // number, which coerces to 1 every time -- so the zoom was stuck on
      // its first stop and clicking twice did nothing.
      const arrow = ev.target?.closest?.(".guide-lightbox-step");
      if (arrow) { show(at + Number(arrow.dataset.step)); return; }
      if (ev.target?.closest?.(".guide-lightbox-close")) { close(); return; }
      // The picture toggles actual size; the backdrop shuts it. Clicking the
      // thing you came to look at must not be how you lose it.
      if (ev.target === shown) {
        if (shown.dataset.panned === "1") { shown.dataset.panned = ""; return; }
        setZoom(step + 1);
        return;
      }
      if (ev.target === box || ev.target === figure || ev.target === caption) close();
    });

    box.addEventListener("keydown", (ev) => {
      const keys = ["Escape", "ArrowLeft", "ArrowRight", "Home", "End",
                    "Enter", " ", "+", "=", "-", "0"];
      if (!keys.includes(ev.key)) return;
      // Escape here must not also reach the drawer, or one press shuts both
      // the picture and the guide behind it.
      ev.stopPropagation();
      if (ev.key === "Escape") { close(); return; }
      if (ev.key === "Enter" || ev.key === " ") {
        if (ev.target === shown) { ev.preventDefault(); setZoom(step + 1); }
        return;
      }
      // The keys every image viewer in the world uses, so nobody has to be
      // told they are there.
      if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); setZoom(step + 1); return; }
      if (ev.key === "-") { ev.preventDefault(); setZoom(step - 1); return; }
      if (ev.key === "0") { ev.preventDefault(); setZoom(0); return; }
      if (!many) return;
      ev.preventDefault();
      if (ev.key === "ArrowLeft") show(at - 1);
      else if (ev.key === "ArrowRight") show(at + 1);
      else if (ev.key === "Home") show(0);
      else show(figures.length - 1);
    });

    // Tab must not walk out of a modal and leave the reader typing into the
    // configuration behind a full-screen picture.
    box.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab") return;
      const stops = Array.from(box.querySelectorAll("button:not([hidden]), img"));
      if (!stops.length) return;
      const here = stops.indexOf(box.getRootNode()?.activeElement);
      const next = ev.shiftKey ? here - 1 : here + 1;
      if (next >= 0 && next < stops.length && here !== -1) return;
      ev.preventDefault();
      stops[ev.shiftKey ? stops.length - 1 : 0].focus?.();
    });

    // Drag to pan once there is more picture than window. Pointer events so
    // a touchscreen gets it too, and capture so a drag that leaves the image
    // keeps panning instead of stopping dead.
    //
    // An <img> is draggable by default, and that native drag-and-drop is what
    // used to end every pan after a single move: the browser fired dragstart,
    // which cancels the pointer stream (pointercancel), so the picture jumped
    // a few pixels and then sat still however far the mouse went. Turned off
    // on the element rather than only in CSS, because -webkit-user-drag is
    // non-standard and `draggable` is the thing the behaviour is named after.
    shown.draggable = false;
    shown.addEventListener("dragstart", (ev) => ev.preventDefault());
    let from = null;
    shown.addEventListener("pointerdown", (ev) => {
      if (!box.classList.contains("zoomed")) return;
      // Also stops the text selection a drag across a figure would otherwise
      // start, which leaves the caption highlighted after every pan.
      ev.preventDefault();
      from = { x: ev.clientX, y: ev.clientY,
               left: figure.scrollLeft, top: figure.scrollTop, moved: false };
      shown.setPointerCapture?.(ev.pointerId);
    });
    shown.addEventListener("pointermove", (ev) => {
      if (!from) return;
      const dx = ev.clientX - from.x;
      const dy = ev.clientY - from.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) from.moved = true;
      figure.scrollLeft = from.left - dx;
      figure.scrollTop = from.top - dy;
    });
    const endPan = (ev) => {
      if (!from) return;
      // A drag that moved is a pan, not a click; without this every pan ends
      // by advancing the zoom a step.
      const moved = from.moved;
      from = null;
      shown.releasePointerCapture?.(ev.pointerId);
      if (moved) ev.preventDefault?.();
      shown.dataset.panned = moved ? "1" : "";
    };
    shown.addEventListener("pointerup", endPan);
    shown.addEventListener("pointercancel", endPan);

    shown.tabIndex = 0;
    shown.setAttribute("role", "button");
    host.appendChild(box);
    show(at);
    box.querySelector(".guide-lightbox-close")?.focus?.();
    return box;
  },

  /** The contents menu, the scroll-spy and the guide's own cross-references. */
  _wireGuide(root) {
    const content = root.querySelector(".guide-content");
    const items = Array.from(root.querySelectorAll(".guide-toc-item"));
    const toggle = root.querySelector(".guide-toc-toggle");
    const toc = root.querySelector(".guide-toc");
    const current = root.querySelector(".guide-toc-current");
    const filter = root.querySelector(".guide-filter-input");
    const none = root.querySelector(".guide-toc-none");
    const hitBox = root.querySelector(".guide-hits");
    const hitCount = root.querySelector(".guide-hits-count");
    const body = root.querySelector(".guide-body");
    const rail = root.querySelector(".guide-rail-toggle");

    /**
     * An entry's own words, without the hit count beside them.
     *
     * The count lives inside the button so it stays with the entry when the
     * list scrolls, which means `textContent` now reads "Images4". Anything
     * matching or displaying an entry has to ask for the text alone.
     */
    const label = (el) => el.querySelector(".guide-toc-text")?.textContent
      ?? el.textContent ?? "";

    /**
     * Whether the contents are a rail rather than something to open.
     *
     * Asked of the stylesheet instead of being decided here: the width at
     * which a rail fits is a layout question, it is already answered by a
     * container query on `.guide-panel`, and a second copy of the number in
     * JS is a second copy to forget. If the toggle is not displayed, the
     * rail is what is on screen.
     */
    const railed = () => {
      try {
        return !!toggle && window.getComputedStyle?.(toggle)?.display === "none";
      } catch { return false; }
    };

    /**
     * Open or shut the contents list.
     *
     * A disclosure in a narrow drawer, because the guide is read in a column
     * barely wide enough for the text and a rail there either halves the
     * prose or, laid flat, shows four of twenty sections behind a horizontal
     * scrollbar nobody finds. Collapsed, it costs one line and spends it
     * saying which section is on screen. Wide, there is a gutter beside the
     * capped measure and the rail lives in it, always open -- so this does
     * nothing but keep the attributes honest.
     */
    const setOpen = (open) => {
      if (!toggle || !toc) return;
      if (railed()) {
        toggle.setAttribute("aria-expanded", "true");
        toc.hidden = false;
        return;
      }
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toc.hidden = !open;
      if (!open) return;
      // Scrolled to the section being read, which in a twenty-entry list is
      // rarely the one at the top, and focused there too: the list was just
      // opened to pick from, and the arrow keys have to start somewhere.
      const here = toc.querySelector(".guide-toc-item.active:not([hidden])")
        ?? shownItems()[0];
      here?.scrollIntoView?.({ block: "nearest" });
      focusItem(here);
    };
    const isOpen = () => toggle?.getAttribute("aria-expanded") === "true";

    /**
     * Fold the contents rail away, and remember it.
     *
     * The rail is about 220px of a drawer whose content is mostly 1200px
     * screenshots, so a reader who has found their section and wants the
     * pictures bigger has a reason to put it away -- and the same reason
     * next time, which is why the choice is stored. Only meaningful in rail
     * mode: narrow, the contents are already a disclosure, and the control
     * is not displayed.
     */
    const setRail = (shown, remember = true) => {
      if (!body || !rail) return;
      body.classList.toggle("rail-collapsed", !shown);
      rail.setAttribute("aria-expanded", shown ? "true" : "false");
      const text = this._t(shown ? "guide_rail_hide" : "guide_rail_show");
      rail.setAttribute("label", text);
      // Folded, the control is the only thing left of the rail, so it has to
      // say what it is as well as what it does: a list, not a bare chevron
      // pointing at nothing.
      // The button holds exactly one icon, and asking for it by tag keeps a
      // decorative glyph out of the sweep that looks for clickable classes.
      rail.querySelector("ha-icon")?.setAttribute(
        "icon", shown ? "mdi:chevron-double-left" : "mdi:format-list-bulleted");
      if (remember) store.set(LS_RAIL, shown ? "1" : "0");
    };
    setRail(store.get(LS_RAIL) !== "0", false);
    rail?.addEventListener("click", () => {
      const shown = rail.getAttribute("aria-expanded") === "true";
      setRail(!shown);
      // Unfolding to search is the common reason to unfold, and a click that
      // leaves the caret where it was makes the reader click twice.
      if (!shown) filter?.focus();
    });

    /** Light up one entry, and say so on the collapsed button. */
    const mark = (id) => {
      for (const el of items) {
        const on = el.dataset.target === id;
        el.classList.toggle("active", on);
        if (on && current) current.textContent = label(el);
        // A rail long enough to scroll can be showing a different part of the
        // guide than the reader is in. `nearest` is a no-op while the entry is
        // already visible, so this does not fight a reader browsing the list.
        if (on && railed()) el.scrollIntoView?.({ block: "nearest" });
      }
      // The section being read is where Tab should land, so a keyboard
      // reader arrives in the list at the place they already are.
      rove(items.find((el) => el.dataset.target === id && !el.hidden));
    };

    /** The entries a reader can actually get to right now. */
    const shownItems = () => items.filter((el) => !el.hidden);

    /**
     * Give one entry the list's single tab stop.
     *
     * Twenty buttons are twenty tab stops, and a reader who wanted the text
     * had to press Tab twenty-one times to reach it. One stop in, the arrow
     * keys from there -- the roving tabindex every toolbar and tree uses.
     */
    const rove = (to) => {
      const target = to && !to.hidden ? to : shownItems()[0];
      for (const el of items) el.tabIndex = el === target ? 0 : -1;
    };

    /** Move the tab stop and the focus together. */
    const focusItem = (el) => {
      if (!el) return;
      rove(el);
      el.focus?.();
    };

    /**
     * Which section each top-level block belongs to.
     *
     * The rendered guide is flat -- headings and paragraphs are siblings, as
     * Markdown makes them -- so a block's section is the id of the last
     * heading above it. Only headings the contents actually list count as
     * boundaries: a deeper one has no entry to report its hits on, so they
     * roll up to the section a reader can be sent to. Stamped once, so a hit
     * found later needs one `closest` rather than a walk back through the
     * article.
     */
    const sectionise = () => {
      const listed = new Set(items.map((el) => el.dataset.target));
      // The blocks are inside the measure wrapper, not directly in the
      // article: the wrapper is what caps and centres the column.
      const column = content?.querySelector(".guide-measure") ?? content;
      let id = "";
      for (const el of Array.from(column?.children || [])) {
        if (/^H[1-6]$/.test(el.tagName) && listed.has(el.id)) id = el.id;
        el.dataset.guideSection = id;
      }
    };
    sectionise();

    /** Take the highlighting back out, leaving the text as it was. */
    const clearHits = () => {
      for (const m of Array.from(content?.querySelectorAll("mark.guide-hit") || [])) {
        const parent = m.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        // Otherwise every search leaves the text one node more fragmented
        // than it found it, and the next search cannot match across the seam.
        parent.normalize();
      }
    };

    /**
     * Wrap every occurrence of `q` in the article, in reading order.
     *
     * Done to the DOM rather than with the Custom Highlight API because the
     * drawer has to work in whatever browser Home Assistant is open in, and
     * `mark` is also the element that means this -- a reader lands on
     * "highlighted" rather than on bare text. The nodes are collected before
     * any are replaced: splitting a node while walking it is how a walker
     * ends up visiting its own output.
     */
    const highlight = (q) => {
      const found = [];
      if (!content || !q) return found;
      const walker = document.createTreeWalker?.(content, 4 /* SHOW_TEXT */);
      const nodes = [];
      while (walker?.nextNode?.()) {
        const node = walker.currentNode;
        if (node.nodeValue?.toLowerCase().includes(q)) nodes.push(node);
      }
      for (const node of nodes) {
        const text = node.nodeValue;
        const low = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let i = 0;
        for (;;) {
          const at = low.indexOf(q, i);
          if (at < 0) break;
          if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
          const el = document.createElement("mark");
          el.className = "guide-hit";
          el.textContent = text.slice(at, at + q.length);
          frag.appendChild(el);
          found.push(el);
          i = at + q.length;
        }
        if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
        node.parentNode?.replaceChild(frag, node);
      }
      return found;
    };

    /** Everything highlighted by the current search, and where we are in it. */
    let hits = [];
    let pos = -1;

    /** The counter, hidden while there is nothing to count. */
    const showCount = () => {
      if (hitBox) hitBox.hidden = hits.length === 0;
      if (!hitCount) return;
      const n = pos >= 0 ? pos + 1 : 0;
      const vars = { n, total: hits.length };
      hitCount.textContent = this._t("guide_hits", vars);
      // The visible text is two numbers and a slash, which says nothing out
      // loud; the label is the sentence it stands for.
      hitCount.setAttribute("aria-label", this._t("guide_hits_label", vars));
    };

    /** Move to the next hit, or the previous one, wrapping at either end. */
    const step = (delta) => {
      if (!hits.length) return false;
      pos = (pos + delta + hits.length) % hits.length;
      hits.forEach((el, i) => el.classList.toggle("guide-hit-current", i === pos));
      // `center`, not `nearest`: a hit scrolled to the very bottom edge is
      // technically visible and practically missed.
      hits[pos].scrollIntoView?.({ block: "center" });
      showCount();
      return true;
    };

    /**
     * Search the guide.
     *
     * Two results from one box: the words are highlighted where they stand,
     * and the contents narrow to the sections holding them, each saying how
     * many. Headings still match on their own -- a section can be what is
     * being looked for even when its title words appear nowhere in its
     * prose.
     *
     * One letter highlights nothing. Every section contains an "e", so the
     * article would turn solid yellow before the reader has typed a word.
     */
    const applyFilter = () => {
      const q = (filter?.value || "").trim().toLowerCase();
      clearHits();
      hits = q.length >= MIN_QUERY ? highlight(q) : [];
      pos = -1;

      const counts = new Map();
      for (const el of hits) {
        const id = el.closest?.("[data-guide-section]")?.dataset.guideSection || "";
        counts.set(id, (counts.get(id) || 0) + 1);
      }

      let shown = 0;
      for (const el of items) {
        const n = counts.get(el.dataset.target) || 0;
        const named = label(el).toLowerCase().includes(q);
        const hit = !q || n > 0 || named;
        el.hidden = !hit;
        if (hit) shown += 1;
        const badge = el.querySelector(".guide-toc-count");
        if (!badge) continue;
        badge.textContent = n ? String(n) : "";
        badge.hidden = !n;
      }
      if (none) none.hidden = shown > 0;
      // The tab stop may have just been filtered away, and a list whose only
      // way in is hidden cannot be reached by keyboard at all.
      if (!items.some((el) => !el.hidden && el.tabIndex === 0)) rove();
      showCount();
    };

    /** The first section still on show, for Enter with nothing highlighted. */
    const firstMatch = () => items.find((el) => !el.hidden);

    filter?.addEventListener("input", applyFilter);
    root.querySelectorAll(".guide-hit-step").forEach((el) => {
      el.addEventListener("click", () => step(Number(el.dataset.step) || 1));
    });
    filter?.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        // Down from a search box goes into its results. The one arrangement
        // every reader already knows, and the only way a keyboard user gets
        // from the box to the list without Tabbing past the find arrows.
        const list = shownItems();
        if (!list.length) return;
        ev.preventDefault();
        focusItem(ev.key === "ArrowDown" ? list[0] : list[list.length - 1]);
        return;
      }
      if (ev.key === "Enter") {
        // Type three letters, press Enter, be there: the whole reason to put
        // a box above a list of twenty. Enter walks the highlighted words,
        // Shift+Enter walks back -- the find bar every browser has taught
        // this -- and falls back to the first section when the match is in a
        // heading and so has nothing highlighted to walk.
        ev.preventDefault();
        if (step(ev.shiftKey ? -1 : 1)) return;
        firstMatch()?.click();
        return;
      }
      if (ev.key !== "Escape") return;
      // Escape clears the box before it closes anything -- otherwise the one
      // key both abandons the search and loses the list it was searching.
      if (filter.value) {
        ev.stopPropagation();
        filter.value = "";
        applyFilter();
      }
    });

    toggle?.addEventListener("click", () => setOpen(!isOpen()));

    /**
     * Walking the contents with the arrow keys.
     *
     * The pair to the roving tabindex above: one Tab gets into the list, and
     * these move inside it. Home and End because twenty entries is enough
     * that holding an arrow down is not an answer, and the filtered-away
     * ones are skipped because they are not on screen to be walked to.
     */
    toc?.addEventListener("keydown", (ev) => {
      const from = items.find((el) => el === ev.target || el.contains?.(ev.target));
      if (!from) return;
      const list = shownItems();
      const at = list.indexOf(from);
      let to = null;
      if (ev.key === "ArrowDown") to = list[at + 1] ?? list[0];
      else if (ev.key === "ArrowUp") to = list[at - 1] ?? list[list.length - 1];
      else if (ev.key === "Home") to = list[0];
      else if (ev.key === "End") to = list[list.length - 1];
      else return;
      ev.preventDefault();
      focusItem(to);
    });
    // Escape shuts the list first and the guide second: one Escape, one
    // thing closed, which is what a user who just opened the list expects.
    // Stopped here so the drawer's own handler does not also fire.
    toc?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !isOpen() || railed()) return;
      ev.stopPropagation();
      setOpen(false);
      toggle?.focus?.();
    });
    // Anywhere else in the guide dismisses it, the way an open menu goes away
    // when the page under it is used.
    root.addEventListener("click", (ev) => {
      if (railed()) return;
      if (!isOpen() || toggle?.contains(ev.target) || toc?.contains(ev.target)) return;
      setOpen(false);
    });

    /** Scroll a heading to the top of the reading pane. */
    const goTo = (id) => {
      // `getElementById` is not available on a detached subtree the way it is
      // on a document, and the ids come from the generator rather than from a
      // user, so a plain attribute selector is both safe and enough.
      const target = content?.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!target) return;
      content.scrollTop += target.getBoundingClientRect().top
        - content.getBoundingClientRect().top;
      mark(id);
    };

    for (const el of items) {
      el.addEventListener("click", () => {
        goTo(el.dataset.target);
        // Picked is picked: leaving the list up would cover the paragraph it
        // was opened to reach.
        setOpen(false);
        content?.focus?.();
      });
    }

    // The guide's own in-document links -- the "see [Define pages]" sort --
    // would otherwise navigate the whole Home Assistant page to `/lizaip#id`
    // and lose the guide with it.
    content?.addEventListener("click", (ev) => {
      const link = ev.target?.closest?.('a[href^="#"]');
      if (!link) return;
      ev.preventDefault();
      goTo(decodeURIComponent(link.getAttribute("href").slice(1)));
    });

    // Screenshots are 1200px wide and the drawer is rarely that, so every
    // picture in the guide is being shown smaller than it was taken. A click
    // gives the reader the full thing without sending them to GitHub.
    for (const img of content?.querySelectorAll("img") || []) {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      const alt = img.getAttribute("alt") || "";
      if (alt) img.title = alt;
      // Markdown wraps every image in a paragraph, and the paragraph carries
      // the prose measure -- so the picture was being capped at 76 characters
      // of text, under half the width it was captured at. Only when the
      // paragraph is nothing but the picture: an inline icon in a sentence is
      // still prose and still belongs at the measure.
      const para = img.parentElement;
      if (para?.tagName === "P" && !para.textContent.trim()) {
        para.classList.add("guide-figure");
      }
    }
    const zoom = (img) => this._guideZoom(root, img);
    content?.addEventListener("click", (ev) => {
      const img = ev.target?.closest?.(".guide-content img");
      if (img) zoom(img);
    });
    content?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const img = ev.target?.closest?.(".guide-content img");
      if (!img) return;
      ev.preventDefault();
      zoom(img);
    });

    // Which section the reader is in. The topmost heading that has not yet
    // scrolled past the top of the pane wins, which is what "I am reading
    // this one" means while scrolling down; `headings` is read once because
    // the content does not change while the guide is open.
    const headings = (_content?.GUIDE_TOC || [])
      .map((e) => ({ id: e.id, el: content?.querySelector(`[id="${CSS.escape(e.id)}"]`) }))
      .filter((h) => h.el);
    let scrollQueued = false;
    content?.addEventListener("scroll", () => {
      if (scrollQueued) return;
      scrollQueued = true;
      // Coalesced to one reading per frame: this fires continuously, and each
      // pass measures every heading in the guide.
      requestAnimationFrame(() => {
        scrollQueued = false;
        const top = content.getBoundingClientRect().top;
        let current = headings[0]?.id;
        for (const h of headings) {
          if (h.el.getBoundingClientRect().top - top > 8) break;
          current = h.id;
        }
        if (current) mark(current);
      });
    });

    // The list ships `hidden`, which is right for the drawer and wrong for
    // the rail; this is what settles it either way, and the empty filter is
    // what decides whether the "no match" line is showing.
    applyFilter();
    setOpen(false);
    mark(headings[0]?.id);
  },

  /** Window listeners outlive a render, so they are dropped with the element. */
  _guideTeardown() {
    if (!this._guideViewportWatch) return;
    window.removeEventListener?.("resize", this._guideViewportWatch);
    this._guideViewportWatch = null;
  },
};
