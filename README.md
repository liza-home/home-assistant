# lizaIP for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2026.8.0%2B-41BDF5.svg)](https://www.home-assistant.io/)
[![GitHub release](https://img.shields.io/github/v/release/liza-home/home-assistant?include_prereleases)](https://github.com/liza-home/home-assistant/releases)
[![Integration type](https://img.shields.io/badge/integration-device-blue.svg)](https://developers.home-assistant.io/docs/creating_integration_manifest#integration-type)
[![IoT class](https://img.shields.io/badge/IoT%20class-local%20push-brightgreen.svg)](https://developers.home-assistant.io/docs/creating_integration_manifest#iot-class)

lizaIP is a smart control for home devices. This integration provides support for Home Assistant:
you decide what every button depicts and what it controls, all from a panel inside Home Assistant.

**This integration requires a physical lizaIP device.**

📸 **New here?** [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) is a screenshot-illustrated
walkthrough: installing, adding a device, defining pages, assigning button actions, the
`mdi:`/`phu:`/`logo:`/`text:`/`media:` image schemes, and live entity variables.

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
- Give it a **Tooltip** — what is shown when a button is touched: usually words, but
  any picture the Image field takes works too.
  `${_state}` is replaced by what pressing the button does, `${_name}`
  by what it opens, and the hint under the field shows what it currently reads.
  A tooltip can also show a live value from Home Assistant, such as a
  temperature or a battery level — see [Live values on the remote](#live-values-on-the-remote).

The Image, the Tooltip and a page's title are the same kind of field: a plain text
box you can copy from and paste into, saved with Enter or by leaving it. Plain words
need no `text:` in front. Typing `mdi:` — or the prefix of another icon set Home
Assistant has, such as `phu:` or `hue:` — opens a list of matching icons; picking one
saves it. Icons from any installed set are drawn on the remote, not just `mdi:` and `phu:`.

Clicking a button on *another* page's thumbnail jumps to that page and selects that
button in one go.

**Moving a button's configuration.** Drag a configured button onto another one and the
two change places: the action, the image, the tooltip and any overrides travel together,
and whatever was already on the destination goes back to the slot you just emptied, so
nothing is lost. Dropping it anywhere else, or pressing **Escape** mid-drag, calls it
off. A right-click or long-press on the button offers **Move…** for the same thing in
two steps — arm it, then click the destination — which is the route to use on a touch
screen, where dragging a button is not offered.

Every button takes part, the fixed ones included — the volume caps hold an ordinary
button configuration like any other. The two exceptions are the page title bar and the
vertical slider: the title bar has no action behind it, and the slider stores a value
range rather than an action, so neither can trade places with a button.

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

### Live values on the remote

A button's **Tooltip**, a button's **Image** and a page **title** can show the current
value of any Home Assistant entity. Write the entity ID in `${…}`:

| You write | The remote shows |
|---|---|
| `${sensor.outdoor_temperature}` | the state with its unit, e.g. `21.5 °C` |
| `${weather.home.temperature}` | one attribute of the entity, e.g. `18` (no unit) |
| `${weather.home}` | the weather: its icon in an image or page title, "Partly cloudy" in a tooltip |

The entity ID is the one shown under **Settings → Entities** in Home Assistant. Numbers
are rounded the way Home Assistant displays them, so a sensor you set to one decimal
shows one decimal here too.

Home Assistant fills the values in and pushes every change to the remote itself, at once
-- no browser has to be open. Each remote can switch this off under
**Settings** (the gear tab) **→ Variables → Variables and calculations**: off, every `${…}` variable
and calculation is left out, a picture that uses one shows its normal icon, and the
editor stops suggesting them.

**Examples**

| Field | You write | The remote shows |
|---|---|---|
| Tooltip | `Outside ${sensor.outdoor_temperature}` | Outside 21.5 °C |
| Tooltip | `Battery ${sensor.lizaip_1c63499a7193_battery}` | Battery 85 % |
| Tooltip | `${media_player.living_room.media_title}` | the song that is playing |
| Tooltip | `${_state} · ${sensor.desk_lamp_power}` | Off · 12 W |
| Image | `${sensor.outdoor_temperature}` | the value drawn as the button's picture |
| Image | `text:${weather.home.temperature}°` | 18° |
| Image | `${weather.home}` | the current weather icon (sun, clouds, rain, …) |
| Image | `${sensor.lizaip_battery_icon}` | an icon chosen by a helper — see below |
| Page title | `Living room ${sensor.living_room_temperature}` | Living room 22 °C |
| Page title (layout page) | `${_device}` | the name of the page's device, e.g. `Living Room TV` |
| Page title (layout page) | `Vol ${_device.volume_level}` | an attribute of the page's own entity |
| Page title (layout page) | `Vol ${round(_device.volume_level * 100)}%` | Vol 12% |
| Tooltip (layout page) | `${_device} ${round(_device.volume_level * 100)}%` | Living Room TV 12% |
| Tooltip | `Brightness ${round(light.desk.brightness * 100 / 255)}%` | Brightness 50% |
| Tooltip | `${round(sensor.outdoor_temperature)} °C` | 22 °C |

`${_device}` works the same in a layout page's tiles, state icons and tooltips, and in the
icons of the actions its buttons run. Typing `${` in a layout page's title, image or tooltip field also suggests `_device`, and after `${_device.`
the attributes of the page's entity.

**Calculations.** Inside `${…}` you can calculate with numbers, variables, the operators
`+ - * / %` (`%` is the remainder), brackets and the functions below. The result is a plain number,
without the unit.

| You write | The remote shows (sensor at 85) |
|---|---|
| `${sensor.battery * 2}` | 170 |
| `${(sensor.battery + 5) / 10}` | 9 |
| `${sensor.battery % 10}` | 5 |
| `mdi:battery-${round(sensor.battery / 10) * 10}` | `mdi:battery-90` |
| `${sensor.battery - sensor.battery % 10}` | 80 (rounded down to tens) |
| `mdi:battery-${max(10, min(90, round(sensor.battery / 10) * 10))}` | `mdi:battery-90`, always between 10 and 90 |

| Function | Result |
|---|---|
| `round(X)` | to the nearest whole number; a half rounds away from zero (2.5 → 3, −2.5 → −3) |
| `round(X, N)` | to `N` decimals, 0–6 (`round(21.75, 1)` → 21.8) |
| `min(A, B, …)` / `max(A, B, …)` | the smallest / largest of two or more values |
| `abs(X)` | without its sign (−3.5 → 3.5) |

`X` is a variable, a number or another calculation, so `${round(sensor.power / 1000, 1)}` works.
A value that is not a number, a mistake in the formula, or a division by zero shows nothing,
like a missing value.

**Completion.** In the panel's picture, tooltip and title fields, typing `${` opens a list.
Entities and function names are offered as you type, also after an operator or inside brackets; after a second dot (`${light.desk.`)
the entity's attributes are listed. Picking `round(` writes `${round()}` with the cursor between
the brackets, and the entities and attributes are completed inside them the same way.
Arrow keys and Enter, or a click, pick an entry; nothing is saved until you leave the field.

- **It stays current.** When the value changes, the remote is updated at once. A value
  that keeps changing -- a lamp being dimmed -- is sent at most every 0.5 s. Each remote
  can change that under **Settings → Variables → Update interval** (0.1 s to 5 s).
- **Missing values disappear.** If the entity is `unavailable`, `unknown` or does not
  exist, the variable is left out: "Battery ${…}" then reads just "Battery". An image
  whose variable has no value falls back to the icon the button would show anyway; a
  title stays blank.
- **Units only appear in text.** In an icon name such as `mdi:battery-${…}` the unit is
  left out, because `mdi:battery-80 %` is not an icon.
- The editor shows the current value as well: the preview draws it, and the hint under
  the field says what it reads right now.

#### An icon that follows a value — the battery level

An icon name has to match an existing icon exactly. Battery icons exist in steps of ten
(`mdi:battery-10` … `mdi:battery-90`, plus `mdi:battery` for full and
`mdi:battery-outline` for empty), while the battery sensor reports every percent — so
`mdi:battery-${sensor.…_battery}` would ask for `mdi:battery-87`, which does not exist.
A small **template helper** in Home Assistant turns the level into the right icon name.

1. In Home Assistant open **Settings → Devices & services → Helpers → Create helper →
   Template → Template a sensor**.
2. **Name:** `lizaIP battery icon` — this creates the entity `sensor.lizaip_battery_icon`.
3. **State template** — replace `sensor.lizaip_1c63499a7193_battery` with the battery
   sensor of your remote:

   ```jinja
   {% set b = states('sensor.lizaip_1c63499a7193_battery') | int(-1) %}
   {% if b < 0 %}unavailable
   {% elif b >= 95 %}mdi:battery
   {% elif b < 5 %}mdi:battery-outline
   {% else %}mdi:battery-{{ [[(b + 5) // 10 * 10, 10] | max, 90] | min }}
   {% endif %}
   ```

   Leave unit, device class and state class empty. The preview at the bottom of the
   dialog should show something like `mdi:battery-80`.
4. **Submit**, then in the lizaIP editor set the button's **Image** (or a page title) to

   ```
   ${sensor.lizaip_battery_icon}
   ```

   The helper already returns the full icon name, so nothing goes in front of it. (A
   helper that returns only `battery-80` works too; then write `mdi:${sensor.lizaip_battery_icon}`.) Add a
   tooltip such as `Battery ${sensor.lizaip_1c63499a7193_battery}` for the exact number.

If you prefer YAML, the same helper in `configuration.yaml` — with a charging icon while
the remote sits in its charger:

```yaml
template:
  - sensor:
      - name: "lizaIP battery icon"
        availability: "{{ has_value('sensor.lizaip_1c63499a7193_battery') }}"
        state: >
          {% set b = states('sensor.lizaip_1c63499a7193_battery') | int(0) %}
          {% set charging = is_state('binary_sensor.lizaip_1c63499a7193_charging', 'on') %}
          {% set icon = 'mdi:battery-charging' if charging else 'mdi:battery' %}
          {% if b >= 95 %}{{ icon ~ ('-100' if charging else '') }}
          {% elif b < 5 %}{{ icon }}-outline
          {% else %}{{ icon }}-{{ [[(b + 5) // 10 * 10, 10] | max, 90] | min }}
          {% endif %}
```

The same pattern works for anything with stepped icons, such as Wi-Fi strength
(`mdi:wifi-strength-1` … `-4`). The weather needs no helper: `${weather.home}` alone
is already drawn as the matching `mdi:weather-…` icon.

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
| The open page | **Delete**, or **Backspace** (the key a Mac labels *delete*), deletes it after the same confirmation as its ✕ — unless you are typing in a field, or a dialog or menu is open. |
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
of its own carries that into the panel. And two gestures need a pointer — dragging page
thumbnails, for which the arrows beside the page name do the same job, and dragging a
button's configuration onto another button, for which the face menu's **Move** does.

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
