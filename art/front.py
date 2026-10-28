"""Cut the front overlay (front.png) out of the shell with the scene's frontMask polygons.

  python art/front.py <design>

Reads assets/scenes/<design>/scene.json (size, frontMask) and shell.png. When frontMask is
empty no file is written (and an old front.png is left alone for the author to remove).
"""
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENES = os.environ.get("AGENT_OFFICE_SCENES_DIR") or os.path.join(ROOT, "assets", "scenes")


def main():
    design = sys.argv[1]
    d = os.path.join(SCENES, design)
    scene = json.load(open(os.path.join(d, "scene.json"), encoding="utf-8"))
    polys = scene.get("frontMask") or []
    if not polys:
        print("front: no frontMask, nothing written")
        return
    shell = Image.open(os.path.join(d, scene.get("shell", "shell.png"))).convert("RGBA")
    mask = Image.new("L", shell.size, 0)
    dr = ImageDraw.Draw(mask)
    for poly in polys:
        dr.polygon([tuple(p) for p in poly], fill=255)
    shell.putalpha(mask)
    shell.save(os.path.join(d, scene.get("front") or "front.png"))
    print("front", shell.size, len(polys), "polygons")


if __name__ == "__main__":
    main()
