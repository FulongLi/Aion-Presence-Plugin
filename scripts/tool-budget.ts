import { connectAion } from "../tests/helpers";
import { codexExposureReport, CODEX_PLUGIN_BUDGET, CODEX_PLUGIN_TARGET, toolMetadataReport, TOOL_METADATA_BUDGET } from "../src/host/mcp/budget";

/**
 * `npm run mcp:budget`: how much tool metadata Aion asks a host to carry (v0.4.4), and — since v0.5.2 — what Codex
 * itself charges for it. Codex counts each plugin tool as its model spec (the server's instructions included, once per
 * tool) against a 64,000-byte budget shared by plugin servers, and silently hides the tools after the first that does
 * not fit (docs/MCP-TOOLS.md). Both measures must stay inside their budgets.
 */
const aion = await connectAion();
try {
  const { tools } = await aion.client.listTools();
  const instructions = aion.client.getInstructions() ?? "";
  const report = toolMetadataReport(tools);
  const codex = codexExposureReport(tools, instructions);
  const codexBytes = new Map(codex.tools.map(tool => [tool.name, tool.bytes]));
  for (const tool of report.tools) console.log(`${tool.name.padEnd(24)} ${String(tool.bytes).padStart(6)} B  (description ${tool.description}, input ${tool.input}${tool.output ? `, output ${tool.output}` : ""}; Codex ${codexBytes.get(tool.name)} B)`);
  console.log(`\n${report.tools.length} tools · ${report.total} B in all on tools/list (budget ${TOOL_METADATA_BUDGET.total} B; largest ${report.largest} B of ${TOOL_METADATA_BUDGET.perTool} B)`);
  console.log(`Codex's measure: ${codex.total} B of ${CODEX_PLUGIN_BUDGET.total} B (target ${CODEX_PLUGIN_TARGET.total} B; instructions ${Buffer.byteLength(instructions)} B, counted on each tool)`);
  console.log(codex.hidden.length ? `Codex exposes ${codex.exposed} of ${codex.tools.length}; hidden: ${codex.hidden.join(", ")}` : `Codex exposes all ${codex.tools.length} tools`);
  if (codex.truncated.length) console.log(`descriptions Codex cuts at ${CODEX_PLUGIN_BUDGET.description} B: ${codex.truncated.join(", ")}`);
  if (!report.ok) { console.error(`over budget: ${report.problems.join("; ")}`); process.exitCode = 1; }
  if (!codex.ok || codex.total > CODEX_PLUGIN_TARGET.total) { console.error("over Codex's plugin budget or target"); process.exitCode = 1; }
} finally { await aion.close(); }
