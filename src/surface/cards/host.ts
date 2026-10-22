import CARD_RUNTIME from "aion:card-runtime";
import type { CardAppManifest, CardLayout } from "../../cards/manifest";
import { Lifecycle, type CardLifecycle } from "../../cards/lifecycle";
import { CARD_PROTOCOL_VERSION, type CardSelection, type FromCardMessage, type MapTile, type ResourceStatus, type SceneEdit } from "../../cards/protocol";
import type { CardAck, CardReport, CardSnapshot } from "../../cards/state";
import type { CardValue } from "../../cards/values";
import type { Presentation } from "../../core/presentation";
import { ParentBridge } from "./bridge";

/**
 * The Interactive Application Container (v0.4.5): one interactive card on the page. It creates the isolated frame —
 * `sandbox="allow-scripts"` without `allow-same-origin` (an opaque origin: no cookies, storage, parent DOM, hub or token),
 * a srcdoc document with its own restrictive CSP, no referrer, no permissions — hands it one MessagePort, and drives the
 * application lifecycle over the Card Bridge. It draws the universal controls (pause, reset, expand/collapse,
 * fullscreen, close), the loading, error and unsupported states, applies Codex's commands from the hub's card, and
 * reports meaningful state back. The page's own Aion never depends on the card: closing it releases everything.
 */
export type InteractivePresentation = Extract<Presentation, { kind: "interactive" }>;

export interface CardHostOptions {
  root: HTMLElement;
  presentation: InteractivePresentation;
  card: CardSnapshot;
  manifest: CardAppManifest;
  media(id: string): Promise<Blob>;
  theme(): { base: string; accent: string };
  reducedMotion: boolean;
  report(report: Omit<CardReport, "window">): void;
  layoutChanged(layout: CardLayout): void;
  close(): void;
  fullscreen(): { active: boolean; toggle(): Promise<void> } | null;
  attention(selection: CardSelection | null): void;
  interacting(on: boolean): void;
  /** v0.6: a map tile's bytes from Aion's hub (absent: the host has none to give, e.g. embedded). */
  tile?(tile: MapTile): Promise<Blob>;
  /** v0.6: where along the route the user points in the card (metres, or null): the body shows the same place. */
  cursor?(distance: number | null): void;
}

const ICONS = { pause: "❚❚", play: "▶", reset: "↺", expand: "⤢", collapse: "⤡", fullscreen: "⛶", close: "×" } as const;

export class InteractiveCardHost {
  readonly instance: string;
  readonly lifecycle: Lifecycle;
  private frame: HTMLIFrameElement | null = null;
  private bridge: ParentBridge | null = null;
  private presentation: InteractivePresentation;
  private layout: CardLayout;
  private applied: number;
  private queue: Promise<void> = Promise.resolve();
  private assetId: string | null = null;
  private pausedByUser = false;
  private disposed = false;
  private disposing: Promise<void> | null = null;
  private interactingTimer?: ReturnType<typeof setTimeout>;
  private reportTimer?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private readonly observer: ResizeObserver;
  private readonly pending: { state: Record<string, CardValue>; selection?: CardSelection | null; error?: { code: string; message: string } | null; acks: CardAck[]; resources?: ResourceStatus; interacting?: boolean; layout?: CardLayout; lifecycle?: CardLifecycle; scene?: CardReport["scene"]; route?: CardReport["route"]; edits: SceneEdit[] } = { state: {}, acks: [], edits: [] };
  /** v0.5: the newest scene revision from the hub, the one this frame has built, and whether one is being sent now. */
  private latestScene: { revision: number; document: NonNullable<CardSnapshot["scene"]>["document"]; history: { undo: number; redo: number } } | null = null;
  /** v0.5.1: the user's edits sent to the hub and not yet answered (by request id). */
  private readonly edits = new Set<string>();
  private sceneSent = 0;
  private sceneReady = false;
  private sceneBusy = false;
  /** v0.6: the newest route revision from the hub and the one this frame has drawn; tiles asked for and being fetched. */
  private latestRoute: { revision: number; route: NonNullable<CardSnapshot["route"]>["document"] } | null = null;
  private routeSent = 0;
  private routeReady = false;
  private routeBusy = false;
  private readonly tileQueue: MapTile[] = [];
  private readonly tileKeys = new Set<string>();
  private tilesActive = 0;
  /** What the frame reported when it was disposed (the cleanup check). */
  leftovers: { geometries: number; textures: number; urls: number; loops: number } | null = null;
  readonly elements: { bar: HTMLElement; name: HTMLElement; status: HTMLElement; body: HTMLElement; loading: HTMLElement; progress: HTMLElement; loadingText: HTMLElement; error: HTMLElement; errorText: HTMLElement; retry: HTMLButtonElement; buttons: Record<"pause" | "reset" | "size" | "fullscreen" | "close", HTMLButtonElement> };

  constructor(private readonly options: CardHostOptions) {
    this.presentation = options.presentation;
    this.instance = options.presentation.instance;
    this.layout = options.card.layout;
    // Commands already in the hub were for an earlier window: this one restores state instead of replaying them.
    this.applied = options.card.commands.at(-1)?.seq ?? 0;
    this.lifecycle = new Lifecycle(state => { this.pending.lifecycle = state; this.scheduleReport(); this.syncControls(); });
    this.elements = this.build();
    this.observer = new ResizeObserver(() => { clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.postResize(), 120); });
    this.observer.observe(this.elements.body);
    document.addEventListener("visibilitychange", this.visibility);
  }

  // ── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────────
  private build() {
    const root = this.options.root;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => { const e = document.createElement(tag); e.className = className; if (text !== undefined) e.textContent = text; return e; };
    const control = (key: keyof typeof ICONS, label: string, onClick: () => void) => {
      const b = make("button", `ws-button ws-${key}`, ICONS[key]);
      b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
      b.addEventListener("click", onClick);
      return b;
    };
    const name = make("span", "ws-name", this.presentation.title);
    const status = make("span", "ws-status");
    status.setAttribute("aria-live", "polite");
    const buttons = {
      pause: control("pause", "Pause", () => void (this.lifecycle.state === "paused" ? this.resume("user") : this.pause("user"))),
      reset: control("reset", "Reset", () => void this.reset()),
      size: control("expand", "Expand", () => this.setLayout(this.layout === "compact" ? "expanded" : "compact", true)),
      fullscreen: control("fullscreen", "Fullscreen", () => void this.toggleFullscreen()),
      close: control("close", "Close", () => this.options.close()),
    };
    const tools = make("div", "ws-controls");
    tools.setAttribute("role", "toolbar"); tools.setAttribute("aria-label", "Card controls");
    tools.append(buttons.pause, buttons.reset, buttons.size, buttons.fullscreen, buttons.close);
    const title = make("div", "ws-title");
    title.append(name, status);
    const bar = make("header", "ws-bar");
    bar.append(title, tools);
    const body = make("div", "ws-body");
    const loading = make("div", "ws-overlay ws-loading");
    const progress = make("i", "");
    const track = make("div", "ws-progress");
    track.append(progress);
    const loadingText = make("p", "", "Loading…");
    loading.append(track, loadingText);
    const error = make("div", "ws-overlay ws-error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    const errorText = make("p", "");
    const retry = make("button", "ws-retry", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => void this.retry());
    error.append(errorText, retry);
    body.append(loading, error);
    root.replaceChildren(bar, body);
    root.setAttribute("aria-label", this.presentation.title);
    root.dataset.app = this.presentation.app;
    root.addEventListener("keydown", this.keydown);
    return { bar, name, status, body, loading, progress, loadingText, error, errorText, retry, buttons };
  }

  private keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.layout === "fullscreen") { event.stopPropagation(); void this.exitFullscreen(); }
  };

  private visibility = () => {
    if (this.disposed) return;
    const hidden = document.visibilityState === "hidden";
    const reason = this.options.manifest.cleanup.onHidden === "pause" ? "codex" : "hidden";
    if (hidden && this.lifecycle.state !== "suspended" && this.lifecycle.state !== "error") {
      if (reason === "hidden" && this.lifecycle.send("suspend")) void this.bridge?.request("PAUSE", { reason: "hidden" });
    } else if (!hidden && this.lifecycle.state === "suspended") {
      if (this.lifecycle.send("wake")) void this.bridge?.request("RESUME", { reason: "hidden" });
    }
  };

  private syncControls() {
    const { buttons, status, loading, error } = this.elements;
    const state = this.lifecycle.state, paused = state === "paused";
    buttons.pause.textContent = paused ? ICONS.play : ICONS.pause;
    buttons.pause.setAttribute("aria-label", paused ? "Resume" : "Pause"); buttons.pause.title = paused ? "Resume" : "Pause";
    buttons.pause.disabled = buttons.reset.disabled = !(state === "active" || state === "paused" || state === "ready");
    buttons.size.textContent = this.layout === "compact" ? ICONS.expand : ICONS.collapse;
    const sizeLabel = this.layout === "compact" ? "Expand" : "Collapse";
    buttons.size.setAttribute("aria-label", sizeLabel); buttons.size.title = sizeLabel;
    buttons.size.hidden = this.layout === "fullscreen";
    const full = this.layout === "fullscreen";
    buttons.fullscreen.setAttribute("aria-label", full ? "Exit fullscreen" : "Fullscreen"); buttons.fullscreen.title = full ? "Exit fullscreen" : "Fullscreen";
    buttons.fullscreen.setAttribute("aria-pressed", String(full));
    loading.hidden = state !== "loading" && state !== "registered";
    error.hidden = state !== "error";
    status.textContent = state === "paused" ? "Paused" : state === "loading" ? "Loading" : state === "error" ? "Stopped" : state === "suspended" ? "Suspended" : "";
    this.options.root.dataset.lifecycle = state;
    this.options.root.dataset.layout = this.layout;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** Creates the isolated frame and starts the application. */
  mount() {
    this.lifecycle.send("launch");
    this.syncControls();
    this.options.layoutChanged(this.layout);
    void this.start();
  }

  private async start() {
    this.sceneSent = 0; this.sceneReady = false; this.routeSent = 0; this.routeReady = false;
    this.tileQueue.length = 0; this.tileKeys.clear();
    const frame = document.createElement("iframe");
    // Scripts only: no same-origin (opaque origin), no forms, popups, top navigation, downloads or pointer lock.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.setAttribute("loading", "eager");
    frame.title = this.presentation.title;
    frame.className = "ws-frame";
    const channel = new MessageChannel();
    this.bridge = new ParentBridge(channel.port1, this.instance, this.options.manifest, {
      message: message => this.receive(message),
      flooded: () => this.fail("card-flooding", "The card sent too many messages and was stopped."),
    });
    const loaded = new Promise<void>(resolve => frame.addEventListener("load", () => resolve(), { once: true }));
    frame.srcdoc = CARD_RUNTIME;
    this.elements.body.prepend(frame);
    this.frame = frame;
    await loaded;
    if (this.disposed || this.frame !== frame) return;
    // The one and only window message: the port, to this frame's window, which has an opaque origin ("*" is the only
    // target origin that reaches it; the port is useless to anyone else).
    frame.contentWindow?.postMessage({ aion: "card-port", v: CARD_PROTOCOL_VERSION, instance: this.instance, app: this.presentation.app }, "*", [channel.port2]);
    const theme = this.options.theme();
    const result = await this.bridge.request("INITIALIZE", {
      app: this.presentation.app, config: this.presentation.config, ...(Object.keys(this.options.card.state).length ? { state: this.options.card.state } : {}),
      layout: this.layout, reducedMotion: this.options.reducedMotion, theme, limits: this.options.manifest.resources,
    }, { seconds: this.options.manifest.resources.maxLoadSeconds + 10 });
    if (this.disposed || this.frame !== frame) return;
    if (!result.ok) { if (this.lifecycle.state !== "error") this.fail("card-start-failed", result.problem === "the card did not answer in time" ? "The card did not start in time." : "The card could not start."); return; }
    if (this.presentation.asset) await this.loadAsset();
    // v0.5: a scene card builds the hub's current scene before it is shown as active.
    if (this.options.manifest.capabilities.includes("scene-documents")) { this.sceneReady = true; await this.pumpScene(); }
    // v0.6: a route card draws the hub's current route before it is shown as active.
    if (this.options.manifest.capabilities.includes("route-documents")) { this.routeReady = true; await this.pumpRoute(); }
    if (this.disposed || this.frame !== frame || this.lifecycle.state === "error") return;
    this.postResize();
    const startPaused = this.presentation.config.paused === true || this.options.card.state.running === false || this.options.card.state.playing === false;
    if (startPaused) { this.lifecycle.send("pause"); await this.bridge.request("PAUSE", { reason: "codex" }); }
    else this.lifecycle.send("activate");
    if (document.visibilityState === "hidden") this.visibility();
  }

  private receive(message: FromCardMessage) {
    if (this.disposed && message.type !== "DISPOSED") return;
    switch (message.type) {
      case "READY": this.lifecycle.send("ready"); break;
      case "LOADING":
        this.elements.progress.style.width = `${Math.round(message.payload.progress * 100)}%`;
        this.elements.loadingText.textContent = message.payload.progress >= 1 ? "Ready" : `${message.payload.phase}…`;
        break;
      case "STATE_CHANGED": Object.assign(this.pending.state, message.payload.state); this.scheduleReport(); break;
      case "SELECTION_CHANGED": {
        const selection = message.payload.objectId === null ? null : message.payload;
        this.pending.selection = selection;
        this.scheduleReport();
        this.options.attention(selection);
        break;
      }
      case "INTERACTION":
        if (message.payload.kind === "escape") { if (this.layout === "fullscreen") void this.exitFullscreen(); break; }
        if (message.payload.kind === "pointer-down" || message.payload.kind === "wheel") this.setInteracting(true);
        if (message.payload.kind === "pointer-up") this.setInteracting(false);
        break;
      case "ERROR":
        if (message.payload.fatal) this.fail(message.payload.code, message.payload.message);
        else { this.flash(message.payload.message); this.pending.error = { code: message.payload.code, message: message.payload.message }; this.scheduleReport(); }
        break;
      case "RESOURCE_STATUS": this.pending.resources = message.payload; this.scheduleReport(); break;
      // v0.5.1: the user's own change, for the hub to validate and record (one per report, in order).
      case "EDIT":
        if (this.pending.edits.length >= 4) { this.flash("Too many changes at once"); break; }
        this.pending.edits.push(message.payload);
        this.edits.add(message.payload.request);
        this.scheduleReport(true);
        break;
      case "DISPOSED": this.leftovers = message.payload; break;
      case "RESULT": break;
      // v0.6: the pointer along the route (the body follows at once, here), and the tiles the card's map shows.
      case "CURSOR": this.options.cursor?.(message.payload.distance); break;
      case "TILE_REQUEST": this.queueTiles(message.payload.tiles); break;
    }
  }

  private setInteracting(on: boolean) {
    clearTimeout(this.interactingTimer);
    if (on) { if (this.pending.interacting !== true) { this.pending.interacting = true; this.options.interacting(true); this.scheduleReport(); } }
    // A moment after the user lets go (damping, a second drag), Aion's background motion returns.
    this.interactingTimer = setTimeout(() => { this.pending.interacting = false; this.options.interacting(false); this.scheduleReport(); }, on ? 6_000 : 1_200);
  }

  private flashTimer?: ReturnType<typeof setTimeout>;
  private flash(text: string) {
    clearTimeout(this.flashTimer);
    this.elements.status.textContent = text;
    this.flashTimer = setTimeout(() => this.syncControls(), 5_000);
  }

  private fail(code: string, message: string) {
    if (this.disposed) return;
    this.lifecycle.send("fail");
    const unsupported = code === "webgl-unavailable";
    this.elements.errorText.textContent = unsupported
      ? "This card needs WebGL 2, which this browser or host does not provide here. Aion is still here; the card cannot run on this device."
      : message;
    this.elements.retry.hidden = false;
    this.options.root.dataset.error = code;
    this.pending.error = { code, message: message.slice(0, 200) };
    this.scheduleReport(true);
    this.syncControls();
  }

  /** Retry after an error: a fresh frame, a fresh channel, the same card. */
  async retry() {
    if (!this.lifecycle.send("retry")) return;
    this.teardownFrame();
    this.pending.error = null;
    delete this.options.root.dataset.error;
    this.assetId = null;
    this.syncControls();
    await this.start();
  }

  private async loadAsset() {
    const asset = this.presentation.asset;
    if (!asset || !this.bridge) return;
    this.assetId = asset.id;
    this.elements.loadingText.textContent = "Loading the model…";
    if (this.lifecycle.state === "active" || this.lifecycle.state === "paused") this.lifecycle.send("reload");
    try {
      const data = await (await this.options.media(asset.id)).arrayBuffer();
      if (data.byteLength !== asset.bytes) throw new Error("size");
      // Integrity: the bytes are the ones the host validated (when this context can hash).
      if (crypto.subtle) {
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
        if (digest !== asset.sha256) throw new Error("integrity");
      }
      if (this.disposed || this.assetId !== asset.id) return;
      const result = await this.bridge.request("LOAD_ASSET", { asset: { id: asset.id, name: asset.name, kind: "model", bytes: asset.bytes, sha256: asset.sha256 }, data }, { transfer: [data], seconds: this.options.manifest.resources.maxLoadSeconds + 5 });
      if (!result.ok) { this.flash("The model could not be loaded"); this.pending.error = { code: /^model-[a-z-]+$/.test(result.problem) ? result.problem : "model-load-failed", message: "The model could not be loaded." }; this.scheduleReport(); }
    } catch (error) {
      const integrity = error instanceof Error && (error.message === "integrity" || error.message === "size");
      this.flash(integrity ? "The model failed its integrity check" : "The model is not available");
      this.pending.error = { code: integrity ? "asset-integrity" : "asset-unavailable", message: integrity ? "The model's bytes did not match what the host validated." : "The model could not be fetched." };
      this.scheduleReport();
    }
    if (this.lifecycle.state === "loading") { this.lifecycle.send("ready"); }
    if (this.lifecycle.state === "ready" && this.frame) {
      if (this.pausedByUser) { this.lifecycle.send("pause"); } else this.lifecycle.send("activate");
    }
  }

  /** The same card shown again with a new model or settings (one instance). */
  update(presentation: InteractivePresentation) {
    const asset = presentation.asset?.id !== this.presentation.asset?.id;
    this.presentation = presentation;
    this.elements.name.textContent = presentation.title;
    if (asset && presentation.asset && this.lifecycle.state !== "loading" && this.lifecycle.state !== "error") void this.loadAsset();
  }

  /** Applies the hub's card: its layout, its scene (v0.5) and any commands this window has not applied yet. */
  apply(card: CardSnapshot) {
    if (card.instance !== this.instance || this.disposed) return;
    if (card.layout !== this.layout) this.setLayout(card.layout, false);
    if (card.scene && card.scene.revision > (this.latestScene?.revision ?? 0)) { this.latestScene = { revision: card.scene.revision, document: card.scene.document, history: { undo: card.scene.undo, redo: card.scene.redo } }; void this.pumpScene(); }
    if (card.route && card.route.revision > (this.latestRoute?.revision ?? 0)) { this.latestRoute = { revision: card.route.revision, route: card.route.document }; void this.pumpRoute(); }
    // v0.5.1: the hub's answer to one of the user's edits: a refusal is said here (an accepted one arrives as a revision).
    const outcome = card.scene?.outcome;
    if (outcome && this.edits.delete(outcome.request) && !outcome.ok) this.flash(`Not applied: ${outcome.problem ?? "refused"}`.slice(0, 120));
    for (const entry of card.commands) {
      if (entry.seq <= this.applied) continue;
      this.applied = entry.seq;
      this.queue = this.queue.then(() => this.execute(entry.seq, entry.command, entry.value));
    }
  }

  /**
   * Sends the newest scene revision the frame has not built yet, one at a time (a burst of revisions sends only the
   * latest). The card answers once it has built it; that answer — built, or refused and why — is reported to the hub.
   */
  private async pumpScene() {
    const bridge = this.bridge;
    if (this.sceneBusy || !this.sceneReady || !bridge || this.disposed) return;
    const target = this.latestScene;
    if (!target || target.revision <= this.sceneSent) return;
    this.sceneBusy = true;
    try {
      const result = await bridge.request("LOAD_SCENE", { revision: target.revision, document: target.document, history: target.history }, { seconds: this.options.manifest.resources.maxLoadSeconds });
      if (this.disposed || this.bridge !== bridge) return;
      this.sceneSent = target.revision;
      this.pending.scene = { revision: target.revision, ok: result.ok, ...(result.ok ? {} : { problem: (result.problem ?? "failed").slice(0, 200) }) };
      if (!result.ok) this.flash("The scene could not be built");
      this.scheduleReport(true);
    } finally { this.sceneBusy = false; }
    void this.pumpScene();
  }

  /** v0.6: sends the newest route revision the frame has not drawn (a burst of revisions sends only the latest). */
  private async pumpRoute() {
    const bridge = this.bridge;
    if (this.routeBusy || !this.routeReady || !bridge || this.disposed) return;
    const target = this.latestRoute;
    if (!target || target.revision <= this.routeSent) return;
    this.routeBusy = true;
    try {
      const result = await bridge.request("LOAD_ROUTE", { revision: target.revision, route: target.route });
      if (this.disposed || this.bridge !== bridge) return;
      this.routeSent = target.revision;
      this.pending.route = { revision: target.revision, ok: result.ok, ...(result.ok ? {} : { problem: (result.problem ?? "failed").slice(0, 200) }) };
      if (!result.ok) this.flash("The route could not be drawn");
      this.scheduleReport(true);
    } finally { this.routeBusy = false; }
    void this.pumpRoute();
  }

  /**
   * v0.6: map tiles for the card, two at a time from Aion's hub (the tile policy asks for few parallel downloads); each
   * arrives in the frame as bytes. The frame never has a URL; a tile that cannot be fetched is simply not sent.
   */
  private queueTiles(tiles: MapTile[]) {
    if (!this.options.tile) return;
    for (const tile of tiles) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      if (this.tileKeys.has(key)) continue;
      this.tileKeys.add(key);
      this.tileQueue.push(tile);
    }
    // The newest requests are what the user is looking at now.
    while (this.tileQueue.length > 48) { const dropped = this.tileQueue.shift()!; this.tileKeys.delete(`${dropped.z}/${dropped.x}/${dropped.y}`); }
    this.pumpTiles();
  }

  private pumpTiles() {
    while (this.tilesActive < 2 && this.tileQueue.length && !this.disposed) {
      const tile = this.tileQueue.pop()!;
      this.tilesActive++;
      void (async () => {
        try {
          const blob = await this.options.tile!(tile);
          const mime = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
          const data = await blob.arrayBuffer();
          if (!this.disposed && this.bridge) await this.bridge.request("LOAD_TILE", { tile, mime, data }, { transfer: [data] });
        } catch { /* not available: the card keeps its coarser tile or its plain background */ }
        finally {
          this.tilesActive--;
          this.tileKeys.delete(`${tile.z}/${tile.x}/${tile.y}`);
          this.pumpTiles();
        }
      })();
    }
  }

  private async execute(seq: number, command: string, value: CardValue | undefined) {
    let result: { ok: boolean; problem?: string };
    if (this.disposed) return;
    // Wait (bounded) for a card that is still starting.
    for (let i = 0; i < 100 && (this.lifecycle.state === "loading" || this.lifecycle.state === "registered"); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.lifecycle.state === "error") result = { ok: false, problem: "the card stopped with an error" };
    else if (command === "pause") result = await this.pause("codex");
    else if (command === "resume") result = await this.resume("codex");
    else if (command === "reset") result = await this.reset();
    else result = this.bridge ? await this.bridge.request("EXECUTE_COMMAND", { command, ...(value !== undefined ? { value } : {}) }) : { ok: false, problem: "the card is not running" };
    this.pending.acks.push({ seq, ok: result.ok, ...(result.ok ? {} : { problem: (result.problem ?? "failed").slice(0, 200) }) });
    this.scheduleReport(true);
  }

  async pause(reason: "user" | "codex") {
    if (!this.bridge || !["active", "ready"].includes(this.lifecycle.state)) return this.lifecycle.state === "paused" ? { ok: true as const } : { ok: false as const, problem: "the card is not running" };
    const result = await this.bridge.request("PAUSE", { reason });
    if (result.ok) { this.pausedByUser = true; this.lifecycle.send("pause"); }
    return result;
  }

  async resume(reason: "user" | "codex") {
    if (!this.bridge || this.lifecycle.state !== "paused") return this.lifecycle.state === "active" ? { ok: true as const } : { ok: false as const, problem: "the card is not paused" };
    const result = await this.bridge.request("RESUME", { reason });
    if (result.ok) { this.pausedByUser = false; this.lifecycle.send("resume"); }
    return result;
  }

  async reset() {
    if (!this.bridge || !["active", "paused", "ready"].includes(this.lifecycle.state)) return { ok: false as const, problem: "the card is not running" };
    return this.bridge.request("RESET", {});
  }

  // ── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────────
  setLayout(layout: CardLayout, byUser: boolean) {
    if (!this.options.manifest.display.layouts.includes(layout) || layout === this.layout) return;
    this.layout = layout;
    this.syncControls();
    this.options.layoutChanged(layout);
    if (byUser) { this.pending.layout = layout; this.scheduleReport(true); }
    // The frame is resized by its observer as the layout transition runs.
  }

  private async toggleFullscreen() {
    if (this.layout === "fullscreen") return this.exitFullscreen();
    this.setLayout("fullscreen", true);
    // Inside the user's click: the browser's (or host's) fullscreen, for the whole of Aion (the body stays beside the card).
    const fullscreen = this.options.fullscreen();
    if (fullscreen && !fullscreen.active) { try { await fullscreen.toggle(); } catch { /* declined: the card still fills Aion's space */ } }
  }

  private async exitFullscreen() {
    this.setLayout("expanded", true);
    const fullscreen = this.options.fullscreen();
    if (fullscreen?.active) { try { await fullscreen.toggle(); } catch { /* already left */ } }
  }

  private postResize() {
    const body = this.elements.body;
    this.bridge?.post("RESIZE", { width: Math.round(body.clientWidth), height: Math.round(body.clientHeight), layout: this.layout });
  }

  // ── Reports ────────────────────────────────────────────────────────────────────────────────────────────────────
  private scheduleReport(soon = false) {
    if (this.reportTimer && !soon) return;
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => this.flushReport(), soon ? 30 : 250);
  }

  private flushReport() {
    this.reportTimer = undefined;
    const p = this.pending;
    const report: Omit<CardReport, "window"> = {
      instance: this.instance,
      ...(p.lifecycle ? { lifecycle: p.lifecycle } : {}), ...(p.layout ? { layout: p.layout } : {}),
      ...(Object.keys(p.state).length ? { state: p.state } : {}), ...(p.selection !== undefined ? { selection: p.selection } : {}),
      ...(p.error !== undefined ? { error: p.error } : {}), ...(p.acks.length ? { acks: p.acks.slice(-16) } : {}),
      ...(p.resources ? { resources: p.resources } : {}), ...(p.interacting !== undefined ? { interacting: p.interacting } : {}),
      ...(p.scene ? { scene: p.scene } : {}), ...(p.edits.length ? { edit: p.edits[0] } : {}), ...(p.route ? { route: p.route } : {}),
    };
    this.pending.state = {}; this.pending.acks = []; p.edits.shift();
    if (p.edits.length) this.scheduleReport(true);
    delete p.selection; delete p.error; delete p.resources; delete p.interacting; delete p.layout; delete p.lifecycle; delete p.scene; delete p.route;
    if (Object.keys(report).length > 1 && !this.disposed) this.options.report(report);
  }

  // ── Disposal ───────────────────────────────────────────────────────────────────────────────────────────────────
  private teardownFrame() {
    this.bridge?.close();
    this.bridge = null;
    this.frame?.remove();
    this.frame = null;
  }

  /** Releases everything: the application's resources (inside the frame), the channel, the frame and listeners. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = (async () => {
      this.lifecycle.send("dispose");
      this.disposed = true;
      clearTimeout(this.reportTimer); clearTimeout(this.interactingTimer); clearTimeout(this.resizeTimer); clearTimeout(this.flashTimer);
      if (this.pending.interacting) this.options.interacting(false);
      this.tileQueue.length = 0;
      this.options.cursor?.(null);
      this.observer.disconnect();
      document.removeEventListener("visibilitychange", this.visibility);
      this.options.root.removeEventListener("keydown", this.keydown);
      if (this.bridge?.open) await this.bridge.request("DISPOSE", {}, { seconds: 1.5 });
      this.teardownFrame();
      this.lifecycle.send("disposed");
      const root = this.options.root;
      if (root.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
    })();
    return this.disposing;
  }
}
