import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/pluginPackage";
import type { HubSnapshot } from "../src/host/hub/protocol";
import { hubCommandSchema } from "../src/host/hub/protocol";
import { VisualResolver } from "../src/host/resolver";
import type { ImageProvider } from "../src/host/resolver/types";
import { decodeHeightField } from "../src/visual/heightfield";
import { planPresentation } from "../src/core/presentation";
import { connectAion } from "./helpers";

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
type Output = { presentation: { kind: string; description: string } | null; shown?: string; source?: { provider: string } };
const text = (result: unknown) => (result as Result).content.map(item => item.text).join(" ");
const output = (result: unknown) => {
  assert.equal((result as Result).isError, undefined, text(result));
  return (result as Result).structuredContent as unknown as Output;
};
const state = (aion: Awaited<ReturnType<typeof connectAion>>) => aion.link.run(backend => backend.state()) as Promise<HubSnapshot>;

/** A JPEG header of the given size: enough for the server-side checks. */
const JPEG = (width: number, height: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)]);
const wikipedia = (queries: string[]): ImageProvider => ({
  name: "wikipedia",
  async search(query) {
    queries.push(query);
    return /nobody/i.test(query) ? [] : [{
      provider: "wikipedia", url: "https://upload.wikimedia.org/x.jpg", title: query, relevance: 1, width: 900, height: 1200, mime: "image/jpeg",
      pageUrl: `https://en.wikipedia.org/wiki/${query.replace(/ /g, "_")}`, license: "free (Wikimedia Commons)",
      load: async () => ({ bytes: JPEG(900, 1200), mime: "image/jpeg" }),
    }];
  },
});
/** A height field for any region but Narnia. */
const terrain = {
  name: "test-elevation",
  async resolve(region: string) {
    if (region === "Narnia") throw new Error("region-not-found");
    const width = 30, height = 24, values = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = 50 + 1300 * Math.exp(-((x - 12) ** 2 + (y - 10) ** 2) / 40);
    return { provider: "test-elevation", kind: "elevation" as const, width, height, values, aspect: 1.2, label: region };
  },
};
const resolver = (queries: string[] = []) => new VisualResolver({
  env: {}, assetsDir: join(PLUGIN_ROOT, "assets"), imageProviders: [wikipedia(queries)], terrainProviders: [terrain],
});

test("show_portrait finds the person and presents a portrait-framed picture, with its source", async () => {
  const queries: string[] = [];
  const aion = await connectAion({ resolver: resolver(queries) });
  try {
    const shown = output(await aion.call("show_portrait", { person: "  Nikola   Tesla " }));
    assert.deepEqual(queries, ["Nikola Tesla"], "only the tidied name is looked up");
    assert.equal(shown.presentation?.description, "portrait: Nikola Tesla");
    assert.equal(shown.shown, "Nikola Tesla");
    assert.equal(shown.source?.provider, "wikipedia");
    const snapshot = await state(aion);
    assert.equal(snapshot.presentation?.kind, "image");
    const presentation = snapshot.presentation as Extract<HubSnapshot["presentation"], { kind: "image" }>;
    assert.equal(presentation.fit, "portrait", "the surface frames it with SCF's portrait crop and sampling");
    assert.equal(presentation.hold, 14);
    assert.equal(presentation.credit, "Wikipedia · free (Wikimedia Commons)");
    assert.deepEqual(planPresentation(presentation).body, { type: "image", media: presentation.media, fit: "portrait" });
    const missing = await aion.call("show_portrait", { person: "Nobody Atall" }) as Result;
    assert.equal(missing.isError, true);
    assert.match(text(missing), /portrait-not-found: no public portrait of Nobody Atall was found/);
    for (const person of ["<script>", "Tesla http://x.y", "x".repeat(61)]) assert.equal((await aion.call("show_portrait", { person }) as Result).isError, true, person);
  } finally { await aion.close(); }
});

test("show_image takes exactly one of a lookup query or a local source; intents choose framing", async () => {
  const aion = await connectAion({ resolver: resolver() });
  try {
    const car = output(await aion.call("show_image", { query: "Tesla Model Y", intent: "vehicle" }));
    assert.equal(car.presentation?.kind, "image");
    assert.equal(((await state(aion)).presentation as { fit: string }).fit, "object");
    output(await aion.call("show_image", { query: "Albert Einstein", intent: "portrait" }));
    assert.equal(((await state(aion)).presentation as { fit: string }).fit, "portrait");
    const logo = output(await aion.call("show_image", { query: "Spirit Connect logo" }));
    assert.equal(logo.shown, "Spirit Connect");
    const presented = (await state(aion)).presentation as { fit: string; media: { mime: string } };
    assert.equal(presented.fit, "logo");
    assert.equal(presented.media.mime, "image/svg+xml");
    for (const args of [{}, { query: "Eiffel Tower", source: "/tmp/a.png" }]) {
      assert.match(text(await aion.call("show_image", args)), /exactly one of query .* or source/);
    }
    for (const query of ["https://example.com/x.png", "<img src=x>", "javascript:alert(1)"]) {
      assert.equal((await aion.call("show_image", { query }) as Result).isError, true, query);
    }
  } finally { await aion.close(); }
});

test("show_terrain resolves real elevation into a height field the surface can sample", async () => {
  const aion = await connectAion({ resolver: resolver() });
  try {
    const scotland = output(await aion.call("show_terrain", { region: "Scotland", style: "topography" }));
    assert.equal(scotland.presentation?.description, "terrain: Scotland");
    assert.match(scotland.shown!, /^Scotland \(elevation \d+–\d+ m\)$/);
    const snapshot = await state(aion);
    const presentation = snapshot.presentation as Extract<HubSnapshot["presentation"], { kind: "terrain" }>;
    assert.equal(presentation.style, "topography");
    assert.equal(presentation.media.mime, "application/vnd.aion.heightfield");
    const bytes = await aion.link.run(backend => backend.media(presentation.media.id));
    const field = decodeHeightField(new Uint8Array(bytes!.data));
    assert.ok(field.width > 2 && field.relief > 0.5);
    assert.match(text(await aion.call("show_terrain", { region: "Narnia" })), /region-not-found: no place called "Narnia"/);
  } finally { await aion.close(); }
});

test("clock, number, symbol and emoji are drawn locally, with SCF's validation", async () => {
  const aion = await connectAion({ now: () => new Date(2026, 9, 1, 9, 5) });
  try {
    const clock = output(await aion.call("show_clock", {}));
    assert.match(clock.shown!, /^09:05 \(local time, .+\)$/, "the result tells Codex the local time so it can say it");
    assert.equal(clock.presentation?.description, "clock: 09:05");
    assert.equal(output(await aion.call("show_clock", { time: "3:42 PM" })).presentation?.description, "clock: 15:42");
    assert.equal((await aion.call("show_clock", { time: "25:99" }) as Result).isError, true);
    for (const value of ["42%", "£28,000", "23°C", "3.14", "-7"]) assert.equal(output(await aion.call("show_number", { value })).presentation?.description, `number: ${value}`);
    for (const value of ["forty-two", "1234567890123", "<b>1</b>"]) assert.equal((await aion.call("show_number", { value }) as Result).isError, true, value);
    assert.deepEqual(planPresentation({ kind: "number", value: "42%" }).body, { type: "text", text: "42%" });
    output(await aion.call("show_symbol", { symbol: "heart" }));
    assert.deepEqual(planPresentation((await state(aion)).presentation!).body, { type: "form", form: "symbol.heart" });
    assert.equal((await aion.call("show_symbol", { symbol: "skull" }) as Result).isError, true);
    for (const emoji of ["🎉", "👍🏻", "👨‍🚀", "🇬🇧", "❤️"]) assert.equal(output(await aion.call("show_emoji", { emoji })).presentation?.description, `emoji: ${emoji}`);
    for (const emoji of ["😊😂", "hello", "1", "<b>", ""]) assert.equal((await aion.call("show_emoji", { emoji }) as Result).isError, true, emoji);
  } finally { await aion.close(); }
});

test("show_form names what it found; show_visual_form still works for older clients", async () => {
  const aion = await connectAion();
  try {
    assert.equal(output(await aion.call("show_form", { form: "猎户座" })).shown, "Orion (constellation)");
    assert.equal(output(await aion.call("show_form", { form: "yin yang" })).presentation?.description, "form: Yin-yang ☯ (太极)");
    assert.equal(output(await aion.call("show_visual_form", { form: "Leo zodiac sign" })).presentation?.description, "form: Leo ♌ (zodiac sign)");
    assert.match(text(await aion.call("show_form", { form: "dragon" })), /form-not-found/);
  } finally { await aion.close(); }
});

test("the hub re-validates the new presentation kinds, whoever sends them", () => {
  const media = { id: `m${"a".repeat(18)}`, mime: "image/jpeg", bytes: 10 };
  const ok = (content: unknown) => hubCommandSchema.safeParse({ type: "present", content }).success;
  assert.ok(ok({ kind: "image", media, mode: "particles", fit: "portrait", alt: "Nikola Tesla", credit: "Wikipedia" }));
  assert.ok(ok({ kind: "terrain", media: { ...media, mime: "application/vnd.aion.heightfield" }, style: "relief", label: "Wales" }));
  assert.ok(ok({ kind: "clock", time: "09:05" }) && ok({ kind: "number", value: "42%" }) && ok({ kind: "symbol", symbol: "star" }) && ok({ kind: "emoji", emoji: "🚀" }));
  assert.ok(!ok({ kind: "terrain", media, style: "relief", label: "Wales" }), "a terrain must be a height field");
  assert.ok(!ok({ kind: "image", media, mode: "particles", fit: "sticker" }));
  assert.ok(!ok({ kind: "clock", time: "9:5" }) && !ok({ kind: "emoji", emoji: "two 🚀🚀" }) && !ok({ kind: "symbol", symbol: "skull" }));
});

test("open_presence: a greeting is due once per newly opened Presence, never while Aion is already showing", async () => {
  const { MCP_APPS_CAPABILITIES } = await import("./helpers");
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  try {
    type Opened = { greeting: { due: boolean; line?: string; line_zh?: string }; message: string };
    const first = (await aion.call("open_presence", {}) as Result).structuredContent as unknown as Opened;
    assert.equal(first.greeting.due, true);
    assert.match(first.greeting.line!, /^Hi, I'm Aion, an interactive AI presence created by Spirit Connect/);
    assert.match(first.greeting.line_zh!, /我是 Aion/);
    assert.match(first.message, /A greeting is due/);
    assert.equal((await state(aion)).gesture?.name, "greeting", "the body waves");
    const gesture = (await state(aion)).gesture!.id;
    // The embedded view is now showing Aion (it syncs through the host).
    await aion.call("presence_sync", { after_revision: -1 });
    const again = (await aion.call("open_presence", {}) as Result).structuredContent as unknown as Opened;
    assert.equal(again.greeting.due, false);
    assert.equal((await state(aion)).gesture!.id, gesture, "no second wave");
  } finally { await aion.close(); }
});
