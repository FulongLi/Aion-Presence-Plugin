import { bandCentres, bandPowers, BAND_DEFAULTS, logBandEdges } from "./bands";
import { createFeatures, type AudioFeatures } from "./features";
import { RealFft } from "./fft";

/**
 * The Audio Analysis Engine: one block of mono samples in, the common feature format out (features.ts). Pure
 * arithmetic, no DOM, no audio APIs, so it runs the same in the page (microphone, a shared tab, the Music Library's
 * playback) and in the hub (Codex's voice and other apps' sound from the native bridge), and it is tested on exact
 * signals. Samples go into a short ring buffer and are overwritten; nothing is kept.
 *
 *   samples ─► window (Hann) ─► FFT ─► log bands ─► dB, spectral tilt, per-band noise floor, adaptive reference
 *           ─► attack/release smoothing ─► bass · mid · treble, flux → onset and beat, centroid, flatness
 *   samples ─► RMS ─► dB above the noise floor (minimum statistics) ─► dynamic-range control ─► level, silence
 *                                                                     └► voice activity (level + speech-range share)
 */
export const analyzerDefaults = {
  fftSize: 2048,
  bands: BAND_DEFAULTS.count,
  minHz: BAND_DEFAULTS.minHz,
  maxHz: BAND_DEFAULTS.maxHz,
  /** Seconds (time constants): bands and level rise fast and fall slower, so motion is lively without flicker. */
  attack: 0.03,
  release: 0.2,
  levelAttack: 0.025,
  levelRelease: 0.28,
  /** How far above the noise floor sound must be to count at all (dB), at sensitivity 0 and 1. */
  gate: { insensitive: 16, sensitive: 4 },
  /** The smallest loudness range level maps onto (dB): a quiet room never fills it. */
  minRange: 26,
  /** The bands' dynamic range below the loudest band (dB). */
  range: 42,
  /** How fast the loudness and band references fall after a loud moment (dB per second): automatic gain. */
  peakDecay: 3.5,
  /** Spectral tilt compensation (dB per octave above 1 kHz), so treble is visible next to bass. */
  tilt: 3,
  /** The noise floor is the quietest moment of the last few seconds (minimum statistics), never above this (dBFS). */
  floorWindows: 8,
  floorWindow: 1,
  floorMax: -46,
  /** …and never below this: digital silence must not turn a dither into a full-scale signal. */
  floorMin: -80,
  /** The loudness reference never sinks below this (dBFS), so automatic gain cannot blow up a whisper. */
  peakMin: -38,
  /** Below the gate this long is silence; no samples for `stale` seconds is silence too. */
  silenceHold: 0.35,
  stale: 0.25,
  voice: { minLevel: 0.06, minSpeech: 0.5, attack: 0.06, hangover: 0.3 },
  beat: { minInterval: 0.28, deviations: 1.5, minFlux: 0.035, decay: 0.12 },
};
export type AnalyzerConfig = typeof analyzerDefaults;

/**
 * Digital sources (Codex's voice and other apps' sound from the bridge, a shared tab, Aion's own playback) carry no room
 * noise: their floor may sit far lower than a microphone's, so quiet music is still heard as music. The microphone keeps
 * the defaults, which never take a steady room for sound.
 */
export const DIGITAL_SOURCE: Partial<AnalyzerConfig> = { floorMax: -72 };

const SILENT_DB = -140;
const toDb = (power: number) => power > 1e-14 ? 10 * Math.log10(power) : SILENT_DB;
const clamp01 = (value: number) => value > 0 ? (value < 1 ? value : 1) : 0;
const ease = (value: number, target: number, tau: number, dt: number) => value + (target - value) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

/** The minimum of a value over the last `windows × window` seconds (Martin's minimum statistics, simplified). */
class RollingMinimum {
  private readonly mins: Float64Array;
  private current = Infinity;
  private age = 0;
  private filled = 0;
  constructor(windows: number, private readonly window: number) { this.mins = new Float64Array(windows).fill(Infinity); }
  push(value: number, dt: number) {
    if (value < this.current) this.current = value;
    this.age += dt;
    if (this.age >= this.window) {
      this.mins.copyWithin(1, 0); this.mins[0] = this.current;
      this.current = Infinity; this.age = 0; this.filled = Math.min(this.mins.length, this.filled + 1);
    }
  }
  get value() {
    let min = this.current;
    for (let i = 0; i < this.filled; i++) if (this.mins[i] < min) min = this.mins[i];
    return min;
  }
  reset() { this.mins.fill(Infinity); this.current = Infinity; this.age = 0; this.filled = 0; }
}

export class AudioAnalyzer {
  readonly config: AnalyzerConfig;
  readonly features: AudioFeatures;
  readonly edges: Float64Array;
  readonly centres: Float64Array;
  /** 0 (only clearly loud sound counts) … 1 (quiet sound counts too). Default 0.5. */
  sensitivity = 0.5;
  private readonly fft: RealFft;
  private readonly ring: Float32Array;
  private readonly window: Float32Array;
  private readonly spectrum: Float32Array;
  private readonly powers: Float32Array;
  private readonly targets: Float32Array;
  private readonly previous: Float32Array;
  private readonly tilt: Float32Array;
  private readonly bandFloors: RollingMinimum[];
  private readonly floor: RollingMinimum;
  private readonly region: Uint8Array;
  private written = 0;
  private analysed = 0;
  private sinceSamples = Infinity;
  private quiet = 0;
  private peak = -60;
  private bandRef = -60;
  private fluxMean = 0;
  private fluxVar = 0;
  private sinceBeat = Infinity;
  private voiceFor = 0;
  private unvoicedFor = Infinity;

  constructor(readonly sampleRate: number, config: Partial<AnalyzerConfig> = {}) {
    if (!(sampleRate >= 8_000 && sampleRate <= 384_000)) throw new Error("sample-rate");
    this.config = { ...analyzerDefaults, ...config };
    const c = this.config;
    this.fft = new RealFft(c.fftSize);
    this.ring = new Float32Array(c.fftSize * 2);
    this.window = new Float32Array(c.fftSize);
    this.spectrum = new Float32Array(c.fftSize / 2 + 1);
    this.edges = logBandEdges(c.bands, c.minHz, Math.min(c.maxHz, sampleRate / 2 * 0.98));
    this.centres = bandCentres(this.edges);
    this.powers = new Float32Array(c.bands);
    this.targets = new Float32Array(c.bands);
    this.previous = new Float32Array(c.bands);
    this.tilt = new Float32Array(c.bands);
    this.region = new Uint8Array(c.bands);
    for (let b = 0; b < c.bands; b++) {
      const f = this.centres[b];
      this.tilt[b] = c.tilt * Math.max(0, Math.log2(f / 1000));
      this.region[b] = f < 250 ? 0 : f < 2000 ? 1 : 2;
    }
    this.bandFloors = Array.from({ length: c.bands }, () => new RollingMinimum(c.floorWindows, c.floorWindow));
    this.floor = new RollingMinimum(c.floorWindows, c.floorWindow);
    this.features = createFeatures(c.bands);
  }

  /** The analyser's clock: seconds of audio received so far. */
  get time() { return this.written / this.sampleRate; }
  /** Diagnostics: the noise floor and the loudness reference, in dBFS. */
  get floorDb() { return this.noiseFloor(); }
  get peakDb() { return this.peak; }

  private noiseFloor() { return Math.max(this.config.floorMin, Math.min(this.config.floorMax, this.floor.value)); }

  /** Appends mono samples (any length). Non-finite samples count as 0. */
  push(samples: ArrayLike<number>) {
    const ring = this.ring, n = ring.length;
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i];
      ring[(this.written + i) % n] = Number.isFinite(value) ? value : 0;
    }
    this.written += samples.length;
    if (samples.length) this.sinceSamples = 0;
  }

  /**
   * The newest window of samples, as an AnalyserNode gives it (it overlaps the last one): the ring ends with exactly
   * these samples and the clock advances by `advance` samples (the time since the last window).
   */
  pushWindow(window: ArrayLike<number>, advance: number) {
    const ring = this.ring, n = ring.length, count = Math.min(window.length, n);
    const step = Math.max(1, Math.round(advance));
    this.written += step;
    for (let i = 0; i < count; i++) {
      const value = window[window.length - count + i];
      ring[(((this.written - count + i) % n) + n) % n] = Number.isFinite(value) ? value : 0;
    }
    this.sinceSamples = 0;
  }

  /** Mixes interleaved or planar channels down to mono first (convenience for multi-channel sources). */
  pushChannels(channels: readonly ArrayLike<number>[]) {
    if (channels.length === 1) { this.push(channels[0]); return; }
    const length = Math.min(...channels.map(channel => channel.length));
    const mono = new Float32Array(length);
    for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
    this.push(mono);
  }

  /** Forgets everything heard (a new source, a device change). */
  reset() {
    this.ring.fill(0); this.written = this.analysed = 0; this.sinceSamples = Infinity; this.quiet = 0;
    this.peak = this.bandRef = -60; this.fluxMean = this.fluxVar = 0; this.sinceBeat = Infinity; this.voiceFor = 0; this.unvoicedFor = Infinity;
    this.targets.fill(0); this.previous.fill(0); this.floor.reset();
    for (const floor of this.bandFloors) floor.reset();
    const bands = this.features.bands;
    bands.fill(0);
    Object.assign(this.features, createFeatures(0), { bands, t: 0 });
  }

  /** The features for the newest audio, `dt` seconds after the previous call (smoothing is in seconds, not frames). */
  analyze(elapsed: number): AudioFeatures {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    const c = this.config, f = this.features, size = c.fftSize;
    this.sinceSamples += dt;
    // The beat pulse falls away first, so a beat found in this frame reads 1.
    f.beat *= Math.exp(-dt / c.beat.decay);
    const fresh = this.written > this.analysed;
    const stale = this.sinceSamples > c.stale || this.written === 0;
    const gate = c.gate.insensitive + (c.gate.sensitive - c.gate.insensitive) * clamp01(this.sensitivity);
    let db = SILENT_DB;
    if (fresh && !stale) {
      // The newest `size` samples, oldest first.
      const ring = this.ring, n = ring.length, start = this.written - size;
      for (let i = 0; i < size; i++) { const at = start + i; this.window[i] = at >= 0 ? ring[at % n] : 0; }
      this.analysed = this.written;
      let sum = 0;
      const half = size >> 1;
      for (let i = half; i < size; i++) sum += this.window[i] * this.window[i];
      f.rms = Math.sqrt(sum / half);
      db = toDb(f.rms * f.rms);
      this.floor.push(db, dt);
      this.fft.power(this.window, this.spectrum);
      bandPowers(this.spectrum, this.sampleRate, size, this.edges, this.powers);
      for (let b = 0; b < c.bands; b++) this.bandFloors[b].push(toDb(this.powers[b]) + this.tilt[b], dt);
    } else if (stale) {
      f.rms = 0;
    } else {
      db = toDb(f.rms * f.rms);
    }
    const floor = this.noiseFloor();
    const threshold = floor + gate;
    const audible = !stale && db > threshold;
    this.quiet = audible ? 0 : this.quiet + dt;
    f.silent = this.quiet >= c.silenceHold;

    // Loudness with automatic gain: the reference jumps to a new peak and sinks slowly, never into the gate.
    this.peak = Math.max(db, this.peak - c.peakDecay * dt, threshold + c.minRange, c.peakMin);
    const loud = audible ? clamp01((db - threshold) / (this.peak - threshold)) ** 0.8 : 0;
    f.level = ease(f.level, f.silent ? 0 : loud, loud > f.level ? c.levelAttack : c.levelRelease, dt);

    // Bands: tilt-compensated dB against an adaptive spectral reference, minus each band's own steady noise.
    let top = SILENT_DB, total = 0, speech = 0, weighted = 0, logSum = 0, counted = 0;
    if (fresh && audible) {
      for (let b = 0; b < c.bands; b++) {
        const p = this.powers[b];
        const value = toDb(p) + this.tilt[b];
        if (value > top) top = value;
        total += p;
        if (this.centres[b] >= 150 && this.centres[b] <= 4000) speech += p;
        weighted += p * b / Math.max(1, c.bands - 1);
        if (p > 1e-14) { logSum += Math.log(p); counted++; }
      }
      this.bandRef = Math.max(top, this.bandRef - c.peakDecay * dt, threshold);
      let flux = 0;
      for (let b = 0; b < c.bands; b++) {
        const value = toDb(this.powers[b]) + this.tilt[b];
        const bandFloor = Math.max(c.floorMin - 20, Math.min(this.bandFloors[b].value, c.floorMax + this.tilt[b]));
        const base = Math.max(this.bandRef - c.range, bandFloor + 6);
        const target = clamp01((value - base) / Math.max(6, this.bandRef - base));
        flux += Math.max(0, target - this.previous[b]);
        this.previous[b] = target;
        this.targets[b] = target;
      }
      flux /= c.bands;
      f.speech = total > 0 ? speech / total : 0;
      f.centroid = total > 0 ? weighted / total : 0;
      f.flatness = counted && total > 0 ? clamp01(Math.exp(logSum / counted) / (total / counted)) : 0;
      // Onsets: flux against its own recent mean and spread; a beat is a strong, spaced onset.
      const deviation = Math.sqrt(Math.max(0, this.fluxVar));
      f.onset = clamp01((flux - this.fluxMean) / (deviation * 3 + 0.02));
      this.sinceBeat += dt;
      if (flux > this.fluxMean + c.beat.deviations * deviation && flux > c.beat.minFlux && this.sinceBeat >= c.beat.minInterval && loud > 0.1) {
        f.beat = 1; this.sinceBeat = 0;
      }
      const k = 1 - Math.exp(-dt / 1.2);
      const delta = flux - this.fluxMean;
      this.fluxMean += delta * k;
      this.fluxVar = (1 - k) * (this.fluxVar + delta * delta * k);
    } else if (!fresh && !stale && !f.silent) {
      // No new samples since the last frame (a faster render loop than the source): the targets stand.
      this.sinceBeat += dt;
    } else {
      this.targets.fill(0); this.previous.fill(0);
      f.onset = 0; f.speech *= Math.exp(-dt * 4); this.sinceBeat += dt;
    }
    if (f.silent) this.targets.fill(0);

    // Each region: half its mean, half its strongest band, so one loud bass note reads as bass as clearly as a broad rumble.
    const sum = [0, 0, 0], peak = [0, 0, 0], count = [0, 0, 0];
    for (let b = 0; b < c.bands; b++) {
      const v = ease(f.bands[b], this.targets[b], this.targets[b] > f.bands[b] ? c.attack : c.release, dt);
      f.bands[b] = v;
      const r = this.region[b];
      sum[r] += v; count[r]++; if (v > peak[r]) peak[r] = v;
    }
    const region = (r: number) => count[r] ? (sum[r] / count[r] + peak[r]) / 2 : 0;
    f.bass = region(0); f.mid = region(1); f.treble = region(2);

    // Voice activity: loud enough and mostly in the speech range, held through syllable gaps.
    const voiced = !f.silent && f.level > c.voice.minLevel && f.speech > c.voice.minSpeech;
    this.voiceFor = voiced ? this.voiceFor + dt : 0;
    this.unvoicedFor = voiced ? 0 : this.unvoicedFor + dt;
    f.voice = f.voice ? this.unvoicedFor < c.voice.hangover : this.voiceFor >= c.voice.attack;
    f.t = this.time;
    return f;
  }
}
