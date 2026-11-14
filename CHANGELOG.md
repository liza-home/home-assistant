# Changelog

Notable changes to the lizaIP integration, described in terms of what they change
for someone using it. The development repository keeps a fuller log that also
covers internal work.

The format is based on Keep a Changelog. Versions are calendar versions: `YYYY.MM.N`, where `N` counts the releases made in that month and starts at 1.

Each release starts with **⚠ Breaking changes**: anything that makes something
you set up stop working or look different, each with a **What to do:** line
that says how to get it working again. Features
that were removed are always listed under **Removed**, new ones under **Added**.

## [2026.11.3b1] - 2026-11-14

For slow smartphone browsers such as the Home Assistant app, where page
thumbnails stayed blank or showed only default icons.

### Added

- **Two editor switches for variables** under Settings → Editor, kept by the
  browser. *Update only visible pages* (on by default) updates a changed
  variable only on the pages you can see; the others catch up when you scroll
  to them. *Live values in the editor* (off by default) keeps the editor's
  previews following their entities.

### Fixed

- **Page thumbnails could stay blank in the Home Assistant app.** Pictures
  that were still loading were replaced every second; they are now kept, and
  one that fails is tried again.
- **Variable pictures and titles could stay on their fallback** -- the
  action's own icon, an empty title -- until the page was reloaded. The panel
  now asks again.
- **TV app icons stayed blank once the TV was off**, on an LG webOS TV's Apps
  pages for example. The icons are kept again for while the TV is off.

## [2026.11.2] - 2026-11-13

### Added

- **Put a remote back on an older firmware.** The **Install update** action
  now takes a version: `version: "11.4.1"` installs that release instead of
  the newest one, so a remote can be rolled back. A version the server does
  not have is refused with a list of the ones it has. The firmware card still
  offers only the newest release.
- **A toggle button drives the page slider by itself.** Give a button a
  toggle action for a dimmable lamp or a fan, and the slider on that page
  controls it while the button is selected -- as on the Hue template's lamp
  tiles. A device you picked for the slider yourself is never replaced.
- **Rounded album covers.** The new **Corner radius** setting rounds whole
  pictures such as album covers, from square (0 %) to round (100 %).

### Changed

- **Button 9 of every TV template is Mute.** The Android TV, Fire TV, Hisense,
  LG webOS, Philips, Roku, Samsung and Sony Bravia templates now have a mute
  toggle there.

### Removed

- **The hover card on the panel's remote picture**, and the setting that
  switched it off.
- **The page icon colour swatches** in the theme editor.

### Fixed

- **Setting up a new remote no longer shows a QR code.** The setup page and
  the panel now tell you to open `172.16.10.1` in a browser if the setup
  page isn't shown automatically.
- **An app set's labels with escapes are read as written**, and each app is
  shown once.
- **Rolling a remote back to a firmware version** no longer fails with
  "no version" for a release the server has.
- **A Sony Bravia's or Philips TV's Apps page shows its apps** rather than
  its HDMI inputs, including for a Bravia that was in standby.
- **A second Apps page appears in the panel as soon as it is added**, without
  reloading.
- **Deleting a button's last action clears the button** instead of the action
  coming back.
- **A held key stops repeating** when it comes up with a finger still resting
  on it.
- **A pinned icon or custom tooltip stays when the button is pressed.**
- **A remote set up for HTTPS or another port is reached on it** for firmware
  updates and diagnostics.

## [2026.11.2b1] - 2026-11-10

### ⚠ Breaking changes

- **Templates you wrote yourself need updating.** A template file now starts
  with `version: 2` and lists its pages under `pages:`, each with its own
  `title:`; a button's text is `tooltip:` and its picture `icon:` (were
  `label:` and `image:`), a held button's repeat is `key_repeat:` (was
  `repeat:`), and `unbound`, `action_name`, `name_key`, `description_key` and
  `title_key` are gone -- translated words are written `{translate: …}`. A
  file in the old form is no longer read. The templates that come with lizaIP,
  and the pages made from them, are converted for you.
  **What to do:** update your own templates as the README describes under
  "Page templates", then add the pages made from them again.
- **No fonts are shipped any more, and the default is Roboto Light.** Filson
  Soft Light and the Noto emoji fonts are no longer included, and
  `/config/lizaip/fonts/` is no longer read: fonts come from
  `/config/www/fonts/` and from Home Assistant itself.
  **What to do:** pick Roboto Light or a font of your own in the theme editor,
  or put `FilsonSoft-Light.otf` -- and `NotoColorEmoji.ttf` for colour emoji
  -- into `/config/www/fonts/` to keep the old look.
- **Sonos is now Sonos+, and the single favourites page is Sonos Control.**
  **Sonos+** adds three pages: album art and playback, with Playlists and Radio
  behind it. Pages you already added keep working.
  **What to do:** pick **Sonos Control** where you used to pick **Sonos** for
  one page of favourites.
- **Overview is now called Table of contents.**
  **What to do:** nothing for pages you already have; pick **Table of
  contents** when you add a new one.
- **The AI assistant's page tools use new names.** A button's text is
  `tooltip` (was `label`), a page's readable name `name` (was `title`) and its
  title picture `title` (was `image`). Your pages are converted, and the remote
  is sent every page once after the update.
  **What to do:** nothing, unless you call these tools or the panel's
  WebSocket API yourself: then use the new names.

### Added

- **Let the person who uses a remote set it up.** Open the **⋮** of a remote,
  pick **Assign user…** and switch on whoever should configure it. They get
  the **lizaIP** item in their sidebar and see only the remotes
  assigned to them, with everything they need for those: pages, buttons,
  actions, images, the remote's settings and its theme. They can also download
  a configuration or a diagnostics bundle for their own remote and restore one
  onto it; a bundle they build is narrowed to that remote and says so in its
  README, so it is not a copy of your installation. Adding or removing a
  remote, the debug tab, the shared theme library and seeing who else holds a
  remote stay with administrators. Somebody assigned no remote at all does not
  get the sidebar item, and taking a remote away takes effect immediately — an
  open panel drops it without a reload.

  Only active users without administrator rights are listed — administrators
  always have access — and **Assign user…** is greyed out until there is one.
  Somebody with no Home Assistant login of their own cannot be assigned, so
  give them a user account first.

  This decides which remotes somebody can *configure*, not what those buttons
  may do. An assigned user can put an action on a button targeting any
  entity their own Home Assistant account may call a service on, exactly as
  they could from a dashboard — Home Assistant's own user and entity
  permissions are unchanged and still decide what anyone can actually switch
  on. One rough edge: if you make somebody an administrator while they have no
  remote assigned, the sidebar item stays hidden for them until they unhide it
  once in Home Assistant's sidebar editor.

- **Send an IR code from a remote.** The new **Send IR** action
  (`lizaip.send_ir`) has a remote transmit an infrared code, given as base64.
  Like the other lizaIP actions, it goes to the remotes you name, or to every
  remote when you name none.
- **Sonos pages for albums, tracks, podcasts and audiobooks**, like Sonos
  Radio and Sonos Playlists: your favourites of that kind, twelve to a page.
  Each is offered only once your speakers have favourites of its kind. They,
  Sonos Radio and Sonos Playlists are under **Sonos → Categories** when adding
  a page.
- **Apple TV apps show their App Store icons** on the Apps page — TV, Music
  and Photos included, and App Store and Arcade their own logos; Computers,
  Settings and Search, which the store does not list, get a lookalike in their
  home-screen colours.
- **Samsung TVs show and start their apps again**, with the icons from
  Samsung's TV app store — newer Samsung TVs no longer tell Home Assistant which
  apps they have, nor start one when it asks, so the Apps page stayed empty and
  its buttons did nothing. The new action **Launch app** starts an app on a TV.
- **A TV's apps stay on the remote while it is off**: the apps and icons it
  showed last stand in until it is back.
- **All TV templates now work like the LG one.** Android TV, Apple TV, Fire
  TV, Roku, Samsung, Sony Bravia and Hisense share its layout: arrows around
  OK, Home below, and **Apps**, **Digits** and **Inputs** pages on the right
  — wherever the device has them. Samsung, Sony, Hisense and Roku TVs get an
  Inputs page; several templates gain volume keys.
- **New TV templates: Sony Bravia, Hisense (Vidaa) and Philips**, each with
  Apps and Digits pages, and Inputs where the TV has them. Hisense needs the
  Hisense TV integration from HACS.
- **TV pages are headed with the TV's brand and room** -- "LG Living room"
  rather than the TV's long model name.
- **Apps, playlists, radio stations and Hue lamps get as many pages as they
  need**, up to three, each leading on to the next.
- **The LG TV's Apps page leaves out the TV's own tools**, and its inputs get
  a page of their own.
- **Options pages can now be made from a template.** Switch on **Options
  pages** (with **Long touch**) under the remote's **Buttons** settings, then
  right-click a button and pick **Add options…**. It is offered only on buttons
  whose device has options — Hue options for a Hue lamp, Sonos options for a
  Sonos speaker — and the page is bound to that device without asking. With
  only one option for the device, it is added straight away. The new
  page's hardware **Back** button always leads back to the page the button sits
  on.
- **Two new templates for exactly that: Hue Lamp Options and Sonos Options.**
  Brightness and colour-temperature presets for one lamp; mute, shuffle,
  repeat, volume presets and a sleep timer for one speaker. Both are offered
  under **Add options…** only — they belong behind a button, not in the row of
  pages you swipe through.
- **Add a remote found on the network right from the panel.** It appears at
  the top of the remote list with **Add** and **Ignore**.
- **Choose a theme's emoji font.** The theme editor's Text group has an
  **Emoji** field: Automatic, None, or any font you have installed.
- **Fontbook in the settings.** With the Fontbook integration installed, the
  gear tab shows it beside Appearance.

### Changed

- **With no remote yet, the panel shows how to add one**: the setup steps, with
  the QR code.
- **The panel looks and behaves like the rest of Home Assistant.** Its dialogs,
  menus, messages, foldable sections, lists and keyboard focus ring are Home
  Assistant's own.
- **German and Spanish address you the way Home Assistant does** ("du",
  "tú").
- **Changing a theme no longer makes the remote reload every picture**, only
  the ones the theme draws differently.
- **The help button is on a remote's toolbar only.** Open a remote and press
  **?** to read the guide.

### Fixed

- **Renaming a remote reaches everything.** Renamed on its device page or on
  the integrations card, it now has one name everywhere, and renaming its
  entities no longer leaves pages and buttons pointing at the old ones.
- **Adding a template no longer stalls the panel for minutes** on the SD card
  or eMMC most Home Assistant boxes run from.
- **A deleted page leaves the panel at once**, also while another page is
  still being added.
- **Amazon Fire TV keys work**, and so do Roku's skip and replay keys.
- **The battery level survives a restart of Home Assistant.**
- **LG TV apps show their icons**, and a TV that is switched off no longer
  holds up the remote's pictures.
- **A TV's apps and inputs work when their page was added with the TV off.**
- **The Sony Bravia volume slider moves the volume.**
- **A page deleted with the Delete key is confirmed with Enter again.**
- **Moving a set of template pages to another device refreshes all of it.**
- **An options page no longer wipes the buttons you already set up.** Adding
  one saved the old action list back over the one the new page had just
  written, so its buttons -- and in some cases others -- ended up empty.
- **The Sonos options page's sleep timer works.** The four sleep-timer buttons
  were created without an action behind them.
- **Cancelling while an options page is being prepared really cancels it.**
  Pressing Cancel, Back or Escape during the short wait still created the page
  and pointed the button at it.
- **Switching pages while an options page is being made no longer scrambles
  the page you left.** The buttons of the page you moved to were saved onto it.
- **An options page is seated beside its button without disturbing the rest.**
  A page the remote added at the same moment could be lost before.
- **An options page's Back button no longer looks dead.** The arrow was drawn
  faint, as an unused hardware key is, even though it was wired to lead back to
  the page the button sits on. It is now drawn like any other configured
  button.

## [2026.11.1] - 2026-11-02

### ⚠ Breaking changes

- **A button is now drawn in your theme's colour for what it is doing.** A
  theme lets you set a colour for **On**, **Off** and **Unavailable**, but
  until now those three were never actually used — a button took the page's
  icon colour, or the colour of the lamp behind it, and otherwise every button
  on the remote came out in the same single colour whatever its entity was
  doing. They now work as the editor says they do. With the shipped default
  theme an entity that is off, or not answering, draws grey instead of white.
  **What to do:** nothing, unless you liked the flat look — open the theme,
  and set **Off** and **Unavailable** to the same colour as **Anything else**.
  A page given an icon colour still overrides all three, as before.

- **High Contrast now uses genuinely high-contrast colours.** Its yellow,
  blue, green, red and grey colours now each have at least 7:1 contrast
  against the remote's black background; previously its grey “Off” colour was
  too dim to read clearly. The theme still uses its largest text and heavier
  icons. **What to do:** nothing, unless you preferred its old colours — edit
  your own copy of the theme to choose different colours.

### Added

- **The online pill shows the battery.** The green *Online* pill in the
  configuration toolbar now fills from left to right with the remote's charge
  and shows the percentage next to the word, so you can see how much is left
  without opening the device page. If the battery sensor has not reported yet,
  the pill stays as it was.
- **See which Home Assistant your remote talks to.** The remote's device page
  now lists *Home Assistant address* next to its own *IP address*, and the
  **This remote** page shows it on a tile -- readable on the remote itself,
  without an app or a browser, which is exactly where you want it when a
  remote has stopped finding Home Assistant.
- **Give any page a device.** Right-click a page you built yourself and choose
  **Assign device…**; the dialog proposes the device most of its buttons already
  control. `${_device}` on that page then reads it, and **Change device…** moves the
  page to another device later.
- **Options for a button.** Right-click a button and choose **Add options…**: a
  new subpage is added, and the button's long touch opens it. Offered first in
  the menu while long touch is switched on (gear tab), and again once you have
  deleted the options page.
- **Themes.** A theme sets the page-colour palette, the colours used for on,
  off and unavailable buttons, the title and tooltip fonts and sizes, and the
  default icons. The picker shows shipped themes first and custom themes next,
  each with a preview; the **Create…** tile comes last. Picking a theme only
  changes the preview. **Apply theme** is always available to set the previewed
  theme on the remote; **Cancel** restores the saved choice when a different
  theme is previewed. Leaving the page never applies a pending pick. Saving a
  custom theme saves it and selects it for preview, but does not apply it.
  Shipped themes have an eye to view their values read-only and a copy action;
  they cannot be edited or deleted. Your own themes can be copied, edited,
  downloaded as `<id>.yaml`, or deleted. **Create…** starts a new theme and is
  also a drop target for theme YAML files. A dropped file is validated and
  added under a free name, never used to overwrite an existing theme. There is
  no separate import or share panel. Deleting a custom theme uses a destructive
  confirmation that names the theme and current remote text and explains that
  a remote still using it falls back to Default. Theme files live in
  `/config/lizaip/themes/`; themes are also included in configuration
  downloads and restored without overwriting existing files.
  The editor starts from a theme or **Blank**, and its **Colours**, **Text
  size** and **Icons** sections let you change each facet. The icon editor
  filters entries by action and lists all changed icons. Page/button-level
  choices continue to take precedence over the theme. Save an edit and every
  remote using that theme is redrawn with it.

- **Let an AI assistant build pages.** Tell Home Assistant's assistant (for
  example Claude) *"make me a page to control my shades"* or *"create a page for
  my Sonos in the Wohnzimmer"*, and it builds the page on your remote — using a
  ready-made template where one fits. It can also rename a button, give it
  another picture, swap two buttons, and rename or move a page. Turn it on by
  ticking **liza** in your conversation agent's settings (**Settings → Voice
  assistants**). It only uses entities you exposed to the assistant.

- **An Overview page.** **Add page → Template → Overview** makes a page with a
  button for each of the remote's pages: it shows the picture from that page's
  title (or a short text of its name) and goes there when pressed. It updates
  by itself when you add, remove or rename a page. Delete one of its buttons and
  the overview leaves it empty from then on.

### Changed

- **Deleting a page removes the buttons that opened it.** A button or long touch
  that went to the deleted page is cleared, instead of being left pointing at
  nothing; a long touch elsewhere on that button stays.

- **The page's Icon color section is hidden for now.** A colour set earlier
  still tints that page's icons. To colour a logo, add `?fg=` to it
  (`logo:sonos?fg=white`).

- **A page's right-click menu starts with Make subpage.** It now reads Make
  subpage (or Make main page), Change device (template pages), then — set
  apart — **Duplicate** and **Delete**, which used to read Duplicate page and
  Delete page.

- **`${_device…}` works on pages you made yourself.** There it means what the
  button controls, so a play/pause button with the tooltip
  `${_device.media_title}` shows the song its speaker plays. Before, it showed
  nothing on such a page. Template pages are unchanged: there it is still the
  page's device.

- **Enter on a button takes you to its first field.** With a button on the
  face focused, press **Enter** to open it and start typing in its first field;
  on a button that is already open, **Enter** goes back to that field.

- **Removing a button is called Delete.** Right-click (or long-press) a button
  and choose **Delete**, which used to read **Clear**. You can also select a
  button and press **Delete** or **Backspace**, the same keys that delete a
  page when no button is selected.

### Fixed

- **A theme's icons now change the buttons on the remote.** Changing a theme's
  on/off icons changed only the preview: every button the panel had saved kept
  its own copy of the standard icons, and that copy won. Those copies are no
  longer written, and an existing one that matches the standard icon is
  ignored, so themes now reach buttons you made before this release. Icons you
  picked yourself are untouched.

- **Delete deletes a button you just opened.** Opening a button put the cursor
  in its image field, so pressing Delete removed a letter of the image instead.
- **A button's tooltip says what its Tooltip field says.** A button whose
  tooltip matched its action's name could show something else: an Overview
  button labelled "Sonos" showed "Goto Page" in the editor and "Go to page: …"
  on the remote. Now the editor preview and the remote both print the field.
  Only a button whose field shows `${_state}` still shows the state it switches
  to.
- **A long page title starts at the left in the editor.** A title picture
  wider than its bar was centred, so its start was cut off; it now starts at
  the left edge. A title that fits stays centred.
- **The Overview's button for a page you just added works.** It showed the
  page but did nothing on the remote, and the editor drew no link from it
  until the browser was reloaded.
- **A deleted page disappears at once.** The editor kept showing it until
  the change had reached the remote.
- **Make subpage / make main page shows at once.** The editor waited for the
  change to be saved before showing it, which could take a while. Saving a page
  change now also writes only the pages that changed, also right after Home
  Assistant starts.
- **A page link's arrow stops at the page.** The arrow pointing at the page a
  button opens ran past the page's frame; its tip now ends on the frame.

## [2026.10.3] - 2026-10-23

### ⚠ Breaking changes

- **Pictures from Home Assistant must come from a picture address.** A
  picture written as an HA path now has to start with `/local/` (your `www`
  folder) or be an entity's picture (`${…entity_picture}`); other HA
  addresses are refused.
  **What to do:** move the file into Home Assistant's `www` folder and use
  `/local/<name>`.
- **Unusual picture formats are no longer shown.** Pictures must be JPEG,
  PNG, WebP, GIF or BMP, at most 10 MB.
  **What to do:** convert the picture to one of those formats.
- **After updating the remote's firmware to 11.4.1, some pictures may be
  missing on the remote.** The remote may still hold pages from before the
  update that it no longer draws completely.
  **What to do:** in the lizaIP panel, open the **gear menu** of that remote
  and choose **Clear and rebuild pages**. The remote is emptied and every
  page is sent to it again.
- **Layouts are now called templates.** Pages you added from a layout before
  this update still open, but they keep the old buttons and labels and do not
  get what the templates gained since (key repeat, artist names, the cover
  pictures).
  **What to do:** delete each page you made from a layout and add it again
  with **Add page → Template**, choosing the same device. If you call
  lizaIP's websocket commands yourself, use the new names: the `…layout…`
  commands are now `…template…` (for example `lizaip_config/list_templates`).
- **`file:` pictures are no longer supported.** A `file:` value is now shown
  as plain text.
  **What to do:** replace `file:my-picture.png` with `/local/my-picture.png`
  (the same file in Home Assistant's `www` folder).
- **Pictures keep their shape.** A cover in a title or on a tile is no longer
  stretched; it is drawn as large as fits.
  **What to do:** if you want the old stretched look, write the size on the
  picture (`?size=200x60`, or add `&fit=fill`).
- **A space ends a picture's address.** In a title made of several parts,
  `/local/my photo.png` is now read as the picture `/local/my` followed by the
  words "photo.png".
  **What to do:** write a space inside an address as `%20`:
  `/local/my%20photo.png`.
- **The Variables switch is gone.** Variables are always filled in now.
  **What to do:** nothing. If you had switched variables off, text such as
  `${sensor.x}` is now replaced by its value; write it differently if you
  wanted it shown literally.
- **The panel's files were renamed.**
  **What to do:** reload the lizaIP panel once in every browser tab that was
  open during the update.

### Added

- **Templates come in folders, and adding a page is one dialog.** The four
  Sonos templates are behind a single **Sonos** card: choose it, then which
  Sonos page. Every step of adding a page — blank or template, the folder,
  the device — happens in the same window, with a **Back** button at each
  step. Pages you already made from a Sonos template are not affected.
- **`${_device.friendly_name}` is suggested again** when you type a variable.
  It shows the name of the page's device, the same as `${_device}`; use
  whichever reads better. The device details are now suggested in
  alphabetical order.
- **Showcase pages.** **Add page → Showcase** offers ready-made pages that
  show what a button can do: *This remote* (its own battery, charging state,
  address and firmware), *Weather*, *Picture lab*, *Light studio* (Hue,
  HomeKit or Nanoleaf lights) and *Media wall* (Sonos). Some need no device
  at all.
- **An LG webOS TV template.**
- **Key repeat.** Turn on **Key repeat** for a button and its action repeats
  while you hold it — for cursor keys and volume. How soon it starts and how
  fast it repeats can be set per remote in the settings. The TV templates
  and the Sonos volume buttons have it on already.
- **A picture next to a logo and words in a title**, for example
  `${_device.entity_picture} + logo:sonos + ${_device.friendly_name}`: the
  cover now playing, the Sonos logo and the speaker's name.
- **`fit=contain` or `fit=fill`** on a picture keeps or drops its proportions.
- **A better Action Library.** Actions are grouped, show which buttons and
  pages use them, and can be filtered to *in use*, *unused* or *duplicates*.
  Delete every unused action, or merge duplicates, in one step.
- **Colours named after a state:** `fg=enabled`, `fg=disabled` and
  `fg=unavailable`.
- **UniFi and Dreame logos:** `logo:unifi`, `logo:dreame`.

- **The user guide is now in the panel.** Press the **?** button in the
  **lizaIP** panel's toolbar: the whole illustrated walkthrough -- pages,
  button actions, the image schemes, variables -- slides in beside the
  configuration. It sits next to your remote rather than on top of it, so you
  can follow a step and do it at the same time. The **Contents** line at the
  top always shows the section you are reading and drops the full list when
  you press it; drag the guide's inner edge to make it as wide as you like
  (the panel always keeps enough of itself to stay usable, the text keeps a
  comfortable line length however wide you go, and the screenshots grow to
  fill the rest). Give it enough room and the contents list stops being a
  drop-down and sits permanently down the side; either way there is a box to
  search the whole guide when twenty sections is more than you want to read
  through. It looks inside the text, not just the section titles, highlights
  what it finds, counts the hits in each section, and **Enter** walks them
  one by one (**Shift+Enter** walks back). The whole guide works from the
  keyboard: **↓** from the search box steps into the contents, the arrow keys
  walk it, **Home** and **End** jump to either end, and **Enter** opens the
  section. Click any screenshot to see it full size with its caption, step
  between all of them with **←** and **→**, and click the picture again to
  magnify it — twice, then three times the size — when the small print
  matters, dragging it about to see the rest. **+**, **-** and **0** do the
  same from the keyboard. **Escape** or a click on the background puts it
  back. The contents list
  folds away with the button beside its **Contents** heading when you would
  rather have the room, and stays folded next time. The guide opens underneath the toolbar
  now, so dragging its edge no longer shuffles the buttons above it, and it
  stops widening once the pictures have stopped growing rather than letting
  you drag out an empty margin. Press **Escape** or the **?**
  again to put it away, and it comes back where
  you left it next time. On a narrow screen it opens as a full window instead.
  No connection to GitHub is needed. The same guide is still on GitHub, and
  Home Assistant's own **Documentation** link on the lizaIP integration page
  now goes straight to it rather than to the repository front page.

### Changed

- **The panel shows buttons the way the remote does:** oval cells that
  touch, tiles in the remote's 50×52 size, square icons kept square.
- **The Sonos templates show the artist** beside the title, and the cover
  template shows artist and album.
- **Choosing a template is fast again.** The list could take close to a
  minute to appear.

- **The remote needs less memory for its pages.** Pictures are sent to it as
  short references instead of full addresses, and when it connects its pages
  are simply written again instead of first being listed by the remote. Both
  were large allocations on the remote and the first things to fail when its
  memory ran short.

### Removed

- **`file:` pictures** — use `/local/…` instead.
- **The Variables switch** in the settings; variables are always on.
- **Automatic merging of actions.** The Action Library used to merge actions
  with the same service on its own, sometimes ones that only looked alike.
  It now merges only when you ask it to.

### Fixed

- **Stable releases no longer contain the debug tools.** A stable version
  installed through HACS could still include the debug tools and debug pages
  of the beta before it. They are now removed.
- **Sonos cover pictures were blank on pages made from an older layout.**
- **Pictures on the panel's remote no longer go blank** when you switch
  between pages.
- **Pages added several at a time are all drawn,** not only the selected one.
- **An edit made while a save was still running is no longer lost.**
- **A failed save is reported** instead of looking as if it had worked.

- **The guide's screenshots show the panel as it is today.** They were taken
  from an older version; all of them have been photographed again, and five
  screens the guide only described now have a picture: a device being
  discovered, the toolbar's tabs, the guide itself, the ⋮ menu and the Restore
  configuration window. The memory gauges and the Debug tab are left out of
  the pictures — the gauges took up most of the toolbar and pushed it onto
  three rows in every shot. Both are still there in the panel itself.

- **Every picture in the guide now matches the text beside it.** Some did not:
  the Config chapter showed the Reconfigure form rather than the options it
  describes, the chapter on automatic discovery showed the *manual* "Add
  integration" picker, the device page was photographed on the wrong remote,
  and the chapter on variables used a tooltip with no variable in it. The
  slider and gear tab pictures stopped just above the settings they promised.
  All of these have been retaken.

- **A zoomed screenshot can be dragged around.** Magnifying a picture showed
  the middle of it with no way to reach the rest: the pointer moved it once
  and then stopped, because the browser's own picture-dragging took over.
  Press and drag now moves the picture as far as it goes.

- **A screenshot narrower than the guide sat against the left edge.** Small
  pictures are centred in the column now, like everything else in the guide.

- **The guide called the restore steps by the wrong names.** It said "Choose,
  Review, Apply"; the window says **Choose**, **Check**, **Restore**. It also
  still spoke of the panel's two tabs when there are four, and never described
  the Debug tab.

- **The guide's screenshots are shown at the size they were taken.** They were
  being squeezed into the width of a paragraph of text — under half the
  picture — while the lines between sections ran the full width beside them.
  The pictures, tables and code now use the whole width of the guide, and the
  text is centred in it rather than sitting against one edge.

- **Clicking a screenshot to zoom it now does something.** On a wide screen
  the "full size" it offered was the size it was already showing, so nothing
  happened. It magnifies properly now.

- **Scaling a `media:` picture needs only `?`.** Write
  `media:${_device.entity_picture}?size=200x200&bg=black` — the picture's own
  address may already have a `?`; a second one is read as `&`. All of `size`,
  `mode`, `fg`, `bg`, `crop`, `alpha` and `percent` work this way; the `|` form
  is gone. Put the address in quotes to keep its own query for its server:
  `media:'https://host/logo.png?size=2000'?size=200x200`.

- **A value shown on a button now reads the same as in a tooltip.** A battery
  or temperature variable lost its `%` or `°C` as soon as anything before it
  held a colon -- `Out: ${sensor.x}` or a variable written beside an icon,
  such as `mdi:battery ${sensor.lizaip_…_battery}`. Words drawn on a button
  now keep the unit, exactly as the same text does in a tooltip. A variable
  written *inside* an icon's name (`mdi:battery-${sensor.x}`) still has none,
  since a unit there is not an icon.

- **A graph inside a combined picture now updates on the remote.** A tooltip
  or image such as `Battery ${sensor.battery} + history:sensor.battery` kept
  showing the graph it was first drawn with, because the remote keeps a
  picture until its address changes. The address now changes with the graph.

- **The remote's record of a page follows live values.** When a value in a
  tooltip or icon changed, the remote got the new picture but kept the page's
  old fingerprint, so a later comparison could believe the page was up to
  date when it was not. The fingerprint now travels with every live change.

### Security

- **The picture service is harder to misuse.** It only reads Home
  Assistant's own picture addresses, always answers with a picture, does not
  follow redirects into your network, limits how much one request may
  download and draw, and keeps access tokens of cover pictures out of the
  log.
- **Note: the picture service is open to anyone who can reach Home Assistant
  on port 8123,** by design — the remote has no way to log in — and it will
  fetch pictures from any web address it is given. Do not expose port 8123 to
  networks you do not trust.

## [2026.10.3b2] - 2026-10-18

### Fixed

- **The ⋮ menu in the toolbar had its labels cut off at the right.** The menu is
  now placed from its right edge and is as wide as its longest entry, so
  "Download configuration" fits on one line wherever the menu is opened from.
- **A downloaded configuration or report was named in UTC.** The time in the
  file name is now the time your Home Assistant shows, so a download taken at
  09:46 is named `-0946`.

- **Icons on the remote faces no longer come up as broken-image question
  marks.** Redrawing a face interrupted whichever pictures were still arriving,
  and the browser — Safari above all — never asked for them again, so a handful
  of buttons sat empty until the page was reloaded. The editor now notices a
  picture that arrived with nothing in it and asks once more.

- **A placeholder in a layout's own tooltip did nothing.** Only tooltips *you*
  had typed could use `${_state}` and friends — the ones a layout ships with
  dropped them silently. That is why the Sonos change above was not possible
  before.

- **"Go to page: Sonos" showed no tooltip.** Words ending in a colon were taken
  for the start of a picture (`page:` like `mdi:`), and the remote got nothing.
  Only real picture types start a new part now.

- **Words with a question mark lost everything after it.** A title or tooltip
  such as "What?" reached the remote as "What". The question mark now travels
  with the words.

- **A colour written in an image value was ignored on the remote.**
  `mdi:lightbulb?color=blue` showed blue in the editor but white on the remote,
  because the page colour was added behind it. Your own colour now wins, the
  first one written counts when there are several (`color=` and `fg=`), and a
  hex colour may be written with `#` (`fg=#112233`).

- **The editor's pictures are the remote's pictures.** Every preview — button
  faces, the title bar, tooltips, the image fields — is now drawn from exactly
  the address the remote is sent, so a colour, a font or a picture type can no
  longer look one way in the editor and another on the remote.

### Added

- **A title can show a logo and a name side by side.** Separate parts with a
  space: `logo:sonos Küche`, `mdi:lightbulb Wohnzimmer` or
  `logo:hue text:Hue mdi:lightbulb` draw each part in the order written. After
  `logo:` and `mdi:` plain words need no `text:`. The icon or logo stands on
  the line the letters sit on and is as tall as the tallest letter; beside one,
  the words are drawn at a fixed size, and a title wider than the bar scrolls
  on the remote. On a square button, one mark and its words are stacked
  instead. See the user guide, *Combining several things in one picture*.

- **Text keeps room for accents and tails.** Text pictures are cut to
  everything the font can reach — from the top of an `Ä` to the bottom of a
  `g` — whether or not the words contain such letters, so "Hi" and "Hg" come
  out the same size and a row of buttons does not jitter.

- **A background colour fills the whole picture.** With `bg=` set, a picture
  is no longer trimmed to its content, and words are centred on the full size
  asked for, so `text:sub?bg=red` gives a red bar the width of the title.

- **Memory bars for the remote (beta releases only).** The Debug tab has a
  switch, *Show memory use*, that puts bars beside the device name for the
  remote's RAM, how fragmented it is, and its two flash areas. They are read
  after every transfer to the remote and at least every five minutes, and keep
  their last reading when the remote does not answer.

- **A configuration can be restored from a download.** The panel's ⋮ menu now
  offers **Restore configuration**, right under the download it undoes. One window
  walks you through it in three steps — choose, review, apply — so you can see
  how much is left to do. Pick the file or drop it in, and watch it go up. Give
  it a configuration ZIP — or a diagnostics bundle, which carries the same files
  — and the pages, buttons and action library come back, so a configuration lost
  to a mishap does not have to be built a second time. The file is checked
  before anything is touched, and the second step names it, says when it was
  downloaded, draws every page it holds the way the remote will show it --
  the real faces, with the icons on their buttons. An archive from another
  remote is accepted without a word about it: copying one remote's pages onto
  another is a thing you are allowed to do. You can step back to pick a
  different file right up to the moment you press Restore. The last step runs
  the work, then says it is done and waits for you to close it. A
  restore replaces rather than merges, and what it replaces is gone — so
  download the configuration you have now before putting an older one back. The
  remote is updated straight away, or catches up when it is next reachable
  if it happens to be away.
  Connection settings, icon options and uploaded fonts are not part of a
  configuration download and stay as they are.

- **The hover cards can be switched off, and start off.** Settings → Editor
  gained *Show button and page details* beside *Show page links*. With it on,
  resting the pointer on a button raises the card describing that button, and
  resting it on a page names the page and says how full it is; with it off the
  editor says nothing on hover. Off by default, like the page links beside it,
  and remembered per browser.

- **Next and Previous name the track they would play.** On a new Sonos page
  the Previous, Play/Pause and Next tooltips are simply the tracks: the one
  before, the one playing, and the one after — "Endless Summer", "Bohemian
  Rhapsody", "Babylon". Write them anywhere on a layout page as
  `${_device.media_title_prev}`, `${_device.media_title}` and
  `${_device.media_title_next}` (and `media_artist_prev`, `media_artist`,
  `media_artist_next` for the artists); type `${_device.` and the editor
  offers them. They read the player the page is built around. Today the
  neighbouring tracks work for Sonos only, because no other kind of player
  tells Home Assistant what is in its queue. They stay quiet rather than
  guess: on radio, with shuffle on, or at the end of a queue that does not
  repeat, the tooltip is empty. They combine with other words and
  placeholders — `${_state} - ${_device.media_title}` reads "Pause - Bohemian
  Rhapsody", and loses the dash when nothing plays. Like every placeholder
  that reads an entity, they need the remote's **Variables** switch on.

  `${_queue.next_song}`, `${_queue.next_artist}`, `${_queue.prev_song}` and
  `${_queue.prev_artist}` say the same for the speaker a *button* points at,
  on any page.

  To make this work, LizaIP adds one sensor per Sonos speaker a button or a
  layout page points at, named after the speaker and ending in "queue"
  (`sensor.kitchen_queue`). It holds the next and previous track, and you can
  use it anywhere you would use any other sensor. It appears on its own and
  disappears when nothing points at that speaker any more.

- **The placeholders are in the suggestion list now.** Type `${` in a Tooltip
  field and `_state`, the `_queue` values and `_name` appear at the top of the
  list with a word explaining each. Only the ones that can say something on
  that button are offered — the queue values on a Sonos speaker, `_name` on a
  "go to page" button — so a suggestion is never one that would come out blank.

### Changed

- **The ⋮ menu reads in the order you use it.** Download configuration, then
  Restore configuration under it, then the diagnostics report on its own below a
  line. The restore is no longer red in the menu: the warning belongs on the
  button inside its window, which is the one that actually replaces anything.
  The menu now reads like Home Assistant's own menus —
  the same row height, icon size and colours, which follow your theme — and a
  choice that cannot be made right now, such as restoring while a restore is
  already running, is greyed out instead of simply not answering.

- **"Toggle" in the gear menu is now "Multi toggle button".** The switch turns
  on buttons that carry several actions and step through them one per press.
  Called just "Toggle", it read as the `toggle` service that half the buttons
  in a house already run.

- **A new Sonos page names its tracks and itself.** Its Previous, Play/Pause
  and Next tooltips are the tracks (see above) instead of "Kitchen Previous",
  "Kitchen Play/Pause" and "Kitchen Next", and Mute reads "Kitchen Mute". The
  page titles show the Sonos logo with the speaker's name — or "playlist" and
  "radio" on the two favourites pages. Pages you already have keep what they
  were made with.

- **A tooltip you typed that reads as nothing is empty.** A tooltip of only
  `${_device.media_title_prev}` used to fall back to "Kitchen Previous" when
  there was no previous track; now it shows nothing, as written. The editor's
  tooltip field and its preview show the same: your text, without the room
  name put in front, and an empty preview when the remote shows nothing.
  Tooltips nobody typed still fall back to the name the remote works out.

## [2026.10.3b1] - 2026-10-14

### Added

- **Pointing at a button explains it.** Resting the mouse on a shape on the open
  face — or tabbing to it — raises a small card beside it summarising that
  button: its label and icon, every press it runs, its long touch and other
  gestures, the entity it acts on, and the page it opens. A goto whose page is
  gone is flagged, since the remote ignores such a press while the face goes on
  drawing a confident glyph for it. A button with nothing on it says so.
  <kbd>Esc</kbd> dismisses the card. A slider is described in its own terms:
  how it is pointed, and which device and property it moves.

- **The editor can draw the links between pages.** Switch *Page links* on under
  Settings → Editor and pointing at a button that opens another page draws a
  curved arrow from it to that page's thumbnail, which lights up. Pointing at a
  thumbnail shows everything that leads to it. Off by default, and remembered
  per browser.

- **A history graph can show any period.** Next to `hours`, a `history:` picture
  takes `days` (1 to 7) and the pair `start_time`/`end_time` for one fixed
  stretch, for example
  `history:sensor.house_power?start_time=2026-10-10T08:00:00Z&end_time=2026-10-10T20:00:00Z`.
  `start_time` on its own runs up to now, `end_time` on its own ends an
  `hours`/`days`-long stretch there, and a time written without a zone is read
  in your own. A fixed stretch stands still instead of moving with the clock;
  no period may be longer than a week.

### Changed

- **Both hover tooltips in the editor are now the same card.** The open face
  carried the page's label as an SVG tooltip and the page thumbnails carried
  theirs as a native one — each drawn by the browser in its own style, after
  its own delay, so pointing at something answered twice at once. The face no
  longer has one at all, and a thumbnail now raises the themed card instead:
  the page's title, where it sits in the strip, and how many of its buttons are
  assigned.

- **The "Go to page" action is now "goto page", and asks for the page's id.**
  It used to ask for the page *name*, with the id as a second, optional field.
  Two pages may share a name and a name can be renamed, so the id — the number
  the panel prints beside every page — is now the only thing the action asks
  for. Automations written against the old `page` field keep working.

- **A page's id is printed as `#id`.** Wherever a page is named — the title
  banner, the page lists in the action editor, messages and tooltips — it now
  reads "Page 3/9 (#24)". The number was easy to read as a third count beside
  the position; the hash says it is the id.

## [2026.10.2] - 2026-10-09

The second stable release of October. It includes everything since 2026.10.1;
the beta sections below record when each change arrived.

### Added

- **Live values from Home Assistant on buttons, titles and tooltips.** Write
  `${sensor.outdoor_temperature}` into a tooltip (`Outside ${sensor.outdoor_temperature}`)
  and the remote shows the current value with its unit, such as
  "Outside 21.5 °C". `${weather.home.temperature}` shows one attribute. The same
  works in button images, page titles and every icon field, for example
  `mdi:battery-${sensor.phone_battery}`. The remote updates as the value changes
  and falls back to the usual icon when the entity is unavailable.
  - `${weather.home}` on its own draws the current weather icon, and in a
    tooltip reads "Partly cloudy" in your language.
  - On a layout page, `${_device}` is the page's device and
    `${_device.attribute}` one of its attributes, e.g.
    `Vol ${round(_device.volume_level * 100)}%`.
- **Long touch.** Rest a finger on a button for 2 seconds to run a second
  action. Turn it on per remote in the gear tab; each button then gets a
  "Long touch" action. On such buttons the click runs when you lift your
  finger. With the switch off, nothing changes.
- **Buttons that show what a light is doing.** A button bound to a light can
  take the lamp's colour and fill its icon from the bottom as the lamp dims.
  Both are switched on per remote under "Icon options" in the gear tab, which
  also sets how finely the fill follows the brightness (formerly in the
  Configure dialog; your setting is kept).
- **Virtual toggle button.** A button can be a toggle you set up entirely in
  the editor.
- **Fonts for titles and tooltips.** A gear tab sets the font and size of page
  titles and tooltips per remote, with a live preview. Your own `.ttf`/`.otf`
  files in `/config/lizaip/fonts/` appear in the list; add
  `NotoColorEmoji.ttf` for colour emoji.
- **Sonos Radio and Sonos Playlists pages**: your favourite stations or
  playlists on buttons 1–12, following changes made in the Sonos app.
- **Page tools in the editor.** Right-click (or long-press) a page in the page
  strip to:
  - **duplicate** it, with all its buttons;
  - **change device…** (or **change hub…**) for a layout page, keeping your
    buttons and labels;
  - **make subpage**, so the remote stops paging through a page you only
    reach from a "Go to page" button;
  - **delete** it. With a page open, **Delete** or **Backspace** asks the same.
  **Shift+F10** or the **Context Menu** key opens the menu without a mouse.
- **Drag a button onto another** to swap their configuration.
- **Scaling a `media:` picture.** `size=200x200` in the URL or after a `|`
  scales it; `mode`, `fg`, `bg`, `crop` and `alpha` work the same way.
- **Firmware release notes.** The update dialog shows the notes of every
  release since the version your remote runs.
- **One-click diagnostics.** The ⋮ menu in the panel's toolbar and on every
  row of the device list offers **Download diagnostics**: one ZIP with the
  remote's configuration, its report and device log, the lizaip lines from
  Home Assistant's log, recent messages with the remote, and the versions in
  play, with a short `summary.txt` on top. A window ticks off each part; you can
  close it and the download still starts. Parts that can't be collected are
  listed with the reason. The bundle contains your entity ids, and the panel
  says so first.
- **Download configuration** in the same menu copies the remote's stored
  files as they are; put the folder back into `<config>/lizaip/` to restore.
- **Home Assistant's own Download diagnostics** for a lizaIP device now
  includes the remote's report, settings, and the errors and log lines about
  lizaIP, with entity ids hidden and secrets redacted, so it is safe to post.

### Changed

- **Starting Home Assistant no longer re-uploads every page.** Only pages that
  differ are written, and a reorder only changes the order.
- **Faster editor and lighter live updates.** Big setups load in one request,
  and a changed value redraws only the buttons showing it; changes that don't
  alter what you see are ignored.
- **Page titles, button images and tooltips are plain text boxes.** Enter or
  clicking elsewhere saves, Escape undoes. Plain words need no `text:` prefix.
- **Icon suggestions as you type** `mdi:` or the prefix of any icon set
  installed in Home Assistant. Icons from such sets (e.g. `hue:`) are now drawn
  on the remote instead of printed as text.
- **Tooltips can show icons and pictures**, e.g. `mdi:lightbulb` or
  `logo:sonos`.
- **Pages are named by position and id**, as "Page 3/9 (24)" with the title
  under it, in dialogs, tooltips and the "go to page" lists.
- **The built-in label tokens take a leading underscore:** `${_state}`,
  `${_name}` and `${_cmd}` instead of `${STATE}`, `${NAME}` and `${COMMAND}`.
  Existing labels are converted automatically.
- **The panel lives at `/lizaip`** instead of `/liza-remote`. Update your
  bookmarks.
- **Clicking a page in the editor no longer moves the remote to it.** Adding a
  page still does.
- **Smaller button text and inset page titles on the remote**, so longer names
  fit. The remote refreshes its pages once after the update.
- **The colour temperature slider** now makes the light warmer when you slide
  up.
- **Subpages look like main pages in the editor**, just slightly lower and
  shaded darker.
- **lizaIP no longer creates Repairs notices.** Refused pages, failing syncs
  and connection problems are logged as errors. Older notices are removed when
  Home Assistant starts.
- **Messages from the remote that break the protocol are logged as
  `PROTOCOL_ERROR`**, every time, so firmware problems show up in the log.

### Fixed

- **A remote finds Home Assistant again by itself.** HA writes its address
  into the remote whenever the remote connects, and when a known remote shows
  up on the network with an outdated address (after a change of HA's port, for
  instance), also while HA is still starting.
- **A remote that keeps refusing pages no longer stalls the sync for about 15
  minutes.** Refused pages aren't retried, and after three failures in a row
  the rest wait for the next sync.
- **A remote that is asleep or offline no longer counts as a failed sync**, and
  no page updates are sent while it is still connecting.
- **A request the remote couldn't read fails at once** instead of after 20–30
  seconds, and "exception in shielded future" errors are gone from the log.
- **Pictures** given as an HA path (e.g. `${_device.entity_picture}`) show on
  the remote, very long picture URLs such as Spotify mosaics work, and a cover
  the remote can't load is logged with the host's HTTP status.
- **A picture or name on a favorites slot survives the next refresh.**
- **Deleting a page** always asks first, with the right button count, and the
  editor shows it gone without waiting for the remote.
- **The firmware update card stays visible** through the whole installation
  and names the step the remote reports.
- **Editor details:** clicking the page outside a button returns to its
  settings; "change hub…" says "hub"; moving a page to a new device leaves
  your labels alone; subpages are announced to screen readers; the debug
  page's device-log switch shows the real state.
- **No more deprecation warning about lizaIP in Home Assistant's log**; the
  device lookup it warned about would have stopped working in 2027.8.0.

## [2026.10.2b4] - 2026-10-08

### Added

- **Drag a button onto another.** With a mouse or pen, drag a button to swap
  its configuration with another one, the same move the tile menu's "Move…"
  makes, in one gesture.
- **Delete a page from the keyboard.** With a page open, **Delete** (or
  **Backspace**, the key a Mac labels *delete*) asks to delete it, with the same
  confirmation as its ✕. Ignored while typing in a field or with a dialog or
  menu open.
- **`${_device}` on layout pages.** A layout page's title, button images, icons
  and tooltips can read the device the page is bound to: `${_device}` is its
  name, `${_device.attribute}` one of its attributes, e.g.
  `Vol ${round(_device.volume_level * 100)}%`. It follows a change of device
  and a rename, and the fields suggest it as you type.
- **Scaling a `media:` picture.** `size=200x200` in a picture's URL, or after a
  `|` (`media:${_device.entity_picture}|size=200x200&bg=black`), scales it to
  that size. `mode`, `fg`, `bg`, `crop` and `alpha` work the same way.
- **A Debug section for adding pages (beta releases only).** Add page offers
  Blank page, Layout and Debug. The demo layout, the random-pages generator and
  a new "Sonos example", whose tiles follow the speaker, live under Debug.

### Changed

- **Pages are named by position and id.** The delete confirmation, the page
  card, the page tooltips, toasts and the "go to page" dropdowns show a page as
  "Page 3/9 (24)" with its title under it (or after it, "Page 3/9 (24) ·
  Sonos", where only one line fits), so two pages with the same title can no
  longer be mixed up.
- **Deleting a page is quick again.** The editor no longer waits for the
  remote, which may be asleep, before showing the page gone.
- **The panel lives at `/lizaip`** instead of `/liza-remote`. Bookmarks to the
  old path need updating.
- **The built-in label tokens take a leading underscore:** `${_state}`,
  `${_name}` and `${_cmd}` instead of `${STATE}`, `${NAME}` and `${COMMAND}`.
  Existing labels, tooltips and action names are converted automatically.
- **Clicking a page in the editor no longer moves the remote to it.** Adding a
  page still does.

### Fixed

- **Pictures given as an HA path show on the remote**, e.g.
  `${_device.entity_picture}` as a page title, which used to stay blank.
- **Very long picture URLs no longer fail on the remote**, e.g. Spotify mosaic
  covers.
- **A picture or name put on a favorites slot survives the next refresh**
  instead of being blanked after a restart or a page change.

## [2026.10.2b3] - 2026-10-07

### Added

- **Virtual toggle button.** A button can now be a toggle that you set up
  entirely in the editor, with long touch and toggle settings on a switch in
  the gear tab.
- **A repair notice when the remote can't take everything.** If the remote
  refuses pages or a sync keeps failing, Home Assistant now shows it under
  Repairs instead of only writing to the log.

### Changed

- **Starting Home Assistant no longer re-uploads every page.** The remote is
  compared page by page and only pages that differ are written. A reorder
  changes only the page order, not the pages themselves.
- **Big setups load faster.** The editor fetches all button assignments in one
  request and skips redrawing work that nothing needs.
- **Faster, lighter live values.** When a value shown by a variable changes,
  the remote now redraws only the buttons that show it instead of reloading
  whole pages, and updates that don't change what you see (say, a new
  temperature when the button only shows the weather icon) are ignored.
- **Variables work in every icon.** Per-state button icons and the icons of an
  action accept `${…}` variables just like a button's image, and each field shows
  what it reads right now. An icon whose variable has no value falls back to the
  next icon instead of drawing a broken one.
- **Page titles, button images and tooltips are edited the same way.** Each is a
  plain text box you can copy from and paste into. Enter or clicking elsewhere
  saves it, Escape undoes it. Plain words need no `text:` in front, and the
  prefix is no longer added behind your back.
- **Icon suggestions as you type.** Type `mdi:` (or the prefix of another icon
  set installed in Home Assistant, such as `phu:`) and a list of matching icons
  opens under the field; pick one with the mouse or the arrow keys and Enter,
  and it is saved. The list is no longer cut off at the edge of the card.
- **Any icon set installed in Home Assistant works on the remote.** Icons from
  add-ons such as hass-hue-icons (`hue:`) used to print as text on the remote;
  they are now drawn like `mdi:` icons.
- **Weather variables just work.** `${weather.home}` on its own as a button
  image or page title draws the current weather icon (sun, clouds, rain, …),
  and in a tooltip it reads "Partly cloudy" in your language instead of
  `partlycloudy`. No template helper needed.
- **Tooltips can show icons and pictures.** A tooltip takes everything a
  button image does, e.g. `mdi:lightbulb` or `logo:sonos`, not just words.

- **Subpages look like main pages in the editor.** A subpage's thumbnail now
  has the same background as the other pages; it still sits slightly lower so
  you can tell it apart.

## [2026.10.2b2] - 2026-10-05

### Added

- **Show live values from Home Assistant on a button.** Write
  `${sensor.outdoor_temperature}` into a button's tooltip -- for example
  `Outside ${sensor.outdoor_temperature}` -- and the remote shows the current
  value with its unit, such as "Outside 21.5 °C". `${weather.home.temperature}`
  shows a single attribute. It works in a button's image too: an image of
  `${sensor.outdoor_temperature}` puts the value itself on the button, and
  `mdi:battery-${sensor.phone_battery}` picks the icon by value. Page titles
  accept the same variables. The remote updates as the
  value changes; if the entity is unavailable, the button falls back to its
  usual icon and text.
- **Long touch.** Rest a finger on a button for 2 seconds to run a second
  action. Turn it on per remote with the new "Long touch" switch in the gear
  tab; each button then gets a "Long touch" action below its click action.
  On buttons that have one, the click runs when you lift your finger, so the
  remote can tell a tap from a long touch. With the switch off, nothing
  changes.
- **Buttons that show what a light is doing.** A button bound to a light can
  take on the lamp's colour (including the warmth of a white lamp) and fill
  its icon from the bottom like a gauge as the lamp dims. Both are switched on
  per remote under "Icon options" in the gear tab, where you can also choose
  how finely the fill follows the brightness. The button reacts as soon as you
  press it, without waiting for the lamp to report back.

### Changed

- **Colour temperature slider.** Sliding up now makes the light warmer instead
  of colder.

## [2026.10.2b1] - 2026-10-02

### Added

- **See what a firmware update brings before you install it.** The firmware
  update dialog now shows the release notes -- of every release since the
  version your remote runs, so nothing is missed when you skipped one.

- **Choose the font and size of titles and tooltips.** A new gear tab in the
  editor sets, for each remote, the font and size of page titles and of
  tooltips, with a live preview and a "Restore fonts" button. Your own
  fonts work too: put `.ttf` or `.otf` files into `/config/lizaip/fonts/` and
  they appear in the list. For colourful emoji in titles and labels, put
  `NotoColorEmoji.ttf` into the same folder.

- **Set how finely light icons fill, in the gear tab.** A button for a light
  fills its icon like a gauge as the lamp gets brighter. How fine that fill is
  -- smoother, or quicker while dimming -- is now set in the editor's gear tab
  under "Icon options", instead of in the integration's Configure dialog. Your
  existing setting is kept.

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
