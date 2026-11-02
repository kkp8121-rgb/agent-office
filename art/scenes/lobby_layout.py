"""Writes the hand layout of assets/scenes/lobby/scene.json (everything except kinds[*].rect, which art/atlas.py keeps).

  python art/scenes/lobby_layout.py
Then: python art/atlas.py lobby (rects), python art/front.py lobby, python art/backdrop.py lobby.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = os.path.join(ROOT, "assets", "scenes", "lobby", "scene.json")
sc = json.load(open(P, encoding="utf-8")) if os.path.exists(P) else {"kinds": {}}
K = sc.setdefault("kinds", {})


def kind(name, fp, blocks=True, seat=None):
    k = K.setdefault(name, {})
    r = k["rect"]
    k["anchor"] = [r[2] // 2, r[3] - 1] if name != "chair" else [13, 41]
    k["footprint"] = [[-fp[0], -fp[1]], [fp[0], -fp[1]], [fp[0], 0], [-fp[0], 0]]
    k["blocks"] = blocks
    k["depth"] = "auto"
    k.pop("seat", None)
    if seat:
        k["seat"] = seat
    # keep key order stable: rect, anchor, footprint, blocks, depth, seat
    for key in ("rect", "anchor", "footprint", "blocks", "depth", "seat"):
        if key in k:
            k[key] = k.pop(key)


kind("desk", (38, 16), seat={"at": [0, -48], "sitAt": [0, -46], "approach": [0, 22], "face": "right"})
kind("chair", (9, 5), blocks=False)
kind("reception", (65, 18))
kind("sofa", (52, 22))
kind("table", (20, 10))
kind("palm", (12, 9))
kind("plant-big", (14, 10))
kind("fern", (24, 10))
kind("stand", (10, 6))
kind("cart", (28, 12))
kind("bench", (40, 10))

COLS = [288 + 92 * i for i in range(8)]
ROWS = [345, 405, 465, 525, 585]
objs, seats = [], []
n = 0
for y in ROWS:
    for x in COLS:
        n += 1
        objs.append({"id": f"desk-{n}", "kind": "desk", "at": [x, y]})
        objs.append({"id": f"chair-{n}", "kind": "chair", "at": [x, y - 50]})
        seats.append(f"desk-{n}")
objs += [
    {"id": "reception", "kind": "reception", "at": [1090, 552]},
    {"id": "sofa-1", "kind": "sofa", "at": [150, 420]},
    {"id": "sofa-2", "kind": "sofa", "at": [110, 500]},
    {"id": "table-1", "kind": "table", "at": [160, 458]},
    {"id": "palm-1", "kind": "palm", "at": [215, 335]},
    {"id": "palm-2", "kind": "palm", "at": [1118, 352]},
    {"id": "plant-1", "kind": "plant-big", "at": [60, 520]},
    {"id": "fern-1", "kind": "fern", "at": [420, 284]},
    {"id": "fern-2", "kind": "fern", "at": [860, 284]},
    {"id": "stand-1", "kind": "stand", "at": [1120, 470]},
    {"id": "bench-1", "kind": "bench", "at": [1010, 636], "flipX": True},
    {"id": "cart-1", "kind": "cart", "at": [920, 640]},
]
sc.update({
    "version": 1, "design": "lobby", "size": [1280, 720], "shell": "shell.png", "atlas": "objects.png", "front": "front.png",
    "board": [16, 8, 320, 48], "reports": [0, 0], "sign": None,
    "walkable": [[[205, 312], [300, 292], [960, 292], [1060, 300], [1128, 372], [1226, 494], [1110, 586], [905, 674], [372, 674], [206, 574], [60, 478], [60, 440], [140, 360]]],
    "blocked": [],
    "frontMask": [[[372, 668], [905, 668], [905, 704], [372, 704]]],
    "door": {"at": [1160, 440], "face": "left"},
    "objects": objs, "seats": seats,
    "lead": {"desk": "reception", "at": [1090, 488], "sitAt": [1090, 486], "approach": [1070, 578], "face": "left"},
    "tray": {"object": "reception", "queue": [[985 + 27 * c, 335 + 28 * r] for r in range(3) for c in range(4)]},
    "idle": [{"at": [430 + 52 * i, 636], "face": "right" if i % 2 else "left"} for i in range(6)],
    "overflow": [{"at": [1010 + 28 * c, y], "face": "left"} for y in (420, 448) for c in range(4)]
                + [{"at": [224, y], "face": "right"} for y in (372, 404, 436, 500)],
    "spots": [
        {"id": "lounge", "kind": "sofa", "at": [190, 375], "face": "right"},
        {"id": "plant", "kind": "plant", "at": [380, 640], "face": "left"},
        {"id": "coffee", "kind": "coffee", "at": [850, 640], "face": "right"},
        {"id": "info", "kind": "other", "at": [1135, 505], "face": "left"},
    ],
    "ledWall": {"panels": [
        {"id": "center", "quad": [[459, 67], [824, 67], [824, 169], [459, 169]]},
        {"id": "left", "quad": [[222, 140], [396, 82], [396, 162], [222, 220]]},
        {"id": "right", "quad": [[884, 82], [1058, 140], [1058, 220], [884, 162]]},
        {"id": "tickerCenter", "quad": [[459, 181], [824, 181], [824, 197], [459, 197]]},
        {"id": "tickerLeft", "quad": [[222, 232], [396, 185], [396, 201], [222, 248]]},
        {"id": "tickerRight", "quad": [[884, 185], [1058, 232], [1058, 248], [884, 201]]},
    ]},
})
sc.pop("windows", None); sc.pop("whiteboard", None); sc.pop("meeting", None); sc.pop("seasonal", None)
order = ["version", "design", "size", "shell", "front", "atlas", "board", "reports", "sign", "walkable", "blocked", "frontMask", "door", "kinds", "objects", "seats", "lead", "tray", "idle", "overflow", "spots", "ledWall", "outline"]
out = {k: sc[k] for k in order if k in sc}
out.update({k: v for k, v in sc.items() if k not in out})
with open(P + ".tmp", "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
os.replace(P + ".tmp", P)
print("objects", len(objs), "seats", len(seats))
