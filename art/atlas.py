"""Pack the pieces of one room into assets/scenes/<design>/objects.png.

  python art/atlas.py <design> [--work <dir>]

Reads art/scenes/<design>.json:
  "kinds": { "<kind>": { "piece": "<path under work dir, no .png>", "width": W | "height": H, "colors": 24 }, ... }
Every piece is shrunk with snap.py `obj`, shelf-packed into objects.png, and the
kinds[*].rect entries of assets/scenes/<design>/scene.json are rewritten (other fields stay).
The work dir (raw Codex output, keyed sheet pieces) lives outside the repo:
--work, or env AGENT_OFFICE_ART_WORK, joined with <design>.
The scenes dir is assets/scenes unless env AGENT_OFFICE_SCENES_DIR points elsewhere (staging).
"""
import argparse
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snap  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENES = os.environ.get("AGENT_OFFICE_SCENES_DIR") or os.path.join(ROOT, "assets", "scenes")
ATLAS_W = 512
PAD = 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("design")
    ap.add_argument("--work", default=None)
    a = ap.parse_args()
    work = os.path.abspath(a.work or os.path.join(os.environ["AGENT_OFFICE_ART_WORK"], a.design))
    spec = json.load(open(os.path.join(ROOT, "art", "scenes", a.design + ".json"), encoding="utf-8"))
    out_dir = os.path.join(SCENES, a.design)
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(work, "atlas-tmp")
    done, items = {}, []
    for kind, k in spec["kinds"].items():
        key = (k["piece"], k.get("width"), k.get("height"), k.get("colors", 24))
        if key not in done:
            dst = os.path.join(tmp, f"{len(done)}.png")
            snap.snap_obj(os.path.join(work, k["piece"] + ".png"), dst, k.get("width"), None if k.get("width") else k.get("height"), key[3])
            done[key] = dst
        items.append((kind, done[key]))
    # shelf pack, tallest first
    uniq = {}
    for kind, path in items:
        uniq.setdefault(path, Image.open(path).convert("RGBA"))
    order = sorted(uniq, key=lambda p: -uniq[p].height)
    pos, x, y, rowh = {}, 0, 0, 0
    for p in order:
        im = uniq[p]
        if x + im.width > ATLAS_W:
            x, y, rowh = 0, y + rowh + PAD, 0
        pos[p] = (x, y)
        x += im.width + PAD
        rowh = max(rowh, im.height)
    atlas = Image.new("RGBA", (ATLAS_W, y + rowh), (0, 0, 0, 0))
    for p in order:
        atlas.paste(uniq[p], pos[p])
    atlas.save(os.path.join(out_dir, "objects.png"))
    scene_path = os.path.join(out_dir, "scene.json")
    scene = json.load(open(scene_path, encoding="utf-8")) if os.path.exists(scene_path) else {"kinds": {}}
    kinds = scene.setdefault("kinds", {})
    for kind, path in items:
        im = uniq[path]
        kinds.setdefault(kind, {})["rect"] = [pos[path][0], pos[path][1], im.width, im.height]
        print(kind, kinds[kind]["rect"])
    tmp_json = scene_path + ".tmp"
    with open(tmp_json, "w", encoding="utf-8", newline="\n") as f:
        json.dump(scene, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp_json, scene_path)
    print("atlas", atlas.size)


if __name__ == "__main__":
    main()
