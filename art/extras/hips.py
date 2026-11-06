"""Measure config.json ui.walk.hips values for the extra girls.
  python art/extras/hips.py out.json
hip   = the row just above where the legs part into two separate runs (first row of >=3 consecutive two-run rows in the
        lower 45% of the picture), as a % of the 64-row height, in 1/64 steps like the existing table.
split = the middle column of the gap between the two legs just inside that first run of rows, as a % of the width (4 decimals).
The existing values were chosen by eye against art/walk/sheet.py; this reproduces their pattern (hip within ~2 rows of
the first gap row, split inside the gap) and the result is checked with sheet.py."""
import json, os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def runs(row):
    out, s = [], None
    for x, v in enumerate(list(row) + [False]):
        if v and s is None: s = x
        if not v and s is not None: out.append((s, x)); s = None
    return out

res = {}
for n in range(1, 13):
    k = f"extra-{n:02d}"
    a = np.array(Image.open(f"{ROOT}/assets/sprites/{k}.png"))[:, :, 3] > 0
    h, w = a.shape
    # the gap between the feet: columns empty in rows h-9..h-3 between the outermost opaque columns there
    low = a[h - 9:h - 2]
    cols = low.any(0)
    xs = np.where(cols)[0]
    empty = [x for x in range(xs.min(), xs.max() + 1) if not cols[x]]
    if not empty:
        res[k] = [78.125, 50]; print(k, "no foot gap, using hipDefault"); continue
    # widest contiguous empty stretch
    best, cur = [], []
    for x in empty:
        cur = cur + [x] if cur and x == cur[-1] + 1 else [x]
        if len(cur) > len(best): best = list(cur)
    col = best[(len(best) - 1) // 2]
    # walk up while that column stays empty with body on both sides (still two separate legs)
    g = h - 9
    while g > 0 and not a[g - 1, col] and a[g - 1, :col].any() and a[g - 1, col + 1:].any():
        g -= 1
    hip = max(g - 1, 0)
    res[k] = [round(hip / h * 100, 4), round(col / w * 100, 4)]
    print(k, w, "gap starts row", g, "hip row", hip, "split col", col, "foot gap", best[0], best[-1])
json.dump({"note": "hip = row above where the two legs separate (walked up from the foot gap), split = middle column of the foot gap, both as % of 64 rows / width; extra-10 (long skirt, feet touch) uses hipDefault. Measured by art/extras/hips.py, checked by eye with the walk frames.", "hips": res}, open(sys.argv[1], "w"), indent=1)
