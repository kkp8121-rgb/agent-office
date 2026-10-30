"""Office cat "치즈" sprites, drawn procedurally (codex imagegen was out of quota).

  python art/cat/build.py [outdir]   -> cat-walk-1/2, cat-sit, cat-sleep, cat-held .png
All poses face right, 1px dark outline, flat shading, shared palette. Feet sit on the
bottom row (held excepted). Walking height is 21 px (one third of a 64 px character).
"""
import os
import sys
from PIL import Image, ImageDraw

OUT = (58, 34, 28, 255)
OR = (238, 154, 62, 255)
DK = (204, 108, 40, 255)
FAR = (176, 92, 36, 255)
CR = (255, 228, 182, 255)
PK = (240, 128, 140, 255)
EY = (30, 20, 20, 255)
WH = (255, 255, 255, 255)

def px(d, pts, c):
    for x, y in pts:
        d.point((x, y), c)

def leg(d, x0, y0, x1, y1, w, fill):
    """Slanted leg: rows y0..y1, left edge moves from x0 to x1, width w (outlined)."""
    n = y1 - y0
    for i in range(n + 1):
        x = round(x0 + (x1 - x0) * i / max(1, n))
        d.line([(x, y0 + i), (x + w - 1, y0 + i)], fill)
    # outline the two sides and the foot
    for i in range(n + 1):
        x = round(x0 + (x1 - x0) * i / max(1, n))
        d.point((x - 1, y0 + i), OUT)
        d.point((x + w, y0 + i), OUT)
    d.line([(round(x1) - 1, y1 + 1), (round(x1) + w, y1 + 1)], OUT)
    d.line([(round(x1), y1), (round(x1) + w - 1, y1)], CR)  # white-ish paw

def head(d, cx, cy, face=True, sleepy=False):
    # ears behind the head
    d.polygon([(cx - 5, cy - 3), (cx - 4, cy - 8), (cx - 1, cy - 5)], OR, OUT)
    d.polygon([(cx + 5, cy - 3), (cx + 4, cy - 8), (cx + 1, cy - 5)], OR, OUT)
    px(d, [(cx - 4, cy - 6), (cx + 4, cy - 6)], PK)
    d.ellipse([cx - 6, cy - 5, cx + 6, cy + 4], OR, OUT)
    d.line([(cx - 1, cy - 4), (cx - 1, cy - 3)], DK)
    d.line([(cx + 1, cy - 4), (cx + 1, cy - 3)], DK)
    d.line([(cx, cy - 4), (cx, cy - 2)], DK)
    d.ellipse([cx - 2, cy, cx + 4, cy + 3], CR)
    if face:
        px(d, [(cx + 1, cy - 1), (cx + 1, cy)], EY)   # eye
        px(d, [(cx + 5, cy), ], PK)
        px(d, [(cx - 3, cy - 1), (cx - 3, cy)], EY)
    if sleepy:
        px(d, [(cx - 3, cy), (cx - 2, cy), (cx + 1, cy), (cx + 2, cy)], EY)

def walk(phase):
    im = Image.new("RGBA", (34, 22), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # tail: S curve rising from the rump
    for x, y in [(6, 10), (5, 9), (4, 8), (3, 7), (3, 6), (3, 5), (4, 4), (5, 3)]:
        d.rectangle([x - 1, y - 1, x + 1, y + 1], OUT)
    for x, y in [(6, 10), (5, 9), (4, 8), (3, 7), (3, 6), (3, 5), (4, 4), (5, 3)]:
        d.rectangle([x, y, x + 1, y + 1], OR)
    px(d, [(3, 6), (4, 4), (3, 8)], DK)
    f, b = (4, -4) if phase == 0 else (-4, 4)  # near front / near back foot shift
    # far legs (darker, opposite stride)
    leg(d, 21, 14, 21 - f, 19, 3, FAR)
    leg(d, 11, 14, 11 - b, 19, 3, FAR)
    d.ellipse([5, 5, 23, 16], OR, OUT)
    d.chord([6, 11, 22, 17], 0, 180, CR)
    for x in (10, 13, 16, 19):
        d.line([(x, 6), (x, 8)], DK)
    px(d, [(11, 9), (14, 9), (17, 9)], DK)
    leg(d, 19, 14, 19 + f, 20, 3, OR)
    leg(d, 9, 14, 9 + b, 20, 3, OR)
    head(d, 26, 8)
    return im

def sit():
    im = Image.new("RGBA", (18, 22), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([2, 9, 15, 20], OR, OUT)               # haunches
    d.polygon([(6, 11), (11, 11), (12, 20), (6, 20)], OR)
    d.rectangle([6, 20, 12, 20], OUT)
    d.line([(8, 12), (8, 19)], CR); d.line([(9, 12), (9, 19)], CR)   # chest
    d.line([(7, 17), (10, 17)], OUT)
    px(d, [(7, 20), (8, 20), (9, 20), (10, 20)], CR)
    px(d, [(3, 13), (3, 15), (4, 17)], DK)
    # tail curling round the feet
    d.line([(1, 19), (1, 17)], OUT); d.line([(14, 20), (16, 19), (16, 17)], OUT)
    d.line([(2, 20), (14, 20)], OUT)
    px(d, [(15, 19), (15, 18)], OR)
    head(d, 9, 6)
    return im

def sleep():
    im = Image.new("RGBA", (26, 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([0, 1, 24, 11], OR, OUT)
    for x in (5, 8, 11, 14):
        d.line([(x, 2), (x, 4)], DK)
    d.arc([0, 5, 22, 12], 20, 160, DK)
    # head tucked on the front paws at the right
    d.polygon([(16, 3), (17, 0), (19, 2)], OR, OUT)
    d.ellipse([16, 3, 25, 11], OR, OUT)
    d.ellipse([18, 7, 24, 11], CR)
    px(d, [(19, 6), (20, 6), (21, 6)], EY)
    px(d, [(24, 8)], PK)
    # tail wrapped along the bottom
    d.line([(2, 10), (14, 10)], DK)
    return im

def held():
    im = Image.new("RGBA", (22, 28), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    head(d, 12, 6)
    d.ellipse([5, 11, 17, 21], OR, OUT)               # hanging body
    d.chord([6, 15, 16, 22], 0, 180, CR)
    d.line([(8, 12), (8, 14)], DK); d.line([(11, 12), (11, 14)], DK)
    # flailing legs
    for x0, y0, x1, y1 in [(4, 16, 0, 23), (6, 19, 3, 27), (15, 17, 20, 22), (13, 20, 17, 27)]:
        d.line([(x0, y0), (x1, y1)], OUT, 3); d.line([(x0, y0), (x1, y1)], OR, 2)
        px(d, [(x1, y1)], CR)
    # tail dangling
    d.line([(6, 20), (2, 25)], OUT, 3); d.line([(6, 20), (2, 25)], OR, 1)
    px(d, [(11, 8)], WH)
    return im

def trim_pad(im, size):
    """Trim to bbox then bottom-center onto `size` (shared canvas, feet on last row)."""
    b = im.getchannel("A").getbbox()
    im = im.crop(b)
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.paste(im, ((size[0] - im.width) // 2, size[1] - im.height))
    return out

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "assets", "sprites")
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    w0, w1 = walk(0), walk(1)
    wb = [w.getchannel("A").getbbox() for w in (w0, w1)]
    size = (max(b[2] - b[0] for b in wb), max(b[3] - b[1] for b in wb))
    sheet = {"cat-walk-1": trim_pad(w0, size), "cat-walk-2": trim_pad(w1, size)}
    for name, im in (("cat-sit", sit()), ("cat-sleep", sleep())):
        b = im.getchannel("A").getbbox()
        sheet[name] = im.crop(b)
    sheet["cat-held"] = held().crop(held().getchannel("A").getbbox())
    for name, im in sheet.items():
        im.save(os.path.join(out, name + ".png"))
        print(name, im.size)

if __name__ == "__main__":
    main()
