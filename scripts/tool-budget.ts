import { connectAion } from "../tests/helpers";
import { toolMetadataReport, TOOL_METADATA_BUDGET } from "../src/host/mcp/budget";

/**
 * `npm run mcp:budget`: how much tool metadata Aion asks a host to carry (v0.4.4). Codex budgets tool metadata per
 * session and silently drops what does not fit (docs/MCP-TOOLS.md), so this must stay well inside the budget.
 */
const aion = await connectAion();
try {
  const { tools } = await aion.client.listTools();
  const report = toolMetadataReport(tools);
  for (const tool of report.tools) console.log(`${tool.name.padEnd(24)} ${String(tool.bytes).padStart(6)} B  (description ${tool.description}, input ${tool.input}${tool.output ? `, output ${tool.output}` : ""})`);
  console.log(`\n${report.tools.length} tools · ${report.total} B in all (budget ${TOOL_METADATA_BUDGET.total} B; largest ${report.largest} B of ${TOOL_METADATA_BUDGET.perTool} B)`);
  if (!report.ok) { console.error(`over budget: ${report.problems.join("; ")}`); process.exitCode = 1; }
} finally { await aion.close(); }
