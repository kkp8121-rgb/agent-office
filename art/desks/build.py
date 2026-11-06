"""Desk and chair art that the seated pose needs (assets/scenes/<design>/objects.png). Starts from art/desks/orig/<design>.png, so it can be run again.

  python art/desks/build.py [lobby] [lounge] [greenhouse]      (default: all)

lobby: the monitor stands on one side of the desk, as big next to the seated figure as on the floors (see the LOBBY_* constants below).
  - desk-b: the old monitor (it stood at the right end) is erased; the greenhouse desk's monitor back (34 wide, panel 19 rows) stands in the right half.
    The sprite grows 10 rows upward (rect y 93 -> 83): its top is the monitor's top, so the seat check (figure top 28 rows above the sprite top) still holds.
  - desk (the laptop desk): the flat closed laptop is erased; an open laptop seen from behind (lid 30 wide, 20 rows, the same body pixels, back edge of the deck
    under it) stands in the left half. The sprite grows 13 rows upward (rect y 93 -> 80).
  Then: rects and anchors in scene.json, monitors.lobby in assets/nightmap/nightmap.json (and node scripts/make-nightmap.mjs), the lobby slots in assets/decor/decor.json.
lounge: the diagonal desk (rect [257, 0, 92, 73]) had its monitor at the left end and the seat at the right, so the monitor stood beside the figure. The monitor with its
    keyboard and shadows moves 23 right and 12 down along the desk so it stands between the viewer and the figure; the plant moves to the old monitor place.
    The decor slots of the lounge desk (assets/decor/decor.json) move with the monitor.
greenhouse: the open table (legs only) shows what is under it, so the office chair of its desks gets a long stem and its star base is lowered 16 rows
    (kind chair-open, a new rect under the old chair; the atlas grows by 13 rows at the bottom). The chair of the lead desk (front panel) is not changed.
"""
import json
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


# ---- lobby desks: the monitor stands on one side of the desk, as large as on the floors ----
# On the floors the monitor panel is about 0.37 of the seated figure's height (the panel of the straight desks is 16..21 rows, the figure 50 rows; the lobby
# figure is the same 50 rows). The old lobby monitor was 9 rows (0.18). So the lobby desks take the monitor back of the greenhouse desk pixel for pixel
# (assets/scenes/greenhouse/objects.png: 34 wide, panel 19 rows, stand 5 rows with one neck row left out so the sprite is not taller than the seat check
# allows: the seated figure's top must be 28 rows above the desk sprite's top, config depth.seatShowPx). It stands in the right half of desk-b (the notebook and
# pencil cup stay at the left), the laptop lid (30 wide, the same panel rows) in the left half of the laptop desk (the mug stays at the right), so the figure
# behind the desk (centred on it) shows head and face; desks the scene mirrors (flipX) mirror the monitor too.
LOBBY_DESKB = (222, 93, 76, 32)  # the orig rect of desk-b
LOBBY_LAPTOP = (299, 93, 76, 27)  # the orig rect of the laptop desk
LOBBY_HEAD_B = 10  # rows desk-b grows upward (rows 72..92 of the atlas are empty above it): its top is the monitor's top, as on the floors
LOBBY_HEAD_L = 13  # rows the laptop desk grows upward (rows 63..92 are empty above it): its top is the lid's top
MON_SRC = ("greenhouse", "desk", (22, 0, 56, 26))  # design, kind, [x0, y0, x1, y1) of the monitor back with its neck and foot inside the kind's rect
MON_PANEL = 20  # template rows 0..19 are the panel (19 rows and its bottom edge), rows 20.. the stand
MON_STAND_DROP = 21  # a neck row (the same as the next one) left out
MON_X_B = 40  # left column of the monitor in desk-b
LID_COLS = (24, 25, 52, 53)  # source columns left out of the lid (plain body, left and right of the vents), so it is 30 wide
LID_X = 5  # left column of the lid in the laptop desk


def is_monitor_px(p):
    r, g, b, a = p
    return a >= 40 and r + g + b < 330 and max(r, g, b) - min(r, g, b) < 60


def monitor_template():
    """The greenhouse desk's monitor back as {(x, y): rgba}: panel rows 0..19, then the stand rows 20..25; desk-coloured pixels are left out."""
    design, kind, (x0, y0, x1, y1) = MON_SRC
    scene = json.load(open(os.path.join(OUT, design, "scene.json"), encoding="utf-8"))
    rx, ry = scene["kinds"][kind]["rect"][:2]
    atlas = Image.open(os.path.join(OUT, design, "objects.png")).convert("RGBA")
    return {(x - x0, y - y0): atlas.getpixel((rx + x, ry + y)) for y in range(y0, y1) for x in range(x0, x1) if is_monitor_px(atlas.getpixel((rx + x, ry + y)))}


def monitor_back(tpl, lid=False):
    """The monitor back as {(x, y): rgba} and its height in rows: the panel and the stand (no neck, no stand and 4 columns fewer for the lid)."""
    out = {(x, y): v for (x, y), v in tpl.items() if y < MON_PANEL}
    if lid:
        for (x, y) in [k for k in out if 13 <= k[0] <= 20 and k[1] >= 9]:  # the neck: the body pixel of the same row, 8 columns to the left, takes its place
            out[(x, y)] = out[(x - 8, y)]
        keep = [c for c in range(34) if c + 22 not in LID_COLS]
        return {(keep.index(x), y): v for (x, y), v in out.items() if x in keep}, MON_PANEL
    for (x, y), v in tpl.items():
        if y >= MON_PANEL and y != MON_STAND_DROP:
            out[(x, y - (1 if y > MON_STAND_DROP else 0))] = v
    return out, max(y for _, y in out) + 1


def lobby(im):
    px = im.load()
    src = im.copy().load()  # the untouched atlas
    tpl = monitor_template()
    # ---- desk-b: orig rect [222, 93, 76, 32] -> [222, 83, 76, 42] ----
    ox, oy, dw, dh = LOBBY_DESKB
    g = LOBBY_HEAD_B
    ny = oy - g
    mon = {}  # (x, y) inside the orig sprite -> colour: the old monitor back with its neck and foot (it stood at the right end)
    for y in range(0, 14):
        for x in range(54, 72):
            p = src[ox + x, oy + y]
            if p[3] >= 40 and not is_orange(p):
                mon[(x, y)] = p
    for (x, y) in list(mon):  # rows 11..13: only the neck and foot (the rest is desk top that happens to be dark brown)
        if y >= 11 and not (58 <= x <= 66):
            del mon[(x, y)]
    fill = {y: src[ox + 49, oy + y] for y in range(7, 15)}  # plain desk top just left of the old monitor, per row
    for y in range(ny, oy + dh):
        for x in range(ox, ox + dw):
            px[x, y] = CLEAR
    for y in range(dh):
        for x in range(dw):
            px[ox + x, ny + g + y] = src[ox + x, oy + y]
    for (x, y) in mon:
        px[ox + x, ny + g + y] = fill[y] if y >= 7 else CLEAR
    new_mon, mon_h = monitor_back(tpl)
    top = g + 14 - (mon_h - 1)  # the foot ends on the last desk-top row (14); the front lip is the next row
    for (x, y), p in new_mon.items():
        px[ox + MON_X_B + x, ny + top + y] = p
    # ---- the laptop desk: orig rect [299, 93, 76, 27] -> [299, 80, 76, 40] ----
    sx, sy, lw, lh0 = LOBBY_LAPTOP
    gl = LOBBY_HEAD_L
    ly = sy - gl
    old = im.crop((sx, sy, sx + lw, sy + lh0))
    for y in range(ly, sy + lh0):
        for x in range(sx, sx + lw):
            px[x, y] = CLEAR
    im.paste(old, (sx, ly + gl))
    for y in range(3, 8):  # remove the flat laptop (old cols 22..39, rows 3..7): desk top copied from old cols 44..61 of the same row
        for x in range(22, 40):
            px[sx + x, ly + gl + y] = old.getpixel((x + 22, y))
    lid, lid_h = monitor_back(tpl, lid=True)
    lid_top = gl + 6 - (lid_h - 1)  # the lid's last row is old row 6; the deck takes old rows 7 and 8, the last desk-top rows
    for (x, y), p in lid.items():
        px[sx + LID_X + x, ly + lid_top + y] = p
    # the back edge of the keyboard deck under the lid: 2 rows, 3 wider than the lid on each side, in the monitor's body colours (shade, outline)
    lid_w = 34 - len(LID_COLS)
    deck = [tpl[(15, 16)], tpl[(15, 19)]]
    for dy, c in enumerate(deck):
        for x in range(LID_X - 3, LID_X + lid_w + 3):
            px[sx + x, ly + gl + 7 + dy] = tpl[(15, 19)] if x in (LID_X - 3, LID_X + lid_w + 2) else c
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
