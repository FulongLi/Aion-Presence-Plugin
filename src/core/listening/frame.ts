/**
 * What the local microphone analysis gives the presence each frame (SCF's MicFrame). It is a handful of numbers
 * computed on this device: no audio, no words, nothing recorded, stored or sent.
 */
export interface MicFrame {
  /** Voice activity after attack/hangover smoothing. */
  voiced: boolean;
  /** Floor-relative loudness in [0, 1]. */
  level: number;
  /** Duration of the current or most recent utterance, in seconds. */
  utterance: number;
  /** Acoustic emphasis event strength for this frame; 0 when none. */
  emphasis: number;
}

export interface MicInput { read(dt: number): MicFrame | null }

/** Root mean square of a block of samples (SCF's audio/analyser.ts). */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
