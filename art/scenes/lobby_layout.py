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
    k["anchor"] = [r[2] // 2, r[3] - 1]
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


# front-view desks: the standing picture of the agent stands 13 px behind the desk's front line (at == sitAt, no seated picture)
DESK_SEAT = {"at": [0, -13], "sitAt": [0, -13], "approach": [0, 16], "face": "right"}
kind("desk", (38, 12), seat=dict(DESK_SEAT))
kind("desk-b", (38, 12), seat=dict(DESK_SEAT))
kind("chair", (9, 5), blocks=False)
kind("reception", (65, 14))
kind("sofa", (52, 22))
kind("table", (20, 10))
kind("palm", (12, 9))
kind("plant-big", (14, 10))
kind("fern", (24, 10))
kind("stand", (10, 6))
kind("cart", (28, 12))
kind("bench", (40, 10))

# screen art quads (navy area, tl tr br bl) written by art/scenes/lobby_wings.py; the text quads are the navy inset by a few pixels
WINGS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lobby-wings.json")))


def inset(q, k):
    """Quad moved k px inside: vertical edges x +-k, slanted top/bottom edges y +-k (the edges stay on their lines)."""
    (tl, tr, br, bl) = q
    f = lambda a, b, x: a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])
    x0, x1 = tl[0] + k, tr[0] - k
    r = lambda v: round(v, 1)
    return [[x0, r(f(tl, tr, x0) + k)], [x1, r(f(tl, tr, x1) + k)], [x1, r(f(bl, br, x1) - k)], [x0, r(f(bl, br, x0) - k)]]


COLS = [296 + 90 * i for i in range(8)]
ROWS = [345, 407, 469, 531, 593]
objs, seats = [], []
n = 0
for y in ROWS:
    for x in COLS:
        n += 1
        objs.append({"id": f"desk-{n}", "kind": "desk-b" if COLS.index(x) % 2 else "desk", "at": [x, y]})
        objs.append({"id": f"chair-{n}", "kind": "chair", "at": [x, y - 17]})
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
    {"id": "bench-1", "kind": "bench", "at": [1040, 650], "flipX": True},
    {"id": "cart-1", "kind": "cart", "at": [1115, 655]},
]
sc.update({
    "version": 1, "design": "lobby", "size": [1280, 720], "shell": "shell.png", "atlas": "objects.png", "front": "front.png",
    "board": [16, 8, 320, 48], "reports": [0, 0], "sign": None,
    "walkable": [[[205, 312], [300, 292], [960, 292], [1060, 300], [1128, 372], [1226, 494], [1110, 586], [905, 674], [372, 674], [206, 574], [60, 478], [60, 440], [140, 360]]],
    "blocked": [],
    "frontMask": [[[372, 668], [905, 668], [905, 704], [372, 704]]],
    "door": {"at": [1160, 440], "face": "left"},
    "objects": objs, "seats": seats,
    "lead": {"desk": "reception", "at": [1090, 520], "sitAt": [1090, 520], "approach": [1070, 578], "face": "right"},
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
        {"id": "center", "quad": [[458, 68], [821, 68], [821, 169], [458, 169]]},
        {"id": "left", "quad": inset(WINGS["left"], 2)},
        {"id": "right", "quad": inset(WINGS["right"], 2)},
        {"id": "tickerCenter", "quad": inset(WINGS["tickerCenter"], 1)},
        {"id": "tickerLeft", "quad": inset(WINGS["tickerLeft"], 1)},
        {"id": "tickerRight", "quad": inset(WINGS["tickerRight"], 1)},
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
