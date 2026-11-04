"""Sky masks of the window views: assets/scenes/<room>/sky-day.png and sky-night.png (one per view picture).

  python art/skymask.py [room ...] [--preview DIR]

The weather overlay (web/fx-weather.mjs) draws clouds and the lightning glow only where the outside view shows sky, so a cloud passes behind the
far skyline, the mountains and the trees instead of lying over them. A mask is a PNG of the view picture's size (scene.json "view".size), grey + alpha:
alpha 255 = sky, alpha 0 = everything else. Reads assets/scenes/<room>/scene.json (`view`) and the view pictures; writes both masks; prints the numbers.

How the sky is found (the day picture has the contrast, so the silhouette comes from it):
  1. Per row a reference colour: the median of the pixels of that row that lie within `dist` (summed RGB difference) of the row above's reference.
     It follows the sky's slow gradient and does not jump to a mountain or a roof when the row is mostly ground.
  2. A pixel is a candidate when it is within `dist` of its row's reference, or (`bright`, rooms with painted clouds on mountains) at least
     `bright` luma steps lighter than it, which takes in the painted clouds that touch the mountain line.
  3. Sky = the candidates connected (4-neighbours) to the top row. Holes of at most `hole` px that touch neither the left, right nor bottom edge
     (painted clouds, the moon, stars) are sky as well. Everything else, the far skyline included, is not sky.
  The night picture has the same composition as the day one (the same raw picture, only re-lit), so its mask is the day silhouette. The script checks that
  on the night picture: the mean colour step across the boundary must be at least AGREE times the mean step across the same boundary moved by 3-5 px
  in eight directions (a night picture of another composition would not step more at the true boundary than next to it).
`--preview DIR` also writes the picture with everything that is not sky tinted red (x2 for the small views) for a look with your own eyes.
Paths are absolute from this file's folder, never from the working directory. Needs Pillow and numpy; repeatable (same pictures, same masks)."""
import argparse
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES = os.path.join(HERE, '..', 'assets', 'scenes')

# per room: dist = summed-RGB tolerance to the row's sky colour, hole = largest enclosed non-sky piece that becomes sky, bright = luma lead that counts as cloud (or None)
ROOMS = {
    'studio2': dict(dist=30, hole=8000, bright=None),
    'lounge': dict(dist=40, hole=8000, bright=10),
    'library': dict(dist=40, hole=8000, bright=10),
    'greenhouse': dict(dist=40, hole=8000, bright=None),
}
AGREE = 1.3  # night check: the colour step at the true boundary against the same boundary moved aside
SHIFTS = ((4, 0), (-4, 0), (0, 4), (0, -4), (3, 3), (-3, -3), (5, 0), (-5, 0))


def luma(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def row_reference(a, dist):
    """The sky colour of every row: median of the row's pixels near the row above's reference (kept when fewer than 15 % are near)."""
    h = a.shape[0]
    ref = np.zeros((h, 3), np.float32)
    prev = np.median(a[0], axis=0)
    for y in range(h):
        near = np.abs(a[y] - prev).sum(axis=1) <= dist
        if near.mean() >= 0.15:
            prev = np.median(a[y][near], axis=0)
        ref[y] = prev
    return ref


def components(m):
    """4-connected labels of a boolean grid: (labels, count, sizes) with sizes[0] unused."""
    h, w = m.shape
    lab = np.zeros((h, w), np.int32)
    sizes = [0]
    n = 0
    for y0 in range(h):
        for x0 in range(w):
            if not m[y0, x0] or lab[y0, x0]:
                continue
            n += 1
            lab[y0, x0] = n
            q = deque([(y0, x0)])
            c = 0
            while q:
                y, x = q.popleft()
                c += 1
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n
                        q.append((ny, nx))
            sizes.append(c)
    return lab, n, sizes


def sky_of(a, dist, hole, bright):
    ref = row_reference(a, dist)
    cand = np.abs(a - ref[:, None, :]).sum(axis=2) <= dist
    if bright is not None:
        cand |= luma(a) >= luma(ref)[:, None] + bright
    lab, _, _ = components(cand)
    sky = np.isin(lab, list(set(lab[0][lab[0] > 0].tolist())))
    lab2, n2, sizes = components(~sky)
    edge = set(lab2[-1].tolist()) | set(lab2[:, 0].tolist()) | set(lab2[:, -1].tolist())
    for i in range(1, n2 + 1):
        if i not in edge and sizes[i] <= hole:
            sky[lab2 == i] = True
    return sky


def boundary_pairs(sky):
    """(sky pixel, non-sky pixel) coordinate pairs that touch vertically or horizontally."""
    out = []
    for dy, dx in ((1, 0), (0, 1), (0, -1)):
        h, w = sky.shape
        ys, xs = np.mgrid[0:h, 0:w]
        ny, nx = ys + dy, xs + dx
        ok = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
        ys, xs, ny, nx = ys[ok], xs[ok], ny[ok], nx[ok]
        hit = sky[ys, xs] & ~sky[ny, nx]
        out.append((ys[hit], xs[hit], ny[hit], nx[hit]))
    return [np.concatenate(p) for p in zip(*out)]


def mean_step(sky, pic):
    ys, xs, ny, nx = boundary_pairs(sky)
    return float(np.abs(pic[ys, xs] - pic[ny, nx]).sum(axis=1).mean())


def edge_agreement(sky, pic):
    """Mean colour step of `pic` across the sky boundary divided by its mean step across the boundary moved aside (see AGREE)."""
    aside = []
    for dy, dx in SHIFTS:
        moved = np.roll(sky, (dy, dx), axis=(0, 1))
        if dy > 0:
            moved[:dy] = True
        elif dy < 0:
            moved[dy:] = False
        aside.append(mean_step(moved, pic))
    return mean_step(sky, pic) / float(np.mean(aside))


def write_mask(sky, path):
    la = np.zeros(sky.shape + (2,), np.uint8)
    la[..., 0] = 255
    la[..., 1] = np.where(sky, 255, 0)
    Image.fromarray(la, 'LA').save(path, optimize=True)


def preview(a, sky, path):
    o = a.copy()
    o[~sky] = o[~sky] * 0.35 + np.array([255, 0, 0]) * 0.65
    sc = 2 if a.shape[1] < 700 else 1
    Image.fromarray(o.astype(np.uint8)).resize((a.shape[1] * sc, a.shape[0] * sc), Image.NEAREST).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('rooms', nargs='*')
    ap.add_argument('--preview', metavar='DIR')
    args = ap.parse_args()
    bad = False
    for room in args.rooms or list(ROOMS):
        p = ROOMS[room]
        folder = os.path.join(SCENES, room)
        view = json.load(open(os.path.join(folder, 'scene.json'), encoding='utf-8-sig'))['view']
        day = np.asarray(Image.open(os.path.join(folder, view['day'])).convert('RGB')).astype(np.float32)
        night = np.asarray(Image.open(os.path.join(folder, view['night'])).convert('RGB')).astype(np.float32)
        sky = sky_of(day, p['dist'], p['hole'], p['bright'])
        ratio = edge_agreement(sky, night)
        ok = ratio >= AGREE
        bad |= not ok
        for mode, pic in (('day', day), ('night', night)):
            write_mask(sky, os.path.join(folder, f'sky-{mode}.png'))
            if args.preview:
                os.makedirs(args.preview, exist_ok=True)
                preview(pic, sky, os.path.join(args.preview, f'sky-{room}-{mode}.png'))
        rows = np.where(sky.mean(axis=1) >= 0.5)[0]
        print(f'{room}: sky {sky.mean():.3f} of the view, rows with half sky or more {rows.min()}-{rows.max()} of {sky.shape[0]}; '
              f'night boundary step x{ratio:.2f} of the moved boundary {"ok" if ok else "TOO LOW"}')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
