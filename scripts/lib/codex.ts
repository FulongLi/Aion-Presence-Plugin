import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** The Codex CLI: CODEX_BIN, `codex` on PATH, or the one bundled with the ChatGPT desktop app on macOS. */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.CODEX_BIN, "codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (candidate.includes("/") && !existsSync(candidate)) continue;
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 15_000 });
      return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

/** The marketplace this repository publishes (.agents/plugins/marketplace.json), and the plugin's id in it. */
export const MARKETPLACE_NAME = "spirit-connect";
export const PLUGIN_ID = `aion-presence@${MARKETPLACE_NAME}`;
/** v0.1 registered the repository under this name; installers remove it so the two never coexist. */
export const LEGACY_MARKETPLACE = "aion-presence-dev";
export const LEGACY_PLUGIN_ID = `aion-presence@${LEGACY_MARKETPLACE}`;

/**
 * What Codex's own MCP layer receives from each server (v0.4.4): `codex app-server` → `mcpServerStatus/list`, read-only.
 * Used by codex:verify (in an isolated CODEX_HOME) and `npm run codex:tools` (your configuration) to trace tool discovery:
 * a tool missing here is a server or registration problem; a tool present here but absent from a conversation is the
 * host's tool exposure (its metadata budget, or a conversation that started before an update).
 */
export async function codexToolInventory(codex: string, env: NodeJS.ProcessEnv, waitMs = 8_000): Promise<{ name: string; pluginId: string | null; version: string | null; tools: Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown }> }[]> {
  const { spawn } = await import("node:child_process");
  const child = spawn(codex, ["app-server"], { env: { ...env, AION_PRESENCE_BROWSER: "none" }, stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "", id = 0;
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { const message = JSON.parse(line); if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); } } catch { /* not a message */ }
    }
  });
  const call = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: unknown }>(resolve => {
    const n = ++id; pending.set(n, resolve); child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
  });
  try {
    await call("initialize", { clientInfo: { name: "aion-codex-tools", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    const list = await call("mcpServerStatus/list", {});
    const data = (list.result as { data?: { name: string; pluginId?: string | null; serverInfo?: { version?: string } | null; tools?: Record<string, never> }[] } | undefined)?.data ?? [];
    return data.map(server => ({ name: server.name, pluginId: server.pluginId ?? null, version: server.serverInfo?.version ?? null, tools: server.tools ?? {} }));
  } finally { child.kill(); }
}

/**
 * What a new Codex conversation will expose of the *installed* Aion (v0.5.2): starts the MCP server exactly as Codex
 * would (`codex mcp list --json`), reads its instructions and tools, and applies Codex's own plugin budget
 * (src/host/mcp/budget.ts `codexExposureReport`). Codex's app server lists every tool even when the model gets fewer.
 */
export async function installedAionExposure(codex: string, env: NodeJS.ProcessEnv) {
  const { execFileSync } = await import("node:child_process");
  const { Client } = await import("@modelcontextprotocol/client");
  const { getDefaultEnvironment, StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const { codexExposureReport } = await import("../../src/host/mcp/budget");
  const servers = JSON.parse(execFileSync(codex, ["mcp", "list", "--json"], { env, encoding: "utf8", timeout: 60_000 })) as { name: string; transport: { command: string; args: string[]; env?: Record<string, string>; cwd?: string } }[];
  const server = servers.find(item => item.name === "aion-presence");
  if (!server) return null;
  const transport = new StdioClientTransport({
    command: server.transport.command, args: server.transport.args, cwd: server.transport.cwd,
    env: { ...getDefaultEnvironment(), ...server.transport.env, AION_PRESENCE_BROWSER: "none" }, stderr: "ignore",
  });
  const client = new Client({ name: "aion-codex-exposure", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    return { version: client.getServerVersion()?.version ?? null, instructions: Buffer.byteLength(instructions), report: codexExposureReport(tools, instructions) };
  } finally { await client.close(); }
}

/**
 * The Aion tools a real Codex conversation holds (v0.5.2): one `codex exec` turn in `home` (which must hold a login)
 * asks the model to run `ALL_TOOLS.filter(...)` in code mode; the answer is read from the session rollout — the tool's
 * own output, not the model's retelling. `resume`: the same conversation as the last turn. Uses one turn of the account.
 */
export async function liveAionTools(codex: string, home: string, workdir: string, resume = false): Promise<string[] | null> {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const js = "text(JSON.stringify({aionTools:ALL_TOOLS.filter(x=>x.name.includes('aion_presence')).map(x=>x.name.replace('mcp__aion_presence__',''))}));";
  const prompt = `Do not do anything else. Call exec once with exactly this JavaScript, then reply with only its raw output:\n\n${js}`;
  const env = { ...process.env, CODEX_HOME: home, AION_PRESENCE_BROWSER: "none" };
  const args = resume ? ["exec", "resume", "--last", "--json", "--skip-git-repo-check", prompt] : ["exec", "--json", "--skip-git-repo-check", "-C", workdir, prompt];
  try { execFileSync(codex, args, { env, cwd: workdir, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* read what the rollout holds */ }
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
  const sessions = join(home, "sessions");
  const rollouts = existsSync(sessions) ? walk(sessions).filter(file => file.endsWith(".jsonl")).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
  for (const file of rollouts.slice(0, 1)) {
    const outputs = readFileSync(file, "utf8").split("\n").filter(line => line.includes("custom_tool_call_output") && line.includes("aionTools"));
    const last = outputs.at(-1);
    if (!last) continue;
    const output = (JSON.parse(last) as { payload: { output: unknown } }).payload.output;
    const text = Array.isArray(output) ? output.map((item: { text?: string }) => item.text ?? "").join("") : String(output);
    const at = text.indexOf("{\"aionTools\"");
    if (at >= 0) return (JSON.parse(text.slice(at, text.indexOf("}", at) + 1)) as { aionTools: string[] }).aionTools;
  }
  return null;
}
