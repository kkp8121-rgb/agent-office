"""Window view panorama processing (README "Window views").
  python art/view.py <room> <day|night> <raw.png> <horizon-src-fraction> [--cx 0.5] [--strength 1] [--zoom 1] [--hy Y] [--out DIR]
Takes the raw Codex picture of a room's outside view (one continuous wide landscape, see art/prompts.json "views"), crops a box of the
room's canvas aspect that puts the source horizon at the room's horizon fraction, LANCZOS-downscales to the exact canvas size (the shell
recipe of snap.py, not nearest neighbour), blends a haze band at the horizon so the far layer is lighter than the near ones, and reduces
the palette. Writes assets/scenes/<room>/view-<mode>.png (default --out). The canvas box is the scene.json "view" entry.
--zoom Z (>1) takes a box 1/Z of the raw picture, so the landscape is bigger and the sky above the far layer is cropped away (eye-level look);
--hy overrides the room's horizon row (scene y). The horizon of the picture must land on the same canvas row for day and night: give the night
picture the horizon fraction of its own raw (the day fraction minus the measured vertical drift between the two raws)."""
import sys, os, argparse
import numpy as np
from PIL import Image, ImageFilter
ROOMS = {  # origin x,y, size w,h, horizon scene y, quantize colours
 "studio2": ((64, 32), (624, 224), 87, 128),
 "lounge": ((344, 64), (376, 136), 130, 64),
 "library": ((304, 32), (304, 112), 88, 64),
 "greenhouse": ((16, 16), (992, 328), 119, 64),
}
HAZE = {"day": ((207, 229, 242), 0.30), "night": ((31, 44, 85), 0.25)}

def process(room, mode, src, hfrac, cx=0.5, strength=1.0, zoom=1.0, hy=None):
    (ox, oy), (w, h), hy0, ncol = ROOMS[room]
    hy = hy0 if hy is None else hy
    im = Image.open(src).convert("RGB")
    W, H = im.size
    a = w / h
    cw, ch = W / zoom, W / zoom / a
    if ch > H: ch, cw = H, H * a
    f = (hy - oy) / h
    top = hfrac * H - f * ch
    top = min(max(top, 0), H - ch)
    left = min(max((W - cw) * cx, 0), W - cw)
    shifted = abs((hfrac * H - top) / ch - f)
    im = im.resize((w, h), Image.LANCZOS, box=(left, top, left + cw, top + ch))
    a_ = np.asarray(im).astype(np.float32)
    y = np.arange(h, dtype=np.float32)[:, None]
    band = np.clip(1 - np.abs(y - (hy - oy)) / 24.0, 0, 1) ** 1.5
    col, k = HAZE[mode]
    k = k * strength
    a_ = a_ * (1 - band[..., None] * k) + np.array(col, np.float32) * band[..., None] * k
    im = Image.fromarray(np.clip(a_, 0, 255).astype(np.uint8))
    im = im.quantize(ncol, Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    return im, shifted

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("room"); p.add_argument("mode"); p.add_argument("src"); p.add_argument("hfrac", type=float)
    p.add_argument("--cx", type=float, default=0.5); p.add_argument("--out", default=None)
    p.add_argument("--strength", type=float, default=1.0)
    p.add_argument("--zoom", type=float, default=1.0); p.add_argument("--hy", type=int, default=None)
    a = p.parse_args()
    im, sh = process(a.room, a.mode, a.src, a.hfrac, a.cx, a.strength, a.zoom, a.hy)
    out = a.out or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "scenes", a.room)
    os.makedirs(out, exist_ok=True)
    im.save(f"{out}/view-{a.mode}.png", optimize=True)
    print(a.room, a.mode, im.size, "horizon shift", round(sh, 3))
