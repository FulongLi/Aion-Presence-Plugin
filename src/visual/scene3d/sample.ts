import { buildScene, type ScenePart } from "./geometry";
import type { Scene3D } from "./types";

/**
 * A scene's geometry → particle rest positions and tones. Surfaces are sampled evenly by area (uniform barycentric
 * points on area-weighted triangles); edges, rims and lines are sampled evenly by length as fine strokes, a little
 * brighter, so the shape's structure reads first. The whole scene is centred and scaled to the stage, so any units
 * work. Objects share the particles by visual size (√area plus length) and their weight; each particle picks its
 * object and its place from one stable sequence, so every quality tier (a prefix) shows the whole scene.
 */
export const SCENE_EXTENT = 1.75;
/** A stroke's Gaussian thickness on the stage (world units). */
const STROKE = 0.0055;

const random = (initial: number) => { let seed = initial; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };
function cumulative(values: number[]): Float64Array { const out = new Float64Array(values.length); let total = 0; values.forEach((v, i) => { total += v; out[i] = total; }); return out; }
function pick(distribution: Float64Array, value: number) {
  let lo = 0, hi = distribution.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (distribution[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

interface Prepared { part: ScenePart; areas: Float64Array; lengths: Float64Array; area: number; length: number }

function prepare(part: ScenePart): Prepared {
  const t = part.triangles, s = part.segments;
  const areas: number[] = [], lengths: number[] = [];
  for (let i = 0; i < t.length; i += 9) {
    const ax = t[i + 3] - t[i], ay = t[i + 4] - t[i + 1], az = t[i + 5] - t[i + 2];
    const bx = t[i + 6] - t[i], by = t[i + 7] - t[i + 1], bz = t[i + 8] - t[i + 2];
    areas.push(Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2);
  }
  for (let i = 0; i < s.length; i += 6) lengths.push(Math.hypot(s[i + 3] - s[i], s[i + 4] - s[i + 1], s[i + 5] - s[i + 2]));
  const a = cumulative(areas), l = cumulative(lengths);
  return { part, areas: a, lengths: l, area: a.length ? a[a.length - 1] : 0, length: l.length ? l[l.length - 1] : 0 };
}

export function sceneBounds(parts: ScenePart[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) for (const values of [part.triangles, part.segments]) {
    for (let i = 0; i < values.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], values[i + k]); max[k] = Math.max(max[k], values[i + k]); }
  }
  const centre = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
  let radius = 0;
  for (const part of parts) for (const values of [part.triangles, part.segments]) {
    for (let i = 0; i < values.length; i += 3) radius = Math.max(radius, Math.hypot(values[i] - centre[0], values[i + 1] - centre[1], values[i + 2] - centre[2]));
  }
  return { centre, radius };
}

export function sceneParticles(scene: Scene3D, count: number): { positions: Float32Array; tones: Float32Array } {
  const prepared = buildScene(scene).map(prepare).filter(p => p.area > 0 || p.length > 0);
  if (!prepared.length) throw new Error("empty-scene");
  const { centre, radius } = sceneBounds(prepared.map(p => p.part));
  if (!(radius > 0)) throw new Error("empty-scene");
  const scale = SCENE_EXTENT / radius;
  // Visual size in the scene's own units: surfaces by √area, strokes by length (a fine stroke needs fewer grains).
  const shares = cumulative(prepared.map(p => p.part.weight * (p.part.surfaceShare > 0 ? Math.sqrt(p.area) : 0) + p.part.weight * (p.part.surfaceShare < 1 ? p.length * 0.45 : 0)));
  const total = shares[shares.length - 1];
  const positions = new Float32Array(count * 3), tones = new Float32Array(count);
  const next = random(0x3d5ce);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  for (let i = 0; i < count; i++) {
    const p = prepared[pick(shares, next() * total)];
    const onSurface = p.area > 0 && (p.length === 0 || next() < p.part.surfaceShare);
    let x: number, y: number, z: number, tone: number;
    if (onSurface) {
      const t = p.part.triangles, k = pick(p.areas, next() * p.area) * 9;
      let r1 = next(), r2 = next();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      x = t[k] + (t[k + 3] - t[k]) * r1 + (t[k + 6] - t[k]) * r2;
      y = t[k + 1] + (t[k + 4] - t[k + 1]) * r1 + (t[k + 7] - t[k + 1]) * r2;
      z = t[k + 2] + (t[k + 5] - t[k + 2]) * r1 + (t[k + 8] - t[k + 2]) * r2;
      tone = p.part.tone * (0.5 + next() * 0.25);
    } else {
      const s = p.part.segments, k = pick(p.lengths, next() * p.length) * 6, f = next();
      x = s[k] + (s[k + 3] - s[k]) * f; y = s[k + 1] + (s[k + 4] - s[k + 1]) * f; z = s[k + 2] + (s[k + 5] - s[k + 2]) * f;
      tone = p.part.tone * (0.88 + next() * 0.12);
    }
    positions[i * 3] = (x - centre[0]) * scale + (onSurface ? 0 : gaussian() * STROKE);
    positions[i * 3 + 1] = (y - centre[1]) * scale + (onSurface ? 0 : gaussian() * STROKE);
    positions[i * 3 + 2] = (z - centre[2]) * scale + (onSurface ? 0 : gaussian() * STROKE);
    tones[i] = Math.max(0, Math.min(1, tone));
  }
  return { positions, tones };
}
