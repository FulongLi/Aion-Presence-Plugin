"""Frames filmed by `npm run showcase` (.e2e/showcase/frames/<clip>/NNNN.jpg + timing.json) → one animated GIF at the
pace they were filmed, clips one after another, each named in a corner. Optional tooling for the visual review; needs
Python 3 with Pillow.

  python3 scripts/media/gif.py <out.gif> <frames-dir> [<frames-dir> …] [--scale 0.6] [--speed 1.0]
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
def option(name, default):
    if name in args:
        i = args.index(name); value = args[i + 1]; del args[i:i + 2]; return float(value)
    return default
scale, speed = option("--scale", 0.6), option("--speed", 1.0)
out, dirs = args[0], [Path(d) for d in args[1:]]
try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 13)
except OSError:
    font = ImageFont.load_default()
images, ms = [], []
for d in dirs:
    durations = json.loads((d / "timing.json").read_text())
    label = d.name.split("-")[-1]
    # Only the frames the showcase wrote (a synced folder may add "0001 2.jpg" copies).
    paths = sorted(d.glob("[0-9][0-9][0-9][0-9].jpg"))
    for k, path in enumerate(paths):
        im = Image.open(path).convert("RGB")
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
        ImageDraw.Draw(im).text((8, 6), label, fill=(150, 170, 190), font=font)
        images.append(im)
        ms.append(max(20, int(durations[k] / speed)))
    # Each clip ends on a short held beat.
    ms[-1] = max(ms[-1], 500)
# One palette for the whole animation keeps the particles from flickering between frames.
palette = images[len(images) // 2].convert("P", palette=Image.ADAPTIVE, colors=96)
frames = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
frames[0].save(out, save_all=True, append_images=frames[1:], duration=ms, loop=0, optimize=True, disposal=1)
print(f"{out}: {len(frames)} frames, {sum(ms) / 1000:.1f} s, {Path(out).stat().st_size // 1024} KB")
