import { ResolveError } from "../errors";
import { frameSize, project, validFrame, type Frame } from "./projection";
import type { GeoPolygon } from "./extent";

/**
 * A map as Aion draws it: everything already projected through its frame into normalized map coordinates (the
 * frame's longer side −1…1, y up), so the surface only samples it. Four layers:
 *
 *   focus     the outline of what was asked for (a country's coast and borders, a city's boundary)   bright
 *   borders   the borders between the members of a group (the countries of a continent)            medium
 *   context   the neighbours around it (Canada and Mexico around the United States)                faint
 *   fill      the land of the focus (rings, even-odd), and of the context                           veils
 *
 * It travels to the surface as media ("AMP1" + JSON), like a height field, so snapshots stay small.
 */
export const MAP_MIME = "application/vnd.aion.map";
export interface GeoMap {
  v: 1;
  frame: Frame;
  label: string;
  focus: number[][];
  borders: number[][];
  context: number[][];
  fill: number[][];
  contextFill: number[][];
}

/** How far normalized map coordinates reach on the stage (world units), as the image and form samplers do. */
export const MAP_SCALE = 1.75;
/** A map point on the stage: flat, the focus a hair in front of its neighbours. */
export const mapWorldPoint = (nx: number, ny: number, z = 0): [number, number, number] => [nx * MAP_SCALE, ny * MAP_SCALE, z];

export const MAP_LIMITS = { vertices: 60_000, lines: 6_000, bytes: 4 * 1024 * 1024 };

/** The normalized rectangle a frame covers (the longer side −1…1). */
export function frameBounds(frame: Frame) {
  const { width, height, half } = frameSize(frame);
  return { x: width / 2 / half, y: height / 2 / half };
}

/** Is this segment one Natural Earth only drew to close a polygon (the date line, the South Pole), not a coast or a border? */
const seam = (a: [number, number], b: [number, number]) =>
  (Math.abs(a[0]) > 179.98 && Math.abs(b[0]) > 179.98 && Math.sign(a[0]) === Math.sign(b[0])) || (a[1] < -89.9 && b[1] < -89.9);

/**
 * A ring with long segments split (at most `step` degrees apart): a border that follows a parallel for thousands of
 * kilometres — the 49th parallel — is two points in the data but a curve on an azimuthal map.
 */
export function densify(ring: readonly [number, number][], step = 0.5, closed = true): [number, number][] {
  const out: [number, number][] = [];
  const count = closed ? ring.length : ring.length - 1;
  for (let i = 0; i < count; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push(a);
    const pieces = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step);
    // A segment across the date line in the data is a seam, never interpolated through the whole world.
    if (pieces > 1 && Math.abs(b[0] - a[0]) < 180) for (let k = 1; k < pieces; k++) out.push([a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces]);
  }
  if (!closed && ring.length) out.push(ring[ring.length - 1]);
  return out;
}

/**
 * Projects polygon outlines into clipped polylines in normalized map coordinates: broken where the projection does
 * not reach, at polygon seams, and at the frame's edge (with a small margin); vertices closer than `minStep` merged.
 */
export function outlineLines(polygons: readonly GeoPolygon[], frame: Frame, options: { minStep?: number; margin?: number } = {}): number[][] {
  const { half, cx, cy } = frameSize(frame);
  const bounds = frameBounds(frame), margin = options.margin ?? 0.03, minStep = options.minStep ?? 0.002;
  const xmin = -bounds.x - margin, xmax = bounds.x + margin, ymin = -bounds.y - margin, ymax = bounds.y + margin;
  const lines: number[][] = [];
  let line: number[] = [];
  const flush = () => { if (line.length >= 4) lines.push(line); line = []; };
  const push = (x: number, y: number) => {
    const n = line.length;
    if (n >= 2 && Math.hypot(x - line[n - 2], y - line[n - 1]) < minStep) return;
    line.push(x, y);
  };
  for (const polygon of polygons) for (const raw of polygon) {
    if (raw.length < 2) continue;
    const explicit = raw.length > 2 && raw[0][0] === raw[raw.length - 1][0] && raw[0][1] === raw[raw.length - 1][1];
    const ring = densify(explicit ? raw.slice(0, -1) : raw);
    const pts = ring.map(([lon, lat]) => { const xy = project(lon, lat, frame.projection); return xy ? [(xy[0] - cx) / half, (xy[1] - cy) / half] as [number, number] : null; });
    const count = ring.length;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % ring.length;
      const a = pts[i], b = pts[j];
      // A jump across the whole map (a world map's date line) is never a coastline.
      if (!a || !b || seam(ring[i], ring[j]) || Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.8) { flush(); continue; }
      // Liang–Barsky: the part of the segment inside the rectangle.
      let t0 = 0, t1 = 1;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const clip = (p: number, q: number) => {
        if (p === 0) return q >= 0;
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
      };
      if (!(clip(-dx, a[0] - xmin) && clip(dx, xmax - a[0]) && clip(-dy, a[1] - ymin) && clip(dy, ymax - a[1]))) { flush(); continue; }
      const sx = a[0] + dx * t0, sy = a[1] + dy * t0, ex = a[0] + dx * t1, ey = a[1] + dy * t1;
      const n = line.length;
      if (t0 > 0 || n < 2 || Math.hypot(sx - line[n - 2], sy - line[n - 1]) > 1e-9) { if (t0 > 0) flush(); push(sx, sy); }
      push(ex, ey);
      if (t1 < 1) flush();
    }
    flush();
  }
  return lines;
}

/** Polygon rings in normalized map coordinates, for fills (rings the projection cannot reach are left out). */
export function fillRings(polygons: readonly GeoPolygon[], frame: Frame, minStep = 0.003): number[][] {
  const { half, cx, cy } = frameSize(frame);
  const rings: number[][] = [];
  for (const polygon of polygons) for (const raw of polygon) {
    const ring = densify(raw);
    const out: number[] = [];
    let ok = true;
    for (const [lon, lat] of ring) {
      const xy = project(lon, lat, frame.projection);
      if (!xy) { ok = false; break; }
      const x = (xy[0] - cx) / half, y = (xy[1] - cy) / half, n = out.length;
      if (n >= 2 && Math.hypot(x - out[n - 2], y - out[n - 1]) < minStep) continue;
      out.push(x, y);
    }
    if (ok && out.length >= 6) rings.push(out);
  }
  return rings;
}

const MAGIC = "AMP1";
export function encodeMap(map: GeoMap): Uint8Array {
  const round = (lines: number[][]) => lines.map(line => line.map(v => Math.round(v * 1e5) / 1e5));
  const json = JSON.stringify({ ...map, focus: round(map.focus), borders: round(map.borders), context: round(map.context), fill: round(map.fill), contextFill: round(map.contextFill) });
  return new TextEncoder().encode(MAGIC + json);
}

export const isMapMedia = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x41 && bytes[1] === 0x4d && bytes[2] === 0x50 && bytes[3] === 0x31;

/** Bytes → a map, checked strictly (finite, bounded, sizes within limits). Throws "map-invalid". */
export function decodeMap(bytes: Uint8Array): GeoMap {
  const fail = (): never => { throw new ResolveError("map-invalid"); };
  if (!isMapMedia(bytes) || bytes.length > MAP_LIMITS.bytes) fail();
  let value: GeoMap;
  try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(4))) as GeoMap; } catch { return fail(); }
  if (!value || value.v !== 1 || !validFrame(value.frame) || typeof value.label !== "string" || value.label.length > 120) fail();
  let vertices = 0, count = 0;
  for (const key of ["focus", "borders", "context", "fill", "contextFill"] as const) {
    const lines = value[key];
    if (!Array.isArray(lines)) fail();
    for (const line of lines) {
      if (!Array.isArray(line) || line.length % 2 || line.length < 4 || !line.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1.5)) fail();
      vertices += line.length / 2; count++;
    }
  }
  if (vertices > MAP_LIMITS.vertices || count > MAP_LIMITS.lines) fail();
  return value;
}
