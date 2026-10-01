import { Aion } from "../core/aion";
import { planPresentation, type BodyVisual, type Presentation } from "../core/presentation";
import { SemanticPresence } from "../core/signal";
import type { ActivityState } from "../core/state";
import type { HubSnapshot } from "../host/hub/protocol";
import type { Framing, RuntimeHandle, RuntimeInputs } from "../render";
import { VisualActionController } from "../visual/controller";
import { visualForms } from "../visual/forms";
import { normalizeImage } from "../visual/image";
import type { MorphTarget } from "../visual/types";
import { decodeImage, rasterizeText } from "./glyphs";
import { buildPanel } from "./panel";
import type { ConnectionState, PresenceTransport } from "./transports/types";

export interface ViewElements {
  root: HTMLElement;
  panel: HTMLElement;
  status: HTMLElement;
  fullscreen: HTMLButtonElement;
  debug: HTMLElement;
}

type BodyRequest = Exclude<BodyVisual, { type: "none" }>;

/** The few words the status line may say, and only on a change. */
const STATE_WORDS: Partial<Record<ActivityState, string>> = {
  listening: "Listening", thinking: "Thinking", reading: "Reading", editing: "Editing", testing: "Testing",
  building: "Building", working: "Working", complete: "Done", error: "Something went wrong",
};

/**
 * One Aion on one surface. Snapshots from the transport drive Aion's activity, persistent body and gestures;
 * a presentation becomes a body visual (a form, a word, an image) through the same Visual Action controller
 * the original Presence used, and long or exact content stands beside the body in the panel. The view has no
 * idea which host it is in.
 */
export class PresenceView {
  readonly presence: SemanticPresence;
  readonly aion: Aion;
  readonly visual: VisualActionController<BodyRequest>;
  runtime: RuntimeHandle | null = null;
  snapshot: HubSnapshot | null = null;
  private activity: ActivityState = "idle";
  private panelOpen = false;
  private presentationId: string | null = null;
  private gestureId: number | null = null;
  private panelImages: string[] = [];
  private statusTimer?: ReturnType<typeof setTimeout>;
  private lastStatus = "";
  private connection: ConnectionState = "connecting";
  private fullscreenHinted = false;
  private wide = false;
  private readonly framed: Framing = { x: 0, y: 0, scale: 1 };

  constructor(private readonly elements: ViewElements, private readonly transport: PresenceTransport, options: { debug?: boolean } = {}) {
    this.visual = new VisualActionController<BodyRequest>((request, signal) => this.resolve(request, signal));
    this.aion = new Aion({ activity: () => this.activity, presenting: () => this.visual.presenting || this.panelOpen, signal: () => this.presence.signal });
    this.presence = new SemanticPresence(() => this.aion.currentState);
    elements.fullscreen.addEventListener("click", () => void this.toggleFullscreen());
    document.addEventListener("keydown", event => {
      if ((event.key === "f" || event.key === "F") && !event.metaKey && !event.ctrlKey && !event.altKey) void this.toggleFullscreen();
    });
    transport.onDisplayChange = () => this.updateFullscreenControl();
    this.updateFullscreenControl();
    if (options.debug) setInterval(() => this.renderDebug(), 500);
  }

  inputs(): RuntimeInputs { return { presence: this.presence, morph: this.visual, body: this.aion, framing: { sample: dt => this.frame(dt) } }; }

  /** The body steps aside for the panel: to the left on wide stages, upward on narrow ones; eased like a breath. */
  private frame(dt: number): Framing {
    const narrow = innerWidth <= 720 || innerWidth / Math.max(1, innerHeight) <= 0.8;
    const target: Framing = !this.panelOpen ? { x: 0, y: 0, scale: 1 }
      : narrow ? { x: 0, y: 0.22, scale: 0.72 }
        : this.wide ? { x: -0.27, y: 0, scale: 0.8 } : { x: -0.18, y: 0, scale: 1 };
    const k = 1 - Math.exp(-2.6 * Math.max(0, Math.min(0.1, dt)));
    this.framed.x += (target.x - this.framed.x) * k;
    this.framed.y += (target.y - this.framed.y) * k;
    this.framed.scale += (target.scale - this.framed.scale) * k;
    return this.framed;
  }

  apply = (snapshot: HubSnapshot) => {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    this.aion.setBody(snapshot.body);
    if (snapshot.gesture && snapshot.gesture.id !== this.gestureId) {
      // A fresh opening greets (the first snapshot of a window that was just opened, or a new open request).
      if (this.gestureId !== null || !previous) this.aion.gesture(snapshot.gesture.name);
      this.gestureId = snapshot.gesture.id;
    }
    if (snapshot.activity.state !== this.activity || snapshot.activity.label !== previous?.activity.label) {
      this.activity = snapshot.activity.state;
      const word = STATE_WORDS[snapshot.activity.state];
      if (word && previous) this.say([word, snapshot.activity.label].filter(Boolean).join(" · "));
    }
    const presentation = snapshot.presentation;
    if ((presentation?.id ?? null) !== this.presentationId) {
      this.presentationId = presentation?.id ?? null;
      void this.present(presentation);
    }
    if (snapshot.hub.display === "fullscreen" && this.transport.kind === "companion" && !this.fullscreenHinted && this.transport.fullscreen()?.active === false) {
      this.fullscreenHinted = true;
      this.say("Press F for fullscreen", 6_000);
    }
  };

  connectionChanged = (state: ConnectionState) => {
    if (state === this.connection) return;
    this.connection = state;
    if (state === "resting") this.say("Aion is resting · it returns when Codex opens it again", 0);
    else if (state === "live" && this.lastStatus.startsWith("Aion is resting")) this.say("", 0);
  };

  private async present(presentation: Presentation | null) {
    const id = presentation?.id ?? null;
    if (!presentation) {
      void this.visual.submit(null);
      this.closePanel();
      return;
    }
    const plan = planPresentation(presentation);
    void this.visual.submit(plan.body.type === "none" ? null : plan.body);
    if (!plan.panel) { this.closePanel(); return; }
    try {
      const content = await buildPanel(presentation, async mediaId => URL.createObjectURL(await this.transport.media(mediaId)));
      if (this.presentationId !== id) { content.images.forEach(url => URL.revokeObjectURL(url)); return; }
      this.releaseImages();
      this.panelImages = content.images;
      this.elements.panel.replaceChildren(...content.root.childNodes);
      this.elements.panel.classList.toggle("wide", content.wide);
      this.wide = content.wide;
      this.elements.panel.hidden = false;
      this.elements.panel.scrollTop = 0;
      this.panelOpen = true;
      // Next frame, so the transition runs from the hidden state.
      requestAnimationFrame(() => this.elements.root.classList.add("with-panel"));
    } catch {
      this.closePanel();
    }
  }

  private closePanel() {
    this.panelOpen = false;
    this.elements.root.classList.remove("with-panel");
    setTimeout(() => {
      if (this.panelOpen) return;
      this.elements.panel.hidden = true;
      this.elements.panel.replaceChildren();
      this.releaseImages();
    }, 1_000);
  }

  private releaseImages() { this.panelImages.forEach(url => URL.revokeObjectURL(url)); this.panelImages = []; }

  private async resolve(request: BodyRequest, signal: AbortSignal): Promise<MorphTarget> {
    switch (request.type) {
      case "form": {
        const form = visualForms.render(request.form, request.variant);
        return { visual: form.visual, hold: Infinity, label: visualForms.label(form.entry.id, form.variant), ...(form.transition ? { transition: form.transition } : {}), ...(form.spin ? { motion: { spin: form.spin } } : {}) };
      }
      case "text":
        return { visual: { kind: "raster2d", style: "glyph", raster: rasterizeText(request.text) }, hold: Infinity, label: request.text };
      case "image": {
        const blob = await this.transport.media(request.media.id);
        signal.throwIfAborted();
        return { visual: normalizeImage(await decodeImage(blob)), hold: Infinity, label: "image" };
      }
    }
  }

  /** One quiet line that fades after a few seconds (0: stays until replaced). */
  private say(text: string, ms = 4_500) {
    clearTimeout(this.statusTimer);
    this.lastStatus = text;
    const status = this.elements.status;
    if (!text) { status.classList.remove("visible"); return; }
    status.textContent = text;
    status.classList.add("visible");
    if (ms > 0) this.statusTimer = setTimeout(() => status.classList.remove("visible"), ms);
  }

  private updateFullscreenControl() {
    const fullscreen = this.transport.fullscreen();
    this.elements.fullscreen.hidden = !fullscreen;
    if (fullscreen) this.elements.fullscreen.setAttribute("aria-label", fullscreen.active ? "Exit fullscreen" : "Fullscreen");
  }

  private async toggleFullscreen() {
    try { await this.transport.fullscreen()?.toggle(); } catch { /* the browser or host declined */ }
    this.updateFullscreenControl();
  }

  private renderDebug() {
    const quality = this.runtime?.quality();
    this.elements.debug.hidden = false;
    this.elements.debug.textContent = [
      `surface ${this.transport.kind} · ${this.connection}`,
      `renderer ${this.runtime?.backend ?? "starting"}${quality ? ` · ${quality.count} particles · effects ${quality.effects ? "on" : "off"} · ${quality.frameMs.toFixed(1)} ms · frame ${quality.frames}` : ""}`,
      `state ${this.aion.currentState} · activity ${this.activity} · body ${this.aion.currentBody}`,
      `visual ${this.visual.phase} · revision ${this.snapshot?.revision ?? "-"} · hooks ${this.snapshot?.hub.hooksActive ? "active" : "not detected"}`,
    ].join("\n");
  }
}
