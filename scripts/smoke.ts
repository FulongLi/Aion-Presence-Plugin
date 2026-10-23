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
import { findFreecad, FreecadBackend } from "../src/host/cad/freecad";
import { freecadBridge } from "../src/host/sim/freecadBridge";
import { SimulationService } from "../src/host/sim/service";
import { findSimTools } from "../src/host/sim/tools";
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
 *   v05           the generative visual engine through the real MCP tools, in both renderers: Scene IR documents routed to
 *                 body, card or hybrid; the solar system built, rotated, zoomed and patched in place (Earth larger, Mars
 *                 stopped, orbits recoloured, resumed); a click selecting an object that a "$selected" patch then moves;
 *                 undo, redo, revert, stale revisions and invalid patches refused with the scene intact; abstract time in
 *                 the body becoming an interactive timeline that gains its geological periods; a three-phase field and a
 *                 buck converter (illustrative, said so); an unsupported request refused with nothing substituted;
 *                 repeated open/close with nothing left behind, and timings
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
 *   welcome       v0.7: the spoken first-run welcome on fresh installations, with a stand-in synthesizer — it waits for
 *                 Codex, speaks four sentences (English, Chinese) with an on-device voice, captions, Replay, ?, Skip;
 *                 autoplay refused → Listen; no voice → text; a visual or closing the window stops it; remembered
 *   cad           v0.7: real FreeCAD → the CAD viewer: box, longer (view kept), holes, the selected hole moved (selection
 *                 kept), undo, a refusal that changes nothing, a lost selection, a fillet; timings (skipped without FreeCAD)
 *   sim           v0.8: real FreeCAD + Gmsh + Elmer → the Simulation Card: the setup (a face picked with the mouse for
 *                 "$selected"), conditions coloured, an electro-thermal run, temperature and current density with their
 *                 legends, vectors, a section through the interior, the maximum probed (the solver's value), colour maps
 *                 and bands, a missing field refused, the result reopened by a new service (skipped without the tools)
 *   v06           v0.6 through the real MCP tools and real routing: Scotland's terrain → a cycling route on it (kept, not
 *                 re-formed) with the Route Explorer card (tiles, route, profile), the highest point on both, the profile's
 *                 pointer on the terrain, reversed, a waypoint, a marker, removed (terrain kept), a hike and a walk on
 *                 their own surroundings, impossible routes refused with nothing invented, the card closed with nothing left
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
// v0.6: the shared hub is a returning user's (the first-run welcome has its own section, on a fresh hub).
writeFileSync(join(home, "welcome-complete"), "smoke\n");
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
  if (section("v05")) for (const renderer of ["auto", "canvas"] as const) await v05(renderer);
  if (section("terrain") && !offline) for (const renderer of ["auto", "canvas"] as const) await terrain(renderer);
  if (section("welcome")) await welcome();
  if (section("cad")) await cad();
  if (section("sim")) await sim();
  if (section("v06") && !offline) for (const renderer of ["auto", "canvas"] as const) await v06(renderer);
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
 * v0.5.2, the terrain regression: real elevation through the real MCP tools, as Codex calls them, for the places and
 * styles people ask for — each must *form* as a height field in the renderer (a successful result is not enough), body
 * and hybrid, with a pin on the relief and a map beside. Network-backed (AWS Terrain Tiles, OpenStreetMap); skipped
 * with --offline.
 */
async function terrain(renderer: "auto" | "canvas") {
  console.log(`v0.5.2: terrain, real elevation (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`);
  console.log(`  ${(await diag(page)).renderer}`);
  const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
  const aion = await connectAion({ home, resolver: new VisualResolver({ env: {} }) });
  const shot = (moment: string) => page.screenshot({ path: join(OUT, `terrain-${renderer}-${moment}.png`) });
  const forms = async (kind: "heightfield" | "map", ms = 30_000) => {
    for (let waited = 0; waited < ms; waited += 250) {
      if (await view<boolean>(`v.visual.phase === 'holding' && v.visual.target.visual.kind === '${kind}'`)) return true;
      await pause(250);
    }
    return false;
  };
  const cases: { moment: string; tool: string; args: Record<string, unknown>; kind: "heightfield" | "map"; route?: string }[] = [
    { moment: "scotland", tool: "show_terrain", args: { region: "Scotland" }, kind: "heightfield" },
    { moment: "china", tool: "show_terrain", args: { region: "China" }, kind: "heightfield" },
    { moment: "united-kingdom", tool: "show_terrain", args: { region: "United Kingdom" }, kind: "heightfield" },
    { moment: "swiss-alps", tool: "show_terrain", args: { region: "Swiss Alps" }, kind: "heightfield" },
    { moment: "scotland-topography", tool: "show_terrain", args: { region: "Scotland", style: "topography" }, kind: "heightfield" },
    { moment: "scotland-relief", tool: "show_terrain", args: { region: "Scotland", style: "relief" }, kind: "heightfield" },
    { moment: "scotland-body", tool: "show_terrain", args: { region: "Scotland", presentation: "body" }, kind: "heightfield", route: "body" },
    { moment: "scotland-hybrid", tool: "show_terrain", args: { region: "Scotland", presentation: "hybrid" }, kind: "heightfield", route: "hybrid" },
    { moment: "scotland-glasgow", tool: "show_terrain", args: { region: "Scotland", markers: [{ place: "Glasgow", color: "red" }] }, kind: "heightfield" },
    { moment: "scotland-map", tool: "show_map", args: { region: "Scotland" }, kind: "map" },
  ];
  try {
    for (const item of cases) {
      const started = performance.now();
      const result = await aion.call(item.tool, item.args) as { isError?: boolean; content: { text: string }[]; structuredContent?: { shown?: string } };
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      check(!result.isError, `${item.tool} ${JSON.stringify(item.args)}: ${result.isError ? result.content[0]?.text : `${result.structuredContent?.shown} (${seconds} s)`}`);
      if (result.isError) continue;
      check(await forms(item.kind), `  it forms as a ${item.kind} in the renderer`);
      if (item.route) {
        const state = await until(page, s => s.route === item.route && (item.route !== "hybrid" || s.card === "shown"), 8_000);
        check(state.route === item.route && (item.route !== "hybrid" || state.card === "shown"), `  routed ${item.route}${item.route === "hybrid" ? ", with the relief map card" : ""}`);
      }
      if (item.moment === "scotland-glasgow") {
        await pause(1_500);
        check(((await view<{ visible: number } | undefined>("v.markerLayer.positions.get('glasgow')"))?.visible ?? 0) > 0.9, "  the Glasgow pin stands on the relief");
      }
      await pause(1_200);
      await shot(item.moment);
      await aion.call("clear_presentation", {});
      await until(page, s => s.phase === "sphere", 6_000);
    }
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally {
    await aion.close();
    await page.close();
  }
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
        // v0.6: Aion's own window is the default; this host is asked to embed it, as a user would ask.
        const opened = await aion.call("open_presence", { display: "immersive", body: "figure", surface: "embedded" }) as { structuredContent: { surface: { mode: string }; window_opened: boolean; immersive: { path: string } } };
        check(opened.structuredContent.surface.mode === "embedded" && !opened.structuredContent.window_opened && opened.structuredContent.immersive.path === "host-fullscreen",
          "open_presence (embedding asked for) chooses embedded mode, asks the host for fullscreen and opens no window");
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
          // v0.5: a generated scene in the embedded view — built, patched and confirmed through the host.
          const solar = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "fixtures", "scenes", "solar-system.json"), "utf8"));
          const generated = (await aion.call("show_interactive_card", { app: "generative-scene", scene: solar })) as { content: { text: string }[] };
          check(/It is built \(revision 1\)/.test(generated.content[0].text), `a generated scene is built in the embedded view (${generated.content[0].text.split("\n")[0].slice(0, 100)})`);
          const patched = (await aion.call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "earth", scaleBy: 3 }], revision: 1 })) as { content: { text: string }[] };
          check(/Done and rendered \(revision 2\)/.test(patched.content[0].text), "and patched in place, confirmed through the host's presence_card");
          await page.screenshot({ path: join(OUT, "embedded-generated-scene.png") });
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

/** v0.5: the generative visual engine, end to end through the real MCP tools (Demos A–H in docs/GENERATIVE-VISUAL-ENGINE.md). */
async function v05(renderer: "auto" | "canvas") {
  console.log(`v0.5: generative visual engine (${renderer})`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`, { width: 1440, height: 900 });
  const warnings: string[] = [];
  page.on("console", message => { if (/too many active webgl contexts|context lost/i.test(message.text())) warnings.push(message.text()); });
  const name = (moment: string) => join(OUT, `v05-${renderer}-${moment}.png`);
  const aion = await connectAion({ home });
  const card = () => hub.snapshot().card;
  const waitCard = async (ok: (c: NonNullable<ReturnType<typeof card>>) => boolean, ms = 10_000) => {
    for (let waited = 0; waited < ms; waited += 100) { const c = card(); if (c && ok(c)) return true; await pause(100); }
    return false;
  };
  const scene = (file: string) => JSON.parse(readFileSync(join(REPO_ROOT, "tests", "fixtures", "scenes", file), "utf8")) as Record<string, unknown>;
  type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: { route?: { mode: string; reason: string; transition: string; capability: string } } };
  const call = async (tool: string, args: Record<string, unknown> = {}) => await aion.call(tool, args) as Result;
  const text = (r: Result) => r.content[0]?.text ?? "";
  const frameOf = async () => (await (await page.locator("#workspace iframe").elementHandle())?.contentFrame()) ?? null;
  const box = async () => (await page.locator("#workspace .ws-body").boundingBox())!;
  const built = () => card()?.scene?.rendered;
  const patch = async (ops: unknown[], extra: Record<string, unknown> = {}) => {
    const t = Date.now();
    const r = await call("control_interactive_card", { action: "patch", patch: ops, ...extra });
    return { r, ms: Date.now() - t };
  };
  const position = async (id: string) => {
    await call("control_interactive_card", { action: "select", value: id });
    await waitCard(c => c.selection?.objectId === id, 2_000);
    return String(card()?.selection?.properties?.Position ?? "");
  };
  const fullDoc = async () => {
    const r = await call("inspect_interactive_card", { full: true });
    return JSON.parse(text(r).split("Scene document (revision ")[1].replace(/^\d+\):\n/, "")) as { objects: { id: string; scale?: unknown; position?: number[] }[]; animations: { id: string; paused?: boolean }[]; materials: { id: string; color: string }[] };
  };
  /** The share of the card's pixels that are clearly blue (what the eye sees, from a screenshot). */
  const blueShare = async () => {
    const shot = (await page.screenshot({ type: "png", clip: await box() })).toString("base64");
    return page.evaluate(`(async (data) => { const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext("2d"); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, img.width, img.height).data;
      let blue = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 90 && d[i + 2] > d[i] + 45 && d[i + 2] > d[i + 1] + 15) blue++; return blue / (d.length / 4); })(${JSON.stringify(shot)})`) as Promise<number>;
  };
  const timings: Record<string, number> = {};
  try {
    // ── Demo A: a solar system from the generic Scene IR ───────────────────────────────────────────────────────
    let t0 = Date.now();
    const shown = await call("show_interactive_card", { app: "generative-scene", scene: scene("solar-system.json") });
    timings.solarSystemBuiltMs = Date.now() - t0;
    check(!shown.isError && built()?.ok === true && built()?.revision === 1, `Demo A: the solar system is generated from Scene IR and built by the card (${text(shown).split("\n")[0].slice(0, 120)})`);
    check(card()?.app === "generative-scene" && card()?.state.objects === 18 && card()?.state.animations === 17, `the card built 18 objects and 17 animations (${card()?.state.objects}, ${card()?.state.animations})`);
    const route = shown.structuredContent?.route;
    check(route?.mode === "hybrid" && hub.snapshot().presentation?.route === "hybrid", `Router 2.0 chose ${route?.mode}: ${route?.reason}`);
    check(/Not to scale/.test(text(shown)) && /Not to scale/.test(await (await frameOf())!.locator(".badge").textContent() ?? ""), "the scale approximation is disclosed to Codex and on the card");
    const time0 = card()!.state.time as number;
    await pause(1_500);
    check((card()!.state.time as number) > time0, "the orbits animate (the timeline advances)");
    await page.screenshot({ path: name("A-solar-system") });
    // The user turns and zooms it.
    const b = await box();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.7);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + b.width * (0.5 + i * 0.015), b.y + b.height * (0.7 - i * 0.012));
    await page.mouse.up();
    await page.mouse.wheel(0, -400);
    check(await waitCard(c => c.state.view === "custom", 3_000), "dragging rotates the camera and the wheel zooms (the card reports a custom view)");
    await page.screenshot({ path: name("A-solar-system-rotated") });

    // ── Demo B: incremental modification ───────────────────────────────────────────────────────────────────────
    const instance = card()!.instance;
    await page.locator("#workspace iframe").evaluate(frame => { (frame as HTMLElement).dataset.v05 = "same-frame"; });
    let step = await patch([{ op: "transform", id: "earth", scaleBy: 3 }], { revision: card()!.scene!.revision });
    timings.patchEarthMs = step.ms;
    check(!step.r.isError && /Done and rendered/.test(text(step.r)) && card()!.state.changes === "0 created, 1 updated, 0 rebuilt, 0 removed",
      `"Make Earth three times larger": one object updated in place (${card()!.state.changes}; ${step.ms} ms to confirmed)`);
    const marsBefore = await position("mars");
    step = await patch([{ op: "update-animation", id: "orbit-mars", set: { paused: true } }, { op: "update-animation", id: "spin-mars", set: { paused: true } }]);
    await pause(1_200);
    const marsAfter = await position("mars"), earthA = await position("earth");
    await pause(800);
    const earthB = await position("earth");
    check(!step.r.isError && marsAfter === (await position("mars")) && earthA !== earthB, `"Stop Mars": Mars holds still (${marsAfter}) while Earth moves on (${earthA} → ${earthB})`);
    void marsBefore;
    await call("control_interactive_card", { action: "clear-selection" });
    await pause(300);
    // An absolute rise (v0.5.1): blue planets in view before the change make a ratio flaky; eight blue orbits add ~0.2%.
    const blueBefore = await blueShare();
    step = await patch([{ op: "material", id: "orbit", set: { color: "blue" } }]);
    await pause(300);
    const blueAfter = await blueShare();
    check(!step.r.isError && card()!.state.changes === "0 created, 8 updated, 0 rebuilt, 0 removed" && blueAfter > blueBefore + 0.0012,
      `"Change the orbit colour to blue": eight orbits recoloured in place (${card()!.state.changes}; blue pixels ${(blueBefore * 100).toFixed(2)}% → ${(blueAfter * 100).toFixed(2)}%)`);
    await page.screenshot({ path: name("B-earth-larger-mars-stopped-blue-orbits") });
    step = await patch([{ op: "update-animation", id: "orbit-mars", set: { paused: false } }, { op: "update-animation", id: "spin-mars", set: { paused: false } }]);
    const m1 = await position("mars");
    await pause(900);
    check(!step.r.isError && m1 !== await position("mars"), "\"Resume the animation\": Mars moves again");
    check(card()!.instance === instance && await page.locator("#workspace iframe").evaluate(frame => (frame as HTMLElement).dataset.v05) === "same-frame",
      "the same card and the same frame throughout: no reload, objects keep their identity");
    check(built()?.revision === card()!.scene!.revision && built()?.ok === true, `scene state and render agree (revision ${card()!.scene!.revision})`);

    // ── Demo F: select by clicking, then "move this object to the left and make it larger" ─────────────────────
    await call("control_interactive_card", { action: "pause" });
    await call("control_interactive_card", { action: "reset-camera" });
    await pause(1_400);
    const c = await box();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    check(await waitCard(k => k.selection?.objectId === "sun", 3_000), `clicking the centre selects the Sun (selected: ${card()?.selection?.objectId ?? "nothing"})`);
    const inspected = await call("inspect_interactive_card");
    check(/Selected: Sun/.test(text(inspected)) && /\$selected/.test(text(inspected)), "Codex can identify the selected object through inspect_interactive_card");
    await page.screenshot({ path: name("F-sun-selected") });
    step = await patch([{ op: "transform", id: "$selected", translate: [-3, 0, 0], scaleBy: 1.5 }]);
    const afterMove = await fullDoc();
    const sun = afterMove.objects.find(o => o.id === "sun")!;
    check(!step.r.isError && /Done and rendered/.test(text(step.r)) && JSON.stringify(sun.position) === "[-3,0,0]" && sun.scale === 1.5,
      `"Move this object to the left and make it larger": the Sun moved and grew, confirmed by the runtime (${text(step.r).split("\n")[0].slice(0, 90)})`);
    check(card()!.selection?.objectId === "sun", "the selection persists across the edit");
    await call("control_interactive_card", { action: "resume" });
    await pause(800);
    await page.screenshot({ path: name("F-sun-moved-planets-follow") });

    // ── Demo H: history ────────────────────────────────────────────────────────────────────────────────────────
    const before = card()!.scene!.revision;
    const undone = await call("control_interactive_card", { action: "undo" });
    let doc = await fullDoc();
    check(!undone.isError && card()!.scene!.revision === before + 1 && doc.objects.find(o => o.id === "sun")!.position === undefined, `"Undo the last change": the Sun is back (revision ${before} → ${card()!.scene!.revision}, a new revision)`);
    const redone = await call("control_interactive_card", { action: "redo" });
    doc = await fullDoc();
    check(!redone.isError && JSON.stringify(doc.objects.find(o => o.id === "sun")!.position) === "[-3,0,0]", "redo re-applies it");
    const stale = await call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "earth", scaleBy: 2 }], revision: 1 });
    check(stale.isError === true && /stale-revision/.test(text(stale)) && card()!.scene!.revision === before + 2, "a patch from an old revision is refused (stale-revision); nothing is overwritten");
    const invalid = await call("control_interactive_card", { action: "patch", patch: [{ op: "transform", id: "earth", scaleBy: 2 }, { op: "update", id: "pluto", set: { radius: 1 } }] });
    doc = await fullDoc();
    check(invalid.isError === true && /invalid-reference/.test(text(invalid)) && doc.objects.find(o => o.id === "earth")!.scale === 3, "an invalid patch changes nothing (transactional): Earth keeps its size");
    const reverted = await call("control_interactive_card", { action: "revert" });
    doc = await fullDoc();
    check(!reverted.isError && doc.objects.find(o => o.id === "earth")!.scale === undefined && doc.materials.find(m => m.id === "orbit")!.color === "#7f8a99", "revert restores the scene as created");
    const tooBig = await call("show_interactive_card", { app: "generative-scene", scene: { ...scene("solar-system.json"), objects: Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, type: "sphere", radius: 0.1 })) } });
    check(tooBig.isError === true && /resource-limit/.test(text(tooBig)) && card()!.scene!.document.objects.length === 18 && built()?.ok === true, "a scene over the limits is refused (resource-limit) and the open scene stays");
    await page.screenshot({ path: name("H-reverted") });
    const history = card()!.scene!.log.map(entry => `${entry.revision} ${entry.label}`);
    console.log(`  · history: ${history.slice(-6).join(" | ")}`);
    await call("control_interactive_card", { action: "close" });
    await pause(1_000);

    // ── Demo C: abstract → concrete ────────────────────────────────────────────────────────────────────────────
    const abstract = await call("show_interactive_card", { app: "generative-scene", scene: scene("passage-of-time.json") });
    check(abstract.structuredContent?.route?.mode === "body" && hub.snapshot().presentation?.kind === "scene" && hub.snapshot().card === null,
      `"Visualize the passage of time": the router chose the body (${abstract.structuredContent?.route?.reason})`);
    check((await until(page, state => state.phase === "holding", 6_000)).phase === "holding", "Aion's particle body forms it");
    await page.screenshot({ path: name("C-time-in-the-body") });
    t0 = Date.now();
    const timeline = await call("show_interactive_card", { app: "generative-scene", scene: scene("deep-time-timeline.json") });
    timings.timelineBuiltMs = Date.now() - t0;
    check(!timeline.isError && timeline.structuredContent?.route?.mode !== "body" && /body/.test(timeline.structuredContent?.route?.transition ?? "") && built()?.ok === true,
      `"Turn this into an interactive 3D timeline": ${timeline.structuredContent?.route?.mode} (${timeline.structuredContent?.route?.transition})`);
    const f0 = await page.evaluate("window.aionPresence.runtime.quality().frames") as number;
    await pause(1_000);
    check(await page.evaluate("window.aionPresence.runtime.quality().frames") as number > f0 && await page.locator("#workspace iframe").count() === 1, "Aion stays present (the body keeps rendering) beside the card");
    await page.screenshot({ path: name("C-timeline") });
    const periods = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "fixtures", "scenes", "geological-periods.patch.json"), "utf8"));
    step = await patch(periods, { revision: card()!.scene!.revision });
    timings.periodsPatchMs = step.ms;
    check(!step.r.isError && card()!.state.objects === 24 && /^15 created, 0 updated, 0 rebuilt, 0 removed$/.test(String(card()!.state.changes)),
      `"Add the major geological periods": 15 objects added to the same scene (${card()!.state.changes}; ${step.ms} ms)`);
    await pause(1_400);
    await page.screenshot({ path: name("C-timeline-periods") });
    // The user selects a period by clicking on it: find it from the card's own report.
    await call("control_interactive_card", { action: "select", value: "jurassic" });
    check(await waitCard(k => k.selection?.objectId === "jurassic" && k.selection.properties?.["Began (Ma)"] === 201.4, 3_000), "a period can be selected and its metadata is reported (Jurassic began 201.4 Ma)");
    await page.screenshot({ path: name("C-jurassic-selected") });
    await call("control_interactive_card", { action: "close" });
    await pause(1_000);

    // ── Demo D: a three-phase magnetic field (illustrative) ────────────────────────────────────────────────────
    const field = await call("show_interactive_card", { app: "generative-scene", scene: scene("three-phase-field.json") });
    check(!field.isError && field.structuredContent?.route?.capability === "PARTIALLY_SUPPORTED" && /not computed/i.test(text(field)), "Demo D: the field is shown as illustrative (partially supported: no field solver), and says so");
    check(/not computed/i.test(await (await frameOf())!.locator(".badge").textContent() ?? ""), "the card carries the illustrative notice");
    await pause(600);
    await page.screenshot({ path: name("D-three-phase-a") });
    await call("control_interactive_card", { action: "pause" });
    await call("control_interactive_card", { action: "seek", value: 0.5 });
    check(await waitCard(k => k.state.playing === false && Math.abs((k.state.time as number) - 0.5) < 0.05, 3_000), "animation controls: pause and seek to 0.5 s");
    await page.screenshot({ path: name("D-three-phase-t0.5") });
    await call("control_interactive_card", { action: "seek", value: 1 });
    await pause(400);
    await page.screenshot({ path: name("D-three-phase-t1.0") });
    await call("control_interactive_card", { action: "set-speed", value: 0.5 });
    await call("control_interactive_card", { action: "resume" });
    check(await waitCard(k => k.state.playing === true && k.state.speed === 0.5, 3_000), "resume at half speed");
    await call("control_interactive_card", { action: "close" });
    await pause(1_000);

    // ── Demo E: a conceptual buck converter ────────────────────────────────────────────────────────────────────
    const buck = await call("show_interactive_card", { app: "generative-scene", scene: scene("buck-converter.json") });
    check(!buck.isError && buck.structuredContent?.route?.mode === "card" && /not a circuit simulation/i.test(text(buck)), `Demo E: the buck converter is a card (${buck.structuredContent?.route?.reason}) and says it is not a simulation`);
    await call("control_interactive_card", { action: "pause" });
    await call("control_interactive_card", { action: "seek", value: 0.5 });
    await pause(400);
    await page.screenshot({ path: name("E-buck-switch-on") });
    await call("control_interactive_card", { action: "seek", value: 1.5 });
    await pause(400);
    await page.screenshot({ path: name("E-buck-switch-off") });
    await call("control_interactive_card", { action: "select", value: "inductor" });
    check(await waitCard(k => k.selection?.objectId === "inductor" && /Stores energy/.test(String(k.selection.properties?.Role)), 3_000), "its components are identifiable (the inductor's role is reported)");
    await call("control_interactive_card", { action: "close" });
    await pause(1_000);

    // Gears and a bead along a curve (couple, path).
    await call("show_interactive_card", { app: "generative-scene", scene: scene("gear-train.json") });
    check(built()?.ok === true, "two meshing gears (one drives the other at 2:1) and a bead following a curve");
    await pause(1_200);
    await page.screenshot({ path: name("gears") });
    await call("control_interactive_card", { action: "close" });
    await pause(800);

    // ── Demo G: unsupported ────────────────────────────────────────────────────────────────────────────────────
    const presentationBefore = hub.snapshot().presentation?.id ?? null;
    const refused = await call("show_interactive_card", { app: "generative-scene", scene: scene("transformer-flux-measured.json") });
    check(refused.isError === true && /unsupported: accurate magnetic flux density needs a numerical field solver/.test(text(refused)) && (hub.snapshot().presentation?.id ?? null) === presentationBefore,
      "Demo G: an accurate flux-density result is refused (needs a field solver): nothing shown, nothing substituted");

    // ── Repeated open/close and performance ────────────────────────────────────────────────────────────────────
    const cycles = 4;
    t0 = Date.now();
    for (let i = 0; i < cycles; i++) {
      for (const file of ["solar-system.json", "buck-converter.json"]) {
        await call("show_interactive_card", { app: "generative-scene", scene: scene(file) });
        await call("control_interactive_card", { action: "close" });
        await pause(250);
      }
    }
    await pause(2_500);
    timings.openBuildCloseMs = Math.round((Date.now() - t0) / (cycles * 2));
    const cardHistory = await page.evaluate("window.aionPresence.cardHistory") as { opened: number; closed: number; leftovers: { geometries: number; textures: number; urls: number; loops: number }[] };
    const left = cardHistory.leftovers.reduce((sum, item) => sum + item.geometries + item.textures + item.urls + item.loops, 0);
    check(cardHistory.opened === cardHistory.closed && left === 0, `every generated scene released everything (${cardHistory.closed} closed, ${left} leftovers${left ? `: ${JSON.stringify(cardHistory.leftovers)}` : ""})`);
    check(warnings.length === 0, `no WebGL context warnings${warnings.length ? `: ${warnings[0]}` : ""}`);
    await call("show_interactive_card", { app: "generative-scene", scene: scene("solar-system.json") });
    await pause(4_500);
    const fa = await page.evaluate("window.aionPresence.runtime.quality().frames") as number;
    await pause(2_000);
    const fb = await page.evaluate("window.aionPresence.runtime.quality().frames") as number;
    const resources = card()!.resources;
    timings.bodyFps = Math.round((fb - fa) / 2);
    timings.cardFps = resources?.fps ?? -1;
    timings.cardDrawCalls = resources?.drawCalls ?? -1;
    timings.cardTriangles = resources?.triangles ?? -1;
    timings.cardGeometries = resources?.geometries ?? -1;
    timings.cardBuildMs = (card()!.state.buildMs as number | undefined) ?? -1;
    if (resources?.heapMB !== undefined) timings.cardHeapMB = resources.heapMB;
    console.log(`  · timings ${JSON.stringify(timings)}`);
    writeFileSync(join(OUT, `v05-${renderer}-performance.json`), JSON.stringify({ renderer, ...timings }, null, 2));
    check(timings.bodyFps > 20 && timings.cardFps > 20, `both render smoothly together (body ${timings.bodyFps} fps, card ${timings.cardFps} fps)`);
    await call("control_interactive_card", { action: "close" });
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

/**
 * v0.7: the spoken first-run welcome in the real renderer, on hubs of their own (fresh installations). The synthesizer is
 * a stand-in injected into the page (it reports start, word boundaries and end like Chrome's, and can refuse without a
 * user gesture or have no voices), so every path is exercised deterministically; it proves the lifecycle and the
 * interface, not that a voice is audible — `npm run welcome:speech` speaks with the system's real voice.
 */
function fakeSpeech(mode: string) {
  // Plain JavaScript (a string), so the page receives it exactly as written.
  return `(() => {
  const mode = ${JSON.stringify(mode)};
  const log = { spoken: [], cancels: 0 };
  window.__speech = log;
  const voices = mode === "none" ? [] : [
    { name: "Google US English", lang: "en-US", localService: false, default: false, voiceURI: "g" },
    { name: "Samantha", lang: "en-US", localService: true, default: true, voiceURI: "s" },
    { name: "Tingting", lang: "zh-CN", localService: true, default: false, voiceURI: "t" },
  ];
  let queue = [], current = null, timers = [];
  // A real click in the page (headless Chrome reports user activation as already given, so it is tracked here).
  let gestured = false;
  addEventListener("pointerdown", event => { if (event.isTrusted) gestured = true; }, true);
  const synth = new EventTarget();
  synth.getVoices = () => voices;
  synth.speak = u => { queue.push(u); pump(); };
  synth.cancel = () => {
    log.cancels++;
    const dropped = [current, ...queue].filter(Boolean);
    queue = []; current = null; timers.forEach(clearTimeout); timers = [];
    dropped.forEach(u => u.onerror && u.onerror({ error: "canceled" }));
  };
  const pump = () => {
    if (current || !queue.length) return;
    const u = current = queue.shift();
    if (mode === "blocked" && !gestured) { current = null; timers.push(setTimeout(() => u.onerror && u.onerror({ error: "not-allowed" }), 30)); return; }
    log.spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, lang: u.lang });
    const words = u.text.split(/\\s+/);
    timers.push(setTimeout(() => {
      u.onstart && u.onstart({});
      words.forEach((_, i) => timers.push(setTimeout(() => u.onboundary && u.onboundary({ name: "word" }), i * 110)));
      timers.push(setTimeout(() => { current = null; u.onend && u.onend({}); pump(); }, words.length * 110 + 150));
    }, 40));
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.voice = null; this.lang = ""; this.rate = 1; this.pitch = 1; this.volume = 1; } };
})();`;
}

async function welcome() {
  console.log("v0.7: spoken first-run welcome (a stand-in synthesizer in the real renderer)");
  const fresh = async (mode: string, locale = "en-US") => {
    const dir = mkdtempSync(join(tmpdir(), "aion-welcome-"));
    const own = new PresenceHub({ home: dir, port: 0, page: () => readFileSync(pagePath, "utf8"), bridge: { locate: () => null } });
    await own.start();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale });
    await context.addInitScript({ content: fakeSpeech(mode) });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${own.surfaceUrl}&debug=1&mic=0`);
    await until(page, state => state.frames > 30, 10_000);
    await page.addStyleTag({ content: "#debug { display: none !important; }" });
    const phase = () => page.evaluate("window.aionPresence.narration.phase") as Promise<string>;
    const waitPhase = async (want: string[], ms = 15_000) => { let now = await phase(); for (let t = 0; t < ms && !want.includes(now); t += 100) { await pause(100); now = await phase(); } return now; };
    const spoken = () => page.evaluate("window.__speech") as Promise<{ spoken: { text: string; voice: string | null; lang: string }[]; cancels: number }>;
    const done = () => existsSync(join(dir, "welcome-complete")) ? readFileSync(join(dir, "welcome-complete"), "utf8").trim() : "";
    const close = async () => { await context.close(); await own.stop(); };
    return { own, dir, page, errors, phase, waitPhase, spoken, done, close };
  };

  // English, speech available: it waits while Codex answers, then speaks the four sentences, then is remembered.
  {
    const t = await fresh("ok");
    try {
      check(t.own.snapshot().hub.welcome, "a fresh installation: the welcome is due");
      t.own.apply({ type: "activity", state: "responding" });
      await t.page.locator("#welcome.visible").waitFor({ timeout: 6_000 });
      await pause(3_000);
      check((await t.spoken()).spoken.length === 0, "while Codex is answering, Aion waits (no overlapping speech)");
      t.own.apply({ type: "activity", state: "idle" });
      check(await t.waitPhase(["speaking"]) === "speaking", "once Codex is quiet, Aion speaks");
      await pause(500);
      const box = await t.page.locator("#welcome").boundingBox();
      check(!!box && box.height < 150, `no panel over the stage: the welcome is ${Math.round(box?.height ?? 0)} px tall (title, caption, controls)`);
      check(await t.page.locator(".welcome-intro, .welcome-examples:visible").count() === 0, "no introduction paragraph and no examples by default");
      const caption = await t.page.locator(".welcome-caption").textContent() ?? "";
      check(/Aion|Codex|companion/.test(caption), `the caption follows the sentence being spoken: "${caption}"`);
      const field = await t.page.evaluate("({ state: window.aionPresence.aion.currentState, responding: window.aionPresence.presence.signal.responding })") as { state: string; responding: number };
      check(field.state === "responding" || field.responding > 0.2, `the body answers while it speaks (semantic field: state ${field.state}, responding ${field.responding.toFixed(2)})`);
      await t.page.screenshot({ path: join(OUT, "v07-welcome-speaking.png") });
      check(await t.waitPhase(["finished"], 20_000) === "finished", "it finishes");
      const log = await t.spoken();
      check(log.spoken.length === 4 && log.spoken.every(u => u.voice === "Samantha"), `four sentences, an on-device voice (never the network one): ${log.spoken.map(u => u.voice).join(", ")}`);
      check(/^Hello, I'm Aion\./.test(log.spoken[0]?.text ?? "") && /powered by Codex/.test(log.spoken[1]?.text ?? ""), "the welcome script, in English");
      for (let i = 0; i < 20 && !t.done(); i++) await pause(150);
      check(/ spoken$/.test(t.done()), `remembered as spoken: "${t.done()}"`);
      // Replay, then the examples behind "?".
      await t.page.locator(".welcome-replay").click();
      check(await t.waitPhase(["speaking"]) === "speaking", "Replay speaks it again");
      await t.page.locator(".welcome-help-toggle").click();
      check(await t.page.locator(".welcome-examples").isVisible(), "? opens the three examples");
      await t.page.screenshot({ path: join(OUT, "v07-welcome-help.png") });
      await t.page.locator(".welcome-copy").first().click();
      let said = "";
      for (let i = 0; i < 20 && !/Copied|Selected/.test(said); i++) { await pause(100); said = await t.page.locator(".welcome-status").textContent() ?? ""; }
      check(/Copied|Selected/.test(said), `an example click copies it: "${said}"`);
      // Skip while speaking: the voice stops at once.
      const cancels = (await t.spoken()).cancels;
      await t.page.locator(".welcome-skip").click();
      await pause(900);
      check((await t.spoken()).cancels > cancels && !(await t.page.locator("#welcome").isVisible()), "Skip stops the voice and puts the welcome away");
      await t.page.reload();
      await until(t.page, state => state.frames > 30, 10_000);
      await pause(3_000);
      check(!(await t.page.locator("#welcome").isVisible()) && (await t.spoken()).spoken.length === 0, "a returning user is not welcomed again");
      check(!t.errors.length, `no page errors${t.errors.length ? `: ${t.errors.join("; ")}` : ""}`);
    } finally { await t.close(); }
  }
  // Chinese.
  {
    const t = await fresh("ok", "zh-CN");
    try {
      check(await t.waitPhase(["speaking"]) === "speaking", "zh-CN: Aion speaks");
      await t.waitPhase(["finished"], 20_000);
      const log = await t.spoken();
      check(log.spoken.length === 4 && log.spoken.every(u => u.voice === "Tingting") && /你好，我是 Aion/.test(log.spoken[0]?.text ?? ""), `Chinese, with a Chinese on-device voice: ${log.spoken[0]?.text} (${log.spoken[0]?.voice})`);
      check(await t.page.locator(".welcome-title").textContent() === "欢迎使用 Aion", "the title in Chinese");
    } finally { await t.close(); }
  }
  // The browser refuses without a gesture: "Listen to the welcome", nothing remembered until it is heard.
  {
    const t = await fresh("blocked");
    try {
      const offered = await t.waitPhase(["offered"]);
      check(offered === "offered", `autoplay refused: Listen to the welcome is offered (${offered})`);
      check(await t.page.locator(".welcome-listen").isVisible() && !t.done(), "one button, and nothing is remembered yet");
      await t.page.screenshot({ path: join(OUT, "v07-welcome-listen.png") });
      await t.page.locator(".welcome-listen").click();
      check(await t.waitPhase(["speaking"]) === "speaking", "the user's click lets it speak");
      await t.waitPhase(["finished"], 20_000);
      for (let i = 0; i < 20 && !t.done(); i++) await pause(150);
      check(/ spoken$/.test(t.done()), "then remembered as spoken");
    } finally { await t.close(); }
  }
  // No on-device voice: a few lines of text instead.
  {
    const t = await fresh("none");
    try {
      check(await t.waitPhase(["text"]) === "text", "no voice: the short text stands in");
      const text = await t.page.locator(".welcome-transcript").textContent() ?? "";
      check(await t.page.locator(".welcome-transcript").isVisible() && /powered by Codex/.test(text), "the script as a small, readable text");
      await t.page.screenshot({ path: join(OUT, "v07-welcome-text.png") });
      await t.page.locator(".welcome-skip").click();
      for (let i = 0; i < 20 && !t.done(); i++) await pause(150);
      check(/ skipped$/.test(t.done()), `closed: remembered (${t.done()}), never as spoken`);
    } finally { await t.close(); }
  }
  // A visual request while it speaks, and the window closed while it speaks.
  {
    const t = await fresh("ok");
    try {
      await t.waitPhase(["speaking"]);
      t.own.apply({ type: "present", content: { kind: "form", form: "tao.yin-yang", label: visualForms.label("tao.yin-yang") }, hold: 6 });
      await pause(1_200);
      check((await t.spoken()).cancels > 0 && !(await t.page.locator("#welcome").isVisible()), "a visual request stops the voice and puts the welcome away");
      for (let i = 0; i < 20 && !t.done(); i++) await pause(150);
      check(/ started$/.test(t.done()), `remembered: the user has started (${t.done()})`);
    } finally { await t.close(); }
    const u = await fresh("ok");
    try {
      await u.waitPhase(["speaking"]);
      await pause(400);
      await u.page.close({ runBeforeUnload: true });
      for (let i = 0; i < 30 && !u.done(); i++) await pause(150);
      check(/ interrupted$/.test(u.done()), `the window closed while speaking: stopped, remembered as heard in part (${u.done()})`);
    } finally { await u.close(); }
  }
}

/**
 * v0.7: FreeCAD in the real renderer — the real FreeCAD backend (skipped, and said so, when FreeCAD is not installed)
 * through the real cad_model tool, into the CAD viewer card: a box, a longer box (the view kept), holes, the selected
 * hole moved (the selection kept), undo, a refusal that changes nothing, and a selection that is lost.
 */
async function cad() {
  console.log("v0.7: FreeCAD → CAD viewer (real FreeCAD, real renderer)");
  if (!findFreecad()) { console.log("  – FreeCAD is not installed: skipped (not evidence either way)"); return; }
  const { page, errors } = await open(browser, "&mic=0", { width: 1440, height: 900 });
  await page.addStyleTag({ content: "#debug { display: none !important; }" });
  const backend = new FreecadBackend({ script: join(PLUGIN_ROOT, "cad", "aion_freecad_worker.py"), env: { AION_CAD_WORKSPACE: join(home, "cad") } });
  const aion = await connectAion({ home, cad: backend });
  type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: { cad?: { revision: number; shown_revision?: number; timing: Record<string, number>; solids: { size_mm: number[]; volume_mm3: number }[]; selected?: { id: string } } } };
  const call = (action: string, args: Record<string, unknown> = {}) => aion.call("cad_model", { action, args }) as Promise<Result>;
  const card = () => hub.snapshot().card;
  const shot = (moment: string) => page.screenshot({ path: join(OUT, `v07-cad-${moment}.png`) });
  const timings: Record<string, number>[] = [];
  try {
    await call("create_document", { name: "Enclosure" });
    let r = await call("add_primitive", { kind: "box", length: 120, width: 80, height: 40, name: "Enclosure" });
    check(!r.isError && r.structuredContent?.cad?.shown_revision === r.structuredContent?.cad?.revision, `A: FreeCAD made the box and the viewer confirmed revision ${r.structuredContent?.cad?.shown_revision}`);
    timings.push(r.structuredContent!.cad!.timing);
    await pause(1_200);
    await shot("1-box");
    // The user turns the view; a FreeCAD change keeps it.
    await aion.call("control_interactive_card", { action: "set-view", value: "top" });
    await pause(1_400);
    r = await call("set_parameter", { component: "Enclosure", parameter: "Length", value: 150 });
    check(!r.isError && r.structuredContent?.cad?.shown_revision === r.structuredContent?.cad?.revision && r.structuredContent?.cad?.solids[0].size_mm[0] === 150, "B: length 150 recomputed in FreeCAD and shown");
    check(card()?.state.view === "top", `the view the user chose is kept across revisions (${String(card()?.state.view)})`);
    timings.push(r.structuredContent!.cad!.timing);
    await aion.call("control_interactive_card", { action: "set-view", value: "iso" });
    r = await call("add_holes", { target: "Enclosure", diameter: 6, corners: 8 });
    const ids = ((card()?.state.components ?? []) as { id: string }[]).map(c => c.id);
    check(!r.isError && ["Hole1", "Hole2", "Hole3", "Hole4"].every(id => ids.includes(id)), `C: four holes, each its own component in the viewer (${ids.join(", ")})`);
    timings.push(r.structuredContent!.cad!.timing);
    await pause(1_400);
    await shot("2-holes");
    // D: the user selects Hole 2 in the viewer, then "move this hole 5 mm inward".
    await aion.call("control_interactive_card", { action: "select", value: "Hole2" });
    await pause(400);
    r = await call("set_parameter", { component: "$selected", parameter: "Inset", delta: 5 });
    check(!r.isError && card()?.selection?.objectId === "Hole2", `D: the selected hole moved, and it is still selected (${card()?.selection?.objectId})`);
    timings.push(r.structuredContent!.cad!.timing);
    await pause(1_400);
    await shot("3-selected-hole-moved");
    const before = r.structuredContent!.cad!.revision;
    r = await call("undo");
    check(!r.isError && r.structuredContent!.cad!.revision > before && r.structuredContent?.cad?.shown_revision === r.structuredContent?.cad?.revision, "E: undo is a new revision, shown");
    // G: an impossible change: refused, nothing changes on screen.
    const shownBefore = card()?.state.revision;
    r = await call("set_parameter", { component: "Hole2", parameter: "Diameter", value: -3 });
    const refused = await call("add_holes", { target: "Enclosure", diameter: 6, positions: [[900, 900]] });
    check(!!refused.isError && /Nothing was changed/.test(refused.content[0].text) && card()?.state.revision === shownBefore, "G: an impossible hole is refused; the viewer keeps the previous valid revision");
    // A selection whose component disappears is reported, never moved to another part.
    await aion.call("control_interactive_card", { action: "select", value: "Hole3" });
    await pause(400);
    r = await call("delete", { component: "$selected" });
    check(!r.isError && /no longer exists/.test(r.content[0].text) && !card()?.selection?.objectId, "a deleted selection is reported as lost, nothing else is selected");
    r = await call("fillet", { target: "Enclosure", radius: 4 });
    check(!r.isError, "a fillet on the vertical edges");
    await pause(1_400);
    await shot("4-fillet");
    timings.push(r.structuredContent!.cad!.timing);
    const keys = ["freecad_ms", "tessellation_ms", "preview_build_ms", "asset_transfer_ms", "card_render_ms", "total_ms"];
    console.log(`  timings (ms): ${keys.map(k => `${k} ${timings.map(t => Math.round(t[k] ?? 0)).join("/")}`).join("; ")}`);
    check(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { backend.stop(); await aion.call("clear_presentation", {}).catch(() => {}); await aion.close(); await page.close(); }
}

async function sim() {
  console.log("v0.8: FreeCAD + Gmsh + Elmer → Simulation Card (real tools, real renderer)");
  const tools = await findSimTools();
  if (!findFreecad() || !tools.gmsh || !tools.elmerSolver) { console.log("  – FreeCAD, Gmsh or Elmer is not installed: skipped (not evidence either way)"); return; }
  const { page, errors } = await open(browser, "&mic=0", { width: 1440, height: 900 });
  await page.addStyleTag({ content: "#debug { display: none !important; }" });
  const backend = new FreecadBackend({ script: join(PLUGIN_ROOT, "cad", "aion_freecad_worker.py"), env: { AION_CAD_WORKSPACE: join(home, "cad-sim"), AION_SIM_WORKSPACE: join(home, "sim") } });
  const service = new SimulationService({ root: join(home, "sim"), cad: freecadBridge(backend) });
  const aion = await connectAion({ home, cad: backend, sim: service });
  type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: { simulation?: Record<string, unknown> } };
  const simulate = (action: string, args: Record<string, unknown> = {}) => aion.call("simulate", { action, args }) as Promise<Result>;
  const control = (action: string, value?: unknown) => aion.call("control_interactive_card", { action, ...(value !== undefined ? { value } : {}) }) as Promise<Result>;
  const card = () => hub.snapshot().card;
  const shot = (moment: string) => page.screenshot({ path: join(OUT, `v08-sim-${moment}.png`) });
  const frame = page.frameLocator("#workspace iframe");
  try {
    await aion.call("cad_model", { action: "create_document", args: { name: "Busbar" } });
    await aion.call("cad_model", { action: "add_primitive", args: { kind: "box", length: 100, width: 10, height: 5, name: "Busbar" } });
    await aion.call("cad_model", { action: "add_holes", args: { target: "Busbar", diameter: 4, positions: [[30, 5]] } });
    await aion.call("cad_model", { action: "add_primitive", args: { kind: "box", length: 25, width: 10, height: 5, at: [100, 0, 0], name: "Tab" } });
    let r = await simulate("create", { analysis: "electrothermal", name: "Busbar with tab" });
    check(!r.isError && card()?.app === "simulation" && card()?.state.mode === "setup", `the setup is shown in the Simulation Card (${String(card()?.state.mode)})`);
    await pause(1_500);
    await shot("1-setup");
    // The user clicks the model: a face is picked (and reported as F<number>).
    // (The bar is thin on screen: try points along a line across the view until one lands on it.)
    const box = await page.locator("#workspace iframe").boundingBox();
    for (let t = 0; box && t <= 1 && !card()?.selection?.objectId; t += 0.05) {
      await page.mouse.click(box.x + box.width * (0.3 + 0.45 * t), box.y + box.height * (0.38 + 0.3 * t));
      await pause(250);
    }
    const picked = card()?.selection?.objectId ?? "";
    check(/^F\d+$/.test(picked), `a mouse click on the model picks a face (${picked || "none"})`);
    for (const [action, args] of [
      ["set_material", { bodies: "Busbar", material: "copper" }], ["set_material", { bodies: "Tab", material: "aluminium" }],
      ["set_boundary", { faces: "left", type: "current", current: "200 A", name: "Terminal +" }], ["set_boundary", { faces: "right", type: "ground" }],
      ["set_boundary", { faces: "remaining", type: "convection", h: "10 W/(m2*K)", ambient: "25 °C", name: "Natural convection" }],
      ["set_boundary", { faces: "left", type: "temperature", temperature: "40 °C", name: "Clamp +" }], ["set_boundary", { faces: "right", type: "temperature", temperature: "40 °C", name: "Clamp −" }],
    ] as [string, Record<string, unknown>][]) {
      r = await simulate(action, args);
      if (r.isError) check(false, `${action}: ${r.content[0].text}`);
    }
    await pause(1_200);
    await shot("2-conditions");
    const legendSetup = await frame.locator(".sim-legend").innerText().catch(() => "");
    check(/Terminal \+/.test(legendSetup) && /Natural convection/.test(legendSetup), "the setup legend names the conditions by their colours");
    r = await simulate("run", { wait_s: 50 });
    const result = r.structuredContent?.simulation as { run: number; electric: { current_A: number; resistance_ohm: number; joule_W: number }; thermal: { max_K: number; balance: { relativeError: number } }; fields: { id: string; max: number; min: number }[]; seconds?: Record<string, number> } | undefined;
    check(!r.isError && card()?.state.mode === "results" && card()?.state.run === result?.run, `Elmer solved run ${result?.run} and the card shows it (${result?.electric.current_A.toFixed(3)} A, R ${result?.electric.resistance_ohm.toExponential(4)} Ω, ${result?.electric.joule_W.toFixed(3)} W)`);
    check(Boolean(result) && Math.abs(result!.electric.current_A - 200) < 1e-3 && result!.thermal.balance.relativeError < 1e-3, "the requested current flows and the heat balance closes");
    console.log(`  seconds: ${JSON.stringify(result?.seconds)}`);
    await control("set-field", "temperature");
    await pause(1_200);
    const temp = result?.fields.find(f => f.id === "temperature");
    const legend = await frame.locator(".sim-legend").innerText().catch(() => "");
    check(card()?.state.field === "temperature" && /Temperature/.test(legend) && /°C/.test(legend), "the temperature field with its labelled legend (°C)");
    check(String(card()?.state.range).startsWith((temp!.min - 273.15).toPrecision(4).replace(/\.?0+$/, "")), `the colour range is the solver's own minimum and maximum (${String(card()?.state.range)})`);
    await shot("3-temperature");
    await control("set-field", "current_density");
    await control("show-vectors", true);
    await pause(1_200);
    check(card()?.state.vectors === true && card()?.state.field === "current_density", "current density with its vectors");
    await shot("4-current-density-vectors");
    const section = await control("section", "y 5");
    await pause(1_200);
    check(!section.isError && String(card()?.state.section).startsWith("y 5"), `a section through the interior (${String(card()?.state.section)})`);
    await shot("5-section");
    await control("set-view", "front");
    await pause(1_400);
    await shot("5b-section-front");
    await control("set-view", "iso");
    await control("probe", "max");
    await pause(800);
    const jmax = result?.fields.find(f => f.id === "current_density")!.max ?? 0;
    const probeText = String(card()?.state.probe ?? "");
    check(probeText.includes((jmax / 1e6).toPrecision(4).replace(/\.?0+$/, "")) && /nodal maximum/.test(probeText), `the probe reads the solver's maximum (${probeText})`);
    await shot("6-probe-max");
    await control("show-vectors", false);
    await control("section", "off");
    await control("set-field", "temperature");
    await control("set-colormap", "viridis");
    await control("bands", true);
    await control("show-mesh", true);
    await pause(1_200);
    check(card()?.state.colormap === "viridis" && card()?.state.bands === true && card()?.state.mesh === true, "another colour map, banded contours and the mesh");
    await shot("7-viridis-bands-mesh");
    const missing = await control("set-field", "magnetic_flux_density");
    check(!!missing.isError && /has no field/.test(missing.content[0].text), "a field the result does not carry is refused, never substituted");
    // A new service (as a new MCP server would be) shows the stored result without solving.
    const fresh = new SimulationService({ root: join(home, "sim"), cad: null });
    const aion2 = await connectAion({ home, sim: fresh });
    const reopened = await aion2.call("simulate", { action: "show", args: { run: result?.run, field: "joule_heating" } }) as Result;
    await pause(1_200);
    check(!reopened.isError && card()?.state.field === "joule_heating", "the stored result reopens in the card without a solve");
    await shot("8-reopened-joule");
    await aion2.close();
    check(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { backend.stop(); await aion.call("clear_presentation", {}).catch(() => {}); await aion.close(); await page.close(); }
}

async function v06(renderer: "auto" | "canvas") {
  console.log(`v0.6: Route Explorer (${renderer}), real routing and elevation`);
  const { page, errors } = await open(browser, `&mic=0${renderer === "canvas" ? "&renderer=canvas" : ""}`, { width: 1440, height: 900 });
  const view = <T,>(expression: string) => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`) as Promise<T>;
  const aion = await connectAion({ home, resolver: new VisualResolver({ env: {} }) });
  // Evidence screenshots without the diagnostics panel (it is only there to read the view's state).
  await page.addStyleTag({ content: "#debug { display: none !important; }" });
  const shot = (moment: string) => page.screenshot({ path: join(OUT, `v06-${renderer}-${moment}.png`) });
  type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: { journey?: Record<string, unknown>; card?: { state: Record<string, unknown> }; presentation?: { kind: string; route: string } | null } };
  const call = (tool: string, args: Record<string, unknown> = {}) => aion.call(tool, args) as Promise<Result>;
  const card = () => hub.snapshot().card;
  const formed = async (ms = 30_000) => { for (let w = 0; w < ms; w += 250) { if (await view<boolean>("v.visual.phase === 'holding' && v.visual.target.visual.kind === 'heightfield'")) return true; await pause(250); } return false; };
  const drawn = () => view<{ points: number; a: number[] | null; b: number[] | null; cursor: number[] | null; highlight: number[] | null; visible: number }>("v.markerLayer.routeDrawn");
  const frameOf = async () => (await (await page.locator("#workspace iframe").elementHandle())?.contentFrame()) ?? null;
  const settle = async (ok: () => boolean | Promise<boolean>, ms = 12_000) => { for (let w = 0; w < ms && !(await ok()); w += 200) await pause(200); return ok(); };
  try {
    // "Show me Scotland's terrain." → "Plan a cycling route from Glasgow to Edinburgh."
    check(!(await call("show_terrain", { region: "Scotland" })).isError && await formed(), "Scotland's terrain forms");
    const formedRevision = await view<number>("v.visual.revision");
    const started = performance.now();
    const planned = await call("plan_route", { from: "Glasgow", to: "Edinburgh", mode: "cycling" });
    const journey = planned.structuredContent?.journey ?? {};
    check(!planned.isError && Number(journey.distance_km) > 60 && Number(journey.distance_km) < 95, `a real cycling route: ${planned.isError ? planned.content[0].text : `${journey.distance_km} km, ${journey.duration}, ↑${journey.ascent_m} m (${((performance.now() - started) / 1000).toFixed(1)} s)`}`);
    check(planned.structuredContent?.presentation?.kind === "interactive" && planned.structuredContent.presentation.route === "hybrid", "routed hybrid: the particle terrain and the Route Explorer card");
    check(await settle(() => card()?.route?.rendered?.ok === true), "the card drew the route (confirmed revision)");
    check(await view<number>("v.visual.revision") === formedRevision && await view<string>("v.visual.phase") === "holding", "the terrain on show was kept, not formed again");
    check(await settle(async () => (await drawn()).points >= 10 && (await drawn()).visible > 0.9), `the route rests on the particle terrain (${(await drawn()).points} points)`);
    const ends = await drawn();
    check(!!ends.a && !!ends.b, "A and B stand on the terrain");
    check(await settle(() => card()?.state.tiles === "ok", 15_000), `the card's map has its OpenStreetMap tiles (${String(card()?.state.tiles)})`);
    await pause(800);
    await shot("scotland-route");
    // Performance: the body with the route overlay and the card beside it, then while the profile's pointer sweeps
    // (CURSOR messages, the overlay redrawing the pointer each frame).
    const perf: Record<string, number> = { planSeconds: Math.round((performance.now() - started) / 100) / 10 };
    const fps = async (during?: () => Promise<void>) => {
      const f0 = await page.evaluate("window.aionPresence.runtime.quality().frames") as number, t0 = performance.now();
      if (during) await during(); else await pause(2_000);
      return Math.round(((await page.evaluate("window.aionPresence.runtime.quality().frames") as number) - f0) / ((performance.now() - t0) / 1000));
    };
    perf.bodyFps = await fps();
    const sweepFrame = await frameOf();
    perf.bodyFpsSweeping = await fps(async () => {
      const box = sweepFrame ? await sweepFrame.locator(".rx-profile canvas").boundingBox() : null;
      for (let i = 0; i < 40 && sweepFrame && box; i++) { await sweepFrame.locator(".rx-profile canvas").hover({ position: { x: box.width * (0.1 + 0.8 * i / 40), y: box.height / 2 } }); await pause(50); }
    });
    perf.cardFps = card()?.resources?.fps ?? -1;
    perf.overlayPoints = (await drawn()).points;
    perf.tiles = Number(card()?.resources?.textures ?? -1);
    writeFileSync(join(OUT, `v06-${renderer}-performance.json`), JSON.stringify({ renderer, ...perf }, null, 2));
    console.log(`  · ${JSON.stringify(perf)}`);
    check(perf.bodyFps > 20 && perf.bodyFpsSweeping > 20, `the body stays smooth beside the route and its card (${perf.bodyFps} fps; ${perf.bodyFpsSweeping} fps while the pointer sweeps the profile)`);
    await page.mouse.move(5, 5);
    // "Show me the highest point."
    const highest = await call("control_interactive_card", { action: "show", value: "highest" });
    check(!highest.isError && card()?.state.highlight === "highest" && typeof card()?.state.highlightM === "number", `the highest point is highlighted (${card()?.state.highlightM} m at km ${card()?.state.highlightKm})`);
    check(await settle(async () => !!(await drawn()).highlight), "…on the terrain too, at the same place along the route");
    await pause(900);
    await shot("highest");
    // Pointing along the profile moves the place on the terrain (CURSOR, page-local).
    const frame = await frameOf();
    if (frame) {
      const box = await frame.locator(".rx-profile canvas").boundingBox();
      if (box) await frame.locator(".rx-profile canvas").hover({ position: { x: box.width * 0.62, y: box.height * 0.5 } });
      check(await settle(async () => !!(await drawn()).cursor, 3_000), "pointing at the profile shows the same place on the particle terrain");
      await shot("hover");
      await frame.locator(".rx-profile canvas").hover({ position: { x: 2, y: 2 } }).catch(() => {});
      await page.mouse.move(5, 5);
    }
    // "Reverse the route."
    const reversed = await call("plan_route", { reverse: true });
    check(!reversed.isError && reversed.structuredContent?.journey?.from === "Edinburgh" && card()?.route?.revision === 2, "reversed: a new route from Edinburgh, revision 2 of the same card");
    check(await settle(() => card()?.route?.rendered?.revision === 2 && card()?.route?.rendered?.ok === true), "the card redrew it");
    check(await view<number>("v.visual.revision") === formedRevision, "the terrain stayed formed through the change");
    await pause(800);
    await shot("reversed");
    // A waypoint and a marker on the route's terrain.
    const via = await call("plan_route", { via: ["Linlithgow"] });
    check(!via.isError && (via.structuredContent?.journey?.via as string[] | undefined)?.[0] === "Linlithgow", "a waypoint: via Linlithgow");
    const marked = await call("mark_map", { add: [{ place: "Stirling", color: "yellow" }] });
    check(!marked.isError && hub.snapshot().presentation?.kind === "interactive" && card()?.route?.revision === 3, "a marker added on the route's terrain keeps the route");
    // "Remove the route": the terrain stays.
    const cleared = await call("plan_route", { clear: true });
    check(!cleared.isError && hub.snapshot().presentation?.kind === "terrain" && !card(), "removing the route keeps the terrain");
    await pause(1_200);
    check(await view<number>("v.visual.revision") === formedRevision && (await drawn()).points === 0, "the body did not re-form; only the route left");
    // Scenario B and C: a hike and a walk, each on its own surroundings.
    for (const [moment, args] of [["hiking", { from: "Ambleside", to: "Grasmere", mode: "hiking" }], ["walking", { from: "Edinburgh Castle", to: "Arthur's Seat", mode: "walking" }]] as const) {
      const result = await call("plan_route", args);
      const j = result.structuredContent?.journey ?? {};
      check(!result.isError, `${moment}: ${result.isError ? result.content[0].text : `${j.from} → ${j.to}, ${j.distance_km} km, ${j.duration}, ↑${j.ascent_m} m ↓${j.descent_m} m, highest ${j.highest_m} m`}`);
      if (result.isError) continue;
      check(await formed() && await settle(async () => (await drawn()).points >= 10), `  its terrain forms with the route on it (${(await drawn()).points} points)`);
      await settle(() => card()?.state.tiles === "ok", 12_000);
      await pause(900);
      await shot(moment);
    }
    // Scenario E: no route — said plainly, nothing drawn, what is on show unchanged.
    const before = hub.snapshot().presentation?.id;
    const none = await call("plan_route", { from: "London", to: "New York", mode: "walking" });
    check(!!none.isError && /route-too-long|route-not-found/.test(none.content[0].text) && hub.snapshot().presentation?.id === before, `an impossible route is refused, nothing invented: ${none.content[0].text.slice(0, 90)}`);
    const unroutable = await call("plan_route", { from: "-80.0, 0.0", to: "-80.1, 0.2", mode: "walking" });
    check(!!unroutable.isError && /route-point-unroutable/.test(unroutable.content[0].text) && hub.snapshot().presentation?.id === before, "a place outside the routing data is refused, the view unchanged");
    // The user's ×: the card closes, the terrain stays; nothing is left behind in the frame.
    await page.locator("#workspace .ws-close").click();
    check(await settle(() => hub.snapshot().presentation?.kind === "terrain"), "closing the card keeps the terrain");
    await settle(async () => (await view<{ closed: number }>("v.cardHistory")).closed >= 1, 4_000);
    const left = await view<{ geometries: number; textures: number; urls: number; loops: number }[]>("v.cardHistory.leftovers");
    check(left.length > 0 && left.every(l => l.geometries + l.textures + l.urls + l.loops === 0), `nothing left behind (${JSON.stringify(left.at(-1))})`);
    await aion.call("clear_presentation", {});
    await until(page, s => s.phase === "sphere", 6_000);
    check(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally { await aion.close(); await page.close(); }
}
