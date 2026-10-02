# lizaIP for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2026.8.0%2B-41BDF5.svg)](https://www.home-assistant.io/)
[![GitHub release](https://img.shields.io/github/v/release/liza-home/home-assistant?include_prereleases)](https://github.com/liza-home/home-assistant/releases)
[![Integration type](https://img.shields.io/badge/integration-device-blue.svg)](https://developers.home-assistant.io/docs/creating_integration_manifest#integration-type)
[![IoT class](https://img.shields.io/badge/IoT%20class-local%20push-brightgreen.svg)](https://developers.home-assistant.io/docs/creating_integration_manifest#iot-class)

lizaIP is a smart control for home devices. This integration provides support for Home Assistant:
you decide what every button depicts and what it controls, all from a panel inside Home Assistant.

**This integration requires a physical lizaIP device.**

## Installation

**Requires Home Assistant 2026.8.0 or newer, with [HACS](https://hacs.xyz) installed.**

Click the button — it opens HACS with this repository pre-filled:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=liza-home&repository=home-assistant&category=integration)

Or add it by manually:

1. Open **HACS** in the Home Assistant sidebar
2. Click the **⋮** menu (top right) → **Custom repositories**
3. Paste `https://github.com/liza-home/home-assistant`, choose category
   **Integration**, click **Add**
4. Find **lizaIP** in the list and click **Download**
5. **Restart Home Assistant**

After installation, connected **lizaIP** devices will be discovered automatically —
confirm the **lizaIP** card under **Settings → Devices & Services**. 

### Settings

Nothing has to be configured to use the remote. What can be changed lives under
**Settings → Devices & Services → lizaIP → Configure**, and the defaults are the
ones most setups want.

| Setting | Default | What it does |
|---|---|---|
| **Device language** | Automatic | Language for the button labels the remote displays. *Automatic* follows Home Assistant's own language. |
| **Optimistic updates** | Off | Update a button's icon the moment it is pressed, before the device confirms the new state. If the action fails, the icon reverts a moment later. Makes the remote feel quicker at the cost of briefly showing a state that did not happen. |
| **Slider update interval** | 250 ms | Shortest gap between two updates while a slider is being dragged. Touch and release are always sent immediately, so the start and the final position are never delayed. `0` removes the limit and forwards every report the device sends. |
| **Demo mode** | Off | Puts the device into its showroom loop. |
| **dwell-time**, **swipe-time** | unset | Timings for that loop. Left empty, the device keeps whatever it already had. |

Renaming the device is a separate step: **⋮ → Rename** on the device page.

---

## add **lizaIP** to your local network

- how to add the **lizaIP** to your local network?

## Using it

Everything is configured from the **lizaIP** entry in the Home Assistant sidebar.

The editor has two tabs: **🎛️ Buttons** and **⚡ Actions**.

### The remote

A page holds **12 freely assignable buttons**, plus fixed controls:
**power**, **back**, **voice**, **volume +/−** and a **vertical slider**.

### Buttons — assigning what a button does

The Buttons tab shows the remote face, with that remote's pages beside it.

- Click a button on the face. Its card opens on the right, headed by an **Appearance**
  editor for the two things that decide how the button looks.
- Set what it should do in the **action editor** — the same editor Home Assistant uses
  in automations, so any service call works and you pick the target entity, device or
  area there.
- Set the **Image**. Once the action names a target,  the card offers that target's states 
  and lets you give each one its own icon as it changes. It is one or  the other: a fixed image, or icons per state.
- Give it a **Tooltip** — the text shown when a button is touched.
  `${STATE}` is replaced by what pressing the button does, `${NAME}`
  by what it opens, and the hint under the field shows what it currently reads.

Clicking a button on *another* page's thumbnail jumps to that page and selects that
button in one go.

Configuring a button adds its action to the Action Library automatically — you never
create library entries by hand, and a matching action is reused rather than duplicated.

**Making a fixed button do something different on one page.** Select a configured grid
button and it becomes the *context*: the power, back, voice and volume buttons, and the
vertical slider, then edit as overrides that apply only while that button is selected on
the remote. The card header says which pair you are editing, and **Page default** takes
you back to the page-wide setting. Clearing from the face menu removes just the
override in this mode, not the page default underneath it.

### Pages

- **Add** a page with the **+** tile at the end of the strip. You are offered a **blank
  page**, or a **layout** — a ready-made page for a device you already have in Home
  Assistant.
- **Reorder** by dragging thumbnails, or with the arrows in Page settings.
- **Delete** with the ✕ on a thumbnail.
- With no button selected, the card shows **Page settings** and an **icon colour**
  applied to that page's icons — a colour picker or a hex value. Cleared,
  icons follow the theme. Images and logos keep their own colours.
- To rename a page, click its **title** for the editor — plain text, an `mdi:` icon, a `logo:` name or an
  image URL.

Some layout pages stay **live**: a Sonos page follows the speaker's favourites, and
refills itself when you change them. **Sonos Radio** and **Sonos Playlists** do the same
with only your favourite radio stations or only your favourite playlists, twelve to a page. Editing such a button by hand detaches it from the
source.

To let a button switch pages, give it the built-in **Go to page** action and choose the
destination.

### The vertical slider

With nothing selected, the slider belongs to the page: pick the **entity** it drives,
**what** it controls (brightness, volume, cover position — the choices follow what the
entity actually supports) and a **sensitivity**. Left empty, it does nothing until you
touch a device.

A grid button can **retarget** it, so selecting that button points the slider at its
entity instead.

### Actions — the library

The Actions tab lists every action in use. It is where you curate them, not where you
create them. Open a row to:

- **Rename** it — the name is what button tooltips are derived from.
- Set the **Button icons** it uses by default, which every button sharing the action
  inherits unless that button overrides them.
- See **Assigned to** — every page and button using it. Click one to jump straight
  there.

Each row shows how many buttons use it, or **unused** if none do. **Filter** by name,
and delete entries you no longer need.

## Keyboard and accessibility

The panel can be operated entirely from the keyboard. Most of it behaves the way the
rest of Home Assistant does — **Tab** moves between controls, **Enter** or **Space**
activates the one you are on. The remote face is a custom control, though, and its menu
has no visible affordance at all, so what it holds is written out here.

### The remote face

**Tab** moves between the buttons on the face, one at a time, in the order they are
drawn. **←**, **→**, **↑** and **↓** move in the direction you press, which is quicker
across a remote than tabbing, and **Home** and **End** jump to the first and last button.
**Enter** or **Space** selects the button you are on and opens
its configuration below.

Moving between buttons does not select them, so you can explore the face without changing
what the editor is showing. Tabbing back onto the face returns you to the selected button.

**Shift+F10**, or the **Context Menu** key if your keyboard has one, opens that button's
menu — the same menu you get from a right-click or a long-press. Nothing on screen
advertises it, and it is the only way to reach **Move** and **Clear** without a pointer.
Inside the menu, **↑** and **↓** move between entries and wrap around, **Home** and
**End** jump to the first and last, **Enter** chooses, and **Escape** closes the menu and
puts focus back on the button you opened it from.

**Move** arms the button; selecting a second button then swaps the two. **Escape** calls
it off.

### Everywhere else

| Where | Keys |
| --- | --- |
| The tab strip at the top | **←** and **→** move between tabs, **Home** and **End** jump to the first and last. The tab you land on opens as you arrive. |
| An open configuration card | **Escape** closes it and returns focus to the button that opened it. |
| Page order | The **Move left** and **Move right** arrows beside the page name do what dragging a page thumbnail does. |
| A page thumbnail | **Shift+F10**, or the **Context Menu** key, opens that page's menu — the same one a right-click or long-press gives — where a page is duplicated, moved to another device (layout pages), deleted, or turned into a subpage, or back. A thumbnail is a tab stop only while its page is not the open one, so to mark the page you are on, step to another page first. |
| Dialogs | **Tab** stays inside the dialog, **Escape** cancels. |

### What else is covered

Colour, contrast and text size follow your Home Assistant theme, so the panel re-themes
and scales along with everything else. A few indicators, such as the keyboard focus ring,
keep a fixed colour so they stay visible on any theme. Controls carry names and roles for
screen readers, and changes with no visible cursor behind them — a page deleted, a layout
applied — are announced. Deleting a page always asks for confirmation first, and says how
many configured buttons go with it.

The panel is available in English, German, French, Italian and Spanish, and follows the
language set on your Home Assistant profile.

Two things worth knowing. Because the colours are inherited, a theme with poor contrast
of its own carries that into the panel. And dragging page thumbnails needs a pointer —
the arrows beside the page name are there to do the same job without one.

If something here does not work with your assistive technology, we would like to know:
see **Support** below.

---

## Troubleshooting

**The panel is not in the sidebar.** It is admin-only. Sign in as an administrator.

## Support

Questions and bug reports go to
[GitHub Issues](https://github.com/liza-home/home-assistant/issues). Diagnostics are
available from the device page under **Settings → Devices & Services**; attaching them
makes a report much easier to act on.

## License

Proprietary
