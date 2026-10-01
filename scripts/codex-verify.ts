import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { findCodex, MARKETPLACE_NAME, PLUGIN_ID } from "./lib/codex";
import { REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run codex:verify`: a clean installation from scratch, with the real Codex CLI, into a throwaway
 * CODEX_HOME (your own Codex configuration is never touched):
 *
 *   register this repo as a local marketplace → install Aion Presence → Codex lists its MCP server and its skill
 *   → the installed copy (Codex's plugin cache, no node_modules) runs: tools listed, Aion opened, a result
 *   presented, the companion page served, the installed hook forwarding a real event.
 */
const codex = findCodex();
if (!codex) { console.log("codex:verify: no Codex CLI found (install Codex or set CODEX_BIN); skipped"); process.exit(0); }
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? "✓" : "✗"} ${what}`); if (!ok) failures.push(what); };

const home = mkdtempSync(join(REPO_ROOT, ".e2e", "codex-home-"));
mkdirSync(join(REPO_ROOT, ".e2e"), { recursive: true });
writeFileSync(join(home, "config.toml"), "[features]\nplugins = true\nhooks = true\n");
const env = { ...process.env, CODEX_HOME: home, HOME: home };
const cx = (...args: string[]) => execFileSync(codex, args, { env, encoding: "utf8", cwd: home, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });

try {
  console.log(`Codex: ${cx("--version").trim()}  (isolated CODEX_HOME: ${home})`);
  execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "build.ts")], { stdio: "ignore", cwd: REPO_ROOT });

  console.log("install");
  cx("plugin", "marketplace", "add", REPO_ROOT);
  cx("plugin", "add", PLUGIN_ID);
  const listed = JSON.parse(cx("plugin", "list", "--json")) as { installed: { pluginId: string; installed: boolean; enabled: boolean; version: string }[] };
  const entry = listed.installed.find(item => item.pluginId === PLUGIN_ID);
  check(Boolean(entry?.installed && entry.enabled), `${PLUGIN_ID} is installed and enabled (v${entry?.version})`);
  const cache = join(home, "plugins", "cache", MARKETPLACE_NAME, "aion-presence", entry?.version ?? "");
  const files = existsSync(cache) ? readdirSync(cache) : [];
  check(["plugin.json", "mcp.json", "skills", "hooks", "assets", "runtime"].every(file => files.includes(file)), "the installed copy holds the whole package");
  check(!files.includes("node_modules") && !files.includes("src"), "and nothing from the repository besides it");

  console.log("discovery");
  const servers = JSON.parse(cx("mcp", "list", "--json")) as { name: string; enabled: boolean; transport: { command: string; args: string[]; env: Record<string, string>; cwd: string } }[];
  const server = servers.find(item => item.name === "aion-presence");
  check(Boolean(server?.enabled), "Codex lists the aion-presence MCP server");
  check(server?.transport.args[0] === join(cache, "runtime", "aion-mcp.mjs"), "its command runs the installed runtime");
  check(!JSON.stringify(server?.transport.env ?? {}).match(/OPENAI|API_KEY/), "with no API key in its environment");
  const prompt = spawnSync(codex, ["debug", "prompt-input", "Open Aion"], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  check(/aion-presence:aion-presence: Use Aion, the visual body of this Codex session/.test(prompt.stdout), "the aion-presence skill is in the model's skill list");

  console.log("the installed runtime");
  const transport = new StdioClientTransport({
    command: server!.transport.command, args: server!.transport.args, cwd: server!.transport.cwd,
    env: { ...getDefaultEnvironment(), ...server!.transport.env, AION_PRESENCE_BROWSER: "none" },
  });
  const client = new Client({ name: "codex-verify", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    check(tools.length === 9 && tools.includes("open_presence") && tools.includes("show_result"), `nine tools: ${tools.join(", ")}`);
    const opened = (await client.callTool({ name: "open_presence", arguments: { body: "figure" } })).structuredContent as { surface: { mode: string }; url?: string; body: string };
    check(opened.surface.mode === "companion" && opened.body === "figure", "open_presence: companion mode in a host without MCP Apps, as the figure");
    const page = await fetch(opened.url!);
    check(page.ok && (await page.text()).includes("<title>Aion</title>"), "the companion surface is served locally");
    const shown = (await client.callTool({ name: "show_result", arguments: { title: "Done", summary: "48 / 48 tests passed", status: "success" } })).structuredContent as { presentation: { kind: string } };
    check(shown.presentation.kind === "result", "show_result presents a result");
    const hook = spawnSync(process.execPath, [join(cache, "runtime", "aion-hook.mjs")], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }),
      env: { ...process.env, PLUGIN_DATA: server!.transport.env.PLUGIN_DATA, PLUGIN_ROOT: cache }, encoding: "utf8", timeout: 10_000,
    });
    check(hook.status === 0 && hook.stdout === "", "the installed hook exits 0 silently");
    const state = (await client.callTool({ name: "clear_presentation", arguments: {} })).structuredContent as { state: string; surface: { hooks: string } };
    check(state.state === "testing" && state.surface.hooks === "active", "the hook's event reached Aion (testing; hooks active)");
  } finally { await client.close(); }
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\n✓ Aion Presence installs as a local Codex plugin and runs from Codex's plugin cache");
process.exit(failures.length ? 1 : 0);
