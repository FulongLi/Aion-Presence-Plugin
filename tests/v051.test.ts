import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SceneDocument } from "../src/scene/ir";
import { MATERIAL_PRESET_VALUES } from "../src/scene/ir";
import { prepareSceneInput, SCENE_ISSUE_LIMIT, validateScene } from "../src/scene/validate";
import { applyPatch } from "../src/scene/patch";
import { closest, distance } from "../src/scene/repair";
import { materialOf, PoseEvaluator } from "../src/scene/animation";
import { checkCapabilities } from "../src/scene/capabilities";
import { resolveStyle, SHADOW_TRIANGLE_BUDGET, STYLE_SPECS } from "../src/scene/style";
import { toParticleScene } from "../src/scene/particleAdapter";
import { routeScene } from "../src/scene/router";
import { CARD_PROTOCOL_VERSION, editProblem, parseFromCard, parseToCard } from "../src/cards/protocol";
import { checkCardReport } from "../src/cards/state";
import { validateManifest } from "../src/cards/manifest";
import { GENERATIVE_SCENE_MANIFEST } from "../src/cards/apps/generativeScene.manifest";
import type { CardAppManifest } from "../src/cards/manifest";
import { EARTH_MOON_MANIFEST } from "../src/cards/apps/earthMoon.manifest";
import { PresenceStore } from "../src/core/store";
import type { PresentationContent } from "../src/core/presentation";
import { connectAion } from "./helpers";

const REPO = join(import.meta.dirname, "..");
const fixture = (name: string) => JSON.parse(readFileSync(join(REPO, "tests/fixtures/scenes", name), "utf8")) as Record<string, unknown>;
const valid = (input: unknown): SceneDocument => { const checked = validateScene(input); assert.ok(checked.ok, checked.ok ? "" : checked.problem); return checked.document; };
const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");
const INSTANCE = "cabcdefgh12345678";
const scene = (extra: Record<string, unknown> = {}) => ({ version: 1, sceneId: "s", title: "S", objects: [{ id: "a", type: "sphere", radius: 1 }], ...extra });

// ── Reliability: every problem at once, each with a hint ───────────────────────────────────────────────────────────
test("v0.5.1 validation: independent problems are reported together, each with how to fix it", () => {
  const checked = validateScene({
    version: 1, sceneId: "gears", title: "Gears",
    objects: [
      { id: "Gear-A", type: "gear", radius: 1, teeth: 20, thickness: 0.2, color: "silver" },
      { id: "gear-b", type: "cog", radius: 0.5 },
      { id: "axle", type: "cylinder", radius: 0.1, parent: "frame" },
    ],
    animations: [{ id: "spin-b", target: "gear-b", type: "rotate", speed: 30 }],
  });
  assert.equal(checked.ok, false);
  if (checked.ok) return;
  const issues = checked.issues;
  assert.equal(checked.problem, issues[0].problem, "problem is the first issue (unchanged contract)");
  const find = (pattern: RegExp) => issues.find(issue => pattern.test(issue.problem));
  assert.match(find(/"Gear-A"\.id must be an id/)!.hint!, /"gear-a"/, "an uppercase id: its lowercase form");
  assert.match(find(/unknown field "color"/)!.hint!, /material: \{ "color"/, "colour belongs in the material");
  assert.equal(find(/"cog" is not a geometry/)!.code, "unsupported-geometry");
  assert.match(find(/"cog" is not a geometry/)!.hint!, /use gear/);
  assert.match(find(/a cylinder needs height/)!.hint!, /"height": 2/, "a missing field: an example");
  assert.match(find(/"axle"\.parent: no object "frame"/)!.hint!, /a parent is usually a group/, "a failed object's missing parent is found in the same round");
  assert.match(find(/"rotate" is not an animation/)!.hint!, /use spin/);
  assert.ok(issues.length >= 6 && issues.length <= SCENE_ISSUE_LIMIT);
  // Bounded: a document with many broken objects reports at most the limit.
  const many = validateScene(scene({ objects: Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, type: "teapot" })) }));
  assert.ok(!many.ok && many.issues.length === SCENE_ISSUE_LIMIT);
  // References: the nearest existing ids.
  const ref = validateScene(scene({ objects: [{ id: "earth", type: "sphere", radius: 1 }], animations: [{ id: "o", target: "eart", type: "spin", speed: 10 }] }));
  assert.ok(!ref.ok && ref.code === "invalid-reference" && /did you mean "earth"/.test(ref.issues[0].hint!));
  assert.ok(distance("colour", "color") === 1 && closest("raduis", ["radius", "height"])[0] === "radius");
});

test("v0.5.1 validation: what is filled in is said, nothing else is changed; probable mistakes are warned about", () => {
  const prepared = prepareSceneInput({ title: "Kinetic Sculpture", objects: [{ id: "core", type: "sphere", radius: 1 }] });
  assert.deepEqual(prepared.notes, ['"version" was missing: read as 1', '"sceneId" was missing: "kinetic-sculpture", from the title']);
  assert.ok(validateScene(prepared.input).ok);
  assert.deepEqual(prepareSceneInput(scene()).notes, [], "a complete document is passed through untouched");
  assert.equal(prepareSceneInput("nope").input, "nope");
  const checked = validateScene(scene({
    objects: [{ id: "floor", type: "plane", width: 10, depth: 10, rotation: [-90, 0, 0] }, { id: "bar", type: "box", size: [1, 1, 1], rotation: [1.5708, 0, 0] }],
    animations: [{ id: "slow", target: "bar", type: "spin", speed: 0.5 }],
  }));
  assert.ok(checked.ok);
  const warnings = checked.ok ? checked.warnings ?? [] : [];
  assert.ok(warnings.some(w => /"bar"\.rotation .* looks like radians/.test(w)));
  assert.ok(warnings.some(w => /"floor" is a plane, already flat in x–z/.test(w)));
  assert.ok(warnings.some(w => /degrees per second/.test(w)));
  assert.equal(validateScene(fixture("solar-system.json")).ok && (validateScene(fixture("solar-system.json")) as { warnings?: string[] }).warnings, undefined, "a good scene has no warnings");
});

test("v0.5.1 patches: refused operations say what to use instead, and which ids exist", () => {
  const doc = valid(fixture("gear-train.json"));
  const alias = applyPatch(doc, [{ op: "move", id: "gear-a" }]);
  assert.ok(!alias.ok && /op must be one of/.test(alias.problem) && /use transform/.test(alias.issues[0].hint!));
  const missing = applyPatch(doc, [{ op: "transform", id: "drivr", scaleBy: 2 }]);
  assert.ok(!missing.ok && missing.code === "invalid-reference" && /did you mean "driver"/.test(missing.issues[0].hint!));
  const unknown = applyPatch(doc, [{ op: "transform", id: "gear-z", scaleBy: 2 }]);
  assert.ok(!unknown.ok && /existing: "driver", "driven"/.test(unknown.issues[0].hint!), "nothing close: the ids that exist");
  const animationId = applyPatch(doc, [{ op: "update-animation", id: doc.objects[1].id, set: { paused: true } }]);
  assert.ok(!animationId.ok && /is an object: its animations are/.test(animationId.issues[0].hint!), "an object id where an animation id belongs");
  const wrongField = applyPatch(doc, [{ op: "transform", id: doc.objects[1].id, scaleby: 2 }]);
  assert.ok(!wrongField.ok && /did you mean "scaleBy"/.test(wrongField.issues[0].hint!));
  const after = applyPatch(doc, [{ op: "add", object: { id: "ball", type: "sphere" } }]);
  assert.ok(!after.ok && /^after the patch/.test(after.issues[0].problem) && /"radius": 1/.test(after.issues[0].hint!));
});

// ── Materials, styles, motion ──────────────────────────────────────────────────────────────────────────────────────
test("v0.5.1 materials: presets give plausible defaults; the material's own fields win", () => {
  const doc = valid(scene({
    materials: [{ id: "brushed", preset: "aluminum" }],
    objects: [{ id: "a", type: "box", size: [1, 1, 1], material: { preset: "copper", roughness: 0.6 } }, { id: "b", type: "box", size: [1, 1, 1], material: "brushed" }, { id: "c", type: "box", size: [1, 1, 1], material: { preset: "glass" } }],
  }));
  assert.deepEqual(materialOf(doc, doc.objects[0]), { ...MATERIAL_PRESET_VALUES.copper, preset: "copper", roughness: 0.6 });
  assert.equal(materialOf(doc, doc.objects[1]).preset, "aluminium", "American spelling accepted, normalized");
  assert.ok(checkCapabilities(doc).requested.includes("feature:transparency"), "a glass preset is transparent");
  assert.ok(checkCapabilities(doc).requested.includes("feature:material-presets"));
  assert.equal(validateScene(scene({ objects: [{ id: "a", type: "box", size: [1, 1, 1], material: { preset: "unobtainium" } }] })).ok, false);
});

test("v0.5.1 styles: picked from the intent unless named, refined by the scene, shadows bounded", () => {
  const style = (extra: Record<string, unknown>) => resolveStyle(valid(scene(extra)));
  assert.equal(style({ intent: { kind: "engineering" } }).name, "engineering");
  assert.equal(style({ intent: { kind: "abstract" } }).name, "cinematic");
  assert.equal(style({ intent: { kind: "scientific" } }).name, "scientific");
  assert.equal(style({}).name, "presentation");
  assert.equal(style({ intent: { kind: "engineering" }, environment: { style: "minimal" } }).source, "scene");
  const minimal = style({ environment: { style: "minimal" } });
  assert.equal(minimal.tone, "light");
  assert.equal(style({ environment: { style: "minimal", background: "#05070b" } }).tone, "dark", "an explicit background sets the tone");
  const space = style({ intent: { kind: "engineering" }, environment: { stars: true } });
  assert.ok(!space.shadows && !space.ground && space.environment <= 0.15, "space has no studio, ground or key shadow");
  assert.equal(style({ environment: { style: "scientific", shadows: true } }).shadows, true, "asked for, shadows are on");
  assert.equal(style({ environment: { style: "engineering", light: false } }).shadows, false);
  const heavy = style({ environment: { style: "engineering" }, objects: [{ id: "f", type: "parametric", surface: "wave", width: 4, depth: 4, resolution: 256, repeat: { count: 4, offset: [5, 0, 0] } }] });
  assert.ok(!heavy.shadows && /triangles/.test(heavy.shadowNote!), `over ${SHADOW_TRIANGLE_BUDGET} triangles shadows stay off, said`);
  for (const spec of Object.values(STYLE_SPECS)) assert.match(spec.background, /^#[0-9a-f]{6}$/);
  assert.equal(validateScene(scene({ environment: { style: "baroque" } })).ok, false);
});

test("v0.5.1 motion: an oscillating scale with an axis swings that direction only (a surface's amplitude)", () => {
  const doc = valid(scene({
    objects: [{ id: "surface", type: "parametric", surface: "ripple", width: 8, depth: 8 }],
    animations: [{ id: "amp", target: "surface", type: "oscillate", property: "scale", axis: [0, 1, 0], amplitude: 0.5, period: 4 }],
  }));
  const pose = new PoseEvaluator(doc).evaluate(() => 1).get("surface")!;
  assert.deepEqual(pose.scale.map(v => Math.round(v * 1000) / 1000), [1, 1.5, 1]);
  const uniform = valid(scene({ animations: [{ id: "pulse", target: "a", type: "oscillate", property: "scale", amplitude: 0.5, period: 4 }] }));
  assert.deepEqual(new PoseEvaluator(uniform).evaluate(() => 1).get("a")!.scale.map(v => Math.round(v * 1000) / 1000), [1.5, 1.5, 1.5], "without an axis: unchanged (v0.5)");
});

test("v0.5.1 capabilities: shadows and studio lighting are supported now; bloom and refraction are said to be approximated", () => {
  const report = checkCapabilities(valid(scene({ requirements: ["render:shadows", "render:bloom", "render:refraction"] })));
  assert.ok(report.supported.includes("render:shadows"));
  assert.deepEqual(report.approximated.map(a => a.requirement).sort(), ["render:bloom", "render:refraction"]);
  assert.equal(report.status, "PARTIALLY_SUPPORTED");
  assert.ok(!checkCapabilities(valid(scene({ requirements: ["render:shadows"] })), { card: false, body: true, compute: [], physics: [] }).supported.includes("render:shadows"), "no card, no shadows");
});

// ── Direct manipulation: proposed by the card, validated and recorded by the hub ───────────────────────────────────
test("v0.5.1 bridge: EDIT needs the scene capability and a well-formed change; LOAD_SCENE may carry the history", () => {
  assert.equal(validateManifest(GENERATIVE_SCENE_MANIFEST).ok, true);
  const edit = (payload: Record<string, unknown>, manifest: CardAppManifest = GENERATIVE_SCENE_MANIFEST) => parseFromCard({ v: CARD_PROTOCOL_VERSION, instance: INSTANCE, type: "EDIT", payload }, INSTANCE, manifest);
  assert.ok(edit({ request: "uabc123", base: 3, action: "transform", id: "gear-a", position: [1, 0, 0] }).ok);
  assert.ok(edit({ request: "uabc123", base: 3, action: "undo" }).ok);
  assert.equal(edit({ request: "uabc123", base: 3, action: "undo" }, EARTH_MOON_MANIFEST).ok, false, "only a scene-documents application proposes edits");
  for (const bad of [
    { request: "uabc123", base: 3, action: "transform", id: "gear-a" },
    { request: "uabc123", base: 3, action: "transform", id: "Gear A", position: [1, 0, 0] },
    { request: "uabc123", base: 3, action: "transform", id: "a", position: [Infinity, 0, 0] },
    { request: "uabc123", base: 3, action: "remove", id: "a" },
    { request: "qabc123", base: 3, action: "undo" },
    { request: "uabc123", base: 0, action: "undo" },
    { request: "uabc123", base: 3, action: "transform", id: "a", scale: 0, extra: 1 },
  ]) assert.ok(editProblem(bad), JSON.stringify(bad));
  const load = (payload: Record<string, unknown>) => parseToCard({ v: CARD_PROTOCOL_VERSION, instance: INSTANCE, type: "LOAD_SCENE", payload }, INSTANCE, GENERATIVE_SCENE_MANIFEST);
  assert.ok(load({ revision: 2, document: scene(), history: { undo: 1, redo: 0 } }).ok);
  assert.equal(load({ revision: 2, document: scene(), history: { undo: -1, redo: 0 } }).ok, false);
});

test("v0.5.1 store: the user's edit is a validated, labelled, undoable revision; a stale or impossible one changes nothing", () => {
  const store = new PresenceStore({ now: () => 1000, schedule: () => () => {} });
  const content = { kind: "interactive", app: "generative-scene", instance: INSTANCE, title: "Gears", layout: "expanded", config: {}, scene: fixture("gear-train.json") } as unknown as PresentationContent;
  store.present(content, 0, { preference: "card" });
  const id = store.snapshot().card!.scene!.document.objects.find(n => n.type === "gear")!.id;
  const report = (edit: Record<string, unknown>) => {
    const checked = checkCardReport({ window: "windowabc1", instance: INSTANCE, edit }, store.snapshot().card, GENERATIVE_SCENE_MANIFEST);
    if (checked.ok) store.cardReport(checked.report);
    return checked;
  };
  assert.ok(report({ request: "uabc0001", base: 1, action: "transform", id, position: [2, 0, 0] }).ok);
  let scene_ = store.snapshot().card!.scene!;
  assert.equal(scene_.revision, 2);
  assert.deepEqual(scene_.document.objects.find(n => n.id === id)!.position, [2, 0, 0]);
  assert.match(scene_.label, /^moved .* \(by hand\)$/);
  assert.deepEqual({ request: scene_.outcome!.request, ok: scene_.outcome!.ok }, { request: "uabc0001", ok: true });
  // Made from an old revision: refused by the history, nothing changes.
  assert.ok(report({ request: "uabc0002", base: 1, action: "transform", id, position: [5, 0, 0] }).ok, "well-formed, so the hub takes the report");
  scene_ = store.snapshot().card!.scene!;
  assert.equal(scene_.revision, 2);
  assert.deepEqual({ ok: scene_.outcome!.ok, code: scene_.outcome!.code }, { ok: false, code: "stale-revision" });
  // Outside what a scene allows: refused by validation.
  report({ request: "uabc0003", base: 2, action: "transform", id, scale: [1e4, 1e4, 1e4] });
  assert.equal(store.snapshot().card!.scene!.revision, 3, "a large but valid scale is a revision");
  assert.equal(report({ request: "uabc0004", base: 3, action: "transform", id: "no-such-gear", position: [0, 0, 0] }).ok, false, "an object that does not exist is refused at the door");
  assert.equal(report({ request: "uabc0005", base: 99, action: "undo" }).ok, false, "a revision that does not exist");
  // Undo from the card: the same history Codex uses.
  report({ request: "uabc0006", base: 3, action: "undo" });
  scene_ = store.snapshot().card!.scene!;
  assert.equal(scene_.revision, 4);
  assert.deepEqual(scene_.document.objects.find(n => n.id === id)!.position, [2, 0, 0]);
  assert.equal(checkCardReport({ window: "windowabc1", instance: INSTANCE, edit: { request: "uabc0007", base: 1, action: "undo" } }, store.snapshot().card, EARTH_MOON_MANIFEST).ok, false);
});

test("v0.5.1 hybrid: a change to the scene's shape re-forms the body; a colour change does not", () => {
  const store = new PresenceStore({ now: () => 5000, schedule: () => () => {} });
  const document = valid(fixture("solar-system.json"));
  const content = { kind: "interactive", app: "generative-scene", instance: INSTANCE, title: "Solar", layout: "expanded", config: {}, scene: document, bodyScene: toParticleScene(document).scene } as unknown as PresentationContent;
  store.present(content, 0, { preference: "hybrid" });
  const before = store.snapshot().presentation as { bodyScene: unknown; bodyEcho?: number };
  assert.equal(before.bodyEcho, undefined);
  assert.ok(store.sceneCommand({ request: "q00001", action: "patch", ops: [{ op: "update", id: "earth", set: { material: { color: "#ff0000" } } }] }).ok);
  const recoloured = store.snapshot().presentation as { bodyEcho?: number; bodyScene: unknown };
  assert.equal(recoloured.bodyEcho, undefined, "a colour change is not re-formed (only the form's brightness follows it)");
  assert.deepEqual(recoloured.bodyScene, toParticleScene(store.snapshot().card!.scene!.document).scene);
  assert.ok(store.sceneCommand({ request: "q00002", action: "patch", ops: [{ op: "transform", id: "jupiter", scaleBy: 3 }] }).ok);
  const after = store.snapshot().presentation as { bodyScene: unknown; bodyEcho?: number; id: string };
  assert.equal(after.bodyEcho, 5000);
  assert.notDeepEqual(after.bodyScene, before.bodyScene);
  assert.deepEqual(after.bodyScene, toParticleScene(store.snapshot().card!.scene!.document).scene, "the body's form is the new scene's own");
  assert.equal(after.id, (before as unknown as { id: string }).id, "the same presentation: the card is not reopened");
  // A card-only scene has no body form to follow.
  const card = new PresenceStore({ now: () => 5000, schedule: () => () => {} });
  card.present({ ...content, bodyScene: undefined } as unknown as PresentationContent, 0, { preference: "card" });
  card.sceneCommand({ request: "q00003", action: "patch", ops: [{ op: "transform", id: "jupiter", scaleBy: 3 }] });
  assert.equal((card.snapshot().presentation as { bodyEcho?: number }).bodyEcho, undefined);
});

// ── MCP: bounded recovery through the existing tools ───────────────────────────────────────────────────────────────
test("v0.5.1 MCP: a refused scene lists its problems and counts the attempt; the third says stop; then the limit holds", async () => {
  const aion = await connectAion();
  try {
    const broken = { title: "Gears", objects: [{ id: "g", type: "cog", radius: 1 }] };
    const first = await aion.call("show_interactive_card", { app: "generative-scene", scene: broken });
    assert.equal(first.isError, true);
    assert.match(text(first), /unsupported-geometry: 1 problem in the scene\. Nothing was shown or changed\.\n1\. \[unsupported-geometry\] .*"cog".* → use gear/);
    assert.match(text(first), /"version" was missing: read as 1/, "what was filled in is said");
    assert.match(text(first), /Attempt 1 of 3\. Fix exactly this problem/);
    assert.match(text(await aion.call("show_interactive_card", { app: "generative-scene", scene: broken })), /Attempt 2 of 3/);
    assert.match(text(await aion.call("show_interactive_card", { app: "generative-scene", scene: broken })), /Attempt 3 of 3: stop retrying\. Tell the user plainly/);
    const limited = await aion.call("show_interactive_card", { app: "generative-scene", scene: broken });
    assert.equal(limited.isError, true);
    assert.match(text(limited), /^repair-limit: attempt 4; the limit is 3\. Nothing was shown or changed\. Do not call again/);
    // A valid scene is always shown, and starts the count again.
    const fixed = await aion.call("show_interactive_card", { app: "generative-scene", scene: { ...broken, objects: [{ id: "g", type: "gear", radius: 1, teeth: 20, thickness: 0.2 }] } });
    assert.notEqual(fixed.isError, true);
    assert.match(text(fixed), /Check: "version" was missing: read as 1; "sceneId" was missing: "gears", from the title\./);
    assert.match(text(await aion.call("show_interactive_card", { app: "generative-scene", scene: broken })), /Attempt 1 of 3/);
    // Patches: checked against the scene first, with hints, and counted separately.
    const patch = await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "scale", id: "g", by: 2 }] });
    assert.equal(patch.isError, true);
    assert.match(text(patch), /invalid-patch: 1 problem in the patch\.[\s\S]*→ use transform \(scaleBy or scale\)[\s\S]*Attempt 1 of 3/);
    const ok = await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "g", scaleBy: 2 }] });
    assert.notEqual(ok.isError, true);
  } finally { await aion.close(); }
});

// ── Codex's guidance: every example it is shown is a valid scene that does what the text says ──────────────────────
test("v0.5.1 skill: every Scene IR example in the references validates, and the refusal and body examples route as described", () => {
  const blocks = (file: string) => [...readFileSync(join(REPO, "plugins/aion-presence/skills/aion-presence/references", file), "utf8").matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]) as Record<string, unknown>);
  const documents = [...blocks("scene-ir.md").filter(b => b.version === 1), ...blocks("scene-examples.md")];
  assert.ok(documents.length >= 6);
  for (const doc of documents) {
    const checked = validateScene(doc);
    assert.ok(checked.ok, `${String(doc.sceneId)}: ${checked.ok ? "" : JSON.stringify(checked.issues)}`);
    assert.equal(checked.ok && checked.warnings, undefined, `${String(doc.sceneId)} has no warnings`);
  }
  const byId = new Map(documents.map(d => [d.sceneId, valid(d)]));
  assert.equal(checkCapabilities(byId.get("core-flux")!).status, "UNSUPPORTED");
  assert.equal(checkCapabilities({ ...byId.get("core-flux")!, intent: { kind: "engineering", fidelity: "illustrative" } }).status, "PARTIALLY_SUPPORTED");
  assert.equal(routeScene({ document: byId.get("growth")! }).mode, "body");
  assert.equal(routeScene({ document: byId.get("wind-turbine")! }).mode, "card");
  // The turbine's blades fan out around the hub (each arm turned 120° more), not around their own centres.
  const turbine = byId.get("wind-turbine")!;
  assert.deepEqual(["arm-1", "arm-2", "arm-3"].map(id => turbine.objects.find(n => n.id === id)!.rotation?.[2] ?? 0), [0, 120, 240]);
});

test("v0.5.1 router: an abstract, symbolic, look-only scene with a few words stays with the body (the words are said to be left out)", () => {
  const time = (fidelity: string, interaction = "view") => valid(scene({
    intent: { kind: "abstract", fidelity, interaction },
    objects: [
      { id: "path", type: "curve", points: [[-4, 0, 0], [0, 1, 0], [4, 0, 0]] }, { id: "now", type: "sphere", radius: 0.3, label: "Now" },
      { id: "past", type: "text", text: "past", position: [-4, 1, 0] }, ...Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, type: "sphere", radius: 0.1, position: [i - 4, 0, 0] })),
    ],
    animations: [{ id: "travel", target: "now", type: "path", path: "path", duration: 8, repeat: "loop" }],
  }));
  const symbolic = routeScene({ document: time("symbolic") });
  assert.equal(symbolic.mode, "body");
  assert.ok(symbolic.limitations.some(l => /text and labels are not formed/.test(l)), "the body says it leaves the words out");
  assert.equal(routeScene({ document: time("illustrative") }).mode, "card", "illustrative text still needs exact rendering");
  assert.equal(routeScene({ document: time("symbolic", "inspect") }).mode, "card", "something to inspect still needs a card");
});

// ── Governance: documentation, versions, license packaging ─────────────────────────────────────────────────────────
test("v0.5.1 governance: docs link to files that exist; README stays short; versions agree; the license travels with the plugin", () => {
  const read = (path: string) => readFileSync(join(REPO, path), "utf8");
  const markdown = ["README.md", "CHANGELOG.md", "CLAUDE.md", "INSTALL.md", ...readdirSync(join(REPO, "docs")).filter(f => f.endsWith(".md")).map(f => `docs/${f}`),
    ...["SKILL.md", "references/scene-ir.md", "references/scene-examples.md"].map(f => `plugins/aion-presence/skills/aion-presence/${f}`)];
  for (const file of markdown) {
    for (const [, link] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      assert.ok(existsSync(join(REPO, dirname(file), link.split("#")[0])), `${file} links to ${link}, which does not exist`);
    }
  }
  const readme = read("README.md");
  assert.ok(readme.split("\n").length <= 160, `README is ${readme.split("\n").length} lines`);
  assert.match(readme, /## License[\s\S]*personal use[\s\S]*separate written license[\s\S]*not an open-source license/i);
  assert.match(readme, /consider giving it a ⭐[\s\S]*Entirely\s+optional/, "the star invitation is voluntary");
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version: string }> };
  const plugin = JSON.parse(read("plugins/aion-presence/plugin.json")) as { version: string; license: string };
  assert.deepEqual([lock.version, lock.packages[""].version, plugin.version], [version, version, version]);
  assert.match(read("CHANGELOG.md"), new RegExp(`## \\[${version.replace(/\./g, "\\.")}\\]`), "the CHANGELOG has the current version");
  const license = read("LICENSE");
  assert.equal(read("plugins/aion-presence/LICENSE"), license, "the installed plugin carries the same LICENSE");
  assert.match(license, /DRAFT FOR LEGAL REVIEW/);
  assert.match(license, /NOT an open-source license/);
  assert.doesNotMatch(license, /\b(MIT License|Apache License|GNU General Public License)\b/, "no standard license is substituted");
  assert.equal(plugin.license, "SEE LICENSE IN LICENSE");
  assert.ok(existsSync(join(REPO, "plugins/aion-presence/THIRD-PARTY-NOTICES.md")) && existsSync(join(REPO, "plugins/aion-presence/packs/chinese-writing/NOTICE.md")));
});
