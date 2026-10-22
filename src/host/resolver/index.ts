import { errorCode, errorDetail, ResolveError } from "../../visual/errors";
import { buildHeightField, encodeHeightField, HEIGHTFIELD_MIME } from "../../visual/heightfield";
import { fitForIntent, type HeightField, type ImageFit, type ImageIntent, type TerrainStyle } from "../../visual/types";
import { loadLocalAsset, matchLocalAsset } from "./assets";
import { imageSize } from "./imageInfo";
import { resolveImage } from "./images";
import { timeoutSignal, type Fetcher } from "./net";
import { braveProvider } from "./sources/brave";
import { openverseProvider } from "./sources/openverse";
import { elevationTilesProvider, type TerrainProvider } from "./sources/terrain";
import { commonsProvider, wikipediaProvider } from "./sources/wikimedia";
import type { ImageProvider, ResolveTrace } from "./types";
import { locatePlace, regionFrame, resolveRegion, type FoundPlace, type GeoRegion } from "../geo/region";
import { buildMap } from "../geo/map";
import { encodeMap, MAP_MIME, type GeoMap } from "../../visual/geo/map";
import type { Frame } from "../../visual/geo/projection";

/**
 * The Visual Resolver, server side (SCF's visual-resolver/resolve.ts for images, portraits and terrain):
 *
 *   validated request ─► curated local asset │ provider chain ─► download ─► check ─► local media
 *
 * In SCF the browser fetched and decoded. In the plugin the local MCP process does the network part, so the
 * Presence surface (embedded in a host, or the companion window) never needs remote access: it receives the
 * same validated local media as for a local file, and frames it by the request's intent (portrait, object,
 * map, logo). Terrain becomes a height field here and travels as compact bytes.
 *
 * Only the search phrase, person or region leaves the machine, and only to public data providers. No model
 * API is involved.
 */
export interface ResolverOptions {
  request?: Fetcher;
  env?: NodeJS.ProcessEnv;
  /** The plugin's assets/ directory (curated first-party assets). */
  assetsDir?: string;
  imageProviders?: readonly ImageProvider[];
  terrainProviders?: readonly TerrainProvider[];
  /** Upper bound for one resolution, whatever the provider chain does. */
  deadlineMs?: number;
}

export const resolverDefaults = { deadlineMs: 20_000, cacheSize: 24, cacheMs: 30 * 60_000 };

export interface ResolvedPicture {
  bytes: Uint8Array;
  mime: string;
  fit: ImageFit;
  /** What was found (an article title, a file name, a brand): for the body's label and the tool result. */
  label: string;
  source: { provider: string; page?: string; license?: string };
  /** The picture's own size (from its header), when known: it decides whether a card is worth showing. */
  width?: number;
  height?: number;
}

export interface ResolvedTerrain {
  field: HeightField;
  bytes: Uint8Array;
  mime: typeof HEIGHTFIELD_MIME;
  label: string;
  source: { provider: string };
}

export interface ResolvedMap {
  map: GeoMap;
  bytes: Uint8Array;
  mime: typeof MAP_MIME;
  region: GeoRegion;
  source: { provider: string };
}

type Family = "image" | "portrait" | "terrain" | "region" | "place";

export class VisualResolver {
  /** What happened for the most recent request (diagnostics). */
  lastTrace: ResolveTrace | null = null;
  private readonly images: readonly ImageProvider[];
  private readonly terrains: readonly TerrainProvider[];
  private readonly cache = new Map<string, { at: number; value: ResolvedPicture | ResolvedTerrain | GeoRegion | FoundPlace }>();

  constructor(private readonly options: ResolverOptions = {}) {
    const request = options.request;
    const web = braveProvider(options.env ?? process.env, request);
    this.images = options.imageProviders ?? [wikipediaProvider(request), commonsProvider(request), openverseProvider(request), ...(web ? [web] : [])];
    // Terrain finds its region through the same (cached) resolution as maps and markers.
    this.terrains = options.terrainProviders ?? [elevationTilesProvider(undefined, request, (name, signal) => this.region(name, signal))];
  }

  /** The image providers in use (the optional keyed one only when the user configured it). */
  get providers() { return this.images.map(provider => provider.name); }

  /** A picture of almost anything: a curated local asset when the query names one, otherwise the provider chain. */
  image(query: string, intent: ImageIntent = "general", signal?: AbortSignal): Promise<ResolvedPicture> {
    return this.run("image", query, `${intent}`, signal, async (bounded, trace) => {
      const asset = matchLocalAsset(query);
      if (asset) {
        if (!this.options.assetsDir) throw new ResolveError("image-unavailable");
        const loaded = await loadLocalAsset(asset, this.options.assetsDir);
        trace.chain.push({ provider: "local-assets", outcome: `selected (${asset.id})`, ms: 0 });
        return { ...loaded, ...imageSize(loaded.bytes), fit: asset.type === "logo" ? "logo" : fitForIntent(intent), label: asset.brand, source: { provider: "local-assets" } };
      }
      const found = await resolveImage(query, intent, { providers: this.images, request: this.options.request }, bounded, trace, "image");
      return picture(found, fitForIntent(intent), query);
    });
  }

  /** A real, recognizable person: the portrait chain (Wikipedia first) and portrait framing. */
  portrait(person: string, signal?: AbortSignal): Promise<ResolvedPicture> {
    return this.run("portrait", person, "portrait", signal, async (bounded, trace) => {
      const found = await resolveImage(person, "portrait", { providers: this.images, request: this.options.request }, bounded, trace, "portrait");
      return picture(found, "portrait", person);
    });
  }

  /**
   * The terrain of a real region from real elevation data, as a height field. `include`: points (markers) that must
   * be in view.
   */
  terrain(region: string, style: TerrainStyle = "terrain", signal?: AbortSignal, include: [number, number][] = [], area?: GeoRegion): Promise<ResolvedTerrain> {
    const key = `${area ? `area:${area.focus.flat(2).map(([lon, lat]) => `${lon.toFixed(3)},${lat.toFixed(3)}`).join(";")}:` : ""}${include.length ? `${style}:${include.map(([lon, lat]) => `${lon.toFixed(3)},${lat.toFixed(3)}`).join(";")}` : style}`;
    return this.run("terrain", region, key, signal, async (bounded, trace) => {
      let cause: string | undefined;
      for (const provider of this.terrains) {
        const started = Date.now();
        try {
          const source = await provider.resolve(region, style, bounded, { include, ...(area ? { area } : {}) });
          let field: ReturnType<typeof buildHeightField>, bytes: Uint8Array;
          try { field = buildHeightField(source, style); bytes = encodeHeightField(field); } catch { throw new ResolveError("heightfield-failed"); }
          trace.chain.push({ provider: provider.name, outcome: "selected", ms: Date.now() - started });
          trace.provider = source.provider;
          return { field, bytes, mime: HEIGHTFIELD_MIME, label: source.label, source: { provider: source.provider } };
        } catch (error) {
          bounded.throwIfAborted();
          const outcome = errorCode(error);
          trace.chain.push({ provider: provider.name, outcome, ms: Date.now() - started });
          if (outcome === "region-not-found") throw new ResolveError("region-not-found");
          cause ??= outcome;
        }
      }
      // v0.5.2: which stage failed travels with the stable code (see terrainCause in the MCP server).
      throw new ResolveError("terrain-unavailable", cause);
    });
  }

  /**
   * v0.6: the terrain of a route's surroundings — a box around it (west, south, east, north), named `label` — when no
   * terrain on show contains the route well. No place lookup: the box is the region.
   */
  terrainArea(label: string, box: [number, number, number, number], style: TerrainStyle = "terrain", signal?: AbortSignal): Promise<ResolvedTerrain> {
    const [west, south, east, north] = box;
    const ring: [number, number][] = [[west, south], [east, south], [east, north], [west, north], [west, south]];
    return this.terrain(label, style, signal, [], { label, kind: "place", focus: [[ring]], ids: [], provider: "route" });
  }

  /** A region by name (continent, country, part of one, or anything OpenStreetMap knows), with its outline. */
  region(name: string, signal?: AbortSignal): Promise<GeoRegion> {
    return this.run("region", name, "", signal, async (bounded, trace) => {
      const started = Date.now();
      const region = await resolveRegion(name, bounded, this.options.request);
      trace.chain.push({ provider: region.provider, outcome: "selected", ms: Date.now() - started });
      return region;
    });
  }

  /** A place to mark, near the region on show (the gazetteer first, then the geocoders). */
  place(name: string, near?: { region?: GeoRegion; frame?: Frame }, signal?: AbortSignal): Promise<FoundPlace> {
    const scope = near?.region ? near.region.ids.join(",") || near.region.label : "";
    return this.run("place", name, scope, signal, async (bounded, trace) => {
      const started = Date.now();
      const found = await locatePlace(name, near, bounded, this.options.request);
      trace.chain.push({ provider: found.provider, outcome: "selected", ms: Date.now() - started });
      return found;
    });
  }

  /** A map of a region with these points (markers) in view: outlines, borders, land and neighbours, projected. */
  async map(name: string, include: [number, number][] = [], signal?: AbortSignal): Promise<ResolvedMap> {
    const region = await this.region(name, signal);
    const map = buildMap(region, regionFrame(region, include));
    return { map, bytes: encodeMap(map), mime: MAP_MIME, region, source: { provider: region.provider === "natural-earth" ? "Natural Earth" : region.provider === "nominatim" ? "OpenStreetMap" : "Photon (OpenStreetMap)" } };
  }

  private async run<T extends ResolvedPicture | ResolvedTerrain | GeoRegion | FoundPlace>(family: Family, query: string, variant: string, signal: AbortSignal | undefined,
    work: (signal: AbortSignal, trace: ResolveTrace) => Promise<T>): Promise<T> {
    const key = `${family}:${variant}:${query.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < resolverDefaults.cacheMs) {
      this.cache.delete(key); this.cache.set(key, cached);
      this.lastTrace = { action: family, query, status: "resolved", chain: [{ provider: "cache", outcome: "hit", ms: 0 }] };
      return cached.value as T;
    }
    const started = Date.now();
    const trace: ResolveTrace = { action: family, query, status: "resolving", chain: [] };
    this.lastTrace = trace;
    const timeout = timeoutSignal(this.options.deadlineMs ?? resolverDefaults.deadlineMs);
    const bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const value = await work(bounded, trace);
      trace.status = "resolved";
      this.cache.set(key, { at: Date.now(), value });
      while (this.cache.size > resolverDefaults.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      return value;
    } catch (error) {
      if (signal?.aborted) { trace.status = "cancelled"; throw error; }
      const code = errorCode(error), detail = timeout.signal.aborted ? "timeout" : errorDetail(error) ?? code;
      const failure = timeout.signal.aborted ? `${family}-unavailable`
        : /^(portrait|image|terrain|region|place)-(not-found|unavailable)$/.test(code) ? code
          : code === "geocoder-unavailable" ? (family === "place" ? "place-unavailable" : "region-unavailable") : `${family}-unavailable`;
      trace.status = "failed";
      trace.error = detail !== failure ? `${failure} (${detail})` : failure;
      throw new ResolveError(failure, detail);
    } finally {
      timeout.clear();
      trace.ms = Date.now() - started;
    }
  }
}

function picture(found: Awaited<ReturnType<typeof resolveImage>>, fit: ImageFit, query: string): ResolvedPicture {
  const { candidate } = found;
  return {
    bytes: found.bytes, mime: found.mime, fit, label: candidate.title || query, width: found.width, height: found.height,
    source: { provider: candidate.provider, ...(candidate.pageUrl ? { page: candidate.pageUrl } : {}), ...(candidate.license ? { license: candidate.license } : {}) },
  };
}
