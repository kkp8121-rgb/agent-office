"""Hand-drawn tiny effects (too small for imagegen): assets/fx/*.png.

  python art/seasonal/build_fx.py
Writes sweat-drop, rain-cloud-1/2 and sparkle-1/2. Characters: '.' clear, 'o' outline,
others are palette keys below.
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PAL = {
    "o": (38, 52, 92), "b": (96, 176, 240), "h": (214, 242, 255),
    "g": (96, 104, 128), "d": (62, 68, 92), "l": (140, 148, 172),
    "y": (255, 224, 80), "w": (255, 255, 240), "k": (255, 170, 40),
    "r": (110, 190, 255),
}

SPRITES = {
    "sweat-drop": [
        "...o...",
        "...o...",
        "..obo..",
        "..obo..",
        ".obbho.",
        ".obbbo.",
        ".obbbo.",
        "..obo..",
        "...o...",
    ],
    "rain-cloud-1": [
        "....oooo......",
        "..oollllloo...",
        ".ollllllllloo.",
        "oollllgggglllo",
        "olllggggggggoo",
        "oggggggdddggdo",
        "ooddddddddddoo",
        ".oooooooooooo.",
        "..r...r....r..",
        "......r..r....",
        ".r.......r..r.",
    ],
    "rain-cloud-2": [
        "....oooo......",
        "..oollllloo...",
        ".ollllllllloo.",
        "oollllgggglllo",
        "olllggggggggoo",
        "oggggggdddggdo",
        "ooddddddddddoo",
        ".oooooooooooo.",
        "....r....r....",
        ".r.....r....r.",
        "...r.......r..",
    ],
    "sparkle-1": [
        ".....y.....",
        ".....y.....",
        "....kyk....",
        "....kwk....",
        "..yykwkyy..",
        "yywwwwwwwyy",
        "..yykwkyy..",
        "....kwk....",
        "....kyk....",
        ".....y.....",
        ".....y.....",
    ],
    "sparkle-2": [
        "...........",
        "...........",
        ".....y.....",
        ".....y.....",
        "....kwk....",
        "..yywwwyy..",
        "....kwk....",
        ".....y.....",
        ".....y.....",
        "...........",
        "...........",
    ],
}


def draw(rows):
    im = Image.new("RGBA", (len(rows[0]), len(rows)), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != ".":
                im.putpixel((x, y), PAL[ch] + (255,))
    return im


def main():
    out = os.path.join(ROOT, "assets", "fx")
    os.makedirs(out, exist_ok=True)
    for name, rows in SPRITES.items():
        im = draw(rows)
        im.save(os.path.join(out, name + ".png"))
        print(name, im.size)


if __name__ == "__main__":
    main()
