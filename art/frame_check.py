"""Counts gap pixels along every frame member listed in art/glass.json[room]["members"] (beams, posts, rails, sills).

  python art/frame_check.py <room> [shell.png]

A member is {"name", "axis": "v"|"h", "box": [x0, y0, x1, y1], "far": false} (inclusive; the box is the member's cross-section times its length;
"far": false counts only transparent pixels, for a member that other parts cross).
A gap pixel is alpha 0 or a colour far from the member's own profile (median colour per cross-section offset over the opaque pixels of the box).
Prints one line per member: name, box, gap pixels. Exit code 1 when any member has a gap (so the check can gate a rebuild)."""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FAR = 200  # L1 distance (sum over R, G, B) from the profile that counts as "not the member"


def gap_mask(rgba, member):
    """Boolean array the size of the box: True where the member is interrupted."""
    x0, y0, x1, y1 = member["box"]
    sub = rgba[y0:y1 + 1, x0:x1 + 1].astype(int)
    opaque = sub[..., 3] > 0
    rgb = sub[..., :3]
    vertical = member["axis"] == "v"
    # profile: median colour per offset across the member (offset runs along x for a vertical member)
    prof = np.zeros((sub.shape[1] if vertical else sub.shape[0], 3))
    for i in range(prof.shape[0]):
        line = rgb[:, i][opaque[:, i]] if vertical else rgb[i][opaque[i]]
        prof[i] = np.median(line, axis=0) if len(line) else 0
    ref = prof[None, :, :] if vertical else prof[:, None, :]
    if member.get("far") is False:  # members crossed by other parts (post caps, struts): only holes count
        return ~opaque
    far = np.abs(rgb - ref).sum(axis=2) > FAR
    return ~opaque | far


def check(room, path=None):
    cfg = json.load(open(os.path.join(HERE, "glass.json"), encoding="utf-8"))[room]
    scene = json.load(open(os.path.join(ROOT, "assets", "scenes", room, "scene.json"), encoding="utf-8"))
    img = np.asarray(Image.open(path or os.path.join(ROOT, "assets", "scenes", room, scene["shell"])).convert("RGBA"))
    return [(m, int(gap_mask(img, m).sum())) for m in cfg.get("members", [])]


if __name__ == "__main__":
    bad = 0
    for m, n in check(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None):
        print("%-14s box %-22s gap px %d" % (m["name"], m["box"], n))
        bad += n
    sys.exit(1 if bad else 0)
