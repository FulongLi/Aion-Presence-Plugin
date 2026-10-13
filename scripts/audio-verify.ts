import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MusicDetector } from "../src/audio/detector";
import { createFeatures } from "../src/audio/features";
import { decodeFeatures } from "../src/audio/wire";
import { defaultBridgeLocation } from "../src/host/audio/bridge";
import { PresenceHub } from "../src/host/hub/hub";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";
import type { Page } from "playwright-core";

/**
 * Real-device check of the macOS audio path (no stand-ins): the installed Aion Audio Bridge app taps a real process, its
 * samples reach a real hub over the private socket, the hub's analyser turns them into features, and the event stream
 * carries them out, where this script measures them (and, with --screenshots, a headless Chrome page shows the body).
 *
 *   npm run audio:verify -- --play-loops                  system audio: a track layered from Apple Loops, played by afplay
 *   npm run audio:verify -- --codex --seconds 40          Codex's own voice: speak with Codex in voice mode meanwhile
 *   npm run audio:verify -- --app Music --seconds 30      another app (play something in it first)
 *   … --screenshots .e2e/audio-verify                     also screenshots of the companion page while it listens
 *
 * Nothing is recorded: the samples exist only in the bridge and the hub's analyser; this script sees features only.
 * Needs macOS 14.2+, the bridge (npm run audio-bridge:install, or AION_AUDIO_BRIDGE) and System Audio Recording permission.
 */
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const codex = args.includes("--codex");
const seconds = Number(option("--seconds") ?? (codex ? 40 : 22));
const shots = option("--screenshots");
const bridge = defaultBridgeLocation(process.env, REPO_ROOT);
if (!bridge) { console.error("audio:verify: no Aion Audio Bridge (npm run audio-bridge:install, or set AION_AUDIO_BRIDGE)"); process.exit(1); }

/** A track layered from one Apple Loops pack (a beat, a bass, a melodic part), as a WAV, mixed here. */
function loopsTrack(dir: string): string | null {
  const root = "/Library/Audio/Apple Loops/Apple";
  if (!existsSync(root)) return null;
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".caf") && file.startsWith("01 Hip Hop/"));
  const pick = (pattern: RegExp) => files.find(file => pattern.test(basename(file)));
  const parts = [pick(/Afloat Beat/), pick(/Afloat Sub Bass/), pick(/Afloat Pad/)].filter(Boolean) as string[];
  if (parts.length < 3) return null;
  const rate = 48_000, length = Math.round((seconds + 4) * rate), mix = new Float32Array(length);
  for (const part of parts) {
    const wav = join(dir, "part.wav");
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${rate}`, "-c", "1", join(root, part), wav]);
    const data = readFileSync(wav), offset = data.indexOf("data") + 8, frames = (data.length - offset) >> 1;
    for (let i = 0; i < length; i++) mix[i] += data.readInt16LE(offset + (i % frames) * 2) / 32768 * 0.45;
  }
  const out = Buffer.alloc(44 + length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + length * 2, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(mix[i] * 32767))), 44 + i * 2);
  const path = join(dir, "track.wav");
  writeFileSync(path, out);
  return path;
}

const dir = mkdtempSync(join(tmpdir(), "aion-audio-verify-"));
const home = join(dir, "home");
let player: ChildProcess | null = null;
const hub = new PresenceHub({ home, port: 0, page: () => readFileSync(join(PLUGIN_ROOT, "runtime", "presence.html"), "utf8"), bridge: { locate: () => bridge } });
await hub.start();
try {
  let app = option("--app");
  if (args.includes("--play-loops")) {
    const track = loopsTrack(dir);
    if (!track) throw new Error("no Apple Loops on this Mac");
    player = spawn("afplay", ["-v", option("--volume") ?? "0.15", track], { stdio: "ignore" });
    app = "afplay";
    await new Promise(resolve => setTimeout(resolve, 600)); // afplay registers with Core Audio
  }
  const target = codex ? { source: "codex" as const } : { source: "system" as const, ...(app ? { app } : {}) };
  console.log(`bridge ${bridge}\ncapturing ${codex ? "Codex (com.openai.codex and its helpers)" : app ?? "the whole system mix"} for ${seconds} s${codex ? " — speak with Codex in voice mode now" : ""}`);
  // Features as a surface receives them: the hub's event stream.
  const events = await fetch(new URL(`events?token=${hub.surfaceUrl.split("token=")[1]}&window=verify0001`, hub.url));
  const reader = events.body!.getReader();
  let browser: { close(): Promise<void> } | null = null;
  let page: Page | null = null;
  if (shots) {
    const { chromium } = await import("playwright-core");
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const launched = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal"] });
    browser = launched;
    page = await launched.newPage({ viewport: { width: 1000, height: 760 } });
    await page.goto(`${hub.surfaceUrl}&mic=0`);
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  const started = Date.now();
  hub.apply({ type: "audio", settings: { source: target.source, mode: "auto" }, capture: target });
  const features = createFeatures(32), detector = new MusicDetector();
  const stats = { frames: 0, audible: 0, voiced: 0, level: 0, bass: 0, mid: 0, treble: 0, beats: 0, firstAudibleMs: -1, musicAtMs: -1, bandSum: new Float64Array(32) };
  let text = "", lastT = -1, shot = 0;
  const decoder = new TextDecoder();
  while (Date.now() - started < seconds * 1000) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: false }>(resolve => setTimeout(() => resolve({ value: undefined, done: false }), 500))]);
    if (done) break;
    if (value) text += decoder.decode(value);
    let at;
    while ((at = text.indexOf("\n\n")) >= 0) {
      const block = text.slice(0, at); text = text.slice(at + 2);
      if (!block.startsWith("event: audio")) continue;
      const frame = decodeFeatures(JSON.parse(block.slice(block.indexOf("data: ") + 6)), features);
      if (!frame) continue;
      const f = frame.features, dt = lastT < 0 ? 1 / 60 : Math.max(0, Math.min(0.25, f.t - lastT));
      lastT = f.t;
      stats.frames++;
      if (!f.silent) {
        stats.audible++; stats.level += f.level; stats.bass += f.bass; stats.mid += f.mid; stats.treble += f.treble;
        for (let i = 0; i < 32; i++) stats.bandSum[i] += f.bands[i];
        if (stats.firstAudibleMs < 0) stats.firstAudibleMs = Date.now() - started;
      }
      if (f.voice) stats.voiced++;
      if (f.beat > 0.99) stats.beats++;
      if (detector.sample(f, dt) && stats.musicAtMs < 0) stats.musicAtMs = Date.now() - started;
    }
    if (page && Date.now() - started > (shot + 1) * (seconds * 1000 / 4)) await page.screenshot({ path: join(shots!, `audio-verify-${++shot}.png`) });
  }
  await reader.cancel();
  const status = hub.snapshot().audio.bridge;
  const n = Math.max(1, stats.audible);
  const summary = {
    target, bridge: status, frames: stats.frames, audibleShare: +(stats.audible / Math.max(1, stats.frames)).toFixed(3), voicedShare: +(stats.voiced / Math.max(1, stats.frames)).toFixed(3),
    meanLevel: +(stats.level / n).toFixed(3), bass: +(stats.bass / n).toFixed(3), mid: +(stats.mid / n).toFixed(3), treble: +(stats.treble / n).toFixed(3), beats: stats.beats,
    firstAudibleMs: stats.firstAudibleMs, musicDetectedAfterMs: stats.musicAtMs, detectorConfidence: +detector.evidence.confidence.toFixed(2),
    bandProfile: Array.from(stats.bandSum, v => +(v / n).toFixed(2)),
  };
  console.log(JSON.stringify(summary, null, 2));
  const verdict = status.silentCapture ? "SILENT: macOS gives the bridge only zeros — allow System Audio Recording for Aion Audio Bridge"
    : stats.level / n < 0.02 ? "NOTHING AUDIBLE: no sound reached the bridge (the target played nothing, is another process, or macOS has not allowed the capture yet)"
      : codex ? (stats.voiced > stats.frames * 0.1 ? "Codex's voice reached Aion as real features" : "audible, but little voice-like content")
        : "the real signal reached Aion as features";
  console.log(`verdict: ${verdict}`);
  await browser?.close();
} finally {
  player?.kill();
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
