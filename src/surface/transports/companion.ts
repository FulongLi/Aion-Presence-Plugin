import type { HubSnapshot } from "../../host/hub/protocol";
import type { ConnectionState, PresenceTransport } from "./types";

/**
 * The companion window: a page served by the local presence hub. Snapshots arrive over server-sent events;
 * if the hub goes away (its Codex session ended) the window rests and reconnects when a hub is back on the
 * same address. Fullscreen is the browser's own Fullscreen API, entered only from a user gesture.
 */
export class CompanionTransport implements PresenceTransport {
  readonly kind = "companion";
  onDisplayChange?: () => void;
  onSuperseded?: () => void;
  private source: EventSource | null = null;
  /** This window's own id, so the hub can tell windows apart (and retire an old one when a new one comes forward). */
  private readonly window = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => (byte % 36).toString(36)).join("");

  constructor(private readonly token: string, private readonly base = new URL("/", location.href)) {
    document.addEventListener("fullscreenchange", () => { this.onDisplayChange?.(); this.report(); });
    // The window tells the hub whether it is in front or fullscreen (nothing else), so "Open Aion" knows whether
    // it must bring a window forward.
    for (const type of ["focus", "blur"]) addEventListener(type, () => this.report());
    document.addEventListener("visibilitychange", () => this.report());
  }

  private report() {
    const body = { window: this.window, focused: document.hasFocus(), fullscreen: document.fullscreenElement !== null, visible: document.visibilityState === "visible" };
    void fetch(new URL("api/surface", this.base), {
      method: "POST", headers: { "content-type": "application/json", "x-aion-token": this.token }, body: JSON.stringify(body), keepalive: true,
    }).catch(() => {});
  }

  diagnostics(lines: Record<string, string>) {
    void fetch(new URL("api/diagnostics", this.base), {
      method: "POST", headers: { "content-type": "application/json", "x-aion-token": this.token }, body: JSON.stringify({ window: this.window, lines }),
    }).catch(() => {});
  }

  start(onSnapshot: (snapshot: HubSnapshot) => void, onConnection: (state: ConnectionState) => void) {
    onConnection("connecting");
    this.source = new EventSource(new URL(`events?token=${encodeURIComponent(this.token)}&window=${this.window}`, this.base));
    this.source.addEventListener("open", () => this.report());
    this.source.addEventListener("superseded", () => this.onSuperseded?.());
    this.source.addEventListener("snapshot", event => {
      onConnection("live");
      try { onSnapshot(JSON.parse((event as MessageEvent<string>).data) as HubSnapshot); } catch { /* ignore a malformed frame */ }
    });
    // EventSource reconnects by itself (the hub sends retry: 2000).
    this.source.onerror = () => onConnection("resting");
  }

  async media(id: string) {
    const response = await fetch(new URL(`media/${encodeURIComponent(id)}?token=${encodeURIComponent(this.token)}`, this.base));
    if (!response.ok) throw new Error("media-unavailable");
    return response.blob();
  }

  async dismiss() {
    await fetch(new URL("api/command", this.base), {
      method: "POST", headers: { "content-type": "application/json", "x-aion-token": this.token }, body: JSON.stringify({ type: "clear" }),
    });
  }

  fullscreen() {
    if (!document.fullscreenEnabled) return null;
    return {
      active: document.fullscreenElement !== null,
      toggle: async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      },
    };
  }

  close() { this.source?.close(); }
}
