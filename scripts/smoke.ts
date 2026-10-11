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
 *   embedded      the same page in a minimal MCP Apps host wired to the real Aion MCP server
 *   v0.4          Aion Eyes and express, the figure explaining an emphasised term, a heritage portrait, a 3D pyramid
 *                 that turns, is dragged and re-oriented, then returns — in both renderers
 *   v0.4.1        through the real MCP tools: a heritage portrait by default; a map whose markers appear in their colours
 *                 at their places and change in place; a pin on terrain; the body turning blue, purple and back
 *
 * Screenshots land in .e2e/smoke/. Needs a local Chrome (CHROME_PATH overrides); skips with a message when there
 * is none. `-- --offline` skips the public portrait and terrain lookups.
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
const hub = new PresenceHub({ home, port: 0, page: () => readFileSync(pagePath, "utf8") });
await hub.start();
hub.apply({ type: "open" });
const GPU = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal"];
const launch = (extra: string[] = []) => chromium.launch({ executablePath: chromePath, headless: true, args: [...GPU, ...extra] });
// The default fake device (a test tone) for permission paths; the speech-like signal gets its own browser below.
const browser = await launch(["--use-fake-device-for-media-stream"]);
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

try {
  await renderers();
  await visuals();
  for (const renderer of ["auto", "canvas"] as const) await v4(renderer);
  for (const renderer of ["auto", "canvas"] as const) await v41(renderer);
  await listening();
  await responding();
  await immersive();
  await embedded();
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
        }
        check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
      } finally { await page.close(); }
    }
  } finally {
    server.close();
    await aion.close();
  }
}
writeFileSync(join(OUT, "result.txt"), failures.length ? failures.join("\n") : "ok");
console.log(failures.length ? `\n${failures.length} smoke check(s) failed` : `\n✓ the Presence surface renders and follows the presence state (screenshots in ${OUT})`);
process.exit(failures.length ? 1 : 0);
