import type { MapTile } from "../../protocol";

/**
 * The Route Explorer's pure geometry (v0.6): Web Mercator (the projection of OpenStreetMap's tiles) in "world pixels" at
 * zoom 0 (0…256 across the world), a view (a centre and a fractional zoom), the tiles a view needs, and the distance
 * scale and axis ticks of the profile. No DOM: tested directly.
 */
export const TILE_SIZE = 256;
export const MAP_ZOOM = { min: 2, max: 18 } as const;

export const worldX = (lon: number) => (lon + 180) / 360 * TILE_SIZE;
export const worldY = (lat: number) => {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_SIZE;
};
export const lonOf = (x: number) => x / TILE_SIZE * 360 - 180;
export const latOf = (y: number) => { const n = Math.PI - 2 * Math.PI * y / TILE_SIZE; return 180 / Math.PI * Math.atan(Math.sinh(n)); };

/** A map view: the centre in world pixels (zoom 0) and the zoom (fractional). */
export interface MapView { cx: number; cy: number; zoom: number }

/** Screen position of a world point, for a view and a canvas size (CSS pixels). */
export function toScreen(view: MapView, width: number, height: number, wx: number, wy: number): [number, number] {
  const k = 2 ** view.zoom;
  return [(wx - view.cx) * k + width / 2, (wy - view.cy) * k + height / 2];
}

export function toWorld(view: MapView, width: number, height: number, sx: number, sy: number): [number, number] {
  const k = 2 ** view.zoom;
  return [(sx - width / 2) / k + view.cx, (sy - height / 2) / k + view.cy];
}

export const clampZoom = (zoom: number) => Math.max(MAP_ZOOM.min, Math.min(MAP_ZOOM.max, zoom));

/** The view that frames a set of [lon, lat] points with `padding` CSS pixels around them. */
export function fitView(points: readonly (readonly [number, number])[], width: number, height: number, padding = 28, maxZoom = 16): MapView {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [lon, lat] of points) {
    const x = worldX(lon), y = worldY(lat);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) return { cx: 128, cy: 128, zoom: MAP_ZOOM.min };
  const w = Math.max(1e-9, x1 - x0), h = Math.max(1e-9, y1 - y0);
  const zoom = Math.log2(Math.min(Math.max(1, width - padding * 2) / w, Math.max(1, height - padding * 2) / h));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom: clampZoom(Math.min(maxZoom, zoom)) };
}

/** The tile zoom a view draws with (tiles are drawn at most about 1.4× their size). */
export const tileZoom = (view: MapView) => Math.max(0, Math.min(MAP_ZOOM.max, Math.round(view.zoom - 0.1)));

/** The tiles that cover a view at its tile zoom, nearest the centre first. */
export function tilesInView(view: MapView, width: number, height: number): MapTile[] {
  const z = tileZoom(view), n = 2 ** z, scale = 2 ** z / TILE_SIZE;
  const [wx0, wy0] = toWorld(view, width, height, 0, 0), [wx1, wy1] = toWorld(view, width, height, width, height);
  const tx0 = Math.floor(wx0 * scale), tx1 = Math.floor(wx1 * scale), ty0 = Math.max(0, Math.floor(wy0 * scale)), ty1 = Math.min(n - 1, Math.floor(wy1 * scale));
  const out: (MapTile & { d: number })[] = [];
  const cx = view.cx * scale, cy = view.cy * scale;
  for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
    if (x - tx0 > 16 || y - ty0 > 16) continue;
    out.push({ z, x: ((x % n) + n) % n, y, d: (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 });
  }
  return out.sort((a, b) => a.d - b.d).map(({ z: tz, x, y }) => ({ z: tz, x, y }));
}

export const tileKey = (t: MapTile) => `${t.z}/${t.x}/${t.y}`;

/** "Nice" axis ticks between min and max (about `count` of them). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** "12-30", "12 – 30 km", "12.5-14" → metres along the route, or null. */
export function parseSection(text: string, length: number): [number, number] | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:km)?\s*[-–—to]+\s*(\d+(?:\.\d+)?)\s*(?:km)?\s*$/i.exec(text);
  if (!match) return null;
  const a = Number(match[1]) * 1000, b = Number(match[2]) * 1000;
  const from = Math.max(0, Math.min(a, b)), to = Math.min(length, Math.max(a, b));
  return to - from >= 50 ? [from, to] : null;
}

/**
 * The point of a polyline (screen coordinates) nearest a screen position, and how far along the route it is: for the
 * pointer over the map. Null when nothing is within `radius` pixels.
 */
export function nearestAlong(screen: readonly (readonly [number, number])[], along: Float64Array, x: number, y: number, radius = 12): { distance: number; gap: number } | null {
  let best: { distance: number; gap: number } | null = null;
  for (let i = 1; i < screen.length; i++) {
    const [ax, ay] = screen[i - 1], [bx, by] = screen[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const gap = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (gap <= radius && (!best || gap < best.gap)) best = { distance: along[i - 1] + (along[i] - along[i - 1]) * t, gap };
  }
  return best;
}
