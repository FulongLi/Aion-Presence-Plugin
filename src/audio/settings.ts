import type { AudioSourceKind } from "./features";

/**
 * How Aion responds to sound (the set_audio_visualizer tool): which source, which visual mode, how strongly.
 *
 *   source   auto: whatever is really sounding, by the rules in route.ts · or one source the user chose
 *   mode     auto: the sphere for speech; the circular spectrum for sustained external music (detected, see detector.ts)
 *            sphere: always the sphere · spectrum: the circular particle spectrum · hybrid: the sphere inside a lighter ring
 *   intensity  subtle · balanced · expressive
 *   sensitivity 0…1: how quiet a sound may be and still count
 *
 * Capture permissions are never part of these settings: opening a source (Codex's voice, another app, a tab) is asked
 * for each time, by the user, and stops with the session.
 */
export const AUDIO_SOURCE_PREFERENCES = ["auto", "microphone", "codex", "system", "tab", "music"] as const;
export type AudioSourcePreference = typeof AUDIO_SOURCE_PREFERENCES[number];
export const AUDIO_MODES = ["auto", "sphere", "spectrum", "hybrid"] as const;
export type AudioMode = typeof AUDIO_MODES[number];
export const AUDIO_INTENSITIES = ["subtle", "balanced", "expressive"] as const;
export type AudioIntensity = typeof AUDIO_INTENSITIES[number];
/** Sources captured outside the page, through the native bridge. */
export const BRIDGE_SOURCES = ["codex", "system"] as const satisfies readonly AudioSourceKind[];
export type BridgeSource = typeof BRIDGE_SOURCES[number];

export interface AudioSettings {
  enabled: boolean;
  source: AudioSourcePreference;
  mode: AudioMode;
  intensity: AudioIntensity;
  sensitivity: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = Object.freeze({ enabled: true, source: "auto", mode: "auto", intensity: "balanced", sensitivity: 0.5 });

/** Gain on every audio-driven motion, per intensity. */
export const INTENSITY_GAIN: Record<AudioIntensity, number> = { subtle: 0.55, balanced: 1, expressive: 1.6 };

/** Where the native bridge stands (it captures Codex's voice or another app's sound on macOS). */
export const BRIDGE_STATES = ["off", "starting", "streaming", "unavailable", "failed"] as const;
export type BridgeState = typeof BRIDGE_STATES[number];

export interface BridgeStatus {
  state: BridgeState;
  /** What it captures while starting or streaming. */
  source?: BridgeSource;
  /** The application tapped, for system audio ("Music", "com.spotify.client"); absent: the whole system mix. */
  app?: string;
  /** Why it is unavailable or failed (not-macos, macos-too-old, not-installed, permission, no-such-app, ended). */
  reason?: string;
  /** Samples arrived but every one was exactly zero: macOS has not granted "System Audio Recording". */
  silentCapture?: boolean;
}

export interface AudioPresence { settings: AudioSettings; bridge: BridgeStatus }
export const DEFAULT_AUDIO_PRESENCE: AudioPresence = Object.freeze({ settings: DEFAULT_AUDIO_SETTINGS, bridge: Object.freeze({ state: "off" as const }) });
