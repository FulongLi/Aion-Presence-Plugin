import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PresenceHub } from "../src/host/hub/hub";
import { openBrowser } from "../src/host/surface";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run welcome:speech [-- --lang=en|zh|both]`: the spoken welcome with the system's *real* voice (v0.7). A fresh
 * installation's window opens in a visible Chrome (no autoplay override: the browser's own policy applies), and Aion
 * speaks through Chrome's Speech Synthesis API — on macOS, the system's on-device voices — out of this Mac's speakers.
 * When Chrome wants a gesture first, the script clicks "Listen to the welcome" as a user would, and says so.
 *
 * It reports what the synthesizer really did: the voices on offer, the one chosen, when each sentence started, and how
 * long the welcome took. That proves the synthesizer spoke; whether it was *audible* is for the person at the Mac to
 * confirm (the report says so). Output: .e2e/welcome-speech/report.json and screenshots.
 *
 * `-- --app-window`: instead, a fresh installation's first run exactly as a user gets it — Aion's own Chrome app window,
 * opened the way Aion opens it, nobody clicking. The hub's record then says whether the welcome was spoken by itself
 * (the browser allowed it) or is still waiting for "Listen to the welcome" (the browser wanted a gesture).
 */
const OUT = join(REPO_ROOT, ".e2e", "welcome-speech");
mkdirSync(OUT, { recursive: true });
const chromePath = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
if (!chromePath) { console.log("welcome:speech: no Chrome found (set CHROME_PATH)"); process.exit(1); }
const pagePath = join(PLUGIN_ROOT, "runtime", "presence.html");
if (!existsSync(pagePath)) { console.error("welcome:speech: run npm run build first"); process.exit(1); }
const which = process.argv.find(arg => arg.startsWith("--lang="))?.slice(7) ?? "both";
const languages = which === "both" ? ["en-US", "zh-CN"] : [which === "zh" ? "zh-CN" : "en-US"];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes("--app-window")) {
  const home = mkdtempSync(join(tmpdir(), "aion-welcome-app-"));
  const hub = new PresenceHub({ home, port: 0, page: () => readFileSync(pagePath, "utf8"), bridge: { locate: () => null } });
  await hub.start();
  hub.apply({ type: "open", greet: true });
  const opened = await openBrowser(`${hub.surfaceUrl}&debug=1`);
  console.log(`Aion's own window ${opened ? "opened" : "could not be opened"} (a fresh installation); waiting up to 45 s without touching it…`);
  let record = "", lastLine = "";
  const lines: string[] = [];
  const diagnostics = () => [...(hub as unknown as { diagnostics: Map<string, { lines: Record<string, string> }> }).diagnostics.values()].at(-1)?.lines.welcome ?? "";
  for (let i = 0; i < 450 && !record; i++) {
    await pause(100);
    const line = diagnostics();
    if (line && line !== lastLine) { lastLine = line; lines.push(line); console.log(`  ${(i / 10).toFixed(1)} s  ${line}`); }
    if (existsSync(join(home, "welcome-complete"))) record = readFileSync(join(home, "welcome-complete"), "utf8").trim();
  }
  const how = record.split(" ").at(-1);
  const outcome = !record ? "not remembered: the window is waiting for “Listen to the welcome” (the browser wanted a gesture), or it never spoke"
    : how === "spoken" ? `remembered "${record}": the browser let Aion speak by itself`
      : `remembered "${record}": not spoken (${how})`;
  console.log(`App window: ${outcome}. Viewers connected: ${hub.snapshot().hub.viewers}.`);
  writeFileSync(join(OUT, "app-window.json"), `${JSON.stringify({ opened, record: record || null, outcome, diagnostics: lines, at: new Date().toISOString() }, null, 2)}\n`);
  await hub.stop();
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: false, args: ["--window-size=1100,760"] });
const report: Record<string, unknown>[] = [];
try {
  for (const locale of languages) {
    const home = mkdtempSync(join(tmpdir(), "aion-welcome-speech-"));
    const hub = new PresenceHub({ home, port: 0, page: () => readFileSync(pagePath, "utf8"), bridge: { locate: () => null } });
    await hub.start();
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, locale });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const started = Date.now();
    await page.goto(`${hub.surfaceUrl}&debug=1&mic=0`);
    await page.addStyleTag({ content: "#debug { display: none !important; }" });
    const voices = await page.evaluate(`new Promise(resolve => { const list = () => speechSynthesis.getVoices().map(v => ({ name: v.name, lang: v.lang, local: v.localService }));
      if (list().length) resolve(list()); else { speechSynthesis.addEventListener("voiceschanged", () => resolve(list()), { once: true }); setTimeout(() => resolve(list()), 3000); } })`) as { name: string; lang: string; local: boolean }[];
    const timeline: { t: number; phase: string; sentence: number }[] = [];
    let last = "", gesture = false, blocked = false, speakingAt = 0, finishedAt = 0;
    for (let waited = 0; waited < 90_000; waited += 100) {
      const now = await page.evaluate("({ phase: window.aionPresence ? window.aionPresence.narration.phase : 'loading', sentence: window.aionPresence ? window.aionPresence.narration.sentence : -1 })") as { phase: string; sentence: number };
      const key = `${now.phase}:${now.sentence}`;
      if (key !== last) { timeline.push({ t: Date.now() - started, ...now }); last = key; console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s  ${now.phase}${now.sentence >= 0 ? ` (sentence ${now.sentence + 1})` : ""}`); }
      if (now.phase === "speaking" && !speakingAt) { speakingAt = Date.now(); await page.screenshot({ path: join(OUT, `speaking-${locale}.png`) }); }
      if (now.phase === "offered" && !gesture) {
        blocked = true; gesture = true;
        await page.screenshot({ path: join(OUT, `offered-${locale}.png`) });
        console.log("  Chrome wants a gesture before it speaks: clicking “Listen to the welcome”, as a user would");
        await page.locator(".welcome-listen").click();
      }
      if (["finished", "text"].includes(now.phase)) { finishedAt = Date.now(); break; }
      await pause(100);
    }
    await pause(800);
    const voice = await page.evaluate("window.aionPresence.speech ? window.aionPresence.speech.voice : null") as string | null;
    const remembered = existsSync(join(home, "welcome-complete")) ? readFileSync(join(home, "welcome-complete"), "utf8").trim() : null;
    const entry = {
      locale, chrome: browser.version(), voices: voices.filter(v => v.lang.toLowerCase().startsWith(locale.slice(0, 2))).slice(0, 30), voice,
      autoplayBlocked: blocked, clickedListen: gesture, spokenSeconds: speakingAt && finishedAt ? Math.round((finishedAt - speakingAt) / 100) / 10 : null,
      outcome: timeline.at(-1)?.phase, remembered, timeline, errors,
      audible: "not measured by this script — confirmed by the person at the Mac",
    };
    report.push(entry);
    console.log(`${locale}: voice ${voice ?? "none"}, ${entry.spokenSeconds ?? "?"} s spoken, outcome ${entry.outcome}${blocked ? " (after the Listen click)" : " (no click needed)"}; remembered: ${remembered ?? "no"}`);
    await context.close();
    await hub.stop();
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Report: ${join(OUT, "report.json")}`);
