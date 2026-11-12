"""Text renderer for the lizaIP Image Server.

Draws text onto a transparent canvas — step 1 of the pipeline in ``render.py``.
The font size defaults to the image height; the image width is derived from the
measured text so the result is never wider than necessary.

Characters whose glyphs are missing from the primary font (typically emoji)
are rendered individually with the NotoEmoji fallback font so that mixed
text like ``Küche 🏠`` uses the primary font for Latin characters and
only switches to NotoEmoji for the emoji.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont
from PIL.features import check as _pil_check

from .const import (
    COLOR_EMOJI_FONT,
    DEFAULT_FG_COLOR,
    DEFAULT_FONT,
    EMOJI_FONT,
    EMOJI_NATIVE_SIZE,
    FALLBACK_EMOJI_PATHS,
    MAX_SIZE,
    TEXT_BAND_INFO,
    TRANSPARENT,
)
from .fonts import find_font, font_has_all_glyphs, open_font, resolve_font_path

_LOGGER = logging.getLogger(__name__)

# Breathing room left on each side of rendered text, in pixels. A layout detail
# of this module and nothing else: without it, glyphs that overhang their
# advance width (italics, the tail of a "g") are clipped by the canvas edge.
TEXT_PADDING = 2

# The smallest the font is allowed to get while fitting words into a width
# (see `render_text_fitted`). Below this the lettering stops being readable on
# the device, so letting the picture stay too wide is the better failure.
MIN_FIT_FONT_SIZE = 14

# Keep underscore aliases so existing tests that import the private names
# continue to work without changes.
_find_font = find_font
_font_has_all_glyphs = font_has_all_glyphs


# ── Helpers ───────────────────────────────────────────────────────────────

#: What ``?emoji=`` says: no emoji font at all, emoji drawn in the text font.
EMOJI_NONE = "none"

#: The bitmap sizes colour emoji fonts are built at, most common first: a
#: CBDT font opens at one of its own sizes or not at all.
_BITMAP_EMOJI_SIZES = (EMOJI_NATIVE_SIZE, 136, 128, 160, 96, 72, 64, 32)


@lru_cache(maxsize=32)
def _bitmap_emoji_size(path: str) -> int | None:
    """The size a colour bitmap font (Noto Color Emoji) opens at; ``None``
    for an outline font, which opens at any size."""
    try:
        open_font(path, 20, layout_engine=_LAYOUT_ENGINE)
        return None
    except OSError:
        pass
    for size in _BITMAP_EMOJI_SIZES:
        try:
            open_font(path, size, layout_engine=_LAYOUT_ENGINE)
            return size
        except OSError:
            continue
    return None


def _resolve_fonts(font_id: str | None, fonts_dir: str | None = None, emoji: str | None = None):
    """Return ``(primary_path, emoji_path, color_emoji_path)``.

    *emoji* is the theme's emoji font: ``none`` for none -- emoji are drawn in
    the text font, as far as it has them -- or a font id. A colour bitmap
    font becomes *color_emoji_path*, any other *emoji_path*. Unset, or naming
    a font that is not installed, the emoji fonts are found as before.

    A font id that names no font draws in the default font, not in the system
    fallback: a font file removed from the user's font folder should leave its
    labels looking like every other label, not like a different typeface.

    *color_emoji_path* points to NotoColorEmoji (CBDT) when present; it is
    used for rendering emoji in their original colours at the native bitmap
    size and then scaling to the target height.
    """
    font_path = resolve_font_path(font_id, fonts_dir) or resolve_font_path(DEFAULT_FONT, fonts_dir)

    if emoji == EMOJI_NONE:
        return font_path, None, None
    chosen = resolve_font_path(emoji, fonts_dir) if emoji else None
    if chosen:
        if _bitmap_emoji_size(chosen):
            return font_path, None, chosen
        return font_path, chosen, None

    # The emoji fonts are not shipped: the user may supply them by dropping
    # them into their font folder, else a system NotoEmoji is used.
    emoji_font_path = None
    for p in ((os.path.join(fonts_dir, EMOJI_FONT),) if fonts_dir else ()) + FALLBACK_EMOJI_PATHS:
        if os.path.exists(p):
            emoji_font_path = p
            break

    color_emoji_path = None
    if fonts_dir:
        color_path = os.path.join(fonts_dir, COLOR_EMOJI_FONT)
        if os.path.exists(color_path):
            color_emoji_path = color_path

    return font_path, emoji_font_path, color_emoji_path


# Use RAQM layout engine when available — it enables HarfBuzz text shaping
# which is required for ZWJ emoji ligatures (e.g. 👩‍🍳 = 👩+ZWJ+🍳).
_LAYOUT_ENGINE = (
    ImageFont.Layout.RAQM if _pil_check("raqm") else ImageFont.Layout.BASIC
)


def _load_font(path: str | None, size: int) -> ImageFont.FreeTypeFont:
    """Load a TrueType font, falling back to Pillow's built-in default."""
    if path:
        return open_font(path, size, layout_engine=_LAYOUT_ENGINE)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _char_needs_emoji(cluster: str, primary_path: str | None) -> bool:
    """Return True if *cluster* is not renderable with the primary font."""
    if not primary_path:
        return False
    # Pure whitespace / control chars never need the emoji font.
    if all(ord(c) <= 0x20 for c in cluster):
        return False
    return not font_has_all_glyphs(primary_path, cluster)


def _render_color_emoji(cluster: str, target_h: int, color_font) -> Image.Image:
    """Render *cluster* with the color emoji font and scale to *target_h*.

    The CBDT font only works at its native bitmap size, so we render at that
    size and then scale down (LANCZOS) to the requested height, preserving
    the aspect ratio and the original emoji colours.
    """
    # Measure at native size
    scratch = Image.new("RGBA", (1, 1))
    draw = ImageDraw.Draw(scratch)
    bb = draw.textbbox((0, 0), cluster, font=color_font)
    glyph_w = max(bb[2] - bb[0], 1)
    glyph_h = max(bb[3] - bb[1], 1)

    # Render at native size with embedded color
    canvas = Image.new(
        "RGBA",
        (glyph_w + 2 * TEXT_PADDING, glyph_h + 2 * TEXT_PADDING),
        TRANSPARENT,
    )
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (TEXT_PADDING - bb[0], TEXT_PADDING - bb[1]),
        cluster,
        font=color_font,
        embedded_color=True,
    )

    # Scale to target height
    scale = target_h / canvas.height
    new_w = max(int(canvas.width * scale), 1)
    return canvas.resize((new_w, target_h), Image.LANCZOS)


# ── Grapheme cluster segmentation ─────────────────────────────────────────
#
# ZWJ emoji like 👩‍🍳 (woman + ZWJ + cooking) are multi-codepoint sequences
# that must be rendered as a single glyph.  Iterating ``for ch in text``
# splits them into separate codepoints, producing two emoji instead of one.
#
# This segmenter groups:
#   - ZWJ sequences   (👩‍🍳, 👨‍👩‍👧‍👦, …)
#   - Skin-tone mods  (👍🏽)
#   - Variation sels   (☀️ = ☀ + VS16)
#   - Keycap sequences (1️⃣ = 1 + VS16 + U+20E3)
#   - Flag sequences   (🇩🇪 = 🇩 + 🇪)
#   - TAG sequences    (🏴󠁧󠁢󠁥󠁮󠁧󠁿)

_ZWJ = 0x200D
_VS16 = 0xFE0F
_KEYCAP = 0x20E3
_TAG_BASE = 0xE0001
_TAG_END = 0xE007F


def _is_regional_indicator(cp: int) -> bool:
    return 0x1F1E6 <= cp <= 0x1F1FF


def _is_skin_tone(cp: int) -> bool:
    return 0x1F3FB <= cp <= 0x1F3FF


def _is_tag_char(cp: int) -> bool:
    return 0xE0020 <= cp <= 0xE007F


def grapheme_iter(text: str):
    """Yield grapheme clusters from *text*.

    Groups ZWJ sequences, variation selectors, skin-tone modifiers,
    regional-indicator pairs (flags), and TAG sequences so they are
    handed to the font as a single string.
    """
    codepoints = [ord(c) for c in text]
    n = len(codepoints)
    i = 0
    while i < n:
        start = i
        cp = codepoints[i]
        i += 1

        # Regional indicator pair → flag emoji
        if _is_regional_indicator(cp) and i < n and _is_regional_indicator(codepoints[i]):
            i += 1

        # TAG sequence (e.g. 🏴󠁧󠁢󠁥󠁮󠁧󠁿)
        elif cp == 0x1F3F4 and i < n and _is_tag_char(codepoints[i]):
            while i < n and _is_tag_char(codepoints[i]):
                i += 1

        # General: absorb VS16, skin tones, keycaps, and ZWJ continuations
        else:
            while i < n:
                nc = codepoints[i]
                if nc == _VS16 or _is_skin_tone(nc) or nc == _KEYCAP:
                    i += 1
                elif nc == _ZWJ and i + 1 < n:
                    i += 2  # consume ZWJ + next codepoint
                    # The joined char may itself have VS16 / skin tone
                    continue
                else:
                    break

        yield text[start:i]


# ── Text rendering ────────────────────────────────────────────────────────

# What a line of this font can reach above and below its baseline: accented
# capitals go higher than the font's own ascent, and these tails lower.
_ASCENDER_PROBE = "ÄÖÜÅÉÎ"
_DESCENDER_PROBE = "gjpqyÇ"


def _extents(font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    """How far *font* reaches above and below its baseline, in pixels."""
    ascent, descent = font.getmetrics()
    draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    up = -draw.textbbox((0, 0), _ASCENDER_PROBE, font=font, anchor="ls")[1]
    down = draw.textbbox((0, 0), _DESCENDER_PROBE, font=font, anchor="ls")[3]
    return max(ascent, up, 0), max(descent, down, 0)


@lru_cache(maxsize=64)
def _line(path: str | None, height: int, requested: int) -> tuple[int, int, int, int]:
    """``(font_size, top, baseline, bottom)`` of the line drawn in *height*.

    The font size is *requested*, shrunk until everything the font can reach
    above and below its baseline fits *height*; that band is centred.
    """
    size = max(1, requested)
    while True:
        up, down = _extents(_load_font(path, size))
        if up + down <= height or size == 1:
            break
        size = min(size - 1, max(1, int(size * height / max(up + down, 1))))
    top = max(0, (height - up - down) // 2)
    return size, top, top + up, min(height, top + up + down)


def text_line(
    height: int,
    font_size: int | None = None,
    font_id: str | None = None,
    fonts_dir: str | None = None,
) -> tuple[int, int, int]:
    """``(top, baseline, bottom)`` of what ``render_text`` draws at *height*."""
    height = min(height, MAX_SIZE)
    path = _resolve_fonts(font_id, fonts_dir)[0]
    return _line(path, height, font_size or height)[1:]


def render_text(
    text: str,
    width: int,  # accepted for API compatibility; image width is derived from text
    height: int,
    fg_color: tuple = DEFAULT_FG_COLOR,
    font_size: int | None = None,
    font_id: str | None = None,
    fonts_dir: str | None = None,
    emoji: str | None = None,
) -> Image.Image:
    """Render *text* onto a transparent canvas and return the image.

    Step 1 of the pipeline in ``render.py``: the background and the PNG encode
    belong to ``finalize_png``.

    The font size -- *height* unless given -- is reduced until everything the
    font can reach above its baseline (accented capitals) and below it (tails)
    fits *height*, and that band is centred. The image width is sized to fit
    the text; the *width* argument is ignored for the output dimensions. The
    band does not depend on the text: "Hi" and "Hg" stand on the same line,
    and ``finalize_png`` crops a text image to the band (:data:`TEXT_BAND_INFO`),
    never to the ink.

    Characters whose glyphs are missing from the primary font are drawn with
    the NotoEmoji fallback font so only those characters switch fonts — the
    rest of the string keeps the primary font.
    """
    fonts = _resolve_fonts(font_id, fonts_dir, emoji)
    return _render_text(text, height, fg_color, font_size, fonts)


def _render_text(
    text: str,
    height: int,
    fg_color: tuple,
    font_size: int | None,
    fonts: tuple[str | None, str | None, str | None],
) -> Image.Image:
    """`render_text` with the fonts already resolved by `_resolve_fonts`."""
    height = min(height, MAX_SIZE)

    primary_path, emoji_path, color_emoji_path = fonts
    font_size, top, baseline, bottom = _line(primary_path, height, font_size or height)
    primary_font = _load_font(primary_path, font_size)
    emoji_font = _load_font(emoji_path, font_size) if emoji_path else primary_font

    # Load color emoji font at its native CBDT bitmap size (if available).
    color_emoji_font = None
    if color_emoji_path:
        try:
            color_emoji_font = open_font(
                color_emoji_path, _bitmap_emoji_size(color_emoji_path) or EMOJI_NATIVE_SIZE,
                layout_engine=_LAYOUT_ENGINE,
            )
        except Exception:
            pass  # fall back to monochrome

    # Decide per-cluster which font to use.
    clusters = list(grapheme_iter(text))
    needs_emoji = False
    cluster_is_emoji: list[bool] = []
    if (emoji_path or color_emoji_path) and primary_path:
        cluster_is_emoji = [_char_needs_emoji(cl, primary_path) for cl in clusters]
        needs_emoji = any(cluster_is_emoji)

    # ── Measure ───────────────────────────────────────────────────────
    scratch = Image.new("RGBA", (1, 1))
    draw = ImageDraw.Draw(scratch)

    if not needs_emoji:
        # Fast path: whole string in the primary font.
        bbox = draw.textbbox((0, 0), text, font=primary_font, anchor="ls")
        text_w = max(bbox[2] - bbox[0], 0)
        img_width = min(max(text_w + 2 * TEXT_PADDING, 1), MAX_SIZE)

        img = Image.new("RGBA", (img_width, height), TRANSPARENT)
        draw = ImageDraw.Draw(img)
        x = TEXT_PADDING - bbox[0]
        draw.text((x, baseline), text, font=primary_font, fill=fg_color, anchor="ls")
    else:
        # Slow path: per-cluster font selection.
        # For emoji clusters with a color font available, we render at the
        # native bitmap size and scale down — this preserves the original
        # emoji colours. Text clusters are drawn with fill=fg_color as usual.

        # First pass: measure each cluster. For color emoji we pre-render
        # to get the final (scaled) dimensions.
        # A colour emoji is a bitmap, not a glyph on the line: it is drawn as
        # tall as the line reaches, from the top of the ascenders down.
        up, down = _extents(primary_font)
        emoji_h = max(1, up + down)

        segments: list[tuple[str, bool, Image.Image | None]] = []
        total_w = 0
        for cl, is_emoji in zip(clusters, cluster_is_emoji, strict=True):
            if is_emoji:
                if color_emoji_font:
                    emoji_img = _render_color_emoji(cl, emoji_h, color_emoji_font)
                    segments.append((cl, is_emoji, emoji_img))
                    total_w += emoji_img.width
                    continue
                font = emoji_font
            else:
                font = primary_font
            bb = draw.textbbox((0, 0), cl, font=font, anchor="ls")
            segments.append((cl, is_emoji, None))
            total_w += bb[2] - bb[0]

        img_width = min(max(total_w + 2 * TEXT_PADDING, 1), MAX_SIZE)
        img = Image.new("RGBA", (img_width, height), TRANSPARENT)
        draw = ImageDraw.Draw(img)
        cursor_x = float(TEXT_PADDING)

        for cl, is_emoji, emoji_img in segments:
            if emoji_img is not None:
                img.paste(emoji_img, (int(cursor_x), baseline - up), emoji_img)
                cursor_x += emoji_img.width
                continue
            font = emoji_font if is_emoji else primary_font
            bb = draw.textbbox((0, 0), cl, font=font, anchor="ls")
            # A colour outline font (COLR, as Twemoji) draws in its own
            # colours; a monochrome one in the text's, as before.
            draw.text(
                (cursor_x - bb[0], baseline), cl, font=font, fill=fg_color, anchor="ls",
                embedded_color=is_emoji,
            )
            cursor_x += bb[2] - bb[0]

    img.info[TEXT_BAND_INFO] = (top, baseline, bottom)
    return img


def text_baseline(
    text: str,
    height: int,
    font_size: int | None = None,
    font_id: str | None = None,
    fonts_dir: str | None = None,
) -> int:
    """The line *text* sits on in what `render_text` draws; the same for any text."""
    return text_line(height, font_size, font_id, fonts_dir)[1]


def render_text_fitted(
    text: str,
    width: int,
    height: int,
    fg_color: tuple = DEFAULT_FG_COLOR,
    font_size: int | None = None,
    font_id: str | None = None,
    fonts_dir: str | None = None,
    min_size: int = MIN_FIT_FONT_SIZE,
    emoji: str | None = None,
) -> Image.Image:
    """*text* drawn no wider than *width*, by shrinking the font to suit.

    ``render_text`` fits the font to the *height* and then lets the canvas
    grow as wide as the words turn out to be -- right for a page title, which
    the device scrolls, wrong for a tile, which it does not: "Battery 91 %"
    drawn at 50 px comes back three tiles wide. Here the font is stepped down
    until the words fit, so a tile shows all of them.

    Only ever shrinks. Words that already fit are drawn at the size asked
    for, never stretched to fill the width, so two tiles beside each other
    keep the same lettering. Shrinking stops at *min_size*: past that the
    words would be unreadable, and staying wide is the better failure.
    """
    fonts = _resolve_fonts(font_id, fonts_dir, emoji)
    img = _render_text(text, height, fg_color, font_size, fonts)
    size = font_size or height
    while width > 0 and img.width > width and size > min_size:
        # Aim straight at the ratio that would fit, but always move by at
        # least one step: rounding could otherwise stand still forever.
        size = max(min_size, min(size - 1, int(size * width / img.width)))
        img = _render_text(text, height, fg_color, size, fonts)
    return img
