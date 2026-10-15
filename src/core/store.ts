import { DEFAULT_BODY, isBodyId, type AionBodyId } from "./body";
import type { EyeExpression } from "./eyes/expression";
import type { FigureGesture } from "./figure/motion";
import type { OrbitCommand } from "../render/interaction/orbit";
import { holdsFor, HOLD_SECONDS, legacyPreference, type GeoMarker, type Presentation, type PresentationContent, type PresentationRequest } from "./presentation";
import { DEFAULT_APPEARANCE, type Appearance } from "./colors";
import { routePresentation } from "./presentationRouter";
import { isActivityState, type ActivityState } from "./state";
import { DEFAULT_AUDIO_PRESENCE, type AudioPresence, type AudioSettings, type BridgeStatus, type VoiceSyncState } from "../audio/settings";
import type { PlaybackEvent } from "../music/notation/score";
import { endOf, positionAt, type PlaybackState } from "../animation/timeline";
import { controlAnimation, playbackFor, type AnimationCommand, type ControlResult } from "../animation/control";
import { applyCardReport, openCard, queueCardCommand, type CardReport, type CardSnapshot } from "../cards/state";
import { checkCommand } from "../cards/manifest";
import type { CardValue } from "../cards/values";
import { cardRegistry } from "./cards";

/**
 * The presence state shared by every surface: the host's activity, the persistent body, the one temporary
 * presentation and the latest gesture. It is plain data with a revision number, so any surface (embedded,
 * companion, a future host) renders exactly the same Aion from it, and nothing in it knows about the host.
 *
 * Timing lives here, not in a surface: a presentation expires after its hold, `complete` settles back to
 * idle, and a work state no host signal ever ended expires instead of shining forever.
 */
export type ActivitySource = "model" | "hook" | "system";

export interface PresenceSnapshot {
  revision: number;
  activity: { state: ActivityState; label?: string; source: ActivitySource; since: number };
  body: AionBodyId;
  presentation: Presentation | null;
  /** The most recent gesture request (e.g. the greeting when Aion is first opened); id changes per request. */
  gesture: { name: "greeting"; id: number } | null;
  /** The most recent expression or gesture asked for by name ("look happy", "wave"); id changes per request. */
  expression: ExpressionRequest | null;
  /** The most recent change of view asked for a 3D object ("rotate it", "from above"); id changes per request. */
  sceneView: (OrbitCommand & { id: number }) | null;
  /** Aion's colours (v0.4.1): the particles' base colour and the accent of markers and highlights. */
  appearance: Appearance;
  /** How Aion responds to sound, and where the native capture bridge stands (v0.4.2). */
  audio: AudioPresence;
  /** The latest music playback request (v0.4.2); a new id starts it, `stop` silences any. */
  playback: PlaybackRequest | null;
  /**
   * v0.4.3: the playback of the animation on show (a symbol being written, a figure's action sequence), anchored to the
   * wall clock so every surface draws the same frame (see animation/timeline.ts). Null when nothing animates.
   */
  animation: AnimationPlayback | null;
  /**
   * v0.4.5: the interactive card on show (its application, lifecycle, declared state, selection, asset, and the commands
   * for surfaces to apply), or null. Present exactly while the presentation is an interactive one.
   */
  card: CardSnapshot | null;
}

/** The animation on show and where its playhead is. */
export interface AnimationPlayback { presentation: string; playback: PlaybackState }

/**
 * Music for the surfaces to play, already validated: events in quarter notes, a tempo, a volume. `presentation`: the
 * music card whose notes light up as they sound. One surface plays it (see the view); nothing is streamed.
 */
export interface PlaybackRequest { id: number; events: PlaybackEvent[]; tempo: number; volume: number; presentation?: string; stop?: boolean }

export interface ExpressionRequest { expression?: EyeExpression; gesture?: FigureGesture; seconds?: number; id: number }

/** Seconds a state lasts unless something replaces it (null: indefinitely). */
export const ACTIVITY_TTL: Record<ActivityState, number | null> = {
  idle: null, listening: 120, thinking: 600, working: 600, reading: 600, editing: 600, testing: 600, building: 600,
  // If the turn's end never arrives (no hooks), responding settles by itself. With hooks, the hub keeps it for as
  // long as the answer takes to say (see PresenceHub.hook), whatever this says.
  responding: 30, presenting: 600, complete: 6, error: 20,
};

export interface StoreClock {
  now(): number;
  /** Runs `callback` after `ms`; returns a cancel function. */
  schedule(callback: () => void, ms: number): () => void;
}

export const systemClock: StoreClock = {
  now: () => Date.now(),
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * A hold is time spent *formed* (as in SCF). The body first takes about this long to form, so the store keeps
 * the presentation that much longer before releasing it.
 */
export const FORMING_SECONDS = 1.6;
/** An action sequence stays this long after it finishes, and this long while paused (v0.4.3). */
export const ANIMATION_TAIL_SECONDS = 1.5;
export const ANIMATION_PAUSED_SECONDS = 60;

let presentationCounter = 0;
const presentationId = (now: number) => `p${now.toString(36)}${(++presentationCounter).toString(36)}`;

export class PresenceStore {
  private state: PresenceSnapshot;
  private readonly listeners = new Set<(snapshot: PresenceSnapshot) => void>();
  private cancelPresentation: (() => void) | null = null;
  private cancelActivity: (() => void) | null = null;

  constructor(private readonly clock: StoreClock = systemClock) {
    this.state = { revision: 0, activity: { state: "idle", source: "system", since: clock.now() }, body: DEFAULT_BODY, presentation: null, gesture: null, expression: null, sceneView: null, appearance: DEFAULT_APPEARANCE, audio: DEFAULT_AUDIO_PRESENCE, playback: null, animation: null, card: null };
  }

  snapshot(): PresenceSnapshot { return this.state; }

  subscribe(listener: (snapshot: PresenceSnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Sets the host's activity. Invalid states are rejected (false), never coerced. */
  /** `ttl` (seconds) overrides how long this state lasts before it settles to idle. */
  setActivity(state: ActivityState, options: { label?: string; source?: ActivitySource; ttl?: number } = {}): boolean {
    if (!isActivityState(state)) return false;
    const now = this.clock.now();
    const current = this.state.activity;
    const label = options.label || undefined;
    if (current.state === state && current.label === label) { this.armActivity(state, options.ttl); return true; }
    this.commit({ activity: { state, ...(label ? { label } : {}), source: options.source ?? "model", since: now } });
    this.armActivity(state, options.ttl);
    return true;
  }

  /**
   * Changes the persistent body. A presentation on show is released so the change is seen at once (the
   * particles return and re-form as the new body). False when it already is that body.
   */
  setBody(body: AionBodyId): boolean {
    if (!isBodyId(body) || body === this.state.body) return false;
    this.cancelPresentation?.();
    this.commit({ body, presentation: null, animation: null });
    return true;
  }

  /**
   * Shows a presentation, replacing any other: the Presentation Router decides body, card or hybrid (from the
   * request's preference, the v0.2 image mode, or automatically), and each part gets its lifetime.
   * `holdSeconds` 0 keeps it until cleared.
   */
  present(content: PresentationContent, holdSeconds?: number, request: PresentationRequest = {}): Presentation {
    const now = this.clock.now();
    const decision = routePresentation({ content, preference: request.preference ?? legacyPreference(content), detail: request.detail, capabilities: request.capabilities });
    const holds = holdsFor(content, decision.route, holdSeconds);
    const presentation = { ...content, id: presentationId(now), at: now, hold: holds.total, route: decision.route, reason: decision.reason, bodyHold: holds.body, cardHold: holds.card } as Presentation;
    this.cancelPresentation?.();
    this.cancelPresentation = null;
    // An animation starts playing with it (a sequence's lifetime follows its speed).
    const animated = content.kind === "writing" || content.kind === "animation";
    const animation = animated ? { presentation: presentation.id, playback: playbackFor(content, now, request.rate ?? 1) } : null;
    // An interactive card: a new one, or the open one when the same instance is shown again (a new model in the viewer).
    let card: CardSnapshot | null = null;
    if (content.kind === "interactive") {
      const open = this.state.card;
      card = open && open.instance === content.instance && open.app === content.app
        ? { ...open, title: content.title, layout: content.layout, config: content.config, asset: content.asset ?? open.asset, error: null, ...(content.asset && content.asset.id !== open.asset?.id ? { lifecycle: "loading" as const } : {}) }
        : openCard({ instance: content.instance, app: content.app, title: content.title, layout: content.layout, asset: content.asset ?? null, config: content.config, now });
    }
    this.commit({ presentation, animation, card });
    if (animation && content.kind === "animation" && holds.total > 0) this.expire(presentation.id, this.playbackLeft(animation.playback) + ANIMATION_TAIL_SECONDS);
    else if (holds.total > 0) this.expire(presentation.id, holds.total + FORMING_SECONDS);
    return presentation;
  }

  /**
   * A command for the interactive card on show (v0.4.5), checked against its application's manifest. Layout commands
   * change the card at once; close ends it; everything else is queued for the surfaces (and acknowledged by the card).
   */
  cardCommand(command: string, value?: CardValue): { ok: true; seq: number; card: CardSnapshot | null } | { ok: false; problem: string } {
    const card = this.state.card, manifest = card ? cardRegistry.get(card.app) : undefined;
    if (!card || !manifest) return { ok: false, problem: "no interactive card is open" };
    const checked = checkCommand(manifest, command, value);
    if (!checked.ok) return checked;
    if (command === "close") { this.clearPresentation(); return { ok: true, seq: 0, card: null }; }
    if (command === "expand" || command === "collapse" || command === "fullscreen") {
      const layout = command === "expand" ? "expanded" : command === "collapse" ? "compact" : "fullscreen";
      if (!manifest.display.layouts.includes(layout)) return { ok: false, problem: `${manifest.name} has no ${layout} layout` };
      this.commit({ card: { ...card, layout } });
      return { ok: true, seq: 0, card: this.state.card };
    }
    const queued = queueCardCommand(card, command, checked.value, this.clock.now());
    this.commit({ card: queued.card });
    return { ok: true, seq: queued.seq, card: queued.card };
  }

  /**
   * A surface's report about the card it shows (already validated against the card and its manifest by the hub). A change
   * of meaningful state is a new revision; a report that only refreshes counters is kept quietly.
   */
  cardReport(report: CardReport) {
    const card = this.state.card;
    if (!card || card.instance !== report.instance) return false;
    const next = applyCardReport(card, report, this.clock.now());
    const meaningful = (c: CardSnapshot) => JSON.stringify({ ...c, reportedAt: 0, resources: null });
    if (meaningful(next) === meaningful(card)) { this.state = { ...this.state, card: next }; return false; }
    this.commit({ card: next });
    return true;
  }

  /** Wall-clock seconds until a playback reaches where it stops. */
  private playbackLeft(playback: PlaybackState) {
    return playback.playing ? Math.max(0, endOf(playback) - positionAt(playback, this.clock.now())) / playback.rate : 0;
  }

  /**
   * Controls the animation on show (v0.4.3): pause, resume, replay, speed, a stroke (next, previous, repeat), the
   * finished symbol, stop (it ends). An action sequence then lasts as long as it still plays; a paused one stays a
   * while. Fails (with why) when nothing animates or the command does not apply.
   */
  controlAnimation(command: AnimationCommand): ControlResult {
    const presentation = this.state.presentation, current = this.state.animation;
    if (!presentation || (presentation.kind !== "writing" && presentation.kind !== "animation") || current?.presentation !== presentation.id) {
      return { ok: false, problem: "no animation is on show" };
    }
    if (command.action === "stop") { this.clearPresentation(); return { ok: true, playback: current.playback }; }
    const result = controlAnimation(presentation, current.playback, command, this.clock.now());
    if (!result.ok) return result;
    this.commit({ animation: { presentation: presentation.id, playback: result.playback } });
    if (presentation.kind === "animation" && presentation.hold !== 0) {
      this.expire(presentation.id, result.playback.playing ? this.playbackLeft(result.playback) + ANIMATION_TAIL_SECONDS : ANIMATION_PAUSED_SECONDS);
    }
    return result;
  }

  /**
   * A new topic began (a new prompt): a temporary presentation still on show ends within `maxSeconds`, so stale
   * cards never accumulate. One kept until cleared (hold 0) stays.
   */
  shorten(maxSeconds: number) {
    const presentation = this.state.presentation;
    if (!presentation || presentation.hold === 0) return;
    const left = (presentation.at - this.clock.now()) / 1000 + presentation.hold + FORMING_SECONDS;
    if (left > maxSeconds) this.expire(presentation.id, maxSeconds);
  }

  private expire(id: string, seconds: number) {
    this.cancelPresentation?.();
    this.cancelPresentation = this.clock.schedule(() => {
      if (this.state.presentation?.id === id) this.commit({ presentation: null, animation: null });
    }, seconds * 1000);
  }

  /** Ends the presentation: Aion returns to its persistent body. False when nothing was shown. */
  clearPresentation(): boolean {
    this.cancelPresentation?.();
    this.cancelPresentation = null;
    if (!this.state.presentation) return false;
    this.commit({ presentation: null, animation: null });
    return true;
  }

  /**
   * Replaces the places marked on the map or terrain on show, in place: the same presentation (the map is not formed
   * again), held for a while longer since the user is working with it. False when no map or terrain is on show.
   */
  setMarkers(markers: GeoMarker[]): boolean {
    const presentation = this.state.presentation;
    if (presentation?.kind !== "map" && presentation?.kind !== "terrain") return false;
    const hold = presentation.hold === 0 ? 0 : Math.max(HOLD_SECONDS.map, presentation.hold);
    const elapsed = (this.clock.now() - presentation.at) / 1000;
    // Its lifetime runs from now: the hold is stretched by the time already spent.
    const next = { ...presentation, markers, ...(hold ? { hold: elapsed + hold, bodyHold: presentation.bodyHold ? elapsed + hold : 0, cardHold: presentation.cardHold ? elapsed + hold : 0 } : {}) } as Presentation;
    this.commit({ presentation: next });
    if (hold) this.expire(next.id, hold + 0.5);
    return true;
  }

  /** Aion's colours (validated by the caller). */
  setAppearance(appearance: Appearance) {
    if (appearance.base.hex === this.state.appearance.base.hex && appearance.accent.hex === this.state.appearance.accent.hex
      && appearance.base.name === this.state.appearance.base.name && appearance.accent.name === this.state.appearance.accent.name) return false;
    this.commit({ appearance });
    return true;
  }

  /** How Aion responds to sound (validated by the caller). */
  setAudioSettings(settings: AudioSettings) {
    if (JSON.stringify(settings) === JSON.stringify(this.state.audio.settings)) return false;
    this.commit({ audio: { ...this.state.audio, settings } });
    return true;
  }

  /** Where Codex Voice Sync stands (v0.4.3). */
  setVoiceSync(voiceSync: VoiceSyncState) {
    if (JSON.stringify(voiceSync) === JSON.stringify(this.state.audio.voiceSync)) return false;
    this.commit({ audio: { ...this.state.audio, voiceSync } });
    return true;
  }

  /** Where the native capture bridge stands. */
  setBridge(bridge: BridgeStatus) {
    if (JSON.stringify(bridge) === JSON.stringify(this.state.audio.bridge)) return false;
    this.commit({ audio: { ...this.state.audio, bridge } });
    return true;
  }

  /** Asks the surfaces to play music (or, with no events, to stop). Returns the request's id. */
  play(request: Omit<PlaybackRequest, "id">): number {
    const id = (this.state.playback?.id ?? 0) + 1;
    this.commit({ playback: { ...request, id } });
    return id;
  }

  /** Asks every surface for an expression or a gesture by name (each body shows it its own way). */
  express(request: Omit<ExpressionRequest, "id">) {
    if (!request.expression && !request.gesture) return false;
    this.commit({ expression: { ...request, id: (this.state.expression?.id ?? 0) + 1 } });
    return true;
  }

  /** Changes how a 3D object on show is viewed. False when no 3D object is showing. */
  orient(command: OrbitCommand): boolean {
    if (this.state.presentation?.kind !== "scene") return false;
    this.commit({ sceneView: { ...command, id: (this.state.sceneView?.id ?? 0) + 1 } });
    return true;
  }

  /** Asks every surface for the greeting gesture (once per opening). */
  greet() { this.commit({ gesture: { name: "greeting", id: (this.state.gesture?.id ?? 0) + 1 } }); }

  /** Replaces the whole state from another store (a hub snapshot), keeping this store's revision moving forward. */
  replace(snapshot: PresenceSnapshot) {
    this.cancelPresentation?.(); this.cancelActivity?.();
    this.cancelPresentation = this.cancelActivity = null;
    this.state = { ...snapshot, revision: Math.max(snapshot.revision, this.state.revision + 1) };
    for (const listener of this.listeners) listener(this.state);
  }

  dispose() {
    this.cancelPresentation?.(); this.cancelActivity?.();
    this.listeners.clear();
  }

  private armActivity(state: ActivityState, override?: number) {
    this.cancelActivity?.();
    this.cancelActivity = null;
    const ttl = override !== undefined && Number.isFinite(override) && override > 0 ? override : ACTIVITY_TTL[state];
    if (ttl === null) return;
    const since = this.state.activity.since;
    this.cancelActivity = this.clock.schedule(() => {
      if (this.state.activity.state === state && this.state.activity.since === since) {
        this.commit({ activity: { state: "idle", source: "system", since: this.clock.now() } });
      }
    }, ttl * 1000);
  }

  private commit(patch: Partial<PresenceSnapshot>) {
    // The card lives exactly as long as its interactive presentation.
    if ("presentation" in patch && patch.presentation?.kind !== "interactive") patch = { ...patch, card: null };
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
  }
}
