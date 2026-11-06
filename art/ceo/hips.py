"""Measure config.json ui.walk.hips.ceo for the boss, the same way art/extras/hips.py does for the extra girls.
  python art/ceo/hips.py
hip   = the row above where the legs part (walked up from the foot gap), as a % of the 64-row height
split = the middle column of the foot gap, as a % of the width (4 decimals).
Prints the [hip, split] pair to paste into ui.walk.hips.ceo (the hip must sit on a pixel row: tests/cat.test.mjs)."""
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).replace("\\", "/")
a = np.array(Image.open(f"{ROOT}/assets/sprites/ceo.png"))[:, :, 3] > 0
h, w = a.shape
cols = a[h - 9:h - 2].any(0)
xs = np.where(cols)[0]
empty = [x for x in range(xs.min(), xs.max() + 1) if not cols[x]]
best, cur = [], []
for x in empty:
    cur = cur + [x] if cur and x == cur[-1] + 1 else [x]
    if len(cur) > len(best):
        best = list(cur)
col = best[(len(best) - 1) // 2]
g = h - 9
while g > 0 and not a[g - 1, col] and a[g - 1, :col].any() and a[g - 1, col + 1:].any():
    g -= 1
hip = max(g - 1, 0)
print(f"ceo {w}x{h} gap starts row {g} hip row {hip} split col {col} foot gap {best[0]}-{best[-1]}")
print([round(hip / h * 100, 4), round(col / w * 100, 4)])
