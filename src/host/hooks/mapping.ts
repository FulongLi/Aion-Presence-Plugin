import type { ActivityState } from "../../core/state";
import { WORK_STATES } from "../../core/state";

/**
 * Codex lifecycle hooks → Aion's activity. Only what a hook actually reports is used: the event, the tool's
 * name and, for shell tools, the command line. Nothing else from the tool input is read or kept.
 *
 *   UserPromptSubmit                     thinking
 *   PreToolUse  apply_patch / Edit …     editing
 *               Read / Grep / Glob …     reading
 *               shell: a test runner     testing
 *               shell: a build tool      building
 *               shell: a read-only look  reading
 *               anything else            working
 *               Aion's own MCP tools     (ignored: presenting is not work)
 *   PostToolUse                          thinking, after a short settle unless another tool starts
 *   Stop                                 complete (or idle when nothing happened this turn)
 *   Interrupt / SessionEnd               idle
 */
export interface HookEvent {
  hook_event_name: string;
  tool_name?: string;
  /** The shell command line, when the tool is a shell (truncated by the hook). */
  command?: string;
  session_id?: string;
}

export type HookDecision =
  | { type: "activity"; state: ActivityState; label?: string }
  | { type: "settle"; state: ActivityState; afterMs: number }
  | { type: "turn-end" }
  | { type: "none" };

export const SETTLE_MS = 1_200;

const EDIT_TOOLS = /^(?:apply_patch|edit|multiedit|write|notebookedit|str_replace_editor|create_file|write_file)$/i;
const READ_TOOLS = /^(?:read|grep|glob|ls|list_dir|view_image|read_file|search|find)$/i;
const SHELL_TOOLS = /^(?:bash|shell|local_shell|exec_command|unified_exec|container\.exec|run_terminal_cmd)$/i;
/** Aion's own tools, under any MCP naming scheme the host uses. */
const OWN_TOOLS = /(?:^|__|\.|\/)aion[-_]presence(?:__|\.|\/)|^(?:open_presence|set_presence_state|set_body_form|show_visual_form|show_text|show_image|show_result|show_artifact|clear_presentation|presence_sync|presence_media)$/i;

const TEST = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:jest|vitest|mocha|playwright\s+test)|(?:jest|vitest|mocha|ava|tap)\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)|cargo\s+(?:test|nextest)|go\s+test\b|(?:node|tsx|deno|bun)\s+(?:--)?test\b|node\s+--test|tsx\s+--test|deno\s+test|rspec\b|(?:bundle\s+exec\s+)?rake\s+test|ctest\b|swift\s+test|xcodebuild\b[^\n]*\btest\b|(?:\.\/)?gradlew?\s+(?:\S+\s+)*test\b|mvn\s+(?:\S+\s+)*test\b|dotnet\s+test|phpunit\b|mix\s+test|tox\b|nox\b)/i;
const BUILD = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|tsc\b|cargo\s+build|go\s+build|make\b|cmake\s+--build|ninja\b|(?:\.\/)?gradlew?\s+(?:\S+\s+)*(?:build|assemble)\b|mvn\s+(?:\S+\s+)*(?:package|install|compile)\b|xcodebuild\b|swift\s+build|vite\s+build|next\s+build|webpack\b|esbuild\b|rollup\b|docker\s+build|dotnet\s+build|bazel\s+build)/i;
const LOOK = /^\s*(?:cat|head|tail|less|more|bat|nl|wc|ls|tree|find|fd|rg|grep|ag|ack|sed\s+-n|awk|stat|file|du|pwd|which|jq|git\s+(?:status|log|diff|show|blame|branch|grep|ls-files)|cd\s+\S+\s*&&\s*(?:cat|ls|rg|grep|git\s+(?:status|log|diff|show)))\b/i;

/** A short, safe label for a shell command: its first words, never secrets that may follow. */
export function commandLabel(command: string): string {
  const first = command.replace(/\s+/g, " ").trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? "";
  const kept: string[] = [];
  let skipNext = false;
  for (const word of first.split(" ")) {
    if (skipNext) { skipNext = false; continue; }
    if (/=|token|key|secret|password|passwd|auth|bearer/i.test(word)) { skipNext = word.startsWith("-") && !word.includes("="); continue; }
    kept.push(word);
  }
  const words = kept.slice(0, 4).join(" ");
  return words.length > 48 ? `${words.slice(0, 47)}…` : words;
}

export function classifyTool(toolName: string | undefined, command?: string): { state: ActivityState; label?: string } | null {
  const tool = toolName?.trim() ?? "";
  if (!tool || OWN_TOOLS.test(tool)) return null;
  if (EDIT_TOOLS.test(tool)) return { state: "editing" };
  if (READ_TOOLS.test(tool)) return { state: "reading" };
  if (SHELL_TOOLS.test(tool) && command) {
    const label = commandLabel(command) || undefined;
    if (TEST.test(command)) return { state: "testing", label };
    if (BUILD.test(command)) return { state: "building", label };
    if (LOOK.test(command)) return { state: "reading" };
    return { state: "working", label };
  }
  return { state: "working" };
}

export function interpretHook(event: HookEvent): HookDecision {
  switch (event.hook_event_name) {
    case "UserPromptSubmit": return { type: "activity", state: "thinking" };
    case "PreToolUse": {
      const work = classifyTool(event.tool_name, event.command);
      return work ? { type: "activity", ...work } : { type: "none" };
    }
    case "PostToolUse":
      return classifyTool(event.tool_name, event.command) ? { type: "settle", state: "thinking", afterMs: SETTLE_MS } : { type: "none" };
    case "Stop": return { type: "turn-end" };
    case "Interrupt":
    case "SessionEnd": return { type: "activity", state: "idle" };
    default: return { type: "none" };
  }
}

export const isWorkState = (state: ActivityState) => (WORK_STATES as readonly string[]).includes(state);
