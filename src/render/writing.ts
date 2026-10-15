import { WRITING_KEYS } from "../visual/points";

/**
 * Writing (v0.4.3): how a formed writing target is revealed stroke by stroke. Every grain of the symbol keeps its own
 * place (sampled once, see visual/points.ts); only its light changes as the pen passes, so nothing is resampled per
 * frame and the symbol never shakes. The pen's own cluster of grains rides the tip. This is the CPU reference of
 * physics/writing.ts (the canvas fallback and the tests use it); the GPU evaluates the identical expressions.
 *
 *   key ≥ 0   a stroke grain: unwritten (a faint ghost) until progress passes its key, then lit; the stroke being
 *             written a little brighter than those already written, and just-written grains glow for a moment
 *   key = −1  always shown as sampled (guides, and every grain of a target that is not writing)
 *   key = −2  the pen: at tip + its offset, as bright as `pen`
 */
export interface WritingUniforms {
  progress: number; complete: number; pen: number; stroke: number; rest: number; ghost: number;
  tip: [number, number, number];
}

/** No writing in progress: every grain is shown as sampled. */
export const NO_WRITING: Readonly<WritingUniforms> = Object.freeze({ progress: 1e6, complete: 1, pen: 0, stroke: -1, rest: 1, ghost: 1, tip: [0, 0, 0] as [number, number, number] });

/** How far ahead of a grain the progress must be before it is fully lit (in strokes: 2 % of a stroke). */
export const REVEAL_RAMP = 0.02;
/** How long, in strokes, a just-written grain glows. */
export const WRITING_GLOW = 0.08;
/** Light of the faint ghost of what is still to be written. */
export const GHOST_LIGHT = 0.075;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The light factor of a grain with reveal key `key`. */
export function writingLight(key: number, u: WritingUniforms): number {
  if (key <= WRITING_KEYS.pen + 0.5) return u.pen;
  if (key < -0.5) return 1;
  const ahead = u.progress - key;
  const revealed = Math.max(u.complete, clamp01(ahead / REVEAL_RAMP));
  const current = 1 - clamp01(Math.abs(Math.floor(key) - u.stroke));
  const lit = u.rest + (1 - u.rest) * current;
  const glow = ahead >= 0 && ahead < WRITING_GLOW ? (1 - ahead / WRITING_GLOW) * 0.45 * (1 - u.complete) : 0;
  return u.ghost + (lit + glow - u.ghost) * revealed;
}

/** The size factor: the pen's grains vanish with it; everything else keeps its size. */
export const writingSize = (key: number, u: WritingUniforms) => key <= WRITING_KEYS.pen + 0.5 ? u.pen : 1;

/** Where a grain of a writing target rests: its own place, or (the pen) the tip plus its offset. */
export function writingPoint(x: number, y: number, z: number, key: number, u: WritingUniforms): [number, number, number] {
  return key <= WRITING_KEYS.pen + 0.5 ? [u.tip[0] + x, u.tip[1] + y, u.tip[2] + z] : [x, y, z];
}
