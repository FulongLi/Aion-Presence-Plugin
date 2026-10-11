import { frameSize, project, unproject, wrapLon, type Frame, type GeoProjection } from "./projection";

/**
 * Which part of a region to frame, and the frame. Pure spherical geometry, so nothing here has a seam at the date
 * line: a polygon is a set of unit vectors, distances are angles.
 *
 * Countries are often scattered (the United States: the contiguous states, Alaska, Hawaii, territories across the
 * Pacific). Framing all of it would shrink what the user asked about to a speck. The primary extent is the largest
 * part plus every part within reach of it — reach grows with the region's size and is taken step by step, so an
 * archipelago (Indonesia, Japan, the Philippines) chains together, while far territories (Alaska, Hawaii, French
 * Guiana, the Canaries, Svalbard) stay out unless a marker asks for them.
 */
export type GeoRing = [number, number][];
/** A polygon: its outer ring, then any holes. */
export type GeoPolygon = GeoRing[];

const RAD = Math.PI / 180;
type Vec = [number, number, number];
export const unit = (lon: number, lat: number): Vec => {
  const l = lon * RAD, p = lat * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Angle between two unit vectors, in degrees. */
export const angle = (a: Vec, b: Vec) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / RAD;
const toLonLat = (v: Vec): [number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [Math.atan2(v[1], v[0]) / RAD, Math.asin(Math.max(-1, Math.min(1, v[2] / length))) / RAD];
};

/** Spherical area of a ring (steradians), from its local equal-area projection. */
export function ringArea(ring: GeoRing): number {
  if (ring.length < 3) return 0;
  const centre = toLonLat(ring.reduce<Vec>((sum, [lon, lat]) => { const v = unit(lon, lat); return [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]]; }, [0, 0, 0]));
  const p: GeoProjection = { kind: "laea", lon0: centre[0], lat0: centre[1] };
  let area = 0, previous = project(ring[ring.length - 1][0], ring[ring.length - 1][1], p);
  for (const [lon, lat] of ring) {
    const next = project(lon, lat, p);
    if (previous && next) area += previous[0] * next[1] - next[0] * previous[1];
    previous = next;
  }
  return Math.abs(area) / 2;
}

export interface PolygonInfo { index: number; area: number; centre: Vec; radius: number; points: Vec[] }

/** Area, centre, angular radius and sampled points of each polygon's outer ring. */
export function describePolygons(polygons: readonly GeoPolygon[]): PolygonInfo[] {
  return polygons.map((polygon, index) => {
    const outer = polygon[0] ?? [];
    const points = outer.map(([lon, lat]) => unit(lon, lat));
    const sum = points.reduce<Vec>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
    const length = Math.hypot(...sum) || 1;
    const centre: Vec = [sum[0] / length, sum[1] / length, sum[2] / length];
    const radius = points.reduce((max, v) => Math.max(max, angle(centre, v)), 0);
    // Large rings are compared through a subsample: gaps are measured in degrees, a few hundred points are plenty.
    const step = Math.max(1, Math.floor(points.length / 400));
    return { index, area: ringArea(outer), centre, radius, points: points.filter((_, k) => k % step === 0) };
  });
}

/** Smallest angle between two polygons (degrees), via their sampled points; quick when their caps are far apart. */
function gap(a: PolygonInfo, b: PolygonInfo, limit: number): number {
  const apart = angle(a.centre, b.centre) - a.radius - b.radius;
  if (apart > limit) return apart;
  let best = Infinity;
  for (const p of a.points) for (const q of b.points) { const d = angle(p, q); if (d < best) best = d; }
  return best;
}

/** Reach for a region whose main part has this angular radius (degrees). */
export const reachFor = (radius: number) => Math.max(2, radius * 0.2);

/**
 * The primary extent: the indices of the polygons to frame. The largest polygon, then repeatedly any polygon within
 * reach of one already included. `include` are points (e.g. markers) that must be in view: a polygon containing or
 * near one of them is included too.
 */
export function primaryExtent(polygons: readonly GeoPolygon[], include: readonly [number, number][] = []): number[] {
  const info = describePolygons(polygons).filter(item => item.points.length >= 3);
  if (!info.length) return [];
  const main = info.reduce((best, item) => item.area > best.area ? item : best);
  const reach = reachFor(main.radius);
  const chosen = new Set([main.index]);
  const frontier = [main];
  while (frontier.length) {
    const from = frontier.pop()!;
    for (const item of info) {
      if (chosen.has(item.index)) continue;
      if (gap(from, item, reach) <= reach) { chosen.add(item.index); frontier.push(item); }
    }
  }
  // A marker far from the main part brings its own part into view (Honolulu brings Hawaii).
  for (const [lon, lat] of include) {
    const v = unit(lon, lat);
    let nearest: PolygonInfo | null = null, distance = Infinity;
    for (const item of info) {
      const d = Math.min(...item.points.map(p => angle(p, v)));
      if (d < distance) { distance = d; nearest = item; }
    }
    if (nearest && distance < 2) chosen.add(nearest.index);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** The centre of a set of polygons (area-weighted) and markers, as (lon, lat). */
export function centreOf(polygons: readonly GeoPolygon[], points: readonly [number, number][] = []): [number, number] {
  const info = describePolygons(polygons);
  const sum: Vec = [0, 0, 0];
  const total = info.reduce((s, item) => s + item.area, 0) || 1;
  for (const item of info) for (let k = 0; k < 3; k++) sum[k] += item.centre[k] * item.area / total;
  // Markers pull the centre only a little; they are framed by the bounds, not by moving the projection to them.
  for (const [lon, lat] of points) { const v = unit(lon, lat); for (let k = 0; k < 3; k++) sum[k] += v[k] * 0.05; }
  if (Math.hypot(...sum) < 1e-9) return [0, 0];
  return toLonLat(sum);
}

/**
 * The frame around polygons and points: a projection centred on them, the bounds of everything projected, and a
 * margin. A view never collapses to nothing (a city is framed with some land around it).
 */
export function frameAround(polygons: readonly GeoPolygon[], points: readonly [number, number][] = [], options: { margin?: number; minSpan?: number; projection?: GeoProjection } = {}): Frame {
  const [lon0, lat0] = centreOf(polygons, points);
  const projection = options.projection ?? { kind: "laea", lon0, lat0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (lon: number, lat: number) => {
    const xy = project(lon, lat, projection);
    if (!xy) return;
    x0 = Math.min(x0, xy[0]); x1 = Math.max(x1, xy[0]); y0 = Math.min(y0, xy[1]); y1 = Math.max(y1, xy[1]);
  };
  for (const polygon of polygons) for (const [lon, lat] of polygon[0] ?? []) add(lon, lat);
  for (const [lon, lat] of points) add(lon, lat);
  if (!Number.isFinite(x0)) { x0 = y0 = -0.01; x1 = y1 = 0.01; }
  // At least minSpan (radians on the sphere, ≈ 1/57 per degree) in each direction, then the margin.
  const minSpan = options.minSpan ?? 0.012;
  const grow = (lo: number, hi: number) => { const mid = (lo + hi) / 2, half = Math.max(minSpan, hi - lo) / 2; return [mid - half, mid + half]; };
  [x0, x1] = grow(x0, x1); [y0, y1] = grow(y0, y1);
  const margin = (options.margin ?? 0.06) * Math.max(x1 - x0, y1 - y0);
  return { projection, x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
}

/** A frame for a window given in degrees (west, south, east, north; east may be less than west across the date line). */
export function frameForWindow(west: number, south: number, east: number, north: number, projection?: GeoProjection): Frame {
  const span = ((east - west) % 360 + 360) % 360 || 360;
  const lon0 = wrapLon(west + span / 2), lat0 = (south + north) / 2;
  const p = projection ?? { kind: "laea", lon0, lat0 };
  const edge: [number, number][] = [];
  for (let k = 0; k <= 32; k++) {
    const lon = west + span * k / 32, lat = south + (north - south) * k / 32;
    edge.push([lon, south], [lon, north], [west, lat], [west + span, lat]);
  }
  return frameAround([[edge]], [], { projection: p, margin: 0 });
}

/** The (lon, lat) bounding window of a frame, sampled along its edges: for tile planning. Longitudes may exceed 180. */
export function frameWindow(frame: Frame): { west: number; east: number; south: number; north: number } {
  const lons: number[] = [], lats: number[] = [];
  const { width, height } = frameSize(frame);
  for (let k = 0; k <= 48; k++) for (const [fx, fy] of [[k / 48, 0], [k / 48, 1], [0, k / 48], [1, k / 48], [k / 48, 0.5], [0.5, k / 48]]) {
    const geo = unproject(frame.x0 + fx * width, frame.y0 + fy * height, frame.projection);
    if (geo) { lons.push(geo[0]); lats.push(geo[1]); }
  }
  // A pole inside the frame: every longitude is in view.
  for (const pole of [90, -90]) {
    const xy = project(0, pole, frame.projection);
    if (xy && xy[0] >= frame.x0 && xy[0] <= frame.x1 && xy[1] >= frame.y0 && xy[1] <= frame.y1) { lats.push(pole); lons.push(-180, 180); }
  }
  // Longitudes relative to the frame's centre, so a window across the date line is one interval.
  const centre = frame.projection.lon0;
  const relative = lons.map(lon => wrapLon(lon - centre));
  const west = centre + Math.min(...relative), east = centre + Math.max(...relative);
  return { west, east: Math.min(east, west + 360), south: Math.max(-90, Math.min(...lats)), north: Math.min(90, Math.max(...lats)) };
}
