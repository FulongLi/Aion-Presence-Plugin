import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import { PresenceHub } from "../src/host/hub/hub";
import type { HubSnapshot } from "../src/host/hub/protocol";
import { findCodex, PLUGIN_ID } from "./lib/codex";
import { REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run scene:eval`: natural-language scene generation with the real Codex (v0.5.1). Not fixture replay: Codex reads
 * the request, writes the Scene IR itself (from the installed skill and its references), and calls Aion's tools; Aion
 * validates, routes and renders it in a real browser renderer; the card confirms what it built.
 *
 *   - Codex runs in a throwaway CODEX_HOME (.e2e/scene-eval/) with this working tree installed as the plugin, the
 *     model and reasoning effort of your own configuration, and your login (auth.json is linked, never read or copied).
 *   - A presence hub runs here, with a headless Chrome page as Aion's window (so cards build and confirm, as for a user);
 *     the plugin's MCP server, started by Codex, connects to it.
 *   - Each scenario is one Codex session ("Open Aion." first, then its requests, resumed in order). For each request:
 *     the wall time from sending it to the card's confirmed render of the new revision (Codex's reasoning, its tool
 *     calls, validation, building — everything the user waits for), the tool calls made, every refusal and repair, the
 *     final scene, a screenshot, and Codex's answer.
 *
 * Usage: `npm run scene:eval` (all), `-- --only gears,dab`, `-- --list`, `-- --out <dir>`. It uses your Codex account's
 * usage: about 20 turns for the full run. Results: <out>/results.json, <out>/*.png (default .e2e/scene-eval/<time>/).
 */
interface Step { prompt: string; expect: "scene" | "patch" | "undo" | "body" | "refusal" | "terrain" | "map" | "route" | "highlight" | "reversed" | "cleared" | "route-refusal" | "answer" | "welcome"; select?: "largest" }
interface Scenario { id: string; title: string; steps: Step[] }

export const SCENARIOS: Scenario[] = [
  { id: "gears", title: "A. Mechanical assembly", steps: [{ prompt: "Create three interconnected gears with different diameters and animate their mechanical motion.", expect: "scene" }] },
  { id: "sculpture", title: "B. Procedural sculpture", steps: [{ prompt: "Create a kinetic sculpture with three rotating rings, a glowing sphere, and a moving particle.", expect: "scene" }] },
  { id: "ripple", title: "C. Mathematical visualization", steps: [{ prompt: "Generate an interactive three-dimensional ripple surface and animate its amplitude.", expect: "scene" }] },
  { id: "dab", title: "D. Electrical engineering", steps: [{ prompt: "Create a simplified three-dimensional Dual Active Bridge converter with two full bridges and a high-frequency transformer.", expect: "scene" }] },
  {
    id: "edits", title: "E. Incremental modification", steps: [
      { prompt: "Create three interconnected gears with different diameters and animate their mechanical motion.", expect: "scene" },
      { prompt: "Add another gear.", expect: "patch" },
      { prompt: "Increase the rotation speed.", expect: "patch" },
      { prompt: "Change the colour of the selected object.", expect: "patch", select: "largest" },
      { prompt: "Undo the last modification.", expect: "undo" },
    ],
  },
  {
    id: "time", title: "F. Abstract to concrete", steps: [
      { prompt: "Visualize the passage of time.", expect: "body" },
      { prompt: "Turn this into an interactive three-dimensional timeline.", expect: "scene" },
    ],
  },
  { id: "flux", title: "G. Unsupported computation", steps: [{ prompt: "Calculate an accurate magnetic flux density field.", expect: "refusal" }] },
  {
    // v0.5.2, the terrain regression: real places must reach show_terrain / show_map, never a generated or decorative scene.
    id: "geo", title: "H. Real terrain and maps", steps: [
      { prompt: "Show me the terrain of Scotland.", expect: "terrain" },
      { prompt: "Show me China's topography.", expect: "terrain" },
      { prompt: "Show me the map of Scotland.", expect: "map" },
      { prompt: "Show me the terrain of Scotland and mark Glasgow.", expect: "terrain" },
    ],
  },
  {
    // v0.6: the final acceptance test — a first-time user's journey from "Open Aion." to a reversed route.
    id: "journey", title: "I. First run to a planned journey", steps: [
      { prompt: "Show me Scotland's terrain.", expect: "terrain" },
      { prompt: "Plan a cycling route from Glasgow to Edinburgh.", expect: "route" },
      { prompt: "Show me the highest point.", expect: "highlight" },
      { prompt: "Reverse the route.", expect: "reversed" },
    ],
  },
  {
    id: "routes", title: "J. Routes, follow-ups and limits", steps: [
      { prompt: "Show me a hiking route from Ambleside to Grasmere.", expect: "route" },
      { prompt: "How much climbing is there?", expect: "answer" },
      { prompt: "Plan a walking route from Edinburgh Castle to Arthur's Seat.", expect: "route" },
      { prompt: "Remove the route.", expect: "cleared" },
      { prompt: "Plan a walking route from London to New York.", expect: "route-refusal" },
      { prompt: "Show me the introduction again.", expect: "welcome" },
    ],
  },
];

interface ToolCall { tool: string; ok: boolean; text: string; arguments?: unknown }
interface StepResult {
  prompt: string; expect: Step["expect"]; seconds: number; renderedSeconds: number | null; firstAttempt: boolean | null;
  refusals: string[]; calls: ToolCall[]; revisionBefore: number; revisionAfter: number; route: string | null; card: Record<string, unknown> | null;
  answer: string; screenshot: string; outcome: string; selected?: string;
}

const argv = process.argv.slice(2);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes("--list")) { for (const s of SCENARIOS) console.log(`${s.id.padEnd(10)} ${s.title}: ${s.steps.map(t => `"${t.prompt}"`).join(" → ")}`); process.exit(0); }
const only = option("--only")?.split(",");
const scenarios = SCENARIOS.filter(s => !only || only.includes(s.id));
const codex = findCodex();
if (!codex) { console.log("scene:eval: no Codex CLI found (install Codex or set CODEX_BIN); nothing was run"); process.exit(0); }
const auth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
if (!existsSync(auth)) { console.log("scene:eval: Codex is not logged in (no auth.json); nothing was run"); process.exit(0); }
const chromePath = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chromePath) { console.log("scene:eval: no Chrome found (set CHROME_PATH); nothing was run"); process.exit(0); }

// Your model and reasoning effort (only these two settings are read from your configuration).
const userConfig = (() => { try { return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"); } catch { return ""; } })();
const setting = (key: string) => userConfig.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
const model = process.env.SCENE_EVAL_MODEL ?? setting("model"), effort = setting("model_reasoning_effort");

const root = join(REPO_ROOT, ".e2e", "scene-eval");
mkdirSync(root, { recursive: true });
const out = option("--out") ?? join(root, new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(root, "codex-home-"));
writeFileSync(join(home, "config.toml"), [model ? `model = "${model}"` : "", effort ? `model_reasoning_effort = "${effort}"` : "", "[features]", "plugins = true", "hooks = true", ""].join("\n"));
symlinkSync(auth, join(home, "auth.json"));
const env = { ...process.env, CODEX_HOME: home };
const cx = (...args: string[]) => execFileSync(codex, args, { env, encoding: "utf8", cwd: home, timeout: 180_000 });
cx("plugin", "marketplace", "add", REPO_ROOT);
cx("plugin", "add", PLUGIN_ID);
const servers = JSON.parse(cx("mcp", "list", "--json")) as { name: string; transport: { env: Record<string, string> } }[];
const pluginData = servers.find(s => s.name === "aion-presence")?.transport.env.PLUGIN_DATA;
if (!pluginData) throw new Error("the installed plugin's data directory was not found");
mkdirSync(pluginData, { recursive: true });
writeFileSync(join(pluginData, "first-run-complete"), "scene-eval\n");
const workdir = mkdtempSync(join(root, "work-"));

const page_ = () => readFileSync(join(REPO_ROOT, "plugins", "aion-presence", "runtime", "presence.html"), "utf8");
const hub = new PresenceHub({ home: pluginData, port: 0, page: page_ });
await hub.start();
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"] });
const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${hub.surfaceUrl}&mic=0`);
await page.waitForTimeout(2500);
const snapshot = () => hub.snapshot() as HubSnapshot;
const revisionOf = () => snapshot().card?.scene?.revision ?? 0;
const renderedOf = () => snapshot().card?.scene?.rendered;

/** One Codex turn; resolves with its events once the process exits. Watches the hub for the confirmed render meanwhile. */
function turn(prompt: string, resume: boolean): Promise<{ events: Record<string, unknown>[]; seconds: number; renderedSeconds: number | null; kinds: Set<string> }> {
  const args = resume
    ? ["exec", "resume", "--last", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", prompt]
    : ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-C", workdir, prompt];
  const started = performance.now(), before = revisionOf(), presentationBefore = snapshot().presentation?.id ?? null;
  const routeBefore = snapshot().card?.route?.document.id ?? null;
  let renderedSeconds: number | null = null;
  const kinds = new Set<string>();
  const watch = setInterval(() => {
    const now = snapshot().presentation;
    if (now && now.id !== presentationBefore) kinds.add(now.kind);
    if (renderedSeconds !== null) return;
    const rendered = renderedOf(), presentation = now;
    const card = rendered && rendered.ok && rendered.revision > before;
    const body = presentation && presentation.id !== presentationBefore && presentation.kind === "scene";
    // v0.6: a new route counts once the card has drawn it.
    const route = snapshot().card?.route;
    const drawn = route && route.document.id !== routeBefore && route.rendered?.ok && route.rendered.revision >= route.revision;
    if (card || body || drawn) renderedSeconds = Math.round((performance.now() - started) / 100) / 10;
  }, 100);
  return new Promise((resolve, reject) => {
    const child = spawn(codex!, args, { env, cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const events: Record<string, unknown>[] = [];
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { events.push(JSON.parse(line)); } catch { /* not an event */ }
      }
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 600_000);
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer); clearInterval(watch);
      if (!events.length) console.log(`  (no events; stderr: ${stderr.slice(-400)})`);
      resolve({ events, seconds: Math.round((performance.now() - started) / 100) / 10, renderedSeconds, kinds });
    });
  });
}

/** The MCP tool calls in a turn's events, whatever the exact event shape of this Codex version. */
function toolCalls(events: Record<string, unknown>[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    const item = (event.item ?? event.msg ?? event) as Record<string, unknown>;
    if (!/mcp/i.test(String(item.type ?? "")) || event.type === "item.started") continue;
    const tool = String(item.tool ?? (item.invocation as Record<string, unknown> | undefined)?.tool ?? "?");
    const result = item.result as Record<string, unknown> | undefined;
    const content = (result?.content ?? (result?.Ok as Record<string, unknown> | undefined)?.content) as { text?: string }[] | undefined;
    const text = content?.map(c => c.text ?? "").join("\n") ?? String(item.error ?? "");
    const isError = item.status === "failed" || result?.is_error === true || result?.isError === true || !!item.error;
    const args = item.arguments ?? (item.invocation as Record<string, unknown> | undefined)?.arguments;
    calls.push({ tool, ok: !isError, text: text.slice(0, 6000), ...(args !== undefined ? { arguments: typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return args; } })() : args } : {}) });
  }
  return calls;
}
const answerOf = (events: Record<string, unknown>[]) => {
  const messages = events.map(e => (e.item ?? {}) as Record<string, unknown>).filter(i => i.type === "agent_message" || i.type === "assistant_message");
  return String(messages.at(-1)?.text ?? "").slice(0, 1200);
};

const results: { id: string; title: string; steps: StepResult[] }[] = [];
console.log(`Codex ${cx("--version").trim()} · model ${model ?? "(default)"}${effort ? ` · effort ${effort}` : ""} · ${scenarios.length} scenario(s) → ${out}`);
try {
  for (const scenario of scenarios) {
    console.log(`\n${scenario.title}`);
    await page.goto(`${hub.surfaceUrl}&mic=0`);
    hub.apply({ type: "clear" });
    await page.waitForTimeout(1500);
    const welcomeDue = snapshot().hub.welcome;
    const opened = await turn("Open Aion.", false);
    await page.waitForTimeout(2500);
    const welcomeShown = await page.locator("#welcome.visible").count() > 0;
    if (welcomeShown) await page.screenshot({ path: join(out, `${scenario.id}-0-welcome.png`) });
    console.log(`  "Open Aion." ${opened.seconds} s (${toolCalls(opened.events).map(c => c.tool).join(", ") || "no tools"})${welcomeDue ? `; first run: welcome ${welcomeShown ? "shown" : "NOT shown"}` : ""}`);
    const steps: StepResult[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      let selected: string | undefined;
      if (step.select === "largest") {
        // Stands for the user's click on an object in the card (the same selection a click reports).
        const doc = snapshot().card?.scene?.document;
        const target = doc?.objects.filter(n => n.type === "gear" || (n.radius !== undefined && n.type !== "circle")).sort((a, b) => (b.radius ?? 0) - (a.radius ?? 0))[0];
        if (target) { hub.apply({ type: "card", command: "select", value: target.id }); selected = target.id; await page.waitForTimeout(1500); }
      }
      const revisionBefore = revisionOf();
      const originBefore = snapshot().card?.route?.document.origin.name ?? null;
      const ran = await turn(step.prompt, true);
      await page.waitForTimeout(1500);
      const calls = toolCalls(ran.events).filter(c => c.tool !== "set_presence_state");
      const sceneCalls = calls.filter(c => ["show_interactive_card", "control_interactive_card"].includes(c.tool));
      const refusals = sceneCalls.filter(c => !c.ok).map(c => c.text.split("\n").slice(0, 3).join(" ").slice(0, 300));
      const shot = join(out, `${scenario.id}-${index + 1}.png`);
      await page.screenshot({ path: shot });
      const card = snapshot().card;
      const route = [...sceneCalls.map(c => c.text).join("\n").matchAll(/Route: (\{.*\})/g)].at(-1)?.[1];
      // The scene as Codex wrote it (after its patches): evidence of what was generated, kept beside the screenshot.
      if (card?.scene) writeFileSync(join(out, `${scenario.id}-${index + 1}.scene.json`), JSON.stringify(card.scene.document, null, 1));
      const revisionAfter = revisionOf();
      const presentation = snapshot().presentation;
      const geoTool = step.expect === "terrain" ? "show_terrain" : "show_map";
      const routeCalls = calls.filter(c => c.tool === "plan_route"), drawnRoute = card?.route?.rendered?.ok ? card.route.document : null;
      const journey = drawnRoute ? `${drawnRoute.origin.name} → ${drawnRoute.destination.name}, ${drawnRoute.travelMode}, ${(drawnRoute.distanceMeters / 1000).toFixed(1)} km, ↑${drawnRoute.totalAscentMeters} m` : "";
      const outcome = step.expect === "route" ? (routeCalls.some(c => c.ok) && drawnRoute ? `route drawn: ${journey}` : `NO ROUTE (tools: ${calls.map(c => `${c.tool}${c.ok ? "" : "✗"}`).join(", ") || "none"})`)
        : step.expect === "highlight" ? (card?.state.highlight === "highest" ? `highest point highlighted: ${card.state.highlightM} m at km ${card.state.highlightKm}` : `NOT HIGHLIGHTED (tools: ${calls.map(c => c.tool).join(", ") || "none"})`)
        : step.expect === "reversed" ? (drawnRoute && originBefore && drawnRoute.origin.name !== originBefore ? `reversed: ${journey}` : "NOT REVERSED")
        : step.expect === "cleared" ? (presentation?.kind === "terrain" && !card ? "route removed, terrain kept" : `NOT CLEARED (${presentation?.kind ?? "nothing"} on show)`)
        : step.expect === "route-refusal" ? (routeCalls.length && routeCalls.every(c => !c.ok) ? `refused by Aion: ${routeCalls[0].text.split(":")[0]}` : routeCalls.length === 0 ? "declined by Codex without calling Aion" : "A ROUTE WAS SHOWN")
        : step.expect === "answer" ? (answerOf(ran.events) ? "answered" : "no answer")
        : step.expect === "welcome" ? (snapshot().hub.welcome && calls.some(c => c.tool === "open_presence") ? "welcome shown again" : `NOT SHOWN (tools: ${calls.map(c => c.tool).join(", ") || "none"})`)
        : step.expect === "terrain" || step.expect === "map"
        ? (calls.some(c => c.tool === geoTool && c.ok) && ran.kinds.has(step.expect)
          ? `${step.expect} formed by ${geoTool}${calls.some(c => ["show_interactive_card", "show_scene", "show_image"].includes(c.tool)) ? " (also called a scene/image tool)" : ""}`
          : `NOT SHOWN (${[...ran.kinds].join(", ") || "nothing"} shown; tools: ${calls.map(c => c.tool).join(", ") || "none"})`)
        : step.expect === "refusal"
        ? (sceneCalls.some(c => /unsupported:/.test(c.text)) ? "refused as unsupported (Aion)" : calls.length === 0 ? "declined by Codex without calling Aion" : sceneCalls.some(c => c.ok) ? "SHOWN (should have been refused)" : "refused")
        : step.expect === "body" ? (presentation?.kind === "scene" ? "formed by the body" : card?.scene ? `card (revision ${revisionAfter})` : "nothing shown")
          : revisionAfter > revisionBefore && card?.scene?.rendered?.ok && card.scene.rendered.revision >= revisionAfter ? `rendered revision ${revisionAfter}` : revisionAfter > revisionBefore ? `revision ${revisionAfter}, not confirmed` : "no change";
      const result: StepResult = {
        prompt: step.prompt, expect: step.expect, seconds: ran.seconds, renderedSeconds: ran.renderedSeconds,
        firstAttempt: sceneCalls.length ? sceneCalls[0].ok : null, refusals, calls, revisionBefore, revisionAfter,
        route: route ? (() => { try { const r = JSON.parse(route) as { mode: string; reason: string }; return `${r.mode}: ${r.reason}`; } catch { return null; } })() : presentation?.kind === "scene" ? "body" : null,
        card: card ? { state: card.state, objects: card.scene?.document.objects.length, animations: card.scene?.document.animations?.length ?? 0, label: card.scene?.label } : null,
        answer: answerOf(ran.events), screenshot: shot, outcome, ...(selected ? { selected } : {}),
      };
      steps.push(result);
      console.log(`  "${step.prompt}" → ${outcome}; ${ran.renderedSeconds ?? "–"} s to visible, ${ran.seconds} s turn; tools: ${calls.map(c => `${c.tool}${c.ok ? "" : "✗"}`).join(", ") || "none"}${refusals.length ? `; refusals: ${refusals.length}` : ""}`);
    }
    results.push({ id: scenario.id, title: scenario.title, steps });
    writeFileSync(join(out, "results.json"), JSON.stringify({ codex: cx("--version").trim(), model, effort, at: new Date().toISOString(), results }, null, 2));
  }
} finally {
  await browser.close();
  await hub.stop();
}
console.log(`\nresults: ${join(out, "results.json")}`);
