/**
 * The application lifecycle (v0.4.5). Pure: the page's card host drives it, the hub records where a card stands, and
 * the tests check every transition.
 *
 *   registered ─launch→ loading ─ready→ ready ─activate→ active ⇄ paused
 *                          ↑                       ↓  ↑        ↓ ↑
 *                        retry/reload           suspend/wake (page hidden)
 *   any live state ─fail→ error ─retry→ loading;   any state ─dispose→ disposing ─disposed→ disposed (final)
 *
 * paused: simulation time stops and rendering happens only on demand (the user can still turn the view);
 * suspended: nothing renders at all (the page is hidden); disposed: every resource has been released.
 */
export const CARD_LIFECYCLE = ["registered", "loading", "ready", "active", "paused", "suspended", "error", "disposing", "disposed"] as const;
export type CardLifecycle = typeof CARD_LIFECYCLE[number];

export const LIFECYCLE_EVENTS = ["launch", "ready", "activate", "pause", "resume", "suspend", "wake", "reload", "fail", "retry", "dispose", "disposed"] as const;
export type LifecycleEvent = typeof LIFECYCLE_EVENTS[number];

const TABLE: Record<CardLifecycle, Partial<Record<LifecycleEvent, CardLifecycle>>> = {
  registered: { launch: "loading", dispose: "disposed" },
  loading: { ready: "ready", fail: "error", dispose: "disposing" },
  ready: { activate: "active", pause: "paused", suspend: "suspended", fail: "error", dispose: "disposing", reload: "loading" },
  active: { pause: "paused", suspend: "suspended", fail: "error", dispose: "disposing", reload: "loading", activate: "active" },
  paused: { resume: "active", suspend: "suspended", fail: "error", dispose: "disposing", reload: "loading", pause: "paused" },
  suspended: { wake: "active", fail: "error", dispose: "disposing" },
  error: { retry: "loading", dispose: "disposing" },
  disposing: { disposed: "disposed", fail: "disposing", dispose: "disposing" },
  disposed: {},
};

/** The next state, or null when the event does not apply in this state. */
export function nextLifecycle(state: CardLifecycle, event: LifecycleEvent): CardLifecycle | null {
  return TABLE[state][event] ?? null;
}

/** States in which the application may render and receive commands. */
export const isLive = (state: CardLifecycle) => state === "ready" || state === "active" || state === "paused" || state === "suspended";

/**
 * A lifecycle with memory: it remembers whether the card was paused when it was suspended (waking returns there), and
 * refuses events that do not apply (returning false) instead of jumping.
 */
export class Lifecycle {
  private current: CardLifecycle = "registered";
  private pausedBeforeSuspend = false;
  constructor(private readonly changed?: (state: CardLifecycle, previous: CardLifecycle) => void) {}

  get state() { return this.current; }

  send(event: LifecycleEvent): boolean {
    let next = nextLifecycle(this.current, event);
    if (!next) return false;
    if (event === "suspend") this.pausedBeforeSuspend = this.current === "paused";
    if (event === "wake" && this.pausedBeforeSuspend) next = "paused";
    const previous = this.current;
    this.current = next;
    if (next !== previous) this.changed?.(next, previous);
    return true;
  }
}
