"""Procedural monitor screen contents for the decor layer (any size from 14x4 up). Used by art/decor/build.py.

screen(content, w, h) returns a w x h RGBA image: a 1 px dark frame and the content drawn with whole pixels.
Contents are deterministic (seeded by name), so a rebuild gives the same pixels.
"""
import random

from PIL import Image

CONTENTS = ["code-dark", "code-light", "dashboard", "canvas", "terminal", "document", "game", "call"]

FRAME = (22, 24, 30)


def _canvas(w, h, bg):
    im = Image.new("RGBA", (w, h), bg + (255,))
    return im, im.load()


def _fill(px, w, h, x, y, rw, rh, col):
    for yy in range(max(0, y), min(h, y + rh)):
        for xx in range(max(0, x), min(w, x + rw)):
            px[xx, yy] = col + (255,)


def _lines(px, w, h, x0, y0, x1, step, cols, rnd, ind=True, gap=1):
    """Rows of little coloured dashes like text: one row every `step` px."""
    y = y0
    while y < h - 1:
        x = x0 + (rnd.choice([0, 0, 2, 2, 4]) if ind else 0)
        while x < x1 - 1:
            ln = rnd.choice([2, 3, 3, 4, 5])
            _fill(px, w, h, x, y, min(ln, x1 - x), 1, rnd.choice(cols))
            x += ln + gap + rnd.choice([0, 1])
            if rnd.random() < 0.18:
                break
        y += step


def _code_dark(w, h, rnd):
    im, px = _canvas(w, h, (28, 32, 46))
    gut = 3 if w >= 20 else 0
    if gut:
        _fill(px, w, h, 0, 0, gut, h, (22, 26, 38))
    _fill(px, w, h, 0, 0, w, 1, (44, 50, 70))
    _lines(px, w, h, gut + 1, 2, w - 1, 2 if h > 9 else 2, [(198, 120, 221), (86, 182, 194), (229, 192, 123), (152, 195, 121), (140, 148, 168), (224, 108, 117)], rnd)
    return im


def _code_light(w, h, rnd):
    im, px = _canvas(w, h, (244, 240, 230))
    gut = 3 if w >= 20 else 0
    if gut:
        _fill(px, w, h, 0, 0, gut, h, (226, 222, 210))
    _fill(px, w, h, 0, 0, w, 1, (214, 210, 198))
    _lines(px, w, h, gut + 1, 2, w - 1, 2, [(52, 94, 168), (180, 60, 60), (46, 128, 96), (110, 110, 120), (150, 90, 170)], rnd)
    return im


def _dashboard(w, h, rnd):
    im, px = _canvas(w, h, (22, 32, 50))
    _fill(px, w, h, 0, 0, w, 1, (38, 52, 78))
    n = max(3, w // 5)
    base = h - 2
    top = 3 if h > 8 else 1
    colors = [(78, 190, 170), (240, 160, 70)]
    for i in range(n):
        bx = 1 + i * ((w - 2) // n)
        bw = max(1, (w - 2) // n - 1)
        bh = rnd.randint(2, max(2, base - top))
        _fill(px, w, h, bx, base - bh, bw, bh, colors[i % 2])
    if h > 9 and w > 14:
        y = top + 2
        for x in range(1, w - 1):
            y = max(top, min(base - 1, y + rnd.choice([-1, 0, 0, 1])))
            px[x, y] = (250, 224, 100, 255)
    return im


def _canvas_app(w, h, rnd):
    im, px = _canvas(w, h, (70, 74, 86))
    _fill(px, w, h, 0, 0, w, 1, (50, 54, 64))
    if w >= 20:
        _fill(px, w, h, 0, 1, 3, h - 1, (54, 58, 68))
        _fill(px, w, h, w - 5, 1, 5, h - 1, (58, 62, 74))
        ax, aw = 4, w - 10
    else:
        ax, aw = 1, w - 2
    _fill(px, w, h, ax, 2, aw, max(1, h - 4), (244, 242, 236))
    _fill(px, w, h, ax + 1, 3, max(1, aw // 3), max(1, (h - 6) // 2 + 1), (226, 96, 90))
    _fill(px, w, h, ax + aw // 2, 3, max(1, aw // 3), max(1, (h - 6) // 2 + 1), (84, 140, 210))
    _fill(px, w, h, ax + 1, h - 4, max(1, aw - 2), 1, (60, 60, 70))
    return im


def _terminal(w, h, rnd):
    im, px = _canvas(w, h, (14, 18, 16))
    y = 2
    while y < h - 2:
        _fill(px, w, h, 1, y, 1, 1, (90, 220, 120))
        ln = rnd.randint(3, max(3, w - 6))
        _fill(px, w, h, 3, y, min(ln, w - 4), 1, rnd.choice([(150, 220, 160), (120, 190, 140), (200, 200, 120)]))
        y += 2
    _fill(px, w, h, 1, min(h - 2, y), 2, 1, (90, 220, 120))
    return im


def _document(w, h, rnd):
    im, px = _canvas(w, h, (206, 210, 218))
    pw = w - 6 if w >= 20 else w - 2
    px0 = (w - pw) // 2
    _fill(px, w, h, px0, 1, pw, h - 1, (250, 250, 246))
    _fill(px, w, h, px0 + 1, 2, max(1, pw // 2), 1, (50, 60, 90))
    y = 4
    while y < h - 2:
        _fill(px, w, h, px0 + 1, y, rnd.randint(max(2, pw - 7), max(2, pw - 2)), 1, (150, 154, 164))
        y += 2
    if h >= 14 and pw > 14:
        _fill(px, w, h, px0 + pw - 7, 4, 5, 4, (150, 190, 226))
    return im


def _game(w, h, rnd):
    im, px = _canvas(w, h, (110, 180, 236))
    gy = h - max(2, h // 5)
    _fill(px, w, h, 0, gy, w, h - gy, (96, 150, 70))
    _fill(px, w, h, 0, gy, w, 1, (130, 190, 90))
    _fill(px, w, h, 0, gy + 1, w, h - gy - 1, (140, 96, 60))
    if w >= 20:
        _fill(px, w, h, 3, 3, 4, 1, (250, 250, 255))
        _fill(px, w, h, 4, 2, 2, 1, (250, 250, 255))
        _fill(px, w, h, w - 9, gy - 4, 5, 1, (180, 120, 70))
        _fill(px, w, h, w - 8, gy - 6, 1, 1, (250, 214, 70))
        _fill(px, w, h, w // 2 - 1, gy - 3, 2, 3, (210, 70, 60))
        _fill(px, w, h, w // 2 - 1, gy - 4, 2, 1, (240, 200, 160))
    else:
        _fill(px, w, h, w // 2, max(1, gy - 2), 1, 2, (210, 70, 60))
    return im


def _call(w, h, rnd):
    im, px = _canvas(w, h, (30, 34, 42))
    bar = 2 if h > 9 else 0
    cols, rows = 2, 2 if h >= 12 else 1
    tw, th = (w - 1 - cols) // cols, (h - 1 - bar - rows) // rows
    skins = [(240, 200, 160), (200, 150, 110), (250, 214, 180), (170, 120, 90)]
    cols_bg = [(70, 90, 130), (90, 110, 90), (120, 90, 100), (100, 100, 70)]
    k = 0
    for r in range(rows):
        for c in range(cols):
            tx, ty = 1 + c * (tw + 1), 1 + r * (th + 1)
            _fill(px, w, h, tx, ty, tw, th, cols_bg[k % 4])
            if tw >= 4 and th >= 4:
                _fill(px, w, h, tx + tw // 2 - 1, ty + 1, 2, 2, skins[k % 4])
                _fill(px, w, h, tx + 1, ty + th - 1, tw - 2, 1, (60, 80, 120))
            else:
                _fill(px, w, h, tx + tw // 2, ty + th // 2, 1, 1, skins[k % 4])
            k += 1
    if bar:
        _fill(px, w, h, w // 2 - 1, h - 2, 3, 1, (220, 70, 70))
    return im


_FN = {"code-dark": _code_dark, "code-light": _code_light, "dashboard": _dashboard, "canvas": _canvas_app,
       "terminal": _terminal, "document": _document, "game": _game, "call": _call}


def screen(content, w, h):
    rnd = random.Random(f"{content}/{w}x{h}")
    im = _FN[content](w, h, rnd)
    px = im.load()
    # 1 px dark frame so every content sits in the monitor the same way
    for x in range(w):
        px[x, 0] = FRAME + (255,) if h > 6 else px[x, 0]
        px[x, h - 1] = FRAME + (255,)
    for y in range(h):
        px[0, y] = FRAME + (255,)
        px[w - 1, y] = FRAME + (255,)
    return im


def shear(im, slope=0.5):
    """Isometric 2:1 shear for the lounge: column x moves down by round(slope * x); outside the quad stays clear."""
    w, h = im.size
    out_h = h + int(round(slope * (w - 1)))
    out = Image.new("RGBA", (w, out_h), (0, 0, 0, 0))
    for x in range(w):
        dy = int(round(slope * x))
        out.paste(im.crop((x, 0, x + 1, h)), (x, dy))
    return out
