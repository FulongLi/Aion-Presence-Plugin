/**
 * Tool metadata budget (v0.4.4). A host keeps every tool's name, description and schemas in its model's context, and
 * Codex budgets that per session: in v0.4.3 Aion's 29 tools carried 302 KB (a 7.9 KB output schema repeated on each),
 * and Codex silently kept only the first 21 in alphabetical order — show_stroke_animation, show_scene, show_text and
 * others vanished from some conversations. `TOOL_METADATA_*` measure the JSON a host receives from tools/list; since
 * v0.5.2 `CODEX_PLUGIN_*` measure what Codex actually charges, which is what decides whether a tool is exposed.
 */
/** Measured on tools/list. Codex's own measure differs (see `codexExposureReport`); both are held by the tests. */
export const TOOL_METADATA_BUDGET = { total: 64_000, perTool: 5_000 } as const;
/**
 * The bounds Aion's own tests hold it to: 10 % inside the budget until v0.6; v0.7 spends about 1.4 KB of that margin on
 * one compact `cad_model` tool (the FreeCAD backend; its details live in the Skill, not the metadata), leaving ≈ 8 %.
 */
export const TOOL_METADATA_TARGET = { total: 59_000, perTool: 4_500 } as const;

interface ListedTool { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; [key: string]: unknown }

export function toolMetadataReport(tools: readonly ListedTool[], budget: { total: number; perTool: number } = TOOL_METADATA_BUDGET) {
  const size = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
  const rows = tools.map(tool => ({
    name: tool.name, bytes: size(tool), description: size(tool.description), input: size(tool.inputSchema), output: size(tool.outputSchema),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const largest = Math.max(0, ...rows.map(row => row.bytes));
  const problems = [
    ...(total > budget.total ? [`${total} B in all > ${budget.total} B`] : []),
    ...rows.filter(row => row.bytes > budget.perTool).map(row => `${row.name} ${row.bytes} B > ${budget.perTool} B`),
  ];
  return { tools: rows, total, largest, ok: problems.length === 0, problems };
}

/**
 * Codex's own measure (v0.5.2). Codex 0.163 registers the MCP tools of *plugin-provided* servers against one shared budget
 * (`codex-rs/core/src/mcp_tool_exposure.rs`: `MAX_AGENT_PLUGIN_MCP_TOTAL_BYTES` 64,000, `..._SPEC_BYTES` 8,000 a tool),
 * in name order, and silently hides every tool after the first that does not fit — from the model's tool list and from
 * `ALL_TOOLS`, although `codex app-server` still lists it. Each tool is counted as the JSON of its model spec: a namespace
 * whose description is the server's `instructions` (cut at 1,000 B), wrapping the function — so the instructions are
 * counted once *per tool*. v0.4.4–v0.5.1 measured tools/list (57.6 KB) but Codex counted ≈ 89 KB and exposed 23 of 32
 * tools: `show_number`, `show_portrait`, `show_result`, `show_scene`, `show_stroke_animation`, `show_symbol`,
 * `show_terrain`, `show_text` and `show_visual_form` were hidden (docs/MCP-TOOLS.md).
 */
export const CODEX_PLUGIN_BUDGET = { total: 64_000, perTool: 8_000, description: 1_000, instructions: 1_000 } as const;
/**
 * What Aion's tests hold it to: 10 % inside Codex's budget, as v0.4.4 chose, for Codex's representation to change a
 * little; v0.7: ≈ 8 % (59,000 B), after one compact `cad_model` tool (docs/MCP-TOOLS.md).
 */
export const CODEX_PLUGIN_TARGET = { total: 59_000 } as const;

/** The keywords Codex keeps in a tool's input schema (codex-rs/tools/src/json_schema/types.rs); it drops the rest. */
const CODEX_SCHEMA_KEYS = new Set(["$ref", "type", "description", "enum", "items", "minItems", "properties", "required", "additionalProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions"]);
const cut = (text: string, bytes: number) => { const buffer = Buffer.from(text); return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString("utf8").replace(/�+$/, ""); };

/** A schema as Codex sends it to the model (codex-rs/tools/src/json_schema.rs `sanitize_json_schema`, without compaction). */
export function codexSchema(value: unknown): unknown {
  if (typeof value === "boolean") return { type: "string" };
  if (Array.isArray(value)) return value.map(codexSchema);
  if (!value || typeof value !== "object") return value;
  const map: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if ("const" in map) { map.enum = [map.const]; delete map.const; }
  const typed = map.type !== undefined;
  if (!typed && !("$ref" in map || "anyOf" in map || "oneOf" in map || "allOf" in map)) {
    if ("properties" in map || "required" in map || "additionalProperties" in map) map.type = "object";
    else if ("items" in map || "prefixItems" in map) map.type = "array";
    else if ("enum" in map || "format" in map) map.type = "string";
    else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some(key => key in map)) map.type = "number";
    else return {};
  }
  const types = ([] as unknown[]).concat(map.type ?? []);
  if (types.includes("object") && !map.properties) map.properties = {};
  if (types.includes("array") && !map.items) map.items = { type: "string" };
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(map)) {
    if (!CODEX_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" || key === "$defs" || key === "definitions") out[key] = Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([k, v]) => [k, codexSchema(v)]));
    else if (key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf" || (key === "additionalProperties" && typeof child !== "boolean")) out[key] = codexSchema(child);
    else out[key] = child;
  }
  return out;
}

/** A tool's description as Codex gives it to the model: with its plugin's name (codex-mcp `add_plugin_provenance_to_tool`). */
export function codexDescription(description = "", plugin = "Aion Presence") {
  const text = description.trim(), note = `This tool is part of plugin \`${plugin}\`.`;
  return !text ? note : /[.!?]$/.test(text) ? `${text} ${note}` : `${text}. ${note}`;
}

/** The bytes Codex charges one tool of a plugin's MCP server (`McpHandler::model_spec_bytes`). */
export function codexToolSpecBytes(tool: ListedTool, instructions = "", plugin = "Aion Presence", server = "aion_presence") {
  let fn: Record<string, unknown> = {
    type: "function", name: tool.name, description: cut(codexDescription(tool.description, plugin), CODEX_PLUGIN_BUDGET.description), strict: false,
    parameters: codexSchema({ ...(tool.inputSchema as object ?? {}), properties: (tool.inputSchema as { properties?: unknown } | undefined)?.properties ?? {} }),
  };
  if (Buffer.byteLength(JSON.stringify(fn)) > CODEX_PLUGIN_BUDGET.perTool) fn = { ...fn, parameters: { type: "object", properties: {}, additionalProperties: true } };
  const namespace = { type: "namespace", name: `mcp__${server}__`, description: cut(instructions, CODEX_PLUGIN_BUDGET.instructions).trim(), tools: [fn] };
  return Buffer.byteLength(JSON.stringify(namespace));
}

/**
 * Which tools Codex exposes to the model when Aion is the only plugin server ahead of them: the name-ordered prefix that
 * fits `CODEX_PLUGIN_BUDGET.total`. Another plugin whose server name sorts first would share the same budget.
 */
export function codexExposureReport(tools: readonly ListedTool[], instructions = "", budget: number = CODEX_PLUGIN_BUDGET.total) {
  const rows = tools.map(tool => ({ name: tool.name, bytes: codexToolSpecBytes(tool, instructions) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let used = 0, exposed = 0, stopped = false;
  for (const row of rows) {
    if (!stopped && row.bytes <= CODEX_PLUGIN_BUDGET.perTool && used + row.bytes <= budget) { used += row.bytes; exposed++; } else stopped = true;
  }
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const hidden = rows.slice(exposed).map(row => row.name);
  const truncated = tools.filter(tool => Buffer.byteLength(codexDescription(tool.description)) > CODEX_PLUGIN_BUDGET.description).map(tool => tool.name);
  return { tools: rows, total, exposed, hidden, truncated, ok: hidden.length === 0 && truncated.length === 0 };
}

/**
 * A tool input schema as it is listed, without the JSON Schema dialect line (`$schema`, about 60 bytes a tool): MCP
 * already defines 2020-12 as the dialect when it is absent, so nothing changes in meaning — v0.4.5's three card tools fit
 * in the budget this way. Validation is still the zod schema's own.
 */
export function compactSchema<T>(schema: T): T {
  const standard = (schema as { "~standard"?: { validate: unknown; vendor: string; version: number; jsonSchema?: { input(options: unknown): Record<string, unknown>; output(options: unknown): Record<string, unknown> } } })["~standard"];
  if (!standard?.jsonSchema) return schema;
  const json = standard.jsonSchema;
  const strip = (value: Record<string, unknown>) => { const { $schema: _dialect, ...rest } = value; return rest; };
  return { "~standard": { ...standard, validate: standard.validate, jsonSchema: { input: (options: unknown) => strip(json.input(options)), output: (options: unknown) => strip(json.output(options)) } } } as T;
}
