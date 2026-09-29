"""SVG rendering engine and shared image utilities.

**The pipeline.** Every request walks the same five steps, and only the first
of them knows what a "logo" or an "MDI icon" is:

1. ``render_*`` draws the subject on a *transparent* canvas — foreground only.
2. ``autocrop`` trims the transparent margin, if the request asked for it.
3. ``apply_percent_tint`` optionally dims the unfilled upper band via alpha.
4. ``mount`` puts the result onto its background.
5. ``save_png`` encodes, flattening the alpha unless the caller keeps it.

Steps 2–5 are generic: they are the same operations whatever the source type
is, so they live here and run once, in :func:`finalize_png`. That is the reason
renderers take no ``bg_color``, no ``crop``, no ``percent`` — a renderer that
painted its own background would have to be trusted to crop against the same
colour it painted, and one that skipped the overlay would produce "percent
works on icons but not on logos" months later.

Shared utilities:
  - ``autocrop``              — step 2: trim the transparent margin
  - ``apply_percent_tint``    — step 3: optional fill-level alpha dimming
  - ``mount``                 — step 4: composite onto a background
  - ``flatten_alpha``         — composite RGBA onto black, yielding RGB
  - ``save_png``              — step 5: encode a PIL image as PNG bytes
  - ``finalize_png``          — steps 2–5 in order; the single exit

SVG rendering (used by render_mdi, render_phu, render_logo):
  - ``render_svg_icon``       — single SVG path → image (even-odd fill)
  - ``render_multi_path_svg`` — multiple paths OR-combined → image
  - ``tessellate_svg_path``   — SVG path `d` → polygon point-lists
  - ``parse_svg_viewbox``     — extract viewBox from SVG root element
  - ``collect_svg_paths``     — extract <path>/<circle> d-strings from SVG root

Text rendering lives in render_text.py; static-image resizing in render_static.py.
Colours, sizes and the tint opacity come from ``const.py``; the two numbers that
only steer this engine — ``SVG_SUPERSAMPLE`` and ``CURVE_SEGMENTS`` — are defined
below, where the code that reads them can be seen at the same time.
"""
from __future__ import annotations

import io
import math
import re

import numpy as np
from PIL import Image, ImageDraw

from .const import (
    FLATTEN_COLOR,
    MAX_SIZE,
    PERCENT_TINT_ALPHA,
    TRANSPARENT,
)

# SVG paths are rasterized at this multiple of the requested size and then
# resized down, which is what produces the anti-aliased edges. It lives here
# rather than in const.py because it means nothing outside this engine: raising
# it costs memory quadratically for a difference nobody can see at 60×60.
SVG_SUPERSAMPLE = 4

# Segments per Bézier curve when flattening an SVG path to polygons. Arcs scale
# this up by their sweep, so 16 is the floor rather than the number used.
CURVE_SEGMENTS = 16


# ═══════════════════════════════════════════════════════════════════════════
# Image utilities
# ═══════════════════════════════════════════════════════════════════════════

def flatten_alpha(img: Image.Image) -> Image.Image:
    """Convert an RGBA image to RGB by compositing onto ``FLATTEN_COLOR``."""
    if img.mode != "RGBA":
        return img.convert("RGB")
    background = Image.new("RGB", img.size, FLATTEN_COLOR)
    background.paste(img, mask=img.split()[3])
    return background


def save_png(img: Image.Image, keep_alpha: bool = False) -> bytes:
    """Step 5: encode as PNG bytes, flattening alpha unless *keep_alpha* is set.

    *keep_alpha* is used for requests from the HA config panel (browser preview),
    where the transparent background should be preserved. External requests
    (the physical device) default to flattened RGB — its display cannot composite
    alpha, so a flattened PNG avoids surprising black fringes at the device.
    """
    if not keep_alpha:
        img = flatten_alpha(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()



def apply_percent_tint(
    img: Image.Image,
    percent: int | None,
) -> Image.Image:
    """Apply fill-level dimming via alpha only.

    ``percent`` splits the image into two horizontal bands on the *finished*
    image (after crop/resize):

    * bottom ``percent``% keeps its original alpha ("full")
    * rows above are scaled to :data:`PERCENT_TINT_ALPHA` ("empty")

    No colour tinting happens here; RGB stays unchanged.
    """
    if percent is None:
        return img

    percent = max(0, min(percent, 100))
    rgba = np.array(img.convert("RGBA"), dtype=np.float32)
    height = rgba.shape[0]

    # Fill starts at this row; ceil() avoids overstating the filled level.
    start_row = int(np.ceil(height * (100 - percent) / 100.0))
    start_row = max(0, min(start_row, height))

    # Scale alpha of the unfilled remainder; keep RGB untouched.
    if start_row > 0:
        rgba[:start_row, :, 3] *= PERCENT_TINT_ALPHA

    return Image.fromarray(np.clip(np.round(rgba), 0, 255).astype(np.uint8), "RGBA")


def mount(
    img: Image.Image,
    bg_color: tuple | None = None,
) -> Image.Image:
    """Step 4: composite the foreground onto its background.

    The renderers hand back foreground pixels on a transparent canvas; this is
    where they meet ``bg_color`` — which may itself be transparent, in which
    case the mount is a no-op and the alpha survives to :func:`save_png`.

    Percent dimming is done earlier in :func:`finalize_png`, before mounting,
    so an opaque background stays fully opaque.
    """
    bg = bg_color or TRANSPARENT
    rgba = img.convert("RGBA")
    if bg[3] != 0:
        canvas = Image.new("RGBA", rgba.size, bg)
        rgba = Image.alpha_composite(canvas, rgba)
    return rgba


def finalize_png(
    img: Image.Image,
    keep_alpha: bool = False,
    percent: int | None = None,
    bg_color: tuple | None = None,
    crop: bool = False,
) -> tuple[bytes, str]:
    """Steps 2–5: crop, percent, mount, encode. **The one exit from every render path.**

    Each ``render_*`` function answers only "what does this subject look like";
    everything after that is identical for all of them and happens here, in
    order:

    1. *(the caller's renderer produced the image)*
    2. ``autocrop`` — only when *crop* is set
    3. ``apply_percent_tint`` — when ``percent`` is set, upper rows are dimmed
       via alpha to :data:`PERCENT_TINT_ALPHA`
    4. ``mount`` onto ``bg_color``
    5. ``save_png``, flattening unless ``keep_alpha``

    That is why the renderers carry none of these parameters in their
    signatures: they never needed to know.
    """
    if crop:
        img = autocrop(img, TRANSPARENT)
    img = apply_percent_tint(img, percent)
    img = mount(img, bg_color)
    return (save_png(img, keep_alpha), "image/png")


def autocrop(
    img: Image.Image,
    bg_color: tuple = TRANSPARENT,
    symmetric_vertical: bool = True,
    horizontal_only: bool = False,
) -> Image.Image:
    """Step 2: crop an image to its content bounding box.

    *bg_color* is what counts as empty; it defaults to fully transparent,
    because that is what renderers leave behind. Callers cropping an image that
    already has a painted background must pass that colour instead.

    *horizontal_only* (default False) keeps the original image height and only
    crops the left/right margins.  Useful for text rendering where the caller
    has already centred the content vertically.

    *symmetric_vertical* (default True, ignored when *horizontal_only* is set)
    equalises the vertical crop: the smaller of the top and bottom margins is
    applied to both sides so the content stays vertically centred.  Pass
    ``False`` to get tight cropping on both axes.
    """
    bg = Image.new("RGBA", img.size, bg_color)
    diff = np.array(img.convert("RGBA")) != np.array(bg)
    mask = diff.any(axis=2)
    if not mask.any():
        return img
    cols = mask.any(axis=0)
    x0, x1 = int(cols.argmax()), int(cols.size - cols[::-1].argmax())

    if horizontal_only:
        return img.crop((x0, 0, x1, img.height))

    rows = mask.any(axis=1)
    y0, y1 = int(rows.argmax()), int(rows.size - rows[::-1].argmax())

    if symmetric_vertical:
        margin_top = y0
        margin_bottom = img.height - y1
        margin = min(margin_top, margin_bottom)
        y0 = margin
        y1 = img.height - margin

    return img.crop((x0, y0, x1, y1))




# ═══════════════════════════════════════════════════════════════════════════
# SVG rendering engine
# ═══════════════════════════════════════════════════════════════════════════

def _viewbox_transform(
    viewbox: tuple[float, float, float, float], rw: int, rh: int,
) -> tuple[float, float, float]:
    """Compute (scale, offset_x, offset_y) to map *viewbox* into a raster of size *rw*×*rh*."""
    vb_x, vb_y, vb_w, vb_h = viewbox
    s = min(rw / vb_w, rh / vb_h)
    ox = (rw - vb_w * s) / 2.0 - vb_x * s
    oy = (rh - vb_h * s) / 2.0 - vb_y * s
    return s, ox, oy


def _rasterize_path(path_d: str, rw: int, rh: int, s: float, ox: float, oy: float) -> np.ndarray:
    """Rasterize one SVG path's polygons into an even-odd (XOR) fill mask."""
    mask = np.zeros((rh, rw), dtype=np.uint8)
    for poly in tessellate_svg_path(path_d):
        if len(poly) >= 3:
            pmask = Image.new("L", (rw, rh), 0)
            ImageDraw.Draw(pmask).polygon(
                [(p[0] * s + ox, p[1] * s + oy) for p in poly], fill=255,
            )
            mask ^= np.array(pmask)
    return mask


def _compose_mask(
    mask: np.ndarray,
    width: int,
    height: int,
    fg_color: tuple,
) -> Image.Image:
    """Turn a rasterized mask into foreground pixels on a transparent canvas.

    The mask becomes the alpha channel rather than a paste-mask onto a painted
    background: step 1 of the pipeline owns the subject, not its surroundings.
    Resizing happens here because the mask is rasterized at ``SVG_SUPERSAMPLE``
    times the requested size and must be reduced before anything downstream
    measures the image.
    """
    rh, rw = mask.shape
    rgba = np.zeros((rh, rw, 4), dtype=np.uint8)
    rgba[:, :, 0], rgba[:, :, 1], rgba[:, :, 2] = fg_color[0], fg_color[1], fg_color[2]
    fg_alpha = fg_color[3] if len(fg_color) > 3 else 255
    rgba[:, :, 3] = (mask.astype(np.uint16) * fg_alpha // 255).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    return img.resize((width, height), Image.LANCZOS)


def render_svg_icon(
    path_str: str,
    viewbox: tuple[float, float, float, float],
    width: int,
    height: int,
    fg_color: tuple,
) -> Image.Image:
    """Render a *single* SVG path string into an image using even-odd fill."""
    return render_multi_path_svg([path_str], viewbox, width, height, fg_color)


def render_multi_path_svg(
    paths_d: list[str],
    viewbox: tuple[float, float, float, float],
    width: int,
    height: int,
    fg_color: tuple,
) -> Image.Image:
    """Render multiple SVG ``<path>`` elements combined with OR (union).

    Each individual path uses even-odd fill (XOR), while separate paths are
    merged with OR so overlapping shapes add up rather than cancel.

    Returns foreground-on-transparent, per the pipeline in the module
    docstring; cropping and the background are the caller's later steps.
    """
    width, height = min(width, MAX_SIZE), min(height, MAX_SIZE)
    rw, rh = width * SVG_SUPERSAMPLE, height * SVG_SUPERSAMPLE
    s, ox, oy = _viewbox_transform(viewbox, rw, rh)

    mask = np.zeros((rh, rw), dtype=np.uint8)
    for path_d in paths_d:
        mask |= _rasterize_path(path_d, rw, rh, s, ox, oy)

    return _compose_mask(mask, width, height, fg_color)


# ── SVG XML helpers ───────────────────────────────────────────────────────

def parse_svg_viewbox(root) -> tuple[float, float, float, float]:
    """Return ``(x, y, width, height)`` from an SVG root element."""
    vb = root.get("viewBox")
    if vb:
        parts = vb.split()
        return float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])
    return 0.0, 0.0, float(root.get("width", "24")), float(root.get("height", "24"))


def collect_svg_paths(root) -> list[str]:
    """Extract ``<path d="…">`` and ``<circle>`` elements, skipping ``fill=none``."""
    paths: list[str] = []
    for elem in root.iter():
        tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        if elem.get("fill", "").lower() == "none":
            continue
        if tag == "path" and elem.get("d"):
            paths.append(elem.get("d"))
        elif tag == "circle":
            cx = float(elem.get("cx", 0))
            cy = float(elem.get("cy", 0))
            r = float(elem.get("r", 0))
            if r > 0:
                paths.append(
                    f"M{cx-r},{cy}A{r},{r},0,1,0,{cx+r},{cy}A{r},{r},0,1,0,{cx-r},{cy}Z"
                )
    return paths


# ── SVG path tessellation ─────────────────────────────────────────────────

_SVG_TOKEN_RE = re.compile(r'[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')


def tessellate_svg_path(
    path_d: str, n: int = CURVE_SEGMENTS,
) -> list[list[tuple[float, float]]]:
    """Parse an SVG path *d* string into polygon point-lists.

    Curves (cubic/quadratic Bézier, arcs) are tessellated into *n* line
    segments each.  Returns a list of polygons (each a list of ``(x, y)``).
    """
    tokens = _SVG_TOKEN_RE.findall(path_d)
    polys: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    x = y = sx = sy = lcx = lcy = 0.0
    i, cmd, lcmd = 0, "M", ""

    def num():
        nonlocal i
        while i < len(tokens) and tokens[i].isalpha():
            i += 1
        if i < len(tokens):
            v = float(tokens[i]); i += 1; return v
        return 0.0

    def cubic(x0, y0, c1x, c1y, c2x, c2y, ex, ey):
        return [
            (
                (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * c1x + 3 * (1 - t) * t * t * c2x + t ** 3 * ex,
                (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * c1y + 3 * (1 - t) * t * t * c2y + t ** 3 * ey,
            )
            for t in (s / n for s in range(1, n + 1))
        ]

    def quad(x0, y0, cx, cy, ex, ey):
        return [
            (
                (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * ex,
                (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * ey,
            )
            for t in (s / n for s in range(1, n + 1))
        ]

    def arc(rx, ry, rot, la, sw, ex, ey, sx_, sy_):
        if rx == 0 or ry == 0:
            return [(ex, ey)]
        rx, ry = abs(rx), abs(ry)
        phi = math.radians(rot)
        cp, sp = math.cos(phi), math.sin(phi)
        dx2, dy2 = (sx_ - ex) / 2, (sy_ - ey) / 2
        x1p, y1p = cp * dx2 + sp * dy2, -sp * dx2 + cp * dy2
        lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
        if lam > 1:
            rx *= math.sqrt(lam)
            ry *= math.sqrt(lam)
        num_ = max(0, rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2)
        den_ = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
        sq = math.sqrt(num_ / den_) if den_ > 0 else 0
        if la == sw:
            sq = -sq
        cxp, cyp = sq * rx * y1p / ry, -sq * ry * x1p / rx
        cx_ = cp * cxp - sp * cyp + (sx_ + ex) / 2
        cy_ = sp * cxp + cp * cyp + (sy_ + ey) / 2

        def ang(ux, uy, vx, vy):
            d = math.sqrt(ux * ux + uy * uy) * math.sqrt(vx * vx + vy * vy)
            if d == 0:
                return 0
            c = max(-1, min(1, (ux * vx + uy * vy) / d))
            a = math.acos(c)
            return -a if ux * vy - uy * vx < 0 else a

        t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if sw == 0 and dt > 0:
            dt -= 2 * math.pi
        elif sw == 1 and dt < 0:
            dt += 2 * math.pi
        steps = max(n, int(abs(dt) / (math.pi / 8)))
        return [
            (
                cp * rx * math.cos(t1 + dt * s / steps) - sp * ry * math.sin(t1 + dt * s / steps) + cx_,
                sp * rx * math.cos(t1 + dt * s / steps) + cp * ry * math.sin(t1 + dt * s / steps) + cy_,
            )
            for s in range(1, steps + 1)
        ]

    while i < len(tokens):
        tok = tokens[i]
        if tok.isalpha():
            cmd = tok
            i += 1

        if cmd == "M":
            if cur: polys.append(cur); cur = []
            x, y = num(), num(); sx, sy = x, y; cur.append((x, y)); cmd = "L"
        elif cmd == "m":
            if cur: polys.append(cur); cur = []
            x += num(); y += num(); sx, sy = x, y; cur.append((x, y)); cmd = "l"
        elif cmd == "L": x, y = num(), num(); cur.append((x, y))
        elif cmd == "l": x += num(); y += num(); cur.append((x, y))
        elif cmd == "H": x = num(); cur.append((x, y))
        elif cmd == "h": x += num(); cur.append((x, y))
        elif cmd == "V": y = num(); cur.append((x, y))
        elif cmd == "v": y += num(); cur.append((x, y))
        elif cmd == "C":
            c1x, c1y, c2x, c2y, ex, ey = num(), num(), num(), num(), num(), num()
            cur.extend(cubic(x, y, c1x, c1y, c2x, c2y, ex, ey))
            lcx, lcy = c2x, c2y; x, y = ex, ey
        elif cmd == "c":
            c1x, c1y = x + num(), y + num(); c2x, c2y = x + num(), y + num()
            dx_, dy_ = num(), num(); ex, ey = x + dx_, y + dy_
            cur.extend(cubic(x, y, c1x, c1y, c2x, c2y, ex, ey))
            lcx, lcy = c2x, c2y; x, y = ex, ey
        elif cmd == "S":
            c1x = 2 * x - lcx if lcmd in "CcSs" else x
            c1y = 2 * y - lcy if lcmd in "CcSs" else y
            c2x, c2y, ex, ey = num(), num(), num(), num()
            cur.extend(cubic(x, y, c1x, c1y, c2x, c2y, ex, ey))
            lcx, lcy = c2x, c2y; x, y = ex, ey
        elif cmd == "s":
            c1x = 2 * x - lcx if lcmd in "CcSs" else x
            c1y = 2 * y - lcy if lcmd in "CcSs" else y
            c2x, c2y = x + num(), y + num(); dx_, dy_ = num(), num(); ex, ey = x + dx_, y + dy_
            cur.extend(cubic(x, y, c1x, c1y, c2x, c2y, ex, ey))
            lcx, lcy = c2x, c2y; x, y = ex, ey
        elif cmd == "Q":
            cx_, cy_, ex, ey = num(), num(), num(), num()
            cur.extend(quad(x, y, cx_, cy_, ex, ey))
            lcx, lcy = cx_, cy_; x, y = ex, ey
        elif cmd == "q":
            cx_, cy_ = x + num(), y + num(); dx_, dy_ = num(), num(); ex, ey = x + dx_, y + dy_
            cur.extend(quad(x, y, cx_, cy_, ex, ey))
            lcx, lcy = cx_, cy_; x, y = ex, ey
        elif cmd == "T":
            cx_ = 2 * x - lcx if lcmd in "QqTt" else x
            cy_ = 2 * y - lcy if lcmd in "QqTt" else y
            ex, ey = num(), num()
            cur.extend(quad(x, y, cx_, cy_, ex, ey))
            lcx, lcy = cx_, cy_; x, y = ex, ey
        elif cmd == "t":
            cx_ = 2 * x - lcx if lcmd in "QqTt" else x
            cy_ = 2 * y - lcy if lcmd in "QqTt" else y
            dx_, dy_ = num(), num(); ex, ey = x + dx_, y + dy_
            cur.extend(quad(x, y, cx_, cy_, ex, ey))
            lcx, lcy = cx_, cy_; x, y = ex, ey
        elif cmd in ("A", "a"):
            rx_, ry_, rot_, la_, sw_ = num(), num(), num(), int(num()), int(num())
            if cmd == "A":
                ex, ey = num(), num()
            else:
                ex, ey = x + num(), y + num()
            cur.extend(arc(rx_, ry_, rot_, la_, sw_, ex, ey, x, y))
            x, y = ex, ey
        elif cmd in ("Z", "z"):
            x, y = sx, sy
            if cur:
                cur.append((sx, sy))
                polys.append(cur)
                cur = []
        else:
            i += 1
        lcmd = cmd

    if cur:
        polys.append(cur)
    return polys
