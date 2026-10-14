import { endOf, pause, PLAYBACK_SPEEDS, positionAt, rateFor, replay, resume, seek, setRate, startPlayback, type PlaybackSpeed, type PlaybackState } from "./timeline";
import { writingSequence } from "./stroke/registry";
import type { WritingSource } from "./stroke/compose";
import type { StrokeSequence } from "./stroke/types";
import { itemWindow, strokeIndexAt, strokeWindow, writingPlan, type WritingPlan } from "./stroke/timeline";
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

/**
 * `stroke` (1-based) counts within a symbol: "repeat the third stroke" is the third stroke of the character on show (of
 * `character`, 1-based, in a word). `character` alone repeats that whole character of a word (v0.4.4).
 */
export interface AnimationCommand { action: AnimationAction; stroke?: number; character?: number; speed?: AnimationSpeed }

/** What is being animated: a writing (composed from its source), or a compiled action sequence. */
export type Animated = { kind: "writing"; source: WritingSource } | { kind: "animation"; sequence: AnimationSpec };

const plans = new WeakMap<StrokeSequence, WritingPlan>();
/** A writing's sequence (null when its source does not compose). */
export function sequenceFor(content: { source: WritingSource }): StrokeSequence | null {
  try { return writingSequence(content.source); } catch { return null; }
}
/** The writing plan of a writing (cached with its sequence; null when it cannot be written). */
export function planFor(content: { source: WritingSource }): WritingPlan | null {
  const sequence = sequenceFor(content);
  if (!sequence) return null;
  let plan = plans.get(sequence);
  if (!plan) { plan = writingPlan(sequence); plans.set(sequence, plan); }
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
  return content.kind === "writing" ? planFor(content)?.duration ?? 0 : compiledFor(content.sequence).duration;
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
  const writing = content.kind === "writing" ? planFor(content) : null;
  const sequence = content.kind === "writing" ? sequenceFor(content) : null;
  if (content.kind === "writing" && (!writing || !sequence)) return { ok: false, problem: "the symbol on show cannot be written" };
  const strokes = writing?.strokes.length ?? 0;
  const items = sequence?.items ?? [];
  /** Writes only stroke k (0-based) and stops after it. */
  const only = (k: number): ControlResult => {
    const window = writing ? strokeWindow(writing, k) : null;
    if (!window) return { ok: false, problem: `there are ${strokes} strokes (1–${strokes})` };
    return { ok: true, stroke: k + 1, playback: seek(withRate(playback), now, window.from, { until: window.until, playing: true }) };
  };
  const current = writing ? strokeIndexAt(writing, position) : -1;
  /** The symbol a command is about: the one asked for, else the one being written (or last written). */
  const itemIndex = command.character !== undefined ? command.character - 1 : Math.max(0, current >= 0 ? sequence!.strokes[current].item : 0);
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
      const item = items[itemIndex];
      if (!item) return { ok: false, problem: `there ${items.length === 1 ? "is one symbol" : `are ${items.length} symbols`} (1–${items.length})` };
      if (command.stroke !== undefined) {
        if (command.stroke < 1 || command.stroke > item.count) return { ok: false, problem: `${item.symbol} has ${item.count} stroke${item.count > 1 ? "s" : ""} (1–${item.count})` };
        return only(item.first + command.stroke - 1);
      }
      // A whole character of a word, or (without either) the stroke being written.
      if (command.character !== undefined && items.length > 1) {
        const window = itemWindow(writing, item.first, item.count)!;
        return { ok: true, stroke: item.first + 1, playback: seek(withRate(playback), now, window.from, { until: window.until, playing: true }) };
      }
      return only(Math.max(0, current));
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
