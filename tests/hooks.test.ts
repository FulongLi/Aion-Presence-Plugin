import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { StoreClock } from "../src/core/store";
import { pickEvent } from "../src/host/hooks/forward";
import { classifyTool, commandLabel, interpretHook, SETTLE_MS } from "../src/host/hooks/mapping";
import { PresenceHub } from "../src/host/hub/hub";
import { HOOK_HEARTBEAT_FILE } from "../src/host/paths";
import { PLUGIN_ROOT } from "../scripts/lib/pluginPackage";
import { PAGE, tempHome } from "./helpers";

test("tools map to the activity they really are", () => {
  const cases: [string, string | undefined, string | null][] = [
    ["apply_patch", undefined, "editing"], ["Edit", undefined, "editing"], ["Write", undefined, "editing"],
    ["Read", undefined, "reading"], ["Grep", undefined, "reading"], ["Glob", undefined, "reading"],
    ["Bash", "npm test", "testing"], ["Bash", "npx vitest run src", "testing"], ["shell", "pytest -q tests/", "testing"], ["Bash", "cargo test --all", "testing"],
    ["Bash", "go test ./...", "testing"], ["Bash", "cd app && npm run test -- --watch=false", "testing"], ["exec_command", "tsx --test tests/*.test.ts", "testing"],
    ["Bash", "npm run build", "building"], ["Bash", "cargo build --release", "building"], ["Bash", "tsc --noEmit", "building"], ["Bash", "xcodebuild -scheme App", "building"],
    ["Bash", "rg -n TODO src", "reading"], ["Bash", "git status", "reading"], ["Bash", "sed -n 1,80p src/a.ts", "reading"], ["Bash", "ls -la", "reading"],
    ["Bash", "echo hi > notes.txt", "working"], ["Bash", "npm install", "working"], ["WebFetch", undefined, "working"],
    ["mcp__aion-presence__show_result", undefined, null], ["mcp__aion_presence__open_presence", undefined, null], ["show_result", undefined, null],
    ["", undefined, null],
  ];
  for (const [tool, command, state] of cases) assert.equal(classifyTool(tool, command)?.state ?? null, state, `${tool} ${command ?? ""}`);
});

test("command labels keep the first words and drop anything that looks like a secret", () => {
  assert.equal(commandLabel("npm test -- --runInBand && echo done"), "npm test -- --runInBand");
  assert.equal(commandLabel("API_KEY=abc123 npm run build"), "npm run build");
  assert.equal(commandLabel("curl --token abcdef https://x"), "curl https://x", "the value after a secret flag goes too");
  assert.equal(commandLabel("gh auth login --with-token"), "gh login");
  assert.ok(commandLabel("x".repeat(200)).length <= 48);
});

test("hook events become decisions; Aion's own tools never change its state", () => {
  assert.deepEqual(interpretHook({ hook_event_name: "UserPromptSubmit" }), { type: "activity", state: "thinking" });
  assert.deepEqual(interpretHook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "npm test" }), { type: "activity", state: "testing", label: "npm test" });
  assert.deepEqual(interpretHook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "npm test" }), { type: "settle", state: "thinking", afterMs: SETTLE_MS });
  assert.deepEqual(interpretHook({ hook_event_name: "PreToolUse", tool_name: "mcp__aion-presence__show_result" }), { type: "none" });
  assert.deepEqual(interpretHook({ hook_event_name: "PostToolUse", tool_name: "mcp__aion-presence__show_result" }), { type: "none" });
  assert.deepEqual(interpretHook({ hook_event_name: "Stop" }), { type: "turn-end" });
  assert.deepEqual(interpretHook({ hook_event_name: "Interrupt" }), { type: "activity", state: "idle" });
  assert.deepEqual(interpretHook({ hook_event_name: "SessionStart" }), { type: "none" }, "a new session does not open or change Aion");
  assert.deepEqual(interpretHook({ hook_event_name: "PermissionRequest" }), { type: "none" });
});

function manualClock() {
  let now = 5_000_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const clock: StoreClock = { now: () => now, schedule(run, ms) { const timer = { at: now + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; } };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter(timer => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at; next.live = false; next.run();
    }
    now = until;
  };
  return { clock, advance };
}

test("a Codex turn through the hub: thinking → reading → editing → testing → complete → idle, without flicker", () => {
  const { clock, advance } = manualClock();
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => PAGE, clock });
  const state = () => hub.snapshot().activity.state;
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  assert.equal(state(), "thinking");
  hub.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "rg -n render src" });
  assert.equal(state(), "reading");
  hub.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "rg -n render src" });
  advance(SETTLE_MS / 2);
  hub.hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch" });
  assert.equal(state(), "editing", "back-to-back tools never flash thinking in between");
  hub.hook({ hook_event_name: "PostToolUse", tool_name: "apply_patch" });
  advance(SETTLE_MS + 10);
  assert.equal(state(), "thinking", "a pause after a tool settles into thinking");
  hub.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "npm test" });
  assert.equal(state(), "testing");
  assert.equal(hub.snapshot().activity.label, "npm test");
  hub.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "npm test" });
  hub.hook({ hook_event_name: "Stop" });
  assert.equal(state(), "complete");
  advance(SETTLE_MS + 10);
  assert.equal(state(), "complete", "a stale settle timer does not undo completion");
  advance(7_000);
  assert.equal(state(), "idle");
  assert.equal(hub.snapshot().hub.hooksActive, true);
});

test("a Stop without a prompt rests; an error the agent reported survives the turn end", () => {
  const { clock } = manualClock();
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => PAGE, clock });
  hub.hook({ hook_event_name: "Stop" });
  assert.equal(hub.snapshot().activity.state, "idle");
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.apply({ type: "activity", state: "error", label: "Build failed" });
  hub.hook({ hook_event_name: "Stop" });
  assert.equal(hub.snapshot().activity.state, "error");
});

test("the agent's own specific state is not overwritten by a generic hook guess", () => {
  const { clock } = manualClock();
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => PAGE, clock });
  hub.apply({ type: "activity", state: "building", label: "Packaging the app" });
  hub.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "./scripts/package.sh" });
  assert.equal(hub.snapshot().activity.state, "building", "generic working does not replace building");
  hub.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "npm test" });
  assert.equal(hub.snapshot().activity.state, "testing", "a specific signal does");
});

test("the hook forwards only the event name, tool name and command line", () => {
  const event = pickEvent({
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/secret/project", transcript_path: "/x", model: "m", turn_id: "t",
    tool_name: "Bash", tool_input: { command: ["bash", "-lc", "npm test"], env: { TOKEN: "x" } }, tool_response: { output: "huge" },
  });
  assert.deepEqual(event, { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s1", command: "bash -lc npm test" });
  assert.equal(pickEvent({ tool_name: "Bash" }), null);
  assert.equal(pickEvent("nonsense"), null);
  assert.equal(pickEvent({ hook_event_name: "Stop", tool_input: { command: "x".repeat(1000) } })!.command!.length, 300);
});

function runHookProcess(home: string, payload: unknown) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/host/hooks/main.ts")], { env: { ...process.env, AION_PRESENCE_HOME: home } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

test("with Aion closed the hook prints nothing, exits 0 and only notes that hooks are running", async () => {
  const home = tempHome();
  const result = await runHookProcess(home, { hook_event_name: "UserPromptSubmit", session_id: "s" });
  assert.deepEqual([result.code, result.stdout], [0, ""]);
  assert.ok(existsSync(join(home, HOOK_HEARTBEAT_FILE)));
  const garbage = await runHookProcess(home, "{not json");
  assert.deepEqual([garbage.code, garbage.stdout], [0, ""], "malformed input is ignored, never an error for Codex");
});

test("with Aion open the hook delivers the event to the hub", async () => {
  const home = tempHome();
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE });
  await hub.start();
  try {
    const result = await runHookProcess(home, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo build" } });
    assert.deepEqual([result.code, result.stdout], [0, ""]);
    assert.equal(hub.snapshot().activity.state, "building");
  } finally { await hub.stop(); }
});

test("hooks.json registers lightweight command hooks only, on the documented events", () => {
  const config = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(config.hooks).sort(), ["Interrupt", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const [event, groups] of Object.entries(config.hooks) as [string, { hooks: { type: string; command: string; timeout: number }[] }[]][]) {
    for (const handler of groups.flatMap(group => group.hooks)) {
      assert.equal(handler.type, "command");
      assert.equal(handler.command, 'node "${PLUGIN_ROOT}/runtime/aion-hook.mjs"');
      assert.ok(handler.timeout <= (event === "Interrupt" || event === "SessionEnd" ? 3 : 5), `${event} timeout`);
    }
  }
  assert.equal(config.hooks.PermissionRequest, undefined, "no policy hooks");
});
