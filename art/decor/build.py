"""Builds the desk decor atlas: assets/decor/decor.png + decor.json, and the review sheets in art/decor/.

  python art/decor/build.py

Props are drawn at native pixel size (sprites.py: ASCII rows, screens.py: procedural screens), given a selective outline,
a left-lit bevel and a contact shadow here, packed into one transparent atlas, and described together with the measured
desk slots (DESKS below: pixels from the top-left of the desk sprite as drawn in the design's objects.png, unflipped).
Also writes art/decor/contact-sheet.png and art/decor/preview-<design>.png (3 combinations per desk kind, 1x and 3x).
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import screens  # noqa: E402
import sprites  # noqa: E402

OUT_DIR = os.path.join(ROOT, "assets", "decor")
ATLAS_W = 512

# ---------------------------------------------------------------------------------------------------------------
# Measured desk slots. Points are bottom-centre anchors of the item that goes there; screen = [x, y, w, h].
# `shear`: the lounge draws its monitors in 2:1 isometric, so its screens are sheared quads inside their bounding rect.
# ---------------------------------------------------------------------------------------------------------------
DESKS = {
    "studio2": {
        "desk": dict(surface=[[23, 25], [24, 16], [60, 25], [67, 19], [75, 25], [75, 15]], monitorTop=[[42, 0]],
                     bezel=[[33, 17], [33, 8], [51, 17], [51, 8]], monitorEdge=[[28, 14], [56, 12]], screen=[29, 1, 26, 17]),
        "lead-desk": dict(surface=[[34, 19], [34, 27], [75, 20], [84, 27], [93, 21], [88, 15]], monitorTop=[[55, 0]],
                          bezel=[[45, 17], [45, 8], [65, 17], [65, 8]], monitorEdge=[[40, 14], [69, 12]], screen=[41, 1, 28, 17]),
    },
    "lounge": {
        "desk": dict(surface=[[14, 20], [20, 23], [47, 36], [55, 40], [62, 44], [83, 35]], monitorTop=[[40, 12]],
                     bezel=[[32, 21], [38, 24], [45, 27]], monitorEdge=[[27, 17], [51, 28]], screen=[27, 6, 25, 28], shear=16),
        "lead-desk": dict(surface=[[22, 23], [30, 27], [38, 31], [63, 43], [72, 49], [82, 48]], monitorTop=[[54, 17]],
                          bezel=[[46, 26], [53, 30], [60, 34]], monitorEdge=[[41, 20], [66, 32]], screen=[41, 10, 26, 29], shear=17),
    },
    "library": {
        "desk": dict(surface=[[7, 24], [13, 19], [19, 25], [56, 25], [56, 18]], monitorTop=[[37, 0]],
                     bezel=[[29, 16], [29, 8], [45, 16], [45, 8]], monitorEdge=[[24, 12], [49, 10]], screen=[25, 2, 24, 15]),
        "lead-desk": dict(surface=[[6, 24], [32, 22], [34, 16], [72, 23], [74, 17], [97, 23]], monitorTop=[[53, 0]],
                          bezel=[[45, 17], [45, 8], [62, 17], [62, 8]], monitorEdge=[[41, 13], [66, 11]], screen=[42, 2, 24, 16]),
    },
    "greenhouse": {
        "desk": dict(surface=[[7, 26], [14, 20], [20, 27], [60, 27], [59, 20]], monitorTop=[[39, 0]],
                     bezel=[[30, 17], [30, 9], [51, 17], [51, 9]], monitorEdge=[[23, 13], [55, 11]], screen=[24, 2, 30, 16]),
        "lead-desk": dict(surface=[[5, 26], [31, 27], [75, 25], [77, 19], [79, 29]], monitorTop=[[52, 0]],
                          bezel=[[41, 18], [41, 9], [63, 18], [63, 9]], monitorEdge=[[35, 14], [69, 12]], screen=[36, 2, 33, 19]),
    },
    "lobby": {
        "desk": dict(surface=[[8, 8], [15, 6], [46, 8], [54, 5], [70, 7]], monitorTop=[[30, 3]],
                     bezel=[[28, 8], [33, 8]], monitorEdge=[[22, 6], [38, 6]], screen=[23, 4, 14, 4]),
        "desk-b": dict(surface=[[30, 13], [38, 10], [45, 13], [51, 9], [28, 9]], monitorTop=[[62, 0]],
                       bezel=[[57, 8], [66, 8]], monitorEdge=[[54, 6], [69, 5]], screen=[55, 1, 14, 10]),
    },
}
ORDER = ["studio2", "lounge", "library", "greenhouse", "lobby"]


# ---------------------------------------------------------------------------------------------------------------
# rendering one sprite
# ---------------------------------------------------------------------------------------------------------------
def _scale(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)


def _lift(c, a):
    return tuple(int(v + (255 - v) * a) for v in c)


def render_sprite(spec):
    rows = spec["rows"]
    w = max(len(r) for r in rows)
    body = {}
    for y, r in enumerate(rows):
        for x, ch in enumerate(r.ljust(w, ".")):
            if ch != ".":
                body[(x, y)] = sprites.PAL[ch]
    xs = [p[0] for p in body]
    ys = [p[1] for p in body]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    body = {(x - x0, y - y0): c for (x, y), c in body.items()}
    bw, bh = x1 - x0 + 1, y1 - y0 + 1

    if spec.get("shade", True):
        shaded = {}
        for (x, y), c in body.items():
            nc = c
            if (x + 1, y) not in body or (x, y + 1) not in body:
                nc = _scale(c, 0.8)
            elif (x, y - 1) not in body or (x - 1, y) not in body:
                nc = _lift(c, 0.2)
            shaded[(x, y)] = nc
        body = shaded

    white = spec.get("outline") == "white"
    shadow = spec["slot"] == "surface"
    W, H = bw + 2, bh + 2 + (1 if shadow else 0)
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = im.load()
    for (x, y), c in body.items():
        px[x + 1, y + 1] = c + (255,)
    for y in range(-1, bh + 1):
        for x in range(-1, bw + 1):
            if (x, y) in body:
                continue
            near = [body[n] for n in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)) if n in body]
            if not near:
                continue
            if white:
                px[x + 1, y + 1] = (246, 242, 232, 255)
            else:
                avg = tuple(sum(c[i] for c in near) // len(near) for i in range(3))
                px[x + 1, y + 1] = _scale(avg, 0.4) + (255,)
    if shadow:
        for x in range(2, bw + 2):
            if px[x, bh + 1][3] == 0:
                px[x, bh + 1] = (40, 24, 14, 70)
    ax = 1 + (min(p[0] for p in body) + max(p[0] for p in body)) // 2
    ay = bh + 1  # the outline row under the body is the contact row
    return im, [ax, ay]


# ---------------------------------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------------------------------
def build_items():
    items = {}
    for id_, spec in sprites.ITEMS.items():
        im, anchor = render_sprite(spec)
        meta = {"slot": spec["slot"], "tags": spec["tags"]}
        if spec.get("personal"):
            meta["personal"] = spec["personal"]
        items[id_] = (im, anchor, meta)
    cache = {}
    for design in ORDER:
        for kind, d in DESKS[design].items():
            x, y, w, h = d["screen"]
            cw, ch = (w, d["shear"]) if d.get("shear") else (w, h)
            for content in screens.CONTENTS:
                key = (content, cw, ch, bool(d.get("shear")))
                if key not in cache:
                    im = screens.screen(content, cw, ch)
                    if d.get("shear"):
                        im = screens.shear(im)
                        assert im.size == (w, h), (design, kind, im.size, (w, h))
                    cache[key] = im
                items[f"screen-{content}-{design}-{kind}"] = (cache[key], [0, 0], {
                    "slot": "screen", "tags": ["screen", content], "design": design, "kind": kind, "content": content})
    return items


def pack(items):
    """Shelf packing; identical pixel buffers (shared screens) share one rect."""
    uniq = {}
    for id_, (im, _a, _m) in items.items():
        uniq.setdefault((im.size, im.tobytes()), im)
    order = sorted(uniq.items(), key=lambda kv: (-kv[0][0][1], -kv[0][0][0]))
    pos = {}
    x = y = shelf = 0
    for key, im in order:
        w, h = im.size
        if x + w + 1 > ATLAS_W:
            x, y, shelf = 0, y + shelf + 1, 0
        pos[key] = (x, y)
        x += w + 1
        shelf = max(shelf, h)
    atlas = Image.new("RGBA", (ATLAS_W, y + shelf + 1), (0, 0, 0, 0))
    for key, im in uniq.items():
        atlas.paste(im, pos[key])
    return atlas, {id_: [*pos[(im.size, im.tobytes())], *im.size] for id_, (im, _a, _m) in items.items()}


def write_atlas(items):
    atlas, rects = pack(items)
    os.makedirs(OUT_DIR, exist_ok=True)
    atlas.save(os.path.join(OUT_DIR, "decor.png"), optimize=True)
    out = {"version": 1, "atlas": "decor.png", "items": {}, "desks": {}}
    for id_, (im, anchor, meta) in items.items():
        out["items"][id_] = {"rect": rects[id_], "anchor": anchor, **meta}
    for design in ORDER:
        out["desks"][design] = {}
        for kind, d in DESKS[design].items():
            out["desks"][design][kind] = {k: v for k, v in d.items() if k != "shear"}
    with open(os.path.join(OUT_DIR, "decor.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return atlas, out


# ---------------------------------------------------------------------------------------------------------------
# review sheets
# ---------------------------------------------------------------------------------------------------------------
def contact_sheet(items):
    cell_items = [(i, v) for i, v in items.items() if not i.startswith("screen-")]
    shown = {}
    for i, v in items.items():  # one screen per content and size, labelled once
        if i.startswith("screen-"):
            shown.setdefault((v[2]["content"], v[0].size), (i, v))
    cell_items += [(f"{k[0]} {k[1][0]}x{k[1][1]}", v[1]) for k, v in shown.items()]
    S = 4
    pad = 6
    bg = (196, 192, 184, 255)
    font = None
    tmp = Image.new("RGBA", (10, 10))
    d0 = ImageDraw.Draw(tmp)
    cells = []
    for id_, v in cell_items:
        im = v[0]
        tw = int(d0.textlength(id_))
        cells.append((id_, im, max(im.width * S, tw) + pad * 2, im.height * S + 14 + pad * 2))
    width = 1500
    x = y = rowh = 0
    place = []
    for c in cells:
        if x + c[2] > width:
            x, y, rowh = 0, y + rowh, 0
        place.append((c, x, y))
        x += c[2]
        rowh = max(rowh, c[3])
    sheet = Image.new("RGBA", (width, y + rowh), bg)
    dr = ImageDraw.Draw(sheet)
    for (id_, im, cw, ch), cx, cy in place:
        big = im.resize((im.width * S, im.height * S), Image.NEAREST)
        sheet.alpha_composite(big, (cx + pad, cy + pad))
        dr.text((cx + pad, cy + pad + im.height * S + 2), id_, fill=(30, 28, 32, 255))
    sheet.save(os.path.join(HERE, "contact-sheet.png"))


def floor_colour(design):
    p = os.path.join(ROOT, "assets", "scenes", design, "shell.png")
    if not os.path.exists(p):
        return (200, 196, 188, 255)
    im = Image.open(p).convert("RGB")
    w, h = im.size
    box = im.crop((w // 3, h * 2 // 3, w * 2 // 3, h * 5 // 6)).resize((1, 1), Image.BOX)
    return box.getpixel((0, 0)) + (255,)


def desk_crop(design, kind):
    scene = json.load(open(os.path.join(ROOT, "assets", "scenes", design, "scene.json"), encoding="utf-8"))
    r = scene["kinds"][kind]["rect"]
    atlas = Image.open(os.path.join(ROOT, "assets", "scenes", design, "objects.png")).convert("RGBA")
    return atlas.crop((r[0], r[1], r[0] + r[2], r[1] + r[3]))


def compose(design, kind, combo, items, margin=(16, 14)):
    """combo: dict(surface=[(point index, id)...], top=id|None, bezel=[(i,id)], edge=[(i,id)], screen=id|None)."""
    desk = desk_crop(design, kind)
    d = DESKS[design][kind]
    mx, my = margin
    im = Image.new("RGBA", (desk.width + mx * 2, desk.height + my + 6), (0, 0, 0, 0))
    im.alpha_composite(desk, (mx, my))

    def put(id_, pt, topleft=False):
        sprite, anchor, _m = items[id_]
        px_, py_ = (pt[0] - 0, pt[1] - 0) if topleft else (pt[0] - anchor[0], pt[1] - anchor[1])
        im.alpha_composite(sprite, (mx + px_, my + py_)) if (mx + px_ >= 0 and my + py_ >= 0) else None

    if combo.get("screen"):
        put(combo["screen"], d["screen"][:2], topleft=True)
    for i, id_ in sorted(combo.get("bezel", []), key=lambda t: d["bezel"][t[0]][1]):
        put(id_, d["bezel"][i])
    for i, id_ in combo.get("edge", []):
        put(id_, d["monitorEdge"][i])
    if combo.get("top"):
        put(combo["top"], d["monitorTop"][0])
    for i, id_ in sorted(combo.get("surface", []), key=lambda t: d["surface"][t[0]][1]):
        put(id_, d["surface"][i])
    return im


def make_combos(design, kind, items, seed):
    rnd = random.Random(f"{design}/{kind}/{seed}")
    d = DESKS[design][kind]
    plain = [i for i, v in items.items() if v[2]["slot"] == "surface" and "lead" not in v[2]["tags"] and "personal" not in v[2]]
    pers = [i for i, v in items.items() if "personal" in v[2]]
    leads = [i for i, v in items.items() if "lead" in v[2]["tags"]]
    tops = [i for i, v in items.items() if v[2]["slot"] == "monitorTop"]
    bez = [i for i, v in items.items() if v[2]["slot"] == "bezel"]
    notes = [i for i, v in items.items() if v[2]["slot"] == "monitorEdge"]
    scr = [f"screen-{c}-{design}-{kind}" for c in screens.CONTENTS]
    combos = []
    for n in range(3):
        k = 3 if len(d["surface"]) >= 5 else 2
        idx = rnd.sample(range(len(d["surface"])), k)
        pool = list(plain)
        surf = []
        for j, i in enumerate(idx):
            if j == 0 and kind in ("lead-desk",):
                surf.append((i, rnd.choice(leads)))
            elif j == 0 and n == 2:
                surf.append((i, rnd.choice(pers)))
            else:
                surf.append((i, pool.pop(rnd.randrange(len(pool)))))
        combos.append(dict(surface=surf, top=rnd.choice(tops) if n != 1 else None,
                           bezel=[] if n != 1 else [(i, rnd.choice(bez)) for i in rnd.sample(range(len(d["bezel"])), min(3, len(d["bezel"])))],
                           edge=[(rnd.randrange(len(d["monitorEdge"])), rnd.choice(notes))],
                           screen=rnd.choice(scr) if n != 1 else None))
    return combos


def previews(items):
    for design in ORDER:
        bg = floor_colour(design)
        rows = []
        for kind in DESKS[design]:
            ims = [compose(design, kind, c, items) for c in make_combos(design, kind, items, 1)]
            rows.append(ims)
        w = max(sum(i.width for i in r) + 12 * (len(r) + 1) for r in rows)
        h1 = sum(max(i.height for i in r) for r in rows) + 12 * (len(rows) + 1)
        sheet = Image.new("RGBA", (max(w, 100), h1 + 4), bg)
        y = 12
        for r in rows:
            x = 12
            for i in r:
                sheet.alpha_composite(i, (x, y))
                x += i.width + 12
            y += max(i.height for i in r) + 12
        sheet3 = Image.new("RGBA", (sheet.width * 3, sheet.height * 3), bg)
        sheet3.alpha_composite(sheet.resize((sheet.width * 3, sheet.height * 3), Image.NEAREST))
        final = Image.new("RGBA", (sheet3.width, sheet.height + sheet3.height + 8), bg)
        final.alpha_composite(sheet, (0, 0))
        final.alpha_composite(sheet3, (0, sheet.height + 8))
        final.save(os.path.join(HERE, f"preview-{design}.png"))


def main():
    items = build_items()
    atlas, out = write_atlas(items)
    contact_sheet(items)
    previews(items)
    print(f"items {len(items)}  atlas {atlas.size}  screens {sum(1 for i in items if i.startswith('screen-'))}")


if __name__ == "__main__":
    main()
