/**
 * Geographic routes (v0.6): one validated route document shared by everything that shows a route — the host that plans
 * it, the hub that keeps it, the particle terrain's overlay and the Route Explorer card. Pure (no DOM, no network), so
 * the card's sandbox, the page and the host validate and measure a route with exactly the same code.
 *
 * Conventions: coordinates are WGS 84 `[longitude, latitude]` in degrees (GeoJSON order); distances and elevations are
 * metres; durations seconds. `coordinates` is the provider's real geometry, simplified for display within a tolerance
 * the document states (never invented or straightened: see `simplifyRoute`). `elevationSamples` are `[distance along
 * the route, elevation]` pairs at a uniform spacing, read from an elevation model, not from the routing service.
 */
export const TRAVEL_MODES = ["walking", "cycling", "hiking"] as const;
export type TravelMode = typeof TRAVEL_MODES[number];

export interface RoutePlace { name: string; lat: number; lon: number }
/** A point on the route: how far along it is, where, and (when known) how high. */
export interface RoutePoint { distanceMeters: number; lon: number; lat: number; elevationMeters: number }

export interface GeoRoute {
  id: string;
  origin: RoutePlace;
  destination: RoutePlace;
  waypoints: RoutePlace[];
  travelMode: TravelMode;
  /** Who computed what: the routing service, the elevation model, and the attribution both require. */
  source: { routing: string; elevation: string; attribution: string };
  coordinates: [number, number][];
  /** The largest distance (m) the displayed geometry may stray from the provider's own (simplification). */
  toleranceMeters: number;
  distanceMeters: number;
  estimatedDurationSeconds: number;
  elevationSamples: [number, number][];
  sampleSpacingMeters: number;
  /** Null when no elevation could be read for the route (the route itself is still real). */
  totalAscentMeters: number | null;
  totalDescentMeters: number | null;
  minimumElevationMeters: number | null;
  maximumElevationMeters: number | null;
  highest: RoutePoint | null;
  lowest: RoutePoint | null;
  warnings: string[];
}

export const ROUTE_LIMITS = {
  coordinates: 1500,
  samples: 600,
  waypoints: 8,
  name: 60,
  warnings: 6,
  warning: 200,
  /** The whole document as JSON (it travels in hub commands, snapshots and one Card Bridge message). */
  bytes: 44 * 1024,
  /** Longest route Aion shows (every provider limits far below this). */
  distanceMeters: 2_000_000,
} as const;

/** Elevation statistics' method (documented in docs/ROUTE-EXPLORER.md). */
export const ELEVATION_METHOD = {
  /** Centred moving average over this distance before ascent and descent are summed. */
  smoothingMeters: 120,
  /** A climb or descent counts once the smoothed profile has moved this far from the last turning point. */
  hysteresisMeters: 5,
} as const;

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversine(a: readonly [number, number], b: readonly [number, number]): number {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distance along the line at each vertex (the first is 0). */
export function cumulative(coordinates: readonly (readonly [number, number])[]): Float64Array {
  const out = new Float64Array(coordinates.length);
  for (let i = 1; i < coordinates.length; i++) out[i] = out[i - 1] + haversine(coordinates[i - 1], coordinates[i]);
  return out;
}

/** The point `distance` metres along the line (clamped to its ends). */
export function pointAlong(coordinates: readonly (readonly [number, number])[], along: Float64Array, distance: number): [number, number] {
  const n = coordinates.length;
  if (!n) return [0, 0];
  if (distance <= 0 || n === 1) return [coordinates[0][0], coordinates[0][1]];
  if (distance >= along[n - 1]) return [coordinates[n - 1][0], coordinates[n - 1][1]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (along[mid] <= distance) lo = mid; else hi = mid; }
  const span = along[hi] - along[lo], t = span > 0 ? (distance - along[lo]) / span : 0;
  return [coordinates[lo][0] + (coordinates[hi][0] - coordinates[lo][0]) * t, coordinates[lo][1] + (coordinates[hi][1] - coordinates[lo][1]) * t];
}

/** Points every `spacing` metres along the line, both ends included. */
export function resample(coordinates: readonly (readonly [number, number])[], spacing: number): { distance: number; point: [number, number] }[] {
  const along = cumulative(coordinates), total = along[along.length - 1] ?? 0;
  const count = Math.max(1, Math.round(total / spacing));
  return Array.from({ length: count + 1 }, (_, i) => { const distance = total * i / count; return { distance, point: pointAlong(coordinates, along, distance) }; });
}

/**
 * Douglas–Peucker in local metres: every vertex kept is one of the provider's own, and no point of the original line is
 * further than `tolerance` metres from the simplified one. The ends are always kept.
 */
export function simplifyRoute(coordinates: readonly [number, number][], tolerance: number): [number, number][] {
  const n = coordinates.length;
  if (n <= 2 || tolerance <= 0) return coordinates.map(c => [c[0], c[1]]);
  const lat0 = coordinates.reduce((sum, c) => sum + c[1], 0) / n * RAD, kx = Math.cos(lat0) * R * RAD, ky = R * RAD;
  const x = coordinates.map(c => c[0] * kx), y = coordinates.map(c => c[1] * ky);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const dx = x[b] - x[a], dy = y[b] - y[a], len2 = dx * dx + dy * dy;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x[i] - x[a]) * dx + (y[i] - y[a]) * dy) / len2)) : 0;
      const ex = x[a] + dx * t - x[i], ey = y[a] + dy * t - y[i], d = ex * ex + ey * ey;
      if (d > worst) { worst = d; at = i; }
    }
    if (at >= 0 && worst > tolerance * tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return coordinates.filter((_, i) => keep[i]).map(c => [c[0], c[1]]);
}

/** The finest simplification (from 1 m, doubling) that fits `max` vertices, and its tolerance. */
export function simplifyToLimit(coordinates: readonly [number, number][], max: number = ROUTE_LIMITS.coordinates): { coordinates: [number, number][]; tolerance: number } {
  if (coordinates.length <= max) return { coordinates: coordinates.map(c => [c[0], c[1]]), tolerance: 0 };
  for (let tolerance = 1; ; tolerance *= 1.5) {
    const simplified = simplifyRoute(coordinates, tolerance);
    if (simplified.length <= max) return { coordinates: simplified, tolerance: Math.round(tolerance * 10) / 10 };
  }
}

export interface ElevationStats {
  ascent: number; descent: number; min: number; max: number;
  highestIndex: number; lowestIndex: number;
  smoothed: number[];
}

/**
 * Ascent, descent and extremes from a uniformly spaced profile. Raw elevation models jitter by a few metres between
 * neighbouring cells; summing every wiggle would overstate the climbing badly. So the profile is first smoothed (a
 * centred moving average over `smoothingMeters`), then a climb or descent is counted only once it has moved
 * `hysteresisMeters` from the last turning point. Extremes are the raw samples' own (smoothing lowers summits).
 */
export function elevationStats(samples: readonly (readonly [number, number])[], options: { smoothingMeters?: number; hysteresisMeters?: number } = {}): ElevationStats | null {
  const n = samples.length;
  if (n < 2) return null;
  const spacing = (samples[n - 1][0] - samples[0][0]) / (n - 1);
  const half = spacing > 0 ? Math.max(0, Math.round((options.smoothingMeters ?? ELEVATION_METHOD.smoothingMeters) / spacing / 2)) : 0;
  const smoothed: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) { sum += samples[k][1]; count++; }
    smoothed.push(sum / count);
  }
  const threshold = options.hysteresisMeters ?? ELEVATION_METHOD.hysteresisMeters;
  let ascent = 0, descent = 0, anchor = smoothed[0];
  for (let i = 1; i < n; i++) {
    const delta = smoothed[i] - anchor;
    if (delta >= threshold) { ascent += delta; anchor = smoothed[i]; }
    else if (delta <= -threshold) { descent -= delta; anchor = smoothed[i]; }
  }
  // The last partial move (below the threshold) still belongs to the route.
  const tail = smoothed[n - 1] - anchor;
  if (tail > 0) ascent += tail; else descent -= tail;
  let highestIndex = 0, lowestIndex = 0;
  for (let i = 1; i < n; i++) {
    if (samples[i][1] > samples[highestIndex][1]) highestIndex = i;
    if (samples[i][1] < samples[lowestIndex][1]) lowestIndex = i;
  }
  return { ascent, descent, min: samples[lowestIndex][1], max: samples[highestIndex][1], highestIndex, lowestIndex, smoothed };
}

/** The steepest sustained climb: the window of at least `minMeters` with the greatest average gradient (rise / run). */
export function steepestClimb(samples: readonly (readonly [number, number])[], minMeters = 500): { from: number; to: number; gradient: number } | null {
  if (samples.length < 2) return null;
  const total = samples[samples.length - 1][0] - samples[0][0];
  const window = Math.min(minMeters, total);
  if (window <= 0) return null;
  let best: { from: number; to: number; gradient: number } | null = null;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    while (j < samples.length - 1 && samples[j][0] - samples[i][0] < window) j++;
    const run = samples[j][0] - samples[i][0];
    if (run < window * 0.999) break;
    const gradient = (samples[j][1] - samples[i][1]) / run;
    if (!best || gradient > best.gradient) best = { from: samples[i][0], to: samples[j][0], gradient };
  }
  return best && best.gradient > 0 ? best : null;
}

/** The route's bounding box: west, south, east, north (degrees). */
export function routeBox(coordinates: readonly (readonly [number, number])[]): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of coordinates) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat); }
  return [west, south, east, north];
}

/** The elevation at a distance along the route, from its samples (linear between them). */
export function elevationAt(route: Pick<GeoRoute, "elevationSamples">, distance: number): number | null {
  const s = route.elevationSamples;
  if (!s.length) return null;
  if (distance <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (s[i][0] >= distance) { const t = (distance - s[i - 1][0]) / Math.max(1e-9, s[i][0] - s[i - 1][0]); return s[i - 1][1] + (s[i][1] - s[i - 1][1]) * t; }
  }
  return s[s.length - 1][1];
}

/** The route's own geometry measured: distance along it at each displayed vertex, scaled to the provider's length. */
export function routeAlong(route: Pick<GeoRoute, "coordinates" | "distanceMeters">): Float64Array {
  const along = cumulative(route.coordinates), total = along[along.length - 1];
  // The displayed line is a little shorter than the provider's (simplification): positions are scaled to its length.
  if (total > 0 && route.distanceMeters > 0) { const k = route.distanceMeters / total; for (let i = 0; i < along.length; i++) along[i] *= k; }
  return along;
}

/** The point at `distance` metres along the route (on its displayed geometry). */
export function routePointAt(route: Pick<GeoRoute, "coordinates" | "distanceMeters">, distance: number, along: Float64Array = routeAlong(route)): [number, number] {
  return pointAlong(route.coordinates, along, distance);
}

// ── Validation ────────────────────────────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const line = (value: unknown, max: number) => typeof value === "string" && value.trim() === value && value.length > 0 && Array.from(value).length <= max && !CONTROL.test(value);
const lonLat = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && finite(value[0], -180, 180) && finite(value[1], -90, 90);
const KEYS = ["id", "origin", "destination", "waypoints", "travelMode", "source", "coordinates", "toleranceMeters", "distanceMeters", "estimatedDurationSeconds",
  "elevationSamples", "sampleSpacingMeters", "totalAscentMeters", "totalDescentMeters", "minimumElevationMeters", "maximumElevationMeters", "highest", "lowest", "warnings"];

function placeProblem(p: unknown, what: string): string | null {
  if (!isRecord(p) || Object.keys(p).some(k => !["name", "lat", "lon"].includes(k))) return `${what} must be {name, lat, lon}`;
  if (!line(p.name, ROUTE_LIMITS.name)) return `${what}.name must be one line of at most ${ROUTE_LIMITS.name} characters`;
  if (!finite(p.lat, -90, 90) || !finite(p.lon, -180, 180)) return `${what} must have a real latitude and longitude`;
  return null;
}

function pointProblem(p: unknown, what: string, distance: number): string | null {
  if (p === null) return null;
  if (!isRecord(p) || Object.keys(p).some(k => !["distanceMeters", "lon", "lat", "elevationMeters"].includes(k))) return `${what} must be a route point`;
  if (!finite(p.distanceMeters, 0, distance + 1) || !finite(p.lon, -180, 180) || !finite(p.lat, -90, 90) || !finite(p.elevationMeters, -500, 9000)) return `${what} is out of range`;
  return null;
}

export type RouteCheck = { ok: true; route: GeoRoute } | { ok: false; problem: string };

/**
 * Validates a route document strictly: known fields only, real coordinates, a continuous line (no jump an actual path
 * could not make between consecutive vertices), monotonic elevation samples within the route, bounded sizes. A route
 * from a provider is validated before it is shown; the hub and the card validate it again.
 */
export function validateRoute(raw: unknown): RouteCheck {
  const bad = (problem: string): RouteCheck => ({ ok: false, problem });
  if (!isRecord(raw)) return bad("a route must be an object");
  const unknown = Object.keys(raw).find(k => !KEYS.includes(k));
  if (unknown) return bad(`unknown field ${unknown}`);
  let bytes: number;
  try { bytes = JSON.stringify(raw).length; } catch { return bad("a route must be plain JSON"); }
  if (bytes > ROUTE_LIMITS.bytes) return bad(`the route document is too large (${bytes} > ${ROUTE_LIMITS.bytes} bytes)`);
  if (typeof raw.id !== "string" || !/^r[a-z0-9]{6,24}$/.test(raw.id)) return bad("id must be r followed by 6–24 letters or digits");
  for (const [key, value] of [["origin", raw.origin], ["destination", raw.destination]] as const) { const p = placeProblem(value, key); if (p) return bad(p); }
  if (!Array.isArray(raw.waypoints) || raw.waypoints.length > ROUTE_LIMITS.waypoints) return bad(`waypoints: at most ${ROUTE_LIMITS.waypoints}`);
  for (const [i, w] of raw.waypoints.entries()) { const p = placeProblem(w, `waypoints[${i}]`); if (p) return bad(p); }
  if (!(TRAVEL_MODES as readonly unknown[]).includes(raw.travelMode)) return bad(`travelMode must be one of ${TRAVEL_MODES.join(", ")}`);
  const source = raw.source;
  if (!isRecord(source) || Object.keys(source).some(k => !["routing", "elevation", "attribution"].includes(k)) || !line(source.routing, 80) || !line(source.elevation, 120) || !line(source.attribution, 160)) return bad("source must name the routing service, the elevation model and the attribution");
  if (!finite(raw.distanceMeters, 1, ROUTE_LIMITS.distanceMeters)) return bad("distanceMeters must be a positive length");
  if (!finite(raw.estimatedDurationSeconds, 0, 30 * 86_400)) return bad("estimatedDurationSeconds is out of range");
  if (!finite(raw.toleranceMeters, 0, 1000)) return bad("toleranceMeters is out of range");
  const coordinates = raw.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > ROUTE_LIMITS.coordinates) return bad(`coordinates: 2–${ROUTE_LIMITS.coordinates} [lon, lat] pairs`);
  if (!coordinates.every(lonLat)) return bad("coordinates must be [longitude, latitude] pairs in degrees");
  const along = cumulative(coordinates);
  const length = along[along.length - 1];
  // The displayed line (simplified) is never longer than the route, nor much shorter than it.
  if (length > raw.distanceMeters * 1.02 + 50 || length < raw.distanceMeters * 0.5 - 50) return bad("the coordinates do not match the route's distance");
  // A path never jumps: no segment may cover more than half the route or 25 km, whichever is less (simplified lines
  // across open country and ferry crossings still pass; a straight line from A to B does not, unless it is that short).
  const maxSegment = Math.max(250, Math.min(25_000, raw.distanceMeters / 2));
  for (let i = 1; i < coordinates.length; i++) if (along[i] - along[i - 1] > maxSegment && coordinates.length > 2) return bad(`the line jumps ${Math.round((along[i] - along[i - 1]) / 1000)} km between two points`);
  if (coordinates.length === 2 && raw.distanceMeters > 250) return bad("a route longer than 250 m is never a straight line of two points");
  const samples = raw.elevationSamples;
  if (!Array.isArray(samples) || samples.length > ROUTE_LIMITS.samples) return bad(`elevationSamples: at most ${ROUTE_LIMITS.samples}`);
  let last = -1;
  for (const s of samples) {
    if (!Array.isArray(s) || s.length !== 2 || !finite(s[0], 0, raw.distanceMeters + 1) || !finite(s[1], -500, 9000) || s[0] <= last) return bad("elevationSamples must be [distance, elevation] pairs, distance increasing along the route");
    last = s[0];
  }
  if (!finite(raw.sampleSpacingMeters, 0, 100_000)) return bad("sampleSpacingMeters is out of range");
  const stat = (value: unknown, min: number, max: number) => value === null || finite(value, min, max);
  if (!stat(raw.totalAscentMeters, 0, 100_000) || !stat(raw.totalDescentMeters, 0, 100_000) || !stat(raw.minimumElevationMeters, -500, 9000) || !stat(raw.maximumElevationMeters, -500, 9000)) return bad("elevation statistics are out of range");
  if (samples.length === 0 && [raw.totalAscentMeters, raw.totalDescentMeters, raw.minimumElevationMeters, raw.maximumElevationMeters, raw.highest, raw.lowest].some(v => v !== null)) return bad("elevation statistics need elevation samples");
  for (const key of ["highest", "lowest"] as const) { const p = pointProblem(raw[key], key, raw.distanceMeters); if (p) return bad(p); }
  if (!Array.isArray(raw.warnings) || raw.warnings.length > ROUTE_LIMITS.warnings || !raw.warnings.every(w => line(w, ROUTE_LIMITS.warning))) return bad(`warnings: at most ${ROUTE_LIMITS.warnings} short lines`);
  return { ok: true, route: structuredClone(raw) as unknown as GeoRoute };
}

/** "76.0 km", "850 m". */
export function formatDistance(meters: number): string {
  return meters >= 10_000 ? `${(meters / 1000).toFixed(1)} km` : meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

/** "4 h 20 min", "35 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
}

/** Climbing is reported to the nearest 5 m: an elevation model cannot honestly say more. */
export const roundClimb = (meters: number) => Math.round(meters / 5) * 5;
