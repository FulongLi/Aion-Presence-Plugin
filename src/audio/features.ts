/**
 * The common audio feature format. Every capture adapter (the microphone, Codex's output through the native bridge, a
 * shared browser tab or another app's audio, the Music Library's own playback) is reduced to this by the same
 * analyzer, and nothing else about the sound leaves the place it was measured: no samples, no recording.
 */
export const AUDIO_SOURCES = ["microphone", "codex", "system", "tab", "music"] as const;
/**
 * microphone: the user's voice (local listening). codex: Codex's own spoken answer (native bridge). system: another
 * application's sound on this Mac (native bridge, the user names the app or the whole mix). tab: a browser tab the
 * user shared. music: the Music Library's own playback, analysed straight from its Web Audio graph.
 */
export type AudioSourceKind = typeof AUDIO_SOURCES[number];
export const isAudioSource = (value: unknown): value is AudioSourceKind => typeof value === "string" && (AUDIO_SOURCES as readonly string[]).includes(value);

export interface AudioFeatures {
  /** Seconds (the analyser's clock) of the newest audio this frame describes. */
  t: number;
  /** Raw loudness of the latest window (RMS, linear full scale). */
  rms: number;
  /** Perceived loudness above the noise floor, 0…1, with dynamic-range control (quiet and loud both visible). */
  level: number;
  /** Log-spaced bands, 0…1 each, smoothed (fast attack, slower release), noise-floor removed. */
  bands: Float32Array;
  /** Below 250 Hz, 250 Hz–2 kHz, above 2 kHz: 0…1 each. */
  bass: number;
  mid: number;
  treble: number;
  /** Spectral flux (how much the spectrum rose since the last frame), 0…1: transients, onsets. */
  onset: number;
  /** A pulse on each detected beat or strong onset: 1 at the beat, decaying over about 0.3 s. */
  beat: number;
  /** Spectral centroid on the log axis, 0 (all bass) … 1 (all treble). */
  centroid: number;
  /** Spectral flatness, 0 (tonal) … 1 (noise-like). */
  flatness: number;
  /** Share of energy in the speech range (150 Hz–4 kHz), 0…1. */
  speech: number;
  /** Voice-like activity (loud enough, speech-range energy, attack and hangover). */
  voice: boolean;
  /** Nothing audible above the noise floor for a moment (or no samples arriving). */
  silent: boolean;
}

export function createFeatures(bands: number): AudioFeatures {
  return {
    t: 0, rms: 0, level: 0, bands: new Float32Array(bands), bass: 0, mid: 0, treble: 0, onset: 0, beat: 0,
    centroid: 0, flatness: 0, speech: 0, voice: false, silent: true,
  };
}

/** A copy (features are reused in place frame to frame). */
export function copyFeatures(from: AudioFeatures, to: AudioFeatures = createFeatures(from.bands.length)): AudioFeatures {
  const { bands, ...scalars } = from;
  Object.assign(to, scalars);
  if (to.bands.length !== bands.length) to.bands = new Float32Array(bands.length);
  to.bands.set(bands);
  return to;
}
