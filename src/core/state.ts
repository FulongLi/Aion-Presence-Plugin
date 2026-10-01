/**
 * Aion's state: what it is doing right now. Separate from identity (who) and body (which form).
 *
 * In plugin mode the host agent (Codex) is the intelligence, so Aion's state is the host's *activity*, as
 * far as the host has actually exposed it: through lifecycle hooks (a prompt was submitted, a shell command
 * runs, a patch is applied, the turn stopped) or through the agent itself (set_presence_state). Nothing is
 * inferred from emotion, and a state the host has not exposed is never pretended.
 *
 *   activity        idle | listening | thinking | working | reading | editing | testing | building |
 *                   responding | presenting | complete | error
 *   gestures        greeting (once, when Aion is first opened) and acknowledging (a small nod when a new
 *                   task begins) — timed, then they hand back to the activity
 *   responding      semantic: Codex is producing its user-facing answer (the Skill says so just before it
 *                   replies). A restrained answering motion, with no amplitude, spectrum or lip sync.
 *   speaking        reserved for a host that exposes real assistant audio (see audio.ts); never faked
 *   listening       the host said so, or (on the surface) the local microphone hears the user
 *
 * The machine is deterministic: the same inputs at the same times give the same states.
 */
export const ACTIVITY_STATES = [
  "idle", "listening", "thinking", "working", "reading", "editing", "testing", "building", "responding", "presenting", "complete", "error",
] as const;
export type ActivityState = typeof ACTIVITY_STATES[number];

/** How long each one-shot gesture lasts (seconds). */
export const GESTURE_SECONDS = { greeting: 2.8, acknowledging: 0.9 } as const;
export type AionGesture = keyof typeof GESTURE_SECONDS;
export const isGesture = (state: string): state is AionGesture => state in GESTURE_SECONDS;

/** Everything the body can express: the activities, the gestures, and host speech. */
export const AION_STATES = [...ACTIVITY_STATES, "speaking", "greeting", "acknowledging"] as const;
export type AionState = typeof AION_STATES[number];

export const isActivityState = (value: unknown): value is ActivityState =>
  typeof value === "string" && (ACTIVITY_STATES as readonly string[]).includes(value);
export const isAionState = (value: unknown): value is AionState =>
  typeof value === "string" && (AION_STATES as readonly string[]).includes(value);
/** Anything that is not a known state is idle. */
export const sanitizeState = (value: unknown): AionState => isAionState(value) ? value : "idle";

/** Work in progress: a new one of these after rest is the start of a task (a small nod). */
export const WORK_STATES: readonly ActivityState[] = ["thinking", "working", "reading", "editing", "testing", "building"];
const RESTING: readonly string[] = ["idle", "listening", "complete", "error"];

export interface StateInputs {
  /** The host's activity, as exposed. */
  activity: ActivityState | string;
  /** A presentation (a visual, result, text…) is forming or held. */
  presenting: boolean;
  /** The host's own assistant audio is audible (only when a host exposes it). */
  speaking?: boolean;
}

export class AionStateMachine {
  state: AionState = "idle";
  /** When the current state began (seconds, the caller's clock). */
  since = 0;
  /** Development override; production never sets it. */
  override: AionState | null = null;
  private gesture: { name: AionGesture; until: number } | null = null;
  private pending: AionGesture | null = null;
  private lastActivity = "idle";

  /** Requests a one-shot gesture; it starts on the next update. */
  trigger(gesture: AionGesture) { if (isGesture(gesture)) this.pending = gesture; }

  /** Forces a state (debug); null returns to the automatic state. Invalid values are ignored as idle. */
  force(state: unknown) { this.override = state === null ? null : sanitizeState(state); }

  update(inputs: StateInputs, now: number): AionState {
    const activity: AionState = isActivityState(inputs.activity) ? inputs.activity : "idle";
    // The host takes up a new task after resting: one small nod. (A real transition, never a guess.)
    if (RESTING.includes(this.lastActivity) && (WORK_STATES as readonly string[]).includes(activity) && !this.gesture) this.pending ??= "acknowledging";
    this.lastActivity = activity;
    if (this.pending) {
      // The greeting outranks a nod; a nod never interrupts a greeting.
      if (!this.gesture || this.pending === "greeting" || this.gesture.name !== "greeting") {
        this.gesture = { name: this.pending, until: now + GESTURE_SECONDS[this.pending] };
      }
      this.pending = null;
    }
    if (this.gesture && now >= this.gesture.until) this.gesture = null;

    let next: AionState;
    if (this.override) next = this.override;
    else if (this.gesture?.name === "greeting") next = "greeting";
    else if (inputs.presenting) next = "presenting";
    else if (this.gesture) next = this.gesture.name;
    else if (inputs.speaking) next = "speaking";
    else next = activity;
    if (next !== this.state) { this.state = next; this.since = now; }
    return this.state;
  }
}
