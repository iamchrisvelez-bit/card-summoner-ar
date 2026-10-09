"""Write a .y4m clip of the test card lying on a wooden table, seen at an angle,
for Chromium's --use-file-for-fake-video-capture."""
import math
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H, FRAMES = 640, 480, 90


def coeffs(dst, src):
    # PIL wants the mapping from output (dst) pixels back to input (src) pixels.
    a = []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = [c for p in src for c in p]
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def table():
    rnd = random.Random(3)
    img = Image.new("RGB", (W, H), (120, 82, 50))
    d = ImageDraw.Draw(img)
    for y in range(0, H, 3):
        c = 110 + rnd.randint(-14, 14)
        d.line((0, y, W, y + rnd.randint(-4, 4)), fill=(c, int(c * 0.68), int(c * 0.42)), width=3)
    return img.filter(ImageFilter.GaussianBlur(1.2))


def main(card_png, out):
    card = Image.open(card_png).convert("RGB")
    cw, ch = card.size
    bg = table()
    with open(out, "wb") as f:
        f.write(f"YUV4MPEG2 W{W} H{H} F30:1 Ip A1:1 C420jpeg\n".encode())
        for i in range(FRAMES):
            t = i / FRAMES * 2 * math.pi
            cx, cy = 320 + 12 * math.sin(t), 250 + 6 * math.cos(t)
            # A card on a table seen from a seated player: top edge foreshortened.
            top, bot, h = 105, 140, 300
            quad = [(cx - top, cy - h / 2), (cx + top, cy - h / 2), (cx + bot, cy + h / 2), (cx - bot, cy + h / 2)]
            warped = card.transform((W, H), Image.PERSPECTIVE, coeffs(quad, [(0, 0), (cw, 0), (cw, ch), (0, ch)]),
                                    Image.BICUBIC)
            mask = Image.new("L", (W, H), 0)
            ImageDraw.Draw(mask).polygon(quad, fill=255)
            frame = bg.copy()
            frame.paste(warped, (0, 0), mask)
            yuv = np.asarray(frame.convert("YCbCr"))
            f.write(b"FRAME\n")
            f.write(yuv[:, :, 0].tobytes())
            f.write(yuv[::2, ::2, 1].tobytes())
            f.write(yuv[::2, ::2, 2].tobytes())
            if i == 0:
                frame.save(out.replace(".y4m", "_frame0.png"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
