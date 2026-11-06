"""Hand-drawn pixel pieces of the building view (too small for imagegen). Imported by build.py.
Pixels only: no anti-aliasing, a 1px dark outline on every outer edge (and around every hole), so each piece reads on any floor and on both themes."""
from PIL import Image, ImageDraw

OUT = (30, 34, 48, 255)      # outline, luma ~34 (tests demand <= 90)
CLEAR = (0, 0, 0, 0)


def c(r, g, b):
    return (r, g, b, 255)


def new(w, h):
    im = Image.new("RGBA", (w, h), CLEAR)
    return im, ImageDraw.Draw(im)


def box(d, x0, y0, x1, y1, fill):
    """Inclusive rectangle."""
    d.rectangle([x0, y0, x1, y1], fill=fill)


def outline(im):
    """Paint a 1px dark ring on every transparent pixel that touches (4-neighbour) an opaque one. Shapes must keep a 1px margin to the edge."""
    w, h = im.size
    px = im.load()
    add = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] != 0 and px[nx, ny] != OUT:
                        add.append((x, y))
                        break
    for p in add:
        px[p] = OUT
    return im


# ---- facade windows: 40x140, two windows stacked (the wall itself is CSS) ----
FW, FH = 40, 140
WIN = [(6, 8), (6, 76)]   # top-left of each 28x56 window
FRAME = c(120, 100, 84)
FRAME_HI = c(168, 146, 120)


def facade(glass, glass2, spark, mullion):
    im, d = new(FW, FH)
    for x, y in WIN:
        box(d, x, y, x + 27, y + 55, FRAME)
        box(d, x + 1, y + 1, x + 26, y + 54, FRAME_HI)
        box(d, x + 2, y + 2, x + 25, y + 53, glass)
        box(d, x + 2, y + 28, x + 25, y + 53, glass2)          # lower pane a tone different
        box(d, x + 13, y + 2, x + 14, y + 53, mullion)        # centre mullion
        box(d, x + 2, y + 27, x + 25, y + 28, mullion)        # transom
        for k in range(5):                                       # diagonal shine, 1px steps
            d.point((x + 4 + k, y + 12 - k), fill=spark)
            d.point((x + 17 + k, y + 40 - k), fill=spark)
        box(d, x - 1, y + 56, x + 28, y + 57, FRAME_HI)        # sill
    return outline(im)


def facade_day():
    return facade(c(150, 204, 238), c(120, 176, 220), c(246, 250, 255), FRAME)


def facade_night_off():
    return facade(c(40, 52, 88), c(32, 42, 74), c(86, 104, 150), c(70, 66, 74))


def facade_night_on():
    return facade(c(255, 226, 120), c(255, 206, 90), c(255, 250, 214), c(150, 112, 56))


# ---- server racks: 56x96, six slots; LEDs at x=8..9 (green) and 12..13 (amber), 2px tall, at slot top + 4 ----
RW, RH = 56, 96
SLOT_Y = [9 + 14 * i for i in range(6)]   # top of each 11px slot
LED_X = (8, 12)


def rack(on):
    im, d = new(RW, RH)
    box(d, 2, 2, RW - 3, RH - 3, c(58, 66, 86))
    box(d, 3, 3, RW - 4, 7, c(88, 98, 122))                      # top cap
    box(d, 3, RH - 9, RW - 4, RH - 4, c(44, 50, 68))             # plinth
    for y in SLOT_Y:
        box(d, 5, y, RW - 6, y + 10, c(30, 34, 48))
        box(d, 6, y + 1, RW - 7, y + 9, c(98, 108, 134) if on else c(76, 84, 108))
        box(d, 6, y + 1, RW - 7, y + 1, c(132, 144, 170) if on else c(104, 112, 136))   # top highlight
        for k in range(4):                                       # vent slits on the right
            box(d, 30 + k * 4, y + 3, 31 + k * 4, y + 7, c(44, 50, 68))
        for i, lx in enumerate(LED_X):
            col = (c(80, 235, 120) if i == 0 else c(255, 176, 60)) if on else c(60, 66, 86)
            box(d, lx, y + 4, lx + 1, y + 5, col)
    return outline(im)


# ---- crane (roof): arm 224x60 and hook 14x64 ----
def crane_arm():
    im, d = new(224, 60)
    Y, G = c(244, 188, 52), c(206, 144, 28)
    box(d, 4, 4, 218, 11, Y)                                      # top chord
    box(d, 4, 4, 218, 5, c(255, 220, 110))
    box(d, 4, 12, 218, 12, G)
    box(d, 4, 28, 218, 31, G)                                     # bottom chord
    for x in range(8, 200, 16):                                   # truss diagonals
        d.line([(x, 13), (x + 8, 27)], fill=G)
        d.line([(x + 8, 27), (x + 16, 13)], fill=G)
    box(d, 190, 32, 218, 52, c(120, 126, 142))                    # counterweight
    box(d, 190, 32, 218, 35, c(150, 156, 172))
    box(d, 2, 4, 5, 31, c(120, 126, 142))                         # tip cap
    box(d, 70, 32, 74, 40, c(120, 126, 142))                      # trolley
    return outline(im)


def crane_hook():
    im, d = new(14, 64)
    box(d, 6, 1, 7, 44, c(188, 192, 204))                         # cable
    box(d, 3, 44, 10, 49, c(244, 188, 52))                        # block
    box(d, 3, 44, 10, 45, c(255, 220, 110))
    box(d, 6, 50, 7, 54, c(188, 192, 204))                        # shank
    box(d, 3, 55, 10, 56, c(188, 192, 204))                       # hook curve
    box(d, 3, 57, 4, 60, c(188, 192, 204))
    box(d, 9, 55, 10, 58, c(188, 192, 204))
    return outline(im)


# ---- elevator ----
CW, CH = 64, 96


def elev_car():
    im, d = new(CW, CH)
    box(d, 2, 2, CW - 3, CH - 3, c(150, 158, 176))
    box(d, 3, 3, CW - 4, 8, c(196, 202, 218))                     # roof band
    box(d, 12, 4, CW - 13, 6, c(255, 244, 190))                   # ceiling lamp
    box(d, 6, 10, CW - 7, CH - 8, c(255, 238, 178))               # lit interior
    box(d, 6, 10, CW - 7, 12, c(255, 250, 220))
    box(d, 6, CH - 20, CW - 7, CH - 8, c(206, 178, 120))          # floor/back rail
    box(d, 6, 40, CW - 7, 41, c(206, 178, 120))                   # handrail
    box(d, 3, CH - 7, CW - 4, CH - 4, c(98, 104, 122))            # sill
    box(d, 6, 10, 8, CH - 8, c(176, 184, 202))                    # door jambs
    box(d, CW - 9, 10, CW - 7, CH - 8, c(176, 184, 202))
    return outline(im)


def elev_shaft_door():
    im, d = new(CW, CH)
    box(d, 2, 2, CW - 3, CH - 3, c(104, 112, 132))                # frame
    box(d, 6, 8, CW - 7, CH - 3, c(176, 184, 202))                # doors
    box(d, 6, 8, CW - 7, 10, c(206, 212, 226))
    box(d, CW // 2 - 1, 8, CW // 2, CH - 3, c(60, 66, 84))        # centre seam
    for x in (14, 22, CW - 24, CW - 16):                          # brushed lines
        box(d, x, 16, x, CH - 10, c(158, 166, 186))
    box(d, 24, 3, CW - 25, 6, c(60, 66, 84))                      # floor indicator housing
    box(d, 29, 4, 34, 5, c(255, 90, 70))                          # indicator light
    return outline(im)


# ---- sign stand: 72x56, blank cream panel (text drawn by CSS) at x 6..65, y 4..39 ----
SIGN_PANEL = (6, 4, 65, 39)


def sign_stand():
    im, d = new(72, 56)
    box(d, 3, 2, 68, 42, c(136, 96, 58))                          # wooden frame
    box(d, 4, 3, 67, 41, c(166, 120, 74))
    x0, y0, x1, y1 = SIGN_PANEL
    box(d, x0, y0, x1, y1, c(250, 244, 226))                      # blank panel
    box(d, x0, y0, x1, y0, c(255, 252, 240))
    box(d, x0, y1, x1, y1, c(226, 216, 190))
    box(d, 14, 42, 17, 53, c(110, 76, 46))                        # legs
    box(d, 54, 42, 57, 53, c(110, 76, 46))
    box(d, 10, 53, 21, 54, c(110, 76, 46))
    box(d, 50, 53, 61, 54, c(110, 76, 46))
    return outline(im)


SMALL = {
    "facade-window-day": facade_day,
    "facade-window-night-off": facade_night_off,
    "facade-window-night-on": facade_night_on,
    "rack-off": lambda: rack(False),
    "rack-on": lambda: rack(True),
    "crane-arm": crane_arm,
    "crane-hook": crane_hook,
    "elev-car": elev_car,
    "elev-shaft-door": elev_shaft_door,
    "sign-stand": sign_stand,
}
