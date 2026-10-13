import type { AudioFeatures } from "./features";

/**
 * Is this sustained music, rather than speech or silence? No model: four measurable properties of the last few
 * seconds of features, each with a known reason to differ between the two, combined into a confidence, then a
 * slow decision with hysteresis so the body never flips back and forth.
 *
 *   dips          speech stops between words and phrases (deep, frequent drops in loudness); music keeps sounding
 *   continuity    music fills the window; speech and silence leave gaps
 *   periodicity   music has a regular pulse (onsets that repeat at 60–180 beats a minute); speech's rhythm is irregular
 *   breadth       speech keeps its energy between 150 Hz and 4 kHz; music spreads into bass and treble
 *
 * It only ever classifies an external source the user chose to share (system audio, a tab): never Codex's own voice,
 * never the microphone by default, never the Music Library's playback (which is known to be music and is shown as a
 * lesson). Measured on real music and real speech: see docs/AUDIO-REACTIVE.md.
 */
export const detectorDefaults = {
  /** Seconds of features the decision looks at. */
  window: 6,
  /** Entries per second kept for the window. */
  rate: 30,
  /** Confidence above which music is being heard, and how long it must last before Aion changes. */
  enter: 0.66,
  enterAfter: 3.5,
  /** Confidence below which it is no longer music, and how long that must last. */
  exit: 0.42,
  exitAfter: 3,
  /** Silence this long ends music at once. */
  silenceExit: 2.2,
  /** A dip is this far below the window's median loudness (dB). */
  dipDb: 14,
};
export type DetectorConfig = typeof detectorDefaults;

export interface MusicEvidence { dips: number; continuity: number; periodicity: number; breadth: number; voiced: number; speechDips: number; confidence: number }

const clamp01 = (value: number) => value > 0 ? (value < 1 ? value : 1) : 0;
/** 1 at or beyond `good`, 0 at or beyond `bad`, linear between. */
const ramp = (value: number, bad: number, good: number) => clamp01((value - bad) / (good - bad));

export class MusicDetector {
  readonly config: DetectorConfig;
  /** The decision: sustained music is playing. */
  music = false;
  readonly evidence: MusicEvidence = { dips: 0, continuity: 0, periodicity: 0, breadth: 0, voiced: 0, speechDips: 0, confidence: 0 };
  private readonly size: number;
  private readonly db: Float32Array;
  private readonly onset: Float32Array;
  private readonly speech: Float32Array;
  private readonly sounding: Uint8Array;
  private readonly voiced: Uint8Array;
  private readonly speechDb: Float32Array;
  private count = 0;
  private head = 0;
  private due = 0;
  private above = 0;
  private below = 0;
  private silentFor = 0;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...detectorDefaults, ...config };
    this.size = Math.round(this.config.window * this.config.rate);
    this.db = new Float32Array(this.size); this.onset = new Float32Array(this.size);
    this.speech = new Float32Array(this.size); this.sounding = new Uint8Array(this.size); this.voiced = new Uint8Array(this.size); this.speechDb = new Float32Array(this.size);
  }

  reset() {
    this.music = false; this.count = this.head = this.due = this.above = this.below = this.silentFor = 0;
    Object.assign(this.evidence, { dips: 0, continuity: 0, periodicity: 0, breadth: 0, voiced: 0, speechDips: 0, confidence: 0 });
  }

  /** Feeds one frame of features `dt` seconds after the last; returns the (hysteretic) decision. */
  sample(features: AudioFeatures, elapsed: number): boolean {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    const c = this.config;
    this.silentFor = features.silent ? this.silentFor + dt : 0;
    this.due += dt * c.rate;
    while (this.due >= 1) {
      this.due -= 1;
      const at = this.head;
      this.db[at] = features.rms > 1e-7 ? 20 * Math.log10(features.rms) : -140;
      this.onset[at] = features.onset;
      this.speech[at] = features.speech;
      this.sounding[at] = features.silent ? 0 : 1;
      this.voiced[at] = features.voice ? 1 : 0;
      this.speechDb[at] = this.db[at] + 10 * Math.log10(Math.max(1e-6, features.speech));
      this.head = (this.head + 1) % this.size;
      this.count = Math.min(this.size, this.count + 1);
    }
    const confidence = this.measure();
    if (this.silentFor >= c.silenceExit) { this.music = false; this.above = 0; this.below = 0; return this.music; }
    if (!this.music) {
      this.above = confidence >= c.enter ? this.above + dt : 0;
      if (this.above >= c.enterAfter) { this.music = true; this.below = 0; }
    } else {
      this.below = confidence <= c.exit ? this.below + dt : 0;
      if (this.below >= c.exitAfter) { this.music = false; this.above = 0; }
    }
    return this.music;
  }

  /** The evidence over the current window (not enough history yet: no confidence). */
  private measure(): number {
    const e = this.evidence, n = this.count;
    if (n < this.size * 0.6) { e.confidence = 0; return 0; }
    const at = (i: number) => (this.head - n + i + this.size) % this.size;
    let sounding = 0;
    const levels: number[] = [];
    let speech = 0, voiced = 0;
    for (let i = 0; i < n; i++) {
      const k = at(i);
      if (this.sounding[k]) { sounding++; levels.push(this.db[k]); speech += this.speech[k]; voiced += this.voiced[k]; }
    }
    e.continuity = sounding / n;
    if (sounding < n * 0.3) { e.dips = 1; e.periodicity = 0; e.breadth = 0; e.confidence = 0; return 0; }
    levels.sort((a, b) => a - b);
    const median = levels[levels.length >> 1];
    let dips = n - sounding;
    for (let i = 0; i < n; i++) { const k = at(i); if (this.sounding[k] && this.db[k] < median - this.config.dipDb) dips++; }
    e.dips = dips / n;
    e.breadth = 1 - speech / sounding;
    e.voiced = voiced / sounding;
    // The speech range on its own: a voice over a quieter bed drops there between words even when the bed fills the gaps.
    const speechLevels: number[] = [];
    for (let i = 0; i < n; i++) { const k = at(i); if (this.sounding[k]) speechLevels.push(this.speechDb[k]); }
    speechLevels.sort((a, b) => a - b);
    const speechMedian = speechLevels[speechLevels.length >> 1];
    let speechDips = 0;
    for (const value of speechLevels) if (value < speechMedian - this.config.dipDb * 0.7) speechDips++;
    e.speechDips = speechDips / sounding;
    // Pulse: the strongest normalised autocorrelation of the onset strength at 60–180 beats per minute.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.onset[at(i)];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { const d = this.onset[at(i)] - mean; energy += d * d; }
    let best = 0;
    const rate = this.config.rate;
    for (let lag = Math.round(rate / 3); lag <= Math.round(rate); lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += (this.onset[at(i)] - mean) * (this.onset[at(i - lag)] - mean);
      const r = energy > 1e-9 ? sum / energy * n / (n - lag) : 0;
      if (r > best) best = r;
    }
    e.periodicity = clamp01(best);
    const score = 0.38 * ramp(e.dips, 0.3, 0.06) + 0.22 * ramp(e.continuity, 0.75, 0.97) + 0.2 * ramp(e.periodicity, 0.12, 0.45) + 0.2 * ramp(e.breadth, 0.1, 0.32);
    e.confidence = clamp01(score);
    return e.confidence;
  }
}
