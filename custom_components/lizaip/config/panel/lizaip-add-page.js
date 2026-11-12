/**
 * lizaIP Panel — the add-page dialog.
 *
 * The walk a new page is added through: blank page, template groups, the
 * template list with its search, and the last step that asks which device (or
 * hub) a template should drive. Also the registry of panel routines a template
 * may name instead of a page to write.
 *
 * Assigned onto the panel's prototype like every other mixin, so these methods
 * run with `this` bound to the panel element.
 */
import { THEME_DEFAULT } from "./settings/theme.js";

/**
 * Panel routines a template may name instead of a page to write.
 *
 * Empty here on purpose: a module that owns such a routine registers it when
 * it loads, the way a Home Assistant component registers its own services. So
 * a build that never loaded the debug tools holds no name for them, and the
 * card naming one it does not have is dropped before anything draws it.
 */
const TEMPLATE_ACTIONS = {};

/** Offer `{action: method}` names to the add-page dialog. */
export function registerTemplateActions(actions) {
  Object.assign(TEMPLATE_ACTIONS, actions);
}

export const AddPageMixin = {
  async _addPage() {
    // Show a dialog asking whether to add a blank page or a template page
    await this._showAddPageDialog();
  },

  /**
   * The add-page options that come from the preset tree.
   *
   * A folder directly under `presets/` is drawn on the first screen rather
   * than being left to be found inside another one; the backend marks it
   * `scope: option`. Nothing here knows their names, and a folder with
   * nothing to offer grows no card -- which is what hides Debug from a
   * release.
   */
  _addPageOptions(templates) {
    const seen = new Map();
    for (const t of templates) {
      const first = this._groupChain(t)[0];
      if (first?.scope === "option" && !seen.has(first.id)) seen.set(first.id, first);
    }
    return [...seen.values()].sort(
      (a, b) => this._groupLabel(a).localeCompare(this._groupLabel(b)),
    );
  },

  /**
   * Adding a page, from the first question to the last, in one dialog.
   *
   * The template list is read *before* the dialog is drawn: the options are
   * folders of templates, so appending them to a dialog already on screen
   * would move the buttons under the pointer. The blank page is a template
   * like any other, so a failed read leaves nothing to offer.
   *
   * `options` is `{key, pageId, name, entity}` when the page being added is a
   * button's options subpage: only the options templates that button's device
   * answers are offered, and with none there is no dialog, only a toast.
   */
  async _showAddPageDialog(options = null) {
    let templates = [];
    try {
      templates = (await this._loadTemplates(options?.entity))
        .filter(t => t.available !== false && this._templateAction(t) !== null);
      // A button's options page is made only from an options template its
      // own device answers; those templates are offered nowhere else.
      templates = templates.filter(t => (options ? t.options && t.fits : !t.options));
    } catch (e) {
      console.warn("[lizaIP] Add-page options unavailable:", e);
    }
    if (options && !templates.length) {
      this._toast(this._t("no_options", { name: options.name }));
      return;
    }
    if (options && templates.length === 1) {
      await this._applyOnlyOption(templates[0], options);
      return;
    }
    this._openAddPageSteps(options
      ? this._addOptionsFirstStep(templates, options)
      : this._addPageFirstStep(templates));
  },

  /**
   * The one options template a button's device answers, applied without a
   * dialog: there is nothing to choose, and the device it binds to is the
   * button's own. Only where that device cannot be proposed is it asked for.
   */
  async _applyOnlyOption(template, options) {
    const hub = Boolean(template.target_selector?.config_entry);
    let suggested = "";
    if (!template.unbound) {
      ({ suggested = "" } = hub
        ? await this._loadTemplateConfigEntries(template.id, options.entity)
        : await this._loadTemplateDevices(template.id, options.entity));
    }
    if (suggested) {
      // Reports for itself: a toast for what it wrote, or why it could not.
      await this._addTemplatePage(template.id, suggested, hub ? "config_entry" : "device", options);
      return;
    }
    await this._showTemplateEntityPicker(template.id, template, { options });
  },

  /** A template's description. */
  _templateDesc(t) {
    return t?.description || "";
  },

  /** "(3 pages)" after a template's name when adding it makes more than one. */
  _templatePagesHtml(t) {
    if (!(t?.page_count > 1)) return "";
    return ` <span class="template-pages">${this._esc(this._t("template_page_count", { count: t.page_count }))}</span>`;
  },

  /**
   * The first screen, as a step like any other.
   *
   * It is a grid of folders, led by the templates sitting loose at the root
   * of the tree -- the blank page is one. Everything carries the same `items`
   * the deeper steps do, so one piece of code draws and binds them all.
   */
  _addPageFirstStep(templates) {
    const loose = templates.filter(t => !this._groupChain(t).length);
    return {
      kind: "options",
      title: this._t("add_page"),
      crumbs: [{ label: this._t("add_page_root"), icon: "mdi:plus-box-outline" }],
      all: templates,
      items: [
        // In no folder, so there is nothing to open on the way: the card adds
        // the page itself, and leads because it is what most pages start from.
        ...loose.map(t => this._templateCard(t)),
        ...this._addPageOptions(templates).map(group => ({
          group: group.id,
          scope: group.scope || "option",
          primary: group.primary === true,
          name: this._groupLabel(group),
          icon: group.icon || "mdi:folder-outline",
          desc: this._groupLabel(group, { desc: true }),
          members: templates.filter(t => this._groupChain(t)[0]?.id === group.id),
        })),
      ],
      depth: 0,
    };
  },

  /** A card that adds *template* itself, rather than opening a folder. */
  _templateCard(template) {
    return {
      template,
      primary: true,
      name: template.name,
      icon: template.icon,
      desc: this._templateDesc(template),
    };
  },

  /**
   * The first screen of an options walk: what this button's device answers.
   *
   * *templates* are already only those, so they are drawn flat, folders
   * and all: there are a handful at most.
   */
  _addOptionsFirstStep(templates, options) {
    return {
      kind: "options",
      options,
      title: this._t("add_options_title"),
      crumbs: [{ label: this._t("add_options_title"), icon: "mdi:tune-variant" }],
      all: templates,
      items: templates.map(t => this._templateCard(t)),
      depth: 0,
    };
  },

  /** One folder deeper, in the same dialog and from the same step shape. */
  _addPageSubStep(step, item) {
    const depth = (step.depth || 0) + 1;
    return {
      title: item.name,
      items: this._groupTemplates(item.members, depth),
      crumbs: [...(step.crumbs || []), { label: item.name, icon: item.icon, group: item.group }],
      all: step.all,
      options: step.options,
      depth,
      back: step,
    };
  },

  /** The chain of steps that leads here, outermost first. */
  _stepChain(step) {
    const chain = [];
    for (let s = step; s; s = s.back) chain.unshift(s);
    return chain;
  },

  /**
   * One grid step: which template, within the folder the step before chose.
   *
   * `group` is a folder path (`templates`, `templates/sonos`): every step of
   * the walk is inside one, since the first screen offers the folders
   * themselves. `null` when there is nothing to show.
   */
  _templateStep(all, { group, back, crumbs }) {
    // A template Home Assistant has nothing to bind to is left out: its dialog
    // could only say there is nothing to pick. `available` is absent from an
    // older backend, which offers them all.
    const templates = all.filter(t => this._groupChain(t).some(g => g.id === group));
    const opened = this._groupById(all, group);
    if (!templates.length) {
      this._toast(this._t("no_templates"));
      return null;
    }

    // One flat grid, deliberately not one grid per category: every shipped
    // template carries a category of its own, so each group held one card and
    // the `1fr` column stretched it across the whole dialog.
    //
    // A folder is the case grouping was meant for: the four Sonos templates
    // would be four of a dozen cards for a choice that is really "which
    // device", so they collapse into one card that opens a step.
    // From the chain, not the id: `options/sonos` is a top-level folder.
    const depth = this._groupChain(templates[0]).findIndex(g => g.id === group) + 1;
    return {
      title: opened ? this._groupLabel(opened) : this._t("choose_template"),
      items: this._groupTemplates(templates, depth),
      crumbs: [...(crumbs || []), {
        label: opened ? this._groupLabel(opened) : this._t("choose_template"),
        icon: opened?.icon || "mdi:folder-outline",
        group,
      }],
      all,
      options: back?.options,
      depth,
      back,
    };
  },

  /** A template's folders, outermost first. `[]` for a top-level template. */
  _groupChain(template) {
    return Array.isArray(template?.groups) ? template.groups : [];
  },

  /**
   * The routine a card runs instead of writing a page.
   *
   * `undefined` for an ordinary template, the bound handler for one whose
   * `action` this build knows, and `null` for one it does not -- which is how
   * a card is dropped before anything counts or draws it.
   */
  _templateAction(template) {
    if (!template?.action) return undefined;
    const fn = this[TEMPLATE_ACTIONS[template.action]];
    return typeof fn === "function" ? fn.bind(this) : null;
  },

  /**
   * How well `text` matches `q`, and which letters matched. `null` for no
   * match, `{score, hits}` otherwise.
   *
   * A subsequence scan rather than a substring one, so "sr" still finds
   * "Sonos Radio". A letter carrying on from the one before, or opening a
   * word, is worth more than one reached by skipping ahead, so a tight run
   * outranks a scatter; the length penalty settles two otherwise equal hits
   * in favour of the shorter name.
   */
  _fuzzyMatch(text, q) {
    const hay = String(text ?? "").toLowerCase();
    const needle = String(q ?? "").toLowerCase();
    if (!needle) return { score: 0, hits: [] };
    const hits = [];
    let from = 0, score = 0, last = -2;
    for (const ch of needle) {
      const at = hay.indexOf(ch, from);
      if (at < 0) return null;
      const opensWord = at === 0 || /[\s\-_./]/.test(hay[at - 1]);
      score += at === last + 1 ? 14 : opensWord ? 11 : 2;
      score -= Math.min(at - from, 9) * 0.6;
      hits.push(at);
      last = at;
      from = at + 1;
    }
    if (hay === needle) score += 70;
    else if (hay.startsWith(needle)) score += 26;
    return { score: score - hay.length * 0.5, hits };
  },

  /**
   * The templates a query finds, best first, wherever they sit in the tree.
   *
   * The name or the folder path has to match. A description is a tiebreaker
   * only: letters that appear there and nowhere else are not why anyone typed
   * them, and letting a description qualify on its own filled the grid with
   * pages that merely happened to hold them in order. The floor then drops
   * the long tail of weak matches, which is noise rather than results.
   */
  _searchTemplates(templates, q) {
    const query = String(q ?? "").trim();
    if (!query) return [];
    const found = [];
    for (const t of templates) {
      const name = t.name || t.id;
      const chain = this._groupChain(t);
      const onName = this._fuzzyMatch(name, query);
      const onPath = this._fuzzyMatch(chain.map(g => this._groupLabel(g)).join(" "), query);
      if (!onName && !onPath) continue;
      const onDesc = this._fuzzyMatch(t.description || "", query);
      found.push({
        template: t, name, icon: t.icon, desc: this._templateDesc(t),
        hits: onName ? onName.hits : [],
        path: chain.map(g => this._groupLabel(g)),
        score: (onName ? onName.score * 3 : 0)
          + (onPath ? onPath.score * 1.4 : 0)
          + (onDesc ? onDesc.score * 0.3 : 0),
      });
    }
    found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const best = found.length ? found[0].score : 0;
    return found.filter(r => r.score >= best * 0.45);
  },

  /** `text`, escaped, with the matched letters wrapped in `<mark>`. */
  _markHits(text, hits) {
    const lit = new Set(hits || []);
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const ch = this._esc(text[i]);
      out += lit.has(i) ? `<mark>${ch}</mark>` : ch;
    }
    return out;
  },

  /**
   * A folder's card by path, taken from whichever template carries it.
   *
   * Every template in a folder repeats the same ancestry, so any of them
   * answers; a path no template sits under is not a folder that exists.
   */
  _groupById(templates, id) {
    for (const t of templates) {
      const found = this._groupChain(t).find(g => g.id === id);
      if (found) return found;
    }
    return null;
  },

  /**
   * A folder's name, translated when it asked to be.
   *
   * `name_key` names an entry in the panel's translation table, which is how
   * a shipped folder keeps its translations. `_t` answers an unknown id with
   * the id itself, so a missing key falls back to the folder's own name.
   */
  _groupLabel(group, { desc = false } = {}) {
    const key = desc ? group.description_key : group.name_key;
    if (key) {
      const text = this._t(key);
      if (text !== key) return text;
    }
    return (desc ? group.description : group.name) || (desc ? "" : group.id);
  },

  /**
   * What a template's card is called at this depth.
   *
   * The folder it sits in is named by the crumb above the grid already, so a
   * name opening with that folder says the same thing twice: inside Sonos,
   * "Sonos Radio" is just "Radio". A search result keeps the whole name,
   * there being no folder on screen there to supply the rest.
   */
  _leafLabel(template, depth) {
    const full = template.name || template.id;
    const folder = this._groupChain(template)[depth - 1];
    const prefix = folder ? this._groupLabel(folder) : "";
    if (!prefix || !full.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) return full;
    const rest = full.slice(prefix.length + 1).trim();
    return rest ? rest[0].toUpperCase() + rest.slice(1) : full;
  },

  /**
   * Fold templates into the folders they sit in, one level at a time.
   *
   * `depth` is how far down the tree this step already is, so the folders it
   * returns are the ones *directly* below it; deeper ones are reached by
   * opening the card that holds them.
   *
   * A folder of one is not a folder: a subtree holding a single template
   * shows that template's own card rather than hiding a one-card step behind
   * a click. An option folder is never folded -- it is a button either way.
   */
  _groupTemplates(templates, depth = 0) {
    const folders = new Map();
    const items = [];
    for (const t of templates) {
      const here = this._groupChain(t)[depth];
      if (!here) {
        items.push({ template: t, name: this._leafLabel(t, depth), icon: t.icon, desc: this._templateDesc(t) });
        continue;
      }
      let folder = folders.get(here.id);
      if (!folder) {
        folder = {
          group: here.id,
          scope: here.scope || "grid",
          name: this._groupLabel(here),
          icon: here.icon || "mdi:folder-outline",
          desc: this._groupLabel(here, { desc: true }),
          members: [],
        };
        folders.set(here.id, folder);
        items.push(folder);
      }
      folder.members.push(t);
    }
    return items.map(item => {
      if (!item.members || item.members.length !== 1 || item.scope === "option") return item;
      const only = item.members[0];
      return { template: only, name: this._leafLabel(only, depth), icon: only.icon, desc: this._templateDesc(only) };
    });
  },

  /**
   * The add-page walk: one dialog, however many steps.
   *
   * Going a step further in replaces what this dialog shows rather than
   * opening another one on top of it -- a second popup for a second click
   * reads as a new question, when it is the same question narrowing down.
   * The breadcrumb is how that reads as one place: it names where the walk
   * is and is the way back out of it.
   */
  _openAddPageSteps(step) {
    const { dlg: overlay, close } = this._openModal(`
      <div class="add-page-dialog template-dialog" id="liza-template-step"></div>
    `, { labelledBy: "liza-dlg-title" });
    const host = overlay.querySelector("#liza-template-step");
    // See the no-anim rule: a hidden tab never starts the entrance animation,
    // and its backwards fill would leave every card at opacity 0 for good.
    if (globalThis.document?.hidden) host.classList?.add?.("no-anim");
    // A step is `{title, items, crumbs, all, depth, back}`; the
    // first screen adds `kind: "options"` for its headed groups. `back` is
    // the step to return to, so the chain of them is the walk so far.
    const state = { step, query: "" };

    const repaint = () => {
      const body = host.querySelector(".add-page-body");
      if (!body) return;
      body.innerHTML = this._addPageBodyHtml(state.step, state.query);
      this._bindAddPageBody(host, state.step, show, close, state);
      const count = host.querySelector(".add-page-count");
      if (count) count.textContent = this._addPageCountText(state.step, state.query);
    };

    const show = (next) => {
      state.step = next;
      // A query is about the whole tree, not this folder, so walking into a
      // folder is an answer to it and the field starts empty again.
      state.query = "";
      host.innerHTML = this._addPageChromeHtml(next, state.query);
      this._bindAddPageStep(host, next, show, close, state, repaint);
      this._bindAddPageBody(host, next, show, close, state);
      // The dialog is open by the time a step is drawn, so `autofocus` is
      // never honoured: each step hands the keyboard its first choice itself.
      // That focus has to exist for the arrow keys to have a starting point
      // (WCAG 2.4.7), but drawing a ring on it reads as a recommendation --
      // and next to the chosen row as a second, contradictory highlight. So
      // the step opens quiet and the indicator appears at the first key.
      host.classList?.add?.("focus-quiet");
      // Its first choice, or -- on a step that offers none -- the way out.
      // Named rather than "button": Cancel is ha-button and Back is an
      // ha-icon-button-arrow-prev, so neither answers a bare tag selector.
      this._focusWhenReady(
        host.querySelector(".template-row") || host.querySelector(".add-page-cancel"));
    };
    host.addEventListener?.("keydown", () => host.classList?.remove?.("focus-quiet"), true);
    show(step);
  },

  /**
   * The walk's way back, where Home Assistant puts it in a stepped dialog:
   * an arrow at the start of the header, beside the title, rather than a
   * worded button in the foot. Same element HA's own flows use, so it
   * carries HA's icon and turns around in right-to-left languages.
   */
  _addPageBackHtml(hasBack) {
    if (!hasBack) return "";
    return `<ha-icon-button-arrow-prev class="add-page-back"
              label="${this._esc(this._t("back"))}"></ha-icon-button-arrow-prev>`;
  },

  /** Hand the arrow `hass` -- it reads the language off it to decide which
   *  way to point -- and the step to walk back to. */
  _wireAddPageBack(root, onBack) {
    const el = root?.querySelector?.(".add-page-back");
    if (!el) return;
    el.hass = this._hass;
    el.addEventListener("click", onBack);
  },

  /** The chrome every step shares: where you are, a search, the grid. */
  _addPageChromeHtml(step, query) {
    return `
        <div class="add-page-head">
          ${this._addPageBackHtml(step.back)}
          ${this._addPageCrumbsHtml(step)}
          <h2 class="liza-sr-only" id="liza-dlg-title">${this._esc(step.title || this._t("add_page"))}</h2>
        </div>
        <div class="add-page-search">
          <ha-input-search appearance="outlined" class="add-page-search-input" autocomplete="off"
                 value="${this._esc(query)}" accessible-label="${this._esc(this._t("search_templates"))}"
                 placeholder="${this._esc(this._t("search_templates"))}"></ha-input-search>
        </div>
        <div class="add-page-body">${this._addPageBodyHtml(step, query)}</div>
        <div class="add-page-foot">
          <span class="add-page-count">${this._esc(this._addPageCountText(step, query))}</span>
          <ha-button appearance="plain" class="add-page-cancel">${this._t("cancel")}</ha-button>
        </div>
    `;
  },

  /**
   * The trail of folders, each one a way back to itself.
   *
   * It replaces both the step's title and a Back button: a title says what
   * you are looking at and a Back button says there is somewhere behind it,
   * and one row of crumbs says both, plus how far in the walk has gone.
   */
  _addPageCrumbsHtml(step) {
    const crumbs = step.crumbs || [];
    const last = crumbs.length - 1;
    const parts = crumbs.map((crumb, i) => {
      const label = this._esc(crumb.label);
      if (i === last) return `<span class="add-page-crumb is-current" aria-current="page">${label}</span>`;
      return `<button class="add-page-crumb" type="button" data-crumb="${i}">${label}</button>`;
    });
    return `<nav class="add-page-crumbs" aria-label="${this._esc(this._t("add_page"))}">${
      parts.join('<span class="add-page-crumb-sep" aria-hidden="true">/</span>')
    }</nav>`;
  },

  /**
   * How much a query found, while one is being typed.
   *
   * Nothing while browsing: the cards are right there to be counted, and a
   * number beside them only reads as a result count for a search nobody ran.
   */
  _addPageCountText(step, query) {
    if (!query) return "";
    return this._t("search_result_count", { count: this._searchTemplates(step.all || [], query).length });
  },

  /** The grid for this step, or the results for whatever was typed. */
  _addPageBodyHtml(step, query) {
    if (query) {
      const results = this._searchTemplates(step.all || [], query);
      if (!results.length) {
        return `
          <div class="add-page-empty">
            ${this._renderChromeIconHtml("mdi:magnify-close", 40)}
            <p class="add-page-empty-title">${this._esc(this._t("search_no_matches", { query }))}</p>
            <p class="add-page-empty-hint">${this._esc(this._t("search_no_matches_hint"))}</p>
          </div>`;
      }
      const found = results.map((r) => this._templateRowHtml({
        attr: `data-template-id="${this._esc(r.template.id)}"`,
        icon: r.icon, name: r.name, hits: r.hits, template: r.template,
        desc: r.path.length ? r.path.join(" / ") : (r.desc || ""),
      })).join("");
      return this._templateListHtml(found);
    }

    const items = this._sortedStepItems(step.items || []);
    const options = step.kind === "options";
    // The first screen leads with the two things most pages start from: an
    // empty page, and the folder of ready-made remotes. HA's own pickers name
    // such a group rather than only ruling a line under it, so each is headed.
    // A page that needs no folder opening comes first whatever it is called.
    const leads = options ? items.filter(i => i.primary) : [];
    const lead = [...leads.filter(i => !i.members), ...leads.filter(i => i.members)];
    const rest = lead.length ? items.filter(i => !i.primary) : items;
    const rows = [];
    const rowsFor = (list) => list.map(item => this._templateRowHtml({
      attr: item.members
        ? `data-group="${this._esc(item.group)}"`
        : `data-template-id="${this._esc(item.template.id)}"`,
      icon: item.icon,
      name: item.name,
      // Counted through the sub-folders: like Home Assistant's "5 entities",
      // this measures what is inside rather than promising how many rows
      // come next, and it is what decides whether a folder is worth opening.
      desc: item.members
        ? this._tCount("template_count", item.members.length)
        : (item.desc || ""),
      kind: item.members ? "folder" : "leaf",
      template: item.members ? null : item.template,
    })).join("");
    rows.push(rowsFor(lead));
    const tail = [rowsFor(rest)];
    // One empty page over the rest is a running order, not two groups worth
    // naming: the headings earn their place once a folder claims the lead.
    if (!lead.some(i => i.members)) {
      return this._templateListHtml([...rows, ...tail].join(""));
    }
    return `
        <p class="template-list-title" id="liza-tpl-lead">${this._t("suggested_options")}</p>
        ${this._templateListHtml(rows.join(""), { cls: "is-lead", labelledBy: "liza-tpl-lead" })}
        <p class="template-list-title" id="liza-tpl-rest">${this._t("other_options")}</p>
        ${this._templateListHtml(tail.join(""), { labelledBy: "liza-tpl-rest" })}`;
  },

  /**
   * One row: a picture, a name, a line under it, and a tail.
   *
   * Every screen of the walk is built out of this -- the folders, the
   * templates inside one, the search results -- so moving between them
   * changes what is listed rather than the shape of the dialog. Only a
   * folder carries a tail, where its count and a chevron say it opens.
   */
  _templateRowHtml({ attr, icon, name, desc, hits, kind = "leaf", template = null }) {
    const nameHtml = `${hits?.length ? this._markHits(name, hits) : this._esc(name)}${this._templatePagesHtml(template)}`;
    // A folder says it opens, and is the only kind with a tail.
    const chevron = kind === "folder" ? '<span class="template-row-chevron"></span>' : "";
    if (this._haLists()) {
      // Home Assistant's list row: the picture leads, the name and the line
      // under it are its headline and supporting text. A target is an option
      // of a listbox, which marks the chosen one itself.
      const tag = kind === "target" ? "ha-list-item-option" : "ha-list-item-button";
      return `
        <${tag} class="template-row" ${attr}>
          ${kind === "target" ? "" : `<span slot="start">${this._tilePlateHtml(icon)}</span>`}
          <span slot="headline" class="template-row-name">${nameHtml}</span>
          ${desc ? `<span slot="supporting-text" class="template-row-desc">${this._esc(desc)}</span>` : ""}
          ${chevron ? `<span slot="end" class="template-row-tail">${chevron}</span>` : ""}
        </${tag}>`;
    }
    // A target is chosen rather than opened, so it wears a radio at its head:
    // the receipt above already carries the mark a plate would repeat.
    const tail = chevron ? `<span class="template-row-tail">${chevron}</span>` : "";
    const head = kind === "target"
      ? '<span class="template-row-radio" aria-hidden="true"></span>'
      : this._tilePlateHtml(icon);
    return `
        <button class="template-row" ${attr}>
          ${head}
          <span class="template-row-text">
            <span class="template-row-name">${nameHtml}</span>
            <span class="template-row-desc">${this._esc(desc || "")}</span>
          </span>
          ${tail}
        </button>`;
  },

  /** Whether Home Assistant's own lists are loaded (they come with the
   *  config panel `_loadHaComponents` pulls in); the walk's own buttons stand
   *  in until they are. */
  _haLists() {
    const ce = globalThis.customElements;
    return !!(ce?.get?.("ha-list-base") && ce.get("ha-list-item-button")
      && ce.get("ha-list-selectable") && ce.get("ha-list-item-option"));
  },

  /** The rows of one step as a list: Home Assistant's, which moves between
   *  them with the arrow keys and is one tab stop. */
  _templateListHtml(rowsHtml, { cls = "", labelledBy = "" } = {}) {
    const label = labelledBy ? ` aria-labelledby="${labelledBy}"` : "";
    if (this._haLists()) {
      return `<ha-list-base class="template-list${cls ? ` ${cls}` : ""}"${label}>${rowsHtml}</ha-list-base>`;
    }
    return `<div class="template-list${cls ? ` ${cls}` : ""}"${labelledBy ? ` role="group"${label}` : ""}>${rowsHtml}</div>`;
  },

  /**
   * The plate the picture sits on, one width for every row.
   *
   * These are rasters from imgserv, not glyphs CSS can tint, and the two
   * kinds are shaped nothing alike: a `logo:` is a wide wordmark and an
   * `mdi:` a roughly square white shape that needs colour behind it to read
   * at all. The plate is the same box for both so the names line up.
   */
  _tilePlateHtml(icon) {
    const val = String(icon ?? "").trim() || "mdi:remote";
    const wordmark = val.startsWith("logo:");
    // Three times the box, for a 3x screen; see _browserImgSrc. Neither kind
    // is themed: a glyph is a CSS-tinted vector, and the wordmark asks
    // imgserv for the default theme, since the plate identifies a template.
    const art = wordmark
      ? this._renderIconHtml(val, 16, "", { w: 42, h: 16 }, { srcSize: 126, theme: THEME_DEFAULT })
      : this._renderChromeIconHtml(val, 22, "", null, { srcSize: 66 });
    return `<span class="tile-plate ${wordmark ? 'is-wordmark' : 'is-glyph'}">${art}</span>`;
  },

  /** Rows read in the order they are drawn, so a click finds what it hit:
   *  by file name -- a folder by its directory's -- so a file named `01_…`
   *  leads its folder, digits sorting before letters. */
  _sortedStepItems(items) {
    const key = (item) => item.members
      ? String(item.group || "").split("/").pop()
      : String(item.template?.file || item.template?.id || item.name || "");
    return [...items].sort((a, b) => key(a).localeCompare(key(b)));
  },

  /** The chrome: breadcrumbs, the search field and the way out. */
  _bindAddPageStep(host, step, show, close, state, repaint) {
    const chain = this._stepChain(step);
    (step.crumbs || []).forEach((_, i) => {
      if (i === (step.crumbs || []).length - 1) return;
      host.querySelector(`[data-crumb="${i}"]`)?.addEventListener("click", () => {
        if (chain[i]) show(chain[i]);
      });
    });

    const field = host.querySelector(".add-page-search-input");
    // Its own clear button reports itself as an input that emptied the box.
    field?.addEventListener?.("input", () => {
      state.query = field.value ?? "";
      repaint();
    });
    field?.addEventListener?.("keydown", (e) => {
      if (e.key === "Escape" && state.query) {
        e.stopPropagation();
        e.preventDefault();
        state.query = "";
        if (field) field.value = "";
        repaint();
        return;
      }
      // The field is where the keyboard lands, so the grid has to be
      // reachable from it without a Tab through the chrome.
      if (e.key === "ArrowDown" || (e.key === "Enter" && state.query)) {
        const first = host.querySelector(".template-row");
        if (!first) return;
        e.preventDefault();
        if (e.key === "Enter") first.click?.();
        else first.focus?.();
      }
    });
    this._wireAddPageBack(host, () => show(step.back));
    host.querySelector(".add-page-cancel").addEventListener("click", close);
  },

  /** The cards, which are redrawn whenever the query changes. */
  _bindAddPageBody(host, step, show, close, state) {
    const sorted = this._sortedStepItems(step.items || []);
    const results = state?.query ? this._searchTemplates(step.all || [], state.query) : null;

    const pick = (template, label = template.name) => {
      // Which device, asked in this same dialog: it is the last step of one
      // question, so it goes back to the templates like every other step.
      this._showTemplateEntityPicker(template.id, template, {
        host,
        close,
        back: () => show(step),
        options: step.options,
        // The trail the walk already built, with the template on the end
        // under the name the row gave it: a folder crumb already says
        // "Sonos", so the one under it says "Cover", not "Sonos Cover".
        crumbs: [...(step.crumbs || []), { label }],
        onCrumb: (i) => {
          const chain = this._stepChain(step);
          if (chain[i]) show(chain[i]);
        },
      }).catch((e) => {
        console.warn("[lizaIP] Template picker failed:", e);
        close();
        this._toast(this._t("template_picker_failed"));
      });
    };

    host.querySelectorAll(".template-row").forEach(card => {
      card.addEventListener("click", () => {
        if (card.dataset.group) {
          const item = sorted.find(i => i.group === card.dataset.group);
          if (!item) return;
          // One step down, in the same dialog, by the same call however deep
          // it goes -- the first screen's folders included, which used to be
          // built by hand and lost the debug tools doing it.
          const next = step.kind === "options"
            ? this._templateStep(step.all, { group: item.group, back: step, crumbs: step.crumbs })
            : this._addPageSubStep(step, item);
          if (next) show(next);
          return;
        }
        const id = card.dataset.templateId;
        const found = results
          ? results.find(r => r.template.id === id)
          : sorted.find(i => i.template && i.template.id === id);
        if (!found) return;
        // A result that is also a row of the folder on screen takes that
        // row's shortened label, so searching inside Sonos still ends in
        // "Sonos / Cover"; one found elsewhere keeps its whole name.
        const here = results && sorted.find(i => i.template && i.template.id === id);
        const label = here ? here.name : found.name;
        // A routine is the walk's last step like the device question is, so it
        // is handed the same chrome rather than opening a dialog of its own.
        const run = this._templateAction(found.template);
        if (run) {
          run(found.template, {
            host,
            close,
            back: () => show(step),
            crumbs: [...(step.crumbs || []), { label }],
            onCrumb: (i) => {
              const chain = this._stepChain(step);
              if (chain[i]) show(chain[i]);
            },
          });
          return;
        }
        pick(found.template, label);
      });
    });
  },

  /**
   * Ask which device (or hub) a template should drive.
   *
   * Adding a template page and moving one to another device ask the very same
   * question under the very same rules, so they share this dialog; only what
   * the confirm button says and does differs. `onConfirm(target, kind)` does
   * the work and returns the toast to show once the dialog is closed.
   *
   * `host` and `close` draw this step into a dialog that is already open --
   * the add-page walk, of which this is the last step -- instead of opening
   * one. `back` is the step to return to; moving an existing page has nothing
   * to go back to and passes neither.
   */
  async _showTemplateEntityPicker(templateId, templateMeta, {
    // Set when the page being added is a button's options subpage: it binds to
    // the button's own device without asking, where the template allows it.
    options = null,
    confirmLabel = this._t(options ? "add_options_title" : "add_page"),
    busyLabel = this._t("adding"),
    host = null,
    close: hostClose = null,
    back = null,
    // The walk's crumb trail, and where each crumb goes. Moving an existing
    // page is not a walk and passes neither.
    crumbs = null,
    onCrumb = null,
    // Where the devices come from, and which one to propose: a template's own
    // list by default; binding a page no template made offers every device.
    loadDevices = null,
    onConfirm = async (target, kind) => {
      await this._addTemplatePage(templateId, target, kind, options);
      // The options path reports for itself: it toasts what it wrote, or why
      // it could not, before this ever gets a chance to.
      if (options) return "";
      return this._t("template_added", { name: templateMeta?.name || templateId });
    },
  } = {}) {
    // Bound to nothing, so there is nothing to ask: the page is added as it
    // stands, like a blank one. Here rather than at the caller so no path to
    // this dialog can show one that only says it cannot be used.
    if (templateMeta?.unbound) {
      hostClose?.();
      try {
        const done = await onConfirm(null, "device");
        if (done) this._toast(done);
      } catch (e) {
        this._toast(this._t("add_page_error", { error: e?.message || e }));
      }
      return;
    }
    const deviceSelector = templateMeta?.target_selector?.device || null;
    const entrySelector = templateMeta?.target_selector?.config_entry || null;
    const description = this._templateDesc(templateMeta);
    const fieldLabel = this._t(entrySelector ? "target_hub" : "target_device");

    const name = this._esc(templateMeta?.name || templateId);
    const field = `
        <div class="template-entity-picker">
          <p class="template-entity-caption" id="liza-template-target">${fieldLabel}</p>
          ${this._haLists()
            ? '<ha-list-selectable class="template-list template-target-list" aria-labelledby="liza-template-target"></ha-list-selectable>'
            : '<div class="template-list template-target-list" role="radiogroup" aria-labelledby="liza-template-target"></div>'}
          <!-- Replaced asynchronously with the outcome of a round-trip, which
               moves no focus, so a screen reader would otherwise never hear it. -->
          <p class="template-entity-hint" role="status" aria-live="polite">${this._t(entrySelector ? "loading_hubs" : "loading_devices")}</p>
        </div>`;

    // The last of the walk's steps, wearing the same chrome as the rest so the
    // trail does not vanish at the one moment something is committed to.
    // Opened on its own it stays the plain dialog it always was.
    const body = host ? `
        <div class="add-page-head">
          ${this._addPageBackHtml(back)}
          ${this._addPageCrumbsHtml({ crumbs: crumbs || [] })}
          <h2 class="liza-sr-only" id="liza-dlg-title">${name}</h2>
        </div>
        <div class="add-page-body is-form-body">
          <div class="template-receipt">
            ${this._tilePlateHtml(templateMeta?.icon)}
            <span class="template-receipt-text">
              <span class="template-receipt-name">${name}${this._templatePagesHtml(templateMeta)}</span>
              <span class="template-receipt-sub">${this._esc(description)}</span>
            </span>
          </div>
          ${field}
        </div>
        ${this._htmlDialogActions({
          row: "add-page-foot is-form-foot",
          dismiss: { cls: "add-page-cancel", label: this._t("cancel") },
          commit: { cls: "template-confirm-btn", label: confirmLabel, attrs: "disabled" },
        })}
    ` : `
        <h2 class="add-page-dialog-title" id="liza-dlg-title">
          ${this._renderChromeIconHtml(templateMeta?.icon || 'mdi:remote', 24, "", null, { srcSize: 72, theme: THEME_DEFAULT })}
          ${name}${this._templatePagesHtml(templateMeta)}
        </h2>
        ${description ? `<p class="template-dialog-desc">${description}</p>` : ""}
        ${field}
        ${this._htmlDialogActions({
          dismiss: { cls: "add-page-cancel", label: this._t("cancel") },
          commit: { cls: "template-confirm-btn", label: confirmLabel, attrs: "disabled" },
        })}
    `;
    let overlay;
    let close;
    // Cancel, Back or Escape while a target is being looked up: what comes
    // back then belongs to a step nobody is on any more.
    let dismissed = false;
    if (host) {
      host.innerHTML = body;
      overlay = host;
      close = hostClose;
    } else {
      ({ dlg: overlay, close } = this._openModal(
        `<div class="add-page-dialog template-dialog">${body}</div>`,
        { labelledBy: "liza-dlg-title" },
      ));
    }
    this._wireAddPageBack(overlay, () => { dismissed = true; back(); });
    // Bound before the lookup that fills the list: a load that fails or finds
    // nothing returns early, and a Cancel that does nothing is a trap.
    overlay.querySelector(".add-page-cancel").addEventListener("click", () => {
      dismissed = true;
      close();
    });
    (crumbs || []).forEach((_, i) => {
      if (i === crumbs.length - 1) return;
      overlay.querySelector(`[data-crumb="${i}"]`)?.addEventListener("click", () => onCrumb?.(i));
    });

    const list = overlay.querySelector(".template-target-list");
    const hint = overlay.querySelector(".template-entity-hint");
    // The hint carries the wait and anything that went wrong with it. Once
    // rows are on screen they say it all themselves, so the line goes rather
    // than restating the caption above them.
    const settled = () => {
      hint.textContent = "";
      hint.hidden = true;
    };
    const confirmBtn = overlay.querySelector(".template-confirm-btn");
    let chosen = "";
    const getTarget = () => chosen;
    const targetKind = entrySelector ? "config_entry" : "device";

    // Every other step focuses its first choice once drawn. This one's
    // arrives from a round-trip, so it is focused when it lands -- unless the
    // keyboard has deliberately been moved somewhere by then.
    let focusClaimed = false;
    const claimFocus = (el) => {
      if (!host || focusClaimed) return;
      focusClaimed = true;
      if (overlay.contains?.(this.shadowRoot?.activeElement)) return;
      el?.focus?.();
    };

    /**
     * The things this template can bind to, drawn as the rows every other
     * step of the walk is made of.
     *
     * The server returns exactly the eligible ones, so the list needs no
     * filtering and a pick needs no validating: choosing a row is the whole
     * interaction. One candidate is not a choice, so it arrives already
     * chosen and Add confirms it.
     */
    const paint = (targets, preselect = "") => {
      // One list, one row height. Areas are optional per device, so without
      // this the group reads as a ragged stack rather than a column.
      list.classList.toggle("is-two-line", targets.some((t) => t.desc));
      const ha = this._haLists();
      list.innerHTML = targets.map((t) => this._templateRowHtml({
        attr: ha
          ? `value="${this._esc(t.id)}" data-target="${this._esc(t.id)}"`
          : `type="button" role="radio" aria-checked="false" tabindex="-1" data-target="${this._esc(t.id)}"`,
        name: t.name,
        desc: t.desc || "",
        kind: "target",
      })).join("");
      const rows = [...list.querySelectorAll(".template-row")];
      const mark = (id) => {
        chosen = id;
        rows.forEach((row) => {
          const on = row.dataset.target === id;
          if (ha) row.selected = on;
          else {
            row.classList.toggle("is-chosen", on);
            row.setAttribute("aria-checked", on ? "true" : "false");
            row.tabIndex = on ? 0 : -1;
          }
        });
        confirmBtn.disabled = !id;
      };
      if (ha) {
        // Home Assistant's listbox: the arrow keys move between the rows,
        // Enter, Space or a click chooses one.
        list.addEventListener("ha-list-item-selected", (e) => {
          const row = rows[Number(e.detail)];
          if (row) mark(row.dataset.target);
        });
      } else {
        for (const row of rows) {
          row.addEventListener("click", () => mark(row.dataset.target));
        }
        // A radio group is one tab stop, and the arrows move within it.
        const STEP = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        list.addEventListener("keydown", (e) => {
          const here = rows.indexOf(e.target.closest?.(".template-row"));
          if (here < 0 || !rows.length) return;
          const next = e.key in STEP
            ? (here + STEP[e.key] + rows.length) % rows.length
            : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
          if (next < 0) return;
          e.preventDefault();
          mark(rows[next].dataset.target);
          rows[next].focus();
        });
        if (rows[0]) rows[0].tabIndex = 0;
      }
      if (preselect) mark(preselect);
      claimFocus(rows.find((r) => r.dataset.target === preselect) || rows[0]);
    };

    if (!deviceSelector && !entrySelector) {
      // Every shipped template declares a device or a config-entry selector; the
      // entity selector they replaced is gone. Saying so beats the old
      // behaviour of quietly painting an unfiltered entity picker, which let a
      // template bind to something none of its actions could service.
      hint.textContent = this._t("template_no_target");
      return;
    }

    // The one way this dialog commits, whether a target was chosen here or --
    // for an options page the button's own device already answers -- bound
    // without ever drawing the step.
    const commit = async (target) => {
      const done = await onConfirm(target, targetKind);
      close();
      if (done) this._toast(done);
      this._render();
    };
    const bindSilently = async (target) => {
      // Escape and the scrim close the dialog without passing through Cancel,
      // and it stays in the tree through the closing animation: its open
      // state is asked as well as the flag and the list.
      if (dismissed || list.isConnected === false) return;
      const dlg = overlay.closest?.(".add-page-overlay")
        || this.shadowRoot?.querySelector(".add-page-overlay");
      if (dlg && (dlg.isConnected === false || dlg.open === false)) return;
      try {
        await commit(target);
      } catch (e) {
        close();
        this._toast(this._t("failed", { error: e.message || e }));
      }
    };

    if (entrySelector) {
      // Config-entry templates are bound to one instance of an integration -- a
      // Hue bridge -- and generate their whole grid from what it owns.
      const { entries, error, suggested = "" } = await this._loadTemplateConfigEntries(
        templateId, options?.entity);
      const integration = entrySelector.integration || "";
      if (error) {
        hint.textContent = this._t("hubs_load_failed", { error });
        return;
      }
      if (!entries.length) {
        hint.textContent = integration
          ? this._t("no_hub_found", { integration })
          : this._t("no_hub_found_generic");
        return;
      }
      const proposed = entries.some((e) => e.id === suggested) ? suggested : "";
      if (options && proposed) return bindSilently(proposed);
      const only = entries.length === 1 ? entries[0].id : "";
      paint(entries.map((e) => ({ id: e.id, name: e.title })), proposed || only);
      settled();
    } else {
      // Device-mode templates span several entity domains of one device. The
      // eligible-device list is resolved server-side against the device and
      // entity registries, so this only has to present it.
      const { devices, error, suggested = "" } = loadDevices
        ? await loadDevices() : await this._loadTemplateDevices(templateId, options?.entity);
      if (error) {
        hint.textContent = this._t("devices_load_failed", { error });
        return;
      }
      if (!devices.length) {
        const integration = deviceSelector.integration || "";
        hint.textContent = integration
          ? this._t("no_matching_devices", { integration })
          : this._t("no_matching_devices_generic");
        return;
      }
      // Proposed, not chosen: preselected so one click confirms it.
      const allowed = new Set(devices.map((d) => d.id));
      const proposed = allowed.has(suggested) ? suggested : "";
      // An options page is about one button, and the button already names its
      // device: there is no question left to ask.
      if (options && proposed) return bindSilently(proposed);
      paint(devices.map((d) => ({ id: d.id, name: d.name, desc: d.area || "" })), proposed);
      settled();
    }

    confirmBtn.addEventListener("click", async () => {
      const target = getTarget();
      if (!target) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = busyLabel;
      try {
        await commit(target);
      } catch (e) {
        this._toast(this._t("failed", { error: e.message || e }));
        confirmBtn.disabled = false;
        confirmBtn.textContent = confirmLabel;
      }
    });
  },
};
