import { planFor } from "../animation/control";
import { strokeSequence } from "../animation/stroke/registry";
import { writingFrame, type WritingFrame } from "../animation/stroke/timeline";
import type { StrokeSequence } from "../animation/stroke/types";
import { positionAt, smooth, type PlaybackState } from "../animation/timeline";
import { GHOST_LIGHT, NO_WRITING, type WritingUniforms } from "../render/writing";
import { strokeLayout } from "../visual/points";
import type { StrokesTarget } from "../visual/types";

/** The writing target for a sequence: its strokes in order and its guides, as the sampler takes them. */
export function strokesTarget(sequence: StrokeSequence): StrokesTarget {
  return { kind: "strokes", strokes: sequence.strokes.map(stroke => ({ path: stroke.path, width: stroke.width })), guides: sequence.guides };
}

/** Seconds the pen takes to glide to a new place after a seek ("repeat the third stroke"), instead of jumping. */
const GLIDE = 0.45;

/**
 * Drives the renderer's writing uniforms on one surface (v0.4.3): the writing frame at the playhead (the hub's playback,
 * anchored to the wall clock), with the tip in world units. A seek glides the pen; nothing is written until the target
 * on show is this writing.
 */
export class WritingDriver {
  /** The writing on show: its sequence and playback (null: nothing is written). */
  private current: { id: string; presentation: string; sequence: StrokeSequence; playback: PlaybackState } | null = null;
  private glide: { from: [number, number, number]; left: number; revision: number } | null = null;
  private lastTip: [number, number, number] = [0, 0, 0];
  private readonly out: WritingUniforms = { ...NO_WRITING, tip: [0, 0, 0] };
  /** The latest frame (normalized), for the card and diagnostics. */
  frame: WritingFrame | null = null;

  /** The presentation and its playback, from each snapshot. */
  set(presentation: { id: string; stroke: string } | null, playback: PlaybackState | null) {
    if (!presentation || !playback) { this.current = null; this.frame = null; return; }
    const sequence = this.current?.id === presentation.stroke ? this.current.sequence : strokeSequence(presentation.stroke);
    if (!sequence) { this.current = null; return; }
    const previous = this.current;
    // A seek on the same writing: the pen glides from where it is.
    if (previous && previous.presentation === presentation.id && previous.playback.revision !== playback.revision) {
      this.glide = { from: [...this.lastTip], left: GLIDE, revision: playback.revision };
    } else if (!previous || previous.presentation !== presentation.id) this.glide = null;
    this.current = { id: presentation.stroke, presentation: presentation.id, sequence, playback };
  }

  /** The uniforms for this frame. `active`: the formed target is this writing (else every grain is shown as sampled). */
  sample(dt: number, active: boolean, now = Date.now()): WritingUniforms {
    const current = this.current, plan = current ? planFor(current.id) : null;
    if (!current || !plan || !active) { this.frame = null; return NO_WRITING; }
    const frame = writingFrame(current.sequence, plan, positionAt(current.playback, now));
    this.frame = frame;
    const scale = strokeLayout.scale;
    let tip: [number, number, number] = [frame.tip[0] * scale, frame.tip[1] * scale, frame.tip[2]];
    if (this.glide) {
      this.glide.left -= Math.max(0, Math.min(0.1, dt));
      const k = smooth(1 - Math.max(0, this.glide.left) / GLIDE);
      tip = [0, 1, 2].map(i => this.glide!.from[i] + (tip[i] - this.glide!.from[i]) * k) as [number, number, number];
      if (this.glide.left <= 0) this.glide = null;
    }
    this.lastTip = tip;
    const out = this.out;
    out.progress = frame.progress; out.complete = frame.complete; out.pen = frame.pen; out.stroke = frame.stroke; out.rest = frame.rest;
    out.ghost = GHOST_LIGHT; out.tip = tip;
    return out;
  }
}
