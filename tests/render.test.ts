import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderer, type RendererFactories, type RuntimeHandle, type RuntimeInputs } from "../src/render";
import { particleDefaults } from "../src/render/particleDefaults";
import { AdaptiveQuality, qualityRange, qualityTiers } from "../src/render/quality";
import { createSphere } from "../src/render/sphere/createSphere";

const run = (quality: AdaptiveQuality, dt: number, seconds: number) => {
  let changes = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) if (quality.sample(dt)) changes++;
  return changes;
};

// ── Adaptive quality (from SCF Presence, with effects shed before density) ─────────────────────────────

test("tiers extend to high-end desktops while phones stay conservative", () => {
  assert.deepEqual(qualityTiers.map(tier => tier.count), [6_000, 12_000, 20_000, 35_000, 50_000]);
  assert.deepEqual(qualityRange(true, 16, 16), { initial: 0, max: 1 });
  assert.deepEqual(qualityRange(false, 4, 8), { initial: 0, max: 2 });
  assert.deepEqual(qualityRange(false, 8, 8), { initial: 1, max: 3 });
  assert.deepEqual(qualityRange(false, 16, 16), { initial: 2, max: 4 });
});

test("sustained slowness sheds secondary effects first, then particle density", () => {
  const quality = new AdaptiveQuality(3, 4);
  assert.deepEqual(quality.settings(), { count: 35_000, pixelRatio: 1.75, bloom: true });
  run(quality, 1 / 30, 11);
  assert.equal(quality.tier, 3, "the first slow window keeps the body's density…");
  assert.deepEqual(quality.settings(), { count: 35_000, pixelRatio: 1, bloom: false }, "…and drops bloom and the high pixel ratio");
  run(quality, 1 / 30, 11);
  assert.equal(quality.tier, 2, "only then does the count step down");
  assert.equal(quality.effects, false);
});

test("isolated stalls do not count as slowness", () => {
  const stalls = new AdaptiveQuality(2, 2);
  for (let i = 0; i < 700; i++) stalls.sample(i % 100 === 0 ? 1 : 1 / 60);
  assert.deepEqual([stalls.tier, stalls.effects], [2, true]);
});

test("climbing back restores the count first and the effects last", () => {
  const quality = new AdaptiveQuality(3, 4);
  run(quality, 1 / 30, 22);
  assert.deepEqual([quality.tier, quality.effects], [2, false]);
  run(quality, 1 / 60, 30);
  assert.deepEqual([quality.tier, quality.effects], [3, false], "density comes back before bloom");
  run(quality, 1 / 60, 200);
  assert.equal(quality.tier, 4);
  assert.equal(quality.effects, true);
});

test("effects or a tier that prove slow right after an upgrade are not retried (no oscillation)", () => {
  const quality = new AdaptiveQuality(2, 2);
  run(quality, 1 / 30, 11);
  assert.equal(quality.effects, false);
  run(quality, 1 / 60, 30);
  assert.equal(quality.effects, true, "effects restored at the ceiling");
  run(quality, 1 / 30, 11);
  assert.equal(quality.effectsCapped, true);
  assert.equal(run(quality, 1 / 60, 300), 0, "never retried this session");
  assert.equal(quality.effects, false);
  const tiers = new AdaptiveQuality(2, 4);
  run(tiers, 1 / 60, 30);
  assert.equal(tiers.tier, 3);
  run(tiers, 1 / 30, 12);
  assert.deepEqual([tiers.tier, tiers.ceiling, tiers.effects], [3, 4, false], "first the effects go");
});

test("frames with drops never count as good, even when the mean is fine", () => {
  const quality = new AdaptiveQuality(1, 4);
  for (let i = 0; i < 60 * 120; i++) quality.sample(i % 20 === 0 ? 0.034 : 0.0155);
  assert.equal(quality.tier, 1);
});

test("sphere samples are deterministic and every quality prefix covers the volume", () => {
  const full = createSphere(qualityTiers[4].count, particleDefaults.geometry.radius);
  assert.deepEqual(full.positions.slice(0, 300), createSphere(100, particleDefaults.geometry.radius).positions);
  for (const tier of qualityTiers) {
    let meanRadius = 0;
    const n = Math.min(tier.count, 4000);
    for (let i = 0; i < n; i++) meanRadius += Math.hypot(full.positions[i * 3], full.positions[i * 3 + 1], full.positions[i * 3 + 2]);
    assert.ok(Math.abs(meanRadius / n - 1.35 * 0.75) < 0.05, "uniform volume: mean radius is 3/4 R");
  }
});

test("the Presence visual identity keeps SCF Presence's tuning", () => {
  assert.deepEqual(particleDefaults.geometry, { radius: 1.35, size: 0.0165 });
  assert.deepEqual(particleDefaults.bloom, { strength: 0.2, radius: 0.38, threshold: 0.85 });
  assert.deepEqual(particleDefaults.thinking, { turbulence: 0.52, rotation: 0.72, travel: 0.12 });
});

// ── Renderer initialization and fallback ──────────────────────────────────────────────────────────────

const inputs = {} as RuntimeInputs;
const container = {} as HTMLElement;
const handle = (backend: "webgpu" | "canvas"): RuntimeHandle => ({ backend, config: particleDefaults, tuning: false, quality: () => ({ tier: 0, ceiling: 0, count: 0, effects: false, frameMs: 16, frames: 0 }), setTier: () => {}, dispose: () => {} });
function factories(webgpu: () => Promise<RuntimeHandle | undefined>) {
  const calls: string[] = [];
  let lost: ((code: string) => void) | null = null;
  const make: RendererFactories = {
    webgpu: (_c, _i, _l, onError) => { calls.push("webgpu"); lost = onError; return webgpu(); },
    canvas: () => { calls.push("canvas"); return handle("canvas"); },
  };
  return { make, calls, lose: (code: string) => lost?.(code) };
}

test("renderer initialization uses WebGPU when available", async () => {
  const f = factories(async () => handle("webgpu"));
  const result = await createRenderer(container, inputs, new AbortController().signal, () => {}, {}, f.make);
  assert.equal(result.handle?.backend, "webgpu");
  assert.equal(result.fallbackReason, null);
  assert.deepEqual(f.calls, ["webgpu"]);
});

test("without WebGPU the canvas body appears instead, with the reason reported", async () => {
  for (const code of ["webgpu-unavailable", "webgpu-failed"]) {
    const f = factories(async () => { throw new Error(code); });
    const result = await createRenderer(container, inputs, new AbortController().signal, () => {}, {}, f.make);
    assert.equal(result.handle?.backend, "canvas");
    assert.equal(result.fallbackReason, code);
  }
  const odd = factories(async () => { throw new Error("Something <odd>"); });
  assert.equal((await createRenderer(container, inputs, new AbortController().signal, () => {}, {}, odd.make)).fallbackReason, "webgpu-failed");
  const forced = factories(async () => handle("webgpu"));
  const result = await createRenderer(container, inputs, new AbortController().signal, () => {}, { prefer: "canvas" }, forced.make);
  assert.deepEqual([result.handle?.backend, result.fallbackReason, forced.calls], ["canvas", "forced", ["canvas"]]);
});

test("a lost GPU device falls back to the canvas body", async () => {
  const errors: string[] = [];
  const f = factories(async () => handle("webgpu"));
  await createRenderer(container, inputs, new AbortController().signal, code => errors.push(code), {}, f.make);
  f.lose("device-lost");
  assert.deepEqual(errors, ["device-lost"]);
  assert.deepEqual(f.calls, ["webgpu", "canvas"]);
});
