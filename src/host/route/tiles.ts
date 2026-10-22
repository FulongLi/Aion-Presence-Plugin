import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResolveError } from "../../visual/errors";
import { safeFetch, HOSTS, type Fetcher } from "../resolver/net";

/**
 * OpenStreetMap's standard map tiles for the Route Explorer card (v0.6), fetched by the hub only for the tiles the card
 * is showing right now, and kept as OpenStreetMap's tile usage policy asks
 * (https://operations.osmfoundation.org/policies/tiles/):
 *
 *   - an identifying User-Agent (the plugin's), never a library default; no no-cache headers;
 *   - only tiles the user is viewing: no prefetching, no bulk download, no offline use;
 *   - cached as the server's caching headers say, else for 7 days; expired tiles are revalidated with
 *     If-None-Match / If-Modified-Since;
 *   - at most two downloads at a time, and a steady rate (a busy view waits rather than floods);
 *   - the attribution "© OpenStreetMap contributors" stays visible on the map (the card draws it).
 *
 * AION_PRESENCE_TILES=off turns tiles off (the card then draws the route, the places and the profile on a plain
 * background). Tiles reveal which area is being looked at to the tile server, like any map; nothing else is sent.
 */
export const TILE_POLICY = { fallbackSeconds: 7 * 86_400, maxBytes: 1024 * 1024, parallel: 2, burst: 24, perSecond: 4, keep: 3000 } as const;
const TILE_URL = (z: number, x: number, y: number) => `https://${HOSTS.osmTiles}/${z}/${x}/${y}.png`;

interface Meta { etag?: string; lastModified?: string; expires: number }

export class TileCache {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private tokens: number = TILE_POLICY.burst;
  private last = Date.now();
  private writes = 0;
  readonly enabled: boolean;

  constructor(private readonly dir: string, private readonly options: { request?: Fetcher; env?: NodeJS.ProcessEnv; now?: () => number } = {}) {
    this.enabled = (options.env ?? process.env).AION_PRESENCE_TILES !== "off";
  }

  private now() { return this.options.now?.() ?? Date.now(); }

  /** The tile's PNG: from the cache while fresh, else (re)fetched. Throws `tiles-off`, `tiles-busy` or the fetch's code. */
  async get(z: number, x: number, y: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!this.enabled) throw new ResolveError("tiles-off");
    const file = join(this.dir, String(z), String(x), `${y}.png`), metaFile = `${file}.json`;
    let cached: Uint8Array | null = null, meta: Meta | null = null;
    try { cached = new Uint8Array(readFileSync(file)); meta = JSON.parse(readFileSync(metaFile, "utf8")) as Meta; } catch { cached = null; meta = null; }
    if (cached && meta && meta.expires > this.now()) return cached;
    if (!this.take()) {
      // Too many new tiles at once: a stale copy is better than nothing; otherwise the card asks again later.
      if (cached) return cached;
      throw new ResolveError("tiles-busy");
    }
    await this.slot();
    try {
      const headers: Record<string, string> = {};
      if (cached && meta?.etag) headers["If-None-Match"] = meta.etag;
      if (cached && meta?.lastModified) headers["If-Modified-Since"] = meta.lastModified;
      const fetched = await safeFetch(TILE_URL(z, x, y), { hosts: [HOSTS.osmTiles], mimes: ["image/png"], maxBytes: TILE_POLICY.maxBytes, signal, request: this.options.request, headers, timeoutMs: 10_000 });
      const next: Meta = { expires: this.now() + freshFor(fetched.headers) * 1000, ...(fetched.headers.get("etag") ? { etag: fetched.headers.get("etag")! } : meta?.etag ? { etag: meta.etag } : {}), ...(fetched.headers.get("last-modified") ? { lastModified: fetched.headers.get("last-modified")! } : meta?.lastModified ? { lastModified: meta.lastModified } : {}) };
      if (fetched.status === 304 && cached) { this.store(file, metaFile, null, next); return cached; }
      const bytes = fetched.bytes;
      if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new ResolveError("type");
      this.store(file, metaFile, bytes, next);
      return bytes;
    } catch (error) {
      if (cached) return cached;
      throw error;
    } finally { this.release(); }
  }

  private store(file: string, metaFile: string, bytes: Uint8Array | null, meta: Meta) {
    try {
      mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
      if (bytes) writeFileSync(file, bytes, { mode: 0o600 });
      writeFileSync(metaFile, JSON.stringify(meta), { mode: 0o600 });
      if (++this.writes % 200 === 0) this.prune();
    } catch { /* a cache that cannot be written only means fetching again later */ }
  }

  /** Keeps the cache bounded: the least recently written tiles go first. */
  prune() {
    const files: { path: string; at: number }[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const path = join(dir, name);
        try { const stat = statSync(path); if (stat.isDirectory()) walk(path); else if (name.endsWith(".png")) files.push({ path, at: stat.mtimeMs }); } catch { /* gone */ }
      }
    };
    walk(this.dir);
    if (files.length <= TILE_POLICY.keep) return;
    files.sort((a, b) => a.at - b.at);
    for (const { path } of files.slice(0, files.length - TILE_POLICY.keep)) { rmSync(path, { force: true }); rmSync(`${path}.json`, { force: true }); }
  }

  private take() {
    const now = this.now();
    this.tokens = Math.min(TILE_POLICY.burst, this.tokens + (now - this.last) / 1000 * TILE_POLICY.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  private slot(): Promise<void> {
    if (this.active < TILE_POLICY.parallel) { this.active++; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(() => { this.active++; resolve(); }));
  }

  private release() { this.active--; this.queue.shift()?.(); }
}

/** Seconds a tile stays fresh: the server's Cache-Control max-age, else its Expires, else the policy's 7 days. */
export function freshFor(headers: Headers, now = Date.now()): number {
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get("cache-control") ?? "");
  if (maxAge) return Number(maxAge[1]);
  const expires = Date.parse(headers.get("expires") ?? "");
  if (Number.isFinite(expires)) return Math.max(0, Math.round((expires - now) / 1000));
  return TILE_POLICY.fallbackSeconds;
}

/**
 * Whether a tile is one the open route's card may show: around the route (it may pan a little beyond it), at a zoom a
 * map of it uses. Everything else is refused, so the hub never becomes a general tile proxy.
 */
export function tileAllowed(z: number, x: number, y: number, box: [number, number, number, number]): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 2 || z > 18 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return false;
  const [west, south, east, north] = box;
  const padX = Math.max(east - west, 0.05), padY = Math.max(north - south, 0.05);
  const n = 2 ** z;
  const lon0 = x / n * 360 - 180, lon1 = (x + 1) / n * 360 - 180;
  const lat = (row: number) => 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n)));
  const lat1 = lat(y), lat0 = lat(y + 1);
  return lon1 >= west - padX && lon0 <= east + padX && lat1 >= south - padY && lat0 <= north + padY;
}
