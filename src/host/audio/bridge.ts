import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { AudioAnalyzer, DIGITAL_SOURCE } from "../../audio/analyzer";
import type { AudioFeatures } from "../../audio/features";
import type { BridgeSource, BridgeStatus } from "../../audio/settings";

/**
 * The hub's end of the macOS Audio Bridge (native/audio-bridge): Codex's spoken voice, or another application's sound,
 * captured with a Core Audio process tap and analysed here with the same AudioAnalyzer every surface uses.
 *
 *   Aion Audio Bridge.app ──private Unix socket (a 0700 directory, a one-time nonce)──► NativeAudioBridge
 *        (samples, in memory)                                                             ├─ AudioAnalyzer (60 Hz)
 *                                                                                          └─► features ─► hub ─► surfaces
 *
 * Samples are never written anywhere: they pass through a short ring buffer and are overwritten. Only features leave
 * this module. Capture starts only when the user asks for it (set_audio_visualizer), never by itself, and stops with
 * `stop()`, with the session, or when the hub goes away (the bridge notices its socket close and exits).
 */
export const BRIDGE_APP_NAME = "Aion Audio Bridge.app";
/** Bundle id of the Codex desktop app; its helper processes (the audio service that plays its voice) share the prefix. */
export const CODEX_BUNDLE = "com.openai.codex";

export interface BridgeTarget { source: BridgeSource; app?: string }

export interface BridgeOptions {
  /** Where the bridge app is (null: not installed). Default: AION_AUDIO_BRIDGE, ~/.aion-presence/audio-bridge, or a dev build. */
  locate?: () => string | null;
  /** Starts the app (injectable for tests). Default: `open -g -n <app> --args …` (LaunchServices, so macOS asks this app for permission). */
  launch?: (app: string, args: string[]) => ChildProcess | null;
  /** Called with each analysed frame (about 60 a second while streaming, fewer while silent). */
  onFeatures: (source: BridgeSource, features: AudioFeatures) => void;
  /** Called whenever the status changes. */
  onStatus: (status: BridgeStatus) => void;
  /** Called once per capture, at its first real (non-zero) sample: proof that macOS lets the audio through (v0.4.3). */
  onHeard?: (source: BridgeSource) => void;
  /** Seconds to wait for the tap to run. Default 20: the first start waits for the user to answer macOS's permission prompt. */
  connectTimeout?: number;
  env?: NodeJS.ProcessEnv;
  isMac?: boolean;
  macosVersion?: number;
}

/** macOS version from the Darwin kernel release (Darwin 23 = macOS 14; process taps need 14.2, Darwin 23.2). */
export function macosFromDarwin(darwin: string): number {
  const [major, minor] = darwin.split(".").map(Number);
  return major >= 20 ? major - 9 + (minor || 0) / 10 : 0;
}

export function defaultBridgeLocation(env: NodeJS.ProcessEnv = process.env, repo?: string): string | null {
  const candidates = [
    env.AION_AUDIO_BRIDGE,
    join(homedir(), ".aion-presence", "audio-bridge", BRIDGE_APP_NAME),
    ...(repo ? [join(repo, "native", "audio-bridge", "build", BRIDGE_APP_NAME)] : []),
  ].filter((path): path is string => !!path);
  return candidates.find(path => existsSync(join(path, "Contents", "MacOS", "aion-audio-bridge"))) ?? null;
}

/** Codex, or another application named by the user (a bundle id or a plain name), or the whole system mix. */
export function bridgeArgs(target: BridgeTarget): string[] {
  // --follow (v0.4.3): the bridge waits for the app's audio processes and ends when they (or the output device) change,
  // so the hub reconnects to the new ones. A bridge built before v0.4.3 ignores it.
  if (target.source === "codex") return ["--bundle", CODEX_BUNDLE, "--follow"];
  if (!target.app) return ["--system", "--follow"];
  return [...(/^[a-zA-Z][\w-]*(\.[\w-]+)+$/.test(target.app) ? ["--bundle", target.app] : ["--name", target.app]), "--follow"];
}

export class NativeAudioBridge {
  status: BridgeStatus = { state: "off" };
  private server: Server | null = null;
  private socket: Socket | null = null;
  private dir: string | null = null;
  private child: ChildProcess | null = null;
  private analyzer: AudioAnalyzer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private target: BridgeTarget | null = null;
  private zeroSamples = 0;
  private realSamples = 0;
  private lastPublish = 0;
  private generation = 0;

  constructor(private readonly options: BridgeOptions) {}

  /** Whether any real (non-zero) sample has arrived in this capture. */
  get heard() { return this.realSamples > 0; }

  /** Why the bridge cannot run here at all (null: it can). */
  unavailable(): string | null {
    const mac = this.options.isMac ?? platform() === "darwin";
    if (!mac) return "not-macos";
    const version = this.options.macosVersion ?? macosFromDarwin(release());
    if (version > 0 && version < 14.2) return "macos-too-old";
    if (!(this.options.locate ?? (() => defaultBridgeLocation(this.options.env)))()) return "not-installed";
    return null;
  }

  /** Starts capturing (replacing a capture already running). Resolves once streaming, or with why it is not. */
  async start(target: BridgeTarget): Promise<BridgeStatus> {
    this.stop(false);
    const generation = ++this.generation;
    const reason = this.unavailable();
    if (reason) return this.set({ state: "unavailable", source: target.source, ...(target.app ? { app: target.app } : {}), reason });
    const app = (this.options.locate ?? (() => defaultBridgeLocation(this.options.env)))()!;
    this.target = target;
    this.dir = mkdtempSync(join(tmpdir(), "aion-audio-"));
    const path = join(this.dir, "bridge.sock");
    const nonce = randomBytes(16).toString("hex");
    this.set({ state: "starting", source: target.source, ...(target.app ? { app: target.app } : {}) });
    return new Promise<BridgeStatus>(resolve => {
      let settled = false;
      const settle = (status: BridgeStatus) => { if (!settled) { settled = true; resolve(status); } };
      const server = createServer(socket => {
        if (this.socket || generation !== this.generation) { socket.destroy(); return; }
        this.accept(socket, nonce, generation, settle);
      });
      this.server = server;
      server.on("error", () => settle(this.fail("socket")));
      server.listen(path, () => {
        if (generation !== this.generation) return;
        const args = ["stream", "--socket", path, "--nonce", nonce, ...bridgeArgs(target)];
        try {
          this.child = (this.options.launch ?? defaultLaunch)(app, args);
          this.child?.on("error", () => settle(this.fail("launch")));
        } catch { settle(this.fail("launch")); return; }
        this.connectTimer = setTimeout(() => settle(this.fail("no-connection")), (this.options.connectTimeout ?? 20) * 1000);
        this.connectTimer.unref?.();
      });
    });
  }

  private accept(socket: Socket, nonce: string, generation: number, settle: (status: BridgeStatus) => void) {
    this.socket = socket;
    let header = "";
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (generation !== this.generation) return;
      if (!this.analyzer) {
        header += chunk.toString("latin1");
        let end = header.indexOf("\n");
        if (end < 0) { if (header.length > 200) socket.destroy(); return; }
        // v0.4.3: "AION-WAIT1 <nonce>": the app has no audio process yet (Codex not open, or not yet playing); the bridge
        // waits for one without a time limit — this is not a permission prompt.
        const waiting = /^AION-WAIT1 ([a-f0-9]{16,64})$/.exec(header.slice(0, end));
        if (waiting) {
          if (waiting[1] !== nonce) { socket.destroy(); settle(this.fail("handshake")); return; }
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
          header = header.slice(end + 1);
          settle(this.set({ ...this.status, state: "starting", waiting: true }));
          end = header.indexOf("\n");
          if (end < 0) return;
        }
        const match = /^AION-PCM1 ([a-f0-9]{16,64}) (\d{4,6})$/.exec(header.slice(0, end));
        if (!match || match[1] !== nonce) { socket.destroy(); settle(this.fail("handshake")); return; }
        this.analyzer = new AudioAnalyzer(Number(match[2]), DIGITAL_SOURCE);
        if (this.connectTimer) clearTimeout(this.connectTimer);
        buffer = Buffer.from(header.slice(end + 1), "latin1");
        this.timer = setInterval(() => this.tick(), 1000 / 60);
        this.timer.unref?.();
        const { waiting: _waiting, ...status } = this.status;
        settle(this.set({ ...status, state: "streaming" }));
      } else buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      // Frames: [UInt32 LE count][count × Float32 LE]. A count of 0 is the bridge's keep-alive.
      let offset = 0;
      while (buffer.length - offset >= 4) {
        const count = buffer.readUInt32LE(offset);
        if (count > 48_000) { socket.destroy(); this.fail("protocol"); return; }
        if (buffer.length - offset < 4 + count * 4) break;
        if (count) {
          const samples = new Float32Array(count);
          let zero = true;
          for (let i = 0; i < count; i++) { const v = buffer.readFloatLE(offset + 4 + i * 4); samples[i] = v; if (v !== 0) zero = false; }
          if (zero) this.zeroSamples += count;
          else { if (this.realSamples === 0) this.options.onHeard?.(this.target!.source); this.realSamples += count; }
          this.analyzer!.push(samples);
          samples.fill(0);
        }
        offset += 4 + count * 4;
      }
      buffer = offset ? buffer.subarray(offset) : buffer;
      if (buffer.length && offset) buffer = Buffer.from(buffer);
      // Many seconds of samples, every one exactly zero: macOS is withholding the audio (no permission yet).
      const silentCapture = this.realSamples === 0 && this.zeroSamples > this.analyzer!.sampleRate * 3;
      if (silentCapture !== Boolean(this.status.silentCapture)) this.set({ ...this.status, silentCapture });
    });
    const ended = () => { if (generation === this.generation && this.status.state !== "off") { settle(this.fail("ended")); } };
    socket.on("close", ended);
    socket.on("error", ended);
  }

  private tick() {
    if (!this.analyzer || !this.target) return;
    const features = this.analyzer.analyze(1 / 60);
    const now = Date.now();
    // Silence is sent a few times a second (enough to show it), sound at the full rate.
    if (!features.silent || now - this.lastPublish > 250) { this.lastPublish = now; this.options.onFeatures(this.target.source, features); }
  }

  /** Stops capturing: the socket closes, the bridge app notices and exits, the tap is gone. */
  stop(report = true) {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.socket?.destroy();
    this.server?.close();
    if (this.child && this.child.exitCode === null) { try { this.child.kill(); } catch { /* already gone */ } }
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.timer = this.connectTimer = null; this.socket = null; this.server = null; this.child = null; this.dir = null;
    this.analyzer?.reset(); this.analyzer = null; this.target = null; this.zeroSamples = this.realSamples = 0;
    if (report && this.status.state !== "off") this.set({ state: "off" });
    else if (!report) this.status = { state: "off" };
  }

  private fail(reason: string): BridgeStatus {
    const source = this.status.source, app = this.status.app;
    this.stop(false);
    return this.set({ state: "failed", ...(source ? { source } : {}), ...(app ? { app } : {}), reason });
  }

  private set(status: BridgeStatus): BridgeStatus {
    this.status = status;
    this.options.onStatus(status);
    return status;
  }
}

/** Launches the app through LaunchServices (its own identity for macOS permissions), in the background. */
function defaultLaunch(app: string, args: string[]): ChildProcess {
  const child = spawnProcess("open", ["-g", "-n", app, "--args", ...args], { stdio: "ignore", detached: false });
  child.unref();
  return child;
}
