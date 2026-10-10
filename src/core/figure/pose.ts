import { sanitizeState, type AionState } from "../state";
import { applyClip, applyStateMotion, clipWeight, REST_ARM, type Channels, type Clip } from "./motion";
import { ANCHOR, ANCHOR_COUNT, FIGURE_SCALE, PROPORTIONS as P } from "./skeleton";

/**
 * Body language (Figure 2.0): a pose is a set of joint parameters solved into anchor positions with forward
 * kinematics for the trunk and head and two-bone inverse kinematics for the limbs (limb lengths never change; feet
 * stay planted unless a clip steps or jumps). Each state has a held pose; the Expressive Motion System (motion.ts)
 * adds its scheduled clips, and one-shot cues (a wave, pointing at a card, a jump) play on top.
 */
export interface ArmPose {
  /** Upper arm angle from hanging straight down, outward positive (radians). */
  raise: number;
  /** Elbow bend, added to `raise` for the forearm (radians; negative folds the forearm across the body). */
  bend: number;
  /** How far the hand comes toward the viewer (normalized units). */
  forward: number;
  /** Weight (0…1) of reaching for (reachX, reachY, reachZ) with IK instead of the angles above. */
  reach: number;
  reachX: number;
  reachY: number;
  reachZ: number;
  /** Weight (0…1) of the hand going to the chin (thinking). */
  chin: number;
}

export interface FootOffset { x: number; y: number; z: number }

export interface PoseParams {
  /** Pelvis sideways shift: weight moving between the feet. */
  sway: number;
  /** Pelvis lowered by this much (knees bend); negative rises onto the toes. */
  crouch: number;
  /** Torso toward the viewer (normalized units at the neck). */
  lean: number;
  /** Torso side bend (radians, positive toward the figure's left). */
  bend: number;
  /** Torso turn about the vertical (radians): the shoulders and hips rotate in depth. */
  twist: number;
  /** Pelvis roll (radians, positive raises the left hip): the relaxed leg's knee softens. */
  hipTilt: number;
  /** Head roll (radians, positive toward the figure's left). */
  tilt: number;
  /** Head dip, 0…1 (a nod is a brief dip; negative looks up). */
  nod: number;
  /** Head turn (radians, positive toward the figure's left): the head leads toward what it looks at. */
  turn: number;
  /** Shoulder lift (breathing, a shrug). */
  lift: number;
  /** The whole figure rises (a jump or a hop). */
  jump: number;
  left: ArmPose;
  right: ArmPose;
  footLeft: FootOffset;
  footRight: FootOffset;
}

export const arm = (raise: number, bend: number, forward: number, extra: Partial<ArmPose> = {}): ArmPose =>
  ({ raise, bend, forward, reach: 0, reachX: 0, reachY: 0, reachZ: 0, chin: 0, ...extra });
const REST = arm(REST_ARM.raise, REST_ARM.bend, REST_ARM.forward);
const FOOT: FootOffset = { x: 0, y: 0, z: 0 };
export const NEUTRAL_POSE: PoseParams = {
  sway: 0, crouch: 0, lean: 0, bend: 0, twist: 0, hipTilt: 0, tilt: 0, nod: 0, turn: 0, lift: 0, jump: 0,
  left: REST, right: REST, footLeft: FOOT, footRight: FOOT,
};

const SCALARS = ["sway", "crouch", "lean", "bend", "twist", "hipTilt", "tilt", "nod", "turn", "lift", "jump"] as const;
const ARM_KEYS = ["raise", "bend", "forward", "reach", "reachX", "reachY", "reachZ", "chin"] as const;
const FOOT_KEYS = ["x", "y", "z"] as const;

/** A pose as flat channels ("nod", "right.raise", "footLeft.y"), the form clips work in. */
export function flattenPose(pose: PoseParams, out: Channels = {}): Channels {
  for (const key of SCALARS) out[key] = pose[key];
  for (const side of ["left", "right"] as const) for (const key of ARM_KEYS) out[`${side}.${key}`] = pose[side][key];
  for (const foot of ["footLeft", "footRight"] as const) for (const key of FOOT_KEYS) out[`${foot}.${key}`] = pose[foot][key];
  return out;
}

const finiteOr = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value as number : fallback;
export function unflattenPose(channels: Channels): PoseParams {
  const pose = { ...NEUTRAL_POSE, left: { ...REST }, right: { ...REST }, footLeft: { ...FOOT }, footRight: { ...FOOT } };
  for (const key of SCALARS) pose[key] = finiteOr(channels[key], 0);
  for (const side of ["left", "right"] as const) for (const key of ARM_KEYS) pose[side][key] = finiteOr(channels[`${side}.${key}`], REST[key]);
  for (const foot of ["footLeft", "footRight"] as const) for (const key of FOOT_KEYS) pose[foot][key] = finiteOr(channels[`${foot}.${key}`], 0);
  return pose;
}

/**
 * Held poses per state. The scheduled clips (motion.ts) move on top of them; these are where the figure rests in
 * each state. Work states differ by posture and hand position: attending to something, never miming a task.
 */
const STATE_POSES: Record<AionState, PoseParams> = {
  idle: NEUTRAL_POSE,
  // Turned toward the user: a lean and head tilt, hands drawn in a little. Loudness adds lean and nods (statePose).
  listening: { ...NEUTRAL_POSE, lean: 0.05, tilt: 0.08, nod: 0.06, left: arm(0.12, 0.3, 0.06), right: arm(0.12, 0.3, 0.06) },
  // The thinker: one hand at the chin, the other arm folded across the waist, head tilted, weight back a little.
  thinking: {
    ...NEUTRAL_POSE, lean: -0.01, tilt: 0.09, nod: 0.12, sway: -0.012, hipTilt: -0.03,
    right: arm(0.3, 1.6, 0.1, { chin: 1 }), left: arm(0.08, -1.3, 0.12),
  },
  // Head lowered toward the hands, which come together a little, forward: attention on something held.
  reading: { ...NEUTRAL_POSE, lean: 0.03, tilt: -0.05, nod: 0.3, left: arm(0.06, 0.95, 0.14), right: arm(0.06, 0.95, 0.14) },
  working: { ...NEUTRAL_POSE, lean: 0.03, tilt: -0.02, nod: 0.18, left: arm(0.14, 0.55, 0.09), right: arm(0.14, 0.55, 0.09) },
  // One hand raised and forward, as if shaping something; the other at rest.
  editing: { ...NEUTRAL_POSE, lean: 0.04, tilt: -0.05, nod: 0.24, left: arm(0.12, 0.4, 0.06), right: arm(0.2, 1.1, 0.12) },
  // Upright and still: waiting for an outcome.
  testing: { ...NEUTRAL_POSE, lean: 0.01, nod: 0.1, left: arm(0.08, 0.2, 0.03), right: arm(0.08, 0.2, 0.03) },
  // Both hands out and up: gathering.
  building: { ...NEUTRAL_POSE, lean: 0.03, nod: 0.14, left: arm(0.3, 0.75, 0.1), right: arm(0.3, 0.75, 0.1) },
  speaking: { ...NEUTRAL_POSE, lean: 0.03, left: arm(0.16, 0.3, 0.05), right: arm(0.16, 0.3, 0.05) },
  // Answering: turned a little toward the user, hands a touch forward; the gestures are the responding track's.
  responding: { ...NEUTRAL_POSE, lean: 0.035, tilt: 0.02, left: arm(0.15, 0.3, 0.05), right: arm(0.16, 0.36, 0.06) },
  // The wave itself is the greeting's signature clip.
  greeting: { ...NEUTRAL_POSE, lean: 0.015 },
  acknowledging: { ...NEUTRAL_POSE, lean: 0.03 },
  // A card has just appeared beside the body (on the viewer's right, the figure's left): an open hand toward it.
  offering: { ...NEUTRAL_POSE, lean: 0.025, tilt: 0.06, turn: 0.6, twist: 0.1, left: arm(0.62, 0.3, 0.1), right: REST },
  // An open arm toward the information forming beside/through the body.
  presenting: { ...NEUTRAL_POSE, lean: 0.02, tilt: 0.05, turn: 0.5, left: arm(0.75, 0.25, 0.12), right: arm(0.2, 0.18, 0.04) },
  // Settled and a little open (after the pleased bounce).
  complete: { ...NEUTRAL_POSE, lean: -0.01, tilt: 0.03, left: arm(0.22, 0.14, 0.03), right: arm(0.22, 0.14, 0.03) },
  // Head down a little, arms drawn in: quiet, not dramatic.
  error: { ...NEUTRAL_POSE, tilt: -0.03, nod: 0.24, lift: -0.01, left: arm(0.08, 0.15, 0.02), right: arm(0.08, 0.15, 0.02) },
};

/**
 * The held pose for a state with its continuous inputs: `amplitude` (real host speech, 0…1) lifts the hands a
 * little; `listen` (the user's loudness while Aion listens, 0…1) leans the figure in and dips the head.
 */
export function statePose(state: AionState, amplitude = 0, listen = 0): PoseParams {
  const pose = STATE_POSES[sanitizeState(state)];
  if (state === "listening") {
    const a = Math.max(0, Math.min(1, finiteOr(listen, 0)));
    return { ...pose, lean: pose.lean + a * 0.04, nod: pose.nod + a * 0.12, tilt: pose.tilt + a * 0.03 };
  }
  if (state === "speaking") {
    const a = Math.max(0, Math.min(1, finiteOr(amplitude, 0)));
    const lifted = (side: ArmPose) => ({ ...side, raise: side.raise + a * 0.06, bend: side.bend + a * 0.3, forward: side.forward + a * 0.03 });
    return { ...pose, lift: a * 0.012, left: lifted(pose.left), right: lifted(pose.right) };
  }
  return pose;
}

/**
 * The target pose for a state `t` seconds after it began: its held pose, its signature clip (the greeting's wave,
 * the nod of acknowledgement…) and its scheduled clips (motion.ts). Pure and deterministic.
 */
export function gestureTarget(state: AionState, t: number, amplitude = 0, listen = 0): PoseParams {
  const safe = sanitizeState(state);
  const channels = flattenPose(statePose(safe, amplitude, listen));
  applyStateMotion(channels, safe, Number.isFinite(t) ? Math.max(0, t) : 0);
  return unflattenPose(channels);
}

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec, fallback: Vec = [0, -1, 0]): Vec => { const n = norm(a); return n > 1e-6 ? scale(a, 1 / n) : fallback; };
const lerp3 = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Two-bone IK: the middle joint and end for a limb from `root` with lengths `l1`, `l2` reaching for `target`, bending
 * toward `pole`. A target out of reach is pointed at with a straight limb.
 */
export function twoBone(root: Vec, target: Vec, l1: number, l2: number, pole: Vec): [Vec, Vec] {
  const toward = sub(target, root);
  const dir = unit(toward);
  const distance = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min(l1 + l2 - 1e-4, norm(toward)));
  const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const bendDir = unit(sub(pole, scale(dir, dot(pole, dir))), unit([dir[1], -dir[0], 0], [1, 0, 0]));
  return [add(add(root, scale(dir, along)), scale(bendDir, height)), add(root, scale(dir, distance))];
}

/**
 * Pose parameters → normalized anchor positions (x, y, z per anchor, in ANCHORS order). Pure: the same parameters
 * always give the same skeleton, and limb lengths are preserved.
 */
export function solvePose(pose: PoseParams, out = new Float32Array(ANCHOR_COUNT * 3)): Float32Array {
  const set = (index: number, v: Vec) => { out[index * 3] = v[0]; out[index * 3 + 1] = v[1]; out[index * 3 + 2] = v[2]; };
  const f = (value: number) => finiteOr(value, 0);
  const pelvis: Vec = [f(pose.sway), P.pelvisY - f(pose.crouch) + f(pose.jump), 0];
  const hipTilt = f(pose.hipTilt), twist = f(pose.twist), bend = f(pose.bend);
  // The torso rises from the pelvis, a touch opposite the weight shift, bending to the side and toward the viewer.
  const neck: Vec = [pelvis[0] - f(pose.sway) * 0.5 + Math.sin(bend) * P.torso, pelvis[1] + Math.cos(bend) * P.torso + f(pose.lift) * 0.5, f(pose.lean)];
  set(ANCHOR.spine, pelvis);
  set(ANCHOR.neck, neck);
  // Head: rolls about the neck with the torso, turns (leads) toward what it looks at, dips forward in a nod.
  const tilt = f(pose.tilt) + bend * 0.5, nod = f(pose.nod), turn = Math.max(-1.2, Math.min(1.2, f(pose.turn)));
  const headLength = P.neck - nod * 0.02;
  const head: Vec = [neck[0] + Math.sin(tilt) * headLength + Math.sin(turn) * 0.035, neck[1] + Math.cos(tilt) * headLength - Math.abs(Math.sin(turn)) * 0.006, neck[2] + nod * 0.05 + f(pose.lean) * 0.3];
  set(ANCHOR.head, head);
  // The shoulder line answers the hips (contrapposto) and turns with the torso.
  const shoulderRoll = -hipTilt * 0.6 + bend * 0.2;
  for (const [side, sign] of [["Left", 1], ["Right", -1]] as const) {
    const armPose = side === "Left" ? pose.left : pose.right;
    const shoulder: Vec = [
      neck[0] + sign * P.shoulderWidth * Math.cos(twist),
      neck[1] - P.shoulderDrop + f(pose.lift) + sign * P.shoulderWidth * Math.sin(shoulderRoll),
      neck[2] * 0.8 - sign * P.shoulderWidth * Math.sin(twist),
    ];
    // Forward kinematics from the angles.
    const raise = f(armPose.raise), fore = raise + f(armPose.bend), forward = f(armPose.forward);
    const elbowFK: Vec = [shoulder[0] + sign * Math.sin(raise) * P.upperArm, shoulder[1] - Math.cos(raise) * P.upperArm, shoulder[2] + forward * 0.4];
    const handFK: Vec = [elbowFK[0] + sign * Math.sin(fore) * P.forearm, elbowFK[1] - Math.cos(fore) * P.forearm, shoulder[2] + forward];
    // Inverse kinematics toward a reach target or the chin, blended by weight; lengths are restored after blending.
    const reach = Math.max(0, Math.min(1, f(armPose.reach))), chin = Math.max(0, Math.min(1, f(armPose.chin)));
    let elbow = elbowFK, hand = handFK;
    const weight = Math.max(reach, chin);
    if (weight > 0) {
      const target: Vec = reach >= chin ? [f(armPose.reachX), f(armPose.reachY), f(armPose.reachZ)]
        : [head[0] - sign * 0.02, head[1] - P.headRadius - 0.025, head[2] + 0.07];
      const pole: Vec = chin > reach ? [sign * 0.9, -0.6, 0.3] : [sign * 0.35, -1, 0.25];
      const [elbowIK, handIK] = twoBone(shoulder, target, P.upperArm, P.forearm, pole);
      elbow = add(shoulder, scale(unit(sub(lerp3(elbowFK, elbowIK, weight), shoulder)), P.upperArm));
      hand = add(elbow, scale(unit(sub(lerp3(handFK, handIK, weight), elbow)), P.forearm));
    } else {
      elbow = add(shoulder, scale(unit(sub(elbowFK, shoulder)), P.upperArm));
      hand = add(elbow, scale(unit(sub(handFK, elbow)), P.forearm));
    }
    set(ANCHOR[`shoulder${side}`], shoulder);
    set(ANCHOR[`elbow${side}`], elbow);
    set(ANCHOR[`hand${side}`], hand);
    // Legs: IK from the hip to the (planted, or stepping) foot; knees bend forward and a little outward, so a crouch
    // reads from the front. A foot the leg cannot reach (a jump) hangs straight below the hip toward it.
    const hip: Vec = [
      pelvis[0] + sign * P.hipWidth * Math.cos(hipTilt) * Math.cos(twist * 0.5),
      pelvis[1] - P.hipDrop + sign * P.hipWidth * Math.sin(hipTilt),
      sign * -P.hipWidth * Math.sin(twist * 0.5),
    ];
    const offset = side === "Left" ? pose.footLeft : pose.footRight;
    const foot: Vec = [sign * P.footX + f(offset.x), P.footY + f(pose.jump) + f(offset.y), f(offset.z)];
    const [knee, ankle] = twoBone(hip, foot, P.thigh, P.shin, [sign * 0.3, 0, 1]);
    set(ANCHOR[`hip${side}`], hip);
    set(ANCHOR[`knee${side}`], knee);
    set(ANCHOR[`foot${side}`], ankle);
  }
  return out;
}

/** How fast each kind of channel follows a change of state (critically damped spring, rad/s). */
const omega = (channel: string) => channel.startsWith("left.") || channel.startsWith("right.") ? 7
  : channel === "tilt" || channel === "nod" || channel === "turn" ? 8 : channel.startsWith("foot") ? 10 : 4.5;

/** A critically damped follower per channel: changes start gently, accelerate and settle with no overshoot. */
class Springs {
  private readonly x: Channels = {};
  private readonly v: Channels = {};
  follow(target: Channels, dt: number, rate: (channel: string) => number): Channels {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (const [name, goal] of Object.entries(target)) {
      if (!(name in this.x)) { this.x[name] = goal; this.v[name] = 0; continue; }
      const w = rate(name);
      let x = this.x[name], v = this.v[name];
      for (let i = 0; i < steps; i++) { v += (w * w * (goal - x) - 2 * w * v) * h; x += v * h; }
      this.x[name] = x; this.v[name] = v;
    }
    return { ...this.x };
  }
}

/**
 * Animates the figure: each state's held pose is followed by springs (state changes ease in and out), the state's
 * clips play on top, a one-shot cue (a gesture, pointing at a card, an explanation) plays above those, breathing is
 * added, and a fast final spring removes any seam when a state or clip changes. Output is world-space anchors
 * (x, y, z, 0 per anchor) for the particle runtime.
 */
export class FigureAnimator {
  readonly anchors = new Float32Array(ANCHOR_COUNT * 4);
  private readonly normalized = new Float32Array(ANCHOR_COUNT * 3);
  private readonly base = new Springs();
  private readonly final = new Springs();
  private cueClip: { clip: Clip; t: number } | null = null;
  private clock = 0;
  /** The pose most recently solved (flat channels), for diagnostics and tests. */
  pose: Channels = flattenPose(NEUTRAL_POSE);

  /** Plays a one-shot clip above the state's own motion (it fades the state's clips while it runs). */
  cue(clip: Clip) { this.cueClip = { clip, t: 0 }; }
  /** The one-shot clip playing now, if any. */
  get cueing(): string | null { return this.cueClip?.clip.name ?? null; }

  /**
   * @param state what Aion is doing; @param t seconds since that state began;
   * @param amplitude assistant speech loudness (0…1); @param calm reduced motion;
   * @param listen the user's local loudness while Aion listens (0…1).
   */
  sample(dt: number, state: AionState, t: number, amplitude = 0, calm = false, listen = 0): Float32Array {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    this.clock += step;
    const safe = sanitizeState(state);
    const pose = this.base.follow(flattenPose(statePose(safe, amplitude, listen)), step, omega);
    const cue = this.cueClip;
    const quiet = calm ? 0.3 : 1;
    applyStateMotion(pose, safe, Number.isFinite(t) ? Math.max(0, t) : 0, quiet * (cue ? 1 - clipWeight(cue.clip, cue.t) : 1));
    if (cue) {
      applyClip(pose, cue.clip, cue.t, calm ? 0.5 : 1);
      cue.t += step;
      if (cue.t > cue.clip.duration) this.cueClip = null;
    }
    // Breathing, about every 4.5 s: tiny.
    pose.lift = (pose.lift ?? 0) + Math.sin(this.clock * Math.PI * 2 * 0.22) * 0.006 * quiet;
    this.pose = this.final.follow(pose, step, () => 18);
    solvePose(unflattenPose(this.pose), this.normalized);
    for (let i = 0; i < ANCHOR_COUNT; i++) {
      this.anchors[i * 4] = this.normalized[i * 3] * FIGURE_SCALE;
      this.anchors[i * 4 + 1] = this.normalized[i * 3 + 1] * FIGURE_SCALE;
      this.anchors[i * 4 + 2] = this.normalized[i * 3 + 2] * FIGURE_SCALE;
      this.anchors[i * 4 + 3] = 0;
    }
    return this.anchors;
  }
}
