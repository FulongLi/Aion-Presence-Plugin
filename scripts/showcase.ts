import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PresenceHub } from "../src/host/hub/hub";
import type { HubCommand } from "../src/host/hub/protocol";
import { VisualResolver } from "../src/host/resolver";
import { speechWav } from "./lib/fakeSpeech";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run showcase`: the v0.4 visual review. Each demo drives the built Presence page in a real Chrome (WebGPU)
 * through the same hub commands the MCP tools send, records a video of the stage and takes screenshots at its key
 * moments. Output: .e2e/showcase/<demo>.webm and <demo>-<moment>.png.
 *
 *   npm run showcase                       every demo
 *   npm run showcase -- heritage eyes      only these
 *   npm run showcase -- --headed           in a visible window (watch it live)
 *   npm run showcase -- --canvas           the Canvas 2D fallback renderer
 *   npm run showcase -- --list             the demo names
 *
 * It needs Chrome (CHROME_PATH overrides) and the network for portraits (cached in .e2e/cache after the first run).
 */
const OUT = join(REPO_ROOT, ".e2e", "showcase");
const CACHE = join(REPO_ROOT, ".e2e", "cache");
const chromePath = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const pagePath = join(PLUGIN_ROOT, "runtime", "presence.html");
const args = process.argv.slice(2);
const headed = args.includes("--headed"), canvas = args.includes("--canvas");
const VIEWPORT = { width: 960, height: 720 };

export interface DemoContext {
  hub: PresenceHub;
  page: Page;
  /** Sends a hub command (what an MCP tool or hook would send). */
  apply(command: HubCommand): void;
  wait(seconds: number): Promise<void>;
  shot(moment: string): Promise<void>;
  /** A real portrait from the public sources (cached), handed to the hub as media. */
  portrait(person: string): Promise<{ media: ReturnType<PresenceHub["addMedia"]>; alt: string; width?: number; height?: number }>;
  /** Evaluates in the page's view (?debug=1 exposes it as window.aionPresence). */
  view<T>(expression: string): Promise<T>;
  log(text: string): void;
}

interface Demo { name: string; title: string; seconds: number; speech?: boolean; run(ctx: DemoContext): Promise<void> }

const resolver = new VisualResolver({ env: {} });
async function cachedPortrait(person: string) {
  mkdirSync(CACHE, { recursive: true });
  const key = join(CACHE, `${person.toLowerCase().replace(/[^a-z]+/g, "-")}.json`);
  if (existsSync(key)) {
    const saved = JSON.parse(readFileSync(key, "utf8")) as { data: string; mime: string; label: string; width?: number; height?: number };
    return { ...saved, bytes: Buffer.from(saved.data, "base64") };
  }
  const found = await resolver.portrait(person);
  const bytes = Buffer.from(found.bytes);
  writeFileSync(key, JSON.stringify({ data: bytes.toString("base64"), mime: found.mime, label: found.label, width: found.width, height: found.height }));
  return { bytes, mime: found.mime, label: found.label, width: found.width, height: found.height };
}

const DEMOS: Demo[] = [
  {
    name: "heritage", title: "Heritage portraits: Tesla, Einstein, Newton, da Vinci", seconds: 44,
    async run(ctx) {
      await ctx.wait(2);
      for (const person of ["Nikola Tesla", "Albert Einstein", "Isaac Newton", "Leonardo da Vinci"]) {
        const found = await ctx.portrait(person);
        ctx.log(person);
        ctx.apply({ type: "present", content: { kind: "image", media: found.media, fit: "portrait", origin: "lookup", alt: person, style: "heritage", width: found.width, height: found.height }, presentation: "body", hold: 5 });
        await ctx.wait(4.6);
        await ctx.shot(person.split(" ").pop()!.toLowerCase());
        await ctx.wait(4.4);
      }
      ctx.apply({ type: "clear" });
      await ctx.wait(2.5);
      await ctx.shot("returned");
    },
  },
  {
    name: "heritage-hybrid", title: "Heritage Tesla with the photograph card (hybrid)", seconds: 12,
    async run(ctx) {
      await ctx.wait(1.5);
      const found = await ctx.portrait("Nikola Tesla");
      ctx.apply({ type: "present", content: { kind: "image", media: found.media, fit: "portrait", origin: "lookup", alt: "Nikola Tesla", style: "heritage", width: found.width, height: found.height }, presentation: "hybrid" });
      await ctx.wait(5);
      await ctx.shot("hybrid");
      ctx.apply({ type: "clear" });
      await ctx.wait(3);
      await ctx.shot("returned");
    },
  },
  {
    name: "figure-idle", title: "Figure 2.0: clean idle (sphere → figure, natural stance)", seconds: 24,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.shot("sphere");
      ctx.apply({ type: "body", body: "figure" });
      await ctx.wait(1.1);
      await ctx.shot("morphing");
      await ctx.wait(3);
      await ctx.shot("figure");
      await ctx.wait(9);
      await ctx.shot("weight-shift");
      await ctx.wait(8);
    },
  },
  {
    name: "eyes", title: "Aion Eyes: expressions (neutral, attentive, thinking, curious, happy, surprised, confused, sleepy)", seconds: 40,
    async run(ctx) {
      ctx.apply({ type: "body", body: "eyes" });
      await ctx.wait(3.5);
      await ctx.shot("neutral");
      for (const expression of ["attentive", "thinking", "curious", "happy", "surprised", "confused", "sleepy", "concerned"] as const) {
        ctx.log(expression);
        ctx.apply({ type: "express", expression, seconds: 3.4 });
        await ctx.wait(1.6);
        await ctx.shot(expression);
        await ctx.wait(2.2);
      }
      await ctx.wait(2);
    },
  },
  {
    name: "transitions", title: "Sphere → Eyes → Figure → Sphere", seconds: 20,
    async run(ctx) {
      await ctx.wait(2);
      await ctx.shot("sphere");
      ctx.apply({ type: "body", body: "eyes" });
      await ctx.wait(1.1); await ctx.shot("sphere-to-eyes");
      await ctx.wait(3); await ctx.shot("eyes");
      ctx.apply({ type: "body", body: "figure" });
      await ctx.wait(1.1); await ctx.shot("eyes-to-figure");
      await ctx.wait(3); await ctx.shot("figure");
      ctx.apply({ type: "body", body: "sphere" });
      await ctx.wait(1.1); await ctx.shot("figure-to-sphere");
      await ctx.wait(3); await ctx.shot("sphere-again");
    },
  },
  {
    name: "figure-listening", title: "Figure 2.0: listening to a voice, then responding with gestures", seconds: 30, speech: true,
    async run(ctx) {
      ctx.apply({ type: "body", body: "figure" });
      // The fake microphone plays a speech-like signal from 3 s in (phrases with short pauses).
      for (let i = 0; i < 6; i++) {
        await ctx.wait(2);
        const live = await ctx.view<{ state: string; amp: number }>("({ state: v.aion.currentState, amp: v.presence.signal.userAmplitude })");
        ctx.log(`${live.state} · loudness ${live.amp.toFixed(2)}`);
        if (i === 3 || i === 5) await ctx.shot(`listening-${i}`);
      }
      ctx.apply({ type: "activity", state: "responding" });
      ctx.log("responding");
      for (let i = 0; i < 4; i++) { await ctx.wait(2.6); await ctx.shot(`responding-${i}`); }
      ctx.apply({ type: "activity", state: "complete" });
      await ctx.wait(3);
    },
  },
  {
    name: "figure-explain", title: "Figure 2.0 explains a² + b² = c² (looks, tilts, points at c², explains, relaxes)", seconds: 14,
    async run(ctx) {
      ctx.apply({ type: "body", body: "figure" });
      await ctx.wait(3.5);
      ctx.apply({ type: "present", content: { kind: "text", text: "a² + b² = c²", emphasis: "c²" }, presentation: "card", hold: 14 });
      for (const [at, moment] of [[1.9, "look"], [1.1, "consider"], [1.1, "point"], [1.4, "emphasis"], [1.6, "explain"], [1.8, "relaxed"]] as const) {
        await ctx.wait(at); await ctx.shot(moment);
      }
      await ctx.wait(2);
    },
  },
  {
    name: "figure-gestures", title: "Figure 2.0 gesture library: wave, nod, point, shrug, surprise, jump, step, turn, look around, think", seconds: 42,
    async run(ctx) {
      ctx.apply({ type: "body", body: "figure" });
      await ctx.wait(3.5);
      const moments: Record<string, number> = { wave: 1.0, nod: 0.3, point: 1.4, shrug: 0.5, surprise: 0.35, jump: 0.7, step: 1.3, turn: 1.2, "look-around": 1.0, think: 1.4 };
      for (const gesture of ["wave", "nod", "point", "shrug", "surprise", "jump", "step", "turn", "look-around", "think"] as const) {
        ctx.log(gesture);
        ctx.apply({ type: "express", gesture });
        await ctx.wait(moments[gesture]); await ctx.shot(gesture);
        await ctx.wait(3.6 - moments[gesture]);
      }
    },
  },
];

/** Demos register here as they are built (later phases append to DEMOS). */
export const demos = DEMOS;

async function runDemo(browser: Browser, demo: Demo) {
  const home = mkdtempSync(join(tmpdir(), "aion-showcase-"));
  const hub = new PresenceHub({ home, port: 0, page: () => readFileSync(pagePath, "utf8") });
  await hub.start();
  hub.apply({ type: "open", greet: false });
  const videoDir = mkdtempSync(join(tmpdir(), "aion-video-"));
  const context: BrowserContext = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT } });
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  const started = Date.now();
  const log = (text: string) => console.log(`    ${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  ${text}`);
  await page.goto(`${hub.surfaceUrl}&debug=1${demo.speech ? "" : "&mic=0"}${canvas ? "&renderer=canvas" : ""}`);
  await page.addStyleTag({ content: "#debug { display: none !important; }" });
  const ctx: DemoContext = {
    hub, page, log,
    apply: command => { hub.apply(command); },
    wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
    shot: async moment => { await page.screenshot({ path: join(OUT, `${demo.name}-${moment}.png`) }); log(`📷 ${moment}`); },
    portrait: async person => {
      const found = await cachedPortrait(person);
      return { media: hub.addMedia(found.bytes, found.mime), alt: found.label, width: found.width, height: found.height };
    },
    view: expression => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`),
  };
  console.log(`  ${demo.name}: ${demo.title}`);
  try { await demo.run(ctx); } finally {
    const video = page.video();
    await context.close();
    const path = await video?.path();
    if (path && existsSync(path)) renameSync(path, join(OUT, `${demo.name}${canvas ? "-canvas" : ""}.webm`));
    rmSync(videoDir, { recursive: true, force: true });
    await hub.stop();
  }
}

if (process.argv[1]?.endsWith("showcase.ts")) {
  if (args.includes("--list")) { for (const demo of DEMOS) console.log(`${demo.name.padEnd(18)} ${demo.title}`); process.exit(0); }
  if (!chromePath) { console.log("showcase: no Chrome found (set CHROME_PATH)"); process.exit(1); }
  if (!existsSync(pagePath)) { console.error("showcase: run npm run build first"); process.exit(1); }
  mkdirSync(OUT, { recursive: true });
  const chosen = args.filter(arg => !arg.startsWith("--"));
  const selected = chosen.length ? DEMOS.filter(demo => chosen.includes(demo.name)) : DEMOS;
  if (!selected.length) { console.error(`showcase: no demo named ${chosen.join(", ")} (see --list)`); process.exit(1); }
  const speech = join(mkdtempSync(join(tmpdir(), "aion-speech-")), "speech.wav");
  speechWav(speech, { lead: 3, phrases: 6, tail: 4 });
  const flags = ["--enable-unsafe-webgpu", "--use-angle=metal", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${speech}`, "--autoplay-policy=no-user-gesture-required"];
  const browser = await chromium.launch({ executablePath: chromePath, headless: !headed, args: flags });
  for (const demo of selected) await runDemo(browser, demo);
  await browser.close();
  console.log(`\nshowcase: ${selected.length} demo(s) in ${OUT}`);
}
