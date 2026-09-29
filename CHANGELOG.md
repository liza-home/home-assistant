# Changelog

Notable changes to the lizaIP integration, described in terms of what they change
for someone using it. The development repository keeps a fuller log that also
covers internal work.

The format is based on Keep a Changelog. Versions are calendar versions: `YYYY.MM.N`, where `N` counts the releases made in that month and starts at 1.

## [2026.09.1] - 2026-09-29

First public release. The remote is set up, configured and kept in step with your home
entirely from Home Assistant — there is nothing to edit in YAML, and no second app to
learn.

### Added

- **Setup through the user interface.** The integration is added from *Settings →
  Devices & services*; remotes on the network are discovered automatically over mDNS. No
  entry in `configuration.yaml` is needed, and there is one integration to install rather
  than three. The connection is local and push-based: a key press reaches Home Assistant
  without passing the internet, and re-discovery keeps the device's address and firmware
  version current by itself. Renaming a remote later does not mean removing and re-adding
  it.

- **A configuration panel for the remote.** The **lizaIP** entry in the sidebar draws the
  remote on screen, so it is always clear which key is being edited. A page holds **12
  freely assignable buttons** alongside the fixed **power**, **back**, **voice** and
  **volume +/−** keys and a **vertical slider**. The editor has two tabs — *Buttons* for
  the face, *Actions* for the library behind it — and clicking a button on another page's
  thumbnail jumps there and selects it in one go.

- **Any Home Assistant action on any button.** Buttons are assigned in the same action
  editor Home Assistant uses in automations, so every service call is available and the
  target is picked as an entity, a device or an area. Optimistic updates, if you turn them
  on, redraw the button the moment it is pressed instead of waiting for the device to
  confirm.

- **Buttons that show what they control.** A button takes a fixed **image** or **one icon
  per state**, so a lamp looks different on and off and the remote reflects the room rather
  than a label written once. An icon can be an `mdi:` name, one of the bundled brand logos
  — Hue, Netflix, Prime, Sonos, YouTube, Disney, Spotify, KNX — a `text:` label, an emoji,
  or a picture from a URL. Brands that ship a wide mark as well are chosen by the shape of
  the tile: `logo:netflix` is the badge on a square button and the wordmark on a wide one.

- **Pictures are fetched by Home Assistant, not by the remote.** An `http(s)://` icon is
  routed through the integration's own image server and reaches the device as a resized
  PNG over its existing connection, so the remote never talks to a third-party host.

- **Tooltips that write themselves.** The text shown while a button is touched can carry
  `${STATE}` and `${NAME}`, filled in from whatever the button currently points at — the
  state it will produce, and the thing it acts on. A button with no action still draws a
  sensible tooltip.

- **Pages, built by hand or from a layout.** Add a blank page, or pick a **layout** and
  the page arrives filled in: **Android TV**, **Apple TV**, **Fire TV**, **Roku**,
  **Samsung TV**, **Sonos** and **Hue**. Thumbnails reorder by dragging or with the arrows
  beside the page name, pages carry their own **icon colour**, and a page title can be plain
  text, an `mdi:` icon, a brand logo or an image. The built-in **Go to page** action turns
  any button into a way between them — and because the device executes it locally, the page
  changes without a round trip.

- **Layouts that keep themselves up to date.** A layout page stays connected to its source:
  a Sonos page follows the speaker's favourites and refills itself when you change them,
  and a Hue page gives every lamp on the bridge its own button. Editing one button by hand
  detaches that button and nothing else. A speaker that is switched off keeps its buttons
  as they were and marks them stale rather than replacing the artwork with titles, and a
  line-in shows as a socket icon because it has no cover art to find.

- **Layouts that know their device.** A TV layout wakes a sleeping set before it launches
  an app rather than sending a press into the dark, and Android TV apps are launched by
  deep link where the application ID alone would not do.

- **One action, many buttons.** Configuring a button files its action in the **Action
  Library** automatically, and a matching action is reused rather than duplicated. From the
  *Actions* tab you rename an action — which is what tooltips are derived from — give it the
  icons every button sharing it inherits, and see exactly which pages and buttons use it,
  each one a click away. Entries nothing points at are marked *unused*.

- **A fixed key can behave differently on one page.** Select a configured button and the
  power, back, voice and volume keys — and the slider — can be given **overrides** that
  apply only while that button is selected on the remote. *Page default* takes you back to
  the page-wide setting, so the exception never costs you the rule.

- **Rearranging a face without redoing the work.** Right-click a tile (long-press on a touch
  screen) and choose *Move…*: the next button clicked receives everything that was on it —
  action, label, icon, overrides and slider retarget. Landing on a button that is already
  configured **swaps** the two rather than overwriting, so aiming at the wrong tile destroys
  nothing, and Escape calls the move off.

- **A slider for whatever is to hand.** The vertical slider drives an entity of your
  choosing — brightness, volume, cover position; the choices follow what the entity actually
  supports — with an adjustable sensitivity. A grid button can **retarget** it, so selecting
  that button points the slider at its own device.

- **Slider update rate.** An option limits how often a drag is acted on, `250 ms` by
  default. Touching and releasing are always sent immediately, so a gesture still starts and
  ends exactly where your finger did — but the stream of intermediate positions no longer
  fills the history database. Set it to `0` for the old behaviour.

- **Automatic brightness.** A switch on the device page hands the display's brightness back
  to the remote itself. While it is on, the brightness slider is greyed out but still shows
  the level the device reports. Home Assistant also reads the current brightness from the
  device when it connects, so the slider starts at the real value instead of a guess.

- **The remote as a sensor, and as a trigger.** The device page carries its **battery
  level**, whether it is **charging**, and whether it is **in hand**. Every key is also an
  event entity reporting `touch`, `click`, `release` and `repeat`, so a button can drive a
  Home Assistant automation directly — including keys you never assigned an action to.

- **Firmware updates from Home Assistant.** The remote appears in Home Assistant's own
  update list: a new firmware is offered with its release notes, installed from there, and
  its progress is shown while it runs.

- **Operable from the keyboard, and with a screen reader.** The whole panel can be worked
  without a pointer: **Tab** and the arrow keys move across the remote face, **Enter** or
  **Space** selects a button, and **Shift+F10** opens the button menu that a right-click or
  a long-press otherwise gives — the only way to reach *Move* and *Clear* without a mouse.
  Moving across the face does not select, so it can be explored without disturbing the
  editor. Controls carry names and roles, changes with no visible cursor behind them are
  announced, and colour, contrast and text size follow your Home Assistant theme. Deleting a
  page that has something on it asks first; deleting a blank one does not. The README
  documents every key.

- **It speaks your language.** The configuration panel ships in English, German, French,
  Italian and Spanish and follows the language on your Home Assistant profile, while the
  button labels the remote displays follow Home Assistant's language unless you pick another
  one for the device.

- **Diagnostics.** The device page offers a diagnostics download containing the connection
  state, protocol and firmware version, and what the device reports it can do — useful to
  attach to a bug report.
