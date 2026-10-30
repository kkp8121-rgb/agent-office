"""The codex-drawn office cat, from a raw codex sheet.

  python art/cat/codex_build.py <work dir>   (work dir holds wc/p/piece-<k>.png
                                              made by `python art/snap.py sheet <sheet> <dir>/p`)
Writes assets/sprites/cat-*.png (same canvas sizes as the old hand-drawn ones).
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "art"))
import snap  # noqa: E402

CAT = [("cat-walk-1", "wc/p/piece-0", (31, 22)), ("cat-walk-2", "wc/p/piece-1", (31, 22)),
       ("cat-sit", "wc/p/piece-2", (16, 21)), ("cat-sleep", "wc/p/piece-3", (26, 12)),
       ("cat-held", "wc/p/piece-4", (22, 28))]


def main():
    work = os.path.abspath(sys.argv[1])
    sp = os.path.join(ROOT, "assets", "sprites")
    tmp = os.path.join(work, "cat-tmp.png")
    for name, piece, (cw, ch) in CAT:
        src = Image.open(os.path.join(work, piece + ".png"))
        f = min(cw / src.width, ch / src.height)
        snap.snap_obj(os.path.join(work, piece + ".png"), tmp, round(src.width * f) if src.width * f <= cw and src.height * f <= ch else None,
                      None if src.width * f <= cw and src.height * f <= ch else ch, 18)
        im = Image.open(tmp)
        if im.width > cw or im.height > ch:
            im = im.crop(im.getchannel("A").getbbox())
        c = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        c.paste(im, ((cw - im.width) // 2, ch - im.height))
        c.save(os.path.join(sp, name + ".png"))
        print(name, im.size, "->", c.size)


if __name__ == "__main__":
    main()
