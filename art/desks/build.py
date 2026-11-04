"""Desk and chair art that the seated pose needs (assets/scenes/<design>/objects.png). Starts from art/desks/orig/<design>.png, so it can be run again.

  python art/desks/build.py [lobby] [greenhouse]      (default: both)

lobby: the monitor backs stand in the middle of the desk, between the viewer and the figure who sits behind it.
  - desk-b: the existing monitor back (it stood at the right end) moves to the middle; its old place is plain desk top again.
  - desk (the laptop desk): the flat closed laptop becomes an open laptop seen from behind: a lid back in the monitor's own colours, with the back edge of the
    keyboard deck under it. The sprite grows 4 rows upward (rect y 93 -> 89, the rows above it are empty in the atlas), the anchor moves down by 4.
greenhouse: the open table (legs only) shows what is under it, so the office chair of its desks gets a long stem and its star base is lowered 16 rows
    (kind chair-open, a new rect under the old chair; the atlas grows by 13 rows at the bottom). The chair of the lead desk (front panel) is not changed.
"""
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ORIG = os.path.join(ROOT, "art", "desks", "orig")
OUT = os.path.join(ROOT, "assets", "scenes")
CLEAR = (0, 0, 0, 0)


def is_orange(p):
    r, g, b, a = p
    return a >= 40 and r >= 140 and r - b >= 70


def lobby(im):
    px = im.load()
    src = im.copy().load()  # the untouched atlas: the lid is cut from the monitor before the monitor moves
    # ---- desk-b: rect [222, 93, 76, 32] ----
    ox, oy = 222, 93
    mon = {}  # (x, y) inside the sprite -> colour, the monitor back with its neck and foot
    for y in range(0, 14):
        for x in range(54, 72):
            p = src[ox + x, oy + y]
            if p[3] >= 40 and not is_orange(p):
                mon[(x, y)] = p
    # keep only the neck and foot part of rows 11..13 (the rest of those rows is desk top that happens to be dark brown)
    for (x, y) in list(mon):
        if y >= 11 and not (58 <= x <= 66):
            del mon[(x, y)]
    fill = {y: px[ox + 49, oy + y] for y in range(7, 15)}  # plain desk top just left of the monitor, per row
    for (x, y) in mon:
        px[ox + x, oy + y] = fill[y] if y >= 7 else CLEAR
    dx = 29 - 54  # monitor centre (x 54..71) -> 37.5, the middle of the 76 wide desk
    for (x, y), p in mon.items():
        px[ox + x + dx, oy + y] = p
    # ---- desk (laptop): rect [299, 93, 76, 27] -> [299, 89, 76, 31] ----
    sx, sy = 299, 93
    old = im.crop((sx, sy, sx + 76, sy + 27))
    for y in range(89, 120):
        for x in range(sx, sx + 76):
            px[x, y] = CLEAR
    im.paste(old, (sx, 89 + 4))
    # remove the flat laptop (old cols 22..39, rows 3..7): desk top copied from old cols 44..61 of the same row
    for y in range(3, 8):
        for x in range(22, 40):
            px[sx + x, 89 + 4 + y] = old.getpixel((x + 22, y))
    # the lid back: the monitor panel of desk-b (18 wide), 9 rows (rows 0..2 and 5..10 of the panel), no stand
    panel = [(x, y) for y in range(0, 11) for x in range(54, 72)]
    rows = [0, 1, 2, 3, 5, 7, 8, 9, 10]
    lx = sx + 29  # lid centred on the desk (cols 29..46)
    ly = 89 + 2  # lid rows 2..10 of the new sprite
    for k, ry in enumerate(rows):
        for x in range(54, 72):
            p = src[ox + x, oy + ry]
            if p[3] >= 40 and not is_orange(p):
                px[lx + (x - 54), ly + k] = p
            else:
                px[lx + (x - 54), ly + k] = px[lx + (x - 54), ly + k] if px[lx + (x - 54), ly + k][3] else CLEAR
    # the back edge of the keyboard deck under the lid (2 rows, 20 wide, in the monitor's dark body colours)
    dark = src[ox + 60, oy + 9]
    body = src[ox + 60, oy + 8]
    for x in range(28, 48):
        px[sx + x, 89 + 4 + 6] = body
        px[sx + x, 89 + 4 + 7] = dark
    return im


def greenhouse(im):
    ox, oy, w, h = 218, 81, 35, 50
    d = 16  # rows the base moves down
    out = Image.new("RGBA", (im.width, 148), CLEAR)
    out.paste(im, (0, 0))
    px = out.load()
    for y in range(oy, oy + h + d):
        for x in range(ox, ox + w):
            px[x, y] = CLEAR
    chair = im.crop((ox, oy, ox + w, oy + h))
    top = 36  # rows 0..35 stay (seat, stem start); the stem repeats d rows; old rows 36.. move down by d
    for y in range(top):
        for x in range(w):
            px[ox + x, oy + y] = chair.getpixel((x, y))
    for y in range(top, top + d):
        for x in range(15, 20):
            px[ox + x, oy + y] = chair.getpixel((x, 35))
    for y in range(top, h):
        for x in range(w):
            px[ox + x, oy + y + d] = chair.getpixel((x, y))
    return out


def main(argv):
    want = argv or ["lobby", "greenhouse"]
    for design in want:
        im = Image.open(os.path.join(ORIG, f"{design}.png")).convert("RGBA")
        im = {"lobby": lobby, "greenhouse": greenhouse}[design](im)
        im.save(os.path.join(OUT, design, "objects.png"))
        print(f"{design}: {im.size}")


if __name__ == "__main__":
    main(sys.argv[1:])
