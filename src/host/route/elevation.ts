import { ResolveError } from "../../visual/errors";
import { decodeTerrarium } from "../../visual/heightfield";
import { cumulative, resample } from "../../visual/geo/route";
import { fetchImage, HOSTS, type Fetcher } from "../resolver/net";
import { decodePng } from "../resolver/png";
import { mercatorX, mercatorY, terrainLimits, TILE_URL } from "../resolver/sources/terrain";

/**
 * Elevation along a route (v0.6), from the same public elevation model as Aion's terrain: AWS Terrain Tiles (Mapzen's
 * terrarium encoding, merged from SRTM, EU-DEM, national lidar where available, GMTED and ETOPO1 — roughly 10–30 m in
 * most of Europe and North America, coarser elsewhere). The route is resampled at a uniform spacing and each sample is
 * read bilinearly from the most detailed tiles within bounds. Only tile coordinates are requested; the route never
 * leaves the machine.
 *
 * Accuracy: an elevation model gives the ground's surface averaged over a cell. A path along a cliff edge, a bridge or
 * a tunnel reads the cell's height, not the path's; summits narrower than a cell read low. The profile is right in
 * shape and to within metres to a few tens of metres in height, and the statistics are rounded to say no more.
 */
export const elevationLimits = { maxTiles: 32, minZoom: 6, maxZoom: 13, samples: 500, minSpacing: 10, cacheTiles: 48 };

export interface ElevationProfile {
  samples: [number, number][];
  spacing: number;
  zoom: number;
  /** "AWS Terrain Tiles (terrarium) z12". */
  source: string;
}

/** The decoded tiles most recently read (a reversed or changed route reads the same ones again). */
const tileCache = new Map<string, Float32Array>();

/** Samples elevation every few metres along a route. Throws `elevation-unavailable` (with the cause) when it cannot. */
export async function sampleElevation(coordinates: readonly [number, number][], signal: AbortSignal, request?: Fetcher): Promise<ElevationProfile> {
  const total = cumulative(coordinates).at(-1) ?? 0;
  if (total <= 0) throw new ResolveError("elevation-unavailable", "empty-route");
  const spacing = Math.max(elevationLimits.minSpacing, Math.ceil(total / elevationLimits.samples / 5) * 5);
  const along = resample(coordinates, spacing).filter(p => Math.abs(p.point[1]) < terrainLimits.mercatorLat);
  // The most detailed zoom that reads at most maxTiles tiles.
  let zoom = elevationLimits.maxZoom, tiles = new Set<string>();
  for (; zoom >= elevationLimits.minZoom; zoom--) {
    tiles = new Set(along.map(({ point: [lon, lat] }) => `${Math.floor(mercatorX(lon, zoom) / 256)}/${Math.floor(mercatorY(lat, zoom) / 256)}`));
    // Bilinear reads near a tile's edge touch its neighbour: count those as well.
    for (const { point: [lon, lat] } of along) {
      const px = mercatorX(lon, zoom) - 0.5, py = mercatorY(lat, zoom) - 0.5;
      tiles.add(`${Math.floor((px + 1) / 256)}/${Math.floor((py + 1) / 256)}`).add(`${Math.floor((px + 1) / 256)}/${Math.floor(py / 256)}`).add(`${Math.floor(px / 256)}/${Math.floor((py + 1) / 256)}`);
    }
    if (tiles.size <= elevationLimits.maxTiles) break;
  }
  if (zoom < elevationLimits.minZoom) throw new ResolveError("elevation-unavailable", "too-many-tiles");
  const n = 2 ** zoom;
  const grids = new Map<string, Float32Array>();
  const keys = [...tiles];
  try {
    for (let i = 0; i < keys.length; i += 4) {
      await Promise.all(keys.slice(i, i + 4).map(async key => {
        const [tx, ty] = key.split("/").map(Number);
        if (ty < 0 || ty >= n) return;
        const id = `${zoom}/${((tx % n) + n) % n}/${ty}`;
        let grid = tileCache.get(id);
        if (!grid) {
          const { bytes } = await fetchImage(TILE_URL(zoom, ((tx % n) + n) % n, ty), { hosts: [HOSTS.elevation], signal, request, maxBytes: terrainLimits.tileBytes });
          const raster = decodePng(bytes);
          if (raster.width !== 256 || raster.height !== 256) throw new ResolveError("terrain-tile-invalid");
          grid = decodeTerrarium(raster);
          tileCache.set(id, grid);
          while (tileCache.size > elevationLimits.cacheTiles) tileCache.delete(tileCache.keys().next().value!);
        } else { tileCache.delete(id); tileCache.set(id, grid); }
        grids.set(key, grid);
      }));
    }
  } catch (error) {
    signal.throwIfAborted();
    throw new ResolveError("elevation-unavailable", error instanceof Error ? error.message : "error");
  }
  const at = (x: number, y: number) => {
    const grid = grids.get(`${Math.floor(x / 256)}/${Math.floor(y / 256)}`);
    if (!grid) return NaN;
    const ix = ((Math.floor(x) % 256) + 256) % 256, iy = ((Math.floor(y) % 256) + 256) % 256;
    return grid[iy * 256 + ix];
  };
  const samples: [number, number][] = [];
  for (const { distance, point: [lon, lat] } of along) {
    const px = mercatorX(lon, zoom) - 0.5, py = mercatorY(lat, zoom) - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    const value = [a, b, c, d].every(Number.isFinite) ? (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy : [a, b, c, d].find(Number.isFinite);
    if (value === undefined || !Number.isFinite(value) || value < -500 || value > 9000) continue;
    samples.push([Math.round(distance * 10) / 10, Math.round(value * 10) / 10]);
  }
  if (samples.length < Math.max(2, along.length * 0.8)) throw new ResolveError("elevation-unavailable", "no-data");
  return { samples, spacing, zoom, source: `AWS Terrain Tiles (terrarium) z${zoom}` };
}
