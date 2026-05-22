#!/usr/bin/env python3
"""Generate the DMG window background: a drag-to-Applications visual guide.

The DMG window is 540x380; electron-builder draws the app icon at (140,200)
and the Applications shortcut at (400,200) ON TOP of this background. So we
paint a title, a big arrow between those two spots, and a first-launch hint.
Output: desktop/resources/dmg-background.png  (+ @2x for retina)
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 540, 380
OUT = os.path.join(os.path.dirname(__file__), '..', 'resources', 'dmg-background.png')
FONT = '/System/Library/Fonts/STHeiti Light.ttc'

C_BG_TOP = (99, 70, 229)     # indigo
C_BG_BOT = (124, 58, 237)    # violet
WHITE = (255, 255, 255)
DIM = (230, 224, 255)


def grad(w, h):
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):
        t = y / h
        c = tuple(int(C_BG_TOP[i] + (C_BG_BOT[i] - C_BG_TOP[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img


def render(scale=1):
    w, h = W * scale, H * scale
    img = grad(w, h)
    d = ImageDraw.Draw(img)
    f_title = ImageFont.truetype(FONT, 26 * scale)
    f_sub = ImageFont.truetype(FONT, 15 * scale)
    f_hint = ImageFont.truetype(FONT, 13 * scale)

    def ctext(cx, y, text, font, fill):
        bb = d.textbbox((0, 0), text, font=font)
        d.text((cx - (bb[2] - bb[0]) / 2, y), text, font=font, fill=fill)

    ctext(w / 2, 36 * scale, '安裝 MediaStudio', f_title, WHITE)
    ctext(w / 2, 72 * scale, '把左邊的圖示拖曳到右邊的 Applications 資料夾', f_sub, DIM)

    # Arrow between icon (140,200) and Applications (400,200)
    y = 200 * scale
    x0, x1 = 210 * scale, 330 * scale
    d.line([(x0, y), (x1, y)], fill=WHITE, width=6 * scale)
    d.polygon([(x1, y - 14 * scale), (x1 + 22 * scale, y), (x1, y + 14 * scale)], fill=WHITE)

    # First-launch hint (Gatekeeper)
    ctext(w / 2, 300 * scale, '首次開啟：對 MediaStudio 按右鍵 →「打開」', f_hint, WHITE)
    ctext(w / 2, 322 * scale, '若仍被擋：系統設定 → 隱私權與安全性 →「仍要打開」', f_hint, DIM)
    return img


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    render(1).save(OUT)
    render(2).save(OUT.replace('.png', '@2x.png'))
    print('wrote', OUT, '(+@2x)')


if __name__ == '__main__':
    main()
