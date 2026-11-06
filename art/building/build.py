"""Building cross-section art: assets/building/*.png + art/building/contact.png.

  python art/building/build.py
Small pieces (windows, racks, crane, elevator, sign stand) are hand pixels from pieces.py.
Big pictures (roof, basement, exterior-day, exterior-night) come from Codex (python art/building/gen.py <key>); their raw pictures live in
the work folder (AGENT_OFFICE_ART_WORK, outside the repo) and are snapped here. A key whose raw picture is missing keeps the committed file.
Widths come from config.json: roof/basement = building.innerW, facade windows = building.facadePx, elevator pieces <= building.shaftPx.
Everything is deterministic: run it twice and the bytes are identical."""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pieces  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "assets", "building")
WORK = (os.environ.get("AGENT_OFFICE_ART_WORK") or os.path.join(HERE, "work")).replace("\\", "/")
CFG = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))["ui"]["building"]
INNER_W, ROOF_H, BASE_H = CFG["innerW"], CFG["roofPx"], CFG["basementPx"]
EXT_W, EXT_H = 320, 640            # exterior-day / exterior-night


def key_magenta(im):
    """Flat #FF00FF background -> transparent, magenta fringe pixels dropped, alpha 0/255."""
    a = np.array(im.convert("RGBA"))
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    mag = (r > 200) & (b > 200) & (g < 90)
    fringe = (r - g > 110) & (b - g > 110)
    a[mag | fringe, 3] = 0
    a[..., 3] = np.where(a[..., 3] >= 128, 255, 0)
    return Image.fromarray(a, "RGBA")


def quant(im, colors):
    """Limit colours, keep alpha 0/255, no dither."""
    alpha = im.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    rgb = im.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def snap_strip(raw, w, h, colors, keyed):
    """A wide strip picture: crop to content, scale to height h (BOX), then centre-crop or tile-stretch to width w."""
    im = Image.open(raw).convert("RGBA")
    if keyed:
        im = key_magenta(im)
        box = im.getchannel("A").getbbox()
        if box:
            im = im.crop(box)
    sc = h / im.height
    nw = max(1, round(im.width * sc))
    im = im.resize((nw, h), Image.BOX)
    if nw != w:
        im = im.resize((w, h), Image.BOX)
    return quant(im, colors)


def snap_exterior(raw, w, h, colors):
    im = Image.open(raw).convert("RGBA")
    # cover-fit: scale so both sides are at least the target, centre-crop
    sc = max(w / im.width, h / im.height)
    nw, nh = round(im.width * sc), round(im.height * sc)
    im = im.resize((nw, nh), Image.BOX)
    x0, y0 = (nw - w) // 2, (nh - h) // 2
    im = im.crop((x0, y0, x0 + w, y0 + h))
    out = quant(im, colors)
    out.putalpha(255)
    return out


def big():
    done = []
    jobs = (
        ("roof", lambda p: snap_strip(p, INNER_W, ROOF_H, 28, True)),
        ("basement", lambda p: snap_strip(p, INNER_W, BASE_H, 32, False)),
        ("exterior-day", lambda p: snap_exterior(p, EXT_W, EXT_H, 40)),
        ("exterior-night", lambda p: snap_exterior(p, EXT_W, EXT_H, 40)),
    )
    for key, fn in jobs:
        raw = f"{WORK}/{key}.png"
        if os.path.exists(raw):
            fn(raw).save(os.path.join(OUT, key + ".png"))
            done.append(key)
    return done


def _pad(im, w):
    out = Image.new("RGBA", (w, im.height), (0, 0, 0, 0))
    out.alpha_composite(im, (0, 0))
    return out


def contact(names):
    """Check sheet: every piece on a light and on a dark ground, drawn at 1x (wide strips at 1/2)."""
    ims = [(n, Image.open(os.path.join(OUT, n + ".png")).convert("RGBA")) for n in names]
    pad = 12
    colw = 1060
    rows = []
    for n, im in ims:
        if im.width > 700:
            im = im.resize((im.width // 2, im.height // 2), Image.NEAREST)
        rows.append((n, im if im.width >= 7 * len(n) else _pad(im, 7 * len(n))))
    # greedy rows of pieces
    layout, cur, curw = [], [], 0
    for n, im in rows:
        if curw + im.width + pad > colw and cur:
            layout.append(cur)
            cur, curw = [], 0
        cur.append((n, im))
        curw += im.width + pad
    layout.append(cur)
    height = sum(max(i.height for _, i in r) + 24 for r in layout) + pad
    sheet = Image.new("RGBA", (colw * 2, height), (0, 0, 0, 255))
    d = ImageDraw.Draw(sheet)
    d.rectangle([0, 0, colw - 1, height], fill=(236, 232, 222, 255))
    d.rectangle([colw, 0, colw * 2, height], fill=(24, 28, 44, 255))
    y = pad
    for r in layout:
        x = pad
        rh = max(i.height for _, i in r)
        for n, im in r:
            for off, fg in ((0, (40, 40, 40, 255)), (colw, (210, 210, 210, 255))):
                sheet.alpha_composite(im, (x + off, y + 14))
                d.text((x + off, y), n, fill=fg)
            x += im.width + pad
        y += rh + 24
    sheet = sheet.convert("RGB")
    sheet.save(os.path.join(HERE, "contact.png"))


ORDER = ["facade-window-day", "facade-window-night-off", "facade-window-night-on", "roof", "basement", "rack-off", "rack-on",
         "crane-arm", "crane-hook", "elev-car", "elev-shaft-door", "sign-stand", "exterior-day", "exterior-night"]

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, fn in pieces.SMALL.items():
        fn().save(os.path.join(OUT, name + ".png"))
    done = big()
    missing = [n for n in ORDER if not os.path.exists(os.path.join(OUT, n + ".png"))]
    if not missing:
        contact(ORDER)
    print("snapped", done, "missing", missing)
