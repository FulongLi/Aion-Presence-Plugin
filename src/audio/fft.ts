/**
 * A small real-input FFT (iterative radix-2, precomputed twiddles and window) for the Audio Analysis Engine. It is
 * the only FFT in Aion: every audio source — the microphone, Codex's voice from the native bridge, a shared tab,
 * the Music Library's own playback — is reduced to features by the same code (see analyzer.ts).
 */
export const FFT_SIZES = [512, 1024, 2048, 4096] as const;
export type FftSize = typeof FFT_SIZES[number];

export class RealFft {
  readonly size: number;
  /** The Hann window, and the sum of its squares (to scale power so a full-scale sine reads about 0 dB). */
  readonly window: Float32Array;
  readonly windowPower: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 8 || (size & (size - 1)) !== 0) throw new Error("fft-size");
    this.size = size;
    this.re = new Float64Array(size); this.im = new Float64Array(size);
    this.cos = new Float64Array(size / 2); this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / size); this.sin[i] = Math.sin(-2 * Math.PI * i / size); }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
    this.window = new Float32Array(size);
    let power = 0;
    for (let i = 0; i < size; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size); this.window[i] = w; power += w * w; }
    this.windowPower = power;
  }

  /**
   * The one-sided power spectrum of `input` (its last `size` samples, windowed): `out[k]` for k = 0…size/2, scaled
   * so a sine of amplitude A gives about A²/2 summed over its bins (Parseval with the window's power).
   */
  power(input: ArrayLike<number>, out: Float32Array, windowed = true) {
    const n = this.size, re = this.re, im = this.im, offset = Math.max(0, input.length - n);
    for (let i = 0; i < n; i++) {
      const sample = i + offset < input.length ? input[i + offset] : 0;
      const value = Number.isFinite(sample) ? sample : 0;
      const j = this.reverse[i];
      re[j] = windowed ? value * this.window[i] : value; im[j] = 0;
    }
    for (let span = 1; span < n; span <<= 1) {
      const step = n / (span * 2);
      for (let start = 0; start < n; start += span * 2) {
        for (let k = 0; k < span; k++) {
          const c = this.cos[k * step], s = this.sin[k * step];
          const a = start + k, b = a + span;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    const scale = 2 / ((windowed ? this.windowPower : n) * n);
    for (let k = 0; k <= n / 2; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) * scale * (k === 0 || k === n / 2 ? 0.5 : 1);
    return out;
  }
}
