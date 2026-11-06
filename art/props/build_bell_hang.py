"""Hand-drawn hanging pull bell (replaces the red desk bell under the whiteboard): assets/props/bell-hang*.png, art/props/bell-hang-contact.png.

  python art/props/build_bell_hang.py
Three pictures, same pixel language as art/props/build.py (it reuses that file's palette and render(): 1px dark outline, no anti-aliasing):
  bell-hang.png       still: a brass bell on a short rope, the rope's top edge is the picture's top edge
  bell-hang-ring.png  same canvas, the bell swung to the right with a leaning clapper and small motion marks
  bell-hang-cord.png  a 5x4 rope tile to repeat vertically from the ceiling line down to the top of the bell picture
Both bell pictures share one canvas and one rope column, so the swap on ring never moves the rope.
Anchor = the picture's top-middle pixel (x = width // 2, y = 0); the rope tile's middle column (x = 2) sits on that x.
Two runs write identical bytes.
"""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build as B  # noqa: E402  (palette + render; importing does not write anything)

ROOT = B.ROOT
OUT = B.OUT
CONTACT = os.path.join(HERE, "bell-hang-contact.png")

B.PAL["H"] = (255, 240, 170, 255)  # brass highlight
B.PAL["c"] = (214, 164, 104, 255)  # rope light (kraft)
B.PAL["q"] = (120, 80, 48, 255)  # rope dark twist (luma <= 90 so a cut end reads as outline)

W = 23  # inside width of both bell pictures
MID = 11  # rope column

# the bell body, 13 wide, centre column 6 (the crown hangs from the rope)
BODY = [
    ".....yyy.....",
    "....yHHyy....",
    "...yHHyyyY...",
    "...yHyyyyY...",
    "...yHyyyyY...",
    "..yHyyyyyyY..",
    "..yHyyyyyyY..",
    ".yHyyyyyyyYY.",
    ".yyyyyyyyyYY.",
    "yyyyyyyyyyYYY",
    "YYYYYYYYYYYYY",
]
assert all(len(r) == 13 for r in BODY)


def canvas(rows_spec, h):
    g = [["."] * W for _ in range(h)]
    for y, x0, text in rows_spec:
        for i, ch in enumerate(text):
            if ch != "." and 0 <= x0 + i < W:
                g[y][x0 + i] = ch
    return ["".join(r) for r in g]


def still():
    spec = [(0, MID, "c"), (1, MID, "q"), (2, MID, "c"), (3, MID, "q")]
    for i, r in enumerate(BODY):
        spec.append((4 + i, MID - 6, r))
    y = 4 + len(BODY)
    spec.append((y, MID - 1, "dd"))  # clapper ball under the lip
    spec.append((y + 1, MID - 1, "dd"))
    return canvas(spec, y + 2)


def ring():
    # pendulum: the rope is fixed at the top and leans one pixel, the bell slides right (1px on the upper rows, 2px lower), clapper thrown left
    shift = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]
    spec = [(0, MID, "c"), (1, MID, "q"), (2, MID, "c"), (3, MID + 1, "q")]
    for i, r in enumerate(BODY):
        spec.append((4 + i, MID - 6 + shift[i], r))
    y = 4 + len(BODY)
    spec.append((y, MID - 1, "dd"))
    spec.append((y + 1, MID - 2, "dd"))
    # motion marks (yellow dashes, outlined by render so they read on light and dark): two on the swing side, one low on the other side (kept 2+ rows apart so the outlines do not merge)
    spec.append((6, MID + 9, "yy"))
    spec.append((10, MID + 10, "yy"))
    spec.append((13, MID - 9, "yy"))
    return canvas(spec, y + 2)


def cord_tile():
    im = Image.new("RGBA", (5, 4), (0, 0, 0, 0))
    ol = B.OUTLINE
    for y, mid in enumerate(["q", "c", "c", "q"]):
        im.putpixel((1, y), ol)
        im.putpixel((3, y), ol)
        im.putpixel((2, y), B.PAL[mid])
    return im


def bell_image(rows):
    im = B.render(rows)
    return im.crop((0, 1, im.width, im.height))  # drop the top margin row: the rope's top outline is the picture's top edge


def contact(imgs):
    scale = 8
    w = sum(i.width for i in imgs) * scale + 60 * len(imgs)
    h = max(i.height for i in imgs) * scale + 40
    sheet = Image.new("RGBA", (w * 2, h), (0, 0, 0, 255))
    d = ImageDraw.Draw(sheet)
    for half, bg in ((0, (236, 230, 216, 255)), (1, (30, 34, 46, 255))):
        d.rectangle([half * w, 0, (half + 1) * w - 1, h], fill=bg)
        x = half * w + 30
        for im in imgs:
            big = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
            sheet.alpha_composite(big, (x, 20))
            x += big.width + 60
    return sheet


if __name__ == "__main__":
    s, r = bell_image(still()), bell_image(ring())
    t = cord_tile()
    assert s.size == r.size
    s.save(os.path.join(OUT, "bell-hang.png"), compress_level=9)
    r.save(os.path.join(OUT, "bell-hang-ring.png"), compress_level=9)
    t.save(os.path.join(OUT, "bell-hang-cord.png"), compress_level=9)
    contact([s, r, t]).save(CONTACT, compress_level=9)
    print("wrote bell-hang", s.size, "bell-hang-ring", r.size, "bell-hang-cord", t.size)
