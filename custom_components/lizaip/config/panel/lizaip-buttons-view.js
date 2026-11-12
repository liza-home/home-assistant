/**
 * lizaIP Panel — Buttons View.
 *
 * HTML generation and wiring for the Buttons tab (pages, SVG, button config),
 * split by concern across the `buttons/` directory and composed back into one
 * mixin here. The slices share no method names, so a method means the same
 * thing after the split as before it -- `applyMixins` throws on a collision at
 * load, and `buttons-split.test.mjs` forbids one too.
 *
 * Importers see exactly what they saw before: `ButtonsViewMixin` and the
 * handful of pure helpers below.
 */
import { applyMixins } from "./lizaip-mixins.js";
import { ButtonsMarkupMixin } from "./buttons/markup.js";
import { ButtonsSliderMixin } from "./buttons/slider.js";
import { ButtonsFaceMixin } from "./buttons/face.js";
import { ButtonsPageStripMixin } from "./buttons/page-strip.js";
import { ButtonsGotoLinksMixin } from "./buttons/goto-links.js";
import { ButtonsMenusMixin } from "./buttons/menus.js";
import { ButtonsPressesMixin } from "./buttons/presses.js";
import { ButtonsWiringMixin } from "./buttons/wiring.js";

export {
  isGridBtn,
  OVERRIDABLE_FIXED_BUTTONS,
  FIXED_CONTROL_KEYS,
  hasOverride,
  sliderFollows,
  isConfigured,
  gotoLinkEnd,
  gotoLinkPath,
} from "./buttons/shared.js";

export const ButtonsViewMixin = applyMixins(
  {},
  ButtonsMarkupMixin,
  ButtonsSliderMixin,
  ButtonsFaceMixin,
  ButtonsPageStripMixin,
  ButtonsGotoLinksMixin,
  ButtonsMenusMixin,
  ButtonsPressesMixin,
  ButtonsWiringMixin,
);
