# lizaIP Integration

Single HACS-installable integration for ruwido LIZA IP remote controls.

## Structure

```
lizaip/
  __init__.py          # Integration entry point — setup, lifecycle
  config_flow.py       # Zeroconf + WebSocket discovery
  manifest.json
  strings.json
  services.yaml        # HA service definitions
  const.py             # Domain, option keys, bus event and dispatcher signal names
  runtime.py           # Lookups into live runtime state (store, connection, device id)
  optimistic.py        # Short-lived predictions of where a lamp is heading
  state_icon.py        # How a tile is drawn from the bound entity's state
  state_color.py       # Entity-derived icon tint (light rgb_color → fg=)
  state_brightness.py  # Icon fill level from a light's brightness
  variables_calc.py    # Calculations inside ${…} variables
  diagnostics.py       # Diagnostics support
  event.py, number.py, sensor.py, ...   # Platform wrappers → device/

  shared/              # Helpers used by more than one sub-package
    assignment.py      # Keys and helpers for a stored button assignment
    i18n.py            # Languages; ActionLabels (translated action wordings)
    icon_defaults.py   # IconDefaults (default icon per domain/state/service)
    icon_urls.py       # URLs the device fetches tiles, tooltips and titles from
    labels.py          # ${_state} / ${_name} label placeholders
    numbers.py         # to_float: numbers typed into forms
    preludes.py        # Wake prelude and launch verification steps
    services.py        # What HA services do: state maps, icon scopes
    tokens.py          # ${sensor.x} and ${_device} variables

  device/              # Device connection sub-package
    __init__.py        # Exports: LizaIPConnection, LizaIPWebSocketView, etc.
    connection.py      # WebSocket connection manager
    protocol.py        # Protocol implementation (request/response/event)
    websocket.py       # HTTP WS endpoint (/api/lizaip/ws)
    const.py           # WS_PATH, MODEL, bus event names, etc.
    entity.py          # Shared entity mixin
    event.py           # EventEntity (buttons)
    number.py          # NumberEntity (brightness, sliders)
    sensor.py          # SensorEntity (battery)
    services.py        # Service handlers (send_image)
    page_cache.py      # PageCache: what the remote is known to hold

  action_controller/   # What a press, a slider or a state change does
    _state.py          # RemoteState: selection, gestures, cycle positions per remote
    dispatch.py        # Routes button, slider and page events from the device
    buttons.py         # Compiles and runs the action behind a button press
    state_listener.py  # Watches entity states, sends icon updates
    toggle.py          # Virtual toggle button: one button, several actions
    sliders.py, slider_exec.py   # Slider capabilities and execution
    icons.py           # Matching an entity state to an icon and tooltip

  config/              # Config panel sub-package
    __init__.py         # Exports: async_setup_panel
    const.py            # Panel and storage constants
    panel.py            # Panel registration + per-entry listeners
    panel_entry.py      # PanelEntry: one remote's listeners, closed together
    events.py           # fire_config_changed (the one bus event config sends)
    websocket/          # WS API for the frontend panel, one module per panel area
    blueprint.py        # Button geometry per remote model (reads blueprints/)
    store.py            # YAML store for the remote's configuration
    button_rendering.py # What a button says and which icon it shows
    page_payload.py     # What a page contains: the set_page payload
    device_sync.py      # When and how pages are sent to the device
    icon_push.py        # Queued delivery of icon updates to one device
    variables.py        # Keeps ${…} variables current on the remote
    layouts/            # Dynamic layouts (favorites, scenes, ...)
    panel/              # Frontend JS assets
    blueprints/         # Button geometry, one file per hardware SKU (3029-000.yaml)

  imgserv/             # On-demand image rendering server
    __init__.py        # Registers HTTP endpoint at /imgserv/
    httpsocket.py      # Request handler — routes source:value URLs
    render.py          # Shared rendering utilities (SVG tessellation, autocrop)
    render_mdi.py      # MDI icon rendering (SVG → PNG via Pillow)
    render_logo.py     # Brand logo rendering (native colour or monochrome)
    render_custom.py    # Browser-registered icon sets (phu:, hue:, ...): store, upload, draw
    render_text.py     # Text-to-image rendering (shrink-to-fit, emoji fallback)
    const.py           # Size IDs, color names, path constants
    fonts/             # Bundled font files
    logos/             # Bundled SVG/PNG logo assets
```

## Installation

### Via HACS

1. HACS → Integrations → ⋮ → Custom repositories
2. Add this repository, category: **Integration**
3. Install **lizaIP**
4. Restart Home Assistant

### Manual / development

```bash
bash custom_components/lizaip/install.sh
ssh root@homeassistant.local 'ha core restart'
```

## Setup

After restart, Home Assistant discovers lizaIP devices automatically via mDNS
(`_lizaip._tcp`). Confirm the prompt in **Settings → Devices & Services**.

## Configuration parameters

This integration is discovery-only — there are no user-configurable parameters during
setup. The following data is stored automatically per config entry:

| Parameter | Description | Source |
|-----------|-------------|--------|
| `sw_version` | Device firmware version | Auto-detected via mDNS TXT record |

The device name can be changed via **Settings → Devices → (device) → ⋮ → Reconfigure**.

## Entities created per device

| Platform | Entity | Direction |
|---|---|---|
| `event` | One per button (`button_1`…`button_12`, `button_power`, etc.) | Device → HA |
| `number` | Brightness (`1`–`255`) | HA → Device |
| `switch` | Automatic brightness | HA → Device |
| `number` | One per slider (`slider_page`, `slider_volume`) | Device → HA |
| `sensor` | Battery | Device → HA |
| `binary_sensor` | Connectivity | Device → HA |
| `update` | Firmware (with release notes) | HA → Device |

Sliders are `number` entities in `NumberMode.SLIDER`. Protocol v1 has no slider-set command,
so writes from Home Assistant only update the local value and log a warning — the position
resyncs on the next slider event from the device.

### Slider update rate

A slider reports continuously while it is being touched, and the protocol offers no way to
ask the device for a slower rate — events are fire-and-forget with no return channel. Left
alone, one drag becomes hundreds of service calls at whatever the slider drives *and*
hundreds of recorder rows for the `number` entity.

One option thins that stream, under **Settings → Devices & Services → lizaIP → Configure**,
in the collapsed **Slider Options** section:

| Option | Default | Effect |
|---|---|---|
| Slider update interval | `250 ms` | Shortest gap between two updates during a drag. |

The rate limiting is Home Assistant's own
[`Debouncer`](https://github.com/home-assistant/core/blob/dev/homeassistant/helpers/debounce.py)
with `immediate=True`: the first movement goes through at once and the rest are collapsed
into a single trailing call when the cooldown expires. That trailing call matters — a
movement held back is still applied a quarter-second later, rather than waiting for the
finger to lift.

The setting applies only to the *middle* of a gesture:

- **Touch and release are never delayed.** The grab responds at once, and the position the
  finger lifts at is always written — that is the value that has to be correct.
- **An unchanged position is never sent.** A finger resting on the slider keeps reporting;
  re-sending the same value says nothing.

Set it to `0` to act on every distinct position, which is how the integration behaved
before this option existed.

The device itself keeps reporting at full rate either way: slider events are fire-and-forget
and the protocol has no return channel, so there is no way to ask for less.

### Slider direction

Sliding up raises the value — except for **colour temperature**, where up means *warmer*,
which lowers the kelvin number.

Kelvin runs backwards from the thing being adjusted: warm light is around 2200 K and cool
light around 6500 K, so "more kelvin" is "less warm". This remote's slider is a *blind,
relative* drag — there is no track and no gradient to look at — so the only intuition
available is "up = more", and for a colour control "more" reads as warmer.

Home Assistant is worth comparing, but it does not settle the question:

| Control | Inverted? | Warm end |
| --- | --- | --- |
| `ha-state-control-light-brightness` (vertical) | no | — |
| `light-color-temp-picker` (vertical, more-info) | **yes** | top |
| `hui-light-color-temp-card-feature` (horizontal) | no | left |

So HA's actual rule is "the warm end comes first in the gradient" — left when horizontal,
top when vertical — not a claim that up means warmer. HA can treat direction as a layout
choice because its sliders are *absolute* and draw the gradient: you look at the colours and
touch the one you want. A blind relative drag has no equivalent affordance, so direction has
to carry the meaning on its own. The vertical picker agreeing with us is corroboration, not
the reason.

This is a UX judgement rather than something derivable, and there is deliberately **no
opt-out**: direction is a property of the capability, not a per-slider preference, so two
remotes cannot end up disagreeing. It is derived from the control's mechanics on every event
(`sliders.control_inverts`), so configurations written before this existed pick it up with no
migration.

### Icon tint and fill

A button bound to a light can fill its icon from the bottom, like a gauge, to show how
bright the lamp is, and can take that lamp's colour instead of the page colour. Both are
**off until switched on**, per remote, in the panel's [gear tab](#settings-gear-tab),
under **Icon options** — they repaint every button bound to a light, which is a visible
change to a remote the user has already arranged:

| Option | Default | Effect |
|---|---|---|
| Tint icons with the light's colour | off | A lit lamp's colour replaces the page colour. |
| Fill icons with the light's brightness | off | Fills the icon from the bottom. |
| Fill step | `5 %` | How much the fill advances per level. Range 1–25. |

The two switches are independent: the fill can be on with the tint off, and the reverse.
The fill step applies only while the fill is on, so the gear tab greys it out otherwise.

The default is measured rather than chosen, but the measurement that decides it is not the
renderer's. A button icon is 50 pixels tall, so 50 levels is every fill that can be drawn
differently, and 2 % lands exactly on that ceiling — which is why the step was 2 for a
while. The ceiling turned out to be the wrong budget. The level is part of the image URL,
so a percent the remote has not cached costs it a fetch before it can paint: a novel
`set_page` measures p50 ~220 ms against ~58 ms for one already in cache. Step 2 mints 50
distinct URLs per lamp per page and spends a whole dimmer sweep paying that penalty; step 5
mints 20, warms the cache 2.5× sooner, and still renders all 20 levels distinctly, so
nothing is lost to aliasing. Lower it toward 1 for a smoother fill if the device keeps up,
raise it if a sweep still feels heavy or to get the older, coarser look back.

The config panel's button previews follow the same setting, so what it shows stays the
image the remote is actually drawing.

## Data update mechanism

This integration uses a **local push** model. The physical device initiates a persistent
WebSocket connection to Home Assistant (`/api/lizaip/ws`). All state updates (button
presses, slider changes, battery level) are pushed by the device in real time — there is
no polling.

When the device disconnects, all entities become `unavailable`. When it reconnects, the
integration performs a `hello` handshake and re-discovers capabilities automatically.

## Supported devices

- **ruwido lizaIP** remote control (all firmware versions supporting protocol v1)
- Virtual Remote (Node.js dev tool in `virtual_remote/`)

## Supported functions

| Function | Description |
|----------|-------------|
| Button events | Touch, click, release, repeat — fired as HA `event` entities |
| Sliders | Touch-slider position tracking (device → HA only) |
| Brightness | Set display brightness on the remote (`1`–`255`, or automatic mode) |
| Page management | Push page/button configuration from HA to device |
| Image sending | Push icon/image URLs to specific buttons via the `send_image` action |
| IR blasting | Send IR codes through the device (via page action config) |
| Diagnostics | Battery level, connection status, protocol/firmware version |
| Image server | On-demand PNG rendering at `/imgserv/` — MDI icons, brand logos, PHU icons, text, static files, media thumbnails, history graphs |
| State-based icons | Automatic button icon updates when watched entity states change |
| Config panel | Sidebar UI for managing Action Library, button assignments, and pages |

## Actions

### `lizaip.send_image`

Push an image to a specific button on a connected device.

| Field | Description |
|-------|-------------|
| `image_url` | URL of the image (see [URL Schemes](#url-schemes) below) |
| `target_device` | Device ID of the target lizaIP remote |
| `target_button` | Button name (e.g. `button_1`) |

### URL Schemes

The following URL schemes are supported in image URLs (`send_image`, page config, icons):

| Scheme | Example | Resolves to |
|--------|---------|-------------|
| `imgserv://` | `imgserv://mdi:home?size=tile` | `https://<ha>:<port>/api/imgserv/mdi:home?size=tile` |
| `ha://` | `ha://api/imgserv/mdi:home?size=tile` | `https://<ha>:<port>/api/imgserv/mdi:home?size=tile` |
| `ha://` | `ha://local/my-icon.png` | `https://<ha>:<port>/local/my-icon.png` |
| `local://` | `local://icons/play.png` | Device-local storage (firmware-bundled or cached) |
| `http://` | `http://example.com/img.png` | Direct HTTP fetch |
| `https://` | `https://example.com/img.png` | Direct HTTPS fetch |
| `data:` | `data:image/png;base64,...` | Inline data URI (passed through) |
| `/path` | `/local/icon.png` | Converted to full HA URL at runtime |

`imgserv://` is the preferred shorthand for the built-in image server.

## Image Server (imgserv)

The integration bundles an on-demand PNG image rendering server at `/api/imgserv/`.
It generates PNG images suitable for pushing to device buttons or title bars.

**Key characteristics:**
- No authentication required (images are public). The one exception is `history:`,
  which only draws entities the integration itself put into a `history:` image
- Responses are cached with `Cache-Control: public, max-age=3600` (1 hour)
- Maximum image dimension: **512×512 pixels**
- Maximum text length: **200 characters**

### URL format

```
http://homeassistant:8123/api/imgserv/<source>:<value>?<params>
```

### How a request is rendered

Every request walks the same four steps, whatever the source type:

1. **Render** — the source draws its subject on a transparent canvas, in `fg`
2. **Crop** — the transparent margin is trimmed (`crop`, on by default)
3. **Mount** — the subject is composited onto `bg`; with `percent`, the lower band stays opaque and the upper remainder is dimmed via alpha, the two joined by a short gradient rather than a hard line. The band holding `percent` % of the glyph's *ink* is what stays opaque, not the bottom `percent` % of the rows
4. **Encode** — the PNG is written, flattened onto black unless `alpha=1`

### Query parameters

Every parameter works with every source type, except `font` and `font_size`
which only mean something for `text:`.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `size` | `tile` (50×50), `title` (200×50), `tooltip` (200×40), `WxH` in pixels, or single integer (square) | `tile` |
| `fg` | Foreground color: hex `RRGGBB` / `RRGGBBAA`, or name (see below) | `white` |
| `color` | Alias for `fg`. If both are given, `fg` wins | — |
| `bg` | Background color mounted behind the subject: same format as `fg` | transparent |
| `mode` | `dark` (white default fg) or `light` (black default fg) — sets the default **foreground only**, never the background | — |
| `crop` | Trim the transparent margin: `1`/`true` or `0`/`false`/`no`. Ignored for `text:` | `1` (enabled) |
| `alpha` | Keep the alpha channel (`1`) instead of flattening onto black (`0`). Use `1` for browser previews, `0` for the device | `0` |
| `percent` | Fill level `0`–`100`: the band holding N % of the icon's ink stays fully opaque; the upper remainder is dimmed via alpha (`70%`), with the boundary feathered across ~8 % of the height so it reads as a level rather than a cut. Measured in ink rather than rows so transparent gaps cost nothing — see **Fill is measured in ink** below. `0` and `100` are uniform, having no boundary | — |
| `font` | Font ID for `text:` source (see [Available Fonts](#available-fonts)) | `filson-light` |
| `font_size` | Font size in pixels for `text:` source | `title` 48, `tooltip` 24, otherwise the image height |
| `hours` | How far back a `history:` graph looks, `1`–`168` | `24` |
| `days` | The same period in days, `1`–`7`. Cannot be combined with `hours` | — |
| `start_time` | Start of an absolute `history:` period, ISO 8601 (`2026-10-10T08:00:00Z`). Without a zone it is read in Home Assistant's time zone | — |
| `end_time` | End of an absolute `history:` period, same format. Given alone, the period is `hours`/`days` long and ends there | now |

A `percent` outside `0`–`100` is answered with `400 Bad Request` before any
rendering work is done.

**Color names:** `white`, `black`, `yellow`, `blue`, `red`, `green`, `inactive`, `transparent`

| Name | Hex value |
|------|-----------|
| `white` | `FFFFFFFF` |
| `black` | `000000FF` |
| `yellow` | `FED430FF` |
| `blue` | `48CBF5FF` |
| `red` | `EA5A5CFF` |
| `green` | `66CAB3FF` |
| `inactive` | `8C8FA6FF` |
| `transparent` | `00000000` |

### Source types

#### `mdi:<icon-name>` — Material Design Icons

Renders any MDI icon from the bundled icon set as a monochrome PNG.

```
imgserv://mdi:home?size=tile&fg=white
imgserv://mdi:lightbulb?size=tile&fg=FFD700
imgserv://mdi:play-circle?size=title&fg=yellow
imgserv://mdi:battery?size=tile&fg=green&percent=40       # 40 % filled
imgserv://mdi:home?size=tile&fg=white&bg=333333&crop=0    # padded dark tile
```

#### `phu:<icon-name>` — Custom Brand Icons (Philips Hue style)

Renders icons from the [custom-brand-icons](https://github.com/elax46/custom-brand-icons)
HACS frontend integration. That set is registered in the browser, like `hue:` or any
other plugin's, so its shapes reach imgserv the same way: the config panel looks each
one up and uploads it, and imgserv draws it from the stored shape. Nothing is read off
disk, so it does not matter where HACS put the JS bundle.

```
imgserv://phu:ceiling-fan?size=tile&fg=white
imgserv://phu:hue-go?size=tile&fg=FFD700
```

> **Note:** A name whose shape has not been uploaded yet returns 404, and is remembered
> as missing so the panel fills it in the next time it opens.

#### `logo:<name>` — Brand logos

Renders bundled brand logos. Two rendering modes:

- **Native colour** — when no `fg`/`color` parameter is specified, the logo is rendered
  with its original colours (PNG preferred, or SVG via `cairosvg` if installed).
- **Monochrome** — when `fg` is specified, the logo SVG paths are rendered in that colour.

`mode` alone does not count as asking for a colour — it only supplies a default
foreground — so a bundled PNG is still served in its own colours.

```
imgserv://logo:hue?size=tile                      # native colours
imgserv://logo:netflix?size=title                 # native colours
imgserv://logo:spotify?size=tile&fg=green         # monochrome green
imgserv://logo:sonos?size=tile&fg=white&alpha=1   # monochrome, transparent
```

**Available logos:** `disney`, `hue`, `knx`, `netflix`, `prime`, `sonos`, `spotify`, `youtube`

> **Tip:** Install `cairosvg` (`pip install cairosvg`) for best native-colour SVG rendering.
> Without it, SVG logos fall back to monochrome when no PNG variant exists.

#### `text:<content>` — Text rendering

Renders text on a canvas as wide as the string needs and as tall as `size` asks.
Supports emoji via the bundled `NotoEmoji-Regular.ttf` fallback font — if the primary
font lacks a glyph, the emoji font is used automatically.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `font` | Font ID (see below) | `filson-light` |
| `font_size` | Size in pixels | `title` 48, `tooltip` 24, otherwise the requested image height |

The height is never trimmed, and `crop` is ignored here on purpose: otherwise
`Hi` and `Hg` would come back different sizes and a row of labels would jitter
as its text changed.

```
imgserv://text:22°C?size=tile&fg=FF8800
imgserv://text:Living%20Room?size=title&fg=white
imgserv://text:Large?size=title&font=filson-light&font_size=28&fg=white
imgserv://text:🎵%20Music?size=title&fg=white
imgserv://text:ON?size=tile&mode=light&bg=FFFFFF     # black on white
```

**Maximum text length:** 200 characters.

##### Available Fonts

| Font ID | File |
|---------|------|
| `filson` / `filson-light` | FilsonSoft-Light.otf (default) |

Only Filson Soft Light is bundled; the other fonts are not redistributable. Your own
fonts (`.ttf`, `.otf`, `.ttc`) go into `/config/lizaip/fonts/` — a folder in your Home
Assistant configuration, so an update of the integration leaves them alone. A font's
ID is its file name without the extension, in lower case: `/config/lizaip/fonts/Inter-Bold.ttf`
is `inter-bold`. A user font with the same ID as a bundled one is ignored.

**Emoji are optional.** `NotoColorEmoji.ttf` (colour) and `NotoEmoji-Regular.ttf`
(monochrome, tintable) are *not* in the release archive — they are 12 MB and not ours
to redistribute. Without them, `render_text` looks for a system NotoEmoji under
`/usr/share/fonts/`, and failing that draws emoji from the primary font, which
normally means a missing-glyph box. To get colour emoji back, download
`NotoColorEmoji.ttf` and drop it into `/config/lizaip/fonts/` (survives updates; the
settings tab says so too) or into `imgserv/fonts/`; the monochrome font is only read
from `imgserv/fonts/`. Either is picked up on the next render, no restart needed. A
HACS install copies the repository directly and does include them.

Font lookup tries the exact ID first (bundled fonts, then your own), then a
case-insensitive fuzzy match over the bundled fonts (hyphens, underscores, spaces are
interchangeable). If the requested font is not found, the default font (Filson Soft
Light) is used; DejaVu Sans Bold is only the last resort when even that is missing.

#### `file:<filename>` — Static files

Serves and resizes a static image from Home Assistant's `/config/www/` directory.

```
imgserv://file:image.png?size=tile
imgserv://file:icons/custom-logo.png?size=title
imgserv://file:icons/custom-logo.png?size=tile&alpha=1&crop=0
```

> **Security:** Path traversal is blocked — only files under `/config/www/` are accessible.

#### `media:<url-or-ha-path>` — Media thumbnails

Proxies and resizes any image HA can reach — album art from `/api/media_player_proxy/`,
files in `/local/`, or artwork on an external CDN. The value is either the **path**
portion of an HA-internal URL (starting with `/`) or a full `http(s)://` URL.

Percent-encode the value into a single path segment so any query string it carries does
not collide with imgserv's own options:

```
imgserv://media:%2Fapi%2Fmedia_player_proxy%2Fmedia_player.living_room?size=tile
imgserv://media:%2Flocal%2Fcover-art.jpg?size=title
imgserv://media:https%3A%2F%2Fcdn.example%2Fart.jpg%3Ftoken%3Dabc?size=tile
```

External `http(s)://` icons are rewritten to this form automatically during device sync,
so the device never fetches third-party hosts itself. Values without a query string may
still be written unencoded — existing configs keep working.

HA fetches the image using its own internal session (authentication is handled
automatically), resizes it to the requested `size`, and returns a PNG.

**Notes:**
- If the media player is idle or the proxy returns a non-200 response, imgserv responds
  with `502 Bad Gateway`.
- Responses are cached for 1 hour like all other imgserv responses. Append a version
  query parameter on the imgserv URL (e.g. `&_v=2`) to bypass the cache when artwork
  changes.

#### `history:<entity_id>` — A graph of an entity's history

Draws the entity's recorded states over a period from the recorder — the last `hours`
(default 24) or `days`, or the absolute period `start_time`/`end_time` name:
a numeric entity as a line with a faint fill, scaled to its own minimum and maximum; any
other entity as a band that is bright while it was `on`, `open`, `home` or `playing`.
`unknown` and `unavailable` stretches stay empty. The line or band is drawn in `fg`.
Not croppable: trimming would stretch the time axis.

```
imgserv://history:sensor.outdoor_temperature?size=tile
imgserv://history:sensor.outdoor_temperature?hours=6&size=title&fg=FF8800
imgserv://history:binary_sensor.front_door?hours=12&size=tooltip
imgserv://history:sensor.house_power?days=7&size=title
imgserv://history:sensor.house_power?start_time=2026-10-10T08:00:00Z&end_time=2026-10-10T20:00:00Z
```

- **The period**: `hours` and `days` spell the same thing, so asking for both is a `400`.
  `start_time` alone runs up to now, `end_time` alone ends a `hours`/`days`-long period
  there, and either way the period may not exceed 168 hours. An absolute period stands
  still, while the default one moves with every refresh.

- **Access** (`shared/history.py`): imgserv needs no login, so it graphs only entities
  for which `versioned_history_image` built a `history:` image — a remote's page payload
  or the panel's preview (`lizaip_config/resolve_variables`). Anything else gets `403`.
  The set is in memory; the first sync after a restart fills it again.
- **Refresh**: `versioned_history_image` adds `v=<last_changed>` to the value, and the
  variable listener counts the entity as a state read (`variables._token_reads`). A state
  change therefore moves the URL and goes to the remote through the variable push, at the
  remote's variables interval.
- **Errors**: `400` for a bad period, `503` when the recorder is not running.

## Config Panel

The integration provides a sidebar panel (**lizaIP Config**) for configuring button
assignments, pages, and the Action Library.

### Action Library

Actions are defined once in a shared library and referenced by buttons. Each action has:
- **ID** — unique identifier
- **Name** — display name
- **Icon** — MDI icon or image URL (rendered on the physical button)
- **Action config** — HA script action sequence (e.g. toggle a light, call a service)
- **State rules** — map entity states/attributes to icons for live updates

### State-based icon tracking

When an action has state rules defined, the integration watches the corresponding HA
entities. When their state changes, the device button icon is updated in real time:

1. Define state rules in an action (e.g. `light.living_room` → state `on` → icon `mdi:lightbulb`)
2. Assign the action to a button
3. When `light.living_room` turns on/off, the button icon updates automatically

State changes are debounced (500 ms) and deduplicated to avoid unnecessary device updates.

### Entity variables

Button tooltips (`label`), button images (`image`, including context overrides) and
page titles (`image` of a page) accept `${domain.object_id}` and
`${domain.object_id.attribute}`. User documentation with examples, including a template
helper for battery icons: [README.public.md → Live values on the remote](../../README.public.md#live-values-on-the-remote).

- **Value** (`const.entity_token_value`): the state rounded to the entity registry's
  `options.sensor.display_precision` (else `suggested_display_precision`) plus
  `unit_of_measurement`; an attribute as stored (lists joined with `, `, booleans
  `on`/`off`, whole floats without `.0`). `unknown`, `unavailable` or a missing entity
  yields `""`, and the token collapses together with a dangling separator.
- **Tooltips**: `substitute_label_tokens(text, values, hass)` fills entity tokens before
  `${_state}`/`${_name}`, in both the sync ladder (`button_rendering`) and the live ladder
  (`action_controller/icons.py`). `${_state}`/`${_name}` never match the entity pattern
  (no dot), and a label of only an entity token counts as the user's own words.
- **Pictures in tooltips** (`tokens.finish_tooltip`): a tooltip that names a picture
  (`is_media_source`) is resolved by `resolve_image_tokens`, like an image or a title, in
  both ladders; `substitute_label_tokens` only fills `${_state}`/`${_name}` in it and
  `clean_label_text` leaves it alone.
- **Images and titles** (`button_rendering.with_resolved_image`): all or nothing — if
  any token is empty the image is dropped and the derived icon is used (a title is
  blank). The unit is only added when the image is drawn text (`text:` or no scheme
  before the token).
- **Live updates** (`config/variables.py`): watches every entity named in a label, image
  or page title, refreshes that set on `CONFIG_CHANGED_EVENT`, and on a state change
  runs `sync_config_to_device` at most every 2 s. The value is part of the page payload
  and therefore of the page hash, so only pages whose output changed are resent.
- **Panel**: `_entityTokenValue`, `_substituteEntityTokens`, `_resolveImageVariables`
  and `_pageTitleImage` in `liza-remote-helpers.js` mirror the Python, reading
  `hass.states` and `hass.entities[…].display_precision`.

### Pages

The device supports multiple pages of buttons. Pages are managed via the config panel:
- Every page is equal — the first one holds no special status and can be renamed, reordered or deleted like any other
- A new page is posted without an ID and the backend mints one: `generate_page_id` returns `max(existing) + 1`. IDs are sequential, not gap-filling — a hole in the middle is never backfilled, but deleting the highest page frees its ID for the next add. The protocol's range is `1…4294967295` (0 is reserved, see `PROTOCOL.md` §3); the generator enforces the lower bound but not the upper one, so an overflow is only reachable by hand-editing a page file, and `is_valid_page_id` catches it during sync
- Pages are synced to the device using hash-based diffing (unchanged pages are skipped)

### Settings (gear tab)

The gear icon at the right end of the panel's tabs opens the settings of the selected
remote: the **font** and **font size** of page **titles** and of **tooltips**. The font
list holds the bundled fonts and your own from `/config/lizaip/fonts/`; the size is
limited to what fits the image (titles 6–50 px, tooltips 6–40 px). A preview shows the
result, and **Restore fonts** (right below the font hint) goes back to Filson Soft Light at 48 px (titles) and
24 px (tooltips).

The **Icon options** card holds the two [icon tint and fill](#icon-tint-and-fill)
switches and the fill step (1–25 %, default 5 %). The switches both start off, so
neither the tint nor the fill appears until asked for. All three are stored
in the integration entry's options rather than in `settings.yaml`, and a change resyncs
the remote. **Restore fonts** leaves them alone.

A change is saved at once to `/config/lizaip/<device_id>/settings.yaml` and pushed to
the remote:

```yaml
title:
  font: filsonsoft-light
  font_size: 48
tooltip:
  font: filsonsoft-light
  font_size: 24
```

The remote caches images by URL, so the style is part of the title and tooltip URLs
(`&font_size=…`, plus `&font=…` when it differs from the default); a change therefore
re-sends the affected pages once. On default settings the URLs are the same as before
the setting existed. A title that names its own `font=` or `font_size=` keeps it. A font
that is later removed stays the setting (shown as *not installed*) and is drawn in the
default font until it is back. Edits made to `settings.yaml` by hand take effect after a
restart.

### Config Panel WebSocket API

The frontend panel communicates with HA via these WebSocket commands (admin-only):

| Command | Description |
|---------|-------------|
| `lizaip_config/list_devices` | List all configured lizaIP devices |
| `lizaip_config/get_blueprint` | Get the button layout blueprint for a device's model (default when no `entry_id`) |
| `lizaip_config/get_actions` | Get the action library for a device |
| `lizaip_config/save_actions` | Save the action library |
| `lizaip_config/get_assignments` | Get button→action assignments for a page |
| `lizaip_config/get_all_assignments` | Get every page's assignments in one call (keyed by page id as a string) |
| `lizaip_config/save_assignments` | Save assignments and push to device |
| `lizaip_config/get_pages` | Get the pages list |
| `lizaip_config/set_pages` | Replace the pages list |
| `lizaip_config/update_page` | Update a page's title image and/or default colour |
| `lizaip_config/get_settings` | Get a device's title/tooltip text settings, with the defaults, the installed fonts and the size limits |
| `lizaip_config/set_settings` | Validate and save the text settings and push them to the device |
| `lizaip_config/sync_custom_icons` | Report the browser's extra icon sets (`window.customIcons`); answers the names the remote asked for that imgserv has no shape for yet |
| `lizaip_config/store_custom_icons` | Upload icon shapes from those sets (`getIcon()`), which imgserv then draws |
| `lizaip_config/get_action_labels` | Translated action wordings for a device's language |

## Localization

**Every user-facing string belongs in `strings.json`.** This follows Home
Assistant's [custom integration
localization](https://developers.home-assistant.io/docs/internationalization/custom_integration):
`strings.json` is the English source, and `translations/<lang>.json` is what HA
loads at runtime.

To add a string:

1. Add the key to `strings.json`.
2. Run `python3 scripts/sync_translations.py --fix` to propagate it to every
   `translations/<lang>.json`, backfilling English where no translation exists.
3. Read it at runtime — never inline the text in Python or JavaScript.

`tests/test_translations.py` enforces this: key parity across languages,
matching `{placeholders}`, and a grep that fails if a translated wording is
pasted back into the panel sources.

### Button action labels

The words a button prints for what a press *does* ("Mute", "Repeat all") live
under the `action_labels` key. Both halves of the app read the same file:

- **Python** — `shared.i18n.action_labels.get(key, lang)` reads
  `translations/<lang>.json` directly. This is what the physical remote renders.
- **Panel JS** — fetches `lizaip_config/get_action_labels` at startup and on
  every device switch. It holds no table of its own, so the panel and the
  device cannot disagree.

Shipped languages: **English, German, French, Italian**. Missing keys fall back
to English, then to a title-cased key, so a gap is readable rather than blank.

> The German and Italian wordings for the attribute actions
> (shuffle/oscillate/repeat) are this project's own — Home Assistant has no
> upstream translation for them to defer to — and want a native-speaker review
> before anyone calls them final. French has no attribute wordings at all yet
> and falls back to English.

These are deliberately *not* taken from HA's `state_translated` /
`hass.localize`. Those name a **state** ("Playing"); these name the **action** a
press performs ("Repeat all"), and HA has no translation at all for `unmute`,
`shuffle_on`, `oscillate_*` or `repeat_*` as actions. Two wordings also diverge
from HA on purpose — see the comments in `shared/i18n.py`.

### Per-device language

Which of those four languages a remote prints is a **per-device option**, set
the same way as optimistic updates:

**Settings → Devices & Services → lizaIP → (device) → Configure → Device language**

| Value | Meaning |
|-------|---------|
| `Automatic` (default) | Follow the config panel's language, then Home Assistant's, then English. This is what every device did before the option existed. |
| `English` / `Deutsch` / `Français` / `Italiano` | Pin this remote to that language, whatever the browser or Home Assistant is set to. |

Per device and not global because the language belongs to the *hardware*: a
household can have a remote in the kitchen labelled in Italian and one in the
study in English, and the browser the panel happens to be open in says nothing
about either.

Changing it re-pushes the page immediately — the entry's update listener calls
`sync_config_to_device`, so the remote relabels without a restart. A device
that is offline at that moment picks the new wording up on its next sync.

Three places build a button label and all three read the option from the same
config entry, or the label would change under the user: `button_rendering` (at
save time), `action_controller/icons` (on the next state change) and
`action_controller/buttons` (the optimistic update on press).

## Light colour on button icons

A button bound to a colour-capable light renders its tile icon in the light's own
colour, the way Home Assistant tints a light's icon on a tile card. A red lamp and
a blue lamp no longer look identical on the remote.

`state_color.py` is a port of HA's `hui-tile-card._computeStateColor`:

```
rgb2hsv(rgb_color)          # h 0-360, s 0-1, v 0-255
if s < 0.1:   v = 225       # near-white: dim it instead of inventing a hue
elif s < 0.4: s = 0.4       # washed out: boost so it stays legible
hsv2rgb(...) -> hex         # handed to imgserv as ?fg=
```

...with one exemption: a light reporting `color_mode: color_temp` skips both
rules and is handed on exactly as HA computed it.

Those two rules are HA's, and right in HA — a dashboard can be on a light theme,
where a pale 5000 K white on white is invisible. This display is not that:
`imgserv` flattens every tile onto `FLATTEN_COLOR`, black, so a near-white tint
already reads, and the contrast they buy is contrast already had.

Applied to a tunable-white lamp they are actively destructive. The blackbody
line HA walks for `color_temp_kelvin` has a near-constant hue, so *saturation is
the only thing* separating 2700 K from 5000 K — and `s = 0.4` erases exactly
that. Measured over 2000-6500 K in 250 K steps, before the exemption:

| | distinct tints | worst collision |
| --- | --- | --- |
| with the clamps | 12 / 19 | 3750-5500 K, eight steps, all `FFC898` |
| exempt | 18 / 19 | one pair, 6000/6250 K |

So a 1750 K band across the most-used part of the range drew one identical tile
— dragging the temperature slider moved the icon not at all — and then the
near-white rule discarded the hue and snapped 5750 K upwards to grey. The one
surviving collision is the channel quantiser (`_QUANTIZE_STEP`, 8) merging two
RGBs that differ by less than a step, which is the URL-cache budget working as
intended rather than a rule eating the signal.

The exemption is deliberately narrow: an `rgb`/`hs`/`xy` light keeps HA's
behaviour unchanged, so the divergence is confined to the case that needs it.
`tests/parity_cases.json#icon_tint` carries cases on both sides of the gate.

The colour reaches the hardware as a normal `img_tile` URL — there is no new
protocol surface. Two producers build it and must agree, or a tile would visibly
change colour a second after the page loads:

* `page_payload._button_icon_style` — the full page sync.
* `action_controller/state_listener` — the live update, pushed as a partial
  `set_page` when the light changes. The state tracker fires on attribute
  changes too, so a colour change alone is enough.

Both resolve the colour from the button's *whole* target via
`state_icon.icon_style_for_entities`, never from the entity that happened to
change. A button bound to an area has several lights, and any of them firing
wakes it: the listener once tinted from that one lamp, so an off member
repainted the tile to the page colour while a lit member was still on, and with
two members dirty in one flush the winner came down to set-iteration order.

That resolver also returns the brightness fill alongside the tint, so both
facets come off the *same* member. Read facet-by-facet they could disagree — a
lit but colourless bulb supplying the level while a second, coloured lamp
supplied the tint, drawing a tile neither lamp was showing.

#### How smoothly the fill tracks the lamp

Two numbers and a gradient, all three there for the same reason — a fill that
snaps between a handful of poses reads as a status light, not as a level:

* **`state_brightness._QUANTIZE_STEP` (2)** is a pixel budget, not a round
  number. Every tile is 50 px (`SIZE_IDS`), so there is a hard ceiling on how
  many *distinguishable* fills the renderer can produce, and the step was picked
  to sit exactly on it. Running each candidate through `apply_percent_tint` and
  comparing the resulting alpha columns:

  | step | levels | distinct renders | adjacent levels that differ |
  | ---: | -----: | ---------------: | --------------------------: |
  |   10 |     10 |               10 |                      9 of 9 |
  |    5 |     20 |               20 |                    19 of 19 |
  |    2 |     50 |               50 |                    49 of 49 |
  |    1 |    100 |           **51** |                **50 of 99** |

  2 saturates the renderer — every level is its own picture. 1 adds fifty more
  levels and *one* more picture: half of its levels are byte-identical to their
  neighbour, so they are cache entries and `set_page` traffic buying a
  difference nobody can see. That cost is real, because the value goes into the
  image URL and one lamp can own a button on three pages.

  The old step of 20 used five of the available positions, jumping a fifth of
  the glyph at a time; 10 moved it ~4.8 px at a time, and that quantum was what
  remained of the "steppiness". Note none of this is a *frame-rate* choice —
  `_STATE_MAX_WAIT_SECONDS` below caps pushes at ~5/sec whatever the step is.
  What a finer step buys is that each of those frames lands on the value the
  finger is at rather than on the nearest multiple of 10.
  `tests/test_render.py::test_every_level_the_quantiser_can_emit_is_its_own_picture`
  asserts the table against the live constant, so tightening the step without
  re-measuring fails rather than shipping silently.

  The 5 above is only the *default*, and it is deliberately coarser than the
  table's ceiling of 2: the table says what the renderer can draw, not what the
  *device* can afford to fetch. A percent it has not cached costs it an image
  fetch before it can paint — p50 ~220 ms against ~58 ms cached — so 20 levels
  warm the cache 2.5× sooner than 50 while still rendering distinctly.
  **Gear tab → Icon options → Fill step** (WS `lizaip_config/set_icon_options`,
  stored in `entry.options`; it used to be an options-flow section)
  overrides it per entry, anywhere from 1 to 25. The table says what the
  renderer can draw; it cannot say what a given install should pay for, and the
  two considerations pull apart on a layout that repeats one lamp across many
  pages, where each extra level multiplies into that many more `set_page`
  pushes and cached images. Reading it is `state_brightness.read_fill_step`,
  which is deliberately unshockable — options outlive the version that wrote
  them and can be hand-edited in `.storage`, and this runs inside a state
  callback, so a value it could not parse would take down the flush for every
  button on the page rather than mis-draw one. Anything unusable falls back to
  the default and anything out of range is clamped.

  Three places build a tile's style — the page push (`config/page_payload.py`),
  the live state listener, and the button entity — and all three resolve the
  step from the same entry options. They have to: they render into the same
  image URL, so one of them still assuming the default would keep re-pushing
  its own answer and the icon would oscillate between two fills instead of
  settling. `tests/test_state_icon.py::TestTheFillStepIsConfigurable` pins each
  path separately for that reason.

  The panel is the fourth renderer and the awkward one, because it draws its
  own preview rather than fetching the device's images. It learns the step over
  `lizaip_config/get_icon_options`, which is entry-scoped — unlike
  `get_features`, which answers for the whole build — and it asks per entry,
  alongside the pages, since two remotes can hold different steps and the panel
  switches between them without reloading. If the call fails it stays on the
  default, which is right for every entry that has not changed the setting.
  `tests/parity_cases.json` carries `icon_fill` cases at steps 1, 10 and 25 as
  well as the default, so the two quantisers are pinned against each other
  across the configurable range rather than only where they started.
* **`imgserv.const.PERCENT_FEATHER_FRACTION` (0.08)** ramps the alpha across the
  boundary instead of switching it. A hard switch drew a horizontal rule as
  prominent as the fill it described, and the ramp also hides what is left of
  the quantisation: adjacent levels overlap, so the fill appears to slide. The
  ramp is anchored to *end* at the boundary, so the filled band is never shaved
  — the filled band is fully opaque either way. `0` and `100` keep a hard
  edge, having no interior boundary to soften.
* **Fill is measured in ink, not in rows** (`render._ink_boundary_row`). Splitting
  the tile geometrically assumes the glyph is spread evenly down it, and icons
  are not drawn that way. `mdi:lightbulb-off` is the worst case: its bottom fifth
  is the detached screw base, then a transparent gap, then the body. Filling by
  row, low levels spent their whole budget on the base and the gap — the tile
  read as a lit indicator rather than a low level — and the levels whose boundary
  landed *in* the gap drew the identical picture, so the dimmer moved and the
  icon did not. Measured on the real glyph, consecutive 5 % levels changed the
  lit area by anywhere from 0.2 to 3.1 percentage points, and the top three
  levels were indistinguishable. Measuring in ink makes every step light the same
  amount of glyph (1.2–2.1 points on the same icon, no stalled levels), and costs
  nothing on an evenly-inked tile, where the two rules agree exactly. The boundary
  is deliberately *fractional*: snapping it to a whole row would trade the old
  dead zone for a new one, since an ink-dense row would otherwise absorb a wide
  range of percentages into one identical picture.
* **`_STATE_MAX_WAIT_SECONDS` (0.2)** caps how long a change may wait while more
  keep arriving. The debounce beside it is *trailing*: each event cancels the
  pending flush and restarts the wait. A burst with an end settles fine, but a
  dimmer being held has no end, so the deadline receded on every frame and the
  icon froze at whatever it showed when the ramp started, snapping to the final
  value only once the user let go. The listener now also fires the *leading*
  edge — the first change after a quiet spell goes out at once rather than
  serving a debounce first, which is what makes switching a lamp on feel
  immediate. `last_sent` still drops any flush that would change nothing.

`action_controller/buttons` is the third, evaluating the tint against the
*predicted* state so a press that turns a lamp off does not briefly paint the off
icon in the colour the lamp is about to stop showing. A press on "turn on" is left
alone: it cannot predict the colour of a lamp that is still off, and the state
listener corrects the tile a moment later anyway.

#### Why the fill does not wait for the lamp

Even with all of the above, the fill lagged the user's finger by about a second.
None of it was our latency. Measured on real hardware:

| Stage | Cadence |
| --- | --- |
| Slider touch events from the remote | ~20–60 ms |
| `slider_throttle` outbound cap | 250 ms (`DEFAULT_SLIDER_MIN_INTERVAL_MS`) |
| Hue bridge → `EVENT_STATE_CHANGED` | **~1 s** (7 commands came back as 3 events) |
| Our push once the state lands | 0 ms on the leading edge |

The bottleneck is the third row, and it is not a polling problem — the bridge is
API v2, so the events arrive over SSE and it is *coalescing* rather than lagging.
Home Assistant's own Hue integration never fills that gap: `async_turn_on` awaits
the bridge PUT and returns, and `brightness` is read live from the resource,
updated only by the event stream. The value we just commanded is nowhere.

So `optimistic.py` keeps it. `slider_exec` already computes the exact target
brightness in order to send it, a quarter-second to a second before the lamp says
so; the tile is drawn from that until the lamp catches up. This is the pattern HA
uses wherever it has no fast authoritative answer — `light.template`,
`light.mqtt` and `demo` all set the attribute they just commanded and write state
immediately. The fill now moves at slider cadence rather than lamp cadence.

**The prediction is published ahead of the throttle, not alongside the command.**
That distinction is the whole point and it was missed at first. Row two of the
table caps `light.turn_on` at one call per 250 ms, because the bridge coalesces
a faster stream away — but nothing about that constraint applies to a local dict
write and a local event. Predicting inside `_Mechanics.write` meant the icon
inherited the command cadence: four updates a second, aliased against a 5/sec
flush, so the tile could be a whole throttle window *plus* a flush window behind
the finger. `_do_slide` now predicts on every touch event and lets the service
call stay thinned, which bounds the lag at the flush window alone. The
prediction is still skipped when the position has not actually moved, so a
device restating a held position cannot keep refreshing the TTL of an overlay
the lamp has already matched.

**The throttle thins by position; a second guard thins by value.** `has_moved`
asks whether the *finger* moved, but `value_at` clamps to the range. Inside a
clamped region — the finger below the bottom or above the top — every distinct
position yields an identical value, passes the movement check, and was written
once per interval for the whole gesture. On a light that is the worst case
there is: Home Assistant routes `brightness: 0` to `async_handle_light_off_service`,
so dragging down on an already-off lamp spent the gesture telling the bridge to
turn off a lamp that was already off. `_write` now skips the call when the
payload would repeat the last one, compared on the *rounded* value because that
is what reaches the service. It is recorded after the await, mirroring
`last_pos`: a failed call must not be remembered as sent, or the retry would be
deduped away.

Three rules keep it honest:

* **Brightness only.** A drag cannot change a lamp's colour, and guessing at
anything else would be inventing state we were never told.
* **`PREDICTION_TTL_SECONDS` (2.0).** A prediction the lamp never confirms —
because it clamped the value, was unreachable, or the command was lost — must
not outlive the moment it was plausible, or the tile lies until the next
gesture. The gesture keeps refreshing it, so this is only ever the tail after
the finger lifts.

#### Why only one icon update is in flight at a time

Everything above decides *what* the tile should show. This decides how it gets
there, and it was the larger share of the lag.

The device acknowledges a `set_page`, but the integration used to start the next
one on a timer regardless of whether the previous had come back. That is
open-loop: it assumes a service rate instead of observing one. Measured over a
dimmer ramp on real hardware, 22.5 % of the time two or more requests were
outstanding, peaking four deep, and the wait showed up exactly where you would
expect — p90 408 ms, p99 993 ms, worst case 1567 ms, against a device that
answers a single request in 51–111 ms. Those were not a slow device; they were
requests queued behind other requests.

So the push is now closed-loop (`config/icon_push.py`): one request in flight
per device, and anything arriving meanwhile is *merged into* the pending set
rather than queued behind it. The device's own acknowledgement becomes the
clock, so the push rate tracks whatever the hardware can absorb — quicker than a
fixed timer when it is idle, and automatically backing off when it is not,
instead of making a bad moment worse. Re-measured after the change, over a
168-step ramp: never more than one request outstanding, and the median
round-trip roughly halved, 111 ms → 60 ms.

Three details carry the design:

* **Coalescing merges per button, it does not replace.** A newer frame usually
carries only `img_tile`, because the state listener omits a tooltip that has not
changed to save the device a second image fetch — while still recording it as
sent. Replacing wholesale would discard a tooltip that could then never be
offered again, so newer keys win and older keys survive.
* **Dropping superseded frames is the point, not a concession.** A ramp's
intermediate values are stale the moment a newer one exists. The *final* value
is never dropped: a page is removed from the pending set immediately before it
is sent, so anything submitted mid-flight is still waiting afterwards.
* **The visible page goes first.** One lamp commonly owns a button on several
pages, and the sends are serialised, so the tile you are actually looking at
would otherwise wait a full round-trip behind a page nobody can see.

What remains is the device. With nothing queued inside the integration, the
occasional 1–2 s acknowledgement has no log activity between send and reply at
all — it is firmware or Wi-Fi, not something this code can schedule around.
That is also why the listener's flush cap was left alone; see
`_STATE_MAX_WAIT_SECONDS`, which records the arithmetic.

* **Settle on agreement, not on any update.** The prediction stands down when the
lamp lands within `_SETTLE_TOLERANCE` of it, so a report from *mid-ramp* does not
yank the tile back down. Exact equality would not do: Hue stores brightness as a
percentage and converts both ways, so a commanded 200 comes back as 199 or 201
and the prediction would be held to its full TTL on every drag. The tolerance is
sized against *that* round-trip error (~2 % of full scale) rather than against
the icon's quantise step — the step is a rendering choice and has already moved
twice, while the bridge's rounding has not. A lamp reporting `off` cancels
outright.

* **Zero is the one brightness that is not "on".** The prediction reports `off`
for a commanded brightness of 0 rather than a 0 % fill. Home Assistant coerces
the service value to an int, so anything under 1 reaches the lamp as 0, and
`light.turn_on` with 0 switches it off — measured on hardware. Forcing `on`
regardless used to light a tile for a dark lamp, and dragging *down* on an
already-off lamp had no safety net: the state never changes, so no event ever
arrives for the settle path to retire the prediction on, and the fill floors at
one whole step rather than 0 %. The result was a dimmed bulb with its base lit
for the entire gesture plus the TTL. The same rule pays off in the other
direction, too — a lit lamp dragged to the bottom now reads as off at once
instead of waiting on the bridge.

### The config panel previews the same colour

The panel's button previews are tinted too, so the preview matches the tile the
device is actually drawing — for a button bound to a single entity. A button
targeting an area or a device previews in the page colour, because the panel
resolves a step's entity from the config alone and has no area registry to
expand; the device still tints those correctly. The panel cannot call
`state_color.py`, so
`liza-remote-helpers._entityIconColor` is a second implementation of the same
algorithm — including Python's banker's rounding in the quantiser, which
`Math.round` does not share.

Two implementations of one rule is exactly the drift this repo has been bitten by
before, so it is pinned rather than trusted: `tests/parity_cases.json#icon_tint`
holds the vectors, and `tests/test_parity.py` and `tests/js/parity.test.mjs`
assert them against their own side. Change the rule in one language and only that
side goes red, naming the case that moved.

### A group is drawn in its own colour, like HA draws it

A light *group* — a Hue room or zone, or HA's own light-group helper — is treated
as an ordinary light: it is drawn in the `rgb_color` it reports itself, which is
the value HA's tile card uses. So the room's button and the room's dashboard tile
always agree, even when they disagree with a lamp inside the room.

They can disagree. Hue derives a room's colour by majority vote among the lamps
that are *on* (`hue/v2/group.py::_update_values`), so an Office whose only
reachable lamp is green can still report 3312 K warm white, because two lamps the
bridge believes are on — but which HA shows `unavailable` — outvote it. The
dashboard shows warm white there, and so does the remote.

## Diagnostics

Download device diagnostics via **Settings → Devices & Services → lizaIP → (device) → ⋮ → Download diagnostics**.

The diagnostics export includes:

```json
{
  "entry": {
    "entry_id": "...",
    "title": "lizaIP",
    "unique_id": "lizaIP",
    "version": 1,
    "data": { "sw_version": "1.2.3" }
  },
  "device": {
    "connected": true,
    "protocol_version": 1,
    "device_version": "1.2.3",
    "device_mac": "AA:BB:CC:DD:EE:FF"
  },
  "capabilities": { ... }
}
```

## Examples

### Toggle a light on button press

```yaml
automation:
  - alias: "lizaIP Button 1 toggles living room light"
    trigger:
      - platform: state
        entity_id: event.lizaip_button_1
        attribute: event_type
        to: "click"
    action:
      - service: light.toggle
        target:
          entity_id: light.living_room
```

### React to slider position

```yaml
automation:
  - alias: "lizaIP slider sets media volume"
    trigger:
      - platform: state
        entity_id: number.lizaip_slider_volume
    action:
      - service: media_player.volume_set
        target:
          entity_id: media_player.living_room
        data:
          volume_level: "{{ states('number.lizaip_slider_volume') | float / 100 }}"
```

### Send a custom image to a button

```yaml
service: lizaip.send_image
data:
  image_url: "imgserv://mdi:lightbulb?size=tile&fg=FFD700"
  target_device: "<device_id>"
  target_button: "button_3"
```

### Dynamic icon based on entity state

```yaml
# In the Action Library, define an action with state rules:
# - entity: light.living_room
# - state "on"  → icon: imgserv://mdi:lightbulb?size=tile&fg=FFD700
# - state "off" → icon: imgserv://mdi:lightbulb-off?size=tile&fg=inactive
# Assign to a button — the icon updates automatically.
```

### Dark mode rendering

```yaml
# Use mode=dark for white-on-transparent icons (default dark theme)
service: lizaip.send_image
data:
  image_url: "imgserv://mdi:home?size=tile&mode=dark"
  target_device: "<device_id>"
  target_button: "button_1"

# Use mode=light for black-on-transparent icons (light theme)
service: lizaip.send_image
data:
  image_url: "imgserv://mdi:home?size=tile&mode=light"
  target_device: "<device_id>"
  target_button: "button_2"
```

## Known limitations

- **No slider-set command** — Protocol v1 does not support setting a slider value from HA
  to the device. Sliders are device→HA direction only.
- **Single connection per device** — Each device maintains one WebSocket. A second connection
  attempt is rejected while the existing one is still alive (detected via WebSocket heartbeat);
  it only takes over once the previous connection has actually gone stale.
- **No device→HA authentication** — HA's WebSocket endpoint trusts a connecting client based on
  `device_id` and local network reachability; there is no bearer token or credential check on
  incoming device connections in this protocol version (see `Document/PROTOCOL.md` § Transport
  Security).
- **Certificate pinning only applies when HA terminates its own TLS** — during provisioning HA
  pushes its certificate (`wss_cert`) so the device can pin HA's identity, but only if HA's
  `http` integration has `ssl_certificate` configured directly. If HA sits behind a reverse
  proxy, Nabu Casa Cloud, or a Docker/ingress layer that terminates TLS in front of it, HA has
  no certificate of its own to hand out — the device falls back to a plain, unencrypted `ws://`
  connection in that case rather than failing to connect.
- **Discovery only** — Devices cannot be added manually; they must advertise via mDNS or
  connect to the WebSocket endpoint.
- **No offline buffering** — Commands sent while the device is disconnected will fail
  immediately.
- **Browser icon sets need the panel opened once** — `phu:`, `hue:` and the like exist
  only in the browser, so their shapes reach imgserv through the config panel. A name
  nobody has saved or synced yet renders as 404 until the panel next opens.
- **cairosvg optional** — Native-colour SVG logo rendering requires `cairosvg`. Without it,
  SVG logos fall back to monochrome rendering.
- **Bundled logo assets are not uniformly pre-cropped** — Several files under
  `custom_components/lizaip/imgserv/logos/` still contain transparent padding in the source
  image. Runtime `crop=1` trims the response, but the asset set itself is not yet normalized.
  Backlog item: autocrop all bundled logos in `imgserv/logos/*` so PNG/SVG variants start from
  equally tight source bounds.
- **Android TV hides its own on-screen keyboard by default** — While the `androidtv_remote`
  integration's *Enable IME* option is on (its default), Home Assistant registers itself with
  the TV as an input method, and the TV replaces its on-screen keyboard with
  *"Use keyboard on mobile device screen"*. A lizaIP remote has only a D-pad, so text fields
  cannot be filled in at all. This is a setting of that integration, not of lizaIP, and lizaIP
  deliberately does not change it — see *Android TV shows "Use keyboard on mobile device
  screen"* under Troubleshooting.
- **Android TV apps cannot be launched by application ID** — `androidtv_remote` sends a bare
  package name to the TV as `market://launch?id=<package>`, which the Play Store resolves. A
  Play Store update (~v52.x, mid-August 2026) stopped honouring those requests, so app buttons
  built from an application ID silently do nothing. Neither Home Assistant nor lizaIP can work
  around it: the remote protocol's launch message carries a URI, never a package name. Use the
  app's deep link instead (e.g. `https://on.orf.at/` for ORF ON) — the shipped Android TV
  layout already does. Note that the app picker still offers package names, because it lists
  the apps configured on the Android TV Remote entry itself; putting the deep link in that
  entry's *Application ID* field fixes the picker and every button made from it at once.

## Troubleshooting

### Device not discovered

1. Ensure the device and HA are on the same network/VLAN.
2. Check that mDNS/Bonjour is not blocked by your router.
3. Look for `_lizaip._tcp` in the HA zeroconf logs:
   **Settings → System → Logs** → filter for `lizaip`.

### Device shows as unavailable

The device has disconnected from the WebSocket. Common causes:
- Device powered off or out of range
- Network interruption
- Device firmware crash — power-cycle the device

The device will automatically reconnect and re-provision when it comes back online.

### Actions fail with "not connected"

The target device is currently offline. Wait for it to reconnect or check the device's
power/network status.

### Image returns 404

- **MDI:** Check the icon name at [materialdesignicons.com](https://materialdesignicons.com)
- **PHU and other browser sets:** Ensure the set's HACS frontend plugin is installed, then
  open the lizaIP config panel once so it uploads the shapes
- **Logo:** Check spelling against the available list above
- **File:** Ensure the file exists under `/config/www/` (not `/config/`)
- **Media:** A `404` from the upstream `media_player_proxy` (e.g. no artwork available) is forwarded as `502`; check that the media player entity is playing and has a `media_content_id`

### Android TV shows "Use keyboard on mobile device screen"

The TV is hiding its own on-screen keyboard because Home Assistant is announcing itself as a
keyboard. Turn that off:

**Settings → Devices & Services → Android TV Remote → (device) → Configure** → uncheck
**Enable IME** → **Submit**

The TV then behaves as it does with its normal remote and shows its built-in keyboard, which
the lizaIP D-pad can drive.

Two things change with the option off:

- Home Assistant can no longer type into the TV (`remote.send_command` with text, and the
  Assist/text entry in the TV's media player card).
- The media player's `app_id` attribute stops updating, so Home Assistant no longer reports
  which app is in the foreground. Anything built on that attribute — templates, automations,
  conditions — stops working for this device.

### Android TV app button does nothing

The button is launching the app by its application ID (package name), which the Play Store no
longer honours — see *Android TV apps cannot be launched by application ID* under Known
limitations. Point it at the app's deep link instead. The lasting fix is to edit the app in the
Android TV Remote entry, so the app picker offers the working value everywhere:

**Settings → Devices & Services → Android TV Remote → (device) → Configure** → replace the
app's *Application ID* with its deep link (e.g. `https://on.orf.at/`) → **Submit**

Then re-pick the app on the button. Deep links only work for apps that publish one; for the
rest there is currently no way to launch them from Home Assistant.

### Checking diagnostics

Go to **Settings → Devices & Services → lizaIP → (device) → ⋮ → Download diagnostics**
for connection state, protocol version, and capabilities.

## Removal

1. Go to **Settings → Devices & Services → lizaIP**
2. Click the entry → **Delete**
3. Optionally remove the integration via HACS → Integrations → lizaIP → Uninstall
4. Restart Home Assistant
