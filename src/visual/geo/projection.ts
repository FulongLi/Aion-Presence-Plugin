/**
 * Map projections for Aion's geography (pure, shared by the server, the samplers and the marker layer).
 *
 * Every region is drawn in a Lambert azimuthal equal-area projection centred on the region itself: areas are true,
 * shapes are faithful near the centre (a country, even a continent, keeps its familiar outline), north is up through
 * the centre, and — because longitudes are only ever taken relative to the centre — the international date line is
 * not a seam and the poles are ordinary points. The whole world uses Equal Earth (an equal-area world map).
 *
 * A Frame is a projection plus the window of it on show, in projected units (x east, y north; on the unit sphere).
 * The samplers and the marker layer place everything through the same frame, so a city's marker lands exactly where
 * the map, or the terrain, puts that latitude and longitude.
 */
export type GeoProjection =
  | { kind: "laea"; lon0: number; lat0: number }
  | { kind: "equal-earth"; lon0: number };

/** A projection and the window of it on show: x0 west … x1 east, y0 south … y1 north (projected units). */
export interface Frame { projection: GeoProjection; x0: number; y0: number; x1: number; y1: number }

const RAD = Math.PI / 180;
/** Longitude difference wrapped into (−180, 180]. */
export const wrapLon = (lon: number) => { const x = ((lon + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };

/** Equal Earth constants (Šavrič, Patterson & Jenny, 2018). */
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;

/** (lon, lat) in degrees → projected (x, y). Null where the projection does not reach (the far side of an azimuthal map). */
export function project(lon: number, lat: number, p: GeoProjection): [number, number] | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const phi = Math.max(-90, Math.min(90, lat)) * RAD;
  if (p.kind === "equal-earth") {
    const lambda = wrapLon(lon - p.lon0) * RAD;
    const theta = Math.asin(M * Math.sin(phi)), t2 = theta * theta, t6 = t2 * t2 * t2;
    const x = (2 * Math.sqrt(3) * lambda * Math.cos(theta)) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1));
    const y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
    return [x, y];
  }
  const lambda = wrapLon(lon - p.lon0) * RAD, phi0 = p.lat0 * RAD;
  const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda);
  // The antipode has no image; points beyond about 170° from the centre are not drawn.
  if (cosc < -0.985) return null;
  const k = Math.sqrt(2 / (1 + cosc));
  return [k * Math.cos(phi) * Math.sin(lambda), k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda))];
}

/** Projected (x, y) → (lon, lat) in degrees; null outside the projection's disc or band. */
export function unproject(x: number, y: number, p: GeoProjection): [number, number] | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (p.kind === "equal-earth") {
    // Newton's method for θ from y, as in the reference implementation.
    let theta = y;
    for (let i = 0; i < 12; i++) {
      const t2 = theta * theta, t6 = t2 * t2 * t2;
      const f = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - y;
      const df = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
      const step = f / df;
      theta -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    if (Math.abs(theta) > Math.asin(M) + 1e-9) return null;
    const t2 = theta * theta, t6 = t2 * t2 * t2;
    const lambda = (3 * x * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1)) / (2 * Math.sqrt(3) * Math.cos(theta));
    if (Math.abs(lambda) > Math.PI + 1e-9) return null;
    const lat = Math.asin(Math.max(-1, Math.min(1, Math.sin(theta) / M))) / RAD;
    return [wrapLon(p.lon0 + lambda / RAD), lat];
  }
  const rho = Math.hypot(x, y);
  if (rho > 2) return null;
  const phi0 = p.lat0 * RAD;
  if (rho < 1e-12) return [p.lon0, p.lat0];
  const c = 2 * Math.asin(rho / 2);
  const lat = Math.asin(Math.max(-1, Math.min(1, Math.cos(c) * Math.sin(phi0) + (y * Math.sin(c) * Math.cos(phi0)) / rho))) / RAD;
  const lon = p.lon0 + Math.atan2(x * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - y * Math.sin(phi0) * Math.sin(c)) / RAD;
  return [wrapLon(lon), lat];
}

/** The frame's size: its longer side spans −1…1 of the normalized map; aspect is width / height. */
export function frameSize(frame: Frame) {
  const width = frame.x1 - frame.x0, height = frame.y1 - frame.y0;
  return { width, height, half: Math.max(width, height) / 2, aspect: width / height, cx: (frame.x0 + frame.x1) / 2, cy: (frame.y0 + frame.y1) / 2 };
}

/** Projected → normalized map coordinates (the longer side −1…1, y up). */
export function toNormal(x: number, y: number, frame: Frame): [number, number] {
  const { half, cx, cy } = frameSize(frame);
  return [(x - cx) / half, (y - cy) / half];
}

/** (lon, lat) → normalized map coordinates through the frame; null where the projection does not reach. */
export function geoToNormal(lon: number, lat: number, frame: Frame): [number, number] | null {
  const xy = project(lon, lat, frame.projection);
  return xy ? toNormal(xy[0], xy[1], frame) : null;
}

/** Normalized map coordinates → (lon, lat). */
export function normalToGeo(nx: number, ny: number, frame: Frame): [number, number] | null {
  const { half, cx, cy } = frameSize(frame);
  return unproject(cx + nx * half, cy + ny * half, frame.projection);
}

/** Whether a frame is well formed (finite, non-degenerate, a known projection). */
export function validFrame(frame: unknown): frame is Frame {
  const f = frame as Frame;
  if (!f || typeof f !== "object" || !f.projection) return false;
  const p = f.projection;
  const projection = (p.kind === "laea" && Number.isFinite(p.lon0) && Number.isFinite(p.lat0) && Math.abs(p.lat0) <= 90 && Math.abs(p.lon0) <= 180)
    || (p.kind === "equal-earth" && Number.isFinite(p.lon0) && Math.abs(p.lon0) <= 180);
  return projection && [f.x0, f.y0, f.x1, f.y1].every(v => Number.isFinite(v) && Math.abs(v) <= 4) && f.x1 - f.x0 > 1e-6 && f.y1 - f.y0 > 1e-6;
}
