import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { connectAion, MCP_APPS_CAPABILITIES } from "../tests/helpers";
import { PresenceHub } from "../src/host/hub/hub";
import type { PresentationContent } from "../src/core/presentation";
import { VisualResolver } from "../src/host/resolver";
import { visualForms } from "../src/visual/forms";
import { SCENE_PRESETS } from "../src/visual/scene3d/presets";
import { speechWav } from "./lib/fakeSpeech";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run smoke`: the built Presence surface in a real browser (the installed Chrome, headless), driven through
 * the real state paths and checked by what is actually on screen:
 *
 *   renderers     both renderers draw; activity, body and visuals arrive; every visual returns to the body
 *   visuals       SCF's visual language, and the Presentation Router: Tesla → hybrid with the original photo,
 *                 Orion → body only, long text and code → cards beside a body that keeps living
 *   listening     a speech-like signal through Chrome's capture device → getUserMedia → MicrophoneListener → VAD
 *                 → PresenceEngine → listening → a visibly gathering body (also while a visual is formed)
 *   responding    Skill → MCP → hub → surface → engine → Aion state → visibly more motion (sphere and figure),
 *                 and the Stop hook's answer tail
 *   immersive     Enter Presence → true fullscreen, kept through visuals; Esc exits and is respected; a window
 *                 brought forward retires the old one; an embedded host that refuses fullscreen
 *   embedded      the same page in a minimal MCP Apps host wired to the real Aion MCP server (and its interactive card)
 *   v45           interactive cards through the real MCP tools: the Earth–Moon and CAD viewer applications in their
 *                 sandboxed frames (isolation probed from inside the frame), clicks select, Codex controls, layouts,
 *                 universal controls, Escape, repeated open/close with nothing left behind, timings, and a browser
 *                 without WebGL showing the unsupported state while Aion lives on
 *   v0.4          Aion Eyes and express, the figure explaining an emphasised term, a heritage portrait, a 3D pyramid
 *                 that turns, is dragged and re-oriented, then returns — in both renderers
 *   v0.4.1        through the real MCP tools: a heritage portrait by default; a map whose markers appear in their colours
 *                 at their places and change in place; a pin on terrain; the body turning blue, purple and back
 *   v0.4.2        music: lessons, engraved notation checked note by note against staff theory, playback whose lit note
 *                 follows the audio clock, a clef formed by the body; sound: the hub's real bridge socket fed by a
 *                 stand-in for the macOS app (scripts/lib/fakeBridge.ts) → analysis → surface → the circular spectrum
 *                 (detected music, bass vs treble, back to the sphere) and Codex's voice moving the speaking body
 *   v0.4.3        through the real MCP tools: 永 written stroke by stroke (the card in step, a stroke repeated, slower,
 *                 complete); the figure jumping over a box (its props drawn) and returning; a local photograph as a
 *                 heritage oval; Codex Voice Sync reconnecting by itself when Aion is opened again (stand-in bridge)
 *
 * Screenshots land in .e2e/smoke/. Needs a local Chrome (CHROME_PATH overrides); skips with a message when there
 * is none. `-- --offline` skips the public portrait and terrain lookups. `-- --only=v42,listening` runs only those sections.
 */
const OUT = join(REPO_ROOT, ".e2e", "smoke");
const chromePath = process.env.CHROME_PATH ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find(existsSync);
if (!chromePath) { console.log("smoke: no Chrome found (set CHROME_PATH); skipped"); process.exit(0); }
const pagePath = join(PLUGIN_ROOT, "runtime", "presence.html");
if (!existsSync(pagePath)) { console.error("smoke: run npm run build first"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "aion-smoke-"));
/** What the stand-in bridge plays next (see scripts/lib/fakeBridge.ts). */
let bridgeSignal = "music";
const hub = new PresenceHub({
  home, port: 0, page: () => readFileSync(pagePath, "utf8"),
  bridge: {
    locate: () => "stand-in", isMac: true, macosVersion: 15,
    launch: (_app, args) => spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "lib", "fakeBridge.ts"), ...args], { stdio: "ignore", env: { ...process.env, AION_FAKE_SIGNAL: bridgeSignal } }),
  },
});
await hub.start();
hub.apply({ type: "open" });
const GPU = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"];
const launch = (extra: string[] = []) => chromium.launch({ executablePath: chromePath, headless: true, args: [...GPU, ...extra] });
// The default fake device (a test tone) for permission paths; the speech-like signal gets its own browser below.
const browser = await launch(["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]);
const offline = process.argv.includes("--offline");
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? "✓" : "✗"} ${what}`); if (!ok) failures.push(what); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The view's diagnostics (?debug=1 exposes it), one line per stage of the live chain. */
const diag = (page: Page) => page.evaluate("window.aionPresence.diagnostics()") as Promise<Record<string, string>>;
interface Live {
  state: string; activity: string; host: string; voiced: boolean; userAmplitude: number; responding: number; focus: number; rms: number;
  mic: string; card: string; phase: string; route: string | null; immersive: string; fullscreen: boolean; frames: number;
}
const live = (page: Page) => page.evaluate(`(() => { const v = window.aionPresence; if (!v) return { frames: 0, mic: "", card: "none", phase: "", immersive: "off" };
  v.immersive.sync(); const s = v.presence.signal;
  return { state: v.aion.currentState, activity: v.presence.activity, host: v.snapshot ? v.snapshot.activity.state : "", voiced: v.presence.userVoiced,
    userAmplitude: s.userAmplitude, responding: s.responding, focus: s.focus, rms: v.presence.lastFrame ? v.presence.lastFrame.rms : 0, mic: v.mic,
    card: v.cardState, phase: v.visual.phase, route: v.snapshot && v.snapshot.presentation ? v.snapshot.presentation.route : null,
    immersive: v.immersive.phase, fullscreen: document.fullscreenElement !== null, frames: v.runtime ? v.runtime.quality().frames : 0 }; })()`) as Promise<Live>;
/** Waits until `ok` holds for the live state (or the time runs out); returns the last state seen. */
async function until(page: Page, ok: (state: Live) => boolean, ms = 8_000) {
  let state = await live(page);
  for (let waited = 0; waited < ms && !ok(state); waited += 200) { await pause(200); state = await live(page); }
  return state;
}

/**
 * What the eye sees, from screenshots. Each frame becomes a 64×48 luminance grid. `motion`: mean change per cell
 * between consecutive frames (shape-level movement; particle jitter averages out). `extent`: the lit share of the
 * frame (a gathering body is smaller).
 */
async function look(page: Page, frames = 10, every = 160) {
  const shots: string[] = [];
  for (let i = 0; i < frames; i++) { shots.push((await page.screenshot({ type: "png" })).toString("base64")); await pause(every); }
  return page.evaluate(`(async (list) => {
    const grid = async (data) => { const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
      const c = new OffscreenCanvas(64, 48); const x = c.getContext("2d"); x.drawImage(img, 0, 0, 64, 48); const d = x.getImageData(0, 0, 64, 48).data;
      const out = new Float32Array(64 * 48); for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; return out; };
    const grids = await Promise.all(list.map(grid));
    let motion = 0, extent = 0;
    for (let f = 0; f < grids.length; f++) {
      let lit = 0; for (const v of grids[f]) if (v > 28) lit++; extent += lit / grids[f].length;
      if (f) { let d = 0; for (let i = 0; i < grids[f].length; i++) d += Math.abs(grids[f][i] - grids[f - 1][i]); motion += d / grids[f].length; }
    }
    return { motion: motion / (grids.length - 1), extent: extent / grids.length };
  })(${JSON.stringify(shots)})`) as Promise<{ motion: number; extent: number }>;
}
const open = async (target: Browser, query = "", viewport = { width: 1100, height: 760 }) => {
  const page = await target.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${hub.surfaceUrl}&debug=1${query}`);
  await until(page, state => state.frames > 30, 10_000);
  return { page, errors };
};

const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",");
const section = (name: string) => !only || only.includes(name);
try {
  if (section("renderers")) await renderers();
  if (section("visuals")) await visuals();
  if (section("v4")) for (const renderer of ["auto", "canvas"] as const) await v4(renderer);
  if (section("v41")) for (const renderer of ["auto", "canvas"] as const) await v41(renderer);
  if (section("v42")) { await music(); for (const renderer of ["auto", "canvas"] as const) await sound(renderer); }
  if (section("v43")) { for (const renderer of ["auto", "canvas"] as const) await v43(renderer); await voiceSync(); }
  if (section("v44")) for (const renderer of ["auto", "canvas"] as const) await v44(renderer);
  if (section("listening")) await listening();
  if (section("responding")) await responding();
  if (section("immersive")) await immersive();
  if (section("embedded")) await embedded();
  if (section("v45")) { for (const renderer of ["auto", "canvas"] as const) await v45(renderer); await cardFallback(); }
} finally {
  await browser.close();
  await hub.stop();
}

async function renderers() {
  for (const renderer of ["auto", "canvas"] as const) {
    console.log(`renderer: ${renderer}`);
    const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
    const info = await diag(page);
    console.log(`  ${info.renderer}`);
    check(/^companion · live/.test(info.surface), "the companion surface is live");
    check(renderer === "canvas" ? /^canvas/.test(info.renderer) : /^(webgpu|canvas)/.test(info.renderer), "a renderer started");
    const frames = (await live(page)).frames;
    await pause(1_000);
    check((await live(page)).frames > frames + 20, "frames are being drawn");
    check((await look(page, 2)).extent > 0.02, "the sphere is visible");
    await page.screenshot({ path: join(OUT, `${renderer}-1-sphere.png`) });

    hub.apply({ type: "activity", state: "testing", label: "npm test" });
    check((await until(page, s => s.activity === "testing", 2_000)).activity === "testing", "activity arrives");
    check((await page.locator("#status").textContent())?.includes("Testing · npm test") ?? false, "the status line names it");

    hub.apply({ type: "body", body: "figure" });
    await pause(3_000);
    check(/body figure/.test((await diag(page)).state), "the figure body forms");
    await page.screenshot({ path: join(OUT, `${renderer}-2-figure.png`) });

    hub.apply({ type: "present", content: { kind: "form", form: "astronomy.orion", label: visualForms.label("astronomy.orion") }, hold: 6 });
    check((await until(page, s => s.phase === "holding")).phase === "holding", "figure → Orion: the visual forms");
    await page.screenshot({ path: join(OUT, `${renderer}-3-orion.png`) });
    // The hold is time formed (SCF), then the body returns: wait for it rather than for a fixed time.
    const back = await until(page, s => s.phase === "sphere", 12_000);
    check(back.phase === "sphere" && /body figure/.test((await diag(page)).state), "Orion → figure: back to the persistent body");

    hub.apply({ type: "present", content: { kind: "result", title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed", "Build successful"] }, hold: 8 });
    await until(page, s => s.card === "shown", 4_000);
    check((await page.locator("#card").textContent())?.includes("48 / 48 tests passed") ?? false, "the result card shows the summary");
    check((await live(page)).state !== "presenting", "a card leaves the body living (it is not frozen in presenting)");
    await page.screenshot({ path: join(OUT, `${renderer}-4-result.png`) });

    hub.apply({ type: "present", content: { kind: "text", text: "48/48" }, hold: 5 });
    await pause(3_000);
    await page.screenshot({ path: join(OUT, `${renderer}-5-text.png`) });
    hub.apply({ type: "clear" });
    hub.apply({ type: "body", body: "sphere" });
    hub.apply({ type: "activity", state: "idle" });
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
    await page.close();
  }
}

/** v0.4 on the real surface: the third body, expressions, the explanation cue, heritage portraits and 3D. */
async function v4(renderer: "auto" | "canvas") {
  console.log(`v0.4: eyes, figure explanation, heritage, 3D (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
  const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
  const name = (moment: string) => join(OUT, `v4-${renderer}-${moment}.png`);
  hub.apply({ type: "body", body: "eyes" });
  await pause(3_000);
  check(/body eyes/.test((await diag(page)).state), "the eyes body forms");
  check((await look(page, 2)).extent > 0.01, "the eyes are visible");
  hub.apply({ type: "express", expression: "happy", seconds: 3 });
  await pause(800);
  check(await view<string>("v.aion.eyes.expression") === "happy", "express: the eyes look happy");
  await page.screenshot({ path: name("eyes-happy") });

  hub.apply({ type: "body", body: "figure" });
  await pause(3_000);
  hub.apply({ type: "present", content: { kind: "text", text: "a² + b² = c²", emphasis: "c²" }, hold: 10 });
  await until(page, s => s.card === "shown", 4_000);
  check(await page.locator("#card mark.emphasis").textContent() === "c²", "the card marks the emphasised term");
  await pause(1_600);
  check(await view<string | null>("v.aion.figure.cueing") === "explain", "the figure explains the term");
  await pause(1_500);
  await page.screenshot({ path: name("figure-explain") });
  hub.apply({ type: "clear" });
  await pause(1_000);

  if (!offline) {
    const tesla = await new VisualResolver({ env: {} }).portrait("Nikola Tesla");
    hub.apply({ type: "present", content: { kind: "image", media: hub.addMedia(Buffer.from(tesla.bytes)), fit: "portrait", origin: "lookup", alt: "Nikola Tesla", style: "heritage" }, presentation: "body", hold: 5 });
    check((await until(page, s => s.phase === "holding")).phase === "holding", "a heritage portrait forms");
    await pause(500);
    await page.screenshot({ path: name("heritage-tesla") });
    check((await until(page, s => s.phase === "sphere", 12_000)).phase === "sphere", "heritage → figure: back to the persistent body");
  }

  hub.apply({ type: "body", body: "sphere" });
  await pause(2_500);
  hub.apply({ type: "present", content: { kind: "scene", scene: SCENE_PRESETS.pyramid, label: "Egyptian pyramid", preset: "pyramid" }, hold: 30 });
  check((await until(page, s => s.phase === "holding")).phase === "holding", "the 3D pyramid forms");
  check(await view<boolean>("v.orbit.active"), "the 3D view is active");
  const yaw = () => view<number>("v.orbit.yaw"), pitch = () => view<number>("v.orbit.pitch");
  const before = await yaw();
  await page.mouse.move(550, 380); await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(550 - i * 8, 380); await pause(16); }
  await page.mouse.up();
  check(await yaw() < before - 0.5, "dragging turns it");
  const tilt = await pitch();
  hub.apply({ type: "view", rotate: "up", degrees: 30 });
  await pause(1_200);
  check(await pitch() > tilt + 0.3, "set_scene_view tilts it");
  await page.screenshot({ path: name("pyramid") });
  const turned = await yaw();
  await pause(4_500);
  check(await yaw() > turned + 0.1, "it turns slowly by itself after the user lets go");
  hub.apply({ type: "clear" });
  check((await until(page, s => s.phase === "sphere", 6_000)).phase === "sphere", "3D → sphere: back to the persistent body");
  check(!(await view<boolean>("v.orbit.active")), "the 3D view ends with it");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}

/**
 * v0.4.1 on the real surface, driven through the real MCP tools (as Codex calls them): a portrait is heritage by
 * default; a map forms and its markers appear in their colours at their places, change in place (the map is not
 * formed again), and stand on terrain; the particles change colour and come back to Aion Silver.
 */
async function v41(renderer: "auto" | "canvas") {
  console.log(`v0.4.1: heritage default, maps and markers, terrain markers, colours (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
  const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
  const name = (moment: string) => join(OUT, `v41-${renderer}-${moment}.png`);
  const aion = await connectAion({ home, resolver: new VisualResolver({ env: {} }) });
  const tool = async (tool: string, args: Record<string, unknown>) => {
    const result = await aion.call(tool, args) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) console.log(`    ${tool}: ${result.content[0]?.text}`);
    return !result.isError;
  };
  /** The mean colour of a small square of the screen. */
  const colorAt = async (x: number, y: number, r = 6) => {
    const shot = (await page.screenshot({ type: "png", clip: { x: Math.max(0, x - r), y: Math.max(0, y - r), width: r * 2, height: r * 2 } })).toString("base64");
    return page.evaluate(`(async () => { const img = new Image(); img.src = "data:image/png;base64,${shot}"; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext("2d"); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, img.width, img.height).data;
      // The lit pixels only (the particles, the marker), so a sparse body is not drowned by the background.
      const s = [0, 0, 0]; let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] < 150) continue; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
      return n ? s.map(v => v / n) : [0, 0, 0]; })()`) as Promise<[number, number, number]>;
  };
  try {
    if (!offline) {
      check(await tool("show_portrait", { person: "Nikola Tesla" }), "show_portrait with no style");
      check((await until(page, s => s.phase === "holding", 15_000)).phase === "holding", "the portrait forms");
      check(await view<string>("v.visual.target.visual.frame") === "oval", "it is a heritage oval by default");
      await page.screenshot({ path: name("heritage-default") });
      await tool("clear_presentation", {});
      await until(page, s => s.phase === "sphere", 6_000);
    }
    check(await tool("show_map", { region: "United States" }), "show_map: the United States");
    check((await until(page, s => s.phase === "holding", 8_000)).phase === "holding", "the map forms");
    check(await view<string>("v.visual.target.visual.kind") === "map", "as a map");
    const revision = await view<number>("v.visual.revision"), id = await view<string>("v.snapshot.presentation.id");
    check(await tool("mark_map", { add: [{ place: "Los Angeles", color: "red" }] }), "mark_map: Los Angeles in red");
    check(await tool("mark_map", { add: [{ place: "New York", color: "yellow" }] }), "mark_map: New York in yellow");
    await pause(1_500);
    check(await view<number>("v.visual.revision") === revision && await view<string>("v.snapshot.presentation.id") === id && (await live(page)).phase === "holding",
      "the markers changed in place: the map was not formed again");
    const markers = await view<Record<string, { x: number; y: number; visible: number; color: string }>>("Object.fromEntries(v.markerLayer.positions)");
    const la = markers["los-angeles"], ny = markers["new-york"];
    check(!!la && !!ny && la.visible > 0.9 && ny.visible > 0.9, "both markers are drawn");
    if (la && ny) {
      check(la.x < ny.x - 250 && la.y > ny.y, `Los Angeles is far to the west and south of New York on screen (${la.x.toFixed(0)},${la.y.toFixed(0)} vs ${ny.x.toFixed(0)},${ny.y.toFixed(0)})`);
      const [r, g, b] = await colorAt(la.x, la.y), [yr, yg, yb] = await colorAt(ny.x, ny.y);
      check(r > g + 40 && r > b + 40, `a red marker at Los Angeles (${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`);
      check(yr > yb + 40 && yg > yb + 40, `a yellow marker at New York (${yr.toFixed(0)},${yg.toFixed(0)},${yb.toFixed(0)})`);
    }
    await page.screenshot({ path: name("usa-la-ny") });
    check(await tool("mark_map", { change: [{ place: "Los Angeles", color: "blue" }] }), "mark_map: Los Angeles in blue");
    await pause(1_200);
    const blue = await view<{ x: number; y: number } | undefined>("v.markerLayer.positions.get('los-angeles')");
    if (blue) { const [r, , b] = await colorAt(blue.x, blue.y); check(b > r + 40, "the marker turned blue"); }
    check(await tool("mark_map", { remove: ["New York"] }), "mark_map: remove New York");
    await pause(800);
    check(!(await view<boolean>("v.markerLayer.positions.has('new-york')")), "New York is gone");
    if (!offline) {
      check(await tool("show_terrain", { region: "Scotland" }), "show_terrain: Scotland");
      let formed = false;
      for (let waited = 0; waited < 25_000 && !formed; waited += 250) { await pause(250); formed = await view<boolean>("v.visual.phase === 'holding' && v.visual.target.visual.kind === 'heightfield'"); }
      check(formed, "the terrain forms");
      check(await tool("mark_map", { add: [{ place: "Glasgow", color: "red" }] }), "mark_map: Glasgow in red on the terrain");
      await pause(1_500);
      const glasgow = await view<{ visible: number } | undefined>("v.markerLayer.positions.get('glasgow')");
      check((glasgow?.visible ?? 0) > 0.9, "the Glasgow pin stands on the relief");
      await page.screenshot({ path: name("scotland-glasgow") });
    }
    await tool("clear_presentation", {});
    await until(page, s => s.phase === "sphere", 6_000);
    const centre = { x: 550, y: 380 };
    const silver = await colorAt(centre.x, centre.y, 60);
    check(await tool("set_colors", { base: "blue" }), "set_colors: blue");
    await pause(2_200);
    const blueBody = await colorAt(centre.x, centre.y, 60);
    check(blueBody[2] - blueBody[0] > (silver[2] - silver[0]) + 10, `the body turns blue (b−r ${(silver[2] - silver[0]).toFixed(0)} → ${(blueBody[2] - blueBody[0]).toFixed(0)})`);
    await page.screenshot({ path: name("blue") });
    check(await tool("set_colors", { base: "紫色" }), "set_colors: 紫色");
    await pause(2_200);
    const purple = await colorAt(centre.x, centre.y, 60);
    check(purple[0] > blueBody[0] + 8, "then purple");
    check(await tool("set_colors", { reset: "base" }), "set_colors: reset");
    await pause(2_500);
    const back = await colorAt(centre.x, centre.y, 60);
    check(Math.abs((back[2] - back[0]) - (silver[2] - silver[0])) < 12, "and back to Aion Silver");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally {
    await aion.close();
    await page.close();
  }
}

/**
 * The visuals restored from SCF, on the real surface, routed by the Presentation Router: a portrait looked up on
 * public sources is a hybrid (particles + the original photograph in a card), terrain and Aion's own forms are the
 * body alone, long text and code are cards. Every visual returns to the persistent body: figure → Tesla → figure.
 */
async function visuals() {
  console.log("visuals and the Presentation Router");
  const { page, errors } = await open(browser, "&mic=0", { width: 1100, height: 760 });
  hub.apply({ type: "body", body: "figure" });
  await pause(3_000);
  const show = async (name: string, content: PresentationContent, options: { returns?: boolean; route?: string; hold?: number | null } = {}) => {
    hub.apply({ type: "present", content, ...(options.hold === null ? {} : { hold: options.hold ?? 4 }) });
    const formed = await until(page, s => s.phase === "holding" || (s.card === "shown" && s.route === "card"));
    check(formed.phase === "holding" || formed.card === "shown", `${name} forms`);
    if (options.route) check(formed.route === options.route, `${name} → ${options.route}${formed.route !== options.route ? ` (got ${formed.route})` : ""}`);
    await pause(400);
    await page.screenshot({ path: join(OUT, `visual-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`) });
    if (options.returns === false) return;
    const back = await until(page, s => s.phase === "sphere", 12_000);
    check(back.phase === "sphere" && /body figure/.test((await diag(page)).state), `${name} → figure: back to the persistent body`);
  };
  if (!offline) {
    const resolver = new VisualResolver({ env: {} });
    try {
      const tesla = await resolver.portrait("Nikola Tesla");
      await show("Nikola Tesla portrait", {
        kind: "image", media: hub.addMedia(Buffer.from(tesla.bytes)), fit: "portrait", origin: "lookup", alt: "Nikola Tesla", credit: "Wikipedia",
        ...(tesla.width && tesla.height ? { width: tesla.width, height: tesla.height } : {}),
      }, { route: "hybrid", returns: false, hold: null });
      const photo = await page.evaluate(`(() => { const img = document.querySelector("#card img"); return img ? { w: img.naturalWidth, h: img.naturalHeight } : null; })()`) as { w: number; h: number } | null;
      check(photo !== null && Math.max(photo.w, photo.h) >= 600, `the card shows the original photograph, not the particle raster (${photo ? `${photo.w}×${photo.h}` : "none"})`);
      const back = await until(page, s => s.phase === "sphere", 16_000);
      check(back.phase === "sphere" && back.card === "shown", "the particle portrait returns to the body while the photograph stays a little longer");
      hub.apply({ type: "clear" });
      const uk = await resolver.terrain("United Kingdom");
      await show("United Kingdom terrain", { kind: "terrain", media: hub.addMedia(Buffer.from(uk.bytes)), style: "terrain", label: "United Kingdom" }, { route: "body" });
    } catch (error) { check(false, `public lookups resolve (${(error as Error).message})`); }
  } else console.log("  ! --offline: the portrait and terrain lookups were skipped");
  await show("Orion", { kind: "form", form: "astronomy.orion", label: visualForms.label("astronomy.orion") }, { route: "body" });
  check((await live(page)).card === "none", "Orion: no unnecessary card");
  await show("yin-yang", { kind: "form", form: "tao.yin-yang", label: visualForms.label("tao.yin-yang") }, { route: "body", returns: false });
  await show("clock", { kind: "clock", time: "09:05" }, { route: "body", returns: false });
  await show("number", { kind: "number", value: "42%" }, { route: "body", returns: false });
  await show("emoji", { kind: "emoji", emoji: "🚀" }, { route: "body", returns: false });
  hub.apply({ type: "clear" });
  await until(page, s => s.phase === "sphere", 6_000);
  const text = "The build failed because the store test still asserted the v0.2 presentation plan. The surface now reads the routed plan, so the assertion was updated to the new contract; runtime behaviour did not change. ".repeat(3);
  await show("long text", { kind: "text", title: "Why the build failed", text: text.slice(0, 590) }, { route: "card", returns: false });
  const textState = await live(page);
  check(textState.phase === "sphere" && textState.state !== "presenting", "long text never becomes particles; the body keeps living beside the card");
  await show("code", { kind: "artifact", type: "code", title: "The fix", language: "typescript", content: "export function planPresentation(presentation, route) {\n  const body = route === \"card\" ? { type: \"none\" } : bodyVisual(presentation);\n  return { body, card: route !== \"body\" || body.type === \"none\" };\n}" }, { route: "card", returns: false });
  check(((await page.locator("#card pre").textContent()) ?? "").includes("planPresentation"), "code stays exact in its card");
  hub.apply({ type: "clear" });
  hub.apply({ type: "activity", state: "idle" });
  hub.apply({ type: "body", body: "sphere" });
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}

/**
 * Local listening through the real browser microphone path. Chrome's capture device plays a speech-like signal
 * (scripts/lib/fakeSpeech.ts: quiet, then phrases, then quiet): the page's own getUserMedia, MicrophoneListener,
 * VAD and PresenceEngine must turn it into listening the body visibly shows. Refused, Aion keeps working.
 */
async function listening() {
  console.log("listening (the browser microphone path, with a speech-like capture signal)");
  const wav = join(OUT, "speech.wav");
  const timing = speechWav(wav, { lead: 3, phrases: 5, tail: 4 });
  const speaking = await launch(["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`]);
  try {
    const context = await speaking.newContext({ viewport: { width: 900, height: 700 } });
    await context.grantPermissions(["microphone"]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const started = Date.now();
    await page.goto(`${hub.surfaceUrl}&debug=1`);
    const ready = await until(page, s => s.mic === "ready", 6_000);
    check(ready.mic === "ready", "the microphone is analysed locally once Presence opens");
    const info = await diag(page);
    check(/permission granted/.test(info.mic) && /audio running|audio starting/.test(info.mic), `diagnostics report the capture (${info.mic})`);
    // Watch the whole signal: quiet room, speech, quiet again.
    const seen = { quietRms: Infinity, speechRms: 0, voiced: false, listening: false, stateListening: false, amplitude: 0, thinking: false };
    const quiet: { extent: number }[] = [], heard: { extent: number }[] = [];
    while (Date.now() - started < (timing.speechEnd + 3) * 1000 + 1_500) {
      const state = await live(page);
      const t = (Date.now() - started) / 1000;
      if (t > 1.5 && t < timing.speechStart - 0.3) { seen.quietRms = Math.min(seen.quietRms, state.rms); if (quiet.length < 2) quiet.push(await look(page, 4, 120)); }
      if (state.voiced) seen.voiced = true;
      seen.speechRms = Math.max(seen.speechRms, state.rms);
      if (state.activity === "listening") seen.listening = true;
      if (state.state === "listening") { seen.stateListening = true; if (heard.length < 3) heard.push(await look(page, 4, 120)); }
      seen.amplitude = Math.max(seen.amplitude, state.userAmplitude);
      if (seen.listening && state.activity === "thinking") seen.thinking = true;
      if (state.state === "listening" && heard.length === 1) await page.screenshot({ path: join(OUT, "listening.png") });
      await pause(150);
    }
    check(seen.speechRms > 0.02 && seen.quietRms < 0.01, `RMS follows the signal (quiet ${seen.quietRms.toFixed(4)} → speech ${seen.speechRms.toFixed(4)})`);
    check(seen.voiced, "the VAD hears voice");
    check(seen.listening, "the effective activity becomes listening");
    check(seen.stateListening, "Aion's state becomes listening");
    check(seen.amplitude > 0.2, `the user's loudness reaches the renderer (userAmplitude up to ${seen.amplitude.toFixed(2)})`);
    check(seen.thinking, "when the speech ends, Aion turns to thinking");
    const mean = (items: { extent: number }[]) => items.reduce((sum, item) => sum + item.extent, 0) / Math.max(1, items.length);
    check(quiet.length > 0 && heard.length > 0 && mean(heard) < mean(quiet) * 0.97,
      `the body visibly gathers while listening (lit extent ${mean(quiet).toFixed(3)} → ${mean(heard).toFixed(3)})`);
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
    // A visual on the body does not silence listening: the next loop of the signal arrives while Orion holds.
    hub.apply({ type: "present", content: { kind: "form", form: "astronomy.orion", label: "Orion" }, hold: 30 });
    const during = await until(page, s => s.phase === "holding" && s.activity === "listening" && s.userAmplitude > 0.1, (timing.seconds + 4) * 1000);
    check(during.activity === "listening" && during.userAmplitude > 0.1 && during.state === "presenting", "while a visual is formed, Aion still listens (and the visual follows the voice)");
    hub.apply({ type: "clear" });
    await context.close();
  } finally { await speaking.close(); }

  const refused = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const denied = await refused.newPage();
  const errors: string[] = [];
  denied.on("pageerror", error => errors.push(error.message));
  await denied.goto(`${hub.surfaceUrl}&debug=1`);
  const state = await until(denied, s => s.mic === "denied" || s.mic === "unavailable", 4_000);
  check((state.mic === "denied" || state.mic === "unavailable") && /^companion · live/.test((await diag(denied)).surface), "refused: Presence keeps working without it");
  check(((await denied.locator("#status").textContent()) ?? "").includes("Microphone off"), "and says so once, quietly");
  hub.apply({ type: "activity", state: "testing" });
  check((await until(denied, s => s.activity === "testing", 2_000)).activity === "testing", "and follows the host's states");
  hub.apply({ type: "activity", state: "idle" });
  check(errors.length === 0, "no page errors");
  await refused.close();
}

/** The responding chain from the Skill's own call: MCP tool → hub → surface → engine → Aion → visible motion. */
async function responding() {
  console.log("responding (Skill → MCP → hub → surface → body)");
  // An Aion MCP server in another "Codex session": it finds this hub and drives it over the local API.
  const aion = await connectAion({ home });
  const { page, errors } = await open(browser, "&mic=0", { width: 900, height: 700 });
  try {
    for (const body of ["sphere", "figure"] as const) {
      await aion.call("set_body_form", { body });
      await aion.call("set_presence_state", { state: "idle" });
      await pause(3_200);
      // The figure's hands, read from its live skeleton: how far they travel in a few seconds.
      const hands = async () => {
        const points: number[][] = [];
        for (let i = 0; i < 40; i++) {
          points.push(await page.evaluate("(() => { const a = window.aionPresence.aion.figure.anchors; return [a[24], a[25], a[28], a[29]]; })()") as number[]);
          await pause(100);
        }
        return Math.max(...[0, 1, 2, 3].map(k => Math.max(...points.map(p => p[k])) - Math.min(...points.map(p => p[k]))));
      };
      const idle = body === "figure" ? null : await look(page, 14, 150);
      const idleHands = body === "figure" ? await hands() : 0;
      await aion.call("set_presence_state", { state: "responding" });
      const answering = await until(page, s => s.state === "responding" && s.responding > 0.8, 4_000);
      check(answering.host === "responding" && answering.state === "responding" && answering.responding > 0.8, `${body}: responding reaches the body (signal ${answering.responding.toFixed(2)})`);
      if (idle) {
        const moving = await look(page, 14, 150);
        const ratio = moving.motion / Math.max(1e-6, idle.motion);
        check(moving.motion > 0 && (ratio > 1.05 || Math.abs(moving.extent - idle.extent) > 0.004),
          `${body}: answering is visibly different from idle (motion ×${ratio.toFixed(2)}, extent ${idle.extent.toFixed(3)} → ${moving.extent.toFixed(3)})`);
      } else {
        const answeringHands = await hands();
        check(answeringHands > 0.15 && answeringHands > idleHands * 1.5,
          `${body}: answering gestures with the hands (range ${idleHands.toFixed(2)} → ${answeringHands.toFixed(2)} world units)`);
      }
      await page.screenshot({ path: join(OUT, `responding-${body}.png`) });
    }
    // The turn ends while the answer is still being said (Codex's Stop hook): the body keeps answering, then completes.
    await aion.call("set_presence_state", { state: "responding" });
    await fetch(new URL(`api/hook?token=${hub.surfaceUrl.split("token=")[1]}`, hub.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "Stop", speech_seconds: 6 }),
    });
    await pause(2_500);
    check((await live(page)).state === "responding", "after Stop, the body keeps answering while the answer is said");
    check((await until(page, s => s.host === "complete", 8_000)).host === "complete", "then it completes");
    check((await until(page, s => s.responding < 0.1, 4_000)).responding < 0.1, "and the answering motion ends");
    await aion.call("set_body_form", { body: "sphere" });
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { await page.close(); await aion.close(); }
}

/** Music (v0.4.2): lessons, engraved notation checked against theory, playback in step with the audio clock. */
async function music() {
  console.log("v0.4.2 music (MCP → hub → surface)");
  const aion = await connectAion({ home });
  const { page, errors } = await open(browser, "&mic=0", { width: 1280, height: 800 });
  type Out = { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
  const call = async (name: string, args: Record<string, unknown>) => await aion.call(name, args) as Out;
  const musicOf = (out: Out) => out.structuredContent?.music as { notes: Record<string, unknown>[]; playback?: string; lesson?: Record<string, unknown>; answer?: { correct: boolean } } | undefined;
  /** Every staff line and notehead of the card, in svg pixels. */
  const engraving = () => page.evaluate(`(() => {
    const svg = document.querySelector("#card .music-score svg"); if (!svg) return null;
    const lines = [...svg.querySelectorAll(".vf-stave path")].map(p => p.getBBox()).filter(b => b.height < 1.5 && b.width > 20).map(b => b.y);
    const notes = [...svg.querySelectorAll(".music-note")].map(g => { const head = g.querySelector(".vf-notehead") || g; const b = head.getBBox(); return { cls: g.getAttribute("class"), y: b.y + b.height / 2, x: b.x }; });
    return { lines: [...new Set(lines.map(y => Math.round(y * 10) / 10))].sort((a, b) => a - b), notes, lit: svg.querySelectorAll(".lit").length, marks: svg.querySelectorAll(".staff-mark").length, clefLit: !!svg.querySelector(".music-clef.lit") };
  })()`) as Promise<{ lines: number[]; notes: { cls: string; y: number; x: number }[]; lit: number; marks: number; clefLit: boolean } | null>;
  try {
    // Demo A: the five-line staff.
    let out = await call("music_lesson", { lesson: 1 });
    check(!out.isError && musicOf(out)?.lesson?.step === 1, "lesson 1 begins");
    await until(page, s => s.card === "shown", 6_000);
    await pause(1_200);
    let engraved = await engraving();
    check(!!engraved && engraved.lines.length === 5, `the staff has five lines (${engraved?.lines.length ?? 0})`);
    check(!!engraved && engraved.marks === 5, "all five lines are lit for the explanation");
    await page.screenshot({ path: join(OUT, "music-1-staff.png") });
    out = await call("music_lesson", { step: "next" });
    await pause(800);
    check(musicOf(out)?.lesson?.step === 2 && (await engraving())?.marks === 4, "next: the four spaces are lit");

    // Demo A (cont.): the treble clef, the body forming it beside the staff (HYBRID).
    out = await call("music_lesson", { lesson: 2 });
    const clef = await until(page, s => s.card === "shown" && s.phase === "holding" && s.route === "hybrid", 8_000);
    engraved = await engraving();
    check(clef.route === "hybrid" && clef.phase === "holding", "the treble clef: notation on the card and the clef in particles (hybrid)");
    check(!!engraved?.clefLit && engraved.lit >= 2, "the clef, line 2 and its G are lit");
    await pause(600);
    await page.screenshot({ path: join(OUT, "music-2-treble-clef.png") });
    const zh = await call("music_lesson", { language: "zh" });
    check(musicOf(zh)?.lesson?.step === 1 && musicOf(zh)?.lesson?.id === 2 && /高音谱号/.test(String(musicOf(zh)?.lesson?.title)), "switching to Chinese keeps the lesson and step");
    await call("music_lesson", { language: "en" });

    // Figure 2.0 teaches: it turns to the lit note and explains it, then points at each note as it sounds.
    await call("set_body_form", { body: "figure" });
    await pause(2_600);
    await call("show_music", { title: "E on line 1", notes: [{ pitch: "E4", duration: "whole", label: "E" }], highlight: [{ note: 0 }, { line: 1 }] });
    await until(page, s => s.card === "shown", 6_000);
    await pause(1_700);
    check(await page.evaluate("window.aionPresence.aion.figure.cueing") === "explain", "the figure turns to the lit note and explains it");
    await pause(1_200);
    await page.screenshot({ path: join(OUT, "music-figure-explains.png") });
    await call("play_music", { scale: { tonic: "C4" }, tempo: 100 });
    let pointed = false;
    for (let i = 0; i < 30 && !pointed; i++) { pointed = await page.evaluate("window.aionPresence.aion.figure.cueing") === "point"; await pause(100); }
    check(pointed, "and points at the notes as they sound");
    await page.screenshot({ path: join(OUT, "music-figure-points.png") });
    await pause(4_000);
    await call("set_body_form", { body: "sphere" });
    await pause(1_500);

    // Demo B: middle C, on its ledger line, played and lit while it sounds.
    out = await call("show_music", { title: "Middle C", notes: [{ pitch: "C4", duration: "whole", label: "middle C" }], highlight: [{ note: 0 }], play: true, tempo: 90 });
    check(musicOf(out)?.playback === "playing", `middle C plays (${musicOf(out)?.playback})`);
    const facts = musicOf(out)?.notes[0] as { pitch: string; where: string; frequency: number } | undefined;
    check(facts?.pitch === "C4" && /first ledger line below/.test(facts.where) && Math.abs(facts.frequency - 261.63) < 0.01, `the result names it: ${facts?.pitch}, ${facts?.where}, ${facts?.frequency} Hz`);
    await pause(700);
    const sounding = await page.evaluate("!!document.querySelector('#card .music-note.sounding')");
    check(sounding as boolean, "the note is lit while it sounds");
    await page.screenshot({ path: join(OUT, "music-3-middle-c.png") });
    await pause(3_000);

    // Demo C: the C major scale, every note where theory puts it, each lit at the moment it is heard.
    out = await call("show_music", { title: "C major scale", scale: { tonic: "C4" }, tempo: 80 });
    await pause(1_500);
    engraved = await engraving();
    const spacing = engraved ? (engraved.lines[4] - engraved.lines[0]) / 4 : 0;
    const bottom = engraved?.lines[4] ?? 0;
    const positions = [-2, -1, 0, 1, 2, 3, 4, 5];
    const errorsPx = engraved?.notes.map((note, i) => Math.abs(note.y - (bottom - positions[i] * spacing / 2))) ?? [99];
    check(engraved?.notes.length === 8 && Math.max(...errorsPx) < spacing * 0.2,
      `C4…C5 sit exactly on their lines and spaces (largest error ${Math.max(...errorsPx).toFixed(2)} px of a ${spacing.toFixed(1)} px staff space)`);
    // The lit note is timed in the page itself (a MutationObserver on the card), so the test's own polling adds no jitter.
    await page.evaluate(`(() => { window.__lit = []; const card = document.querySelector("#card");
      new MutationObserver(() => { const s = card.querySelector(".music-note.sounding"); const m = s && /note-(\\d+)/.exec(s.getAttribute("class"));
        const index = m ? Number(m[1]) : -1; if (index >= 0 && (window.__lit.at(-1) || {}).index !== index) window.__lit.push({ index, t: performance.now() }); })
        .observe(card, { subtree: true, attributes: true, attributeFilter: ["class"] }); })()`);
    out = await call("play_music", {});
    check(musicOf(out)?.playback === "playing", "play_music plays the music on show");
    await pause(2_300);
    const reason = await page.evaluate("(() => { const a = window.aionPresence.audio; return a.route.reason + ', sphere ' + a.sample(0).sphere.toFixed(2); })()") as string;
    await page.screenshot({ path: join(OUT, "music-4-scale-playing.png") });
    await pause(5_000);
    const seen = await page.evaluate("window.__lit") as { index: number; t: number }[];
    const order = seen.map(item => item.index).join(" ");
    const gaps = seen.slice(1).map((item, i) => (item.t - seen[i].t) / 1000);
    check(order === "0 1 2 3 4 5 6 7", `each note lights in order as it sounds (${order})`);
    check(gaps.length === 7 && gaps.every(gap => Math.abs(gap - 0.75) < 0.05), `one quarter note apart at 80 bpm (${gaps.map(g => g.toFixed(3)).join(", ")} s; 0.75 s expected)`);
    check(/^playback/.test(reason), `the body moves with the playback's own sound (${reason})`);

    // Lesson 8: a practice question, answered.
    out = await call("music_lesson", { lesson: 8 });
    const asked = musicOf(out)?.notes[0] as { name: string } | undefined;
    const answer = await call("music_lesson", { answer: asked?.name ?? "C" });
    check(musicOf(answer)?.answer?.correct === true, `a practice answer is checked (${asked?.name} → correct)`);
    const wrong = await call("music_lesson", { answer: asked?.name === "E" ? "F" : "E" });
    check(musicOf(wrong)?.answer?.correct === false, "and a wrong one is not");
    await aion.call("clear_presentation");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { await page.close(); await aion.close(); }
}

/**
 * Sound (v0.4.2): another app's music through the hub's bridge socket (a stand-in for the macOS app) → the circular
 * spectrum, bass and treble visibly different, back to the sphere; Codex's voice moving the speaking body.
 */
async function sound(renderer: "auto" | "canvas") {
  console.log(`v0.4.2 sound (${renderer})`);
  const aion = await connectAion({ home });
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`, { width: 1000, height: 760 });
  const tag = renderer === "canvas" ? "canvas-" : "";
  type Out = { structuredContent?: { audio?: Record<string, string> }; content: { text: string }[] };
  const frame = () => page.evaluate(`(() => { const a = window.aionPresence.audio; const f = a.sample(0); const s = window.aionPresence.presence.signal;
    return { ring: f.ring, sphere: f.sphere, level: f.level, bass: f.bass, treble: f.treble, reason: a.route.reason, music: a.detectors.system.music, conf: a.detectors.system.evidence.confidence, mode: s.mode, voice: s.assistantAmplitude }; })()`) as Promise<{ ring: number; sphere: number; level: number; bass: number; treble: number; reason: string; music: boolean; conf: number; mode: string; voice: number }>;
  const waitFrame = async (ok: (f: Awaited<ReturnType<typeof frame>>) => boolean, ms: number) => {
    let f = await frame();
    for (let waited = 0; waited < ms && !ok(f); waited += 250) { await pause(250); f = await frame(); }
    return f;
  };
  /** Lit pixels outside the sphere's radius, above and below the centre (the ring's bars: bass at the bottom, treble at the top). */
  const halves = async () => page.evaluate(`(async () => {
    const c = document.querySelector("#stage canvas"); const w = c.width, h = c.height;
    const img = new Image(); img.src = c.toDataURL ? c.toDataURL() : ""; await img.decode().catch(() => {});
    const o = new OffscreenCanvas(200, 152); const x = o.getContext("2d"); x.drawImage(img, 0, 0, 200, 152); const d = x.getImageData(0, 0, 200, 152).data;
    let top = 0, bottom = 0; for (let y = 0; y < 152; y++) for (let i = 0; i < 200; i++) { const v = d[(y * 200 + i) * 4] + d[(y * 200 + i) * 4 + 1] + d[(y * 200 + i) * 4 + 2]; if (v < 90) continue; const r = Math.hypot(i - 100, (y - 76) * 1); if (r < 44) continue; if (y < 76) top++; else bottom++; }
    return { top, bottom };
  })()`) as Promise<{ top: number; bottom: number }>;
  try {
    // Demo F: music shared from another app → detected → the circular spectrum.
    bridgeSignal = "music";
    await page.screenshot({ path: join(OUT, `${tag}sound-0-sphere.png`) });
    let out = await aion.call("set_audio_visualizer", { source: "system", app: "Music", mode: "auto" }) as Out;
    check(/^streaming/.test(out.structuredContent?.audio?.system ?? ""), `the bridge streams (${out.structuredContent?.audio?.system})`);
    const detected = await waitFrame(f => f.ring > 0.98, 16_000);
    check(detected.music && detected.reason === "music-detected" && detected.ring > 0.98, `sustained music is detected and Aion becomes the spectrum (confidence ${detected.conf.toFixed(2)}, ring ${detected.ring.toFixed(2)})`);
    const spectrum = await look(page, 10, 120);
    await page.screenshot({ path: join(OUT, `${tag}sound-1-spectrum.png`) });

    // Bass versus treble: the same ring, visibly different shapes (bass at the bottom, treble at the top).
    const profile = async (signal: string) => {
      bridgeSignal = signal;
      await aion.call("set_audio_visualizer", { source: "system", app: "Music", mode: "spectrum" });
      await waitFrame(f => f.ring > 0.98 && f.level > 0.1, 8_000);
      await pause(1_500);
      let top = 0, bottom = 0;
      for (let i = 0; i < 6; i++) { const h = await halves(); top += h.top; bottom += h.bottom; await pause(120); }
      const f = await frame();
      await page.screenshot({ path: join(OUT, `${tag}sound-2-${signal}.png`) });
      return { top, bottom, bass: f.bass, treble: f.treble };
    };
    const bass = await profile("bass"), treble = await profile("treble");
    // The same ring with the sound gone: it calms (it is the music that moves it, not a loop).
    bridgeSignal = "silence";
    await aion.call("set_audio_visualizer", { source: "system", app: "Music", mode: "spectrum" });
    await waitFrame(f => f.ring > 0.98 && f.level < 0.02, 8_000);
    await pause(1_200);
    const still = await look(page, 10, 120);
    check(spectrum.motion > still.motion * 1.5, `the spectrum moves with the music and calms without it (motion ${spectrum.motion.toFixed(2)} vs ${still.motion.toFixed(2)} in silence)`);
    check(bass.bass > bass.treble && treble.treble > treble.bass, `the analysis tells them apart (bass: bass ${bass.bass.toFixed(2)} / treble ${bass.treble.toFixed(2)}; treble: ${treble.bass.toFixed(2)} / ${treble.treble.toFixed(2)})`);
    if (renderer === "canvas") {
      check(bass.bottom > bass.top && treble.top > treble.bottom, `and the ring shows it: bass reaches out below (${bass.bottom} vs ${bass.top}), treble above (${treble.top} vs ${treble.bottom})`);
    } else {
      check(bass.bottom / Math.max(1, bass.top) > treble.bottom / Math.max(1, treble.top), `and the ring shows it: bass weighs the bottom (${bass.bottom}/${bass.top}), treble the top (${treble.bottom}/${treble.top})`);
    }

    // Demo H: back to the sphere, one particle transition (the music still playing moves the sphere gently).
    bridgeSignal = "music";
    await aion.call("set_audio_visualizer", { source: "system", app: "Music", mode: "sphere" });
    const back = await waitFrame(f => f.ring < 0.02, 6_000);
    check(back.ring < 0.02 && back.reason === "external-sphere", `"Return to your normal sphere": the ring re-forms as the sphere (${back.reason})`);
    await page.screenshot({ path: join(OUT, `${tag}sound-3-back.png`) });
    await aion.call("set_audio_visualizer", { stop: ["system"], mode: "auto" });
    const quiet = await waitFrame(f => f.reason === "quiet", 4_000);
    check(quiet.reason === "quiet", "stopping system audio releases it");

    // Demo E (simulated capture): Codex's voice through the bridge drives the speaking body, never the spectrum.
    bridgeSignal = "speech";
    out = await aion.call("set_audio_visualizer", { source: "codex" }) as Out;
    check(/^streaming/.test(out.structuredContent?.audio?.codex ?? ""), `Codex's voice streams (${out.structuredContent?.audio?.codex})`);
    const speaking = await waitFrame(f => f.mode === "speaking" && f.voice > 0.05, 6_000);
    check(speaking.mode === "speaking" && speaking.ring < 0.02, `the body speaks with the real signal, as a sphere (amplitude ${speaking.voice.toFixed(2)}, ring ${speaking.ring.toFixed(2)})`);
    await page.screenshot({ path: join(OUT, `${tag}sound-4-codex-voice.png`) });
    await aion.call("set_audio_visualizer", { stop: ["codex"], source: "auto" });
    const stopped = await waitFrame(f => f.mode !== "speaking", 4_000);
    check(stopped.mode !== "speaking", "stopping it returns to the semantic body");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { await page.close(); await aion.close(); }
}

/** Immersive mode in the companion: one click for true fullscreen, kept through visuals; never a trap. */
async function immersive() {
  console.log("immersive (companion)");
  hub.apply({ type: "open", display: "immersive", greet: false });
  const { page, errors } = await open(browser, "&mic=0", { width: 1280, height: 800 });
  try {
    const offered = await until(page, s => s.immersive === "offered", 3_000);
    check(offered.immersive === "offered" && await page.locator("#entry").isVisible(), "Open Aion offers one quiet Enter Presence");
    await pause(2_200); // the entry fades in
    await page.screenshot({ path: join(OUT, "immersive-entry.png") });
    await page.locator("#enter").click();
    const entered = await until(page, s => s.fullscreen, 3_000);
    check(entered.fullscreen && entered.immersive === "fullscreen", "one click: true fullscreen");
    check(!(await page.locator("#entry").isVisible()), "the entry is gone");
    hub.apply({ type: "present", content: { kind: "form", form: "tao.yin-yang", label: "Yin-yang" }, hold: 3 });
    await until(page, s => s.phase === "holding");
    await until(page, s => s.phase === "sphere", 10_000);
    check((await live(page)).fullscreen, "visual transformations stay in fullscreen");
    await page.screenshot({ path: join(OUT, "immersive-fullscreen.png") });
    await page.keyboard.press("Escape");
    let left = await until(page, s => !s.fullscreen, 1_500);
    // Headless Chrome may not route Esc to its fullscreen controller; leaving the same way the browser would.
    if (left.fullscreen) { await page.evaluate("document.exitFullscreen()"); left = await until(page, s => !s.fullscreen, 1_500); }
    check(!left.fullscreen && left.immersive === "declined", `Esc exits; the choice is respected (${left.fullscreen ? "fullscreen" : "windowed"}, ${left.immersive})`);
    await pause(1_000);
    check(!(await live(page)).fullscreen && !(await page.locator("#entry").isVisible()), "no fullscreen trap: nothing re-enters by itself");
    await page.keyboard.press("f");
    check((await until(page, s => s.fullscreen, 2_000)).fullscreen, "F returns to fullscreen whenever the user wants");
    await page.evaluate("document.exitFullscreen()");
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);

    // A window behind others: "Open Aion" brings a new one forward and the old one retires itself.
    hub.apply({ type: "supersede" });
    const { page: fresh } = await open(browser, "&mic=0", { width: 900, height: 600 });
    await pause(1_000);
    const retired = page.isClosed() || ((await page.locator("#status").textContent()) ?? "").includes("continues in its new window");
    check(retired, "the window brought forward replaces the old one, which retires");
    await fresh.close();
  } finally {
    if (!page.isClosed()) await page.close();
    hub.apply({ type: "open", display: "auto", greet: false });
  }
}

/** The same surface inside an MCP Apps host, including one that declines fullscreen. */
async function embedded() {
  console.log("embedded: an MCP Apps host");
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  const host = await build({ entryPoints: [join(REPO_ROOT, "scripts", "smoke-host", "host.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "chrome120", logLevel: "warning" });
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/?") || req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><body style="margin:0;background:#000"><script type="module">${host.outputFiles[0].text}</script></body>`); return; }
    if (req.url === "/presence.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(readFileSync(pagePath, "utf8")); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    for (const refuse of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.exposeFunction("hostCallTool", (params: { name: string; arguments?: Record<string, unknown> }) => aion.client.callTool(params));
        const opened = await aion.call("open_presence", { display: "immersive", body: "figure" }) as { structuredContent: { surface: { mode: string }; window_opened: boolean; immersive: { path: string } } };
        check(opened.structuredContent.surface.mode === "embedded" && !opened.structuredContent.window_opened && opened.structuredContent.immersive.path === "host-fullscreen",
          "open_presence chooses embedded mode, asks the host for fullscreen and opens no window");
        await page.goto(refuse ? `${base}?refuse=1` : base);
        await pause(3_500);
        const log = await page.evaluate("window.hostLog") as string[];
        check(log.includes("initialized"), "the view completes the MCP Apps handshake");
        check(log.includes("display:fullscreen"), "fullscreen is requested through the host's display mode");
        const frame = page.frames().find(item => item.url().endsWith("/presence.html"))!;
        if (refuse) {
          check(log.includes("refused") && await frame.evaluate("document.querySelector('#stage canvas') !== null") as boolean, "a host that declines fullscreen: Aion carries on inline");
        } else {
          await aion.call("show_result", { title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed"] });
          await pause(3_000);
          check((await frame.locator("#card").textContent())?.includes("48 / 48 tests passed") ?? false, "a tool call reaches the embedded view");
          check(await frame.evaluate("document.querySelector('#stage canvas') !== null") as boolean, "the embedded body renders");
          await page.screenshot({ path: join(OUT, "embedded-result.png") });
          // v0.4.5: an interactive card inside the embedded view; it reports through the app-only presence_card tool.
          await aion.call("show_interactive_card", { app: "earth-moon" });
          let report = "";
          for (let i = 0; i < 60 && !/"lifecycle":"active"/.test(report); i++) { await pause(200); report = ((await aion.call("inspect_interactive_card")) as { content: { text: string }[] }).content[0].text; }
          check(/"lifecycle":"active"/.test(report) && !/no window has reported/.test(report), "an interactive card runs in the embedded view and reports through the host");
          check(await frame.evaluate("document.querySelector('#workspace iframe')?.getAttribute('sandbox')") === "allow-scripts", "the nested card frame is sandboxed too");
          await page.screenshot({ path: join(OUT, "embedded-card.png") });
          await aion.call("control_interactive_card", { action: "close" });
        }
        check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
      } finally { await page.close(); }
    }
  } finally {
    server.close();
    await aion.close();
  }
}
/**
 * v0.4.3 on the real surface, through the real MCP tools: writing (the body writes 永 stroke by stroke while the card
 * follows; a stroke repeated, slower, the finished symbol), a short action sequence of the figure with its props,
 * and a local photograph composed as a heritage portrait.
 */
async function v43(renderer: "auto" | "canvas") {
  console.log(`v0.4.3: stroke animation, action sequences, local portraits (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
  const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
  const name = (moment: string) => join(OUT, `v43-${renderer}-${moment}.png`);
  const aion = await connectAion({ home });
  try {
    const frame = () => view<{ phase: string; stroke: number; progress: number; pen: number } | null>("v.writing.frame && { phase: v.writing.frame.phase, stroke: v.writing.frame.stroke, progress: v.writing.frame.progress, pen: v.writing.frame.pen }");
    await aion.call("show_stroke_animation", { symbol: "永" });
    check((await until(page, s => s.phase === "holding" && s.card === "shown", 6_000)).phase === "holding", "永 forms, with its stroke-order card");
    check(await view<string>("v.visual.target.visual.kind") === "strokes", "the body's target is the writing (sampled once, revealed by key)");
    const seen = new Set<number>();
    let last = -1, monotonic = true;
    for (let waited = 0; waited < 14_000 && (await frame())?.phase !== "done"; waited += 120) {
      const f = await frame();
      // From the moment the writing begins (the preview shows the symbol complete, then it clears to its ghost).
      if (f && ["ready", "stroke", "gap", "done"].includes(f.phase)) { if (f.progress < last - 1e-6) monotonic = false; last = f.progress; if (f.phase === "stroke") seen.add(f.stroke); }
      await pause(120);
    }
    check([0, 1, 2, 3, 4].every(k => seen.has(k)), `all five strokes are written, in order (${[...seen].join(",")})`);
    check(monotonic, "the writing never goes backwards");
    check((await frame())?.phase === "done", "the finished symbol stays");
    await page.screenshot({ path: name("written") });
    await aion.call("control_animation", { action: "repeat", stroke: 3 });
    await pause(800);
    const repeat = await frame();
    check(repeat?.stroke === 2 && Math.floor(repeat.progress) === 2, "repeat the third stroke: strokes 1–2 written, the third being written");
    check(await page.locator("#card .stroke-list li.current").textContent().then(text => /right, then down-left/.test(text ?? "")), "the card lights the same stroke");
    await page.screenshot({ path: name("repeat-third") });
    await aion.call("control_animation", { action: "replay", speed: "slow" });
    await pause(300);
    check(await view<number>("v.snapshot.animation.playback.rate") === 0.5, "write it more slowly: half speed");
    await aion.call("control_animation", { action: "complete" });
    await pause(600);
    check((await frame())?.phase === "done", "show the whole character again");
    await aion.call("clear_presentation");
    check((await until(page, s => s.phase === "sphere", 6_000)).phase === "sphere", "writing → back to the persistent body");

    await aion.call("play_animation", { demo: "jump-over-obstacle" });
    await pause(2_600);
    check(await view<number>("v.aion.figure.performing") > 0.9, "the body becomes the figure for the sequence");
    check(await view<boolean>("v.sceneLayer.drawn.has('box')"), "its box is drawn where the stage puts it");
    let jumped = false;
    for (let waited = 0; waited < 6_000 && !jumped; waited += 100) { jumped = /figure jump/.test((await diag(page)).animation ?? ""); await pause(100); }
    check(jumped, "it jumps");
    await page.screenshot({ path: name("jump") });
    let returned = false;
    for (let i = 0; i < 80 && !returned; i++) { returned = await view<number>("v.aion.figure.performing") === 0; await pause(150); }
    check(returned, "and returns to the persistent body afterwards");

    // A photograph on this machine, as a portrait: the heritage oval (the original stays on its card).
    const photo = join(home, `portrait-${renderer}.png`);
    writeFileSync(photo, await page.screenshot({ clip: { x: 300, y: 120, width: 300, height: 400 } }));
    await aion.call("show_portrait", { source: photo, person: "A local photograph" });
    check((await until(page, s => s.phase === "holding" && s.card === "shown", 8_000)).route === "hybrid", "a local portrait is a hybrid, like a looked-up one");
    check(await view<string>("v.visual.target.visual.frame") === "oval", "the body forms the heritage oval");
    check(await page.locator("#card img.picture").count() === 1, "the card shows the original file");
    await page.screenshot({ path: name("local-portrait") });
    await aion.call("clear_presentation");
    await until(page, s => s.phase === "sphere", 6_000);
  } finally { await aion.close(); }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}

/**
 * v0.4.4 in the real renderer: Chinese characters from the pack written into their true outlines (a single character, a
 * complex one, a traditional form, a word with a repeated character), the reference card in step, tracing practice,
 * English words, a music symbol with its engraving beside its handwriting, a 4/4 bar that plays, and Figure 3.0's limbs,
 * secondary motion and behaviours (thinking, exploring).
 */
async function v44(renderer: "auto" | "canvas") {
  console.log(`v0.4.4: Chinese Writing Pack, English and music writing, Figure 3.0 (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
  const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
  const name = (moment: string) => join(OUT, `v44-${renderer}-${moment}.png`);
  const aion = await connectAion({ home });
  const frame = () => view<{ phase: string; stroke: number; progress: number } | null>("v.writing.frame && { phase: v.writing.frame.phase, stroke: v.writing.frame.stroke, progress: v.writing.frame.progress }");
  const waitDone = async (ms: number) => { for (let waited = 0; waited < ms && (await frame())?.phase !== "done"; waited += 150) await pause(150); };
  try {
    await aion.call("show_stroke_animation", { text: "永" });
    check((await until(page, s => s.phase === "holding" && s.card === "shown", 6_000)).phase === "holding", "永 from the pack forms beside its reference card");
    check(await view<boolean>("v.visual.target.visual.strokes.every(s => Array.isArray(s.outline) && s.outline.length > 0)"), "every stroke carries its true outline");
    check(await page.locator("#card .stroke-ink").count() === 5 && await page.locator("#card clipPath").count() === 5, "the card draws the five outlines, each revealed through its clip path");
    let synced = false;
    for (let waited = 0; waited < 10_000 && !synced; waited += 100) {
      const f = await frame();
      if (f?.phase === "stroke") {
        const lit = await page.locator("#card .stroke-brush.current").count();
        const listed = await page.locator("#card .stroke-list li.current").textContent();
        synced = lit === 1 && listed !== null;
      }
      await pause(100);
    }
    check(synced, "the card's brush and list follow the stroke the particles are writing");
    await waitDone(14_000);
    await page.screenshot({ path: name("yong") });

    await aion.call("show_stroke_animation", { text: "鬱" });
    await until(page, s => s.phase === "holding", 6_000);
    check(await view<number>("v.visual.target.visual.strokes.length") === 29, "a complex character (鬱, 29 strokes) with no special case");
    await pause(9_000);
    await page.screenshot({ path: name("yu") });

    await aion.call("show_stroke_animation", { text: "国", form: "traditional" });
    await until(page, s => s.phase === "holding", 6_000);
    check(await view<string>("v.snapshot.presentation.source.text") === "國", "the traditional form (国 → 國)");

    await aion.call("show_stroke_animation", { text: "爱国" });
    await until(page, s => s.phase === "holding", 6_000);
    check(await view<number>("v.writing.sequence.items.length") === 2, "a word: two characters, each in its own order");
    await aion.call("control_animation", { action: "repeat", character: 2 });
    await pause(1_400);
    const second = await frame();
    check(second !== null && second.progress >= 10, "repeat the second character: the first stays written");
    await page.screenshot({ path: name("word") });

    await aion.call("show_stroke_animation", { text: "永", practice: true });
    await until(page, s => s.card === "shown", 6_000);
    let practice = false;
    for (let i = 0; i < 30 && !practice; i++) { practice = await page.locator("#card .practice-target svg").count() > 0; await pause(150); }
    check(practice, "tracing practice: Hanzi Writer's quiz on the same data");

    await aion.call("show_stroke_animation", { text: "HELLO", presentation: "body" });
    await until(page, s => s.phase === "holding", 6_000);
    check(await view<number>("v.writing.sequence.items.length") === 5, "HELLO: five letters in order");
    await waitDone(16_000);
    await page.screenshot({ path: name("hello") });

    await aion.call("show_stroke_animation", { text: "treble clef" });
    await until(page, s => s.card === "shown", 6_000);
    let engraved = false;
    for (let i = 0; i < 30 && !engraved; i++) { engraved = await page.locator("#card .music-score.engraved svg").count() > 0; await pause(150); }
    check(engraved, "the treble clef's engraving stands beside its handwriting");
    await page.screenshot({ path: name("clef") });

    await aion.call("show_music", { time: "4/4", notes: [{ pitch: "C4" }, { pitch: "D4" }, { pitch: "E4" }, { pitch: "F4" }], play: true });
    await until(page, s => s.card === "shown", 6_000);
    check(await page.locator("#card .music-note").count() === 4, "a 4/4 bar of four quarter notes, engraved");

    await aion.call("clear_presentation");
    await until(page, s => s.phase === "sphere", 6_000);
    await aion.call("set_body_form", { body: "figure" });
    await pause(2_500);
    check(await view<boolean>("Array.isArray(v.aion.figure.lag) && v.aion.figure.lag.length === 5 && v.aion.figure.lag.flat().every(Number.isFinite)"), "Figure 3.0: five limbs with secondary motion");
    await aion.call("play_animation", { demo: "thinking" });
    await pause(9_200);
    const answered = await view<number>("(() => { const p = v.performance; return p ? 1 : 0; })()");
    check(answered === 1 && await view<boolean>("v.sceneLayer.drawn.has('question')"), "thinking: the question is drawn above the figure");
    await page.screenshot({ path: name("thinking") });
    await pause(3_000);
    await aion.call("play_animation", { demo: "exploring" });
    await pause(2_600);
    check(await view<boolean>("v.sceneLayer.drawn.has('box')"), "exploring: the box is there");
    let touched = false;
    for (let waited = 0; waited < 14_000 && !touched; waited += 100) { touched = /figure touch/.test((await diag(page)).animation ?? ""); await pause(100); }
    check(touched, "it walks up, examines and touches the box");
    await page.screenshot({ path: name("exploring") });
    let returned = false;
    for (let i = 0; i < 100 && !returned; i++) { returned = await view<number>("v.aion.figure.performing") === 0; await pause(150); }
    check(returned, "and returns to the persistent body");
    await aion.call("set_body_form", { body: "sphere" });
  } finally { await aion.close(); }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}

/**
 * Codex Voice Sync (v0.4.3), with the stand-in for the macOS app (a speech-like signal over the real socket): once
 * opted in, it connects while Aion is open, stops when Aion closes, and reconnects by itself when Aion is opened again —
 * with no tool call. This is the mechanism; real Codex Voice needs a person speaking (npm run audio:verify -- --codex).
 */
async function voiceSync() {
  console.log("v0.4.3: Codex Voice Sync (stand-in bridge)");
  bridgeSignal = "speech";
  let { page, errors } = await open(browser, "&mic=0");
  const aion = await connectAion({ home });
  try {
    await aion.call("set_audio_visualizer", { voice_sync: true });
    let state = hub.snapshot().audio;
    for (let i = 0; i < 40 && state.bridge.state !== "streaming"; i++) { await pause(150); state = hub.snapshot().audio; }
    check(state.bridge.state === "streaming" && state.bridge.source === "codex", "voice sync connects while Aion is open");
    let speaking = false;
    for (let i = 0; i < 40 && !speaking; i++) { speaking = /speaking yes/.test((await diag(page)).state); await pause(150); }
    check(speaking, "Codex's (stand-in) voice drives the speaking body");
    await page.close();
    let stopped = false;
    for (let i = 0; i < 80 && !stopped; i++) { stopped = hub.snapshot().audio.bridge.state === "off"; await pause(200); }
    check(stopped, "closing Aion stops the capture (after a short grace)");
    ({ page, errors } = await open(browser, "&mic=0"));
    let back = false;
    for (let i = 0; i < 40 && !back; i++) { back = hub.snapshot().audio.bridge.state === "streaming"; await pause(150); }
    check(back, "opening Aion again reconnects by itself, with no tool call");
    check(/voice sync on/.test((await diag(page)).audio), "the diagnostics say so");
    await aion.call("set_audio_visualizer", { voice_sync: false });
    await pause(400);
    check(hub.snapshot().audio.bridge.state === "off", "turning it off stops the capture");
  } finally { await aion.close(); bridgeSignal = "music"; }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}


/** Interactive cards (v0.4.5) on the real surface, through the real MCP tools, with the real sandboxed frame. */
async function v45(renderer: "auto" | "canvas") {
  console.log(`v0.4.5: interactive cards (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`, { width: 1440, height: 900 });
  const warnings: string[] = [];
  page.on("console", message => { if (/too many active webgl contexts|context lost|webgl/i.test(message.text())) warnings.push(message.text()); });
  const name = (moment: string) => join(OUT, `v45-${renderer}-${moment}.png`);
  const aion = await connectAion({ home });
  const card = () => hub.snapshot().card;
  const frameOf = async () => (await (await page.locator("#workspace iframe").elementHandle())?.contentFrame()) ?? null;
  const waitCard = async (ok: (c: NonNullable<ReturnType<typeof card>>) => boolean, ms = 10_000) => {
    for (let waited = 0; waited < ms; waited += 100) { const c = card(); if (c && ok(c)) return true; await pause(100); }
    return false;
  };
  const box = async () => (await page.locator("#workspace .ws-body").boundingBox())!;
  const clickCenter = async (dx = 0, dy = 0) => { const b = await box(); await page.mouse.click(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy); };
  const timings: Record<string, number> = {};
  try {
    // ── Earth–Moon ─────────────────────────────────────────────────────────────────────────────────────────────
    let t0 = Date.now();
    await aion.call("show_interactive_card", { app: "earth-moon" });
    check(await waitCard(c => c.lifecycle === "active" && Object.keys(c.state).length > 0), "the Earth–Moon card starts in its frame and reports its state");
    timings.earthMoonReadyMs = Date.now() - t0;
    check(await page.locator("#workspace iframe").getAttribute("sandbox") === "allow-scripts", "the frame is sandboxed with scripts only (no same-origin)");
    const token = hub.surfaceUrl.split("token=")[1];
    check(!(await page.locator("#workspace iframe").getAttribute("srcdoc"))!.includes(token), "the frame's document does not contain the hub token");
    const inside = await (await frameOf())!.evaluate(async (url: string) => {
      const out: Record<string, string> = { origin: String(self.origin), referrer: document.referrer };
      try { out.parent = String(parent.location.href); } catch { out.parent = "blocked"; }
      try { out.storage = String(localStorage.length); } catch { out.storage = "blocked"; }
      try { await fetch(url); out.fetch = "reached"; } catch { out.fetch = "blocked"; }
      try { await fetch("https://example.com/"); out.remote = "reached"; } catch { out.remote = "blocked"; }
      return out;
    }, `${hub.url}api/state`);
    check(inside.origin === "null" && inside.referrer === "" && inside.parent === "blocked" && inside.storage === "blocked", `the frame has an opaque origin, no referrer, no parent access, no storage (${JSON.stringify(inside)})`);
    check(inside.fetch === "blocked" && inside.remote === "blocked", "the frame cannot reach the hub or the network");
    // A hostile frame posting window messages to the page: the page listens only to its own port, so nothing happens.
    const before = card()!.state.day;
    await (await frameOf())!.evaluate((instance: string) => { for (let i = 0; i < 3000; i++) parent.postMessage({ v: 1, instance, type: "STATE_CHANGED", payload: { state: { day: 99999, speed: 100 } } }, "*"); }, card()!.instance);
    await pause(700);
    check(card()!.state.day !== 99999 && card()!.state.speed !== 100 && typeof before === "number", "forged window messages from the frame are ignored (only the bridge port counts)");
    const day0 = card()!.state.day as number;
    await pause(1600);
    check((card()!.state.day as number) > day0, "the orbit animates (simulation time advances)");
    await page.screenshot({ path: name("earth-moon-expanded") });

    // Selecting by clicking: Earth is at the centre of the overview.
    await clickCenter();
    check(await waitCard(c => c.selection?.objectId === "earth", 3_000), "clicking Earth selects it, and the card reports the selection");
    const inspected = await aion.call("inspect_interactive_card") as { content: { text: string }[] };
    check(/Selected: Earth/.test(inspected.content[0].text) && /12,742 km/.test(inspected.content[0].text), "Codex can inspect the selected object and its properties");
    await page.screenshot({ path: name("earth-selected") });

    await aion.call("control_interactive_card", { action: "pause" });
    check(card()!.lifecycle === "paused", "pause: the card confirms it is paused");
    const paused = card()!.state.day;
    await pause(1200);
    check(card()!.state.day === paused, "paused: orbital motion stops");
    // Rotating the camera by dragging inside the frame.
    const b = await box();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.6);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + b.width * (0.5 + i * 0.02), b.y + b.height * (0.6 - i * 0.01));
    await page.mouse.up();
    check(await waitCard(c => c.state.view === "custom", 3_000), "dragging rotates the camera (the card reports a custom view)");
    await page.screenshot({ path: name("earth-rotated") });
    await aion.call("control_interactive_card", { action: "resume" });
    t0 = Date.now();
    await aion.call("control_interactive_card", { action: "focus", value: "moon" });
    await pause(1_900);
    timings.focusMoonMs = Date.now() - t0;
    await clickCenter();
    check(await waitCard(c => c.selection?.objectId === "moon", 3_000), "focus on the Moon: the camera follows it and a click at the centre selects it");
    await aion.call("control_interactive_card", { action: "show-teaching", value: true });
    await pause(900);
    await page.screenshot({ path: name("earth-moon-focus") });

    // Layouts and the universal controls.
    await aion.call("control_interactive_card", { action: "collapse" });
    await pause(1_000);
    const compact = await box();
    await page.screenshot({ path: name("earth-moon-compact") });
    await aion.call("control_interactive_card", { action: "fullscreen" });
    await pause(1_000);
    const full = await box();
    check(compact.width < 700 && full.width > 1100, `layouts: compact ${Math.round(compact.width)} px wide, fullscreen ${Math.round(full.width)} px`);
    await page.screenshot({ path: name("earth-moon-fullscreen") });
    await (await frameOf())!.locator("canvas").focus();
    await page.keyboard.press("Escape");
    check(await waitCard(c => c.layout === "expanded", 3_000), "Escape inside the card leaves fullscreen");
    await page.locator("#workspace .ws-pause").click();
    check(await waitCard(c => c.lifecycle === "paused", 3_000), "the card's own pause button pauses it");
    await page.locator("#workspace .ws-pause").click();
    check(await waitCard(c => c.lifecycle === "active", 3_000), "and resumes it");
    await page.locator("#workspace .ws-close").click();
    await pause(1_200);
    check(hub.snapshot().presentation === null && await page.locator("#workspace iframe").count() === 0, "closing the card ends it everywhere and removes its frame");

    // Hybrid: the body forms the application's particle form for a moment while the card runs beside it.
    await aion.call("show_interactive_card", { app: "earth-moon", presentation: "hybrid" });
    check(await waitCard(c => c.lifecycle === "active"), "a hybrid Earth–Moon card starts");
    check(hub.snapshot().presentation?.route === "hybrid" && (await until(page, s => s.phase === "holding", 6_000)).phase === "holding", "hybrid: the body forms Earth, Moon and orbit in particles beside the card");
    await page.screenshot({ path: name("earth-moon-hybrid") });
    await aion.call("control_interactive_card", { action: "close" });
    await pause(1_200);
    // Reduced motion reaches the application (instant camera moves, no damping, a slower default speed).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await aion.call("show_interactive_card", { app: "earth-moon" });
    await waitCard(c => c.lifecycle === "active" && Object.keys(c.state).length > 0);
    check(await (await frameOf())!.evaluate(() => document.documentElement.dataset.motion) === "reduced" && card()!.state.speed === 0.25, "reduced motion reaches the card (and its default speed is calmer)");
    await aion.call("control_interactive_card", { action: "close" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await pause(1_000);

    // ── CAD viewer ─────────────────────────────────────────────────────────────────────────────────────────────
    t0 = Date.now();
    await aion.call("show_interactive_card", { app: "cad-viewer", model: "transformer" });
    check(await waitCard(c => c.lifecycle === "active" && Array.isArray(c.state.components)), "the transformer loads in the CAD viewer with its component hierarchy");
    timings.cadReadyMs = Date.now() - t0;
    await page.screenshot({ path: name("cad-loaded") });
    await aion.call("control_interactive_card", { action: "set-view", value: "left" });
    await pause(1_300);
    await clickCenter();
    check(await waitCard(c => c.selection?.objectId === "assembly/core", 3_000), "clicking the magnetic core selects it (assembly/core)");
    const core = card()!.selection!;
    check(core.name === "Magnetic Core" && core.properties?.["Part Number"] === "DEMO-CORE-EI96", "its name and the model's metadata are reported");
    await aion.call("control_interactive_card", { action: "set-view", value: "iso" });
    await pause(1_200);
    await page.screenshot({ path: name("cad-core-selected") });
    await aion.call("control_interactive_card", { action: "hide", value: "assembly/windings" });
    check(await waitCard(c => (c.state.hidden as string[] | undefined)?.includes("assembly/windings") === true, 3_000), "hide the winding: the windings are hidden");
    await page.screenshot({ path: name("cad-windings-hidden") });
    await aion.call("control_interactive_card", { action: "isolate", value: "assembly/core" });
    check(await waitCard(c => c.state.isolated === "assembly/core", 3_000), "isolate the core");
    await page.screenshot({ path: name("cad-core-isolated") });
    await aion.call("control_interactive_card", { action: "show-all" });
    check(await waitCard(c => (c.state.hidden as string[]).length === 0, 3_000), "show all restores visibility");
    // Zoom with the wheel inside the frame.
    const cb = await box();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.wheel(0, -600);
    await pause(600);
    await page.screenshot({ path: name("cad-zoomed") });
    await aion.call("show_interactive_card", { app: "cad-viewer", model: join(REPO_ROOT, "tests/fixtures/cards/bracket.gltf") });
    check(await waitCard(c => c.state.model === "Angle bracket (test model)" || /bracket/i.test(String(c.state.model)), 6_000), "another glTF (with external files and a texture) loads into the same viewer");
    await page.screenshot({ path: name("cad-bracket") });
    await aion.call("control_interactive_card", { action: "close" });
    await pause(1_000);

    // ── Repeated open and close: nothing left behind ──────────────────────────────────────────────────────────
    const cycles = 6;
    t0 = Date.now();
    for (let i = 0; i < cycles; i++) {
      for (const app of ["earth-moon", "cad-viewer"] as const) {
        await aion.call("show_interactive_card", { app });
        await waitCard(c => c.lifecycle === "active");
        await aion.call("control_interactive_card", { action: "close" });
        await pause(250);
      }
    }
    await pause(2_500);
    timings.cycleMs = Math.round((Date.now() - t0) / (cycles * 2));
    const history = await page.evaluate("window.aionPresence.cardHistory") as { opened: number; closed: number; leftovers: { geometries: number; textures: number; urls: number; loops: number }[] };
    const left = history.leftovers.reduce((sum, item) => sum + item.geometries + item.textures + item.urls + item.loops, 0);
    check(history.opened === history.closed && history.leftovers.length === history.closed, `every card opened was closed and reported its cleanup (${history.opened} opened, ${history.closed} closed)`);
    check(left === 0, `no geometries, textures, object URLs or loops left behind (${left})`);
    check(await page.locator("#workspace iframe").count() === 0 && page.frames().length === 1, "no frame remains after closing");
    check(warnings.length === 0, `no WebGL context warnings after ${history.opened} cards${warnings.length ? `: ${warnings[0]}` : ""}`);
    check(await page.evaluate("window.aionPresence.runtime.quality().frames") as number > 0, "Aion's body keeps rendering throughout");

    // ── Performance: both renderers together ──────────────────────────────────────────────────────────────────
    await aion.call("show_interactive_card", { app: "earth-moon" });
    await waitCard(c => c.lifecycle === "active");
    await pause(4_500);
    const f0 = await page.evaluate("window.aionPresence.runtime.quality().frames") as number;
    await pause(2_000);
    const f1 = await page.evaluate("window.aionPresence.runtime.quality().frames") as number;
    const resources = card()!.resources;
    timings.bodyFps = Math.round((f1 - f0) / 2);
    timings.cardFps = resources?.fps ?? -1;
    timings.cardDrawCalls = resources?.drawCalls ?? -1;
    timings.cardTextures = resources?.textures ?? -1;
    timings.cardGeometries = resources?.geometries ?? -1;
    if (resources?.heapMB !== undefined) timings.cardHeapMB = resources.heapMB;
    console.log(`  · timings ${JSON.stringify(timings)}`);
    writeFileSync(join(OUT, `v45-${renderer}-performance.json`), JSON.stringify({ renderer, ...timings }, null, 2));
    check(timings.bodyFps > 20 && timings.cardFps > 20, `both render smoothly together (body ${timings.bodyFps} fps, card ${timings.cardFps} fps)`);
    await aion.call("control_interactive_card", { action: "close" });
    await pause(600);
  } finally { await aion.close(); }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}

/** A browser without WebGL: the card says it cannot run here (no screenshot pretending), and Aion lives on. */
async function cardFallback() {
  console.log("v0.4.5: interactive card without WebGL");
  const plain = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--disable-3d-apis", "--disable-webgl", "--disable-gpu"] });
  try {
    const { page, errors } = await open(plain, "&mic=0", { width: 1200, height: 800 });
    const aion = await connectAion({ home });
    try {
      await aion.call("show_interactive_card", { app: "earth-moon" });
      let state = hub.snapshot().card;
      for (let i = 0; i < 60 && state?.lifecycle !== "error"; i++) { await pause(150); state = hub.snapshot().card; }
      check(state?.lifecycle === "error" && state.error?.code === "webgl-unavailable", "the card reports that WebGL is unavailable");
      check(/needs WebGL 2/.test(await page.locator("#workspace .ws-error").textContent() ?? ""), "it says so in the card (with Retry), instead of a static picture");
      const f0 = await page.evaluate("window.aionPresence.runtime.quality().frames") as number;
      await pause(800);
      check(await page.evaluate("window.aionPresence.runtime.quality().frames") as number > f0, "Aion's body keeps living (canvas renderer)");
      await page.screenshot({ path: join(OUT, "v45-no-webgl.png") });
      await aion.call("control_interactive_card", { action: "close" });
    } finally { await aion.close(); }
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { await plain.close(); }
}

writeFileSync(join(OUT, "result.txt"), failures.length ? failures.join("\n") : "ok");
console.log(failures.length ? `\n${failures.length} smoke check(s) failed` : `\n✓ the Presence surface renders and follows the presence state (screenshots in ${OUT})`);
process.exit(failures.length ? 1 : 0);
