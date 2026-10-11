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

// ── 3. Geography: coverage, projection, extents ──────────────────────────────────────────────────────────────

import { resolveRegion, regionFrame, inside } from "../src/host/geo/region";
import { buildMap } from "../src/host/geo/map";
import { findPlace, findRegion, REGION_GROUPS, worldRegions } from "../src/host/geo/world";
import { decodeMap, encodeMap, frameBounds, mapWorldPoint, MAP_LIMITS, MAP_SCALE } from "../src/visual/geo/map";
import { frameWindow, primaryExtent } from "../src/visual/geo/extent";
import { geoToNormal, project, unproject, type GeoProjection } from "../src/visual/geo/projection";
import { markerWorldPoint } from "../src/visual/geo/markers";
import { createTargetPoints, terrainWorldPoint } from "../src/visual/points";
import { buildHeightField, decodeHeightField, encodeHeightField } from "../src/visual/heightfield";

/** Nothing in these tests may reach the network: the offline world must answer. */
const offline = (async () => { throw new Error("network used"); }) as unknown as typeof fetch;
const signal = () => new AbortController().signal;
const region = (name: string) => resolveRegion(name, signal(), offline);

test("projections: equal-area azimuthal and Equal Earth invert exactly; the date line and the poles are not seams", () => {
  const laea: GeoProjection = { kind: "laea", lon0: 178, lat0: -17 }, world: GeoProjection = { kind: "equal-earth", lon0: 0 };
  for (const p of [laea, { kind: "laea", lon0: 0, lat0: 90 } as GeoProjection, { kind: "laea", lon0: -98, lat0: 39 } as GeoProjection, world]) {
    for (let k = 0; k < 200; k++) {
      const lon = ((k * 137.5) % 360) - 180, lat = ((k * 61.3) % 170) - 85;
      const xy = project(lon, lat, p);
      if (!xy) continue;
      const back = unproject(xy[0], xy[1], p)!;
      const dlon = Math.abs(((back[0] - lon + 540) % 360) - 180);
      assert.ok(dlon * Math.cos(lat * Math.PI / 180) < 1e-6 && Math.abs(back[1] - lat) < 1e-6, `${p.kind} round trip at ${lon},${lat}`);
    }
  }
  // Fiji: 179.9° E and 179.9° W are neighbours, not opposite sides of the map.
  const a = project(179.9, -17, laea)!, b = project(-179.9, -17, laea)!;
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01, "across the date line");
  // The pole is an ordinary point of a polar map.
  assert.ok(Math.hypot(...project(0, 90, { kind: "laea", lon0: 0, lat0: 90 })!) < 1e-9);
});

test("coverage: every country, named part and group of Aion's offline world resolves, frames and maps within bounds", async () => {
  const names = [...worldRegions().map(r => r.name), ...REGION_GROUPS.map(group => group.label)];
  assert.ok(names.length > 290, `${names.length} names`);
  for (const name of names) {
    const found = await region(name);
    const frame = regionFrame(found);
    assert.ok([frame.x0, frame.y0, frame.x1, frame.y1].every(Number.isFinite) && frame.x1 > frame.x0 && frame.y1 > frame.y0, `${name}: a frame`);
    const map = decodeMap(encodeMap(buildMap(found, frame)));
    const vertices = [...map.focus, ...map.borders, ...map.context, ...map.fill, ...map.contextFill].reduce((n, line) => n + line.length / 2, 0);
    assert.ok(vertices > 0 && vertices <= MAP_LIMITS.vertices, `${name}: ${vertices} vertices`);
    assert.ok(map.focus.length + map.borders.length > 0 || map.fill.length > 0, `${name}: its own outline is drawn`);
  }
});

test("names: English, Chinese, common aliases and codes; continents and well-known groups", async () => {
  for (const [name, id] of [["United States", "USA"], ["USA", "USA"], ["美国", "USA"], ["中国", "CHN"], ["China", "CHN"], ["Japan", "JPN"], ["日本", "JPN"],
    ["Scotland", "GBR.SCT"], ["苏格兰", "GBR.SCT"], ["UK", "GBR"], ["Britain", "GBR"], ["Côte d'Ivoire", "CIV"], ["Ivory Coast", "CIV"], ["Svalbard", "NOR.NSV"]] as const) {
    assert.equal(findRegion(name)?.id, id, name);
  }
  for (const [name, label] of [["Africa", "Africa"], ["非洲", "Africa"], ["Europe", "Europe"], ["South America", "South America"], ["Antarctica", "Antarctica"],
    ["world", "The world"], ["世界", "The world"], ["Middle East", "The Middle East"], ["Scandinavia", "Scandinavia"]] as const) {
    assert.equal((await region(name)).label, label, name);
  }
  await assert.rejects(region("Narnia"), /network used|region-not-found|geocoder-unavailable/, "anything else goes to the geocoder");
});

test("extents: the main part plus what is near it — no unintended cropping, no far territories", async () => {
  const lonRange = async (name: string) => { const w = frameWindow(regionFrame(await region(name))); return w; };
  const usaFrame = regionFrame(await region("United States"));
  assert.ok(inside(usaFrame, [-98, 39]) && inside(usaFrame, [-122.4, 37.8]) && inside(usaFrame, [-80.2, 25.8]) && inside(usaFrame, [-69, 45]), "the contiguous states, coast to coast");
  assert.ok(!inside(usaFrame, [-149.9, 61.2]) && !inside(usaFrame, [-157.86, 21.31]) && !inside(usaFrame, [144.8, 13.4]), "not Anchorage, Honolulu or Guam");
  const contains = async (name: string, lon: number, lat: number) => {
    const found = await region(name);
    // Point in polygon (even-odd) on the outer rings: the place is part of what is framed.
    return found.focus.some(([ring]) => {
      let within = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) within = !within;
      }
      return within;
    });
  };
  assert.ok(await contains("France", 9.1, 42.2), "France keeps Corsica");
  assert.ok(!(await contains("France", 55.5, -21.1)), "but not Réunion");
  assert.ok(await contains("Japan", 142.5, 43.5) && await contains("Japan", 130.7, 32.5), "Japan: Hokkaido and Kyushu");
  assert.ok(await contains("Indonesia", 110.4, -7.5) && await contains("Indonesia", 101, 0) && await contains("Indonesia", 138, -4), "Indonesia chains Java, Sumatra and Papua");
  assert.ok(await contains("Russia", -175, 66), "Russia keeps Chukotka across the date line");
  const fiji = await lonRange("Fiji");
  assert.ok(fiji.east - fiji.west < 12, `Fiji is not stretched across the world (${(fiji.east - fiji.west).toFixed(1)}°)`);
  const africa = await lonRange("Africa");
  assert.ok(africa.west < -17 && africa.east > 51 && africa.south < -34 && africa.north > 37, "Africa whole, never cropped to 70°");
  const russia = await lonRange("Russia");
  assert.ok(russia.east - russia.west > 150, "Russia whole");
  // High latitude: an equal-area frame keeps Svalbard's true proportions (Web Mercator would make it 3–4× taller).
  const sv = regionFrame(await region("Svalbard"));
  const aspect = (sv.x1 - sv.x0) / (sv.y1 - sv.y0);
  assert.ok(aspect > 0.7 && aspect < 1.6, `Svalbard keeps its shape (${aspect.toFixed(2)})`);
  // A marker outside widens the view; the primary extent brings in the part a marker sits on.
  assert.ok(!inside(regionFrame(await region("United States")), [-157.86, 21.31]), "Honolulu is outside the contiguous states");
  assert.ok(inside(regionFrame(await region("United States"), [[-157.86, 21.31]]), [-157.86, 21.31]), "until it is marked");
  assert.equal(primaryExtent([]).length, 0);
});

test("markers sit at their real coordinates: on a map through the frame, on terrain onto its cell and relief", async () => {
  const usa = await region("United States");
  const la = findPlace("Los Angeles", place => place.country === "USA")!, ny = findPlace("New York", place => place.country === "USA")!;
  assert.ok(Math.abs(la.lat - 34.05) < 0.15 && Math.abs(la.lon + 118.24) < 0.15, "Los Angeles from the gazetteer");
  assert.ok(Math.abs(ny.lat - 40.71) < 0.15 && Math.abs(ny.lon + 74.0) < 0.15, "New York from the gazetteer");
  assert.equal(findPlace("Glasgow", place => place.country === "GBR")?.country, "GBR", "Glasgow on Scotland is Glasgow, Scotland");
  const frame = regionFrame(usa, [[la.lon, la.lat], [ny.lon, ny.lat]]);
  const map = buildMap(usa, frame);
  const target = { kind: "map" as const, map };
  const pLA = markerWorldPoint(target, la.lon, la.lat)!, pNY = markerWorldPoint(target, ny.lon, ny.lat)!;
  assert.ok(pLA[0] < pNY[0] - 2 && pLA[1] < pNY[1], "Los Angeles is south-west of New York, far apart");
  const bounds = frameBounds(frame);
  for (const p of [pLA, pNY]) assert.ok(Math.abs(p[0]) < bounds.x * MAP_SCALE && Math.abs(p[1]) < bounds.y * MAP_SCALE, "on the stage");
  assert.deepEqual(pLA, mapWorldPoint(...geoToNormal(la.lon, la.lat, frame)!, 0.06), "the same transform the map sampler uses");
  // The coastline the sampler drew passes within a few hundredths of the coastal city.
  const points = createTargetPoints(target, 20_000);
  let nearest = Infinity;
  for (let i = 0; i < 20_000; i++) nearest = Math.min(nearest, Math.hypot(points.positions[i * 3] - pLA[0], points.positions[i * 3 + 1] - pLA[1]));
  assert.ok(nearest < 0.05, `particles of the map at Los Angeles (${nearest.toFixed(3)})`);
  // Terrain: a synthetic georeferenced grid, a peak at a known place; the marker stands on that peak.
  const scotland = await region("Scotland");
  const sframe = regionFrame(scotland);
  const W = 60, H = 80, values = new Float32Array(W * H);
  const peak = { lon: -5.0, lat: 56.8 };
  const pxy = project(peak.lon, peak.lat, sframe.projection)!;
  const pu = (pxy[0] - sframe.x0) / (sframe.x1 - sframe.x0), pv = (sframe.y1 - pxy[1]) / (sframe.y1 - sframe.y0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) values[y * W + x] = 50 + 1300 * Math.exp(-(((x + 0.5) / W - pu) ** 2 + ((y + 0.5) / H - pv) ** 2) / 0.004);
  const field = decodeHeightField(encodeHeightField(buildHeightField({ provider: "t", kind: "elevation", width: W, height: H, values, aspect: (sframe.x1 - sframe.x0) / (sframe.y1 - sframe.y0), label: "S", geo: sframe })));
  assert.ok(field.geo, "the frame survives the crop and the codec");
  const top = markerWorldPoint({ kind: "heightfield", field, style: "terrain" }, peak.lon, peak.lat)!;
  const low = markerWorldPoint({ kind: "heightfield", field, style: "terrain" }, -2.2, 57.6)!;
  assert.ok(top[2] > low[2], "the marker on the peak stands higher than one on low ground");
  assert.deepEqual(markerWorldPoint({ kind: "heightfield", field, style: "terrain" }, 120, 30), null, "outside the terrain: no marker");
  assert.ok(Number.isFinite(terrainWorldPoint(field, 0.5, 0.5)[0]));
});

// ── 4. Map mode tools and markers ────────────────────────────────────────────────────────────────────────────

import { PresenceStore } from "../src/core/store";
import { PresenceHub, loadAppearance } from "../src/host/hub/hub";
import { tempHome, PAGE } from "./helpers";
import { accentColor, AION_CORAL, AION_SILVER, contrastOnBlack, hexToRgb, parseColor, particlePalette, SILVER_PALETTE } from "../src/core/colors";
import type { GeoMarker } from "../src/core/presentation";

type MapPresentation = Extract<HubSnapshot["presentation"], { kind: "map" }>;
const geoResolver = () => new VisualResolver({ env: {}, request: offline, imageProviders: [], terrainProviders: [] });
type Output = { presentation: { id: string; description: string } | null; markers?: { label: string; lat: number; lon: number; color: string }[]; colors?: { base: { hex: string; name: string }; accent: { hex: string } } };

test("Test C: the United States, then Los Angeles in red, New York in yellow — one map, markers changed in place", async () => {
  const aion = await connectAion({ resolver: geoResolver() });
  try {
    const shown = output<Output>(await aion.call("show_map", { region: "United States" }));
    assert.match(shown.presentation!.description, /^map: United States of America$/);
    const first = (await state(aion)).presentation as MapPresentation;
    assert.equal(first.route, "body");
    const la = output<Output>(await aion.call("mark_map", { add: [{ place: "Los Angeles", color: "red" }] }));
    assert.equal(la.markers?.[0].label, "Los Angeles");
    assert.equal(la.markers?.[0].color, parseColor("red")!.hex);
    assert.ok(Math.abs(la.markers![0].lat - 34.05) < 0.15 && Math.abs(la.markers![0].lon + 118.24) < 0.15);
    const ny = output<Output>(await aion.call("mark_map", { add: [{ place: "New York", color: "yellow" }] }));
    assert.deepEqual(ny.markers?.map(m => m.label), ["Los Angeles", "New York"], "multiple markers on the same map");
    let now = (await state(aion)).presentation as MapPresentation;
    assert.equal(now.id, first.id, "the map was not formed again");
    assert.equal(now.media.id, first.media.id);
    output(await aion.call("mark_map", { change: [{ place: "Los Angeles", color: "blue" }] }));
    output(await aion.call("mark_map", { remove: ["New York"] }));
    now = (await state(aion)).presentation as MapPresentation;
    assert.deepEqual(now.markers.map(m => [m.label, m.color]), [["Los Angeles", parseColor("blue")!.hex]]);
    assert.equal(now.id, first.id);
    // Default colour: the accent. Highlight. A place outside the view widens the map (a new one).
    output(await aion.call("mark_map", { add: [{ place: "Honolulu", highlight: true }] }));
    now = (await state(aion)).presentation as MapPresentation;
    assert.notEqual(now.id, first.id, "Honolulu needs a wider map");
    assert.equal(now.markers.find(m => m.label === "Honolulu")?.color, accentColor(AION_CORAL.hex));
    assert.equal(now.markers.find(m => m.label === "Honolulu")?.highlight, true);
    // Errors are clear and actionable.
    assert.match(text(await aion.call("mark_map", { add: [{ place: "Los Angeles", color: "blurple" }] })), /color-unknown: "blurple"/);
    assert.match(text(await aion.call("mark_map", { remove: ["Atlantis"] })), /No marker called "Atlantis"/);
    assert.match(text(await aion.call("mark_map", {})), /invalid-arguments/);
  } finally { await aion.close(); }
});

test("\"Show me Scotland and mark Glasgow in red\": a map with its marker at once; mark_map brings a map back if it has gone", async () => {
  const aion = await connectAion({ resolver: geoResolver() });
  try {
    const shown = output<Output>(await aion.call("show_map", { region: "Scotland", markers: [{ place: "Glasgow", color: "red" }] }));
    assert.ok(Math.abs(shown.markers![0].lat - 55.86) < 0.1 && Math.abs(shown.markers![0].lon + 4.25) < 0.1, "Glasgow, Scotland");
    output(await aion.call("clear_presentation"));
    assert.equal((await state(aion)).presentation, null);
    output(await aion.call("mark_map", { add: [{ place: "Edinburgh" }] }));
    const back = (await state(aion)).presentation as MapPresentation;
    assert.deepEqual(back.markers.map(m => m.label), ["Glasgow", "Edinburgh"], "the geographic context was kept");
    const fresh = await connectAion({ resolver: geoResolver() });
    try { assert.match(text(await fresh.call("mark_map", { add: [{ place: "Paris" }] })), /no-map/); } finally { await fresh.close(); }
  } finally { await aion.close(); }
});

test("markers: validated by the hub, replaced in place by the store, which holds the map a while longer", () => {
  const marker: GeoMarker = { id: "los-angeles", label: "Los Angeles", lat: 34.05, lon: -118.24, color: "#ff3b30" };
  assert.ok(hubCommandSchema.safeParse({ type: "markers", markers: [marker] }).success);
  for (const bad of [{ ...marker, lat: 91 }, { ...marker, color: "red" }, { ...marker, id: "Los Angeles!" }, { ...marker, label: "x".repeat(41) }]) {
    assert.equal(hubCommandSchema.safeParse({ type: "markers", markers: [bad] }).success, false, JSON.stringify(bad));
  }
  assert.equal(hubCommandSchema.safeParse({ type: "markers", markers: Array(13).fill(marker) }).success, false, "at most 12");
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const store = new PresenceStore({ now: () => now, schedule: (run, ms) => { const t = { at: now + ms, run }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1); }; } });
  assert.equal(store.setMarkers([marker]), false, "nothing on show");
  const media = { id: "m0123456789abcdef01", mime: "application/vnd.aion.map", bytes: 10 };
  const shown = store.present({ kind: "map", media, label: "USA", region: "United States", markers: [] });
  now = 50_000;
  assert.equal(store.setMarkers([marker]), true);
  const after = store.snapshot().presentation as MapPresentation;
  assert.equal(after.id, shown.id);
  assert.deepEqual(after.markers, [marker]);
  assert.ok(after.hold > shown.hold, "held longer: the user is working with it");
  const fire = (until: number) => { now = until; for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now && timers.includes(t)) { timers.splice(timers.indexOf(t), 1); t.run(); } };
  fire(50_000 + 55_000);
  assert.ok(store.snapshot().presentation, "still on show 55 s after the change");
  fire(50_000 + 62_000);
  assert.equal(store.snapshot().presentation, null);
});

// ── 5. Colours ───────────────────────────────────────────────────────────────────────────────────────────────

test("colours: names in English and Chinese, presets, validated hex; nonsense refused", () => {
  assert.equal(parseColor("blue")?.hex, "#3b82f6");
  assert.equal(parseColor("Blue")?.hex, "#3b82f6");
  assert.equal(parseColor("紫色")?.name, "purple");
  assert.equal(parseColor("Use #00BFFF".replace("Use ", ""))?.hex, "#00bfff");
  assert.equal(parseColor("#0bf")?.hex, "#00bbff");
  assert.equal(parseColor("warm golden")?.name, "warm gold");
  assert.equal(parseColor("red particles")?.name, "red");
  assert.equal(parseColor("light purple")?.name, "light purple");
  assert.equal(parseColor("aion silver")?.hex, AION_SILVER.hex);
  for (const bad of ["", "blurple", "#12345", "#ggg", "x".repeat(41), 42, null]) assert.equal(parseColor(bad), null, String(bad));
});

test("colours: Aion Silver is exactly the original palette; others keep the shading and stay visible on black", () => {
  assert.deepEqual(particlePalette(AION_SILVER.hex), SILVER_PALETTE);
  for (const words of ["blue", "purple", "red", "warm gold", "navy", "black", "#00BFFF", "green", "white"]) {
    const palette = particlePalette(parseColor(words)!.hex);
    for (const rgb of [palette.cool, palette.warm, palette.formed]) {
      assert.ok(rgb.every(c => c >= 0 && c <= 1));
      assert.ok(contrastOnBlack(rgb) >= 4.5, `${words} reads on black (${contrastOnBlack(rgb).toFixed(1)})`);
    }
    assert.ok(Math.max(...palette.formed) > 0.99, `${words}: formed visuals as bright as silver's`);
  }
  // The hue survives: blue stays blue, red stays red.
  const blue = particlePalette(parseColor("blue")!.hex).cool, red = particlePalette(parseColor("red")!.hex).cool;
  assert.ok(blue[2] > blue[0] + 0.3 && red[0] > red[2] + 0.3);
  assert.ok(contrastOnBlack(hexToRgb(accentColor("#111111"))) >= 4, "a black marker is lifted so it never vanishes");
});

test("Test E: blue, then purple, then back to Aion Silver — remembered across a restart of Aion", async () => {
  const home = tempHome();
  const aion = await connectAion({ home, resolver: geoResolver() });
  try {
    let shown = output<Output>(await aion.call("set_colors", { base: "blue" }));
    assert.equal(shown.colors?.base.name, "blue");
    shown = output<Output>(await aion.call("set_colors", { base: "紫色" }));
    assert.equal(shown.colors?.base.name, "purple");
    assert.equal((await state(aion)).appearance.base.hex, parseColor("purple")!.hex);
    assert.match(text(await aion.call("set_colors", { base: "blurple" })), /color-unknown/);
    assert.match(text(await aion.call("set_colors", {})), /invalid-arguments/);
    output(await aion.call("set_colors", { accent: "#00BFFF" }));
  } finally { await aion.close(); }
  // A new session (a new hub on the same data directory) remembers.
  assert.deepEqual(loadAppearance(home).base.name, "purple");
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE });
  assert.equal(hub.snapshot().appearance.base.name, "purple");
  assert.equal(hub.snapshot().appearance.accent.hex, "#00bfff");
  hub.apply({ type: "appearance", reset: "base" });
  assert.equal(hub.snapshot().appearance.base.hex, AION_SILVER.hex, "restored");
  assert.equal(hub.snapshot().appearance.accent.hex, "#00bfff", "the accent is its own choice");
  assert.equal(loadAppearance(home).base.hex, AION_SILVER.hex);
  await hub.stop();
  // A damaged file never breaks Aion: the defaults.
  assert.deepEqual(loadAppearance(tempHome()), { base: AION_SILVER, accent: AION_CORAL });
  assert.equal(hubCommandSchema.safeParse({ type: "appearance", base: { hex: "blue", name: "blue" } }).success, false, "the hub takes only validated colours");
});
