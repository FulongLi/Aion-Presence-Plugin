/**
 * Figure 2.0's Expressive Motion System: reusable keyframe clips with easing, and per-state tracks that schedule
 * them with real pauses in between.
 *
 * A pose is a flat set of channels (see pose.ts: `sway`, `nod`, `right.raise`, `footLeft.y`…). A clip moves some
 * of them through keys; each key says when it is reached and how the motion into it eases. Motion has intent:
 * anticipation (a small move the other way first), acceleration and deceleration (eased segments), follow-through
 * (an overshooting `back` ease, a settle), a clear beginning and end (every clip fades in and out of the pose it
 * starts from). Body channels are additive (a nod during a listening lean keeps the lean); arm channels are
 * absolute angles or IK reach targets, blended from the arm's current pose.
 *
 * Everything here is pure: the same clip at the same time gives the same pose, and a state's track is generated
 * from a fixed seed, so motion is varied without being random from frame to frame.
 */
import type { AionState } from "../state";

export type Ease = "linear" | "in" | "out" | "inOut" | "back" | "hold";
export type Channels = Record<string, number>;
export interface Key { at: number; v: Channels; ease?: Ease }
export interface Clip {
  name: string;
  duration: number;
  keys: readonly Key[];
  /** Seconds to blend in from, and back out to, the pose underneath. */
  fadeIn?: number;
  fadeOut?: number;
}

/** Arm channels are absolute (an angle, an IK weight or target); everything else is added to the pose underneath. */
export const isAbsolute = (channel: string) => channel.startsWith("left.") || channel.startsWith("right.");

export function ease(kind: Ease | undefined, x: number): number {
  const t = Math.max(0, Math.min(1, x));
  switch (kind) {
    case "linear": return t;
    case "in": return t * t * t;
    case "out": return 1 - Math.pow(1 - t, 3);
    case "back": { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
    case "hold": return t < 1 ? 0 : 1;
    default: return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** How much of a clip is in effect at `t`: eased in at its start, eased out at its end. */
export function clipWeight(clip: Clip, t: number): number {
  if (!(t >= 0) || t > clip.duration) return 0;
  const fadeIn = clip.fadeIn ?? 0.25, fadeOut = clip.fadeOut ?? 0.35;
  return smooth(fadeIn > 0 ? t / fadeIn : 1) * smooth(fadeOut > 0 ? (clip.duration - t) / fadeOut : 1);
}

/**
 * The clip's own channel values at `t`. Before a channel's first key it starts from the pose underneath (0 for an
 * additive channel, the base value for an absolute one); between keys it eases with the later key's curve.
 */
export function sampleClip(clip: Clip, t: number, base: Channels): Channels {
  const out: Channels = {};
  const channels = new Set<string>();
  for (const key of clip.keys) for (const name of Object.keys(key.v)) channels.add(name);
  for (const name of channels) {
    let previousAt = 0, previous = isAbsolute(name) ? base[name] ?? 0 : 0, value = previous;
    for (const key of clip.keys) {
      if (!(name in key.v)) continue;
      const target = key.v[name];
      if (t >= key.at) { previousAt = key.at; previous = target; value = target; continue; }
      const span = key.at - previousAt;
      value = previous + (target - previous) * ease(key.ease, span > 0 ? (t - previousAt) / span : 1);
      break;
    }
    out[name] = value;
  }
  return out;
}

/** Applies a clip at `t` (scaled by `gain`) on top of `pose` (flat channels), in place. */
export function applyClip(pose: Channels, clip: Clip, t: number, gain = 1) {
  const w = clipWeight(clip, t) * gain;
  if (w <= 0) return pose;
  const values = sampleClip(clip, t, pose);
  for (const [name, value] of Object.entries(values)) {
    pose[name] = isAbsolute(name) ? (pose[name] ?? 0) + (value - (pose[name] ?? 0)) * w : (pose[name] ?? 0) + value * w;
  }
  return pose;
}

// ── The clip library ─────────────────────────────────────────────────────────────────────────────────────
// Sides: the figure faces the viewer, so its "left" arm is on the viewer's right (+x). `raise` is the upper arm's
// angle out from hanging, `bend` the forearm's added angle (positive outward/up), `forward` toward the viewer.

type Side = "left" | "right";
const arm = (side: Side, raise: number, bend: number, forward = 0.04): Channels => ({ [`${side}.raise`]: raise, [`${side}.bend`]: bend, [`${side}.forward`]: forward });
const both = (raise: number, bend: number, forward = 0.04): Channels => ({ ...arm("left", raise, bend, forward), ...arm("right", raise, bend, forward) });
const other = (side: Side): Side => side === "left" ? "right" : "left";
/** The relaxed arm: hanging, a little out, elbow soft. */
export const REST_ARM = { raise: 0.16, bend: 0.1, forward: 0.02 };
const rest = (side: Side) => arm(side, REST_ARM.raise, REST_ARM.bend, REST_ARM.forward);
/** +1 for the figure's left (viewer's right), −1 for its right. */
const sign = (side: Side) => side === "left" ? 1 : -1;

/** A friendly wave: a small dip, the arm rises with a little overshoot, two and a half swings that settle, and down. */
export const WAVE = (side: Side = "right"): Clip => ({
  name: "wave", duration: 2.8, fadeIn: 0.15, fadeOut: 0.5,
  keys: [
    { at: 0.18, v: { ...arm(side, 0.1, 0.35), lean: 0.01, tilt: 0.02 * sign(side) }, ease: "inOut" },
    { at: 0.62, v: { ...arm(side, 0.95, 1.8, 0.06), tilt: 0.07 * sign(side), lean: 0.025 }, ease: "back" },
    { at: 0.92, v: arm(side, 0.95, 2.15, 0.06), ease: "inOut" },
    { at: 1.22, v: arm(side, 0.95, 1.62, 0.06), ease: "inOut" },
    { at: 1.52, v: arm(side, 0.95, 2.1, 0.06), ease: "inOut" },
    { at: 1.82, v: arm(side, 0.95, 1.72, 0.06), ease: "inOut" },
    { at: 2.08, v: { ...arm(side, 0.94, 1.92, 0.06), tilt: 0.07 * sign(side) }, ease: "inOut" },
    { at: 2.8, v: { ...rest(side), tilt: 0, lean: 0 }, ease: "inOut" },
  ],
});

/** One clear nod (head dips, comes up a touch past level, settles). */
export const NOD: Clip = {
  name: "nod", duration: 1.05, fadeIn: 0.1, fadeOut: 0.25,
  keys: [{ at: 0.28, v: { nod: 0.42 }, ease: "out" }, { at: 0.62, v: { nod: -0.06 }, ease: "inOut" }, { at: 1.05, v: { nod: 0 }, ease: "inOut" }],
};

/** Weight onto one leg: the pelvis slides over it, the other hip drops and its knee softens, the shoulders answer. */
export const WEIGHT_SHIFT = (side: Side, hold = 3.5): Clip => ({
  name: "weight-shift", duration: 1.3 + hold + 1.5, fadeIn: 0.3, fadeOut: 0.4,
  keys: [
    { at: 1.3, v: { sway: 0.03 * sign(side), hipTilt: 0.075 * sign(side), bend: -0.035 * sign(side), tilt: -0.04 * sign(side), crouch: 0.008 }, ease: "inOut" },
    { at: 1.3 + hold, v: { sway: 0.03 * sign(side), hipTilt: 0.07 * sign(side), bend: -0.03 * sign(side), tilt: -0.025 * sign(side), crouch: 0.008 }, ease: "linear" },
    { at: 2.8 + hold, v: { sway: 0, hipTilt: 0, bend: 0, tilt: 0, crouch: 0 }, ease: "inOut" },
  ],
});

/** Looking around: to one side, a held moment, across to the other, back to the front. */
export const LOOK_AROUND = (first: Side = "left"): Clip => ({
  name: "look-around", duration: 4.4, fadeIn: 0.2, fadeOut: 0.4,
  keys: [
    { at: 0.75, v: { turn: 0.85 * sign(first), tilt: 0.05 * sign(first), twist: 0.12 * sign(first), nod: -0.05 }, ease: "inOut" },
    { at: 1.6, v: { turn: 0.8 * sign(first), tilt: 0.045 * sign(first), twist: 0.11 * sign(first), nod: -0.04 }, ease: "linear" },
    { at: 2.55, v: { turn: -0.85 * sign(first), tilt: -0.05 * sign(first), twist: -0.12 * sign(first), nod: 0.02 }, ease: "inOut" },
    { at: 3.3, v: { turn: -0.8 * sign(first), tilt: -0.045 * sign(first), twist: -0.1 * sign(first), nod: 0.02 }, ease: "linear" },
    { at: 4.4, v: { turn: 0, tilt: 0, twist: 0, nod: 0 }, ease: "inOut" },
  ],
});

/** A small settling of the shoulders and hands, as people do when standing still. */
export const ADJUST: Clip = {
  name: "adjust", duration: 2.2, fadeIn: 0.2, fadeOut: 0.4,
  keys: [
    { at: 0.5, v: { lift: 0.022, ...both(0.2, 0.22, 0.05) }, ease: "inOut" },
    { at: 1.2, v: { lift: -0.006, ...both(0.14, 0.08, 0.02) }, ease: "inOut" },
    { at: 2.2, v: { lift: 0, ...both(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward) }, ease: "inOut" },
  ],
};

/** Listening: a head tilt toward the speaker, held, back. */
export const ATTENTIVE_TILT = (side: Side): Clip => ({
  name: "attentive-tilt", duration: 2.6, fadeIn: 0.2, fadeOut: 0.4,
  keys: [{ at: 0.6, v: { tilt: 0.1 * sign(side), lean: 0.015 }, ease: "inOut" }, { at: 1.9, v: { tilt: 0.09 * sign(side), lean: 0.015 }, ease: "linear" }, { at: 2.6, v: { tilt: 0, lean: 0 }, ease: "inOut" }],
});

/** Listening: one hand lifts a little, open (an "mm-hm"), and returns. */
export const ATTENTIVE_HAND = (side: Side): Clip => ({
  name: "attentive-hand", duration: 2.1, fadeIn: 0.15, fadeOut: 0.4,
  keys: [{ at: 0.55, v: { ...arm(side, 0.24, 0.85, 0.1), nod: 0.12 }, ease: "back" }, { at: 1.3, v: { ...arm(side, 0.23, 0.78, 0.09), nod: 0 }, ease: "inOut" }, { at: 2.1, v: rest(side), ease: "inOut" }],
});

/** Thinking: the gaze drifts up and aside while the hand at the chin stays (see the thinking pose). */
export const PONDER = (side: Side): Clip => ({
  name: "ponder", duration: 3.4, fadeIn: 0.3, fadeOut: 0.5,
  keys: [
    { at: 1.0, v: { turn: 0.55 * sign(side), nod: -0.22, tilt: 0.06 * sign(side) }, ease: "inOut" },
    { at: 2.3, v: { turn: 0.5 * sign(side), nod: -0.2, tilt: 0.07 * sign(side) }, ease: "linear" },
    { at: 3.4, v: { turn: 0, nod: 0, tilt: 0 }, ease: "inOut" },
  ],
});

/** Responding: an open hand offered forward and out, palm up, with the head turned a little with it. */
export const OFFER_HAND = (side: Side): Clip => ({
  name: "offer-hand", duration: 2.2, fadeIn: 0.15, fadeOut: 0.45,
  keys: [
    { at: 0.15, v: arm(side, 0.12, 0.3, 0.03), ease: "inOut" },
    { at: 0.62, v: { ...arm(side, 0.42, 1.12, 0.16), tilt: 0.05 * sign(side), lean: 0.02 }, ease: "back" },
    { at: 1.45, v: { ...arm(side, 0.4, 1.05, 0.15), tilt: 0.04 * sign(side), lean: 0.02 }, ease: "linear" },
    { at: 2.2, v: { ...rest(side), tilt: 0, lean: 0 }, ease: "inOut" },
  ],
});

/** Responding: both forearms come up and part, as when laying out an idea, with one small beat. */
export const EXPLAIN_BOTH: Clip = {
  name: "explain-both", duration: 2.6, fadeIn: 0.2, fadeOut: 0.5,
  keys: [
    { at: 0.55, v: { ...both(0.3, 1.0, 0.14), lean: 0.025 }, ease: "out" },
    { at: 1.0, v: { ...both(0.42, 0.88, 0.15), nod: 0.1 }, ease: "inOut" },
    { at: 1.4, v: { ...both(0.36, 1.05, 0.15), nod: 0 }, ease: "inOut" },
    { at: 1.9, v: { ...both(0.44, 0.9, 0.15), lean: 0.02 }, ease: "inOut" },
    { at: 2.6, v: { ...both(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward), lean: 0 }, ease: "inOut" },
  ],
};

/** Responding: one hand at chest height marks two beats of a phrase, the head nodding with the second. */
export const BEAT = (side: Side): Clip => ({
  name: "beat", duration: 2.3, fadeIn: 0.15, fadeOut: 0.45,
  keys: [
    { at: 0.45, v: arm(side, 0.22, 1.3, 0.12), ease: "out" },
    { at: 0.75, v: { ...arm(side, 0.24, 1.0, 0.13), nod: 0.08 }, ease: "in" },
    { at: 1.05, v: { ...arm(side, 0.22, 1.28, 0.12), nod: 0 }, ease: "out" },
    { at: 1.35, v: { ...arm(side, 0.24, 0.96, 0.13), nod: 0.14 }, ease: "in" },
    { at: 1.65, v: { ...arm(side, 0.22, 1.15, 0.12), nod: 0 }, ease: "out" },
    { at: 2.3, v: rest(side), ease: "inOut" },
  ],
});

/** Responding: a forearm raised beside the shoulder, as when making a point, then down. */
export const MAKE_POINT = (side: Side): Clip => ({
  name: "make-point", duration: 2.0, fadeIn: 0.15, fadeOut: 0.4,
  keys: [
    { at: 0.12, v: arm(side, 0.12, 0.2), ease: "inOut" },
    { at: 0.5, v: { ...arm(side, 0.3, 2.25, 0.1), nod: 0.1, tilt: -0.03 * sign(side) }, ease: "back" },
    { at: 1.25, v: { ...arm(side, 0.3, 2.2, 0.1), nod: 0.04 }, ease: "linear" },
    { at: 2.0, v: { ...rest(side), nod: 0, tilt: 0 }, ease: "inOut" },
  ],
});

/** A light shrug: shoulders up, forearms out, palms up, head tilted. */
export const SHRUG: Clip = {
  name: "shrug", duration: 1.9, fadeIn: 0.1, fadeOut: 0.45,
  keys: [
    { at: 0.4, v: { lift: 0.045, tilt: 0.09, ...both(0.28, 1.25, 0.12) }, ease: "back" },
    { at: 1.0, v: { lift: 0.04, tilt: 0.08, ...both(0.27, 1.2, 0.12) }, ease: "linear" },
    { at: 1.9, v: { lift: 0, tilt: 0, ...both(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward) }, ease: "inOut" },
  ],
};

/** Surprise: a quick start back — arms fly up and out, head back, a small hop — then a slow settle. */
export const SURPRISE: Clip = {
  name: "surprise", duration: 2.4, fadeIn: 0.05, fadeOut: 0.6,
  keys: [
    { at: 0.08, v: { crouch: 0.025, nod: 0.08 }, ease: "out" },
    { at: 0.3, v: { crouch: -0.01, jump: 0.035, nod: -0.32, lean: -0.05, lift: 0.04, ...both(0.95, 0.85, 0.08) }, ease: "out" },
    { at: 0.62, v: { crouch: 0.02, jump: 0, nod: -0.25, lean: -0.04, lift: 0.03, ...both(0.88, 0.95, 0.08) }, ease: "back" },
    { at: 1.4, v: { crouch: 0.005, nod: -0.12, lean: -0.02, lift: 0.015, ...both(0.5, 0.7, 0.05) }, ease: "inOut" },
    { at: 2.4, v: { crouch: 0, nod: 0, lean: 0, lift: 0, ...both(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward) }, ease: "inOut" },
  ],
};

/** A small, joyful jump: crouch (anticipation), launch with arms up, tuck, land soft, settle. */
export const JUMP: Clip = {
  name: "jump", duration: 2.1, fadeIn: 0.1, fadeOut: 0.45,
  keys: [
    { at: 0.38, v: { crouch: 0.075, lean: 0.03, nod: 0.12, ...both(0.3, 0.2, 0.02) }, ease: "inOut" },
    { at: 0.62, v: { crouch: -0.01, jump: 0.15, lean: 0, nod: -0.12, ...both(2.5, 0.25, 0.04), "footLeft.y": 0.05, "footRight.y": 0.05 }, ease: "out" },
    { at: 0.78, v: { jump: 0.17, "footLeft.y": 0.07, "footRight.y": 0.07 }, ease: "out" },
    { at: 1.0, v: { crouch: 0.0, jump: 0, "footLeft.y": 0, "footRight.y": 0, ...both(1.6, 0.4, 0.04) }, ease: "in" },
    { at: 1.18, v: { crouch: 0.07, nod: 0.1, ...both(0.7, 0.5, 0.04) }, ease: "out" },
    { at: 2.1, v: { crouch: 0, nod: 0, lean: 0, ...both(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward) }, ease: "inOut" },
  ],
};

/** A step out to one side and back: weight over the other foot, lift, place, shift across, return. */
export const STEP = (side: Side = "left"): Clip => {
  const s = sign(side), foot = side === "left" ? "footLeft" : "footRight";
  return {
    name: "step", duration: 3.0, fadeIn: 0.15, fadeOut: 0.3,
    keys: [
      { at: 0.4, v: { sway: -0.03 * s, hipTilt: -0.05 * s }, ease: "inOut" },
      { at: 0.72, v: { [`${foot}.x`]: 0.06 * s, [`${foot}.y`]: 0.07, crouch: 0.015 }, ease: "out" },
      { at: 0.98, v: { [`${foot}.x`]: 0.13 * s, [`${foot}.y`]: 0, sway: 0.02 * s, hipTilt: 0, crouch: 0.02 }, ease: "in" },
      { at: 1.6, v: { sway: 0.06 * s, crouch: 0.01 }, ease: "inOut" },
      { at: 2.1, v: { [`${foot}.x`]: 0.07 * s, [`${foot}.y`]: 0.07, sway: -0.01 * s }, ease: "out" },
      { at: 2.4, v: { [`${foot}.x`]: 0, [`${foot}.y`]: 0, sway: 0, crouch: 0 }, ease: "in" },
    ],
  };
};

/** A turn toward one side: the torso twists, the feet pivot, the head leads, then back to the front. */
export const TURN = (side: Side = "left"): Clip => {
  const s = sign(side);
  return {
    name: "turn", duration: 3.0, fadeIn: 0.2, fadeOut: 0.4,
    keys: [
      { at: 0.35, v: { turn: 0.7 * s, tilt: 0.04 * s }, ease: "inOut" },
      { at: 0.95, v: { twist: 0.6 * s, turn: 0.8 * s, "footLeft.z": 0.05 * s, "footRight.z": -0.05 * s, "footLeft.x": -0.02, "footRight.x": 0.02, sway: 0.01 * s }, ease: "inOut" },
      { at: 1.9, v: { twist: 0.58 * s, turn: 0.75 * s }, ease: "linear" },
      { at: 3.0, v: { twist: 0, turn: 0, tilt: 0, "footLeft.z": 0, "footRight.z": 0, "footLeft.x": 0, "footRight.x": 0, sway: 0 }, ease: "inOut" },
    ],
  };
};

/**
 * Pointing at something: look toward it, the arm draws back a little and extends to it (two-bone IK; the arm stays
 * straight toward a target it cannot reach), holds, and returns. `target` is in normalized figure space.
 */
export const POINT = (target: [number, number, number], hold = 1.6): Clip => {
  const side: Side = target[0] >= 0 ? "left" : "right", s = sign(side);
  const reach = { [`${side}.reachX`]: target[0], [`${side}.reachY`]: target[1], [`${side}.reachZ`]: target[2] };
  return {
    name: "point", duration: 1.4 + hold + 0.9, fadeIn: 0.15, fadeOut: 0.45,
    keys: [
      { at: 0.55, v: { turn: 0.75 * s, tilt: 0.05 * s, twist: 0.12 * s, lean: 0.015 }, ease: "inOut" },
      { at: 0.85, v: { ...arm(side, 0.25, 0.8, 0.06), ...reach, [`${side}.reach`]: 0 }, ease: "inOut" },
      { at: 1.25, v: { [`${side}.reach`]: 1 }, ease: "back" },
      { at: 1.25 + hold, v: { [`${side}.reach`]: 1, turn: 0.7 * s }, ease: "linear" },
      { at: 2.3 + hold, v: { [`${side}.reach`]: 0, ...rest(side), turn: 0, tilt: 0, twist: 0, lean: 0 }, ease: "inOut" },
    ],
  };
};

/**
 * Explaining what is shown beside the figure (Demo C): it looks at the information, tilts its head as it considers
 * it, points at the term in question (with a small double emphasis), turns back to the viewer and explains with
 * both hands, then relaxes. `target` is the term's position in normalized figure space.
 */
export const EXPLAIN = (target: [number, number, number]): Clip => {
  const side: Side = target[0] >= 0 ? "left" : "right", s = sign(side), o = other(side);
  const at = (dx = 0, dy = 0) => ({ [`${side}.reachX`]: target[0] + dx, [`${side}.reachY`]: target[1] + dy, [`${side}.reachZ`]: target[2] });
  return {
    name: "explain", duration: 7.2, fadeIn: 0.25, fadeOut: 0.6,
    keys: [
      // Look at it.
      { at: 0.8, v: { turn: 0.85 * s, tilt: 0.05 * s, twist: 0.14 * s, lean: 0.02 }, ease: "inOut" },
      // Consider it: the head tilts, a slight nod.
      { at: 1.6, v: { tilt: 0.16 * s, nod: 0.1, turn: 0.8 * s }, ease: "inOut" },
      // Anticipation: the pointing arm gathers.
      { at: 2.0, v: { ...arm(side, 0.22, 0.95, 0.08), ...at(), [`${side}.reach`]: 0, tilt: 0.08 * s, nod: 0 }, ease: "inOut" },
      // Point.
      { at: 2.45, v: { [`${side}.reach`]: 1, lean: 0.035 }, ease: "back" },
      // Emphasis: two small taps toward the term.
      { at: 2.85, v: at(-0.04 * s, 0.01), ease: "inOut" },
      { at: 3.1, v: at(), ease: "out" },
      { at: 3.35, v: at(-0.04 * s, 0.01), ease: "inOut" },
      { at: 3.6, v: at(), ease: "out" },
      { at: 4.1, v: { [`${side}.reach`]: 1, turn: 0.7 * s }, ease: "linear" },
      // Back to the viewer: both hands open, explaining.
      { at: 4.7, v: { [`${side}.reach`]: 0, ...both(0.34, 1.0, 0.14), turn: 0, tilt: -0.03 * s, twist: 0, lean: 0.025 }, ease: "inOut" },
      { at: 5.15, v: { ...both(0.44, 0.88, 0.15), nod: 0.1 }, ease: "inOut" },
      { at: 5.6, v: { ...both(0.36, 1.04, 0.15), nod: 0 }, ease: "inOut" },
      // Relax.
      { at: 6.6, v: { ...rest(side), ...rest(o), tilt: 0, lean: 0, nod: 0 }, ease: "inOut" },
    ],
  };
};

/** Drowsy: the head sinks slowly, the shoulders drop, then it lifts with a start and settles. */
export const DROWSY: Clip = {
  name: "drowsy", duration: 3.6, fadeIn: 0.3, fadeOut: 0.5,
  keys: [
    { at: 1.8, v: { nod: 0.42, lift: -0.025, lean: 0.02, tilt: 0.06, crouch: 0.01 }, ease: "in" },
    { at: 2.15, v: { nod: -0.08, lift: 0.01, lean: -0.01, tilt: 0, crouch: 0 }, ease: "out" },
    { at: 3.6, v: { nod: 0, lift: 0, lean: 0 }, ease: "inOut" },
  ],
};

/** A brief bright moment: a small bounce on the toes with the hands opening (complete, happy). */
export const PLEASED: Clip = {
  name: "pleased", duration: 1.7, fadeIn: 0.1, fadeOut: 0.5,
  keys: [
    { at: 0.25, v: { crouch: 0.025, nod: 0.18 }, ease: "out" },
    { at: 0.55, v: { crouch: -0.012, jump: 0.02, nod: -0.06, tilt: 0.05, ...both(0.32, 0.55, 0.06) }, ease: "out" },
    { at: 0.85, v: { crouch: 0.008, jump: 0, nod: 0 }, ease: "in" },
    { at: 1.7, v: { crouch: 0, tilt: 0, ...both(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward) }, ease: "inOut" },
  ],
};

/** Concern (an error): shoulders drop, the head lowers and tilts, a small breath out. */
export const CONCERN: Clip = {
  name: "concern", duration: 2.4, fadeIn: 0.25, fadeOut: 0.6,
  keys: [
    { at: 0.6, v: { nod: 0.22, tilt: -0.07, lift: -0.02, lean: 0.01 }, ease: "inOut" },
    { at: 1.7, v: { nod: 0.2, tilt: -0.08, lift: -0.018 }, ease: "linear" },
    { at: 2.4, v: { nod: 0, tilt: 0, lift: 0, lean: 0 }, ease: "inOut" },
  ],
};

// ── Tracks: when each state's clips happen ───────────────────────────────────────────────────────────────

export interface TrackEvent { at: number; clip: Clip }

const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const hashName = (name: string) => { let h = 2166136261; for (const char of name) h = Math.imul(h ^ char.charCodeAt(0), 16777619); return h >>> 0; };

/**
 * The scheduled clips for a state, generated deterministically up to `horizon` seconds after it began: actions with
 * pauses between them (never back to back, never the same one twice in a row). States without a track only hold
 * their pose (and their signature clip, see SIGNATURE).
 */
export function stateTrack(state: AionState, horizon = 240): TrackEvent[] {
  const next = seeded(hashName(state));
  const pick = <T,>(items: readonly T[], last: T | null) => {
    const choices = items.length > 1 ? items.filter(item => item !== last) : items;
    return choices[Math.floor(next() * choices.length)];
  };
  const events: TrackEvent[] = [];
  const schedule = (first: number, gap: [number, number], make: () => Clip) => {
    for (let at = first; at < horizon;) {
      const clip = make();
      events.push({ at, clip });
      at += clip.duration + gap[0] + next() * (gap[1] - gap[0]);
    }
  };
  let last: string | null = null;
  const side = (): Side => next() < 0.5 ? "left" : "right";
  switch (state) {
    case "idle": case "complete": {
      const kinds = ["shift", "look", "shift", "adjust"] as const;
      schedule(state === "idle" ? 2.5 : 4, [2.5, 6], () => {
        const kind = pick(kinds, last as typeof kinds[number] | null); last = kind;
        return kind === "shift" ? WEIGHT_SHIFT(side(), 3 + next() * 3) : kind === "look" ? LOOK_AROUND(side()) : ADJUST;
      });
      break;
    }
    case "listening":
      schedule(1.2, [1.2, 3.2], () => {
        const kind = pick(["nod", "tilt", "nod", "hand"] as const, last as "nod" | "tilt" | "hand" | null); last = kind;
        return kind === "nod" ? NOD : kind === "tilt" ? ATTENTIVE_TILT(side()) : ATTENTIVE_HAND(side());
      });
      break;
    case "thinking":
      schedule(1.4, [1.5, 3.5], () => {
        const kind = pick(["ponder", "shift"] as const, last as "ponder" | "shift" | null); last = kind;
        return kind === "ponder" ? PONDER(side()) : WEIGHT_SHIFT(side(), 2 + next() * 2);
      });
      break;
    case "responding": case "speaking": {
      // Varied, alternating hands, with pauses that let the figure rest between thoughts.
      let hand: Side = "right";
      schedule(0.6, [0.5, 1.9], () => {
        const kind = pick(["offer", "both", "beat", "point", "offer", "beat"] as const, last as string | null); last = kind;
        hand = next() < 0.7 ? other(hand) : hand;
        return kind === "offer" ? OFFER_HAND(hand) : kind === "both" ? EXPLAIN_BOTH : kind === "beat" ? BEAT(hand) : MAKE_POINT(hand);
      });
      break;
    }
    case "reading": case "working": case "editing": case "testing": case "building":
      schedule(5, [6, 12], () => WEIGHT_SHIFT(side(), 3 + next() * 3));
      break;
    default:
      break;
  }
  return events;
}

/** One-shot clips some states open with: the greeting's wave, the nods of acknowledgement and completion. */
export const SIGNATURE: Partial<Record<AionState, Clip>> = {
  greeting: WAVE("right"), acknowledging: NOD, complete: PLEASED, error: CONCERN,
};

const trackCache = new Map<AionState, TrackEvent[]>();
/** Applies a state's signature and scheduled clips at `t` seconds into the state (pure). */
export function applyStateMotion(pose: Channels, state: AionState, t: number, gain = 1) {
  const signature = SIGNATURE[state];
  if (signature) applyClip(pose, signature, t, gain);
  let track = trackCache.get(state);
  if (!track) { track = stateTrack(state); trackCache.set(state, track); }
  for (const event of track) {
    if (event.at > t) break;
    if (t - event.at <= event.clip.duration) applyClip(pose, event.clip, t - event.at, gain);
  }
  return pose;
}

/** Gestures a user (or Codex) can ask the figure for by name. */
export const FIGURE_GESTURES = ["wave", "nod", "point", "shrug", "surprise", "jump", "step", "turn", "look-around", "think"] as const;
export type FigureGesture = typeof FIGURE_GESTURES[number];

/** The clip for a named gesture. `target` (normalized figure space) is where `point` points. */
export function gestureClip(name: FigureGesture, target: [number, number, number] = [0.9, 0.35, 0.4]): Clip {
  switch (name) {
    case "wave": return WAVE("right");
    case "nod": return NOD;
    case "point": return POINT(target);
    case "shrug": return SHRUG;
    case "surprise": return SURPRISE;
    case "jump": return JUMP;
    case "step": return STEP("left");
    case "turn": return TURN("left");
    case "look-around": return LOOK_AROUND("left");
    case "think": return PONDER("left");
  }
}
