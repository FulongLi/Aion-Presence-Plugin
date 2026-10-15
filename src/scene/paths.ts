import type { SceneNode, Vec3 } from "./ir";
import { add, length, lerp, mul, normalize, sub } from "./math";

/**
 * Paths (v0.5): the polyline every path-like node stands for — a line, a polyline, a smooth curve, a tube's centre line,
 * a circle (in the x–z plane) or a helix (about y) — in the node's own frame. The scene compiler draws exactly these
 * points and animations follow exactly these points, so what moves along a curve stays on the curve that is drawn.
 */
export interface SampledPath { points: Vec3[]; closed: boolean; lengths: number[]; total: number }

/** A uniform Catmull–Rom spline through `points`, `perSegment` samples per segment. */
export function catmullRom(points: Vec3[], closed: boolean, perSegment = 12): Vec3[] {
  if (points.length < 3 && !closed) return points.map(p => [...p] as Vec3);
  const n = points.length, out: Vec3[] = [];
  const at = (i: number) => closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
  const segments = closed ? n : n - 1;
  for (let s = 0; s < segments; s++) {
    const p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map(i => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3)) as Vec3);
    }
  }
  if (!closed) out.push([...points[n - 1]] as Vec3);
  return out;
}

/** The points a path-like node stands for (local frame), or null for nodes that are not paths. */
export function pathPoints(node: SceneNode): { points: Vec3[]; closed: boolean } | null {
  switch (node.type) {
    case "line": return { points: [node.from!, node.to!], closed: false };
    case "polyline": return { points: node.points!.map(p => [...p] as Vec3), closed: node.closed === true };
    case "curve": case "tube": return { points: catmullRom(node.points!, node.closed === true), closed: node.closed === true };
    case "circle": {
      const r = node.radius!, segments = 128, points: Vec3[] = [];
      for (let i = 0; i < segments; i++) { const a = (i / segments) * Math.PI * 2; points.push([r * Math.cos(a), 0, -r * Math.sin(a)]); }
      return { points, closed: true };
    }
    case "helix": {
      const steps = Math.max(16, Math.ceil(node.turns! * 64)), points: Vec3[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, a = t * node.turns! * Math.PI * 2;
        points.push([node.radius! * Math.cos(a), (t - 0.5) * node.height!, -node.radius! * Math.sin(a)]);
      }
      return { points, closed: false };
    }
    default: return null;
  }
}

export function samplePath(points: Vec3[], closed: boolean): SampledPath {
  const all = closed && points.length > 2 ? [...points, points[0]] : points;
  const lengths = [0];
  for (let i = 1; i < all.length; i++) lengths.push(lengths[i - 1] + length(sub(all[i], all[i - 1])));
  return { points: all, closed, lengths, total: lengths[lengths.length - 1] };
}

/** Where on a sampled path a fraction 0…1 of its length is, and the direction it runs there. */
export function pointAt(path: SampledPath, fraction: number): { position: Vec3; tangent: Vec3 } {
  const { points, lengths, total } = path;
  if (points.length === 1 || total <= 0) return { position: [...points[0]] as Vec3, tangent: [1, 0, 0] };
  const f = path.closed ? ((fraction % 1) + 1) % 1 : Math.max(0, Math.min(1, fraction));
  const d = f * total;
  let lo = 0, hi = lengths.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] <= d) lo = mid; else hi = mid; }
  const span = lengths[hi] - lengths[lo] || 1;
  const t = (d - lengths[lo]) / span;
  return { position: lerp(points[lo], points[hi], t), tangent: normalize(sub(points[hi], points[lo])) };
}

/** The centre of a set of points (for framing). */
export const centroid = (points: Vec3[]): Vec3 => points.length ? mul(points.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / points.length) : [0, 0, 0];
