import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexToolInventory, findCodex, installedAionExposure } from "./lib/codex";
import { CODEX_PLUGIN_BUDGET, toolMetadataReport, TOOL_METADATA_BUDGET } from "../src/host/mcp/budget";
import { REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run codex:tools`: what your Codex receives from each MCP server — tool counts and metadata sizes — and whether every
 * Aion tool is there (read-only; it starts Codex's app server, which starts your configured MCP servers as Codex does).
 * v0.5.2: also the Aion version Codex runs against this checkout's, and how many Aion tools a *new conversation* gets —
 * Codex's app server lists every tool, but the model only gets those inside Codex's plugin budget.
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
  const checkout = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
  console.log(`\nversion: Codex runs Aion ${aion.version ?? "?"}; this checkout is ${checkout}${aion.version && aion.version !== checkout ? " — update the plugin, then start a new conversation" : ""}`);
  const ahead = servers.filter(server => server.pluginId && server.name < "aion-presence" && Object.keys(server.tools).length).map(server => server.name);
  if (ahead.length) console.log(`plugin servers ahead of Aion in Codex's shared plugin budget: ${ahead.join(", ")}`);
  const exposure = await installedAionExposure(codex, process.env).catch(error => { console.log(`exposure: the installed server could not be started (${String(error).slice(0, 120)})`); return null; });
  if (exposure) {
    const { report } = exposure;
    console.log(`exposure: Codex charges ${report.total} B of its ${CODEX_PLUGIN_BUDGET.total} B plugin budget (instructions ${exposure.instructions} B on each tool)`);
    console.log(report.hidden.length
      ? `  ✗ a new conversation gets ${report.exposed} of ${report.tools.length} Aion tools; hidden: ${report.hidden.join(", ")}`
      : `  ✓ a new conversation gets all ${report.tools.length} Aion tools${ahead.length ? " (if the servers above leave room)" : ""}`);
    if (report.truncated.length) console.log(`  descriptions Codex cuts at ${CODEX_PLUGIN_BUDGET.description} B: ${report.truncated.join(", ")}`);
  }
}
