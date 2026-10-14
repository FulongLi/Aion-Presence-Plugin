/**
 * Tool metadata budget (v0.4.4). A host keeps every tool's name, description and schemas in its model's context, and
 * Codex budgets that per session: in v0.4.3 Aion's 29 tools carried 302 KB (a 7.9 KB output schema repeated on each),
 * and Codex silently kept only the first 21 in alphabetical order — show_stroke_animation, show_scene, show_text and
 * others vanished from some conversations. Aion now stays far inside any such budget; tests and `npm run mcp:budget`
 * hold it there. Measured as the JSON a host receives from tools/list.
 */
export const TOOL_METADATA_BUDGET = { total: 64_000, perTool: 5_000 } as const;

interface ListedTool { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; [key: string]: unknown }

export function toolMetadataReport(tools: readonly ListedTool[], budget = TOOL_METADATA_BUDGET) {
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
