import type { AudioSourceKind } from "./features";
import type { AudioSettings } from "./settings";

/**
 * Audio source management: each frame, which real source drives which part of the body. Pure policy (no audio, no
 * DOM), so every rule is tested.
 *
 *   1. Aion's own music (a lesson, a scale) is analysed straight from its playback graph. While it sounds and briefly
 *      after, the microphone is not taken for the user (it hears the speakers), and Codex's tap is ignored (when Aion
 *      is embedded in Codex, Codex's process plays Aion's notes too): one sound is never analysed twice.
 *   2. Codex's voice (the native bridge) drives the speaking body through the presence engine, never the spectrum by
 *      itself, and is never taken for the user.
 *   3. External music the user shared (another app, a tab) becomes the circular spectrum when asked (spectrum,
 *      hybrid) or, in auto, when the detector has heard sustained music; otherwise it moves the sphere gently.
 *   4. The microphone is listening (the engine's job); its spectrum adds detail to the listening sphere, and becomes
 *      the ring only if the user chose the microphone and the spectrum explicitly.
 *   A source that is not connected drives nothing: no source, no spectrum. Host state never switches the spectrum off.
 */
export interface SourceState {
  /** Capture is running (permission granted, samples or keep-alives arriving). */
  connected: boolean;
  /** Something audible right now (features not silent). */
  sounding: boolean;
  /** External sources only: the detector's decision. */
  music?: boolean;
}

export interface RouteInput {
  settings: AudioSettings;
  sources: Partial<Record<AudioSourceKind, SourceState>>;
  /** Seconds since Aion's own playback last sounded (Infinity: never). */
  sincePlayback: number;
}

export type RingLayout = "spectrum" | "hybrid";

export interface AudioRoute {
  /** The source whose features move the sphere's audio field (null: none; Codex's voice moves it through speaking). */
  sphere: AudioSourceKind | null;
  /** The source the circular spectrum follows (null: no ring). */
  ring: AudioSourceKind | null;
  layout: RingLayout;
  /** The microphone hears Aion's own playback: do not take it for the user. */
  suppressMicrophone: boolean;
  /** Codex's tap may carry Aion's own playback: ignore it for now. */
  ignoreCodex: boolean;
  reason: string;
}

/** Aion's own playback still echoes this long after it stops (room reverb, output latency). */
export const PLAYBACK_ECHO_SECONDS = 0.6;

const EXTERNAL: readonly AudioSourceKind[] = ["system", "tab"];

export function routeAudio(input: RouteInput): AudioRoute {
  const { settings, sources } = input;
  const state = (kind: AudioSourceKind): SourceState => sources[kind] ?? { connected: false, sounding: false };
  const playback = input.sincePlayback < PLAYBACK_ECHO_SECONDS || state("music").sounding;
  const base = { suppressMicrophone: playback, ignoreCodex: playback, layout: (settings.mode === "hybrid" ? "hybrid" : "spectrum") as RingLayout };
  if (!settings.enabled) return { ...base, sphere: null, ring: null, reason: "disabled" };
  const explicitRing = settings.mode === "spectrum" || settings.mode === "hybrid";
  const chosen = (kind: AudioSourceKind) => settings.source === kind;

  // 1. Aion's own music.
  if (state("music").sounding && (settings.source === "auto" || chosen("music"))) {
    return { ...base, sphere: "music", ring: explicitRing ? "music" : null, reason: explicitRing ? "playback-spectrum" : "playback" };
  }
  // 2. Codex's voice: the speaking body (the engine), never mistaken for the user.
  const codex = state("codex");
  if (codex.connected && codex.sounding && !playback && (settings.source === "auto" || chosen("codex"))) {
    return { ...base, sphere: null, ring: explicitRing && chosen("codex") ? "codex" : null, reason: "codex-voice" };
  }
  // 3. External music the user shared.
  const external = EXTERNAL.filter(kind => (settings.source === "auto" || chosen(kind)) && state(kind).connected)
    .sort((a, b) => Number(state(b).sounding) - Number(state(a).sounding))[0];
  if (external && !playback) {
    const s = state(external);
    if (settings.mode !== "sphere" && (explicitRing || s.music)) return { ...base, sphere: null, ring: external, reason: explicitRing ? "external-spectrum" : "music-detected" };
    if (s.sounding) return { ...base, sphere: external, ring: null, reason: "external-sphere" };
  }
  // 4. The microphone.
  const mic = state("microphone");
  if (mic.connected && !playback) {
    if (chosen("microphone") && explicitRing) return { ...base, sphere: null, ring: "microphone", reason: "microphone-spectrum" };
    if (mic.sounding) return { ...base, sphere: "microphone", ring: null, reason: "listening" };
  }
  return { ...base, sphere: null, ring: null, reason: playback ? "playback-echo" : "quiet" };
}
