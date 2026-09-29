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

from PIL import Image, ImageDraw, ImageFont
from PIL.features import check as _pil_check

from .const import (
    COLOR_EMOJI_FONT,
    DEFAULT_FG_COLOR,
    DEFAULT_FONT,
    EMOJI_FONT,
    EMOJI_NATIVE_SIZE,
    FALLBACK_EMOJI_PATHS,
    FALLBACK_FONT_PATHS,
    FONTS_DIR,
    MAX_SIZE,
    TRANSPARENT,
    find_font,
    font_has_all_glyphs,
)

_LOGGER = logging.getLogger(__name__)

# Breathing room left on each side of rendered text, in pixels. A layout detail
# of this module and nothing else: without it, glyphs that overhang their
# advance width (italics, the tail of a "g") are clipped by the canvas edge.
TEXT_PADDING = 2

# Keep underscore aliases so existing tests that import the private names
# continue to work without changes.
_find_font = find_font
_font_has_all_glyphs = font_has_all_glyphs


# ── Helpers ───────────────────────────────────────────────────────────────

def _resolve_fonts(font_id: str | None):
    """Return ``(primary_path, emoji_path, color_emoji_path)``.

    *color_emoji_path* points to NotoColorEmoji (CBDT) when present; it is
    used for rendering emoji in their original colours at the native bitmap
    size and then scaling to the target height.
    """
    font_path = find_font(font_id or DEFAULT_FONT)
    if not font_path:
        for p in FALLBACK_FONT_PATHS:
            if os.path.exists(p):
                font_path = p
                break

    emoji_font_path = None
    emoji_path = os.path.join(FONTS_DIR, EMOJI_FONT)
    if os.path.exists(emoji_path):
        emoji_font_path = emoji_path
    else:
        for p in FALLBACK_EMOJI_PATHS:
            if os.path.exists(p):
                emoji_font_path = p
                break

    color_emoji_path = None
    color_path = os.path.join(FONTS_DIR, COLOR_EMOJI_FONT)
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
        return ImageFont.truetype(path, size, layout_engine=_LAYOUT_ENGINE)
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


def _is_emoji_presentation(cp: int) -> bool:
    """Rough check: codepoint typically rendered as emoji."""
    if cp >= 0x1F000:
        return True
    # Miscellaneous symbols / dingbats / emoticons ranges
    if 0x2600 <= cp <= 0x27BF:
        return True
    if 0x2300 <= cp <= 0x23FF:
        return True
    if 0xFE00 <= cp <= 0xFE0F:
        return True
    return False


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

def render_text(
    text: str,
    width: int,  # accepted for API compatibility; image width is derived from text
    height: int,
    fg_color: tuple = DEFAULT_FG_COLOR,
    font_size: int | None = None,
    font_id: str | None = None,
) -> Image.Image:
    """Render *text* onto a transparent canvas and return the image.

    Step 1 of the pipeline in ``render.py``: the background and the PNG encode
    belong to ``finalize_png``.

    Font size defaults to *height* (no shrink-to-fit loop).  The image width is
    sized to fit the text at the chosen font size; the *width* argument is
    ignored for the output dimensions. The height is *not* trimmed to the
    glyphs — the canvas keeps the requested height so that "Hi" and "Hg" come
    out the same size and sit on a common baseline.

    Characters whose glyphs are missing from the primary font are drawn with
    the NotoEmoji fallback font so only those characters switch fonts — the
    rest of the string keeps the primary font.
    """
    height = min(height, MAX_SIZE)

    if font_size is None:
        font_size = height

    primary_path, emoji_path, color_emoji_path = _resolve_fonts(font_id)
    primary_font = _load_font(primary_path, font_size)
    emoji_font = _load_font(emoji_path, font_size) if emoji_path else primary_font

    # Load color emoji font at its native CBDT bitmap size (if available).
    color_emoji_font = None
    if color_emoji_path:
        try:
            color_emoji_font = ImageFont.truetype(
                color_emoji_path, EMOJI_NATIVE_SIZE, layout_engine=_LAYOUT_ENGINE,
            )
        except Exception:
            pass  # fall back to monochrome

    # Decide per-cluster which font to use.
    clusters = list(grapheme_iter(text))
    needs_emoji = (emoji_path or color_emoji_path) and primary_path and any(
        _char_needs_emoji(cl, primary_path) for cl in clusters
    )

    # ── Measure ───────────────────────────────────────────────────────
    scratch = Image.new("RGBA", (1, 1))
    draw = ImageDraw.Draw(scratch)

    if not needs_emoji:
        # Fast path: whole string in the primary font.
        bbox = draw.textbbox((0, 0), text, font=primary_font)
        text_w = max(bbox[2] - bbox[0], 0)
        text_h = max(bbox[3] - bbox[1], 0)
        img_width = min(max(text_w + 2 * TEXT_PADDING, 1), MAX_SIZE)

        img = Image.new("RGBA", (img_width, height), TRANSPARENT)
        draw = ImageDraw.Draw(img)
        x = TEXT_PADDING - bbox[0]
        y = (height - text_h) / 2 - bbox[1]
        draw.text((x, y), text, font=primary_font, fill=fg_color)
    else:
        # Slow path: per-cluster font selection.
        # For emoji clusters with a color font available, we render at the
        # native bitmap size and scale down — this preserves the original
        # emoji colours. Text clusters are drawn with fill=fg_color as usual.

        # First pass: measure each cluster. For color emoji we pre-render
        # to get the final (scaled) dimensions.
        segments: list[tuple[str, bool, int, int]] = []  # (cluster, is_emoji, w, h)
        total_w = 0
        max_h = 0
        y_min_text = 0
        y_max_text = 0

        for cl in clusters:
            is_emoji = _char_needs_emoji(cl, primary_path)
            if is_emoji and color_emoji_font:
                # Pre-render color emoji to get scaled dimensions
                emoji_img = _render_color_emoji(cl, font_size, color_emoji_font)
                segments.append((cl, True, emoji_img.width, emoji_img.height))
                total_w += emoji_img.width
                max_h = max(max_h, emoji_img.height)
            elif is_emoji:
                bb = draw.textbbox((0, 0), cl, font=emoji_font)
                w = bb[2] - bb[0]
                h = bb[3] - bb[1]
                segments.append((cl, True, w, h))
                total_w += w
                y_min_text = min(y_min_text, bb[1])
                y_max_text = max(y_max_text, bb[3])
            else:
                bb = draw.textbbox((0, 0), cl, font=primary_font)
                w = bb[2] - bb[0]
                segments.append((cl, False, w, 0))
                total_w += w
                y_min_text = min(y_min_text, bb[1])
                y_max_text = max(y_max_text, bb[3])

        text_h = max(y_max_text - y_min_text, max_h)
        img_width = min(max(total_w + 2 * TEXT_PADDING, 1), MAX_SIZE)

        img = Image.new("RGBA", (img_width, height), TRANSPARENT)
        draw = ImageDraw.Draw(img)
        cursor_x = float(TEXT_PADDING)
        baseline_y = (height - (y_max_text - y_min_text)) / 2 - y_min_text

        for cl, is_emoji, seg_w, seg_h in segments:
            if is_emoji and color_emoji_font:
                # Render color emoji and paste as image
                emoji_img = _render_color_emoji(cl, font_size, color_emoji_font)
                paste_y = int((height - emoji_img.height) / 2)
                img.paste(emoji_img, (int(cursor_x), paste_y), emoji_img)
                cursor_x += emoji_img.width
            elif is_emoji:
                bb = draw.textbbox((0, 0), cl, font=emoji_font)
                draw.text((cursor_x - bb[0], baseline_y), cl, font=emoji_font, fill=fg_color)
                cursor_x += bb[2] - bb[0]
            else:
                bb = draw.textbbox((0, 0), cl, font=primary_font)
                draw.text((cursor_x - bb[0], baseline_y), cl, font=primary_font, fill=fg_color)
                cursor_x += bb[2] - bb[0]

    return img
