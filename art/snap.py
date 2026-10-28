"""Pixel-art snapping tool.

  python art/snap.py sprite <in> <out> --height 64 --colors 20
  python art/snap.py bg     <in> <out> --size 768x512
  python art/snap.py shell  <in> <out> --size 1024x512
  python art/snap.py sheet  <sheet.png> <outdir> [--rows N]
  python art/snap.py obj    <piece.png> <out> (--width W | --height H) [--colors 24]

sprite: crop transparent margins, box-average downscale, limit colors, alpha 0/255.
bg:     LANCZOS downscale, no color limit.
shell:  LANCZOS downscale of an empty-room shell (same as bg; scene pipeline name).
sheet:  key out the magenta background, trim the fringe, split a sprite sheet into
        outdir/piece-<k>.png (left to right, top to bottom) + outdir/pieces.json.
obj:    premultiplied BOX downscale of one piece to a target width/height, alpha 0/255,
        per-object palette reduction.
Paths are resolved to absolute from the arguments (never relies on CWD for output).
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter


def snap_sprite(src, dst, height, colors):
    im = Image.open(src).convert("RGBA")
    bbox = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bbox:
        im = im.crop(bbox)
    width = max(1, round(im.width * height / im.height))
    im = im.resize((width, height), Image.BOX)
    alpha = im.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    rgb = im.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.save(dst)
    return out.size


def snap_bg(src, dst, size):
    im = Image.open(src).convert("RGB").resize(size, Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst)
    return im.size


def key_magenta(src):
    """Magenta key + 1px erosion + pink-spill reduction. Returns an RGBA image."""
    a = np.array(Image.open(src).convert("RGB")).astype(int)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mag = (r > 150) & (b > 150) & (g < r - 70) & (g < b - 70)
    im = Image.fromarray(np.dstack([a.astype(np.uint8), (~mag).astype(np.uint8) * 255]), "RGBA")
    al = im.getchannel("A").filter(ImageFilter.MinFilter(3))
    im.putalpha(al)
    arr = np.array(im).astype(int)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    spill = np.maximum(0, np.minimum(r, b) - g)
    edge = np.array(al.filter(ImageFilter.MinFilter(7))) < 255
    fix = edge & (arr[:, :, 3] > 0) & (spill > 30)
    arr[:, :, 0][fix] = np.minimum(r, g + 30)[fix]
    arr[:, :, 2][fix] = np.minimum(b, g + 30)[fix]
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def runs(flags, min_len):
    """[start, end) runs of True in a 1-D bool array, shorter than min_len dropped."""
    out, s = [], None
    for i, v in enumerate(list(flags) + [False]):
        if v and s is None:
            s = i
        if not v and s is not None:
            if i - s >= min_len:
                out.append((s, i))
            s = None
    return out


def split_sheet(src, outdir, rows):
    im = key_magenta(src)
    alpha = np.array(im)[:, :, 3] > 0
    bands = runs(alpha.any(1), 20) if rows else [(0, im.height)]
    if rows and len(bands) != rows:
        raise SystemExit(f"sheet: expected {rows} rows, found {len(bands)} ({bands})")
    os.makedirs(outdir, exist_ok=True)
    pieces, k = [], 0
    for y0, y1 in bands:
        for x0, x1 in runs(alpha[y0:y1].any(0), 20):
            c = im.crop((x0, y0, x1, y1))
            bb = c.getchannel("A").getbbox()
            c = c.crop(bb)
            c.save(os.path.join(outdir, f"piece-{k}.png"))
            pieces.append({"k": k, "bbox": [x0 + bb[0], y0 + bb[1], x0 + bb[2], y0 + bb[3]]})
            k += 1
    with open(os.path.join(outdir, "pieces.json"), "w", encoding="utf-8") as f:
        json.dump(pieces, f)
    return pieces


def snap_obj(src, dst, width, height, colors):
    im = Image.open(src).convert("RGBA")
    bb = im.getchannel("A").getbbox()
    if bb:
        im = im.crop(bb)
    f = (width / im.width) if width else (height / im.height)
    w, h = max(1, round(im.width * f)), max(1, round(im.height * f))
    p = np.array(im).astype(np.float32)
    p[:, :, :3] *= p[:, :, 3:] / 255
    ch = [np.array(Image.fromarray(p[:, :, i], "F").resize((w, h), Image.BOX)) for i in range(4)]
    q = np.dstack(ch)
    al = q[:, :, 3:]
    q[:, :, :3] = np.where(al > 0, q[:, :, :3] / np.maximum(al, 1) * 255, 0)
    opaque = al[:, :, 0] > 127
    q = np.clip(q, 0, 255).astype(np.uint8)
    rgb = q[:, :, :3].copy()
    if opaque.any():
        rgb[~opaque] = rgb[opaque].mean(0).astype(np.uint8)
    pal = Image.fromarray(rgb, "RGB").quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    out = np.dstack([np.array(pal), np.where(opaque, 255, 0).astype(np.uint8)])
    out[~opaque, :3] = 0
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    Image.fromarray(out, "RGBA").save(dst)
    return (w, h), f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["sprite", "bg", "shell", "sheet", "obj"])
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--height", type=int, default=None)
    ap.add_argument("--colors", type=int, default=None)
    ap.add_argument("--size", default="768x512")
    ap.add_argument("--width", type=int)
    ap.add_argument("--rows", type=int, default=0)
    a = ap.parse_args()
    src, dst = os.path.abspath(a.src), os.path.abspath(a.dst)
    if a.mode == "sheet":
        print("sheet", [p["bbox"] for p in split_sheet(src, dst, a.rows)])
    elif a.mode == "obj":
        if not (a.width or a.height):
            raise SystemExit("obj: give --width or --height")
        size, f = snap_obj(src, dst, a.width, None if a.width else a.height, a.colors or 24)
        print("obj", size, "scale %.3f" % f)
    elif a.mode == "sprite":
        print("sprite", snap_sprite(src, dst, a.height or 64, a.colors or 20))
    else:  # bg, shell
        w, h = (int(v) for v in a.size.lower().split("x"))
        print(a.mode, snap_bg(src, dst, (w, h)))


if __name__ == "__main__":
    sys.exit(main())
