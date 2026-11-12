/**
 * Animated-model playback in Aion's real renderer (v0.9.1): imports the given models into a throwaway library, shows each
 * with its own clip playing through the hub and the Presence page in headless Chrome, and records what the eye and the
 * clock see —
 *
 *   - frames for a demonstration (a GIF per model) and a contact sheet;
 *   - per detail level (bundle 12k / 30k / 50k particles) × render tier: conversion time, clip load time (request → formed),
 *     average frame rate and frame-time percentiles (p50 / p95 / p99, from requestAnimationFrame), JS heap, GPU buffer size;
 *   - viewport behaviour: side and front views, turning, zooming to the edges, window sizes (default, maximized, narrow),
 *     repeated fullscreen ↔ windowed transitions — the model's lit region is measured each time and must keep its size
 *     relative to the view and never touch an edge it should not reach.
 *
 *   npx tsx scripts/models/playback.ts --out <dir> [--model <file.glb>[=Name] ...] [--fox] [--renderer canvas] [--quick]
 *
 * `--fox` adds the bundled Fox (Run), including the before/after capture of the v0.9.1 quantization fix (the "before"
 * bundle reproduces v0.9.0's clamp of animated frames to the rest pose's range).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PresenceHub } from "../../src/host/hub/hub";
import { ModelLibrary } from "../../src/host/models/library";
import { creditLine, DETAIL_COUNTS, type ModelDetail } from "../../src/visual/models/manifest";
import { decodeBundle, encodeBundle } from "../../src/visual/models/bundle";
import { MODEL_EXTENT } from "../../src/visual/models/sampler";
import { decodePng } from "../../src/host/resolver/png";
import { encodeGif } from "../lib/gif";
import { PLUGIN_ROOT } from "../lib/pluginPackage";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(option("out") ?? ".e2e/playback");
const quick = args.includes("--quick");
const renderer = option("renderer") === "canvas" ? "canvas" : "auto";
const models = args.flatMap((value, i) => args[i - 1] === "--model" ? [value] : []).map(spec => {
  const [file, name] = spec.split("=");
  return { file: resolve(file), name: name ?? basename(file).replace(/\.glb$/i, "") };
});
mkdirSync(OUT, { recursive: true });
const chromePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => { try { readFileSync(p); return true; } catch { return false; } });
if (!chromePath) { console.error("no Chrome found"); process.exit(1); }

const home = mkdtempSync(join(tmpdir(), "aion-playback-"));
writeFileSync(join(home, "welcome-complete"), "playback\n");
const library = new ModelLibrary({ home, assetsDir: join(PLUGIN_ROOT, "assets") });
const hub = new PresenceHub({ home, port: 0, page: () => readFileSync(join(PLUGIN_ROOT, "runtime", "presence.html"), "utf8"), bridge: { locate: () => null } });
await hub.start();
hub.apply({ type: "open" });
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
await page.goto(`${hub.surfaceUrl}&debug=1&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
// The diagnostics panel and the caption line are not the model: hidden, so lit-region measurements see only particles.
await page.addStyleTag({ content: "#debug, #status { display: none !important; }" });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
for (let i = 0; i < 50 && !(await view<number>("v.runtime ? v.runtime.quality().frames : 0")); i++) await pause(200);
const backend = await view<string>("v.runtime.backend");
const ceiling = await view<number>("v.runtime.quality().ceiling");

/** requestAnimationFrame intervals over `ms`: mean fps and percentiles (ms). */
async function frameTimes(ms: number) {
  return page.evaluate(`new Promise(done => { const out = []; let last = performance.now(); const end = last + ${ms};
    const step = now => { out.push(now - last); last = now; if (now < end) requestAnimationFrame(step); else { out.sort((a, b) => a - b);
      const q = p => out[Math.min(out.length - 1, Math.floor(out.length * p))]; const mean = out.reduce((a, b) => a + b, 0) / out.length;
      done({ fps: 1000 / mean, p50: q(0.5), p95: q(0.95), p99: q(0.99), frames: out.length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0 }); } };
    requestAnimationFrame(step); })`) as Promise<{ fps: number; p50: number; p95: number; p99: number; frames: number; heap: number }>;
}

/** The lit region of the page (pixels brighter than the background), as a box and a share of the view. */
async function litBox(file?: string) {
  const png = await page.screenshot({ type: "png", ...(file ? { path: file } : {}) });
  const image = decodePng(new Uint8Array(png), { side: 8192, bytes: 64 << 20 });
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1, lit = 0;
  for (let y = 0; y < image.height; y += 2) for (let x = 0; x < image.width; x += 2) {
    const i = (y * image.width + x) * 4;
    if (Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) > 70) { lit++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { width: image.width, height: image.height, x0, y0, x1, y1, lit, w: (x1 - x0) / image.height, h: (y1 - y0) / image.height, touches: x0 <= 2 || y0 <= 2 || x1 >= image.width - 3 || y1 >= image.height - 3 };
}

async function present(id: string, bundle: Uint8Array, clip: string, label: string, credit: string) {
  const media = hub.addMedia(Buffer.from(bundle));
  const started = Date.now();
  hub.apply({ type: "present", content: { kind: "model", media, model: id, label, colors: "original", credit, animation: clip, playing: true } });
  for (let i = 0; i < 200; i++) { if ((await view<string>("v.visual.phase")) !== "sphere" && (await view<number>("v.visual.level")) > 0) break; await pause(10); }
  const loadMs = Date.now() - started;
  for (let i = 0; i < 100 && (await view<string>("v.visual.phase")) !== "holding"; i++) await pause(50);
  return loadMs;
}
const clear = async () => { hub.apply({ type: "clear" }); for (let i = 0; i < 80 && (await view<string>("v.visual.phase")) !== "sphere"; i++) await pause(50); };
const sideView = async () => { hub.apply({ type: "view", spin: false, reset: true }); await pause(900); };

async function film(dir: string, frames: number, every: number) {
  mkdirSync(dir, { recursive: true });
  const shots: string[] = [];
  for (let i = 0; i < frames; i++) { const file = join(dir, `${String(i).padStart(3, "0")}.png`); await page.screenshot({ path: file }); shots.push(file); await pause(every); }
  return shots;
}
function gif(shots: string[], file: string, crop = { x: 250, y: 120, width: 600, height: 560 }, scale = 2, delayMs = 70) {
  const frames = shots.map(shot => {
    const image = decodePng(new Uint8Array(readFileSync(shot)), { side: 8192, bytes: 64 << 20 });
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
    return { width, height, rgba, delayMs };
  });
  writeFileSync(file, encodeGif(frames));
}

const report: string[] = [];
const rows: string[] = [];
const viewportRows: string[] = [];
const say = (line: string) => { console.log(line); report.push(line); };
say(`Aion playback: ${backend} renderer (tier ceiling ${ceiling}), Chrome headless, ${cpus()[0]?.model ?? "CPU"} × ${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(0)} GB`);

async function evaluate(id: string, label: string, clip: string, slug: string) {
  const entry = (await library.registry()).get(id)!;
  const info = (await library.particles(id, "low")).info;
  say(`\n${label}: ${info.triangles.toLocaleString("en")} triangles, ${info.joints ?? "?"} joints, ${info.morphTargets ?? 0} morph targets, clips ${info.animations.join(", ")}`);
  const details: ModelDetail[] = quick ? ["high"] : ["low", "medium", "high"];
  for (const detail of details) {
    const fresh = new ModelLibrary({ home: mkdtempSync(join(tmpdir(), "aion-playback-c-")), assetsDir: join(PLUGIN_ROOT, "assets") });
    let converted = null as Awaited<ReturnType<ModelLibrary["particles"]>> | null, convertMs = 0;
    if (entry.manifest.availability === "redistributable") { const t = performance.now(); converted = await fresh.particles(id, detail, clip); convertMs = performance.now() - t; }
    else { const t = performance.now(); converted = await library.particles(id, detail, clip); convertMs = converted.cached ? converted.ms : performance.now() - t; }
    const loadMs = await present(id, converted!.bundle, clip, label, creditLine(entry.manifest));
    const tiers = quick ? [ceiling] : [...new Set([0, 2, ceiling])].filter(t => t <= ceiling);
    for (const tier of tiers) {
      await view(`v.runtime.setTier(${tier})`);
      await pause(1200);
      const count = await view<number>("v.runtime.quality().count");
      const shown = Math.min(count, DETAIL_COUNTS[detail]);
      const t = await frameTimes(quick ? 2500 : 4000);
      const gpu = (count * 48 / 1024 / 1024).toFixed(1);
      rows.push(`| ${label} | ${detail} (${DETAIL_COUNTS[detail].toLocaleString("en")}) | ${count.toLocaleString("en")}${shown < count ? ` (${shown.toLocaleString("en")} distinct)` : ""} | ${(convertMs / 1000).toFixed(2)} s | ${(converted!.bundle.byteLength / 1048576).toFixed(1)} MB | ${loadMs} ms | ${t.fps.toFixed(1)} | ${t.p50.toFixed(1)} / ${t.p95.toFixed(1)} / ${t.p99.toFixed(1)} | ${(t.heap / 1048576).toFixed(0)} MB | ${gpu} MB |`);
      console.log(`  ${detail} · tier ${tier} (${count}): ${t.fps.toFixed(1)} fps, p95 ${t.p95.toFixed(1)} ms`);
    }
    if (detail === "high") {
      await view(`v.runtime.setTier(${ceiling})`);
      await pause(800);
      const shots = await film(join(OUT, `${slug}-frames`), 36, 40);
      gif(shots, join(OUT, `${slug}.gif`));
      await viewport(label, slug);
    }
    await clear();
  }
}

/** Views, turns, zoom to the edges, window sizes and fullscreen transitions; the lit region is measured each time. */
async function viewport(label: string, slug: string) {
  const shot = (moment: string) => join(OUT, `${slug}-${moment}.png`);
  await sideView();
  const base = await litBox(shot("view-default"));
  hub.apply({ type: "view", rotate: "left", degrees: 90 }); await pause(1400);
  const side = await litBox(shot("view-turned-90"));
  hub.apply({ type: "view", rotate: "left", degrees: 90 }); await pause(1400);
  const back = await litBox(shot("view-turned-180"));
  hub.apply({ type: "view", zoom: "in" }); await pause(700); hub.apply({ type: "view", zoom: "in" }); await pause(1400);
  const zoomed = await litBox(shot("view-zoomed"));
  hub.apply({ type: "view", reset: true, spin: false }); await pause(1200);
  const sizes: [string, number, number][] = [["maximized", 1680, 1050], ["narrow", 620, 900], ["default", 1100, 760]];
  const measured: [string, Awaited<ReturnType<typeof litBox>>][] = [];
  for (const [name, width, height] of sizes) { await page.setViewportSize({ width, height }); await pause(1200); measured.push([name, await litBox(shot(`size-${name}`))]); }
  const fullscreen: [string, Awaited<ReturnType<typeof litBox>>][] = [];
  for (let round = 1; round <= 3; round++) {
    await page.evaluate("document.documentElement.requestFullscreen().catch(() => {})"); await pause(1000);
    const inFull = await page.evaluate("document.fullscreenElement !== null");
    fullscreen.push([`fullscreen ${round}${inFull ? "" : " (not granted)"}`, await litBox(round === 1 ? shot("fullscreen") : undefined)]);
    await page.evaluate("document.exitFullscreen().catch(() => {})"); await pause(1000);
    fullscreen.push([`windowed ${round}`, await litBox()]);
  }
  const all: [string, Awaited<ReturnType<typeof litBox>>][] = [["default", base], ["turned 90°", side], ["turned 180°", back], ["zoomed in ×1.7", zoomed], ...measured, ...fullscreen];
  for (const [name, box] of all) {
    viewportRows.push(`| ${label} | ${name} | ${box.width}×${box.height} | ${(box.w * 100).toFixed(0)} % × ${(box.h * 100).toFixed(0)} % of the view height | ${box.touches ? "yes" : "no"} |`);
  }
}

if (args.includes("--fox")) {
  // Before / after the quantization fix: the same Run frames, encoded as v0.9.0 did (clamped to the rest pose's range).
  const fixed = await library.particles("khronos-fox", "high", "Run");
  const decoded = decodeBundle(fixed.bundle);
  const clamp = (values: Float32Array) => values.map(v => Math.max(-MODEL_EXTENT, Math.min(MODEL_EXTENT, v)));
  const before = encodeBundle({ ...decoded, extent: MODEL_EXTENT, positions: clamp(decoded.positions), frames: decoded.frames.map(clamp) });
  const credit = creditLine((await library.registry()).get("khronos-fox")!.manifest);
  for (const [moment, bundle] of [["before", before], ["after", fixed.bundle]] as const) {
    await present("khronos-fox", bundle, "Run", "Fox", credit);
    await sideView();
    hub.apply({ type: "view", rotate: "left", degrees: 90 }); await pause(1500);
    const shots = await film(join(OUT, `fox-run-${moment}-frames`), 30, 30);
    gif(shots, join(OUT, `fox-run-${moment}.gif`));
    // The widest moment of the run, side on: the nose and the tail at their farthest.
    let widest = { w: 0, file: "" };
    for (const file of shots) { const image = decodePng(new Uint8Array(readFileSync(file)), { side: 8192, bytes: 64 << 20 }); let x0 = 1e9, x1 = -1;
      for (let y = 0; y < image.height; y += 2) for (let x = 0; x < image.width; x += 2) { const i = (y * image.width + x) * 4; if (Math.max(image.data[i], image.data[i + 1], image.data[i + 2]) > 70) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } }
      if (x1 - x0 > widest.w) widest = { w: x1 - x0, file }; }
    writeFileSync(join(OUT, `fox-run-${moment}-widest.png`), readFileSync(widest.file));
    say(`Fox Run side view (${moment}): widest lit extent ${widest.w} px`);
    await clear();
  }
  await evaluate("khronos-fox", "Fox", "Run", "fox");
}
for (const model of models) {
  const imported = await library.importFile(model.file, { name: model.name, category: "character" });
  const clip = imported.info.animations[0];
  if (!clip) { say(`${model.name}: no animation clip — skipped`); continue; }
  await evaluate(imported.manifest.id, model.name, clip, model.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
}

say("\n| Model | Bundle detail | Rendered particles | Conversion (with clip) | Bundle | Load (request → forming) | Avg FPS | Frame ms p50 / p95 / p99 | JS heap | GPU target buffers |");
say("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
rows.forEach(row => say(row));
say("\n| Model | View | Window | Lit region | Touches an edge |");
say("| --- | --- | --- | --- | --- |");
viewportRows.forEach(row => say(row));
say(`\npage errors: ${errors.length ? errors.join("; ") : "none"}`);
writeFileSync(join(OUT, "report.md"), `${report.join("\n")}\n`);
await browser.close();
await hub.stop();
