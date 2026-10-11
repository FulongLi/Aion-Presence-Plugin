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
