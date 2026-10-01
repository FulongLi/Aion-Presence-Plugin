/**
 * Host audio, behind an adapter. In plugin mode the conversation, including any voice, belongs to the host
 * (Codex). Aion never opens a microphone and never starts a speech session of its own.
 *
 * Today no host exposes its assistant audio (amplitude, spectrum, timing) to a plugin, so the only adapter
 * is NO_HOST_AUDIO and Aion expresses speech semantically (its activity state), never with faked lip-sync
 * or a made-up amplitude. If a host later exposes real signals, an adapter implementing HostAudioSource is
 * the only thing to add: the presence and the renderer already accept them.
 */
export const SPECTRUM_BANDS = 16;

export interface HostAudioFrame {
  /** The host's assistant speech loudness, 0…1, measured from the real audio. */
  amplitude: number;
  /** Optional spectrum, SPECTRUM_BANDS values in 0…1. */
  bands?: ArrayLike<number>;
}

export interface HostAudioSource {
  /** A short, stable name for diagnostics. */
  readonly name: string;
  /** The latest real frame, or null when the host has no audible assistant speech (or exposes none). */
  read(now: number): HostAudioFrame | null;
}

/** The adapter for every host that exposes no audio: there is nothing to animate, so nothing is invented. */
export const NO_HOST_AUDIO: HostAudioSource = Object.freeze({ name: "none", read: () => null });
