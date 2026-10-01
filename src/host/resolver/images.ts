import { errorCode, ResolveError } from "../../visual/errors";
import type { ImageIntent } from "../../visual/types";
import { imageSize } from "./imageInfo";
import { fetchImage, HOSTS, type Fetcher } from "./net";
import { rankCandidates } from "./rank";
import type { ImageCandidate, ImageProvider, ResolveTrace } from "./types";

/**
 * Open image retrieval (SCF's providers/images.ts). Any query goes to an ordered chain of providers suited to
 * its intent; the first provider that yields a usable, downloadable image wins. Nothing here knows a list of
 * supported things: a Model Y, a wind turbine or a public figure all take the same path.
 *
 * | intent                       | order                                   |
 * | ---------------------------- | --------------------------------------- |
 * | portrait, celebrity          | wikipedia → web → openverse → commons   |
 * | vehicle, product, object     | wikipedia → commons → web → openverse   |
 * | map                          | commons → wikipedia → openverse         |
 * | reference, general           | openverse → commons → web → wikipedia   |
 *
 * "web" is optional (a key the user sets) and skipped when not configured. SCF decoded each download in the
 * browser; here the bytes are checked server-side (type by magic bytes, dimensions from the header) and
 * handed to the Presence surface as local media, so the surface never fetches anything remote.
 */
export const PROVIDER_ORDER: Record<ImageIntent, readonly string[]> = {
  portrait: ["wikipedia", "web", "openverse", "commons"],
  celebrity: ["wikipedia", "web", "openverse", "commons"],
  vehicle: ["wikipedia", "commons", "web", "openverse"],
  product: ["wikipedia", "commons", "web", "openverse"],
  object: ["wikipedia", "commons", "web", "openverse"],
  map: ["commons", "wikipedia", "openverse"],
  reference: ["openverse", "commons", "web", "wikipedia"],
  general: ["openverse", "commons", "web", "wikipedia"],
};

/** Hosts images may be downloaded from (the web provider hands over bytes itself). */
export const IMAGE_HOSTS = [...HOSTS.wikimediaImages, HOSTS.openverse];
/** At most this many candidates are downloaded per provider before moving on. */
export const DOWNLOADS_PER_PROVIDER = 2;
/** A downloaded image must be at least this big on its short side, and not absurdly large. */
export const IMAGE_BOUNDS = { minSide: 64, maxPixels: 40_000_000 };

export interface ImagePipeline { providers: readonly ImageProvider[]; request?: Fetcher }

export interface ResolvedImage { bytes: Uint8Array; mime: string; width: number; height: number; candidate: ImageCandidate }

/** Checks downloaded bytes: a known image type whose header gives sane dimensions. */
export function checkImage(bytes: Uint8Array, mime: string) {
  const size = imageSize(bytes);
  if (!size) throw new ResolveError("image-invalid");
  if (Math.min(size.width, size.height) < IMAGE_BOUNDS.minSide || size.width * size.height > IMAGE_BOUNDS.maxPixels) throw new ResolveError("image-invalid");
  return { bytes, mime, ...size };
}

/**
 * Walks the provider chain for `intent`, recording every step in `trace.chain`. Fails with
 * `${kind}-not-found` when no provider had a usable candidate, or `${kind}-unavailable` when
 * candidates existed or providers failed but nothing could be downloaded.
 */
export async function resolveImage(query: string, intent: ImageIntent, pipeline: ImagePipeline, signal: AbortSignal,
  trace: ResolveTrace, kind: "image" | "portrait" = "image"): Promise<ResolvedImage> {
  let trouble = false;
  for (const name of PROVIDER_ORDER[intent]) {
    const provider = pipeline.providers.find(p => p.name === name);
    if (!provider) continue;
    const started = Date.now();
    let candidates: ImageCandidate[];
    try {
      candidates = await provider.search(query, intent, signal);
    } catch (error) {
      signal.throwIfAborted();
      trouble = true;
      trace.chain.push({ provider: name, outcome: errorCode(error), ms: Date.now() - started });
      continue;
    }
    const ranked = rankCandidates(candidates, query, intent);
    if (!ranked.length) {
      trace.chain.push({ provider: name, outcome: candidates.length ? `${candidates.length} found, none usable` : "no results", ms: Date.now() - started });
      continue;
    }
    for (const candidate of ranked.slice(0, DOWNLOADS_PER_PROVIDER)) {
      const fetchStarted = Date.now();
      try {
        const { bytes, mime } = candidate.load ? await candidate.load(signal)
          : await fetchImage(candidate.url, { hosts: IMAGE_HOSTS, signal, request: pipeline.request });
        const checked = checkImage(bytes, mime);
        trace.chain.push({ provider: name, outcome: `selected (${ranked.length} usable)`, ms: Date.now() - started });
        return { ...checked, candidate };
      } catch (error) {
        signal.throwIfAborted();
        trouble = true;
        trace.chain.push({ provider: name, outcome: `download ${errorCode(error)}`, ms: Date.now() - fetchStarted });
      }
    }
  }
  throw new ResolveError(`${kind}-${trouble ? "unavailable" : "not-found"}`);
}
