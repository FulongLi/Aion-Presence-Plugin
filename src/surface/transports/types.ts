import type { HubSnapshot, SurfaceAudio } from "../../host/hub/protocol";
import type { CardReport } from "../../cards/state";
import type { MapTile } from "../../cards/protocol";

export type ConnectionState = "connecting" | "live" | "resting";

/**
 * How a surface receives Aion's state. The view and the renderer never know which transport (and so which
 * host) they are in: an MCP Apps host and the companion window feed the same snapshots.
 */
export interface PresenceTransport {
  readonly kind: "embedded" | "companion";
  start(onSnapshot: (snapshot: HubSnapshot) => void, onConnection: (state: ConnectionState) => void): void;
  /** The bytes of a presented image. */
  media(id: string): Promise<Blob>;
  /** Fullscreen as this host offers it: null when it offers none. */
  fullscreen(): { active: boolean; toggle(): Promise<void> } | null;
  /** Called when the host's display options change (so the view can show or hide its fullscreen control). */
  onDisplayChange?: () => void;
  /** The host or user asked for fullscreen in open_presence; honoured only where the host offers it. */
  requestFullscreen?(): Promise<void>;
  /** The user dismissed what is being presented: end it at the source, so every surface returns to the body. */
  dismiss?(): Promise<void>;
  /** ?debug=1 only: hands the diagnostics to the host side (`npm run diagnose`). */
  diagnostics?(lines: Record<string, string>): void;
  /** A newer window was brought to the foreground in this one's place: this one should retire. */
  onSuperseded?: () => void;
  /** This window's own id (the companion), so it knows whether it is the one that plays music (v0.4.2). */
  readonly windowId?: string;
  /** Audio features the hub analysed (Codex's voice, another app's sound), as they arrive (v0.4.2). */
  onAudio?: (message: unknown) => void;
  /** Tells the hub where this window's own audio stands (states only, never audio). */
  audioStatus?(status: SurfaceAudio): void;
  /** v0.4.5: reports the interactive card this surface shows (validated again by the hub). */
  cardReport?(report: Omit<CardReport, "window">): Promise<void>;
  /** v0.6: a map tile for the Route Explorer, from the hub (companion only: an embedded view has none). */
  tile?(tile: MapTile): Promise<Blob>;
  /** v0.6: tells the hub the first-run welcome has been seen (remembered), or asks for it again. */
  welcome?(done: boolean): Promise<void>;
  close(): void;
}
