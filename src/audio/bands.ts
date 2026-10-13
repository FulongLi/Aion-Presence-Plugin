/**
 * Logarithmic frequency bands for visualization: equal width in octaves (as hearing and music are), so a bass line,
 * a voice and a cymbal each get a fair share of the ring instead of the treble taking most of a linear axis.
 */
export const BAND_DEFAULTS = { count: 32, minHz: 40, maxHz: 16_000 } as const;

/** Band edges in Hz: `count + 1` values from minHz to maxHz, geometrically spaced. */
export function logBandEdges(count: number = BAND_DEFAULTS.count, minHz: number = BAND_DEFAULTS.minHz, maxHz: number = BAND_DEFAULTS.maxHz): Float64Array {
  if (!Number.isInteger(count) || count < 1 || count > 256) throw new Error("band-count");
  if (!(minHz > 0 && maxHz > minHz)) throw new Error("band-range");
  const edges = new Float64Array(count + 1);
  const ratio = maxHz / minHz;
  for (let i = 0; i <= count; i++) edges[i] = minHz * Math.pow(ratio, i / count);
  return edges;
}

/** The geometric centre of each band. */
export function bandCentres(edges: ArrayLike<number>): Float64Array {
  const out = new Float64Array(edges.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(edges[i] * edges[i + 1]);
  return out;
}

/**
 * Mean power per band from a one-sided power spectrum (`power[k]` at k·sampleRate/fftSize Hz). A band narrower than
 * one bin (the lowest bands at a small FFT) takes the spectrum interpolated at its centre, so no band is ever empty.
 * Above Nyquist a band is 0.
 */
export function bandPowers(power: ArrayLike<number>, sampleRate: number, fftSize: number, edges: ArrayLike<number>, out: Float32Array): Float32Array {
  const binHz = sampleRate / fftSize, last = Math.floor(fftSize / 2);
  for (let b = 0; b < out.length; b++) {
    const lo = edges[b], hi = edges[b + 1];
    if (lo >= sampleRate / 2) { out[b] = 0; continue; }
    const first = Math.ceil(lo / binHz), end = Math.min(last, Math.ceil(hi / binHz) - 1);
    if (end >= first) {
      let sum = 0;
      for (let k = first; k <= end; k++) sum += power[k];
      // Power is summed over the band's bins (energy), so a pure tone reads the same in a wide or a narrow band.
      out[b] = sum;
    } else {
      const at = Math.sqrt(lo * hi) / binHz, k = Math.min(last - 1, Math.floor(at)), f = at - k;
      out[b] = power[k] * (1 - f) + power[k + 1] * f;
    }
  }
  return out;
}

/** Resamples a band array to another count (e.g. 32 analysis bands → 16 for the legacy speech uniforms). */
export function resampleBands(source: ArrayLike<number>, out: Float32Array): Float32Array {
  const n = source.length, m = out.length;
  if (!n) { out.fill(0); return out; }
  for (let i = 0; i < m; i++) {
    const from = i * n / m, to = (i + 1) * n / m;
    let sum = 0, weight = 0;
    for (let j = Math.floor(from); j < Math.ceil(to) && j < n; j++) {
      const w = Math.min(to, j + 1) - Math.max(from, j);
      if (w > 0) { sum += source[j] * w; weight += w; }
    }
    out[i] = weight ? sum / weight : 0;
  }
  return out;
}
