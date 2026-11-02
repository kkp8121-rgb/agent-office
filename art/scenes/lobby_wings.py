"""Redraws the two LED wing screens and the three ticker strips of the lobby shell (scripted, deterministic, no Codex).

  python art/scenes/lobby_wings.py
Reads art/scenes/lobby-shell-v1.png (the first shell), writes assets/scenes/lobby/shell.png and
art/scenes/lobby-wings.json (the measured screen quads, scene px, for scene.json ledWall).
Then: python art/backdrop.py lobby, python art/scene_sheet.py lobby.

Why: in v1 the wing screens were smaller at the outer end (83 px) than at the inner end (101 px), so the outer ends
looked farther away and the wall read convex. The wing top edge follows the ceiling beam and cannot move up, so the
bottom edge is redrawn instead: outer end 88 px, inner end 73 px (ratio 1.2, bow-tie), the outer end is the tall one.
Tickers become 11 px strips (v1: 9 px) parallel to the wing bottom edge.
"""
import json
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, "lobby-shell-v1.png")
DST = os.path.join(ROOT, "assets", "scenes", "lobby", "shell.png")
OUT = os.path.join(HERE, "lobby-wings.json")
W = 1279

# v1 screens measured on lobby-shell-v1.png (tl, tr, br, bl). Left wing as drawn; right wing = mirror image of the left one.
OLD_L = [[218, 139.4], [397, 70.5], [397, 171.7], [218, 222.2]]
OLD_R = [[883, 71.8], [1061, 140.1], [1061, 222.7], [883, 171.6]]
OLD_TICK_L = [[218, 234.5], [392, 186.3], [392, 196.7], [218, 242.7]]
OLD_TICK_R = [[888, 186.7], [1062, 234.9], [1062, 243.7], [888, 196.8]]
B_OUT, B_IN = 227.0, 143.0      # new bottom edge of the navy area: outer end, inner end
TICK_GAP, TICK_H = 12.0, 11.0   # ticker navy top below the screen's navy bottom (5 px bezel + 3 px wood + 3 px bezel + 1), ticker navy height
RINGS = [(5, (13, 9, 6)), (4, (68, 55, 42)), (3, (78, 67, 54)), (2, (70, 64, 58)), (1, (21, 18, 12)), (0, (1, 30, 69))]
TRINGS = [(3, (51, 56, 51)), (2, (21, 18, 17)), (1, (0, 14, 39)), (0, (1, 30, 69))]
NAVY = (1, 30, 69)


def level(q, size, kmax):
    """Ring level of every pixel around quad q: 0 inside, 1..kmax outside (vertical distance to the slanted edges, horizontal to the vertical ones), -1 farther."""
    h, w = size[1], size[0]
    ys, xs = np.mgrid[0:h, 0:w]
    yc, xc = ys + 0.5, xs + 0.5
    (tl, tr, br, bl) = q
    yt = tl[1] + (tr[1] - tl[1]) * (xc - tl[0]) / (tr[0] - tl[0])
    yb = bl[1] + (br[1] - bl[1]) * (xc - bl[0]) / (br[0] - bl[0])
    o = np.maximum.reduce([yt - yc, yc - yb, tl[0] - xc, xc - tr[0]])
    lv = np.where(o <= 0, 0, np.ceil(o)).astype(int)
    lv[lv > kmax] = -1
    return lv


def paint(out, lv, table, sel=None):
    for k, col in table:
        m = lv == k
        if sel is not None:
            m &= sel
        out[m] = col


def line_y(a, b, x):
    return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])


def wing(img, old, oldt):
    """img: RGB numpy array, left-wing orientation (outer end at the left). Returns (new screen quad, new ticker quad)."""
    h, w, _ = img.shape
    size = (w, h)
    tl, tr, br, bl = old
    nbr, nbl = [tr[0], B_IN], [tl[0], B_OUT]
    new = [tl, tr, nbr, nbl]
    b = lambda x: line_y(nbl, nbr, x)
    t0, t1 = oldt[0][0], oldt[1][0]
    tq = [[t0, b(t0) + TICK_GAP], [t1, b(t1) + TICK_GAP], [t1, b(t1) + TICK_GAP + TICK_H], [t0, b(t0) + TICK_GAP + TICK_H]]
    old_m = (level(old, size, 8) >= 0) | (level(oldt, size, 9) >= 0)
    new_m = (level(new, size, 5) >= 0) | (level(tq, size, 3) >= 0)
    # 1. wipe: wood between the wood under the old screen and the wood under the old ticker, per column
    ys, xs = np.mgrid[0:h, 0:w]
    wipe = old_m & ~new_m
    out = img.copy()
    for x in range(w):
        col = np.where(wipe[:, x])[0]
        if not len(col):
            continue
        xc = min(max(x, t0), t1)
        y_gap = int(line_y(old[3], old[2], min(max(x, old[0][0]), old[1][0]))) + 8
        y_low = int(line_y(oldt[3], oldt[2], xc)) + 8
        c_gap = img[y_gap, max(x - 12, 0):x + 13].astype(float).mean(axis=0)
        c_low = img[y_low, max(x - 12, 0):x + 13].astype(float).mean(axis=0)
        for y in col:
            t = min(max((y - y_gap) / max(1, y_low - y_gap), 0), 1)
            out[y, x] = np.round(c_gap * (1 - t) + c_low * t)
    # 2. screen: new rings where the old ones do not fit (outside the old shape, or on the bottom band); the old top edge stays
    lv = level(new, size, 5)
    bot = ys >= (nbl[1] + (nbr[1] - nbl[1]) * (xs - nbl[0]) / (nbr[0] - nbl[0])) - 6
    top = ys < (tl[1] + (tr[1] - tl[1]) * (xs - tl[0]) / (tr[0] - tl[0])) + 6
    paint(out, lv, RINGS, ((level(old, size, 5) < 0) | bot) & ~top)
    # 3. ticker: three-pixel bezel, navy strip, parallel to the screen's bottom edge
    paint(out, level(tq, size, 3), TRINGS)
    return out, new, tq


def centre_ticker(arr, x0=459, x1=821, y0=183, y1=196):
    q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    paint(arr, level(q, (arr.shape[1], arr.shape[0]), 3), TRINGS)
    return arr, q


def mirror_q(q):
    return [[W - p[0], p[1]] for p in (q[1], q[0], q[3], q[2])]


def main():
    arr = np.array(Image.open(SRC).convert("RGB"))
    arr, left, tleft = wing(arr, OLD_L, OLD_TICK_L)
    flipped = arr[:, ::-1].copy()
    flipped, rm, trm = wing(flipped, mirror_q(OLD_R), mirror_q(OLD_TICK_R))
    arr = flipped[:, ::-1].copy()
    right, tright = mirror_q(rm), mirror_q(trm)
    arr, tc = centre_ticker(arr)
    Image.fromarray(arr).save(DST)
    rnd = lambda q: [[round(p[0], 1), round(p[1], 1)] for p in q]
    json.dump({"left": rnd(left), "right": rnd(right), "tickerLeft": rnd(tleft), "tickerRight": rnd(tright), "tickerCenter": tc}, open(OUT, "w"))
    print(open(OUT).read())


if __name__ == "__main__":
    main()
