"""Check sheet for one layered room (headless, Pillow only).

  python art/scene_sheet.py <design>

Writes art/scenes-check/<design>.png with four panels, top to bottom:
  1. composite scene   shell + objects in depth order + characters on every seat,
                       lead seat, tray queue, idle points and spots (+ front overlay)
  2. overlay           footprints, walkable grid, depth lines, point numbers, frontMask
  3. depth tests       zoomed tiles: in front of / behind desk and big plant
  4. old vs new        assets/floors/<design>.png over the new composite

Geometry is resolved here (same rules as web/scene.mjs). When scripts/check-scenes.mjs exists
the engine's own grid is read with `--json <design>` and drawn instead of the local one, and the
engine validator output is printed; without it the local reachability check below is the only
check ("local check" lines on stdout).
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENES = os.environ.get("AGENT_OFFICE_SCENES_DIR") or os.path.join(ROOT, "assets", "scenes")
FONT = "C:/Windows/Fonts/malgun.ttf"


def font(n):
    try:
        return ImageFont.truetype(FONT, n)
    except OSError:
        return ImageFont.load_default()


# ---------------------------------------------------------------- resolve
def mirror(pts, ax):
    return [[2 * ax - x, y] for x, y in pts]


def resolve(scene):
    kinds = scene["kinds"]
    objs, by_id = [], {}
    for o in scene["objects"]:
        k = kinds[o["kind"]]
        flip = bool(o.get("flipX"))
        ax, ay = k["anchor"]
        fp = o.get("footprint", k.get("footprint", []))
        fp = [[-dx if flip else dx, dy] for dx, dy in fp]
        p = {
            "id": o["id"], "kind": o["kind"], "at": o["at"], "flipX": flip, "rect": k["rect"],
            "anchor": [(k["rect"][2] - 1 - ax) if flip else ax, ay],
            "footprint": [[o["at"][0] + dx, o["at"][1] + dy] for dx, dy in fp],
            "blocks": o.get("blocks", k.get("blocks", True)), "depth": o.get("depth", k.get("depth", "auto")),
        }
        objs.append(p)
        by_id[p["id"]] = (p, k)
    seats = []
    for i, did in enumerate(scene["seats"]):
        p, k = by_id[did]
        s = k["seat"]
        sg = -1 if p["flipX"] else 1
        ox, oy = p["at"]
        pt = lambda v: [ox + sg * v[0], oy + v[1]]
        seats.append({"i": i, "deskId": did, "at": pt(s["at"]), "sitAt": pt(s.get("sitAt", s["at"])),
                      "approach": pt(s["approach"]), "visit": pt(s["visit"]) if s.get("visit") else None,
                      "face": ("left" if s["face"] == "right" else "right") if p["flipX"] else s["face"]})
    return {**scene, "objs": objs, "by_id": {k: v[0] for k, v in by_id.items()}, "seatList": seats}


def depth_y(o):
    return max([y for _, y in o["footprint"]] or [o["at"][1]])


def in_poly(pt, poly):
    x, y = pt
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


# ---------------------------------------------------------------- grid
def mask_of(size, polys):
    from PIL import ImageDraw as D
    m = Image.new("L", size, 0)
    d = D.Draw(m)
    for p in polys:
        d.polygon([tuple(v) for v in p], fill=255)
    return np.array(m) > 0


def bake_grid(r, nav):
    w, h = r["size"]
    cell, infl = nav["cellPx"], nav["inflatePx"]
    walk = mask_of((w, h), r["walkable"])
    closed = ~walk | mask_of((w, h), r.get("blocked", [])) | mask_of((w, h), [o["footprint"] for o in r["objs"] if o["blocks"] and o["depth"] == "auto" and len(o["footprint"]) > 2])
    bad = closed.copy()
    for dy in range(-infl, infl + 1):
        for dx in range(-infl, infl + 1):
            if dx * dx + dy * dy <= infl * infl and (dx or dy):
                sh = np.zeros_like(closed)
                ys, yd = (slice(dy, None), slice(0, h - dy)) if dy >= 0 else (slice(0, h + dy), slice(-dy, None))
                xs, xd = (slice(dx, None), slice(0, w - dx)) if dx >= 0 else (slice(0, w + dx), slice(-dx, None))
                sh[yd, xd] = closed[ys, xs]
                bad |= sh
    cols, rows = -(-w // cell), -(-h // cell)
    open_ = np.zeros((rows, cols), bool)
    for cy in range(rows):
        for cx in range(cols):
            px, py = min(w - 1, cx * cell + cell // 2), min(h - 1, cy * cell + cell // 2)
            open_[cy, cx] = not bad[py, px]
    return {"cols": cols, "rows": rows, "cellPx": cell, "open": open_}


def reach(g, start, goals):
    """BFS (8-way, no corner cutting). Returns the set of reachable cells; goals snapped within 6 cells."""
    c = g["cellPx"]
    def cell(p):
        return (min(g["rows"] - 1, int(p[1] // c)), min(g["cols"] - 1, int(p[0] // c)))
    def snap(p, rad=6):
        cy, cx = cell(p)
        best = None
        for dy in range(-rad, rad + 1):
            for dx in range(-rad, rad + 1):
                y, x = cy + dy, cx + dx
                if 0 <= y < g["rows"] and 0 <= x < g["cols"] and g["open"][y, x]:
                    d = dy * dy + dx * dx
                    if best is None or d < best[0]:
                        best = (d, (y, x))
        return best[1] if best else None
    s = snap(start)
    seen = {s} if s else set()
    q = [s] if s else []
    while q:
        y, x = q.pop()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if (dy or dx) and 0 <= ny < g["rows"] and 0 <= nx < g["cols"] and g["open"][ny, nx] and (ny, nx) not in seen:
                    if dy and dx and not (g["open"][y, nx] and g["open"][ny, x]):
                        continue
                    seen.add((ny, nx))
                    q.append((ny, nx))
    out = {}
    for name, p in goals:
        n = snap(p)
        out[name] = bool(n is not None and n in seen)
    return out


# ---------------------------------------------------------------- draw
def load_sprites(cfg):
    sp = os.path.join(ROOT, "assets", "sprites")
    stand = Image.open(os.path.join(sp, "default.png")).convert("RGBA")
    sitp = os.path.join(sp, "default-sit.png")
    if os.path.exists(sitp):
        sit = Image.open(sitp).convert("RGBA")
    else:  # stand-in until Task 6: standing picture squeezed to sitHeight
        sit = stand.resize((stand.width, cfg.get("sitHeight", 50)), Image.NEAREST)
    return stand, sit


def obj_image(atlas, o):
    x, y, w, h = o["rect"]
    im = atlas.crop((x, y, x + w, y + h))
    return im.transpose(Image.FLIP_LEFT_RIGHT) if o["flipX"] else im


def draw_scene(r, shell, atlas, front, stand, sit, chars, cfg, sit_all=True):
    """chars: [(kind 'sit'|'stand', foot pt, face)]. Returns an RGBA image."""
    dep = cfg["depth"]
    items = []
    for o in r["objs"]:
        d = o["depth"]
        z = dep["zBase"] - 1 if d == "floor" else dep["frontZ"] - 1 if d == "overhead" else dep["zBase"] + 2 * round(depth_y(o))
        items.append((z, "o", o))
    for kind, p, face in chars:
        items.append((dep["zBase"] + 2 * round(p[1]) + 1, "c", (kind, p, face)))
    items.sort(key=lambda t: t[0])
    img = shell.convert("RGBA").copy()
    for _, t, v in items:
        if t == "o":
            im = obj_image(atlas, v)
            img.alpha_composite(im, (int(v["at"][0] - v["anchor"][0]), int(v["at"][1] - v["anchor"][1])))
        else:
            kind, p, face = v
            s = sit if kind == "sit" else stand
            if face == "left":
                s = s.transpose(Image.FLIP_LEFT_RIGHT)
            img.alpha_composite(s, (int(p[0] - s.width / 2), int(p[1] - s.height)))
    if front is not None:
        img.alpha_composite(front)
    return img


def scene_chars(r):
    ch = []
    for s in r["seatList"]:
        ch.append(("sit", s["sitAt"], s["face"]))
    ch.append(("sit", r["lead"]["sitAt"] if r["lead"].get("sitAt") else r["lead"]["at"], r["lead"]["face"]))
    ch += [("stand", p, "right") for p in r["tray"]["queue"][:4]]
    ch += [("stand", i["at"], i["face"]) for i in r["idle"][:3]]
    ch += [("stand", s["at"], s["face"]) for s in r["spots"]]
    return ch


def label(d, xy, text, fill=(255, 255, 255), size=11):
    d.text(xy, text, font=font(size), fill=fill, stroke_width=2, stroke_fill=(0, 0, 0))


def overlay(r, shell, g, nav, dep):
    img = shell.convert("RGBA")
    img = Image.blend(img, Image.new("RGBA", img.size, (0, 0, 0, 255)), 0.45)
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    c = g["cellPx"]
    for cy in range(g["rows"]):
        for cx in range(g["cols"]):
            if not g["open"][cy, cx]:
                d.rectangle((cx * c, cy * c, cx * c + c - 1, cy * c + c - 1), fill=(255, 40, 40, 70))
    img.alpha_composite(ov)
    d = ImageDraw.Draw(img)
    for p in r["walkable"]:
        d.line([tuple(v) for v in p] + [tuple(p[0])], fill=(60, 255, 90, 255), width=1)
    for p in r.get("blocked", []):
        d.line([tuple(v) for v in p] + [tuple(p[0])], fill=(255, 150, 0, 255), width=1)
    for p in r.get("frontMask", []):
        d.line([tuple(v) for v in p] + [tuple(p[0])], fill=(255, 0, 255, 255), width=1)
    for o in r["objs"]:
        if len(o["footprint"]) > 2:
            d.polygon([tuple(v) for v in o["footprint"]], outline=(255, 255, 0, 255))
            xs = [x for x, _ in o["footprint"]]
            y = depth_y(o)
            d.line((min(xs), y, max(xs), y), fill=(0, 220, 255, 255))
            label(d, (min(xs), y + 1), o["id"], size=9)
    for s in r["seatList"]:
        x, y = s["at"]; d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(255, 60, 60, 255))
        x, y = s["approach"]; d.ellipse((x - 3, y - 3, x + 3, y + 3), outline=(255, 255, 255, 255))
        x, y = s["sitAt"]; d.polygon([(x, y - 4), (x + 4, y), (x, y + 4), (x - 4, y)], fill=(80, 160, 255, 255))
        if s["visit"]:
            x, y = s["visit"]; d.rectangle((x - 2, y - 2, x + 2, y + 2), outline=(255, 120, 255, 255))
        label(d, (s["at"][0] + 4, s["at"][1] - 12), str(s["i"] + 1), size=10)
    ld = r["lead"]
    for key, col in (("at", (255, 60, 60, 255)), ("approach", (255, 255, 255, 255)), ("sitAt", (80, 160, 255, 255))):
        if ld.get(key):
            x, y = ld[key]; d.ellipse((x - 3, y - 3, x + 3, y + 3), outline=col, fill=col if key != "approach" else None)
    for k, (x, y) in enumerate(r["tray"]["queue"]):
        d.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(255, 220, 0, 255)); label(d, (x + 3, y - 5), f"q{k + 1}", size=9)
    for k, p in enumerate(r["idle"]):
        x, y = p["at"]; d.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(0, 255, 255, 255)); label(d, (x + 3, y - 5), f"i{k + 1}", size=9)
    for k, p in enumerate(r["overflow"]):
        x, y = p["at"]; d.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(180, 120, 255, 255)); label(d, (x + 3, y - 5), f"o{k + 1}", size=9)
    for s in r["spots"]:
        x, y = s["at"]; d.ellipse((x - 4, y - 4, x + 4, y + 4), outline=(255, 255, 0, 255), width=2); label(d, (x + 5, y - 6), s["id"], (255, 255, 0), 9)
        if s.get("pair"):
            x, y = s["pair"]; d.ellipse((x - 3, y - 3, x + 3, y + 3), outline=(255, 255, 0, 255)); label(d, (x + 4, y - 6), "pair", (255, 255, 0), 9)
    x, y = r["door"]["at"]
    d.rectangle((x - 4, y - 4, x + 4, y + 4), fill=(0, 255, 0, 255)); label(d, (x + 6, y - 6), "door", (0, 255, 0), 10)
    return img


def depth_tiles(r, shell, atlas, front, stand, sit, cfg):
    desk = next(o for o in r["objs"] if o["id"] == r["seats"][5])
    big = next((o for o in r["objs"] if o["kind"] == "plant-big"), None)
    tests = []
    s = next(s for s in r["seatList"] if s["deskId"] == desk["id"])
    tests.append(("앉음: 의자 앞 · 책상 뒤", desk, [("sit", s["sitAt"], s["face"])]))
    tests.append(("선 자세: 책상 뒤(at)", desk, [("stand", s["at"], s["face"])]))
    fx, fy = desk["at"]
    tests.append(("책상 앞(+14)", desk, [("stand", [fx, fy + 14], "right")]))
    if big:
        bx, by = big["at"]
        tests.append(("큰 화분 뒤(-10)", big, [("stand", [bx - 6, by - 10], "right")]))
        tests.append(("큰 화분 앞(+12)", big, [("stand", [bx - 6, by + 12], "right")]))
    tiles = []
    for name, o, chars in tests:
        cx, cy = o["at"]
        box = (int(cx - 70), int(cy - 110), int(cx + 70), int(cy + 40))
        im = draw_scene(r, shell, atlas, front, stand, sit, chars, cfg).crop(box).resize((200, 214), Image.NEAREST)
        d = ImageDraw.Draw(im)
        label(d, (3, 16), name, size=12)
        tiles.append(im)
    w = sum(t.width for t in tiles)
    out = Image.new("RGBA", (max(w, 1024), max(t.height for t in tiles)), (30, 30, 30, 255))
    x = 0
    for t in tiles:
        out.paste(t, (x, 0)); x += t.width
    return out


def node_json(design):
    script = os.path.join(ROOT, "scripts", "check-scenes.mjs")
    if not os.path.exists(script):
        return None
    try:
        p = subprocess.run(["node", script, "--dir", SCENES, "--json", design], capture_output=True, text=True, cwd=ROOT, timeout=60)
        return json.loads(p.stdout) if p.returncode == 0 else None
    except Exception:
        return None


def local_checks(r, g, dep, cfg):
    """Own reachability + depth checks (stands in for the engine validator)."""
    msgs = []
    goals = [(f"seat {s['i'] + 1} approach", s["approach"]) for s in r["seatList"]]
    goals.append(("lead approach", r["lead"]["approach"]))
    goals += [(f"queue {k + 1}", p) for k, p in enumerate(r["tray"]["queue"])]
    goals += [(f"idle {k + 1}", p["at"]) for k, p in enumerate(r["idle"])]
    goals += [(f"overflow {k + 1}", p["at"]) for k, p in enumerate(r["overflow"])]
    goals += [(f"spot {s['id']}", s["at"]) for s in r["spots"]]
    goals += [(f"spot {s['id']} pair", s["pair"]) for s in r["spots"] if s.get("pair")]
    goals += [(f"visit {s['i'] + 1}", s["visit"]) for s in r["seatList"] if s["visit"]]
    res = reach(g, r["door"]["at"], goals)
    for n, ok in res.items():
        if not ok:
            msgs.append(f"UNREACHABLE {n}")
    show = dep.get("seatShowPx", 28)
    for s in r["seatList"] + [{"i": "lead", "deskId": r["lead"]["desk"], "sitAt": r["lead"]["sitAt"], "at": r["lead"]["at"]}]:
        desk = r["by_id"][s["deskId"]]
        back = min(y for _, y in desk["footprint"])
        if not s["at"][1] < back:
            msgs.append(f"seat {s['i']}: at.y {s['at'][1]} not behind desk back {back}")
        if not s["sitAt"][1] < back:
            msgs.append(f"seat {s['i']}: sitAt.y {s['sitAt'][1]} not behind desk back {back}")
        top = desk["at"][1] - desk["anchor"][1]
        if not (s["sitAt"][1] - cfg.get("sitHeight", 50) <= top - show):
            msgs.append(f"seat {s['i']}: seated head not {show}px above desk top ({s['sitAt'][1] - cfg.get('sitHeight', 50)} vs {top})")
    pts = [(f"seat {s['i'] + 1}", s["at"]) for s in r["seatList"]] + [(f"idle {k + 1}", p["at"]) for k, p in enumerate(r["idle"])]
    pts += [(f"queue {k + 1}", p) for k, p in enumerate(r["tray"]["queue"])] + [(f"spot {s['id']}", s["at"]) for s in r["spots"]]
    for a in range(len(pts)):
        for b in range(a + 1, len(pts)):
            if abs(pts[a][1][0] - pts[b][1][0]) < 24 and abs(pts[a][1][1] - pts[b][1][1]) < 24 and not (pts[a][0].startswith("queue") and pts[b][0].startswith("queue")):
                msgs.append(f"close points {pts[a][0]} / {pts[b][0]}")
    return msgs


def main():
    design = sys.argv[1]
    cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
    d = os.path.join(SCENES, design)
    scene = json.load(open(os.path.join(d, "scene.json"), encoding="utf-8"))
    r = resolve(scene)
    shell = Image.open(os.path.join(d, scene["shell"])).convert("RGBA")
    atlas = Image.open(os.path.join(d, scene["atlas"])).convert("RGBA")
    front = Image.open(os.path.join(d, scene["front"])).convert("RGBA") if scene.get("front") and os.path.exists(os.path.join(d, scene["front"])) else None
    stand, sit = load_sprites(cfg)
    nav = cfg.get("nav", {"cellPx": 8, "inflatePx": 12})
    dep = cfg.get("depth", {"zBase": 1000, "frontZ": 7000, "seatShowPx": 28})
    nj = node_json(design)
    if nj and nj.get("grid"):
        g = nj["grid"]
        op = np.array([c == "1" for c in g["open"]]).reshape(g["rows"], g["cols"])
        g = {**g, "open": op}
    else:
        g = bake_grid(r, nav)
    comp = draw_scene(r, shell, atlas, front, stand, sit, scene_chars(r), cfg)
    ov = overlay(r, shell, g, nav, dep)
    tiles = depth_tiles(r, shell, atlas, front, stand, sit, cfg)
    old_path = os.path.join(ROOT, "assets", "floors", design + ".png")
    old = Image.open(old_path).convert("RGBA").resize(comp.size, Image.LANCZOS) if os.path.exists(old_path) else Image.new("RGBA", comp.size)
    W = comp.width
    sheet = Image.new("RGBA", (W, comp.height * 4 + tiles.height + 30), (20, 20, 20, 255))
    y = 0
    for im, name in ((comp, "1 합성"), (ov, "2 겹침판"), (tiles, "3 깊이 시험"), (old, "4a 옛 그림"), (comp, "4b 새 장면")):
        sheet.paste(im, (0, y)); label(ImageDraw.Draw(sheet), (4, y + 2), name, (255, 255, 0), 12)
        y += im.height + (6 if im is tiles else 0)
    out = os.path.join(ROOT, "art", "scenes-check")
    os.makedirs(out, exist_ok=True)
    sheet.convert("RGB").save(os.path.join(out, design + ".png"))
    msgs = local_checks(r, g, dep, cfg)
    print("local check:", "OK" if not msgs else f"{len(msgs)} problems")
    for m in msgs:
        print("  ", m)
    print("grid source:", "engine --json" if nj and nj.get('grid') else "local")
    print("sheet", sheet.size, "->", os.path.join(out, design + ".png"))


if __name__ == "__main__":
    main()
