/**
 * lizaIP Panel — Styles: the primitives several tabs share (hint, toast, plain buttons).
 *
 * One slice of the panel stylesheet. The barrel module one directory up
 * joins the slices back together in source order; nothing else imports
 * this file. The join is order-sensitive -- later rules win ties on
 * specificity -- so a slice must keep its position in that list.
 *
 * No backtick may appear anywhere in this file but the pair delimiting the
 * literal below, not even in a comment quoting a CSS identifier: the first
 * stray one ends the string and everything after it parses as code.
 */
export const STYLES_SHARED = `
  .debug-btn { flex: 0 0 auto; }
  .debug-error {
    color: var(--error-color, #f44336);
    font-size: var(--liza-font-m);
    overflow-wrap: anywhere;
  }
  /* --- Shared --- */
  .hint-text {
    color: var(--liza-muted-text);
    font-size: var(--liza-font-m);
    padding: 24px 0;
    text-align: center;
  }
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--liza-accent-fill);
    color: #fff;
    padding: 10px 24px;
    border-radius: 8px;
    font-size: var(--liza-font-m);
    z-index: 999;
    opacity: 0;
    transition: opacity .3s;
    pointer-events: none;
  }
  .toast.show { opacity: 1; }
`;
