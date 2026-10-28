"""Pixel-art snapping tool.

  python art/snap.py sprite <in> <out> --height 64 --colors 20
  python art/snap.py bg     <in> <out> --size 768x512

sprite: crop transparent margins, box-average downscale, limit colors, alpha 0/255.
bg:     LANCZOS downscale, no color limit.
Paths are resolved to absolute from the arguments (never relies on CWD for output).
"""
import argparse
import os
import sys

from PIL import Image


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["sprite", "bg"])
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--height", type=int, default=64)
    ap.add_argument("--colors", type=int, default=20)
    ap.add_argument("--size", default="768x512")
    a = ap.parse_args()
    src, dst = os.path.abspath(a.src), os.path.abspath(a.dst)
    if a.mode == "sprite":
        print("sprite", snap_sprite(src, dst, a.height, a.colors))
    else:
        w, h = (int(v) for v in a.size.lower().split("x"))
        print("bg", snap_bg(src, dst, (w, h)))


if __name__ == "__main__":
    sys.exit(main())
