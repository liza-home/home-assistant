/**
 * lizaIP Panel — Styles.
 *
 * The stylesheet is kept as one string behind this module and split by feature
 * across the `styles/` directory. Consumers (`lizaip-panel.js` and
 * `lizaip-stylesheet.js`) import `STYLES` from here and are unaffected by
 * the split.
 *
 * The slices are joined in source order and the order matters: the sheet
 * resolves specificity ties by position, so moving a slice up or down this
 * list changes which rule wins.
 *
 * Nested files are served because `LizaIPPanelView` resolves the request path
 * under the panel directory rather than requiring a bare filename, and
 * `_panel_version()` walks the tree rather than listing one level -- without
 * that walk, editing a slice would not move the asset version and the browser
 * would keep serving the stale one.
 */
import { STYLES_BASE } from "./styles/base.js";
import { STYLES_ACTIONS } from "./styles/actions.js";
import { STYLES_BUTTONS } from "./styles/buttons.js";
import { STYLES_GRID } from "./styles/grid.js";
import { STYLES_PAGE_SETTINGS } from "./styles/page-settings.js";
import { STYLES_TILE_MENU } from "./styles/tile-menu.js";
import { STYLES_SETTINGS } from "./styles/settings.js";
import { STYLES_DIAGNOSTICS } from "./styles/diagnostics.js";
import { STYLES_DEBUG } from "./styles/debug.js";
import { STYLES_DIALOGS } from "./styles/dialogs.js";
import { STYLES_SLIDER } from "./styles/slider.js";
import { STYLES_A11Y } from "./styles/a11y.js";
import { STYLES_GUIDE } from "./styles/guide.js";
import { STYLES_DISCOVERY } from "./styles/discovery.js";

export const STYLES = [
  STYLES_BASE,
  STYLES_ACTIONS,
  STYLES_BUTTONS,
  STYLES_GRID,
  STYLES_PAGE_SETTINGS,
  STYLES_TILE_MENU,
  STYLES_SETTINGS,
  STYLES_DIAGNOSTICS,
  STYLES_DEBUG,
  STYLES_DIALOGS,
  STYLES_SLIDER,
  STYLES_A11Y,
  STYLES_GUIDE,
  STYLES_DISCOVERY,
].join("");
