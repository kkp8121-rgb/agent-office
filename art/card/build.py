"""Hand-drawn pixel pieces of the character card (too small for imagegen): assets/card/*.png.

  python art/card/build.py
Writes clip.png (the paperclip that holds the two photos) and folder-icon.png (the small file folder that shows beside a name tag on hover).
Pixels only: no anti-aliasing, a 1px dark outline on every shape so it reads on any floor and on both themes.
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "assets", "card")

OUTLINE = (58, 62, 74, 255)
STEEL = (196, 202, 214, 255)
SHINE = (240, 244, 252, 255)


def clip():
    """A paperclip, 15x34: a dark 3px line with a light 1px core, then a shine pixel on each straight run."""
    im = Image.new("RGBA", (15, 34), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    path = [(7, 24), (7, 8), (10, 3), (13, 8), (13, 28), (9, 32), (3, 28), (3, 11), (5, 9)]
    d.line(path, fill=OUTLINE, width=3, joint="curve")
    d.line(path, fill=STEEL, width=1, joint="curve")
    for x, y in ((13, 12), (13, 20), (3, 16), (7, 14)):
        d.point((x, y), fill=SHINE)
    return im


FOLDER = [
    "..oooo.........",
    ".okkkko........",
    "okkkkkkoooooooo",
    "okhhhhhhhhhhhko",
    "okhhhhhhhhhhhko",
    "okkkkkkkkkkkkko",
    "okkkkkkkkkkkkko",
    "okkkkkkkkkkkkko",
    "okkkkkkkkkkkkko",
    "okkkkkkkkkkkkko",
    ".ooooooooooooo.",
]
PAL = {"o": (74, 48, 24, 255), "k": (214, 164, 104, 255), "h": (246, 214, 160, 255), ".": (0, 0, 0, 0)}


def folder_icon():
    """A file folder 15x11: a kraft body, a lighter sheet edge peeking out, a tab on the upper left."""
    im = Image.new("RGBA", (15, len(FOLDER)), (0, 0, 0, 0))
    for y, row in enumerate(FOLDER):
        for x, ch in enumerate(row):
            im.putpixel((x, y), PAL[ch])
    return im


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    clip().save(os.path.join(OUT, "clip.png"))
    folder_icon().save(os.path.join(OUT, "folder-icon.png"))
    print("wrote", sorted(os.listdir(OUT)))
