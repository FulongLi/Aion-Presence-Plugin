import { planFor, sequenceFor } from "../animation/control";
import type { WritingSource } from "../animation/stroke/compose";
import { writingFrame, type WritingFrame, type WritingPlan } from "../animation/stroke/timeline";
import type { StrokeSequence } from "../animation/stroke/types";
import { positionAt, smooth, type PlaybackState } from "../animation/timeline";
import { GHOST_LIGHT, NO_WRITING, type WritingUniforms } from "../render/writing";
import { strokeLayout } from "../visual/points";
import type { StrokesTarget } from "../visual/types";

/** Light of the strokes outside a highlighted radical. */
export const UNEMPHASIZED = 0.42;

/**
 * The writing target for a sequence: its strokes in order — true outlines where the data has them — and its guides, as
 * the sampler takes them. `highlight: "radical"` keeps the radical's strokes bright and dims the rest.
 */
export function strokesTarget(sequence: StrokeSequence, highlight?: "radical"): StrokesTarget {
  const radical = new Set<number>();
  if (highlight === "radical") for (const item of sequence.items) for (const k of item.radical ?? []) radical.add(item.first + k);
  return {
    kind: "strokes", guides: sequence.guides,
    strokes: sequence.strokes.map((stroke, i) => ({
      path: stroke.path, width: stroke.width, ...(stroke.outline ? { outline: stroke.outline } : {}),
      ...(radical.size ? { emphasis: radical.has(i) ? 1 : UNEMPHASIZED } : {}),
    })),
  };
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
  private current: { id: string; presentation: string; sequence: StrokeSequence; plan: WritingPlan; playback: PlaybackState } | null = null;
  private glide: { from: [number, number, number]; left: number; revision: number } | null = null;
  private lastTip: [number, number, number] = [0, 0, 0];
  private readonly out: WritingUniforms = { ...NO_WRITING, tip: [0, 0, 0] };
  /** The latest frame (normalized), for the card and diagnostics. */
  frame: WritingFrame | null = null;
  /** The sequence being written (for the card and diagnostics). */
  get sequence(): StrokeSequence | null { return this.current?.sequence ?? null; }

  /** The presentation and its playback, from each snapshot. */
  set(presentation: { id: string; stroke: string; source: WritingSource } | null, playback: PlaybackState | null) {
    if (!presentation || !playback) { this.current = null; this.frame = null; return; }
    const sequence = this.current?.presentation === presentation.id ? this.current.sequence : sequenceFor(presentation);
    const plan = sequence ? planFor(presentation) : null;
    if (!sequence || !plan) { this.current = null; return; }
    const previous = this.current;
    // A seek on the same writing: the pen glides from where it is.
    if (previous && previous.presentation === presentation.id && previous.playback.revision !== playback.revision) {
      this.glide = { from: [...this.lastTip], left: GLIDE, revision: playback.revision };
    } else if (!previous || previous.presentation !== presentation.id) this.glide = null;
    this.current = { id: presentation.stroke, presentation: presentation.id, sequence, plan, playback };
  }

  /** The uniforms for this frame. `active`: the formed target is this writing (else every grain is shown as sampled). */
  sample(dt: number, active: boolean, now = Date.now()): WritingUniforms {
    const current = this.current, plan = current?.plan ?? null;
    if (!current || !plan) { this.frame = null; return NO_WRITING; }
    // The frame is always computed (a reference card writes on its own when the body is not writing); the body's
    // uniforms only while it is this writing.
    const frame = writingFrame(current.sequence, plan, positionAt(current.playback, now));
    this.frame = frame;
    if (!active) return NO_WRITING;
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
