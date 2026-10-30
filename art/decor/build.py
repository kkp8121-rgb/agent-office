"""Shop furniture sprites + the codex office cat, from raw codex sheets.

  python art/decor/build.py <work dir>   (work dir holds w1,w2,w3,wc each with p/piece-<k>.png
                                          made by `python art/snap.py sheet <sheet> <dir>/p`)
Writes assets/decor/<id>.png (bottom-centre = floor contact point), art/decor/items.json
and assets/sprites/cat-*.png (same canvas sizes as the old hand-drawn ones).
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "art"))
import snap  # noqa: E402

# id, name, price, work/piece, size spec, footprint half-width/depth (scene px), blocks
ITEMS = [
    ("plant-small", "화분", 30, "w1/p/piece-0", {"height": 36}, 8, 5, True),
    ("poster-stand", "포스터 입간판", 40, "w1/p/piece-1", {"height": 56}, 11, 5, True),
    ("rug", "러그", 70, "w1/p/piece-2", {"width": 96}, 40, 16, False),
    ("plant-big", "큰 화분", 60, "w2/p/piece-0", {"height": 70}, 12, 6, True),
    ("floor-lamp", "스탠드 조명", 80, "w2/p/piece-1", {"height": 68}, 6, 4, True),
    ("bookshelf", "책장", 100, "w2/p/piece-2", {"height": 74}, 17, 6, True),
    ("cat-house", "고양이 집", 120, "w1/p/piece-3", {"height": 38}, 14, 6, True),
    ("fish-tank", "어항", 150, "w2/p/piece-3", {"height": 62}, 20, 7, True),
    ("sofa", "소파", 160, "w3/p/piece-0", {"width": 104}, 46, 12, True),
    ("vending", "자판기", 200, "w3/p/piece-1", {"height": 76}, 18, 7, True),
    ("arcade", "오락기", 280, "w3/p/piece-2", {"height": 74}, 17, 7, True),
]
CAT = [("cat-walk-1", "wc/p/piece-0", (31, 22)), ("cat-walk-2", "wc/p/piece-1", (31, 22)),
       ("cat-sit", "wc/p/piece-2", (16, 21)), ("cat-sleep", "wc/p/piece-3", (26, 12)),
       ("cat-held", "wc/p/piece-4", (22, 28))]


def main():
    work = os.path.abspath(sys.argv[1])
    out = os.path.join(ROOT, "assets", "decor")
    os.makedirs(out, exist_ok=True)
    meta = []
    for id_, name, price, piece, spec, hw, dp, blocks in ITEMS:
        dst = os.path.join(out, id_ + ".png")
        snap.snap_obj(os.path.join(work, piece + ".png"), dst, spec.get("width"), spec.get("height"), 24)
        w, h = Image.open(dst).size
        meta.append({"id": id_, "name": name, "price": price, "size": [w, h], "anchor": [w // 2, h - 1],
                     "footprint": [[-hw, -dp], [hw, -dp], [hw, 0], [-hw, 0]], "blocks": blocks})
    json.dump({"version": 1, "note": "size/anchor in scene px; anchor = floor contact (bottom-centre); footprint like scene.json kinds",
               "items": meta}, open(os.path.join(HERE, "items.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sp = os.path.join(ROOT, "assets", "sprites")
    tmp = os.path.join(work, "cat-tmp.png")
    for name, piece, (cw, ch) in CAT:
        src = Image.open(os.path.join(work, piece + ".png"))
        f = min(cw / src.width, ch / src.height)
        snap.snap_obj(os.path.join(work, piece + ".png"), tmp, round(src.width * f) if src.width * f <= cw and src.height * f <= ch else None,
                      None if src.width * f <= cw and src.height * f <= ch else ch, 18)
        im = Image.open(tmp)
        if im.width > cw or im.height > ch:
            im = im.crop(im.getchannel("A").getbbox())
        c = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        c.paste(im, ((cw - im.width) // 2, ch - im.height))
        c.save(os.path.join(sp, name + ".png"))
        print(name, im.size, "->", c.size)


if __name__ == "__main__":
    main()
