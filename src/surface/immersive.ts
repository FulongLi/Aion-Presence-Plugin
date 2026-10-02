import type { DisplayPreference } from "../host/hub/protocol";
import type { PresenceTransport } from "./transports/types";

/**
 * Immersive mode on this surface: the cleanest Aion-only presentation the environment permits. This is surface
 * adapter logic; Aion Core, the renderer and the Presentation Router know nothing about it.
 *
 *   embedded (MCP Apps)   ask the host for its fullscreen display mode, once. The host decides; its own composer,
 *                         voice controls or overlays may stay, and nothing here tries to hide them.
 *   companion (browser)   the window arrives in the foreground; the page sizes its own app window to the screen
 *                         (allowed for app windows, ignored in tabs), then offers one quiet "Enter Presence". That
 *                         click calls requestFullscreen synchronously — browsers require a user gesture, and no flag
 *                         or trick is used to avoid it. Fullscreen then lasts the whole session (visuals never
 *                         leave it); Esc exits as usual and Aion stays, with F or the corner control to return.
 *
 * A future desktop shell is one more adapter with its own window controls.
 */
export type ImmersivePhase = "off" | "offered" | "fullscreen" | "declined" | "host";

export interface ImmersiveElements { entry: HTMLElement; enter: HTMLButtonElement }

export class ImmersiveController {
  phase: ImmersivePhase = "off";
  private filled = false;
  private hostAsked = false;

  constructor(private readonly elements: ImmersiveElements, private readonly transport: PresenceTransport,
    /** Runs inside the same click, after fullscreen was requested (e.g. resuming audio, asking for the microphone). */
    private readonly onEnter: () => void = () => {}) {
    elements.enter.addEventListener("click", () => this.enter());
    elements.entry.addEventListener("keydown", event => { if (event.key === "Escape") this.decline(); });
    // Leaving fullscreen always resizes the page, so a missed fullscreenchange cannot leave the phase stale.
    document.addEventListener("fullscreenchange", () => this.sync());
    addEventListener("resize", () => this.sync());
  }

  /** Follows the browser's actual fullscreen state (companion). */
  sync() {
    if (this.transport.kind !== "companion") return;
    if (document.fullscreenElement) { if (this.phase !== "fullscreen") this.set("fullscreen"); }
    else if (this.phase === "fullscreen") this.set("declined"); // the user left (Esc): respected, never re-entered by itself
  }

  /** The hub's display preference changed (or a snapshot arrived). */
  update(display: DisplayPreference) {
    const wanted = display === "immersive" || display === "fullscreen";
    if (!wanted) { if (this.phase === "offered") this.set("off"); return; }
    if (this.transport.kind === "embedded") {
      if (!this.hostAsked) { this.hostAsked = true; void this.transport.requestFullscreen?.(); }
      this.set("host");
      return;
    }
    if (!this.filled) { this.filled = true; fillScreen(); }
    if (this.phase === "off") this.set(this.transport.fullscreen()?.active ? "fullscreen" : this.transport.fullscreen() ? "offered" : "declined");
  }

  /** The user's click: fullscreen is requested synchronously, inside the gesture, before anything else awaits. */
  enter() {
    const fullscreen = this.transport.fullscreen();
    const request = fullscreen && !fullscreen.active ? fullscreen.toggle() : Promise.resolve();
    this.onEnter();
    void request.then(() => this.set(document.fullscreenElement ? "fullscreen" : "declined"), () => this.set("declined"));
  }

  /** Stay in the window (Esc on the entry). */
  decline() { if (this.phase === "offered") this.set("declined"); }

  private set(phase: ImmersivePhase) {
    this.phase = phase;
    const show = phase === "offered";
    this.elements.entry.hidden = !show;
    if (show) requestAnimationFrame(() => this.elements.enter.focus({ preventScroll: true }));
  }
}

/** A companion app window fills the available screen (menu bar and dock stay). Ignored by browsers in tabs. */
function fillScreen() {
  try {
    const screenArea = screen as Screen & { availLeft?: number; availTop?: number };
    if (outerWidth >= screen.availWidth - 8 && outerHeight >= screen.availHeight - 8) return;
    moveTo(screenArea.availLeft ?? 0, screenArea.availTop ?? 0);
    resizeTo(screen.availWidth, screen.availHeight);
  } catch { /* not allowed here */ }
}
