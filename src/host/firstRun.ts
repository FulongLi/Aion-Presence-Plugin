import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * First run: the first Codex session after Aion Presence is installed opens Aion once, by itself, so a new
 * user sees it appear without knowing any command. After that it opens when asked ("Open Aion"). A marker in
 * the plugin data directory remembers that the first run happened; it holds no user content.
 *
 * `autoOpen` (settings.json in the plugin data directory, or AION_PRESENCE_AUTO_OPEN):
 *   first-run (default)  open once, on the first session after installation
 *   always               open on every new Codex session (unless a window is already showing Aion)
 *   never                only when asked
 */
export const AUTO_OPEN_MODES = ["first-run", "always", "never"] as const;
export type AutoOpen = typeof AUTO_OPEN_MODES[number];
export const FIRST_RUN_FILE = "first-run-complete";
export const SETTINGS_FILE = "settings.json";

const isMode = (value: unknown): value is AutoOpen => typeof value === "string" && (AUTO_OPEN_MODES as readonly string[]).includes(value);

export function autoOpenSetting(home: string, env: NodeJS.ProcessEnv = process.env): AutoOpen {
  if (isMode(env.AION_PRESENCE_AUTO_OPEN)) return env.AION_PRESENCE_AUTO_OPEN;
  try {
    const settings = JSON.parse(readFileSync(join(home, SETTINGS_FILE), "utf8")) as { autoOpen?: unknown };
    if (isMode(settings.autoOpen)) return settings.autoOpen;
  } catch { /* no settings: the default */ }
  return "first-run";
}

export const firstRunDone = (home: string) => existsSync(join(home, FIRST_RUN_FILE));

/** Whether this session should open Aion by itself. */
export function shouldAutoOpen(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = autoOpenSetting(home, env);
  return mode === "always" || (mode === "first-run" && !firstRunDone(home));
}

/** Records that the first run happened (before opening, so a failure can never reopen windows forever). */
export function markFirstRun(home: string, now = new Date()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, FIRST_RUN_FILE), `${now.toISOString()}\n`, { mode: 0o600 });
}
