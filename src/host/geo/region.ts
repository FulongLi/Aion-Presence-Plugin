import { ResolveError } from "../../visual/errors";
import { frameAround, frameForWindow, frameWindow, primaryExtent, type GeoPolygon, type GeoRing } from "../../visual/geo/extent";
import { geoToNormal, project, type Frame } from "../../visual/geo/projection";
import { fetchJSON, HOSTS, type Fetcher } from "../resolver/net";
import { findGroup, findPlace, findRegion, worldRegions, type RegionGroup, type WorldRegion } from "./world";

/**
 * Where a place is: a named region (a continent, a country, Scotland, California, the Alps) or a point (a city, a
 * mountain), as outline polygons in longitude and latitude, and the frame it is best seen through.
 *
 *   name ─► Aion's offline world (continents, groups, countries, their named parts)  — instant, no network
 *        ─► OpenStreetMap Nominatim (with the outline)  ─► Photon                    — anything else
 *
 * Only the name leaves the machine, and only when the offline world does not know it.
 */
export interface GeoRegion {
  label: string;
  kind: "group" | "country" | "unit" | "place";
  /** The region's own outline: its primary parts (see extent.ts), or for a group every member's. */
  focus: GeoPolygon[];
  /** For a group: each member's parts, so the map can draw the borders between them. */
  members?: GeoPolygon[][];
  /** The world regions that are this region (excluded from the neighbouring context). */
  ids: string[];
  /** A point place (a city, a mountain): where it is. Its map is framed around it. */
  point?: [number, number];
  /** How it is framed before any markers: a window (groups), or around its parts. */
  window?: RegionGroup["window"]; centre?: RegionGroup["centre"]; world?: boolean;
  /** v0.6 "route": the surroundings of a planned route (a box around it, no lookup). */
  provider: "natural-earth" | "nominatim" | "photon" | "route";
}

const primary = (region: WorldRegion) => { const keep = primaryExtent(region.polygons); return keep.map(i => region.polygons[i]); };

function fromGroup(group: RegionGroup): GeoRegion {
  const members = worldRegions().filter(group.members).filter(region => region.polygons.length);
  // Every member's main parts (French Guiana stays out of Europe), and all of them on a world map.
  const parts = members.map(region => group.id === "world" ? region.polygons : primary(region));
  return {
    label: group.label, kind: "group", focus: parts.flat(), members: parts, ids: members.map(region => region.id),
    window: group.window, centre: group.centre, world: group.id === "world", provider: "natural-earth",
  };
}

function fromWorld(region: WorldRegion): GeoRegion {
  return { label: region.name, kind: region.parent ? "unit" : "country", focus: primary(region), ids: [region.id, ...(region.parent ? [] : worldRegions().filter(r => r.parent === region.id).map(r => r.id))], provider: "natural-earth" };
}

type NominatimHit = { display_name?: string; name?: string; lat?: string; lon?: string; boundingbox?: string[]; geojson?: { type: string; coordinates: unknown } };
type PhotonFeature = { properties?: { name?: string; country?: string; extent?: number[] }; geometry?: { coordinates?: number[] } };

const ring = (value: unknown): GeoRing => Array.isArray(value)
  ? value.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]] as [number, number])
  : [];
/** GeoJSON Polygon / MultiPolygon → polygons (outer ring first, then holes). */
export function geojsonPolygons(geojson: NominatimHit["geojson"]): GeoPolygon[] {
  if (!geojson || !Array.isArray(geojson.coordinates)) return [];
  const polygon = (value: unknown) => Array.isArray(value) ? value.map(ring).filter(r => r.length > 2) : [];
  if (geojson.type === "Polygon") return [polygon(geojson.coordinates)].filter(p => p.length);
  if (geojson.type === "MultiPolygon") return (geojson.coordinates as unknown[]).map(polygon).filter(p => p.length);
  return [];
}

/** A bounding box as a polygon (a box from a geocoder that has no outline). */
const boxPolygon = (west: number, south: number, east: number, north: number): GeoPolygon => {
  if (east < west) east += 360;
  const edge: GeoRing = [];
  for (let k = 0; k <= 8; k++) edge.push([west + (east - west) * k / 8, south]);
  for (let k = 0; k <= 8; k++) edge.push([east, south + (north - south) * k / 8]);
  for (let k = 8; k >= 0; k--) edge.push([west + (east - west) * k / 8, north]);
  for (let k = 8; k >= 0; k--) edge.push([west, south + (north - south) * k / 8]);
  return [edge];
};

/** Nominatim with its outline, then Photon: a region the offline world does not know. */
export async function geocodeRegion(name: string, signal: AbortSignal, request?: Fetcher): Promise<GeoRegion> {
  let failure: unknown = null;
  try {
    const url = new URL(`https://${HOSTS.nominatim}/search`);
    url.search = new URLSearchParams({ q: name, format: "jsonv2", limit: "1", polygon_geojson: "1", polygon_threshold: "0.005" }).toString();
    const { data } = await fetchJSON<NominatimHit[]>(url, { hosts: [HOSTS.nominatim], signal, request });
    const hit = Array.isArray(data) ? data[0] : undefined;
    if (hit) {
      const label = (hit.name || hit.display_name || name).slice(0, 80);
      const polygons = geojsonPolygons(hit.geojson);
      if (polygons.length) {
        const keep = primaryExtent(polygons);
        return { label, kind: "place", focus: keep.map(i => polygons[i]), ids: [], provider: "nominatim" };
      }
      const b = hit.boundingbox?.map(Number), lat = Number(hit.lat), lon = Number(hit.lon);
      if (b && b.length === 4 && b.every(Number.isFinite) && (b[1] - b[0] > 0.05 || b[3] - b[2] > 0.05)) {
        return { label, kind: "place", focus: [boxPolygon(b[2], b[0], b[3], b[1])], ids: [], provider: "nominatim" };
      }
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { label, kind: "place", focus: [], point: [lon, lat], ids: [], provider: "nominatim" };
    }
  } catch (error) { signal.throwIfAborted(); failure = error; }
  try {
    const url = new URL(`https://${HOSTS.photon}/api/`);
    url.search = new URLSearchParams({ q: name, limit: "1" }).toString();
    const { data } = await fetchJSON<{ features?: PhotonFeature[] }>(url, { hosts: [HOSTS.photon], signal, request });
    const feature = data.features?.[0];
    const e = feature?.properties?.extent, c = feature?.geometry?.coordinates;
    const label = (feature?.properties?.name ?? name).slice(0, 80);
    if (e?.length === 4 && e.every(Number.isFinite)) return { label, kind: "place", focus: [boxPolygon(e[0], e[3], e[2], e[1])], ids: [], provider: "photon" };
    if (c?.length === 2 && c.every(Number.isFinite)) return { label, kind: "place", focus: [], point: [c[0], c[1]], ids: [], provider: "photon" };
  } catch (error) { signal.throwIfAborted(); failure = error; }
  throw new ResolveError(failure ? "geocoder-unavailable" : "region-not-found");
}

/** Any region by name: the offline world first (groups, then countries and their parts), then the geocoders. */
export async function resolveRegion(name: string, signal: AbortSignal, request?: Fetcher): Promise<GeoRegion> {
  const group = findGroup(name);
  if (group) return fromGroup(group);
  const region = findRegion(name);
  if (region) return fromWorld(region);
  return geocodeRegion(name, signal, request);
}

/**
 * The frame a region is seen through, with any markers in view: a polar window for the poles, Equal Earth for the
 * world, a group's window, or the region's own parts — and markers outside it widen it.
 */
export function regionFrame(region: GeoRegion, markers: readonly [number, number][] = []): Frame {
  if (region.world) {
    const p = { kind: "equal-earth" as const, lon0: 0 };
    const edge: GeoRing = [];
    // ±179.99: −180 and 180 are the same meridian, which would fold the frame onto one side.
    for (let lat = -90; lat <= 90; lat += 5) edge.push([-179.99, lat], [179.99, lat]);
    return frameAround([[edge]], [], { projection: p, margin: 0.02 });
  }
  if (region.window) {
    const [west, south, east, north] = region.window;
    const base = region.centre
      ? frameAround([[[[-180, region.centre[1] > 0 ? south : north], [-90, region.centre[1] > 0 ? south : north], [0, region.centre[1] > 0 ? south : north], [90, region.centre[1] > 0 ? south : north]]]], [], { projection: { kind: "laea", lon0: region.centre[0], lat0: region.centre[1] }, margin: 0.03 })
      : frameForWindow(west, south, east, north);
    const outside = markers.filter(point => !inside(base, point));
    return outside.length ? frameAround([], [...corners(base), ...markers], { projection: base.projection, margin: 0.08 }) : base;
  }
  const polygons = region.focus;
  const parts = polygons.length ? polygons : [];
  const points = [...(region.point ? [region.point] : []), ...markers];
  // A point place is shown with the country around it: a city on its own would be a dot in nothing. v0.6: a route's
  // surroundings are framed tightly (a few kilometres is a whole hike), so the terrain's detail is spent on them.
  if (region.provider === "route") return frameAround(parts, points, { minSpan: 0.0006, margin: 0.01 });
  const minSpan = region.point && !parts.length ? 0.05 : 0.012;
  return frameAround(parts, points, { minSpan, margin: 0.08 });
}

/** Whether a point lies inside a frame (with a small inset, so a marker is never on the very edge). */
export function inside(frame: Frame, [lon, lat]: [number, number], inset = 0.04): boolean {
  const n = geoToNormal(lon, lat, frame);
  if (!n) return false;
  const { x0, y0, x1, y1 } = frame;
  const xy = project(lon, lat, frame.projection)!;
  const w = x1 - x0, h = y1 - y0;
  return xy[0] > x0 + w * inset && xy[0] < x1 - w * inset && xy[1] > y0 + h * inset && xy[1] < y1 - h * inset;
}

function corners(frame: Frame): [number, number][] {
  const { west, east, south, north } = frameWindow(frame);
  return [[west, south], [east, south], [west, north], [east, north]];
}

export interface FoundPlace { label: string; lon: number; lat: number; provider: "natural-earth" | "nominatim" | "photon" }

/**
 * A place to mark, by name, preferring one inside the region on show ("Glasgow" on Scotland is Glasgow, Scotland):
 * the offline gazetteer within the region's countries, then Nominatim bounded to the view, then anywhere, then Photon.
 */
export async function locatePlace(name: string, near: { region?: GeoRegion; frame?: Frame; gazetteerFirst?: boolean } | undefined, signal: AbortSignal, request?: Fetcher): Promise<FoundPlace> {
  const countries = new Set(near?.region?.ids.map(id => id.split(".")[0]) ?? []);
  const local = findPlace(name, countries.size ? place => countries.has(place.country) || (near?.frame ? inside(near.frame, [place.lon, place.lat], 0) : false) : undefined);
  if (local) return { label: local.name, lon: local.lon, lat: local.lat, provider: "natural-earth" };
  // v0.6: a route's places need not be in the region on show: a city Aion knows anywhere comes before a search bounded
  // to the view (which could find a street named after it there).
  const known = near?.gazetteerFirst ? findPlace(name) : null;
  if (known) return { label: known.name, lon: known.lon, lat: known.lat, provider: "natural-earth" };
  const window = near?.frame ? frameWindow(near.frame) : null;
  const attempts: URLSearchParams[] = [];
  const base = { q: name, format: "jsonv2", limit: "1" };
  if (window && window.east - window.west < 300) {
    attempts.push(new URLSearchParams({ ...base, viewbox: `${window.west},${window.north},${window.east > 180 ? window.east - 360 : window.east},${window.south}`, bounded: "1" }));
  }
  attempts.push(new URLSearchParams(base));
  let failure: unknown = null;
  for (const search of attempts) {
    try {
      const url = new URL(`https://${HOSTS.nominatim}/search`);
      url.search = search.toString();
      const { data } = await fetchJSON<NominatimHit[]>(url, { hosts: [HOSTS.nominatim], signal, request });
      const hit = Array.isArray(data) ? data[0] : undefined;
      const lat = Number(hit?.lat), lon = Number(hit?.lon);
      if (hit && Number.isFinite(lat) && Number.isFinite(lon)) return { label: (hit.name || name).slice(0, 60), lon, lat, provider: "nominatim" };
    } catch (error) { signal.throwIfAborted(); failure = error; }
  }
  try {
    const url = new URL(`https://${HOSTS.photon}/api/`);
    url.search = new URLSearchParams({ q: name, limit: "1" }).toString();
    const { data } = await fetchJSON<{ features?: PhotonFeature[] }>(url, { hosts: [HOSTS.photon], signal, request });
    const c = data.features?.[0]?.geometry?.coordinates;
    if (c?.length === 2 && c.every(Number.isFinite)) return { label: (data.features?.[0]?.properties?.name ?? name).slice(0, 60), lon: c[0], lat: c[1], provider: "photon" };
  } catch (error) { signal.throwIfAborted(); failure = error; }
  // A city the gazetteer knows elsewhere is better than nothing when the geocoders are down.
  const anywhere = findPlace(name);
  if (anywhere) return { label: anywhere.name, lon: anywhere.lon, lat: anywhere.lat, provider: "natural-earth" };
  throw new ResolveError(failure ? "geocoder-unavailable" : "place-not-found");
}
