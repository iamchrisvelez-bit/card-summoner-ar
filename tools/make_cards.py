"""Render a game pack's printable cards (one PNG per card in cards.json) for image tracking.

Usage: python3 tools/make_cards.py app/games/<id> <model preview.png>

Image targets track best with lots of high-contrast, non-repeating detail, so
the frame uses random filigree and speckle rather than flat colour.
"""
import json
import random
import sys
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 750, 1050  # 63 x 88 mm poker-card ratio at ~300 dpi
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
FONT_SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def hue_shift(img, degrees):
    if not degrees:
        return img
    h, sat, v = img.convert("HSV").split()
    shift = int(degrees / 360 * 255)
    h = h.point(lambda x: (x + shift) % 256)
    return Image.merge("HSV", (h, sat, v)).convert("RGB")


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def render(card, style, preview_png, out_png, seed):
    rnd = random.Random(seed)
    frame, bg, gem = hex_rgb(style["frame"]), hex_rgb(style["bg"]), hex_rgb(style["gemColor"])
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    # Speckled, irregular border texture (feature points for the tracker), unique per card.
    for _ in range(9000):
        x, y = rnd.randrange(W), rnd.randrange(H)
        r = rnd.choice((1, 1, 2, 3))
        c = rnd.choice((frame, (12, 12, 12), tuple(min(255, v + 60) for v in bg), (240, 220, 150)))
        d.ellipse((x - r, y - r, x + r, y + r), fill=c)
    for _ in range(140):
        x0, y0 = rnd.randrange(W), rnd.randrange(H)
        pts = [(x0, y0)]
        for _ in range(6):
            x0 += rnd.randint(-40, 40)
            y0 += rnd.randint(-40, 40)
            pts.append((x0, y0))
        d.line(pts, fill=rnd.choice((frame, (10, 10, 10))), width=rnd.choice((2, 3, 4)))

    d.rounded_rectangle((18, 18, W - 18, H - 18), 30, outline=frame, width=10)

    # Title bar with gems (level stars or mana cost).
    d.rounded_rectangle((50, 46, W - 50, 126), 14, fill=(236, 222, 180), outline=(60, 40, 10), width=4)
    title_font = ImageFont.truetype(FONT, 46 if len(card["name"]) < 14 else 38)
    d.text((72, 62), card["name"], font=title_font, fill=(30, 20, 8))
    gems = int(card["stats"].get(style["gemsStat"], 0))
    for i in range(min(gems, 8)):
        cx = W - 80 - i * 30
        d.ellipse((cx - 12, 74, cx + 12, 98), fill=gem, outline=(20, 20, 20), width=2)

    # Art box: the model preview, recoloured per card.
    # The preview is a 2x2 grid of 450x300 views; each card uses a different one so cards
    # differ in luminance, not just hue (the tracker works in greyscale).
    view = card.get("art", {}).get("view", 0)
    box = ((view % 2) * 450, (view // 2) * 300)
    art = Image.open(preview_png).convert("RGB").crop((*box, box[0] + 450, box[1] + 300))
    art = hue_shift(art, card.get("art", {}).get("hue", 0))
    art = art.resize((W - 100, int((W - 100) * 300 / 450)), Image.LANCZOS)
    img.paste(art, (50, 146))
    d.rectangle((50, 146, 50 + art.width, 146 + art.height), outline=(60, 40, 10), width=5)

    y = 146 + art.height + 16
    d.rounded_rectangle((50, y, W - 50, y + 58), 10, fill=(236, 222, 180), outline=(60, 40, 10), width=4)
    fields = {"type": card["type"].capitalize(), **card["stats"]}
    type_line = style["typeLine"].format(**fields) if card["type"] not in ("spell", "trap") else card["type"].capitalize()
    d.text((70, y + 10), type_line, font=ImageFont.truetype(FONT, 32), fill=(30, 20, 8))

    y += 74
    d.rounded_rectangle((50, y, W - 50, H - 130), 10, fill=(244, 236, 210), outline=(60, 40, 10), width=4)
    body = ImageFont.truetype(FONT_SANS, 30)
    for i, line in enumerate(card.get("text", [])):
        d.text((74, y + 18 + i * 40), line, font=body, fill=(30, 24, 16))

    if card["stats"] and card["type"] not in ("spell", "trap"):
        stat = style["statLine"].format(**card["stats"])
        f = ImageFont.truetype(FONT, 34)
        tw = d.textlength(stat, font=f)
        d.rounded_rectangle((W - 80 - tw, H - 120, W - 50, H - 50), 12, fill=(236, 222, 180), outline=(60, 40, 10), width=4)
        d.text((W - 65 - tw, H - 106), stat, font=f, fill=(30, 20, 8))
    d.text((60, H - 96), card["id"].upper(), font=ImageFont.truetype(FONT_SANS, 24), fill=(236, 222, 180))

    img.filter(ImageFilter.SMOOTH).save(out_png, optimize=True)


def main(pack_dir, preview_png):
    pack = Path(pack_dir)
    style = json.loads((pack / "game.json").read_text())["cardStyle"]
    cards = json.loads((pack / "cards.json").read_text())["cards"]
    for i, card in enumerate(cards):
        if not card.get("image"):
            continue
        out = pack / card["image"]
        out.parent.mkdir(parents=True, exist_ok=True)
        render(card, style, preview_png, str(out), seed=zlib.crc32(card["id"].encode()))
        print("wrote", out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
