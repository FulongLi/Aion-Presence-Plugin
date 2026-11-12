import type { ModelParticles } from "./sampler";

/**
 * The particle bundle (v0.9, media type application/vnd.aion.particles): a converted model as the body receives it —
 * never the model itself. Compact and validated on both sides:
 *
 *   "AIPM" · version u8 (1) · flags u8 · frames u16 · count u32 · extent f32 · fps f32
 *   positions  int16 × 3 × count   (× extent / 32767)
 *   colours    u8 × 3 × count      (sRGB)
 *   shade      u8 × count
 *   frames × (int16 × 3 × count)   (flag 1: an animation clip baked from the model's own skeleton, see animation.ts)
 *
 * 50,000 particles are about 0.5 MB; a 24-frame clip adds 0.3 MB a frame.
 */
export const PARTICLES_MIME = "application/vnd.aion.particles";
export const BUNDLE_LIMITS = { count: 200_000, frames: 96 };
const MAGIC = [0x41, 0x49, 0x50, 0x4d]; // AIPM
const HEADER = 20;

export interface ParticleBundle extends ModelParticles {
  /** Baked animation frames (positions only, in the same order), or none. */
  frames: Float32Array[];
  fps: number;
}

export class BundleError extends Error { constructor(readonly detail: string) { super("particles-invalid"); this.name = "BundleError"; } }

/**
 * v0.9.1: the quantization range is the true extent of the rest pose *and every frame* (never just the rest pose's
 * normalized radius). An animated model reaches beyond its rest pose — the Fox's nose and tail when it runs, up to 1.92
 * against 1.75 — and clamping those coordinates flattened its nose and cut its tail tip.
 */
export function boundsOf(bundle: Pick<ParticleBundle, "positions" | "frames" | "count">): number {
  let extent = 0;
  for (const values of [bundle.positions, ...bundle.frames]) for (let i = 0; i < bundle.count * 3; i++) { const v = Math.abs(values[i]); if (v > extent) extent = v; }
  return extent;
}

export function encodeBundle(bundle: ParticleBundle): Uint8Array {
  const { count } = bundle;
  const extent = Math.max(bundle.extent, boundsOf(bundle) * 1.0001);
  if (!(count > 0 && count <= BUNDLE_LIMITS.count) || !(extent > 0 && extent <= 10) || bundle.frames.length > BUNDLE_LIMITS.frames) throw new BundleError("The bundle is out of range.");
  const frameBytes = count * 6;
  const out = new Uint8Array(HEADER + count * 10 + bundle.frames.length * frameBytes);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = 1; out[5] = bundle.frames.length ? 1 : 0;
  view.setUint16(6, bundle.frames.length, true);
  view.setUint32(8, count, true);
  view.setFloat32(12, extent, true);
  view.setFloat32(16, bundle.fps || 0, true);
  const quantize = (positions: Float32Array, at: number) => {
    for (let i = 0; i < count * 3; i++) view.setInt16(at + i * 2, Math.round(Math.max(-1, Math.min(1, positions[i] / extent)) * 32767), true);
  };
  quantize(bundle.positions, HEADER);
  out.set(bundle.colors.subarray(0, count * 3), HEADER + count * 6);
  out.set(bundle.shade.subarray(0, count), HEADER + count * 9);
  bundle.frames.forEach((frame, f) => quantize(frame, HEADER + count * 10 + f * frameBytes));
  return out;
}

export const isParticleBundle = (bytes: Uint8Array) => bytes.length >= HEADER && MAGIC.every((b, i) => bytes[i] === b);

export function decodeBundle(bytes: Uint8Array): ParticleBundle {
  if (!isParticleBundle(bytes)) throw new BundleError("Not a particle bundle.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[4] !== 1) throw new BundleError("Unknown bundle version.");
  const frameCount = view.getUint16(6, true), count = view.getUint32(8, true), extent = view.getFloat32(12, true), fps = view.getFloat32(16, true);
  if (!(count > 0 && count <= BUNDLE_LIMITS.count)) throw new BundleError("The particle count is out of range.");
  if (!(extent > 0 && extent <= 10) || !Number.isFinite(fps) || fps < 0 || fps > 120) throw new BundleError("The bundle header is invalid.");
  if (frameCount > BUNDLE_LIMITS.frames || (frameCount > 0) !== ((bytes[5] & 1) === 1)) throw new BundleError("The animation frames are invalid.");
  if (bytes.length !== HEADER + count * 10 + frameCount * count * 6) throw new BundleError("The bundle length does not match its header.");
  const read = (at: number) => {
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) out[i] = view.getInt16(at + i * 2, true) / 32767 * extent;
    return out;
  };
  const frames: Float32Array[] = [];
  for (let f = 0; f < frameCount; f++) frames.push(read(HEADER + count * 10 + f * count * 6));
  return {
    count, extent, fps, frames, positions: read(HEADER),
    colors: bytes.slice(HEADER + count * 6, HEADER + count * 9), shade: bytes.slice(HEADER + count * 9, HEADER + count * 10),
  };
}
