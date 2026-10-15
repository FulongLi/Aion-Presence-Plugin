import assert from "node:assert/strict";
import { test } from "node:test";
import { Aion } from "../src/core/aion";
import { AionBody, bodyTransition } from "../src/core/body";
import { EYE_GEOMETRY, EYE_PARAMS } from "../src/core/eyes/layout";
import { EYE_EXPRESSIONS, EyesAnimator, STATE_EXPRESSION } from "../src/core/eyes/expression";
import { createFigureLayout, FIGURE_KINDS, FIGURE_SHARES, figurePoint, figureStroke, limbCurve, unpackAnchors } from "../src/core/figure/layout";
import { applyClip, clipWeight, EXPLAIN, FIGURE_GESTURES, gestureClip, sampleClip, stateTrack, WAVE, type Clip } from "../src/core/figure/motion";
import { FigureAnimator, flattenPose, NEUTRAL_POSE, solvePose, twoBone, unflattenPose } from "../src/core/figure/pose";
import { ANCHOR, ANCHOR_COUNT, FIGURE_SCALE, LIMB_SLOT } from "../src/core/figure/skeleton";
import { createSignal } from "../src/core/signal";
import { AION_STATES } from "../src/core/state";
import { PresenceStore } from "../src/core/store";
import { planPresentation, type PresentationContent } from "../src/core/presentation";
import { routePresentation } from "../src/core/presentationRouter";
import { hubCommandSchema, type HubSnapshot } from "../src/host/hub/protocol";
import { OrbitController, ORBIT } from "../src/render/interaction/orbit";
import { formedPoint } from "../src/render/physics/morph";
import { normalizeImage, HERITAGE_ANCHOR_Y } from "../src/visual/image";
import { HERITAGE_OVAL, ovalMask } from "../src/visual/oval";
import { createTargetPoints } from "../src/visual/points";
import { SCENE_PRESET_NAMES, SCENE_PRESETS } from "../src/visual/scene3d/presets";
import { SCENE_EXTENT, sceneParticles } from "../src/visual/scene3d/sample";
import { SCENE_LIMITS, SCENE_PRIMITIVES, type Scene3D } from "../src/visual/scene3d/types";
import { checkScene } from "../src/visual/scene3d/validate";
import type { Raster } from "../src/visual/types";
import { connectAion } from "./helpers";

const finite = (values: ArrayLike<number>) => Array.from(values).every(Number.isFinite);

// ── Heritage portrait ──────────────────────────────────────────────────────────────────────────────────

/** A synthetic "photograph": a bright face disc on a mid-grey background, `width` × `height`. */
function photo(width: number, height: number, ground = 110): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const face = Math.hypot((x - width / 2) / (width * 0.18), (y - height * 0.38) / (height * 0.16)) < 1;
    const v = face ? 225 : (x + y) % 9 === 0 ? 40 : ground;
    data.set([v, v, v, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("heritage oval: a soft elliptical mask, 1 inside, easing to 0 exactly on the oval, 0 outside", () => {
  assert.equal(ovalMask(0, 0), 1);
  assert.equal(ovalMask(0.5, 0.5), 1);
  assert.equal(ovalMask(1, 0), 0);
  assert.equal(ovalMask(0, -1.2), 0);
  const edge = ovalMask(0, 1 - HERITAGE_OVAL.feather / 2);
  assert.ok(edge > 0.2 && edge < 0.8, "fading within the feather");
  let previous = 1;
  for (let r = 0; r <= 1; r += 0.01) { const m = ovalMask(r * 0.6, r * 0.8); assert.ok(m <= previous + 1e-9, "monotonic"); previous = m; }
});

test("heritage normalization: exactly 3:4, cropped never stretched, the face kept; classic only when asked for", () => {
  for (const [width, height] of [[600, 900], [800, 800], [1200, 700], [300, 400]] as const) {
    const target = normalizeImage(photo(width, height), "portrait", { portraitStyle: "heritage" });
    assert.equal(target.frame, "oval");
    assert.equal(target.style, "portrait");
    assert.ok(Math.abs(target.raster.width / target.raster.height - 0.75) < 0.02, `${width}×${height} → 3:4`);
    // Cropping keeps pixel scale: one axis is only ever resized by the same factor as the other.
    const scale = Math.min(1, 300 / Math.max(Math.min(width, height * 0.75), Math.min(height, width / 0.75)));
    assert.ok(target.raster.width <= Math.ceil(Math.min(width, height * 0.75) * scale) + 1);
  }
  assert.ok(HERITAGE_ANCHOR_Y < 0.2, "a tall picture keeps its top (the head)");
  // v0.4.1: a portrait with no style is a heritage portrait; classic is the explicit alternative.
  assert.deepEqual(normalizeImage(photo(600, 900), "portrait"), normalizeImage(photo(600, 900), "portrait", { portraitStyle: "heritage" }));
  const classic = normalizeImage(photo(600, 900), "portrait", { portraitStyle: "classic" });
  assert.equal(classic.frame, undefined);
  assert.ok(Math.abs(classic.raster.width / classic.raster.height - 0.72) < 0.02, "the classic head-and-shoulders band (a 2:3 photo cropped to 0.72)");
});

test("heritage sampling: nothing outside the oval, a silver outline of about a tenth of the particles, the face denser", () => {
  const target = normalizeImage(photo(450, 600), "portrait", { portraitStyle: "heritage" });
  const count = 20_000;
  const { positions, tones } = createTargetPoints(target, count);
  assert.ok(finite(positions) && finite(tones));
  const h = 3.6, w = h * target.raster.width / target.raster.height;
  let outline = 0, outside = 0, faceInside = 0, cornerInside = 0;
  for (let i = 0; i < count; i++) {
    const r = Math.hypot(positions[i * 3] / (w / 2), positions[i * 3 + 1] / (h / 2));
    if (r > HERITAGE_OVAL.bevelRadius + 0.02) outside++;
    if (r > 0.985) outline++;
    if (Math.hypot(positions[i * 3] / (w * 0.18), (positions[i * 3 + 1] - h * 0.12) / (h * 0.16)) < 1) faceInside++;
    if (positions[i * 3] < -w * 0.25 && positions[i * 3 + 1] < -h * 0.25 && r < 0.9) cornerInside++;
  }
  assert.equal(outside, 0, "no particle beyond the outline");
  assert.ok(outline / count > 0.07 && outline / count < 0.14, `outline share ${(outline / count).toFixed(3)}`);
  assert.ok(faceInside > cornerInside * 2, "the bright face carries more particles than the background");
  // Same input, same particles (every quality tier is a prefix).
  assert.deepEqual(createTargetPoints(target, 500).positions, createTargetPoints(target, 2000).positions.subarray(0, 1500));
});

test("heritage sampling of a drawing on pale paper follows the ink, not the paper", () => {
  // Pale paper with a dark-red diagonal stroke.
  const width = 300, height = 400, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ink = Math.abs(x - y * 0.75) < 6;
    data.set(ink ? [140, 60, 40, 255] : [235, 220, 195, 255], (y * width + x) * 4);
  }
  const target = normalizeImage({ width, height, data }, "portrait", { portraitStyle: "heritage" });
  const { positions } = createTargetPoints(target, 8_000);
  const h = 3.6, w = h * 0.75;
  let near = 0, photo = 0;
  for (let i = 0; i < 8_000; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1];
    if (Math.hypot(x / (w / 2), y / (h / 2)) > 0.97) continue;
    photo++;
    const px = (x / w + 0.5) * width, py = (0.5 - y / h) * height;
    if (Math.abs(px - py * 0.75) < 20) near++;
  }
  assert.ok(near / photo > 0.5, `most particles draw the stroke (${(near / photo).toFixed(2)})`);
});

// ── Figure 2.0 ────────────────────────────────────────────────────────────────────────────────────────

test("Figure 3.0 particle allocation: continuous limbs, the head and small hand/foot ends; no joint beads, dust, halo or veil", () => {
  assert.equal(FIGURE_SHARES.dust, 0); assert.equal(FIGURE_SHARES.halo, 0); assert.equal(FIGURE_SHARES.veil, 0);
  assert.ok(FIGURE_SHARES.aura <= 0.05, "at most a thin glow");
  assert.equal(FIGURE_SHARES.bone, 0, "no straight bones: every limb is one curve");
  assert.ok(FIGURE_SHARES.joint <= 0.04, "only the small ends of the hands and feet, no joint beads");
  assert.ok(FIGURE_SHARES.limb + FIGURE_SHARES.ring + FIGURE_SHARES.joint >= 0.95);
  assert.ok(Math.abs(Object.values(FIGURE_SHARES).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const layout = createFigureLayout(20_000);
  const counts = new Map<number, number>();
  for (let i = 0; i < layout.count; i++) { const kind = unpackAnchors(layout.bind[i * 4]).kind; counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  assert.ok((counts.get(FIGURE_KINDS.limb) ?? 0) / layout.count > 0.75);
  assert.equal(counts.get(FIGURE_KINDS.bone) ?? 0, 0);
  assert.equal(counts.get(FIGURE_KINDS.dust) ?? 0, 0);
});

test("Figure 3.0 limbs are precise: every grain stays within a few line widths of its limb's curve, which passes through the joints", () => {
  const layout = createFigureLayout(12_000);
  const animator = new FigureAnimator();
  for (const [state, t] of [["idle", 0], ["responding", 3.2], ["thinking", 2], ["greeting", 1.2]] as const) {
    for (let k = 0; k < 20; k++) animator.sample(0.05, state, t + k * 0.05);
    const anchors = animator.anchors;
    const at = (i: number) => [anchors[i * 4], anchors[i * 4 + 1], anchors[i * 4 + 2]];
    for (let i = 0; i < layout.count; i += 3) {
      const { a, b, c, d, kind } = unpackAnchors(layout.bind[i * 4]);
      if (kind !== FIGURE_KINDS.limb || layout.bind[i * 4 + 3] < 0.3) continue;
      const p = figurePoint(layout, i, anchors, { clock: t, orbit: 0, thinking: 0 }).position;
      // The nearest point of the limb's curve (sampled densely), without the limb's secondary-motion offset.
      const chain = [a, b, c, d].map(at);
      let best = Infinity;
      for (let k = 0; k < 3; k++) for (let u = 0; u <= 1; u += 0.02) {
        const q = limbCurve(chain, k, u).point;
        best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
      const lag = Math.hypot(...[0, 1, 2].map(n => anchors[(LIMB_SLOT + layout.bind[i * 4 + 2]) * 4 + n]));
      assert.ok(best < figureStroke.width * FIGURE_SCALE * 7 + lag, `${state}: grain ${i} on its limb (${best.toFixed(4)})`);
    }
  }
  // The curve passes exactly through every anchor of its chain (the joints are control points, not corners).
  const pose = solvePose(NEUTRAL_POSE);
  assert.ok(finite(pose));
  const p = (name: keyof typeof ANCHOR) => [pose[ANCHOR[name] * 3], pose[ANCHOR[name] * 3 + 1], pose[ANCHOR[name] * 3 + 2]];
  const arm = [p("neck"), p("shoulderLeft"), p("elbowLeft"), p("handLeft")];
  for (const [k, u, anchor] of [[0, 0, 0], [1, 0, 1], [2, 0, 2], [2, 1, 3]] as const) {
    const q = limbCurve(arm, k, u).point;
    assert.ok(Math.hypot(q[0] - arm[anchor][0], q[1] - arm[anchor][1], q[2] - arm[anchor][2]) < 1e-9);
  }
});

test("two-bone IK keeps limb lengths and points straight at a target out of reach", () => {
  const root: [number, number, number] = [0, 0, 0];
  for (const target of [[0.3, -0.2, 0.1], [2, 0.5, 0], [0, -0.6, 0.2], [0.01, 0.01, 0]] as [number, number, number][]) {
    const [mid, end] = twoBone(root, target, 0.28, 0.26, [0.3, -1, 0.2]);
    assert.ok(Math.abs(Math.hypot(...mid) - 0.28) < 1e-6);
    assert.ok(Math.abs(Math.hypot(...end.map((v, i) => v - mid[i])) - 0.26) < 1e-6);
  }
  const [, far] = twoBone(root, [2, 0, 0], 0.28, 0.26, [0, -1, 0]);
  assert.ok(far[0] > 0.53 && Math.abs(far[1]) < 1e-3, "extended toward the target");
  const pose = unflattenPose(flattenPose(NEUTRAL_POSE));
  assert.deepEqual(solvePose(pose), solvePose(NEUTRAL_POSE), "flatten ⇄ unflatten is lossless");
});

test("clips have intent: eased keys, a clear start and end, and every gesture is bounded", () => {
  const wave = WAVE("right");
  assert.equal(clipWeight(wave, 0), 0);
  assert.equal(clipWeight(wave, wave.duration + 0.01), 0);
  assert.ok(clipWeight(wave, wave.duration / 2) > 0.99);
  const base = flattenPose(NEUTRAL_POSE);
  const mid = sampleClip(wave, 1.2, base);
  assert.ok(mid["right.raise"] > 0.8, "the waving arm is raised");
  for (const name of FIGURE_GESTURES) {
    const clip = gestureClip(name);
    assert.ok(clip.duration > 0.5 && clip.duration < 10, name);
    for (let t = 0; t <= clip.duration; t += 0.05) {
      const pose = solvePose(unflattenPose(applyClip(flattenPose(NEUTRAL_POSE), clip, t)));
      assert.ok(finite(pose), `${name} finite`);
      for (let i = 0; i < pose.length; i++) assert.ok(Math.abs(pose[i]) < 1.2, `${name} bounded at ${t.toFixed(2)}`);
    }
  }
});

test("gesture transitions are continuous: no jump when a state changes or a cue starts and ends", () => {
  const animator = new FigureAnimator();
  const dt = 1 / 60;
  let previous = Float32Array.from(animator.sample(dt, "idle", 0));
  const states = ["idle", "listening", "thinking", "responding", "complete", "error", "greeting", "idle"] as const;
  let time = 0, maxStep = 0, seam = 0;
  let velocity = new Float32Array(previous.length);
  for (const state of states) {
    if (state === "thinking") animator.cue(gestureClip("jump"));
    if (state === "complete") animator.cue(EXPLAIN([1.2, 0.3, 0.25]));
    for (let k = 0; k < 150; k++) {
      const anchors = animator.sample(dt, state, k * dt);
      const next = new Float32Array(anchors.length);
      for (let i = 0; i < anchors.length; i++) {
        next[i] = anchors[i] - previous[i];
        maxStep = Math.max(maxStep, Math.abs(next[i]));
        // Where a state or cue begins, motion may change direction but never snap: velocity changes only a little.
        if (k < 3) seam = Math.max(seam, Math.abs(next[i] - velocity[i]));
      }
      velocity = next;
      previous = Float32Array.from(anchors);
      time += dt;
    }
  }
  assert.ok(seam < 0.02, `a new state or cue begins smoothly (largest change of per-frame velocity ${seam.toFixed(3)})`);
  // Fast gestures (arms thrown up in a jump) still move less than a fifth of a unit per frame: never a teleport.
  assert.ok(maxStep < 0.2, `largest per-frame anchor move ${maxStep.toFixed(3)} world units`);
  assert.ok(time > 10);
});

test("state tracks are varied and paced: pauses between actions, never the same action twice in a row", () => {
  for (const state of ["idle", "listening", "thinking", "responding"] as const) {
    const track = stateTrack(state, 120);
    assert.ok(track.length >= 4, `${state} has actions`);
    for (let i = 1; i < track.length; i++) {
      assert.ok(track[i].at >= track[i - 1].at + track[i - 1].clip.duration + 0.4, `${state}: a pause after ${track[i - 1].clip.name}`);
      if (state !== "idle") assert.ok(track[i].clip !== track[i - 1].clip || track[i].clip.name !== track[i - 1].clip.name || state === "responding", "varied");
    }
    assert.deepEqual(stateTrack(state, 60).map(e => e.at), stateTrack(state, 60).map(e => e.at), "deterministic");
  }
  const responding = stateTrack("responding", 120).map(e => e.clip.name);
  assert.ok(new Set(responding).size >= 4, `several gestures while answering (${[...new Set(responding)].join(", ")})`);
});

test("explaining points at the term: the pointing hand reaches toward it, the head turns to it, then it relaxes", () => {
  const target: [number, number, number] = [1.4, 0.35, 0.25];
  const clip: Clip = EXPLAIN(target);
  const at = (t: number) => solvePose(unflattenPose(applyClip(flattenPose(NEUTRAL_POSE), clip, t)));
  const pointing = at(3.0), relaxed = at(clip.duration);
  const hand = [pointing[ANCHOR.handLeft * 3], pointing[ANCHOR.handLeft * 3 + 1]];
  const shoulder = [pointing[ANCHOR.shoulderLeft * 3], pointing[ANCHOR.shoulderLeft * 3 + 1]];
  const toward = Math.atan2(target[1] - shoulder[1], target[0] - shoulder[0]), arm = Math.atan2(hand[1] - shoulder[1], hand[0] - shoulder[0]);
  assert.ok(Math.abs(toward - arm) < 0.2, `the arm points at the term (${toward.toFixed(2)} vs ${arm.toFixed(2)})`);
  assert.ok(pointing[ANCHOR.head * 3] > solvePose(NEUTRAL_POSE)[ANCHOR.head * 3], "the head leads toward it");
  const neutral = solvePose(NEUTRAL_POSE);
  for (let i = 0; i < relaxed.length; i++) assert.ok(Math.abs(relaxed[i] - neutral[i]) < 0.02, "relaxed at the end");
});

// ── Aion Eyes ─────────────────────────────────────────────────────────────────────────────────────────

// Aion Eyes (redesigned in v0.4.1: see v41.test.ts for the cartoon geometry and motion).
test("Aion Eyes animate: they blink on their own, move in saccades, answer the user's voice and follow requests", () => {
  const eyes = new EyesAnimator();
  let minHeight = Infinity;
  const gazes = new Set<string>();
  for (let k = 0; k < 600; k++) {
    const p = eyes.sample(1 / 60, "idle", k / 60);
    minHeight = Math.min(minHeight, p[3]);
    gazes.add(p[0].toFixed(3));
  }
  assert.ok(minHeight < 0.2 * EYE_GEOMETRY.halfHeight, "a blink happened in ten seconds");
  assert.ok(gazes.size > 5, "the gaze moved");
  const quiet = new EyesAnimator(), loud = new EyesAnimator();
  for (let k = 0; k < 120; k++) { quiet.sample(1 / 60, "listening", k / 60, { listen: 0 }); loud.sample(1 / 60, "listening", k / 60, { listen: 1 }); }
  assert.ok(loud.params[11] > quiet.params[11], "the eyes brighten with the user's voice");
  eyes.express("surprised", 3);
  for (let k = 0; k < 60; k++) eyes.sample(1 / 60, "idle", 10 + k / 60);
  assert.equal(eyes.expression, "surprised");
  for (let k = 0; k < 240; k++) eyes.sample(1 / 60, "idle", 11 + k / 60);
  assert.equal(eyes.expression, "neutral", "a requested expression ends by itself");
  eyes.express("nonsense" as never);
  assert.equal(eyes.expression, "neutral");
  for (const state of AION_STATES) assert.ok(EYE_EXPRESSIONS.includes(STATE_EXPRESSION[state]), state);
  assert.equal(EYE_PARAMS, 16);
});

test("three persistent bodies: sphere → eyes → figure → sphere, one particle transition each", () => {
  const body = new AionBody();
  const run = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) body.sample(1 / 60); };
  assert.equal(body.set("eyes"), true); run(bodyTransition.seconds + 0.1);
  assert.deepEqual([body.level, body.eyes], [0, 1]);
  assert.equal(body.set("figure"), true); run(bodyTransition.seconds + 0.1);
  assert.deepEqual([body.level, body.eyes], [1, 0]);
  assert.equal(body.set("sphere"), true); run(bodyTransition.seconds + 0.1);
  assert.deepEqual([body.level, body.eyes], [0, 0]);
  assert.equal(body.transitioning, false);
});

test("express: the eyes wear an expression, the figure acts it out, the sphere gathers briefly", () => {
  const signal = createSignal();
  const aion = new Aion({ activity: () => "idle", presenting: () => false, signal: () => signal });
  aion.setBody("eyes");
  aion.express({ expression: "happy" });
  aion.sample(1 / 60, 0);
  assert.equal(aion.eyes.expression, "happy");
  aion.setBody("figure");
  aion.express({ gesture: "jump" });
  assert.equal(aion.figure.cueing, "jump");
  aion.express({ expression: "surprised" });
  assert.equal(aion.figure.cueing, "surprise");
  const frame = aion.sample(1 / 60, 0.1);
  assert.ok(finite(frame.anchors) && finite(frame.eyeParams));
  aion.setBody("sphere");
  aion.express({ gesture: "wave" });
  aion.sample(1 / 60, 0.2);
  assert.equal(aion.currentState, "acknowledging");
});

// ── 3D scene engine ───────────────────────────────────────────────────────────────────────────────────

test("3D schema: presets are valid; unknown fields, code, bad numbers and oversize scenes are rejected", () => {
  for (const name of SCENE_PRESET_NAMES) assert.equal(checkScene(SCENE_PRESETS[name]).ok, true, name);
  const bad: [unknown, RegExp][] = [
    [null, /object/],
    [{ title: "x", objects: [] }, /1 to 24/],
    [{ title: "x", objects: [{ type: "box", size: [1, 1, 1], onload: "alert(1)" }] }, /unknown field "onload"/],
    [{ title: "x", objects: [{ type: "script", src: "https://x" }] }, /type must be one of/],
    [{ title: "x", objects: [{ type: "sphere", radius: Number.NaN }] }, /radius/],
    [{ title: "x", objects: [{ type: "sphere", radius: 1e6 }] }, /radius/],
    [{ title: "x", objects: [{ type: "sphere", radius: 1, position: [0, 0, 99] }] }, /position/],
    [{ title: "<img src=x>", objects: [{ type: "sphere", radius: 1 }] }, /title/],
    [{ title: "x", objects: [{ type: "torus", radius: 1, tube: 2 }] }, /tube must be smaller/],
    [{ title: "x", objects: [{ type: "ring", inner: 2, outer: 1 }] }, /inner must be smaller/],
    [{ title: "x", objects: Array.from({ length: 25 }, () => ({ type: "sphere", radius: 1 })) }, /1 to 24/],
    [{ title: "x", objects: Array.from({ length: 5 }, () => ({ type: "sphere", radius: 1, repeat: { count: 60 } })) }, /after repeats/],
    [{ title: "x", objects: [{ type: "torus", radius: 1, tube: 0.2, repeat: { count: 40 } }] }, /too detailed/],
    [{ title: "x", objects: [{ type: "curve", points: Array.from({ length: 65 }, (_, i) => [i / 10, 0, 0]) }] }, /2 to 64 points/],
    [{ title: "x", objects: [{ type: "sphere", radius: 1 }], rotation: "fast" }, /slow or none/],
    [{ title: "x".repeat(SCENE_LIMITS.payload), objects: [{ type: "sphere", radius: 1 }] }, /bytes/],
  ];
  for (const [scene, problem] of bad) {
    const check = checkScene(scene);
    assert.equal(check.ok, false, JSON.stringify(scene).slice(0, 80));
    if (!check.ok) assert.match(check.problem, problem);
  }
  // Prototype tricks are unknown fields: rejected, and nothing is polluted.
  const input = JSON.parse('{"title":"ok","objects":[{"type":"sphere","radius":1}],"__proto__":{"polluted":true}}');
  const check = checkScene(input);
  assert.equal(check.ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // A valid scene comes back as a clean copy, never the input object.
  const scene = { title: "ok", objects: [{ type: "sphere", radius: 1 }] };
  const clean = checkScene(scene);
  assert.ok(clean.ok && clean.scene !== (scene as unknown) && clean.scene.objects[0] !== scene.objects[0]);
});

test("3D primitives: every primitive builds into particles within the stage, centred and scaled", () => {
  const objects: Record<string, unknown> = {
    box: { type: "box", size: [1, 2, 0.5] }, sphere: { type: "sphere", radius: 1 }, pyramid: { type: "pyramid", base: 2, height: 1.4 },
    cylinder: { type: "cylinder", radius: 0.5, height: 2 }, cone: { type: "cone", radius: 0.6, height: 1.5 }, torus: { type: "torus", radius: 1, tube: 0.25 },
    ring: { type: "ring", inner: 1, outer: 1.5 }, line: { type: "line", from: [-1, 0, 0], to: [1, 1, 0] },
    tube: { type: "tube", points: [[0, 0, 0], [1, 1, 0], [2, 0, 1]], radius: 0.1 }, curve: { type: "curve", points: [[0, 0, 0], [1, 1, 0], [2, 0, 1]] },
    helix: { type: "helix", radius: 0.5, height: 2, turns: 3 },
  };
  assert.deepEqual(Object.keys(objects).sort(), [...SCENE_PRIMITIVES].sort());
  for (const [name, object] of Object.entries(objects)) {
    const check = checkScene({ title: name, objects: [object] });
    assert.equal(check.ok, true, name);
    if (!check.ok) continue;
    const { positions, tones } = sceneParticles(check.scene, 4_000);
    assert.ok(finite(positions) && finite(tones), name);
    let radius = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 4_000; i++) {
      radius = Math.max(radius, Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i * 3 + k]); max[k] = Math.max(max[k], positions[i * 3 + k]); }
    }
    assert.ok(radius <= SCENE_EXTENT + 0.05 && radius > SCENE_EXTENT * 0.6, `${name}: fills the stage (${radius.toFixed(2)})`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(min[k] + max[k]) / 2 < 0.08, `${name}: centred on axis ${k}`);
  }
});

test("3D sampling: the pyramid concentrates on its geometry — base, four faces, apex and bright edges", () => {
  const check = checkScene(SCENE_PRESETS.pyramid);
  assert.ok(check.ok);
  if (!check.ok) return;
  const count = 20_000;
  const { positions, tones } = sceneParticles(check.scene, count);
  let top = -Infinity, bottom = Infinity;
  for (let i = 0; i < count; i++) { top = Math.max(top, positions[i * 3 + 1]); bottom = Math.min(bottom, positions[i * 3 + 1]); }
  // Every particle lies on the solid's surface: |x| and |z| shrink linearly toward the apex.
  const height = top - bottom;
  let off = 0, bright = 0;
  for (let i = 0; i < count; i++) {
    const x = Math.abs(positions[i * 3]), y = positions[i * 3 + 1], z = Math.abs(positions[i * 3 + 2]);
    const limit = (top - y) / height;
    const halfBase = 2.3 / 2 * (SCENE_EXTENT / Math.hypot(2.3 / 2 * Math.SQRT2, 1.46 / 2));
    if (Math.max(x, z) > limit * halfBase + 0.05) off++;
    if (tones[i] > 0.78) bright++;
  }
  assert.ok(off / count < 0.01, `on the pyramid (${off} off)`);
  assert.ok(bright / count > 0.3 && bright / count < 0.6, "edges are drawn brighter than faces");
  assert.deepEqual(sceneParticles(check.scene, 300).positions, sceneParticles(check.scene, 900).positions.subarray(0, 900), "prefix-stable");
});

test("3D through the target pipeline: mesh3d targets are validated again and sampled", () => {
  const ok = createTargetPoints({ kind: "mesh3d", scene: SCENE_PRESETS.dna as Scene3D }, 3_000);
  assert.equal(ok.positions.length, 9_000);
  assert.throws(() => createTargetPoints({ kind: "mesh3d", scene: { title: "x", objects: [{ type: "sphere", radius: -1 }] } as unknown as Scene3D }, 100), /scene-invalid/);
});

test("3D interaction: it turns by itself, drags, zooms within bounds, obeys commands and resets", () => {
  const orbit = new OrbitController();
  orbit.reset({ orbit: ORBIT.spin, tilt: 0.3 });
  orbit.active = true;
  const start = orbit.sample(0).yaw;
  for (let k = 0; k < 600; k++) orbit.sample(1 / 60);
  assert.ok(orbit.yaw > start + 0.5, "the slow turn");
  orbit.dragBy(100, 0);
  const dragged = orbit.yaw;
  for (let k = 0; k < 30; k++) orbit.sample(1 / 60);
  assert.ok(orbit.yaw >= dragged, "keeps a little momentum");
  for (let k = 0; k < 20; k++) orbit.zoomBy(2);
  for (let k = 0; k < 120; k++) orbit.sample(1 / 60);
  assert.ok(orbit.zoom <= ORBIT.zoom.max + 1e-6);
  const before = orbit.yaw;
  orbit.command({ rotate: "right", degrees: 90, spin: false });
  for (let k = 0; k < 120; k++) orbit.sample(1 / 60);
  assert.ok(Math.abs(orbit.yaw - before - Math.PI / 2) < 0.05, "rotate right by 90°");
  orbit.command({ rotate: "up", degrees: 180 });
  for (let k = 0; k < 120; k++) orbit.sample(1 / 60);
  assert.ok(orbit.pitch <= ORBIT.pitch.max + 1e-6, "tilt bounded");
  orbit.command({ reset: true });
  for (let k = 0; k < 240; k++) orbit.sample(1 / 60);
  assert.ok(Math.abs(orbit.pitch - 0.3) < 0.02 && Math.abs(orbit.zoom - 1) < 0.02, "back to the default view");
  orbit.active = false;
  assert.equal(orbit.sample(1 / 60).depth, 0, "inactive for flat visuals");
  // The view transform leaves flat visuals untouched and turns 3D points about the vertical axis.
  assert.deepEqual(formedPoint(0.4, 0.5, 0.6, { angle: 0, yaw: 0, pitch: 0, zoom: 1 }), [0.4, 0.5, 0.6]);
  const turned = formedPoint(1, 0, 0, { angle: 0, yaw: Math.PI / 2, pitch: 0, zoom: 1 });
  assert.ok(Math.abs(turned[0]) < 1e-9 && Math.abs(turned[2] + 1) < 1e-9);
});

test("routing: 3D objects are the body; a card is never forced on them; v0.3 routes are unchanged", () => {
  const scene: PresentationContent = { kind: "scene", scene: SCENE_PRESETS.saturn as Scene3D, label: "Saturn" };
  assert.deepEqual(routePresentation({ content: scene }), { route: "body", reason: "body-native", preference: "auto" });
  assert.equal(routePresentation({ content: scene, preference: "card" }).route, "body");
  assert.equal(planPresentation(scene, "body").body.type, "scene");
  assert.equal(planPresentation(scene, "body").card, false);
  const media = { id: `m${"a".repeat(18)}`, mime: "image/jpeg", bytes: 1 };
  assert.equal(routePresentation({ content: { kind: "image", media, fit: "portrait", origin: "lookup", width: 800, height: 1000, style: "heritage" } }).route, "hybrid");
  assert.equal(routePresentation({ content: { kind: "text", text: "x".repeat(400) } }).route, "card");
  assert.equal(routePresentation({ content: { kind: "artifact", type: "code", title: "x", content: "let a = 1" } }).route, "card");
  assert.equal(routePresentation({ content: { kind: "terrain", media: { ...media, mime: "application/vnd.aion.heightfield" }, style: "terrain", label: "x" } }).route, "body");
});

test("the store orients a 3D object only while one is on show, and carries expressions with fresh ids", () => {
  const store = new PresenceStore();
  assert.equal(store.orient({ rotate: "left" }), false);
  store.present({ kind: "scene", scene: SCENE_PRESETS.pyramid as Scene3D, label: "Egyptian pyramid" });
  assert.equal(store.orient({ rotate: "left" }), true);
  assert.equal(store.snapshot().sceneView?.rotate, "left");
  assert.equal(store.express({}), false);
  store.express({ expression: "happy" });
  const first = store.snapshot().expression!.id;
  store.express({ gesture: "wave" });
  assert.equal(store.snapshot().expression!.id, first + 1);
  store.dispose();
});

test("the hub re-validates v0.4 commands and still accepts every v0.3 command", () => {
  const ok = (command: unknown) => hubCommandSchema.safeParse(command).success;
  assert.ok(ok({ type: "body", body: "eyes" }));
  assert.ok(ok({ type: "body", body: "figure" }) && ok({ type: "body", body: "sphere" }));
  assert.ok(ok({ type: "express", expression: "curious", seconds: 3 }));
  assert.ok(!ok({ type: "express" }), "nothing to express");
  assert.ok(!ok({ type: "express", expression: "angry-rage" }));
  assert.ok(ok({ type: "view", rotate: "up", degrees: 30 }));
  assert.ok(!ok({ type: "view", rotate: "sideways" }));
  assert.ok(ok({ type: "present", content: { kind: "scene", scene: SCENE_PRESETS.dna, label: "DNA double helix" } }));
  assert.ok(!ok({ type: "present", content: { kind: "scene", scene: { title: "x", objects: [{ type: "box", size: [1, 1, 1], code: "x" }] }, label: "x" } }));
  assert.ok(ok({ type: "present", content: { kind: "text", text: "a² + b² = c²", emphasis: "c²" } }));
  assert.ok(!ok({ type: "present", content: { kind: "text", text: "a² + b² = c²", emphasis: "d²" } }), "emphasis must be in the text");
  const media = { id: `m${"a".repeat(18)}`, mime: "image/jpeg", bytes: 100 };
  assert.ok(ok({ type: "present", content: { kind: "image", media, fit: "portrait", style: "heritage" } }));
  assert.ok(!ok({ type: "present", content: { kind: "image", media, fit: "portrait", style: "sepia" } }));
  // v0.3 commands, unchanged.
  for (const command of [
    { type: "activity", state: "responding" }, { type: "present", content: { kind: "form", form: "tao.yin-yang", label: "Yin-yang" } },
    { type: "present", content: { kind: "image", media, fit: "portrait", origin: "lookup" }, presentation: "hybrid" }, { type: "clear" },
    { type: "open", display: "immersive", greet: true },
  ]) assert.ok(ok(command), JSON.stringify(command));
});

test("MCP: show_scene (preset or scene), set_scene_view, express, heritage portraits and emphasis", async () => {
  const aion = await connectAion();
  try {
    type Out = { presentation: { kind: string; route: string; description: string } | null; body: string; shown?: string };
    const out = (result: unknown) => {
      const r = result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
      assert.equal(r.isError, undefined, r.content.map(c => c.text).join(" "));
      return r.structuredContent as Out;
    };
    const error = (result: unknown) => { const r = result as { isError?: boolean; content: { text: string }[] }; assert.equal(r.isError, true); return r.content[0].text; };
    assert.match(error(await aion.call("set_scene_view", { rotate: "left" })), /no-scene/);
    const pyramid = out(await aion.call("show_scene", { preset: "pyramid" }));
    assert.equal(pyramid.presentation?.kind, "scene");
    assert.equal(pyramid.presentation?.route, "body");
    assert.equal(pyramid.shown, "Egyptian pyramid");
    out(await aion.call("set_scene_view", { rotate: "up", degrees: 30 }));
    const snapshot = await aion.link.run(backend => backend.state()) as HubSnapshot;
    assert.equal(snapshot.sceneView?.rotate, "up");
    const water = { title: "Water molecule", objects: [{ type: "sphere", radius: 0.6 }, { type: "sphere", radius: 0.36, position: [-0.78, -0.58, 0] }, { type: "sphere", radius: 0.36, position: [0.78, -0.58, 0] }] };
    assert.equal(out(await aion.call("show_scene", { scene: water })).presentation?.description, "3D: Water molecule");
    assert.match(error(await aion.call("show_scene", { scene: { ...water, objects: [{ type: "sphere", radius: 99 }] } })), /scene-invalid: objects\[0\]\.radius/);
    assert.match(error(await aion.call("show_scene", {})), /exactly one of preset or scene/);
    assert.equal(out(await aion.call("set_body_form", { body: "eyes" })).body, "eyes");
    out(await aion.call("express", { expression: "happy" }));
    const expressed = await aion.link.run(backend => backend.state()) as HubSnapshot;
    assert.equal(expressed.expression?.expression, "happy");
    assert.match(error(await aion.call("express", {})), /invalid-arguments/);
    const text = out(await aion.call("show_text", { text: "a² + b² = c²", emphasis: "c²" }));
    assert.equal(text.presentation?.route, "card");
    assert.match(error(await aion.call("show_text", { text: "a² + b² = c²", emphasis: "x" })), /emphasis-not-in-text/);
    const tools = (await aion.client.listTools()).tools.map(tool => tool.name);
    for (const name of ["express", "show_scene", "set_scene_view"]) assert.ok(tools.includes(name), name);
    const portrait = tools.includes("show_portrait") ? (await aion.client.listTools()).tools.find(tool => tool.name === "show_portrait") : undefined;
    assert.ok(JSON.stringify(portrait?.inputSchema).includes("heritage"), "show_portrait offers the heritage style");
  } finally { await aion.close(); }
});

test("the animators stay finite and bounded for every state over time (renderer fallback relies on the CPU references)", () => {
  const signal = createSignal();
  for (const body of ["sphere", "figure", "eyes"] as const) {
    const aion = new Aion({ activity: () => "responding", presenting: () => false, signal: () => signal });
    aion.setBody(body);
    for (let k = 0; k < 400; k++) {
      const frame = aion.sample(1 / 60, k / 60);
      assert.ok(finite(frame.anchors) && finite(frame.eyeParams) && frame.level >= 0 && frame.level <= 1 && frame.eyes >= 0 && frame.eyes <= 1);
    }
    for (let i = 0; i < ANCHOR_COUNT * 4; i++) assert.ok(Math.abs(aion.figure.anchors[i]) <= FIGURE_SCALE * 1.2);
  }
});
