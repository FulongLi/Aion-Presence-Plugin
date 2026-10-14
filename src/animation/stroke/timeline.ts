import { ease, smooth } from "../timeline";
import { arcLengths, gapSeconds, pointAlong } from "./path";
import type { StrokeSequence } from "./types";

/**
 * The Stroke Timeline Controller: a writing sequence laid out in time, and the writing state at any moment. The
 * symbol first forms complete (so the user sees what will be written), quietly clears to a faint ghost, then each
 * stroke is written in order with a pause between strokes while the pen travels; the finished symbol stays.
 *
 *   lead (the body forms) · preview · clear · ready · stroke 1 · gap · stroke 2 · … · stroke n · end
 *
 * Times are at normal speed; playback speed is the PlaybackState's rate (animation/timeline.ts). Everything is a pure
 * function of time, so a replay, a seek or a slower speed always shows exactly the same writing.
 */
export const WRITING_TIMING = { lead: 1.9, preview: 1.3, clear: 0.7, ready: 0.45, end: 0.8 } as const;

export interface StrokeSlot { start: number; end: number }
export interface WritingPlan {
  /** Seconds, start to finished symbol. */
  duration: number;
  /** When the first stroke begins. */
  writeStart: number;
  /** When the clearing begins (a replay starts here, so the finished symbol fades gently into the ghost). */
  clearStart: number;
  strokes: StrokeSlot[];
}

export function writingPlan(sequence: StrokeSequence): WritingPlan {
  const clearStart = WRITING_TIMING.lead + WRITING_TIMING.preview;
  let at = clearStart + WRITING_TIMING.clear + WRITING_TIMING.ready;
  const writeStart = at;
  const strokes = sequence.strokes.map((stroke, i) => {
    if (i) at += gapSeconds(sequence.strokes[i - 1].endPoint, stroke.startPoint);
    const slot = { start: at, end: at + stroke.duration };
    at = slot.end;
    return slot;
  });
  return { duration: at + WRITING_TIMING.end, writeStart, clearStart, strokes };
}

export type WritingPhase = "forming" | "preview" | "clearing" | "ready" | "stroke" | "gap" | "done";

/**
 * What the renderer needs at one moment (normalized coordinates):
 *   progress   strokes written so far: k + u while stroke k is u of the way along (grains with key ≤ progress are written)
 *   complete   1: the whole symbol is shown regardless of progress (the preview), easing to 0 as it clears
 *   pen        how visible the pen's small cluster of light is (1 writing, about ½ while it travels lifted, 0 otherwise)
 *   tip        where the pen is; z lifts toward the viewer while the pen travels between strokes
 *   stroke     the stroke being written (−1: none), lit a little brighter than those already written
 *   rest       brightness of strokes already written (1 when none is being written)
 */
export interface WritingFrame {
  phase: WritingPhase;
  progress: number;
  complete: number;
  pen: number;
  tip: [number, number, number];
  stroke: number;
  rest: number;
}

/** The pen accelerates, travels and slows at the end of a stroke, as a hand does (partly eased, never stopping). */
export const penEase = (s: number) => s + (smooth(s) - s) * 0.55;

const lengthsCache = new WeakMap<number[], Float64Array>();
const along = (path: number[], u: number) => {
  let lengths = lengthsCache.get(path);
  if (!lengths) { lengths = arcLengths(path); lengthsCache.set(path, lengths); }
  return pointAlong(path, u, lengths);
};

export function writingFrame(sequence: StrokeSequence, plan: WritingPlan, time: number): WritingFrame {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  const n = sequence.strokes.length;
  const first = sequence.strokes[0].startPoint, last = sequence.strokes[n - 1].endPoint;
  const frame = (phase: WritingPhase, patch: Partial<WritingFrame>): WritingFrame =>
    ({ phase, progress: n, complete: 0, pen: 0, tip: [first[0], first[1], 0], stroke: -1, rest: 1, ...patch });
  if (t < WRITING_TIMING.lead) return frame("forming", { complete: 1 });
  if (t < plan.clearStart) return frame("preview", { complete: 1 });
  const ready = plan.clearStart + WRITING_TIMING.clear;
  if (t < ready) {
    const k = (t - plan.clearStart) / WRITING_TIMING.clear;
    return frame("clearing", { progress: 0, complete: 1 - ease("inOut", k), rest: 1 - 0.2 * smooth(k) });
  }
  if (t < plan.writeStart) return frame("ready", { progress: 0, pen: smooth((t - ready) / WRITING_TIMING.ready), rest: 0.8 });
  for (let k = 0; k < n; k++) {
    const slot = plan.strokes[k];
    if (t < slot.start) {
      // Between strokes: the pen lifts and travels from the end of stroke k − 1 to the start of stroke k.
      const previous = plan.strokes[k - 1];
      const v = (t - previous.end) / Math.max(1e-6, slot.start - previous.end);
      const from = sequence.strokes[k - 1].endPoint, to = sequence.strokes[k].startPoint, e = ease("inOut", v);
      return frame("gap", {
        progress: k, pen: 0.5 + 0.5 * Math.abs(1 - 2 * v) ** 2, stroke: k - 1, rest: 0.8,
        tip: [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, Math.sin(Math.PI * v) * 0.12],
      });
    }
    if (t < slot.end) {
      const u = penEase((t - slot.start) / (slot.end - slot.start));
      const p = along(sequence.strokes[k].path, u);
      return frame("stroke", { progress: k + u, pen: 1, stroke: k, rest: 0.8, tip: [p.x, p.y, 0] });
    }
  }
  // Written: the pen fades away and every stroke settles to the same light.
  const k = Math.min(1, (t - plan.strokes[n - 1].end) / WRITING_TIMING.end);
  return frame("done", { pen: 1 - smooth(k * 1.6), rest: 0.8 + 0.2 * smooth(k), stroke: k < 0.5 ? n - 1 : -1, tip: [last[0], last[1], 0] });
}

/** Seconds before a stroke at which a repeat of it begins (the pen arrives); also when it counts as "the current stroke". */
const STROKE_LEAD = 0.4;

/** The stroke being written at `t`, or the last one begun (−1 before the first). */
export function strokeIndexAt(plan: WritingPlan, t: number): number {
  let index = -1;
  plan.strokes.forEach((slot, k) => { if (t >= slot.start - STROKE_LEAD - 1e-6) index = k; });
  return index;
}

/** Where to seek to write only stroke `k` (0-based): the pen arrives, writes it, and rests a moment after it. */
export function strokeWindow(plan: WritingPlan, k: number): { from: number; until: number } | null {
  const slot = plan.strokes[k];
  if (!slot) return null;
  return { from: Math.max(plan.writeStart - WRITING_TIMING.ready, slot.start - STROKE_LEAD), until: Math.min(plan.duration, slot.end + 0.3) };
}
