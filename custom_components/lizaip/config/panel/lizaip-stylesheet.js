/**
 * lizaIP Panel — adopting the stylesheet instead of inlining it.
 *
 * Its own module rather than a few lines in `lizaip-styles.js`, because
 * that file is one template literal from its first backtick to its last and a
 * test enforces it: a stray backtick in a doc comment there would end the
 * stylesheet early and take the panel down.
 */
import { STYLES } from "./lizaip-styles.js";

/**
 * The parsed stylesheet, built once.
 *
 * `null` until the first successful build. Every panel element then adopts
 * this same object, so the hundred-odd kilobytes are tokenised once per page
 * load rather than once per render.
 */
let _sheet = null;

/**
 * Give `root` the panel stylesheet without putting it in the markup.
 *
 * The panel renders by replacing `shadowRoot.innerHTML`, so a `<style>` tag in
 * that markup made the browser re-tokenise and re-parse the whole stylesheet --
 * over a hundred kilobytes of it -- on every render, and `_render` is called
 * from two dozen places. `adoptedStyleSheets` lives on the shadow root rather
 * than in its markup, so one parse survives every later rewrite.
 *
 * Returns `false` where the browser has no constructable stylesheets, and the
 * caller keeps inlining the tag as before.
 */
export function adoptStyles(root) {
  if (!root) return false;
  if (!_sheet) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      _sheet = sheet;
    } catch (e) {
      // No constructable stylesheets here. Not remembered: the panel builds
      // one element, so retrying costs one throw, and remembering it would
      // make the result depend on who called first.
      return false;
    }
  }
  try {
    // Appended rather than assigned: HA or a theme may already have put a
    // sheet on this root, and replacing the array would drop it.
    if (!root.adoptedStyleSheets.includes(_sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, _sheet];
    }
    return true;
  } catch (e) {
    return false;
  }
}
