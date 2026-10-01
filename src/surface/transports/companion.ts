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
  private source: EventSource | null = null;

  constructor(private readonly token: string, private readonly base = new URL("/", location.href)) {
    document.addEventListener("fullscreenchange", () => this.onDisplayChange?.());
  }

  start(onSnapshot: (snapshot: HubSnapshot) => void, onConnection: (state: ConnectionState) => void) {
    onConnection("connecting");
    this.source = new EventSource(new URL(`events?token=${encodeURIComponent(this.token)}`, this.base));
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
