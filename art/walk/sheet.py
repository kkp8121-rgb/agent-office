"""Walking-legs check sheet: draws the same 4 frames the CSS plays (two poses x body bob) for chosen sprites, zoomed.

The page does not use new art: while a character walks, the lower part of its own picture (below `hip`) is drawn twice,
the left part and the right part (cut at `split`), and the two parts swap sides every half step. This script reproduces
that with PIL so the result can be looked at; keep the numbers in sync with style.css (LEG_PX, LIFT_PX, BOB_PX) and with
config.json ui.walk.hips (hip and split there are percentages of the picture: hip rows / 64, split columns / width).

  python art/walk/sheet.py out.png [--zoom 4] [--only worker,lead-2] [--all]
"""
import argparse
import json
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LEG_PX, LIFT_PX, BOB_PX = 2, 1, 1
BG = (239, 230, 210, 255)


def hips():
    cfg = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
    w = cfg['ui']['walk']
    return w['hips'], w['hipDefault']


def frame(im, hip_pct, split_pct, pose, bob):
    w, h = im.size
    hip = round(hip_pct / 100 * h)
    split = round(split_pct / 100 * w)
    pad = 6
    out = Image.new('RGBA', (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    top = im.crop((0, 0, w, hip))
    left = im.crop((0, hip, split, h))
    right = im.crop((split, hip, w, h))
    dy = -bob
    out.alpha_composite(top, (pad, pad + dy))
    # pose 0: legs apart (left part out to the left); pose 1: crossed (left part past the middle, lifted)
    if pose == 0:
        lx, ly, rx, ry = -LEG_PX, 0, LEG_PX, 0
    else:
        lx, ly, rx, ry = LEG_PX, -LIFT_PX, -LEG_PX, 0
    out.alpha_composite(left, (pad + lx, pad + hip + ly + dy))
    out.alpha_composite(right, (pad + split + rx, pad + hip + ry + dy))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--zoom', type=int, default=4)
    ap.add_argument('--only', default='')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    table, default = hips()
    sdir = os.path.join(ROOT, 'assets', 'sprites')
    keys = sorted(f[:-4] for f in os.listdir(sdir) if f.endswith('.png') and not f.endswith('-sit.png') and not f.startswith('cat-'))
    if a.only:
        keys = [k for k in a.only.split(',')]
    z = a.zoom
    cell = 56 * z
    rows = []
    for k in keys:
        im = Image.open(os.path.join(sdir, k + '.png')).convert('RGBA')
        hip, split = table.get(k, default)
        fs = [frame(im, hip, split, p, b) for p, b in ((0, 0), (0, 1), (1, 0), (1, 1))]
        rows.append((k, im, fs, hip, split))
    pad_top = 14
    sheet = Image.new('RGBA', (cell * 5, (76 * z + pad_top) * len(rows)), BG)
    d = ImageDraw.Draw(sheet)
    for r, (k, im, fs, hip, split) in enumerate(rows):
        y0 = r * (76 * z + pad_top)
        d.text((4, y0 + 1), f'{k}  hip {hip}%  split {split}%', fill=(0, 0, 0, 255))
        # first cell: the still picture with the cut lines
        still = im.resize((im.width * z, im.height * z), Image.NEAREST)
        ox = (cell - still.width) // 2
        sheet.alpha_composite(still, (ox, y0 + pad_top + 6 * z))
        hy = y0 + pad_top + 6 * z + round(hip / 100 * im.height) * z
        d.line([(ox - 6, hy), (ox + still.width + 6, hy)], fill=(255, 0, 0, 255))
        sx = ox + round(split / 100 * im.width) * z
        d.line([(sx, hy), (sx, hy + (im.height - round(hip / 100 * im.height)) * z)], fill=(0, 0, 255, 255))
        for i, f in enumerate(fs):
            big = f.resize((f.width * z, f.height * z), Image.NEAREST)
            sheet.alpha_composite(big, ((i + 1) * cell + (cell - big.width) // 2, y0 + pad_top))
    sheet.convert('RGB').save(a.out)
    print(a.out, sheet.size)


if __name__ == '__main__':
    sys.exit(main())
