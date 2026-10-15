import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright-core";
import { codexToolInventory, findCodex, MARKETPLACE_NAME, PLUGIN_ID } from "./lib/codex";
import { toolMetadataReport } from "../src/host/mcp/budget";
import { TOOL_NAMES } from "../src/host/mcp/toolNames";
import { CODEX_HOOK_EVENTS, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run codex:verify`: installation from scratch with the real Codex CLI, into throwaway CODEX_HOMEs (your
 * own Codex configuration is never touched), from what is *committed* — exactly what a user gets from GitHub:
 *
 *   A. Git install: this repository's HEAD served as a Git remote → `codex plugin marketplace add <git URL>` →
 *      `codex plugin add aion-presence@spirit-connect`. No npm install, no build.
 *   B. One-command fallback: `git clone` → `node scripts/install.mjs` → installed.
 *   Then, on the installed copy (Codex's plugin cache, no node_modules): enabled · MCP server listed · skill in
 *   the model's skill list · hooks discoverable · no API key · open Aion · the Presence surface loads in a real
 *   browser · the greeting wave · a portrait (hybrid), a terrain and a form · responding · clean shutdown.
 *
 * Options: --github (install A from GitHub instead of the local HEAD; needs the branch pushed), --ref <ref>,
 * --offline (skip the public portrait/terrain lookups). Needs Codex (CODEX_BIN) and, for the surface, Chrome.
 */
const codex = findCodex();
if (!codex) { console.log("codex:verify: no Codex CLI found (install Codex or set CODEX_BIN); skipped"); process.exit(0); }
const argv = process.argv.slice(2);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const github = argv.includes("--github"), offline = argv.includes("--offline");
const ref = option("--ref") ?? execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const chromePath = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? "✓" : "✗"} ${what}`); if (!ok) failures.push(what); };
const E2E = join(REPO_ROOT, ".e2e");
mkdirSync(E2E, { recursive: true });
const homes: string[] = [];
const freshHome = () => {
  const home = mkdtempSync(join(E2E, "codex-home-"));
  writeFileSync(join(home, "config.toml"), "[features]\nplugins = true\nhooks = true\n");
  homes.push(home);
  return home;
};
const codexIn = (home: string) => (...args: string[]) => execFileSync(codex, args, {
  env: { ...process.env, CODEX_HOME: home, HOME: home }, encoding: "utf8", cwd: home, timeout: 180_000, stdio: ["ignore", "pipe", "pipe"],
});

/** This repository's HEAD as a Git remote over plain HTTP (git's "dumb" protocol): what `git clone` from GitHub sees. */
async function serveHead() {
  const bare = join(mkdtempSync(join(E2E, "remote-")), "Aion-Presence-Plugin.git");
  homes.push(join(bare, ".."));
  // --no-local: a real copy. A local clone hard-links this repository's object files, and the test deletes its copy.
  execFileSync("git", ["clone", "--quiet", "--bare", "--no-local", REPO_ROOT, bare]);
  execFileSync("git", ["update-server-info"], { cwd: bare });
  // A separate process: the Codex calls below are synchronous and would block an in-process server.
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const server = spawn(process.execPath, ["-e", `require("node:http").createServer((q, s) => { const p = require("node:path").join(${JSON.stringify(join(bare, ".."))}, decodeURIComponent(new URL(q.url, "http://x").pathname)); require("node:fs").stat(p, (e, st) => { if (e || !st.isFile()) { s.writeHead(404); return s.end(); } s.writeHead(200); require("node:fs").createReadStream(p).pipe(s); }); }).listen(${port}, "127.0.0.1")`], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 600));
  return { url: `http://127.0.0.1:${port}/Aion-Presence-Plugin.git`, close: () => server.kill() };
}

type Installed = { pluginId: string; installed: boolean; enabled: boolean; version: string };
function installedPlugin(cx: ReturnType<typeof codexIn>) {
  return (JSON.parse(cx("plugin", "list", "--json")) as { installed: Installed[] }).installed.find(item => item.pluginId === PLUGIN_ID);
}

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
if (dirty && !github) console.log("! uncommitted changes are not part of this test: it installs what is committed\n");

const remote = github ? null : await serveHead();
try {
  const home = freshHome();
  const cx = codexIn(home);
  console.log(`Codex: ${cx("--version").trim()}  (isolated CODEX_HOME)`);

  console.log(`A. Git install from ${github ? "GitHub" : "this repository's HEAD"} (${ref}): no npm, no build`);
  check(!installedPlugin(cx), "a fresh Codex has no Aion Presence");
  cx("plugin", "marketplace", "add", github ? "FulongLi/Aion-Presence-Plugin" : remote!.url, "--ref", ref);
  cx("plugin", "add", PLUGIN_ID);
  const entry = installedPlugin(cx);
  check(Boolean(entry?.installed && entry.enabled), `${PLUGIN_ID} is installed and enabled (v${entry?.version})`);
  const cache = join(home, "plugins", "cache", MARKETPLACE_NAME, "aion-presence", entry?.version ?? "");
  const files = existsSync(cache) ? readdirSync(cache) : [];
  check(["plugin.json", "mcp.json", "skills", "hooks", "assets", "runtime"].every(file => files.includes(file)), "the installed copy holds the whole package, runtime included");
  check(!files.includes("node_modules") && !files.includes("src"), "and nothing from the repository besides it");
  // v0.4.4: the Chinese Writing Pack is installed with the plugin, intact (offline teaching needs no download).
  const packManifest = join(cache, "packs", "chinese-writing", "manifest.json");
  check(existsSync(packManifest) && readFileSync(packManifest, "utf8") === readFileSync(join(REPO_ROOT, "plugins", "aion-presence", "packs", "chinese-writing", "manifest.json"), "utf8"),
    "the Chinese Writing Pack is installed with the plugin (manifest identical)");
  // v0.4.4: tool discovery as Codex itself sees it — every Aion tool, small enough for its metadata budget.
  const inventory = await codexToolInventory(codex, { ...process.env, CODEX_HOME: home, HOME: home });
  const listed = inventory.find(item => item.name === "aion-presence");
  const listedNames = Object.keys(listed?.tools ?? {});
  check(TOOL_NAMES.every(name => listedNames.includes(name)), `Codex's MCP layer receives all ${TOOL_NAMES.length} Aion tools (${listedNames.length})`);
  const budget = toolMetadataReport(Object.entries(listed?.tools ?? {}).map(([name, tool]) => ({ name, ...tool })));
  check(budget.ok, `their metadata stays inside the budget (${budget.total} B; v0.4.3 sent 302,010 B and Codex dropped 8 tools)`);

  const servers = JSON.parse(cx("mcp", "list", "--json")) as { name: string; enabled: boolean; transport: { command: string; args: string[]; env: Record<string, string>; cwd: string } }[];
  const server = servers.find(item => item.name === "aion-presence");
  check(Boolean(server?.enabled), "Codex lists the aion-presence MCP server");
  check(server?.transport.args[0] === join(cache, "runtime", "aion-mcp.mjs"), "its command runs the installed runtime");
  check(!JSON.stringify(server?.transport.env ?? {}).match(/OPENAI|API_KEY/), "no API key in its environment");
  const prompt = spawnSync(codex, ["debug", "prompt-input", "Open Aion"], { env: { ...process.env, CODEX_HOME: home, HOME: home }, cwd: home, encoding: "utf8", timeout: 180_000 });
  check(/aion-presence:aion-presence: Aion Embodiment Mode\. Use when the user asks to open, see or talk to Aion/.test(prompt.stdout), "the aion-presence skill is in the model's skill list");
  const hooks = JSON.parse(readFileSync(join(cache, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
  check(Object.keys(hooks.hooks).every(event => (CODEX_HOOK_EVENTS as readonly string[]).includes(event)) && "PreToolUse" in hooks.hooks, `hooks are discoverable (${Object.keys(hooks.hooks).join(", ")})`);

  console.log("B. One-command fallback: git clone → node scripts/install.mjs");
  const homeB = freshHome();
  const clone = join(mkdtempSync(join(E2E, "clone-")), "Aion-Presence-Plugin");
  homes.push(join(clone, ".."));
  execFileSync("git", ["clone", "--quiet", "--branch", ref, github ? "https://github.com/FulongLi/Aion-Presence-Plugin.git" : remote!.url, clone]);
  check(!existsSync(join(clone, "node_modules")), "the clone has no node_modules");
  const installer = spawnSync(process.execPath, [join(clone, "scripts", "install.mjs"), "--json", "--codex", codex], {
    env: { ...process.env, CODEX_HOME: homeB, HOME: homeB }, cwd: clone, encoding: "utf8", timeout: 300_000,
  });
  const report = JSON.parse(installer.stdout.trim().split("\n").at(-1) || "{}") as { ok?: boolean; next?: string[]; message?: string };
  check(installer.status === 0 && report.ok === true, `one command installs it${report.message ? `: ${report.message}` : ""}`);
  check(Boolean(installedPlugin(codexIn(homeB))?.enabled), "and Codex reports it enabled");
  check((report.next ?? []).some(step => /Restart Codex once/.test(step)), "it tells the user only what remains: restart once, trust hooks");

  console.log("the installed runtime");
  const pluginData = server!.transport.env.PLUGIN_DATA;
  const transport = new StdioClientTransport({
    command: server!.transport.command, args: server!.transport.args, cwd: server!.transport.cwd,
    env: { ...getDefaultEnvironment(), ...server!.transport.env, AION_PRESENCE_BROWSER: "none" },
  });
  const client = new Client({ name: "codex-verify", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }>;
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    check(existsSync(join(pluginData, "first-run-complete")), "the first session after installation is recorded as the first run");
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    check(TOOL_NAMES.every(name => tools.includes(name)), `${tools.length} tools, every one registered`);
    const opened = (await call("open_presence", { body: "figure" })).structuredContent as { surface: { mode: string }; url?: string; greeting: { due: boolean; line?: string } };
    check(opened.surface.mode === "companion", "open_presence: companion mode (Codex declares no MCP Apps rendering)");
    check(opened.greeting.due && /^Hi, I'm Aion/.test(opened.greeting.line ?? ""), "the greeting is due, with Aion's introduction");
    if (chromePath) {
      const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${opened.url}&debug=1`);
        const debug = async () => (await page.locator("#debug").textContent()) ?? "";
        const until = async (pattern: RegExp, ms = 12_000) => { for (let t = 0; t < ms; t += 200) { if (pattern.test(await debug())) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
        check(await until(/surface companion · live/), "the Presence surface loads and connects");
        check(await until(/state greeting/), "the body greets (a wave, once)");
        if (!offline) {
          const portrait = await call("show_portrait", { person: "Nikola Tesla" });
          const shown = (portrait.structuredContent as { presentation: { description: string; route: string } } | undefined)?.presentation;
          check(!portrait.isError && shown?.description === "heritage portrait: Nikola Tesla", "show_portrait: Nikola Tesla, from a public source, a heritage portrait by default");
          check(shown?.route === "hybrid", "the Presentation Router: a particle portrait and the original photograph (hybrid)");
          check(await until(/visual holding/), "the portrait forms");
          await page.screenshot({ path: join(E2E, "verify-portrait.png") });
          const terrain = await call("show_terrain", { region: "United Kingdom" });
          check(!terrain.isError && /elevation/.test(String(terrain.structuredContent?.shown)), `show_terrain: ${terrain.structuredContent?.shown ?? terrain.content[0]?.text}`);
          await page.screenshot({ path: join(E2E, "verify-terrain.png") });
        }
        const form = await call("show_form", { form: "Orion" });
        check(!form.isError && form.structuredContent?.shown === "Orion (constellation)", "show_form: Orion");
        await new Promise(r => setTimeout(r, 3_500));
        // v0.4.2: the Music Library from the installed runtime — engraved notation (bundled VexFlow and Bravura).
        const lesson = await call("music_lesson", { lesson: 7 });
        check(!lesson.isError && (lesson.structuredContent as { music?: { notes: unknown[] } } | undefined)?.music?.notes.length === 8, "music_lesson: the C major scale lesson");
        let engraved = 0;
        for (let t = 0; t < 8_000 && engraved < 8; t += 250) { engraved = await page.locator("#card .music-note").count(); await new Promise(r => setTimeout(r, 250)); }
        check(engraved === 8, `the installed runtime engraves its eight notes (${engraved})`);
        await page.screenshot({ path: join(E2E, "verify-music.png") });
        // v0.4.3: stroke animation and an action sequence from the installed runtime.
        const writing = await call("show_stroke_animation", { text: "永" });
        check(!writing.isError && (writing.structuredContent as { writing?: { symbols: { strokes: unknown[] }[] } } | undefined)?.writing?.symbols[0].strokes.length === 5, "show_stroke_animation: 永 from the installed Chinese Writing Pack, five strokes in order");
        check(await until(/writing stroke · stroke [1-5]/, 12_000), "the installed runtime writes it stroke by stroke");
        const word = await call("show_stroke_animation", { text: "国", form: "traditional" });
        check(!word.isError && (word.structuredContent as { writing?: { text: string } } | undefined)?.writing?.text === "國", "the traditional form, offline (国 → 國)");
        const hello = await call("show_stroke_animation", { text: "HELLO", presentation: "body" });
        check(!hello.isError && (hello.structuredContent as { writing?: { symbols: unknown[] } } | undefined)?.writing?.symbols.length === 5, "English: HELLO, five letters");
        const concept = await call("show_music", { concept: "tie" });
        check(!concept.isError, "the music glossary: a tie, engraved");
        await page.screenshot({ path: join(E2E, "verify-writing.png") });
        const thinking = await call("play_animation", { demo: "thinking" });
        check(!thinking.isError, "Figure 3.0: the thinking demo");
        await new Promise(r => setTimeout(r, 1_500));
        const scene = await call("play_animation", { demo: "jump-over-obstacle" });
        check(!scene.isError && (scene.structuredContent as { animation?: { title: string } } | undefined)?.animation?.title === "Jump over a box", "play_animation: jump over a box");
        check(await until(/figure jump/, 10_000), "the figure performs the jump");
        await page.screenshot({ path: join(E2E, "verify-animation.png") });
        // v0.4.5: interactive cards from the installed runtime — the Earth–Moon application and the bundled transformer.
        const earth = await call("show_interactive_card", { app: "earth-moon" });
        check(!earth.isError && /open and running/.test(earth.content[0]?.text ?? ""), "show_interactive_card: the Earth–Moon card runs in its sandboxed frame");
        check(await until(/interactive c[a-z0-9]+ · active/, 10_000), "the installed surface hosts it (lifecycle active)");
        check(await page.locator("#workspace iframe").getAttribute("sandbox") === "allow-scripts", "isolated: scripts only, no same-origin");
        const paused = await call("control_interactive_card", { action: "pause" });
        check(!paused.isError && /Done: pause/.test(paused.content[0]?.text ?? ""), "control_interactive_card: the card confirms the pause");
        await page.screenshot({ path: join(E2E, "verify-earth-moon.png") });
        const cad = await call("show_interactive_card", { app: "cad-viewer", model: "transformer" });
        check(!cad.isError && /transformer\.glb \(17 nodes/.test(cad.content[0]?.text ?? ""), "the bundled transformer model is installed and loads in the CAD viewer");
        const selected = await call("control_interactive_card", { action: "select", value: "assembly/core" });
        const inspected = await call("inspect_interactive_card");
        check(!selected.isError && /Selected: Magnetic Core/.test(inspected.content[0]?.text ?? ""), "inspect_interactive_card: the selected magnetic core and its metadata");
        await page.screenshot({ path: join(E2E, "verify-cad.png") });
        await call("control_interactive_card", { action: "close" });
        await call("clear_presentation");
        await call("set_presence_state", { state: "responding" });
        check(await until(/state responding/), "responding: the body answers with Codex");
        check(/body figure/.test(await debug()), "and it is still the figure after every visual");
        check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
      } finally { await browser.close(); }
    } else console.log("  ! no Chrome: the surface checks were skipped (set CHROME_PATH)");
    const hook = spawnSync(process.execPath, [join(cache, "runtime", "aion-hook.mjs")], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }),
      env: { ...process.env, PLUGIN_DATA: pluginData, PLUGIN_ROOT: cache }, encoding: "utf8", timeout: 10_000,
    });
    check(hook.status === 0 && hook.stdout === "", "the installed hook exits 0 silently");
    const state = (await call("clear_presentation")).structuredContent as { state: string; surface: { hooks: string } };
    check(state.state === "testing" && state.surface.hooks === "active", "a real hook event reached Aion (testing; hooks active)");
  } finally { await client.close(); }
  await new Promise(resolve => setTimeout(resolve, 800));
  check(!existsSync(join(pluginData, "hub.json")), "clean shutdown: the hub is gone when Codex closes the server");
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  remote?.close();
  // The test must leave this repository exactly as it found it.
  const fsck = spawnSync("git", ["fsck", "--no-dangling"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (fsck.status !== 0 || /missing|broken/.test(fsck.stdout + fsck.stderr)) failures.push(`git fsck reports problems in this repository:\n${fsck.stdout}${fsck.stderr}`);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\n✓ Aion Presence installs from Git with no build, and runs from Codex's plugin cache");
process.exit(failures.length ? 1 : 0);
