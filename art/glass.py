"""Cuts the window glass out of a room shell, so the outside view painted under the shell shows through.

  python art/glass.py <room> [--preview OUT.png] [--dry]

Reads art/glass.json[room] and assets/scenes/<room>/scene.json (`windows`, `view`):
  mode "poly"    the hole is every window polygon grown by `grow` px (rooms whose panes have no bars: studio2).
  mode "colour"  polygon grown by `grow` px minus frame colours (bars and sills: lounge, library). Frame = brownish (R-B > 22 and R-G > 10)
                 or very dark (max channel < 75), the rest is glass; 3x3 closing keeps yellow flowers and similar glass pixels.
  mode "flood"   greenhouse: glass is every coloured pixel (saturation > .16 or blue) of a connected area of at least `minArea` px above `maxY`
                 inside the `zones` boxes and the window polygons grown by `grow` px and inside the room outline, each area closed by
                 `close` px so clouds, white flowers and glints inside the glass are not holes. Hanging plants (dark green outlines, which the
                 painted garden has not) are found inside the hand boxes `plants` and left out.
  `plantReach` / `plantDens` (flood): how tightly the plant outline blob is cut (default 4 px / .07; greenhouse 2 / .25, so the pasted pieces of
                 old picture around the hanging plants become glass); `islands` N: opaque pieces of at most N px cut off from everything else are old-picture specks and become glass.
  `rim` (poly): {"band": k, "max": m, "rb": d}: the polygons are drawn on the frame, so within `band` px of a polygon edge frame-coloured pixels (dark brown or grey:
                 max channel <= `max`, R - B >= `rb`, G <= R + 5) stay in the shell instead of being cut (studio2: the window rims); blue-ish pixels (B - R > `bleed`, 20) next to the hole are old glass and join it.
  `members`: the frame members (beams, posts, rails, sills) that must run unbroken, {"name", "axis": "v"|"h", "box": [x0, y0, x1, y1], "ref": [a, b]}.
                 After the hole is cut, every gap pixel of a member (see frame_check.py: alpha 0 or a colour far from the member's own profile; hanging
                 plants, nibbled edges, cut-out vine strands) is rebuilt from the member itself: it takes the pixel at the same cross-section offset from the
                 nearest intact pixel along the member, or, with `ref` (an intact span along the member), from that span mirrored outward from its end.
                 python art/frame_check.py <room> counts what is left (must be 0).
  `subtract` / `add`: hand polygons removed from / added to the hole (hanging plants painted into the shell, door handles).
  `cuts`: old-picture leftovers that the hole missed, because they sit in small panes closed off by frame pieces (the triangles between roof struts), or
                 hang beside a plant: {"name", "box": [x0, y0, x1, y1] or "spans": [[y, x0, x1], ...] (inclusive; only these pixels), "where": [...], "keep": n}.
                 Applied last, after the ring clean-up, so no pixel outside the cut changes. A pixel is cut when it is opaque and matches one of `where`
                 ("all", "sky" blue, "green", "yellow", "pale" light green, "black"), unless its brightest channel is <= `keep` (dark frame outline).
Writes shell.png as RGBA: alpha 0 on the glass, the old picture's RGB kept under the hole (tools that drop alpha still see the old view),
and the 1-2 px ring around the hole decontaminated: ring pixels that still carry the old glass colour take the nearest frame colour.
Run it on a shell that still has the old view (git checkout of shell.png), or on its own output (the RGB under the hole is the old view, so it is repeatable).
Paths are absolute from this file's folder, never from the working directory."""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from frame_check import gap_mask

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def poly_mask(size, polys):
    im = Image.new("L", size, 0)
    d = ImageDraw.Draw(im)
    for p in polys:
        d.polygon([tuple(pt) for pt in p], fill=255)
    return np.asarray(im) > 0


def grow(m, r):
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * r + 1))) > 0 if r > 0 else m


def shrink(m, r):
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(2 * r + 1))) > 0 if r > 0 else m


def frame_like(rgb):
    r, g, b = (rgb[..., i].astype(int) for i in range(3))
    return ((r - b > 22) & (r - g > 10)) | (rgb.max(axis=2) < 75)


def components(mask, y_max):
    """4-connected components of mask above y_max, as lists of (y, x)."""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for y0 in range(min(h, y_max)):
        for x0 in np.flatnonzero(mask[y0] & ~seen[y0]):
            if seen[y0, x0]:
                continue
            seen[y0, x0] = True
            stack, pts = [(y0, x0)], []
            while stack:
                y, x = stack.pop()
                pts.append((y, x))
                for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= yy < y_max and 0 <= xx < w and mask[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
            out.append(np.array(pts))
    return out


def plant_mask(rgb, boxes, reach=4, dens_min=0.07):
    """Hanging plants: dark green outlines are dense on a plant and almost absent from the painted garden behind the glass."""
    mx = rgb.max(axis=2)
    dg = (mx < 85) & (rgb[..., 1] > rgb[..., 0] + 3) & (rgb[..., 1] >= rgb[..., 2])
    dens = np.asarray(Image.fromarray((dg * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(5))) / 255.0
    blob = grow(dens > dens_min, reach)
    box = np.zeros(mx.shape, bool)
    for x0, y0, x1, y1 in boxes:
        box[y0:y1, x0:x1] = True
    return blob & box


def flood_hole(rgb, cfg, outline, windows):
    mx, mn = rgb.max(axis=2).astype(int), rgb.min(axis=2).astype(int)
    sat = (mx - mn) / np.maximum(mx, 1)
    coloured = ((sat > cfg.get("sat", 0.16)) | (rgb[..., 2].astype(int) > rgb[..., 0].astype(int) + 12)) & (mx >= 90)
    r, g, b = (rgb[..., i].astype(int) for i in range(3))
    coloured &= ~plant_mask(rgb, cfg.get("plants", []), cfg.get("plantReach", 4), cfg.get("plantDens", 0.07))
    coloured &= shrink(poly_mask(mx.shape[::-1], [outline]), 1)  # the painted backdrop outside the room is green too
    zone = grow(poly_mask(mx.shape[::-1], windows), cfg.get("grow", 8)) | poly_mask(mx.shape[::-1], cfg.get("zones", []))
    coloured &= zone  # pictures, shelves and the floor are coloured too: only look near the panes
    hole = np.zeros(mx.shape, bool)
    for pts in components(coloured, cfg.get("maxY", 345)):
        if len(pts) < cfg.get("minArea", 150):
            continue
        m = np.zeros(mx.shape, bool)
        m[pts[:, 0], pts[:, 1]] = True
        hole |= shrink(grow(m, cfg.get("close", 2)), cfg.get("close", 2))
    return hole


def hole_for(rgb, windows, cfg, outline=None):
    h, w = rgb.shape[:2]
    mode = cfg.get("mode", "poly")
    if mode == "flood":
        hole = flood_hole(rgb, cfg, outline, windows)
    else:
        zone = grow(poly_mask((w, h), windows), cfg.get("grow", 1))
        hole = zone
        if cfg.get("rim"):
            r = cfg["rim"]
            R, G, B = (rgb[..., i].astype(int) for i in range(3))
            rimlike = (rgb.max(axis=2) <= r.get("max", 150)) & (R - B >= r.get("rb", 10)) & (G <= R + 5)
            band = zone & ~shrink(zone, r.get("band", 6))
            hole = zone & ~(band & rimlike)
            for _ in range(2):  # sky-blue edge pixels just outside the polygon: the old glass bleeding over the rim
                hole |= grow(hole, 1) & (B - R > r.get("bleed", 20))
        if mode == "colour":
            glass = zone & ~frame_like(rgb)
            hole = shrink(grow(glass, 1), 1) & zone  # closing: yellow flowers and light spots inside the glass are not frame
    if cfg.get("add"):
        hole |= poly_mask((w, h), cfg["add"])
    if mode == "flood":  # the hanging plants stay, also where an `add` polygon (door glass) reaches behind them
        hole &= ~plant_mask(rgb, cfg.get("plants", []), cfg.get("plantReach", 4), cfg.get("plantDens", 0.07))
    if cfg.get("subtract"):
        hole &= ~poly_mask((w, h), cfg["subtract"])
    if cfg.get("islands"):  # old-picture specks: small opaque pieces cut off from the frame, inside the glass area
        for pts in components(~hole, cfg.get("maxY", h)):
            if len(pts) <= cfg["islands"]:
                hole[pts[:, 0], pts[:, 1]] = True
    return hole


def mirror(d, n):
    """Index d (0, 1, 2 ...) steps away from the end of a span of n pixels, folded back and forth inside the span."""
    j = d % (2 * n)
    return j if j < n else 2 * n - 1 - j


def repair_members(rgb, hole, members):
    """Rebuilds every gap pixel of every member from the member itself (see the `members` note above). Returns the new rgb and hole."""
    rgb, hole = rgb.copy(), hole.copy()
    for m in members:
        x0, y0, x1, y1 = m["box"]
        rgba = np.dstack([rgb, np.where(hole, 0, 255).astype(np.uint8)])
        bad = gap_mask(rgba, m)
        vertical = m["axis"] == "v"
        new = rgb.copy()
        for ly in range(bad.shape[1] if vertical else bad.shape[0]):  # one line along the member per cross-section offset
            line = bad[:, ly] if vertical else bad[ly]
            if not line.any():
                continue
            good = np.flatnonzero(~line)
            if len(good) == 0:
                continue
            for t in np.flatnonzero(line):
                src = None
                if m.get("ref"):
                    a, b = m["ref"]
                    pos = (y0 if vertical else x0) + t
                    if pos < a:
                        src = a + mirror(a - 1 - pos, b - a + 1)
                    elif pos > b:
                        src = b - mirror(pos - b - 1, b - a + 1)
                    if src is not None:
                        src -= (y0 if vertical else x0)
                        if not 0 <= src < len(line) or line[src]:
                            src = None
                if src is None:
                    src = good[np.argmin(np.abs(good - t))]
                if vertical:
                    new[y0 + t, x0 + ly] = rgb[y0 + src, x0 + ly]
                    hole[y0 + t, x0 + ly] = False
                else:
                    new[y0 + ly, x0 + t] = rgb[y0 + ly, x0 + src]
                    hole[y0 + ly, x0 + t] = False
        rgb = new
    return rgb, hole


def decontaminate(rgb, hole, ring_px):
    """Ring pixels (within ring_px outside the hole) take the nearest pixel that is more than ring_px away from the hole."""
    out = rgb.copy()
    near = grow(hole, ring_px) & ~hole
    src = ~grow(hole, ring_px)  # trusted frame pixels
    filled = src.copy()
    todo = near.copy()
    for _ in range(ring_px + 2):
        grown = np.zeros_like(filled)
        acc = np.zeros(rgb.shape, dtype=np.int32)
        cnt = np.zeros(filled.shape, dtype=np.int32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                f = np.roll(filled, (dy, dx), (0, 1))
                c = np.roll(out, (dy, dx), (0, 1)).astype(np.int32)
                acc += c * f[..., None]
                cnt += f
        take = todo & (cnt > 0)
        out[take] = (acc[take] / cnt[take][:, None]).astype(np.uint8)
        filled = filled | take
        todo &= ~take
        if not todo.any():
            break
    return out


CUT_TESTS = {
    "all": lambda r, g, b, mx, sat: np.ones(r.shape, bool),
    "sky": lambda r, g, b, mx, sat: (b > r + 8) & (g >= r - 6),
    "green": lambda r, g, b, mx, sat: (g >= r + 6) & (g >= b - 4) & (sat >= 0.12),
    "yellow": lambda r, g, b, mx, sat: (r > 140) & (g > 140) & (b < 120),
    "pale": lambda r, g, b, mx, sat: (mx >= 150) & (g >= r + 3) & (g >= b - 3) & (sat < 0.5),
    "black": lambda r, g, b, mx, sat: mx <= 45,
}


def cut_mask(rgb, alpha, cuts):
    """Pixels of the `cuts` entries (see the module note) that are still opaque and match their `where` tests."""
    r, g, b = (rgb[..., i].astype(int) for i in range(3))
    mx = rgb.max(axis=2).astype(int)
    sat = (mx - rgb.min(axis=2).astype(int)) / np.maximum(mx, 1)
    out = np.zeros(alpha.shape, bool)
    for c in cuts:
        area = np.zeros(alpha.shape, bool)
        if "spans" in c:
            for y, x0, x1 in c["spans"]:
                area[y, x0:x1 + 1] = True
        else:
            x0, y0, x1, y1 = c["box"]
            area[y0:y1 + 1, x0:x1 + 1] = True
        hit = np.zeros(alpha.shape, bool)
        for w in c["where"]:
            hit |= CUT_TESTS[w](r, g, b, mx, sat)
        out |= area & hit & (alpha > 0) & (mx > c.get("keep", -1))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("room")
    ap.add_argument("--preview", help="write a 4x preview of the hole over the shell here")
    ap.add_argument("--dry", action="store_true", help="do not write shell.png")
    a = ap.parse_args()
    cfg_all = json.load(open(os.path.join(HERE, "glass.json"), encoding="utf-8"))
    cfg = cfg_all[a.room]
    d = os.path.join(ROOT, "assets", "scenes", a.room)
    scene = json.load(open(os.path.join(d, "scene.json"), encoding="utf-8"))
    shell = Image.open(os.path.join(d, scene["shell"]))
    rgb = np.asarray(shell.convert("RGB")).copy()
    hole = hole_for(rgb, scene["windows"], cfg, scene.get("outline"))
    if cfg.get("members"):
        rgb, hole = repair_members(rgb, hole, cfg["members"])
    ring = cfg.get("ring", 2)
    clean = decontaminate(rgb, hole, ring) if ring else rgb
    alpha = np.where(hole, 0, 255).astype(np.uint8)
    pix = np.where(hole[..., None], rgb, clean)  # keep the old view's RGB under the hole
    if cfg.get("cuts"):
        extra = cut_mask(pix, alpha, cfg["cuts"])
        alpha[extra] = 0
        print("  cuts px", int(extra.sum()))
    out = np.dstack([pix, alpha])
    print(a.room, "hole px", int(hole.sum()), "ring px", int((grow(hole, ring) & ~hole).sum()))
    for i, p in enumerate(scene["windows"]):
        m = poly_mask(hole.shape[::-1], [p])
        print("  window", i, "glass share %.0f%%" % (100 * (hole & m).sum() / max(1, m.sum())))
    if a.preview:
        k = 4
        bg = Image.new("RGB", shell.size, (255, 0, 255))
        im = Image.composite(Image.fromarray(clean), bg, Image.fromarray(alpha))
        im.resize((im.width * k, im.height * k), Image.NEAREST).save(a.preview)
    if not a.dry:
        Image.fromarray(out, "RGBA").save(os.path.join(d, scene["shell"]), optimize=True)


if __name__ == "__main__":
    main()
