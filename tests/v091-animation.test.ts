import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleGeometry, SphereGeometry } from "three";
import { ASSETS_DIR, connectAion } from "./helpers";
import { GltfModel } from "../src/visual/models/gltf";
import { MODEL_EXTENT, sampleModel } from "../src/visual/models/sampler";
import { bakeAnimation } from "../src/visual/models/animation";
import { boundsOf, decodeBundle, encodeBundle } from "../src/visual/models/bundle";
import { validateGlb } from "../src/cards/assets/gltf";
import { controlModelClip } from "../src/animation/control";
import { ModelPlayback } from "../src/render/modelPlayback";
import type { ModelTarget, MorphTarget } from "../src/visual/types";
import { blend, BOUNCE_SECONDS, bounceMorphs, capsuleBetween, legIk, periodic, placed, RigBuilder, segmentSkin, softBounce, taperedTube, type V3 } from "../scripts/lib/rig";

const MODELS = join(ASSETS_DIR, "models");
const fox = () => new GltfModel(new Uint8Array(readFileSync(join(MODELS, "khronos", "fox.glb"))));

// ── The fox's clipped nose (root cause: animated frames quantized to the rest pose's range) ──────────────────────

test("regression: an animated frame beyond the rest pose survives the particle bundle (the running Fox's nose and tail)", () => {
  const model = fox();
  const { particles, surface } = sampleModel(model.geometry(), { count: 4000 });
  const run = bakeAnimation(model, surface, { animation: model.animations.findIndex(a => a.name === "Run") });
  const reach = boundsOf({ positions: particles.positions, frames: run.frames, count: particles.count });
  assert.ok(reach > MODEL_EXTENT + 0.1, `the run reaches ${reach.toFixed(3)}, beyond the rest pose's ${MODEL_EXTENT}`);
  const decoded = decodeBundle(encodeBundle({ ...particles, frames: run.frames, fps: run.fps }));
  assert.ok(decoded.extent >= reach, "the bundle's range covers every frame");
  let worst = 0, nose = -Infinity, decodedNose = -Infinity;
  run.frames.forEach((frame, f) => {
    for (let i = 0; i < frame.length; i++) worst = Math.max(worst, Math.abs(frame[i] - decoded.frames[f][i]));
    for (let i = 2; i < frame.length; i += 3) { nose = Math.max(nose, frame[i]); decodedNose = Math.max(decodedNose, decoded.frames[f][i]); }
  });
  // One quantization step of int16 over the bundle's range.
  assert.ok(worst <= decoded.extent / 32767 + 1e-6, `largest error ${worst}`);
  assert.ok(Math.abs(decodedNose - nose) < 1e-3, `the nose reaches ${nose.toFixed(3)} and is decoded at ${decodedNose.toFixed(3)} (v0.9.0 flattened it at ${MODEL_EXTENT})`);
});

// ── Morph targets and rigs ─────────────────────────────────────────────────────────────────────────────────────

/** A tiny soft body: a ball with squash and stretch morph targets, a crown bone and one ear, bouncing. */
function bouncer(): Uint8Array {
  const rig = new RigBuilder();
  rig.morph("squash"); rig.morph("stretch");
  const root = rig.bone("root", null, [0, 0, 0]), body = rig.bone("body", root, [0, 1, 0]), crown = rig.bone("crown", body, [0, 2, 0]), ear = rig.bone("ear", crown, [0, 2, 0]);
  const m = rig.material("pink", "#f39bb8");
  rig.part(placed(new SphereGeometry(1, 24, 16), [0, 1, 0]), m, () => [[body, 1]], { squash: bounceMorphs.squash, stretch: bounceMorphs.stretch });
  rig.part(taperedTube([[0, 1.9, 0], [0.2, 2.5, -0.2], [0.4, 2.9, -0.5]], 0.12, 0.06, 24, 8), m, () => [[ear, 1]]);
  rig.clip("Bounce", BOUNCE_SECONDS, 32, softBounce({ root, crown: { bone: crown, height: 2 }, appendages: [{ bone: ear, side: 1 }] }));
  return rig.toGlb();
}

/** A tiny biped with a tail: hips, two legs (thigh, shin, foot) and a three-bone tail, walking by leg IK. */
function strider(): Uint8Array {
  const rig = new RigBuilder();
  const root = rig.bone("root", null, [0, 0, 0]), hips = rig.bone("hips", root, [0, 1, 0]);
  const m = rig.material("teal", "#5fc9b8");
  rig.part(placed(new SphereGeometry(1, 24, 16), [0, 1.3, 0], [0, 0, 0], [0.4, 0.5, 0.35]), m, () => [[hips, 1]]);
  const legs = [1, -1].map(s => {
    const hip: V3 = [0.2 * s, 1, 0], knee: V3 = [0.22 * s, 0.55, 0.1], ankle: V3 = [0.22 * s, 0.1, 0];
    const thigh = rig.bone(`thigh${s}`, hips, hip), shin = rig.bone(`shin${s}`, thigh, knee), foot = rig.bone(`foot${s}`, shin, ankle);
    rig.part(capsuleBetween(hip, knee, 0.12), m, p => segmentSkin(p, hip, knee, thigh, hips, shin));
    rig.part(capsuleBetween(knee, ankle, 0.1), m, p => segmentSkin(p, knee, ankle, shin, thigh, foot));
    rig.part(placed(new CapsuleGeometry(0.08, 0.25, 4, 8), [0.22 * s, 0.06, 0.12], [90, 0, 0]), m, () => [[foot, 1]]);
    return { s, hip, knee, ankle, thigh, shin, foot };
  });
  const tailPoints: V3[] = [[0, 1.05, -0.3], [0, 0.95, -0.8], [0, 0.85, -1.25], [0, 0.8, -1.6]];
  const t1 = rig.bone("tail1", hips, tailPoints[0]), t2 = rig.bone("tail2", t1, tailPoints[1]), t3 = rig.bone("tail3", t2, tailPoints[2]);
  rig.part(taperedTube(tailPoints, 0.15, 0.04, 32, 10), m, p => { const z = -p.z; return z < 0.8 ? blend(z, 0.5, 0.85, t1, t2) : blend(z, 1.0, 1.3, t2, t3); });
  const L = legs[0], l1 = Math.hypot(L.knee[1] - L.hip[1], L.knee[2] - L.hip[2]), l2 = Math.hypot(L.ankle[1] - L.knee[1], L.ankle[2] - L.knee[2]);
  const rest = { thigh: Math.atan2(L.knee[2] - L.hip[2], -(L.knee[1] - L.hip[1])), shin: Math.atan2(L.ankle[2] - L.knee[2], -(L.ankle[1] - L.knee[1])) };
  rig.clip("Walk", 1, 24, t => {
    const bones: Record<number, { t?: V3; r?: V3 }> = {};
    for (const [leg, offset] of [[legs[0], 0], [legs[1], 0.5]] as const) {
      const u = (t + offset) % 1, stance = u < 0.5;
      const z = stance ? 0.2 - 0.8 * u : -0.2 + 0.4 * (0.5 - 0.5 * Math.cos(Math.PI * (u - 0.5) * 2));
      const y = leg.ankle[1] + (stance ? 0 : 0.15 * Math.sin(Math.PI * (u - 0.5) * 2));
      const ik = legIk([leg.hip[1], leg.hip[2]], [y, z], l1, l2, rest);
      bones[leg.thigh] = { r: [ik.thigh, 0, 0] }; bones[leg.shin] = { r: [ik.shin, 0, 0] }; bones[leg.foot] = { r: [ik.foot, 0, 0] };
    }
    [t1, t2, t3].forEach((bone, i) => { bones[bone] = { r: [0, -10 * Math.sin(2 * Math.PI * t - 0.5 * (i + 1)), 0] }; });
    bones[hips] = { r: [0, 5 * Math.sin(2 * Math.PI * t), 0] };
    return { bones };
  });
  return rig.toGlb();
}

test("rig builder: skins, morph targets and clips in a valid GLB; the reader evaluates morph weights from the animation", () => {
  const glb = bouncer();
  assert.ok(validateGlb(glb).triangles > 0);
  const model = new GltfModel(glb);
  assert.equal(model.joints, 4); assert.equal(model.morphTargets, 2);
  assert.deepEqual(model.animations.map(a => a.name), ["Bounce"]);
  const top = (time?: number) => { const g = model.geometry(time === undefined ? undefined : { animation: 0, time }); let y = -Infinity, width = 0;
    for (const p of g.primitives.slice(0, 1)) for (let i = 0; i < p.positions.length; i += 3) { y = Math.max(y, p.positions[i + 1]); width = Math.max(width, Math.abs(p.positions[i])); }
    return { y, width }; };
  const rest = top(), landing = top(1.09), launch = top(0.42);
  assert.ok(landing.y < rest.y - 0.3 && landing.width > rest.width * 1.08, `landing squashes the ball (top ${rest.y.toFixed(2)} → ${landing.y.toFixed(2)}, wider)`);
  assert.ok(launch.width < rest.width, "launch stretches it (narrower)");
});

/**
 * Attachment and loop continuity. A particle that detached from the surface, or a surface torn by bad skinning, leaves
 * particles far from all others: the spacing to the nearest neighbour (99th percentile over a sample) must stay close to
 * the rest pose's in every frame. And the step across the loop seam (last frame → first) is no larger than an ordinary one.
 */
function continuity(rest: Float32Array, frames: Float32Array[]) {
  const n = rest.length / 3, probe = Array.from({ length: Math.min(500, n) }, (_, k) => Math.floor(k * n / Math.min(500, n)));
  const spacing = (p: Float32Array) => {
    const d = probe.map(i => { let best = Infinity; for (let j = 0; j < n; j++) { if (j === i) continue; const e = (p[i * 3] - p[j * 3]) ** 2 + (p[i * 3 + 1] - p[j * 3 + 1]) ** 2 + (p[i * 3 + 2] - p[j * 3 + 2]) ** 2; if (e < best) best = e; } return Math.sqrt(best); }).sort((x, y) => x - y);
    return d[Math.floor(d.length * 0.99)];
  };
  const base = spacing(rest);
  const tear = Math.max(...frames.map(spacing)) / base;
  const step = (a: Float32Array, b: Float32Array) => { let worst = 0; for (let i = 0; i < a.length; i += 3) worst = Math.max(worst, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2])); return worst; };
  let largest = 0;
  for (let f = 1; f < frames.length; f++) largest = Math.max(largest, step(frames[f - 1], frames[f]));
  return { tear, seam: step(frames[frames.length - 1], frames[0]), largest };
}

test("soft body: particles stay on the deforming surface — no jumps, a seamless loop, the landing compresses the outline", () => {
  const model = new GltfModel(bouncer());
  const { particles, surface } = sampleModel(model.geometry(), { count: 3000, visibility: false });
  const baked = bakeAnimation(model, surface, { animation: 0 });
  const { tear, seam, largest } = continuity(particles.positions, baked.frames);
  assert.ok(tear < 2 && seam <= largest, `spacing ×${tear.toFixed(2)} of rest; seam ${seam.toFixed(3)} ≤ largest step ${largest.toFixed(3)}`);
  // The ball itself (the lower 70 % of particles at rest; the ear flops up on landing and would hide the squash).
  const ys = Array.from({ length: particles.count }, (_, i) => particles.positions[i * 3 + 1]).sort((x, y) => x - y);
  const cut = ys[Math.floor(ys.length * 0.7)];
  const ball = Array.from({ length: particles.count }, (_, i) => i).filter(i => particles.positions[i * 3 + 1] <= cut);
  const height = (frame: Float32Array) => { let lo = Infinity, hi = -Infinity; for (const i of ball) { lo = Math.min(lo, frame[i * 3 + 1]); hi = Math.max(hi, frame[i * 3 + 1]); } return hi - lo; };
  const landing = baked.frames[Math.round(1.09 / BOUNCE_SECONDS * baked.frames.length) % baked.frames.length];
  assert.ok(height(landing) < height(particles.positions) * 0.85, `the ball is compressed at landing (${height(landing).toFixed(2)} vs ${height(particles.positions).toFixed(2)} at rest)`);
});

test("biped with a tail: legs alternate, the tail follows through, every particle stays attached across the loop", () => {
  const model = new GltfModel(strider());
  const { particles, surface } = sampleModel(model.geometry(), { count: 3000, visibility: false });
  const baked = bakeAnimation(model, surface, { animation: 0 });
  const { tear, seam, largest } = continuity(particles.positions, baked.frames);
  assert.ok(tear < 2 && seam <= largest, `no tearing (spacing ×${tear.toFixed(2)} of rest); seam ${seam.toFixed(3)} ≤ ${largest.toFixed(3)}`);
  // The particles nearest each foot and the tail tip in the rest pose: the feet move opposite each other, the tail sways.
  const nearest = (where: V3) => { let best = 0, d = Infinity; for (let i = 0; i < particles.count; i++) { const e = Math.hypot(particles.positions[i * 3] - where[0], particles.positions[i * 3 + 1] - where[1], particles.positions[i * 3 + 2] - where[2]); if (e < d) { d = e; best = i; } } return best; };
  let lowest = [0, 0];
  for (let i = 0; i < particles.count; i++) { const y = particles.positions[i * 3 + 1]; if (y < particles.positions[lowest[0] * 3 + 1]) lowest = [i, 0]; }
  const xs = (i: number) => particles.positions[i * 3];
  const left = nearest([Math.abs(xs(lowest[0])), particles.positions[lowest[0] * 3 + 1], particles.positions[lowest[0] * 3 + 2]]);
  const right = nearest([-Math.abs(xs(lowest[0])), particles.positions[lowest[0] * 3 + 1], particles.positions[lowest[0] * 3 + 2]]);
  const zOf = (i: number) => baked.frames.map(f => f[i * 3 + 2]);
  const zl = zOf(left), zr = zOf(right);
  const correlation = zl.reduce((sum, v, k) => sum + (v - zl.reduce((a, b) => a + b) / zl.length) * (zr[k] - zr.reduce((a, b) => a + b) / zr.length), 0);
  assert.ok(correlation < 0, "the two feet move in opposite phase");
  let tipIndex = 0;
  for (let i = 0; i < particles.count; i++) if (particles.positions[i * 3 + 2] < particles.positions[tipIndex * 3 + 2]) tipIndex = i;
  const tipX = baked.frames.map(f => f[tipIndex * 3]);
  assert.ok(Math.max(...tipX) - Math.min(...tipX) > 0.1, `the tail tip sways (${(Math.max(...tipX) - Math.min(...tipX)).toFixed(3)})`);
});

test("leg IK: the computed rotations put the ankle where it was asked to be", () => {
  const hip: [number, number] = [1, 0], l1 = 0.45, l2 = 0.45, rest = { thigh: 0.2, shin: -0.1 };
  for (const want of [[0.15, 0.2], [0.2, -0.25], [0.3, 0.05]] as [number, number][]) {
    const r = legIk(hip, want, l1, l2, rest);
    const toRad = Math.PI / 180;
    const thigh = rest.thigh - r.thigh * toRad, shin = thigh + (rest.shin - rest.thigh) - r.shin * toRad;
    const ankle = [hip[0] - Math.cos(thigh) * l1 - Math.cos(shin) * l2, hip[1] + Math.sin(thigh) * l1 + Math.sin(shin) * l2];
    assert.ok(Math.hypot(ankle[0] - want[0], ankle[1] - want[1]) < 1e-6, `${want} → ${ankle.map(v => v.toFixed(4))}`);
    assert.ok(Math.abs(r.thigh + r.shin + r.foot) < 1e-9, "the foot stays flat");
  }
  const wave = periodic([[0, 0], [0.5, 1]], 1);
  assert.ok(Math.abs(wave(0) - wave(1)) < 1e-9 && Math.abs(wave(0.5) - 1) < 1e-9, "periodic keys loop");
});

test("Lumen (the bundled fixture) bounces with its own clip: squash on landing, a seamless loop", () => {
  const model = new GltfModel(new Uint8Array(readFileSync(join(MODELS, "originals", "lumen.glb"))));
  assert.deepEqual(model.animations.map(a => a.name), ["Bounce"]);
  assert.equal(model.morphTargets, 2);
  const { particles, surface } = sampleModel(model.geometry(), { count: 2000, visibility: false });
  const baked = bakeAnimation(model, surface, { animation: 0 });
  const { tear, seam, largest } = continuity(particles.positions, baked.frames);
  assert.ok(tear < 2 && seam <= largest, `spacing ×${tear.toFixed(2)} of rest; seam ${seam.toFixed(3)} ≤ ${largest.toFixed(3)}`);
});

// ── Playback control ───────────────────────────────────────────────────────────────────────────────────────────

test("clip control: pause, resume, replay, speed (slow/fast/slower/faster within 0.25–2.5×), stop; writing-only commands refused", () => {
  const current = { playing: true, speed: 1 };
  assert.deepEqual(controlModelClip(current, { action: "pause" }), { ok: true, playing: false, speed: 1, restart: false });
  assert.deepEqual(controlModelClip({ playing: false, speed: 1 }, { action: "resume" }), { ok: true, playing: true, speed: 1, restart: false });
  assert.equal((controlModelClip(current, { action: "speed", speed: "slow" }) as { speed: number }).speed, 0.5);
  assert.equal((controlModelClip({ playing: true, speed: 2.4 }, { action: "speed", speed: "faster" }) as { speed: number }).speed, 2.5);
  assert.equal((controlModelClip({ playing: true, speed: 0.3 }, { action: "speed", speed: "slower" }) as { speed: number }).speed, 0.25);
  assert.ok((controlModelClip(current, { action: "replay" }) as { restart: boolean }).restart);
  assert.ok(!controlModelClip(current, { action: "next" }).ok);
  const frames = [Float32Array.from([0, 0, 0]), Float32Array.from([1, 0, 0])];
  const target: MorphTarget = { visual: { kind: "model", id: "m", colors: "silver", playing: true, speed: 0.5, particles: { count: 1, positions: new Float32Array(3), colors: new Uint8Array(3), shade: new Uint8Array(1), frames, fps: 2 } }, hold: 1, label: "m" };
  const playback = new ModelPlayback();
  playback.reset(target);
  assert.ok(Math.abs(playback.sample(target, 0.5)!.positions[0] - 0.5) < 1e-6, "half speed: half a frame in half a second");
  (target.visual as ModelTarget).restart = 1;
  assert.equal(playback.sample(target, 0)!.positions[0], 0, "a new restart counter starts the clip over");
});

test("control_animation drives a model's own clip in place (same particles); a model without a clip is told so", async () => {
  const aion = await connectAion();
  try {
    const text = (result: Awaited<ReturnType<typeof aion.call>>) => (result.content as { text: string }[])[0].text;
    await aion.call("show_model", { model: "fox", animation: "Run" });
    const before = (await aion.link.run(backend => backend.state())).presentation as { media: { id: string } };
    const slower = await aion.call("control_animation", { action: "speed", speed: "slower" });
    assert.ok(!slower.isError, text(slower));
    const after = (await aion.link.run(backend => backend.state())).presentation as { media: { id: string }; speed: number; playing: boolean };
    assert.equal(after.media.id, before.media.id);
    assert.equal(after.speed, 0.7); assert.equal(after.playing, true);
    await aion.call("control_animation", { action: "pause" });
    assert.equal(((await aion.link.run(backend => backend.state())).presentation as { playing: boolean }).playing, false);
    await aion.call("show_model", { model: "Lumen" });
    const none = await aion.call("control_animation", { action: "pause" });
    assert.ok(none.isError && /no clip playing/.test(text(none)));
  } finally { await aion.close(); }
});
