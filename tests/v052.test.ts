import test from "node:test";
import assert from "node:assert/strict";
import { connectAion } from "./helpers";
import { codexDescription, codexExposureReport, codexSchema, codexToolSpecBytes, CODEX_PLUGIN_BUDGET, CODEX_PLUGIN_TARGET } from "../src/host/mcp/budget";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "../src/host/mcp/server";
import { TOOL_NAMES } from "../src/host/mcp/toolNames";

// v0.5.2: the terrain regression. Codex 0.163 charged every Aion tool its spec *plus* the server's instructions (cut at
// 1,000 B) against the 64,000-byte plugin budget, and hid the nine tools after show_music — show_terrain among them.

test("codex measure: reproduces the v0.5.1 cut observed in real Codex sessions (23 of 32, show_terrain hidden)", async () => {
  const aion = await connectAion();
  try {
    const { tools } = await aion.client.listTools();
    // v0.5.1's instructions were 1,267 B; Codex keeps 1,000 B of them on every tool, whatever they say.
    const before = codexExposureReport(tools, "x".repeat(1_267));
    assert.equal(before.exposed, 23);
    assert.equal(before.hidden[0], "show_number");
    assert.ok(before.hidden.includes("show_terrain") && before.hidden.includes("show_portrait") && before.hidden.includes("show_stroke_animation"));
  } finally { await aion.close(); }
});

test("codex measure: every Aion tool is exposed, 10 % inside Codex's plugin budget, no description cut", async () => {
  const aion = await connectAion();
  try {
    const { tools } = await aion.client.listTools();
    const instructions = aion.client.getInstructions() ?? "";
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.ok(Buffer.byteLength(instructions) <= 120, `instructions ${Buffer.byteLength(instructions)} B: Codex repeats them on every tool`);
    const report = codexExposureReport(tools, instructions);
    assert.deepEqual(report.hidden, []);
    assert.equal(report.exposed, TOOL_NAMES.length);
    assert.deepEqual(report.truncated, [], "Codex cuts a plugin tool's description at 1,000 B");
    assert.ok(report.total <= CODEX_PLUGIN_TARGET.total, `${report.total} B > ${CODEX_PLUGIN_TARGET.total} B`);
    for (const row of report.tools) assert.ok(row.bytes <= CODEX_PLUGIN_BUDGET.perTool, row.name);
  } finally { await aion.close(); }
});

test("codex measure: follows Codex's representation (plugin note, kept schema keywords, namespace wrapper)", () => {
  assert.equal(codexDescription("Show it."), "Show it. This tool is part of plugin `Aion Presence`.");
  assert.equal(codexDescription("Show it"), "Show it. This tool is part of plugin `Aion Presence`.");
  assert.deepEqual(codexSchema({ type: "object", properties: { a: { type: "string", minLength: 1, maxLength: 9, default: "x" }, b: { const: "k" }, c: { type: "array" } }, additionalProperties: false, $schema: "x" }),
    { type: "object", properties: { a: { type: "string" }, b: { enum: ["k"], type: "string" }, c: { type: "array", items: { type: "string" } } }, additionalProperties: false });
  const tool = { name: "t", description: "d.", inputSchema: { type: "object", properties: {} } };
  const plain = JSON.stringify({ type: "namespace", name: "mcp__aion_presence__", description: "", tools: [{ type: "function", name: "t", description: codexDescription("d."), strict: false, parameters: { type: "object", properties: {} } }] });
  assert.equal(codexToolSpecBytes(tool), Buffer.byteLength(plain));
  assert.equal(codexToolSpecBytes(tool, "y".repeat(5_000)) - codexToolSpecBytes(tool), CODEX_PLUGIN_BUDGET.instructions);
});

test("show_form: its catalogue of form ids reaches Codex whole", () => {
  const description = codexDescription(TOOL_DESCRIPTIONS.show_form());
  assert.ok(Buffer.byteLength(description) <= CODEX_PLUGIN_BUDGET.description, `${Buffer.byteLength(description)} B`);
  assert.match(description, /music\.\{treble-clef,.*common-time\}/);
});

test("terrain failures say which stage failed, with the stable code first", async () => {
  const { VisualResolver } = await import("../src/host/resolver");
  const { errorDetail } = await import("../src/visual/errors");
  const { terrainCause } = await import("../src/host/mcp/server");
  const failing = (message: string) => new VisualResolver({ terrainProviders: [{ name: "t", resolve: async () => { throw new Error(message); } }] });
  for (const [code, cause] of [["timeout", /timed out/], ["network", /could not be reached/], ["http-503", /HTTP 503/], ["terrain-tile-invalid", /tile was invalid/], ["png-invalid", /tile was invalid/]] as const) {
    const error = await failing(code).terrain("Wales").catch(e => e);
    assert.match(String(error.message), /^terrain-unavailable$/);
    assert.equal(errorDetail(error), code);
    assert.match(terrainCause(errorDetail(error))!, cause);
  }
  assert.equal(terrainCause(undefined), null);
  assert.equal(terrainCause("error"), null);
  // The MCP result: the code a model can act on, the stage for whoever reads the log, nothing else.
  const aion = await connectAion({ resolver: failing("http-503") });
  try {
    const out = await aion.call("show_terrain", { region: "Wales" });
    assert.ok(out.isError);
    assert.match((out.content as { text: string }[])[0].text, /^terrain-unavailable: elevation data for Wales could not be loaded right now \(the elevation service answered HTTP 503\)\. Describe the terrain in words\.$/);
  } finally { await aion.close(); }
});
