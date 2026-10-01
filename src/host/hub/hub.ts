import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { MediaRef } from "../../core/presentation";
import { PresenceStore, systemClock, type StoreClock } from "../../core/store";
import { interpretHook, isWorkState, type HookEvent } from "../hooks/mapping";
import { MediaStore, sniffImage } from "../media";
import { DEFAULT_PORT, HOOK_HEARTBEAT_FILE, HOOKS_ACTIVE_MS, HUB_FILE, presenceHome, TOKEN_FILE } from "../paths";
import { hookEventSchema, hubCommandSchema, mediaUploadSchema, type DisplayPreference, type HubCommand, type HubSnapshot } from "./protocol";

export interface HubOptions {
  /** Runtime directory (hub.json, token, hook heartbeat). Default: presenceHome(). */
  home?: string;
  /** Preferred port; 0 for any free port. Default AION_PRESENCE_PORT or DEFAULT_PORT. */
  port?: number;
  /** The presence surface page (the same single file the MCP Apps resource serves). */
  page: () => string;
  clock?: StoreClock;
}

export interface HubDiscovery { version: 1; pid: number; port: number; hub: string; url: string; startedAt: number }

const JSON_LIMIT = 64 * 1024;
const MEDIA_LIMIT = 12 * 1024 * 1024;

/** A model-set work state outranks a generic hook-derived "working" for this long. */
const MODEL_PRECEDENCE_MS = 120_000;

/**
 * The presence hub: the one place Aion's state lives while it is open. It is owned by the first Aion MCP
 * process that needs it and serves, on 127.0.0.1 only:
 *
 *   GET  /              the companion surface (the same page an MCP Apps host embeds)
 *   GET  /events        server-sent snapshots for companion windows
 *   GET  /api/state     a snapshot, optionally long-polled (other MCP processes, embedded views)
 *   POST /api/command   state commands from other Aion MCP processes
 *   POST /api/media     images handed over by other Aion MCP processes
 *   GET  /media/:id     image bytes for a surface
 *   POST /api/hook      Codex lifecycle hook events
 *   GET  /health        identity check for discovery
 *
 * Every route needs the per-user token (from the runtime directory, mode 0600) and a loopback Host header,
 * so other local users, web pages (DNS rebinding) and other sites cannot read or drive it.
 */
export class PresenceHub {
  readonly id = randomBytes(6).toString("hex");
  readonly store: PresenceStore;
  readonly media = new MediaStore();
  readonly home: string;
  private server: Server | null = null;
  private port = 0;
  private token = "";
  private revision = 0;
  private display: DisplayPreference = "auto";
  private readonly viewers = new Set<ServerResponse>();
  private readonly waiters = new Set<() => void>();
  private readonly clock: StoreClock;
  private cancelSettle: (() => void) | null = null;
  private turnActive = false;
  private lastHookAt = 0;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly options: HubOptions) {
    this.home = options.home ?? presenceHome();
    this.clock = options.clock ?? systemClock;
    this.store = new PresenceStore(this.clock);
    this.store.subscribe(() => this.changed());
  }

  get url() { return `http://127.0.0.1:${this.port}/`; }
  /** The companion address including its token (only ever given to the local user's browser). */
  get surfaceUrl() { return `${this.url}?token=${this.token}`; }
  get listening() { return this.server !== null; }

  async start(): Promise<void> {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.token = readOrCreateToken(this.home);
    const preferred = this.options.port ?? (Number(process.env.AION_PRESENCE_PORT) || DEFAULT_PORT);
    this.server = createServer((req, res) => { void this.route(req, res); });
    this.server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const listen = (port: number, retry: boolean) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (retry && error.code === "EADDRINUSE") listen(0, false); else reject(error);
        });
        server.listen(port, "127.0.0.1", () => { server.removeAllListeners("error"); resolve(); });
      };
      listen(preferred, preferred !== 0);
    });
    this.server.unref();
    this.port = (this.server.address() as AddressInfo).port;
    const discovery: HubDiscovery = { version: 1, pid: process.pid, port: this.port, hub: this.id, url: this.url, startedAt: this.clock.now() };
    writeFileSync(join(this.home, HUB_FILE), JSON.stringify(discovery), { mode: 0o600 });
    this.heartbeat = setInterval(() => { for (const viewer of this.viewers) viewer.write(": ping\n\n"); }, 20_000);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    this.cancelSettle?.();
    for (const viewer of this.viewers) viewer.end();
    this.viewers.clear();
    for (const wake of this.waiters) wake();
    const file = join(this.home, HUB_FILE);
    try {
      const current = JSON.parse(readFileSync(file, "utf8")) as HubDiscovery;
      if (current.hub === this.id) rmSync(file, { force: true });
    } catch { /* already gone */ }
    this.store.dispose();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  }

  snapshot(): HubSnapshot {
    const { revision: _ignored, ...state } = this.store.snapshot();
    return {
      ...state, revision: this.revision,
      hub: { id: this.id, url: this.url, viewers: this.viewers.size, display: this.display, hooksActive: this.hooksActive() },
    };
  }

  /** Codex hooks are trusted and running: one has reported recently (to this hub, or to the heartbeat file). */
  hooksActive(): boolean {
    const now = this.clock.now();
    if (now - this.lastHookAt < HOOKS_ACTIVE_MS) return true;
    try { return now - statSync(join(this.home, HOOK_HEARTBEAT_FILE)).mtimeMs < HOOKS_ACTIVE_MS; } catch { return false; }
  }

  /** Applies a validated command and returns the resulting snapshot. */
  apply(command: HubCommand): HubSnapshot {
    switch (command.type) {
      case "activity":
        this.cancelSettle?.();
        this.store.setActivity(command.state, { label: command.label, source: "model" });
        break;
      case "body": this.store.setBody(command.body); break;
      case "present": this.store.present(command.content, command.hold); break;
      case "clear": this.store.clearPresentation(); break;
      case "open":
        if (command.display && command.display !== this.display) { this.display = command.display; this.changed(); }
        // A fresh opening greets; a window that is already showing Aion does not greet again.
        if (this.viewers.size === 0) this.store.greet();
        break;
    }
    return this.snapshot();
  }

  addMedia(data: Buffer, mime: string): MediaRef {
    if (sniffImage(data) === null) throw new Error("image-invalid");
    return this.media.add(data, mime);
  }

  /** Resolves with the next snapshot newer than `after` (or at once when the hub is a different one). */
  waitFor(after: number, hub: string | undefined, ms: number): Promise<HubSnapshot> {
    if (hub !== this.id || this.revision > after || ms <= 0) return Promise.resolve(this.snapshot());
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(this.snapshot()); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** A Codex hook event, mapped to activity (see hooks/mapping.ts). */
  hook(event: HookEvent) {
    this.lastHookAt = this.clock.now();
    const decision = interpretHook(event);
    const current = this.store.snapshot().activity;
    switch (decision.type) {
      case "activity": {
        if (event.hook_event_name === "UserPromptSubmit") this.turnActive = true;
        this.cancelSettle?.(); this.cancelSettle = null;
        const modelWork = current.source === "model" && isWorkState(current.state) && this.clock.now() - current.since < MODEL_PRECEDENCE_MS;
        // A generic "working" never replaces something more specific the agent itself said it is doing.
        if (decision.state === "working" && modelWork) break;
        this.store.setActivity(decision.state, { label: decision.label, source: "hook" });
        break;
      }
      case "settle": {
        this.cancelSettle?.();
        const since = current.since;
        this.cancelSettle = this.clock.schedule(() => {
          this.cancelSettle = null;
          const now = this.store.snapshot().activity;
          if (now.since === since && now.source === "hook" && isWorkState(now.state)) this.store.setActivity(decision.state, { source: "hook" });
        }, decision.afterMs);
        break;
      }
      case "turn-end": {
        this.cancelSettle?.(); this.cancelSettle = null;
        if (current.state !== "error") this.store.setActivity(this.turnActive ? "complete" : "idle", { source: "hook" });
        this.turnActive = false;
        break;
      }
    }
    this.changed();
  }

  private changed() {
    this.revision++;
    const snapshot = this.snapshot();
    const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const viewer of this.viewers) viewer.write(frame);
    for (const wake of [...this.waiters]) wake();
  }

  private authorized(req: IncomingMessage, url: URL) {
    const host = req.headers.host ?? "";
    if (![`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host)) return false;
    const given = url.searchParams.get("token") ?? (req.headers["x-aion-token"] as string | undefined) ?? "";
    const a = Buffer.from(given), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (!this.authorized(req, url)) return send(res, 403, { error: "forbidden" });
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(this.options.page());
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, hub: this.id, pid: process.pid });
      if (req.method === "GET" && url.pathname === "/events") return this.subscribe(req, res);
      if (req.method === "GET" && url.pathname === "/api/state") {
        const after = Number(url.searchParams.get("after") ?? -1);
        const wait = Math.max(0, Math.min(25_000, Number(url.searchParams.get("wait") ?? 0)));
        return send(res, 200, await this.waitFor(Number.isFinite(after) ? after : -1, url.searchParams.get("hub") ?? undefined, wait));
      }
      const media = /^\/media\/(m[a-f0-9]{18})$/.exec(url.pathname);
      if (req.method === "GET" && media) {
        const item = this.media.get(media[1]);
        if (!item) return send(res, 404, { error: "not-found" });
        res.writeHead(200, { "Content-Type": item.mime, "Content-Length": item.bytes, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        return res.end(item.data);
      }
      if (req.method === "POST" && url.pathname === "/api/command") {
        const command = hubCommandSchema.safeParse(await readJson(req, JSON_LIMIT));
        if (!command.success) return send(res, 400, { error: "invalid-command" });
        return send(res, 200, this.apply(command.data as HubCommand));
      }
      if (req.method === "POST" && url.pathname === "/api/media") {
        const upload = mediaUploadSchema.safeParse(await readJson(req, MEDIA_LIMIT));
        if (!upload.success) return send(res, 400, { error: "invalid-media" });
        const data = Buffer.from(upload.data.data, "base64");
        const mime = sniffImage(data);
        if (!mime || data.length > 8 * 1024 * 1024) return send(res, 400, { error: "invalid-media" });
        return send(res, 200, this.addMedia(data, mime));
      }
      if (req.method === "POST" && url.pathname === "/api/hook") {
        const event = hookEventSchema.safeParse(await readJson(req, JSON_LIMIT));
        if (!event.success) return send(res, 400, { error: "invalid-hook" });
        this.hook(event.data);
        res.writeHead(204);
        return res.end();
      }
      return send(res, 404, { error: "not-found" });
    } catch (error) {
      return send(res, error instanceof Error && error.message === "too-large" ? 413 : 400, { error: "bad-request" });
    }
  }

  private subscribe(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.write(`retry: 2000\n\n`);
    this.viewers.add(res);
    req.on("close", () => { this.viewers.delete(res); this.changed(); });
    // Everyone (including the new viewer) learns the new viewer count.
    this.changed();
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("too-large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("invalid-json")); } });
    req.on("error", reject);
  });
}

/** The per-user token, created once (0600) so a restarted hub keeps the companion window's address valid. */
export function readOrCreateToken(home: string): string {
  const file = join(home, TOKEN_FILE);
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{48}$/.test(token)) return token;
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
