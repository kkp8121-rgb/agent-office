"""Contact sheet (light + dark, 4x) and room check (items pasted onto shell crops, 2x).

  python art/seasonal/sheet.py <out dir>
"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
A = os.path.join(ROOT, "assets")
items = json.load(open(os.path.join(A, "seasonal", "items.json"), encoding="utf-8"))
ims = {i["name"]: Image.open(os.path.join(A, i["file"])).convert("RGBA") for i in items}


def contact(out):
    Z, pad = 4, 8
    W = sum(im.width * Z + pad for im in ims.values())
    cols = 8
    names = list(ims)
    rows = [names[i:i + cols] for i in range(0, len(names), cols)]
    H = sum(max(ims[n].height for n in r) * Z + 2 * pad for r in rows)
    sheet = Image.new("RGBA", (1700, H * 2), (0, 0, 0, 0))
    for side, bg in enumerate([(236, 234, 224, 255), (38, 40, 52, 255)]):
        sheet.paste(Image.new("RGBA", (1700, H), bg), (0, side * H))
        y = side * H + pad
        for r in rows:
            x, mh = pad, max(ims[n].height for n in r) * Z
            for n in r:
                a = ims[n].resize((ims[n].width * Z, ims[n].height * Z), Image.NEAREST)
                sheet.alpha_composite(a, (x, y + mh - a.height))
                x += a.width + pad
            y += mh + 2 * pad
    sheet.save(os.path.join(out, "contact.png"))


def rooms(out):
    picks = [("halloween-pumpkin-big", 330, 330), ("halloween-bats", 420, 60),
             ("christmas-tree", 520, 330), ("christmas-wreath", 640, 70),
             ("lunar-lantern", 780, 60), ("lunar-pouch", 700, 330), ("snack-coffee", 440, 320)]
    designs = ["studio2", "lounge", "library", "greenhouse"]
    tiles = []
    for d in designs:
        sh = Image.open(os.path.join(A, "scenes", d, "shell.png")).convert("RGBA")
        for n, x, y in picks:
            im, it = ims[n], next(i for i in items if i["name"] == n)
            sh.alpha_composite(im, (x - it["anchor"][0], y - it["anchor"][1]))
        tiles.append(sh.crop((300, 0, 880, 420)).resize((1160, 840), Image.NEAREST))
    sheet = Image.new("RGBA", (2320, 1680))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % 2) * 1160, (i // 2) * 840))
    sheet.save(os.path.join(out, "rooms.png"))


if __name__ == "__main__":
    o = os.path.abspath(sys.argv[1])
    os.makedirs(o, exist_ok=True)
    contact(o)
    rooms(o)
