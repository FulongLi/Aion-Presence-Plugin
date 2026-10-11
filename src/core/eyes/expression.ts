import { sanitizeState, type AionState } from "../state";
import { EYE_GEOMETRY, EYE_PARAMS } from "./layout";

/**
 * Aion Eyes' expressions and their animation (v0.4.1, the cartoon design). An expression is a shape for each eye —
 * size, squash and stretch, roundness, lid cuts, an arc, a tilt — plus where the pair looks, its roll and its lift.
 * Nothing is anatomical: a happy eye is a curved "^", a sleepy one a soft "‿", a surprised one pops open round.
 *
 * Every number is driven by a spring, not an ease: shapes overshoot a little and settle (elastic), each expression
 * enters with its own small action (a hop of joy, the squash before a pop of surprise, the wobble of confusion, the
 * narrowing that comes before a thinking glance) and each has its own tempo (sleepy is slow). Blinks squash the eye
 * to a line and let it spring back a touch taller. The gaze moves in quick saccades with stillness between, most of
 * the time back at the user.
 */
export const EYE_EXPRESSIONS = ["neutral", "attentive", "thinking", "curious", "happy", "surprised", "confused", "sleepy", "concerned"] as const;
export type EyeExpression = typeof EYE_EXPRESSIONS[number];
export const isEyeExpression = (value: unknown): value is EyeExpression => typeof value === "string" && (EYE_EXPRESSIONS as readonly string[]).includes(value);

/**
 * One eye's shape. Lid slopes and tilts are "inner-positive", so each eye mirrors the other naturally: a positive
 * slope lowers the lid at the inner corner (focus, a frown), a negative one at the outer corner (worry, drowsiness);
 * a positive tilt raises the inner corner.
 */
export interface EyeShape {
  /** Overall scale, and width and height on top of it (1: at rest). */
  size: number; width: number; height: number;
  /** Superellipse exponent: 2 round, about 3 the rounded rectangle, 4 squarer. */
  round: number;
  /** Upper and lower lid closure (0 open … 0.5 meeting in the middle), the upper lid's slope, the lower lid rising in the middle. */
  upper: number; lower: number; slope: number; cheek: number;
  /** An arc (world units at size 1): the middle lifts, the ends stay. Positive is "^", negative "‿". */
  bend: number;
  /** Turn of the eye about its own centre (radians, inner corner up positive). */
  tilt: number;
  /** Offset of this eye from its place (world): dx outward, dy up. */
  dx: number; dy: number;
  /** Brightness, and the light of the edge and of the fill. */
  glow: number; edge: number; fill: number;
}

export interface ExpressionShape {
  left: EyeShape; right: EyeShape;
  /** The pair: roll about its middle (radians), lift (world), and where it looks (−1…1 each way). */
  roll: number; lift: number; gazeX: number; gazeY: number;
}

const NEUTRAL_EYE: EyeShape = {
  size: 1, width: 1, height: 1, round: EYE_GEOMETRY.n, upper: 0, lower: 0, slope: 0, cheek: 0, bend: 0, tilt: 0, dx: 0, dy: 0,
  glow: 1, edge: 1, fill: 0.7,
};
const eye = (shape: Partial<EyeShape> = {}): EyeShape => ({ ...NEUTRAL_EYE, ...shape });
const pair = (both: Partial<EyeShape>, left: Partial<EyeShape> = {}, right: Partial<EyeShape> = {}, whole: Partial<Omit<ExpressionShape, "left" | "right">> = {}): ExpressionShape =>
  ({ left: eye({ ...both, ...left }), right: eye({ ...both, ...right }), roll: 0, lift: 0, gazeX: 0, gazeY: 0, ...whole });

/** "left" is the eye on the viewer's left. */
export const EXPRESSIONS: Record<EyeExpression, ExpressionShape> = {
  // Calm rounded rectangles, looking at the user.
  neutral: pair({}),
  // Perked up: a little larger and taller, brighter, very still.
  attentive: pair({ size: 1.06, height: 1.05, round: 3, glow: 1.08, fill: 0.74 }, {}, {}, { lift: 0.025 }),
  // One eye narrows; then the pair glances up and aside (the glance comes a moment later, see ENTRY).
  thinking: pair({}, { height: 0.95 }, { upper: 0.25, slope: -0.04, height: 0.96 }, { gazeX: 0.55, gazeY: 0.42, roll: 0.03 }),
  // A tilt toward something interesting, one eye opened wider than the other.
  curious: pair({}, { size: 0.9, upper: 0.07 }, { size: 1.13, height: 1.06, round: 2.8 }, { roll: 0.13, gazeX: 0.25, gazeY: 0.12, lift: 0.02 }),
  // Two smiling arcs: "^ ^".
  happy: pair({ height: 0.19, width: 1.08, round: 2, bend: 0.22, glow: 1.12, edge: 1.05, fill: 0.95, dy: -0.04 }, {}, {}, { lift: 0.035 }),
  // Popped open: big, round, bright-edged.
  surprised: pair({ size: 1.17, width: 1.04, height: 1.12, round: 2.05, glow: 1.12, edge: 1.15, fill: 0.64 }, {}, {}, { lift: 0.06 }),
  // Lopsided: one eye squashed under a slanted lid, the other tall; each tilted its own way, the pair askew.
  confused: pair({}, { height: 0.62, upper: 0.1, slope: 0.16, tilt: -0.1, size: 0.95 }, { size: 1.06, height: 1.06, tilt: 0.08 }, { roll: -0.1, gazeX: -0.3, gazeY: 0.28 }),
  // Heavy lids sinking at the outer corners; after a moment they close into soft curves (see SLEEPY).
  sleepy: pair({ upper: 0.33, slope: -0.07, glow: 0.88, fill: 0.64 }, {}, {}, { lift: -0.03, gazeY: -0.25 }),
  // Worry: the inner corners up, the outer lids down, a little smaller, the gaze lowered.
  concerned: pair({ size: 0.94, upper: 0.12, slope: -0.2, tilt: 0.06, glow: 0.95, fill: 0.64 }, {}, {}, { gazeY: -0.32, lift: -0.02 }),
};

/** Sleepy, fully asleep: soft horizontal curves ("‿ ‿"), reached gradually (SLEEPY.closing seconds in). */
export const ASLEEP: ExpressionShape = pair({ height: 0.13, width: 1.04, round: 2, bend: -0.07, glow: 0.82, edge: 0.95, fill: 0.92, dy: -0.06 }, {}, {}, { lift: -0.04 });
export const SLEEPY = { closing: 1.4, closed: 3.6 };

/**
 * How each expression enters (applied once, when it begins): impulses to the springs (per second), and for thinking
 * the delay before its glance. These are what make the change read as an action rather than a cross-fade.
 */
export const ENTRY: Partial<Record<EyeExpression, { lift?: number; size?: number; height?: number; roll?: number; glanceAfter?: number }>> = {
  happy: { lift: 1.6 },
  surprised: { size: -1.1, height: 2.6, lift: 0.6 },
  confused: { roll: -1.8 },
  curious: { roll: 1.1, size: 0.4 },
  attentive: { size: 0.7 },
  concerned: { lift: -0.5 },
  thinking: { glanceAfter: 0.38 },
};

/** Tempo: how quickly an expression's springs move (sleepy is slow, surprise quick). */
export const TEMPO: Partial<Record<EyeExpression, number>> = { sleepy: 0.32, surprised: 1.35, happy: 1.1, concerned: 0.8 };

/** Which expression each state wears when nothing was asked for. */
export const STATE_EXPRESSION: Record<AionState, EyeExpression> = {
  idle: "neutral", listening: "attentive", thinking: "thinking", reading: "thinking", working: "thinking", editing: "thinking",
  testing: "attentive", building: "thinking", responding: "neutral", speaking: "neutral", presenting: "neutral", complete: "happy",
  error: "concerned", greeting: "happy", acknowledging: "attentive", offering: "curious",
};

const EYE_KEYS = Object.keys(NEUTRAL_EYE) as (keyof EyeShape)[];
const PAIR_KEYS = ["roll", "lift", "gazeX", "gazeY"] as const;
/** Spring frequency (rad/s) and damping ratio per key: shapes elastic, lids firmer, light smooth, gaze quick. */
const SPRINGS: Record<keyof EyeShape | typeof PAIR_KEYS[number], [number, number]> = {
  size: [15, 0.42], width: [15, 0.5], height: [16, 0.58], round: [12, 0.8],
  upper: [20, 0.75], lower: [20, 0.75], slope: [18, 0.7], cheek: [18, 0.75], bend: [14, 0.5], tilt: [11, 0.5],
  dx: [14, 0.6], dy: [14, 0.6], glow: [8, 1], edge: [8, 1], fill: [8, 1],
  roll: [9, 0.45], lift: [12, 0.38], gazeX: [34, 0.82], gazeY: [34, 0.82],
};

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const irregular = (t: number, seed: number) => 0.5 + 0.5 * Math.sin(t * 0.83 + seed) * Math.sin(t * 0.37 + seed * 2.1);
const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Linear blend of two expression shapes (for gradual expressions such as falling asleep). */
export function blendShapes(a: ExpressionShape, b: ExpressionShape, t: number): ExpressionShape {
  const mixEye = (x: EyeShape, y: EyeShape) => Object.fromEntries(EYE_KEYS.map(key => [key, x[key] + (y[key] - x[key]) * t])) as unknown as EyeShape;
  return {
    left: mixEye(a.left, b.left), right: mixEye(a.right, b.right),
    roll: a.roll + (b.roll - a.roll) * t, lift: a.lift + (b.lift - a.lift) * t, gazeX: a.gazeX + (b.gazeX - a.gazeX) * t, gazeY: a.gazeY + (b.gazeY - a.gazeY) * t,
  };
}

/**
 * A blink (seconds): the eye squashes shut fast, holds for a breath, and springs open a little slower, overshooting
 * into a slightly taller eye before it settles (squash, then stretch). Negative values are that stretch.
 */
export const BLINK = { close: 0.07, hold: 0.035, open: 0.14, settle: 0.16 };
export function blinkAmount(t: number): number {
  if (t < 0) return 0;
  if (t < BLINK.close) return smooth(t / BLINK.close);
  if (t < BLINK.close + BLINK.hold) return 1;
  const opening = t - BLINK.close - BLINK.hold;
  if (opening < BLINK.open) return 1 - smooth(opening / BLINK.open);
  const after = opening - BLINK.open;
  return after < BLINK.settle ? -0.07 * Math.sin(Math.PI * after / BLINK.settle) : 0;
}

/**
 * Packs the two eyes' shapes and the pair's gaze into the uniform layout of EYE_PARAMS (see layout.ts). `blink`
 * (0…1, negative: the stretch after it) squashes both eyes; `lift` moves the pair (a nod, a breath).
 */
export function packEyes(shape: ExpressionShape, out = new Float32Array(EYE_PARAMS * 2), lift = 0, blink = 0): Float32Array {
  const g = EYE_GEOMETRY;
  const c = Math.cos(shape.roll), s = Math.sin(shape.roll);
  const gx = clamp(shape.gazeX, -1, 1), gy = clamp(shape.gazeY, -1, 1);
  ([shape.left, shape.right] as const).forEach((e, index) => {
    const side = index === 0 ? -1 : 1, inner = -side, o = index * EYE_PARAMS;
    // Looking aside, the pair shifts that way, the nearer eye grows and the farther shrinks (as if the head turned);
    // looking up or down it shifts and flattens a little.
    const near = 1 + 0.1 * side * gx;
    const size = Math.max(0.2, e.size) * near;
    const hw = g.halfWidth * size * Math.max(0.3, e.width) * (1 - 0.1 * Math.abs(gx)) * (1 + 0.08 * Math.max(0, blink));
    const squash = blink >= 0 ? 1 - 0.9 * blink : 1 - blink;
    const hh = g.halfHeight * size * Math.max(0.06, e.height) * (1 - 0.06 * Math.abs(gy)) * squash;
    const x = side * (g.spacing + e.dx) + gx * 0.13;
    const y = g.centreY + shape.lift + lift + e.dy + gy * 0.09 - 0.22 * Math.max(0, blink) * g.halfHeight * size * e.height;
    // The pair rolls about its middle.
    out[o] = x * c - (y - g.centreY) * s; out[o + 1] = g.centreY + x * s + (y - g.centreY) * c;
    out[o + 2] = hw; out[o + 3] = hh;
    out[o + 4] = clamp(e.upper, 0, 0.5); out[o + 5] = clamp(e.lower, 0, 0.5);
    // Inner corner: +u for the left eye, −u for the right. The lid's top is 1 − 2·upper − slope·u.
    out[o + 6] = e.slope * inner; out[o + 7] = e.cheek;
    out[o + 8] = clamp(e.round, 1.6, 6); out[o + 9] = e.bend * size;
    // Tilt: the eye's own turn (inner corner up positive) plus the pair's roll.
    out[o + 10] = e.tilt * inner + shape.roll; out[o + 11] = Math.max(0, e.glow);
    out[o + 12] = Math.max(0, e.edge); out[o + 13] = Math.max(0, e.fill); out[o + 14] = 1; out[o + 15] = 0;
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
  /** Something to look at (gaze, −1…1 each way: +x toward the viewer's right, e.g. a card); null: free. */
  look?: [number, number] | null;
}

class Spring {
  velocity = 0;
  constructor(public value: number) {}
  step(target: number, dt: number, omega: number, zeta: number) {
    const accel = omega * omega * (target - this.value) - 2 * zeta * omega * this.velocity;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
  }
}
type SpringShape = { left: Record<keyof EyeShape, Spring>; right: Record<keyof EyeShape, Spring> } & Record<typeof PAIR_KEYS[number], Spring>;
const springsFor = (shape: ExpressionShape): SpringShape => ({
  left: Object.fromEntries(EYE_KEYS.map(key => [key, new Spring(shape.left[key])])) as Record<keyof EyeShape, Spring>,
  right: Object.fromEntries(EYE_KEYS.map(key => [key, new Spring(shape.right[key])])) as Record<keyof EyeShape, Spring>,
  roll: new Spring(shape.roll), lift: new Spring(shape.lift), gazeX: new Spring(shape.gazeX), gazeY: new Spring(shape.gazeY),
});

/**
 * Animates the eyes: the state's expression (or one that was asked for, for a few seconds) through springs; each
 * expression's entry action and tempo; blinks at irregular intervals (sometimes twice; slower when sleepy); the gaze in
 * saccades whose range and rhythm depend on the state (reading scans along a line; listening holds the user's gaze);
 * the user's voice makes them a little larger and brighter; answering gives them a light, irregular bounce.
 */
export class EyesAnimator {
  readonly params = new Float32Array(EYE_PARAMS * 2);
  private readonly springs: SpringShape = springsFor(EXPRESSIONS.neutral);
  private requested: { name: EyeExpression; until: number } | null = null;
  private clock = 0;
  private nextBlink = 1.6;
  private blinkAt = -10;
  private doubleBlink = false;
  private nextSaccade = 0.8;
  private gaze: [number, number] = [0, 0];
  private scan = 0;
  private dip = { at: -10 };
  private lastState: AionState = "idle";
  private worn: EyeExpression = "neutral";
  private wornSince = 0;
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
  /** Seconds the current expression has been worn. */
  get age() { return this.clock - this.wornSince; }

  /** The shape the springs are heading for now: the expression, its gradual phases, the voice and the answer. */
  private goal(name: EyeExpression, state: AionState, since: number, inputs: EyesInputs): ExpressionShape {
    const age = this.clock - this.wornSince;
    let goal = structuredClone(EXPRESSIONS[name]);
    // Falling asleep: heavy lids first, then soft closed curves.
    if (name === "sleepy") goal = blendShapes(goal, ASLEEP, smooth((age - SLEEPY.closing) / (SLEEPY.closed - SLEEPY.closing)));
    // Thinking narrows first and glances a moment later.
    const glanceAfter = ENTRY[name]?.glanceAfter ?? 0;
    if (age < glanceAfter) { goal.gazeX = 0; goal.gazeY = 0; }
    const listen = clamp(inputs.listen ?? 0, 0, 1), amplitude = clamp(inputs.amplitude ?? 0, 0, 1);
    for (const e of [goal.left, goal.right]) { e.size += listen * 0.05; e.glow += listen * 0.12; }
    if ((state === "responding" || state === "speaking") && !this.requested) {
      // Answering: a light bounce with the thought, each eye a little out of step, never a loop.
      const talk = irregular(since * 1.6, 0.7) * (0.7 + amplitude * 0.8), lilt = irregular(since * 1.3, 2.9);
      goal.lift += (talk - 0.5) * 0.03;
      goal.left.height *= 1 + (talk - 0.5) * 0.08; goal.right.height *= 1 + (lilt - 0.5) * 0.08;
      goal.left.cheek += talk * 0.08; goal.right.cheek += lilt * 0.08;
    }
    return goal;
  }

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
    // A long quiet idle grows sleepy; anything else wakes it. Completion is a brief bright moment, then calm.
    let name: EyeExpression = this.requested?.name ?? (safe === "idle" && since > 120 ? "sleepy" : STATE_EXPRESSION[safe]);
    if (!this.requested && safe === "complete" && since > 1.8) name = "neutral";
    if (name !== this.worn) this.enter(name);
    this.expression = name;
    const goal = this.goal(name, safe, since, inputs);
    this.updateGaze(step, safe, inputs.look ?? null, calm, goal);
    // The springs, in small steps so they stay stable however the frames arrive.
    const tempo = (TEMPO[name] ?? 1) * (calm ? 0.5 : 1);
    const sub = Math.max(1, Math.ceil(step / (1 / 240)));
    for (let k = 0; k < sub; k++) {
      const h = step / sub;
      for (const side of ["left", "right"] as const) {
        // The right eye trails the left by a hair: changes never land in perfect lockstep.
        const lag = side === "right" ? 0.92 : 1;
        for (const key of EYE_KEYS) { const [omega, zeta] = SPRINGS[key]; this.springs[side][key].step(goal[side][key], h, omega * tempo * lag, zeta); }
      }
      for (const key of PAIR_KEYS) {
        const [omega, zeta] = SPRINGS[key];
        // The gaze keeps its own quick pace: a saccade is fast even when the expression is slow.
        const target = key === "gazeX" ? goal.gazeX + this.gaze[0] : key === "gazeY" ? goal.gazeY + this.gaze[1] : goal[key];
        this.springs[key].step(target, h, omega * (key.startsWith("gaze") ? (calm ? 0.4 : 1) : tempo), zeta);
      }
    }
    // Blinks: every 2.5–6 s (sleepy: slower and longer), sometimes twice.
    if (this.clock >= this.nextBlink) {
      this.blinkAt = this.clock;
      this.doubleBlink = this.random() < 0.18;
      this.nextBlink = this.clock + (name === "sleepy" ? 4 + this.random() * 4 : 2.5 + this.random() * 3.5) * (calm ? 1.5 : 1);
    }
    const slow = name === "sleepy" ? 0.5 : 1;
    let blink = blinkAmount((this.clock - this.blinkAt) * slow);
    if (this.doubleBlink) { const second = blinkAmount((this.clock - this.blinkAt - 0.3) * slow); if (Math.abs(second) > Math.abs(blink)) blink = second; }
    const value = (side: "left" | "right") => Object.fromEntries(EYE_KEYS.map(key => [key, this.springs[side][key].value])) as unknown as EyeShape;
    const shape: ExpressionShape = {
      left: value("left"), right: value("right"),
      roll: this.springs.roll.value, lift: this.springs.lift.value, gazeX: this.springs.gazeX.value, gazeY: this.springs.gazeY.value,
    };
    const dip = this.clock - this.dip.at;
    const nod = dip >= 0 && dip < 0.7 ? -Math.sin(Math.PI * dip / 0.7) * 0.07 : 0;
    // Breathing: the pair rises and falls very slightly.
    const breath = Math.sin(this.clock * Math.PI * 2 * 0.22) * 0.006 * (calm ? 0.3 : 1);
    return packEyes(shape, this.params, nod + breath, blink);
  }

  /** A new expression begins: its entry action is an impulse to the springs. */
  private enter(name: EyeExpression) {
    this.worn = name;
    this.wornSince = this.clock;
    const entry = ENTRY[name];
    if (!entry) return;
    if (entry.lift) this.springs.lift.velocity += entry.lift;
    if (entry.roll) this.springs.roll.velocity += entry.roll;
    for (const side of ["left", "right"] as const) {
      if (entry.size) this.springs[side].size.velocity += entry.size;
      if (entry.height) this.springs[side].height.velocity += entry.height;
    }
  }

  /** Saccades: a new point to look at every so often, reached in a few hundredths of a second, then held. */
  private updateGaze(_step: number, state: AionState, look: [number, number] | null, calm: boolean, goal: ExpressionShape) {
    if (look) {
      // Toward something (a card): the expression's own gaze gives way to it.
      this.gaze = [clamp(look[0], -1, 1) - goal.gazeX, clamp(look[1], -1, 1) - goal.gazeY];
      this.nextSaccade = this.clock + 0.8;
      return;
    }
    if (this.clock < this.nextSaccade) return;
    const r = () => this.random() * 2 - 1;
    if (state === "reading") {
      // Reading: along a line in small steps, then back to the start of the next.
      this.scan = this.scan >= 3 ? 0 : this.scan + 1;
      this.gaze = [-0.6 + this.scan * 0.38, -0.42 + (this.scan === 0 ? -0.08 : 0)];
      this.nextSaccade = this.clock + 0.35 + this.random() * 0.25;
      return;
    }
    let range = 0.2, hold = [2, 4.5];
    if (state === "listening" || state === "testing") { range = 0.08; hold = [2.6, 5]; }
    else if (state === "thinking" || state === "working" || state === "building" || state === "editing") { range = 0.16; hold = [1.8, 3.8]; }
    // Most of the time the eyes return to the user; now and then they glance a little further, briefly.
    const glance = this.random() < 0.2;
    this.gaze = glance ? [r() * range * 2.4, r() * range * 1.2] : [r() * range, r() * range * 0.5];
    this.nextSaccade = this.clock + (glance ? 0.8 + this.random() * 0.7 : hold[0] + this.random() * (hold[1] - hold[0])) * (calm ? 1.6 : 1);
  }
}
