import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCENE_IR_LIMITS, type SceneDocument } from "../src/scene/ir";
import { validateScene } from "../src/scene/validate";
import { applyPatch } from "../src/scene/patch";
import { commit, HISTORY_LIMITS, redo, resetHistory, startHistory, undo } from "../src/scene/history";
import { PoseEvaluator, SceneTimeline } from "../src/scene/animation";
import { checkCapabilities, DEFAULT_RUNTIME, requirementsOf } from "../src/scene/capabilities";
import { routeScene } from "../src/scene/router";
import { toParticleScene } from "../src/scene/particleAdapter";
import { pathPoints, samplePath } from "../src/scene/paths";
import { quatFromEuler, rotate } from "../src/scene/math";
import { summarizeScene } from "../src/scene/summary";
import { sceneFromModel } from "../src/scene/cad";
import { checkScene } from "../src/visual/scene3d/validate";
import { CARD_PROTOCOL_VERSION, parseToCard } from "../src/cards/protocol";
import { validateManifest } from "../src/cards/manifest";
import { checkCardReport } from "../src/cards/state";
import { GENERATIVE_SCENE_MANIFEST } from "../src/cards/apps/generativeScene.manifest";
import { EARTH_MOON_MANIFEST } from "../src/cards/apps/earthMoon.manifest";
import { SceneCompiler, CompileError } from "../src/cards/apps/generativeScene/compiler";
import { PresenceStore } from "../src/core/store";
import { hubCommandSchema } from "../src/host/hub/protocol";
import type { PresentationContent } from "../src/core/presentation";
import { connectAion } from "./helpers";

const REPO = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const fixture = (name: string) => JSON.parse(read(`tests/fixtures/scenes/${name}`)) as Record<string, unknown>;
const valid = (name: string): SceneDocument => { const checked = validateScene(fixture(name)); assert.ok(checked.ok, `${name}: ${checked.ok ? "" : checked.problem}`); return checked.document; };
const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");
const INSTANCE = "cabcdefgh12345678";
const minimal = (extra: Record<string, unknown> = {}) => ({ version: 1, sceneId: "s", title: "S", objects: [{ id: "a", type: "sphere", radius: 1 }], ...extra });

// ── Scene IR ───────────────────────────────────────────────────────────────────────────────────────────────────────
test("v0.5 Scene IR: every demonstration document validates; the result is a clean copy with colours normalized", () => {
  for (const file of readdirSync(join(REPO, "tests/fixtures/scenes")).filter(f => !f.includes(".patch."))) valid(file);
  const input = minimal({ objects: [{ id: "a", type: "sphere", radius: 1, material: { color: "blue" } }] });
  const checked = validateScene(input);
  assert.ok(checked.ok);
  assert.notEqual(checked.document, input);
  assert.deepEqual(checked.document.objects[0].material, { color: "#3b82f6" });
  assert.deepEqual(checked.stats, { nodes: 1, instances: 1, triangles: 3072, particles: 0, animations: 0, bytes: checked.stats.bytes });
});

test("v0.5 Scene IR: unknown fields, geometries and animations, bad references and cycles are refused with a code", () => {
  const problem = (input: unknown) => { const c = validateScene(input); return c.ok ? null : `${c.code}: ${c.problem}`; };
  assert.match(problem(minimal({ script: "alert(1)" }))!, /invalid-scene: scene: unknown field "script"/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "sphere", radius: 1, onClick: "x" }] }))!, /unknown field "onClick"/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "teapot" }] }))!, /^unsupported-geometry/);
  assert.match(problem(minimal({ animations: [{ id: "x", target: "a", type: "explode" }] }))!, /^unsupported-animation/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "sphere", radius: 1, parent: "b" }] }))!, /^invalid-reference/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "group", parent: "b" }, { id: "b", type: "group", parent: "a" }] }))!, /^invalid-reference.*cycle/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "sphere", radius: 1 }, { id: "a", type: "box", size: [1, 1, 1] }] }))!, /used twice/);
  assert.match(problem(minimal({ objects: [{ id: "Bad Id", type: "sphere", radius: 1 }] }))!, /must be an id/);
  assert.match(problem(minimal({ version: 2 }))!, /^unsupported-version/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "sphere", radius: Number.NaN }] }))!, /radius must be a number/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "sphere", radius: 1, material: "nope" }] }))!, /no material "nope"/);
  assert.match(problem(minimal({ animations: [{ id: "o", target: "a", type: "orbit", period: 1, center: "a" }] }))!, /cannot orbit itself/);
  assert.match(problem(minimal({ animations: [{ id: "k", target: "a", type: "keyframes", property: "position", keys: [{ t: 2, value: [0, 0, 0] }, { t: 1, value: [1, 0, 0] }] }] }))!, /time order/);
  assert.match(problem(minimal({ title: "x‮y" }))!, /title must be one line/);
  // Orbit centres must share the target's parent; couplings must end in a spin; flows move point clouds.
  assert.match(problem(minimal({ objects: [{ id: "g", type: "group" }, { id: "a", type: "sphere", radius: 1, parent: "g" }, { id: "b", type: "sphere", radius: 1 }],
    animations: [{ id: "o", target: "a", type: "orbit", period: 1, center: "b" }] }))!, /must share/);
  assert.match(problem(minimal({ animations: [{ id: "c", target: "a", type: "couple", source: "c", ratio: 1 }] }))!, /couplings form a cycle/);
  assert.match(problem(minimal({ animations: [{ id: "o", target: "a", type: "oscillate", property: "scale", amplitude: 1, period: 1 }, { id: "c", target: "a", type: "couple", source: "o", ratio: 1 }] }))!, /must name a spin/);
  assert.match(problem(minimal({ objects: [{ id: "a", type: "sphere", radius: 1 }, { id: "p", type: "line", from: [0, 0, 0], to: [1, 0, 0] }], animations: [{ id: "f", target: "a", type: "flow", path: "p", rate: 1 }] }))!, /flow moves a points object/);
});

test("v0.5 Scene IR: resource limits are enforced, never truncated", () => {
  const many = minimal({ objects: Array.from({ length: SCENE_IR_LIMITS.nodes + 1 }, (_, i) => ({ id: `s${i}`, type: "box", size: [1, 1, 1] })) });
  assert.match((validateScene(many) as { problem: string }).problem, /at most 256 objects/);
  const heavy = minimal({ objects: [{ id: "a", type: "sphere", radius: 1, repeat: { count: 100 } }, { id: "b", type: "sphere", radius: 1, repeat: { count: 100 } }] });
  const checked = validateScene(heavy);
  assert.equal(checked.ok, false);
  assert.equal((checked as { code: string }).code, "resource-limit");
  const cloud = minimal({ objects: [{ id: "c", type: "points", particles: { distribution: "sphere", count: 20_001, radius: 1 } }] });
  assert.match((validateScene(cloud) as { problem: string }).problem, /count must be a number from 1 to 20000/);
  const big = minimal({ objects: [{ id: "m", type: "mesh", positions: Array.from({ length: 9 * 3000 }, () => 0) }] });
  assert.equal((validateScene(big) as { code: string }).code, "resource-limit");
});

// ── Patches and history ────────────────────────────────────────────────────────────────────────────────────────
test("v0.5 patches: targeted, transactional, and never mutate the scene they start from", () => {
  const doc = valid("solar-system.json");
  const before = JSON.stringify(doc);
  const ok = applyPatch(doc, [
    { op: "transform", id: "earth", scaleBy: 3 },
    { op: "update-animation", id: "orbit-mars", set: { paused: true } },
    { op: "material", id: "orbit", set: { color: "blue" } },
  ]);
  assert.ok(ok.ok);
  assert.equal(ok.document.objects.find(n => n.id === "earth")!.scale, 3);
  assert.equal(ok.document.animations!.find(a => a.id === "orbit-mars")!.paused, true);
  assert.equal(ok.document.materials!.find(m => m.id === "orbit")!.color, "#3b82f6");
  assert.ok(ok.changed.includes("earth") && ok.changed.includes("orbit-neptune"));
  assert.equal(JSON.stringify(doc), before, "the original document is untouched");
  // One bad operation: nothing at all changes, and it says which.
  const bad = applyPatch(doc, [{ op: "transform", id: "earth", scaleBy: 3 }, { op: "update", id: "pluto", set: { radius: 1 } }]);
  assert.equal(bad.ok, false);
  assert.match((bad as { problem: string }).problem, /^operation 2: no object "pluto"/);
  // The result must be a valid scene as a whole.
  const invalid = applyPatch(doc, [{ op: "update", id: "earth", set: { radius: -1 } }]);
  assert.match((invalid as { problem: string }).problem, /after the patch, .*radius must be a number/);
  assert.match((applyPatch(doc, [{ op: "update", id: "earth", set: { type: "box" } }]) as { problem: string }).problem, /type cannot change/);
  assert.match((applyPatch(doc, []) as { problem: string }).problem, /1 or more/);
  assert.match((applyPatch(doc, [{ op: "eval", code: "x" }]) as { problem: string }).problem, /op must be one of/);
});

test("v0.5 patches: \"$selected\", shared materials copied on write, and removal takes dependants with it", () => {
  const doc = valid("solar-system.json");
  const moved = applyPatch(doc, [{ op: "transform", id: "$selected", translate: [-2, 0, 0], scaleBy: 2 }], { selected: "sun" });
  assert.ok(moved.ok);
  assert.deepEqual(moved.document.objects.find(n => n.id === "sun")!.position, [-2, 0, 0]);
  assert.equal(moved.document.objects.find(n => n.id === "sun")!.scale, 2);
  assert.equal((applyPatch(doc, [{ op: "transform", id: "$selected", scaleBy: 2 }]) as { code: string }).code, "no-selection");
  // Recolouring one orbit that shares a material gives it its own; the others keep theirs.
  const one = applyPatch(doc, [{ op: "update", id: "orbit-earth", set: { material: { color: "red" } } }]);
  assert.ok(one.ok);
  assert.equal((one.document.objects.find(n => n.id === "orbit-earth")!.material as { color: string }).color, "#ff3b30");
  assert.equal((one.document.objects.find(n => n.id === "orbit-earth")!.material as { opacity: number }).opacity, 0.45, "the rest of the shared material is kept");
  assert.equal(one.document.objects.find(n => n.id === "orbit-mars")!.material, "orbit");
  // Removing Saturn removes its rings (a child) and the animations that need it.
  const removed = applyPatch(doc, [{ op: "remove", id: "saturn" }]);
  assert.ok(removed.ok);
  assert.deepEqual(removed.removed.sort(), ["saturn", "saturn-rings"]);
  assert.equal(removed.document.animations!.some(a => a.target === "saturn"), false);
  // Adding an orbit around a moving body: the Moon around Earth.
  const moon = applyPatch(doc, [{ op: "add", object: { id: "moon", type: "sphere", radius: 0.1, position: [6.2, 0, 0] } },
    { op: "add-animation", animation: { id: "orbit-moon", target: "moon", type: "orbit", center: "earth", period: 2 } }]);
  assert.ok(moon.ok, moon.ok ? "" : moon.problem);
});

test("v0.5 history: revisions only increase; undo, redo and reset are revisions too; stale changes are refused", () => {
  const doc = valid("solar-system.json");
  let state = startHistory(doc, 0);
  const bigger = applyPatch(doc, [{ op: "transform", id: "earth", scaleBy: 3 }]);
  assert.ok(bigger.ok);
  let step = commit(state, bigger.document, "earth larger", 1, 1);
  assert.ok(step.ok); state = step.state;
  assert.equal(state.revision, 2);
  const stale = commit(state, doc, "late", 2, 1);
  assert.equal(stale.ok, false);
  assert.equal((stale as { code: string }).code, "stale-revision");
  step = undo(state, 3); assert.ok(step.ok); state = step.state;
  assert.equal(state.revision, 3);
  assert.equal(state.document.objects.find(n => n.id === "earth")!.scale, undefined);
  step = redo(state, 4); assert.ok(step.ok); state = step.state;
  assert.equal(state.revision, 4);
  assert.equal(state.document.objects.find(n => n.id === "earth")!.scale, 3);
  assert.equal((redo(state, 5) as { code: string }).code, "nothing-to-redo");
  step = resetHistory(state, 5); assert.ok(step.ok); state = step.state;
  assert.equal(state.revision, 5);
  assert.equal(state.document, doc);
  assert.deepEqual(state.log.map(e => e.revision), [1, 2, 3, 4, 5]);
  // Bounded.
  for (let i = 0; i < 60; i++) { const s = commit(state, doc, `c${i}`, 10 + i); assert.ok(s.ok); state = s.state; }
  assert.equal(state.undo.length, HISTORY_LIMITS.undo);
  assert.equal(state.log.length, HISTORY_LIMITS.log);
});

// ── Animation ──────────────────────────────────────────────────────────────────────────────────────────────────
test("v0.5 animation: frame-rate independent, per-animation stop, seek, and a moving orbit centre carries its satellite", () => {
  const base = valid("solar-system.json");
  const patched = applyPatch(base, [{ op: "add", object: { id: "moon", type: "sphere", radius: 0.1, position: [6.2, 0, 0] } },
    { op: "add-animation", animation: { id: "orbit-moon", target: "moon", type: "orbit", center: "earth", period: 2 } }]);
  assert.ok(patched.ok);
  const doc = patched.document, animations = doc.animations!;
  const run = (steps: number) => {
    const timeline = new SceneTimeline();
    timeline.sync(animations);
    for (let i = 0; i < steps; i++) timeline.advance(3 / steps, animations);
    return new PoseEvaluator(doc).evaluate(id => timeline.clock(id));
  };
  const at144 = run(432), at7 = run(7);
  for (const id of ["earth", "mars", "moon"]) {
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(at144.get(id)!.position[i] - at7.get(id)!.position[i]) < 1e-9, `${id} is where it is regardless of frame rate`);
  }
  const earth = at144.get("earth")!.position, moon = at144.get("moon")!.position;
  assert.ok(Math.abs(Math.hypot(moon[0] - earth[0], moon[2] - earth[2]) - 0.6) < 1e-9, "the Moon stays 0.6 from a moving Earth");
  // Stopping Mars: its clock holds while the others run.
  const stopped = applyPatch(doc, [{ op: "update-animation", id: "orbit-mars", set: { paused: true } }]);
  assert.ok(stopped.ok);
  const timeline = new SceneTimeline();
  timeline.sync(stopped.document.animations!);
  timeline.advance(1, stopped.document.animations!);
  assert.equal(timeline.clock("orbit-mars"), 0);
  assert.equal(timeline.clock("orbit-earth"), 1);
  timeline.seek(5, stopped.document.animations!);
  assert.equal(timeline.clock("orbit-earth"), 5);
  assert.equal(timeline.clock("orbit-mars"), 0, "a stopped motion stays where it is through a seek");
  timeline.playing = false;
  timeline.advance(1, stopped.document.animations!);
  assert.equal(timeline.time, 5, "paused: time stands still");
});

test("v0.5 animation: gears couple, paths follow the drawn path, phases keep their relationship", () => {
  const gears = valid("gear-train.json");
  const evaluator = new PoseEvaluator(gears);
  const drive = gears.animations!.find(a => a.id === "drive")!, mesh = gears.animations!.find(a => a.id === "mesh")!;
  const clock = () => 2;
  evaluator.evaluate(clock);
  assert.equal(evaluator.spinAngle(drive), 90);
  assert.equal(evaluator.spinAngle(mesh), -180, "the driven gear turns twice as fast the other way");
  // The bead is always on the drawn curve.
  const track = gears.objects.find(n => n.id === "track")!;
  const drawn = samplePath(pathPoints(track)!.points, true).points;
  for (const t of [0, 0.7, 2.3, 5.9]) {
    const bead = new PoseEvaluator(gears).evaluate(() => t).get("bead")!.position;
    const nearest = Math.min(...drawn.map((p, i) => i ? segmentDistance(bead, drawn[i - 1], p) : Infinity));
    assert.ok(nearest < 1e-6, `at ${t} s the bead is on the curve (${nearest})`);
  }
  // Three-phase: the coils' brightness peaks 120° apart (a third of a period).
  const field = valid("three-phase-field.json");
  const brightness = (coil: string, t: number) => new PoseEvaluator(field).evaluate(() => t).get(coil)!.emissiveIntensity!;
  assert.ok(Math.abs(brightness("coil-a", 0) - brightness("coil-b", 2 / 3)) < 1e-9);
  assert.ok(Math.abs(brightness("coil-b", 2 / 3) - brightness("coil-c", 4 / 3)) < 1e-9);
  // Rotations follow Three.js's Euler XYZ convention.
  const v = rotate([1, 0, 0], quatFromEuler([0, 90, 0]));
  assert.ok(Math.abs(v[2] + 1) < 1e-12);
});

function segmentDistance(p: number[], a: number[], b: number[]) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = len ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

// ── Capabilities and Router 2.0 ────────────────────────────────────────────────────────────────────────────────
test("v0.5 capabilities: supported, partially supported (illustrative), unsupported (needs a solver) — never silently substituted", () => {
  assert.equal(checkCapabilities(valid("solar-system.json")).status, "SUPPORTED");
  const field = checkCapabilities(valid("three-phase-field.json"));
  assert.equal(field.status, "PARTIALLY_SUPPORTED");
  assert.match(field.approximated[0].note, /numerical field solver.*illustrative/);
  assert.deepEqual(field.disclosures, ["Illustrative visualization: not computed by a numerical solver."]);
  const flux = checkCapabilities(valid("transformer-flux-measured.json"));
  assert.equal(flux.status, "UNSUPPORTED");
  assert.match(flux.unsupported[0].note, /accurate magnetic flux density needs a numerical field solver/);
  const asset = checkCapabilities(validateScene(minimal({ requirements: ["asset:model-url"] })).ok ? (validateScene(minimal({ requirements: ["asset:model-url"] })) as { document: SceneDocument }).document : valid("solar-system.json"));
  assert.equal(asset.status, "PARTIALLY_SUPPORTED");
  assert.equal(checkCapabilities(valid("solar-system.json"), { ...DEFAULT_RUNTIME, card: false }).status, "UNSUPPORTED");
  assert.ok(requirementsOf(valid("buck-converter.json")).includes("animation:flow"));
  // A backend that exists makes the same request supported (a future solver registers its compute capability).
  assert.equal(checkCapabilities(valid("transformer-flux-measured.json"), { ...DEFAULT_RUNTIME, compute: ["magnetic-flux-density"] }).status, "SUPPORTED");
});

test("v0.5 Router 2.0: deterministic BODY / CARD / HYBRID with reasons, preferences honoured when possible, transitions described", () => {
  const route = (name: string, extra: Partial<Parameters<typeof routeScene>[0]> = {}) => routeScene({ document: valid(name), ...extra });
  assert.equal(route("passage-of-time.json").mode, "body");
  assert.equal(route("solar-system.json").mode, "hybrid");
  assert.equal(route("deep-time-timeline.json").mode, "hybrid");
  assert.equal(route("buck-converter.json").mode, "card", "an engineering scene is never particles alone");
  assert.equal(route("gear-train.json").mode, "card");
  assert.deepEqual(route("solar-system.json"), route("solar-system.json"), "the same scene routes the same way");
  const explained = route("buck-converter.json");
  assert.match(explained.reason, /engineering/);
  assert.ok(explained.requested.includes("geometry:helix") && explained.available.includes("animation:flow"));
  // Preferences.
  const body = route("solar-system.json", { preference: "body" });
  assert.equal(body.mode, "body");
  assert.ok(body.limitations.some(l => /text and labels are not formed/.test(l)));
  assert.equal(route("passage-of-time.json", { preference: "card" }).mode, "card");
  const onlyText = validateScene(minimal({ objects: [{ id: "t", type: "text", text: "Hello" }] }));
  assert.ok(onlyText.ok);
  const cannot = routeScene({ document: onlyText.document, preference: "body" });
  assert.equal(cannot.mode, "card");
  assert.match(cannot.reason, /cannot form this scene/);
  assert.equal(routeScene({ document: valid("solar-system.json"), runtime: { ...DEFAULT_RUNTIME, card: false } }).mode, "body");
  // Transitions.
  assert.match(route("deep-time-timeline.json", { current: "body" }).transition.description, /body keeps a particle form/);
  assert.match(route("buck-converter.json", { current: "body" }).transition.description, /no particle-to-mesh morph/);
  assert.match(route("buck-converter.json", { current: "card" }).transition.description, /updates in place/);
});

test("v0.5 particle adapter: a valid body scene within the body's limits, with what it leaves out said", () => {
  for (const name of ["solar-system.json", "passage-of-time.json", "deep-time-timeline.json", "three-phase-field.json", "buck-converter.json", "gear-train.json"]) {
    const adapted = toParticleScene(valid(name));
    assert.ok(adapted.scene, name);
    assert.ok(checkScene(adapted.scene).ok, name);
    assert.ok(adapted.scene.objects.length <= 24 && JSON.stringify(adapted.scene).length <= 16_384, name);
    assert.ok(adapted.fit > 0 && adapted.fit <= 1, name);
  }
  const solar = toParticleScene(valid("solar-system.json"));
  assert.equal(solar.fit, 1);
  assert.ok(solar.limitations.some(l => /motion is not formed/.test(l)));
  assert.ok(toParticleScene(valid("gear-train.json")).limitations.some(l => /gear teeth/.test(l)));
});

// ── Card 2.0 integration ───────────────────────────────────────────────────────────────────────────────────────
test("v0.5 card: the manifest validates; LOAD_SCENE needs the scene-documents capability and a valid scene", () => {
  assert.ok(validateManifest(GENERATIVE_SCENE_MANIFEST).ok);
  const message = (document: unknown, revision = 1) => ({ v: CARD_PROTOCOL_VERSION, instance: INSTANCE, type: "LOAD_SCENE", id: "r1", payload: { revision, document } });
  const parsed = parseToCard(message(fixture("solar-system.json")), INSTANCE, GENERATIVE_SCENE_MANIFEST);
  assert.ok(parsed.ok);
  assert.match((parseToCard(message(fixture("solar-system.json")), INSTANCE, EARTH_MOON_MANIFEST) as { problem: string }).problem, /needs the scene-documents capability/);
  assert.match((parseToCard(message({ ...fixture("solar-system.json"), objects: [{ id: "x", type: "teapot" }] }), INSTANCE, GENERATIVE_SCENE_MANIFEST) as { problem: string }).problem, /unsupported-geometry/);
  assert.equal(parseToCard(message(fixture("solar-system.json"), 0), INSTANCE, GENERATIVE_SCENE_MANIFEST).ok, false);
  // The card's acknowledgement of a built scene is checked against the scene it was sent.
  const card = { instance: INSTANCE, app: "generative-scene", scene: { revision: 2 } } as never;
  assert.ok(checkCardReport({ window: "windowabc1", instance: INSTANCE, scene: { revision: 2, ok: true } }, card, GENERATIVE_SCENE_MANIFEST).ok);
  assert.equal(checkCardReport({ window: "windowabc1", instance: INSTANCE, scene: { revision: 3, ok: true } }, card, GENERATIVE_SCENE_MANIFEST).ok, false, "a revision that does not exist yet");
  assert.equal(checkCardReport({ window: "windowabc1", instance: INSTANCE, scene: { revision: 1, ok: true } }, card, EARTH_MOON_MANIFEST).ok, false);
});

test("v0.5 compiler: built from the document, edits keep object identity, failures change nothing, everything is released", () => {
  const doc = valid("solar-system.json");
  const compiler = new SceneCompiler({ maxTriangles: 600_000, animatedOpacity: () => false });
  const first = compiler.apply(doc);
  assert.equal(first.created.length, 18);
  const earth = compiler.entries.get("earth")!, holder = earth.holder, geometry = earth.geometry, material = earth.material;
  // A colour change updates the same material; a size change keeps the geometry (it is a transform).
  const recoloured = applyPatch(doc, [{ op: "update", id: "earth", set: { material: { color: "red" } } }, { op: "transform", id: "earth", scaleBy: 3 }]);
  assert.ok(recoloured.ok);
  const second = compiler.apply(recoloured.document);
  assert.deepEqual(second, { created: [], updated: ["earth"], removed: [], rebuilt: [], triangles: second.triangles });
  assert.equal(compiler.entries.get("earth")!.holder, holder);
  assert.equal(compiler.entries.get("earth")!.geometry, geometry);
  assert.equal(compiler.entries.get("earth")!.material, material);
  assert.equal(holder.scale.x, 3);
  // A new radius rebuilds only that geometry, and releases the old one.
  let disposed = 0;
  geometry!.addEventListener("dispose", () => { disposed++; });
  const resized = applyPatch(recoloured.document, [{ op: "update", id: "earth", set: { radius: 0.5 } }]);
  assert.ok(resized.ok);
  assert.deepEqual(compiler.apply(resized.document).rebuilt, ["earth"]);
  assert.equal(disposed, 1);
  // Too heavy for this card: refused, and the built scene is exactly as it was.
  const small = new SceneCompiler({ maxTriangles: 1000, animatedOpacity: () => false });
  assert.throws(() => small.apply(doc), (error: unknown) => error instanceof CompileError && error.code === "resource-limit");
  assert.equal(small.entries.size, 0);
  // Disposal releases every geometry and material.
  let released = 0;
  for (const entry of compiler.entries.values()) { entry.geometry?.addEventListener("dispose", () => { released++; }); entry.material?.addEventListener("dispose", () => { released++; }); }
  const resources = [...compiler.entries.values()].reduce((sum, e) => sum + (e.geometry ? 1 : 0) + (e.material ? 1 : 0), 0);
  compiler.dispose();
  assert.equal(released, resources);
  assert.equal(compiler.entries.size, 0);
});

// ── State in the hub ───────────────────────────────────────────────────────────────────────────────────────────
test("v0.5 store: a generated scene's revisions, patches against the selection, stale and invalid changes leave it intact", () => {
  const store = new PresenceStore({ now: () => 1000, schedule: () => () => {} });
  const content = { kind: "interactive", app: "generative-scene", instance: INSTANCE, title: "Solar", layout: "expanded", config: {}, scene: fixture("solar-system.json") } as unknown as PresentationContent;
  store.present(content, 0, { preference: "card" });
  let card = store.snapshot().card!;
  assert.equal(card.scene!.revision, 1);
  assert.equal((store.snapshot().presentation as { scene?: unknown }).scene, undefined, "the document lives in the card's scene, not twice");
  assert.ok(store.sceneCommand({ request: "q00001", action: "patch", ops: [{ op: "transform", id: "earth", scaleBy: 3 }], base: 1 }).ok);
  card = store.snapshot().card!;
  assert.equal(card.scene!.revision, 2);
  assert.deepEqual({ ok: card.scene!.outcome!.ok, revision: card.scene!.outcome!.revision }, { ok: true, revision: 2 });
  assert.equal(store.sceneCommand({ request: "q00002", action: "patch", ops: [{ op: "transform", id: "earth", scaleBy: 3 }], base: 1 }).ok, false);
  assert.equal(store.snapshot().card!.scene!.outcome!.code, "stale-revision");
  assert.equal(store.snapshot().card!.scene!.revision, 2);
  assert.equal(store.sceneCommand({ request: "q00003", action: "patch", ops: [{ op: "remove", id: "pluto" }] }).ok, false);
  assert.equal(store.snapshot().card!.scene!.outcome!.code, "invalid-reference");
  // "$selected" follows the card's reported selection.
  store.cardReport({ window: "windowabc1", instance: INSTANCE, selection: { objectId: "mars", name: "Mars" } });
  assert.ok(store.sceneCommand({ request: "q00004", action: "patch", ops: [{ op: "transform", id: "$selected", scaleBy: 2 }] }).ok);
  assert.equal(store.snapshot().card!.scene!.document.objects.find(n => n.id === "mars")!.scale, 2);
  assert.ok(store.sceneCommand({ request: "q00005", action: "undo" }).ok);
  assert.equal(store.snapshot().card!.scene!.document.objects.find(n => n.id === "mars")!.scale, undefined);
  assert.equal(store.snapshot().card!.scene!.revision, 4);
  // The card confirms what it built.
  store.cardReport({ window: "windowabc1", instance: INSTANCE, scene: { revision: 4, ok: true } });
  assert.deepEqual({ ...store.snapshot().card!.scene!.rendered, at: 0 }, { revision: 4, ok: true, at: 0 });
  // Showing the same card a new scene is a new revision of the same history.
  store.present({ ...content, scene: fixture("gear-train.json") } as unknown as PresentationContent, 0, { preference: "card" });
  assert.equal(store.snapshot().card!.scene!.revision, 5);
  assert.ok(store.sceneCommand({ request: "q00006", action: "undo" }).ok);
  assert.equal(store.snapshot().card!.scene!.document.sceneId, "solar-system");
  // Closing ends the card and its history.
  store.clearPresentation();
  assert.equal(store.sceneCommand({ request: "q00007", action: "undo" }).ok, false);
});

test("v0.5 hub protocol: scene commands and scene presentations are validated wherever they come from", () => {
  const ok = hubCommandSchema.safeParse({ type: "scene", action: "patch", request: "qabc123", ops: [{ op: "transform", id: "earth", scaleBy: 2 }], base: 3 });
  assert.ok(ok.success);
  assert.equal(hubCommandSchema.safeParse({ type: "scene", action: "patch", request: "qabc123" }).success, false, "a patch needs operations");
  assert.equal(hubCommandSchema.safeParse({ type: "scene", action: "set", request: "qabc123", document: { version: 1 } }).success, false);
  const present = (content: Record<string, unknown>) => hubCommandSchema.safeParse({ type: "present", content: { kind: "interactive", instance: INSTANCE, title: "T", layout: "expanded", config: {}, ...content } }).success;
  assert.ok(present({ app: "generative-scene", scene: fixture("solar-system.json") }));
  assert.equal(present({ app: "earth-moon", scene: fixture("solar-system.json") }), false, "only a scene-documents application takes a scene");
  const document = valid("solar-system.json");
  assert.ok(present({ app: "generative-scene", scene: document, bodyScene: toParticleScene(document).scene }));
  assert.equal(present({ app: "generative-scene", scene: document, bodyScene: EARTH_MOON_MANIFEST.hybrid }), false, "the body form is the scene's own");
});

// ── MCP ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("v0.5 MCP: generate, route, patch, undo and inspect through the existing card tools; unsupported requests are refused", async () => {
  const aion = await connectAion();
  try {
    const missing = await aion.call("show_interactive_card", { app: "generative-scene" });
    assert.match(text(missing), /scene-required/);
    const invalid = await aion.call("show_interactive_card", { app: "generative-scene", scene: { ...fixture("solar-system.json"), objects: [{ id: "x", type: "teapot" }] } });
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /unsupported-geometry: .*Nothing was shown/);
    const refused = await aion.call("show_interactive_card", { app: "generative-scene", scene: fixture("transformer-flux-measured.json") });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /unsupported: accurate magnetic flux density needs a numerical field solver.*nothing was substituted/);
    assert.match(text(await aion.call("inspect_interactive_card")), /No interactive card is open/);

    const body = await aion.call("show_interactive_card", { app: "generative-scene", scene: fixture("passage-of-time.json") });
    assert.match(text(body), /Aion's body forms "The passage of time" \(abstract and look-only/);
    assert.equal((body.structuredContent as { presentation: { kind: string; route: string } }).presentation.kind, "scene");

    const shown = await aion.call("show_interactive_card", { app: "generative-scene", scene: fixture("solar-system.json") });
    assert.match(text(shown), /Opened the generated scene "The Solar System" as a card while the body forms it\. Aion is not open/);
    assert.match(text(shown), /Tell me|Tell the user: Not to scale/);
    const structured = shown.structuredContent as { route: { mode: string; capability: string; transition: string }; card: { scene: { revision: number; objects: unknown[] }; commands: string[] } };
    assert.equal(structured.route.mode, "hybrid");
    assert.equal(structured.route.capability, "SUPPORTED");
    assert.match(structured.route.transition, /body keeps a particle form/);
    assert.equal(structured.card.scene.revision, 1);
    assert.ok(structured.card.commands.includes("patch (patch, revision)"));

    const patched = await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "earth", scaleBy: 3 }], revision: 1 });
    assert.match(text(patched), /Accepted as revision 2: transform earth \(earth\)\. Aion is not open/);
    const stale = await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "earth", scaleBy: 3 }], revision: 1 });
    assert.equal(stale.isError, true);
    assert.match(text(stale), /stale-revision: .*Nothing changed; the scene is still at revision 2/);
    assert.match(text(await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "$selected", scaleBy: 2 }] })), /no-selection/);
    assert.match(text(await aion.call("control_interactive_card", { action: "undo" })), /Accepted as revision 3: undo: transform earth/);
    assert.match(text(await aion.call("control_interactive_card", { action: "undo" })), /nothing-to-undo/);
    assert.match(text(await aion.call("control_interactive_card", { action: "redo" })), /revision 4/);
    assert.match(text(await aion.call("control_interactive_card", { action: "revert" })), /revision 5: reset to the original scene/);
    assert.match(text(await aion.call("control_interactive_card", { action: "set-speed", value: 2 })), /no window is showing the card/);
    assert.match(text(await aion.call("control_interactive_card", { action: "undo", patch: [{ op: "remove", id: "earth" }] })), /takes no patch/);
    const full = text(await aion.call("inspect_interactive_card", { full: true }));
    assert.match(full, /"history":\[/);
    assert.match(full, /Scene document \(revision 5\):\n\{"version":1,"sceneId":"solar-system"/);
    // A different application never takes a patch.
    await aion.call("show_interactive_card", { app: "earth-moon" });
    assert.match(text(await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "remove", id: "earth" }] })), /invalid-command|patch and revision go with/);
  } finally { await aion.close(); }
});

test("v0.5 summary and CAD boundary: Codex gets ids, revisions and history; a backend model becomes a scene with its component ids", () => {
  const summary = summarizeScene(valid("solar-system.json"), 3, { log: [{ revision: 3, label: "x", at: 0 }], undo: 2, redo: 0 });
  assert.equal(summary.objects.length, 18);
  assert.equal(summary.can_undo, true);
  assert.equal(summary.animations.find(a => a.id === "orbit-earth")?.target, "earth");
  const scene = sceneFromModel({ backend: "freecad", modelId: "EI96", revision: 7, parameters: [], units: "mm", warnings: [],
    components: [{ id: "core", name: "Core", metadata: { Material: "M19" } }, { id: "winding-primary", name: "Primary", metadata: {} }] });
  const checked = validateScene(scene);
  assert.ok(checked.ok);
  assert.deepEqual(checked.document.objects.map(n => n.id), ["core", "winding-primary"]);
  assert.match(checked.document.disclosure![0], /mesh view of a parametric model/);
});

test("v0.5 security: the scene runtime never executes scene data; text is drawn as text", () => {
  const sources = ["src/cards/apps/generativeScene/app.ts", "src/cards/apps/generativeScene/compiler.ts", "src/cards/apps/generativeScene/geometry.ts",
    "src/scene/validate.ts", "src/scene/patch.ts", "src/scene/animation.ts", "src/scene/router.ts", "src/scene/particleAdapter.ts"];
  for (const file of sources) {
    const source = read(file);
    for (const pattern of [/\beval\(/, /new Function\(/, /\.innerHTML\b/, /insertAdjacentHTML/, /document\.write/, /ShaderMaterial/, /fetch\(/, /XMLHttpRequest/, /import\(/]) {
      assert.doesNotMatch(source, pattern, `${file}: ${pattern}`);
    }
  }
  // Labels and annotations: textContent or a canvas, nothing parsed.
  const app = read("src/cards/apps/generativeScene/app.ts");
  assert.match(app, /label\.textContent = n\.label!/);
  const hostile = validateScene(minimal({ title: "<img src=x onerror=alert(1)>", objects: [{ id: "a", type: "text", text: "<script>alert(1)</script>" }] }));
  assert.ok(hostile.ok, "markup is only ever text");
  assert.equal(validateScene(minimal({ objects: [{ id: "a", type: "sphere", radius: 1, material: { shader: "void main(){}" } }] })).ok, false);
  assert.equal(validateScene({ ...minimal(), toJSON: () => ({}) }).ok, false, "only plain data");
});
