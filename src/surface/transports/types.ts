import type { HubSnapshot } from "../../host/hub/protocol";

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
  close(): void;
}
