"""Hand-drawn pixel props (too small for imagegen): assets/props/*.png, assets/props/README.md, art/props/contact.png.

  python art/props/build.py
Each prop is drawn as an ASCII shape (the inside only); the build adds a 1px transparent margin and a 1px dark outline
around every opaque region (and around holes), so each prop reads on any floor and on both themes.
Pixels only: no anti-aliasing. Two runs write identical bytes.
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "assets", "props")
CONTACT = os.path.join(ROOT, "art", "props", "contact.png")

OUTLINE = (58, 40, 30, 255)
PAL = {
    ".": None,
    "w": (250, 248, 240, 255),  # paper white
    "g": (150, 154, 168, 255),  # grey ruling / shade
    "k": (214, 164, 104, 255),  # kraft
    "h": (246, 214, 160, 255),  # kraft light
    "n": (150, 100, 56, 255),  # kraft shade
    "y": (250, 218, 90, 255),  # yellow
    "Y": (214, 160, 40, 255),  # gold shade
    "r": (214, 60, 52, 255),  # red
    "R": (255, 130, 110, 255),  # red light
    "s": (196, 202, 214, 255),  # steel
    "S": (120, 128, 148, 255),  # steel shade
    "d": (60, 66, 82, 255),  # dark detail
    "l": (210, 236, 250, 255),  # glass
    "t": (232, 196, 120, 255),  # sand
    "x": (40, 34, 30, 255),  # dark gap (open door)
}

SHAPES = {}

SHAPES["paper"] = [
    "wwwwwwww..",
    "wggggggwg.",
    "wwwwwwwwgg",
    "wggggggggw",
    "wwwwwwwwww",
    "wgggggggww",
    "wwwwwwwwww",
    "wggggggggw",
    "wwwwwwwwww",
    "wgggggggww",
    "wwwwwwwwww",
    "wwwwwwwwww",
]
SHAPES["folder"] = [
    "nnnnn.......",
    "nkkkknnnnnnn",
    "kkkkkkkkkkkk",
    "khhhhhhhhhhk",
    "khhhhhhhhhhk",
    "kkkkkkkkkkkk",
    "kkkkkkkkkkkk",
    "kkkkkkkkkkkk",
    "nnnnnnnnnnnn",
]
SHAPES["plane"] = [
    "..........www.",
    "........wwwwg.",
    "......wwwwwgg.",
    "..wwwwwwwwgg..",
    "wwwwwwwwwgggg.",
    "..ggwwwwwwwgg.",
    "......ggggg...",
]
SHAPES["notepad"] = [
    "d.d.d.d.",
    "dddddddd",
    "yyyyyyyy",
    "yggggggy",
    "yyyyyyyy",
    "yggggggy",
    "yyyyyyyy",
    "yggggggy",
    "yyyyyyyy",
    "yggggyyy",
    "yyyyyyyy",
    "YYYYYYYY",
]
SHAPES["bell"] = [
    "....yy....",
    "...yyyy...",
    "..yyRRyy..",
    "..yRyyyy..",
    "..yRyyyY..",
    ".yyyyyyYY.",
    ".yyyyyyYY.",
    "yyyyyyyYYY",
    "YYYYYYYYYY",
    "....dd....",
]
SHAPES["hourglass"] = [
    "nnnnnnnnnnnnnn",
    "nkkkkkkkkkkkkn",
    ".nlllllllllln.",
    "..nlttttttln..",
    "...nlttttln...",
    "....nlttln....",
    ".....nlln.....",
    ".....nlln.....",
    "....nl..ln....",
    "...nl.tt.ln...",
    "..nl.tttt.ln..",
    ".nl.tttttt.ln.",
    "nkkkkkkkkkkkkn",
    "nnnnnnnnnnnnnn",
]


def pile(sheets):
    """A stack of paper sheets (2 rows each: face + edge), each a little off from the one below, the top one most."""
    pads = [0, 2, 1, 2]
    rows = []
    for i in range(sheets):
        pad = pads[i]
        face = "." * pad + "w" * 12 + "." * (2 - pad)
        edge = "." * pad + "g" * 12 + "." * (2 - pad)
        rows = [face, edge] + rows
    return rows


for _n in range(1, 5):
    SHAPES["pile-%d" % _n] = pile(_n)

SHAPES["bell-desk"] = [
    "....rrrr....",
    "..rrRRrrrr..",
    ".rRRrrrrrrr.",
    "rRrrrrrrrrrr",
    "rrrrrrrrrrrr",
    "dddddddddddd",
    ".dssssssssd.",
]
SHAPES["bell-desk-ring"] = [
    "R..........R",
    ".R..rrrr..R.",
    "..rrRRrrrr..",
    ".rRRrrrrrrr.",
    "rRrrrrrrrrrr",
    "rrrrrrrrrrrr",
    "dddddddddddd",
    ".dssssssssd.",
]
SHAPES["warn-lamp-on"] = [
    "...RRrr...",
    "..RyyRrr..",
    ".RyyyRrrr.",
    ".RyyRrrrr.",
    ".RRRrrrrr.",
    ".rrrrrrrr.",
    "ssssssssss",
    "SSSSSSSSSS",
    "..dddddd..",
    "..dddddd..",
]
SHAPES["warn-lamp-off"] = [
    "...SSdd...",
    "..SsSSdd..",
    ".SssSSddd.",
    ".SsSSdddd.",
    ".SSSddddd.",
    ".dddddddd.",
    "ssssssssss",
    "SSSSSSSSSS",
    "..dddddd..",
    "..dddddd..",
]
SHAPES["tug-paper"] = [
    "wwwwwwwwwwwwww",
    "wggggggggggwww",
    "wwwwwwwwwwwwww",
    "wggggggggwwwww",
    "wwwwwwwwwwwwww",
    "wgggggggwwwwww",
    "wwwwwwwwwwwwww",
    "wwwwwwwwwwwwwg",
]


def door(open_):
    """A lift door cover 22x30 inside: a steel frame; closed = two panels meeting at a seam with a glass slit, open = a dark gap between the panels."""
    w, h = 22, 30
    g = [["s"] * w for _ in range(h)]
    for x in range(w):
        g[0][x] = g[1][x] = g[h - 1][x] = "S"
    for y in range(h):
        g[y][0] = g[y][w - 1] = "S"
    if open_:
        for y in range(2, h - 2):
            g[y][2] = g[y][4] = g[y][w - 3] = g[y][w - 5] = "S"
            for x in range(6, w - 6):
                g[y][x] = "x"
    else:
        for y in range(2, h - 2):
            g[y][w // 2 - 1] = g[y][w // 2] = "S"
        for y in range(4, 10):
            for x in (4, 5, w - 6, w - 5):
                g[y][x] = "l"
    return ["".join(r) for r in g]


SHAPES["elev-door-closed"] = door(False)
SHAPES["elev-door-open"] = door(True)

ORDER = [
    "paper", "folder", "plane", "notepad", "bell",
    "hourglass", "pile-1", "pile-2", "pile-3", "pile-4",
    "bell-desk", "bell-desk-ring", "warn-lamp-on", "warn-lamp-off", "tug-paper",
    "elev-door-closed", "elev-door-open",
]

USE = {
    "paper": "the lead's paper in the bell wave (call)",
    "folder": "the folder handed to the new hire (handoff)",
    "plane": "the paper plane that flies between floors (message)",
    "notepad": "the notepad held after waking up (compact)",
    "bell": "the bell mark next to a floor sign (call)",
    "hourglass": "the slow-tool hourglass over a head",
    "pile-1": "desk paper pile, stage 1",
    "pile-2": "desk paper pile, stage 2",
    "pile-3": "desk paper pile, stage 3",
    "pile-4": "desk paper pile, stage 4 (about to topple)",
    "bell-desk": "desk bell for the bell meeting",
    "bell-desk-ring": "the same bell while it is rung",
    "warn-lamp-on": "lobby conflict lamp, lit",
    "warn-lamp-off": "lobby conflict lamp, dark",
    "tug-paper": "the paper pulled in a file conflict (one end leaves the picture)",
    "elev-door-closed": "lift door cover, closed",
    "elev-door-open": "lift door cover, open",
}


def render(rows):
    h = len(rows)
    w = len(rows[0])
    assert all(len(r) == w for r in rows), "ragged shape"
    im = Image.new("RGBA", (w + 2, h + 2), (0, 0, 0, 0))
    fill = {}
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if PAL[ch] is not None:
                fill[(x + 1, y + 1)] = PAL[ch]
    for xy, c in fill.items():
        im.putpixel(xy, c)
    for y in range(h + 2):
        for x in range(w + 2):
            if (x, y) in fill:
                continue
            if any((x + dx, y + dy) in fill for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                im.putpixel((x, y), OUTLINE)
    # the four canvas corners stay transparent; a fill pixel that then touches one becomes outline (a rounded corner)
    for cx, cy in ((0, 0), (w + 1, 0), (0, h + 1), (w + 1, h + 1)):
        im.putpixel((cx, cy), (0, 0, 0, 0))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                xy = (cx + dx, cy + dy)
                if 0 <= xy[0] < w + 2 and 0 <= xy[1] < h + 2 and im.getpixel(xy)[3]:
                    im.putpixel(xy, OUTLINE)
    return im


def contact(images):
    scale = 6
    cell_w = max(im.width for im in images.values()) * scale + 16
    cell_h = max(im.height for im in images.values()) * scale + 30
    cols = 6
    rows = (len(ORDER) + cols - 1) // cols
    sheet = Image.new("RGBA", (cell_w * cols * 2, cell_h * rows), (0, 0, 0, 255))
    d = ImageDraw.Draw(sheet)
    for half, bg, fg in ((0, (236, 230, 216, 255), (40, 40, 40, 255)), (1, (30, 34, 46, 255), (220, 220, 220, 255))):
        d.rectangle([half * cell_w * cols, 0, (half + 1) * cell_w * cols - 1, cell_h * rows], fill=bg)
        for i, name in enumerate(ORDER):
            cx = half * cell_w * cols + (i % cols) * cell_w
            cy = (i // cols) * cell_h
            big = images[name].resize((images[name].width * scale, images[name].height * scale), Image.NEAREST)
            sheet.alpha_composite(big, (cx + 8, cy + 6))
            d.text((cx + 8, cy + cell_h - 18), "%s %dx%d" % (name, images[name].width, images[name].height), fill=fg)
    return sheet


def readme(images):
    lines = [
        "# Props",
        "",
        "Hand-drawn pixel props, built by `python art/props/build.py` (PIL, no anti-aliasing, 1px dark outline, 1px transparent margin).",
        "Heights follow the `assets/snacks/*.png` family (up to 16px; the paper piles are flatter because a pile is low); only the lift door covers are bigger (a door, not a hand prop).",
        "A test reads this table: the sizes below must match the PNG files.",
        "",
        "| file | size | use |",
        "|---|---|---|",
    ]
    for name in ORDER:
        im = images[name]
        lines.append("| %s.png | %dx%d | %s |" % (name, im.width, im.height, USE[name]))
    lines += [
        "",
        "Palette: outline `#3a281e`; paper white `#faf8f0` with grey `#969aa8` ruling; kraft `#d6a468`, `#f6d6a0`, `#966438`;",
        "yellow `#fada5a` / gold `#d6a028`; red `#d63c34` / `#ff826e`; steel `#c4cad6` / `#788094`; glass `#d2ecfa`; sand `#e8c478`.",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    images = {name: render(SHAPES[name]) for name in ORDER}
    for name in ORDER:
        images[name].save(os.path.join(OUT, name + ".png"), compress_level=9)
    with open(os.path.join(OUT, "README.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(readme(images))
    contact(images).save(CONTACT, compress_level=9)
    print("wrote", len(ORDER), "props")
