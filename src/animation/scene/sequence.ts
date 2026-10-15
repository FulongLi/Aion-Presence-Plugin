import { ease, smooth, type Segment, segmentAt, sequence as layOut } from "../timeline";
import { applyClip, LOOK_AROUND, NOD, REST_ARM, SHRUG, SURPRISE, THINK, WAVE, type Channels, type Clip } from "../../core/figure/motion";
import { flattenPose, NEUTRAL_POSE, solvePose, unflattenPose } from "../../core/figure/pose";
import { ANCHOR, PROPORTIONS } from "../../core/figure/skeleton";

/**
 * The Scene Sequencer (v0.4.3): short, meaningful actions of Aion's own figure (Figure 2.0 — its skeleton, poses and
 * two-bone IK; no second skeleton, no second renderer) with a few simple objects, described as data and played on the
 * Animation Core's timeline.
 *
 *   AnimationSpec (declarative, from Codex or a demo) ─validate─► compile ─► CompiledSequence: segments on a timeline
 *   evaluate(t) ─► the figure's pose channels (rootX, heading, crouch, arms' IK targets…) + where each object is
 *
 * Codex combines approved motion primitives (walk, jump, pick up, put down, point, face, gesture, react, crouch,
 * wait); it never supplies joint values, code or curves. Everything is bounded (duration, objects, actions, positions)
 * and deterministic: the same spec at the same time is always the same pose.
 *
 * Space: the figure's normalized frame (x right, y up; the ground is at the feet, y = −0.9; the figure is about 1.8
 * tall). The stage shows x within ±STAGE.reach. Walking is planned as footsteps: a planted foot never slides.
 */
export const OBJECT_TYPES = ["box", "ball", "panel", "question"] as const;
export type ObjectType = typeof OBJECT_TYPES[number];
export const OBJECT_SIZES = ["small", "medium", "large"] as const;
export type ObjectSize = typeof OBJECT_SIZES[number];
export const WALK_SPEEDS = ["slow", "normal", "brisk"] as const;
export type WalkSpeed = typeof WALK_SPEEDS[number];
export const FACINGS = ["left", "right", "viewer"] as const;
export type Facing = typeof FACINGS[number];
export const SCENE_GESTURES = ["wave", "nod", "shrug", "surprise", "think", "look-around"] as const;
export type SceneGesture = typeof SCENE_GESTURES[number];
export const ACTIONS = ["walk", "jump", "pick-up", "put-down", "point", "face", "gesture", "react", "crouch", "wait", "think", "notice", "examine", "touch"] as const;
export type ActionName = typeof ACTIONS[number];

export interface SceneObjectSpec {
  id: string;
  type: ObjectType;
  /** Where it stands (normalized x). */
  x: number;
  size?: ObjectSize;
  /** A ball may roll in from here at the start (normalized x). */
  from?: number;
  label?: string;
}

export type ActionSpec =
  | { do: "walk"; to: number | string; speed?: WalkSpeed }
  | { do: "jump"; over?: string }
  | { do: "pick-up"; object: string }
  | { do: "put-down" }
  | { do: "point"; at: string | [number, number] }
  | { do: "face"; toward: Facing | string }
  | { do: "gesture"; name: SceneGesture }
  | { do: "react"; to?: string }
  | { do: "crouch" }
  | { do: "wait"; seconds: number }
  /** v0.4.4 (Figure 3.0): pause and think it over — head tilt, weight shift, hand to the chin, small searching movements, then the "got it" (a question object above it turns to "!"). */
  | { do: "think"; about?: string }
  /** v0.4.4: notice something — the head leads toward it, a small start, the body follows. */
  | { do: "notice"; object: string }
  /** v0.4.4: walk up to an object cautiously and examine it — lean in, crouch, look it over from side to side. */
  | { do: "examine"; object: string }
  /** v0.4.4: reach out and touch an object; it reacts (a hop and a wobble) and the figure starts back a little. */
  | { do: "touch"; object: string };

export interface AnimationSpec {
  title: string;
  start?: { x?: number; facing?: Facing };
  objects?: SceneObjectSpec[];
  actions: ActionSpec[];
}

/** Bounds every sequence respects (the validator enforces them; the compiler's own durations are checked too). */
export const SEQUENCE_LIMITS = { objects: 3, actions: 12, seconds: 18, reach: 1.25, title: 60, wait: 3 } as const;
/** How the stage is drawn: the figure smaller and lower than at rest, so it can travel and jump (see the surface). */
export const STAGE = { scale: 0.62, y: -0.2, reach: SEQUENCE_LIMITS.reach } as const;
export const GROUND = PROPORTIONS.footY;
/** Seconds of standing still at the start while the body forms, and at the end. */
export const SEQUENCE_TIMING = { lead: 1.9, tail: 0.9, enter: 1.3 } as const;

const OBJECT_DIMENSIONS: Record<ObjectType, Record<ObjectSize, { w: number; h: number }>> = {
  box: { small: { w: 0.3, h: 0.26 }, medium: { w: 0.4, h: 0.34 }, large: { w: 0.5, h: 0.42 } },
  ball: { small: { w: 0.18, h: 0.18 }, medium: { w: 0.24, h: 0.24 }, large: { w: 0.32, h: 0.32 } },
  panel: { small: { w: 0.62, h: 0.44 }, medium: { w: 0.8, h: 0.56 }, large: { w: 0.98, h: 0.68 } },
  question: { small: { w: 0.18, h: 0.26 }, medium: { w: 0.24, h: 0.34 }, large: { w: 0.3, h: 0.42 } },
};
/** A panel (a diagram card) stands in the air beside the figure, its centre at about shoulder height. */
const PANEL_CENTRE_Y = 0.3;

export const objectDimensions = (type: ObjectType, size: ObjectSize = "medium") => OBJECT_DIMENSIONS[type][size];

/** Where an object rests (its centre) before anything moves it. */
export function restingCentre(object: SceneObjectSpec): [number, number] {
  const { h } = objectDimensions(object.type, object.size);
  // A question mark floats above head height (v0.4.4); a panel stands at shoulder height; the rest stand on the ground.
  return [object.x, object.type === "panel" ? PANEL_CENTRE_Y : object.type === "question" ? 0.95 : GROUND - 0.02 + h / 2];
}

// ── Validation ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Checked = { ok: true; spec: AnimationSpec } | { ok: false; problem: string };

const ID = /^[a-z][a-z0-9-]{0,23}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Checks a spec against the schema and every bound. Pure; the same check runs in the MCP server, the hub and the page. */
export function validateSequence(input: unknown): Checked {
  const fail = (problem: string): Checked => ({ ok: false, problem });
  if (typeof input !== "object" || input === null) return fail("a sequence must be an object");
  const spec = input as AnimationSpec;
  if (typeof spec.title !== "string" || !spec.title.trim() || Array.from(spec.title).length > SEQUENCE_LIMITS.title) return fail(`title: 1–${SEQUENCE_LIMITS.title} characters`);
  const objects = spec.objects ?? [];
  if (!Array.isArray(objects) || objects.length > SEQUENCE_LIMITS.objects) return fail(`objects: at most ${SEQUENCE_LIMITS.objects}`);
  const ids = new Set<string>();
  for (const object of objects) {
    if (typeof object !== "object" || object === null || !ID.test(object.id) || ids.has(object.id)) return fail("objects: each needs a unique id (lowercase letters, digits, hyphens)");
    ids.add(object.id);
    if (!(OBJECT_TYPES as readonly string[]).includes(object.type)) return fail(`object ${object.id}: type is one of ${OBJECT_TYPES.join(", ")}`);
    if (object.size !== undefined && !(OBJECT_SIZES as readonly string[]).includes(object.size)) return fail(`object ${object.id}: size is small, medium or large`);
    if (!finite(object.x) || Math.abs(object.x) > SEQUENCE_LIMITS.reach) return fail(`object ${object.id}: x within ±${SEQUENCE_LIMITS.reach}`);
    if (object.from !== undefined && (object.type !== "ball" || !finite(object.from) || Math.abs(object.from) > SEQUENCE_LIMITS.reach + 0.6)) return fail(`object ${object.id}: only a ball rolls in (from within ±${SEQUENCE_LIMITS.reach + 0.6})`);
    if (object.label !== undefined && (typeof object.label !== "string" || Array.from(object.label).length > 24)) return fail(`object ${object.id}: label up to 24 characters`);
  }
  const start = spec.start ?? {};
  if (start.x !== undefined && (!finite(start.x) || Math.abs(start.x) > SEQUENCE_LIMITS.reach)) return fail(`start.x within ±${SEQUENCE_LIMITS.reach}`);
  if (start.facing !== undefined && !(FACINGS as readonly string[]).includes(start.facing)) return fail("start.facing is left, right or viewer");
  if (!Array.isArray(spec.actions) || !spec.actions.length || spec.actions.length > SEQUENCE_LIMITS.actions) return fail(`actions: 1–${SEQUENCE_LIMITS.actions}`);
  const known = (id: unknown) => typeof id === "string" && ids.has(id);
  /** A box or a ball: something standing on the ground (not a panel or a floating question mark). */
  const grounded = (id: string) => { const type = objects.find(o => o.id === id)!.type; return type === "box" || type === "ball"; };
  for (const [index, action] of spec.actions.entries()) {
    const where = `action ${index + 1}`;
    if (typeof action !== "object" || action === null || !(ACTIONS as readonly string[]).includes(action.do)) return fail(`${where}: do is one of ${ACTIONS.join(", ")}`);
    switch (action.do) {
      case "walk":
        if (!(finite(action.to) && Math.abs(action.to) <= SEQUENCE_LIMITS.reach) && !known(action.to)) return fail(`${where}: walk to an x within ±${SEQUENCE_LIMITS.reach} or an object id`);
        if (action.speed !== undefined && !(WALK_SPEEDS as readonly string[]).includes(action.speed)) return fail(`${where}: speed is slow, normal or brisk`);
        break;
      case "jump":
        if (action.over !== undefined && !(known(action.over) && grounded(action.over))) return fail(`${where}: jump over a box or a ball by id`);
        break;
      case "think":
        if (action.about !== undefined && !known(action.about)) return fail(`${where}: think about an object id`);
        break;
      case "notice":
        if (!known(action.object)) return fail(`${where}: notice an object by id`);
        break;
      case "examine": case "touch":
        if (!known(action.object) || !grounded(action.object)) return fail(`${where}: ${action.do} a box or a ball by id`);
        break;
      case "pick-up":
        if (!known(action.object) || !grounded(action.object)) return fail(`${where}: pick up a box or a ball by id`);
        break;
      case "point":
        if (!known(action.at) && !(Array.isArray(action.at) && action.at.length === 2 && action.at.every(finite) && Math.abs(action.at[0]) <= 1.6 && action.at[1] >= -1 && action.at[1] <= 1.2)) {
          return fail(`${where}: point at an object id or [x, y] within the stage`);
        }
        break;
      case "face":
        if (!(FACINGS as readonly string[]).includes(action.toward as string) && !known(action.toward)) return fail(`${where}: face left, right, viewer or an object id`);
        break;
      case "gesture":
        if (!(SCENE_GESTURES as readonly string[]).includes(action.name)) return fail(`${where}: gesture is one of ${SCENE_GESTURES.join(", ")}`);
        break;
      case "react":
        if (action.to !== undefined && !known(action.to)) return fail(`${where}: react to an object id`);
        break;
      case "wait":
        if (!finite(action.seconds) || action.seconds < 0.2 || action.seconds > SEQUENCE_LIMITS.wait) return fail(`${where}: wait 0.2–${SEQUENCE_LIMITS.wait} seconds`);
        break;
      default: break;
    }
  }
  const compiled = compileUnchecked(spec);
  if (!compiled.ok) return fail(compiled.problem);
  if (compiled.sequence.duration > SEQUENCE_LIMITS.seconds) return fail(`too long: ${compiled.sequence.duration.toFixed(1)} s (at most ${SEQUENCE_LIMITS.seconds} s); use fewer or shorter actions`);
  return { ok: true, spec };
}

// ── Compilation ────────────────────────────────────────────────────────────────────────────────────────────────

/** What the figure is doing and where things are, carried from one primitive to the next. */
interface StageState {
  x: number;
  heading: number;
  /** The object in the figure's hands. */
  holding: string | null;
  /** Where each object rests (its centre), when no one holds it. */
  objects: Map<string, [number, number]>;
}

/** One primitive on the timeline: its channels at local time t, and what it changes for the next one. */
interface Primitive {
  name: string;
  duration: number;
  /** Channels added to the standing pose (rootX and heading included). */
  pose(t: number): Channels;
  /** The object this primitive is about (highlighted while it plays). */
  focus?: string;
  /** Objects held during this primitive from local time `from` (and released at `to`). */
  hold?: { object: string; from: number; to?: number; release?: [number, number] };
  /** A point on a panel highlighted while pointing (world of the figure, normalized). */
  pointAt?: [number, number];
  /** v0.4.4: an object touched at local time `at` (it hops and wobbles). */
  poke?: { object: string; at: number };
  /** v0.4.4: a question object answered at local time `at` (its "?" becomes "!"). */
  solve?: { object: string; at: number };
}

export interface CompiledSequence {
  spec: AnimationSpec;
  duration: number;
  segments: Segment<Primitive>[];
  start: { x: number; heading: number };
}

export type Compiled = { ok: true; sequence: CompiledSequence } | { ok: false; problem: string };

const HEADING: Record<Facing, number> = { viewer: 0, right: Math.PI / 2, left: -Math.PI / 2 };
const SPEED: Record<WalkSpeed, { v: number; step: number; lift: number }> = {
  slow: { v: 0.4, step: 0.62, lift: 0.07 }, normal: { v: 0.58, step: 0.5, lift: 0.085 }, brisk: { v: 0.78, step: 0.42, lift: 0.1 },
};

const standing = (state: StageState): Channels => ({ rootX: state.x, heading: state.heading });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const arms = (raise: number, bend: number, forward: number): Channels =>
  ({ "left.raise": raise, "left.bend": bend, "left.forward": forward, "right.raise": raise, "right.bend": bend, "right.forward": forward });
/** Both hands reaching (two-bone IK) for a point in the figure's own frame, a little apart. */
const reachBoth = (weight: number, x: number, y: number, z: number): Channels => ({
  "left.reach": weight, "left.reachX": x + 0.045, "left.reachY": y, "left.reachZ": z,
  "right.reach": weight, "right.reachX": x - 0.045, "right.reachY": y, "right.reachZ": z,
});
/** World (stage, normalized) → the figure's own frame, for IK targets. */
function toLocal(point: [number, number], rootX: number, heading: number): [number, number, number] {
  const dx = point[0] - rootX, c = Math.cos(heading), s = Math.sin(heading);
  // world x = local x·c + local z·s (y unchanged), with a target in the stage plane (world z = 0): solve for local.
  return [dx * c, point[1], dx * s];
}
/** Where hands hold a carried object (the figure's frame): in front of the chest. */
const CARRY: [number, number, number] = [0, 0.18, 0.26];
/** Where hands take hold of an object: a little above its centre (its top, for a box). */
const GRIP = 0.28;

/** Turning to a new heading on the spot, the head leading a little. */
function face(state: StageState, heading: number): Primitive | null {
  const from = state.heading, change = heading - from;
  if (Math.abs(change) < 1e-3) return null;
  const duration = 0.32 + Math.abs(change) * 0.16;
  state.heading = heading;
  const holding = state.holding;
  return {
    name: "face", duration,
    pose: t => {
      const k = ease("inOut", t / duration), lead = ease("inOut", Math.min(1, t / (duration * 0.7)));
      return { rootX: state.x, heading: from + change * k, turn: (lead - k) * Math.sign(change) * 0.9, ...(holding ? reachBoth(1, ...CARRY) : {}) };
    },
  };
}

/**
 * A walk planned as footsteps: the pelvis eases into motion, cruises and eases to a stop; each foot swings in turn and
 * lands where the pelvis will be half a step later, so a planted foot never slides, and the last steps bring the feet
 * together at the destination.
 */
function walk(state: StageState, to: number, speed: WalkSpeed): Primitive | null {
  const x0 = state.x, distance = Math.abs(to - x0), dir = Math.sign(to - x0);
  if (distance < 0.02) return null;
  const { v: cruise, step, lift } = SPEED[speed];
  const accel = 0.5, decel = 0.65;
  // Smoothstep ramps cover half their duration's worth of cruise distance.
  const v = Math.min(cruise, distance / ((accel + decel) / 2));
  const moving = distance / v + (accel + decel) / 2;
  const ramp = (u: number) => u * u * u - u * u * u * u / 2;
  const travelled = (t: number) => {
    if (t <= 0) return 0;
    if (t >= moving) return distance;
    let s = v * accel * ramp(Math.min(1, t / accel)) + v * Math.max(0, Math.min(t, moving - decel) - accel);
    if (t > moving - decel) { const u = (t - (moving - decel)) / decel; s += v * decel * (u - ramp(u)); }
    return Math.min(distance, s);
  };
  const pelvis = (t: number) => x0 + dir * travelled(t);
  // Footsteps: alternate feet; each lands under where the pelvis will be at mid-stance; stop once both are home.
  const swings: { foot: 0 | 1; start: number; from: number; to: number }[] = [];
  const at: [number, number] = [x0, x0];
  for (let k = 0; k < 64; k++) {
    const foot = (k % 2) as 0 | 1, start = k * step;
    const target = pelvis(start + step * 1.5);
    if (Math.abs(target - at[foot]) > 0.004) { swings.push({ foot, start, from: at[foot], to: target }); at[foot] = target; }
    if (start + step >= moving && Math.abs(at[0] - to) < 0.004 && Math.abs(at[1] - to) < 0.004) break;
  }
  const duration = Math.max(moving, swings.length ? swings[swings.length - 1].start + step : 0) + 0.12;
  const heading = state.heading, holding = state.holding;
  state.x = to;
  const footAt = (foot: 0 | 1, t: number): { x: number; y: number; swing: number } => {
    let x = x0, y = 0, swing = 0;
    for (const s of swings) {
      if (s.foot !== foot || t < s.start) continue;
      if (t >= s.start + step) { x = s.to; continue; }
      const u = (t - s.start) / step;
      x = lerp(s.from, s.to, smooth(u)); y = lift * Math.sin(Math.PI * u) * Math.min(1, Math.abs(s.to - s.from) / 0.12); swing = u;
    }
    return { x, y, swing };
  };
  return {
    name: "walk", duration,
    pose: t => {
      const root = pelvis(t), speedNow = (pelvis(t + 0.02) - pelvis(t - 0.02)) / 0.04 * dir / cruise;
      const left = footAt(0, t), right = footAt(1, t);
      // Forward in the figure's frame is along its heading: local z = (world x − root) · dir.
      const zl = (left.x - root) * dir, zr = (right.x - root) * dir;
      const bob = [left, right].reduce((sum, f) => sum + (f.swing > 0 ? 0.014 * (1 - Math.sin(Math.PI * f.swing)) : 0), 0);
      const swing = (z: number) => Math.max(-0.2, Math.min(0.2, z * 0.9));
      // Figure 3.0: the weight shifts over the planted foot, the shoulders counter-turn against the hips, the upper body
      // leads into the motion, and after the last step it settles back a touch before standing still (follow-through).
      const stance = left.swing > 0 ? -1 : right.swing > 0 ? 1 : 0;
      const settle = t > moving ? Math.sin(Math.PI * Math.min(1, (t - moving) / 0.5)) * Math.exp(-(t - moving) * 2) : 0;
      const pace = Math.min(1, speedNow * 1.2);
      return {
        rootX: root, heading,
        "footLeft.z": zl, "footLeft.y": left.y, "footRight.z": zr, "footRight.y": right.y,
        crouch: bob * Math.min(1, speedNow * 1.4), lean: 0.05 * speedNow - 0.03 * settle, curl: 0.22 * pace - 0.12 * settle,
        sway: 0.016 * stance * pace, hipTilt: -0.03 * stance * pace, twist: Math.max(-0.16, Math.min(0.16, (zl - zr) * 0.45)) * pace,
        nod: 0.05 * pace, tilt: -0.02 * stance * pace,
        ...(holding ? reachBoth(1, ...CARRY) : {
          "left.forward": REST_ARM.forward + swing(zr), "right.forward": REST_ARM.forward + swing(zl),
          "left.raise": REST_ARM.raise * 0.6, "right.raise": REST_ARM.raise * 0.6,
          // The elbow bends more as the arm swings forward.
          "left.bend": 0.16 + Math.max(0, swing(zr)) * 1.4, "right.bend": 0.16 + Math.max(0, swing(zl)) * 1.4,
        }),
      };
    },
  };
}

/**
 * A running jump over an object (v0.4.3; v0.4.4 Figure 3.0 timing and body): a deep, gathered crouch with the arms
 * swinging back (anticipation), an explosive extension with the arms thrown up and the back arching, a tuck over it with
 * the knees up and the back rounding, a landing that absorbs through the knees with the arms forward for balance, and a
 * recovery that rises a touch past standing before it settles.
 */
function jumpOver(state: StageState, objectX: number, half: number, height: number): Primitive {
  const dir = Math.sign(Math.sin(state.heading)) || 1;
  const takeoff = state.x, landing = objectX + dir * (half + 0.3);
  const A = 0.5, F = 0.62, L = 0.34, R = 0.62, duration = A + F + L + R;
  const H = height + 0.07, tuck = 0.15;
  const heading = state.heading;
  state.x = landing;
  return {
    name: "jump", duration,
    pose: t => {
      if (t < A) {
        const k = ease("inOut", t / A);
        return { rootX: takeoff, heading, crouch: 0.15 * k, lean: 0.07 * k, curl: 0.45 * k, nod: 0.12 * k, "footLeft.z": 0.04, "footRight.z": -0.04,
          ...arms(REST_ARM.raise + (0.42 - REST_ARM.raise) * k, 0.25, -0.24 * k) };
      }
      if (t < A + F) {
        const u = (t - A) / F, arc = Math.sin(Math.PI * u), launch = 1 - smooth(Math.min(1, u * 3.2));
        // Every channel continues from the crouch at take-off and arrives where the landing begins.
        const arch = Math.sin(Math.PI * Math.min(1, u / 0.42)) * (u < 0.42 ? 1 : 0), tuckIn = Math.sin(Math.PI * Math.max(0, (u - 0.3) / 0.7));
        return {
          rootX: lerp(takeoff, landing, u), heading, jump: 4 * H * u * (1 - u), crouch: 0.15 * launch, lean: 0.07 - 0.04 * arc,
          // Arching as it extends, rounding into the tuck over the top.
          curl: 0.45 * launch - 0.35 * arch + 0.35 * tuckIn, nod: 0.12 * launch - 0.12 * arc,
          "footLeft.y": tuck * arc, "footRight.y": tuck * arc * 0.9, "footLeft.z": 0.04 + 0.13 * arc, "footRight.z": -0.04 - 0.04 * arc,
          ...arms(0.42 + 1.25 * Math.sin(Math.PI * Math.min(1, u * 1.6)), 0.25 + 0.05 * smooth(u * 2), -0.24 + 0.46 * smooth(u * 2)),
        };
      }
      if (t < A + F + L) {
        const k = ease("out", (t - A - F) / L);
        return { rootX: landing, heading, crouch: 0.16 * k, lean: 0.07 + 0.01 * k, curl: 0.4 * k, nod: 0.14 * k, "footLeft.z": 0.04, "footRight.z": -0.04, ...arms(0.42 + 0.15 * k, 0.3 + 0.15 * k, 0.22 - 0.02 * k) };
      }
      // Rising back up, a touch past standing (follow-through), then settling.
      const k = ease("back", (t - A - F - L) / R);
      return { rootX: landing, heading, crouch: 0.16 * (1 - k), lean: 0.08 * (1 - k), curl: 0.4 * (1 - k), nod: 0.14 * (1 - k), "footLeft.z": 0.04 * (1 - k), "footRight.z": -0.04 * (1 - k),
        ...arms(lerp(0.57, REST_ARM.raise, k), lerp(0.45, REST_ARM.bend, k), lerp(0.2, REST_ARM.forward, k)) };
    },
  };
}

/** A small jump on the spot (anticipation, launch with arms up, land soft). */
function jumpInPlace(state: StageState): Primitive {
  const base = standing(state);
  return {
    name: "jump", duration: 1.7,
    pose: t => {
      const u = t < 0.4 ? 0 : Math.min(1, (t - 0.4) / 0.5), arc = Math.sin(Math.PI * u);
      const crouch = t < 0.4 ? 0.08 * ease("inOut", t / 0.4) : t < 0.9 ? 0.08 * (1 - smooth(u * 3)) : 0.08 * Math.sin(Math.PI * Math.min(1, (t - 0.9) / 0.8));
      return { ...base, crouch, jump: 0.16 * 4 * u * (1 - u), "footLeft.y": 0.07 * arc, "footRight.y": 0.07 * arc, ...arms(REST_ARM.raise + 1.6 * arc, 0.25, 0.05) };
    },
  };
}

/** Bending down to an object, reaching for it with both hands, lifting it to the chest, up overhead, and back. */
function pickUp(state: StageState, object: string, centre: [number, number], height: number): Primitive {
  const heading = state.heading, x = state.x;
  const ground = toLocal([centre[0], centre[1] + height * GRIP], x, heading);
  // A deep squat with the back bent forward: the figure's arms are short beside its legs.
  const SQUAT = 0.55, BEND = 0.36, NOD = 0.3;
  const B = 0.8, G = 0.25, L = 0.85, U = 0.8, D = 0.6, duration = B + G + L + U + D;
  state.holding = object;
  const overhead: [number, number, number] = [0, 0.66, 0.1];
  return {
    name: "pick-up", duration, focus: object, hold: { object, from: B + G * 0.6 },
    pose: t => {
      const base = { rootX: x, heading, "footLeft.z": 0.05, "footRight.z": -0.05 };
      if (t < B + G) {
        const k = ease("inOut", Math.min(1, t / B));
        return { ...base, crouch: SQUAT * k, lean: BEND * k, nod: NOD * k, ...reachBoth(k, ground[0], ground[1], ground[2]) };
      }
      if (t < B + G + L) {
        const k = ease("inOut", (t - B - G) / L);
        return {
          ...base, crouch: SQUAT * (1 - k), lean: BEND * (1 - k), nod: NOD * (1 - k),
          ...reachBoth(1, lerp(ground[0], CARRY[0], k), lerp(ground[1], CARRY[1], k), lerp(ground[2], CARRY[2], k)),
        };
      }
      if (t < B + G + L + U) {
        const k = ease("inOut", (t - B - G - L) / U);
        return { ...base, nod: -0.18 * k, lift: 0.02 * k, ...reachBoth(1, lerp(CARRY[0], overhead[0], k), lerp(CARRY[1], overhead[1], k), lerp(CARRY[2], overhead[2], k)) };
      }
      const k = ease("inOut", (t - B - G - L - U) / D);
      return { ...base, nod: -0.18 * (1 - k), lift: 0.02 * (1 - k), ...reachBoth(1, lerp(overhead[0], CARRY[0], k), lerp(overhead[1], CARRY[1], k), lerp(overhead[2], CARRY[2], k)) };
    },
  };
}

/** Bending to set the object down in front, letting go, standing up. */
function putDown(state: StageState, object: string, height: number): Primitive {
  const heading = state.heading, x = state.x, dir = Math.sign(Math.sin(heading));
  const spot: [number, number] = [x + (dir || 0) * 0.3, GROUND - 0.02 + height / 2];
  const ground = toLocal([spot[0], spot[1] + height * GRIP], x, heading);
  const SQUAT = 0.55, BEND = 0.36, NOD = 0.3;
  const B = 0.85, G = 0.2, R = 0.8, duration = B + G + R;
  state.holding = null;
  state.objects.set(object, spot);
  return {
    name: "put-down", duration, focus: object, hold: { object, from: 0, to: B + G * 0.5, release: spot },
    pose: t => {
      const base = { rootX: x, heading, "footLeft.z": 0.05, "footRight.z": -0.05 };
      if (t < B + G) {
        const k = ease("inOut", Math.min(1, t / B));
        return { ...base, crouch: SQUAT * k, lean: BEND * k, nod: NOD * k, ...reachBoth(1, lerp(CARRY[0], ground[0], k), lerp(CARRY[1], ground[1], k), lerp(CARRY[2], ground[2], k)) };
      }
      const k = ease("inOut", (t - B - G) / R);
      return { ...base, crouch: SQUAT * (1 - k), lean: BEND * (1 - k), nod: NOD * (1 - k), ...reachBoth(1 - k, ground[0], ground[1], ground[2]) };
    },
  };
}

/** Looking at a point, reaching an arm toward it (IK; straight toward a point out of reach), holding, returning. */
function point(state: StageState, at: [number, number], focus?: string): Primitive {
  const heading = state.heading, x = state.x, holding = state.holding;
  const local = toLocal(at, x, heading);
  // The arm on the side of the point (the figure's left is the viewer's right); in profile, the near arm.
  const side = local[0] >= 0 ? "left" : "right", s = local[0] >= 0 ? 1 : -1;
  const look = Math.abs(heading) < 0.3 ? 0.75 * s : 0;
  const target = { [`${side}.reachX`]: local[0], [`${side}.reachY`]: local[1], [`${side}.reachZ`]: Math.max(0.12, local[2]) };
  const keys: { at: number; v: Channels; ease: "inOut" | "back" | "linear" }[] = [
    { at: 0.5, v: { turn: look, tilt: 0.05 * s, lean: 0.015 }, ease: "inOut" },
    { at: 0.8, v: { [`${side}.raise`]: 0.25, [`${side}.bend`]: 0.8, [`${side}.forward`]: 0.06, [`${side}.reach`]: 0, ...target }, ease: "inOut" },
    { at: 1.2, v: { [`${side}.reach`]: 1 }, ease: "back" },
    { at: 2.2, v: { [`${side}.reach`]: 1, turn: look * 0.9 }, ease: "linear" },
    { at: 2.9, v: { [`${side}.reach`]: 0, [`${side}.raise`]: REST_ARM.raise, [`${side}.bend`]: REST_ARM.bend, [`${side}.forward`]: REST_ARM.forward, turn: 0, tilt: 0, lean: 0 }, ease: "inOut" },
  ];
  const clip: Clip = { name: "point", duration: 2.9, fadeIn: 0.1, fadeOut: 0.3, keys };
  return {
    name: "point", duration: clip.duration, ...(focus ? { focus } : {}), pointAt: at,
    pose: t => {
      const channels: Channels = { ...flatten(), rootX: x, heading, ...(holding ? reachBoth(1, ...CARRY) : {}) };
      applyClip(channels, clip, t);
      return channels;
    },
  };
}

/** A named gesture from Figure 2.0's library, played where the figure stands. */
function gesture(state: StageState, name: SceneGesture): Primitive {
  const clip: Clip = { wave: WAVE("right"), nod: NOD, shrug: SHRUG, surprise: SURPRISE, think: THINK, "look-around": LOOK_AROUND("left") }[name];
  const base = standing(state);
  return { name, duration: clip.duration, pose: t => { const channels: Channels = { ...flatten(), ...base }; applyClip(channels, clip, t); return channels; } };
}

/** Surprise: a start back (a small hop away from what surprised it), arms up, then a slow recovery and a nod. */
function react(state: StageState, toward: number | null): Primitive {
  const heading = state.heading, x0 = state.x;
  const away = toward === null ? -(Math.sign(Math.sin(heading)) || 1) : -Math.sign(toward - x0) || -1;
  const back = 0.17, x1 = x0 + away * back;
  state.x = x1;
  const nod: Clip = { ...NOD, duration: NOD.duration };
  return {
    name: "react", duration: SURPRISE.duration + 0.9,
    pose: t => {
      const k = smooth((t - 0.12) / 0.34);
      const channels: Channels = { ...flatten(), rootX: lerp(x0, x1, k), heading };
      applyClip(channels, SURPRISE, t);
      applyClip(channels, nod, t - SURPRISE.duration + 0.2);
      return channels;
    },
  };
}

function crouch(state: StageState): Primitive {
  const base = standing(state), holding = state.holding;
  return {
    name: "crouch", duration: 1.4,
    pose: t => {
      const k = Math.sin(Math.PI * Math.min(1, t / 1.4));
      return { ...base, crouch: 0.2 * k, lean: 0.06 * k, nod: 0.15 * k, ...(holding ? reachBoth(1, ...CARRY) : arms(REST_ARM.raise + 0.25 * k, 0.4 * k + REST_ARM.bend, 0.14 * k)) };
    },
  };
}

function wait(state: StageState, seconds: number): Primitive {
  const base = standing(state), holding = state.holding;
  return { name: "wait", duration: seconds, pose: () => ({ ...base, ...(holding ? reachBoth(1, ...CARRY) : {}) }) };
}

// ── Figure 3.0 behaviours (v0.4.4) ─────────────────────────────────────────────────────────────────────────────

/** Channels for one arm as raise / bend / forward (the figure's "left" is the viewer's right). */
const armOf = (side: "left" | "right", raise: number, bend: number, forward: number): Channels =>
  ({ [`${side}.raise`]: raise, [`${side}.bend`]: bend, [`${side}.forward`]: forward });
const restOf = (side: "left" | "right") => armOf(side, REST_ARM.raise, REST_ARM.bend, REST_ARM.forward);

/**
 * Thinking it over: a pause, the head tilting, the weight shifting onto one leg, a hand coming up to the chin and the
 * other folding across the waist, small searching movements of the head, then the "got it" — the hand lifts with a raised
 * finger, the head comes up — and a calm return. With `about` (a question object), its "?" turns to "!" at that moment.
 */
function think(state: StageState, about?: string): Primitive {
  const base = standing(state);
  const keys: { at: number; v: Channels; ease: "inOut" | "back" | "linear" | "out" }[] = [
    { at: 0.6, v: { tilt: 0.06, nod: -0.06, curl: -0.15 }, ease: "inOut" },
    { at: 1.3, v: { tilt: 0.16, sway: -0.018, hipTilt: -0.04, nod: 0.05 }, ease: "inOut" },
    { at: 2.1, v: { "right.chin": 1, ...armOf("left", 0.08, -1.25, 0.12), curl: -0.25, lean: -0.012 }, ease: "inOut" },
    { at: 2.7, v: { turn: 0.22, tilt: 0.08, nod: -0.1 }, ease: "inOut" },
    { at: 3.3, v: { turn: -0.12, tilt: 0.18, nod: -0.04 }, ease: "inOut" },
    { at: 3.8, v: { turn: 0.05, tilt: 0.12, nod: 0.06 }, ease: "inOut" },
    // The idea: the chin hand rises, finger up, the back straightens and leans in, the head lifts.
    { at: 4.25, v: { "right.chin": 0, ...armOf("right", 1.7, 1.45, 0.16), curl: 0.3, lean: 0.03, nod: -0.14, tilt: 0.02, turn: 0, sway: 0, hipTilt: 0 }, ease: "back" },
    { at: 4.9, v: { ...armOf("right", 1.65, 1.4, 0.16) }, ease: "linear" },
    { at: 5.8, v: { ...restOf("right"), ...restOf("left"), curl: 0, lean: 0, nod: 0, tilt: 0 }, ease: "inOut" },
  ];
  const clip: Clip = { name: "think", duration: 5.8, fadeIn: 0.15, fadeOut: 0.4, keys };
  return {
    name: "think", duration: clip.duration, ...(about ? { focus: about, solve: { object: about, at: 4.1 } } : {}),
    pose: t => { const channels: Channels = { ...flatten(), ...base }; applyClip(channels, clip, t); return channels; },
  };
}

/** Noticing something: the head snaps toward it, a small start (the body lifts and draws back a little), then settles. */
function notice(state: StageState, objectX: number, object: string): Primitive {
  const base = standing(state);
  const toward = objectX >= state.x ? 1 : -1;
  // Facing the viewer the head turns toward it; in profile it lifts instead (the object is ahead or behind).
  const facingViewer = Math.abs(Math.sin(state.heading)) < 0.5;
  const look = facingViewer ? 0.7 * toward : 0;
  const keys: { at: number; v: Channels; ease: "inOut" | "back" | "out" }[] = [
    { at: 0.22, v: { turn: look, nod: -0.12, lift: 0.012, curl: -0.25, lean: -0.02 }, ease: "out" },
    { at: 0.7, v: { turn: look * 0.95, nod: -0.04, lift: 0, curl: -0.1, lean: 0 }, ease: "inOut" },
    { at: 1.3, v: { turn: look * 0.9, nod: 0.02, curl: 0.12, lean: 0.015 }, ease: "inOut" },
  ];
  const clip: Clip = { name: "notice", duration: 1.3, fadeIn: 0.05, fadeOut: 0.5, keys };
  return { name: "notice", duration: clip.duration, focus: object, pose: t => { const channels: Channels = { ...flatten(), ...base }; applyClip(channels, clip, t); return channels; } };
}

/** Examining an object close up: leaning in and down, the head looking it over from one side to the other, then straightening a little. */
function examine(state: StageState, object: string): Primitive {
  const base = standing(state);
  const keys: { at: number; v: Channels; ease: "inOut" | "linear" }[] = [
    { at: 0.9, v: { crouch: 0.1, lean: 0.12, curl: 0.55, nod: 0.3, ...armOf("left", 0.2, 0.7, 0.1), ...armOf("right", 0.2, 0.7, 0.1) }, ease: "inOut" },
    { at: 1.6, v: { tilt: 0.2, turn: 0.12 }, ease: "inOut" },
    { at: 2.3, v: { tilt: -0.18, turn: -0.1 }, ease: "inOut" },
    { at: 2.8, v: { tilt: 0.04, turn: 0 }, ease: "inOut" },
    { at: 3.4, v: { crouch: 0.03, lean: 0.05, curl: 0.25, nod: 0.18 }, ease: "inOut" },
  ];
  const clip: Clip = { name: "examine", duration: 3.4, fadeIn: 0.1, fadeOut: 0.3, keys };
  return { name: "examine", duration: clip.duration, focus: object, pose: t => { const channels: Channels = { ...flatten(), ...base }; applyClip(channels, clip, t); return channels; } };
}

/**
 * Touching an object: the near hand reaches out slowly (IK to its top), taps it, and pulls back quickly as the figure starts
 * back a little; the object hops and wobbles from the moment of the touch.
 */
function touch(state: StageState, object: string, top: [number, number]): Primitive {
  const heading = state.heading, x = state.x;
  const local = toLocal(top, x, heading);
  // In profile the arm toward the object is the near one; facing the viewer, the one on its side.
  const side: "left" | "right" = local[0] >= 0 ? "left" : "right";
  const target = { [`${side}.reachX`]: local[0], [`${side}.reachY`]: local[1] + 0.02, [`${side}.reachZ`]: Math.max(0.1, local[2]) };
  const TAP = 1.15;
  const keys: { at: number; v: Channels; ease: "inOut" | "back" | "out" | "linear" }[] = [
    { at: 0.5, v: { lean: 0.06, curl: 0.35, nod: 0.2, crouch: 0.05, [`${side}.reach`]: 0, ...target }, ease: "inOut" },
    { at: TAP - 0.1, v: { [`${side}.reach`]: 0.92, lean: 0.08 }, ease: "inOut" },
    { at: TAP, v: { [`${side}.reach`]: 1 }, ease: "out" },
    // The start back: the hand withdraws fast, the body draws back, the head lifts.
    { at: TAP + 0.28, v: { [`${side}.reach`]: 0, ...armOf(side, 0.45, 1.2, 0.12), lean: -0.03, curl: -0.25, nod: -0.08, crouch: 0.02, lift: 0.01 }, ease: "out" },
    { at: TAP + 1.1, v: { ...restOf(side), lean: 0, curl: 0, nod: 0.06, crouch: 0, lift: 0 }, ease: "inOut" },
  ];
  const clip: Clip = { name: "touch", duration: TAP + 1.1, fadeIn: 0.1, fadeOut: 0.3, keys };
  return {
    name: "touch", duration: clip.duration, focus: object, poke: { object, at: TAP },
    pose: t => { const channels: Channels = { ...flatten(), rootX: x, heading }; applyClip(channels, clip, t); return channels; },
  };
}

const NEUTRAL = flattenPose(NEUTRAL_POSE);
const flatten = (): Channels => ({ ...NEUTRAL });

/** Compiles a validated spec (use validateSequence first; this assumes the shape is right). */
export function compileSequence(spec: AnimationSpec): CompiledSequence {
  const compiled = compileUnchecked(spec);
  if (!compiled.ok) throw new Error("sequence-invalid");
  return compiled.sequence;
}

function compileUnchecked(spec: AnimationSpec): Compiled {
  const objects = new Map((spec.objects ?? []).map(object => [object.id, object]));
  const state: StageState = {
    x: spec.start?.x ?? 0, heading: HEADING[spec.start?.facing ?? "viewer"], holding: null,
    objects: new Map((spec.objects ?? []).map(object => [object.id, restingCentre(object)])),
  };
  const start = { x: state.x, heading: state.heading };
  const primitives: Primitive[] = [wait(state, SEQUENCE_TIMING.lead)];
  const push = (primitive: Primitive | null) => { if (primitive) primitives.push(primitive); };
  const half = (id: string) => { const o = objects.get(id)!; return objectDimensions(o.type, o.size).w / 2; };
  const centreOf = (id: string) => state.objects.get(id) ?? restingCentre(objects.get(id)!);
  /** Faces the direction of travel toward x (if it is not already facing it). */
  const faceToward = (x: number) => { if (Math.abs(x - state.x) > 0.02) push(face(state, HEADING[x > state.x ? "right" : "left"])); };
  /** Walks to stand `gap` in front of an object's near side. */
  const approach = (id: string, gap: number, speed: WalkSpeed = "normal") => {
    const cx = centreOf(id)[0], side = cx >= state.x ? -1 : 1;
    const to = cx + side * (half(id) + gap);
    faceToward(cx);
    push(walk(state, to, speed));
    if (Math.abs(Math.sin(state.heading)) < 0.5 || Math.sign(Math.sin(state.heading)) !== Math.sign(cx - state.x)) push(face(state, HEADING[cx > state.x ? "right" : "left"]));
  };
  for (const action of spec.actions) {
    switch (action.do) {
      case "walk": {
        let to: number;
        if (typeof action.to === "string") {
          const cx = centreOf(action.to)[0], side = cx >= state.x ? -1 : 1;
          to = cx + side * (half(action.to) + 0.18);
        } else to = action.to;
        if (Math.abs(to) > SEQUENCE_LIMITS.reach + 0.05) return { ok: false, problem: "walk: the destination is off the stage" };
        faceToward(to);
        push(walk(state, to, action.speed ?? "normal"));
        break;
      }
      case "jump": {
        if (!action.over) { push(jumpInPlace(state)); break; }
        if (state.holding) return { ok: false, problem: "jump: put the object down first" };
        const object = objects.get(action.over)!, cx = centreOf(action.over)[0], h = objectDimensions(object.type, object.size).h;
        const landing = cx + Math.sign(cx - state.x || 1) * (half(action.over) + 0.3);
        if (Math.abs(landing) > SEQUENCE_LIMITS.reach + 0.05) return { ok: false, problem: "jump: there is no room to land beyond that object" };
        approach(action.over, 0.3, "brisk");
        push(jumpOver(state, cx, half(action.over), h));
        break;
      }
      case "pick-up": {
        if (state.holding) return { ok: false, problem: "pick-up: the hands are already full" };
        approach(action.object, 0.12);
        const object = objects.get(action.object)!;
        push(pickUp(state, action.object, centreOf(action.object), objectDimensions(object.type, object.size).h));
        break;
      }
      case "put-down": {
        if (!state.holding) return { ok: false, problem: "put-down: nothing is being held" };
        const object = objects.get(state.holding)!;
        push(putDown(state, state.holding, objectDimensions(object.type, object.size).h));
        break;
      }
      case "point": {
        let at: [number, number], focus: string | undefined;
        if (typeof action.at === "string") {
          const object = objects.get(action.at)!, c = centreOf(action.at), { w, h } = objectDimensions(object.type, object.size);
          // A panel is pointed at a little left of centre and above it (where the diagram's mark is); anything else at its top.
          at = object.type === "panel" ? [c[0] - w * 0.18, c[1] + h * 0.28] : [c[0], c[1] + h / 2];
          focus = action.at;
        } else at = action.at;
        push(point(state, at, focus));
        break;
      }
      case "face": {
        const toward = action.toward;
        const heading = (FACINGS as readonly string[]).includes(toward) ? HEADING[toward as Facing] : HEADING[centreOf(toward)[0] >= state.x ? "right" : "left"];
        push(face(state, heading));
        break;
      }
      case "gesture": push(gesture(state, action.name)); break;
      case "react": push(react(state, action.to ? centreOf(action.to)[0] : null)); break;
      case "crouch": push(crouch(state)); break;
      case "wait": push(wait(state, action.seconds)); break;
      case "think": push(think(state, action.about)); break;
      case "notice": push(notice(state, centreOf(action.object)[0], action.object)); break;
      case "examine": {
        // Up to it slowly, then a close look.
        approach(action.object, 0.16, "slow");
        push(examine(state, action.object));
        break;
      }
      case "touch": {
        if (state.holding) return { ok: false, problem: "touch: put the object down first" };
        const object = objects.get(action.object)!, c = centreOf(action.object);
        if (Math.abs(c[0] - state.x) > half(action.object) + 0.4) approach(action.object, 0.14, "slow");
        push(touch(state, action.object, [c[0], c[1] + objectDimensions(object.type, object.size).h / 2]));
        break;
      }
    }
    if (Math.abs(state.x) > SEQUENCE_LIMITS.reach + 0.05) return { ok: false, problem: "the figure would leave the stage" };
  }
  push(wait(state, SEQUENCE_TIMING.tail));
  const segments = layOut(primitives, primitive => primitive.duration);
  const duration = segments[segments.length - 1].end;
  return { ok: true, sequence: { spec, duration, segments, start } };
}

// ── Evaluation ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ObjectFrame {
  id: string;
  type: ObjectType;
  size: ObjectSize;
  /** Centre (normalized stage coordinates). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A ball's roll (radians), from how far it has travelled. */
  spin: number;
  /** 0…1: the action is about this object (a soft highlight). */
  focus: number;
  /** A point on a panel being pointed at (normalized), or null. */
  mark: [number, number] | null;
  label?: string;
  /** v0.4.4: a touched object's wobble (radians), its hop (normalized) and a brief glow (0…1). */
  tilt: number;
  hop: number;
  glow: number;
  /** v0.4.4: a question object's answer, 0 ("?") … 1 ("!"). */
  solved: number;
}

export interface SequenceFrame {
  /** The figure's full pose as flat channels (Figure 2.0's), for FigureAnimator. */
  channels: Channels;
  objects: ObjectFrame[];
  /** The primitive playing ("walk", "jump"…), for diagnostics. */
  action: string;
}

/** The pose and the objects at `time` (seconds into the sequence, clamped). Pure. */
export function evaluateSequence(sequence: CompiledSequence, time: number): SequenceFrame {
  const t = Math.max(0, Math.min(sequence.duration, Number.isFinite(time) ? time : 0));
  const segment = segmentAt(sequence.segments, t)!;
  const local = t - segment.start;
  const channels = { ...NEUTRAL, rootX: sequence.start.x, heading: sequence.start.heading, ...segment.value.pose(local) };
  // Objects: where each rests, unless held (then between the hands) or rolling in.
  const rest = new Map((sequence.spec.objects ?? []).map(object => [object.id, restingCentre(object)]));
  let held: string | null = null;
  for (const s of sequence.segments) {
    if (s.start > t) break;
    const hold = s.value.hold;
    if (!hold) continue;
    const at = t - s.start;
    if (at >= hold.from && (hold.to === undefined || at < hold.to)) held = hold.object;
    else if (hold.to !== undefined && at >= hold.to) { held = null; if (hold.release) rest.set(hold.object, hold.release); }
  }
  let hands: [number, number] | null = null;
  if (held) {
    const anchors = solvePose(unflattenPose(channels));
    hands = [(anchors[ANCHOR.handLeft * 3] + anchors[ANCHOR.handRight * 3]) / 2, (anchors[ANCHOR.handLeft * 3 + 1] + anchors[ANCHOR.handRight * 3 + 1]) / 2];
  }
  const objects = (sequence.spec.objects ?? []).map(object => {
    const size = object.size ?? "medium", { w, h } = objectDimensions(object.type, size);
    let [x, y] = rest.get(object.id)!;
    let travelled = 0;
    if (object.id === held && hands) { x = hands[0]; y = hands[1] - h * GRIP; }
    else if (object.from !== undefined && t < SEQUENCE_TIMING.lead + SEQUENCE_TIMING.enter) {
      const k = ease("out", Math.max(0, (t - SEQUENCE_TIMING.lead * 0.55) / (SEQUENCE_TIMING.enter + SEQUENCE_TIMING.lead * 0.45)));
      x = lerp(object.from, object.x, k);
    }
    if (object.from !== undefined) travelled = x - object.from;
    const focused = segment.value.focus === object.id ? smooth(Math.min(local, segment.value.duration - local) / 0.35) : 0;
    const mark = segment.value.pointAt && segment.value.focus === object.id && object.type === "panel"
      ? (local > 0.9 && local < 2.5 ? segment.value.pointAt : null) : null;
    // Touched: a hop and a decaying wobble from the moment of the touch; answered: "?" turns to "!".
    let tilt = 0, hop = 0, glow = 0, solved = 0;
    for (const s of sequence.segments) {
      if (s.value.poke?.object === object.id && t >= s.start + s.value.poke.at) {
        const e = t - s.start - s.value.poke.at;
        tilt += 0.2 * Math.exp(-3.2 * e) * Math.sin(15 * e);
        hop += e < 0.36 ? 0.07 * Math.sin(Math.PI * e / 0.36) : 0;
        glow = Math.max(glow, Math.exp(-2.2 * e));
      }
      if (s.value.solve?.object === object.id && t >= s.start + s.value.solve.at) solved = Math.max(solved, smooth(Math.min(1, (t - s.start - s.value.solve.at) / 0.35)));
    }
    return {
      id: object.id, type: object.type, size, x, y: y + hop, w, h, spin: -travelled / (w / 2), focus: focused, mark, tilt, hop, glow, solved,
      ...(object.label ? { label: object.label } : {}),
    };
  });
  return { channels, objects, action: segment.value.name };
}
