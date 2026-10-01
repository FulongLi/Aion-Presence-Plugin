import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaRef } from "../../core/presentation";
import { HUB_FILE, presenceHome, TOKEN_FILE } from "../paths";
import { PresenceHub, type HubDiscovery, type HubOptions } from "./hub";
import type { HubCommand, HubSnapshot } from "./protocol";

/** One way of reaching the presence hub: in this process, or over loopback HTTP in another one. */
export interface PresenceBackend {
  readonly kind: "local" | "remote";
  /** The companion address with its token, for the local user's browser. */
  readonly surfaceUrl: string;
  apply(command: HubCommand): Promise<HubSnapshot>;
  addMedia(data: Buffer, mime: string): Promise<MediaRef>;
  state(after?: number, hub?: string, waitMs?: number): Promise<HubSnapshot>;
  media(id: string): Promise<{ mime: string; data: Buffer } | null>;
  close(): Promise<void>;
}

class LocalBackend implements PresenceBackend {
  readonly kind = "local";
  constructor(readonly hub: PresenceHub) {}
  get surfaceUrl() { return this.hub.surfaceUrl; }
  async apply(command: HubCommand) { return this.hub.apply(command); }
  async addMedia(data: Buffer, mime: string) { return this.hub.addMedia(data, mime); }
  state(after = -1, hub?: string, waitMs = 0) { return this.hub.waitFor(after, hub ?? this.hub.id, waitMs); }
  async media(id: string) { const item = this.hub.media.get(id); return item ? { mime: item.mime, data: item.data } : null; }
  close() { return this.hub.stop(); }
}

class RemoteBackend implements PresenceBackend {
  readonly kind = "remote";
  constructor(private readonly base: string, private readonly token: string) {}
  get surfaceUrl() { return `${this.base}?token=${this.token}`; }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 4_000) {
    const response = await fetch(new URL(path, this.base), {
      ...init, headers: { "x-aion-token": this.token, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`hub-${response.status}`);
    return response;
  }

  async apply(command: HubCommand) { return (await this.request("api/command", { method: "POST", body: JSON.stringify(command) })).json() as Promise<HubSnapshot>; }
  async addMedia(data: Buffer, mime: string) {
    return (await this.request("api/media", { method: "POST", body: JSON.stringify({ mime, data: data.toString("base64") }) }, 15_000)).json() as Promise<MediaRef>;
  }
  async state(after = -1, hub?: string, waitMs = 0) {
    const query = new URLSearchParams({ after: String(after), wait: String(waitMs), ...(hub ? { hub } : {}) });
    return (await this.request(`api/state?${query}`, {}, waitMs + 4_000)).json() as Promise<HubSnapshot>;
  }
  async media(id: string) {
    try {
      const response = await this.request(`media/${id}`);
      return { mime: response.headers.get("content-type") ?? "application/octet-stream", data: Buffer.from(await response.arrayBuffer()) };
    } catch { return null; }
  }
  async close() {}

  /** Whether a hub that answers with its own id is alive at this address. */
  async alive(expectedHub: string) {
    try {
      const health = await (await this.request("health", {}, 600)).json() as { hub?: string };
      return health.hub === expectedHub;
    } catch { return false; }
  }
}

/**
 * Reaches the presence hub, wherever it is. Several Codex sessions may each run an Aion MCP server; the first
 * to need the hub starts it, the others find it through hub.json and talk to it, so every session drives the
 * same Aion. If the hub's owner has gone away, the next call takes over as the hub (with a fresh state).
 */
export class PresenceLink {
  private backend: PresenceBackend | null = null;
  private connecting: Promise<PresenceBackend> | null = null;
  readonly home: string;

  constructor(private readonly options: Omit<HubOptions, "home"> & { home?: string }) {
    this.home = options.home ?? presenceHome();
  }

  get current() { return this.backend; }

  connect(): Promise<PresenceBackend> {
    if (this.backend) return Promise.resolve(this.backend);
    this.connecting ??= this.discover().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Runs `action` against the hub; if a remote hub has vanished, reconnects (possibly becoming the hub) once. */
  async run<T>(action: (backend: PresenceBackend) => Promise<T>): Promise<T> {
    const backend = await this.connect();
    try {
      return await action(backend);
    } catch (error) {
      if (backend.kind !== "remote" || /^hub-4\d\d$/.test((error as Error).message)) throw error;
      this.backend = null;
      return action(await this.connect());
    }
  }

  async close() { await this.backend?.close(); this.backend = null; }

  private async discover(): Promise<PresenceBackend> {
    try {
      const found = JSON.parse(readFileSync(join(this.home, HUB_FILE), "utf8")) as HubDiscovery;
      const token = readFileSync(join(this.home, TOKEN_FILE), "utf8").trim();
      if (typeof found.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(found.url)) {
        const remote = new RemoteBackend(found.url, token);
        if (await remote.alive(found.hub)) return (this.backend = remote);
      }
    } catch { /* no hub yet */ }
    const hub = new PresenceHub({ ...this.options, home: this.home });
    await hub.start();
    return (this.backend = new LocalBackend(hub));
  }
}
