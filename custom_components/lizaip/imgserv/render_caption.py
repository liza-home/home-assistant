"""Draw the parts of a composite source as one picture.

A source naming several things -- ``logo:hue Wohnzimmer`` -- asks for all of
them in one picture, which is the only shape a page title can take. It happens
after the source renderers and before ``finalize_png``, which finishes it.
"""
from __future__ import annotations

from PIL import Image

from .const import MAX_SIZE, TEXT_BAND_INFO, TRANSPARENT
from .render import autocrop
from .render_text import render_text, text_baseline

#: The subject's share of the *height* when a mark and its words are stacked.
_SUBJECT_HEIGHT_SHARE = 0.62

#: The gap between parts, as a fraction of the short side, so a 50px tile and a
#: 200px strip separate by the same amount visually.
_GAP_SHARE = 0.10

#: Words are not worth drawing below this. Only the stacked arrangement
#: reaches it: a tile cannot overflow, so there the tail is cut instead.
_MIN_FONT_SIZE = 14

#: The floor for a row, which is a title strip. The device scrolls what does
#: not fit, so a long name overflows rather than shrinking past this.
_MIN_TITLE_FONT_SIZE = 32

#: The words' size in a row beside a mark (a logo, an icon): fixed, not fitted,
#: so a name reads the same beside any mark -- a wide wordmark does not shrink
#: it. Only a smaller size asked for wins. The row overflows and scrolls.
_BESIDE_A_MARK_FONT_SIZE = 32

#: How far a mark beside words reaches past the tallest letter, in pixels,
#: above it and below the baseline alike: exactly as tall, a mark's edges
#: read as smaller than the letters' strokes.
_MARK_OVERSHOOT = 1

#: What marks words that had to be cut short.
_ELLIPSIS = "\u2026"

#: A box at least this much wider than it is tall draws its parts in a row.
#: ``title`` (200×50) is such a box; a ``tile`` (50×52) stacks instead.
_SIDE_BY_SIDE_RATIO = 1.5


def _fit_subject(
    img: Image.Image, max_w: int, max_h: int, grow: bool = False,
) -> Image.Image:
    """*img*, trimmed of its transparent margin and scaled into the box.

    Only shrunk, unless *grow*: a mark beside words is drawn exactly as tall
    as they are, however small it was rendered.
    """
    img = autocrop(img.convert("RGBA"), TRANSPARENT, symmetric_vertical=False)
    if img.width <= 0 or img.height <= 0:
        return img
    scale = min(max_w / img.width, max_h / img.height)
    if scale == 1 or (scale > 1 and not grow):
        return img
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    return img.resize(size, Image.LANCZOS)


def _render_fitted_text(
    text: str,
    budget: int,
    height: int,
    fg_color: tuple,
    font_size: int,
    font_id: str | None,
    user_fonts_dir: str | None,
    min_size: int = _MIN_FONT_SIZE,
) -> Image.Image:
    """The words, shrunk until they fit *budget* pixels, then cut short.

    ``render_text`` sizes its canvas to the words, so the fitting is done here.
    """
    size = max(min_size, min(font_size, height))
    img = render_text(text, budget, height, fg_color, size, font_id, user_fonts_dir)
    while img.width > budget > 0 and size > min_size:
        shrunk = max(min_size, int(size * budget / img.width))
        size = shrunk if shrunk < size else size - 1
        img = render_text(text, budget, height, fg_color, size, font_id, user_fonts_dir)

    shortened = text
    while img.width > budget > 0 and len(shortened) > 1:
        shortened = shortened[:-1].rstrip()
        img = render_text(
            shortened + _ELLIPSIS, budget, height, fg_color, size, font_id, user_fonts_dir,
        )
    return img


def _place(canvas: Image.Image, img: Image.Image, x: int, y: int) -> None:
    """Paste *img* onto the transparent *canvas*, clipping what does not fit.

    ``alpha_composite`` refuses a source that overruns its destination, and
    pasting without a mask is what keeps the pixels as they were drawn: each
    part has its own stretch of an empty canvas, so there is nothing to blend
    with and a mask would only spend the alpha a second time.
    """
    canvas.paste(img, (x, y))


def _text_at(
    text: str,
    size: int,
    height: int,
    fg_color: tuple,
    font_id: str | None,
    user_fonts_dir: str | None,
) -> Image.Image:
    """*text* drawn at exactly *size*, however wide that turns out to be."""
    return render_text(text, MAX_SIZE, height, fg_color, size, font_id, user_fonts_dir)


def _row_width(items: list[Image.Image], gap: int) -> int:
    return sum(item.width for item in items) + gap * max(0, len(items) - 1)


def _centred(img: Image.Image) -> Image.Image:
    """*img*'s content moved to the middle of the band it was drawn in.

    A name without a tail leaves the descender's share of the band empty
    below the line everything stands on, and the crop that follows keeps that
    margin; re-centring is what stops the picture hanging high.
    """
    box = img.getbbox()
    if box is None:
        return img
    shift = (img.height - (box[3] - box[1])) // 2 - box[1]
    if not shift:
        return img
    out = Image.new("RGBA", img.size, TRANSPARENT)
    out.paste(img, (0, shift))
    return out


def _row(
    items: list[Image.Image], height: int, gap: int, baseline: int, centre: bool = True,
) -> Image.Image:
    """*items* laid out left to right, each standing on the *baseline*.

    A mark sits on the line the letters sit on, the way a capital does. The
    words are drawn on a canvas as tall as the band, so they are already
    where they belong and the clamp leaves them there. A row with words keeps
    them where they are (*centre* False) and carries their band, so a crop
    cuts the row exactly as it would cut the words alone; there a mark reaches
    :data:`_MARK_OVERSHOOT` below the baseline.
    """
    canvas = Image.new("RGBA", (max(1, _row_width(items, gap)), height), TRANSPARENT)
    foot = baseline if centre else baseline + _MARK_OVERSHOOT
    x = 0
    for item in items:
        bottom = baseline if TEXT_BAND_INFO in item.info else foot
        _place(canvas, item, x, max(0, min(height - item.height, bottom - item.height)))
        x += item.width + gap
    if centre:
        return _centred(canvas)
    band = next((i.info[TEXT_BAND_INFO] for i in items if TEXT_BAND_INFO in i.info), None)
    if band:
        canvas.info[TEXT_BAND_INFO] = band
    return canvas


def compose_parts(
    parts: list,
    width: int,
    height: int,
    fg_color: tuple,
    font_size: int | None = None,
    font_id: str | None = None,
    user_fonts_dir: str | None = None,
) -> Image.Image:
    """The parts of a composite source drawn as one picture, in order.

    *parts* is the title already resolved: an ``Image`` for every part that
    renders to one, and the plain string for every ``text:`` part, which is
    rendered here because only here is there a size to render it at.

    Words set the scale: a mark is drawn as tall as the tallest letter beside
    it. Beside a mark the words are drawn at :data:`_BESIDE_A_MARK_FONT_SIZE`
    (or the smaller size asked for), whatever the row's width; words alone
    are shrunk to fit, down to :data:`_MIN_TITLE_FONT_SIZE`. Marks alone share
    the box.

    A row may come back wider than *width* -- the device scrolls a title
    strip. Only at :data:`~.const.MAX_SIZE`, where ``render_text`` stops
    widening its canvas, are the words cut short instead.
    """
    items = [p for p in parts if not isinstance(p, str) or p.strip()]
    if not items:
        return Image.new("RGBA", (max(1, width), max(1, height)), TRANSPARENT)
    if len(items) == 1 and not isinstance(items[0], str):
        return items[0]

    gap = max(1, round(min(width, height) * _GAP_SHARE))
    texts = [i for i, part in enumerate(items) if isinstance(part, str)]

    if len(items) == 2 and texts == [1] and width < height * _SIDE_BY_SIDE_RATIO:
        return _stacked(
            items[0], items[1], width, height, gap, fg_color,
            font_size, font_id, user_fonts_dir,
        )

    if not texts:
        share = max(1, (width - gap * (len(items) - 1)) // len(items))
        # No words to stand on, so the marks stand on the band and centre in it.
        return _row([_fit_subject(p.convert("RGBA"), share, height) for p in items],
                    height, gap, height)

    size = min(font_size or height, height)
    beside_a_mark = len(texts) < len(items)
    if beside_a_mark:
        size = min(size, _BESIDE_A_MARK_FONT_SIZE)
    while True:
        rendered = _render_row(items, texts, size, height, fg_color, font_id,
                               user_fonts_dir)
        row_w = _row_width(rendered, gap)
        if beside_a_mark or row_w <= width or size <= _MIN_TITLE_FONT_SIZE:
            break
        shrunk = max(_MIN_TITLE_FONT_SIZE, int(size * width / row_w))
        size = shrunk if shrunk < size else size - 1

    if _row_width(rendered, gap) > MAX_SIZE:
        rendered = _render_row(
            items, texts, size, height, fg_color, font_id, user_fonts_dir,
            budget=MAX_SIZE - gap * (len(items) - 1),
        )
    band = next(
        (r.info[TEXT_BAND_INFO] for r in rendered if TEXT_BAND_INFO in r.info), None,
    )
    baseline = band[1] if band else text_baseline(
        items[texts[0]], height, size, font_id, user_fonts_dir,
    )
    return _row(rendered, height, gap, baseline, centre=False)


def _render_row(
    items: list,
    texts: list[int],
    size: int,
    height: int,
    fg_color: tuple,
    font_id: str | None,
    user_fonts_dir: str | None,
    budget: int | None = None,
) -> list[Image.Image]:
    """Every part as an image: the words at *size*, the marks to match.

    A mark is as tall as the tallest letter beside it, plus
    :data:`_MARK_OVERSHOOT` above and below. With a *budget* the words are fitted to what the marks leave of it.
    """
    def letter_height(words: dict) -> int:
        # How far the tallest letter reaches above the line it stands on.
        reach = [
            w.info[TEXT_BAND_INFO][1] - w.getbbox()[1]
            for w in words.values() if w.getbbox() and TEXT_BAND_INFO in w.info
        ]
        tallest = max(1, max(reach)) if reach else max(1, size)
        return tallest + 2 * _MARK_OVERSHOOT

    def fit_marks(mark_h: int) -> dict:
        return {
            i: _fit_subject(part.convert("RGBA"), MAX_SIZE, mark_h, grow=True)
            for i, part in enumerate(items)
            if i not in texts
        }

    words = {
        i: _text_at(items[i], size, height, fg_color, font_id, user_fonts_dir)
        for i in texts
    }
    marks = fit_marks(letter_height(words))
    if budget is not None:
        share = max(1, (budget - sum(m.width for m in marks.values())) // len(texts))
        words = {
            i: _render_fitted_text(
                items[i], share, height, fg_color, size, font_id, user_fonts_dir,
            )
            for i in texts
        }
        marks = fit_marks(letter_height(words))
    return [marks.get(i) or words[i] for i in range(len(items))]


def _stacked(
    img: Image.Image,
    caption: str,
    width: int,
    height: int,
    gap: int,
    fg_color: tuple,
    font_size: int | None,
    font_id: str | None,
    user_fonts_dir: str | None,
) -> Image.Image:
    """A mark above its words, both fitted -- the arrangement a tile gets."""
    subject_h = max(1, int(height * _SUBJECT_HEIGHT_SHARE))
    subject = _fit_subject(img.convert("RGBA"), width, subject_h)
    text_h = max(1, height - subject_h - gap)
    text = _render_fitted_text(
        caption, width, text_h, fg_color,
        min(font_size or text_h, text_h), font_id, user_fonts_dir,
    )
    canvas_w = min(width, max(subject.width, text.width))
    canvas = Image.new("RGBA", (max(1, canvas_w), height), TRANSPARENT)
    _place(canvas, subject, max(0, (canvas_w - subject.width) // 2), 0)
    _place(canvas, text, max(0, (canvas_w - text.width) // 2), subject_h + gap)
    return canvas
