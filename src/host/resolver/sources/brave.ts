import { fetchImage, fetchJSON, HOSTS, overlap, type Fetcher } from "../net";
import { ResolveError } from "../../../visual/errors";
import type { ImageCandidate, ImageProvider } from "../types";

/**
 * Optional web-scale image search (SCF's server/imageSearch.ts): Brave Search's image API. It is **off by
 * default** and only exists when the user sets AION_PRESENCE_BRAVE_SEARCH_KEY themselves; the standard
 * experience needs no key. Only the query is sent, and only thumbnails on Brave's own image host are read.
 */
export const BRAVE_KEY_ENV = "AION_PRESENCE_BRAVE_SEARCH_KEY";
const SEARCH_URL = `https://${HOSTS.braveSearch}/res/v1/images/search`;

type BraveResult = {
  title?: string; url?: string; confidence?: string;
  thumbnail?: { src?: string; width?: number; height?: number };
  properties?: { width?: number; height?: number };
};

/** Brave results → candidates. Only thumbnails on Brave's own image host are considered. */
export function braveCandidates(results: BraveResult[], query: string, request?: Fetcher): ImageCandidate[] {
  const confidence: Record<string, number> = { high: 1, medium: 0.85, low: 0.7 };
  return results.flatMap((result, index): ImageCandidate[] => {
    const src = result.thumbnail?.src;
    if (!src) return [];
    let url: URL;
    try { url = new URL(src); } catch { return []; }
    if (url.protocol !== "https:" || url.hostname !== HOSTS.braveImages || url.port || url.username) return [];
    const title = (result.title ?? "").slice(0, 200);
    // Web titles are page titles, so a correct image often shares few words with the query.
    const relevance = Math.max(0.5, overlap(query, title)) * (confidence[result.confidence ?? ""] ?? 0.85) * (1 - Math.min(10, index) * 0.02);
    return [{
      provider: "web", url: url.href, title, relevance,
      width: result.properties?.width || result.thumbnail?.width, height: result.properties?.height || result.thumbnail?.height,
      pageUrl: result.url,
      load: async signal => fetchImage(url, { hosts: [HOSTS.braveImages], signal, request }),
    }];
  });
}

/** The provider, or null when the user has not configured a key (the default). */
export function braveProvider(env: NodeJS.ProcessEnv = process.env, request?: Fetcher): ImageProvider | null {
  const key = env[BRAVE_KEY_ENV]?.trim();
  if (!key) return null;
  return {
    name: "web",
    async search(query, _intent, signal) {
      const url = new URL(SEARCH_URL);
      url.search = new URLSearchParams({ q: query, count: "20", safesearch: "strict" }).toString();
      try {
        const { data } = await fetchJSON<{ results?: BraveResult[] }>(url, {
          hosts: [HOSTS.braveSearch], signal, request, headers: { "X-Subscription-Token": key },
        });
        return braveCandidates(Array.isArray(data.results) ? data.results.slice(0, 40) : [], query, request);
      } catch (error) {
        signal.throwIfAborted();
        throw error instanceof ResolveError ? error : new ResolveError("network");
      }
    },
  };
}
