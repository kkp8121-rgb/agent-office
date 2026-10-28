"""Snap split pieces into assets/sprites/<key>-sit.png and build the contact sheet.
python art/sit/build.py [key ...]   (no keys = all)"""
import json, subprocess, sys
from PIL import Image, ImageDraw

ROOT = "C:/Users/gustj/agent-office"
S = "C:/Users/gustj/AppData/Local/Temp/claude/C--Project/6106276a-a6e5-4468-8650-198bebbf83af/scratchpad/layers/sit"
P = json.load(open(ROOT + "/art/sit/prompts.json", encoding="utf-8"))
only = set(sys.argv[1:])
keys = [k for s in P["sheets"] for k in s]
for si, sheet in enumerate(P["sheets"]):
    for pi, k in enumerate(sheet):
        if only and k not in only:
            continue
        piece = f"{S}/p{si}/piece-{pi}.png"
        subprocess.run(["python", ROOT + "/art/snap.py", "sprite", piece, f"{ROOT}/assets/sprites/{k}-sit.png", "--height", "50", "--colors", "20"], check=True, capture_output=True)
BG, DESK = (232, 226, 214), (140, 98, 62)
sc, w, h = 3, 70 * 3 * 3, 72 * 3
im = Image.new("RGB", (w * 2, h * 9), BG)
d = ImageDraw.Draw(im)
for n, k in enumerate(keys):
    ox, oy = (n // 9) * w, (n % 9) * h
    stand = Image.open(f"{ROOT}/assets/sprites/{k}.png").convert("RGBA")
    sit = Image.open(f"{ROOT}/assets/sprites/{k}-sit.png").convert("RGBA")
    base = oy + h - 4 * sc

    def put(img, x, flip=False, desk=False):
        if flip:
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
        img = img.resize((img.width * sc, img.height * sc), Image.NEAREST)
        im.paste(img, (ox + x, base - img.height), img)
        if desk:
            d.rectangle([ox + x - 8, base - 20 * sc, ox + x + img.width + 8, base], fill=DESK)

    put(stand, 8)
    put(sit, 8 + 70 * sc)
    put(sit, 8 + 140 * sc, flip=True, desk=True)
    d.text((ox + 2, oy + 2), k, fill=(0, 0, 0))
im.save(ROOT + "/art/sit/contact-sit.png")
im.save(S + "/contact-sit.png")
print("ok", im.size)
