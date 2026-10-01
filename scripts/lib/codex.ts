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

export const MARKETPLACE_NAME = "aion-presence-dev";
export const PLUGIN_ID = `aion-presence@${MARKETPLACE_NAME}`;
