/**
 * Tool metadata budget (v0.4.4). A host keeps every tool's name, description and schemas in its model's context, and
 * Codex budgets that per session: in v0.4.3 Aion's 29 tools carried 302 KB (a 7.9 KB output schema repeated on each),
 * and Codex silently kept only the first 21 in alphabetical order — show_stroke_animation, show_scene, show_text and
 * others vanished from some conversations. Aion now stays far inside any such budget; tests and `npm run mcp:budget`
 * hold it there. Measured as the JSON a host receives from tools/list.
 */
/** Measured on tools/list; a host's own representation adds a little (Codex's: about 2 %), so these leave room for it. */
export const TOOL_METADATA_BUDGET = { total: 64_000, perTool: 5_000 } as const;
/** The bounds Aion's own tests hold it to: 10 % inside the budget. */
export const TOOL_METADATA_TARGET = { total: 57_600, perTool: 4_500 } as const;

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
