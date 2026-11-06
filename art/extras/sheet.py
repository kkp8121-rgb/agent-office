"""Contact sheet: 3 existing girls + the 12 extras, standing (top) and seated (below) at the same scale (x4); optional
walking-leg check (two poses per girl) using the values in the walk json.
  python art/extras/sheet.py out.png walk.json [walk-out.png]"""
import json, os, sys
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "walk"))
import sheet as walk

S = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets", "sprites") + os.sep
keys = ["worker", "lead-3", "performance-reviewer"] + [f"extra-{n:02d}" for n in range(1, 13)]
z, BG = 4, (239, 230, 210, 255)
cw, rh = 54 * z, (64 + 52) * z + 14
big = lambda im, k=z: im.resize((im.width * k, im.height * k), Image.NEAREST)

im = Image.new("RGBA", (cw * 8, rh * 2), BG)
d = ImageDraw.Draw(im)
for n, k in enumerate(keys):
    ox, oy = (n % 8) * cw, (n // 8) * rh
    im.alpha_composite(big(Image.open(S + k + ".png").convert("RGBA")), (ox + 4, oy + 12))
    im.alpha_composite(big(Image.open(S + k + "-sit.png").convert("RGBA")), (ox + 4, oy + 12 + 64 * z + 4))
    d.text((ox + 4, oy + 1), k, fill=(0, 0, 0, 255))
im.convert("RGB").save(sys.argv[1])
print(sys.argv[1], im.size)

if len(sys.argv) > 3:
    hips = json.load(open(sys.argv[2]))["hips"]
    zz, fw, fh = 3, 60 * 3, 76 * 3
    out = Image.new("RGBA", (fw * 8, fh * 3), BG)
    d = ImageDraw.Draw(out)
    for n, k in enumerate(keys[3:]):
        a = Image.open(S + k + ".png").convert("RGBA")
        hip, sp = hips[k] or [78.125, 50]
        ox, oy = (n % 4) * fw * 2, (n // 4) * fh
        d.text((ox + 2, oy + 1), f"{k} hip {hip} split {sp}", fill=(0, 0, 0, 255))
        for i, pose in enumerate((0, 1)):
            out.alpha_composite(big(walk.frame(a, hip, sp, pose, 0), zz), (ox + i * fw, oy + 12))
    out.convert("RGB").save(sys.argv[3])
    print(sys.argv[3])
