import { sanitizeState, type AionState } from "../state";
import { EYE_GEOMETRY, EYE_PARAMS } from "./layout";

/**
 * Aion Eyes' expressions and their animation. An expression is a shape for each eye — openness, lids, gaze, iris,
 * brow — plus a little roll and bounce of the pair; the animator eases between them, blinks, moves the gaze in
 * quick saccades with still moments between, and follows Aion's state. Expressive through shape and timing, with
 * natural asymmetry, never cartoonish exaggeration.
 */
export const EYE_EXPRESSIONS = ["neutral", "attentive", "thinking", "curious", "happy", "surprised", "confused", "sleepy", "concerned"] as const;
export type EyeExpression = typeof EYE_EXPRESSIONS[number];
export const isEyeExpression = (value: unknown): value is EyeExpression => typeof value === "string" && (EYE_EXPRESSIONS as readonly string[]).includes(value);

/** One eye's shape. Slopes are "inner-positive": a positive lid slope lowers the inner corner, a positive brow slope raises the inner end. */
export interface EyeShape {
  /** Width and height scale (1: at rest). */
  width: number; open: number;
  /** Upper and lower lid closure (0 open … 0.5 meeting in the middle). */
  upper: number; lower: number;
  /** Upper lid slope, inner corner down positive (focus, a frown); negative droops the outer corner. */
  slope: number;
  /** The lower lid curving up in the middle: a smile. */
  smile: number;
  /** Gaze (shape units, ±0.4) and iris size (1: at rest), glint brightness. */
  gazeX: number; gazeY: number; iris: number; glint: number;
  /** Brow: how far it lifts out of the rim (0…1), its height above the eye, inner-end raise, arch. */
  brow: number; browLift: number; browSlope: number; browArch: number;
}
export interface ExpressionShape { left: EyeShape; right: EyeShape; roll: number; bounce: number }

const NEUTRAL_EYE: EyeShape = {
  width: 1, open: 1, upper: 0, lower: 0, slope: 0, smile: 0, gazeX: 0, gazeY: 0, iris: 1, glint: 1,
  brow: 0, browLift: 0, browSlope: 0, browArch: 0,
};
const eye = (shape: Partial<EyeShape> = {}): EyeShape => ({ ...NEUTRAL_EYE, ...shape });
const pair = (both: Partial<EyeShape>, left: Partial<EyeShape> = {}, right: Partial<EyeShape> = {}, roll = 0, bounce = 0): ExpressionShape =>
  ({ left: eye({ ...both, ...left }), right: eye({ ...both, ...right }), roll, bounce });

/** "left" is the eye on the viewer's left. */
export const EXPRESSIONS: Record<EyeExpression, ExpressionShape> = {
  neutral: pair({}),
  // Wide, bright and still: the brows lift a little out of the rims, the irises open.
  attentive: pair({ width: 1.03, open: 1.07, iris: 1.12, brow: 0.55, browLift: 0.04, browArch: 0.3, glint: 1.1 }),
  // The gaze drifts up and aside, lids a little lower, one brow raised more than the other.
  thinking: pair({ open: 0.93, upper: 0.09, gazeX: 0.3, gazeY: 0.34, iris: 0.95 }, { brow: 0.8, browLift: 0.1, browSlope: 0.05 }, { brow: 0.45, browLift: -0.04 }),
  // A tilt, one eye a little larger with its brow up, the irises open.
  curious: pair({ iris: 1.14, gazeX: 0.12, gazeY: 0.06 }, { open: 0.95, brow: 0.45, browLift: 0.02 }, { width: 1.05, open: 1.13, brow: 0.95, browLift: 0.17, browArch: 0.3 }, 0.11),
  // Smiling eyes: the lower lids curve up into crescents, the brows rise softly, a little bounce.
  happy: pair({ smile: 1.15, lower: 0.2, upper: 0.03, iris: 0.55, gazeY: 0.12, brow: 0.6, browLift: 0.06, browArch: 0.4, glint: 1.15 }, {}, {}, 0, 0.03),
  // Open wide and taller, small irises, brows high.
  surprised: pair({ width: 1.08, open: 1.2, iris: 0.78, brow: 1, browLift: 0.26, browArch: 0.55, glint: 1.2 }),
  // One eye narrowed under a lowered brow, the other open under a raised one, a tilt.
  confused: pair({ gazeX: -0.14, gazeY: 0.08 }, { upper: 0.2, slope: 0.12, brow: 0.9, browLift: -0.05, browSlope: -0.08 }, { open: 1.08, brow: 1, browLift: 0.22, browArch: 0.3 }, -0.09),
  // Heavy lids, outer corners drooping, the gaze lowered.
  sleepy: pair({ upper: 0.36, lower: 0.05, slope: -0.08, gazeY: -0.22, iris: 0.95, glint: 0.7, brow: 0.25, browLift: -0.06 }),
  // Worry (an error): inner brows up, the outer lids soft, the gaze a little down.
  concerned: pair({ upper: 0.1, slope: -0.14, gazeY: -0.12, iris: 0.96, brow: 0.9, browLift: 0.04, browSlope: 0.22 }),
};

/** Which expression each state wears when nothing was asked for. */
export const STATE_EXPRESSION: Record<AionState, EyeExpression> = {
  idle: "neutral", listening: "attentive", thinking: "thinking", reading: "thinking", working: "thinking", editing: "thinking",
  testing: "attentive", building: "thinking", responding: "neutral", speaking: "neutral", presenting: "neutral", complete: "happy",
  error: "concerned", greeting: "happy", acknowledging: "attentive", offering: "curious",
};

const KEYS = Object.keys(NEUTRAL_EYE) as (keyof EyeShape)[];
const approach = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const irregular = (t: number, seed: number) => 0.5 + 0.5 * Math.sin(t * 0.83 + seed) * Math.sin(t * 0.37 + seed * 2.1);
const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

/** A blink: lids close fast, hold for a breath, open a little slower (seconds). */
export const BLINK = { close: 0.075, hold: 0.04, open: 0.13 };
export function blinkAmount(t: number): number {
  if (t < 0) return 0;
  if (t < BLINK.close) return smooth(t / BLINK.close);
  if (t < BLINK.close + BLINK.hold) return 1;
  return 1 - smooth((t - BLINK.close - BLINK.hold) / BLINK.open);
}

/** Packs the two eyes' shapes into the uniform layout of EYE_PARAMS (see layout.ts). */
export function packEyes(shape: ExpressionShape, out = new Float32Array(EYE_PARAMS * 2), lift = 0): Float32Array {
  const g = EYE_GEOMETRY;
  const c = Math.cos(shape.roll), s = Math.sin(shape.roll);
  ([shape.left, shape.right] as const).forEach((e, index) => {
    const side = index === 0 ? -1 : 1, inner = -side, o = index * EYE_PARAMS;
    // The pair rolls about its middle; each eye shifts a touch with its gaze (eyes are not pinned in place).
    const x = side * g.spacing + e.gazeX * 0.05, y = g.centreY + shape.bounce + lift + e.gazeY * 0.03;
    out[o] = x * c - (y - g.centreY) * s; out[o + 1] = g.centreY + x * s + (y - g.centreY) * c;
    out[o + 2] = g.halfWidth * e.width; out[o + 3] = g.halfHeight * e.open;
    out[o + 4] = e.upper; out[o + 5] = e.lower;
    // Inner corner: +u for the left eye, −u for the right. The lid's top is 1 − 2·upper − slope·u.
    out[o + 6] = e.slope * inner; out[o + 7] = e.smile;
    out[o + 8] = Math.max(-0.42, Math.min(0.42, e.gazeX)); out[o + 9] = Math.max(-0.42, Math.min(0.42, e.gazeY));
    out[o + 10] = g.iris * e.iris; out[o + 11] = e.glint;
    out[o + 12] = e.browLift; out[o + 13] = -e.browSlope * inner; out[o + 14] = e.browArch; out[o + 15] = e.brow;
  });
  return out;
}

export interface EyesInputs {
  /** The user's loudness while Aion listens (0…1). */
  listen?: number;
  /** Real host speech loudness (0…1). */
  amplitude?: number;
  /** Reduced motion: fewer saccades, slower changes. */
  calm?: boolean;
  /** Something to look at, in shape units of the gaze (e.g. toward a card on the right); null: free. */
  look?: [number, number] | null;
}

/**
 * Animates the eyes: the state's expression (or one that was asked for, for a few seconds), eased; blinks at
 * irregular intervals (sometimes twice; slower when sleepy); the gaze in saccades — quick moves, then stillness —
 * whose range and rhythm depend on the state (reading scans along a line; listening holds the user's gaze);
 * the user's voice widens them; answering moves lids and brows a little, out of step, never as a loop.
 */
export class EyesAnimator {
  readonly params = new Float32Array(EYE_PARAMS * 2);
  private current: ExpressionShape = structuredClone(EXPRESSIONS.neutral);
  private requested: { name: EyeExpression; until: number } | null = null;
  private clock = 0;
  private nextBlink = 1.6;
  private blinkAt = -10;
  private doubleBlink = false;
  private nextSaccade = 0.8;
  private gaze: [number, number] = [0, 0];
  private gazeGoal: [number, number] = [0, 0];
  private scan = 0;
  private dip = { at: -10 };
  private lastState: AionState = "idle";
  private readonly random = seeded(0xe7e5);
  /** The expression being worn (asked for, or the state's). */
  expression: EyeExpression = "neutral";

  /** Shows an expression for `seconds`, above the state's own (blinking and gaze continue). */
  express(name: EyeExpression, seconds = 4) {
    if (!isEyeExpression(name)) return;
    this.requested = { name, until: this.clock + Math.max(0.5, Math.min(60, Number.isFinite(seconds) ? seconds : 4)) };
  }
  /** A quick blink now (a gesture, an acknowledgement). */
  blink() { this.blinkAt = this.clock; }
  /** A small dip of both eyes, as a nod. */
  nod() { this.dip.at = this.clock; this.blinkAt = this.clock + 0.05; }

  sample(dt: number, state: AionState, t: number, inputs: EyesInputs = {}): Float32Array {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    this.clock += step;
    const safe = sanitizeState(state);
    const since = Number.isFinite(t) ? Math.max(0, t) : 0;
    const calm = inputs.calm === true;
    if (safe !== this.lastState) {
      // A new state is met with a blink (people blink as attention shifts), and an acknowledgement nods.
      if (this.clock - this.blinkAt > 0.6) this.blinkAt = this.clock + 0.03;
      if (safe === "acknowledging") this.nod();
      this.lastState = safe;
    }
    if (this.requested && this.clock > this.requested.until) this.requested = null;
    // A long quiet idle grows sleepy; anything else wakes it.
    let name: EyeExpression = this.requested?.name ?? (safe === "idle" && since > 120 ? "sleepy" : STATE_EXPRESSION[safe]);
    // Completion and greeting are brief bright moments, then the eyes settle.
    if (!this.requested && (safe === "complete" && since > 1.8)) name = "neutral";
    this.expression = name;
    const goal = structuredClone(EXPRESSIONS[name]);
    const listen = Math.max(0, Math.min(1, inputs.listen ?? 0)), amplitude = Math.max(0, Math.min(1, inputs.amplitude ?? 0));
    for (const e of [goal.left, goal.right]) {
      // The user's voice: a little wider, irises open, brows up a touch.
      e.open += listen * 0.08; e.iris += listen * 0.14; e.browLift += listen * 0.06; e.brow = Math.max(e.brow, listen * 0.6);
    }
    if ((safe === "responding" || safe === "speaking") && !this.requested) {
      // Answering: lids and brows move a little with the thought, each on its own slow rhythm.
      const talk = irregular(since, 0.7) * (0.6 + amplitude * 0.8), lift = irregular(since, 2.9);
      for (const [e, k] of [[goal.left, 0], [goal.right, 0.15]] as const) {
        e.smile += talk * 0.28 + k * 0.05; e.brow = Math.max(e.brow, 0.25 + lift * 0.45); e.browLift += lift * 0.08 - k * 0.02; e.open += amplitude * 0.05;
      }
    }
    // Ease toward the expression (lids a little faster than the rest).
    const rate = calm ? 4 : 9;
    for (const side of ["left", "right"] as const) {
      const now = this.current[side], target = goal[side];
      for (const key of KEYS) {
        now[key] = approach(now[key], target[key], key === "upper" || key === "lower" ? rate * 1.4 : rate, step);
      }
    }
    this.current.roll = approach(this.current.roll, goal.roll, rate * 0.6, step);
    this.current.bounce = approach(this.current.bounce, goal.bounce * (0.6 + 0.4 * Math.abs(Math.sin(this.clock * 6))), rate, step);
    this.updateGaze(step, safe, inputs.look ?? null, calm);
    // Blinks: every 2.5–6 s (sleepy: slower and longer), sometimes twice.
    if (this.clock >= this.nextBlink) {
      this.blinkAt = this.clock;
      this.doubleBlink = this.random() < 0.18;
      this.nextBlink = this.clock + (name === "sleepy" ? 4 + this.random() * 4 : 2.5 + this.random() * 3.5) * (calm ? 1.5 : 1);
    }
    let blink = blinkAmount((this.clock - this.blinkAt) * (name === "sleepy" ? 0.55 : 1));
    if (this.doubleBlink) blink = Math.max(blink, blinkAmount(this.clock - this.blinkAt - 0.32));
    const shape: ExpressionShape = { left: { ...this.current.left }, right: { ...this.current.right }, roll: this.current.roll, bounce: this.current.bounce };
    for (const e of [shape.left, shape.right]) {
      // The expression's own gaze (up and aside while thinking) plus the saccades.
      e.gazeX += this.gaze[0]; e.gazeY += this.gaze[1];
      e.upper += (0.52 - e.upper) * blink; e.lower += (0.46 - e.lower) * blink; e.smile *= 1 - blink;
    }
    const dip = this.clock - this.dip.at;
    const nod = dip >= 0 && dip < 0.7 ? -Math.sin(Math.PI * dip / 0.7) * 0.07 : 0;
    // Breathing: the pair rises and falls very slightly.
    const breath = Math.sin(this.clock * Math.PI * 2 * 0.22) * 0.006 * (calm ? 0.3 : 1);
    return packEyes(shape, this.params, nod + breath);
  }

  /** Saccades: a new point to look at every so often, reached in a few hundredths of a second, then held. */
  private updateGaze(step: number, state: AionState, look: [number, number] | null, calm: boolean) {
    if (look) {
      this.gazeGoal = [Math.max(-0.4, Math.min(0.4, look[0])), Math.max(-0.4, Math.min(0.4, look[1]))];
      this.nextSaccade = this.clock + 0.8;
    } else if (this.clock >= this.nextSaccade) {
      const r = () => this.random() * 2 - 1;
      let range = 0.16, hold = [1.2, 3.2];
      if (state === "listening" || state === "testing") { range = 0.06; hold = [2.2, 4.5]; }
      else if (state === "thinking" || state === "working" || state === "building" || state === "editing") { range = 0.12; hold = [1.6, 3.6]; }
      if (state === "reading") {
        // Reading: along a line in small steps, then back to the start of the next.
        this.scan = this.scan >= 3 ? 0 : this.scan + 1;
        this.gazeGoal = [-0.24 + this.scan * 0.16, -0.2 + (this.scan === 0 ? -0.04 : 0)];
        this.nextSaccade = this.clock + 0.35 + this.random() * 0.25;
      } else {
        // Most saccades return near the centre (the user); some wander.
        const wander = this.random() < 0.35 ? 1.6 : 0.6;
        this.gazeGoal = [r() * range * wander, r() * range * 0.6 * wander];
        this.nextSaccade = this.clock + (hold[0] + this.random() * (hold[1] - hold[0])) * (calm ? 1.6 : 1);
      }
    }
    // A saccade is fast (tens of milliseconds); calm motion is slower.
    const speed = calm ? 8 : 26;
    this.gaze[0] = approach(this.gaze[0], this.gazeGoal[0], speed, step);
    this.gaze[1] = approach(this.gaze[1], this.gazeGoal[1], speed, step);
  }
}
