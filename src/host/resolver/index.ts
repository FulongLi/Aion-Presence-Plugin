import { errorCode, ResolveError } from "../../visual/errors";
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

type Family = "image" | "portrait" | "terrain";

export class VisualResolver {
  /** What happened for the most recent request (diagnostics). */
  lastTrace: ResolveTrace | null = null;
  private readonly images: readonly ImageProvider[];
  private readonly terrains: readonly TerrainProvider[];
  private readonly cache = new Map<string, { at: number; value: ResolvedPicture | ResolvedTerrain }>();

  constructor(private readonly options: ResolverOptions = {}) {
    const request = options.request;
    const web = braveProvider(options.env ?? process.env, request);
    this.images = options.imageProviders ?? [wikipediaProvider(request), commonsProvider(request), openverseProvider(request), ...(web ? [web] : [])];
    this.terrains = options.terrainProviders ?? [elevationTilesProvider(undefined, request)];
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

  /** The terrain of a real region from real elevation data, as a height field. */
  terrain(region: string, style: TerrainStyle = "terrain", signal?: AbortSignal): Promise<ResolvedTerrain> {
    return this.run("terrain", region, style, signal, async (bounded, trace) => {
      for (const provider of this.terrains) {
        const started = Date.now();
        try {
          const source = await provider.resolve(region, style, bounded);
          const field = buildHeightField(source, style);
          trace.chain.push({ provider: provider.name, outcome: "selected", ms: Date.now() - started });
          trace.provider = source.provider;
          return { field, bytes: encodeHeightField(field), mime: HEIGHTFIELD_MIME, label: source.label, source: { provider: source.provider } };
        } catch (error) {
          bounded.throwIfAborted();
          const outcome = errorCode(error);
          trace.chain.push({ provider: provider.name, outcome, ms: Date.now() - started });
          if (outcome === "region-not-found") throw new ResolveError("region-not-found");
        }
      }
      throw new ResolveError("terrain-unavailable");
    });
  }

  private async run<T extends ResolvedPicture | ResolvedTerrain>(family: Family, query: string, variant: string, signal: AbortSignal | undefined,
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
      const code = errorCode(error);
      const failure = timeout.signal.aborted ? `${family}-unavailable`
        : /^(portrait|image|terrain|region)-(not-found|unavailable)$/.test(code) ? code : `${family}-unavailable`;
      trace.status = "failed";
      trace.error = code !== failure ? `${failure} (${code})` : failure;
      throw new ResolveError(failure);
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
