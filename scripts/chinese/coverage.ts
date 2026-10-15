import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ChinesePack } from "../../src/host/writing/chinesePack";
import { resolveWriting } from "../../src/host/writing/resolve";
import { buildSequence } from "../../src/animation/stroke/path";
import { insideOutline } from "../../src/writing/hanzi/geometry";
import { createTargetPoints, strokeLayout } from "../../src/visual/points";
import { strokesTarget } from "../../src/surface/writing";
import type { StrokePack, StrokeSequence } from "../../src/animation/stroke/types";
import { CHINESE_PACK_DIR } from "../../src/writing/hanzi/sources";
import { REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run chinese:coverage`: verifies the Chinese Writing Pack as Aion draws it, and measures how faithfully the particle
 * letterforms reproduce the reference geometry (the same outlines Hanzi Writer renders).
 *
 *   all characters      decoded, composed and validated by the production pipeline (counts, failures)
 *   a diverse sample    sampled into particles at the smallest and a high quality tier:
 *                       inside   — share of stroke grains inside their own stroke's true outline
 *                       coverage — share of the reference glyph's area (a 96 × 96 raster) that has grains
 *                       IoU      — the particle letterform's raster against the reference raster
 *   v0.4.3 vs v0.4.4    the same IoU for v0.4.3's hand-drawn 永 (centre lines with a pen width), to measure the change
 *
 * Output: docs/CHINESE-COVERAGE.json (machine-readable) and a summary on stdout.
 */
const pack = new ChinesePack(join(REPO_ROOT, CHINESE_PACK_DIR), { cache: 64 });
const N = 96;

/** A raster of the reference glyph: cells whose centre is inside any stroke outline (normalized, the item's box). */
function referenceMask(sequence: StrokeSequence): { mask: Uint8Array; box: [number, number, number, number] } {
  const box = sequence.items[0].box;
  const mask = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = box[0] + (i + 0.5) / N * (box[2] - box[0]), y = box[1] + (j + 0.5) / N * (box[3] - box[1]);
    if (sequence.strokes.some(stroke => stroke.outline && insideOutline(stroke.outline, x, y))) mask[j * N + i] = 1;
  }
  return { mask, box };
}

/** A raster of particle grains (each lights its cell and the 4 around it: the grains' visible size). */
function grainMask(points: Float32Array, keys: Float32Array, box: [number, number, number, number]): Uint8Array {
  const mask = new Uint8Array(N * N);
  for (let k = 0; k < keys.length; k++) {
    if (keys[k] < 0) continue;
    const x = points[k * 3] / strokeLayout.scale, y = points[k * 3 + 1] / strokeLayout.scale;
    const i = Math.floor((x - box[0]) / (box[2] - box[0]) * N), j = Math.floor((y - box[1]) / (box[3] - box[1]) * N);
    for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a >= 0 && a < N && b >= 0 && b < N) mask[b * N + a] = 1;
    }
  }
  return mask;
}

const iou = (a: Uint8Array, b: Uint8Array) => { let both = 0, either = 0; for (let i = 0; i < a.length; i++) { both += a[i] & b[i]; either += a[i] | b[i]; } return either ? both / either : 0; };

function measure(char: string, count: number) {
  const found = resolveWriting({ text: char, system: "chinese" }, pack);
  if (!found.ok) throw new Error(found.problem);
  const sequence = found.sequence;
  const { positions, keys } = createTargetPoints(strokesTarget(sequence), count);
  let grains = 0, inside = 0;
  for (let k = 0; k < keys!.length; k++) {
    if (keys![k] < 0) continue;
    grains++;
    const stroke = sequence.strokes[Math.floor(keys![k])];
    if (stroke.outline && insideOutline(stroke.outline, positions[k * 3] / strokeLayout.scale, positions[k * 3 + 1] / strokeLayout.scale)) inside++;
  }
  const reference = referenceMask(sequence);
  const particles = grainMask(positions, keys!, reference.box);
  let area = 0, covered = 0;
  for (let i = 0; i < reference.mask.length; i++) if (reference.mask[i]) { area++; covered += particles[i]; }
  return { char, strokes: sequence.strokes.length, inside: inside / grains, coverage: covered / area, iou: iou(particles, reference.mask), reference };
}

// ── Every character through the production pipeline ──────────────────────────────────────────────────────────────
const t0 = performance.now();
let composed = 0;
const failures: { char: string; problem: string }[] = [];
for (const char of pack.characters()) {
  const found = resolveWriting({ text: char, system: "chinese" }, pack);
  if (found.ok) composed++; else failures.push({ char, problem: found.problem });
}
const composeSeconds = (performance.now() - t0) / 1000;

// ── A diverse sample, as particles ───────────────────────────────────────────────────────────────────────────────
const named = [..."永爱国鬱龍鑫曌謝學體藝靈書飛馬鳥一人大中水火"].filter(char => pack.has(char));
const every = [...pack.characters()].filter((_, i) => i % 41 === 0);
const sample = [...new Set([...named, ...every])];
const rows = sample.map(char => {
  const low = measure(char, 6000), high = measure(char, 35_000);
  return { char, strokes: low.strokes, form: pack.form(char), inside: +low.inside.toFixed(4), coverage6000: +low.coverage.toFixed(4), coverage35000: +high.coverage.toFixed(4), iou35000: +high.iou.toFixed(4) };
});
const mean = (key: "inside" | "coverage6000" | "coverage35000" | "iou35000") => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
const min = (key: "inside" | "coverage6000" | "coverage35000" | "iou35000") => Math.min(...rows.map(row => row[key]));

// ── v0.4.3's hand-drawn 永 against the same reference ────────────────────────────────────────────────────────────
async function compareV043() {
  const dir = mkdtempSync(join(tmpdir(), "aion-v043-"));
  const source = execFileSync("git", ["show", "cc57c84:src/animation/stroke/packs/chinese.ts"], { cwd: REPO_ROOT, encoding: "utf8" }).replace(/^import type .*$/m, "");
  const file = join(dir, "chinese-v043.ts");
  writeFileSync(file, source);
  const old = await import(pathToFileURL(file).href) as { CHINESE_PACK: StrokePack };
  const spec = old.CHINESE_PACK.symbols.find(item => item.symbol === "永")!;
  const oldSequence = buildSequence(old.CHINESE_PACK, spec);
  const now = measure("永", 35_000);
  // v0.4.3 drew centre lines with a pen width: its letterform is that region (the same raster, the same reference).
  const { positions, keys } = createTargetPoints(strokesTarget(oldSequence), 35_000);
  const oldMask = grainMask(positions, keys!, now.reference.box);
  return { v043: +iou(oldMask, now.reference.mask).toFixed(4), v044: +now.iou.toFixed(4) };
}
const yong = await compareV043();

const report = {
  pack: pack.manifest().version, generated: new Date().toISOString().slice(0, 10),
  counts: { characters: pack.size, composed, failed: failures.length, composeSeconds: +composeSeconds.toFixed(1) },
  failures,
  shape: {
    sample: rows.length, method: "96 × 96 rasters of the reference outlines (Hanzi Writer's geometry) and of the particle grains",
    insideMean: +mean("inside").toFixed(4), insideMin: +min("inside").toFixed(4),
    coverage6000Mean: +mean("coverage6000").toFixed(4), coverage35000Mean: +mean("coverage35000").toFixed(4), coverage35000Min: +min("coverage35000").toFixed(4),
    iou35000Mean: +mean("iou35000").toFixed(4), iou35000Min: +min("iou35000").toFixed(4),
  },
  yong,
  rows,
};
mkdirSync(join(REPO_ROOT, "docs"), { recursive: true });
writeFileSync(join(REPO_ROOT, "docs", "CHINESE-COVERAGE.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(`${composed} of ${pack.size} characters compose and validate (${failures.length} failed) in ${composeSeconds.toFixed(1)} s`);
console.log(`shape, ${rows.length} characters: grains inside their stroke ${(report.shape.insideMean * 100).toFixed(2)} % (min ${(report.shape.insideMin * 100).toFixed(2)} %); `
  + `reference area covered ${(report.shape.coverage6000Mean * 100).toFixed(1)} % at 6,000 particles, ${(report.shape.coverage35000Mean * 100).toFixed(1)} % at 35,000; IoU ${report.shape.iou35000Mean.toFixed(3)} (min ${report.shape.iou35000Min.toFixed(3)})`);
console.log(`永 against the reference outline: v0.4.3 IoU ${yong.v043.toFixed(3)} → v0.4.4 IoU ${yong.v044.toFixed(3)}`);
