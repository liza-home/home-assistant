# Changelog

Notable changes to the lizaIP integration, described in terms of what they change
for someone using it. The development repository keeps a fuller log that also
covers internal work.

The format is based on Keep a Changelog. Versions are calendar versions: `YYYY.MM.N`, where `N` counts the releases made in that month and starts at 1.

## [2026.10.2b1] - 2026-10-02

### Added

- **See what a firmware update brings before you install it.** The firmware
  update dialog now shows the release notes -- of every release since the
  version your remote runs, so nothing is missed when you skipped one.

- **Choose the font and size of titles and tooltips.** A new gear tab in the
  editor sets, for each remote, the font and size of page titles and of
  tooltips, with a live preview and a button to restore the defaults. Your own
  fonts work too: put `.ttf` or `.otf` files into `/config/lizaip/fonts/` and
  they appear in the list. For colourful emoji in titles and labels, put
  `NotoColorEmoji.ttf` into the same folder.

- **Sonos Radio and Sonos Playlists pages.** Two new layouts, titled with the
  Sonos logo: one puts your favourite radio stations on buttons 1-12, the other
  your favourite playlists -- nothing else from your favourites mixed in.
  Like the Sonos page, they keep up when you add, rename or reorder favourites
  in the Sonos app, and the volume keys and slider work as usual.

- **Duplicate a page.** Right-click (or long-press) a page in the editor's
  page strip and choose "duplicate page" to get a copy with all its buttons, placed
  right after the original and ready to edit. Copying a subpage gives you
  another subpage. The two pages are independent from then on: changing one
  leaves the other as it was.

- **Move a layout page to another device.** A page made from a layout -- a TV
  remote, say -- can now be pointed at a different device without starting
  over: choose "change device…" (or "change hub…" for Hue) in the page's menu
  and pick the new one. Your buttons, their names and their arrangement stay as
  they are; only what they control moves to the new device. Anything the new
  device has no counterpart for keeps controlling the old one.

- **Delete a page from its menu.** The page menu now also offers "delete page",
  asking for confirmation first, as the delete button does.

- **Pages you only reach from a button can be kept out of the way.** Some pages
  exist only as the destination of a "Go to page" button -- a page of light
  scenes behind one button, say. Until now the remote still offered them while
  you paged through, so getting to the page you wanted meant passing the ones
  you never browse to on purpose. Right-click a page in the editor's page strip
  (or long-press it on a touchscreen) and choose "make subpage": the remote
  stops listing it, while buttons pointing at it keep working exactly as
  before. The page stays in the editor, shaded darker so you can see which ones
  are subpages, and the same menu turns it back. **Shift+F10** or the **Context
  Menu** key opens it without a mouse.

### Changed

- **Better-proportioned text on the remote.** The words under a button are now
  drawn noticeably smaller, so longer names fit, and page titles written as text
  sit slightly inside their strip instead of touching its edges. After updating,
  the remote refreshes its pages once to pick up the new look.

### Fixed

- **The firmware update stays visible all the way through.** After you press
  Install, the update card no longer blanks out for a few seconds before it
  starts showing the installation; it shows "Installing" until the remote is
  back on the new version, and its heading names the step the remote reports,
  such as "Update started".

- **Clicking the page gets you back to its settings.** While editing a page's
  title, clicking anywhere on that page outside a button now closes the title
  editor and shows the page's settings, as it already did for a button.

- **Deleting a page always asks for confirmation, and now counts it right.**
  Before, a page that looked empty could be deleted without a prompt --
  including pages whose buttons the editor simply had not loaded yet; such a
  page now reports its true button count before you confirm.

- **Moving a page to a new hub now says "hub", not "device".** The
  confirmation after "change hub…" previously used the device wording
  regardless of which kind of target you picked.

- **Moving a layout page to a new device no longer touches your own text.** A
  button's label is yours; it is left exactly as you wrote it even if it
  happens to mention the old device by name.

- **A page kept out of the remote's own paging is now also announced as such
  by screen readers**, not only shown darker in the editor.

- **A remote that cannot find Home Assistant now fixes itself when it
  connects.** Part of pairing is writing Home Assistant's address into the
  remote so it can get back to you on its own. That only ever happened while
  Home Assistant was discovering the remote on the network -- which is the one
  moment a battery-powered remote is most likely to be asleep and not
  listening. The result was a remote that worked while the network happened to
  cooperate, and went quiet when it did not, with nothing in the interface to
  say why. Home Assistant now also writes the address the moment the remote
  checks in, using the connection the remote itself just opened. A remote that
  already has a working address is left alone.

- **Home Assistant no longer warns about lizaIP in its log.** A repair notice
  about a deprecated device lookup appeared on every start. It was harmless for
  now, but the same lookup was due to stop working in Home Assistant 2027.8.0,
  and when it did, removing the remote would have left its saved state behind.
  Both are fixed, and the notice is gone.

## [2026.10.1] - 2026-10-01

The first stable release of October. It carries what 2026.09.3b1 through b3
worked out -- the remote finding its way back to Home Assistant by itself, the
buttons named the way you would say them, and the panel telling you the truth
about what is connected. Those sections, just below, say what each one changed.

## [2026.09.3b3] - 2026-09-30

### Fixed

- **Remotes could be handed the wrong port for Home Assistant.** If your Home
  Assistant URL used the standard port for its scheme — `http://…` on port 80,
  for instance — remotes were still told to connect on 8123 and could not get
  through. They are now told the port the URL actually means.

- **Remotes are told the port Home Assistant really listens on.** When no
  Home Assistant URL is configured to read a port from, remotes used to be sent
  8123 regardless. On a Home Assistant OS install the port is 80 by default, and
  the "Server port" setting can change it — that actual port is now used.

- **A remote pointed at the wrong address now repairs itself.** Previously a
  remote only got a new address if it had none at all, so one left holding a
  stale host or port stayed stuck there. Now, when a remote turns up that is not
  connected and holds an address different from the current one, it is given the
  right one. A remote that *is* connected keeps working undisturbed.

## [2026.09.3b2] - 2026-09-30

### Fixed

- **Your remote's buttons had the word "button" in their name twice.** In
  German they read "Taste Button 1" instead of "Taste 1", and the named keys
  were worse: "Taste Button Volume Down" where you would expect "Taste Leiser".

  They are now named the way you would say them — Taste 1 to Taste 12, and
  Taste Zurück, Taste Ein/Aus, Taste Sprachassistent, Taste Leiser and Taste
  Lauter — in each of the five languages, using the same words the remote
  itself already uses for those functions.

  Nothing you have built breaks: the underlying entity ids do not change, so
  existing automations, scripts and dashboards keep working. Only the name you
  read changes. If you had renamed a button yourself, your own name stays.

- **Changing Home Assistant's language left the button names behind.** Every
  other text switched over at once, but the remote's buttons kept the wording
  they had been given when the integration last started — you had to restart
  Home Assistant to see them follow.

  They now follow the change by themselves, within a moment of you saving the
  new language.

## [2026.09.3b1] - 2026-09-30

The release that makes the panel tell you the truth about your remote, and makes a
bug report worth attaching.

### Added

- **You can now see your remote's IP address.** It appears in the Diagnostic
  section of the remote's device page, alongside the battery level. It follows
  the remote: if your router hands it a different address, the page shows the
  new one without you doing anything.

- **The panel's empty page now takes you where you need to go.** With no remote
  set up yet it used to state the fact and leave you to find the rest. It now
  links straight to lizaIP's own page in Settings → Integrations, which is where
  the button for adding one actually lives.

- **The online badge now follows your remote.** It used to be worked out once, when
  the panel opened, and then left alone — so a remote that came online a moment
  later stayed grey until you reloaded the page, and one that had gone away stayed
  green. It now updates by itself, the moment the remote connects or drops.

  The awkward cases are covered too. A panel left open in a background tab catches
  up as soon as you return to it, and one that was open across a dropped connection
  catches up when the connection returns. A brief network hiccup no longer wipes
  the device list, which is what made remotes seem to vanish.

- **Optimistic updates are on by default.** Press a button and the panel shows the
  new state straight away instead of waiting for the remote to confirm it. This was
  already available as an option; it is simply the starting point now. If you had
  deliberately turned it off, it stays off.

- **Diagnostics is worth downloading.** The file you attach to a support request
  used to say what the remote reported about itself and not much more. It now
  answers the questions that actually get asked.

  It includes the remote's address on your network — which appears nowhere else,
  because the remote dials Home Assistant rather than the other way round. It
  includes your settings, so "the slider lags" or "the labels are in the wrong
  language" can be explained without a round of questions. It notes how the
  integration was set up and how far it got, and whether the remote's stored model
  matches the one it currently reports — a mismatch is what makes the panel draw
  the wrong remote.

  Your configuration is described by shape only: how many pages, how many buttons
  carry something, how much of the action library goes unused. What a button
  actually points at is deliberately left out — those are the private part, and
  they stay private.

### Fixed

- **A remote that had forgotten where Home Assistant lives now finds its way
  back on its own.** If a remote loses the address it was given — after a
  factory reset, or a firmware update that cleared it — it announces itself on
  the network again, and Home Assistant is supposed to hand the address straight
  back. That never happened, so the remote sat there announcing itself while the
  panel showed it as offline, and the only way out was to remove it and set it
  up again.

  It is now repaired automatically: the remote is asked what address it has, and
  is given a new one only if it genuinely has none. A remote that is working is
  left untouched, and so is one that cannot be reached at that moment — the
  integration will not push your address onto a remote it was unable to ask,
  in case that remote belongs to a different Home Assistant.

  There is nothing to press and nothing to configure. Expect it to take a few
  minutes rather than to be instant: the repair happens the next time the remote
  announces itself, which on a real factory reset took just under nine minutes,
  with the remote back online a few seconds after that.

- **Buttons and icons in the panel could turn invisible.** Depending on your
  theme, the coloured circle behind each remote's icon in the device list — and
  the panel's filled buttons — could lose their colour entirely, leaving white
  on white. The control was still there and still worked; you just could not
  read it. The panel now falls back to its own colour when the theme does not
  supply one, and the filled buttons use a darker shade so their labels stay
  legible.

- **The diagnostics download now tells a straight story about your remote.** The
  firmware, hardware and model fields were listed twice with slightly different
  answers, and the model could read as "none" even while the device page showed
  it. Each now appears once, matching what the device page displays.

- **Home Assistant no longer grows over time from using the remote.** Every button
  action was compiled into a script that Home Assistant then held on to
  permanently, including each replacement made when a button was edited. On a busy
  setup this accumulated quietly in the background. Scripts are now released when
  they are replaced and when the integration shuts down.

- **Renaming the integration no longer restarts it more than once.**

### Changed

- **Home Assistant 2026.8 or newer is now required.** Previously 2026.7.1. The
  device lookup the integration relies on does not exist in the older release, so
  this is a hard requirement rather than a recommendation. Home Assistant will not
  offer you the update until you are on 2026.8.

## [2026.09.2] - 2026-09-29

A housekeeping release. Nothing about the remote or the panel changes; what changes is
what the integration does to Home Assistant around it.

### Fixed

- **No more warnings from lizaIP in your Home Assistant log.** Two of them, both asking
  you to open a bug report against us. One said the integration made a blocking call
  inside the event loop, the other that it used the device registry in a way Home
  Assistant has deprecated. Neither broke anything you would have noticed, but they made
  a healthy installation look unhealthy — and a log full of warnings you are told to
  report is worth fixing on its own.

- **Starting up no longer holds Home Assistant still.** Registering the panel and reading
  the remote's button labels both went to disk while everything else was waiting on them.
  The labels are now read once, in the background, as the integration starts; the panel
  works out its version off to the side. On a slow disk or a busy Pi this is the
  difference between a start that hesitates and one that does not.

- **Ready for Home Assistant 2027.9.** The deprecated device lookups the log complained
  about are the kind that stop working rather than merely warning. They have been moved
  to the supported helpers, so the integration will keep finding your remotes when that
  release lands.

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
