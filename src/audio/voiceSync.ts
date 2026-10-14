import type { BridgeStatus } from "./settings";

/**
 * Codex Voice Sync (v0.4.3): the user's lasting choice that Aion moves with Codex's real spoken voice. Once the user has
 * opted in, Aion reconnects to Codex's voice by itself whenever it is open — no tool call each session — and lets go
 * when it closes. It is about Codex only: another app's sound, or the whole system mix, is still asked for each time.
 *
 * This module is the policy, pure and tested rule by rule; the hub (host/audio/voiceSync.ts) carries it out.
 *
 *   enabled     the user said yes (it survives windows closing, Codex and computer restarts, plugin updates)
 *   permission  what macOS has shown so far, from evidence only:
 *                 granted     real (non-zero) samples arrived from Codex at least once
 *                 unconfirmed the tap ran, but Codex has not sounded since (quiet is not proof either way)
 *                 silent      only exactly-zero samples: macOS is most likely withholding the audio ("System Audio Recording" off)
 *                 unanswered  the capture never started: macOS's prompt was probably left unanswered
 *                 unknown     never tried
 *
 * Reconnecting never asks again: with `unanswered` Aion waits for the user to ask (so a pending prompt is not raised
 * over and over); after a denial macOS stays silent and does not prompt, and Aion says so in its diagnostics.
 */
export const VOICE_SYNC_PERMISSIONS = ["unknown", "granted", "unconfirmed", "silent", "unanswered"] as const;
export type VoiceSyncPermission = typeof VOICE_SYNC_PERMISSIONS[number];

export interface VoiceSyncPreference {
  enabled: boolean;
  permission: VoiceSyncPermission;
  /** When the user last changed it (ms since the epoch), for diagnostics. */
  updatedAt: number;
}

export const DEFAULT_VOICE_SYNC: VoiceSyncPreference = Object.freeze({ enabled: false, permission: "unknown" as const, updatedAt: 0 });

/** Bounded reconnection: these waits, then it stops until Aion is opened again or the user asks. */
export const RECONNECT_BACKOFF_SECONDS = [1, 2, 4, 8, 16, 32] as const;
/** A capture that has run this long resets the backoff (it was a real connection, not a flapping one). */
export const STABLE_SECONDS = 30;
/** After the last window closes, capture stops after this grace (a reload or a superseding window keeps it). */
export const CLOSE_GRACE_SECONDS = 8;

/** Failures that will not change by trying again soon (the bridge cannot run here, or macOS is waiting for the user). */
const PERMANENT = new Set(["not-macos", "macos-too-old", "not-installed"]);

export interface VoiceSyncInput {
  preference: VoiceSyncPreference;
  /** Sound response is on at all (set_audio_visualizer enabled). */
  audioEnabled: boolean;
  /** An Aion window is open (a companion window is connected). */
  open: boolean;
  bridge: BridgeStatus;
  /** Reconnection attempts since the last stable connection or explicit request. */
  attempts: number;
}

export type VoiceSyncDecision =
  | { action: "connect"; reason: string }
  | { action: "retry"; afterSeconds: number; reason: string }
  | { action: "disconnect"; reason: string }
  | { action: "none"; reason: string };

/**
 * What to do now. `connect` starts a capture of Codex's voice; `retry` schedules one after a failure; `disconnect`
 * stops a capture this policy started; `none` leaves things as they are (with why, for diagnostics).
 */
export function decideVoiceSync(input: VoiceSyncInput): VoiceSyncDecision {
  const { preference, bridge } = input;
  const ours = bridge.source === "codex";
  const running = bridge.state === "streaming" || bridge.state === "starting";
  if (!preference.enabled) return ours && running ? { action: "disconnect", reason: "voice sync is off" } : { action: "none", reason: "voice sync is off" };
  if (!input.audioEnabled) return ours && running ? { action: "disconnect", reason: "sound response is off" } : { action: "none", reason: "sound response is off" };
  if (!input.open) return ours && running ? { action: "disconnect", reason: "Aion is closed" } : { action: "none", reason: "Aion is closed" };
  // One capture at a time: the user's own choice of another app's sound wins; Codex resumes when it ends.
  if (bridge.source === "system" && running) return { action: "none", reason: "another app's sound is being captured" };
  if (ours && running) return { action: "none", reason: bridge.state === "streaming" ? "connected" : "connecting" };
  if (preference.permission === "unanswered") return { action: "none", reason: "waiting for the user: macOS's permission prompt was not answered" };
  if (bridge.state === "unavailable" && PERMANENT.has(bridge.reason ?? "")) return { action: "none", reason: `the bridge cannot run here (${bridge.reason})` };
  const failed = ours && bridge.state === "failed";
  if (!failed) return { action: "connect", reason: "voice sync is on and Aion is open" };
  if (input.attempts >= RECONNECT_BACKOFF_SECONDS.length) return { action: "none", reason: `gave up after ${input.attempts} attempts (${bridge.reason ?? "failed"}); it tries again when Aion is opened or you ask` };
  return { action: "retry", afterSeconds: RECONNECT_BACKOFF_SECONDS[input.attempts], reason: `reconnecting after ${bridge.reason ?? "a failure"}` };
}

/** What the capture's outcome says about macOS's permission (evidence only; quiet never downgrades a grant). */
export function permissionFrom(previous: VoiceSyncPermission, bridge: BridgeStatus, realSamples: boolean): VoiceSyncPermission {
  if (bridge.source !== undefined && bridge.source !== "codex") return previous;
  if (realSamples) return "granted";
  if (bridge.state === "streaming") return bridge.silentCapture ? "silent" : previous === "granted" ? "granted" : "unconfirmed";
  if (bridge.state === "failed" && bridge.reason === "no-connection") return previous === "granted" ? "granted" : "unanswered";
  return previous;
}

/** One line for the user and the diagnostics: where Codex Voice Sync stands. */
export function describeVoiceSync(preference: VoiceSyncPreference, bridge: BridgeStatus, decision: VoiceSyncDecision): string {
  if (!preference.enabled) return "off";
  if (bridge.source === "codex" && bridge.state === "streaming") {
    return preference.permission === "silent" || bridge.silentCapture
      ? "on · connected, but macOS gives only silence (allow System Audio Recording for Aion Audio Bridge)"
      : preference.permission === "granted" ? "on · following Codex's voice" : "on · connected, waiting for Codex to speak";
  }
  return `on · ${decision.reason}`;
}
