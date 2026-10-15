import type { HanziData } from "./codec";

/**
 * Chinese character geometry (v0.4.4): Hanzi Writer data → measured stroke outlines and centre lines in Aion's
 * normalized space. Pure; the same code validates the whole dataset at build time, prepares a character in the host
 * and in the page, so what was validated is exactly what is drawn.
 *
 * The em box is Hanzi Writer's: x 0…1024, y −124…900 (y up). Every character uses the same box, so proportions,
 * positions inside the square and relative sizes are the source font's — nothing is stretched to fill a bounding box.
 */
export const HANZI_EM = { left: 0, right: 1024, bottom: -124, top: 900, size: 1024, cx: 512, cy: 388 } as const;
/** Coordinates beyond this margin around the em box are a data defect. */
const BOUNDS_MARGIN = 160;

/** A flattened outline: rings of [x0, y0, x1, y1, …] (closed implicitly). */
export type Rings = number[][];

const subdivisions = (length: number) => Math.max(2, Math.min(16, Math.ceil(length / 22)));

/**
 * Flattens an outline path (M, L, Q, C, Z; absolute, space-separated, as upstream writes it) into rings, mapping each
 * point through `map`. Curves are subdivided by the length of their control polygon (about one point per 22 em units).
 */
export function flattenOutline(path: string, map: (x: number, y: number) => [number, number] = (x, y) => [x, y]): Rings {
  const tokens = path.trim().split(/\s+/);
  const rings: Rings = [];
  let ring: number[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const num = (i: number) => {
    const value = Number(tokens[i]);
    if (!Number.isFinite(value)) throw new Error("hanzi-path-invalid");
    return value;
  };
  const emit = (x: number, y: number) => { const [mx, my] = map(x, y); ring.push(mx, my); };
  for (let i = 0; i < tokens.length;) {
    const op = tokens[i++];
    switch (op) {
      case "M":
        if (ring.length >= 6) rings.push(ring);
        ring = [];
        cx = sx = num(i); cy = sy = num(i + 1); i += 2;
        emit(cx, cy);
        break;
      case "L": cx = num(i); cy = num(i + 1); i += 2; emit(cx, cy); break;
      case "Q": {
        const qx = num(i), qy = num(i + 1), x = num(i + 2), y = num(i + 3); i += 4;
        const n = subdivisions(Math.hypot(qx - cx, qy - cy) + Math.hypot(x - qx, y - qy));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          emit(u * u * cx + 2 * u * t * qx + t * t * x, u * u * cy + 2 * u * t * qy + t * t * y);
        }
        cx = x; cy = y;
        break;
      }
      case "C": {
        const ax = num(i), ay = num(i + 1), bx = num(i + 2), by = num(i + 3), x = num(i + 4), y = num(i + 5); i += 6;
        const n = subdivisions(Math.hypot(ax - cx, ay - cy) + Math.hypot(bx - ax, by - ay) + Math.hypot(x - bx, y - by));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          emit(u * u * u * cx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x, u * u * u * cy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y);
        }
        cx = x; cy = y;
        break;
      }
      case "Z":
        cx = sx; cy = sy;
        break;
      default: throw new Error("hanzi-path-invalid");
    }
  }
  if (ring.length >= 6) rings.push(ring);
  // Drop a closing point that repeats the first.
  for (const r of rings) {
    if (r.length >= 8 && Math.abs(r[0] - r[r.length - 2]) < 1e-9 && Math.abs(r[1] - r[r.length - 1]) < 1e-9) r.length -= 2;
  }
  return rings;
}

/** Signed area of a ring (positive anticlockwise). */
export function ringArea(ring: readonly number[]): number {
  let area = 0;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return area / 2;
}

/** Area enclosed by rings under the even-odd rule, approximated as |Σ signed areas| (strokes are single rings). */
export const outlineArea = (rings: Rings) => Math.abs(rings.reduce((sum, ring) => sum + ringArea(ring), 0));

/** Even-odd point-in-outline test. */
export function insideOutline(rings: Rings, x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[j * 2], yj = ring[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}

/** Bounds [minX, minY, maxX, maxY] of flat point lists. */
export function boundsOf(lists: readonly (readonly number[])[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const list of lists) for (let i = 0; i < list.length; i += 2) {
    x0 = Math.min(x0, list[i]); x1 = Math.max(x1, list[i]); y0 = Math.min(y0, list[i + 1]); y1 = Math.max(y1, list[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/** Length of a flat polyline. */
export function polylineLength(points: readonly number[]): number {
  let length = 0;
  for (let i = 2; i < points.length; i += 2) length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return length;
}

export interface HanziProblem { stroke?: number; problem: string }

/**
 * Every check a character must pass to be offered (and the build's coverage report): valid outline paths that close
 * into rings with area, ordered medians with finite points, one median per outline, coordinates inside the em box (with
 * a margin), radical strokes that exist, and a usable animation (each centre line runs inside or along its outline).
 */
export function validateHanzi(data: HanziData): HanziProblem[] {
  const problems: HanziProblem[] = [];
  if (!data.strokes.length) return [{ problem: "no strokes" }];
  if (data.strokes.length !== data.medians.length) problems.push({ problem: `${data.strokes.length} outlines but ${data.medians.length} medians` });
  const inBox = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y)
    && x >= HANZI_EM.left - BOUNDS_MARGIN && x <= HANZI_EM.right + BOUNDS_MARGIN && y >= HANZI_EM.bottom - BOUNDS_MARGIN && y <= HANZI_EM.top + BOUNDS_MARGIN;
  data.strokes.forEach((path, stroke) => {
    let rings: Rings;
    try { rings = flattenOutline(path); } catch { problems.push({ stroke, problem: "outline path cannot be parsed" }); return; }
    if (!/Z\s*$/.test(path.trim())) problems.push({ stroke, problem: "outline is not closed" });
    if (!rings.length) { problems.push({ stroke, problem: "outline has no ring" }); return; }
    if (!rings.every(ring => { for (let i = 0; i < ring.length; i += 2) if (!inBox(ring[i], ring[i + 1])) return false; return true; })) problems.push({ stroke, problem: "outline outside the em box" });
    if (!(outlineArea(rings) > 40)) problems.push({ stroke, problem: "outline has no area" });
    const median = data.medians[stroke];
    if (!median || !median.length) { problems.push({ stroke, problem: "no median" }); return; }
    if (!median.every(([x, y]) => inBox(x, y))) problems.push({ stroke, problem: "median outside the em box" });
    // The pen's path must belong to its stroke: most of the median lies inside the outline, or very near it.
    const near = median.filter(([x, y]) => insideOutline(rings, x, y) || distanceToRings(rings, x, y) < 60).length;
    if (near < Math.ceil(median.length * 0.6)) problems.push({ stroke, problem: "median does not follow its outline" });
  });
  if (data.radStrokes && !data.radStrokes.every(k => Number.isInteger(k) && k >= 0 && k < data.strokes.length)) problems.push({ problem: "radical strokes out of range" });
  return problems;
}

/** Distance from a point to the nearest ring edge. */
export function distanceToRings(rings: Rings, x: number, y: number): number {
  let best = Infinity;
  for (const ring of rings) for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    best = Math.min(best, distanceToSegment(x, y, ring[j * 2], ring[j * 2 + 1], ring[i * 2], ring[i * 2 + 1]).distance);
  }
  return best;
}

/** Distance from (x, y) to segment a→b, and the parameter t of the nearest point. */
export function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): { distance: number; t: number } {
  const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
  return { distance: Math.hypot(x - (ax + dx * t), y - (ay + dy * t)), t };
}
