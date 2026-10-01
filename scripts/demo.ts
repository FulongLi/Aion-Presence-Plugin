import { PresenceLink } from "../src/host/hub/link";
import { visualForms } from "../src/visual/forms";

/**
 * A scripted Codex-like workflow against a running hub (npm run dev -- --demo, or AION_PRESENCE_HOME pointing at
 * a hub). It sends exactly what the MCP tools and hooks would send, so it exercises the real state path.
 */
const link = new PresenceLink({ page: () => "" });
const pause = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000));
const apply = (command: Parameters<Awaited<ReturnType<typeof link.connect>>["apply"]>[0]) => link.run(backend => backend.apply(command));
const hook = async (event: Record<string, string>) => {
  const backend = await link.connect();
  // Hooks reach the hub over HTTP; locally owned hubs take them directly.
  if ("hub" in backend) (backend as unknown as { hub: { hook(event: unknown): void } }).hub.hook(event);
  else await fetch(new URL("api/hook", backend.surfaceUrl.split("?")[0]), { method: "POST", headers: { "content-type": "application/json", "x-aion-token": new URL(backend.surfaceUrl).searchParams.get("token")! }, body: JSON.stringify(event) });
};
const step = (text: string) => console.log(`  · ${text}`);

console.log("Aion demo: a Codex turn");
step("figure body"); await apply({ type: "body", body: "figure" }); await pause(3);
step("prompt submitted → thinking"); await hook({ hook_event_name: "UserPromptSubmit" }); await pause(3);
step("reading the repository"); await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "rg -n render src" }); await pause(3);
await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "rg -n render src" }); await pause(2);
step("editing files"); await hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch" }); await pause(3);
await hook({ hook_event_name: "PostToolUse", tool_name: "apply_patch" }); await pause(2);
step("running tests"); await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "npm test" }); await pause(4);
await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "npm test" });
step("presenting the result");
await apply({ type: "present", content: { kind: "result", title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed", "Build successful"] }, hold: 10 });
await hook({ hook_event_name: "Stop" }); await pause(12);
step("a visual form: Orion");
await apply({ type: "present", content: { kind: "form", form: "astronomy.orion", label: visualForms.label("astronomy.orion") }, hold: 9 }); await pause(12);
step("short text becomes the body"); await apply({ type: "present", content: { kind: "text", text: "48/48" }, hold: 6 }); await pause(9);
step("back to the sphere, yin-yang"); await apply({ type: "body", body: "sphere" }); await pause(3);
await apply({ type: "present", content: { kind: "form", form: "tao.yin-yang", label: visualForms.label("tao.yin-yang") }, hold: 9 }); await pause(12);
step("done"); await link.close();
