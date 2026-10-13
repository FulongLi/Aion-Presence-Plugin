/**
 * The circular audio spectrum (v0.4.2): Aion's particles leave the sphere and become a ring of particle bars around a
 * smaller core, each angle following one frequency band of the real audio. This is its CPU reference (the canvas
 * fallback and the tests); physics/ring.ts is the same expression in TSL for the GPU.
 *
 *   bass (bottom) ── mirrored left and right ── treble (top)
 *   low frequencies   a slow swell of the whole ring and the core, and the tallest, slowest bars
 *   mid frequencies   a travelling ripple around the ring
 *   high frequencies  small, fast shimmer at the bars' tips
 *   particles flow slowly round the ring and ride the spectrum's outline as they pass through it.
 *
 * The bars are a particle density, not rectangles: most grains sit near the ring, fewer reach the tips.
 */
export const RING_BANDS = 32;

/** The two ring layouts: the spectrum (ring first, a small core) and hybrid (the full sphere inside a lighter ring). */
export const RING_LAYOUTS = {
  spectrum: { radius: 1.3, height: 0.8, core: 0.3, coreScale: 0.42 },
  hybrid: { radius: 1.66, height: 0.5, core: 0.62, coreScale: 0.93 },
} as const;

export interface RingParams { radius: number; height: number; core: number; coreScale: number; flow: number }

export const ringParams = (layout: number, flow = 0.08): RingParams => {
  const a = RING_LAYOUTS.spectrum, b = RING_LAYOUTS.hybrid, t = Math.max(0, Math.min(1, layout));
  return { radius: a.radius + (b.radius - a.radius) * t, height: a.height + (b.height - a.height) * t, core: a.core + (b.core - a.core) * t, coreScale: a.coreScale + (b.coreScale - a.coreScale) * t, flow };
};

export interface RingAudio { bands: ArrayLike<number>; bass: number; mid: number; treble: number; beat: number; gain: number }

const fract = (x: number) => x - Math.floor(x);
/** The same stable per-grain hashes as the GPU (a grain's rest position picks them). */
export const ringHash = (x: number, y: number, z: number, a: number, b: number, c: number, k: number) => fract(Math.sin(x * a + y * b + z * c) * k);
export const RING_HASHES = [[12.91, 78.23, 37.71, 43758.55], [39.35, 11.13, 83.17, 24634.63], [73.11, 52.37, 19.91, 31871.23], [27.17, 61.73, 47.29, 17375.91]] as const;

/** The ring layer's per-grain stagger (as ringWeight on the GPU). */
export const RING_STAGGER = [53.7, 29.3, 61.1, 19642.3491] as const;

/** The band value at a position 0 (bass) … 1 (treble), interpolated between bands. */
export function bandAt(bands: ArrayLike<number>, position: number): number {
  const n = bands.length;
  const p = Math.max(0, Math.min(1, position)) * (n - 1), i = Math.floor(p), f = p - i;
  return (bands[i] ?? 0) * (1 - f) + (bands[Math.min(n - 1, i + 1)] ?? 0) * f;
}

/** Where on the spectrum an angle (radians, 0 = right, anticlockwise) is: 0 at the bottom (bass) … 1 at the top. */
export function spectrumPosition(theta: number): number {
  const a = fract((theta + Math.PI / 2) / (Math.PI * 2) + 0.5) * Math.PI * 2 - Math.PI;
  return Math.abs(a) / Math.PI;
}

export interface RingPoint { position: [number, number, number]; energy: number; core: boolean }

/** A grain's place in the ring (or the core), from its sphere rest position, at clock `t`. */
export function ringPoint(rest: readonly [number, number, number], params: RingParams, audio: RingAudio, t: number, out?: RingPoint): RingPoint {
  const [x, y, z] = rest;
  const h = RING_HASHES.map(([a, b, c, k]) => ringHash(x, y, z, a, b, c, k));
  const point = out ?? { position: [0, 0, 0], energy: 0, core: false };
  const g = audio.gain;
  if (h[0] < params.core) {
    const s = params.coreScale * (1 + audio.bass * 0.08 * g + audio.beat * 0.05 * g);
    point.position[0] = x * s; point.position[1] = y * s; point.position[2] = z * s;
    point.energy = audio.bass * 0.5; point.core = true;
    return point;
  }
  const theta = Math.atan2(y, x) + t * params.flow * (0.4 + h[1] * 0.6);
  const value = bandAt(audio.bands, spectrumPosition(theta));
  const row = Math.pow(h[2], 1.6);
  const base = params.radius * (1 + audio.bass * 0.07 * g) + audio.beat * 0.05 * g;
  const wave = Math.sin(theta * 6 - t * 3) * audio.mid * 0.05 * g;
  const shimmer = Math.sin(t * 23 + h[3] * 60) * audio.treble * 0.025 * g * row;
  const radius = base + row * Math.min(1.1, value * params.height * g) + (h[3] - 0.5) * 0.05 + wave + shimmer;
  point.position[0] = Math.cos(theta) * radius;
  point.position[1] = Math.sin(theta) * radius;
  point.position[2] = (h[1] - 0.5) * 0.16 + Math.sin(theta * 3 + t * 0.7) * 0.04;
  point.energy = value * (0.4 + row * 0.6);
  point.core = false;
  return point;
}

/**
 * The sphere moved by sound (v0.4.2), for music played or shared while the body stays a sphere: it breathes with the
 * loudness, pulses on beats, carries waves whose height follows the band at each latitude (bass at the bottom pole,
 * treble at the top), a ripple with the mids and a fine shiver with the treble. Bounded, so the sphere stays a sphere.
 * CPU reference of physics/audioField.ts; returns the radial and tangential displacement for a grain.
 */
export interface SphereAudio extends RingAudio { level: number; weight: number }

export function sphereAudioOffset(rest: readonly [number, number, number], audio: SphereAudio, t: number): [number, number, number] {
  const [x, y, z] = rest, length = Math.hypot(x, y, z) || 1, nx = x / length, ny = y / length, nz = z / length;
  const g = audio.gain * audio.weight;
  if (g <= 0) return [0, 0, 0];
  const position = 1 - Math.acos(Math.max(-1, Math.min(1, ny))) / Math.PI;
  const band = bandAt(audio.bands, position);
  const longitude = Math.atan2(nz, nx);
  const waves = band * 0.07 * (0.6 + 0.4 * Math.sin(longitude * 7 + t * 2.2 + position * 5));
  const ripple = Math.sin((x * 0.3 + y + z * 0.2) * 4 - t * 5) * audio.mid * 0.025;
  const radial = (audio.level * 0.05 + audio.beat * 0.06 + waves + ripple) * g;
  const shiver = audio.treble * 0.02 * g;
  return [nx * radial + Math.sin(t * 17 + y * 9) * shiver, ny * radial + Math.sin(t * 19 + z * 9) * shiver, nz * radial + Math.sin(t * 13 + x * 9) * shiver];
}
