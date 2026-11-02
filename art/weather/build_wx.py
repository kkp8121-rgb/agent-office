"""Tiny weather tiles for the window overlays: assets/fx/wx-*.png.

  python art/weather/build_wx.py

Rain and snow tiles repeat in both directions and are moved along their own slope (one tile width left per tile height down),
so web/style.css can loop them with a single transform animation and no seam. Clouds repeat sideways, with gaps between them. Everything is 1 scene pixel per pixel.
"""
import os
import random

from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets", "fx")


def new(w, h):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def put(img, x, y, rgba):
    w, h = img.size
    img.putpixel((x % w, y % h), rgba)


def scatter(img, count, seed, min_gap, draw):
    """Calls draw(x, y) at `count` places at least `min_gap` apart (measured on the wrapped tile)."""
    rng = random.Random(seed)
    w, h = img.size
    spots = []
    tries = 0
    while len(spots) < count and tries < 20000:
        tries += 1
        x, y = rng.randrange(w), rng.randrange(h)
        if all(min(abs(x - sx), w - abs(x - sx)) ** 2 + min(abs(y - sy), h - abs(y - sy)) ** 2 >= min_gap ** 2 for sx, sy in spots):
            spots.append((x, y))
    for x, y in spots:
        draw(x, y)
    return len(spots)


def rain(path, w, h, count, length, head, tail_alpha, seed):
    img = new(w, h)

    def streak(x, y):
        for i in range(length):  # the head is the lowest pixel; the streak leans one pixel left per 3 rows going down
            a = int(tail_alpha[0] + (tail_alpha[1] - tail_alpha[0]) * i / (length - 1))
            put(img, x - i // 3, y + i, (*head, a))

    scatter(img, count, seed, length + 5, streak)
    img.save(path)


def snow(path, w, h, flakes, seed, big_share):
    img = new(w, h)
    rng = random.Random(seed + 1)

    def flake(x, y):
        if rng.random() < big_share:  # a plus-shaped 3x3 flake, brighter in the middle
            for dx, dy in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)):
                put(img, x + dx, y + dy, (255, 255, 255, 255 if (dx, dy) == (0, 0) else 190))
        elif rng.random() < 0.5:  # 2x2
            for dx in (0, 1):
                for dy in (0, 1):
                    put(img, x + dx, y + dy, (255, 255, 255, 235))
        else:
            put(img, x, y, (255, 255, 255, 215))

    scatter(img, flakes, seed, 9, flake)
    img.save(path)


def cloud(path, w, h, puffs, palette):
    """Union of ellipses (wrapped sideways), shaded by height: top light, middle base, bottom shade, flat underside."""
    light, mid, shade = palette
    mask = [[False] * w for _ in range(h)]
    top = [h] * w
    bot = [-1] * w
    for cx, cy, rx, ry in puffs:
        for off in (-w, 0, w):
            for y in range(h):
                for x in range(w):
                    if ((x - (cx + off) + 0.5) / rx) ** 2 + ((y - cy + 0.5) / ry) ** 2 <= 1:
                        mask[y][x] = True
    base = max(cy + ry * 0.35 for _, cy, _, ry in puffs)  # a flat underside
    img = new(w, h)
    for x in range(w):
        ys = [y for y in range(h) if mask[y][x] and y <= base]
        if not ys:
            continue
        top[x], bot[x] = min(ys), max(ys)
        span = max(1, bot[x] - top[x])
        for y in ys:
            t = (y - top[x]) / span
            img.putpixel((x, y), (*(light if t < 0.28 else mid if t < 0.68 else shade), 255))
    img.save(path)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    rain(os.path.join(OUT, "wx-rain-a.png"), 48, 144, 20, 9, (232, 244, 255), (60, 255), 11)
    rain(os.path.join(OUT, "wx-rain-b.png"), 32, 96, 14, 5, (190, 215, 245), (40, 170), 23)
    snow(os.path.join(OUT, "wx-snow-a.png"), 48, 144, 13, 5, 0.3)
    snow(os.path.join(OUT, "wx-snow-b.png"), 40, 100, 14, 9, 0.0)
    day = ((255, 255, 255), (232, 238, 248), (196, 208, 226))
    night = ((128, 140, 176), (98, 110, 146), (70, 80, 114))
    a = [(22, 22, 13, 9), (36, 17, 15, 11), (52, 22, 14, 8), (86, 23, 9, 6), (97, 19, 12, 9), (111, 23, 9, 6)]  # two separate clouds in a 144-wide tile
    b = [(20, 17, 9, 6), (31, 13, 11, 8), (44, 17, 10, 5)]  # one small cloud in a 88-wide tile
    cloud(os.path.join(OUT, "wx-cloud-a-day.png"), 144, 32, a, day)
    cloud(os.path.join(OUT, "wx-cloud-a-night.png"), 144, 32, a, night)
    cloud(os.path.join(OUT, "wx-cloud-b-day.png"), 88, 24, b, day)
    cloud(os.path.join(OUT, "wx-cloud-b-night.png"), 88, 24, b, night)
    for n in sorted(os.listdir(OUT)):
        if n.startswith("wx-"):
            print(n, os.path.getsize(os.path.join(OUT, n)), "bytes")
