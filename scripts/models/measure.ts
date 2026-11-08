/**
 * Model library measurements (v0.9): for each bundled model (and any extra files given), the time to read and validate
 * it, decode its textures, sample it at each detail level (with the visibility test), match it to the sphere and encode
 * the bundle, plus the bundle and cache sizes and the process's memory. Renderer numbers (frame time, transitions) come
 * from `npm run smoke -- --only=models`.
 *
 *   npm run models:measure [-- --file extra.glb ...]
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { selfContainedGlb, validateGlb } from "../../src/cards/assets/gltf";
import { GltfModel } from "../../src/visual/models/gltf";
import { sampleModel } from "../../src/visual/models/sampler";
import { encodeBundle } from "../../src/visual/models/bundle";
import { bakeAnimation } from "../../src/visual/models/animation";
import { DETAIL_COUNTS, MODEL_DETAILS } from "../../src/visual/models/manifest";
import { colourImages, decodeTextures } from "../../src/host/models/textures";
import { MODEL_LIBRARY_LIMITS } from "../../src/host/models/library";
import { PLUGIN_ROOT } from "../lib/pluginPackage";

const args = process.argv.slice(2);
const extra = args.flatMap((value, i) => args[i - 1] === "--file" ? [value] : []);
const models = join(PLUGIN_ROOT, "assets", "models");
const files = [join(models, "originals", "lumen.glb"), join(models, "khronos", "fox.glb"), ...extra];
const ms = (start: number) => `${(performance.now() - start).toFixed(0)} ms`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
for (const file of files) {
  const raw = readFileSync(file);
  let t = performance.now();
  const glb = await selfContainedGlb(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const info = validateGlb(glb, MODEL_LIBRARY_LIMITS);
  const model = new GltfModel(glb);
  const geometry = model.geometry();
  const read = ms(t);
  t = performance.now();
  const warnings: string[] = [];
  const textures = decodeTextures(geometry.images, warnings, colourImages(geometry.materials));
  const decode = ms(t);
  console.log(`\n${basename(file)}: ${mb(raw.byteLength)}, ${info.triangles.toLocaleString("en")} triangles, ${info.images} textures (${textures.map(r => r ? `${r.width}×${r.height}` : "—").join(", ")}), clips ${model.animations.map(a => a.name).join(", ") || "none"}`);
  console.log(`  read + validate + geometry ${read} · textures ${decode}${warnings.length ? ` · ${warnings.join("; ")}` : ""}`);
  for (const detail of MODEL_DETAILS) {
    const start = performance.now();
    const { particles, report, surface } = sampleModel(geometry, { count: DETAIL_COUNTS[detail], textures });
    const sampled = performance.now() - start;
    const e = performance.now();
    const bundle = encodeBundle({ ...particles, frames: [], fps: 0 });
    let clip = "";
    if (detail === "high" && model.animations.length) {
      const b = performance.now();
      const baked = bakeAnimation(model, surface, { animation: 0, maxFrames: Math.floor(6 * 1024 * 1024 / (particles.count * 6)) });
      clip = ` · clip "${model.animations[0].name}" ${baked.frames.length} frames in ${ms(b)} (+${mb(baked.frames.length * particles.count * 6)})`;
    }
    console.log(`  ${detail.padEnd(6)} ${String(particles.count).padStart(6)} particles: sample ${sampled.toFixed(0)} ms (visibility ${report.ms.visibility} ms, ${report.hidden} hidden of ${report.candidates}) · encode ${ms(e)} · bundle ${(bundle.byteLength / 1024).toFixed(0)} KB${clip}`);
  }
  const memory = process.memoryUsage();
  console.log(`  memory: heap ${mb(memory.heapUsed)}, resident ${mb(memory.rss)}`);
}
