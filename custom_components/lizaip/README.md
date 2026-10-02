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
  diagnostics.py       # Diagnostics support

  event.py             # Platform wrapper → device/event.py
  number.py            # Platform wrapper → device/number.py
  sensor.py            # Platform wrapper → device/sensor.py

  device/              # Device connection sub-package
    __init__.py        # Exports: LizaIPConnection, LizaIPWebSocketView, etc.
    connection.py      # WebSocket connection manager
    protocol.py        # Protocol implementation (request/response/event)
    websocket.py         # HTTP WS endpoint (/api/lizaip/ws)
    const.py           # DOMAIN, WS_PATH, MODEL, etc.
    entity.py          # Shared entity mixin
    event.py           # EventEntity (buttons)
    number.py          # NumberEntity (brightness, sliders)
    sensor.py          # SensorEntity (battery)
    services.py        # Service handlers (send_image)

  config/              # Config panel sub-package
    __init__.py         # Exports: async_setup_panel
    const.py            # Events, helpers, icon resolver
    panel.py            # Panel registration + button listener
    actions.py          # Action execution + state-based icon tracking
    websocket.py        # WS API for the frontend panel
    button_rendering.py # What a button says and which icon it shows
    device_sync.py      # Push config to the physical device
    panel/              # Frontend JS assets
    blueprints/         # Button geometry, one file per hardware SKU (3029-000.yaml)

  imgserv/             # On-demand image rendering server
    __init__.py        # Registers HTTP endpoint at /imgserv/
    httpsocket.py      # Request handler — routes source:value URLs
    render.py          # Shared rendering utilities (SVG tessellation, autocrop)
    render_mdi.py      # MDI icon rendering (SVG → PNG via Pillow)
    render_logo.py     # Brand logo rendering (native colour or monochrome)
    render_phu.py      # Philips Hue / custom-brand-icons rendering
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
| Image server | On-demand PNG rendering at `/imgserv/` — MDI icons, brand logos, PHU icons, text, static files, media thumbnails |
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
- No authentication required (images are public)
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
3. **Mount** — the subject is composited onto `bg`; with `percent`, the lower band stays opaque and the upper remainder is dimmed via alpha
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
| `percent` | Fill level `0`–`100`: the bottom N % stays fully opaque; the upper remainder is dimmed via alpha (`70%`) | — |
| `font` | Font ID for `text:` source (see [Available Fonts](#available-fonts)) | `filson-light` |
| `font_size` | Font size in pixels for `text:` source | `title` 48, `tooltip` 24, otherwise the image height |

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
HACS frontend integration. Requires `custom-brand-icons` to be installed via HACS — the
renderer loads icons from its JS bundle at runtime.

```
imgserv://phu:ceiling-fan?size=tile&fg=white
imgserv://phu:hue-go?size=tile&fg=FFD700
```

> **Note:** If `custom-brand-icons` is not installed, all `phu:` requests return 404.

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

#### Legacy `?text=` format

For backward compatibility, you can also request text rendering without a source path:

```
/api/imgserv/?text=Hello&size=tile&fg=white
```

This is equivalent to `/api/imgserv/text:Hello?size=tile&fg=white`.

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
result, and **Restore defaults** goes back to Filson Soft Light at 48 px (titles) and
24 px (tooltips).

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
| `lizaip_config/save_assignments` | Save assignments and push to device |
| `lizaip_config/get_pages` | Get the pages list |
| `lizaip_config/set_pages` | Replace the pages list |
| `lizaip_config/update_page` | Update a page's title image and/or default colour |
| `lizaip_config/get_settings` | Get a device's title/tooltip text settings, with the defaults, the installed fonts and the size limits |
| `lizaip_config/set_settings` | Validate and save the text settings and push them to the device |
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

- **Python** — `const.get_action_label(key, lang)` reads
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
from HA on purpose — see the comments in `const.py`.

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
- **PHU icons require custom-brand-icons** — The `phu:` source type only works if the
  `custom-brand-icons` HACS frontend integration is installed.
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
- **PHU:** Ensure `custom-brand-icons` is installed via HACS
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
