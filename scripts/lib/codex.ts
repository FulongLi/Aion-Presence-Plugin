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
export async function codexToolInventory(codex: string, env: NodeJS.ProcessEnv, waitMs = 8_000): Promise<{ name: string; tools: Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown }> }[]> {
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
    const data = (list.result as { data?: { name: string; tools?: Record<string, never> }[] } | undefined)?.data ?? [];
    return data.map(server => ({ name: server.name, tools: server.tools ?? {} }));
  } finally { child.kill(); }
}
