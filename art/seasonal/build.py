"""Seasonal decorations + snacks from raw codex sheets, then items.json (all fun2 art).

  python art/seasonal/build.py <work dir>   (work dir holds hal/ xmas/ lny/ snack/ with
                                              p/piece-<k>.png from `python art/snap.py sheet`)
Hand-drawn effects come from art/seasonal/build_fx.py. Writes assets/seasonal/*.png,
assets/snacks/*.png and assets/seasonal/items.json (anchor = x,y inside the file:
bottom-centre for floor/desk, top-centre for wall).
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "art"))
import snap  # noqa: E402

# name, sheet dir, piece, ("w"|"h", px), kind, season, label
ITEMS = [
    ("halloween-pumpkin-small", "hal", 0, ("w", 16), "desk", "halloween", "작은 호박등"),
    ("halloween-pumpkin-big", "hal", 1, ("w", 30), "floor", "halloween", "큰 호박등"),
    ("halloween-bats", "hal", 2, ("w", 46), "wall", "halloween", "박쥐 가랜드"),
    ("halloween-ghost", "hal", 3, ("h", 26), "floor", "halloween", "촛불 든 유령"),
    ("christmas-tree", "xmas", 0, ("h", 54), "floor", "christmas", "작은 트리"),
    ("christmas-wreath", "xmas", 1, ("w", 24), "wall", "christmas", "리스"),
    ("christmas-gifts", "xmas", 2, ("w", 28), "floor", "christmas", "선물 상자 더미"),
    ("christmas-lights", "xmas", 3, ("w", 56), "wall", "christmas", "꼬마전구 줄"),
    ("lunar-pouch", "lny", 0, ("w", 15), "desk", "lunar", "복주머니"),
    ("lunar-lantern", "lny", 1, ("h", 40), "wall", "lunar", "청사초롱"),
    ("lunar-kite", "lny", 2, ("h", 36), "wall", "lunar", "연"),
    ("lunar-tray", "lny", 3, ("w", 26), "desk", "lunar", "한과 · 떡 쟁반과 세뱃돈"),
    ("snack-coffee", "snack", 0, ("h", 16), "hand", "snack", "커피"),
    ("snack-donut", "snack", 1, ("w", 14), "hand", "snack", "도넛"),
    ("snack-cookie", "snack", 2, ("w", 13), "hand", "snack", "쿠키"),
    ("snack-fish", "snack", 3, ("w", 15), "hand", "snack", "고양이 간식 생선"),
]
FX = [
    ("sweat-drop", "땀방울"), ("rain-cloud-1", "먹구름 1"), ("rain-cloud-2", "먹구름 2"),
    ("sparkle-1", "반짝임 1"), ("sparkle-2", "반짝임 2"),
]


def main():
    work = os.path.abspath(sys.argv[1])
    out = []
    for name, sheet, k, (axis, px), kind, season, label in ITEMS:
        folder = "snacks" if season == "snack" else "seasonal"
        dst = os.path.join(ROOT, "assets", folder, name + ".png")
        src = os.path.join(work, sheet, "p", f"piece-{k}.png")
        snap.snap_obj(src, dst, px if axis == "w" else None, px if axis == "h" else None, 24)
        w, h = Image.open(dst).size
        anchor = [w // 2, 0] if kind == "wall" else [w // 2, h - 1]
        out.append({"file": f"{folder}/{name}.png", "name": name, "label": label, "size": [w, h],
                    "anchor": anchor, "kind": kind, "season": season})
        print(name, w, h)
    for name, label in FX:
        w, h = Image.open(os.path.join(ROOT, "assets", "fx", name + ".png")).size
        out.append({"file": f"fx/{name}.png", "name": name, "label": label, "size": [w, h],
                    "anchor": [w // 2, h - 1], "kind": "fx", "season": "fx"})
    with open(os.path.join(ROOT, "assets", "seasonal", "items.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
