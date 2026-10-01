import { DEFAULT_BODY, isBodyId, type AionBodyId } from "./body";
import { holdFor, type Presentation, type PresentationContent } from "./presentation";
import { isActivityState, type ActivityState } from "./state";

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
}

/** Seconds a state lasts unless something replaces it (null: indefinitely). */
export const ACTIVITY_TTL: Record<ActivityState, number | null> = {
  idle: null, listening: 120, thinking: 600, working: 600, reading: 600, editing: 600, testing: 600, building: 600,
  presenting: 600, complete: 6, error: 20,
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

let presentationCounter = 0;
const presentationId = (now: number) => `p${now.toString(36)}${(++presentationCounter).toString(36)}`;

export class PresenceStore {
  private state: PresenceSnapshot;
  private readonly listeners = new Set<(snapshot: PresenceSnapshot) => void>();
  private cancelPresentation: (() => void) | null = null;
  private cancelActivity: (() => void) | null = null;

  constructor(private readonly clock: StoreClock = systemClock) {
    this.state = { revision: 0, activity: { state: "idle", source: "system", since: clock.now() }, body: DEFAULT_BODY, presentation: null, gesture: null };
  }

  snapshot(): PresenceSnapshot { return this.state; }

  subscribe(listener: (snapshot: PresenceSnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Sets the host's activity. Invalid states are rejected (false), never coerced. */
  setActivity(state: ActivityState, options: { label?: string; source?: ActivitySource } = {}): boolean {
    if (!isActivityState(state)) return false;
    const now = this.clock.now();
    const current = this.state.activity;
    const label = options.label || undefined;
    if (current.state === state && current.label === label) { this.armActivity(state); return true; }
    this.commit({ activity: { state, ...(label ? { label } : {}), source: options.source ?? "model", since: now } });
    this.armActivity(state);
    return true;
  }

  /**
   * Changes the persistent body. A presentation on show is released so the change is seen at once (the
   * particles return and re-form as the new body). False when it already is that body.
   */
  setBody(body: AionBodyId): boolean {
    if (!isBodyId(body) || body === this.state.body) return false;
    this.cancelPresentation?.();
    this.commit({ body, presentation: null });
    return true;
  }

  /** Shows a presentation, replacing any other. `holdSeconds` 0 holds it until cleared. */
  present(content: PresentationContent, holdSeconds?: number): Presentation {
    const now = this.clock.now();
    const hold = holdFor(content.kind, holdSeconds, content.kind === "text" ? content.text : undefined);
    const presentation = { ...content, id: presentationId(now), at: now, hold } as Presentation;
    this.cancelPresentation?.();
    this.cancelPresentation = null;
    this.commit({ presentation });
    if (hold > 0) {
      this.cancelPresentation = this.clock.schedule(() => {
        if (this.state.presentation?.id === presentation.id) this.commit({ presentation: null });
      }, hold * 1000);
    }
    return presentation;
  }

  /** Ends the presentation: Aion returns to its persistent body. False when nothing was shown. */
  clearPresentation(): boolean {
    this.cancelPresentation?.();
    this.cancelPresentation = null;
    if (!this.state.presentation) return false;
    this.commit({ presentation: null });
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

  private armActivity(state: ActivityState) {
    this.cancelActivity?.();
    this.cancelActivity = null;
    const ttl = ACTIVITY_TTL[state];
    if (ttl === null) return;
    const since = this.state.activity.since;
    this.cancelActivity = this.clock.schedule(() => {
      if (this.state.activity.state === state && this.state.activity.since === since) {
        this.commit({ activity: { state: "idle", source: "system", since: this.clock.now() } });
      }
    }, ttl * 1000);
  }

  private commit(patch: Partial<PresenceSnapshot>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
  }
}
