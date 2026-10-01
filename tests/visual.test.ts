import assert from "node:assert/strict";
import { test } from "node:test";
import { Aion } from "../src/core/aion";
import { bodyTransition } from "../src/core/body";
import { RESULT_SYMBOL } from "../src/core/presentation";
import { createSignal } from "../src/core/signal";
import type { ActivityState } from "../src/core/state";
import { transitionSeconds, VisualActionController } from "../src/visual/controller";
import { FORM_ID, VISUAL_FORM_PACKS, VisualFormRegistry, visualForms } from "../src/visual/forms";
import { PLANETS, ZODIAC_SIGNS } from "../src/visual/forms/celestial/astrology/glyphs";
import { chart } from "../src/visual/forms/celestial/astronomy/projection";
import { ORION } from "../src/visual/forms/celestial/astronomy/constellations";
import { renderYinYang } from "../src/visual/forms/tao/draw";
import { SYMBOL_IDS } from "../src/visual/forms/symbols";
import { normalizeImage } from "../src/visual/image";
import { createTargetPoints, pointLayoutLimits } from "../src/visual/points";
import type { MorphTarget, PointLayoutTarget, Raster, Raster2DTarget, VisualTarget } from "../src/visual/types";

const density = (raster: Raster, x: number, y: number) => raster.data[(Math.round(y) * raster.width + Math.round(x)) * 4 + 3] / 255;

// ── Registry (from SCF Presence, plus the symbol pack) ────────────────────────────────────────────────

test("registry: every form has a well-formed, category-prefixed id and a label, and ids are unique", () => {
  const ids = visualForms.ids();
  assert.equal(new Set(ids).size, ids.length);
  for (const form of visualForms.forms()) {
    assert.match(form.id, FORM_ID);
    assert.ok(form.id.startsWith(`${form.category}.`), form.id);
    assert.ok(form.label.trim(), form.id);
  }
  for (const id of ["tao.yin-yang", "tao.qian", "tao.bagua", "astronomy.orion", "astronomy.pleiades",
    ...ZODIAC_SIGNS.map(sign => `astrology.${sign}`), ...PLANETS.map(p => `astrology.${p}`), ...SYMBOL_IDS]) assert.ok(visualForms.has(id), id);
  assert.deepEqual(visualForms.categories().map(category => category.id), ["tao", "astronomy", "astrology", "symbol"]);
  assert.equal(new VisualFormRegistry(VISUAL_FORM_PACKS).size, visualForms.size, "the shipped packs register without collisions");
});

test("registry lookup: ids, aliases in English, Chinese and symbols, and category hints", () => {
  const found = (query: string) => { const match = visualForms.lookup(query); return match && (match.variant ? `${match.entry.id}#${match.variant}` : match.entry.id); };
  const cases: [string, string][] = [
    ["tao.yin-yang", "tao.yin-yang"], ["yin yang", "tao.yin-yang"], ["太极", "tao.yin-yang"], ["☯", "tao.yin-yang"],
    ["fire trigram", "tao.li"], ["后天八卦", "tao.bagua#later-heaven"], ["Orion", "astronomy.orion"], ["猎户座", "astronomy.orion"],
    ["Big Dipper", "astronomy.ursa-major"], ["Leo", "astrology.leo"], ["Leo constellation", "astronomy.leo"], ["♈", "astrology.aries"],
    ["check", "symbol.check"], ["checkmark", "symbol.check"], ["✓", "symbol.check"], ["cross", "symbol.cross"], ["warning", "symbol.exclamation"],
    ["arrow up", "symbol.arrow-up"], ["→", "symbol.arrow-right"], ["heart", "symbol.heart"], ["star", "symbol.star"], ["check mark", "symbol.check"],
  ];
  for (const [query, id] of cases) assert.equal(found(query), id, query);
  for (const query of ["fish", "car", "", "x".repeat(61), "tao.unknown", "constellation"]) assert.equal(visualForms.lookup(query), null, query);
});

test("every registered form renders a non-empty, valid target that the particle sampler accepts", () => {
  for (const form of visualForms.forms()) {
    for (const variant of [undefined, ...(form.variants ?? []).map(item => item.id)]) {
      const rendered = visualForms.render(form.id, variant);
      const points = createTargetPoints(rendered.visual, 3000);
      for (let i = 0; i < points.positions.length; i++) assert.ok(Number.isFinite(points.positions[i]), `${form.id} position`);
      for (let i = 0; i < 3000; i++) {
        assert.ok(points.tones[i] >= 0 && points.tones[i] <= 1, `${form.id} tone`);
        assert.ok(Math.abs(points.positions[i * 3]) <= 2.2 && Math.abs(points.positions[i * 3 + 1]) <= 2.2, `${form.id} stays on stage`);
      }
    }
  }
});

test("result statuses map onto registered symbols, drawn without any canvas or font", () => {
  for (const id of Object.values(RESULT_SYMBOL)) if (id) assert.ok(visualForms.has(id), id);
  const check = visualForms.render("symbol.check").visual as Raster2DTarget;
  const { raster } = check;
  // The stroke passes through its corner (lower middle) and not through the opposite corner.
  const at = (fx: number, fy: number) => density(raster, (fx + 1) / 2 * (raster.width - 1), (1 - (fy + 1) / 2) * (raster.height - 1));
  assert.ok(at(-0.18, -0.42) > 0.8, "the check's corner is drawn");
  assert.ok(at(0.5, -0.6) < 0.1 && at(-0.6, 0.6) < 0.1, "empty space stays empty");
  assert.notDeepEqual((visualForms.render("symbol.cross").visual as Raster2DTarget).raster.data, raster.data);
});

test("tao: the yin-yang is centred, balanced and turns slowly; trigrams stay upright", () => {
  const { raster } = renderYinYang();
  const c = (raster.width - 1) / 2, r = 0.92 * raster.width / 2;
  const at = (fx: number, fy: number) => density(raster, c + fx * r, c - fy * r);
  assert.ok(at(-0.7, 0) > 0.8 && at(0.7, 0) < 0.3, "yang left, yin right");
  assert.ok(at(0, 0.5) < 0.3 && at(0, -0.5) > 0.8, "a dot of each in the other");
  assert.ok(visualForms.render("tao.yin-yang").spin! < 0 && visualForms.render("tao.qian").spin === undefined);
});

test("astronomy: Orion keeps its sky orientation; magnitude sets prominence", () => {
  const { points } = chart(ORION.stars);
  const at = (id: string) => points[ORION.stars.findIndex(item => item.id === id)];
  assert.ok(at("betelgeuse").x < at("rigel").x && at("betelgeuse").y > at("rigel").y, "east is left");
  const target = visualForms.render("astronomy.orion").visual as PointLayoutTarget;
  const rigel = target.layout.points[ORION.stars.findIndex(item => item.id === "rigel")];
  const faint = target.layout.points[ORION.stars.findIndex(item => item.id === "chi2")];
  assert.ok(rigel.radius > faint.radius && rigel.tone > faint.tone);
});

test("point layouts: quality prefixes, and malformed layouts are rejected before the render loop", () => {
  const target = visualForms.render("astronomy.cassiopeia").visual as PointLayoutTarget;
  assert.deepEqual(createTargetPoints(target, 4000).positions.slice(0, 3000), createTargetPoints(target, 1000).positions);
  const bad = (layout: Partial<PointLayoutTarget["layout"]>): VisualTarget => ({ kind: "points", style: "celestial", layout: { ...target.layout, ...layout } });
  for (const layout of [{ dust: 0.9 }, { points: [], strokes: [] }, { points: [{ x: 3, y: 0, weight: 1, radius: 0.1, tone: 1 }] },
    { points: Array.from({ length: pointLayoutLimits.points + 1 }, () => ({ x: 0, y: 0, weight: 1, radius: 0.1, tone: 1 })) }]) {
    assert.throws(() => createTargetPoints(bad(layout), 10));
  }
});

function raster(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...paint(x, y), 255], (y * width + x) * 4);
  return { width, height, data };
}

test("an image the host hands over is trimmed and sampled as an object, its subject drawn densest", () => {
  // A dark square on a white page: the square is the subject, not the page.
  const image = raster(120, 80, (x, y) => x > 40 && x < 80 && y > 20 && y < 60 ? [20, 30, 40] : [250, 250, 250]);
  const target = normalizeImage(image);
  assert.equal(target.style, "object");
  assert.ok(target.raster.width < 60 && target.raster.height < 60, "the plain page is trimmed away");
  const points = createTargetPoints(target, 4000);
  let inside = 0;
  for (let i = 0; i < 4000; i++) if (Math.abs(points.positions[i * 3]) < 1.45 && Math.abs(points.positions[i * 3 + 1]) < 1.45) inside++;
  assert.ok(inside > 3600, `the subject, not its margin, gets the particles (${inside})`);
});

// ── Lifecycle: the body becomes information and returns to the persistent body ─────────────────────────

const orion: MorphTarget = { visual: visualForms.render("astronomy.orion").visual, hold: 3, label: "Orion" };

function lifecycle() {
  const resolved: { resolve: (target: MorphTarget) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  const errors: unknown[] = [];
  const controller = new VisualActionController<string>((_request, signal) => new Promise((resolve, reject) => resolved.push({ resolve, reject, signal })), error => errors.push(error));
  const run = (seconds: number) => { const levels: number[] = []; for (let i = 0; i < Math.round(seconds * 60); i++) levels.push(controller.sample(1 / 60)); return levels; };
  return { controller, resolved, errors, run, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test("a visual forms from the body, holds, and returns smoothly", async () => {
  const h = lifecycle();
  void h.controller.submit("orion");
  assert.equal(h.controller.phase, "sphere", "the body stays until the target is ready");
  h.resolved[0].resolve({ ...orion, hold: 2 });
  await h.settle();
  const forming = h.run(transitionSeconds.form + 0.1);
  assert.equal(h.controller.phase, "holding");
  for (let i = 1; i < forming.length; i++) assert.ok(forming[i] >= forming[i - 1] && forming[i] - forming[i - 1] < 0.03, "monotonic, no jumps");
  h.run(2);
  assert.equal(h.controller.phase, "returning");
  h.run(transitionSeconds.return + 0.1);
  assert.equal(h.controller.phase, "sphere");
  assert.equal(h.controller.level, 0);
});

test("an infinite hold stays formed until released; null returns to the body", async () => {
  const h = lifecycle();
  void h.controller.submit("orion");
  h.resolved[0].resolve({ ...orion, hold: Infinity });
  await h.settle();
  h.run(60);
  assert.equal(h.controller.phase, "holding");
  await h.controller.submit(null);
  h.run(transitionSeconds.return + 0.1);
  assert.equal(h.controller.phase, "sphere");
});

test("a second visual returns through the body before the next target is loaded; cancelled results never appear", async () => {
  const h = lifecycle();
  void h.controller.submit("one");
  h.resolved[0].resolve({ ...orion, hold: 30 }); await h.settle();
  h.run(2);
  void h.controller.submit("two");
  h.resolved[1].resolve({ ...orion, label: "two", hold: 30 }); await h.settle();
  const levels: number[] = [], revisions: number[] = [];
  for (let i = 0; i < 60 * 4; i++) { levels.push(h.controller.sample(1 / 60)); revisions.push(h.controller.revision); }
  assert.equal(levels[revisions.indexOf(2)], 0, "the buffer is replaced only at rest");
  void h.controller.submit("three");
  void h.controller.submit(null);
  assert.equal(h.resolved[2].signal.aborted, true);
  h.resolved[2].resolve({ ...orion, label: "late" }); await h.settle();
  assert.notEqual(h.controller.target?.label, "late");
});

/** A runtime-like frame loop over Aion and the visual controller: the persistent body under the visual. */
function stage() {
  const signal = createSignal();
  const visual = new VisualActionController<string>(async () => orion);
  const activity: ActivityState = "idle";
  const aion = new Aion({ activity: () => activity, presenting: () => visual.presenting, signal: () => signal });
  let now = 0;
  const run = (seconds: number) => {
    let frame = aion.sample(0, now), morph = visual.level;
    for (let i = 0; i < Math.round(seconds * 60); i++) { now += 1 / 60; morph = visual.sample(1 / 60); frame = aion.sample(1 / 60, now); }
    return { body: frame.level, morph, state: aion.currentState };
  };
  return { aion, visual, run };
}

test("figure → temporary visual → figure: the visual returns to the persistent body, not the sphere", async () => {
  const { aion, visual, run } = stage();
  aion.setBody("figure");
  assert.equal(run(bodyTransition.seconds + 0.5).body, 1);
  await visual.submit("orion");
  const presenting = run(1);
  assert.equal(presenting.state, "presenting");
  assert.equal(presenting.body, 1, "the figure is still the rest the visual forms from");
  assert.ok(run(3).morph > 0.99, "Orion formed");
  const after = run(5);
  assert.equal(after.morph, 0);
  assert.equal(after.body, 1, "and the rest is still the figure");
  assert.equal(aion.currentBody, "figure");
  assert.notEqual(after.state, "presenting");
});

test("sphere → temporary visual → sphere", async () => {
  const { aion, visual, run } = stage();
  await visual.submit("orion");
  assert.ok(run(4).morph > 0.99);
  const after = run(5);
  assert.equal(after.morph, 0);
  assert.equal(after.body, 0);
  assert.equal(aion.currentBody, "sphere");
});
