import { App, type McpUiDisplayMode, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { HubSnapshot } from "../../host/hub/protocol";
import type { ConnectionState, PresenceTransport } from "./types";

/**
 * Embedded in an MCP Apps host (the standard io.modelcontextprotocol/ui bridge, via the official
 * ext-apps App). The view asks the Aion server for state through the host with the app-only presence_sync
 * tool, long-polling so changes arrive promptly, and fetches images with presence_media. Display modes are
 * exactly the ones the host declares in its host context; nothing else is assumed.
 */
export class McpAppsTransport implements PresenceTransport {
  readonly kind = "embedded";
  onDisplayChange?: () => void;
  private context: McpUiHostContext | undefined;
  private stopped = false;

  constructor(private readonly app: App) {
    app.onhostcontextchanged = params => {
      this.context = { ...this.context, ...params };
      this.onDisplayChange?.();
    };
    app.onteardown = async () => { this.stopped = true; return {}; };
    this.context = app.getHostContext();
  }

  /** Connects to the host; rejects when there is no MCP Apps host on the other side. */
  static async connect(timeoutMs = 3_000): Promise<McpAppsTransport> {
    const app = new App({ name: "Aion Presence", version: "1" }, { availableDisplayModes: ["inline", "fullscreen", "pip"] }, { autoResize: false });
    await Promise.race([
      app.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no-mcp-apps-host")), timeoutMs)),
    ]);
    return new McpAppsTransport(app);
  }

  get displayModes(): McpUiDisplayMode[] { return this.context?.availableDisplayModes ?? []; }
  get displayMode(): McpUiDisplayMode | undefined { return this.context?.displayMode; }

  start(onSnapshot: (snapshot: HubSnapshot) => void, onConnection: (state: ConnectionState) => void) {
    onConnection("connecting");
    void this.loop(onSnapshot, onConnection);
  }

  private async loop(onSnapshot: (snapshot: HubSnapshot) => void, onConnection: (state: ConnectionState) => void) {
    let after = -1, hub: string | undefined, failures = 0;
    while (!this.stopped) {
      try {
        const result = await this.app.callServerTool({ name: "presence_sync", arguments: { after_revision: after, ...(hub ? { hub } : {}), wait_ms: after < 0 ? 0 : 20_000 } });
        const snapshot = result.structuredContent as HubSnapshot | undefined;
        if (result.isError || !snapshot || typeof snapshot.revision !== "number") throw new Error("sync-failed");
        failures = 0;
        onConnection("live");
        if (snapshot.revision !== after || snapshot.hub.id !== hub) {
          after = snapshot.revision; hub = snapshot.hub.id;
          onSnapshot(snapshot);
        }
      } catch {
        failures++;
        onConnection("resting");
        await new Promise(resolve => setTimeout(resolve, Math.min(15_000, 1_000 * 2 ** Math.min(failures, 4))));
      }
    }
  }

  async media(id: string) {
    const result = await this.app.callServerTool({ name: "presence_media", arguments: { id } });
    const media = result.structuredContent as { mime?: string; data?: string } | undefined;
    if (result.isError || !media?.data || !media.mime) throw new Error("media-unavailable");
    const bytes = Uint8Array.from(atob(media.data), char => char.charCodeAt(0));
    return new Blob([bytes], { type: media.mime });
  }

  async dismiss() {
    await this.app.callServerTool({ name: "clear_presentation", arguments: {} });
  }

  async requestFullscreen() {
    if (!this.displayModes.includes("fullscreen") || this.displayMode === "fullscreen") return;
    try { await this.app.requestDisplayMode({ mode: "fullscreen" }); } catch { /* the host declined */ }
  }

  fullscreen() {
    if (!this.displayModes.includes("fullscreen")) return null;
    const active = this.displayMode === "fullscreen";
    const back: McpUiDisplayMode = this.displayModes.includes("inline") ? "inline" : this.displayModes[0];
    return { active, toggle: async () => { await this.app.requestDisplayMode({ mode: active ? back : "fullscreen" }).catch(() => {}); } };
  }

  close() { this.stopped = true; }
}
