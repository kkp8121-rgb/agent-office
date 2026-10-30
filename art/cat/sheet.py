import sys
from PIL import Image
S = sys.argv[1]; R = "C:/Users/gustj/agent-office/assets/sprites/"
names = ["default", "cat-walk-1", "cat-walk-2", "cat-sit", "cat-sleep", "cat-held"]
ims = [Image.open(R + n + ".png").convert("RGBA") for n in names]
W = sum(i.width * 5 + 10 for i in ims) + 10
sheet = Image.new("RGBA", (W, 2 * (64 * 4 + 20)), (0, 0, 0, 0))
for row, bg in enumerate([(235, 235, 225, 255), (40, 42, 52, 255)]):
    y0 = row * (64 * 4 + 20)
    sheet.paste(Image.new("RGBA", (W, 64 * 4 + 20), bg), (0, y0))
    x = 10
    for n, im in zip(names, ims):
        a = im.resize((im.width * 4, im.height * 4), Image.NEAREST)
        sheet.alpha_composite(a, (x, y0 + 10 + 256 - a.height)); 
        sheet.alpha_composite(im, (x + a.width + 2, y0 + 10 + 256 - im.height)) if False else None
        x += a.width + 10
        b = im  # 1x
    # 1x strip under scale
    x = 10
    for n, im in zip(names, ims):
        sheet.alpha_composite(im, (x, y0 + 4)); x += im.width * 4 + 10
sheet.save(S)
