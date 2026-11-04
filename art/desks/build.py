"""Desk and chair art that the seated pose needs (assets/scenes/<design>/objects.png). Starts from art/desks/orig/<design>.png, so it can be run again.

  python art/desks/build.py [lobby] [lounge] [greenhouse]      (default: all)

lobby: the monitor backs stand in the middle of the desk, between the viewer and the figure who sits behind it.
  - desk-b: the existing monitor back (it stood at the right end) moves to the middle; its old place is plain desk top again.
  - desk (the laptop desk): the flat closed laptop becomes an open laptop seen from behind: a lid back in the monitor's own colours, with the back edge of the
    keyboard deck under it. The sprite grows 4 rows upward (rect y 93 -> 89, the rows above it are empty in the atlas), the anchor moves down by 4.
lounge: the diagonal desk (rect [257, 0, 92, 73]) had its monitor at the left end and the seat at the right, so the monitor stood beside the figure. The monitor with its
    keyboard and shadows moves 23 right and 12 down along the desk so it stands between the viewer and the figure; the plant moves to the old monitor place.
    The decor slots of the lounge desk (assets/decor/decor.json) move with the monitor.
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


LOUNGE_BOX = (257, 0, 92, 73)  # the desk rect in the atlas
WOOD = {(250, 163, 46), (250, 159, 42), (247, 153, 41), (251, 171, 56), (235, 141, 38), (234, 163, 54), (208, 112, 28)}  # desk top colours
GREY = {(42, 44, 36), (36, 38, 31), (30, 32, 26), (26, 24, 18), (55, 58, 48), (75, 78, 66), (46, 48, 40), (26, 27, 22), (23, 23, 18), (37, 38, 32), (34, 35, 29), (29, 30, 25)}
KEYS = {(69, 66, 47), (55, 45, 31), (52, 40, 26)}
LEAF = {(31, 25, 16), (147, 112, 34), (137, 92, 33)}
LOUNGE_MONITOR_MOVE = (23, 12)  # monitor, keyboard and their shadows
LOUNGE_PLANT_MOVE = (-32, -12)


def lounge(im):
    ox, oy, w, h = LOUNGE_BOX
    px = im.load()
    src = im.copy().load()

    def col(x, y):
        p = src[ox + x, oy + y]
        return p[:3] if p[3] else None

    def top_min(x):  # upper edge of the desk top: the left slope, then the back edge
        return max(15 - 0.52 * (x - 1), 1 + 0.53 * (x - 28))

    def top_max(x):  # lower edge: the front edge, then the right end
        return min(15 + 0.53 * (x - 1), 48.5 - 0.54 * (x - 64))

    def inside(x, y):  # on the desk top, one pixel off the outline
        return 1 <= x <= 90 and top_min(x) + 1 <= y <= top_max(x) - 1

    def hull(colours, xs, ys):  # every pixel between the first and the last pixel of those colours in a column
        out = set()
        for x in xs:
            hit = [y for y in ys if col(x, y) in colours]
            if hit:
                out.update((x, y) for y in range(min(hit), max(hit) + 1))
        return out

    stuff = {(x, y) for y in range(h) for x in range(w) if inside(x, y) and col(x, y) is not None and col(x, y) not in WOOD}  # props and their shadows
    mon = {p for p in stuff if p[0] <= 51} | hull(GREY, range(22, 52), range(0, 36))
    key = ({p for p in stuff if 52 <= p[0] <= 63 and p[1] <= 28 and p not in mon} | hull(GREY | KEYS, range(52, 64), range(15, 27))) - mon
    leaf = ({p for p in stuff if p[0] >= 62 and 20 <= p[1] <= 44 and p not in mon and p not in key} | hull(LEAF | GREY | KEYS, range(62, 81), range(22, 43))) - mon - key
    assert len(stuff - mon - key - leaf) == 0

    def grown(pts, r):
        out = set(pts)
        for (x, y) in pts:
            out.update((x + a, y + b) for a in range(-r, r + 1) for b in range(-r, r + 1) if inside(x + a, y + b))
        return out

    clear = grown(mon, 2) | grown(key, 1) | grown(leaf, 1)
    slope = 33 / 63  # the desk's long axis; plain desk top is copied from along it, which keeps the grain bands

    def plain(x, y):
        for sign in (1, -1):
            for s in range(1, 70):
                nx, ny = x + sign * s, y + sign * round(slope * s)
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in clear and col(nx, ny) in WOOD:
                    return src[ox + nx, oy + ny]
        raise ValueError((x, y))

    for (x, y) in clear:
        px[ox + x, oy + y] = plain(x, y)
    for pts, (dx, dy) in ((mon, LOUNGE_MONITOR_MOVE), (key, LOUNGE_MONITOR_MOVE), (leaf, LOUNGE_PLANT_MOVE)):
        for (x, y) in pts:
            if inside(x + dx, y + dy):
                px[ox + x + dx, oy + y + dy] = src[ox + x, oy + y]
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
    want = argv or ["lobby", "lounge", "greenhouse"]
    for design in want:
        im = Image.open(os.path.join(ORIG, f"{design}.png")).convert("RGBA")
        im = {"lobby": lobby, "lounge": lounge, "greenhouse": greenhouse}[design](im)
        im.save(os.path.join(OUT, design, "objects.png"))
        print(f"{design}: {im.size}")


if __name__ == "__main__":
    main(sys.argv[1:])
