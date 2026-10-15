import { codexToolInventory, findCodex } from "./lib/codex";
import { toolMetadataReport, TOOL_METADATA_BUDGET } from "../src/host/mcp/budget";

/**
 * `npm run codex:tools`: what your Codex receives from each MCP server — tool counts and metadata sizes — and whether every
 * Aion tool is there (read-only; it starts Codex's app server, which starts your configured MCP servers as Codex does).
 * See docs/MCP-TOOLS.md for how to read it.
 */
const codex = findCodex();
if (!codex) { console.log("codex:tools: no Codex CLI found (set CODEX_BIN)"); process.exit(0); }
const servers = await codexToolInventory(codex, process.env);
for (const server of servers) {
  const tools = Object.entries(server.tools).map(([name, tool]) => ({ name, ...tool }));
  const report = toolMetadataReport(tools);
  console.log(`${server.name.padEnd(28)} ${String(tools.length).padStart(4)} tools ${String(report.total).padStart(9)} B`);
}
const aion = servers.find(server => server.name === "aion-presence");
if (!aion) console.log("\naion-presence: not listed — the plugin is not installed or enabled, or its server failed to start");
else {
  const report = toolMetadataReport(Object.entries(aion.tools).map(([name, tool]) => ({ name, ...tool })));
  console.log(`\naion-presence: ${report.tools.length} tools, ${report.total} B of metadata (budget ${TOOL_METADATA_BUDGET.total} B)${report.ok ? "" : ` — over budget: ${report.problems.join("; ")}`}`);
  console.log(report.tools.map(tool => tool.name).join(", "));
}
