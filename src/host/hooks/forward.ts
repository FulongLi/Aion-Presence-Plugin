import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_HEARTBEAT_FILE, HUB_FILE, presenceHome, TOKEN_FILE } from "../paths";
import { estimateSpeechSeconds } from "./speech";

/**
 * The Codex lifecycle hook command (hooks/hooks.json runs it for SessionStart, UserPromptSubmit, PreToolUse,
 * PostToolUse, Stop, Interrupt and SessionEnd). It is deliberately tiny and can never get in Codex's way:
 *
 *   - it prints nothing and always exits 0, so it never blocks, rewrites or comments on a tool call;
 *   - it notes that hooks are running (a timestamp file), so Aion can tell the agent it need not report
 *     routine states itself;
 *   - when Aion is open it forwards the event name, the tool name and, for shell tools, the first part of the
 *     command line to the local presence hub — nothing else from the tool input or output; at the end of a
 *     turn, only how many seconds the final answer takes to say (never its text);
 *   - when Aion is not open, or anything at all goes wrong, it simply stops.
 */
const STDIN_LIMIT = 256 * 1024;
const POST_TIMEOUT_MS = 400;

export interface ForwardedEvent { hook_event_name: string; tool_name?: string; command?: string; session_id?: string; speech_seconds?: number }

/** The fields Aion needs from a hook payload, and nothing more. */
export function pickEvent(payload: unknown): ForwardedEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.hook_event_name !== "string") return null;
  const event: ForwardedEvent = { hook_event_name: value.hook_event_name.slice(0, 40) };
  if (typeof value.tool_name === "string") event.tool_name = value.tool_name.slice(0, 200);
  if (typeof value.session_id === "string") event.session_id = value.session_id.slice(0, 200);
  const input = value.tool_input as Record<string, unknown> | undefined;
  const command = input && typeof input === "object" ? input.command ?? input.cmd : undefined;
  const line = Array.isArray(command) ? command.filter(part => typeof part === "string").join(" ") : command;
  if (typeof line === "string" && line.trim()) event.command = line.trim().slice(0, 300);
  if (event.hook_event_name === "Stop") {
    const seconds = estimateSpeechSeconds(value.last_assistant_message);
    if (seconds > 0) event.speech_seconds = seconds;
  }
  return event;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > STDIN_LIMIT) break;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(home = presenceHome()): Promise<void> {
  const event = pickEvent(JSON.parse((await readStdin()) || "null"));
  if (!event) return;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, HOOK_HEARTBEAT_FILE), String(Date.now()), { mode: 0o600 });
  } catch { /* a read-only home only means the heartbeat is missing */ }
  let url: string, token: string;
  try {
    url = (JSON.parse(readFileSync(join(home, HUB_FILE), "utf8")) as { url: string }).url;
    token = readFileSync(join(home, TOKEN_FILE), "utf8").trim();
  } catch { return; }
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) return;
  await fetch(new URL("api/hook", url), {
    method: "POST", headers: { "content-type": "application/json", "x-aion-token": token },
    body: JSON.stringify(event), signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
}

