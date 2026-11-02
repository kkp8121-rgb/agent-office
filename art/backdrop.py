"""Write the room outline (scene.json "outline") that dark mode uses to darken the painted backdrop around a room.

  python art/backdrop.py <design> [--inset 2] [--tol 48] [--check]

The shell is an opaque picture: the room floats on a painted backdrop. This floods the backdrop from the
picture border (colour within --tol of the border median), takes the rest as the room, shrinks it by --inset
pixels (so the antialiased fringe of the room's dark rim falls on the cover side), traces its border and
simplifies it to a polygon. The page paints a dark cover everywhere outside that polygon in dark mode only.
Needs numpy and Pillow.
"""
import json
import os
import re
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENES = os.environ.get("AGENT_OFFICE_SCENES_DIR") or os.path.join(ROOT, "assets", "scenes")


def backdrop_mask(rgb, tol):
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).astype(int)
    ref = np.median(border, axis=0)
    near = np.abs(rgb.astype(int) - ref).sum(axis=2) <= tol
    seen = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and near[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True; q.append((ny, nx))
    return seen, ref


def erode(m, k):
    for _ in range(k):
        p = np.pad(m, 1, constant_values=False)
        m = m & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:] & p[:-2, :-2] & p[:-2, 2:] & p[2:, :-2] & p[2:, 2:]
    return m


def trace(m):
    """Pixel-corner boundary of the biggest 4-connected blob, as a closed list of corner points."""
    h, w = m.shape
    ys, xs = np.nonzero(m)
    # edges between inside and outside, directed so that inside is on the right
    nxt = {}
    p = np.pad(m, 1, constant_values=False)
    for y, x in zip(ys, xs):
        if not p[y, x + 1]:      # top edge
            nxt[(x, y)] = (x + 1, y)
        if not p[y + 1, x + 2]:  # right edge
            nxt[(x + 1, y)] = (x + 1, y + 1)
        if not p[y + 2, x + 1]:  # bottom edge
            nxt[(x + 1, y + 1)] = (x, y + 1)
        if not p[y + 1, x]:      # left edge
            nxt[(x, y + 1)] = (x, y)
    best = []
    seen = set()
    for s in list(nxt):
        if s in seen:
            continue
        loop, c = [], s
        while c not in seen and c in nxt:
            seen.add(c); loop.append(c); c = nxt[c]
        if len(loop) > len(best):
            best = loop
    return best


def simplify(pts, eps):
    """Douglas-Peucker on a closed ring (split at the point farthest from the first)."""
    def dp(seg):
        (ax, ay), (bx, by) = seg[0], seg[-1]
        dx, dy = bx - ax, by - ay
        n = (dx * dx + dy * dy) ** 0.5 or 1
        far, idx = -1, 0
        for i in range(1, len(seg) - 1):
            dist = abs(dy * seg[i][0] - dx * seg[i][1] + bx * ay - by * ax) / n
            if dist > far:
                far, idx = dist, i
        if far > eps:
            return dp(seg[:idx + 1])[:-1] + dp(seg[idx:])
        return [seg[0], seg[-1]]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    return dp(pts[:far + 1])[:-1] + dp(pts[far:] + [pts[0]])[:-1]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opt = {a.split("=")[0]: a.split("=")[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}
    design = args[0]
    inset, tol, eps = int(opt.get("--inset", 2)), int(opt.get("--tol", 48)), float(opt.get("--eps", 0.8))
    d = os.path.join(SCENES, design)
    sp = os.path.join(d, "scene.json")
    scene = json.load(open(sp, encoding="utf-8"))
    rgb = np.array(Image.open(os.path.join(d, scene.get("shell", "shell.png"))).convert("RGB"))
    back, ref = backdrop_mask(rgb, tol)
    room = erode(~back, inset)
    ring = trace(room)
    poly = simplify(ring, eps)
    # self-check: the polygon must lie inside the eroded room, and no backdrop pixel may be inside it
    img = Image.new("L", (rgb.shape[1], rgb.shape[0]), 0)
    ImageDraw.Draw(img).polygon(poly, fill=255)
    hole = np.array(img) > 0
    leak = int((hole & back).sum())
    lost = int((room & ~hole).sum())
    fringe = int((hole & (np.abs(rgb.astype(int) - ref).sum(axis=2) <= tol * 2) & ~erode(hole, 3)).sum())
    print(f"{design}: ref={ref.astype(int).tolist()} backdrop={int(back.sum())}px room={int((~back).sum())}px points={len(poly)} backdrop-inside-hole={leak} room-px-covered-extra={lost} backdrop-like-px-at-hole-rim={fringe}")
    if "--check" in sys.argv:
        return
    # edit the text, not the parsed data, so the rest of the file keeps its formatting
    text = open(sp, encoding="utf-8").read()
    line = json.dumps([[int(x), int(y)] for x, y in poly], separators=(",", ":"))
    if '"outline"' in text:
        text = re.sub(r'"outline"\s*:\s*\[\[[-0-9,\[\]\s]*\]\]', lambda m: '"outline":' + line, text, count=1)
    else:
        end = text.rstrip().rfind("}")
        text = text[:end].rstrip() + ',' + chr(10) + ' "outline":' + line + chr(10) + text[end:]
    open(sp, "w", encoding="utf-8", newline=chr(10)).write(text)


if __name__ == "__main__":
    main()
