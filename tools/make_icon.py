#!/usr/bin/env python3
"""Generate the MediaStudio app icon family from a single programmatic design.

Design: a rounded-square tile with an indigo→violet gradient, a bold white
play triangle (media) fused with an audio waveform (sound), plus a small AI
spark. Renders at 1024px then emits:
  - resources/icon.png            (1024, for web/Linux/electron)
  - resources/icon.ico            (multi-size: 16/32/48/64/128/256, Windows)
  - resources/icon.iconset/*.png  (macOS iconset)
  - resources/icon.icns           (built via iconutil, macOS)

Pure-PIL (no SVG dep). Re-run anytime to tweak the design.
"""
import os, math, subprocess, sys
from PIL import Image, ImageDraw

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'electron-resources')
# Allow override (electron build resources live elsewhere)
OUT_DIR = os.environ.get('MS_ICON_OUTDIR', OUT_DIR)
os.makedirs(OUT_DIR, exist_ok=True)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_base(size):
    # Diagonal gradient indigo → violet → magenta
    c0 = (79, 70, 229)    # #4F46E5 indigo
    c1 = (124, 58, 237)   # #7C3AED violet
    c2 = (192, 38, 211)   # #C026D3 magenta-ish
    img = Image.new('RGB', (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            col = lerp(c0, c1, t * 2) if t < 0.5 else lerp(c1, c2, (t - 0.5) * 2)
            px[x, y] = col
    return img


def draw_glyph(img):
    size = img.size[0]
    d = ImageDraw.Draw(img, 'RGBA')
    white = (255, 255, 255, 255)
    soft = (255, 255, 255, 235)

    cx, cy = size * 0.40, size * 0.50
    # Play triangle (rounded-ish via polygon), left-of-center
    r = size * 0.17
    tri = [
        (cx - r * 0.85, cy - r),
        (cx - r * 0.85, cy + r),
        (cx + r * 1.05, cy),
    ]
    d.polygon(tri, fill=white)

    # Audio waveform bars to the right (4 bars, kept inside the rounded tile)
    bar_w = size * 0.050
    gap = size * 0.034
    heights = [0.18, 0.34, 0.24, 0.42]
    x = size * 0.585
    for h in heights:
        hh = size * h
        y0 = cy - hh / 2
        y1 = cy + hh / 2
        d.rounded_rectangle([x, y0, x + bar_w, y1], radius=bar_w / 2, fill=soft)
        x += bar_w + gap

    # AI spark (4-point star) top-right
    sx, sy = size * 0.72, size * 0.27
    s = size * 0.055
    spark = [
        (sx, sy - s), (sx + s * 0.28, sy - s * 0.28),
        (sx + s, sy), (sx + s * 0.28, sy + s * 0.28),
        (sx, sy + s), (sx - s * 0.28, sy + s * 0.28),
        (sx - s, sy), (sx - s * 0.28, sy - s * 0.28),
    ]
    d.polygon(spark, fill=white)
    return img


def main():
    base = make_base(SIZE)
    base = draw_glyph(base)
    # Apply rounded corners (transparent outside)
    radius = int(SIZE * 0.225)   # macOS Big Sur squircle-ish
    mask = rounded_mask(SIZE, radius)
    icon = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    png_path = os.path.join(OUT_DIR, 'icon.png')
    icon.save(png_path)
    print('wrote', png_path)

    # Windows .ico (multi-size)
    ico_path = os.path.join(OUT_DIR, 'icon.ico')
    icon.save(ico_path, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('wrote', ico_path)

    # macOS iconset → icns
    iconset = os.path.join(OUT_DIR, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    specs = [
        (16, '16x16'), (32, '16x16@2x'), (32, '32x32'), (64, '32x32@2x'),
        (128, '128x128'), (256, '128x128@2x'), (256, '256x256'),
        (512, '256x256@2x'), (512, '512x512'), (1024, '512x512@2x'),
    ]
    for px, name in specs:
        icon.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, f'icon_{name}.png'))
    if sys.platform == 'darwin':
        icns_path = os.path.join(OUT_DIR, 'icon.icns')
        r = subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns_path])
        if r.returncode == 0:
            print('wrote', icns_path)
        else:
            print('iconutil failed; .iconset left for manual conversion', file=sys.stderr)
    else:
        print('not macOS — skipped .icns (iconset written for later)', file=sys.stderr)


if __name__ == '__main__':
    main()
