import { Aion } from "../core/aion";
import { EXPLAIN, POINT } from "../core/figure/motion";
import { FIGURE_SCALE } from "../core/figure/skeleton";
import { ORBIT, OrbitController, type OrbitView } from "../render/interaction/orbit";
import { GreetingGate } from "../core/guidance";
import { planPresentation, type BodyVisual, type Presentation } from "../core/presentation";
import { PresenceEngine } from "../core/signal";
import { WritingDriver, strokesTarget } from "./writing";
import type { StrokeCard } from "./strokeCard";
import { SceneLayer } from "./scene";
import { compiledFor, sequenceFor } from "../animation/control";
import { evaluateSequence, STAGE, type CompiledSequence } from "../animation/scene/sequence";
import { phaseAt, positionAt, type PlaybackState as AnimationPlaybackState } from "../animation/timeline";
import type { ActivityState } from "../core/state";
import type { HubSnapshot } from "../host/hub/protocol";
import type { Framing, RuntimeHandle, RuntimeInputs } from "../render";
import { VisualActionController } from "../visual/controller";
import { visualForms } from "../visual/forms";
import { decodeHeightField } from "../visual/heightfield";
import { decodeMap } from "../visual/geo/map";
import { MarkerLayer, type BodyRoute } from "./markers";
import { Welcome } from "./welcome";
import { routeAlong, elevationAt } from "../visual/geo/route";
import { accentColor, particlePalette, type Appearance } from "../core/colors";
import { HOLD_SECONDS, markerWords, type GeoMarker } from "../core/presentation";
import { normalizeImage } from "../visual/image";
import type { MorphTarget } from "../visual/types";
import { buildCard } from "./card";
import { decodeImage, rasterizeEmoji, rasterizeText } from "./glyphs";
import { ImmersiveController } from "./immersive";
import { MicrophoneListener, microphonePermission, requestMicrophone, type MicPermission } from "./microphone";
import type { ConnectionState, PresenceTransport } from "./transports/types";
import { AudioVisualizer } from "./audioVisual";
import { TabAudioCapture, type TabCaptureState } from "./capture";
import { MusicPlayer, type PlaybackState } from "./music/player";
import { highlight as lightNotes, type RenderedScore } from "./music/notation";
import { decodeFeatures } from "../audio/wire";
import { checkScore, playbackEvents } from "../music/notation/score";
import { TEMPO } from "../music/theory/rhythm";
import type { PlaybackRequest } from "../core/store";
import { InteractiveCardHost, type InteractivePresentation } from "./cards/host";
import { cardRegistry } from "../core/cards";
import type { CardLayout } from "../cards/manifest";
import type { CardSelection } from "../cards/protocol";

export interface ViewElements {
  root: HTMLElement;
  card: HTMLElement;
  status: HTMLElement;
  fullscreen: HTMLButtonElement;
  debug: HTMLElement;
  entry: HTMLElement;
  enter: HTMLButtonElement;
  /** The overlay the places marked on a map or terrain are drawn on (optional: absent, no markers are drawn). */
  markers?: HTMLCanvasElement;
  /** v0.4.2: the quiet indicator of a connected sound source, its label and its one button (share a tab). */
  sound?: { root: HTMLElement; label: HTMLElement; action: HTMLButtonElement };
  /** v0.4.3: the overlay an action sequence's objects are drawn on (optional: absent, no props are drawn). */
  scene?: HTMLCanvasElement;
  /** v0.6: the first-run welcome (optional: absent, none is shown). */
  welcome?: HTMLElement;
  /** v0.6: the note an embedded view shows while Aion is in its own window (optional). */
  elsewhere?: HTMLElement;
  /** v0.4.5: where an interactive card (an isolated application) is shown (optional: absent, interactive cards are not shown). */
  workspace?: HTMLElement;
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
/** v0.5.1: how long the body re-forms a hybrid scene after a change to its shape. */
const BODY_ECHO_SECONDS = 4.5;

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
  private renderer: RuntimeHandle | null = null;
  /** The particle renderer. A replacement (the canvas after a lost GPU) gets Aion's colours at once. */
  get runtime() { return this.renderer; }
  set runtime(handle: RuntimeHandle | null) {
    this.renderer = handle;
    if (handle && this.appearance) handle.setPalette(particlePalette(this.appearance.base.hex), true);
  }
  snapshot: HubSnapshot | null = null;
  readonly markerLayer: MarkerLayer | null;
  private appearance: Appearance | null = null;
  private markersKey = "";
  cardState: CardState = "none";
  private stream: MediaStream | null = null;
  private activity: ActivityState = "idle";
  private presentationId: string | null = null;
  /** v0.5.1: the hybrid scene change the body last re-formed (presentation.bodyEcho). */
  private bodyEcho: number | null = null;
  private gestureId: number | null = null;
  private expressionId: number | null = null;
  private sceneViewId: number | null = null;
  /** How a formed 3D object is viewed: slow turn, drag, zoom (see render/interaction/orbit.ts). */
  readonly orbit = new OrbitController();
  /** Sound (v0.4.2): every source's features, the policy, the ring and the sphere's audio field. */
  readonly audio = new AudioVisualizer();
  /** The Music Library's playback; it sounds only in the window the hub chose (see playbackOwner). */
  readonly player = new MusicPlayer((id, state) => this.playbackChanged(id, state));
  /** A browser tab's sound, when the user shares one. */
  readonly tab = new TabAudioCapture(state => this.tabChanged(state));
  private playbackId: number | null = null;
  private playback: { id: number; state: PlaybackState } | null = null;
  /** The music card on show: its engraved score, its presentation and the note sounding now. */
  private music: { rendered: RenderedScore; presentation: Extract<Presentation, { kind: "music" }>; sounding: number | null } | null = null;
  private orbitRevision = -1;
  /** v0.4.3: a symbol being written (the renderer's writing uniforms) and its stroke-order card. */
  readonly writing = new WritingDriver();
  private strokeCard: StrokeCard | null = null;
  /** v0.4.3: the action sequence the figure performs, its playback, and the layer its objects are drawn on. */
  private performance: { presentation: string; sequence: CompiledSequence; playback: AnimationPlaybackState } | null = null;
  readonly sceneLayer: SceneLayer | null;
  private cardImages: string[] = [];
  /** v0.4.5: the interactive card on show (its isolated frame and bridge) and its layout. */
  private cardHost: InteractiveCardHost | null = null;
  private workspaceLayout: CardLayout | null = null;
  /** Cards closed on this page: how many, and what their frames reported left behind (the cleanup check). */
  readonly cardHistory: { opened: number; closed: number; leftovers: { geometries: number; textures: number; urls: number; loops: number }[] } = { opened: 0, closed: 0, leftovers: [] };
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
    // Codex's real voice (when the user has the bridge capture it) is the engine's host audio; Aion's own music keeps
    // the microphone from taking the speakers for the user.
    this.presence = new PresenceEngine({ state: () => this.aion.currentState, host: () => this.activity, audio: this.audio.hostAudio, playback: () => this.audio.playbackAudible });
    this.immersive = new ImmersiveController({ entry: elements.entry, enter: elements.enter }, transport, () => this.userGesture());
    this.sceneLayer = elements.scene ? new SceneLayer(elements.scene, {
      frame: () => {
        const performance = this.performance, visible = this.aion.figure.performing;
        if (!performance || visible <= 0) return null;
        return { objects: evaluateSequence(performance.sequence, positionAt(performance.playback, Date.now())).objects, visible: visible * this.aion.body.level };
      },
      project: point => this.runtime?.project(point) ?? null,
      colors: () => ({ base: this.appearance?.base.hex ?? "#a8bed1", accent: accentColor(this.appearance?.accent.hex ?? "#e2725b") }),
    }) : null;
    // v0.6: the welcome lives only in Aion's own window (the hub remembers it was seen).
    this.welcome = elements.welcome && transport.kind === "companion" ? new Welcome({ root: elements.welcome, dismissed: () => this.welcomeSeen() }) : null;
    this.markerLayer = elements.markers ? new MarkerLayer(elements.markers, {
      target: () => this.visual.phase === "sphere" ? null : this.visual.target,
      level: () => this.visual.level,
      project: point => this.runtime?.project(point) ?? null,
      accent: () => accentColor(this.appearance?.accent.hex ?? "#e2725b"),
    }) : null;
    // An AnalyserNode fallback may wait for a first interaction (autoplay policy); so may music.
    for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => { this.listener.resume(); if (this.playbackOwner) this.player.unlock(); }, { passive: true });
    transport.onAudio = message => {
      const frame = decodeFeatures(message);
      if (frame && (frame.source === "codex" || frame.source === "system")) this.audio.publish(frame.source, frame.features);
    };
    if (elements.sound) elements.sound.action.addEventListener("click", () => void this.shareTab());
    elements.fullscreen.addEventListener("click", () => void this.toggleFullscreen());
    document.addEventListener("keydown", event => {
      // Keys typed inside an interactive card's controls are the card's (the frame itself never passes keys up).
      if (elements.workspace?.contains(event.target as Node)) return;
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

  inputs(): RuntimeInputs {
    return {
      presence: this.presence, morph: this.visual, body: this.aion, framing: { sample: dt => this.frame(dt) }, orbit: { sample: dt => this.orbitFrame(dt) },
      audio: { sample: dt => this.soundFrame(dt) }, writing: { sample: dt => this.writingFrame(dt) },
    };
  }

  /** The writing uniforms (v0.4.3), while the formed target is the writing on show; the card follows the same moment. */
  private writingFrame(dt: number) {
    const target = this.visual.target, presentation = this.snapshot?.presentation;
    const active = target?.visual.kind === "strokes" && this.visual.phase !== "sphere" && presentation?.kind === "writing";
    const frame = this.writing.sample(dt, active);
    this.strokeCard?.update(this.writing.frame);
    return frame;
  }

  /**
   * Once per rendered frame: this page's own sources are measured (the microphone, a shared tab, Aion's music) and
   * published, the music card's lit note follows what is heard, and the body's sound frame is chosen.
   */
  private soundFrame(dt: number) {
    const sensitivity = this.audio.settings.sensitivity;
    if (this.listener.running) {
      this.listener.sensitivity = sensitivity;
      const mic = this.listener.features(dt);
      if (mic) this.audio.publish("microphone", mic);
    }
    const tab = this.tab.features(dt, sensitivity);
    if (tab) this.audio.publish("tab", tab);
    const music = this.player.features(dt);
    if (music) this.audio.publish("music", music);
    this.followPlayback();
    return this.audio.sample(dt);
  }

  /** Lets the user turn and zoom a formed 3D object on the stage. */
  attachOrbit(stage: HTMLElement) { return this.orbit.attach(stage); }

  /** The 3D view while the formed visual is a 3D object (each new one starts from its own default view). */
  private orbitFrame(dt: number): OrbitView {
    const target = this.visual.target;
    const solid = target?.visual.kind === "mesh3d" && this.visual.phase !== "sphere";
    if (solid && this.visual.revision !== this.orbitRevision) { this.orbitRevision = this.visual.revision; this.orbit.reset(target.motion); }
    this.orbit.active = solid;
    return this.orbit.sample(dt);
  }

  /** The body steps aside for a card: to the left on wide stages, upward on narrow ones; eased like a breath. */
  private frame(dt: number): Framing {
    const narrow = innerWidth <= 720 || innerWidth / Math.max(1, innerHeight) <= 0.8;
    const open = this.cardState === "shown" || this.cardState === "loading";
    // An interactive card (v0.4.5): the body steps aside by its layout — beside a compact card, into a slim strip beside
    // an expanded one, smaller still beside a fullscreen one. It stays itself and alive the whole time.
    const layout = this.workspaceLayout;
    if (layout) {
      const target: Framing = narrow
        ? { x: 0, y: layout === "compact" ? 0.3 : 0.38, scale: layout === "compact" ? 0.5 : layout === "expanded" ? 0.34 : 0.26 }
        : layout === "compact" ? { x: -0.25, y: 0, scale: 0.8 } : layout === "expanded" ? { x: -0.385, y: 0.02, scale: 0.4 } : { x: -0.44, y: 0.02, scale: 0.26 };
      return this.ease(target, dt);
    }
    // v0.6: the welcome stands below the body; the body rises a little above it, still itself and alive.
    if (this.welcome?.shown && !open) return this.ease(narrow ? { x: 0, y: 0.3, scale: 0.6 } : { x: 0, y: 0.2, scale: 0.74 }, dt);
    // A written word runs wider than other visuals (v0.4.4): it steps further aside and a little smaller.
    const word = (this.writing.sequence?.items.length ?? 0) > 1;
    const target: Framing = !open ? { x: 0, y: 0, scale: 1 }
      : narrow ? { x: 0, y: 0.22, scale: word ? 0.6 : 0.72 }
        : word ? { x: -0.25, y: 0, scale: 0.62 } : this.wide ? { x: -0.24, y: 0, scale: 0.86 } : { x: -0.17, y: 0, scale: 0.96 };
    return this.ease(target, dt);
  }

  private ease(target: Framing, dt: number): Framing {
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
    // A change of view for the 3D object on show ("rotate it", "from above").
    if (snapshot.sceneView && snapshot.sceneView.id !== this.sceneViewId) {
      if (previous) this.orbit.command(snapshot.sceneView);
      this.sceneViewId = snapshot.sceneView.id;
    }
    // An expression or gesture asked for by name; a window that opens later does not replay an old one.
    if (snapshot.expression && snapshot.expression.id !== this.expressionId) {
      if (previous) this.aion.express(snapshot.expression);
      this.expressionId = snapshot.expression.id;
    }
    if (snapshot.activity.state !== this.activity || snapshot.activity.label !== previous?.activity.label) {
      this.activity = snapshot.activity.state;
      const word = STATE_WORDS[snapshot.activity.state];
      if (word && previous) this.say([word, snapshot.activity.label].filter(Boolean).join(" · "));
    }
    // Aion's colours: the particles ease to the new base colour; the accent marks emphasis in cards.
    const appearance = snapshot.appearance;
    if (appearance && (appearance.base.hex !== this.appearance?.base.hex || appearance.accent.hex !== this.appearance?.accent.hex)) {
      const first = !this.appearance;
      this.appearance = appearance;
      this.runtime?.setPalette(particlePalette(appearance.base.hex), first);
      this.elements.root.style.setProperty("--accent", accentColor(appearance.accent.hex));
    }
    this.applyAudio(snapshot, previous);
    const presentation = snapshot.presentation;
    // Places marked on the map or terrain on show: they change in place, and the map stays up a while longer.
    const markers: GeoMarker[] = presentation?.kind === "map" ? presentation.markers : presentation?.kind === "terrain" ? presentation.markers ?? []
      : presentation?.kind === "interactive" ? presentation.terrain?.markers ?? [] : [];
    const markersKey = `${presentation?.id ?? ""}|${markers.map(marker => `${marker.id}:${marker.color}:${marker.lat},${marker.lon}:${marker.label}:${marker.highlight ? 1 : 0}`).join(";")}`;
    if (markersKey !== this.markersKey) {
      const samePresentation = (presentation?.id ?? null) === this.presentationId && this.markersKey.startsWith(`${presentation?.id ?? ""}|`);
      this.markersKey = markersKey;
      this.markerLayer?.set(markers);
      if (samePresentation && presentation) {
        this.visual.holdFor(presentation.hold === 0 ? Infinity : HOLD_SECONDS.map);
        if (markers.length) this.say(markerWords(markers), 5_000);
        if (this.cardState === "shown" && presentation.kind === "map") void this.showCard(presentation);
      }
    }
    // v0.4.3: the playhead of the animation on show (writing or an action sequence), on every change of it.
    const playback = snapshot.animation && snapshot.animation.presentation === presentation?.id ? snapshot.animation.playback : null;
    this.writing.set(presentation?.kind === "writing" ? presentation : null, playback);
    if (this.performance && presentation?.id === this.performance.presentation && playback) this.performance.playback = playback;
    if ((presentation?.id ?? null) !== this.presentationId) {
      this.presentationId = presentation?.id ?? null;
      void this.present(presentation);
      // A looked-up picture or terrain shown only as particles names itself and its public source, quietly, once.
      const caption = presentation?.route !== "body" ? ""
        : presentation.kind === "terrain" ? presentation.label
          : presentation.kind === "map" ? [presentation.label, markerWords(presentation.markers)].filter(Boolean).join(" · ")
            : presentation.kind === "image" && presentation.alt ? [presentation.alt, presentation.credit].filter(Boolean).join(" · ") : "";
      if (caption) this.say(caption, 6_000);
    }
    // v0.4.5: the interactive card on show follows the hub's card (its layout, Codex's commands).
    if (this.cardHost && snapshot.card?.instance === this.cardHost.instance) this.cardHost.apply(snapshot.card);
    // v0.6: the route on the terrain is the card's own route; its highlight and section follow what the card reports.
    this.applyRoute(snapshot);
    this.applyWelcome(snapshot, previous);
    // v0.5.1: a hybrid scene that changed shape: the body re-forms it for a moment beside the card, then returns.
    if (presentation?.kind === "interactive" && presentation.bodyEcho && presentation.bodyScene && presentation.id === this.presentationId && presentation.bodyEcho !== this.bodyEcho) {
      const first = this.bodyEcho === null;
      this.bodyEcho = presentation.bodyEcho;
      if (!first || Date.now() - presentation.bodyEcho < 10_000) { this.bodyKey = null; void this.visual.submit({ type: "scene", scene: presentation.bodyScene, hold: BODY_ECHO_SECONDS }); }
    } else if (presentation?.kind !== "interactive") this.bodyEcho = null;
    this.immersive.update(snapshot.hub.display);
    this.updateFullscreenControl();
  };

  /**
   * v0.6: the first-run welcome. Shown when the hub says it is due (the first launch, or "show me the introduction
   * again"), a moment after the body has appeared; remembered as seen once it has been on screen a few seconds; it steps
   * aside by itself as soon as Codex shows something (the user has started). An embedded view, while Aion is in its own
   * window, says so instead of showing a second Aion.
   */
  private readonly welcome: Welcome | null;
  private welcomeTimer?: ReturnType<typeof setTimeout>;
  private welcomeSent = false;
  private applyWelcome(snapshot: HubSnapshot, previous: HubSnapshot | null) {
    const elsewhere = this.elements.elsewhere;
    if (elsewhere && this.transport.kind === "embedded") {
      const away = snapshot.hub.surfaceMode === "companion" && snapshot.hub.viewers > 0;
      elsewhere.hidden = !away;
      elsewhere.textContent = away ? "Aion is open in its own window." : "";
      this.elements.root.classList.toggle("elsewhere-open", away);
    }
    const welcome = this.welcome;
    if (!welcome) return;
    const due = snapshot.hub.welcome, wasDue = previous?.hub.welcome ?? false;
    if (snapshot.presentation && welcome.shown) { welcome.hide(); this.welcomeSeen(); return; }
    if (due && (!wasDue || !previous) && !welcome.shown && !snapshot.presentation) {
      clearTimeout(this.welcomeTimer);
      this.welcomeSent = false;
      this.welcomeTimer = setTimeout(() => {
        if (this.snapshot?.presentation) return;
        welcome.show();
        // Seen: remembered once it has been on screen a little while, even if the user just starts talking.
        setTimeout(() => { if (welcome.shown) this.welcomeSeen(); }, 6_000);
      }, previous ? 200 : 1_400);
    }
  }
  private welcomeSeen() {
    if (this.welcomeSent) return;
    this.welcomeSent = true;
    void this.transport.welcome?.(true);
  }

  /**
   * Forms what a presentation's body shows. v0.6: the same terrain (same height field, same style) that is already
   * formed is kept and only held longer — a route drawn on the terrain on show, a reversed route, or a route's card
   * closed back to its terrain never re-forms the land.
   */
  private bodyKey: string | null = null;
  private formBody(body: ReturnType<typeof planPresentation>["body"], hold: number) {
    const key = body.type === "terrain" ? `terrain:${body.media.id}:${body.style}` : null;
    if (key && key === this.bodyKey && this.visual.presenting && this.visual.phase !== "returning") { this.visual.holdFor(hold); return; }
    this.bodyKey = key;
    void this.visual.submit(body.type === "none" ? null : { ...body, hold });
  }

  /** The route over the particle terrain (v0.6), from the hub's card: the same document the Route Explorer draws. */
  private routeKey = "";
  private applyRoute(snapshot: HubSnapshot) {
    const layer = this.markerLayer, presentation = snapshot.presentation, card = snapshot.card;
    const route = presentation?.kind === "interactive" && presentation.terrain && card?.instance === presentation.instance ? card.route : null;
    if (!layer) return;
    if (!route) { if (this.routeKey) { this.routeKey = ""; layer.setRoute(null); } return; }
    const key = `${route.document.id}:${route.revision}`;
    if (key !== this.routeKey) {
      this.routeKey = key;
      const document = route.document;
      const body: BodyRoute = { id: key, coordinates: document.coordinates, along: routeAlong(document), origin: document.origin, destination: document.destination, waypoints: document.waypoints };
      layer.setRoute(body);
    }
    // What the card highlights, as it reported it (Codex's "show the highest point", or the user's click).
    const state = card!.state, kind = state.highlight;
    const km = typeof state.highlightKm === "number" ? state.highlightKm : null;
    const highlight = km !== null && kind !== "none" && kind !== "section" && kind !== "steepest" ? (() => {
      const elevation = typeof state.highlightM === "number" ? state.highlightM : elevationAt(route.document, km * 1000);
      const name = kind === "highest" ? "Highest" : kind === "lowest" ? "Lowest" : kind === "start" ? route.document.origin.name : kind === "end" ? route.document.destination.name : `${km.toFixed(1)} km`;
      return { distance: km * 1000, label: `${name}${elevation === null ? "" : ` · ${Math.round(elevation)} m`}` };
    })() : null;
    const match = typeof state.sectionKm === "string" ? /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(state.sectionKm) : null;
    layer.setFocus({ highlight, section: match ? [Number(match[1]) * 1000, Number(match[2]) * 1000] : null });
  }

  connectionChanged = (state: ConnectionState) => {
    if (state === this.connection) return;
    this.connection = state;
    if (state === "resting") this.say("Resting · I'll be back when Aion is opened again", 0);
    else if (state === "live" && this.lastStatus.startsWith("Resting")) this.say("", 0);
  };

  private async present(presentation: Presentation | null) {
    // An action sequence ends with its presentation: the figure eases back and the body returns to its own form.
    if (this.performance && this.performance.presentation !== presentation?.id) { this.performance = null; this.aion.perform(null); }
    // An interactive card (v0.4.5) ends with its presentation, unless the same card is shown again.
    if (this.cardHost && !(presentation?.kind === "interactive" && presentation.instance === this.cardHost.instance)) this.closeWorkspace();
    if (presentation?.kind === "interactive") { this.presentInteractive(presentation); return; }
    if (!presentation) {
      this.formBody({ type: "none" }, 0);
      this.closeCard();
      return;
    }
    const plan = planPresentation(presentation, presentation.route);
    if (plan.body.type === "performance" && presentation.kind === "animation") {
      // The body itself performs: nothing forms, the figure is borrowed for it (v0.4.3).
      this.formBody({ type: "none" }, 0);
      this.closeCard();
      const playback = this.snapshot?.animation?.presentation === presentation.id ? this.snapshot.animation.playback : null;
      if (!playback) return;
      const performance = { presentation: presentation.id, sequence: compiledFor(presentation.sequence), playback };
      this.performance = performance;
      this.aion.perform({
        frame: () => this.performance === performance ? evaluateSequence(performance.sequence, positionAt(performance.playback, Date.now())).channels : null,
        // The scene a moment ago (in its own time, at its speed): its secondary motion is a pure function of the scene.
        past: secondsAgo => {
          if (this.performance !== performance) return null;
          const at = positionAt(performance.playback, Date.now()) - secondsAgo * performance.playback.rate;
          return at < 0 ? null : evaluateSequence(performance.sequence, at).channels;
        },
        stage: STAGE,
      });
      return;
    }
    const hold = presentation.bodyHold > 0 ? presentation.bodyHold : Infinity;
    this.formBody(plan.body, hold);
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
      this.music = content.music && presentation.kind === "music" ? { rendered: content.music, presentation, sounding: null } : null;
      this.strokeCard?.dispose?.();
      this.strokeCard = content.writing ?? null;
      // The card's own play button plays it here, at once (the click is also what lets a browser sound).
      content.play?.addEventListener("click", () => this.playCard());
      card.classList.toggle("wide", content.wide);
      card.dataset.route = presentation.route;
      card.dataset.kind = presentation.kind;
      this.wide = content.wide;
      card.hidden = false;
      card.scrollTop = 0;
      this.cardState = "shown";
      // Next frame, so the transition runs from the hidden state.
      requestAnimationFrame(() => this.elements.root.classList.add("with-card"));
      // Once the body has stepped aside, it turns to the card: the figure points at it (and explains an emphasised
      // term), the eyes glance at it.
      setTimeout(() => { if (this.presentationId === id) this.attendToCard(); }, 1_100);
    } catch {
      if (this.presentationId === id) this.closeCard();
    }
  }

  /**
   * An interactive card (v0.4.5): the isolated application stands beside the living body. A hybrid also forms the
   * application's particle form for a moment. The same instance shown again only updates it (a new model, new settings).
   */
  private presentInteractive(presentation: InteractivePresentation) {
    const workspace = this.elements.workspace, card = this.snapshot?.card, manifest = cardRegistry.get(presentation.app);
    const plan = planPresentation(presentation, presentation.route);
    const hold = presentation.bodyHold > 0 ? presentation.bodyHold : Infinity;
    this.formBody(plan.body, hold);
    if (!workspace || !manifest || !card || card.instance !== presentation.instance) return;
    if (this.cardHost?.instance === presentation.instance) { this.cardHost.update(presentation); return; }
    this.closeCard();
    workspace.hidden = false;
    const host = new InteractiveCardHost({
      root: workspace, presentation, card, manifest,
      media: id => this.transport.media(id),
      theme: () => ({ base: this.appearance?.base.hex ?? "#a8bed1", accent: accentColor(this.appearance?.accent.hex ?? "#e2725b") }),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      report: report => { void this.transport.cardReport?.(report); },
      layoutChanged: layout => {
        this.workspaceLayout = layout;
        const root = this.elements.root;
        root.dataset.workspace = layout;
        requestAnimationFrame(() => root.classList.add("with-workspace"));
      },
      close: () => this.dismiss(),
      fullscreen: () => this.transport.fullscreen(),
      attention: selection => this.attendToSelection(selection),
      interacting: on => this.runtime?.setFrameCap?.(on && this.workspaceLayout !== "compact" ? 30 : null),
      ...(this.transport.tile ? { tile: (tile: Parameters<NonNullable<PresenceTransport["tile"]>>[0]) => this.transport.tile!(tile) } : {}),
      cursor: distance => this.markerLayer?.setFocus({ cursor: distance }),
    });
    this.cardHost = host;
    this.cardHistory.opened++;
    host.mount();
    host.apply(card);
    // The body turns toward the application once it has stepped aside.
    setTimeout(() => { if (this.cardHost === host && plan.body.type === "none") this.attendToSelection(null); }, 1_300);
  }

  /** Closes the interactive card: the frame and everything in it are released, and the body returns to its place. */
  private closeWorkspace() {
    const host = this.cardHost, workspace = this.elements.workspace;
    if (!host) return;
    this.cardHost = null;
    this.workspaceLayout = null;
    this.runtime?.setFrameCap?.(null);
    this.elements.root.classList.remove("with-workspace");
    delete this.elements.root.dataset.workspace;
    void host.dispose().then(() => {
      this.cardHistory.closed++;
      if (host.leftovers) this.cardHistory.leftovers.push(host.leftovers);
      if (workspace && !this.cardHost) setTimeout(() => { if (!this.cardHost) { workspace.hidden = true; workspace.replaceChildren(); } }, 600);
    });
  }

  /**
   * The body attends to the interactive card: toward the selected object when the application reported exactly where it
   * is on screen, otherwise toward the card as a whole (never an invented point).
   */
  private attendToSelection(selection: CardSelection | null) {
    const workspace = this.elements.workspace;
    if (!workspace || this.visual.presenting || !this.cardHost) return;
    const frame = workspace.querySelector<HTMLElement>(".ws-body") ?? workspace;
    const box = frame.getBoundingClientRect();
    const exact = selection?.screen ? { x: box.left + selection.screen.x * box.width, y: box.top + selection.screen.y * box.height } : null;
    const at = exact ?? { x: box.left + Math.min(box.width * 0.12, 80), y: box.top + box.height * 0.45 };
    const world = this.runtime?.toWorld(at.x, at.y);
    if (this.aion.currentBody === "figure" && world) {
      this.aion.figure.cue(exact ? EXPLAIN([world[0] / FIGURE_SCALE, world[1] / FIGURE_SCALE, 0.25]) : POINT([world[0] / FIGURE_SCALE, world[1] / FIGURE_SCALE, 0.25], 1.2));
    } else if (this.aion.currentBody === "eyes") {
      this.aion.glance([0.85, world ? Math.max(-0.75, Math.min(0.75, world[1] * 0.38)) : 0], exact ? 2.6 : 1.8);
    }
  }

  /** The body turns to the card beside it. Only while the body is itself (not formed into a visual). */
  private attendToCard() {
    if (this.visual.presenting || this.cardState !== "shown") return;
    const card = this.elements.card;
    // What is being explained: an emphasised term, or the first lit note of a music card.
    const term = card.querySelector<HTMLElement>("mark.emphasis") ?? card.querySelector<HTMLElement>(".music-score .lit.music-note, .music-score .lit");
    const target = (term ?? card.querySelector<HTMLElement>(".card-body > :not(.dismiss)") ?? card).getBoundingClientRect();
    const world = this.runtime?.toWorld(term ? target.left + target.width / 2 : target.left, target.top + Math.min(target.height / 2, 60));
    if (this.aion.currentBody === "figure" && world) {
      const at: [number, number, number] = [world[0] / FIGURE_SCALE, world[1] / FIGURE_SCALE, 0.25];
      this.aion.figure.cue(term ? EXPLAIN(at) : POINT(at, 1.2));
    } else if (this.aion.currentBody === "eyes") {
      this.aion.glance([0.85, world ? Math.max(-0.75, Math.min(0.75, world[1] * 0.38)) : 0], term ? 4 : 2.2);
      if (term) this.aion.eyes.express("curious", 4.5);
    }
  }

  /**
   * The user dismissed the card: the presentation ends everywhere (the body returns too). v0.6: a route's card closes and
   * the route goes, but the terrain it was drawn on stays formed (the hub keeps it), so the body does not leave it.
   */
  private dismiss() {
    const presentation = this.snapshot?.presentation;
    const keepTerrain = presentation?.kind === "interactive" && !!presentation.terrain && this.transport.kind === "companion";
    this.closeWorkspace();
    this.closeCard();
    if (keepTerrain) this.markerLayer?.setRoute(null); else this.formBody({ type: "none" }, 0);
    void this.transport.dismiss?.().catch(() => {});
  }

  private closeCard() {
    this.music = null;
    this.strokeCard?.dispose?.();
    this.strokeCard = null;
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
        // Heritage: the same photograph in an antique oval (see visual/oval.ts).
        return { visual: normalizeImage(await decodeImage(blob), request.fit, { portraitStyle: request.style }), hold, label: "image" };
      }
      case "terrain": {
        const blob = await this.transport.media(request.media.id);
        signal.throwIfAborted();
        return { visual: { kind: "heightfield", field: decodeHeightField(new Uint8Array(await blob.arrayBuffer())), style: request.style }, hold, label: "terrain" };
      }
      case "map": {
        const blob = await this.transport.media(request.media.id);
        signal.throwIfAborted();
        return { visual: { kind: "map", map: decodeMap(new Uint8Array(await blob.arrayBuffer())) }, hold, label: "map" };
      }
      case "emoji":
        return { visual: { kind: "raster2d", style: "emoji", raster: rasterizeEmoji(request.emoji) }, hold, label: request.emoji };
      case "scene":
        // A 3D object: it forms in a turned, slightly elevated view and turns slowly (unless the scene holds still).
        return {
          visual: { kind: "mesh3d", scene: request.scene }, hold, label: request.scene.title, transition: { form: 2, return: 1.5 },
          motion: { orbit: request.scene.rotation === "none" ? 0 : ORBIT.spin, tilt: (request.scene.tilt ?? 15) * Math.PI / 180 },
        };
      case "writing": {
        // A writing (v0.4.3; v0.4.4 true outlines and words): sampled once with each grain's reveal key; the writing uniforms do the rest.
        const sequence = sequenceFor(request);
        if (!sequence) throw new Error("stroke-symbol-unknown");
        return { visual: strokesTarget(sequence, request.highlight), hold, label: sequence.symbol };
      }
      case "performance":
        throw new Error("not-a-visual");
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
      this.reportAudio();
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
    this.reportAudio();
  }

  private noteOnce(text: string) {
    try { if (localStorage.getItem(MIC_NOTE_KEY)) return; localStorage.setItem(MIC_NOTE_KEY, "1"); } catch { /* storage unavailable: once per page */ }
    this.say(text, 6_000);
  }

  /** Releases the microphone entirely (the page is closing). */
  stopListening() {
    this.tab.stop();
    this.player.stop(false);
    this.presence.setMicrophone(null);
    this.listener.stop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private microphoneLost() { this.presence.setMicrophone(null); this.mic = "unavailable"; this.audio.bus.setConnected("microphone", false, performance.now() / 1000); this.reportAudio(); }

  // ── Sound and music (v0.4.2) ─────────────────────────────────────────────────────────────────────────────────

  /** This window plays music and opens captures: the newest companion window, or the embedded view when none is open. */
  get playbackOwner(): boolean {
    const hub = this.snapshot?.hub;
    if (!hub) return false;
    if (this.transport.kind === "embedded") return hub.viewers === 0;
    return !hub.audioWindow || hub.audioWindow === this.transport.windowId;
  }

  private applyAudio(snapshot: HubSnapshot, previous: HubSnapshot | null) {
    const audio = snapshot.audio;
    if (!audio) return;
    this.audio.settings = audio.settings;
    // A bridge source that is not streaming drives nothing, whatever frames arrived before.
    const now = performance.now() / 1000;
    for (const source of ["codex", "system"] as const) {
      if (!(audio.bridge.state === "streaming" && audio.bridge.source === source)) this.audio.bus.setConnected(source, false, now);
    }
    // A tab is shared only by a click here; choosing another source stops sharing it.
    if (audio.settings.source !== "tab" && audio.settings.source !== "auto" && this.tab.state === "connected") this.tab.stop();
    this.updateSound();
    // Music to play: a new request, in the one window that plays (a window that opens later never replays an old one).
    const playback = snapshot.playback;
    if (playback && playback.id !== this.playbackId) {
      const fresh = this.playbackId !== null || !previous;
      this.playbackId = playback.id;
      if (fresh && previous && this.playbackOwner) void this.player.play(playback);
      else if (fresh && !previous && playback.stop) this.player.stop(false);
    }
  }

  /** The card's play button: the music on show, here and now. */
  private playCard() {
    const music = this.music;
    if (!music) return;
    const check = checkScore(music.presentation.score);
    if (!check.ok) return;
    this.player.unlock();
    const request: PlaybackRequest = { id: -Date.now(), events: playbackEvents(check.value), tempo: music.presentation.tempo ?? TEMPO.default, volume: 0.8, presentation: music.presentation.id };
    void this.player.play(request);
  }

  /** The lit note follows what is heard; the figure points at it and the eyes follow it. */
  private followPlayback() {
    const position = this.player.position();
    const music = this.music;
    if (!music) return;
    const sounding = position && position.presentation === music.presentation.id ? position.index : null;
    if (sounding === music.sounding) return;
    music.sounding = sounding;
    lightNotes(music.rendered, music.presentation.highlight ?? [], sounding);
    if (sounding !== null) this.attendToNote(music.rendered.notes[sounding]);
  }

  /** The body turns to a note of the music card (the figure points, the eyes glance). */
  private attendToNote(note: SVGElement | null | undefined) {
    if (!note || this.visual.presenting || this.cardState !== "shown") return;
    const box = note.getBoundingClientRect();
    const world = this.runtime?.toWorld(box.left + box.width / 2, box.top + box.height / 2);
    if (!world) return;
    if (this.aion.currentBody === "figure") this.aion.figure.cue(POINT([world[0] / FIGURE_SCALE, world[1] / FIGURE_SCALE, 0.25], 0.5));
    else if (this.aion.currentBody === "eyes") this.aion.glance([0.85, Math.max(-0.75, Math.min(0.75, world[1] * 0.38))], 0.8);
  }

  private playbackChanged(id: number, state: PlaybackState) {
    if (id < 0) { if (state === "blocked") this.say("Click once to let Aion play sound"); return; }
    this.playback = { id, state };
    if (state === "blocked") this.say("Click anywhere in Aion's window to hear the music", 8_000);
    this.reportAudio();
  }

  /** Shares a tab's sound (only from the user's click on "Share tab audio"). */
  private async shareTab() {
    const state = await this.tab.start();
    if (state === "denied") this.say("No tab audio shared · choose a tab and keep \"Share tab audio\" on", 6_000);
    if (state === "unavailable") this.say("This browser cannot share a tab's sound here", 6_000);
  }

  private tabChanged(_state: TabCaptureState) {
    this.audio.bus.setConnected("tab", this.tab.state === "connected", performance.now() / 1000);
    this.updateSound();
    this.reportAudio();
  }

  /** Tells the hub where this window's audio stands, so Codex never claims more than is true. */
  private reportAudio() {
    const microphone = this.mic === "ready" ? "connected" : this.mic === "off" ? "off" : this.mic === "requesting" ? "requesting" : this.mic;
    this.transport.audioStatus?.({ microphone, tab: this.tab.state, ...(this.playback ? { playback: this.playback } : {}) });
  }

  /** The quiet indicator: a captured source that is really connected, or the one click a tab share needs. */
  private updateSound() {
    const sound = this.elements.sound, audio = this.snapshot?.audio;
    if (!sound || !audio) return;
    const bridge = audio.bridge;
    let label = "", action = "";
    if (!audio.settings.enabled) label = "";
    else if (bridge.state === "streaming" && !bridge.silentCapture) label = bridge.source === "codex" ? "Codex voice" : `Sound · ${bridge.app ?? "this Mac"}`;
    else if (bridge.state === "streaming") label = "Sound capture silent · allow System Audio Recording";
    else if (bridge.state === "starting" && bridge.waiting) label = bridge.source === "codex" ? "Codex voice · ready" : "Sound · waiting";
    else if (bridge.state === "starting") label = "Connecting sound…";
    if (audio.settings.enabled && audio.settings.source === "tab") {
      if (this.tab.state === "connected") label = label ? `${label} · Tab audio` : "Tab audio";
      else if (this.playbackOwner || this.transport.kind === "embedded") action = this.tab.state === "requesting" ? "" : "Share tab audio";
    }
    sound.root.hidden = !label && !action;
    sound.root.classList.toggle("waiting", !label);
    sound.label.textContent = label;
    sound.action.hidden = !action;
    sound.action.textContent = action;
  }

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
      interactive: this.cardHost ? `${this.cardHost.instance} · ${this.cardHost.lifecycle.state} · ${this.workspaceLayout} · opened ${this.cardHistory.opened} closed ${this.cardHistory.closed}` : `none · opened ${this.cardHistory.opened} closed ${this.cardHistory.closed}`,
      animation: (() => {
        const animation = this.snapshot?.animation;
        if (!animation) return "none";
        const at = positionAt(animation.playback, Date.now()), phase = phaseAt(animation.playback, Date.now());
        const writing = this.writing.frame, performance = this.performance;
        const detail = writing ? `writing ${writing.phase} · stroke ${writing.stroke + 1} · progress ${writing.progress.toFixed(2)} · pen ${writing.pen.toFixed(2)}`
          : performance ? `figure ${evaluateSequence(performance.sequence, at).action} · performing ${this.aion.figure.performing.toFixed(2)}` : "-";
        return `${phase} · ${at.toFixed(2)}/${animation.playback.duration.toFixed(2)} s · rate ${animation.playback.rate} · ${detail}`;
      })(),
      hooks: this.snapshot?.hub.hooksActive ? "active" : "not detected",
      audio: (() => {
        const settings = this.audio.settings, route = this.audio.route, bridge = this.snapshot?.audio?.bridge;
        const sources = (["microphone", "codex", "system", "tab", "music"] as const).map(kind => {
          const state = this.audio.bus.state(kind, performance.now() / 1000);
          return state.connected ? `${kind}${state.sounding ? "*" : ""}` : "";
        }).filter(Boolean).join(" ");
        const detector = this.audio.detectors.tab.evidence.confidence || this.audio.detectors.system.evidence.confidence;
        return `${settings.enabled ? `${settings.source}/${settings.mode}/${settings.intensity}` : "off"} · route ${route.reason} (sphere ${route.sphere ?? "-"}, ring ${route.ring ?? "-"})`
          + ` · sources ${sources || "none"} · bridge ${bridge?.state ?? "-"}${bridge?.waiting ? " (waiting)" : ""}${bridge?.reason ? ` (${bridge.reason})` : ""} · music ${detector.toFixed(2)}`
          + ` · voice sync ${this.snapshot?.audio?.voiceSync?.status ?? "-"}`;
      })(),
    };
  }

  private renderDebug() {
    this.elements.debug.hidden = false;
    this.elements.debug.textContent = Object.entries(this.diagnostics()).map(([key, value]) => `${key} ${value}`).join("\n");
  }
}
