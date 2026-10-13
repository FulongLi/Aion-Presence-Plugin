import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PresenceHub } from "../src/host/hub/hub";
import type { HubCommand } from "../src/host/hub/protocol";
import { VisualResolver } from "../src/host/resolver";
import { SCENE_PRESETS } from "../src/visual/scene3d/presets";
import { speechWav } from "./lib/fakeSpeech";
import { connectAion } from "../tests/helpers";
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
  /**
   * Films the stage for `seconds` as fast as the browser can take screenshots: frames/<demo>-<clip>/NNNN.jpg plus
   * timing.json (milliseconds per frame), which scripts/media/gif.py turns into an animated GIF at the real pace.
   */
  film(clip: string, seconds: number, area?: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Calls an Aion MCP tool by name, exactly as Codex does (the real server, the real resolver, this hub). Returns its text. */
  tool(name: string, args?: Record<string, unknown>): Promise<string>;
  log(text: string): void;
  /** What the stand-in for the macOS audio bridge plays when a capture starts (scripts/lib/fakeBridge.ts). */
  bridgeSignal(signal: string): void;
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
    name: "eyes", title: "Aion Eyes: expressions (neutral, attentive, thinking, curious, happy, surprised, confused, sleepy, concerned)", seconds: 43,
    async run(ctx) {
      ctx.apply({ type: "body", body: "eyes" });
      await ctx.wait(3.5);
      await ctx.shot("neutral");
      for (const expression of ["attentive", "thinking", "curious", "happy", "surprised", "confused", "sleepy", "concerned"] as const) {
        ctx.log(expression);
        // Sleepy closes gradually: its picture is the soft closed curves, a few seconds in.
        const at = expression === "sleepy" ? 4.2 : 1.6;
        ctx.apply({ type: "express", expression, seconds: at + 1.8 });
        await ctx.wait(at);
        await ctx.shot(expression);
        await ctx.wait(2.2);
      }
      await ctx.wait(2);
    },
  },
  {
    name: "eyes-motion", title: "Aion Eyes in motion: blink, happy hop, surprise pop, confused wobble, thinking glance, falling asleep", seconds: 34,
    async run(ctx) {
      const area = { x: 200, y: 170, width: 560, height: 340 };
      ctx.apply({ type: "body", body: "eyes" });
      await ctx.wait(4);
      ctx.log("blink");
      await ctx.view("v.aion.eyes.blink()");
      await ctx.film("blink", 0.6, area);
      await ctx.wait(1);
      for (const [expression, seconds] of [["happy", 1.4], ["surprised", 1.2], ["confused", 1.4], ["thinking", 1.6], ["curious", 1.3]] as const) {
        ctx.log(expression);
        ctx.apply({ type: "express", expression, seconds: seconds + 0.6 });
        await ctx.film(expression, seconds, area);
        await ctx.wait(1.6);
      }
      ctx.log("sleepy");
      ctx.apply({ type: "express", expression: "sleepy", seconds: 7 });
      await ctx.film("sleepy", 5, area);
      await ctx.wait(3);
      ctx.log("wakes");
      await ctx.film("wake", 1.4, area);
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
  {
    name: "pyramid", title: "3D pyramid: forms from the sphere, turns, dragged by the user, zoomed, returns", seconds: 30,
    async run(ctx) {
      await ctx.wait(1.5);
      ctx.apply({ type: "present", content: { kind: "scene", scene: SCENE_PRESETS.pyramid, label: "Egyptian pyramid", preset: "pyramid" }, hold: 40 });
      await ctx.wait(1); await ctx.shot("forming");
      await ctx.wait(2.5); await ctx.shot("formed");
      await ctx.wait(4); await ctx.shot("turning");
      // The user drags it: a slow sweep to the left and up (a real mouse drag on the stage).
      ctx.log("drag");
      await ctx.page.mouse.move(480, 360); await ctx.page.mouse.down();
      for (let i = 1; i <= 30; i++) { await ctx.page.mouse.move(480 - i * 6, 360 + i * 3); await ctx.wait(0.03); }
      await ctx.page.mouse.up();
      await ctx.wait(0.6); await ctx.shot("dragged");
      ctx.log("zoom");
      for (let i = 0; i < 4; i++) { await ctx.page.mouse.wheel(0, -120); await ctx.wait(0.1); }
      await ctx.wait(1); await ctx.shot("zoomed");
      ctx.log("set_scene_view: from above");
      ctx.apply({ type: "view", reset: true }); await ctx.wait(1.5);
      ctx.apply({ type: "view", rotate: "up", degrees: 35 }); await ctx.wait(1.6); await ctx.shot("from-above");
      ctx.apply({ type: "clear" }); ctx.log("return");
      await ctx.wait(0.7); await ctx.shot("returning");
      await ctx.wait(2.5); await ctx.shot("sphere");
    },
  },
  {
    name: "saturn", title: "3D Saturn: planet and rings, turning", seconds: 16,
    async run(ctx) {
      await ctx.wait(1.5);
      ctx.apply({ type: "present", content: { kind: "scene", scene: SCENE_PRESETS.saturn, label: "Saturn", preset: "saturn" }, hold: 30 });
      await ctx.wait(3.5); await ctx.shot("formed");
      await ctx.wait(5); await ctx.shot("turning");
      ctx.apply({ type: "view", rotate: "up", degrees: 30 }); await ctx.wait(2); await ctx.shot("from-above");
      await ctx.wait(2);
    },
  },
  {
    name: "dna", title: "3D DNA double helix: two strands, base-pair rungs, turning", seconds: 16,
    async run(ctx) {
      await ctx.wait(1.5);
      ctx.apply({ type: "present", content: { kind: "scene", scene: SCENE_PRESETS.dna, label: "DNA double helix", preset: "dna" }, hold: 30 });
      await ctx.wait(3.5); await ctx.shot("formed");
      await ctx.wait(4); await ctx.shot("turning");
      await ctx.wait(4); await ctx.shot("turning-2");
      await ctx.wait(2);
    },
  },
  {
    name: "acceptance", title: "The v0.4 acceptance sequence, one continuous presence", seconds: 80, speech: true,
    async run(ctx) {
      const state = () => ctx.view<string>("v.aion.currentState");
      ctx.log("sphere"); await ctx.wait(2); await ctx.shot("01-sphere");
      ctx.log("→ eyes"); ctx.apply({ type: "body", body: "eyes" }); await ctx.wait(3);
      ctx.log(`eyes, the user speaks: ${await state()}`); await ctx.wait(2.5); await ctx.shot("02-eyes-listening");
      await ctx.wait(4.5);
      ctx.log("→ figure"); ctx.apply({ type: "body", body: "figure" }); await ctx.wait(3.5); await ctx.shot("03-figure");
      ctx.log("figure answers"); ctx.apply({ type: "activity", state: "responding" }); await ctx.wait(3); await ctx.shot("04-figure-responding");
      await ctx.wait(3); ctx.apply({ type: "activity", state: "complete" }); await ctx.wait(1.5);
      ctx.log("figure explains a² + b² = c²");
      ctx.apply({ type: "present", content: { kind: "text", text: "a² + b² = c²", emphasis: "c²" }, presentation: "card", hold: 9 });
      await ctx.wait(4.2); await ctx.shot("05-figure-points"); await ctx.wait(5.5);
      ctx.apply({ type: "clear" }); await ctx.wait(1);
      ctx.log("→ sphere"); ctx.apply({ type: "body", body: "sphere" }); await ctx.wait(3.2); await ctx.shot("06-sphere");
      const tesla = await ctx.portrait("Nikola Tesla");
      ctx.log("heritage Tesla");
      ctx.apply({ type: "present", content: { kind: "image", media: tesla.media, fit: "portrait", origin: "lookup", alt: "Nikola Tesla", style: "heritage", width: tesla.width, height: tesla.height }, presentation: "body", hold: 6 });
      await ctx.wait(4.5); await ctx.shot("07-heritage-tesla"); await ctx.wait(5.5);
      await ctx.shot("08-sphere-again");
      ctx.log("3D pyramid");
      ctx.apply({ type: "present", content: { kind: "scene", scene: SCENE_PRESETS.pyramid, label: "Egyptian pyramid", preset: "pyramid" }, hold: 30 });
      await ctx.wait(5); await ctx.shot("09-pyramid");
      ctx.log("the user turns it");
      await ctx.page.mouse.move(480, 360); await ctx.page.mouse.down();
      for (let i = 1; i <= 30; i++) { await ctx.page.mouse.move(480 + i * 7, 360 - i * 2); await ctx.wait(0.03); }
      await ctx.page.mouse.up(); await ctx.wait(1); await ctx.shot("10-pyramid-turned");
      await ctx.wait(3);
      ctx.log("return to the sphere"); ctx.apply({ type: "clear" }); await ctx.wait(3); await ctx.shot("11-sphere-end");
      const frames = await ctx.view<number>("v.runtime.quality().frames");
      ctx.log(`responsive throughout: ${frames} frames drawn`);
    },
  },
];

DEMOS.push(
  {
    name: "bodies-motion", title: "v0.4.1: sphere → eyes → figure → sphere, filmed (one particle body re-forming)", seconds: 16,
    async run(ctx) {
      const area = { x: 180, y: 90, width: 600, height: 540 };
      await ctx.wait(1.5);
      ctx.apply({ type: "body", body: "eyes" }); await ctx.film("1-sphere-to-eyes", 3, area);
      ctx.apply({ type: "body", body: "figure" }); await ctx.film("2-eyes-to-figure", 3, area);
      ctx.apply({ type: "body", body: "sphere" }); await ctx.film("3-figure-to-sphere", 3, area);
    },
  },
  {
    name: "portrait-default", title: "v0.4.1 Test A: \"Show me Nikola Tesla\" — a heritage portrait by default; then the classic one on request", seconds: 30,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.tool("show_portrait", { person: "Nikola Tesla" });
      await ctx.wait(5.5); await ctx.shot("heritage-default");
      await ctx.tool("show_portrait", { person: "Nikola Tesla", style: "classic" });
      await ctx.wait(7.5); await ctx.shot("classic-on-request");
      await ctx.tool("show_portrait", { person: "Albert Einstein" });
      await ctx.wait(5.5); await ctx.shot("einstein");
      await ctx.tool("show_portrait", { person: "Isaac Newton" });
      await ctx.wait(5.5); await ctx.shot("newton");
    },
  },
  {
    name: "map-usa", title: "v0.4.1 Test C: the United States; mark Los Angeles in red; add New York in yellow; recolour; remove", seconds: 40,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.tool("show_map", { region: "United States" });
      await ctx.wait(4); await ctx.shot("usa");
      await ctx.tool("mark_map", { add: [{ place: "Los Angeles", color: "red" }] });
      await ctx.film("los-angeles", 1.6);
      await ctx.wait(0.5); await ctx.shot("los-angeles-red");
      await ctx.tool("mark_map", { add: [{ place: "New York", color: "yellow" }] });
      await ctx.wait(2); await ctx.shot("new-york-yellow");
      await ctx.tool("mark_map", { add: [{ place: "San Francisco", highlight: true }] });
      await ctx.wait(2.5); await ctx.shot("san-francisco");
      await ctx.tool("mark_map", { change: [{ place: "Los Angeles", color: "blue" }] });
      await ctx.wait(2); await ctx.shot("los-angeles-blue");
      await ctx.tool("mark_map", { remove: ["New York"] });
      await ctx.wait(2); await ctx.shot("new-york-removed");
      const markers = await ctx.view<{ label: string; x: number; y: number }[]>("[...v.markerLayer.positions.values()]");
      ctx.log(`markers on screen: ${JSON.stringify(markers)}`);
      await ctx.tool("show_map", { region: "United States", markers: [{ place: "Los Angeles", color: "red" }] }, );
      await ctx.wait(1.5);
      await ctx.tool("show_map", { region: "United States", markers: [{ place: "Los Angeles", color: "red" }] , presentation: "hybrid" });
      await ctx.wait(5); await ctx.shot("hybrid-card");
    },
  },
  {
    name: "terrain-scotland", title: "v0.4.1 Test D: Scotland's terrain, then mark Glasgow in red", seconds: 22,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.tool("show_terrain", { region: "Scotland" });
      await ctx.wait(5); await ctx.shot("scotland");
      await ctx.tool("mark_map", { add: [{ place: "Glasgow", color: "red" }] });
      await ctx.wait(2.5); await ctx.shot("glasgow");
      await ctx.tool("mark_map", { add: [{ place: "Edinburgh", color: "yellow" }, { place: "Ben Nevis", color: "white" }] });
      await ctx.wait(2.5); await ctx.shot("edinburgh-ben-nevis");
    },
  },
  {
    name: "geo-coverage", title: "v0.4.1 geography: continents, large and high-latitude countries, the date line, the poles", seconds: 120,
    async run(ctx) {
      for (const [tool, region] of [["show_map", "Africa"], ["show_map", "Europe"], ["show_map", "Japan"], ["show_map", "中国"], ["show_map", "Russia"],
        ["show_map", "Fiji"], ["show_map", "Antarctica"], ["show_map", "World"], ["show_map", "Svalbard"], ["show_map", "California"],
        ["show_terrain", "Africa"], ["show_terrain", "中国"], ["show_terrain", "Japan"], ["show_terrain", "Iceland"]] as const) {
        await ctx.tool(tool, { region });
        await ctx.wait(4.2); await ctx.shot(`${tool === "show_map" ? "map" : "terrain"}-${region.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "") || "china"}`);
        await ctx.wait(0.6);
      }
    },
  },
  {
    name: "colors", title: "v0.4.1 Test E: blue, purple, back to Aion Silver — on the sphere, the eyes, the figure and a map", seconds: 40,
    async run(ctx) {
      await ctx.wait(1.5); await ctx.shot("silver-sphere");
      await ctx.tool("set_colors", { base: "blue" });
      await ctx.film("to-blue", 1.4);
      await ctx.shot("blue-sphere");
      await ctx.tool("set_body_form", { body: "eyes" });
      await ctx.wait(3.5); await ctx.shot("blue-eyes");
      await ctx.tool("set_colors", { base: "紫色" });
      await ctx.wait(1.6); await ctx.shot("purple-eyes");
      await ctx.tool("set_body_form", { body: "figure" });
      await ctx.wait(3.5); await ctx.shot("purple-figure");
      await ctx.tool("set_colors", { base: "warm gold", accent: "#00BFFF" });
      await ctx.tool("show_map", { region: "Scotland", markers: [{ place: "Glasgow" }] });
      await ctx.wait(4.5); await ctx.shot("gold-map-accent");
      await ctx.tool("clear_presentation");
      await ctx.tool("set_colors", { reset: "all" });
      await ctx.film("to-silver", 1.4);
      await ctx.shot("silver-figure");
    },
  },
);

DEMOS.push(
  {
    name: "music-staff", title: "v0.4.2 Demo A: lesson 1 (the staff: lines, then spaces), lesson 2 (the treble clef, formed by the body beside the notation)", seconds: 30,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.tool("music_lesson", { lesson: 1 });
      await ctx.wait(3); await ctx.shot("lines");
      await ctx.tool("music_lesson", { step: "next" });
      await ctx.wait(2.5); await ctx.shot("spaces");
      await ctx.tool("music_lesson", { lesson: 2 });
      await ctx.film("treble-clef", 6);
      await ctx.shot("treble-clef");
      await ctx.tool("music_lesson", { language: "zh" });
      await ctx.wait(2.5); await ctx.shot("chinese");
      await ctx.tool("clear_presentation");
      await ctx.wait(2.5);
    },
  },
  {
    name: "music-middle-c", title: "v0.4.2 Demo B: middle C on its ledger line, played and lit while it sounds", seconds: 14,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.tool("show_music", { title: "Middle C", notes: [{ pitch: "C4", duration: "whole", label: "middle C" }], highlight: [{ note: 0 }] });
      await ctx.wait(2.5); await ctx.shot("shown");
      await ctx.tool("play_music", { tempo: 70 });
      await ctx.film("playing", 4);
      await ctx.wait(2);
    },
  },
  {
    name: "music-scale", title: "v0.4.2 Demo C: the C major scale — each note lights as it is heard; the sphere moves with the music", seconds: 18,
    async run(ctx) {
      await ctx.wait(1.5);
      await ctx.tool("show_music", { scale: { tonic: "C4" } });
      await ctx.wait(2.5); await ctx.shot("shown");
      await ctx.tool("play_music", { tempo: 96 });
      await ctx.film("playing", 6.5);
      await ctx.wait(1.5);
    },
  },
  {
    name: "music-figure", title: "v0.4.2: Figure 2.0 explains a lit note, then points at each note of the scale as it sounds", seconds: 24,
    async run(ctx) {
      await ctx.tool("set_body_form", { body: "figure" });
      await ctx.wait(3);
      await ctx.tool("show_music", { title: "G on line 2", notes: [{ pitch: "G4", duration: "whole", label: "G" }], highlight: [{ note: 0 }, { line: 2 }] });
      await ctx.film("explains", 4);
      await ctx.tool("play_music", { scale: { tonic: "C4" }, tempo: 84 });
      await ctx.film("points", 7);
      await ctx.tool("set_body_form", { body: "sphere" });
      await ctx.wait(3);
    },
  },
  {
    name: "spectrum", title: "v0.4.2 Demo F/H: shared music (stand-in capture) → detected → circular spectrum; bass vs treble; back to the sphere", seconds: 70,
    async run(ctx) {
      await ctx.wait(1.5); await ctx.shot("sphere");
      ctx.bridgeSignal("music");
      await ctx.tool("set_audio_visualizer", { source: "system", app: "Music", mode: "auto" });
      await ctx.wait(4.5);
      await ctx.film("sphere-to-spectrum", 5);
      await ctx.wait(1); await ctx.shot("spectrum");
      await ctx.film("spectrum-music", 5);
      ctx.bridgeSignal("bass");
      await ctx.tool("set_audio_visualizer", { source: "system", app: "Music", mode: "spectrum" });
      await ctx.wait(3); await ctx.film("bass", 3); await ctx.shot("bass");
      ctx.bridgeSignal("treble");
      await ctx.tool("set_audio_visualizer", { source: "system", app: "Music", mode: "spectrum" });
      await ctx.wait(3); await ctx.film("treble", 3); await ctx.shot("treble");
      ctx.bridgeSignal("music");
      await ctx.tool("set_audio_visualizer", { source: "system", app: "Music", mode: "hybrid", intensity: "expressive" });
      await ctx.wait(3); await ctx.film("hybrid", 4); await ctx.shot("hybrid");
      await ctx.tool("set_colors", { base: "blue" });
      await ctx.wait(2); await ctx.shot("blue");
      await ctx.tool("set_colors", { reset: "base" });
      await ctx.tool("set_audio_visualizer", { mode: "sphere", intensity: "balanced" });
      await ctx.film("spectrum-to-sphere", 4);
      await ctx.wait(1); await ctx.shot("back-to-sphere");
      await ctx.tool("set_audio_visualizer", { stop: ["system"], mode: "auto" });
      await ctx.wait(2);
    },
  },
  {
    name: "codex-voice-sim", title: "v0.4.2 Demo E (stand-in capture, not Codex): a speech signal through the bridge path drives the speaking sphere", seconds: 16,
    async run(ctx) {
      await ctx.wait(1.5);
      ctx.bridgeSignal("speech");
      await ctx.tool("set_audio_visualizer", { source: "codex" });
      await ctx.wait(1.5);
      await ctx.film("speaking", 6);
      await ctx.shot("speaking");
      await ctx.tool("set_audio_visualizer", { stop: ["codex"], source: "auto" });
      await ctx.wait(2);
    },
  },
  {
    name: "listening-spectrum", title: "v0.4.2 Demo D (Chrome's fake microphone): the listening sphere follows the voice's loudness and spectrum", seconds: 16, speech: true,
    async run(ctx) {
      await ctx.wait(3);
      await ctx.film("listening", 8);
      await ctx.shot("listening");
    },
  },
);

/** Demos register here as they are built (later phases append to DEMOS). */
export const demos = DEMOS;

async function runDemo(browser: Browser, demo: Demo) {
  const home = mkdtempSync(join(tmpdir(), "aion-showcase-"));
  let signal = "music";
  // Sound demos use a stand-in for the macOS bridge app (real socket, real analysis, generated sound).
  const hub = new PresenceHub({
    home, port: 0, page: () => readFileSync(pagePath, "utf8"),
    bridge: { locate: () => "stand-in", isMac: true, macosVersion: 15, launch: (_app, args) => spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "lib", "fakeBridge.ts"), ...args], { stdio: "ignore", env: { ...process.env, AION_FAKE_SIGNAL: signal } }) },
  });
  await hub.start();
  hub.apply({ type: "open", greet: false });
  const videoDir = mkdtempSync(join(tmpdir(), "aion-video-"));
  const context: BrowserContext = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT } });
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  const started = Date.now();
  // The real MCP server, connected to this showcase's hub through its runtime directory (as a second Codex session would).
  const aion = await connectAion({ home, resolver });
  const log = (text: string) => console.log(`    ${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  ${text}`);
  await page.goto(`${hub.surfaceUrl}&debug=1${demo.speech ? "" : "&mic=0"}${canvas ? "&renderer=canvas" : ""}`);
  await page.addStyleTag({ content: "#debug { display: none !important; }" });
  const ctx: DemoContext = {
    hub, page, log, bridgeSignal: next => { signal = next; },
    apply: command => { hub.apply(command); },
    wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
    shot: async moment => { await page.screenshot({ path: join(OUT, `${demo.name}${canvas ? "-canvas" : ""}-${moment}.png`) }); log(`📷 ${moment}`); },
    portrait: async person => {
      const found = await cachedPortrait(person);
      return { media: hub.addMedia(found.bytes, found.mime), alt: found.label, width: found.width, height: found.height };
    },
    view: expression => page.evaluate(`(() => { const v = window.aionPresence; return ${expression}; })()`),
    tool: async (name, args = {}) => {
      const result = await aion.call(name, args) as { isError?: boolean; content: { text: string }[] };
      const text = result.content.map(item => item.text).join(" ");
      log(`${result.isError ? "✗" : "→"} ${name} ${JSON.stringify(args)}: ${text.slice(0, 150)}`);
      return text;
    },
    film: async (clip, seconds, area) => {
      const dir = join(OUT, "frames", `${demo.name}${canvas ? "-canvas" : ""}-${clip}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const times: number[] = [];
      const start = Date.now();
      while (Date.now() - start < seconds * 1000) {
        times.push(Date.now() - start);
        await page.screenshot({ path: join(dir, `${String(times.length).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, ...(area ? { clip: area } : {}) });
      }
      const durations = times.map((at, k) => (times[k + 1] ?? Date.now() - start) - at);
      writeFileSync(join(dir, "timing.json"), JSON.stringify(durations));
      log(`🎞  ${clip}: ${times.length} frames in ${seconds} s`);
    },
  };
  console.log(`  ${demo.name}: ${demo.title}`);
  try { await demo.run(ctx); } finally {
    await aion.close();
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
