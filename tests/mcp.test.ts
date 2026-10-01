import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { APP_TOOL_NAMES, PRESENCE_RESOURCE_URI, presenceOutput, TOOL_NAMES } from "../src/host/mcp/server";
import { decideSurface } from "../src/host/surface";
import { connectAion, MCP_APPS_CAPABILITIES, PNG } from "./helpers";

type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
const text = (result: unknown) => (result as Result).content.map(item => item.text ?? "").join("");
const structured = (result: unknown) => presenceOutput.parse((result as Result).structuredContent);

test("a host without MCP Apps sees exactly the nine Aion tools, each with schemas and honest annotations", async () => {
  const aion = await connectAion();
  try {
    const { tools } = await aion.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 80, `${tool.name} has a precise description`);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, `${tool.name} rejects unknown fields`);
      assert.ok(tool.outputSchema, `${tool.name} declares its structured output`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} touches nothing outside this machine`);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    const open = tools.find(tool => tool.name === "open_presence")!;
    assert.equal((open._meta as { ui: { resourceUri: string } }).ui.resourceUri, PRESENCE_RESOURCE_URI);
    assert.match(open.description!, /not another AI model/);
    assert.match(tools.find(tool => tool.name === "set_presence_state")!.description!, /Never call it for every small step/);
  } finally { await aion.close(); }
});

test("an MCP Apps host also gets the app-only sync tools and the presence resource", async () => {
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  try {
    const { tools } = await aion.client.listTools();
    for (const name of APP_TOOL_NAMES) {
      const tool = tools.find(item => item.name === name);
      assert.ok(tool, name);
      assert.deepEqual((tool!._meta as { ui: { visibility: string[] } }).ui.visibility, ["app"], `${name} is hidden from the model`);
    }
    const resource = await aion.client.readResource({ uri: PRESENCE_RESOURCE_URI });
    const content = resource.contents[0] as { mimeType: string; text: string };
    assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
    assert.match(content.text, /Aion Presence/);
    const sync = await aion.call("presence_sync", { after_revision: -1 });
    assert.equal(typeof (sync as Result).structuredContent?.revision, "number");
  } finally { await aion.close(); }
});

test("host capability fallback: embedded only when the host declares MCP Apps; never faked", () => {
  assert.equal(decideSurface(MCP_APPS_CAPABILITIES, "auto", {}).mode, "embedded");
  assert.deepEqual(decideSurface({}, "auto", {}), { mode: "companion", embeddedSupported: false, reason: "host-without-mcp-apps" });
  assert.equal(decideSurface(undefined, "auto", {}).mode, "companion");
  assert.equal(decideSurface({ extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } } } as never, "auto", {}).mode, "companion", "the MCP App type must be declared");
  assert.equal(decideSurface(MCP_APPS_CAPABILITIES, "companion", {}).mode, "companion", "a companion window can always be asked for");
  assert.equal(decideSurface(MCP_APPS_CAPABILITIES, "auto", { AION_PRESENCE_SURFACE: "companion" }).mode, "companion");
  assert.equal(decideSurface({}, "auto", { AION_PRESENCE_SURFACE: "embedded" }).mode, "companion", "an override cannot invent host support");
});

test("open_presence in a host without MCP Apps opens the companion window, once, with a greeting", async () => {
  const aion = await connectAion();
  try {
    const first = structured(await aion.call("open_presence", { body: "figure" }));
    assert.equal(first.surface.mode, "companion");
    assert.equal(first.window_opened, true);
    assert.equal(first.body, "figure");
    assert.match(first.url!, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{48}$/);
    assert.deepEqual(aion.opened, [first.url]);
    const hub = await aion.link.run(backend => backend.state());
    assert.equal(hub.gesture?.name, "greeting");
    assert.equal(hub.hub.display, "auto");
  } finally { await aion.close(); }
});

test("open_presence in an MCP Apps host stays embedded and records the fullscreen request", async () => {
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  try {
    const result = structured(await aion.call("open_presence", { display: "fullscreen" }));
    assert.equal(result.surface.mode, "embedded");
    assert.equal(result.window_opened, false);
    assert.equal(result.fullscreen, "requested");
    assert.deepEqual(aion.opened, [], "no extra window when the host embeds Aion");
    assert.equal((await aion.link.run(backend => backend.state())).hub.display, "fullscreen");
  } finally { await aion.close(); }
});

test("state, body, forms, text and results produce structured output and update the shared presence", async () => {
  const aion = await connectAion();
  try {
    let output = structured(await aion.call("set_presence_state", { state: "testing", label: "  npm   test " }));
    assert.equal(output.state, "testing");
    output = structured(await aion.call("set_body_form", { body: "figure" }));
    assert.equal(output.body, "figure");
    output = structured(await aion.call("show_visual_form", { form: "Big Dipper" }));
    assert.equal(output.presentation?.kind, "form");
    assert.match(output.presentation!.description, /Ursa Major/);
    output = structured(await aion.call("show_visual_form", { form: "bagua", variant: "later heaven bagua" }));
    assert.match(output.presentation!.description, /Later Heaven/);
    output = structured(await aion.call("show_text", { text: "48/48" }));
    assert.equal(output.presentation?.kind, "text");
    output = structured(await aion.call("show_result", { title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed", "Build successful"] }));
    assert.equal(output.presentation?.kind, "result");
    assert.equal(output.presentation?.hold_seconds, 16);
    assert.equal(output.body, "figure", "the persistent body is unchanged by a presentation");
    const state = await aion.link.run(backend => backend.state());
    assert.deepEqual(state.presentation && state.presentation.kind === "result" && state.presentation.details, ["8 files changed", "Build successful"]);
    assert.equal(state.activity.label, "npm test");
    output = structured(await aion.call("clear_presentation"));
    assert.equal(output.presentation, null);
  } finally { await aion.close(); }
});

test("tool input validation rejects unknown states, fields, oversize text and unknown forms", async () => {
  const aion = await connectAion();
  try {
    const rejected = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
      const result = await aion.call(name, args) as Result;
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args).slice(0, 60)}`);
      assert.match(text(result), pattern);
    };
    await rejected("set_presence_state", { state: "dancing" }, /state/);
    await rejected("set_presence_state", { state: "idle", mood: "happy" }, /Unrecognized key|mood/);
    await rejected("set_body_form", { body: "dragon" }, /body/);
    await rejected("show_text", { text: "x".repeat(700) }, /600/);
    await rejected("show_text", { text: "   " }, /text/);
    await rejected("show_result", { title: "t", summary: "s", details: Array(9).fill("d") }, /details|8/);
    await rejected("show_visual_form", { form: "dragon" }, /form-not-found/);
    await rejected("show_visual_form", { form: "orion", variant: "rainbow" }, /variant-not-found: astronomy\.orion has the variants lines, stars/);
    await rejected("show_artifact", { type: "code", title: "Patch" }, /content-required/);
    await rejected("show_artifact", { type: "svg", title: "Diagram", content: "<script>alert(1)</script>" }, /svg-invalid/);
  } finally { await aion.close(); }
});

test("images come only from local files or data URLs and are checked by their bytes", async () => {
  const aion = await connectAion();
  try {
    const file = join(aion.home, "diagram.png");
    writeFileSync(file, PNG);
    let output = structured(await aion.call("show_image", { source: file, alt: "A diagram", mode: "framed" }));
    assert.equal(output.presentation?.kind, "image");
    const state = await aion.link.run(backend => backend.state());
    const media = state.presentation?.kind === "image" ? state.presentation.media : null;
    assert.equal(media?.mime, "image/png");
    assert.deepEqual((await aion.link.run(backend => backend.media(media!.id)))?.data, PNG);
    output = structured(await aion.call("show_image", { source: `data:image/png;base64,${PNG.toString("base64")}` }));
    assert.equal(output.presentation?.kind, "image");
    for (const [source, code] of [["https://example.com/a.png", "remote-image-not-supported"], ["relative/a.png", "image-path-not-absolute"],
      [join(aion.home, "missing.png"), "image-not-found"], ["data:text/html;base64,PGI+", "image-invalid"]] as const) {
      const result = await aion.call("show_image", { source }) as Result;
      assert.equal(result.isError, true, source);
      assert.match(text(result), new RegExp(code));
    }
    const fake = join(aion.home, "fake.png");
    writeFileSync(fake, "<html>not an image at all</html>");
    assert.match(text(await aion.call("show_image", { source: fake })), /image-invalid/);
  } finally { await aion.close(); }
});

test("artifacts: code excerpts, file changes and SVG diagrams", async () => {
  const aion = await connectAion();
  try {
    let output = structured(await aion.call("show_artifact", { type: "code", title: "The new guard", language: "TypeScript", content: "\nif (!ok) {\n  return;\n}\n" }));
    let state = await aion.link.run(backend => backend.state());
    assert.equal(state.presentation?.kind === "artifact" && state.presentation.content, "if (!ok) {\n  return;\n}");
    assert.equal(state.presentation?.kind === "artifact" && state.presentation.language, "typescript");
    output = structured(await aion.call("show_artifact", { type: "changes", title: "8 files changed", changes: [{ path: "src/a.ts", change: "modified", additions: 12, deletions: 3 }] }));
    assert.equal(output.presentation?.kind, "artifact");
    output = structured(await aion.call("show_artifact", { type: "svg", title: "Architecture", content: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10'/></svg>" }));
    state = await aion.link.run(backend => backend.state());
    assert.equal(state.presentation?.kind === "artifact" && state.presentation.media?.mime, "image/svg+xml");
  } finally { await aion.close(); }
});
