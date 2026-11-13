/**
 * lizaIP Panel — Styles: remotes waiting to be added.
 *
 * One slice of the panel stylesheet. The barrel module one directory up
 * joins the slices back together in source order; nothing else imports
 * this file. The join is order-sensitive -- later rules win ties on
 * specificity -- so a slice must keep its position in that list.
 *
 * Home Assistant's own discovered-device row, as it appears on the
 * integrations dashboard: a green strip under a "Discovered" heading, the
 * name plain on the leading edge, the green Add on the trailing one. Green
 * rather than our accent because this is the one row in the list the user
 * does not own yet, and HA has already taught them what that colour means
 * here.
 *
 * No backtick may appear anywhere in this file but the pair delimiting the
 * literal below, not even in a comment quoting a CSS identifier: the first
 * stray one ends the string and everything after it parses as code.
 */
export const STYLES_DISCOVERY = `
  /* ── Grouping, as the integrations dashboard groups ──────────────── */

  /* The gap here separates groups; the one in base.js separates the rows
     inside them. */
  .device-list { gap: 20px; }

  .list-section { display: flex; flex-direction: column; gap: 12px; }

  .list-section-title {
    margin: 0 0 2px;
    font-size: 14px; font-weight: 500; letter-spacing: 0.02em;
    color: var(--liza-muted-text);
  }
  /* With no remote yet, the setup page's own heading, large as it is there. */
  .list-section-title[data-setup] {
    margin: 0 0 8px;
    font-size: clamp(28px, 4vw, 44px); font-weight: 400; line-height: 1.1;
    letter-spacing: -0.03em;
    color: var(--primary-text-color);
  }

  /* A wrapper only so there is a node to patch: the group inside it sits in
     the list's own flow, and an empty one leaves no gap behind. */
  .discovery-slot { display: contents; }

  /* ── Found on the network ────────────────────────────────────────── */

  /* Well clear of the card behind it: at the quiet end of the scale the strip
     read as an off background rather than as something waiting to be acted on.
     The border carries the rest on themes that flatten the fill. */
  .discovery-row {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 12px 12px 18px;
    border-radius: 12px;
    border: 1px solid var(--success-color, #43a047);
    background: color-mix(in srgb, var(--success-color, #43a047) 24%,
      var(--card-background-color, #1c1c1c));
  }

  /* Full-strength, not the muted token: this is the row's subject, and the
     only thing in it that is not a control. */
  .discovery-row-name {
    flex: 1; min-width: 0;
    font-size: 15px; font-weight: 500;
    color: var(--primary-text-color, #fff);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── The list with nothing in it ─────────────────────────────────── */

  .no-devices {
    list-style: none; margin: 0; padding: 8px 0;
    display: flex; flex-direction: column; gap: 16px;
    color: var(--liza-muted-text);
  }

  .setup-step { display: flex; align-items: center; gap: 16px; }
  .setup-step > div { flex: 1; min-width: 0; }
  .setup-step-icon { flex: none; width: 24px; height: 24px; color: var(--primary-text-color); }
  .setup-step-title { margin: 0 0 2px; font-size: 1rem; color: var(--primary-text-color); }
  .setup-step p { margin: 0; line-height: 1.5; }

  /* ── The toolbar control that leads back to the list ─────────────── */

  /* Patched in place when a remote is found, so it must hold its width
     whichever control is in it. */
  .toolbar-lead { display: flex; align-items: center; flex: none; }
`;
