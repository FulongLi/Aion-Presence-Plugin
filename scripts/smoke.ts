import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium, type Page } from "playwright-core";
import { connectAion, MCP_APPS_CAPABILITIES } from "../tests/helpers";
import { PresenceHub } from "../src/host/hub/hub";
import type { PresentationContent } from "../src/core/presentation";
import { VisualResolver } from "../src/host/resolver";
import { visualForms } from "../src/visual/forms";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run smoke`: the built Presence surface in a real browser (the installed Chrome, headless). It starts a
 * hub, opens the companion page with both renderers, drives the real state path (activity, body, a visual form,
 * a result, text) and checks that frames are drawn and every change arrives. It then embeds the same page in a
 * minimal MCP Apps host (the official AppBridge) wired to the real Aion MCP server, and checks the embedded
 * mode: the standard handshake, state through presence_sync, and fullscreen through the host's display modes.
 * Screenshots land in .e2e/smoke/.
 * Needs a local Chrome (CHROME_PATH overrides); skips with a message when there is none.
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

const hub = new PresenceHub({ home: mkdtempSync(join(tmpdir(), "aion-smoke-")), port: 0, page: () => readFileSync(pagePath, "utf8") });
await hub.start();
hub.apply({ type: "open" });
// A fake microphone device (a test tone), so the local listening path runs; permission is granted per context.
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--use-fake-device-for-media-stream"] });
const offline = process.argv.includes("--offline");
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? "✓" : "✗"} ${what}`); if (!ok) failures.push(what); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const debug = async (page: Page) => (await page.locator("#debug").textContent()) ?? "";

/** Bright pixels on the canvas: is a body actually being drawn? */
const litPixels = async (page: Page) => {
  const shot = await page.screenshot({ type: "png" });
  return page.evaluate(async (data: string) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 240) lit++;
    return lit;
  }, shot.toString("base64"));
};

try {
  for (const renderer of ["auto", "canvas"] as const) {
    console.log(`renderer: ${renderer}`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.surfaceUrl}&debug=1${renderer === "canvas" ? "&renderer=canvas" : ""}`);
    await pause(3_000);
    const info = await debug(page);
    console.log(`  ${info.split("\n")[1]}`);
    check(/surface companion · live/.test(info), "the companion surface is live");
    check(renderer === "canvas" ? /renderer canvas/.test(info) : /renderer (webgpu|canvas)/.test(info), "a renderer started");
    const frames = Number(/frame (\d+)/.exec(info)?.[1] ?? 0);
    await pause(1_000);
    check(Number(/frame (\d+)/.exec(await debug(page))?.[1] ?? 0) > frames + 20, "frames are being drawn");
    check(await litPixels(page) > 200, "the sphere is visible");
    await page.screenshot({ path: join(OUT, `${renderer}-1-sphere.png`) });

    hub.apply({ type: "activity", state: "testing", label: "npm test" });
    await pause(800);
    check(/activity testing/.test(await debug(page)), "activity arrives");
    check((await page.locator("#status").textContent())?.includes("Testing · npm test") ?? false, "the status line names it");

    hub.apply({ type: "body", body: "figure" });
    await pause(3_200);
    check(/body figure/.test(await debug(page)), "the figure body forms");
    await page.screenshot({ path: join(OUT, `${renderer}-2-figure.png`) });

    hub.apply({ type: "present", content: { kind: "form", form: "astronomy.orion", label: visualForms.label("astronomy.orion") }, hold: 6 });
    await pause(3_200);
    check(/visual holding/.test(await debug(page)), "figure → Orion: the visual forms");
    await page.screenshot({ path: join(OUT, `${renderer}-3-orion.png`) });
    // The hold is time formed (SCF), then the body returns: wait for it rather than for a fixed time.
    let after = "";
    for (let waited = 0; waited < 12_000 && !(/visual sphere/.test(after) && /body figure/.test(after)); waited += 250) { await pause(250); after = await debug(page); }
    check(/visual sphere/.test(after) && /body figure/.test(after), "Orion → figure: back to the persistent body");

    hub.apply({ type: "present", content: { kind: "result", title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed", "Build successful"] }, hold: 8 });
    await pause(3_000);
    check((await page.locator("#panel").textContent())?.includes("48 / 48 tests passed") ?? false, "the result panel shows the summary");
    check(/state presenting/.test(await debug(page)), "the body presents beside it");
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
  await visuals();
  await listening();
  await embedded();
} finally {
  await browser.close();
  await hub.stop();
}

/**
 * The visuals restored from SCF, on the real surface: a portrait and a terrain looked up on public sources (the
 * same resolver the MCP server uses; --offline skips them), the Tao and celestial forms, clock, number, emoji
 * and a result card. Every visual returns to the persistent body: figure → Tesla → figure, figure → terrain →
 * figure, figure → Orion → figure.
 */
async function visuals() {
  console.log("visuals (SCF parity)");
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${hub.surfaceUrl}&debug=1&mic=0`);
  await pause(3_000);
  hub.apply({ type: "body", body: "figure" });
  await pause(3_000);
  const show = async (name: string, content: PresentationContent, returns = true) => {
    hub.apply({ type: "present", content, hold: 4 });
    let formed = false;
    for (let t = 0; t < 8_000 && !formed; t += 250) { await pause(250); formed = /visual holding/.test(await debug(page)); }
    check(formed, `${name} forms`);
    await page.screenshot({ path: join(OUT, `visual-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`) });
    if (!returns) return;
    let back = false;
    for (let t = 0; t < 10_000 && !back; t += 250) { await pause(250); const info = await debug(page); back = /visual sphere/.test(info) && /body figure/.test(info); }
    check(back, `${name} → figure: back to the persistent body`);
  };
  if (!offline) {
    const resolver = new VisualResolver({ env: {} });
    try {
      const tesla = await resolver.portrait("Nikola Tesla");
      await show("Nikola Tesla portrait", { kind: "image", media: hub.addMedia(Buffer.from(tesla.bytes)), mode: "particles", fit: "portrait", alt: "Nikola Tesla", credit: "Wikipedia" });
    } catch (error) { check(false, `Nikola Tesla portrait resolves (${(error as Error).message})`); }
    try {
      const uk = await resolver.terrain("United Kingdom");
      await show("United Kingdom terrain", { kind: "terrain", media: hub.addMedia(Buffer.from(uk.bytes)), style: "terrain", label: "United Kingdom" });
    } catch (error) { check(false, `United Kingdom terrain resolves (${(error as Error).message})`); }
  } else console.log("  ! --offline: the portrait and terrain lookups were skipped");
  await show("Orion", { kind: "form", form: "astronomy.orion", label: visualForms.label("astronomy.orion") });
  await show("yin-yang", { kind: "form", form: "tao.yin-yang", label: visualForms.label("tao.yin-yang") }, false);
  await show("clock", { kind: "clock", time: "09:05" }, false);
  await show("number", { kind: "number", value: "42%" }, false);
  await show("emoji", { kind: "emoji", emoji: "🚀" }, false);
  hub.apply({ type: "present", content: { kind: "result", title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed"] }, hold: 4 });
  await pause(2_500);
  check((await page.locator("#panel").textContent())?.includes("48 / 48 tests passed") ?? false, "result card");
  await page.screenshot({ path: join(OUT, "visual-result.png") });
  hub.apply({ type: "clear" });
  hub.apply({ type: "activity", state: "responding" });
  await pause(1_500);
  check(/state responding/.test(await debug(page)), "responding: the body answers");
  await page.screenshot({ path: join(OUT, "visual-responding.png") });
  hub.apply({ type: "activity", state: "idle" });
  hub.apply({ type: "body", body: "sphere" });
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await page.close();
}

/** Local listening: with a (fake) microphone the body hears it; refused, Aion follows the host's states. */
async function listening() {
  console.log("listening (local microphone)");
  const granted = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await granted.grantPermissions(["microphone"]);
  const page = await granted.newPage();
  await page.goto(`${hub.surfaceUrl}&debug=1`);
  let ready = false;
  for (let t = 0; t < 6_000 && !ready; t += 250) { await pause(250); ready = /mic ready/.test(await debug(page)); }
  check(ready, "the microphone is analysed locally once Presence opens");
  await granted.close();
  const refused = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const denied = await refused.newPage();
  const errors: string[] = [];
  denied.on("pageerror", error => errors.push(error.message));
  await denied.goto(`${hub.surfaceUrl}&debug=1`);
  await pause(2_500);
  const info = await debug(denied);
  check(/mic (denied|unavailable)/.test(info) && /surface companion · live/.test(info), "refused: Presence keeps working without it");
  hub.apply({ type: "activity", state: "testing" });
  await pause(800);
  check(/activity testing → testing/.test(await debug(denied)), "and follows the host's states");
  hub.apply({ type: "activity", state: "idle" });
  check(errors.length === 0, "no page errors");
  await refused.close();
}

/** The same surface inside an MCP Apps host. */
async function embedded() {
  console.log("embedded: an MCP Apps host");
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  const host = await build({ entryPoints: [join(REPO_ROOT, "scripts", "smoke-host", "host.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "chrome120", logLevel: "warning" });
  const server = createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><body style="margin:0;background:#000"><script type="module">${host.outputFiles[0].text}</script></body>`); return; }
    if (req.url === "/presence.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(readFileSync(pagePath, "utf8")); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.exposeFunction("hostCallTool", (params: { name: string; arguments?: Record<string, unknown> }) => aion.client.callTool(params));
    const opened = await aion.call("open_presence", { display: "fullscreen", body: "figure" }) as { structuredContent: { surface: { mode: string }; window_opened: boolean } };
    check(opened.structuredContent.surface.mode === "embedded" && !opened.structuredContent.window_opened, "open_presence chooses embedded mode and opens no window");
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await pause(3_500);
    const log = await page.evaluate(() => window.hostLog);
    check(log.includes("initialized"), "the view completes the MCP Apps handshake");
    check(log.includes("display:fullscreen"), "fullscreen is requested through the host's display mode");
    const frame = page.frames().find(item => item.url().endsWith("/presence.html"))!;
    await aion.call("show_result", { title: "Done", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed"] });
    await pause(3_000);
    check((await frame.locator("#panel").textContent())?.includes("48 / 48 tests passed") ?? false, "a tool call reaches the embedded view");
    check(await frame.evaluate(() => document.querySelector("#stage canvas") !== null), "the embedded body renders");
    await page.screenshot({ path: join(OUT, "embedded-result.png") });
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  } finally {
    await page.close();
    server.close();
    await aion.close();
  }
}
writeFileSync(join(OUT, "result.txt"), failures.length ? failures.join("\n") : "ok");
console.log(failures.length ? `\n${failures.length} smoke check(s) failed` : `\n✓ the Presence surface renders and follows the presence state (screenshots in ${OUT})`);
process.exit(failures.length ? 1 : 0);
