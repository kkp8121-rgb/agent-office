"""Contact sheets: python art/decor/sheet.py <decor-sheet.png> <cat-sheet.png> [old-cat-dir]"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
items = json.load(open(os.path.join(ROOT, "art", "decor", "items.json"), encoding="utf-8"))["items"]
BG = [(235, 235, 225, 255), (40, 42, 52, 255)]


def up(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def decor(dst):
    ims = [Image.open(os.path.join(ROOT, "assets", "decor", i["id"] + ".png")).convert("RGBA") for i in items]
    colw = [max(im.width * 3, 60) + 12 for im in ims]
    W = sum(colw) + 12
    rows = []
    for bg in BG:
        row = Image.new("RGBA", (W, 250), bg)
        x = 12
        for im, cw in zip(ims, colw):
            row.alpha_composite(im, (x, 8))
            row.alpha_composite(up(im, 3), (x, 245 - im.height * 3 if im.height * 3 < 230 else 8 + 40))
            x += cw
        rows.append(row)
    # composite onto each room: floor spots next to existing furniture
    spots = {"studio2": ("sofa", 560, 330), "lounge": ("plant-big", 560, 330),
             "library": ("bookshelf", 560, 330), "greenhouse": ("vending", 560, 330)}
    scenes = []
    for d, (it, x, y) in spots.items():
        sh = Image.open(os.path.join(ROOT, "assets", "scenes", d, "shell.png")).convert("RGBA")
        sc = json.load(open(os.path.join(ROOT, "assets", "scenes", d, "scene.json")))
        ob = Image.open(os.path.join(ROOT, "assets", "scenes", d, "objects.png")).convert("RGBA")
        for o in sc["objects"]:
            k = sc["kinds"][o["kind"]]
            r = k["rect"]
            sh.alpha_composite(ob.crop((r[0], r[1], r[0] + r[2], r[1] + r[3])), (o["at"][0] - k["anchor"][0], o["at"][1] - k["anchor"][1]))
        for n, (iid, dx, dy) in enumerate([(it, x, y), ("plant-small", x - 150, y + 20), ("rug", x + 150, y + 60)]):
            im = Image.open(os.path.join(ROOT, "assets", "decor", iid + ".png")).convert("RGBA")
            sh.alpha_composite(im, (dx - im.width // 2, dy - im.height))
        scenes.append(sh)
    H = sum(r.height for r in rows) + 512 * 2
    out = Image.new("RGBA", (max(W, 2048), H), (255, 255, 255, 255))
    y = 0
    for r in rows:
        out.alpha_composite(r, (0, y)); y += r.height
    out.alpha_composite(scenes[0], (0, y)); out.alpha_composite(scenes[1], (1024, y))
    out.alpha_composite(scenes[2], (0, y + 512)); out.alpha_composite(scenes[3], (1024, y + 512))
    out.convert("RGB").save(dst)


def cat(dst, old):
    names = ["cat-walk-1", "cat-walk-2", "cat-sit", "cat-sleep", "cat-held"]
    new = [Image.open(os.path.join(ROOT, "assets", "sprites", n + ".png")).convert("RGBA") for n in names]
    olds = [Image.open(os.path.join(old, n + ".png")).convert("RGBA") for n in names]
    ref = Image.open(os.path.join(ROOT, "assets", "sprites", "default.png")).convert("RGBA")
    W = 40 + sum(im.width * 4 + 20 for im in new) + ref.width * 4
    out = Image.new("RGBA", (W, 2 * 2 * 130), (0, 0, 0, 0))
    for r, bg in enumerate(BG):
        for q, (set_, lab) in enumerate(((olds, "old"), (new, "new"))):
            y0 = (r * 2 + q) * 130
            out.paste(Image.new("RGBA", (W, 130), bg), (0, y0))
            x = 10
            for im in set_:
                out.alpha_composite(im, (x, y0 + 4))
                out.alpha_composite(up(im, 4), (x + 40, y0 + 122 - im.height * 4)) if False else None
                x += 36
            x = 10 + 5 * 36 + 10
            for im in set_:
                out.alpha_composite(up(im, 4), (x, y0 + 126 - im.height * 4))
                x += im.width * 4 + 10
            if q == 1:
                pass
    out.convert("RGB").save(dst)


if __name__ == "__main__":
    decor(sys.argv[1])
    cat(sys.argv[2], sys.argv[3])
