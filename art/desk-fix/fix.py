"""Remove drawer fronts/handles from desk sprites (viewer side shows the back/modesty panel).
Usage: python art/desk-fix/fix.py   (reads assets/scenes/<d>/objects.png, backup in art/desk-fix/orig/)"""
import json, os, shutil, statistics
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ORIG = os.path.join(ROOT, "art", "desk-fix", "orig")
def lum(c): return 0.3*c[0]+0.59*c[1]+0.11*c[2]

def clean(px, W, mask_in, thr_px, thr_row):
    """mask_in: set of (x,y) inside the drawer area. Mark handle pixels/seam rows, refill vertically."""
    rows = {}
    for (x, y) in mask_in: rows.setdefault(y, []).append(x)
    allmed = statistics.median(lum(px[x, y]) for (x, y) in mask_in)
    bad = set()
    for y, xs in rows.items():
        med = statistics.median(lum(px[x, y]) for x in xs)
        if abs(med - allmed) > thr_row:
            bad.update((x, y) for x in xs); continue
        for x in xs:
            if abs(lum(px[x, y]) - med) > thr_px: bad.add((x, y))
    # dilate horizontally-adjacent handle halo is not needed; fill
    good = mask_in - bad
    out = {}
    for (x, y) in bad:
        best = None
        for d in range(1, 40):
            for yy in ((y-d, y+d) if (x+y) % 2 else (y+d, y-d)):
                if (x, yy) in good: best = (x, yy); break
            if best: break
        if best is None:
            # fall back to nearest in row
            for d in range(1, 40):
                for xx in (x-d, x+d):
                    if (xx, y) in good: best = (xx, y); break
                if best: break
        if best: out[(x, y)] = px[best]
    return out, bad

def box(x0, y0, x1, y1): return {(x, y) for x in range(x0, x1+1) for y in range(y0, y1+1)}
def poly_rows(rows):  # rows: {y: (xa, xb)}
    return {(x, y) for y, (a, b) in rows.items() for x in range(a, b+1)}

def grain(px, area, seed, lo=0.25, hi=0.85, run=(2, 6), ok=None):
    import random
    from collections import Counter
    cnt = Counter(px[x, y] for (x, y) in area if ok is None or ok(px[x, y]))
    cols = sorted(cnt, key=lum)
    tot = sum(cnt.values()); acc = 0; cand = []
    for c in cols:
        acc += cnt[c]
        if lo*tot <= acc <= hi*tot + cnt[c]: cand += [c]*cnt[c]
    rng = random.Random(seed)
    xs = sorted({x for x, _ in area})
    for x in xs:
        ys = sorted(y for (xx, y) in area if xx == x); i = 0
        while i < len(ys):
            c = rng.choice(cand); n = rng.randint(*run)
            for y in ys[i:i+n]: px[x, y] = c
            i += n

def apply(design, rect, areas, thr_px=18, thr_row=14, mode='clean', gkw={}):
    p = os.path.join(ROOT, "assets", "scenes", design, "objects.png")
    bk = os.path.join(ORIG, design + ".png")
    os.makedirs(ORIG, exist_ok=True)
    if not os.path.exists(bk): shutil.copy(p, bk)
    im = Image.open(p).convert("RGBA"); px = im.load()
    x0, y0, w, h = rect
    # work in absolute coords
    for area in areas:
        absarea = {(x+x0, y+y0) for (x, y) in area}
        if mode == 'grain':
            grain(px, absarea, design+str(sorted(absarea)[0]), **gkw); continue
        out, bad = clean(px, im.width, absarea, thr_px, thr_row)
        for (x, y), c in out.items(): px[x, y] = c
    im.save(p)

def restore(design):
    bk = os.path.join(ORIG, design + ".png")
    if os.path.exists(bk): shutil.copy(bk, os.path.join(ROOT, "assets", "scenes", design, "objects.png"))
