import { Aion } from "../core/aion";
import { GreetingGate } from "../core/guidance";
import { planPresentation, type BodyVisual, type Presentation } from "../core/presentation";
import { PresenceEngine } from "../core/signal";
import type { ActivityState } from "../core/state";
import type { HubSnapshot } from "../host/hub/protocol";
import type { Framing, RuntimeHandle, RuntimeInputs } from "../render";
import { VisualActionController } from "../visual/controller";
import { visualForms } from "../visual/forms";
import { decodeHeightField } from "../visual/heightfield";
import { normalizeImage } from "../visual/image";
import type { MorphTarget } from "../visual/types";
import { buildCard } from "./card";
import { decodeImage, rasterizeEmoji, rasterizeText } from "./glyphs";
import { ImmersiveController } from "./immersive";
import { MicrophoneListener, microphonePermission, requestMicrophone, type MicPermission } from "./microphone";
import type { ConnectionState, PresenceTransport } from "./transports/types";

export interface ViewElements {
  root: HTMLElement;
  card: HTMLElement;
  status: HTMLElement;
  fullscreen: HTMLButtonElement;
  debug: HTMLElement;
  entry: HTMLElement;
  enter: HTMLButtonElement;
}

/** A body visual with the seconds it stays formed (Infinity: until the presentation ends). */
type BodyRequest = Exclude<BodyVisual, { type: "none" }> & { hold: number };

/** Where local listening stands. "off": not asked (e.g. ?mic=0); "denied"/"unavailable": host states only. */
export type MicState = "off" | "requesting" | "ready" | "denied" | "unavailable";

/** The card's lifecycle on this surface. */
export type CardState = "none" | "loading" | "shown" | "leaving";

/** The few words the status line may say, and only on a change. */
const STATE_WORDS: Partial<Record<ActivityState, string>> = {
  listening: "Listening", thinking: "Thinking", reading: "Reading", editing: "Editing", testing: "Testing",
  building: "Building", working: "Working", complete: "Done", error: "Something went wrong",
};

/** Remembered (per browser, best effort) so the microphone explanation is shown once, not every session. */
const MIC_NOTE_KEY = "aion.presence.mic-note";

/**
 * One Aion on one surface. Snapshots from the transport drive Aion's activity, persistent body and gestures.
 * A presentation arrives already routed (BODY, CARD or HYBRID, see core/presentationRouter.ts): the body visual
 * forms through the same Visual Action controller the original Presence used, and a card stands beside the
 * living body — it never freezes it. The view has no idea which host it is in.
 */
export class PresenceView {
  readonly presence: PresenceEngine;
  readonly listener = new MicrophoneListener(() => this.microphoneLost());
  mic: MicState = "off";
  micPermission: MicPermission = "unknown";
  /** The greeting wave waits for the body to be on screen and for a quiet moment. */
  readonly greeting = new GreetingGate();
  readonly aion: Aion;
  readonly visual: VisualActionController<BodyRequest>;
  readonly immersive: ImmersiveController;
  runtime: RuntimeHandle | null = null;
  snapshot: HubSnapshot | null = null;
  cardState: CardState = "none";
  private stream: MediaStream | null = null;
  private activity: ActivityState = "idle";
  private presentationId: string | null = null;
  private gestureId: number | null = null;
  private cardImages: string[] = [];
  private statusTimer?: ReturnType<typeof setTimeout>;
  private lastStatus = "";
  private connection: ConnectionState = "connecting";
  private wide = false;
  private readonly framed: Framing = { x: 0, y: 0, scale: 1 };

  constructor(private readonly elements: ViewElements, private readonly transport: PresenceTransport, options: { debug?: boolean } = {}) {
    this.visual = new VisualActionController<BodyRequest>((request, signal) => this.resolve(request, signal));
    // The host's activity (hub) is the base; the engine layers local listening on top (see core/signal.ts). Only a
    // visual the body itself has become is "presenting": a card beside the body leaves it listening and answering.
    this.aion = new Aion({ activity: () => this.presence.activity, presenting: () => this.visual.presenting, signal: () => this.presence.signal });
    this.presence = new PresenceEngine({ state: () => this.aion.currentState, host: () => this.activity });
    this.immersive = new ImmersiveController({ entry: elements.entry, enter: elements.enter }, transport, () => this.userGesture());
    // An AnalyserNode fallback may wait for a first interaction (autoplay policy).
    for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => this.listener.resume(), { passive: true });
    elements.fullscreen.addEventListener("click", () => void this.toggleFullscreen());
    document.addEventListener("keydown", event => {
      if ((event.key === "f" || event.key === "F") && !event.metaKey && !event.ctrlKey && !event.altKey) void this.toggleFullscreen();
    });
    transport.onDisplayChange = () => this.updateFullscreenControl();
    transport.onSuperseded = () => this.retire();
    setInterval(() => {
      if (this.greeting.pending && this.greeting.update({ bodyReady: this.runtime !== null, userActive: this.presence.userVoiced }, Date.now())) this.aion.gesture("greeting");
    }, 150);
    this.updateFullscreenControl();
    if (options.debug) {
      setInterval(() => this.renderDebug(), 250);
      setInterval(() => this.transport.diagnostics?.(this.diagnostics()), 1_000);
    }
  }

  inputs(): RuntimeInputs { return { presence: this.presence, morph: this.visual, body: this.aion, framing: { sample: dt => this.frame(dt) } }; }

  /** The body steps aside for a card: to the left on wide stages, upward on narrow ones; eased like a breath. */
  private frame(dt: number): Framing {
    const narrow = innerWidth <= 720 || innerWidth / Math.max(1, innerHeight) <= 0.8;
    const open = this.cardState === "shown" || this.cardState === "loading";
    const target: Framing = !open ? { x: 0, y: 0, scale: 1 }
      : narrow ? { x: 0, y: 0.22, scale: 0.72 }
        : this.wide ? { x: -0.24, y: 0, scale: 0.86 } : { x: -0.17, y: 0, scale: 0.96 };
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
      if (this.gestureId !== null || !previous) this.greeting.request(Date.now());
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
      // A looked-up picture or terrain shown only as particles names itself and its public source, quietly, once.
      const caption = presentation?.route !== "body" ? ""
        : presentation.kind === "terrain" ? presentation.label
          : presentation.kind === "image" && presentation.alt ? [presentation.alt, presentation.credit].filter(Boolean).join(" · ") : "";
      if (caption) this.say(caption, 6_000);
    }
    this.immersive.update(snapshot.hub.display);
    this.updateFullscreenControl();
  };

  connectionChanged = (state: ConnectionState) => {
    if (state === this.connection) return;
    this.connection = state;
    if (state === "resting") this.say("Resting · I'll be back when Aion is opened again", 0);
    else if (state === "live" && this.lastStatus.startsWith("Resting")) this.say("", 0);
  };

  private async present(presentation: Presentation | null) {
    if (!presentation) {
      void this.visual.submit(null);
      this.closeCard();
      return;
    }
    const plan = planPresentation(presentation, presentation.route);
    const hold = presentation.bodyHold > 0 ? presentation.bodyHold : Infinity;
    void this.visual.submit(plan.body.type === "none" ? null : { ...plan.body, hold });
    if (!plan.card) { this.closeCard(); return; }
    // A card alone: the body turns toward it for a moment, then carries on living (listening, answering).
    if (plan.body.type === "none") this.aion.gesture("offering");
    await this.showCard(presentation);
  }

  private async showCard(presentation: Presentation) {
    const id = presentation.id;
    this.cardState = "loading";
    try {
      const content = await buildCard(presentation, { media: mediaId => this.transport.media(mediaId) });
      if (this.presentationId !== id) { content.images.forEach(url => URL.revokeObjectURL(url)); return; }
      this.releaseImages();
      this.cardImages = content.images;
      const card = this.elements.card;
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", () => this.dismiss());
      card.replaceChildren(dismiss, content.root);
      card.classList.toggle("wide", content.wide);
      card.dataset.route = presentation.route;
      card.dataset.kind = presentation.kind;
      this.wide = content.wide;
      card.hidden = false;
      card.scrollTop = 0;
      this.cardState = "shown";
      // Next frame, so the transition runs from the hidden state.
      requestAnimationFrame(() => this.elements.root.classList.add("with-card"));
    } catch {
      if (this.presentationId === id) this.closeCard();
    }
  }

  /** The user dismissed the card: the presentation ends everywhere (the body returns too). */
  private dismiss() {
    this.closeCard();
    void this.visual.submit(null);
    void this.transport.dismiss?.().catch(() => {});
  }

  private closeCard() {
    if (this.cardState === "none") return;
    this.cardState = "leaving";
    this.elements.root.classList.remove("with-card");
    setTimeout(() => {
      if (this.cardState !== "leaving") return;
      this.cardState = "none";
      this.elements.card.hidden = true;
      this.elements.card.replaceChildren();
      this.releaseImages();
    }, 900);
  }

  private releaseImages() { this.cardImages.forEach(url => URL.revokeObjectURL(url)); this.cardImages = []; }

  private async resolve(request: BodyRequest, signal: AbortSignal): Promise<MorphTarget> {
    const hold = request.hold;
    switch (request.type) {
      case "form": {
        const form = visualForms.render(request.form, request.variant);
        return { visual: form.visual, hold, label: visualForms.label(form.entry.id, form.variant), ...(form.transition ? { transition: form.transition } : {}), ...(form.spin ? { motion: { spin: form.spin } } : {}) };
      }
      case "text":
        return { visual: { kind: "raster2d", style: "glyph", raster: rasterizeText(request.text) }, hold, label: request.text };
      case "image": {
        const blob = await this.transport.media(request.media.id);
        signal.throwIfAborted();
        // The fit carries the request's intent: a portrait keeps SCF's head-and-shoulders band and portrait sampling.
        return { visual: normalizeImage(await decodeImage(blob), request.fit), hold, label: "image" };
      }
      case "terrain": {
        const blob = await this.transport.media(request.media.id);
        signal.throwIfAborted();
        return { visual: { kind: "heightfield", field: decodeHeightField(new Uint8Array(await blob.arrayBuffer())), style: request.style }, hold, label: "terrain" };
      }
      case "emoji":
        return { visual: { kind: "raster2d", style: "emoji", raster: rasterizeEmoji(request.emoji) }, hold, label: request.emoji };
    }
  }

  /**
   * A newer Aion window came to the foreground in this one's place: this one closes itself (a window opened for
   * Aion may), or, where the browser keeps it open, releases the microphone and rests.
   */
  private retire() {
    this.stopListening();
    this.transport.close();
    this.connection = "resting";
    window.close();
    setTimeout(() => this.say("Aion continues in its new window", 0), 300);
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
    // While the entry offers fullscreen, the corner control would only repeat it.
    this.elements.fullscreen.hidden = !fullscreen || this.immersive.phase === "offered";
    if (fullscreen) this.elements.fullscreen.setAttribute("aria-label", fullscreen.active ? "Exit fullscreen" : "Fullscreen");
  }

  private async toggleFullscreen() {
    try { await this.transport.fullscreen()?.toggle(); } catch { /* the browser or host declined */ }
    this.updateFullscreenControl();
  }

  /** Inside the user's Enter Presence click: audio may start now, and the microphone is asked for if it was not. */
  private userGesture() {
    this.listener.resume();
    if (this.mic === "off" && this.listenAllowed) void this.listen();
  }

  /** Whether this Presence may listen at all (false with ?mic=0, or when it is resting). */
  listenAllowed = false;

  /**
   * Local listening: asks for the microphone once, when Presence opens. Only loudness and voice activity are
   * computed, on this device: nothing is recorded, stored, uploaded or transcribed. Refused or unavailable,
   * Aion simply follows Codex's states, and says so once.
   */
  async listen() {
    this.listenAllowed = true;
    if (this.mic === "requesting" || this.mic === "ready") return;
    this.mic = "requesting";
    this.micPermission = await microphonePermission();
    let stream: MediaStream;
    try {
      stream = await requestMicrophone();
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.mic = denied ? "denied" : "unavailable";
      this.micPermission = await microphonePermission();
      if (denied) this.noteOnce("Microphone off · I can still answer, I just won't see when you speak");
      return;
    }
    this.micPermission = "granted";
    this.stream = stream;
    try {
      this.listener.attach(stream);
      this.presence.setMicrophone(this.listener);
      this.mic = "ready";
    } catch {
      this.mic = "unavailable";
      this.stopListening();
    }
  }

  private noteOnce(text: string) {
    try { if (localStorage.getItem(MIC_NOTE_KEY)) return; localStorage.setItem(MIC_NOTE_KEY, "1"); } catch { /* storage unavailable: once per page */ }
    this.say(text, 6_000);
  }

  /** Releases the microphone entirely (the page is closing). */
  stopListening() {
    this.presence.setMicrophone(null);
    this.listener.stop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private microphoneLost() { this.presence.setMicrophone(null); this.mic = "unavailable"; }

  /** Diagnostics for ?debug=1: the whole live chain, so a real device can be checked step by step. */
  diagnostics(): Record<string, string> {
    this.immersive.sync();
    const quality = this.runtime?.quality();
    const frame = this.presence.lastFrame;
    const signal = this.presence.signal;
    const presentation = this.snapshot?.presentation;
    const fullscreen = this.transport.fullscreen();
    return {
      surface: `${this.transport.kind} · ${this.connection} · immersive ${this.immersive.phase} · fullscreen ${fullscreen ? (fullscreen.active ? "on" : "off") : "unavailable"}`
        + ` · window ${outerWidth}×${outerHeight} of ${screen.availWidth}×${screen.availHeight} · ${document.hasFocus() ? "focused" : "background"}`,
      renderer: `${this.runtime?.backend ?? "starting"}${quality ? ` · ${quality.count} particles · effects ${quality.effects ? "on" : "off"} · ${quality.frameMs.toFixed(1)} ms · frame ${quality.frames}` : ""}`,
      mic: `${this.mic} · permission ${this.micPermission} · ${this.listener.path} · audio ${this.listener.audioState}${this.listener.deviceLabel ? ` · ${this.listener.deviceLabel}` : ""}`,
      vad: frame ? `rms ${(frame.rms ?? 0).toFixed(4)} · floor ${this.listener.vad.floor.toFixed(4)} · ${frame.voiced ? "voice" : "quiet"} · level ${frame.level.toFixed(2)} · echo ${this.presence.echo}` : "no microphone frames",
      activity: `host ${this.activity} → effective ${this.presence.activity}`,
      state: `${this.aion.currentState} · body ${this.aion.currentBody} · userAmplitude ${signal.userAmplitude.toFixed(2)} · responding ${signal.responding.toFixed(2)} · speaking ${signal.mode === "speaking" ? "yes" : "no"} · hostAudio ${this.presence.hostAudio}`,
      visual: `${this.visual.phase} · card ${this.cardState}${presentation ? ` · route ${presentation.route} (${presentation.reason})` : ""} · revision ${this.snapshot?.revision ?? "-"}`,
      hooks: this.snapshot?.hub.hooksActive ? "active" : "not detected",
    };
  }

  private renderDebug() {
    this.elements.debug.hidden = false;
    this.elements.debug.textContent = Object.entries(this.diagnostics()).map(([key, value]) => `${key} ${value}`).join("\n");
  }
}
