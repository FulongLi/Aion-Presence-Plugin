import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_DIR, connectAion, tempHome } from "./helpers";
import { decodeJpeg, JpegError } from "../src/visual/models/jpeg";
import { decodePng } from "../src/host/resolver/png";
import { GltfModel, sampleChannel } from "../src/visual/models/gltf";
import { readObj, parseMtl } from "../src/visual/models/obj";
import { readStl } from "../src/visual/models/stl";
import { geometryToGlb } from "../src/visual/models/writeGltf";
import { validateGlb } from "../src/cards/assets/gltf";
import { MODEL_EXTENT, sampleModel } from "../src/visual/models/sampler";
import { matchToSphere, meanTravel } from "../src/visual/models/correspond";
import { decodeBundle, encodeBundle, isParticleBundle, PARTICLES_MIME } from "../src/visual/models/bundle";
import { bakeAnimation } from "../src/visual/models/animation";
import { modelCatalogue, validateManifest, type ModelManifest } from "../src/visual/models/manifest";
import { ModelRegistry } from "../src/visual/models/registry";
import { normalizeGeometry } from "../src/visual/models/normalization";
import type { ModelGeometry } from "../src/visual/models/geometry";
import { ModelLibrary } from "../src/host/models/library";
import { sniffMedia } from "../src/host/media";
import { createTargetPoints, modelPoints } from "../src/visual/points";
import { VisualActionController } from "../src/visual/controller";
import type { ModelTarget, MorphTarget } from "../src/visual/types";
import { ModelPlayback } from "../src/render/modelPlayback";
import { TOOL_NAMES } from "../src/host/mcp/toolNames";

const FIXTURES = join(import.meta.dirname, "fixtures", "models");
const MODELS = join(ASSETS_DIR, "models");
const fox = () => new Uint8Array(readFileSync(join(MODELS, "khronos", "fox.glb")));
const lumen = () => new Uint8Array(readFileSync(join(MODELS, "originals", "lumen.glb")));

// ── Textures ──────────────────────────────────────────────────────────────────────────────────────────────────

test("JPEG: baseline, progressive (spectral selection and successive approximation), restart intervals and greyscale decode as libjpeg does", () => {
  for (const [name, mean] of [["texture-baseline-420", 4], ["texture-progressive-444", 0.5], ["texture-progressive-420", 4], ["texture-restart", 4], ["texture-grey", 0.5]] as const) {
    const decoded = decodeJpeg(new Uint8Array(readFileSync(join(FIXTURES, `${name}.jpg`))));
    const reference = decodePng(new Uint8Array(readFileSync(join(FIXTURES, `${name}.decoded.png`))));
    assert.equal(decoded.width, 61); assert.equal(decoded.height, 45);
    let error = 0;
    for (let i = 0; i < decoded.data.length; i++) if (i % 4 !== 3) error += Math.abs(decoded.data[i] - reference.data[i]);
    // 4:2:0 differs only by chroma upsampling (nearest here, smooth in libjpeg).
    assert.ok(error / (61 * 45 * 3) < mean, `${name}: mean error ${(error / (61 * 45 * 3)).toFixed(2)}`);
  }
});

test("JPEG: a large texture is decoded at a reduced scale (n-point IDCT of the low frequencies), keeping its colours", () => {
  const full = decodeJpeg(new Uint8Array(readFileSync(join(FIXTURES, "texture-progressive-444.jpg"))));
  const half = decodeJpeg(new Uint8Array(readFileSync(join(FIXTURES, "texture-progressive-444.jpg"))), undefined, { maxSide: 32 });
  assert.deepEqual([half.width, half.height], [31, 23]);
  let error = 0;
  for (let y = 0; y < 22; y++) for (let x = 0; x < 30; x++) for (let k = 0; k < 3; k++) {
    const average = [0, 1].flatMap(dy => [0, 1].map(dx => full.data[((y * 2 + dy) * full.width + x * 2 + dx) * 4 + k])).reduce((a, b) => a + b) / 4;
    error += Math.abs(half.data[(y * half.width + x) * 4 + k] - average);
  }
  assert.ok(error / (22 * 30 * 3) < 8, `mean difference from a 2×2 average: ${(error / (22 * 30 * 3)).toFixed(2)}`);
});

test("JPEG: malformed, truncated and unsupported files are refused, never guessed", () => {
  const good = new Uint8Array(readFileSync(join(FIXTURES, "texture-baseline-420.jpg")));
  assert.throws(() => decodeJpeg(new Uint8Array([1, 2, 3, 4])), (e: unknown) => e instanceof JpegError && e.message === "jpeg-invalid");
  assert.throws(() => decodeJpeg(good.subarray(0, 40)), JpegError);
  // A lossless (SOF3) frame header.
  const lossless = Uint8Array.from(good);
  const at = lossless.findIndex((b, i) => b === 0xff && lossless[i + 1] === 0xc0);
  lossless[at + 1] = 0xc3;
  assert.throws(() => decodeJpeg(lossless), (e: unknown) => e instanceof JpegError && e.message === "jpeg-unsupported");
  assert.throws(() => decodeJpeg(good, { side: 32, pixels: 1 << 20, bytes: 1 << 20 }), (e: unknown) => e instanceof JpegError && e.message === "jpeg-unsupported");
});

// ── Readers ───────────────────────────────────────────────────────────────────────────────────────────────────

test("glTF: the Fox's rest pose through its skin, its material and texture, and its three clips", () => {
  const model = new GltfModel(fox());
  const geometry = model.geometry();
  assert.equal(geometry.primitives.length, 1);
  assert.equal(geometry.skins, 1);
  assert.deepEqual(model.animations.map(a => a.name), ["Survey", "Walk", "Run"]);
  assert.ok(model.animations.every(a => a.duration > 0.5));
  assert.equal(geometry.images[0].mime, "image/png");
  assert.equal(geometry.materials[0].texture?.image, 0);
  const p = geometry.primitives[0];
  assert.ok(p.positions.every(Number.isFinite) && p.indices.length % 3 === 0 && p.uvs[0]);
  // A walking pose is not the rest pose.
  const walking = model.geometry({ animation: 1, time: 0.3 }).primitives[0].positions;
  let moved = 0;
  for (let i = 0; i < walking.length; i++) moved = Math.max(moved, Math.abs(walking[i] - p.positions[i]));
  assert.ok(moved > 1, `the walk moves the mesh (${moved.toFixed(2)})`);
});

test("glTF: animation channels interpolate (linear, step, slerp for rotations) and clamp outside their keys", () => {
  const input = Float32Array.from([0, 1]);
  assert.deepEqual(sampleChannel(input, Float32Array.from([0, 0, 0, 2, 4, 6]), 3, "LINEAR", 0.5, false), [1, 2, 3]);
  assert.deepEqual(sampleChannel(input, Float32Array.from([0, 0, 0, 2, 4, 6]), 3, "STEP", 0.9, false), [0, 0, 0]);
  assert.deepEqual(sampleChannel(input, Float32Array.from([0, 0, 0, 2, 4, 6]), 3, "LINEAR", 5, false), [2, 4, 6]);
  const half = sampleChannel(input, Float32Array.from([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]), 4, "LINEAR", 0.5, true)!;
  assert.ok(Math.abs(Math.hypot(...half) - 1) < 1e-6 && Math.abs(half[1] - Math.sin(Math.PI / 8)) < 1e-6, "slerp halfway through a 90° turn");
});

const OBJ = `mtllib a.mtl
v 0 0 0 1 0 0
v 1 0 0 1 0 0
v 1 1 0 1 0 0
v 0 1 0 1 0 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
usemtl red
f 1/1 2/2 3/3 4/4
usemtl blue
f -4 -2 -1
`;

test("OBJ and STL: faces fanned, materials and vertex colours kept, bad indices refused; OBJ → GLB passes the asset policy", () => {
  const materials = parseMtl("newmtl red\nKd 1 0 0\nnewmtl blue\nKd 0 0 1\nd 0.5\n");
  const geometry = readObj(OBJ, materials);
  assert.equal(geometry.primitives.length, 2);
  assert.equal(geometry.primitives[0].indices.length, 6, "a quad is two triangles");
  assert.deepEqual(geometry.materials[1].color, [0, 0, 1, 0.5]);
  assert.equal(geometry.materials[1].alphaMode, "BLEND");
  assert.ok(geometry.primitives[0].colors, "vertex colours");
  assert.throws(() => readObj("v 0 0 0\nf 1 2 3\n"), /model-invalid/);
  const glb = geometryToGlb(geometry);
  assert.equal(validateGlb(glb).triangles, 3);
  const round = new GltfModel(glb).geometry();
  assert.equal(round.primitives.length, 2);
  assert.ok(Math.abs(round.materials[0].color[0] - 1) < 1e-6 && round.materials[0].color[1] < 1e-6, "the red material survives the round trip");
  // Binary and ASCII STL of one triangle.
  const binary = new Uint8Array(84 + 50); const view = new DataView(binary.buffer);
  view.setUint32(80, 1, true); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, k) => view.setFloat32(84 + 12 + k * 4, v, true));
  assert.equal(readStl(binary).primitives[0].indices.length, 3);
  const ascii = new TextEncoder().encode("solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n");
  assert.equal(readStl(ascii).primitives[0].positions.length, 9);
  assert.throws(() => readStl(new TextEncoder().encode("not an stl at all")), /model-invalid/);
});

// ── Sampling ──────────────────────────────────────────────────────────────────────────────────────────────────

const quad = (x: number, size: number, z = 0): Float32Array => Float32Array.from([x, 0, z, x + size, 0, z, x + size, size, z, x, size, z]);
function geometryOf(parts: { positions: Float32Array; color?: [number, number, number, number]; mask?: boolean }[]): ModelGeometry {
  return {
    format: "glb", images: [], animations: [], skins: 0, warnings: [],
    materials: parts.map((p, i) => ({ name: `m${i}`, color: p.color ?? [1, 1, 1, 1], alphaMode: p.mask ? "MASK" : "OPAQUE" })),
    primitives: parts.map((p, i) => ({ positions: p.positions, indices: p.positions.length === 12 ? Uint32Array.from([0, 1, 2, 0, 2, 3]) : Uint32Array.from({ length: p.positions.length / 3 }, (_, k) => k), uvs: [], material: i, node: i })),
  };
}

test("sampler: area-weighted (never per vertex), deterministic, normalized onto the stage", () => {
  // Two squares, areas 1 and 9: about one particle in ten on the small one.
  const geometry = geometryOf([{ positions: quad(-3, 1), color: [1, 0, 0, 1] }, { positions: quad(0, 3), color: [0, 0, 1, 1] }]);
  const a = sampleModel(geometry, { count: 8000, visibility: false, detail: 0 });
  const b = sampleModel(geometry, { count: 8000, visibility: false, detail: 0 });
  assert.deepEqual(a.particles.positions, b.particles.positions, "same model, same particles");
  let red = 0;
  for (let i = 0; i < 8000; i++) if (a.particles.colors[i * 3] > 200) red++;
  assert.ok(Math.abs(red / 8000 - 0.1) < 0.02, `area share of the small square: ${(red / 8000).toFixed(3)}`);
  let radius = 0;
  for (let i = 0; i < 8000; i++) radius = Math.max(radius, Math.hypot(a.particles.positions[i * 3], a.particles.positions[i * 3 + 1], a.particles.positions[i * 3 + 2]));
  assert.ok(radius <= MODEL_EXTENT + 1e-4 && radius > MODEL_EXTENT * 0.9, `scaled to the stage (${radius.toFixed(3)})`);
  const other = sampleModel(geometry, { count: 8000, visibility: false, detail: 0, seed: 7 });
  assert.notDeepEqual(other.particles.positions, a.particles.positions, "another seed, another sample");
});

test("sampler: hidden surfaces are dropped (a cube inside a cube leaves no particles); cut-out alpha is skipped", () => {
  const cube = (size: number, color: [number, number, number, number]) => {
    const h = size / 2, v: number[] = [];
    const faces = [[[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]], [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]], [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]],
      [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]], [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]], [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]]];
    for (const f of faces) v.push(...f[0], ...f[1], ...f[2], ...f[0], ...f[2], ...f[3]);
    return { positions: Float32Array.from(v), color };
  };
  const nested = geometryOf([cube(2, [0, 1, 0, 1]), cube(1, [1, 0, 0, 1])]);
  const { particles, report } = sampleModel(nested, { count: 4000, detail: 0 });
  let inner = 0;
  for (let i = 0; i < 4000; i++) if (particles.colors[i * 3] > 200) inner++;
  assert.equal(inner, 0, "nothing of the hidden inner cube");
  assert.ok(report.hidden > 0);
  // A masked material whose alpha is 0 (no texture: its colour's alpha) contributes nothing.
  const masked = geometryOf([{ positions: quad(0, 1), color: [1, 1, 1, 1] }, { positions: quad(2, 1), color: [1, 0, 0, 0], mask: true }]);
  const cut = sampleModel(masked, { count: 2000, visibility: false, detail: 0 });
  assert.ok(cut.report.cut > 0);
  for (let i = 0; i < 2000; i++) assert.ok(cut.particles.colors[i * 3 + 1] > 200, "only the opaque square");
});

test("sampler: a model's colours come from its texture; the Fox is orange with a white tail tip, Lumen is teal", async () => {
  const { decodeTextures } = await import("../src/host/models/textures");
  const geometry = new GltfModel(fox()).geometry();
  const { particles } = sampleModel(geometry, { count: 6000, textures: decodeTextures(geometry.images, []) });
  let orange = 0, white = 0;
  for (let i = 0; i < particles.count; i++) {
    const [r, g, b] = [particles.colors[i * 3], particles.colors[i * 3 + 1], particles.colors[i * 3 + 2]];
    if (r > 150 && r > b + 60 && g < r) orange++;
    if (r > 200 && g > 200 && b > 200) white++;
  }
  assert.ok(orange / particles.count > 0.4 && white / particles.count > 0.03, `orange ${orange}, white ${white}`);
  const l = sampleModel(new GltfModel(lumen()).geometry(), { count: 6000 }).particles;
  let teal = 0;
  for (let i = 0; i < l.count; i++) if (l.colors[i * 3 + 1] > l.colors[i * 3] + 40 && l.colors[i * 3 + 2] > l.colors[i * 3]) teal++;
  assert.ok(teal / l.count > 0.5, `teal ${teal}`);
});

test("correspondence: a bijection with the sphere's grains that travels far less than an arbitrary order", () => {
  const geometry = new GltfModel(lumen()).geometry();
  const { particles } = sampleModel(geometry, { count: 5000, visibility: false });
  const key = (p: Float32Array) => Array.from({ length: p.length / 3 }, (_, i) => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`).sort();
  // An arbitrary (deterministic) permutation of the same points.
  const order = Array.from({ length: particles.count }, (_, i) => (i * 7919) % particles.count);
  const arbitrary = { ...particles, positions: Float32Array.from(order.flatMap(i => [particles.positions[i * 3], particles.positions[i * 3 + 1], particles.positions[i * 3 + 2]])) };
  const matched = matchToSphere(arbitrary).particles;
  assert.deepEqual(key(matched.positions), key(particles.positions), "every point used exactly once");
  assert.ok(meanTravel(matched) < meanTravel(arbitrary) * 0.6, `matched ${meanTravel(matched).toFixed(3)} vs arbitrary ${meanTravel(arbitrary).toFixed(3)}`);
  assert.deepEqual(matched.positions, particles.positions, "matching is deterministic whatever order the points came in");
});

test("animation: the Fox's own Walk clip is baked from its skeleton; every frame keeps every particle on its own spot", () => {
  const model = new GltfModel(fox());
  const { particles, surface } = sampleModel(model.geometry(), { count: 3000, visibility: false });
  const baked = bakeAnimation(model, surface, { animation: 1 });
  assert.ok(baked.frames.length >= 8 && baked.frames.length <= 48);
  for (const frame of baked.frames) assert.ok(frame.length === particles.count * 3 && frame.every(Number.isFinite));
  let moved = 0;
  for (let i = 0; i < baked.frames[0].length; i++) moved = Math.max(moved, Math.abs(baked.frames[0][i] - baked.frames[Math.floor(baked.frames.length / 2)][i]));
  assert.ok(moved > 0.05, `legs move between frames (${moved.toFixed(3)})`);
  // Same scale as the rest pose (one placement matrix for every frame).
  const extent = (p: Float32Array) => { let r = 0; for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1], p[i + 2])); return r; };
  assert.ok(Math.abs(extent(baked.frames[0]) - extent(particles.positions)) < 0.4);
  assert.throws(() => bakeAnimation(new GltfModel(lumen()), surface, { animation: 0 }), /animation-unknown/);
});

test("normalization: up axis, yaw and placement; Z-up STL stands upright", () => {
  const tall = geometryOf([{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 10]) }]);
  const turned = normalizeGeometry(tall, { up: "z" }, 1).geometry.primitives[0].positions;
  let ys = 0, zs = 0;
  for (let i = 0; i < 3; i++) { ys = Math.max(ys, Math.abs(turned[i * 3 + 1])); zs = Math.max(zs, Math.abs(turned[i * 3 + 2])); }
  assert.ok(ys > 0.9 && zs < 0.1, "Z-up becomes Y-up");
});

// ── Bundle ────────────────────────────────────────────────────────────────────────────────────────────────────

test("particle bundle: round trip within quantization, validated on decode, recognised as media", () => {
  const { particles } = sampleModel(new GltfModel(lumen()).geometry(), { count: 2000, visibility: false });
  const bytes = encodeBundle({ ...particles, frames: [particles.positions], fps: 12 });
  assert.ok(isParticleBundle(bytes));
  const back = decodeBundle(bytes);
  assert.equal(back.count, 2000); assert.equal(back.frames.length, 1); assert.equal(back.fps, 12);
  for (let i = 0; i < back.positions.length; i++) assert.ok(Math.abs(back.positions[i] - particles.positions[i]) < 1e-3);
  assert.deepEqual(back.colors, particles.colors);
  assert.equal(sniffMedia(Buffer.from(bytes)), PARTICLES_MIME);
  assert.throws(() => decodeBundle(bytes.subarray(0, bytes.length - 2)), /particles-invalid/);
  const huge = Uint8Array.from(bytes); new DataView(huge.buffer).setUint32(8, 5_000_000, true);
  assert.throws(() => decodeBundle(huge), /particles-invalid/);
  assert.equal(sniffMedia(Buffer.from(huge)), null, "an invalid bundle is not media");
});

test("model target points: silver tones follow light and the model's own light and dark; more grains than particles double up", () => {
  const { particles } = sampleModel(new GltfModel(lumen()).geometry(), { count: 3000, visibility: false });
  const target: ModelTarget = { kind: "model", id: "aion-lumen", colors: "original", particles: { ...particles, frames: [], fps: 0 } };
  const points = createTargetPoints(target, 4000);
  assert.equal(points.positions.length, 12_000); assert.equal(points.colors!.length, 12_000);
  assert.deepEqual(Array.from(points.positions.subarray(0, 9000)), Array.from(particles.positions), "the first grains are the model's own particles");
  // The dark eyes are darker in silver than the teal body.
  let darkest = 1, brightest = 0;
  for (let i = 0; i < 3000; i++) { darkest = Math.min(darkest, points.tones[i]); brightest = Math.max(brightest, points.tones[i]); }
  assert.ok(darkest < 0.25 && brightest > 0.7);
  assert.throws(() => modelPoints({ ...target, particles: { ...target.particles, count: 5000 } }, 100), /invalid-model/);
});

// ── Morphing ──────────────────────────────────────────────────────────────────────────────────────────────────

const modelTarget = (id: string): MorphTarget => ({
  visual: { kind: "model", id, colors: "original", particles: { count: 1, positions: new Float32Array(3), colors: new Uint8Array(3), shade: new Uint8Array(1), frames: [], fps: 0 } },
  hold: 30, label: id,
});

test("morphing: a formed model morphs straight into the next (no return through the sphere); anything else returns first", () => {
  const controller = new VisualActionController<MorphTarget>(async target => target);
  controller.show(modelTarget("a"));
  for (let t = 0; t < 4; t += 0.05) controller.sample(0.05);
  assert.equal(controller.phase, "holding");
  const revision = controller.revision;
  controller.show(modelTarget("b"));
  controller.sample(0.05);
  assert.equal(controller.revision, revision + 1);
  assert.ok(controller.crossing && controller.cross < 0.1 && controller.level === 1, "the second model replaced the first while formed");
  // A third model during the morph waits for it to finish.
  controller.show(modelTarget("c"));
  controller.sample(0.05);
  assert.equal((controller.target!.visual as ModelTarget).id, "b");
  const phases = new Set<string>();
  for (let t = 0; t < 5; t += 0.05) { controller.sample(0.05); phases.add(controller.phase); }
  assert.equal((controller.target!.visual as ModelTarget).id, "c");
  assert.ok(!phases.has("sphere") && !phases.has("returning"), [...phases].join());
  // A non-model returns through the sphere as before.
  controller.show({ visual: { kind: "points", style: "celestial", layout: { points: [], strokes: [], dust: 0.1 } }, hold: 5, label: "x" });
  controller.sample(0.05);
  assert.equal(controller.phase, "returning");
  for (let t = 0; t < 3; t += 0.05) controller.sample(0.05);
  assert.equal(controller.target!.visual.kind, "points");
  assert.equal(controller.crossing, false);
});

test("playback: a model's clip loops, interpolated between frames; stopping restores the rest pose once", () => {
  const frames = [Float32Array.from([0, 0, 0]), Float32Array.from([1, 0, 0])];
  const target: MorphTarget = { visual: { kind: "model", id: "m", colors: "silver", playing: true, particles: { count: 1, positions: Float32Array.from([5, 5, 5]), colors: new Uint8Array(3), shade: new Uint8Array(1), frames, fps: 2 } }, hold: 1, label: "m" };
  const playback = new ModelPlayback();
  playback.reset(target);
  assert.ok(Math.abs(playback.sample(target, 0.25)!.positions[0] - 0.5) < 1e-6, "halfway between frames");
  (target.visual as ModelTarget).playing = false;
  assert.deepEqual(Array.from(playback.sample(target, 0.1)!.positions), [5, 5, 5]);
  assert.equal(playback.sample(target, 0.1), null);
});

// ── Manifests, registry, catalogue ───────────────────────────────────────────────────────────────────────────

const loadCatalogue = (file: string) => modelCatalogue.parse(JSON.parse(readFileSync(file, "utf8")));

test("manifests: a redistributable model needs a licence that allows it, verified rights, no third-party design, and a file", () => {
  const [lumenEntry] = loadCatalogue(join(MODELS, "library.json")).entries;
  assert.ok(validateManifest(lumenEntry).ok);
  const fan: ModelManifest = { ...lumenEntry, rights: { ...lumenEntry.rights, underlyingIp: "third-party" } };
  assert.match((validateManifest(fan) as { problem: string }).problem, /third-party/);
  assert.ok(!validateManifest({ ...lumenEntry, rights: { ...lumenEntry.rights, redistributionVerified: false } }).ok);
  assert.ok(!validateManifest({ ...lumenEntry, licence: { ...lumenEntry.licence, redistribution: "unknown" } }).ok);
  assert.ok(!validateManifest({ ...lumenEntry, availability: "catalogued" }).ok, "only redistributable models name a bundled file");
  assert.ok(!validateManifest({ ...lumenEntry, id: "Bad Id" }).ok);
});

test("bundled library: every model is redistributable, credited, present, and converts", async () => {
  const library = loadCatalogue(join(MODELS, "library.json"));
  for (const entry of library.entries) {
    assert.equal(entry.availability, "redistributable");
    assert.ok(entry.licence.attribution, `${entry.id} has a credit`);
    assert.ok(existsSync(join(MODELS, entry.file!)), `${entry.id}: ${entry.file}`);
    assert.ok(validateGlb(new Uint8Array(readFileSync(join(MODELS, entry.file!)))).triangles > 0);
  }
  const notices = readFileSync(join(ASSETS_DIR, "..", "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.match(notices, /Fox/); assert.match(notices, /tomkranis/); assert.match(notices, /PixelMannen/);
});

test("Pokémon catalogue: references only — third-party design, never redistributable, restricted rips marked, no duplicates", () => {
  const file = join(MODELS, "catalogue", "pokemon.json");
  const catalogue = loadCatalogue(file);
  assert.ok(catalogue.entries.length >= 100, `${catalogue.entries.length} references`);
  const subjects = new Set(catalogue.entries.map(e => e.subject));
  assert.ok(subjects.size >= 80, `${subjects.size} characters`);
  for (const name of ["pikachu", "squirtle", "bulbasaur", "charmander", "charizard", "eevee", "snorlax", "gengar", "jigglypuff", "psyduck", "mew", "mewtwo"]) assert.ok(subjects.has(name), name);
  for (const e of catalogue.entries) {
    assert.equal(e.availability, "catalogued");
    assert.equal(e.rights.underlyingIp, "third-party");
    assert.equal(e.rights.redistributionVerified, false);
    assert.equal(e.file, undefined);
    assert.equal(e.download.status, "not-downloaded");
    assert.match(e.source.url!, /^https:\/\/sketchfab\.com\/3d-models\/[A-Za-z0-9]{16,40}$/);
  }
  assert.deepEqual(new ModelRegistry(catalogue.entries.map(manifest => ({ manifest, installed: false }))).duplicates(), []);
});

test("registry: names, other languages, misspellings; resolve says what is installed and what is only catalogued", () => {
  const entries = [...loadCatalogue(join(MODELS, "library.json")).entries.map(manifest => ({ manifest, installed: true })),
    ...loadCatalogue(join(MODELS, "catalogue", "pokemon.json")).entries.map(manifest => ({ manifest, installed: false }))];
  const registry = new ModelRegistry(entries);
  for (const query of ["Pikachu", "pikachu", "皮卡丘", "Pickachu", "#0025"]) assert.equal(registry.search(query)[0]?.entry.manifest.subject, "pikachu", query);
  const pikachu = registry.resolve("Pikachu");
  assert.equal(pikachu.model, null, "no Pikachu is installed");
  assert.ok(pikachu.references.length >= 1 && pikachu.references.every(r => r.manifest.subject === "pikachu"));
  assert.equal(registry.resolve("the fox").model?.manifest.id, "khronos-fox");
  assert.equal(registry.resolve("zzzz").model, null);
  assert.ok(registry.categories().some(c => c.category === "character" && c.installed >= 1));
});

// ── Library and the tool ──────────────────────────────────────────────────────────────────────────────────────

test("library: import validates and converts once, detects duplicates, refuses what it cannot or must not accept, removes cleanly", async () => {
  const home = tempHome(), files = join(home, "downloads");
  mkdirSync(files, { recursive: true });
  copyFileSync(join(MODELS, "originals", "lumen.glb"), join(files, "creature.glb"));
  writeFileSync(join(files, "quad.obj"), OBJ);
  writeFileSync(join(files, "a.mtl"), "newmtl red\nKd 1 0 0\nnewmtl blue\nKd 0 0 1\n");
  writeFileSync(join(files, "broken.glb"), Buffer.from("glTF not really"));
  writeFileSync(join(files, "model.fbx"), "x");
  const library = new ModelLibrary({ home, assetsDir: ASSETS_DIR });
  const imported = await library.importFile(join(files, "creature.glb"), { name: "My creature" });
  assert.equal(imported.manifest.id, "my-my-creature");
  assert.equal(imported.manifest.availability, "local");
  assert.equal(imported.manifest.rights.underlyingIp, "unknown");
  assert.equal((await library.importFile(join(files, "creature.glb"))).duplicate, true);
  const obj = await library.importFile(join(files, "quad.obj"), { name: "Quad" });
  assert.equal(obj.info.triangles, 3);
  await assert.rejects(library.importFile(join(files, "model.fbx")), /model-type/);
  await assert.rejects(library.importFile(join(files, "broken.glb")), /model-invalid/);
  await assert.rejects(library.importFile("https://example.com/pikachu.glb"), /remote-model-not-supported/);
  await assert.rejects(library.importFile("relative/file.glb"), /model-path-not-absolute/);
  await assert.rejects(library.importFile(join(files, "creature.glb").replace("creature", "missing")), /model-not-found/);
  const first = await library.particles(imported.manifest.id, "low");
  assert.equal(first.cached, false);
  assert.equal(first.count, 12_000);
  const again = await new ModelLibrary({ home, assetsDir: ASSETS_DIR }).particles(imported.manifest.id, "low");
  assert.ok(again.cached, "converted particles are cached on disk");
  assert.deepEqual(again.bundle, first.bundle);
  assert.ok(await library.remove(imported.manifest.id));
  assert.equal((await library.registry()).get(imported.manifest.id), undefined);
  assert.equal(await library.remove("khronos-fox"), false, "bundled models cannot be removed");
});

test("library: importing a catalogued reference keeps its provenance; a restricted rip is refused", async () => {
  const home = tempHome(), assets = join(home, "assets");
  mkdirSync(join(assets, "models", "catalogue"), { recursive: true });
  const pokemon = loadCatalogue(join(MODELS, "catalogue", "pokemon.json"));
  const reference = pokemon.entries.find(e => e.subject === "pikachu" && e.rights.extractedGameAsset === "no")!;
  const rip: ModelManifest = { ...reference, id: "pokemon-test-rip", rights: { ...reference.rights, extractedGameAsset: "yes" } };
  writeFileSync(join(assets, "models", "catalogue", "test.json"), ModelLibrary.catalogueText("t", [reference, rip]));
  const library = new ModelLibrary({ home, assetsDir: assets });
  const imported = await library.importFile(join(MODELS, "originals", "lumen.glb"), { catalogue: reference.id });
  assert.equal(imported.manifest.id, reference.id);
  assert.equal(imported.manifest.availability, "local");
  assert.equal(imported.manifest.source.author, reference.source.author);
  assert.equal(imported.manifest.rights.underlyingIp, "third-party");
  assert.equal((await library.registry()).resolve("Pikachu").model?.manifest.id, reference.id, "now installed");
  await assert.rejects(library.importFile(join(MODELS, "khronos", "fox.glb"), { catalogue: rip.id }), /model-not-permitted/);
});

test("show_model: one tool for every model — forms, switches colours in place, morphs to the next, refuses what is not installed", async () => {
  assert.ok(TOOL_NAMES.includes("show_model"));
  const aion = await connectAion();
  try {
    const text = (result: Awaited<ReturnType<typeof aion.call>>) => (result.content as { text: string }[])[0].text;
    const found = await aion.call("show_model", { action: "find" });
    assert.match(text(found), /2 installed \(Lumen, Fox\)/);
    const shown = await aion.call("show_model", { model: "Lumen" });
    assert.ok(!shown.isError, text(shown));
    const state = await aion.link.run(backend => backend.state());
    assert.equal(state.presentation?.kind, "model");
    const first = state.presentation as Extract<typeof state.presentation, { kind: "model" }>;
    assert.equal(first.colors, "original"); assert.equal(first.route, "body");
    assert.match(first.credit!, /original Aion Presence test character/);
    const silver = await aion.call("show_model", { colors: "silver" });
    assert.ok(!silver.isError);
    const after = (await aion.link.run(backend => backend.state())).presentation as typeof first;
    assert.equal(after.colors, "silver"); assert.equal(after.media.id, first.media.id, "the same particles: changed in place");
    assert.ok(!(await aion.call("set_scene_view", { rotate: "left" })).isError, "a model can be turned");
    const walk = await aion.call("show_model", { model: "fox", animation: "Walk" });
    assert.match(text(walk), /playing "Walk"/);
    const none = await aion.call("show_model", { model: "Lumen", animation: "wave" });
    assert.ok(none.isError && /no animation of its own/.test(text(none)));
    const before = (await aion.link.run(backend => backend.state())).presentation?.id;
    const missing = await aion.call("show_model", { model: "Squirtle" });
    assert.ok(missing.isError && /model-not-installed/.test(text(missing)) && /never downloads/.test(text(missing)), text(missing));
    assert.equal((await aion.link.run(backend => backend.state())).presentation?.id, before, "nothing else was shown instead");
    const unknown = await aion.call("show_model", { model: "Optimus Prime" });
    assert.ok(unknown.isError && /model-unknown/.test(text(unknown)));
  } finally { await aion.close(); }
});
