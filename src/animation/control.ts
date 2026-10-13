import { endOf, pause, PLAYBACK_SPEEDS, positionAt, rateFor, replay, resume, seek, setRate, startPlayback, type PlaybackSpeed, type PlaybackState } from "./timeline";
import { strokeSequence } from "./stroke/registry";
import { strokeIndexAt, strokeWindow, writingPlan, type WritingPlan } from "./stroke/timeline";
import { compileSequence, SEQUENCE_TIMING, type AnimationSpec, type CompiledSequence } from "./scene/sequence";

/**
 * Animation control (v0.4.3): one vocabulary for both kinds of animation Aion presents — a symbol being written and a
 * figure's action sequence — over the Animation Core's playback state. Pure: the hub applies a command and every
 * surface draws from the resulting state.
 */
export const ANIMATION_ACTIONS = ["play", "pause", "resume", "replay", "speed", "next", "previous", "repeat", "complete", "stop"] as const;
export type AnimationAction = typeof ANIMATION_ACTIONS[number];
export const ANIMATION_SPEEDS = ["slow", "normal", "fast", "slower", "faster"] as const;
export type AnimationSpeed = typeof ANIMATION_SPEEDS[number];

export interface AnimationCommand { action: AnimationAction; stroke?: number; speed?: AnimationSpeed }

/** What is being animated: a writing sequence by id, or a compiled action sequence. */
export type Animated = { kind: "writing"; stroke: string } | { kind: "animation"; sequence: AnimationSpec };

const plans = new Map<string, WritingPlan>();
/** The writing plan of a stroke sequence id (cached; null for an unknown id). */
export function planFor(id: string): WritingPlan | null {
  let plan = plans.get(id);
  if (!plan) {
    const sequence = strokeSequence(id);
    if (!sequence) return null;
    plan = writingPlan(sequence);
    plans.set(id, plan);
  }
  return plan;
}

const compiled = new WeakMap<AnimationSpec, CompiledSequence>();
/** The compiled form of a (validated) action sequence, cached per spec object. */
export function compiledFor(spec: AnimationSpec): CompiledSequence {
  let sequence = compiled.get(spec);
  if (!sequence) { sequence = compileSequence(spec); compiled.set(spec, sequence); }
  return sequence;
}

/** The timeline's length, in seconds at normal speed. */
export function animationDuration(content: Animated): number {
  return content.kind === "writing" ? planFor(content.stroke)?.duration ?? 0 : compiledFor(content.sequence).duration;
}

export const speedRate = (speed?: PlaybackSpeed) => PLAYBACK_SPEEDS[speed ?? "normal"];

/** A new playback for content just presented. */
export const playbackFor = (content: Animated, now: number, rate = 1): PlaybackState => startPlayback(animationDuration(content), now, { rate });

export type ControlResult = { ok: true; playback: PlaybackState; stroke?: number } | { ok: false; problem: string };

/**
 * Applies a command. Strokes are 1-based for people ("the third stroke"); `next` and `previous` move from the stroke
 * being written (or last written); `repeat` without a stroke repeats that one. A figure's sequence has no strokes.
 */
export function controlAnimation(content: Animated, playback: PlaybackState, command: AnimationCommand, now: number): ControlResult {
  const rate = command.speed ? rateFor(command.speed, playback.rate) : playback.rate;
  const withRate = (state: PlaybackState) => command.speed ? setRate(state, now, rate) : state;
  const position = positionAt(playback, now);
  const writing = content.kind === "writing" ? planFor(content.stroke) : null;
  if (content.kind === "writing" && !writing) return { ok: false, problem: "the symbol on show cannot be written" };
  const strokes = writing?.strokes.length ?? 0;
  /** Writes only stroke k (0-based) and stops after it. */
  const only = (k: number): ControlResult => {
    const window = writing ? strokeWindow(writing, k) : null;
    if (!window) return { ok: false, problem: `there are ${strokes} strokes (1–${strokes})` };
    return { ok: true, stroke: k + 1, playback: seek(withRate(playback), now, window.from, { until: window.until, playing: true }) };
  };
  const current = writing ? strokeIndexAt(writing, position) : -1;
  switch (command.action) {
    case "play": case "resume": return { ok: true, playback: withRate(resume(playback, now)) };
    case "pause": return { ok: true, playback: pause(withRate(playback), now) };
    case "speed":
      if (!command.speed) return { ok: false, problem: "speed needs slow, normal, fast, slower or faster" };
      return { ok: true, playback: setRate(playback, now, rate) };
    case "replay": {
      // Writing replays from the finished symbol clearing to its ghost; a figure's sequence from just before it moves.
      const from = writing ? writing.clearStart : SEQUENCE_TIMING.lead * 0.5;
      return { ok: true, playback: replay(withRate(playback), now, from) };
    }
    case "complete":
      return { ok: true, playback: seek(withRate(playback), now, playback.duration, { playing: false }) };
    case "stop":
      return { ok: true, playback: pause(playback, now) };
    case "repeat": {
      if (!writing) return { ok: false, problem: "repeat applies to a symbol being written; use replay for the whole animation" };
      const k = command.stroke !== undefined ? command.stroke - 1 : Math.max(0, current);
      return only(k);
    }
    case "next": case "previous": {
      if (!writing) return { ok: false, problem: `${command.action} applies to a symbol being written` };
      // From the finished symbol, "previous" is the last stroke and "next" starts again at the first.
      const finished = position >= endOf(playback) - 1e-6 && playback.until === null;
      const k = command.action === "next" ? (finished ? 0 : current + 1) : (finished ? strokes - 1 : current - 1);
      if (k < 0) return { ok: false, problem: "this is the first stroke" };
      if (k >= strokes) return { ok: false, problem: "that was the last stroke" };
      return only(k);
    }
  }
}
