"""Screenshots in a labelled grid: python3 scripts/media/sheet.py <out.png> <columns> <scale> <image> [<image> …] (label = file name)."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out, columns, scale, paths = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), [Path(p) for p in sys.argv[4:]]
try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
except OSError:
    font = ImageFont.load_default()
images = [Image.open(p).convert("RGB") for p in paths]
images = [im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS) for im in images]
w, h = max(i.width for i in images), max(i.height for i in images)
rows = (len(images) + columns - 1) // columns
sheet = Image.new("RGB", (columns * w + (columns - 1) * 6, rows * h + (rows - 1) * 6), (8, 12, 18))
for k, (im, p) in enumerate(zip(images, paths)):
    x, y = (k % columns) * (w + 6), (k // columns) * (h + 6)
    sheet.paste(im, (x, y))
    ImageDraw.Draw(sheet).text((x + 8, y + 6), p.stem.split("-", 1)[-1], fill=(170, 186, 204), font=font)
sheet.save(out, optimize=True)
print(out)
