import type { ImageIntent } from "../../visual/types";

/** One image a provider found (SCF's ImageCandidate). `load` lets a provider hand over bytes directly. */
export interface ImageCandidate {
  provider: string;
  url: string;
  title: string;
  width?: number;
  height?: number;
  mime?: string;
  /** Provider-side relevance 0..1 (title/tag overlap with the query, search rank). */
  relevance: number;
  pageUrl?: string;
  license?: string;
  load?: (signal: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>;
}

export interface ImageProvider {
  readonly name: string;
  search(query: string, intent: ImageIntent, signal: AbortSignal): Promise<ImageCandidate[]>;
}

/** What the resolver did for the last request: every provider consulted, in order. Never contains credentials. */
export interface ResolveTrace {
  action: "image" | "portrait" | "terrain";
  query: string;
  status: "resolving" | "resolved" | "failed" | "cancelled";
  error?: string;
  chain: { provider: string; outcome: string; ms: number }[];
  provider?: string;
  source?: string;
  ms?: number;
}
