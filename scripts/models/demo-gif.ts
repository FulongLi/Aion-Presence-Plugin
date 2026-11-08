/**
 * The model library's demonstration clip (v0.9): the frames `npm run smoke -- --only=models` captured from the real
 * WebGPU renderer (sphere → Lumen → silver → the Fox, turned, walking → another → sphere), cropped and scaled into
 * docs/media/v0.9.0/model-library.gif. Run the smoke section first.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../src/host/resolver/png";
import { encodeGif, type GifFrame } from "../lib/gif";
import { REPO_ROOT } from "../lib/pluginPackage";

const dir = join(REPO_ROOT, ".e2e", "smoke", `models-${process.argv[2] ?? "auto"}-frames`);
const names = readdirSync(dir).filter(name => name.endsWith(".png")).sort();
if (!names.length) { console.error("no frames: run npm run smoke -- --only=models first"); process.exit(1); }
// The body's area of the 1100×760 page, halved.
const crop = { x: 280, y: 150, width: 560, height: 520 }, scale = 2;
const frames: GifFrame[] = [];
for (const [i, name] of names.entries()) {
  if (i % 2) continue;
  const image = decodePng(new Uint8Array(readFileSync(join(dir, name))), { side: 4096, bytes: 32 * 1024 * 1024 });
  const width = crop.width / scale, height = crop.height / scale, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sums = [0, 0, 0];
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = ((crop.y + y * scale + dy) * image.width + crop.x + x * scale + dx) * 4;
      for (let k = 0; k < 3; k++) sums[k] += image.data[at + k];
    }
    for (let k = 0; k < 3; k++) rgba[(y * width + x) * 4 + k] = sums[k] / (scale * scale);
    rgba[(y * width + x) * 4 + 3] = 255;
  }
  frames.push({ width, height, rgba, delayMs: 160 });
}
const out = join(REPO_ROOT, "docs", "media", "v0.9.0");
mkdirSync(out, { recursive: true });
const gif = encodeGif(frames);
writeFileSync(join(out, "model-library.gif"), gif);
console.log(`docs/media/v0.9.0/model-library.gif: ${frames.length} frames, ${(gif.byteLength / 1024).toFixed(0)} KB`);
