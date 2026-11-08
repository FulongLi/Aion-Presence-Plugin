import type { GltfModel } from "./gltf";
import type { SurfaceRefs } from "./sampler";

/**
 * Genuine model animation (v0.9, first version): a rigged glTF character's own animation clip, evaluated through its
 * skeleton (GltfModel: sampled TRS channels, linear blend skinning) at a fixed rate, and every particle re-placed on its
 * own spot of the moving surface (the triangle and barycentric weights it was sampled at). Nothing is invented: a model
 * without a skin and a clip has no animation, and Aion says so instead of distorting the static shape. The baked frames
 * travel in the particle bundle; the surface plays them as a loop (positions only — colours stay with their particles).
 */
export const ANIMATION_LIMITS = { fps: 15, frames: 48 };

export interface BakeOptions { animation: number; fps?: number; maxFrames?: number }

export function bakeAnimation(model: GltfModel, surface: SurfaceRefs, options: BakeOptions): { frames: Float32Array[]; fps: number; duration: number } {
  const info = model.animations[options.animation];
  if (!info) throw new Error("animation-unknown");
  if (!(info.duration > 0)) throw new Error("animation-empty");
  const maxFrames = Math.max(2, Math.min(ANIMATION_LIMITS.frames, options.maxFrames ?? ANIMATION_LIMITS.frames));
  let fps = Math.min(30, options.fps ?? ANIMATION_LIMITS.fps);
  let count = Math.max(2, Math.round(info.duration * fps));
  if (count > maxFrames) { count = maxFrames; fps = count / info.duration; }
  const frames: Float32Array[] = [];
  const m = surface.matrix;
  for (let f = 0; f < count; f++) {
    const geometry = model.geometry({ animation: options.animation, time: (f / count) * info.duration });
    const kept = surface.kept.map(i => geometry.primitives[i]);
    if (kept.some(p => !p)) throw new Error("animation-mismatch");
    const offsets = new Uint32Array(kept.length + 1);
    kept.forEach((p, i) => { offsets[i + 1] = offsets[i] + p.indices.length / 3; });
    const out = new Float32Array(surface.triangle.length * 3);
    for (let j = 0; j < surface.triangle.length; j++) {
      const tri = surface.triangle[j];
      let lo = 0, hi = kept.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (offsets[mid] <= tri) lo = mid; else hi = mid - 1; }
      const p = kept[lo], k = (tri - offsets[lo]) * 3;
      const a = p.indices[k] * 3, b = p.indices[k + 1] * 3, c = p.indices[k + 2] * 3;
      const r1 = surface.r1[j], r2 = surface.r2[j], w0 = 1 - r1 - r2;
      const x = p.positions[a] * w0 + p.positions[b] * r1 + p.positions[c] * r2;
      const y = p.positions[a + 1] * w0 + p.positions[b + 1] * r1 + p.positions[c + 1] * r2;
      const z = p.positions[a + 2] * w0 + p.positions[b + 2] * r1 + p.positions[c + 2] * r2;
      out[j * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[j * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[j * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    frames.push(out);
  }
  return { frames, fps, duration: info.duration };
}
