import { ResolveError } from "../../../visual/errors";
import { frameWindow } from "../../../visual/geo/extent";
import { project, unproject } from "../../../visual/geo/projection";
import { regionFrame, resolveRegion, type GeoRegion } from "../../geo/region";
import { decodeTerrarium, downsampleGrid, heightFieldLimits, rasterizePolygon, type TerrainSource } from "../../../visual/heightfield";
import type { Raster, TerrainStyle } from "../../../visual/types";
import { fetchImage, fetchJSON, HOSTS, type Fetcher } from "../net";
import { decodePng } from "../png";

export interface TerrainProvider {
  readonly name: string;
  /** `include`: points (markers) that must be in view. */
  resolve(region: string, style: TerrainStyle, signal: AbortSignal, options?: { include?: [number, number][] }): Promise<TerrainSource>;
}

/**
 * Real elevation for any named place, keyless (SCF's sources/terrain.ts, run in the local MCP process):
 *
 *   region name ─► the region (Aion's offline world: continents, countries, their parts; else Nominatim/Photon)
 *               ─► its equal-area frame (see visual/geo) ─► the longitude/latitude window it covers
 *               ─► AWS Terrain Tiles ("terrarium" PNG, metres in RGB, Web Mercator) ─► mosaic
 *               ─► resampled into the frame ─► elevation grid, masked by the region's outline
 *
 * Resampling into the region's own equal-area frame means high latitudes keep their true shape (Mercator would stretch
 * Svalbard fourfold), a continent is never cropped, and the date line is not a seam. The grid carries its frame so a
 * marker's latitude and longitude land on the right cell. Bounded: at most 16 tiles, a grid of at most 160 cells a
 * side. Only the region name goes to a geocoder (and only when the offline world does not know it); the tiles are
 * fetched by coordinates. Web Mercator tiles stop at ±85.05°: nearer the poles there is no data (Antarctica's
 * interior is shown up to that latitude).
 */
export type Box = { west: number; south: number; east: number; north: number };
/** The v0.3 place shape (a box and outline rings), still accepted from an injected locator. */
export interface Place { label: string; box: Box; rings?: [number, number][][]; provider: string }

export const terrainLimits = { maxTiles: 16, maxPixels: 640, maxZoom: 12, minSpan: 0.25, pointSpan: 0.8, tileBytes: 1024 * 1024, mercatorLat: 85.0511 };
const TILE_URL = (z: number, x: number, y: number) => `https://${HOSTS.elevation}/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

type NominatimHit = { display_name?: string; name?: string; boundingbox?: string[]; geojson?: { type: string; coordinates: unknown } };
type PhotonFeature = { properties?: { name?: string; country?: string; extent?: number[] }; geometry?: { coordinates?: number[] } };

function polygonRings(geojson: NominatimHit["geojson"]): [number, number][][] | undefined {
  if (!geojson) return undefined;
  const ring = (value: unknown) => Array.isArray(value)
    ? value.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]] as [number, number])
    : [];
  if (geojson.type === "Polygon" && Array.isArray(geojson.coordinates)) return (geojson.coordinates as unknown[]).map(ring).filter(r => r.length > 2);
  if (geojson.type === "MultiPolygon" && Array.isArray(geojson.coordinates)) {
    return (geojson.coordinates as unknown[]).flatMap(polygon => Array.isArray(polygon) ? polygon.map(ring) : []).filter(r => r.length > 2);
  }
  return undefined;
}

/** Expands point-like boxes to a visible span and keeps latitudes on the globe. Large boxes are kept whole (never cropped). */
export function normalizeBox(box: Box): Box {
  const west = box.west;
  let east = box.east;
  if (east < west) east += 360; // crosses the antimeridian
  const south = Math.max(-90, Math.min(90, box.south)), north = Math.max(-90, Math.min(90, box.north));
  const point = east - west < 0.02 && north - south < 0.02;
  const minimum = point ? terrainLimits.pointSpan : terrainLimits.minSpan;
  const grow = (lo: number, hi: number, span: number) => { const mid = (lo + hi) / 2, half = Math.max(span, hi - lo) / 2; return [mid - half, mid + half]; };
  const [w, e] = grow(west, east, minimum), [s, n] = grow(south, north, minimum);
  return { west: w, east: e, south: Math.max(-90, s), north: Math.min(90, n) };
}

export async function geocode(region: string, signal: AbortSignal, request?: Fetcher): Promise<Place> {
  let failure: unknown = null;
  try {
    const url = new URL(`https://${HOSTS.nominatim}/search`);
    url.search = new URLSearchParams({ q: region, format: "jsonv2", limit: "1", polygon_geojson: "1", polygon_threshold: "0.01" }).toString();
    // Nominatim's usage policy asks apps to identify themselves: the request carries the plugin's User-Agent.
    const { data } = await fetchJSON<NominatimHit[]>(url, { hosts: [HOSTS.nominatim], signal, request });
    const hit = Array.isArray(data) ? data[0] : undefined;
    const b = hit?.boundingbox?.map(Number);
    if (hit && b && b.length === 4 && b.every(Number.isFinite)) {
      return { label: (hit.name || hit.display_name || region).slice(0, 80), box: { south: b[0], north: b[1], west: b[2], east: b[3] }, rings: polygonRings(hit.geojson), provider: "nominatim" };
    }
  } catch (error) { signal.throwIfAborted(); failure = error; }
  try {
    const url = new URL(`https://${HOSTS.photon}/api/`);
    url.search = new URLSearchParams({ q: region, limit: "1" }).toString();
    const { data } = await fetchJSON<{ features?: PhotonFeature[] }>(url, { hosts: [HOSTS.photon], signal, request });
    const feature = data.features?.[0];
    const e = feature?.properties?.extent, c = feature?.geometry?.coordinates;
    if (e?.length === 4 && e.every(Number.isFinite)) {
      return { label: (feature?.properties?.name ?? region).slice(0, 80), box: { west: e[0], north: e[1], east: e[2], south: e[3] }, provider: "photon" };
    }
    if (c?.length === 2 && c.every(Number.isFinite)) {
      return { label: (feature?.properties?.name ?? region).slice(0, 80), box: { west: c[0], east: c[0], south: c[1], north: c[1] }, provider: "photon" };
    }
  } catch (error) { signal.throwIfAborted(); failure = error; }
  throw new ResolveError(failure ? "geocoder-unavailable" : "region-not-found");
}

/** Web Mercator world pixel coordinates at zoom z (256-pixel tiles). */
export const mercatorX = (lon: number, z: number) => (lon + 180) / 360 * 256 * 2 ** z;
export const mercatorY = (lat: number, z: number) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};

/** The most detailed zoom whose pixel window and tile count stay within bounds. */
export function planTiles(window: Box) {
  const box = { ...window, south: Math.max(-terrainLimits.mercatorLat, window.south), north: Math.min(terrainLimits.mercatorLat, window.north) };
  for (let z = terrainLimits.maxZoom; z >= 0; z--) {
    const x0 = mercatorX(box.west, z), x1 = mercatorX(box.east, z), y0 = mercatorY(box.north, z), y1 = mercatorY(box.south, z);
    const tiles = (Math.floor((x1 - 1e-9) / 256) - Math.floor(x0 / 256) + 1) * (Math.floor((y1 - 1e-9) / 256) - Math.floor(y0 / 256) + 1);
    if ((x1 - x0 <= terrainLimits.maxPixels && y1 - y0 <= terrainLimits.maxPixels && tiles <= terrainLimits.maxTiles) || z === 0) {
      return { z, x0, x1, y0, y1, tx0: Math.floor(x0 / 256), tx1: Math.floor((x1 - 1e-9) / 256), ty0: Math.floor(y0 / 256), ty1: Math.floor((y1 - 1e-9) / 256) };
    }
  }
  throw new ResolveError("terrain-unavailable");
}

export type TileDecoder = (bytes: Uint8Array) => Raster;

/** A located place, from the region resolver or from an injected v0.3-style locator. */
type Located = GeoRegion | Place;
const asRegion = (found: Located): GeoRegion => {
  if ("focus" in found) return found;
  const b = normalizeBox(found.box);
  const rings = found.rings?.length ? found.rings : [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]] as [number, number][]];
  return { label: found.label, kind: "place", focus: rings.map(ring => [ring]), ids: [], provider: found.provider as GeoRegion["provider"] };
};

/**
 * Elevation from AWS Terrain Tiles (Mapzen terrarium encoding; SRTM, GMTED, ETOPO1 and others,
 * roughly 30 m–1 km). Public dataset on the Registry of Open Data on AWS; no key.
 */
export function elevationTilesProvider(decode: TileDecoder = decodePng, request?: Fetcher,
  locate: (region: string, signal: AbortSignal, request?: Fetcher) => Promise<Located> = resolveRegion): TerrainProvider {
  return {
    name: "aws-terrain-tiles",
    async resolve(name, _style, signal, options = {}) {
      const region = asRegion(await locate(name, signal, request));
      const frame = regionFrame(region, options.include ?? []);
      const window = frameWindow(frame);
      const plan = planTiles(window);
      const cols = plan.tx1 - plan.tx0 + 1, rows = plan.ty1 - plan.ty0 + 1, n = 2 ** plan.z;
      const mosaicW = cols * 256, mosaicH = rows * 256;
      const mosaic = new Float32Array(mosaicW * mosaicH).fill(NaN);
      const jobs: (() => Promise<void>)[] = [];
      for (let ty = plan.ty0; ty <= plan.ty1; ty++) for (let tx = plan.tx0; tx <= plan.tx1; tx++) {
        if (ty < 0 || ty >= n) continue;
        jobs.push(async () => {
          const { bytes } = await fetchImage(TILE_URL(plan.z, ((tx % n) + n) % n, ty), { hosts: [HOSTS.elevation], signal, request, maxBytes: terrainLimits.tileBytes });
          const raster = decode(bytes);
          if (raster.width !== 256 || raster.height !== 256) throw new ResolveError("terrain-tile-invalid");
          const metres = decodeTerrarium(raster);
          const ox = (tx - plan.tx0) * 256, oy = (ty - plan.ty0) * 256;
          for (let y = 0; y < 256; y++) mosaic.set(metres.subarray(y * 256, y * 256 + 256), (oy + y) * mosaicW + ox);
        });
      }
      // Four requests at a time: quick, and polite to the public bucket.
      for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(job => job()));
      signal.throwIfAborted();

      // The mosaic resampled into the region's frame, at twice the final resolution, then area-averaged down.
      const aspect = (frame.x1 - frame.x0) / (frame.y1 - frame.y0), long = heightFieldLimits.maxSide * 2;
      const width = Math.max(2, Math.round(aspect >= 1 ? long : long * aspect)), height = Math.max(2, Math.round(aspect >= 1 ? long / aspect : long));
      const fine = new Float32Array(width * height).fill(NaN);
      const at = (x: number, y: number) => x >= 0 && y >= 0 && x < mosaicW && y < mosaicH ? mosaic[y * mosaicW + x] : NaN;
      for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
        const geo = unproject(frame.x0 + (i + 0.5) / width * (frame.x1 - frame.x0), frame.y1 - (j + 0.5) / height * (frame.y1 - frame.y0), frame.projection);
        if (!geo || Math.abs(geo[1]) > terrainLimits.mercatorLat) continue;
        // Longitude on the same turn of the globe as the tile window.
        let lon = geo[0];
        while (lon < window.west) lon += 360;
        while (lon >= window.west + 360) lon -= 360;
        const px = mercatorX(lon, plan.z) - plan.tx0 * 256 - 0.5, py = mercatorY(geo[1], plan.z) - plan.ty0 * 256 - 0.5;
        const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
        const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        fine[j * width + i] = [a, b, c, d].every(Number.isFinite)
          ? (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
          : [a, b, c, d].find(Number.isFinite) ?? NaN;
      }
      const grid = downsampleGrid(fine, width, height, heightFieldLimits.maxSide);
      let mask: Uint8Array | undefined;
      if (region.focus.length) {
        const rings: [number, number][][] = [];
        for (const polygon of region.focus) for (const ring of polygon) {
          const projected: [number, number][] = [];
          for (const [lon, lat] of ring) {
            const xy = project(lon, lat, frame.projection);
            if (xy) projected.push([(xy[0] - frame.x0) / (frame.x1 - frame.x0) * grid.width, (frame.y1 - xy[1]) / (frame.y1 - frame.y0) * grid.height]);
          }
          if (projected.length > 2) rings.push(projected);
        }
        mask = rasterizePolygon(rings, grid.width, grid.height);
        let inside = 0;
        for (const cell of mask) inside += cell;
        if (inside < heightFieldLimits.minCells) mask = undefined; // outline too small to use: show the window
      }
      return {
        provider: `aws-terrain-tiles z${plan.z} · ${region.provider}`, kind: "elevation",
        width: grid.width, height: grid.height, values: grid.values, mask,
        aspect, label: region.label, geo: frame,
      } satisfies TerrainSource;
    },
  };
}
