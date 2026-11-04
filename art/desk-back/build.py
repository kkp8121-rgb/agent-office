"""Redraw the monitor backs in assets/scenes/<design>/objects.png so they read as backs.

  python art/desk-back/build.py [design ...]      (default: every design)

The seated character looks at the screen, so the viewer sees the back of the monitor: a rounded housing, lit along its
top edge and darker toward the bottom, a small vent, a round mount hub where the stand neck meets the back. No outlined
rectangle (that read as a small screen with a bezel). Each design keeps its own palette: every colour is a ramp of the
panel colour that was already in the sprite, the dark outline colour is the sprite's own.

Footprint, position and base plate stay as they were; only the panel (back housing) and the stand neck are repainted.
Originals live in art/desk-back/orig/<design>.png; the script always starts from them, so it can be run again.
Decor points (assets/decor/decor.json) refer to the panel box, which does not move.
"""
import os
import shutil
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ORIG = os.path.join(ROOT, "art", "desk-back", "orig")


def mul(c, f, add=0):
    return tuple(max(0, min(255, round(v * f + add))) for v in c[:3]) + (255,)


def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3)) + (255,)


class Pal:
    def __init__(self, base, dark, warm=0.0):
        self.B = base + (255,)
        self.D = dark + (255,)
        self.H1 = mul(base, 1.55, 10)      # lit top rim
        self.H2 = mul(base, 1.22, 4)       # soft light below the rim, left edge
        self.L = mul(base, 1.1)
        self.S1 = mul(base, 0.86)
        self.S2 = mul(base, 0.72)
        self.S3 = mix(mul(base, 0.5), dark, 0.35)   # vent slits
        self.S4 = mul(base, 0.62)          # bottom rows


# design -> kind -> (atlas origin, panel l r t b, centre x, neck half width, neck bottom row, hub row, vent slits, vent half width)
SPECS = {
    "studio2": {
        "pal": Pal((71, 86, 87), (23, 19, 20)),
        "desk": dict(o=(0, 90), l=28, r=56, t=0, b=18, cx=42, nh=2, ny1=19, hy=12, slits=3, vw=4),
        "lead": dict(o=(340, 0), l=40, r=69, t=0, b=19, cx=55, nh=3, ny1=22, hy=13, slits=3, vw=5),
    },
    "library": {
        "pal": Pal((52, 52, 49), (36, 28, 22)),
        "desk": dict(o=(79, 0), l=24, r=50, t=0, b=17, cx=37, nh=2, ny1=19, hy=11, slits=3, vw=4),
        "lead": dict(o=(163, 0), l=41, r=67, t=0, b=16, cx=54, nh=3, ny1=18, hy=10, slits=3, vw=4),
    },
    "greenhouse": {
        "pal": Pal((56, 58, 56), (37, 27, 18)),
        "desk": dict(o=(355, 0), l=22, r=55, t=0, b=19, cx=39, nh=2, ny1=21, hy=12, slits=3, vw=5),
        "lead": dict(o=(250, 0), l=34, r=70, t=0, b=21, cx=52, nh=3, ny1=23, hy=14, slits=3, vw=5),
    },
    "lounge": {
        "pal": Pal((42, 44, 36), (26, 24, 18)),
        "desk": dict(o=(257, 0), l=26, r=51, cx=39, nh=2, ny1=33, hy=19, slits=3, vw=4,
                     top=lambda x: 4 + int(0.47 * (x - 27)) if x > 26 else 5, bot=lambda x: 20 + int(0.47 * (x - 26))),
        "lead": dict(o=(113, 0), l=41, r=66, cx=54, nh=2, ny1=34, hy=25, slits=3, vw=4,
                     top=lambda x: 10 + (x - 42) // 2 if x > 41 else 10, bot=lambda x: 26 + (x - 41) // 2),
    },
    "lobby": {
        "pal": Pal((55, 55, 51), (40, 30, 24)),
        "deskb": dict(o=(222, 93), l=54, r=69, t=1, b=10, cx=62, nh=1, ny1=11, hy=7, slits=2, vw=3, small=True),
    },
}


def paint(px, pal, s, bg):
    ox, oy = s["o"]
    l, r, cx = s["l"], s["r"], s["cx"]
    slab = "top" in s  # isometric slab: the top and bottom edges slope, one row per two columns
    T = (lambda x: s["top"](x)) if slab else (lambda x: s["t"])
    Bm = (lambda x: s["bot"](x)) if slab else (lambda x: s["b"])
    t, b = T(l), Bm(l)
    small = s.get("small", False)

    def put(x, y, c):
        px[ox + x, oy + y] = c

    corner = set()
    rad = 1 if small or slab else 2
    for k in range(rad):
        for j in range(rad - k):
            corner |= {(l + k, T(l + k) + j), (r - k, T(r - k) + j)}

    for x in range(l, r + 1):
        for y in range(T(x), Bm(x) + 1):
            if (x, y) in corner:
                put(x, y, (0, 0, 0, 0))
                continue
            dt, db, dl, dr = y - T(x), Bm(x) - y, x - l, r - x
            H = Bm(x) - T(x) + 1
            u = dt / max(1, H - 1)
            if db == 0 or dr == 0:
                c = pal.D
            elif dt == 0:
                c = pal.H1
            elif dt == 1:
                c = pal.H2
            elif dl == 0:
                c = pal.H2
            elif dr == 1:
                c = pal.S2
            elif db == 1:
                c = pal.S4
            elif u < 0.4:
                c = pal.B
            elif u < 0.6:
                c = pal.S1 if (x + y) % 2 == 0 or u > 0.5 else pal.B
            elif u < 0.82:
                c = pal.S1 if dr > 2 else pal.S2
            else:
                c = pal.S2
            put(x, y, c)

    # bottom corners: one pixel of the surface behind the housing, so the lower corners are soft too
    if not small and not slab:
        for x, nx in ((l, l - 1), (r, r + 1)):
            px[ox + x, oy + b] = bg[ox + nx, oy + b]

    # vent slits
    for i in range(s["slits"]):
        for x in range(cx - s["vw"], cx + s["vw"] + 1):
            put(x, T(x) + (2 if small else 3) + 2 * i, pal.S3)

    # stand neck: from the hub down past the bottom edge to the base plate
    hy, nh, ny1 = s["hy"], s["nh"], s["ny1"]
    for y in range(hy, ny1 + 1):
        below = y > Bm(cx)
        for x in range(cx - nh, cx + nh + 1):
            if x == cx - nh:
                c = pal.D if below else pal.L
            elif x == cx + nh:
                c = pal.D if below else pal.S2
            elif x == cx - nh + 1:
                c = pal.L
            elif x == cx + nh - 1:
                c = pal.S1
            else:
                c = pal.B
            if below and y == Bm(cx) + 1 and x not in (cx - nh, cx + nh):
                c = mul(c, 0.8)
            put(x, y, c)

    # hub: a round mount where the neck meets the back; light on the upper left, shade on the lower right, no outline
    shape = [(-1, 1), (-2, 2), (-2, 2), (-2, 2), (-1, 1)] if small is False else [(-1, 1), (-1, 1), (-1, 1)]
    top = hy - (2 if not small else 1)
    for i, (a, z) in enumerate(shape):
        for dx in range(a, z + 1):
            x, y = cx + dx, top + i
            d = dx + (i - len(shape) // 2)
            c = pal.H1 if d <= -2 else (pal.H2 if d == -1 else (pal.S2 if d >= 3 else (pal.S1 if d == 2 else pal.L)))
            put(x, y, c)
    put(cx, hy, pal.S3)  # screw


def main():
    designs = sys.argv[1:] or list(SPECS)
    os.makedirs(ORIG, exist_ok=True)
    for d in designs:
        p = os.path.join(ROOT, "assets", "scenes", d, "objects.png")
        bk = os.path.join(ORIG, d + ".png")
        if not os.path.exists(bk):
            shutil.copy(p, bk)
        im = Image.open(bk).convert("RGBA")
        px = im.load()
        bg = Image.open(bk).convert("RGBA").load()
        pal = SPECS[d]["pal"]
        for k, s in SPECS[d].items():
            if k != "pal":
                paint(px, pal, s, bg)
        im.save(p)
        print(d, "ok")


if __name__ == "__main__":
    main()
