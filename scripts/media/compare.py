"""Two filmed clips side by side, in step (each frame shown for the time it was filmed): the visual comparisons of a
release (e.g. v0.4.3 and v0.4.4 running the same scene). Optional tooling; needs Python 3 with Pillow.

  python3 scripts/media/compare.py <out.gif> <left-frames-dir> <right-frames-dir> --labels "v0.4.3" "v0.4.4" [--scale 0.5] [--crop x0 y0 x1 y1] [--colors 80] [--step 80]
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
def take(name, n, cast=float):
    if name not in args: return None
    i = args.index(name); values = args[i + 1:i + 1 + n]; del args[i:i + 1 + n]
    return [cast(v) for v in values] if n > 1 else cast(values[0])
labels = take("--labels", 2, str) or ["before", "after"]
scale = take("--scale", 1) or 0.5
crop = take("--crop", 4, int)
colors = int(take("--colors", 1) or 80)
step = int(take("--step", 1) or 80)
out, left, right = args[0], Path(args[1]), Path(args[2])
try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 15)
except OSError:
    font = ImageFont.load_default()

def clip(d):
    durations = json.loads((d / "timing.json").read_text())
    paths = sorted(d.glob("[0-9][0-9][0-9][0-9].jpg"))
    times, t = [], 0
    for ms in durations[:len(paths)]: times.append(t); t += ms
    return paths, times, t

def frame_at(paths, times, t):
    k = 0
    while k + 1 < len(times) and times[k + 1] <= t: k += 1
    return paths[k]

lp, lt, ltotal = clip(left); rp, rt, rtotal = clip(right)
total = min(ltotal, rtotal)
cache = {}
def load(path):
    if path not in cache:
        im = Image.open(path).convert("RGB")
        if crop: im = im.crop(crop)
        cache[path] = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    return cache[path]
frames = []
for t in range(0, int(total), step):
    a, b = load(frame_at(lp, lt, t)), load(frame_at(rp, rt, t))
    im = Image.new("RGB", (a.width + b.width + 6, max(a.height, b.height)), (8, 12, 18))
    im.paste(a, (0, 0)); im.paste(b, (a.width + 6, 0))
    draw = ImageDraw.Draw(im)
    draw.text((10, 8), labels[0], fill=(170, 186, 204), font=font)
    draw.text((a.width + 16, 8), labels[1], fill=(170, 186, 204), font=font)
    frames.append(im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
frames[0].save(out, save_all=True, append_images=frames[1:], duration=step, loop=0, optimize=True)
last = Image.new("RGB", frames[-1].size); last.paste(frames[-1].convert("RGB"))
last.save(out.replace(".gif", ".png"))
print(out, len(frames), "frames")
