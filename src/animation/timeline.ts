/**
 * The Animation Core (v0.4.3): a small, predictable playback controller shared by the Stroke Animation Engine and
 * the Scene Sequencer. It knows nothing about strokes, skeletons or particles: only a timeline of a known duration,
 * where the playhead is, how fast it moves, and where it should stop.
 *
 * Playback is plain data anchored to a wall-clock instant, so the hub (which receives "pause", "replay", "slower")
 * and every surface (which draws the frame) compute exactly the same position from the same state:
 *
 *   position(now) = position₀ + (now − at) × rate   while playing, clamped to [0, until ?? duration]
 *
 * Every operation returns a new state (nothing is mutated), so a command is deterministic and testable.
 */
export const PLAYBACK_SPEEDS = { slow: 0.5, normal: 1, fast: 1.6 } as const;
export type PlaybackSpeed = keyof typeof PLAYBACK_SPEEDS;
export const RATE_LIMITS = { min: 0.25, max: 2.5 } as const;

export interface PlaybackState {
  /** The timeline's length in seconds. */
  duration: number;
  /** Whether the playhead moves. */
  playing: boolean;
  /** Seconds of timeline per second of wall clock. */
  rate: number;
  /** The playhead at `at` (seconds into the timeline). */
  position: number;
  /** Wall-clock milliseconds at which `position` held. */
  at: number;
  /** Where playback stops by itself (a single stroke being repeated); null: the end. */
  until: number | null;
  /** Increments on every command, so a surface can tell a replay of the same position from no change. */
  revision: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
export const clampRate = (rate: number) => clamp(finite(rate, 1), RATE_LIMITS.min, RATE_LIMITS.max);

/** A new timeline, playing from the start (or paused at `position`). */
export function startPlayback(duration: number, now: number, options: { rate?: number; playing?: boolean; position?: number } = {}): PlaybackState {
  const length = Math.max(0, finite(duration, 0));
  return {
    duration: length, playing: options.playing ?? true, rate: clampRate(options.rate ?? 1),
    position: clamp(finite(options.position ?? 0, 0), 0, length), at: now, until: null, revision: 0,
  };
}

/** Where the playhead stops by itself. */
export const endOf = (state: PlaybackState) => state.until === null ? state.duration : clamp(state.until, 0, state.duration);

/** The playhead at wall-clock `now` (milliseconds). */
export function positionAt(state: PlaybackState, now: number): number {
  const elapsed = state.playing ? Math.max(0, finite(now - state.at, 0)) / 1000 * state.rate : 0;
  return clamp(state.position + elapsed, 0, endOf(state));
}

/** Whether the playhead has reached where it stops. */
export const finishedAt = (state: PlaybackState, now: number) => positionAt(state, now) >= endOf(state) - 1e-6;

/** The phase a person would name: playing, paused, or finished (it reached its end, or the stroke it repeated). */
export function phaseAt(state: PlaybackState, now: number): "playing" | "paused" | "finished" {
  if (finishedAt(state, now)) return "finished";
  return state.playing ? "playing" : "paused";
}

const next = (state: PlaybackState, now: number, patch: Partial<PlaybackState>): PlaybackState =>
  ({ ...state, position: positionAt(state, now), at: now, ...patch, revision: state.revision + 1 });

export const pause = (state: PlaybackState, now: number) => next(state, now, { playing: false });

/** Resumes where it paused; at the end (or at a repeated stroke's end), it carries on to the end of the timeline. */
export function resume(state: PlaybackState, now: number): PlaybackState {
  const position = positionAt(state, now);
  const until = state.until !== null && position >= state.until - 1e-6 ? null : state.until;
  return next(state, now, { playing: true, until });
}

/** Moves the playhead (and plays to `until`, or to the end). */
export function seek(state: PlaybackState, now: number, position: number, options: { until?: number | null; playing?: boolean } = {}): PlaybackState {
  const to = clamp(finite(position, 0), 0, state.duration);
  const until = options.until === undefined ? null : options.until === null ? null : clamp(options.until, to, state.duration);
  return { ...state, position: to, at: now, until, playing: options.playing ?? true, revision: state.revision + 1 };
}

/** From the beginning (or from `from`), to the end. */
export const replay = (state: PlaybackState, now: number, from = 0) => seek(state, now, from, { until: null, playing: true });

/** A new speed from now on; the playhead does not jump. */
export const setRate = (state: PlaybackState, now: number, rate: number) => next(state, now, { rate: clampRate(rate) });

/** Stopped at the beginning. */
export const stop = (state: PlaybackState, now: number) => seek(state, now, 0, { playing: false });

/** A named speed, or a rate relative to the current one ("slower", "faster"). */
export function rateFor(speed: PlaybackSpeed | "slower" | "faster", current = 1): number {
  if (speed === "slower") return clampRate(current * 0.6);
  if (speed === "faster") return clampRate(current * 1.5);
  return PLAYBACK_SPEEDS[speed];
}

// ── Keyframes and easing: the vocabulary both animation systems share ───────────────────────────────────────

export type Ease = "linear" | "in" | "out" | "inOut" | "back" | "hold";

/** Easing curves: cubic in, out and in-out, an overshooting `back` (follow-through) and a step `hold`. */
export function ease(kind: Ease | undefined, x: number): number {
  const t = clamp(finite(x, 0), 0, 1);
  switch (kind) {
    case "linear": return t;
    case "in": return t * t * t;
    case "out": return 1 - Math.pow(1 - t, 3);
    case "back": { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
    case "hold": return t < 1 ? 0 : 1;
    default: return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}

/** Smoothstep on [0, 1]. */
export const smooth = (x: number) => { const t = clamp(finite(x, 0), 0, 1); return t * t * (3 - 2 * t); };

/** A keyframe of one value: reached at `at` seconds, eased into by `ease`. */
export interface ValueKey { at: number; value: number; ease?: Ease }

/** The value of a keyframed track at `t` (held before the first key and after the last). */
export function interpolate(keys: readonly ValueKey[], t: number): number {
  if (!keys.length) return 0;
  if (!(t > keys[0].at)) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    if (t <= key.at) {
      const previous = keys[i - 1], span = key.at - previous.at;
      return previous.value + (key.value - previous.value) * ease(key.ease, span > 0 ? (t - previous.at) / span : 1);
    }
  }
  return keys[keys.length - 1].value;
}

/** A segment of a timeline: [start, end) with a name. Sequenced segments tile a timeline without gaps. */
export interface Segment<T> { start: number; end: number; value: T }

/** Lays items end to end, each `duration(item)` long, starting at `from`. */
export function sequence<T>(items: readonly T[], duration: (item: T) => number, from = 0): Segment<T>[] {
  const out: Segment<T>[] = [];
  let at = from;
  for (const item of items) {
    const length = Math.max(0, finite(duration(item), 0));
    out.push({ start: at, end: at + length, value: item });
    at += length;
  }
  return out;
}

/** The segment playing at `t` (the last one after the end; null when there are none or `t` is before the first). */
export function segmentAt<T>(segments: readonly Segment<T>[], t: number): Segment<T> | null {
  if (!segments.length || t < segments[0].start) return null;
  for (const segment of segments) if (t < segment.end) return segment;
  return segments[segments.length - 1];
}
