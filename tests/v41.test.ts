import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/pluginPackage";
import { describePresentation, planPresentation } from "../src/core/presentation";
import type { HubSnapshot } from "../src/host/hub/protocol";
import { hubCommandSchema } from "../src/host/hub/protocol";
import { VisualResolver } from "../src/host/resolver";
import type { ImageProvider } from "../src/host/resolver/types";
import { DEFAULT_PORTRAIT_STYLE, portraitStyleFor } from "../src/visual/types";
import { createEyesLayout, EYE_GEOMETRY, EYE_KINDS, EYE_PARAMS, eyesPoint, lidBand, type EyesLayout } from "../src/core/eyes/layout";
import { ASLEEP, blinkAmount, BLINK, ENTRY, EXPRESSIONS, EYE_EXPRESSIONS, EyesAnimator, packEyes, type EyeExpression } from "../src/core/eyes/expression";
import { connectAion } from "./helpers";

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const text = (result: unknown) => (result as Result).content.map(item => item.text).join(" ");
const output = <T = { presentation: { description: string } | null; shown?: string }>(result: unknown) => {
  assert.equal((result as Result).isError, undefined, text(result));
  return (result as Result).structuredContent as unknown as T;
};
const state = (aion: Awaited<ReturnType<typeof connectAion>>) => aion.link.run(backend => backend.state()) as Promise<HubSnapshot>;
type ImagePresentation = Extract<HubSnapshot["presentation"], { kind: "image" }>;

const JPEG = (width: number, height: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)]);
const pictures: ImageProvider = {
  name: "wikipedia",
  async search(query) {
    return [{
      provider: "wikipedia", url: "https://upload.wikimedia.org/x.jpg", title: query, relevance: 1, width: 900, height: 1200, mime: "image/jpeg",
      load: async () => ({ bytes: JPEG(900, 1200), mime: "image/jpeg" }),
    }];
  },
};
const resolver = () => new VisualResolver({ env: {}, assetsDir: join(PLUGIN_ROOT, "assets"), imageProviders: [pictures], terrainProviders: [] });

// ── 1. Heritage portrait: the default ────────────────────────────────────────────────────────────────────────

test("portrait style: heritage unless classic is asked for, and only ever for portraits", () => {
  assert.equal(DEFAULT_PORTRAIT_STYLE, "heritage");
  assert.equal(portraitStyleFor("portrait"), "heritage");
  assert.equal(portraitStyleFor("portrait", "classic"), "classic");
  assert.equal(portraitStyleFor("portrait", "heritage"), "heritage");
  assert.equal(portraitStyleFor("portrait", "sepia" as never), "heritage", "an unknown style falls back to the default");
  for (const fit of ["object", "map", "logo", undefined] as const) {
    assert.equal(portraitStyleFor(fit), undefined, `${fit}: never an oval`);
    assert.equal(portraitStyleFor(fit, "heritage"), undefined, `${fit}: not even when asked`);
  }
});

test("a portrait presentation with no style forms a heritage oval; classic stays the explicit alternative", () => {
  const media = { id: "m0123456789abcdef01", mime: "image/jpeg", bytes: 10 };
  const bare = { kind: "image" as const, media, fit: "portrait" as const, origin: "lookup" as const, alt: "Nikola Tesla", width: 900, height: 1200 };
  assert.deepEqual(planPresentation(bare, "hybrid").body, { type: "image", media, fit: "portrait", style: "heritage" });
  assert.equal(planPresentation(bare, "hybrid").card, true, "the original photograph card stays");
  assert.equal(describePresentation(bare), "heritage portrait: Nikola Tesla");
  assert.deepEqual(planPresentation({ ...bare, style: "classic" }, "hybrid").body, { type: "image", media, fit: "portrait", style: "classic" });
  assert.equal(describePresentation({ ...bare, style: "classic" }), "classic portrait: Nikola Tesla");
  // A car is never framed as a portrait, whatever a caller sends.
  const car = { kind: "image" as const, media, fit: "object" as const, origin: "lookup" as const, style: "heritage" as const };
  assert.deepEqual(planPresentation(car, "body").body, { type: "image", media, fit: "object" });
  assert.equal(describePresentation(car), "image");
  // Older callers (the hub's HTTP API) may still send either style, or none.
  for (const style of [undefined, "heritage", "classic"]) assert.ok(hubCommandSchema.safeParse({ type: "present", content: { ...bare, ...(style ? { style } : {}) } }).success);
});

test("Test A: \"Show me Nikola Tesla\" → show_portrait with no style is a heritage portrait; \"the classic portrait instead\" → classic", async () => {
  const aion = await connectAion({ resolver: resolver() });
  try {
    const shown = output(await aion.call("show_portrait", { person: "Nikola Tesla" }));
    assert.equal(shown.presentation?.description, "heritage portrait: Nikola Tesla");
    let presentation = (await state(aion)).presentation as ImagePresentation;
    assert.equal(presentation.style, "heritage");
    assert.equal(presentation.route, "hybrid", "the original high-resolution photograph stands beside it");
    output(await aion.call("show_portrait", { person: "Nikola Tesla", style: "classic" }));
    presentation = (await state(aion)).presentation as ImagePresentation;
    assert.equal(presentation.style, "classic");
    // show_image with a portrait intent is a portrait too; a vehicle is not, even with a style.
    output(await aion.call("show_image", { query: "Albert Einstein", intent: "portrait" }));
    assert.equal(((await state(aion)).presentation as ImagePresentation).style, "heritage");
    output(await aion.call("show_image", { query: "Isaac Newton", intent: "celebrity", style: "classic" }));
    assert.equal(((await state(aion)).presentation as ImagePresentation).style, "classic");
    output(await aion.call("show_image", { query: "Tesla Model Y", intent: "vehicle", style: "heritage" }));
    const car = (await state(aion)).presentation as ImagePresentation;
    assert.equal(car.fit, "object");
    assert.equal(car.style, undefined, "no oval for vehicles, buildings or landscapes");
    const tools = await aion.client.listTools();
    const portrait = tools.tools.find(tool => tool.name === "show_portrait")!;
    assert.match(portrait.description ?? "", /by default a heritage portrait/);
    assert.match(JSON.stringify(portrait.inputSchema), /classic/);
  } finally { await aion.close(); }
});

// ── 2. Aion Eyes: the cartoon redesign ───────────────────────────────────────────────────────────────────────

const LAYOUT = createEyesLayout(12_000);
const finite = (values: ArrayLike<number>) => Array.from(values).every(Number.isFinite);
const shapeParams = (name: EyeExpression) => packEyes(EXPRESSIONS[name]);
/** Each eye's drawn points and their extent. */
function measure(params: ArrayLike<number>, layout: EyesLayout = LAYOUT) {
  const eyes = [0, 1].map(() => ({ xs: [] as number[], ys: [] as number[] }));
  for (let i = 0; i < layout.count; i++) {
    const { position: [x, y], eye } = eyesPoint(layout, i, params, 0);
    eyes[eye].xs.push(x); eyes[eye].ys.push(y);
  }
  return eyes.map(({ xs, ys }) => {
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, w = maxX - minX;
    // The top of the eye in its middle, inner and outer thirds (an arc rises in the middle; a frown slopes).
    const topIn = (from: number, to: number) => Math.max(...ys.filter((_, k) => xs[k] >= minX + w * from && xs[k] <= minX + w * to));
    const bottomIn = (from: number, to: number) => Math.min(...ys.filter((_, k) => xs[k] >= minX + w * from && xs[k] <= minX + w * to));
    return { xs, ys, width: w, height: maxY - minY, cx, cy: (minY + maxY) / 2, topLeft: topIn(0, 0.2), topMiddle: topIn(0.4, 0.6), topRight: topIn(0.8, 1), bottomMiddle: bottomIn(0.4, 0.6), bottomEnds: Math.min(bottomIn(0, 0.12), bottomIn(0.88, 1)) };
  });
}
/** A coarse picture of the whole pair: which cells of a 40×24 grid over the stage are lit. */
function silhouette(params: ArrayLike<number>) {
  const cells = new Set<number>();
  for (let i = 0; i < LAYOUT.count; i += 2) {
    const { position: [x, y] } = eyesPoint(LAYOUT, i, params, 0);
    cells.add(Math.floor((y + 1.2) / 2.4 * 24) * 40 + Math.floor((x + 2) / 4 * 40));
  }
  return cells;
}
const jaccard = (a: Set<number>, b: Set<number>) => { let both = 0; for (const cell of a) if (b.has(cell)) both++; return 1 - both / (a.size + b.size - both); };

test("Eyes have no anatomy: only a crisp edge and a solid fill per eye — no iris, pupil, glint or brow", () => {
  assert.deepEqual(Object.keys(EYE_KINDS).sort(), ["edge", "fill"]);
  const kinds = new Map<number, number>();
  for (let i = 0; i < LAYOUT.count; i++) { const kind = Math.round(LAYOUT.bind[i * 4]) % 8; kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
  assert.deepEqual([...kinds.keys()].sort(), [0, 1]);
  assert.ok(Math.abs(kinds.get(EYE_KINDS.edge)! / LAYOUT.count - 0.3) < 0.03, "about 30 % draw the edge");
  // Every grain belongs to an eye and is drawn within it: the fill never leaves the edge, whatever the roundness.
  for (const round of [2, 3.2, 5]) {
    const p = Float32Array.from(shapeParams("neutral"));
    p[8] = p[EYE_PARAMS + 8] = round;
    const [left] = measure(p);
    for (let k = 0; k < left.xs.length; k++) {
      const u = (left.xs[k] - p[0]) / p[2], v = (left.ys[k] - p[1]) / p[3];
      // (The edge itself has a width: a few percent past the outline.)
      assert.ok(Math.pow(Math.pow(Math.abs(u), round) + Math.pow(Math.abs(v), round), 1 / round) < 1.07, `inside the outline at n=${round}`);
    }
  }
});

test("every expression is bounded, finite, drawn by every particle, and clearly distinguishable as a silhouette", () => {
  const pictures = new Map<EyeExpression, Set<number>>();
  for (const name of EYE_EXPRESSIONS) {
    const p = shapeParams(name);
    assert.equal(p.length, EYE_PARAMS * 2);
    assert.ok(finite(p), name);
    for (let i = 0; i < LAYOUT.count; i += 7) {
      const { position, tone } = eyesPoint(LAYOUT, i, p, 2.1);
      assert.ok(finite(position) && tone >= 0 && tone <= 1);
      assert.ok(Math.abs(position[0]) < 1.6 && Math.abs(position[1]) < 1.2 && Math.abs(position[2]) < 0.2, `${name} bounded`);
    }
    pictures.set(name, silhouette(p));
  }
  for (let a = 0; a < EYE_EXPRESSIONS.length; a++) for (let b = a + 1; b < EYE_EXPRESSIONS.length; b++) {
    const [x, y] = [EYE_EXPRESSIONS[a], EYE_EXPRESSIONS[b]];
    assert.ok(jaccard(pictures.get(x)!, pictures.get(y)!) > 0.12, `${x} and ${y} look different (${jaccard(pictures.get(x)!, pictures.get(y)!).toFixed(2)})`);
  }
});

test("the shapes say it: happy arcs, round surprise, lopsided confusion, worried corners, a narrowed thinking eye, a tilted curious one", () => {
  const [neutral] = measure(shapeParams("neutral"));
  // Happy: two thin arcs whose middle rises above their ends ("^ ^").
  for (const eye of measure(shapeParams("happy"))) {
    assert.ok(eye.height < 0.6 * neutral.height, "thin");
    assert.ok(eye.bottomMiddle > eye.bottomEnds + 0.1, "arched: the middle lifted");
  }
  // Asleep: thin soft curves whose middle sags ("‿ ‿").
  for (const eye of measure(packEyes(ASLEEP))) {
    assert.ok(eye.height < 0.3 * neutral.height, "closed");
    assert.ok(eye.bottomMiddle < eye.bottomEnds, "a soft downward curve");
  }
  // Surprised: bigger in both directions, and round.
  const surprised = measure(shapeParams("surprised"));
  for (const eye of surprised) assert.ok(eye.width > 1.1 * neutral.width && eye.height > 1.15 * neutral.height, "popped open");
  assert.ok(EXPRESSIONS.surprised.left.round < 2.3, "round");
  // Confused: the two eyes differ a lot, and lean opposite ways.
  const [cl, cr] = measure(shapeParams("confused"));
  assert.ok(Math.abs(cl.height - cr.height) > 0.3 * neutral.height, "lopsided");
  assert.ok(Math.sign(EXPRESSIONS.confused.left.tilt) !== Math.sign(EXPRESSIONS.confused.right.tilt), "tilted each its own way");
  // Concerned: on each eye the inner top corner is higher than the outer one.
  const [wl, wr] = measure(shapeParams("concerned"));
  assert.ok(wl.topRight > wl.topLeft + 0.03, "left eye: inner (right) corner up");
  assert.ok(wr.topLeft > wr.topRight + 0.03, "right eye: inner (left) corner up");
  // Thinking: one eye narrowed under a flat lid, the other open.
  const [tl, tr] = measure(shapeParams("thinking"));
  assert.ok(tr.height < tl.height - 0.08, "one eye narrows");
  // Curious: one eye clearly larger than the other.
  const [ul, ur] = measure(shapeParams("curious"));
  assert.ok(ur.height > ul.height * 1.15, "one eye opened wider");
  // Lids: open lids leave the shape unchanged; closed lids meet.
  const open = shapeParams("neutral");
  const [vmax, top, bottom] = lidBand(0, open, 0);
  assert.ok(top - bottom >= 2 * vmax - 1e-6, "open: the whole height");
  const shut = Float32Array.from(open); shut[4] = 0.5; shut[5] = 0.5;
  const [, t2, b2] = lidBand(0, shut, 0);
  assert.ok(t2 - b2 <= 0.06, "closed to a line");
});

test("a blink squashes the eye to a line, then springs back a touch taller before it settles (squash and stretch)", () => {
  assert.equal(blinkAmount(-0.1), 0);
  assert.equal(blinkAmount(BLINK.close + BLINK.hold / 2), 1);
  const stretch = blinkAmount(BLINK.close + BLINK.hold + BLINK.open + BLINK.settle / 2);
  assert.ok(stretch < -0.03, "the rebound");
  assert.equal(blinkAmount(5), 0);
  const rest = packEyes(EXPRESSIONS.neutral), shut = packEyes(EXPRESSIONS.neutral, undefined, 0, 1), tall = packEyes(EXPRESSIONS.neutral, undefined, 0, stretch);
  assert.ok(shut[3] < 0.12 * rest[3], "a line");
  assert.ok(shut[2] > rest[2], "squashed eyes widen");
  assert.ok(tall[3] > rest[3], "and reopen a little taller");
  const eyes = new EyesAnimator();
  for (let k = 0; k < 30; k++) eyes.sample(1 / 60, "idle", k / 60);
  eyes.blink();
  let lowest = Infinity;
  for (let t = 0; t < 0.4; t += 1 / 240) lowest = Math.min(lowest, eyes.sample(1 / 240, "idle", 1)[3]);
  assert.ok(lowest < 0.15 * EYE_GEOMETRY.halfHeight, `it closes (${lowest.toFixed(3)})`);
  for (let k = 0; k < 30; k++) eyes.sample(1 / 60, "idle", 2);
  assert.ok(eyes.params[3] > 0.8 * EYE_GEOMETRY.halfHeight, "and opens again");
});

/** Runs an animator in one expression from neutral and records each eye's half height (and the pair's lift). */
function run(name: EyeExpression, seconds: number, dt = 1 / 120) {
  const eyes = new EyesAnimator();
  // No blinks or saccades during a measurement: only the expression moves.
  Object.assign(eyes as unknown as { nextBlink: number; nextSaccade: number }, { nextBlink: 1e9, nextSaccade: 1e9 });
  for (let t = 0; t < 1.2; t += dt) eyes.sample(dt, "idle", t);
  eyes.express(name, 30);
  const frames: Float32Array[] = [];
  for (let t = 0; t < seconds; t += dt) frames.push(Float32Array.from(eyes.sample(dt, "idle", 1.2 + t)));
  return { eyes, frames };
}

test("elastic: a surprise pops past its size and settles; transitions are continuous, never a jump", () => {
  const { frames } = run("surprised", 1.6);
  const target = packEyes(EXPRESSIONS.surprised);
  const widest = Math.max(...frames.map(p => p[2])), tallest = Math.max(...frames.map(p => p[3]));
  assert.ok(widest > target[2] * 1.02 && tallest > target[3] * 1.02, "overshoot: the eye pops a little past its open size");
  const last = frames[frames.length - 1];
  assert.ok(Math.abs(last[2] - target[2]) / target[2] < 0.02 && Math.abs(last[3] - target[3]) / target[3] < 0.02, "and settles on it");
  for (const name of EYE_EXPRESSIONS) {
    const { frames: f } = run(name, 1.2);
    for (let k = 1; k < f.length; k++) for (let i = 0; i < f[k].length; i++) {
      assert.ok(Math.abs(f[k][i] - f[k - 1][i]) < 0.12, `${name}: param ${i} moves continuously (${(f[k][i] - f[k - 1][i]).toFixed(3)} in 1/120 s)`);
    }
  }
});

test("expressive timing: happy hops, thinking narrows before it glances, sleep comes gradually, the right eye trails the left", () => {
  // Happy: the pair hops up before settling.
  const happy = run("happy", 1.2).frames;
  const lifts = happy.map(p => (p[1] + p[EYE_PARAMS + 1]) / 2);
  assert.ok(Math.max(...lifts) > lifts[lifts.length - 1] + 0.01, "a hop of joy");
  // Thinking: the lid comes down at once; the glance waits.
  const thinking = run("thinking", 1.2).frames;
  const at = (s: number) => thinking[Math.round(s * 120)];
  const glanceAfter = ENTRY.thinking!.glanceAfter!;
  assert.ok(at(glanceAfter * 0.8)[EYE_PARAMS + 4] > 0.12, "the right eye has narrowed");
  const restX = run("neutral", 0.1).frames[0][0];
  assert.ok(Math.abs(at(glanceAfter * 0.8)[0] - restX) < 0.02, "but has not glanced yet");
  assert.ok(at(1.1)[0] - restX > 0.04, "then the pair glances aside");
  // Sleepy: still open after half a second, softly closed curves a few seconds in.
  const sleepy = run("sleepy", 4.5).frames;
  assert.ok(sleepy[60][3] > 0.6 * EYE_GEOMETRY.halfHeight, "drowsy first");
  assert.ok(sleepy[sleepy.length - 1][3] < 0.2 * EYE_GEOMETRY.halfHeight && sleepy[sleepy.length - 1][9] < 0, "then asleep: thin and curved down");
  // Asymmetry: shortly after a change the left eye has moved further toward its goal than the right.
  const attentive = run("attentive", 0.1).frames;
  const p = attentive[attentive.length - 1], from = packEyes(EXPRESSIONS.neutral), to = packEyes(EXPRESSIONS.attentive);
  const progress = (i: number) => (p[i] - from[i]) / (to[i] - from[i]);
  assert.ok(progress(3) > progress(EYE_PARAMS + 3) + 0.02, `the right eye trails a hair behind (${progress(3).toFixed(2)} vs ${progress(EYE_PARAMS + 3).toFixed(2)})`);
});
