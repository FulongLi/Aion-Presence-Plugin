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
import type { SceneEdit } from "../cards/protocol";
import { checkCommand } from "../cards/manifest";
import type { CardValue } from "../cards/values";
import { cardRegistry } from "./cards";
import type { SceneDocument } from "../scene/ir";
import { validateScene } from "../scene/validate";
import { validateRoute } from "../visual/geo/route";
import { applyPatch } from "../scene/patch";
import { toParticleScene } from "../scene/particleAdapter";
import { commit as commitScene, redo as redoScene, resetHistory, startHistory, undo as undoScene, type HistoryResult, type SceneHistoryState } from "../scene/history";

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

/**
 * v0.5: a change to a generative scene card's scene. `request` names it so the caller can read its outcome from the
 * snapshot (card.scene.outcome). `base`: the revision the change was made from (a stale one is refused).
 */
export type SceneCommand = { request: string; base?: number; label?: string } & (
  | { action: "set"; document: unknown }
  | { action: "patch"; ops: unknown[] }
  | { action: "undo" | "redo" | "reset" }
);

/** A direct edit from the card as a scene command: a transform patch (labelled as the user's) or undo / redo. */
function editCommand(edit: SceneEdit, card: CardSnapshot): SceneCommand {
  if (edit.action !== "transform") return { request: edit.request, action: edit.action };
  const node = card.scene?.document.objects.find(n => n.id === edit.id);
  const name = node?.name ?? node?.label ?? edit.id;
  const what = [edit.position && "moved", edit.rotation && "turned", edit.scale !== undefined && "resized"].filter(Boolean).join(" and ");
  const op: Record<string, unknown> = { op: "transform", id: edit.id, ...(edit.position ? { position: edit.position } : {}), ...(edit.rotation ? { rotation: edit.rotation } : {}), ...(edit.scale !== undefined ? { scale: edit.scale } : {}) };
  return { request: edit.request, base: edit.base, action: "patch", ops: [op], label: `${what} ${name} (by hand)` };
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
  /** v0.5: the generative scene card's full history (earlier documents stay here, not in the snapshot). */
  private sceneHistory: { instance: string; state: SceneHistoryState } | null = null;

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
      // v0.5: a generated scene. The same card shown with a new scene keeps its history: the new scene is a new revision.
      if (content.scene !== undefined) {
        delete (presentation as { scene?: unknown }).scene;
        const checked = validateScene(content.scene);
        if (checked.ok) card = { ...card, scene: this.sceneState(card, checked.document, now) };
      }
      // v0.6: a route. The same card shown with a new route (reversed, another mode, a waypoint) is its next revision.
      if (content.geoRoute !== undefined) {
        delete (presentation as { geoRoute?: unknown }).geoRoute;
        const checked = validateRoute(content.geoRoute);
        if (checked.ok) card = { ...card, route: { document: checked.route, revision: (open?.instance === card.instance ? open.route?.revision ?? 0 : 0) + 1, rendered: open?.instance === card.instance ? open.route?.rendered ?? null : null } };
      }
    }
    // A different card (or none) ends the old card's scene history.
    if (!card || (!card.scene && card.instance !== this.sceneHistory?.instance)) this.sceneHistory = null;
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
    if (command === "close") { this.clearPresentation({ keepTerrain: true }); return { ok: true, seq: 0, card: null }; }
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
   * v0.5.1: a hybrid scene's particle body follows its changes. When a change alters what the body forms (objects added,
   * removed, moved, resized, hidden), the presentation carries the new particle form and when it changed (`bodyEcho`):
   * the surfaces re-form the body for a moment, then it returns beside the card. A colour change only updates the form's
   * brightness, quietly (the body is not re-formed for it).
   */
  private bodyEcho(card: CardSnapshot, document: SceneDocument, now: number): { presentation?: Presentation } {
    const presentation = this.state.presentation;
    if (presentation?.kind !== "interactive" || presentation.instance !== card.instance || !presentation.bodyScene) return {};
    const body = toParticleScene(document).scene;
    if (!body || JSON.stringify(body) === JSON.stringify(presentation.bodyScene)) return {};
    // Shape: the same particle form apart from brightness (tone follows colour) is kept quietly, without re-forming.
    const shape = (scene: unknown) => JSON.stringify(scene, (key, value) => key === "tone" ? undefined : value);
    if (shape(body) === shape(presentation.bodyScene)) return { presentation: { ...presentation, bodyScene: body } };
    return { presentation: { ...presentation, bodyScene: body, bodyEcho: now } };
  }

  /** The scene state after a whole new scene: a new history, or a new revision of the open card's. */
  private sceneState(card: CardSnapshot, document: SceneDocument, now: number) {
    const history = this.sceneHistory?.instance === card.instance ? this.sceneHistory.state : null;
    const next = history ? commitScene(history, document, "replaced the scene", now) : { ok: true as const, state: startHistory(document, now) };
    const state = next.ok ? next.state : startHistory(document, now);
    this.sceneHistory = { instance: card.instance, state };
    return { ...this.sceneSnapshot(state), rendered: card.scene?.rendered ?? null, outcome: null };
  }

  private sceneSnapshot(state: SceneHistoryState) {
    return { document: state.document, revision: state.revision, label: state.label, log: state.log, undo: state.undo.length, redo: state.redo.length };
  }

  /**
   * v0.5: changes the generative scene card's scene — a whole new document, a patch, undo, redo or reset — as one
   * transaction: validated, checked against `base` (stale changes are refused), recorded in the history. The outcome is
   * written to the card's scene (by request id) either way; a failure leaves the scene exactly as it was.
   */
  sceneCommand(command: SceneCommand): { ok: boolean; problem?: string } {
    const card = this.state.card, manifest = card ? cardRegistry.get(card.app) : undefined;
    if (!card || !manifest?.capabilities.includes("scene-documents")) return { ok: false, problem: "no generated scene is open" };
    const now = this.clock.now();
    const history = this.sceneHistory?.instance === card.instance ? this.sceneHistory.state : null;
    const fail = (code: string, problem: string) => {
      if (card.scene) this.commit({ card: { ...card, scene: { ...card.scene, outcome: { request: command.request, ok: false, revision: card.scene.revision, code, problem: problem.slice(0, 400) } } } });
      return { ok: false, problem };
    };
    let result: HistoryResult, extra: { summary?: string; changed?: string[]; removed?: string[] } = {};
    if (command.action === "set") {
      const checked = validateScene(command.document);
      if (!checked.ok) return fail(checked.code, checked.problem);
      if (!history || !card.scene) {
        const state = startHistory(checked.document, now);
        this.sceneHistory = { instance: card.instance, state };
        this.commit({ card: { ...card, scene: { ...this.sceneSnapshot(state), rendered: null, outcome: { request: command.request, ok: true, revision: state.revision, summary: "created the scene" } } } });
        return { ok: true };
      }
      result = commitScene(history, checked.document, (command.label ?? "replaced the scene").slice(0, 160), now, command.base);
      extra = { summary: "replaced the scene" };
    } else {
      if (!history || !card.scene) return fail("no-scene", "the card has no scene yet");
      if (command.action === "patch") {
        const patched = applyPatch(history.document, command.ops, { selected: card.selection?.objectId ?? null });
        if (!patched.ok) return fail(patched.code, patched.problem);
        result = commitScene(history, patched.document, (command.label ?? patched.summary).slice(0, 160), now, command.base);
        extra = { summary: patched.summary, changed: patched.changed.slice(0, 64), removed: patched.removed.slice(0, 64) };
      } else {
        result = command.action === "undo" ? undoScene(history, now) : command.action === "redo" ? redoScene(history, now) : resetHistory(history, now);
        extra = { summary: command.action === "reset" ? "reset to the original scene" : `${command.action}: ${command.action === "undo" ? history.label : history.redo.at(-1)?.label ?? ""}`.slice(0, 160) };
      }
    }
    if (!result.ok) return fail(result.code, result.problem);
    this.sceneHistory = { instance: card.instance, state: result.state };
    this.commit({
      card: { ...card, scene: { ...this.sceneSnapshot(result.state), rendered: card.scene?.rendered ?? null, outcome: { request: command.request, ok: true, revision: result.state.revision, ...extra } } },
      ...this.bodyEcho(card, result.state.document, now),
    });
    return { ok: true };
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
    const changed = meaningful(next) !== meaningful(card);
    if (changed) this.commit({ card: next }); else this.state = { ...this.state, card: next };
    // v0.5.1: the user's own change in the card is one more scene command, validated and recorded like Codex's.
    if (report.edit) this.sceneCommand(editCommand(report.edit, next));
    return changed || !!report.edit;
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

  /**
   * Ends the presentation: Aion returns to its persistent body. False when nothing was shown. v0.6 `keepTerrain`: closing a
   * route's card (the user's ×, or Codex's close) removes the route but keeps the terrain it was drawn on, for a while,
   * with the places marked on it — the geography the user was exploring is not torn down with the route.
   */
  clearPresentation(options: { keepTerrain?: boolean } = {}): boolean {
    this.cancelPresentation?.();
    this.cancelPresentation = null;
    const presentation = this.state.presentation;
    if (!presentation) return false;
    if (options.keepTerrain && presentation.kind === "interactive" && presentation.terrain) {
      const { media, style, label, region, elevation, credit, markers } = presentation.terrain;
      this.present({ kind: "terrain", media, style, label, ...(region ? { region } : {}), ...(elevation ? { elevation } : {}), ...(credit ? { credit } : {}), ...(markers?.length ? { markers } : {}) }, HOLD_SECONDS.map);
      return true;
    }
    this.commit({ presentation: null, animation: null });
    return true;
  }

  /**
   * Replaces the places marked on the map or terrain on show, in place: the same presentation (the map is not formed
   * again), held for a while longer since the user is working with it. False when no map or terrain is on show.
   */
  setMarkers(markers: GeoMarker[]): boolean {
    const presentation = this.state.presentation;
    // v0.6: places marked on a route's terrain change in place too (the route and its card stay as they are).
    if (presentation?.kind === "interactive" && presentation.terrain) {
      this.commit({ presentation: { ...presentation, terrain: { ...presentation.terrain, markers } } });
      return true;
    }
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
    // The card lives exactly as long as its interactive presentation (and its scene history with it).
    if ("presentation" in patch && patch.presentation?.kind !== "interactive") { patch = { ...patch, card: null }; this.sceneHistory = null; }
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
  }
}
